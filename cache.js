'use strict';
/**
 * cache.js - Proxy requests upstream with optional local disk cache.
 * Handles brotli passthrough / on-the-fly decompression.
 */

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const zlib    = require('zlib');
const os      = require('os');
const crypto  = require('crypto');
const mime    = require('mime-types');

const COEP_HEADERS = {
  'Cross-Origin-Opener-Policy':   'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function clientAcceptsBrotli(req) {
  const ae = req.headers['accept-encoding'] || '';
  return ae.toLowerCase().includes('br');
}

function isBrFile(urlOrPath) {
  return urlOrPath.split('?')[0].toLowerCase().endsWith('.br');
}

function getMediaType(filePath) {
  const p = filePath.toLowerCase().split('?')[0];
  if (p.endsWith('.wasm.br') || p.endsWith('.wasm')) return 'application/wasm';
  if (p.endsWith('.js.br'))   return 'application/javascript';
  if (p.endsWith('.json.br')) return 'application/json';
  if (p.endsWith('.html.br')) return 'text/html';
  if (p.endsWith('.css.br'))  return 'text/css';
  if (p.endsWith('.br'))      return 'application/octet-stream';
  return mime.lookup(p) || 'application/octet-stream';
}

/**
 * Serve a local file, decompressing .br on the fly if client can't accept it.
 * @returns {boolean} true if file was served
 */
function serveLocalFile(localPath, req, res) {
  if (!fs.existsSync(localPath)) return false;

  const isBr      = localPath.endsWith('.br');
  const clientBr  = clientAcceptsBrotli(req);
  const mediaType = getMediaType(localPath);

  const headers = {
    ...COEP_HEADERS,
    'Content-Type': mediaType,
  };

  if (isBr && clientBr) {
    headers['Content-Encoding'] = 'br';
    res.set(headers);
    fs.createReadStream(localPath).pipe(res);
    return true;
  }

  if (isBr && !clientBr) {
    // Decompress on the fly
    res.set({ ...headers, ...COEP_HEADERS });
    const stream = fs.createReadStream(localPath).pipe(zlib.createBrotliDecompress());
    stream.pipe(res);
    stream.on('error', () => res.destroy());
    return true;
  }

  // Plain file
  res.set(headers);
  fs.createReadStream(localPath).pipe(res);
  return true;
}

/**
 * Proxy a request upstream, optionally caching the raw response to disk.
 * Handles brotli decompression if the client doesn't support it.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {string} url           - upstream URL
 * @param {string|null} cachePath - local path to cache raw response (null = no cache)
 */
function proxyAndCache(req, res, url, cachePath = null) {
  // Try local cache first
  if (cachePath && serveLocalFile(cachePath, req, res)) return;

  const isBr        = isBrFile(url);
  const clientBr    = clientAcceptsBrotli(req);
  const needDecompress = isBr && !clientBr;
  const mediaType   = getMediaType(url);

  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'https:' ? https : http;

  const upstreamHeaders = { ...req.headers };
  delete upstreamHeaders['host'];
  delete upstreamHeaders['content-length'];
  // Ask upstream for raw bytes, no transport compression
  upstreamHeaders['accept-encoding'] = 'identity';

  const upstreamReq = transport.request(
    { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.pathname + parsedUrl.search, method: req.method, headers: upstreamHeaders },
    (upstreamRes) => {
      // Strip hop-by-hop headers
      const hop = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'content-security-policy']);
      const respHeaders = { ...COEP_HEADERS, 'Content-Type': mediaType };
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!hop.has(k.toLowerCase())) respHeaders[k] = v;
      }

      const willDecompress = needDecompress && upstreamRes.statusCode === 200
        && !((upstreamRes.headers['content-type'] || '').startsWith('text/'));

      if (willDecompress) {
        delete respHeaders['content-encoding'];
        delete respHeaders['Content-Encoding'];
        delete respHeaders['content-length'];
        delete respHeaders['Content-Length'];
      } else if (isBr && clientBr) {
        respHeaders['Content-Encoding'] = 'br';
      }

      res.status(upstreamRes.statusCode).set(respHeaders);

      // No caching for non-200 or when caching disabled
      if (upstreamRes.statusCode !== 200 || !cachePath) {
        const stream = willDecompress
          ? upstreamRes.pipe(zlib.createBrotliDecompress())
          : upstreamRes;
        stream.pipe(res);
        stream.on('error', () => res.destroy());
        return;
      }

      // Cache to temp file then rename
      const cacheDir = path.dirname(cachePath);
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmpPath = path.join(os.tmpdir(), `cache_${crypto.randomBytes(8).toString('hex')}`);
      const tmpStream = fs.createWriteStream(tmpPath);

      // We always save raw (possibly brotli-compressed) bytes
      upstreamRes.pipe(tmpStream);
      upstreamRes.on('end', () => {
        fs.renameSync(tmpPath, cachePath);
      });
      upstreamRes.on('error', () => {
        fs.unlink(tmpPath, () => {});
      });

      // Also send to client
      const srcForClient = willDecompress
        ? fs.createReadStream(tmpPath).pipe(zlib.createBrotliDecompress()) // can't do this before file is written...
        : upstreamRes;

      // Actually, pipe directly: tee to file + client
      if (willDecompress) {
        // Collect raw, write to file, decompress for client
        const chunks = [];
        upstreamRes.on('data', chunk => {
          chunks.push(chunk);
          tmpStream.write(chunk);
        });
        upstreamRes.on('end', () => {
          tmpStream.end();
          const raw = Buffer.concat(chunks);
          try {
            const decompressed = zlib.brotliDecompressSync(raw);
            res.end(decompressed);
          } catch {
            res.end(raw);
          }
          fs.renameSync(tmpPath, cachePath);
        });
      } else {
        const chunks = [];
        upstreamRes.on('data', chunk => {
          chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          const raw = Buffer.concat(chunks);
          fs.writeFile(tmpPath, raw, () => {
            fs.renameSync(tmpPath, cachePath);
          });
          res.end(raw);
        });
      }
    }
  );

  upstreamReq.on('error', (err) => {
    console.error('Upstream error:', err.message);
    if (!res.headersSent) res.status(502).send('Bad Gateway');
  });

  req.pipe(upstreamReq);
}

module.exports = { serveLocalFile, proxyAndCache, clientAcceptsBrotli, getMediaType, COEP_HEADERS };
