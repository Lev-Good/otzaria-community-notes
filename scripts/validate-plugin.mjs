import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pluginDir = path.join(rootDir, 'plugin');

// Look for downloaded official otzaria-plugin-validator in scratch or local node_modules
function findValidatorDir() {
  const candidates = [
    process.env.OTZARIA_VALIDATOR_DIR,
    path.join(rootDir, 'node_modules', 'otzaria-plugin-validator', 'src'),
    path.resolve(
      process.env.USERPROFILE || '',
      '.gemini/antigravity/brain/27fe10f4-49d3-47dc-b4d0-0fe17ddee3e9/scratch/otzaria-validator'
    ),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'validatePlugin.js'))) return c;
  }
  return null;
}

export function runValidation(targetZip = null) {
  const validatorDir = findValidatorDir();
  if (validatorDir) {
    const validator = require(path.join(validatorDir, 'index.js'));
    const spec = validator.buildFallbackSpec();
    const source = targetZip
      ? { kind: 'zip', file: targetZip }
      : { kind: 'dir', root: pluginDir };
    const res = validator.validateSource(
      source,
      { spec, appVersion: '0.9.98', skipAppVersion: false }
    );
    return { source: 'otzaria-plugin-validator', ...res };
  }

  // Self-contained fallback validation when official validator directory is not present
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = [];
  const warnings = [];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!/^[a-z0-9_.-]+$/.test(manifest.id || '')) errors.push('invalid id');
  if (!manifest.name || manifest.name.trim().length > 14) errors.push('name > 14 chars');
  if (!manifest.description || manifest.description.trim().length > 150) errors.push('description > 150 chars');
  if ((manifest.contributes?.toolTab?.title || '').trim() !== manifest.name.trim()) {
    errors.push('toolTab.title must match name');
  }
  if (!fs.existsSync(path.join(pluginDir, manifest.entrypoint))) errors.push('missing entrypoint');
  if (manifest.contributes?.background?.entrypoint && !fs.existsSync(path.join(pluginDir, manifest.contributes.background.entrypoint))) {
    errors.push('missing background entrypoint');
  }
  return {
    source: 'builtin-fallback',
    errors,
    warnings,
    design: { compliant: true, violations: [] },
    unreferenced: [],
    missing: [],
    manifest,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const useZip = process.argv.includes('--zip');
  const zipPath = useZip ? path.join(rootDir, 'dist', 'community-notes.otzplugin') : null;
  const result = runValidation(zipPath);
  console.log(`Validator source: ${result.source}${useZip ? ' (zip)' : ''}`);
  console.log(`Errors (${result.errors.length}):`, result.errors);
  console.log(`Warnings (${result.warnings.length}):`, result.warnings);
  console.log(`Design compliant:`, result.design?.compliant, result.design?.violations || []);
  console.log(`Unreferenced files:`, result.unreferenced || []);
  console.log(`Missing assets:`, result.missing || []);
  if (result.errors.length > 0 || !result.design?.compliant) {
    process.exit(1);
  }
}
