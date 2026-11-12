import { jsonResponse, errorResponse } from '../http.js';
import { authenticateRequest, timingSafeEqual } from '../auth.js';
import { isModerator, demoteOnUpheldReport, maybePromoteUser, bumpBookVersion } from '../ranking.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function requireModAuth(request, env, rawBody, { requireSeq = false } = {}) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq });
  if (!auth.ok) return auth;
  if (!isModerator(auth.user)) {
    return { ok: false, status: 403, code: 'MOD_ONLY', message: 'גישה למודרטורים בלבד' };
  }
  return auth;
}

export async function handleGetModQueue(request, env) {
  const auth = await requireModAuth(request, env, '', { requireSeq: false });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});

  // Queue ordered by risk_score DESC, then created_at ASC (oldest highest-risk first)
  const { results } = await env.DB.prepare(`
    SELECT n.*,
           u.display_name AS author_name,
           u.level AS author_level,
           u.created_at AS author_created_at,
           u.banned_until AS author_banned_until,
           (SELECT COUNT(*) FROM notes pn WHERE pn.author_id = n.author_id AND pn.status = 'published') AS author_published_count,
           (SELECT COUNT(*) FROM notes rn WHERE rn.author_id = n.author_id AND rn.status IN ('rejected', 'hidden')) AS author_rejected_count,
           (SELECT COUNT(*) FROM reports rp WHERE rp.note_id = n.id AND rp.resolved_by IS NULL) AS open_reports_count
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.status = 'pending'
       OR n.appeal_status = 'pending'
       OR EXISTS (SELECT 1 FROM reports rp WHERE rp.note_id = n.id AND rp.resolved_by IS NULL)
    ORDER BY n.risk_score DESC, n.created_at ASC
    LIMIT 100
  `).all();

  const items = [];
  for (const r of results || []) {
    let reports = [];
    if (Number(r.open_reports_count || 0) > 0) {
      const { results: rps } = await env.DB.prepare(`
        SELECT rp.id, rp.reason, rp.details, rp.created_at, u.display_name AS reporter_name
        FROM reports rp
        LEFT JOIN users u ON u.id = rp.reporter_id
        WHERE rp.note_id = ? AND rp.resolved_by IS NULL
        ORDER BY rp.created_at ASC
      `).bind(r.id).all();
      reports = rps || [];
    }
    items.push({
      id: r.id,
      bookUid: r.book_uid,
      titleHint: r.title_hint,
      ref: r.ref,
      sectionHint: r.section_hint,
      quote: r.quote,
      kind: r.kind,
      rootId: r.root_id,
      body: r.body,
      status: r.status,
      riskScore: r.risk_score,
      moderationCategory: r.moderation_category,
      moderationReason: r.moderation_reason,
      aiFlags: JSON.parse(r.ai_flags || '[]'),
      appealStatus: r.appeal_status,
      appealNote: r.appeal_note,
      createdAt: r.created_at,
      author: {
        id: r.author_id,
        displayName: r.author_name,
        level: r.author_level,
        createdAt: r.author_created_at,
        bannedUntil: r.author_banned_until,
        publishedCount: Number(r.author_published_count || 0),
        rejectedCount: Number(r.author_rejected_count || 0),
      },
      reports,
    });
  }

  return jsonResponse({ items });
}

export async function handleGetModLog(request, env) {
  const auth = await requireModAuth(request, env, '', { requireSeq: false });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});

  const { results } = await env.DB.prepare(`
    SELECT m.*, u.display_name AS actor_name
    FROM mod_log m
    LEFT JOIN users u ON u.id = m.actor_id
    ORDER BY m.at DESC
    LIMIT 100
  `).all();

  return jsonResponse({ items: results || [] });
}

export async function handleModDecide(request, env, rawBody) {
  const auth = await requireModAuth(request, env, rawBody, { requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user: mod } = auth;
  const now = Date.now();

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const { noteId, action, reason = '', banDays = 7 } = body;
  if (!noteId || !['approve', 'reject', 'hide', 'dismiss_reports', 'ban_temp', 'ban_perm'].includes(action)) {
    return errorResponse(400, 'INVALID_ACTION', 'פעולת מודרציה אינה תקינה');
  }

  const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!note) return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');

  let inboxType = null;
  let inboxSummary = '';

  if (action === 'approve') {
    await env.DB.prepare(`
      UPDATE notes
      SET status = 'published',
          moderation_reason = NULL,
          appeal_status = CASE WHEN appeal_status = 'pending' THEN 'reviewed' ELSE appeal_status END
      WHERE id = ?
    `).bind(noteId).run();

    await env.DB.prepare(`
      UPDATE reports SET resolved_by = ?, resolution = 'dismissed', resolved_at = ?
      WHERE note_id = ? AND resolved_by IS NULL
    `).bind(mod.id, now, noteId).run();

    await maybePromoteUser(env, note.author_id, now);
    await bumpBookVersion(env, note.book_uid, now);

    inboxType = note.appeal_status === 'pending' ? 'appeal_decision' : 'mod_approved';
    inboxSummary = `הערתך ב${note.title_hint || note.book_uid} ${note.ref} אושרה ופורסמה`;

    // If this was a newly approved reply/answer, also notify the root author!
    if (note.root_id && note.status === 'pending') {
      const root = await env.DB.prepare('SELECT author_id FROM notes WHERE id = ?').bind(note.root_id).first();
      const author = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(note.author_id).first();
      if (root && root.author_id !== note.author_id) {
        await env.DB.prepare(`
          INSERT INTO inbox (user_id, type, note_id, root_id, actor_id, summary, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          root.author_id,
          note.kind === 'answer' ? 'answer' : 'reply',
          note.id,
          note.root_id,
          note.author_id,
          `${author?.display_name || 'לומד'} השיב להערתך ב${note.title_hint || note.book_uid} ${note.ref}`,
          now
        ).run();
      }
    }
  } else if (action === 'reject' || action === 'hide') {
    const newStatus = action === 'reject' ? 'rejected' : 'hidden';
    const cleanReason = String(reason || (action === 'reject' ? 'אינו עומד בנוהל הקהילה' : 'הוסתר על ידי מודרטור')).slice(0, 240);

    await env.DB.prepare(`
      UPDATE notes
      SET status = ?,
          moderation_reason = ?,
          appeal_status = CASE WHEN appeal_status = 'pending' THEN 'reviewed' ELSE appeal_status END
      WHERE id = ?
    `).bind(newStatus, cleanReason, noteId).run();

    await env.DB.prepare(`
      UPDATE reports SET resolved_by = ?, resolution = 'upheld', resolved_at = ?
      WHERE note_id = ? AND resolved_by IS NULL
    `).bind(mod.id, now, noteId).run();

    await demoteOnUpheldReport(env, note.author_id);
    await bumpBookVersion(env, note.book_uid, now);

    inboxType = action === 'reject' ? 'mod_rejected' : 'mod_hidden';
    inboxSummary = `הערתך ב${note.title_hint || note.book_uid} ${note.ref} ${action === 'reject' ? 'נדחתה' : 'הוסתרה'}: ${cleanReason}`;
  } else if (action === 'dismiss_reports') {
    await env.DB.prepare(`
      UPDATE reports SET resolved_by = ?, resolution = 'dismissed', resolved_at = ?
      WHERE note_id = ? AND resolved_by IS NULL
    `).bind(mod.id, now, noteId).run();
    if (note.status === 'hidden') {
      await env.DB.prepare(`UPDATE notes SET status = 'published', moderation_reason = NULL WHERE id = ?`).bind(noteId).run();
      await bumpBookVersion(env, note.book_uid, now);
    }
  } else if (action === 'ban_temp' || action === 'ban_perm') {
    const until = action === 'ban_perm' ? now + 100 * 365 * DAY_MS : now + Math.max(1, Number(banDays || 7)) * DAY_MS;
    const cleanReason = String(reason || 'הפרת נוהל הקהילה').slice(0, 240);
    await env.DB.prepare('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?')
      .bind(until, cleanReason, note.author_id)
      .run();
    await env.DB.prepare(`
      UPDATE notes
      SET status = 'hidden',
          moderation_reason = ?,
          appeal_status = CASE WHEN appeal_status = 'pending' THEN 'reviewed' ELSE appeal_status END
      WHERE id = ?
    `).bind(cleanReason, noteId).run();
    await env.DB.prepare(`
      UPDATE reports SET resolved_by = ?, resolution = 'upheld', resolved_at = ?
      WHERE note_id = ? AND resolved_by IS NULL
    `).bind(mod.id, now, noteId).run();
    await demoteOnUpheldReport(env, note.author_id);
    await bumpBookVersion(env, note.book_uid, now);
    inboxType = 'mod_hidden';
    inboxSummary = `הערתך ב${note.title_hint || note.book_uid} ${note.ref} הוסתרה וחשבונך הוגבל מכתיבה: ${cleanReason}`;
  }

  if (inboxType) {
    await env.DB.prepare(`
      INSERT INTO inbox (user_id, type, note_id, root_id, actor_id, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(note.author_id, inboxType, note.id, note.root_id || note.id, mod.id, inboxSummary, now).run();
  }

  await env.DB.prepare(`
    INSERT INTO mod_log (id, actor_id, action, target, reason, details, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), mod.id, action, noteId, String(reason || ''), JSON.stringify({ authorId: note.author_id }), now).run();

  return jsonResponse({ ok: true, noteId, action });
}

/**
 * Re-anchoring tool (Stage 4): moderators can update ref/section_hint/quote/prefix/suffix after library updates.
 */
export async function handleModReanchor(request, env, rawBody) {
  const auth = await requireModAuth(request, env, rawBody, { requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user: mod } = auth;
  const now = Date.now();

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const { noteId, ref, sectionHint, quote, prefix = '', suffix = '' } = body;
  if (!noteId) return errorResponse(400, 'MISSING_NOTE_ID', 'חסר מזהה רשומה');

  const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!note) return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');

  const nextRef = ref !== undefined ? String(ref).trim().slice(0, 160) : note.ref;
  const nextSection = sectionHint !== undefined ? Number(sectionHint) : note.section_hint;
  const nextQuote = quote !== undefined ? String(quote).trim().slice(0, 200) : note.quote;
  const nextPrefix = String(prefix).trim().slice(0, 30);
  const nextSuffix = String(suffix).trim().slice(0, 30);

  await env.DB.prepare(`
    UPDATE notes SET ref = ?, section_hint = ?, quote = ?, prefix = ?, suffix = ? WHERE id = ?
  `).bind(nextRef, nextSection, nextQuote, nextPrefix, nextSuffix, noteId).run();

  await bumpBookVersion(env, note.book_uid, now);
  await env.DB.prepare(`
    INSERT INTO mod_log (id, actor_id, action, target, reason, details, at)
    VALUES (?, ?, 'reanchor', ?, 'עיגון מחדש לאחר עדכון ספרייה', ?, ?)
  `).bind(crypto.randomUUID(), mod.id, noteId, JSON.stringify({ nextRef, nextSection }), now).run();

  return jsonResponse({ ok: true, noteId, ref: nextRef, sectionHint: nextSection, quote: nextQuote });
}

export async function handleCreateInvite(request, env, rawBody) {
  // Allow either signed moderator OR bootstrap admin header (when ALLOW_BOOTSTRAP_ADMIN === 'true')
  const adminSecretHeader = request.headers.get('X-Admin-Secret');
  let actorId = null;

  if (adminSecretHeader && env.ADMIN_BOOTSTRAP_SECRET && timingSafeEqual(adminSecretHeader, env.ADMIN_BOOTSTRAP_SECRET)) {
    actorId = 'bootstrap-admin';
  } else {
    const auth = await requireModAuth(request, env, rawBody, { requireSeq: true });
    if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
    actorId = auth.user.id;
  }

  let body = {};
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = {};
  }

  const count = Math.min(50, Math.max(1, Number(body.count || 1)));
  const level = ['new', 'active', 'veteran', 'moderator'].includes(body.level) ? body.level : 'active';
  if (level === 'moderator' && actorId !== 'bootstrap-admin') {
    const modCheck = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(actorId).first();
    if (modCheck?.role !== 'admin') {
      return errorResponse(403, 'ADMIN_ONLY', 'רק מנהל ראשי רשאי להנפיק הזמנת מודרטור');
    }
  }

  const now = Date.now();
  const codes = [];
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let i = 0; i < count; i++) {
    const rnd = new Uint8Array(8);
    crypto.getRandomValues(rnd);
    let code = 'OTZ-';
    for (let j = 0; j < 8; j++) {
      if (j === 4) code += '-';
      code += alphabet[rnd[j] % alphabet.length];
    }
    await env.DB.prepare('INSERT INTO invites (code, created_by, level, created_at) VALUES (?, ?, ?, ?)')
      .bind(code, actorId, level, now)
      .run();
    codes.push(code);
  }

  return jsonResponse({ codes, level }, { status: 201 });
}
