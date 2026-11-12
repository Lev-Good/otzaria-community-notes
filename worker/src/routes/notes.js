import { jsonResponse, errorResponse } from '../http.js';
import { authenticateRequest, verifyAndConsumeChallenge } from '../auth.js';
import { evaluateContent, runAdvisoryAiModeration } from '../moderation.js';
import {
  computeTier,
  getVoteWeightForUser,
  canPublishImmediately,
  canAnswerQuestions,
  readDailyCounts,
  maybePromoteUser,
  bumpBookVersion,
} from '../ranking.js';

const COALESCE_WINDOW_MS = 10 * 60 * 1000;
const VOTE_BURST_WINDOW_MS = 15 * 60 * 1000;

function mapPublicNote(row, viewerId = null, myVote = null) {
  const isDeleted = row.status === 'deleted';
  const isMod = row.author_role === 'moderator' || row.author_role === 'admin';
  return {
    id: row.id,
    bookUid: row.book_uid,
    titleHint: row.title_hint,
    ref: row.ref,
    sectionHint: row.section_hint,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    occurrence: row.occurrence,
    libVersion: row.lib_version,
    kind: row.kind,
    rootId: row.root_id,
    replyToId: row.reply_to_id,
    replyToAuthorName: row.reply_to_author_name || null,
    authorId: isDeleted ? null : row.author_id,
    authorName: isDeleted ? 'משתמש' : (row.author_name || 'לומד'),
    isStaff: !isDeleted && isMod,
    isOwn: viewerId ? row.author_id === viewerId : false,
    body: isDeleted ? 'ההערה נמחקה' : row.body,
    status: row.status,
    questionStatus: row.question_status,
    acceptedAnswerId: row.accepted_answer_id,
    upCount: Number(row.up_count || 0),
    downCount: Number(row.down_count || 0),
    tier: row.tier,
    replyCount: Number(row.reply_count || 0),
    answerCount: Number(row.answer_count || 0),
    myVote: myVote ? { value: myVote.value, reason: myVote.reason || null } : null,
    // Reason shown only to author (or moderator endpoints)
    moderationReason: viewerId && row.author_id === viewerId ? row.moderation_reason : null,
    moderationCategory: viewerId && row.author_id === viewerId ? row.moderation_category : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

async function createCoalescedInboxNotice(env, { userId, type, noteId, rootId, actorId, summary, now }) {
  if (!userId || (actorId && userId === actorId)) return;
  const recent = await env.DB.prepare(`
    SELECT seq FROM inbox
    WHERE user_id = ? AND root_id = ? AND type = ? AND created_at > ?
    LIMIT 1
  `).bind(userId, rootId, type, now - COALESCE_WINDOW_MS).first();

  if (recent) return; // Coalesce one alert per thread every 10 minutes
  await env.DB.prepare(`
    INSERT INTO inbox (user_id, type, note_id, root_id, actor_id, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, type, noteId, rootId, actorId || null, summary || '', now).run();
}

export async function handleGetBookIndex(request, env, bookUid) {
  const decodedBookUid = decodeURIComponent(bookUid);
  const verRow = await env.DB.prepare('SELECT version FROM book_versions WHERE book_uid = ?')
    .bind(decodedBookUid)
    .first();
  const version = verRow ? Number(verRow.version) : 0;
  const etag = `"v${version}-${decodedBookUid}"`;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=30',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const { results } = await env.DB.prepare(`
    SELECT ref,
           SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END) AS notes_count,
           SUM(CASE WHEN kind = 'question' AND question_status = 'open' THEN 1 ELSE 0 END) AS open_questions_count,
           SUM(CASE WHEN kind = 'question' THEN 1 ELSE 0 END) AS total_questions_count
    FROM notes
    WHERE book_uid = ? AND status = 'published' AND kind IN ('note', 'question')
    GROUP BY ref
  `).bind(decodedBookUid).all();

  const refs = {};
  for (const r of results || []) {
    refs[r.ref] = {
      notes: Number(r.notes_count || 0),
      openQuestions: Number(r.open_questions_count || 0),
      questions: Number(r.total_questions_count || 0),
    };
  }

  return jsonResponse({ bookUid: decodedBookUid, etag, refs }, {
    headers: {
      ETag: etag,
      'Cache-Control': 'public, max-age=30',
    },
  });
}

export async function handleGetBookNotes(request, env, bookUid) {
  const decodedBookUid = decodeURIComponent(bookUid);
  const url = new URL(request.url);
  const ref = url.searchParams.get('ref') || '';

  const auth = await authenticateRequest(request, env, '', { required: false, requireSeq: false });
  const viewerId = auth.ok && auth.user ? auth.user.id : null;

  const { results } = await env.DB.prepare(`
    SELECT n.*,
           u.display_name AS author_name,
           u.role AS author_role,
           (SELECT COUNT(*) FROM notes c WHERE c.root_id = n.id AND c.kind = 'reply' AND c.status = 'published') AS reply_count,
           (SELECT COUNT(*) FROM notes a WHERE a.root_id = n.id AND a.kind = 'answer' AND a.status = 'published') AS answer_count
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.book_uid = ?
      AND n.ref = ?
      AND n.kind IN ('note', 'question')
      AND (n.status = 'published' OR (n.status = 'pending' AND n.author_id = ?))
    ORDER BY n.created_at DESC
    LIMIT 200
  `).bind(decodedBookUid, ref, viewerId || '__none__').all();

  const voteMap = new Map();
  if (viewerId && results && results.length > 0) {
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const { results: myVotes } = await env.DB.prepare(`
      SELECT note_id, value, reason FROM votes WHERE user_id = ? AND note_id IN (${placeholders})
    `).bind(viewerId, ...ids).all();
    for (const v of myVotes || []) voteMap.set(v.note_id, v);
  }

  const items = (results || []).map((r) => mapPublicNote(r, viewerId, voteMap.get(r.id) || null));
  return jsonResponse({ bookUid: decodedBookUid, ref, items });
}

export async function handleGetQuestions(request, env) {
  const url = new URL(request.url);
  const book = url.searchParams.get('book') || '';
  const status = url.searchParams.get('status') || 'open';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));

  const auth = await authenticateRequest(request, env, '', { required: false, requireSeq: false });
  const viewerId = auth.ok && auth.user ? auth.user.id : null;

  const where = [`n.kind = 'question'`, `n.status = 'published'`];
  const params = [];

  if (status === 'open') {
    where.push(`n.question_status = 'open'`);
  } else if (status === 'answered') {
    where.push(`n.question_status = 'answered'`);
  }

  let orderBy = 'n.created_at DESC';
  if (book) {
    // Show current book first when book param is passed, or filter if scope=book
    const scope = url.searchParams.get('scope') || 'all';
    if (scope === 'book') {
      where.push(`n.book_uid = ?`);
      params.push(book);
    } else {
      orderBy = `CASE WHEN n.book_uid = ? THEN 0 ELSE 1 END ASC, CASE WHEN n.question_status = 'open' THEN 0 ELSE 1 END ASC, n.created_at DESC`;
      params.push(book);
    }
  } else {
    orderBy = `CASE WHEN n.question_status = 'open' THEN 0 ELSE 1 END ASC, n.created_at DESC`;
  }

  const sql = `
    SELECT n.*,
           u.display_name AS author_name,
           u.role AS author_role,
           (SELECT COUNT(*) FROM notes a WHERE a.root_id = n.id AND a.kind = 'answer' AND a.status = 'published') AS answer_count,
           (SELECT COUNT(*) FROM notes c WHERE c.root_id = n.id AND c.kind = 'reply' AND c.status = 'published') AS reply_count
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  params.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return jsonResponse({
    items: (results || []).map((r) => mapPublicNote(r, viewerId, null)),
  });
}

export async function handleGetThread(request, env, rootId) {
  const auth = await authenticateRequest(request, env, '', { required: false, requireSeq: false });
  const viewerId = auth.ok && auth.user ? auth.user.id : null;

  let root = await env.DB.prepare(`
    SELECT n.*, u.display_name AS author_name, u.role AS author_role
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    WHERE n.id = ?
  `).bind(rootId).first();

  if (root && root.root_id) {
    const parentRoot = await env.DB.prepare(`
      SELECT n.*, u.display_name AS author_name, u.role AS author_role
      FROM notes n
      LEFT JOIN users u ON u.id = n.author_id
      WHERE n.id = ?
    `).bind(root.root_id).first();
    if (parentRoot) {
      root = parentRoot;
      rootId = parentRoot.id;
    }
  }

  if (!root) {
    return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');
  }

  const isVisibleToViewer =
    root.status === 'published' ||
    root.status === 'deleted' ||
    (viewerId && root.author_id === viewerId) ||
    (auth.user && (auth.user.role === 'moderator' || auth.user.role === 'admin'));

  if (!isVisibleToViewer) {
    return errorResponse(404, 'NOT_FOUND', 'הרשומה אינה זמינה');
  }

  const { results: children } = await env.DB.prepare(`
    SELECT n.*,
           u.display_name AS author_name,
           u.role AS author_role,
           ru.display_name AS reply_to_author_name
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    LEFT JOIN notes rn ON rn.id = n.reply_to_id
    LEFT JOIN users ru ON ru.id = rn.author_id
    WHERE n.root_id = ?
      AND (n.status = 'published' OR (n.status = 'pending' AND n.author_id = ?))
    ORDER BY n.created_at ASC
  `).bind(rootId, viewerId || '__none__').all();

  const allIds = [root.id, ...(children || []).map((c) => c.id)];
  const voteMap = new Map();
  if (viewerId && allIds.length > 0) {
    const placeholders = allIds.map(() => '?').join(',');
    const { results: votes } = await env.DB.prepare(`
      SELECT note_id, value, reason FROM votes WHERE user_id = ? AND note_id IN (${placeholders})
    `).bind(viewerId, ...allIds).all();
    for (const v of votes || []) voteMap.set(v.note_id, v);
  }

  const mappedChildren = (children || []).map((c) => mapPublicNote(c, viewerId, voteMap.get(c.id) || null));
  const answers = mappedChildren
    .filter((c) => c.kind === 'answer')
    .sort((a, b) => {
      if (root.accepted_answer_id === a.id) return -1;
      if (root.accepted_answer_id === b.id) return 1;
      return (b.upCount - b.downCount) - (a.upCount - a.downCount) || a.createdAt - b.createdAt;
    });
  const replies = mappedChildren.filter((c) => c.kind === 'reply');

  return jsonResponse({
    root: mapPublicNote(root, viewerId, voteMap.get(root.id) || null),
    answers,
    replies,
  });
}

export async function handleCreateNote(request, env, rawBody) {
  if (env.WRITES_ENABLED === 'false') {
    return errorResponse(503, 'WRITES_DISABLED', 'הכתיבה מושבתת זמנית. הקריאה פעילה');
  }

  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  let { user } = auth;
  const now = Date.now();

  if (user.banned_until && Number(user.banned_until) > now) {
    return errorResponse(403, 'ACCOUNT_BANNED', 'הכתיבה חסומה זמנית', {
      bannedUntil: Number(user.banned_until),
      reason: user.ban_reason || '',
    });
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const kind = body.kind;
  if (!['note', 'question', 'answer', 'reply'].includes(kind)) {
    return errorResponse(400, 'INVALID_KIND', 'סוג רשומה אינו תקין');
  }

  // Refresh potential automatic trust promotion before checking permissions
  user = await maybePromoteUser(env, user.id, now);

  // Per-user rate limit (never per-IP because of shared filtered networks)
  const daily = readDailyCounts(user, now);
  const dailyLimit = user.level === 'new' ? 15 : user.level === 'active' ? 40 : 80;
  if (daily.posts >= dailyLimit) {
    return errorResponse(429, 'RATE_LIMIT_POSTS', 'שלחת הרבה הערות בזמן קצר. נסה שוב בעוד כמה דקות', {}, {
      'Retry-After': '1800',
    });
  }

  // New users must solve a lightweight PoW challenge per write
  if (user.level === 'new') {
    const pow = await verifyAndConsumeChallenge(env, body.challengeToken, body.challengeNonce);
    if (!pow.ok) {
      return errorResponse(400, pow.error, 'נדרש אימות חישובי לפרסום משתמש חדש');
    }
  }

  let rootNote = null;
  let bookUid = String(body.bookUid || '').trim();
  let titleHint = String(body.titleHint || '').trim().slice(0, 120);
  let ref = String(body.ref || '').trim().slice(0, 160);
  let sectionHint = Number.isInteger(Number(body.sectionHint)) ? Number(body.sectionHint) : 0;
  let quote = String(body.quote || '').trim().slice(0, 200);
  let prefix = String(body.prefix || '').trim().slice(0, 30);
  let suffix = String(body.suffix || '').trim().slice(0, 30);
  const occurrence = Math.max(0, Number(body.occurrence || 0) || 0);
  const libVersion = String(body.libVersion || '').trim().slice(0, 40);

  if (kind === 'note' || kind === 'question') {
    if (!bookUid) {
      return errorResponse(400, 'MISSING_BOOK', 'מזהה ספר חסר');
    }
  } else {
    const rootId = String(body.rootId || '').trim();
    if (!rootId) {
      return errorResponse(400, 'MISSING_ROOT', 'נדרש מזהה רשומת שורש');
    }
    rootNote = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(rootId).first();
    if (!rootNote || (rootNote.status !== 'published' && rootNote.status !== 'deleted')) {
      return errorResponse(404, 'ROOT_NOT_FOUND', 'רשומת השורש לא נמצאה');
    }
    if (rootNote.root_id) {
      return errorResponse(400, 'MAX_DEPTH', 'ניתן להגיב בשתי רמות בלבד');
    }
    if (kind === 'answer') {
      if (rootNote.kind !== 'question') {
        return errorResponse(400, 'ANSWER_ONLY_TO_QUESTION', 'ניתן לשלוח תשובה רק לשאלה');
      }
      if (!canAnswerQuestions(user)) {
        return errorResponse(403, 'ANSWER_LEVEL_REQUIRED', 'מענה לשאלות זמין החל מרמה פעילה');
      }
    }
    bookUid = rootNote.book_uid;
    titleHint = rootNote.title_hint;
    ref = rootNote.ref;
    sectionHint = rootNote.section_hint;
    quote = rootNote.quote;
    prefix = '';
    suffix = '';
  }

  const evalRes = evaluateContent(body.body, quote);
  if (!evalRes.ok) {
    return errorResponse(400, evalRes.code, evalRes.message);
  }

  const aiRes = await runAdvisoryAiModeration(env, evalRes.body, quote);
  let status = 'published';
  let moderationCategory = evalRes.category || null;
  let moderationReason = null;
  let riskScore = evalRes.riskScore + aiRes.riskDelta;

  if (evalRes.action === 'reject') {
    status = 'rejected';
    moderationReason = `נדחה אוטומטית: ${moderationCategory}`;
  } else if (evalRes.action === 'pending' || aiRes.flags.length > 0 || !canPublishImmediately(user)) {
    status = 'pending';
    if (!canPublishImmediately(user) && evalRes.softFlags.length === 0 && aiRes.flags.length === 0) {
      moderationCategory = 'אישור מראש לחדשים';
    }
  }

  const noteId = crypto.randomUUID();
  const questionStatus = kind === 'question' ? 'open' : null;
  const replyToId = body.replyToId ? String(body.replyToId).trim() : null;

  await env.DB.prepare(`
    INSERT INTO notes (
      id, book_uid, title_hint, ref, section_hint, quote, prefix, suffix, occurrence, lib_version,
      kind, root_id, reply_to_id, author_id, body, status, question_status,
      tier, moderation_reason, moderation_category, risk_score, ai_flags, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
  `).bind(
    noteId, bookUid, titleHint, ref, sectionHint, quote, prefix, suffix, occurrence, libVersion,
    kind, rootNote ? rootNote.id : null, replyToId, user.id, evalRes.body, status, questionStatus,
    moderationReason, moderationCategory, riskScore, JSON.stringify(aiRes.flags || []), now
  ).run();

  daily.posts += 1;
  await env.DB.prepare('UPDATE users SET daily_counts = ? WHERE id = ?')
    .bind(JSON.stringify(daily), user.id)
    .run();

  if (status === 'published') {
    await bumpBookVersion(env, bookUid, now);

    if (rootNote) {
      const targetType = kind === 'answer' ? 'answer' : 'reply';
      const summary = kind === 'answer'
        ? `${user.display_name} ענה לשאלתך ב${titleHint || bookUid} ${ref}`
        : `${user.display_name} הגיב להערתך ב${titleHint || bookUid} ${ref}`;
      await createCoalescedInboxNotice(env, {
        userId: rootNote.author_id,
        type: targetType,
        noteId,
        rootId: rootNote.id,
        actorId: user.id,
        summary,
        now,
      });

      if (replyToId) {
        const parentReply = await env.DB.prepare('SELECT author_id FROM notes WHERE id = ?').bind(replyToId).first();
        if (parentReply && parentReply.author_id !== rootNote.author_id) {
          await createCoalescedInboxNotice(env, {
            userId: parentReply.author_id,
            type: 'reply',
            noteId,
            rootId: rootNote.id,
            actorId: user.id,
            summary: `${user.display_name} הגיב לתגובתך ב${titleHint || bookUid} ${ref}`,
            now,
          });
        }
      }
    }
  }

  return jsonResponse({
    note: {
      id: noteId,
      status,
      moderationCategory,
      moderationReason,
      tier: 'new',
      createdAt: now,
    },
  }, { status: 201 });
}

export async function handleUpdateNote(request, env, noteId, rawBody) {
  if (env.WRITES_ENABLED === 'false') {
    return errorResponse(503, 'WRITES_DISABLED', 'הכתיבה מושבתת זמנית. הקריאה פעילה');
  }
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;
  const now = Date.now();

  const existing = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!existing || existing.status === 'deleted') {
    return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');
  }
  if (existing.author_id !== user.id) {
    return errorResponse(403, 'FORBIDDEN', 'ניתן לערוך רק רשומות שלך');
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  // Anchor cannot be changed on edit
  const evalRes = evaluateContent(body.body, existing.quote);
  if (!evalRes.ok) {
    return errorResponse(400, evalRes.code, evalRes.message);
  }
  const aiRes = await runAdvisoryAiModeration(env, evalRes.body, existing.quote);

  let nextStatus = existing.status;
  let moderationCategory = existing.moderation_category;
  let moderationReason = existing.moderation_reason;
  let riskScore = Math.max(existing.risk_score, evalRes.riskScore + aiRes.riskDelta);

  if (evalRes.action === 'reject') {
    nextStatus = 'rejected';
    moderationCategory = evalRes.category;
    moderationReason = `נדחה אוטומטית: ${evalRes.category}`;
  } else if (evalRes.action === 'pending' || aiRes.flags.length > 0 || !canPublishImmediately(user)) {
    nextStatus = 'pending';
    moderationCategory = evalRes.category || (aiRes.flags[0] || 'בדיקה לאחר עריכה');
    moderationReason = null;
  } else {
    nextStatus = 'published';
    moderationCategory = null;
    moderationReason = null;
  }

  await env.DB.prepare(`
    UPDATE notes
    SET body = ?, status = ?, moderation_category = ?, moderation_reason = ?, risk_score = ?, ai_flags = ?, edited_at = ?
    WHERE id = ?
  `).bind(
    evalRes.body, nextStatus, moderationCategory, moderationReason, riskScore,
    JSON.stringify(aiRes.flags || []), now, noteId
  ).run();

  await bumpBookVersion(env, existing.book_uid, now);

  return jsonResponse({
    note: {
      id: noteId,
      body: evalRes.body,
      status: nextStatus,
      moderationCategory,
      moderationReason,
      editedAt: now,
    },
  });
}

export async function handleDeleteNote(request, env, noteId, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;
  const now = Date.now();

  const existing = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!existing || existing.status === 'deleted') {
    return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');
  }
  if (existing.author_id !== user.id) {
    return errorResponse(403, 'FORBIDDEN', 'ניתן למחוק רק רשומות שלך');
  }

  const childCountRow = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM notes WHERE root_id = ? AND status = 'published'
  `).bind(noteId).first();
  const hasChildren = Number(childCountRow?.cnt || 0) > 0;

  if (!existing.root_id && hasChildren) {
    // Keep thread replies with tombstone message per spec
    await env.DB.prepare(`
      UPDATE notes SET status = 'deleted', body = 'ההערה נמחקה', edited_at = ? WHERE id = ?
    `).bind(now, noteId).run();
  } else {
    await env.DB.prepare(`UPDATE notes SET status = 'deleted', edited_at = ? WHERE id = ?`)
      .bind(now, noteId)
      .run();
  }

  if (existing.root_id && existing.kind === 'answer') {
    await env.DB.prepare(`
      UPDATE notes
      SET accepted_answer_id = NULL, question_status = 'open'
      WHERE id = ? AND accepted_answer_id = ?
    `).bind(existing.root_id, noteId).run();
  }

  await bumpBookVersion(env, existing.book_uid, now);
  return jsonResponse({ ok: true, id: noteId });
}

export async function handleVoteNote(request, env, noteId, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;
  const now = Date.now();

  const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!note || note.status !== 'published') {
    return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');
  }
  if (note.author_id === user.id) {
    return errorResponse(403, 'SELF_VOTE', 'אי אפשר להצביע על רשומה של עצמך');
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const value = Number(body.value);
  if (![1, -1, 0].includes(value)) {
    return errorResponse(400, 'INVALID_VOTE', 'ערך הצבעה אינו תקין');
  }

  const validReasons = ['wrong', 'off_topic', 'unclear', 'inappropriate'];
  const reason = value === -1 ? String(body.reason || '') : null;
  if (value === -1 && !validReasons.includes(reason)) {
    return errorResponse(400, 'REASON_REQUIRED', 'בסימון "לא מועיל" חובה לציין סיבה');
  }

  const daily = readDailyCounts(user, now);
  if (value !== 0 && daily.votes >= 60) {
    return errorResponse(429, 'RATE_LIMIT_VOTES', 'הגעת למגבלת ההצבעות היומית (60)');
  }

  const weight = getVoteWeightForUser(user, now);
  if (value === 0) {
    await env.DB.prepare('DELETE FROM votes WHERE note_id = ? AND user_id = ?').bind(noteId, user.id).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO votes (note_id, user_id, value, reason, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id, user_id) DO UPDATE SET
        value = excluded.value,
        reason = excluded.reason,
        weight = excluded.weight,
        created_at = excluded.created_at
    `).bind(noteId, user.id, value, reason, weight, now).run();

    daily.votes += 1;
    await env.DB.prepare('UPDATE users SET daily_counts = ? WHERE id = ?')
      .bind(JSON.stringify(daily), user.id)
      .run();
  }

  // Recompute aggregates from votes table
  const agg = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN value = 1 THEN weight ELSE 0 END), 0) AS w_up,
      COALESCE(SUM(CASE WHEN value = -1 THEN weight ELSE 0 END), 0) AS w_down,
      COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS up_count,
      COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS down_count
    FROM votes
    WHERE note_id = ?
  `).bind(noteId).first();

  let isAccepted = false;
  if (note.root_id) {
    const root = await env.DB.prepare('SELECT accepted_answer_id FROM notes WHERE id = ?').bind(note.root_id).first();
    isAccepted = root?.accepted_answer_id === note.id;
  }

  const wUp = Number(agg?.w_up || 0);
  const wDown = Number(agg?.w_down || 0);
  const upCount = Number(agg?.up_count || 0);
  const downCount = Number(agg?.down_count || 0);
  const tier = computeTier({ wUp, wDown, createdAt: note.created_at, isAcceptedAnswer: isAccepted, now });

  await env.DB.prepare(`
    UPDATE notes SET w_up = ?, w_down = ?, up_count = ?, down_count = ?, tier = ? WHERE id = ?
  `).bind(wUp, wDown, upCount, downCount, tier, noteId).run();

  // "inappropriate" also counts as a report
  if (value === -1 && reason === 'inappropriate') {
    await registerReportInternal(env, { note, reporter: user, reason: 'inappropriate', details: 'סומן כלא ראוי בהצבעה', now });
  }

  // Anti-manipulation: detect concentrated votes from same voter on same author in short window
  if (value !== 0) {
    const burst = await env.DB.prepare(`
      SELECT COUNT(*) AS cnt
      FROM votes v
      JOIN notes n ON n.id = v.note_id
      WHERE v.user_id = ? AND n.author_id = ? AND v.created_at >= ?
    `).bind(user.id, note.author_id, now - VOTE_BURST_WINDOW_MS).first();
    if (Number(burst?.cnt || 0) >= 4) {
      await env.DB.prepare(`
        INSERT INTO mod_log (id, actor_id, action, target, reason, details, at)
        VALUES (?, ?, 'vote_burst_flag', ?, 'הצבעות מרוכזות בחלון זמן קצר', ?, ?)
      `).bind(crypto.randomUUID(), user.id, note.author_id, JSON.stringify({ noteId, count: burst.cnt }), now).run();
    }
  }

  return jsonResponse({
    noteId,
    upCount,
    downCount,
    tier,
    myVote: value === 0 ? null : { value, reason },
  });
}

export async function handleAcceptAnswer(request, env, answerId, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;
  const now = Date.now();

  const answer = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(answerId).first();
  if (!answer || answer.kind !== 'answer' || answer.status !== 'published') {
    return errorResponse(404, 'NOT_FOUND', 'התשובה לא נמצאה');
  }
  const question = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(answer.root_id).first();
  if (!question || question.kind !== 'question') {
    return errorResponse(404, 'QUESTION_NOT_FOUND', 'השאלה לא נמצאה');
  }
  if (question.author_id !== user.id) {
    return errorResponse(403, 'ONLY_ASKER_CAN_ACCEPT', 'רק השואל יכול לסמן תשובה מקובלת');
  }

  let body = {};
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = {};
  }

  const accept = body.accepted !== false && question.accepted_answer_id !== answer.id;
  const prevAcceptedId = question.accepted_answer_id;

  if (accept) {
    await env.DB.prepare(`
      UPDATE notes SET accepted_answer_id = ?, question_status = 'answered' WHERE id = ?
    `).bind(answer.id, question.id).run();
    await env.DB.prepare(`UPDATE notes SET tier = 'recommended' WHERE id = ?`).bind(answer.id).run();

    // Demote previously accepted answer back to computed tier if there was one
    if (prevAcceptedId && prevAcceptedId !== answer.id) {
      const prev = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(prevAcceptedId).first();
      if (prev) {
        const prevTier = computeTier({ wUp: prev.w_up, wDown: prev.w_down, createdAt: prev.created_at, isAcceptedAnswer: false, now });
        await env.DB.prepare('UPDATE notes SET tier = ? WHERE id = ?').bind(prevTier, prev.id).run();
      }
    }

    await createCoalescedInboxNotice(env, {
      userId: answer.author_id,
      type: 'accepted',
      noteId: answer.id,
      rootId: question.id,
      actorId: user.id,
      summary: `${user.display_name} סימן את תשובתך כמקובלת ב${question.title_hint || question.book_uid} ${question.ref}`,
      now,
    });
  } else {
    const newTier = computeTier({ wUp: answer.w_up, wDown: answer.w_down, createdAt: answer.created_at, isAcceptedAnswer: false, now });
    await env.DB.prepare(`
      UPDATE notes SET accepted_answer_id = NULL, question_status = 'open' WHERE id = ?
    `).bind(question.id).run();
    await env.DB.prepare(`UPDATE notes SET tier = ? WHERE id = ?`).bind(newTier, answer.id).run();
  }

  await bumpBookVersion(env, question.book_uid, now);

  return jsonResponse({
    questionId: question.id,
    questionStatus: accept ? 'answered' : 'open',
    acceptedAnswerId: accept ? answer.id : null,
  });
}

async function registerReportInternal(env, { note, reporter, reason, details, now }) {
  const ins = await env.DB.prepare(`
    INSERT OR IGNORE INTO reports (id, note_id, reporter_id, reason, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), note.id, reporter.id, reason, details.slice(0, 300), now).run();

  const inserted = (ins?.meta?.changes ?? ins?.changes ?? 0) > 0;
  if (!inserted) {
    return { autoHidden: note.status === 'hidden', duplicate: true };
  }

  // Raise risk score for mod queue only on first report by this user
  await env.DB.prepare('UPDATE notes SET risk_score = risk_score + 20 WHERE id = ?').bind(note.id).run();

  // Check distinct reporters of level active+
  const cntRow = await env.DB.prepare(`
    SELECT COUNT(DISTINCT r.reporter_id) AS cnt
    FROM reports r
    JOIN users u ON u.id = r.reporter_id
    WHERE r.note_id = ?
      AND r.resolved_by IS NULL
      AND u.level IN ('active', 'veteran', 'moderator')
  `).bind(note.id).first();

  if (Number(cntRow?.cnt || 0) >= 3 && note.status === 'published') {
    await env.DB.prepare(`
      UPDATE notes
      SET status = 'hidden',
          moderation_category = 'דווח על ידי הקהילה',
          moderation_reason = 'הוסתרה זמנית בעקבות דיווחים עד לבדיקת מודרטור',
          risk_score = risk_score + 40
      WHERE id = ?
    `).bind(note.id).run();
    await bumpBookVersion(env, note.book_uid, now);
    return { autoHidden: true };
  }
  return { autoHidden: false };
}

export async function handleReportNote(request, env, noteId, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;
  const now = Date.now();

  const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!note || note.status === 'deleted') {
    return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');
  }
  if (note.author_id === user.id) {
    return errorResponse(400, 'SELF_REPORT', 'לא ניתן לדווח על רשומה של עצמך');
  }

  const daily = readDailyCounts(user, now);
  if (daily.reports >= 25) {
    return errorResponse(429, 'RATE_LIMIT_REPORTS', 'הגעת למגבלת הדיווחים היומית');
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'קלט JSON אינו תקין');
  }

  const reason = String(body.reason || 'other').slice(0, 60);
  const details = String(body.details || '').trim();
  const res = await registerReportInternal(env, { note, reporter: user, reason, details, now });
  if (!res.duplicate) {
    daily.reports += 1;
    await env.DB.prepare('UPDATE users SET daily_counts = ? WHERE id = ?')
      .bind(JSON.stringify(daily), user.id)
      .run();
  }

  return jsonResponse({ ok: true, ...res });
}

export async function handleAppealNote(request, env, noteId, rawBody) {
  const auth = await authenticateRequest(request, env, rawBody, { required: true, requireSeq: true });
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, auth.details || {});
  const { user } = auth;
  const now = Date.now();

  const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(noteId).first();
  if (!note) return errorResponse(404, 'NOT_FOUND', 'הרשומה לא נמצאה');
  if (note.author_id !== user.id) return errorResponse(403, 'FORBIDDEN', 'ניתן לערער רק על רשומה שלך');
  if (!['rejected', 'hidden'].includes(note.status)) {
    return errorResponse(400, 'APPEAL_NOT_APPLICABLE', 'ניתן לערער רק על הערה שנדחתה או הוסתרה');
  }
  if (note.appeal_status === 'reviewed') {
    return errorResponse(400, 'APPEAL_ALREADY_REVIEWED', 'הערעור על רשומה זו כבר נבדק');
  }

  let body = {};
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = {};
  }
  const appealNote = String(body.reason || '').trim().slice(0, 400);
  const riskDelta = note.appeal_status === 'pending' ? 0 : 25;

  await env.DB.prepare(`
    UPDATE notes
    SET appeal_status = 'pending',
        appeal_note = ?,
        risk_score = risk_score + ?
    WHERE id = ?
  `).bind(appealNote, riskDelta, noteId).run();

  return jsonResponse({ ok: true, appealStatus: 'pending', updatedAt: now });
}
