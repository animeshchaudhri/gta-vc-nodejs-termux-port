'use strict';
/**
 * downloader_brotli.js
 * Downloads a packed archive from a URL and unpacks it directly to disk
 * without saving an intermediate .bin file.
 */

const https = require('https');
const http  = require('http');
const { AsyncBuffer, streamUnpackToDisk } = require('./packer_brotli');

/**
 * Download from url, feeding chunks into an AsyncBuffer while
 * streamUnpackToDisk consumes from the same buffer concurrently.
 *
 * @param {string} url
 * @param {string} outputDir
 */
async function downloadAndUnpack(url, outputDir) {
  const buf = new AsyncBuffer();

  // Download task: fetch and push chunks
  const downloadPromise = new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Simple single-level redirect
        downloadAndUnpackRaw(res.headers.location, buf).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      console.log(`Downloading from ${url}${total ? ` (${(total/1024/1024).toFixed(1)} MB)` : ''}...`);

      res.on('data', chunk => {
        downloaded += chunk.length;
        buf.push(chunk);
        if (total) {
          const pct = (downloaded / total * 100).toFixed(1);
          process.stdout.write(`\r  ${(downloaded/1024/1024).toFixed(1)} MB / ${(total/1024/1024).toFixed(1)} MB (${pct}%)`);
        }
      });
      res.on('end', () => {
        if (total) process.stdout.write('\n');
        buf.end();
        resolve();
      });
      res.on('error', reject);
    }).on('error', reject);
  });

  // Run both concurrently - unpack reads from buf as download fills it
  await Promise.all([
    downloadPromise,
    streamUnpackToDisk(buf, outputDir),
  ]);
}

/** Helper for redirect handling */
function downloadAndUnpackRaw(url, buf) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      res.on('data', chunk => buf.push(chunk));
      res.on('end', () => { buf.end(); resolve(); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { downloadAndUnpack };

// CLI
if (require.main === module) {
  const [,, url, outputDir] = process.argv;
  if (!url || !outputDir) {
    console.log('Usage: node downloader_brotli.js <url> <output_dir>');
    process.exit(1);
  }
  downloadAndUnpack(url, outputDir).catch(err => { console.error(err); process.exit(1); });
}
