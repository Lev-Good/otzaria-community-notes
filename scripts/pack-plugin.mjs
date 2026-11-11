import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runValidation } from './validate-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pluginDir = path.join(rootDir, 'plugin');
const distDir = path.join(rootDir, 'dist');
const outputFile = path.join(distDir, 'community-notes.otzplugin');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function collectPackableFiles(dir, baseDir = dir) {
  const skipDirs = new Set(['.git', 'node_modules', 'dev', '.github', 'screenshots']);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      if (skipDirs.has(ent.name) || ent.name.startsWith('.')) continue;
      files.push(...collectPackableFiles(full, baseDir));
    } else if (ent.isFile()) {
      if (ent.name === '.otzignore' || ent.name.startsWith('.')) continue;
      if (/\.md$/i.test(ent.name)) continue;
      files.push({ name: rel, data: fs.readFileSync(full) });
    }
  }
  return files;
}

export function buildZipArchive(files, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const useStore = compressed.length >= data.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? data : compressed;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...locals, ...centrals, eocd]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, archive);
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  return { path: outPath, fileCount: files.length, bytes: archive.length, sha256 };
}

export function packPlugin() {
  const val = runValidation();
  if (val.errors.length > 0 || !val.design?.compliant) {
    throw new Error(
      `Validation failed:\nErrors: ${JSON.stringify(val.errors)}\nDesign: ${JSON.stringify(val.design)}`
    );
  }
  const files = collectPackableFiles(pluginDir);
  return buildZipArchive(files, outputFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = packPlugin();
  console.log('Packed .otzplugin successfully:', out);
}
