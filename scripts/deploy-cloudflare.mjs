import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packPlugin } from './pack-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const workerDir = path.join(rootDir, 'worker');
const wranglerTomlPath = path.join(workerDir, 'wrangler.toml');
const manifestPath = path.join(rootDir, 'plugin', 'manifest.json');
const configJsPath = path.join(rootDir, 'plugin', 'js', 'config.js');

const WRANGLER_BIN = process.platform === 'win32'
  ? path.join(workerDir, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(workerDir, 'node_modules', '.bin', 'wrangler');

function runWrangler(args, { input = null, allowFail = false } = {}) {
  const cmd = fs.existsSync(WRANGLER_BIN) ? WRANGLER_BIN : 'npx';
  const fullArgs = cmd === 'npx' ? ['wrangler', ...args] : args;
  const res = spawnSync(cmd, fullArgs, {
    cwd: workerDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    input: input ?? undefined,
  });
  if (!allowFail && res.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

async function main() {
  console.log('1. Checking Cloudflare authentication...');
  const who = runWrangler(['whoami'], { allowFail: true });
  if (who.status !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) {
    console.error('Not logged in to Cloudflare. Run: npx --prefix worker wrangler login');
    process.exit(1);
  }
  console.log(who.stdout.trim());

  console.log('\n2. Ensuring D1 database exists...');
  let toml = fs.readFileSync(wranglerTomlPath, 'utf8');
  if (toml.includes('REPLACE_WITH_D1_DATABASE_ID')) {
    let dbId = null;
    const createRes = runWrangler(['d1', 'create', 'otzaria-community-notes'], { allowFail: true });
    const outText = createRes.stdout + '\n' + createRes.stderr;
    const idMatch = outText.match(/database_id\s*=\s*"([a-f0-9-]+)"/i);
    if (idMatch) {
      dbId = idMatch[1];
    } else {
      // Check if database already exists via d1 list
      const listRes = runWrangler(['d1', 'list', '--json']);
      const list = JSON.parse(listRes.stdout);
      const found = list.find((d) => d.name === 'otzaria-community-notes');
      if (!found) throw new Error('Could not create or locate D1 database:\n' + outText);
      dbId = found.uuid;
    }
    toml = toml.replace('REPLACE_WITH_D1_DATABASE_ID', dbId);
    fs.writeFileSync(wranglerTomlPath, toml, 'utf8');
    console.log('Configured D1 database_id:', dbId);
  } else {
    console.log('D1 database_id already set in worker/wrangler.toml');
  }

  console.log('\n3. Applying D1 remote migrations...');
  const migRes = runWrangler(['d1', 'migrations', 'apply', 'otzaria-community-notes', '--remote'], {
    input: 'y\n',
  });
  console.log(migRes.stdout.trim());

  console.log('\n4. Setting Worker secrets (CHALLENGE_SECRET & ADMIN_BOOTSTRAP_SECRET)...');
  const challengeSecret = process.env.CHALLENGE_SECRET || randomSecret();
  const adminSecret = process.env.ADMIN_BOOTSTRAP_SECRET || randomSecret();
  runWrangler(['secret', 'put', 'CHALLENGE_SECRET'], { input: challengeSecret + '\n' });
  runWrangler(['secret', 'put', 'ADMIN_BOOTSTRAP_SECRET'], { input: adminSecret + '\n' });

  console.log('\n5. Deploying Cloudflare Worker...');
  const depRes = runWrangler(['deploy']);
  console.log(depRes.stdout);
  const urlMatch = (depRes.stdout + '\n' + depRes.stderr).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  if (!urlMatch) {
    throw new Error('Could not parse deployed workers.dev URL from wrangler output.');
  }
  const workerUrl = urlMatch[0].replace(/\/+$/, '');
  console.log('Deployed Worker URL:', workerUrl);

  console.log('\n6. Updating plugin/manifest.json & plugin/js/config.js with live Worker URL...');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.network = { enabled: true, allowlist: [workerUrl] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  let cfgJs = fs.readFileSync(configJsPath, 'utf8');
  cfgJs = cfgJs.replace(/DEFAULT_API_BASE:\s*'[^']*'/, `DEFAULT_API_BASE: '${workerUrl}'`);
  fs.writeFileSync(configJsPath, cfgJs, 'utf8');

  console.log('\n7. Rebuilding & validating dist/community-notes.otzplugin...');
  const packed = packPlugin();
  console.log('Packed:', packed);

  console.log('\n8. Generating initial moderator & beta invite codes...');
  const modInvRes = await fetch(`${workerUrl}/v1/mod/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Secret': adminSecret,
    },
    body: JSON.stringify({ count: 1, level: 'moderator' }),
  });
  const modInv = await modInvRes.json();

  const betaInvRes = await fetch(`${workerUrl}/v1/mod/invites`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Secret': adminSecret,
    },
    body: JSON.stringify({ count: 5, level: 'active' }),
  });
  const betaInv = await betaInvRes.json();

  console.log('\n=== DEPLOYMENT COMPLETE ===');
  console.log('Live Worker URL:', workerUrl);
  console.log('Moderator invite code (keep private!):', modInv.codes?.[0]);
  console.log('Beta user invite codes:', betaInv.codes);
  console.log('Note: Remember to store your ADMIN_BOOTSTRAP_SECRET securely if needed later.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
