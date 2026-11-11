import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZipArchive } from './pack-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcPlugin = path.join(rootDir, 'plugin');
const outDevDir = path.join(rootDir, 'dist', 'dev-plugin');
const outDevZip = path.join(rootDir, 'dist', 'community-notes-local-test.otzplugin');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.otzignore') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function collectDirFiles(dir, baseDir = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (ent.isDirectory()) out.push(...collectDirFiles(full, baseDir));
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

fs.rmSync(outDevDir, { recursive: true, force: true });
copyDir(srcPlugin, outDevDir);

// Patch manifest.json & config.js in dist/dev-plugin for local 127.0.0.1:8787 testing
const manifestPath = path.join(outDevDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = '0.4.1';
manifest.permissions = manifest.permissions.map((p) => (p === 'network.access' ? 'network.localhost' : p));
manifest.network = { enabled: true, allowlist: ['http://127.0.0.1:8787'] };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const cfgPath = path.join(outDevDir, 'js', 'config.js');
let cfg = fs.readFileSync(cfgPath, 'utf8');
cfg = cfg.replace(/DEFAULT_API_BASE:\s*'[^']*'/, "DEFAULT_API_BASE: 'http://127.0.0.1:8787'");
fs.writeFileSync(cfgPath, cfg, 'utf8');

const zipInfo = buildZipArchive(collectDirFiles(outDevDir), outDevZip);

console.log('Built local dev plugin folder at:', outDevDir);
console.log('Built local test .otzplugin archive at:', zipInfo.path);
console.log('Run local Worker with: npm run dev:worker');
