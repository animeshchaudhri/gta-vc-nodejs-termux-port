'use strict';
/**
 * packed.js - Serve files from a PackedArchive (.bin) file.
 * Supports brotli passthrough and on-the-fly decompression.
 * Mirrors additions/packed.py.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const { PackedArchive, isBrotliFile } = require('./packer_brotli');
const { clientAcceptsBrotli, getMediaType, COEP_HEADERS } = require('./cache');

let _archive = null;

function isUrl(s) { return s.startsWith('http://') || s.startsWith('https://'); }

function filenameFromUrl(url) {
  return path.basename(new URL(url).pathname) || 'packed.bin';
}

/** Download url to destPath, showing progress. */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    console.log(`Downloading archive from ${url}...`);
    transport.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', chunk => {
        downloaded += chunk.length;
        out.write(chunk);
        if (total) {
          const pct = (downloaded / total * 100).toFixed(1);
          process.stdout.write(`\r  ${(downloaded/1024/1024).toFixed(1)} MB / ${(total/1024/1024).toFixed(1)} MB (${pct}%)`);
        }
      });
      res.on('end', () => {
        out.end();
        if (total) process.stdout.write('\n');
        console.log(`  Saved to: ${destPath}`);
        resolve();
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Resolve source (URL or local path) to a local file path, downloading if needed.
 */
async function resolvePackedSource(source) {
  if (!isUrl(source)) return source;
  const filename = filenameFromUrl(source);
  if (fs.existsSync(filename) && fs.statSync(filename).size > 0) {
    console.log(`Using existing archive: ${filename} (${fs.statSync(filename).size} bytes)`);
    return filename;
  }
  await downloadFile(source, filename);
  return filename;
}

/**
 * Initialize the global PackedArchive instance.
 * @param {string} source  - local path or URL
 * @returns {PackedArchive|null}
 */
async function initPackedArchive(source) {
  const archivePath = await resolvePackedSource(source);
  if (!fs.existsSync(archivePath)) {
    console.error(`Archive not found: ${archivePath}`);
    return null;
  }
  _archive = new PackedArchive(archivePath);
  await _archive.init();
  console.log(`Loaded packed archive: ${archivePath}`);
  console.log(`  Folders: ${_archive.listFolders().length}`);
  console.log(`  Files: ${_archive.listFiles().length}`);
  return _archive;
}

function isInitialized() { return _archive !== null && _archive._initialized; }
function getArchive()    { return _archive; }

/**
 * Serve a file from the archive as an Express response.
 * Returns true if handled, false if file not found.
 *
 * @param {string} filePath - e.g. "vcsky/fetched/model.txd"
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
async function servePackedFile(filePath, req, res) {
  if (!isInitialized() || !_archive.exists(filePath)) return false;

  const clientBr  = clientAcceptsBrotli(req);
  const isBr      = isBrotliFile(filePath);
  const mediaType = getMediaType(filePath);

  const headers = {
    ...COEP_HEADERS,
    'Content-Type': mediaType,
  };

  try {
    if (isBr) {
      // .br files stored as-is in archive - readFile returns raw .br bytes
      const brData = await _archive.readFile(filePath, false);
      if (clientBr) {
        headers['Content-Encoding'] = 'br';
        res.set(headers).end(brData);
      } else {
        const decompressed = zlib.brotliDecompressSync(brData);
        res.set(headers).end(decompressed);
      }
    } else {
      if (clientBr) {
        const compressed = await _archive.readFile(filePath, true);
        headers['Content-Encoding'] = 'br';
        res.set(headers).end(compressed);
      } else {
        const data = await _archive.readFile(filePath, false);
        res.set(headers).end(data);
      }
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    console.error(`Error reading from archive: ${filePath} -`, err.message);
    return false;
  }
}

module.exports = { initPackedArchive, isInitialized, getArchive, servePackedFile };
