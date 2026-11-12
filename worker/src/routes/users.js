import { jsonResponse, errorResponse } from '../http.js';
import {
  authenticateRequest,
  verifyAndConsumeChallenge,
  normalizeRecoveryCode,
  sha256Hex,
  timingSafeEqual,
  importP256PublicKey,
} from '../auth.js';
import { validateDisplayName } from '../moderation.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function handleCheckNameAvailability(request, env) {
  const url = new URL(request.url);
  const name = (url.searchParams.get('name') || '').trim();
  const check = validateDisplayName(name);
  if (!check.ok) {
    return jsonResponse({ available: false, code: check.code, message: check.message });
  }
  const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(display_name) = LOWER(?)')
    .bind(check.name)
    .first();
  return jsonResponse({
    available: !existing,
    code: existing ? 'NAME_TAKEN' : null,
    message: existing ? 'השם כבר תפוס, נסה שם אחר' : '',
  });
}

export async function handleRegisterUser(request, env, rawBody) {
  if (env.WRITES_ENABLED === 'false') {
    return errorResponse(503, 'WRITES_DISABLED', 'הכתיבה מושבתת זמנית. הקריאה פעילה');
  }
  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const {
    displayName,
    pubkey,
    recoveryHash,
    inviteCode,
    acceptedGuidelines,
    challengeToken,
    challengeNonce,
  } = body;

  if (acceptedGuidelines !== true) {
    return errorResponse(400, 'GUIDELINES_REQUIRED', 'יש לאשר את נוהל הקהילה לפני ההרשמה');
  }

  const nameCheck = validateDisplayName(displayName);
  if (!nameCheck.ok) {
    return errorResponse(400, nameCheck.code, nameCheck.message);
  }

  if (!recoveryHash || typeof recoveryHash !== 'string' || !/^[a-f0-9]{64}$/i.test(recoveryHash)) {
    return errorResponse(400, 'INVALID_RECOVERY_HASH', 'קוד שחזור אינו תקין');
  }

  try {
    await importP256PublicKey(pubkey);
  } catch {
    return errorResponse(400, 'INVALID_PUBKEY', 'מפתח ציבורי ECDSA P-256 אינו תקין');
  }

  // Verify PoW challenge
  const pow = await verifyAndConsumeChallenge(env, challengeToken, challengeNonce);
  if (!pow.ok) {
    return errorResponse(400, pow.error, 'פתרון האתגר החישובי נכשל או פג תוקפו');
  }

  // Check unique display name
  const dup = await env.DB.prepare('SELECT id FROM users WHERE LOWER(display_name) = LOWER(?)')
    .bind(nameCheck.name)
    .first();
  if (dup) {
    return errorResponse(409, 'NAME_TAKEN', 'השם כבר תפוס, נסה שם אחר');
  }

  // Invite verification (required during beta when INVITE_REQUIRED !== 'false')
  const inviteRequired = env.INVITE_REQUIRED !== 'false';
  let initialLevel = 'new';
  let initialRole = 'user';
  let validInvite = null;

  if (inviteCode && typeof inviteCode === 'string' && inviteCode.trim()) {
    const code = inviteCode.trim().toUpperCase();
    validInvite = await env.DB.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL')
      .bind(code)
      .first();
    if (!validInvite) {
      return errorResponse(400, 'INVALID_INVITE', 'קוד ההזמנה אינו תקין או שכבר נוצל');
    }
    if (validInvite.level === 'moderator') {
      initialLevel = 'moderator';
      initialRole = 'moderator';
    } else if (validInvite.level === 'veteran' || validInvite.level === 'active') {
      initialLevel = validInvite.level;
    }
  } else if (inviteRequired) {
    return errorResponse(403, 'INVITE_REQUIRED', 'נדרש קוד הזמנה להצטרפות לבטא');
  }

  const userId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO users (id, pubkey, recovery_hash, display_name, level, role, seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).bind(userId, pubkey.trim(), recoveryHash.toLowerCase(), nameCheck.name, initialLevel, initialRole, now).run();

  if (validInvite) {
    await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?')
      .bind(userId, now, validInvite.code)
      .run();
  }

  return jsonResponse({
    user: {
      id: userId,
      displayName: nameCheck.name,
      role: initialRole,
      createdAt: now,
      seq: 0,
    },
  }, { status: 201 });
}

export async function handleRecoverUser(request, env, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const { displayName, recoveryCode, newPubkey, newRecoveryHash, challengeToken, challengeNonce } = body;
  if (!displayName || !recoveryCode || !newPubkey) {
    return errorResponse(400, 'MISSING_FIELDS', 'חסרים פרטי שחזור');
  }

  const pow = await verifyAndConsumeChallenge(env, challengeToken, challengeNonce);
  if (!pow.ok) {
    return errorResponse(400, pow.error, 'פתרון האתגר החישובי נכשל או פג תוקפו');
  }

  try {
    await importP256PublicKey(newPubkey);
  } catch {
    return errorResponse(400, 'INVALID_PUBKEY', 'מפתח ציבורי ECDSA P-256 אינו תקין');
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(display_name) = LOWER(?) AND deleted_at IS NULL')
    .bind(String(displayName).trim())
    .first();

  if (!user || !user.recovery_hash) {
    return errorResponse(401, 'RECOVERY_FAILED', 'שם התצוגה או קוד השחזור אינם נכונים');
  }

  const candidateHash = await sha256Hex(normalizeRecoveryCode(recoveryCode));
  if (!timingSafeEqual(candidateHash, user.recovery_hash)) {
    return errorResponse(401, 'RECOVERY_FAILED', 'שם התצוגה או קוד השחזור אינם נכונים');
  }

  const nextRecoveryHash =
    newRecoveryHash && /^[a-f0-9]{64}$/i.test(newRecoveryHash)
      ? newRecoveryHash.toLowerCase()
      : user.recovery_hash;

  // Reset seq to 0 for the newly bound device key
  await env.DB.prepare('UPDATE users SET pubkey = ?, recovery_hash = ?, seq = 0 WHERE id = ?')
    .bind(newPubkey.trim(), nextRecoveryHash, user.id)
    .run();

  return jsonResponse({
    user: {
      id: user.id,
      displayName: user.display_name,
      role: user.role,
      createdAt: user.created_at,
      seq: 0,
    },
  });
}

export async function handleGetMe(request, env) {
  const auth = await authenticateRequest(request, env, '', { required: true, requireSeq: false });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  return jsonResponse({
    id: user.id,
    displayName: user.display_name,
    role: user.role,
    seq: user.seq,
    createdAt: user.created_at,
    lastNameChangeAt: user.last_name_change_at,
    bannedUntil: user.banned_until,
    banReason: user.ban_reason,
  });
}

export async function handleUpdateMe(request, env, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const now = Date.now();
  if (user.last_name_change_at && now - user.last_name_change_at < MONTH_MS) {
    return errorResponse(429, 'NAME_CHANGE_COOLDOWN', 'ניתן לשנות שם תצוגה עד פעם בחודש');
  }

  const nameCheck = validateDisplayName(body.displayName, { allowTitles: user.role !== 'user' });
  if (!nameCheck.ok) {
    return errorResponse(400, nameCheck.code, nameCheck.message);
  }

  const dup = await env.DB.prepare('SELECT id FROM users WHERE LOWER(display_name) = LOWER(?) AND id != ?')
    .bind(nameCheck.name, user.id)
    .first();
  if (dup) {
    return errorResponse(409, 'NAME_TAKEN', 'השם כבר תפוס, נסה שם אחר');
  }

  await env.DB.prepare('UPDATE users SET display_name = ?, last_name_change_at = ? WHERE id = ?')
    .bind(nameCheck.name, now, user.id)
    .run();

  return jsonResponse({ displayName: nameCheck.name, lastNameChangeAt: now });
}

export async function handleGetMyNotes(request, env) {
  const auth = await authenticateRequest(request, env, '', { required: true, requireSeq: false });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  const { results } = await env.DB.prepare(`
    SELECT n.*,
      (SELECT COUNT(*) FROM notes r WHERE r.root_id = n.id AND r.status = 'published') AS reply_count
    FROM notes n
    WHERE n.author_id = ? AND n.status != 'deleted'
    ORDER BY n.created_at DESC
    LIMIT 200
  `).bind(user.id).all();

  const stats = await env.DB.prepare(`
    SELECT COALESCE(SUM(up_count), 0) AS helped_count
    FROM notes
    WHERE author_id = ? AND status = 'published'
  `).bind(user.id).first();

  return jsonResponse({
    helpedCount: Number(stats?.helped_count || 0),
    items: (results || []).map((r) => ({
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
      questionStatus: r.question_status,
      moderationReason: r.moderation_reason,
      moderationCategory: r.moderation_category,
      appealStatus: r.appeal_status,
      upCount: r.up_count,
      downCount: r.down_count,
      replyCount: Number(r.reply_count || 0),
      createdAt: r.created_at,
      editedAt: r.edited_at,
    })),
  });
}

export async function handleGetInbox(request, env) {
  const auth = await authenticateRequest(request, env, '', { required: true, requireSeq: false });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  const url = new URL(request.url);
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));

  const { results } = await env.DB.prepare(`
    SELECT i.seq, i.type, i.note_id, i.root_id, i.actor_id, i.summary, i.created_at, i.read_at,
           u.display_name AS actor_name,
           n.book_uid, n.title_hint, n.ref
    FROM inbox i
    LEFT JOIN users u ON u.id = i.actor_id
    LEFT JOIN notes n ON n.id = i.root_id
    WHERE i.user_id = ? AND i.seq > ?
    ORDER BY i.seq DESC
    LIMIT 100
  `).bind(user.id, after).all();

  const unread = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM inbox WHERE user_id = ? AND read_at IS NULL')
    .bind(user.id)
    .first();

  return jsonResponse({
    unreadCount: Number(unread?.cnt || 0),
    items: (results || []).map((r) => ({
      seq: r.seq,
      type: r.type,
      noteId: r.note_id,
      rootId: r.root_id,
      actorName: r.actor_name || 'קהילה',
      bookUid: r.book_uid || '',
      titleHint: r.title_hint || '',
      ref: r.ref || '',
      summary: r.summary,
      createdAt: r.created_at,
      readAt: r.read_at,
    })),
  });
}

export async function handleMarkInboxRead(request, env, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const now = Date.now();
  if (body.all === true) {
    await env.DB.prepare('UPDATE inbox SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .bind(now, user.id)
      .run();
  } else if (Array.isArray(body.seqs) && body.seqs.length > 0) {
    const clean = body.seqs.map((s) => Number(s)).filter((s) => Number.isInteger(s) && s > 0).slice(0, 100);
    if (clean.length > 0) {
      const placeholders = clean.map(() => '?').join(',');
      await env.DB.prepare(`UPDATE inbox SET read_at = ? WHERE user_id = ? AND seq IN (${placeholders}) AND read_at IS NULL`)
        .bind(now, user.id, ...clean)
        .run();
    }
  } else if (body.upToSeq) {
    await env.DB.prepare('UPDATE inbox SET read_at = ? WHERE user_id = ? AND seq <= ? AND read_at IS NULL')
      .bind(now, user.id, Number(body.upToSeq))
      .run();
  }

  const unread = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM inbox WHERE user_id = ? AND read_at IS NULL')
    .bind(user.id)
    .first();

  return jsonResponse({ unreadCount: Number(unread?.cnt || 0) });
}

export async function handleExportMe(request, env) {
  const auth = await authenticateRequest(request, env, '', { required: true, requireSeq: false });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  const { results: notes } = await env.DB.prepare('SELECT * FROM notes WHERE author_id = ? ORDER BY created_at DESC')
    .bind(user.id)
    .all();
  const { results: votes } = await env.DB.prepare('SELECT note_id, value, reason, created_at FROM votes WHERE user_id = ?')
    .bind(user.id)
    .all();
  const { results: reports } = await env.DB.prepare('SELECT id, note_id, reason, details, created_at FROM reports WHERE reporter_id = ?')
    .bind(user.id)
    .all();
  const { results: inbox } = await env.DB.prepare('SELECT seq, type, note_id, root_id, summary, created_at, read_at FROM inbox WHERE user_id = ? ORDER BY seq DESC')
    .bind(user.id)
    .all();

  return jsonResponse({
    exportedAt: new Date().toISOString(),
    license: 'CC BY-SA 4.0',
    profile: {
      id: user.id,
      displayName: user.display_name,
      createdAt: user.created_at,
    },
    notes: notes || [],
    votes: votes || [],
    reports: reports || [],
    inbox: inbox || [],
  });
}

export async function handleDeleteMe(request, env, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = {};
  }
  const mode = body.mode === 'delete' ? 'delete' : 'anonymize';
  const now = Date.now();

  if (mode === 'delete') {
    await env.DB.prepare(`UPDATE notes SET status = 'deleted', body = '[נמחק על ידי הכותב]' WHERE author_id = ?`)
      .bind(user.id)
      .run();
  }
  // Anonymize or delete user identity (while maintaining FK integrity)
  const anonName = `משתמש_מחק_${user.id.slice(0, 8)}`;
  await env.DB.prepare(`
    UPDATE users
    SET pubkey = '', recovery_hash = '', display_name = ?, deleted_at = ?
    WHERE id = ?
  `).bind(anonName, now, user.id).run();

  await env.DB.prepare('DELETE FROM inbox WHERE user_id = ?').bind(user.id).run();

  return jsonResponse({ ok: true, mode });
}
