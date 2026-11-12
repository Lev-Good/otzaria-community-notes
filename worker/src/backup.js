/**
 * Public daily JSON backup per book to GitHub + maintenance tasks (60-day inbox retention) + restore utility.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function sanitizeBookFilename(bookUid) {
  const raw = String(bookUid || 'unknown');
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const slug = raw
    .replace(/[^\u0590-\u05FFa-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return `${slug || 'book'}-${h.toString(16).padStart(8, '0')}`;
}

/**
 * Build full public backup snapshot (published notes/questions/answers/replies + display names, no private hashes/bans).
 */
export async function buildPublicBackupSnapshot(env) {
  const { results: notes } = await env.DB.prepare(`
    SELECT
      n.id, n.book_uid, n.title_hint, n.ref, n.section_hint, n.quote, n.prefix, n.suffix,
      n.occurrence, n.lib_version, n.kind, n.root_id, n.reply_to_id, n.author_id,
      u.display_name AS author_name, n.body, n.question_status, n.accepted_answer_id,
      n.up_count, n.down_count, n.tier, n.created_at, n.edited_at
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.status = 'published'
    ORDER BY n.book_uid ASC, n.created_at ASC
  `).all();

  const byBook = new Map();
  for (const row of notes || []) {
    if (!byBook.has(row.book_uid)) {
      byBook.set(row.book_uid, {
        schemaVersion: 1,
        license: 'CC BY-SA 4.0',
        generatedAt: new Date().toISOString(),
        bookUid: row.book_uid,
        titleHint: row.title_hint,
        records: [],
      });
    }
    byBook.get(row.book_uid).records.push(row);
  }
  return byBook;
}

async function upsertGitHubFile({ repo, branch, token, path, content, message }) {
  const apiBase = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'otzaria-community-notes-backup',
    'Content-Type': 'application/json',
  };

  let sha = null;
  const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  }

  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message,
      content: b64,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) {
    const txt = await putRes.text();
    throw new Error(`GitHub backup failed (${putRes.status}): ${txt}`);
  }
}

export async function runDailyMaintenanceAndBackup(env) {
  const now = Date.now();
  // 1. Prune inbox messages older than 60 days & expired PoW challenges
  await env.DB.prepare('DELETE FROM inbox WHERE created_at < ?').bind(now - 60 * DAY_MS).run();
  await env.DB.prepare('DELETE FROM used_challenges WHERE expires_at < ?').bind(now).run();

  // 2. Public GitHub backup per book if configured
  const token = env.GITHUB_BACKUP_TOKEN;
  const repo = env.BACKUP_REPO;
  const branch = env.BACKUP_BRANCH || 'main';
  if (!token || !repo) {
    return { backedUpBooks: 0, skippedGithub: true };
  }

  const byBook = await buildPublicBackupSnapshot(env);
  const dateStr = new Date(now).toISOString().slice(0, 10);
  const manifest = {
    schemaVersion: 1,
    license: 'CC BY-SA 4.0',
    date: dateStr,
    books: [],
  };

  let count = 0;
  for (const [bookUid, payload] of byBook.entries()) {
    const fname = `books/${sanitizeBookFilename(bookUid)}.json`;
    await upsertGitHubFile({
      repo,
      branch,
      token,
      path: fname,
      content: JSON.stringify(payload, null, 2),
      message: `chore(backup): daily public notes snapshot for ${bookUid} (${dateStr})`,
    });
    manifest.books.push({
      bookUid,
      titleHint: payload.titleHint,
      file: fname,
      count: payload.records.length,
    });
    count++;
  }

  await upsertGitHubFile({
    repo,
    branch,
    token,
    path: 'books/index.json',
    content: JSON.stringify(manifest, null, 2),
    message: `chore(backup): update public index (${dateStr})`,
  });

  return { backedUpBooks: count, skippedGithub: false };
}

/**
 * Restore a single book backup JSON payload back into D1 (for disaster recovery & verification tests).
 */
export async function restoreBookBackupSnapshot(env, snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.records)) {
    throw new Error('Invalid backup snapshot');
  }
  let restored = 0;
  for (const r of snapshot.records) {
    // Ensure placeholder author exists if restoring onto a fresh DB
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users (id, pubkey, recovery_hash, display_name, level, role, seq, created_at)
      VALUES (?, '', '', ?, 'active', 'user', 0, ?)
    `).bind(r.author_id, r.author_name || `משתמש_${String(r.author_id).slice(0, 6)}`, r.created_at || Date.now()).run();

    await env.DB.prepare(`
      INSERT OR IGNORE INTO notes (
        id, book_uid, title_hint, ref, section_hint, quote, prefix, suffix,
        occurrence, lib_version, kind, root_id, reply_to_id, author_id, body,
        status, question_status, accepted_answer_id, up_count, down_count, tier,
        created_at, edited_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      r.id, r.book_uid, r.title_hint || '', r.ref || '', r.section_hint || 0,
      r.quote || '', r.prefix || '', r.suffix || '', r.occurrence || 0, r.lib_version || '',
      r.kind, r.root_id || null, r.reply_to_id || null, r.author_id, r.body,
      r.question_status || null, r.accepted_answer_id || null,
      r.up_count || 0, r.down_count || 0, r.tier || 'normal',
      r.created_at || Date.now(), r.edited_at || null
    ).run();
    restored++;
  }
  return { restored };
}
