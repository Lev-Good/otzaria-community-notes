import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPlugin } from '../scripts/pack-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function runStep(label, args) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(process.execPath, args, { cwd: rootDir, stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

runStep('1. Validate Otzaria Plugin (manifest + API + permissions + design compliance)', ['scripts/validate-plugin.mjs']);
runStep('2. Worker & D1 Integration Tests', ['--test', 'tests/worker.test.mjs']);
runStep('3. Plugin Client Unit Tests', ['--test', 'tests/client.test.mjs']);

console.log('\n=== 4. Build & Validate .otzplugin Archive ===');
const packed = packPlugin();
console.log('Built archive:', packed);
runStep('5. Validate Built .otzplugin Archive', ['scripts/validate-plugin.mjs', '--zip']);
console.log('\nALL CHECKS PASSED!');
