/**
 * Authentication, ECDSA P-256 verification, anti-replay seq, PoW challenges, and recovery codes.
 */

const textEncoder = new TextEncoder();

export function toBase64Url(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function toHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? textEncoder.encode(input) : input;
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(hash));
}

export async function sha256Bytes(input) {
  const data = typeof input === 'string' ? textEncoder.encode(input) : input;
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function timingSafeEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Import an ECDSA P-256 public key from base64url SPKI or JSON JWK string.
 */
export async function importP256PublicKey(pubkeyStr) {
  if (!pubkeyStr || typeof pubkeyStr !== 'string') {
    throw new Error('Missing public key');
  }
  const trimmed = pubkeyStr.trim();
  if (trimmed.startsWith('{')) {
    const jwk = JSON.parse(trimmed);
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
      throw new Error('Unsupported JWK curve');
    }
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  }
  const raw = fromBase64Url(trimmed);
  return crypto.subtle.importKey(
    'spki',
    raw,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

/**
 * Normalize DER ECDSA signature into IEEE P1363 64-byte raw (r || s) if needed.
 */
function normalizeEcdsaSignature(sigBytes) {
  if (sigBytes.length === 64) return sigBytes;
  if (sigBytes[0] !== 0x30) return sigBytes;
  // Minimal ASN.1 DER sequence parser for (r, s)
  let offset = 2;
  if (sigBytes[1] & 0x80) {
    const lenBytes = sigBytes[1] & 0x7f;
    offset = 2 + lenBytes;
  }
  if (sigBytes[offset] !== 0x02) throw new Error('Invalid DER signature');
  const rLen = sigBytes[offset + 1];
  const rStart = offset + 2;
  const r = sigBytes.slice(rStart, rStart + rLen);
  const sTagPos = rStart + rLen;
  if (sigBytes[sTagPos] !== 0x02) throw new Error('Invalid DER signature');
  const sLen = sigBytes[sTagPos + 1];
  const sStart = sTagPos + 2;
  const s = sigBytes.slice(sStart, sStart + sLen);

  const out = new Uint8Array(64);
  const rClean = r.length > 32 ? r.slice(r.length - 32) : r;
  const sClean = s.length > 32 ? s.slice(s.length - 32) : s;
  out.set(rClean, 32 - rClean.length);
  out.set(sClean, 64 - sClean.length);
  return out;
}

export async function verifyP256Signature(pubkeyStr, messageStr, sigBase64Url) {
  try {
    const key = await importP256PublicKey(pubkeyStr);
    const sigRaw = normalizeEcdsaSignature(fromBase64Url(sigBase64Url));
    if (sigRaw.length !== 64) return false;
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sigRaw,
      textEncoder.encode(messageStr)
    );
  } catch {
    return false;
  }
}

export function buildCanonicalPayload({ method, pathWithQuery, seq, timestamp, bodyHash }) {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${seq}\n${timestamp}\n${bodyHash}`;
}

function getChallengeSecret(env) {
  return env.CHALLENGE_SECRET || 'dev-insecure-local-challenge-secret-change-in-prod';
}

async function hmacSha256Base64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

export function countLeadingZeroBits(bytes) {
  let zeros = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) {
      zeros += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if ((b & (1 << bit)) === 0) zeros++;
      else return zeros;
    }
  }
  return zeros;
}

export async function issueChallenge(env, difficulty = 14) {
  const challengeId = crypto.randomUUID();
  const rnd = new Uint8Array(12);
  crypto.getRandomValues(rnd);
  const prefix = toBase64Url(rnd);
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const payload = `${challengeId}.${prefix}.${difficulty}.${expiresAt}`;
  const sig = await hmacSha256Base64Url(getChallengeSecret(env), payload);
  return {
    challengeId,
    prefix,
    difficulty,
    expiresAt,
    token: `${payload}.${sig}`,
  };
}

export async function verifyAndConsumeChallenge(env, challengeToken, nonce) {
  if (!challengeToken || typeof challengeToken !== 'string' || nonce == null) {
    return { ok: false, error: 'CHALLENGE_REQUIRED' };
  }
  const parts = challengeToken.split('.');
  if (parts.length !== 5) {
    return { ok: false, error: 'CHALLENGE_INVALID' };
  }
  const [challengeId, prefix, diffStr, expStr, sig] = parts;
  const difficulty = Number(diffStr);
  const expiresAt = Number(expStr);
  if (!Number.isInteger(difficulty) || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return { ok: false, error: 'CHALLENGE_EXPIRED' };
  }
  const expectedSig = await hmacSha256Base64Url(
    getChallengeSecret(env),
    `${challengeId}.${prefix}.${diffStr}.${expStr}`
  );
  if (!timingSafeEqual(sig, expectedSig)) {
    return { ok: false, error: 'CHALLENGE_INVALID' };
  }
  const nonceStr = String(nonce);
  if (nonceStr.length > 64) {
    return { ok: false, error: 'CHALLENGE_INVALID' };
  }
  const digest = await sha256Bytes(`${prefix}:${nonceStr}`);
  if (countLeadingZeroBits(digest) < difficulty) {
    return { ok: false, error: 'CHALLENGE_FAILED' };
  }
  // Single-use enforcement in D1
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT id FROM used_challenges WHERE id = ?').bind(challengeId).first();
  if (existing) {
    return { ok: false, error: 'CHALLENGE_REUSED' };
  }
  await env.DB.prepare('INSERT INTO used_challenges (id, expires_at) VALUES (?, ?)')
    .bind(challengeId, expiresAt)
    .run();
  // Best-effort opportunistic cleanup of old expired challenges
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM used_challenges WHERE expires_at < ?').bind(now).run();
  }
  return { ok: true, challengeId };
}

/**
 * Authenticate a request.
 * - For write requests (requireSeq = true), enforces monotonic integer seq > user.seq.
 * - For authenticated GET requests (requireSeq = false), allows timestamp-window + X-Seq (string/number) without consuming seq.
 */
export async function authenticateRequest(request, env, rawBody, { required = true, requireSeq = true } = {}) {
  const userId = request.headers.get('X-User-Id');
  const seqHeader = request.headers.get('X-Seq');
  const tsHeader = request.headers.get('X-Timestamp');
  const sigHeader = request.headers.get('X-Signature');

  if (!userId || !seqHeader || !tsHeader || !sigHeader) {
    if (!required) return { ok: true, user: null };
    return { ok: false, status: 401, code: 'AUTH_MISSING', message: 'נדרשת הזדהות' };
  }

  const timestamp = Number(tsHeader);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 5 * 60 * 1000) {
    return { ok: false, status: 401, code: 'AUTH_TIMESTAMP', message: 'חותמת זמן אינה תקינה' };
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!user) {
    return { ok: false, status: 401, code: 'USER_NOT_FOUND', message: 'המשתמש לא נמצא' };
  }

  const url = new URL(request.url);
  const pathWithQuery = url.pathname + url.search;
  const bodyHash = await sha256Hex(rawBody || '');
  const canonical = buildCanonicalPayload({
    method: request.method,
    pathWithQuery,
    seq: seqHeader,
    timestamp: tsHeader,
    bodyHash,
  });

  const validSig = await verifyP256Signature(user.pubkey, canonical, sigHeader);
  if (!validSig) {
    return { ok: false, status: 401, code: 'INVALID_SIGNATURE', message: 'חתימה אינה תקינה' };
  }

  if (requireSeq) {
    const seqNum = Number(seqHeader);
    if (!Number.isSafeInteger(seqNum) || seqNum <= 0) {
      return { ok: false, status: 400, code: 'INVALID_SEQ', message: 'מונה בקשה אינו תקין' };
    }
    const upd = await env.DB.prepare('UPDATE users SET seq = ? WHERE id = ? AND seq < ?')
      .bind(seqNum, user.id, seqNum)
      .run();
    const changes = upd?.meta?.changes ?? upd?.changes ?? 0;
    if (changes === 0) {
      return { ok: false, status: 409, code: 'SEQ_REPLAY', message: 'מונה הבקשה כבר נוצל או לא עדכני' };
    }
    user.seq = seqNum;
  }

  return { ok: true, user };
}
