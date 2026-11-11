import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1SqliteAdapter } from '../tests/d1-sqlite-adapter.mjs';
import { handleRequest } from '../worker/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dbFile = process.env.LOCAL_DB_PATH || path.join(rootDir, '.wrangler-local.sqlite');
const port = Number(process.env.PORT || 8787);

const db = new D1SqliteAdapter(dbFile);
db.applyMigrationFile(path.join(rootDir, 'worker', 'migrations', '0001_initial.sql'));

const env = {
  DB: db,
  MIN_PLUGIN_VERSION: '0.1.0',
  WRITES_ENABLED: 'true',
  INVITE_REQUIRED: process.env.INVITE_REQUIRED || 'false',
  ADMIN_BOOTSTRAP_SECRET: process.env.ADMIN_BOOTSTRAP_SECRET || 'local-dev-admin-secret',
  CHALLENGE_SECRET: process.env.CHALLENGE_SECRET || 'local-dev-challenge-secret',
  POW_DIFFICULTY: process.env.POW_DIFFICULTY || '12',
};

// Seed one demo invite code for beta testing
await db.prepare(`
  INSERT OR IGNORE INTO invites (code, created_by, level, created_at)
  VALUES ('OTZ-BETA-2026', 'system', 'active', ?)
`).bind(Date.now()).run();

await db.prepare(`
  INSERT OR IGNORE INTO invites (code, created_by, level, created_at)
  VALUES ('OTZ-MOD-2026', 'system', 'moderator', ?)
`).bind(Date.now()).run();

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyBuf = Buffer.concat(chunks);
    const url = `http://${req.headers.host || `127.0.0.1:${port}`}${req.url}`;

    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
    });

    const webRes = await handleRequest(webReq, env);
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    const arrBuf = await webRes.arrayBuffer();
    res.end(Buffer.from(arrBuf));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Otzaria Community Notes local dev Worker listening on http://127.0.0.1:${port}`);
  console.log(`Database: ${dbFile}`);
  console.log(`Demo beta invite: OTZ-BETA-2026 | Demo moderator invite: OTZ-MOD-2026`);
});
