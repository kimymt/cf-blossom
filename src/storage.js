import { HttpError, isValidSHA256, isValidPubkey } from './auth.js';

export const TTL_MS = 86400000;
export const INDEX_PREFIX = '__index/';
const CHECKPOINT = '__maintenance/index-v1';
const EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
  'application/pdf': '.pdf', 'text/plain': '.txt',
};
export function expiresAt(object) {
  const declared = object.customMetadata?.expiresAt;
  return declared === undefined ? object.uploaded.getTime() + TTL_MS : Date.parse(declared);
}
export function active(object, now = Date.now()) {
  return !!object && Number.isFinite(expiresAt(object)) && expiresAt(object) > now;
}
export function descriptor(object, origin) {
  const type = object.customMetadata?.contentType || 'application/octet-stream';
  return { sha256: object.key, size: object.size, type,
    uploaded: Math.floor(object.uploaded.getTime() / 1000),
    url: origin + '/' + object.key + (EXTENSIONS[type] || '.bin') };
}
export function indexKey(object) {
  const reverseTime = String(9999999999999 - object.uploaded.getTime()).padStart(13, '0');
  return INDEX_PREFIX + object.customMetadata.uploader + '/' + reverseTime + '/' + object.key;
}
export async function indexBlob(bucket, object) {
  if (!isValidSHA256(object.key) || !isValidPubkey(object.customMetadata?.uploader)) return;
  await bucket.put(indexKey(object), '', { onlyIf: { etagDoesNotMatch: '*' },
    customMetadata: { hash: object.key } });
}
export async function listBlobs(bucket, pubkey, params, origin) {
  const rawLimit = params.get('limit') ?? '20';
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20) {
    throw new HttpError(400, 'limit must be an integer between 1 and 20');
  }
  const limit = Number(rawLimit), cursor = params.get('cursor');
  let startAfter;
  if (cursor !== null) {
    if (!isValidSHA256(cursor)) throw new HttpError(400, 'Invalid cursor');
    const object = await bucket.head(cursor);
    if (!object || object.customMetadata?.uploader !== pubkey) throw new HttpError(400, 'Cursor is no longer available');
    startAfter = indexKey(object);
  }
  const results = [];
  let scanned = 0, r2cursor;
  // Bound R2 subrequests even if stale entries exist. Never return an incomplete
  // empty page that could silently hide more results.
  while (scanned < 30) {
    const page = await bucket.list({ prefix: INDEX_PREFIX + pubkey + '/',
      startAfter: r2cursor ? undefined : startAfter, cursor: r2cursor, limit: Math.min(20, 30 - scanned),
      include: ['customMetadata'] });
    for (const entry of page.objects) {
      scanned++;
      const hash = entry.customMetadata?.hash;
      if (!isValidSHA256(hash)) continue;
      const object = await bucket.head(hash);
      if (active(object) && object.customMetadata?.uploader === pubkey && indexKey(object) === entry.key) {
        results.push(descriptor(object, origin));
        if (results.length === limit) return results;
      }
    }
    if (results.length >= limit || !page.truncated) return results;
    if (!page.cursor || !page.objects.length) break;
    r2cursor = page.cursor;
  }
  throw new HttpError(503, 'Listing temporarily unavailable; retry later');
}

// Trusted Cron work only. Public requests never scan the bucket or perform cleanup.
// Hex prefixes exclude internal index/checkpoint objects. Each run is bounded,
// and failure leaves the checkpoint unchanged for an idempotent retry.
export async function maintainIndex(env) {
  const bucket = env.BLOSSOM_BUCKET;
  const saved = await bucket.get(CHECKPOINT);
  const state = saved ? await saved.json() : { prefix: 0 };
  const prefix = Number.isInteger(state.prefix) && state.prefix >= 0 && state.prefix < 16 ? state.prefix : 0;
  const page = await bucket.list({ prefix: prefix.toString(16), cursor: state.cursor,
    limit: 25, include: ['customMetadata'] });
  for (const object of page.objects) {
    if (active(object)) await indexBlob(bucket, object);
  }
  await bucket.put(CHECKPOINT, JSON.stringify(page.truncated
    ? { prefix, cursor: page.cursor } : { prefix: (prefix + 1) % 16 }));
}
