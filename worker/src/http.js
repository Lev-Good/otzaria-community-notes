/**
 * HTTP response & JSON helpers for Cloudflare Worker.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-Timestamp, X-Seq, X-Signature, X-Admin-Secret, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag, Retry-After',
};

export function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

export function errorResponse(status, code, message, extra = {}, headers = {}) {
  return jsonResponse({ error: { code, message, ...extra } }, { status, headers });
}

export async function readBodyText(request, maxBytes = 65536) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw Object.assign(new Error('Payload too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
  return text;
}
