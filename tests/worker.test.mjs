import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1SqliteAdapter } from './d1-sqlite-adapter.mjs';
import { handleRequest } from '../worker/src/index.js';
import { wilsonLowerBound, computeTier } from '../worker/src/ranking.js';
import { normalizeForDictionary, evaluateContent } from '../worker/src/moderation.js';
import { buildPublicBackupSnapshot, restoreBookBackupSnapshot } from '../worker/src/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(__dirname, '../worker/migrations/0001_initial.sql');

const subtle = crypto.subtle;
const enc = new TextEncoder();

function toB64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function sha256Hex(str) {
  const buf = await subtle.digest('SHA-256', enc.encode(str));
  return Buffer.from(buf).toString('hex');
}

async function solvePow(challenge) {
  let nonce = 0;
  while (true) {
    const hash = new Uint8Array(await subtle.digest('SHA-256', enc.encode(`${challenge.prefix}:${nonce}`)));
    let zeros = 0;
    for (const b of hash) {
      if (b === 0) {
        zeros += 8;
        continue;
      }
      for (let bit = 7; bit >= 0; bit--) {
        if ((b & (1 << bit)) === 0) zeros++;
        else break;
      }
      break;
    }
    if (zeros >= challenge.difficulty) return String(nonce);
    nonce++;
  }
}

async function makeTestClient(env) {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = await subtle.exportKey('spki', kp.publicKey);
  const pubkey = toB64Url(new Uint8Array(spki));
  let userId = null;
  let seq = 0;

  async function call(method, pathWithQuery, bodyObj = null, { auth = false, customSeq = null, adminSecret = null } = {}) {
    const bodyText = bodyObj !== null ? JSON.stringify(bodyObj) : '';
    const headers = {};
    if (bodyObj !== null) headers['Content-Type'] = 'application/json';
    if (adminSecret) headers['X-Admin-Secret'] = adminSecret;

    if (auth) {
      const ts = String(Date.now());
      const useSeq = customSeq !== null ? String(customSeq) : (method === 'GET' ? `r:${ts}` : String(++seq));
      const bodyHash = await sha256Hex(bodyText);
      const canonical = `${method.toUpperCase()}\n${pathWithQuery}\n${useSeq}\n${ts}\n${bodyHash}`;
      const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(canonical));
      headers['X-User-Id'] = userId;
      headers['X-Timestamp'] = ts;
      headers['X-Seq'] = useSeq;
      headers['X-Signature'] = toB64Url(new Uint8Array(sig));
    }

    const req = new Request(`https://example.workers.dev${pathWithQuery}`, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : bodyText,
    });
    const res = await handleRequest(req, env);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 304 etc */ }
    return { status: res.status, headers: res.headers, data: json };
  }

  return {
    pubkey,
    setUserId: (id) => { userId = id; },
    getUserId: () => userId,
    getSeq: () => seq,
    setSeq: (n) => { seq = n; },
    call,
  };
}

function makeEnv(db) {
  return {
    DB: db,
    MIN_PLUGIN_VERSION: '0.1.0',
    WRITES_ENABLED: 'true',
    INVITE_REQUIRED: 'true',
    CHALLENGE_SECRET: 'test-challenge-secret',
    ADMIN_BOOTSTRAP_SECRET: 'test-admin-secret',
    POW_DIFFICULTY: '8',
  };
}

test('Hebrew normalization, quote-context mitigation, and structural rules', () => {
  assert.equal(normalizeForDictionary('מִ.מְ.זֵ.ר'), normalizeForDictionary('ממזר'));
  assert.equal(normalizeForDictionary('זוווונה'), normalizeForDictionary('זונה'));
  assert.equal(evaluateContent('פירוש ענייני למילה מִ.מְ.זֵ.ר בסוגיה זו').action, 'pending');

  // External URL blocked, otzaria://open/book allowed, otzaria://plugin/install blocked
  assert.equal(evaluateContent('ראו כאן https://example.com לפרטים').code, 'EXTERNAL_LINK_FORBIDDEN');
  assert.equal(evaluateContent('התקן otzaria://plugin/install/bad').code, 'FORBIDDEN_OTZARIA_LINK');
  const okBook = evaluateContent('עיין בפירוש המלא otzaria://open/book/183?ref=בראשית+א');
  assert.equal(okBook.ok, true);
  assert.equal(okBook.action, 'pass');

  // Hard block term rejected automatically when NOT in quote
  const hard = evaluateContent('זה דבר מטומטם מאוד ולא מתאים');
  assert.equal(hard.action, 'reject');

  // Context mitigation: term present in quote lowers severity to soft flag (pending)
  const mitigated = evaluateContent('פירוש המילה מטומטם בפסוק זה מבואר ברש״י', 'אמר רבי פלוני מטומטם');
  assert.equal(mitigated.action, 'pending');
});

test('Wilson 95% lower bound and tier thresholds', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  const w3 = wilsonLowerBound(3, 0);
  assert.ok(w3 >= 0.43 && w3 < 0.45);
  const w4 = wilsonLowerBound(4, 0);
  assert.ok(w4 >= 0.50);

  assert.equal(computeTier({ wUp: 4, wDown: 0, createdAt: Date.now() - 10 * 86400_000 }), 'recommended');
  assert.equal(computeTier({ wUp: 0, wDown: 5, createdAt: Date.now() - 10 * 86400_000 }), 'low');
  assert.equal(computeTier({ wUp: 1, wDown: 0, createdAt: Date.now() - 2 * 86400_000 }), 'new');
  assert.equal(computeTier({ wUp: 1, wDown: 0, createdAt: Date.now() - 3 * 86400_000, isAcceptedAnswer: true }), 'recommended');
});

test('End-to-end Worker API flow: registration, ECDSA seq, notes, Q&A, votes, reports, mod, recovery, backup/restore', async () => {
  const db = new D1SqliteAdapter(':memory:');
  db.applyMigrationFile(MIGRATION_PATH);
  const env = makeEnv(db);

  try {
    const anon = await makeTestClient(env);
    const mod = await makeTestClient(env);
    const alice = await makeTestClient(env);
    const bob = await makeTestClient(env);

    // 1. Config & invites bootstrap
    const cfg = await anon.call('GET', '/v1/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.inviteRequired, true);

    const modInv = await anon.call('POST', '/v1/mod/invites', { count: 1, level: 'moderator' }, { adminSecret: 'test-admin-secret' });
    assert.equal(modInv.status, 201);
    const betaInvs = await anon.call('POST', '/v1/mod/invites', { count: 2, level: 'active' }, { adminSecret: 'test-admin-secret' });
    assert.equal(betaInvs.status, 201);

    // 2. Display name rules block titles ("הרב")
    const badName = await anon.call('GET', `/v1/users/availability?name=${encodeURIComponent('הרב פלוני')}`);
    assert.equal(badName.data.available, false);

    // Register moderator, Alice (invited active), Bob (no invite -> fails when inviteRequired=true)
    const ch1 = (await anon.call('GET', '/v1/challenge')).data;
    const modReg = await mod.call('POST', '/v1/users', {
      displayName: 'דן המודרטור',
      pubkey: mod.pubkey,
      recoveryHash: await sha256Hex('MODRECOVERY1234'),
      inviteCode: modInv.data.codes[0],
      acceptedGuidelines: true,
      challengeToken: ch1.token,
      challengeNonce: await solvePow(ch1),
    });
    assert.equal(modReg.status, 201);
    mod.setUserId(modReg.data.user.id);

    const ch2 = (await anon.call('GET', '/v1/challenge')).data;
    const bobNoInvite = await bob.call('POST', '/v1/users', {
      displayName: 'בוב החדש',
      pubkey: bob.pubkey,
      recoveryHash: await sha256Hex('BOBREC11112222'),
      acceptedGuidelines: true,
      challengeToken: ch2.token,
      challengeNonce: await solvePow(ch2),
    });
    assert.equal(bobNoInvite.status, 403);

    const ch3 = (await anon.call('GET', '/v1/challenge')).data;
    const aliceRecCode = 'ALICEREC99998888';
    const aliceReg = await alice.call('POST', '/v1/users', {
      displayName: 'יעל הלומדת',
      pubkey: alice.pubkey,
      recoveryHash: await sha256Hex(aliceRecCode),
      inviteCode: betaInvs.data.codes[0],
      acceptedGuidelines: true,
      challengeToken: ch3.token,
      challengeNonce: await solvePow(ch3),
    });
    assert.equal(aliceReg.status, 201);
    alice.setUserId(aliceReg.data.user.id);

    // Also register Bob with beta invite
    const ch4 = (await anon.call('GET', '/v1/challenge')).data;
    const bobReg = await bob.call('POST', '/v1/users', {
      displayName: 'ראובן',
      pubkey: bob.pubkey,
      recoveryHash: await sha256Hex('BOBREC11112222'),
      inviteCode: betaInvs.data.codes[1],
      acceptedGuidelines: true,
      challengeToken: ch4.token,
      challengeNonce: await solvePow(ch4),
    });
    assert.equal(bobReg.status, 201);
    bob.setUserId(bobReg.data.user.id);

    // 3. Alice creates a note with ECDSA signature & seq=1
    const noteRes = await alice.call('POST', '/v1/notes', {
      kind: 'note',
      bookUid: 'id:183',
      titleHint: 'בראשית',
      ref: 'פרק א',
      sectionHint: 1,
      quote: 'בראשית ברא אלהים',
      prefix: '',
      suffix: ' את השמים',
      occurrence: 0,
      body: 'רש״י מביא בשם רבי יצחק שלא היה צריך להתחיל את התורה אלא מהחודש הזה לכם.',
    }, { auth: true });
    assert.equal(noteRes.status, 201);
    assert.equal(noteRes.data.note.status, 'published');
    const noteId = noteRes.data.note.id;

    // Anti-replay check: reusing seq=1 must fail with 409 SEQ_REPLAY
    const replayRes = await alice.call('POST', '/v1/notes', {
      kind: 'note',
      bookUid: 'id:183',
      ref: 'פרק א',
      body: 'ניסיון שחזור בקשה חתומה.',
    }, { auth: true, customSeq: 1 });
    assert.equal(replayRes.status, 409);
    assert.equal(replayRes.data.error.code, 'SEQ_REPLAY');

    // 4. Book index & ETag 304
    const idx1 = await anon.call('GET', '/v1/books/id%3A183/index');
    assert.equal(idx1.status, 200);
    assert.equal(idx1.data.refs['פרק א'].notes, 1);

    const etag = idx1.headers.get('ETag');
    const req304 = new Request('https://example.workers.dev/v1/books/id%3A183/index', {
      headers: { 'If-None-Match': etag },
    });
    const res304 = await handleRequest(req304, env);
    assert.equal(res304.status, 304);

    // 5. Alice creates a question; Bob answers; Alice accepts answer -> inbox notification
    const qRes = await alice.call('POST', '/v1/notes', {
      kind: 'question',
      bookUid: 'id:183',
      titleHint: 'בראשית',
      ref: 'פרק א',
      sectionHint: 2,
      quote: 'והארץ היתה תהו ובהו',
      body: 'מה ההבדל בין פירוש רש״י לרמב״ן על המילה תהו?',
    }, { auth: true });
    assert.equal(qRes.status, 201);
    const questionId = qRes.data.note.id;

    const ansRes = await bob.call('POST', '/v1/notes', {
      kind: 'answer',
      rootId: questionId,
      body: 'הרמב״ן מפרש תהו כחומר ההיולי הראשוני, ורש״י מפרש לשון תמה ושממה.',
    }, { auth: true });
    assert.equal(ansRes.status, 201);
    const answerId = ansRes.data.note.id;

    // Only asker can accept
    const badAccept = await bob.call('PUT', `/v1/notes/${answerId}/accept`, { accepted: true }, { auth: true });
    assert.equal(badAccept.status, 403);

    const okAccept = await alice.call('PUT', `/v1/notes/${answerId}/accept`, { accepted: true }, { auth: true });
    assert.equal(okAccept.status, 200);
    assert.equal(okAccept.data.questionStatus, 'answered');

    // Bob's inbox should have accepted notification
    const bobInbox = await bob.call('GET', '/v1/me/inbox?after=0', null, { auth: true });
    assert.equal(bobInbox.status, 200);
    assert.ok(bobInbox.data.unreadCount >= 1);

    // 6. Voting: self-vote forbidden; Bob votes helpful (account age < 7d -> weight 0, upCount 1)
    const selfVote = await alice.call('PUT', `/v1/notes/${noteId}/vote`, { value: 1 }, { auth: true });
    assert.equal(selfVote.status, 403);

    const bobVote = await bob.call('PUT', `/v1/notes/${noteId}/vote`, { value: 1 }, { auth: true });
    assert.equal(bobVote.status, 200);
    assert.equal(bobVote.data.upCount, 1);

    // Negative vote requires reason
    const missingReason = await mod.call('PUT', `/v1/notes/${noteId}/vote`, { value: -1 }, { auth: true });
    assert.equal(missingReason.status, 400);

    // 7. Auto-rejected note + Appeal + Moderator approval
    const badNote = await alice.call('POST', '/v1/notes', {
      kind: 'note',
      bookUid: 'id:183',
      titleHint: 'בראשית',
      ref: 'פרק א',
      body: 'הערה שמכילה מילה פסולה כמו מטומטם לבדיקת ערעור.',
    }, { auth: true });
    assert.equal(badNote.status, 201);
    assert.equal(badNote.data.note.status, 'rejected');
    const rejectedId = badNote.data.note.id;

    const appealRes = await alice.call('POST', `/v1/notes/${rejectedId}/appeal`, {
      reason: 'נכתב בטעות, מבקשת בדיקת מודרטור',
    }, { auth: true });
    assert.equal(appealRes.status, 200);

    const modQueue = await mod.call('GET', '/v1/mod/queue', null, { auth: true });
    assert.equal(modQueue.status, 200);
    assert.ok(modQueue.data.items.some((i) => i.id === rejectedId));

    const modDecide = await mod.call('POST', '/v1/mod/decide', {
      noteId: rejectedId,
      action: 'reject',
      reason: 'לשון לא מתאימה',
    }, { auth: true });
    assert.equal(modDecide.status, 200);

    // Moderator re-anchoring tool
    const reanchor = await mod.call('POST', '/v1/mod/reanchor', {
      noteId,
      ref: 'פרק א פסוק א',
      sectionHint: 3,
    }, { auth: true });
    assert.equal(reanchor.status, 200);
    assert.equal(reanchor.data.sectionHint, 3);

    // 8. Identity recovery onto a new device key
    const aliceDevice2 = await makeTestClient(env);
    const chRec = (await anon.call('GET', '/v1/challenge')).data;
    const recRes = await anon.call('POST', '/v1/users/recover', {
      displayName: 'יעל הלומדת',
      recoveryCode: aliceRecCode,
      newPubkey: aliceDevice2.pubkey,
      challengeToken: chRec.token,
      challengeNonce: await solvePow(chRec),
    });
    assert.equal(recRes.status, 200);
    aliceDevice2.setUserId(recRes.data.user.id);

    const exportRes = await aliceDevice2.call('GET', '/v1/me/export', null, { auth: true });
    assert.equal(exportRes.status, 200);
    assert.ok(exportRes.data.notes.length >= 2);

    // 9. Public JSON backup snapshot & restore into clean DB
    const snapshots = await buildPublicBackupSnapshot(env);
    assert.ok(snapshots.has('id:183'));
    const bookSnap = snapshots.get('id:183');
    assert.ok(bookSnap.records.length >= 3);

    const freshDb = new D1SqliteAdapter(':memory:');
    freshDb.applyMigrationFile(MIGRATION_PATH);
    const restored = await restoreBookBackupSnapshot({ DB: freshDb }, bookSnap);
    assert.equal(restored.restored, bookSnap.records.length);
    freshDb.close();

    const pubBackup = await anon.call('GET', '/v1/backup/public');
    assert.equal(pubBackup.status, 200);
    assert.ok(pubBackup.data.books['id:183']);

    // 10. Account deletion (anonymize)
    const delRes = await aliceDevice2.call('DELETE', '/v1/me', { mode: 'anonymize' }, { auth: true });
    assert.equal(delRes.status, 200);

    // 11. Three reports from active+ users auto-hide a published note
    const targetRes = await bob.call('POST', '/v1/notes', {
      kind: 'note',
      bookUid: 'id:183',
      titleHint: 'בראשית',
      ref: 'פרק ב',
      body: 'הערה לבדיקת הסתרה אוטומטית על ידי שלושה דיווחים.',
    }, { auth: true });
    assert.equal(targetRes.status, 201);
    const targetId = targetRes.data.note.id;

    const rep3 = await makeTestClient(env);
    const rep4 = await makeTestClient(env);
    const extraInvs = await anon.call('POST', '/v1/mod/invites', { count: 2, level: 'active' }, { adminSecret: 'test-admin-secret' });
    for (const [idx, cl] of [[0, rep3], [1, rep4]]) {
      const ch = (await anon.call('GET', '/v1/challenge')).data;
      const r = await cl.call('POST', '/v1/users', {
        displayName: `מדווח_${idx + 1}`,
        pubkey: cl.pubkey,
        recoveryHash: await sha256Hex(`REPREC${idx}123456`),
        inviteCode: extraInvs.data.codes[idx],
        acceptedGuidelines: true,
        challengeToken: ch.token,
        challengeNonce: await solvePow(ch),
      });
      assert.equal(r.status, 201);
      cl.setUserId(r.data.user.id);
    }

    await mod.call('POST', `/v1/notes/${targetId}/report`, { reason: 'off_topic' }, { auth: true });
    await rep3.call('POST', `/v1/notes/${targetId}/report`, { reason: 'off_topic' }, { auth: true });
    const thirdReport = await rep4.call('POST', `/v1/notes/${targetId}/report`, { reason: 'off_topic' }, { auth: true });
    assert.equal(thirdReport.status, 200);
    assert.equal(thirdReport.data.autoHidden, true);

    const hiddenCheck = await anon.call('GET', '/v1/books/id%3A183/notes?ref=' + encodeURIComponent('פרק ב'));
    assert.equal(hiddenCheck.data.items.length, 0);
  } finally {
    db.close();
  }
});
