const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const BROTLI_PARAMS = {
  [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
  [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
  [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
};

function parseArgs(argv) {
  const args = {
    port: 8000,
    custom_saves: false,
    login: undefined,
    password: undefined,
    vcsky_local: undefined,
    vcbr_local: undefined,
    vcsky_url: 'https://cdn.dos.zone/vcsky/',
    vcbr_url: 'https://br.cdn.dos.zone/vcsky/',
    vcsky_cache: false,
    vcbr_cache: false,
    packed: undefined,
    unpacked: undefined,
    pack: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      continue;
    }

    const [flag, inlineValue] = current.split('=', 2);
    const nextValue = inlineValue !== undefined ? inlineValue : argv[i + 1];

    switch (flag) {
      case '--port': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.port = Number.parseInt(value, 10);
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      case '--custom_saves':
        args.custom_saves = true;
        break;
      case '--login': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.login = value;
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      case '--password': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.password = value;
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      case '--vcsky_local': {
        let value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value === undefined || value.startsWith('-')) {
          value = 'vcsky';
        } else if (inlineValue === undefined) {
          i += 1;
        }
        args.vcsky_local = value;
        break;
      }
      case '--vcbr_local': {
        let value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value === undefined || value.startsWith('-')) {
          value = 'vcbr';
        } else if (inlineValue === undefined) {
          i += 1;
        }
        args.vcbr_local = value;
        break;
      }
      case '--vcsky_url': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.vcsky_url = value;
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      case '--vcbr_url': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.vcbr_url = value;
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      case '--vcsky_cache':
        args.vcsky_cache = true;
        break;
      case '--vcbr_cache':
        args.vcbr_cache = true;
        break;
      case '--packed': {
        let value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value === undefined || value.startsWith('-')) {
          value = 'revcdos.bin';
        } else if (inlineValue === undefined) {
          i += 1;
        }
        args.packed = value;
        break;
      }
      case '--unpacked': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.unpacked = value;
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      case '--pack': {
        const value = inlineValue !== undefined ? inlineValue : nextValue;
        if (value !== undefined && !value.startsWith('-')) {
          args.pack = value;
          if (inlineValue === undefined) i += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const UNPACKED_DIR = path.join(ROOT_DIR, 'unpacked');

function md5Hash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function isUrl(value) {
  return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'));
}

function isMd5Hash(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value);
}

function getUnpackedDir(source) {
  if (isMd5Hash(source)) {
    return path.join(UNPACKED_DIR, source.toLowerCase());
  }
  return path.join(UNPACKED_DIR, md5Hash(source));
}

function safeResolve(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath || '.');
  const normalizedBase = path.resolve(baseDir);
  if (resolved === normalizedBase || resolved.startsWith(normalizedBase + path.sep)) {
    return resolved;
  }
  return null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function shouldIgnoreFile(filename) {
  return filename === '.DS_Store' || filename === '._.DS_Store' || filename === 'Thumbs.db' || filename === 'desktop.ini' || filename.startsWith('._');
}

function isAlreadyBrotli(filename) {
  return filename.toLowerCase().endsWith('.br');
}

function compressBrotli(buffer) {
  return zlib.brotliCompressSync(buffer, { params: BROTLI_PARAMS });
}

function decompressBrotli(buffer) {
  return zlib.brotliDecompressSync(buffer);
}

function compressString(value) {
  return compressBrotli(Buffer.from(value, 'utf8'));
}

function decompressString(buffer) {
  return decompressBrotli(buffer).toString('utf8');
}

function readUtf8Slice(buffer, offset, length) {
  return buffer.slice(offset, offset + length).toString('utf8');
}

function encodeULEB128(value) {
  const bytes = [];
  let remaining = value >>> 0;
  while (true) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
    if (remaining === 0) {
      break;
    }
  }
  return Buffer.from(bytes);
}

function readULEB128(buffer, offset) {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (true) {
    const byte = buffer[offset + bytesRead];
    bytesRead += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  return { value: result, bytesRead };
}

function getMediaType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.wasm.br') || lower.endsWith('.wasm')) return 'application/wasm';
  if (lower.endsWith('.js.br') || lower.endsWith('.js')) return 'application/javascript';
  if (lower.endsWith('.json.br') || lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html.br') || lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.css.br') || lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp.trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function formatClientSummary(clients) {
  if (clients.size === 0) {
    return '0 active connections';
  }

  const uniqueIps = new Set();
  const recentClients = [];

  for (const client of clients.values()) {
    uniqueIps.add(client.ip);
    recentClients.push(`${client.ip}${client.userAgent ? ` | ${client.userAgent}` : ''}`);
  }

  const preview = recentClients.slice(0, 5).join(' || ');
  const extra = recentClients.length > 5 ? ` || +${recentClients.length - 5} more` : '';
  return `${clients.size} active connections, ${uniqueIps.size} unique IPs${preview ? ` | ${preview}${extra}` : ''}`;
}

function clientAcceptsBrotli(req) {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  return acceptEncoding.toLowerCase().includes('br');
}

function commonHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}

function withCommonHeaders(headers = {}) {
  return { ...headers, ...commonHeaders() };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartFormData(body, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || '');
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }

  const boundary = Buffer.from(`--${boundaryMatch[1].replace(/^"|"$/g, '')}`);
  const parts = [];
  let start = body.indexOf(boundary);

  while (start !== -1) {
    start += boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) {
      break;
    }
    if (body[start] === 13 && body[start + 1] === 10) {
      start += 2;
    }

    const nextBoundary = body.indexOf(boundary, start);
    if (nextBoundary === -1) {
      break;
    }

    let part = body.slice(start, nextBoundary);
    if (part.slice(-2).equals(Buffer.from('\r\n'))) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      start = nextBoundary;
      continue;
    }

    const headerText = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);
    const headers = {};

    for (const line of headerText.split('\r\n')) {
      const index = line.indexOf(':');
      if (index !== -1) {
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
    }

    parts.push({ headers, content });
    start = nextBoundary;
  }

  const fields = {};
  let file = null;

  for (const part of parts) {
    const disposition = part.headers['content-disposition'] || '';
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    if (!nameMatch) {
      continue;
    }

    const fieldName = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    if (filenameMatch) {
      file = {
        fieldName,
        filename: filenameMatch[1],
        content: part.content,
      };
      continue;
    }

    fields[fieldName] = part.content.toString('utf8');
  }

  return { fields, file };
}

function getFilesInFolder(folderPath) {
  return fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !shouldIgnoreFile(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function collectPackFolders(rootFolder) {
  const parentDir = path.dirname(rootFolder) || '.';
  const folders = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && !shouldIgnoreFile(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    if (files.length > 0) {
      folders.push({
        folderPath: currentDir,
        relativeName: path.relative(parentDir, currentDir).split(path.sep).join('/'),
        files,
      });
    }

    const subdirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    for (const subdir of subdirs) {
      walk(path.join(currentDir, subdir));
    }
  }

  walk(rootFolder);
  folders.sort((left, right) => left.relativeName.localeCompare(right.relativeName));
  return folders;
}

function packFolder(folderPath, outputFile, options = {}) {
  const append = Boolean(options.append);
  const folders = collectPackFolders(folderPath);

  if (folders.length === 0) {
    throw new Error(`No packable files found in ${folderPath}`);
  }

  const chunks = [];
  for (const folder of folders) {
    const folderNameBytes = compressString(folder.relativeName);
    chunks.push(Buffer.from([0]));
    chunks.push(encodeULEB128(folderNameBytes.length));
    chunks.push(folderNameBytes);
    chunks.push(encodeULEB128(folder.files.length));

    for (const filename of folder.files) {
      const filePath = path.join(folder.folderPath, filename);
      const content = fs.readFileSync(filePath);
      const fileNameBytes = compressString(filename);
      const encodedContent = isAlreadyBrotli(filename) ? content : compressBrotli(content);

      chunks.push(encodeULEB128(fileNameBytes.length));
      chunks.push(fileNameBytes);
      chunks.push(Buffer.from([0]));
      chunks.push(encodeULEB128(encodedContent.length));
      chunks.push(encodedContent);
    }
  }

  const outputBuffer = Buffer.concat(chunks);
  if (append && fs.existsSync(outputFile)) {
    fs.appendFileSync(outputFile, outputBuffer);
  } else {
    fs.writeFileSync(outputFile, outputBuffer);
  }

  return outputFile;
}

function addFolder(archivePath, folderPath) {
  return packFolder(folderPath, archivePath, { append: true });
}

function packSource(source) {
  let folderPath;
  let outputHash;

  if (isMd5Hash(source)) {
    folderPath = path.join(UNPACKED_DIR, source.toLowerCase());
    outputHash = source.toLowerCase();
  } else {
    folderPath = source.replace(/[\\/]+$/, '');
    outputHash = md5Hash(path.basename(folderPath));
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`Folder not found: ${folderPath}`);
  }

  const subdirs = fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (subdirs.length === 0) {
    throw new Error(`No subdirectories found in ${folderPath}`);
  }

  const outputFile = `${outputHash}.bin`;
  console.log(`Packing ${subdirs.length} subfolders from ${folderPath} to ${outputFile}`);
  console.log(`Subfolders: ${subdirs.join(', ')}`);

  packFolder(path.join(folderPath, subdirs[0]), outputFile);
  for (const subdir of subdirs.slice(1)) {
    addFolder(outputFile, path.join(folderPath, subdir));
  }

  const finalSize = fs.statSync(outputFile).size;
  console.log(`Packing complete: ${outputFile} (${finalSize.toLocaleString()} bytes)`);
  return outputFile;
}

class PackedArchive {
  constructor(archivePath) {
    this.path = archivePath;
    this.entries = new Map();
    this.folders = new Map();
    this.folderCopies = new Map();
    this.initialized = false;
    this.data = null;
  }

  async init() {
    if (this.initialized) {
      return;
    }

    this.data = await fsp.readFile(this.path);
    this.parseIndex(this.data);
    this.resolveFolderCopies();
    this.initialized = true;
  }

  parseIndex(buffer) {
    let offset = 0;

    while (offset < buffer.length) {
      const folderType = buffer[offset];
      offset += 1;

      const folderNameLength = readULEB128(buffer, offset);
      offset += folderNameLength.bytesRead;
      const folderName = readUtf8Slice(buffer, offset, folderNameLength.value);
      offset += folderNameLength.value;

      if (folderType === 1) {
        const sourceLength = readULEB128(buffer, offset);
        offset += sourceLength.bytesRead;
        const sourceName = readUtf8Slice(buffer, offset, sourceLength.value);
        offset += sourceLength.value;
        this.folderCopies.set(folderName, sourceName);
        continue;
      }

      const fileCount = readULEB128(buffer, offset);
      offset += fileCount.bytesRead;

      this.folders.set(folderName, []);

      for (let index = 0; index < fileCount.value; index += 1) {
        const fileNameLength = readULEB128(buffer, offset);
        offset += fileNameLength.bytesRead;
        const fileName = readUtf8Slice(buffer, offset, fileNameLength.value);
        offset += fileNameLength.value;

        this.folders.get(folderName).push(fileName);

        const fileType = buffer[offset];
        offset += 1;
        const fullPath = `${folderName}/${fileName}`;

        if (fileType === 1) {
          const sourceFolderLength = readULEB128(buffer, offset);
          offset += sourceFolderLength.bytesRead;
          const sourceFolder = readUtf8Slice(buffer, offset, sourceFolderLength.value);
          offset += sourceFolderLength.value;

          const sourceFileLength = readULEB128(buffer, offset);
          offset += sourceFileLength.bytesRead;
          const sourceFile = readUtf8Slice(buffer, offset, sourceFileLength.value);
          offset += sourceFileLength.value;

          this.entries.set(fullPath, {
            folder: folderName,
            filename: fileName,
            fileType: 1,
            dataOffset: 0,
            compressedSize: 0,
            refFolder: sourceFolder,
            refFilename: sourceFile,
          });
          continue;
        }

        const compressedLength = readULEB128(buffer, offset);
        offset += compressedLength.bytesRead;

        this.entries.set(fullPath, {
          folder: folderName,
          filename: fileName,
          fileType: 0,
          dataOffset: offset,
          compressedSize: compressedLength.value,
          refFolder: null,
          refFilename: null,
        });

        offset += compressedLength.value;
      }
    }
  }

  resolveFolderCopies() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [copyFolder, sourceFolder] of this.folderCopies.entries()) {
        if (this.folders.has(copyFolder) || !this.folders.has(sourceFolder)) {
          continue;
        }

        const filenames = [...this.folders.get(sourceFolder)];
        this.folders.set(copyFolder, filenames);

        for (const filename of filenames) {
          const sourcePath = `${sourceFolder}/${filename}`;
          const destinationPath = `${copyFolder}/${filename}`;
          if (this.entries.has(sourcePath)) {
            const sourceEntry = this.entries.get(sourcePath);
            this.entries.set(destinationPath, { ...sourceEntry, folder: copyFolder, filename });
          }
        }

        changed = true;
      }
    }
  }

  listFolders() {
    if (!this.initialized) {
      throw new Error('Archive not initialized. Call init() first.');
    }
    return [...this.folders.keys()];
  }

  listFiles(folder = undefined) {
    if (!this.initialized) {
      throw new Error('Archive not initialized. Call init() first.');
    }
    if (folder !== undefined) {
      return [...(this.folders.get(folder) || [])];
    }
    return [...this.entries.keys()];
  }

  exists(targetPath) {
    if (!this.initialized) {
      throw new Error('Archive not initialized. Call init() first.');
    }
    return this.entries.has(targetPath);
  }

  resolveEntry(targetPath) {
    let entry = this.entries.get(targetPath);
    if (!entry) {
      return null;
    }

    while (entry.fileType === 1) {
      const sourcePath = `${entry.refFolder}/${entry.refFilename}`;
      entry = this.entries.get(sourcePath);
      if (!entry) {
        throw new Error(`Reference target not found: ${sourcePath}`);
      }
    }

    return entry;
  }

  open(targetPath, keepBrotli = false) {
    if (!this.initialized) {
      throw new Error('Archive not initialized. Call init() first.');
    }

    const entry = this.resolveEntry(targetPath);
    if (!entry) {
      throw new Error(`File not found in archive: ${targetPath}`);
    }

    const originalName = entry.filename;
    const data = this.data.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);

    if (isAlreadyBrotli(originalName)) {
      return data;
    }

    if (keepBrotli) {
      return data;
    }

    return decompressBrotli(data);
  }

  readFile(targetPath, keepBrotli = false) {
    return this.open(targetPath, keepBrotli);
  }
}

let packedArchive = null;

async function getExistingFilePath(url) {
  const parsed = new URL(url);
  const filename = path.basename(parsed.pathname) || 'packed.bin';
  return path.join(ROOT_DIR, filename);
}

function makeRawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const requestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const request = client.request(requestOptions, (response) => {
      resolve(response);
    });

    request.on('error', reject);

    if (options.body && options.body.length > 0) {
      request.write(options.body);
    }

    request.end();
  });
}

async function downloadFile(url, destinationPath) {
  console.log(`Downloading archive from ${url}...`);
  const response = await makeRawRequest(url, {
    method: 'GET',
    headers: {
      'accept-encoding': 'identity',
    },
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Failed to download: HTTP ${response.statusCode}`);
  }

  ensureDir(path.dirname(destinationPath));
  const fileStream = fs.createWriteStream(destinationPath);
  await pipeline(response, fileStream);
  console.log(`Saved to: ${destinationPath}`);
  return destinationPath;
}

async function resolvePackedSource(source) {
  if (!isUrl(source)) {
    return source;
  }

  const localPath = await getExistingFilePath(source);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
    console.log(`Using existing archive: ${localPath} (${fs.statSync(localPath).size} bytes)`);
    return localPath;
  }

  await downloadFile(source, localPath);
  return localPath;
}

async function initPackedArchive(source) {
  const archivePath = await resolvePackedSource(source);
  if (!archivePath || !fs.existsSync(archivePath)) {
    return null;
  }

  packedArchive = new PackedArchive(archivePath);
  await packedArchive.init();
  console.log(`Loaded packed archive: ${archivePath}`);
  console.log(`  Folders: ${packedArchive.listFolders().length}`);
  console.log(`  Files: ${packedArchive.listFiles().length}`);
  return packedArchive;
}

function isInitialized() {
  return packedArchive !== null && packedArchive.initialized;
}

async function setupUnpacked(source) {
  const unpackedDir = getUnpackedDir(source);
  const isHashOnly = isMd5Hash(source);

  if (checkUnpackedExists(unpackedDir)) {
    console.log(`Using existing unpacked directory: ${unpackedDir}`);
  } else if (isHashOnly) {
    console.log(`Error: Unpacked folder not found for hash: ${source}`);
    console.log(`Expected directory: ${unpackedDir}`);
    return { vcsky: null, vcbr: null };
  } else {
    console.log(`Unpacking to: ${unpackedDir}`);
    ensureDir(unpackedDir);

    let archivePath = source;
    if (isUrl(source)) {
      const parsed = new URL(source);
      archivePath = path.join(ROOT_DIR, path.basename(parsed.pathname) || 'revcdos.bin');
      if (!(fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0)) {
        await downloadFile(source, archivePath);
      }
    } else if (!fs.existsSync(source)) {
      console.log(`Error: Archive file not found: ${source}`);
      return { vcsky: null, vcbr: null };
    }

    const archive = new PackedArchive(archivePath);
    await archive.init();

    for (const filePath of archive.listFiles()) {
      const outputFile = path.join(unpackedDir, filePath.split('/').join(path.sep));
      ensureDir(path.dirname(outputFile));
      const data = archive.readFile(filePath, isAlreadyBrotli(path.basename(filePath)));
      fs.writeFileSync(outputFile, data);
    }
  }

  let vcskyPath = null;
  let vcbrPath = null;

  const vcskyCandidate = path.join(unpackedDir, 'vcsky');
  if (fs.existsSync(vcskyCandidate) && fs.statSync(vcskyCandidate).isDirectory()) {
    vcskyPath = vcskyCandidate;
    console.log(`  vcsky: ${vcskyPath}`);
  }

  const vcbrCandidate = path.join(unpackedDir, 'vcbr');
  if (fs.existsSync(vcbrCandidate) && fs.statSync(vcbrCandidate).isDirectory()) {
    vcbrPath = vcbrCandidate;
    console.log(`  vcbr: ${vcbrPath}`);
  }

  if (!vcskyPath && !vcbrPath) {
    console.log(`Warning: No vcsky or vcbr folders found in ${unpackedDir}`);
    for (const item of fs.readdirSync(unpackedDir)) {
      const itemPath = path.join(unpackedDir, item);
      if (fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory()) {
        const vcskySub = path.join(itemPath, 'vcsky');
        const vcbrSub = path.join(itemPath, 'vcbr');
        if (fs.existsSync(vcskySub) && fs.statSync(vcskySub).isDirectory()) {
          vcskyPath = vcskySub;
        }
        if (fs.existsSync(vcbrSub) && fs.statSync(vcbrSub).isDirectory()) {
          vcbrPath = vcbrSub;
        }
      }
    }
  }

  return { vcsky: vcskyPath, vcbr: vcbrPath };
}

async function serveBuffer(res, statusCode, buffer, headers = {}, method = 'GET') {
  const responseHeaders = withCommonHeaders({ ...headers, 'Content-Length': String(buffer.length) });
  res.writeHead(statusCode, responseHeaders);
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buffer);
}

async function serveStream(res, statusCode, filePath, headers = {}, method = 'GET') {
  const stat = fs.statSync(filePath);
  const responseHeaders = withCommonHeaders({ ...headers, 'Content-Length': String(stat.size) });
  res.writeHead(statusCode, responseHeaders);
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(500, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    }
    res.end(`File stream error: ${error.message}`);
  });
  stream.pipe(res);
}

async function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  await serveBuffer(res, statusCode, body, { 'Content-Type': 'application/json; charset=utf-8' });
}

async function serveLocalFile(localPath, req, res) {
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
    return false;
  }

  const method = req.method || 'GET';
  const headers = { 'Content-Type': getMediaType(localPath) };
  const isBrFile = localPath.toLowerCase().endsWith('.br');
  const needsDecompress = isBrFile && !clientAcceptsBrotli(req);

  if (needsDecompress) {
    try {
      const raw = fs.readFileSync(localPath);
      const decompressed = decompressBrotli(raw);
      const contentType = localPath.toLowerCase().endsWith('.wasm.br') ? 'application/wasm' : 'application/octet-stream';
      await serveBuffer(res, 200, decompressed, { 'Content-Type': contentType }, method);
      return true;
    } catch (error) {
      const raw = fs.readFileSync(localPath);
      await serveBuffer(res, 200, raw, { 'Content-Type': 'application/octet-stream' }, method);
      return true;
    }
  }

  if (isBrFile) {
    headers['Content-Encoding'] = 'br';
  }

  await serveStream(res, 200, localPath, headers, method);
  return true;
}

async function proxyAndCache(req, res, url, localPath = undefined, disableCache = false) {
  if (!disableCache && localPath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    return serveLocalFile(localPath, req, res);
  }

  const method = req.method || 'GET';
  const upstreamHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!['host', 'content-length', 'accept-encoding'].includes(key.toLowerCase())) {
      upstreamHeaders[key] = value;
    }
  }
  upstreamHeaders['accept-encoding'] = 'identity';

  const body = ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : await readRequestBody(req);
  let response;
  try {
    response = await makeRawRequest(url, {
      method,
      headers: upstreamHeaders,
      body,
    });
  } catch (error) {
    res.writeHead(502, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(`Upstream request failed: ${error.message}`);
    return;
  }

  const excludedHeaders = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'content-security-policy']);
  const responseHeaders = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (!excludedHeaders.has(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  }
  Object.assign(responseHeaders, commonHeaders());

  const isBrFile = url.split('?', 1)[0].toLowerCase().endsWith('.br');
  const clientAcceptsBr = clientAcceptsBrotli(req);
  const needDecompress = isBrFile && !clientAcceptsBr;
  const contentType = response.headers['content-type'] || response.headers['Content-Type'] || 'application/octet-stream';

  if (needDecompress) {
    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];
  }

  const shouldCache = response.statusCode === 200 && !disableCache && localPath;
  const responseChunks = [];
  try {
    for await (const chunk of response) {
      responseChunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    res.writeHead(502, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end(`Upstream stream failed: ${error.message}`);
    return;
  }
  const responseBody = Buffer.concat(responseChunks);

  let outboundBody = responseBody;
  if (needDecompress) {
    try {
      outboundBody = decompressBrotli(responseBody);
    } catch (error) {
      outboundBody = responseBody;
      delete responseHeaders['content-encoding'];
      delete responseHeaders['Content-Encoding'];
    }
  }

  if (response.statusCode !== 200) {
    delete responseHeaders['content-encoding'];
    delete responseHeaders['Content-Encoding'];
  }

  if (shouldCache) {
    ensureDir(path.dirname(localPath));
    const tempPath = `${localPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, responseBody);
    fs.renameSync(tempPath, localPath);
  }

  if (!responseHeaders['content-type'] && contentType) {
    responseHeaders['content-type'] = contentType;
  }

  await serveBuffer(res, response.statusCode, outboundBody, responseHeaders, method);
}

function requestToUrl(req, requestPath, baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/?$/, '/')}${requestPath}`.replace(/\\/g, '/');
  url.search = new URL(req.url, 'http://localhost').search;
  return url.toString();
}

async function getPackedFile(filePath, req) {
  if (!isInitialized() || !packedArchive.exists(filePath)) {
    return null;
  }

  const clientAcceptsBr = clientAcceptsBrotli(req);
  const isBrFile = filePath.toLowerCase().endsWith('.br');
  const mediaType = getMediaType(filePath);

  try {
    if (isBrFile) {
      const raw = packedArchive.readFile(filePath, false);
      if (clientAcceptsBr) {
        return { statusCode: 200, body: raw, headers: withCommonHeaders({ 'Content-Type': mediaType, 'Content-Encoding': 'br' }) };
      }

      try {
        const decompressed = decompressBrotli(raw);
        return { statusCode: 200, body: decompressed, headers: withCommonHeaders({ 'Content-Type': mediaType }) };
      } catch (error) {
        return { statusCode: 200, body: raw, headers: withCommonHeaders({ 'Content-Type': mediaType }) };
      }
    }

    if (clientAcceptsBr) {
      const compressed = packedArchive.readFile(filePath, true);
      return { statusCode: 200, body: compressed, headers: withCommonHeaders({ 'Content-Type': mediaType, 'Content-Encoding': 'br' }) };
    }

    const decompressed = packedArchive.readFile(filePath, false);
    return { statusCode: 200, body: decompressed, headers: withCommonHeaders({ 'Content-Type': mediaType }) };
  } catch (error) {
    return null;
  }
}

function checkUnpackedExists(unpackedDir) {
  if (!fs.existsSync(unpackedDir) || !fs.statSync(unpackedDir).isDirectory()) {
    return false;
  }

  for (const subdir of ['vcsky', 'vcbr']) {
    const candidate = path.join(unpackedDir, subdir);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      continue;
    }

    const stack = [candidate];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isFile()) {
          return true;
        }
        if (entry.isDirectory()) {
          stack.push(entryPath);
        }
      }
    }
  }

  return false;
}

async function serveIndex(req, res) {
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.writeHead(404, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end('index.html not found');
    return;
  }

  let content = fs.readFileSync(indexPath, 'utf8');
  const customSavesValue = args.custom_saves ? '1' : '0';
  content = content.replace(
    'new URLSearchParams(window.location.search).get("custom_saves") === "1"',
    `"${customSavesValue}" === "1"`,
  );

  await serveBuffer(res, 200, Buffer.from(content, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, req.method);
}

async function serveDistFile(req, res, pathname) {
  const relativePath = pathname.replace(/^\//, '');
  const resolvedPath = safeResolve(DIST_DIR, relativePath);
  if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    return false;
  }

  const headers = { 'Content-Type': getMediaType(resolvedPath), 'Cache-Control': 'no-store' };
  await serveStream(res, 200, resolvedPath, headers, req.method);
  return true;
}

function unauthorized(res) {
  res.writeHead(401, withCommonHeaders({ 'WWW-Authenticate': "Basic realm='Restricted'", 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end('Unauthorized');
}

function basicAuthIsValid(req) {
  if (!args.login || !args.password) {
    return true;
  }

  if ((req.method || 'GET').toUpperCase() === 'OPTIONS') {
    return true;
  }

  const header = req.headers.authorization;
  if (!header) {
    return false;
  }

  const [scheme, credentials] = String(header).split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !credentials) {
    return false;
  }

  try {
    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      return false;
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (username.length !== args.login.length || password.length !== args.password.length) {
      return false;
    }

    const usernameMatch = crypto.timingSafeEqual(Buffer.from(username), Buffer.from(args.login));
    const passwordMatch = crypto.timingSafeEqual(Buffer.from(password), Buffer.from(args.password));
    return usernameMatch && passwordMatch;
  } catch (error) {
    return false;
  }
}

async function handleCustomSaves(req, res, pathname) {
  if (!args.custom_saves) {
    return false;
  }

  if (pathname === '/token/get' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id') || '';
    await sendJson(res, 200, { token: id, premium: true, email: 'local@user' });
    return true;
  }

  if (pathname === '/saves/upload' && req.method === 'POST') {
    const body = await readRequestBody(req);
    const { fields, file } = parseMultipartFormData(body, req.headers['content-type']);
    if (!fields.token || !fields.fileName || !file) {
      await sendJson(res, 400, { error: 'Invalid upload payload' });
      return true;
    }

    const safeFilename = path.basename(fields.fileName);
    const saveDir = path.join(ROOT_DIR, 'saves');
    ensureDir(saveDir);
    const savePath = path.join(saveDir, `${fields.token}_${safeFilename}`);
    fs.writeFileSync(savePath, file.content);
    await sendJson(res, 200, { success: true });
    return true;
  }

  if (pathname.startsWith('/saves/download/') && req.method === 'GET') {
    const match = /^\/saves\/download\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match) {
      return false;
    }

    const token = decodeURIComponent(match[1]);
    const fileName = decodeURIComponent(match[2]);
    const safeFilename = path.basename(fileName);
    const savePath = path.join(ROOT_DIR, 'saves', `${token}_${safeFilename}`);

    if (!fs.existsSync(savePath)) {
      await sendJson(res, 404, { error: 'File not found' });
      return true;
    }

    await serveStream(res, 200, savePath, { 'Content-Type': getMediaType(savePath) }, req.method);
    return true;
  }

  return false;
}

async function handleVcRoute(req, res, pathname, prefix, baseUrl, localSetting, cacheEnabled) {
  const routePrefix = `/${prefix}`;
  if (pathname !== routePrefix && !pathname.startsWith(`${routePrefix}/`)) {
    return false;
  }

  const requestPath = pathname === routePrefix ? '' : pathname.slice(routePrefix.length + 1);
  const packedPath = `${prefix}/${requestPath}`;

  if (args.packed && isInitialized()) {
    const packedResponse = await getPackedFile(packedPath, req);
    if (packedResponse) {
      await serveBuffer(res, packedResponse.statusCode, packedResponse.body, packedResponse.headers, req.method);
      return true;
    }
  }

  if (localSetting) {
    const localPath = safeResolve(localSetting, requestPath);
    if (localPath && (await serveLocalFile(localPath, req, res))) {
      return true;
    }

    if (args[`${prefix}_local`] !== undefined || args.unpacked) {
      res.writeHead(404, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('File not found');
      return true;
    }
  }

  const proxyUrl = requestToUrl(req, requestPath, baseUrl);
  const cachePath = cacheEnabled ? safeResolve(ROOT_DIR, path.join(prefix, requestPath)) : undefined;
  await proxyAndCache(req, res, proxyUrl, cachePath, !cacheEnabled);
  return true;
}

async function handleRequest(req, res) {
  if (!basicAuthIsValid(req)) {
    unauthorized(res);
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (await handleCustomSaves(req, res, pathname)) {
    return;
  }

  if (await handleVcRoute(req, res, pathname, 'vcsky', args.vcsky_url, args.vcsky_local, args.vcsky_cache)) {
    return;
  }

  if (await handleVcRoute(req, res, pathname, 'vcbr', args.vcbr_url, args.vcbr_local, args.vcbr_cache)) {
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/') {
      await serveIndex(req, res);
      return;
    }

    if (await serveDistFile(req, res, pathname)) {
      return;
    }
  }

  res.writeHead(404, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end('Not found');
}

async function initServer() {
  if (args.pack) {
    try {
      const packedFile = packSource(args.pack);
      args.packed = packedFile;
    } catch (error) {
      console.error(`Packing failed: ${error.message}`);
      process.exitCode = 1;
      return false;
    }
  }

  if (args.unpacked) {
    const { vcsky, vcbr } = await setupUnpacked(args.unpacked);
    if (vcsky) {
      args.vcsky_local = vcsky;
    }
    if (vcbr) {
      args.vcbr_local = vcbr;
    }
  }

  if (args.packed) {
    const result = await initPackedArchive(args.packed);
    if (!result) {
      console.log(`Warning: Failed to initialize packed archive from: ${args.packed}`);
    }
  }

  return true;
}

async function main() {
  const initialized = await initServer();
  if (!initialized) {
    return;
  }

  const activeClients = new Map();
  const logActiveClients = () => {
    console.log(`[connections] ${formatClientSummary(activeClients)}`);
  };

  const server = http.createServer((req, res) => {
    activeClients.set(req.socket, {
      ip: getClientIp(req),
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
      path: req.url || '/',
      method: req.method || 'GET',
      lastSeenAt: new Date().toISOString(),
    });

    handleRequest(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        res.writeHead(500, withCommonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      }
      res.end(`Internal server error: ${error.message}`);
    });
  });

  server.on('connection', (socket) => {
    socket.on('close', () => {
      if (activeClients.delete(socket)) {
        logActiveClients();
      }
    });
  });

  const host = '0.0.0.0';
  server.listen(args.port, host, () => {
    console.log(`Server started at http://localhost:${args.port}`);
    logActiveClients();
    const interval = setInterval(logActiveClients, 10000);
    interval.unref();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});