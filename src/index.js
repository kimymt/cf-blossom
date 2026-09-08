import { authorize, HttpError, isValidSHA256, isValidPubkey, calculateSHA256 } from './auth.js';
import { TTL_MS, active, expiresAt, descriptor, indexKey, indexBlob, listBlobs, maintainIndex } from './storage.js';

const DEFAULT_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm',
  'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'application/pdf', 'text/plain',
];
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-SHA-256, X-Content-Type, X-Content-Length, Range, *',
  'Access-Control-Expose-Headers': 'X-Reason, X-Max-File-Size, X-Allowed-MIME-Types, X-TTL, ETag, Sunset, Retry-After',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
let reservedBytes = 0;
const BUFFER_BUDGET = 48 * 1024 * 1024;
function policy(env) {
  const raw = env.MAX_FILE_SIZE ?? '10485760';
  const maxSize = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 32 * 1024 * 1024) {
    throw new HttpError(503, 'MAX_FILE_SIZE must be between 1 and 33554432');
  }
  const types = env.ALLOWED_MIME_TYPES ? env.ALLOWED_MIME_TYPES.split(',').map(t => t.trim()) : DEFAULT_TYPES;
  return { maxSize, types };
}
function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...HEADERS, ...headers } });
}
function json(value, status = 200) {
  return response(JSON.stringify(value), status, { 'Content-Type': 'application/json' });
}
async function rateLimit(env, key) {
  if (!env.RATE_LIMITER) throw new HttpError(503, 'Rate limiter unavailable');
  const result = await env.RATE_LIMITER.limit({ key: 'blossom:v1:' + key });
  if (!result.success) throw new HttpError(429, 'Rate limit exceeded');
}
function uploadMetadata(request, config, head) {
  const type = (request.headers.get(head ? 'X-Content-Type' : 'Content-Type') || 'application/octet-stream')
    .split(';')[0].trim().toLowerCase();
  const size = request.headers.get(head ? 'X-Content-Length' : 'Content-Length');
  if (head && size === null) throw new HttpError(411, 'X-Content-Length required');
  if (size !== null && (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)))) throw new HttpError(400, 'Invalid length');
  if (size !== null && Number(size) > config.maxSize) throw new HttpError(413, 'File too large');
  if (!config.types.includes(type)) throw new HttpError(415, 'Unsupported file type');
  const hash = request.headers.get('X-SHA-256');
  if ((head || hash !== null) && !isValidSHA256(hash)) throw new HttpError(400, 'Invalid or missing X-SHA-256');
  return { type, size: size === null ? null : Number(size), hash };
}
async function readBounded(request, maxSize, size) {
  // A single preallocated buffer avoids retaining chunks plus a second copy.
  const data = new Uint8Array(size ?? maxSize);
  const reader = request.body?.getReader();
  let offset = 0;
  try {
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > maxSize) throw new HttpError(413, 'File too large');
        if (offset + value.byteLength > data.byteLength) throw new HttpError(400, 'Content-Length mismatch');
        data.set(value, offset); offset += value.byteLength;
      }
    }
    if (size !== null && size !== offset) throw new HttpError(400, 'Content-Length mismatch');
    return data.subarray(0, offset);
  } catch (error) {
    if (reader) await reader.cancel().catch(() => {});
    throw error;
  } finally { reader?.releaseLock(); }
}
async function upload(request, env, config) {
  const metadata = uploadMetadata(request, config, false);
  const auth = await authorize(request, env, 'upload', metadata.hash);
  await rateLimit(env, 'upload:' + auth.pubkey);
  const reservation = metadata.size ?? config.maxSize;
  if (reservedBytes + reservation > BUFFER_BUDGET) throw new HttpError(503, 'Upload capacity temporarily exhausted');
  reservedBytes += reservation;
  try {
    const data = await readBounded(request, config.maxSize, metadata.size);
    const hash = await calculateSHA256(data);
    if (metadata.hash && metadata.hash !== hash) throw new HttpError(409, 'X-SHA-256 does not match body');
    if (!auth.hashes.includes(hash)) throw new HttpError(401, 'Blob not authorized');
    const bucket = env.BLOSSOM_BUCKET;
    let object = await bucket.head(hash), created = false;
    if (!object) {
      object = await bucket.put(hash, data, {
        onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { contentType: metadata.type, uploader: auth.pubkey,
          expiresAt: new Date(Date.now() + TTL_MS).toISOString() },
        httpMetadata: { contentType: metadata.type },
      });
      created = !!object;
      if (!object) object = await bucket.head(hash);
    }
    if (!object) throw new HttpError(503, 'Concurrent blob change; retry upload');
    if (!active(object)) throw new HttpError(409, 'Expired blob awaits removal; its owner may delete it before retrying');
    // Return stored MIME/owner/time on duplicate uploads, including races.
    await indexBlob(bucket, object);
    return json(descriptor(object, new URL(request.url).origin), created ? 201 : 200);
  } finally { reservedBytes -= reservation; }
}
async function getBlob(request, env, hash) {
  const head = request.method === 'HEAD';
  const object = head ? await env.BLOSSOM_BUCKET.head(hash) : await env.BLOSSOM_BUCKET.get(hash);
  if (!active(object)) {
    if (!head) await object?.body?.cancel?.();
    throw new HttpError(404, 'Blob not found');
  }
  return response(head ? null : object.body, 200, {
    'Content-Type': object.customMetadata?.contentType || 'application/octet-stream',
    'Content-Length': String(object.size), ETag: '"' + hash + '"',
    'Last-Modified': object.uploaded.toUTCString(), Sunset: new Date(expiresAt(object)).toUTCString(),
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), method = request.method;
    try {
      if (method === 'OPTIONS') return response(null);
      if (method === 'GET' && url.pathname === '/') return response('Blossom Server API is running. See documentation for usage.');
      const blob = url.pathname.match(/^\/([a-f0-9]{64})(?:\.[a-zA-Z0-9]+)?$/);
      if (blob && ['GET', 'HEAD'].includes(method)) return await getBlob(request, env, blob[1]);
      const list = url.pathname.match(/^\/list\/([a-f0-9]{64})$/);
      if ((url.pathname === '/upload' && ['PUT', 'HEAD'].includes(method)) || list || (blob && method === 'DELETE')) {
        await rateLimit(env, 'ip:' + (request.headers.get('CF-Connecting-IP') || 'unknown'));
      }
      if (url.pathname === '/upload' && method === 'PUT') return await upload(request, env, policy(env));
      if (url.pathname === '/upload' && method === 'HEAD') {
        const config = policy(env), metadata = uploadMetadata(request, config, true);
        const auth = await authorize(request, env, 'upload', metadata.hash);
        await rateLimit(env, 'upload:' + auth.pubkey);
        return response(null, 200, { 'X-Max-File-Size': String(config.maxSize),
          'X-Allowed-MIME-Types': config.types.join(','), 'X-TTL': '86400' });
      }
      if (list && method === 'GET') {
        await authorize(request, env, 'list', null, false);
        return json(await listBlobs(env.BLOSSOM_BUCKET, list[1], url.searchParams, url.origin));
      }
      if (blob && method === 'DELETE') {
        const hash = blob[1], auth = await authorize(request, env, 'delete', hash);
        await rateLimit(env, 'delete:' + auth.pubkey);
        const object = await env.BLOSSOM_BUCKET.head(hash);
        if (!object) throw new HttpError(404, 'Blob not found');
        if (object.customMetadata?.uploader !== auth.pubkey) throw new HttpError(403, 'Not the uploader');
        await env.BLOSSOM_BUCKET.delete(hash);
        // Delete the index only after the authoritative object is gone.
        await env.BLOSSOM_BUCKET.delete(indexKey(object));
        return response(null, 204);
      }
      throw new HttpError(404, 'Not Found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      const reason = error instanceof HttpError ? error.message : 'Storage or service temporarily unavailable';
      return response(request.method === 'HEAD' ? null : reason, status,
        { 'X-Reason': reason, ...([429, 503].includes(status) ? { 'Retry-After': '60' } : {}) });
    }
  },
  async scheduled(event, env) { await maintainIndex(env); },
};
export { isValidSHA256, isValidPubkey, calculateSHA256 };
