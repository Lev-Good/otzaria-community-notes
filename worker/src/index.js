import { CORS_HEADERS, errorResponse, jsonResponse, readBodyText } from './http.js';
import { handleGetChallenge, handleGetConfig } from './routes/config.js';
import {
  handleCheckNameAvailability,
  handleDeleteMe,
  handleExportMe,
  handleGetInbox,
  handleGetMe,
  handleGetMyNotes,
  handleMarkInboxRead,
  handleRecoverUser,
  handleRegisterUser,
  handleUpdateMe,
} from './routes/users.js';
import {
  handleAcceptAnswer,
  handleAppealNote,
  handleCreateNote,
  handleDeleteNote,
  handleGetBookIndex,
  handleGetBookNotes,
  handleGetQuestions,
  handleGetThread,
  handleReportNote,
  handleUpdateNote,
  handleVoteNote,
} from './routes/notes.js';
import { handleCreateInvite, handleGetModLog, handleGetModQueue, handleModDecide, handleModReanchor } from './routes/mod.js';
import { buildPublicBackupSnapshot, runDailyMaintenanceAndBackup } from './backup.js';

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    // Public config & PoW challenge
    if (method === 'GET' && path === '/v1/config') return handleGetConfig(request, env);
    if (method === 'GET' && path === '/v1/challenge') return handleGetChallenge(request, env);
    if (method === 'GET' && path === '/v1/users/availability') return handleCheckNameAvailability(request, env);

    // Registration & recovery
    if (method === 'POST' && path === '/v1/users') {
      const raw = await readBodyText(request);
      return handleRegisterUser(request, env, raw);
    }
    if (method === 'POST' && path === '/v1/users/recover') {
      const raw = await readBodyText(request);
      return handleRecoverUser(request, env, raw);
    }

    // Current user endpoints
    if (method === 'GET' && path === '/v1/me') return handleGetMe(request, env);
    if (method === 'PATCH' && path === '/v1/me') {
      const raw = await readBodyText(request);
      return handleUpdateMe(request, env, raw);
    }
    if (method === 'DELETE' && path === '/v1/me') {
      const raw = await readBodyText(request);
      return handleDeleteMe(request, env, raw);
    }
    if (method === 'GET' && path === '/v1/me/notes') return handleGetMyNotes(request, env);
    if (method === 'GET' && path === '/v1/me/inbox') return handleGetInbox(request, env);
    if (method === 'POST' && path === '/v1/me/inbox/read') {
      const raw = await readBodyText(request);
      return handleMarkInboxRead(request, env, raw);
    }
    if (method === 'GET' && path === '/v1/me/export') return handleExportMe(request, env);

    // Reading routes
    const bookIndexMatch = path.match(/^\/v1\/books\/([^/]+)\/index$/);
    if (method === 'GET' && bookIndexMatch) {
      return handleGetBookIndex(request, env, bookIndexMatch[1]);
    }
    const bookNotesMatch = path.match(/^\/v1\/books\/([^/]+)\/notes$/);
    if (method === 'GET' && bookNotesMatch) {
      return handleGetBookNotes(request, env, bookNotesMatch[1]);
    }
    if (method === 'GET' && path === '/v1/questions') {
      return handleGetQuestions(request, env);
    }
    const threadMatch = path.match(/^\/v1\/notes\/([^/]+)\/thread$/);
    if (method === 'GET' && threadMatch) {
      return handleGetThread(request, env, threadMatch[1]);
    }

    // Write notes / votes / accept / report / appeal
    if (method === 'POST' && path === '/v1/notes') {
      const raw = await readBodyText(request);
      return handleCreateNote(request, env, raw);
    }
    const noteIdMatch = path.match(/^\/v1\/notes\/([^/]+)$/);
    if (method === 'PATCH' && noteIdMatch) {
      const raw = await readBodyText(request);
      return handleUpdateNote(request, env, noteIdMatch[1], raw);
    }
    if (method === 'DELETE' && noteIdMatch) {
      const raw = await readBodyText(request);
      return handleDeleteNote(request, env, noteIdMatch[1], raw);
    }
    const voteMatch = path.match(/^\/v1\/notes\/([^/]+)\/vote$/);
    if (method === 'PUT' && voteMatch) {
      const raw = await readBodyText(request);
      return handleVoteNote(request, env, voteMatch[1], raw);
    }
    const acceptMatch = path.match(/^\/v1\/notes\/([^/]+)\/accept$/);
    if (method === 'PUT' && acceptMatch) {
      const raw = await readBodyText(request);
      return handleAcceptAnswer(request, env, acceptMatch[1], raw);
    }
    const reportMatch = path.match(/^\/v1\/notes\/([^/]+)\/report$/);
    if (method === 'POST' && reportMatch) {
      const raw = await readBodyText(request);
      return handleReportNote(request, env, reportMatch[1], raw);
    }
    const appealMatch = path.match(/^\/v1\/notes\/([^/]+)\/appeal$/);
    if (method === 'POST' && appealMatch) {
      const raw = await readBodyText(request);
      return handleAppealNote(request, env, appealMatch[1], raw);
    }

    // Moderation routes
    if (method === 'GET' && path === '/v1/mod/queue') return handleGetModQueue(request, env);
    if (method === 'GET' && path === '/v1/mod/log') return handleGetModLog(request, env);
    if (method === 'POST' && path === '/v1/mod/decide') {
      const raw = await readBodyText(request);
      return handleModDecide(request, env, raw);
    }
    if (method === 'POST' && path === '/v1/mod/reanchor') {
      const raw = await readBodyText(request);
      return handleModReanchor(request, env, raw);
    }
    if (method === 'POST' && path === '/v1/mod/invites') {
      const raw = await readBodyText(request);
      return handleCreateInvite(request, env, raw);
    }

    if (method === 'GET' && path === '/v1/backup/public') {
      const byBook = await buildPublicBackupSnapshot(env);
      const books = {};
      for (const [bookUid, snapshot] of byBook.entries()) {
        books[bookUid] = snapshot;
      }
      return jsonResponse({
        schemaVersion: 1,
        license: 'CC BY-SA 4.0',
        generatedAt: new Date().toISOString(),
        bookCount: Object.keys(books).length,
        books,
      });
    }

    if (method === 'GET' && path === '/') {
      return jsonResponse({ service: 'otzaria-community-notes', status: 'ok' });
    }

    return errorResponse(404, 'ROUTE_NOT_FOUND', 'נתיב לא נמצא');
  } catch (err) {
    if (err?.status === 413) {
      return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'הבקשה גדולה מדי');
    }
    console.error('Worker error:', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'שגיאת שרת פנימית');
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDailyMaintenanceAndBackup(env));
  },
};
