'use strict';
/**
 * packer_brotli.js
 * Port of packer_brotli.py - reads/writes the custom binary archive format.
 *
 * Format per folder:
 *   folder_type   (1 byte)  0=normal, 1=copy
 *   folder_name_len (ULEB128)
 *   folder_name   (UTF-8)
 *   if normal:
 *     num_files   (ULEB128)
 *     for each file:
 *       filename_len  (ULEB128)
 *       filename      (UTF-8)
 *       file_type     (1 byte) 0=content, 1=reference
 *       if content:  compressed_len (ULEB128) + brotli bytes
 *       if reference: src_folder_len + src_folder + src_filename_len + src_filename
 *   if copy:
 *     source_folder_len (ULEB128)
 *     source_folder     (UTF-8)
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const brotliCompressAsync   = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

const BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  },
};

const FOLDER_TYPE_NORMAL = 0;
const FOLDER_TYPE_COPY   = 1;
const FILE_TYPE_CONTENT   = 0;
const FILE_TYPE_REFERENCE = 1;

const IGNORED_FILES   = new Set(['.DS_Store', '._.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IGNORED_PREFIXES = ['._'];

function shouldIgnoreFile(filename) {
  if (IGNORED_FILES.has(filename)) return true;
  return IGNORED_PREFIXES.some(p => filename.startsWith(p));
}

function isBrotliFile(filename) {
  return filename.toLowerCase().endsWith('.br');
}

// ── ULEB128 ──────────────────────────────────────────────────────────────────

function encodeULEB128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7F;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

/** Returns { value, bytesRead } */
function decodeULEB128(buf, offset = 0) {
  let result = 0;
  let shift  = 0;
  let bytesRead = 0;
  while (true) {
    const byte = buf[offset + bytesRead];
    bytesRead++;
    result |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, bytesRead };
}

function uleb128Size(value) {
  let size = 0;
  do { value = Math.floor(value / 128); size++; } while (value !== 0);
  return size;
}

// ── Brotli helpers ────────────────────────────────────────────────────────────

function compressSync(data)   { return zlib.brotliCompressSync(data, BROTLI_OPTIONS); }
function decompressSync(data) { return zlib.brotliDecompressSync(data); }

async function compressAsync(data)   { return brotliCompressAsync(data, BROTLI_OPTIONS); }
async function decompressAsync(data) { return brotliDecompressAsync(data); }

// ── MD5 file hash ─────────────────────────────────────────────────────────────

function md5File(filePath) {
  const hash = crypto.createHash('md5');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

// ── PackedArchive ─────────────────────────────────────────────────────────────

class PackedArchive {
  constructor(archivePath) {
    this._path   = archivePath;
    this._entries = new Map(); // fullPath -> entry object
    this._folders = new Map(); // folderName -> [filename, ...]
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    const data = await fs.promises.readFile(this._path);
    this._parseIndex(data);
    this._initialized = true;
  }

  _parseIndex(data) {
    let offset = 0;

    while (offset < data.length) {
      const folderType = data[offset++];

      const { value: folderNameLen, bytesRead: br1 } = decodeULEB128(data, offset);
      offset += br1;
      const folderName = data.slice(offset, offset + folderNameLen).toString('utf8');
      offset += folderNameLen;

      if (folderType === FOLDER_TYPE_COPY) {
        const { value: srcLen, bytesRead: br2 } = decodeULEB128(data, offset);
        offset += br2;
        const srcName = data.slice(offset, offset + srcLen).toString('utf8');
        offset += srcLen;

        // Mirror source folder's entries
        const srcFiles = this._folders.get(srcName) || [];
        this._folders.set(folderName, [...srcFiles]);
        for (const filename of srcFiles) {
          const srcEntry = this._entries.get(`${srcName}/${filename}`);
          if (srcEntry) {
            this._entries.set(`${folderName}/${filename}`, { ...srcEntry, folder: folderName });
          }
        }
      } else {
        const { value: numFiles, bytesRead: br3 } = decodeULEB128(data, offset);
        offset += br3;

        const fileList = [];
        this._folders.set(folderName, fileList);

        for (let i = 0; i < numFiles; i++) {
          const { value: fnLen, bytesRead: br4 } = decodeULEB128(data, offset);
          offset += br4;
          const filename = data.slice(offset, offset + fnLen).toString('utf8');
          offset += fnLen;
          fileList.push(filename);

          const fileType = data[offset++];
          const fullPath = `${folderName}/${filename}`;

          if (fileType === FILE_TYPE_REFERENCE) {
            const { value: sfLen, bytesRead: br5 } = decodeULEB128(data, offset);
            offset += br5;
            const refFolder = data.slice(offset, offset + sfLen).toString('utf8');
            offset += sfLen;

            const { value: sfnLen, bytesRead: br6 } = decodeULEB128(data, offset);
            offset += br6;
            const refFilename = data.slice(offset, offset + sfnLen).toString('utf8');
            offset += sfnLen;

            this._entries.set(fullPath, {
              folder: folderName, filename,
              fileType: FILE_TYPE_REFERENCE,
              dataOffset: 0, compressedSize: 0,
              refFolder, refFilename,
            });
          } else {
            const { value: cLen, bytesRead: br7 } = decodeULEB128(data, offset);
            offset += br7;

            this._entries.set(fullPath, {
              folder: folderName, filename,
              fileType: FILE_TYPE_CONTENT,
              dataOffset: offset, compressedSize: cLen,
              refFolder: null, refFilename: null,
            });
            offset += cLen;
          }
        }
      }
    }
  }

  listFolders() {
    this._checkInit();
    return [...this._folders.keys()];
  }

  listFiles(folder = null) {
    this._checkInit();
    if (folder !== null) return [...(this._folders.get(folder) || [])];
    return [...this._entries.keys()];
  }

  exists(filePath) {
    this._checkInit();
    return this._entries.has(filePath);
  }

  /**
   * Read a file from the archive.
   * @param {string} filePath  - e.g. "vcsky/fetched/model.txd"
   * @param {boolean} keepBrotli - if true, return raw compressed bytes
   * @returns {Promise<Buffer>}
   */
  async readFile(filePath, keepBrotli = false) {
    this._checkInit();

    let entry = this._entries.get(filePath);
    if (!entry) throw Object.assign(new Error(`File not found: ${filePath}`), { code: 'ENOENT' });

    const originalFilename = entry.filename;

    // Resolve references
    while (entry.fileType === FILE_TYPE_REFERENCE) {
      const refPath = `${entry.refFolder}/${entry.refFilename}`;
      entry = this._entries.get(refPath);
      if (!entry) throw new Error(`Reference target not found: ${refPath}`);
    }

    // Read compressed bytes from archive
    const fd  = await fs.promises.open(this._path, 'r');
    const buf = Buffer.alloc(entry.compressedSize);
    await fd.read(buf, 0, entry.compressedSize, entry.dataOffset);
    await fd.close();

    // .br files are stored as-is (no extra brotli wrapper)
    if (isBrotliFile(originalFilename)) return buf;
    if (keepBrotli) return buf;

    return decompressAsync(buf);
  }

  _checkInit() {
    if (!this._initialized) throw new Error('Archive not initialized. Call init() first.');
  }
}

// ── pack / unpack ─────────────────────────────────────────────────────────────

/**
 * Pack a folder into a binary archive.
 * @param {string} folderPath
 * @param {string} outputFile
 * @param {object} [opts]
 * @param {boolean} [opts.deduplicate=true]
 */
async function packFolder(folderPath, outputFile, opts = {}) {
  const { deduplicate = true } = opts;
  folderPath = folderPath.replace(/[/\\]+$/, '');
  const parentDir = path.dirname(folderPath) || '.';

  // Collect files
  const filesToCompress = [];
  const folderStructure = [];

  for (const [root, files] of walkSync(folderPath)) {
    const filteredFiles = files.filter(f => !shouldIgnoreFile(f)).sort();
    if (filteredFiles.length === 0) continue;
    const relPath = path.relative(parentDir, root).replace(/\\/g, '/');
    folderStructure.push({ relPath, files: filteredFiles, isDuplicate: false, sourcePath: null });
    for (const filename of filteredFiles) {
      filesToCompress.push({ filePath: path.join(root, filename), relPath, filename });
    }
  }

  console.log(`Compressing ${filesToCompress.length} files (Brotli quality 11)...`);

  // Parallel compression via Promise.all (uses libuv thread pool)
  const compressedMap = new Map();
  await Promise.all(filesToCompress.map(async ({ filePath, relPath, filename }) => {
    const content = await fs.promises.readFile(filePath);
    let data;
    if (isBrotliFile(filename)) {
      data = content;
    } else {
      data = await compressAsync(content);
      const ratio = (data.length / content.length * 100).toFixed(1);
      console.log(`  ${relPath}/${filename}: ${content.length} -> ${data.length} bytes (${ratio}%)`);
    }
    compressedMap.set(`${relPath}/${filename}`, data);
  }));

  console.log('\nWriting packed file...');

  const chunks = [];
  for (const { relPath, files, isDuplicate, sourcePath } of folderStructure) {
    const folderNameBuf = Buffer.from(relPath, 'utf8');
    if (isDuplicate) {
      const srcBuf = Buffer.from(sourcePath, 'utf8');
      chunks.push(Buffer.from([FOLDER_TYPE_COPY]));
      chunks.push(encodeULEB128(folderNameBuf.length)); chunks.push(folderNameBuf);
      chunks.push(encodeULEB128(srcBuf.length));        chunks.push(srcBuf);
    } else {
      chunks.push(Buffer.from([FOLDER_TYPE_NORMAL]));
      chunks.push(encodeULEB128(folderNameBuf.length)); chunks.push(folderNameBuf);
      chunks.push(encodeULEB128(files.length));

      for (const filename of files) {
        const fnBuf   = Buffer.from(filename, 'utf8');
        const content = compressedMap.get(`${relPath}/${filename}`);
        chunks.push(encodeULEB128(fnBuf.length));    chunks.push(fnBuf);
        chunks.push(Buffer.from([FILE_TYPE_CONTENT]));
        chunks.push(encodeULEB128(content.length));  chunks.push(content);
      }
    }
  }

  await fs.promises.writeFile(outputFile, Buffer.concat(chunks));
  const size = (await fs.promises.stat(outputFile)).size;
  console.log(`\nPacked to ${outputFile} (${size} bytes)`);
}

/**
 * Append a folder to an existing archive.
 */
async function addFolder(archivePath, folderPath) {
  folderPath = folderPath.replace(/[/\\]+$/, '');
  const parentDir = path.dirname(folderPath) || '.';

  const filesToCompress = [];
  const folderStructure = [];

  for (const [root, files] of walkSync(folderPath)) {
    const filteredFiles = files.filter(f => !shouldIgnoreFile(f)).sort();
    if (filteredFiles.length === 0) continue;
    const relPath = path.relative(parentDir, root).replace(/\\/g, '/');
    folderStructure.push({ relPath, files: filteredFiles });
    for (const filename of filteredFiles) {
      filesToCompress.push({ filePath: path.join(root, filename), relPath, filename });
    }
  }

  console.log(`Compressing ${filesToCompress.length} files...`);

  const compressedMap = new Map();
  await Promise.all(filesToCompress.map(async ({ filePath, relPath, filename }) => {
    const content = await fs.promises.readFile(filePath);
    const data = isBrotliFile(filename) ? content : await compressAsync(content);
    compressedMap.set(`${relPath}/${filename}`, data);
  }));

  console.log('Appending to archive...');

  const chunks = [];
  for (const { relPath, files } of folderStructure) {
    const folderNameBuf = Buffer.from(relPath, 'utf8');
    chunks.push(Buffer.from([FOLDER_TYPE_NORMAL]));
    chunks.push(encodeULEB128(folderNameBuf.length)); chunks.push(folderNameBuf);
    chunks.push(encodeULEB128(files.length));
    for (const filename of files) {
      const fnBuf   = Buffer.from(filename, 'utf8');
      const content = compressedMap.get(`${relPath}/${filename}`);
      chunks.push(encodeULEB128(fnBuf.length));    chunks.push(fnBuf);
      chunks.push(Buffer.from([FILE_TYPE_CONTENT]));
      chunks.push(encodeULEB128(content.length));  chunks.push(content);
    }
  }

  const fd = await fs.promises.open(archivePath, 'a');
  await fd.write(Buffer.concat(chunks));
  await fd.close();
  console.log(`Appended to ${archivePath}`);
}

/**
 * Unpack a binary archive to a directory.
 */
async function unpackFile(inputFile, outputDir) {
  const data = await fs.promises.readFile(inputFile);
  const unpackedFolders = new Map();
  const unpackedFiles   = new Map();
  let offset = 0;

  while (offset < data.length) {
    const folderType = data[offset++];

    const { value: fnLen, bytesRead: br1 } = decodeULEB128(data, offset);
    offset += br1;
    const folderName = data.slice(offset, offset + fnLen).toString('utf8');
    offset += fnLen;

    const folderPath = path.join(outputDir, folderName);
    await fs.promises.mkdir(folderPath, { recursive: true });
    unpackedFolders.set(folderName, folderPath);

    if (folderType === FOLDER_TYPE_COPY) {
      const { value: snLen, bytesRead: br2 } = decodeULEB128(data, offset);
      offset += br2;
      const sourceName = data.slice(offset, offset + snLen).toString('utf8');
      offset += snLen;

      const sourcePath = unpackedFolders.get(sourceName);
      if (sourcePath) {
        const entries = await fs.promises.readdir(sourcePath);
        for (const fname of entries) {
          const src = path.join(sourcePath, fname);
          const dst = path.join(folderPath, fname);
          if ((await fs.promises.stat(src)).isFile()) {
            await fs.promises.copyFile(src, dst);
            unpackedFiles.set(`${folderName}/${fname}`, dst);
          }
        }
        console.log(`Copied folder: ${folderName} <- ${sourceName}`);
      }
    } else {
      const { value: numFiles, bytesRead: br3 } = decodeULEB128(data, offset);
      offset += br3;
      console.log(`Folder: ${folderName} (${numFiles} files)`);

      for (let i = 0; i < numFiles; i++) {
        const { value: fileNameLen, bytesRead: br4 } = decodeULEB128(data, offset);
        offset += br4;
        const filename = data.slice(offset, offset + fileNameLen).toString('utf8');
        offset += fileNameLen;

        const filePath = path.join(folderPath, filename);
        const fileType = data[offset++];

        if (fileType === FILE_TYPE_REFERENCE) {
          const { value: sfLen, bytesRead: br5 } = decodeULEB128(data, offset);
          offset += br5;
          const srcFolder = data.slice(offset, offset + sfLen).toString('utf8');
          offset += sfLen;

          const { value: sfnLen, bytesRead: br6 } = decodeULEB128(data, offset);
          offset += br6;
          const srcFilename = data.slice(offset, offset + sfnLen).toString('utf8');
          offset += sfnLen;

          const srcPath = unpackedFiles.get(`${srcFolder}/${srcFilename}`);
          if (srcPath) {
            await fs.promises.copyFile(srcPath, filePath);
            unpackedFiles.set(`${folderName}/${filename}`, filePath);
            console.log(`  Copied: ${filename} <- ${srcFolder}/${srcFilename}`);
          }
        } else {
          const { value: contentLen, bytesRead: br7 } = decodeULEB128(data, offset);
          offset += br7;
          const compressed = data.slice(offset, offset + contentLen);
          offset += contentLen;

          let content;
          if (isBrotliFile(filename)) {
            content = compressed; // stored as-is
          } else {
            content = await decompressAsync(compressed);
          }
          await fs.promises.writeFile(filePath, content);
          unpackedFiles.set(`${folderName}/${filename}`, filePath);
          console.log(`  Unpacked: ${filename} (${content.length} bytes)`);
        }
      }
    }
  }

  console.log(`\nUnpacked to ${outputDir}`);
}

// ── AsyncBuffer (for streaming unpack) ───────────────────────────────────────

class AsyncBuffer {
  constructor() {
    this._buf   = Buffer.alloc(0);
    this._waiters = [];
    this._ended = false;
  }

  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._notify();
  }

  end() {
    this._ended = true;
    this._notify();
  }

  _notify() {
    while (this._waiters.length > 0 && (this._buf.length >= this._waiters[0].needed || this._ended)) {
      this._waiters.shift().resolve();
    }
  }

  async readBytes(n) {
    while (this._buf.length < n) {
      if (this._ended) throw new Error(`Unexpected EOF: need ${n}, have ${this._buf.length}`);
      await new Promise(resolve => this._waiters.push({ needed: n, resolve }));
    }
    const result = this._buf.slice(0, n);
    this._buf = this._buf.slice(n);
    return result;
  }

  async readULEB128() {
    let result = 0, shift = 0;
    while (true) {
      const b = (await this.readBytes(1))[0];
      result |= (b & 0x7F) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }
}

/**
 * Stream-unpack from an AsyncBuffer, writing files to outputDir.
 * Call asyncBuf.push(chunk) as data arrives, then asyncBuf.end().
 */
async function streamUnpackToDisk(asyncBuf, outputDir) {
  const unpackedFolders = new Map();
  const unpackedFiles   = new Map();

  try {
    while (true) {
      let folderTypeByte;
      try { folderTypeByte = (await asyncBuf.readBytes(1))[0]; }
      catch { break; }

      const folderNameLen = await asyncBuf.readULEB128();
      const folderName    = (await asyncBuf.readBytes(folderNameLen)).toString('utf8');

      const folderPath = path.join(outputDir, folderName);
      await fs.promises.mkdir(folderPath, { recursive: true });
      unpackedFolders.set(folderName, folderPath);

      if (folderTypeByte === FOLDER_TYPE_COPY) {
        const srcLen  = await asyncBuf.readULEB128();
        const srcName = (await asyncBuf.readBytes(srcLen)).toString('utf8');

        const srcPath = unpackedFolders.get(srcName);
        if (srcPath) {
          const entries = await fs.promises.readdir(srcPath);
          for (const fname of entries) {
            const src = path.join(srcPath, fname);
            const dst = path.join(folderPath, fname);
            if ((await fs.promises.stat(src)).isFile()) {
              await fs.promises.copyFile(src, dst);
              unpackedFiles.set(`${folderName}/${fname}`, dst);
            }
          }
        }
        console.log(`Copied folder: ${folderName} <- ${srcName}`);
      } else {
        const numFiles = await asyncBuf.readULEB128();
        console.log(`Folder: ${folderName} (${numFiles} files)`);

        for (let i = 0; i < numFiles; i++) {
          const fnLen    = await asyncBuf.readULEB128();
          const filename = (await asyncBuf.readBytes(fnLen)).toString('utf8');
          const fileType = (await asyncBuf.readBytes(1))[0];
          const filePath = path.join(folderPath, filename);

          if (fileType === FILE_TYPE_REFERENCE) {
            const sfLen      = await asyncBuf.readULEB128();
            const srcFolder  = (await asyncBuf.readBytes(sfLen)).toString('utf8');
            const sfnLen     = await asyncBuf.readULEB128();
            const srcFilename = (await asyncBuf.readBytes(sfnLen)).toString('utf8');

            const srcPath = unpackedFiles.get(`${srcFolder}/${srcFilename}`);
            if (srcPath) {
              await fs.promises.copyFile(srcPath, filePath);
              unpackedFiles.set(`${folderName}/${filename}`, filePath);
            }
          } else {
            const cLen     = await asyncBuf.readULEB128();
            const compressed = await asyncBuf.readBytes(cLen);
            let content;
            if (isBrotliFile(filename)) {
              content = compressed;
            } else {
              content = await decompressAsync(compressed);
            }
            await fs.promises.writeFile(filePath, content);
            unpackedFiles.set(`${folderName}/${filename}`, filePath);
            console.log(`  Unpacked: ${filename} (${content.length} bytes)`);
          }
        }
      }
    }
  } catch (e) {
    if (!e.message.startsWith('Unexpected EOF')) throw e;
  }

  console.log(`\nStream unpacked to ${outputDir}`);
}

// ── walk helper ───────────────────────────────────────────────────────────────

/** Sync DFS walk, yields [root, files] */
function* walkSync(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files   = entries.filter(e => e.isFile()).map(e => e.name);
  const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  if (files.length > 0) yield [dir, files];
  for (const sub of subdirs) yield* walkSync(path.join(dir, sub));
}

module.exports = {
  PackedArchive,
  packFolder,
  addFolder,
  unpackFile,
  AsyncBuffer,
  streamUnpackToDisk,
  encodeULEB128,
  decodeULEB128,
  isBrotliFile,
  shouldIgnoreFile,
  FOLDER_TYPE_NORMAL,
  FOLDER_TYPE_COPY,
  FILE_TYPE_CONTENT,
  FILE_TYPE_REFERENCE,
};
