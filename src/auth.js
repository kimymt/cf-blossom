import { schnorr } from '@noble/curves/secp256k1.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const isValidSHA256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isValidPubkey = isValidSHA256;
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const bytes = value => Uint8Array.from(value.match(/../g), b => parseInt(b, 16));
export async function calculateSHA256(data) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

// Accept current Base64url and legacy Base64, decoding NIP-01 content as UTF-8.
export async function authorize(request, env, action, hash, required = true) {
  const header = request.headers.get('Authorization');
  if (!header && !required) return null;
  try {
    if (!header || header.length > 16384 || !/^Nostr /i.test(header)) throw new Error();
    const encoded = header.slice(6);
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) throw new Error();
    const decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(decoded, c => c.charCodeAt(0))));
    const now = Math.floor(Date.now() / 1000);
    if (!event || event.kind !== 24242 || !isValidPubkey(event.pubkey) ||
        !isValidSHA256(event.id) || typeof event.sig !== 'string' ||
        !/^[a-f0-9]{128}$/.test(event.sig) ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > now ||
        typeof event.content !== 'string' || !event.content.trim() ||
        !Array.isArray(event.tags) ||
        !event.tags.every(t => Array.isArray(t) && t.length > 0 && t.every(v => typeof v === 'string'))) {
      throw new Error();
    }
    const tags = name => event.tags.filter(t => t[0] === name).map(t => t[1]);
    const actions = tags('t'), expiration = tags('expiration');
    if (actions.length !== 1 || actions[0] !== action || expiration.length !== 1 ||
        !/^\d+$/.test(expiration[0]) || !Number.isSafeInteger(Number(expiration[0])) ||
        Number(expiration[0]) <= now) throw new Error();
    const servers = tags('server');
    if (servers.length && !servers.includes(new URL(request.url).hostname)) throw new Error();
    const hashes = tags('x');
    if (['upload', 'delete'].includes(action) &&
        (!hashes.length || !hashes.every(isValidSHA256) || (hash && !hashes.includes(hash)))) throw new Error();
    const id = await calculateSHA256(new TextEncoder().encode(JSON.stringify(
      [0, event.pubkey, event.created_at, event.kind, event.tags, event.content])));
    if (id !== event.id || !schnorr.verify(bytes(event.sig), bytes(id), bytes(event.pubkey))) throw new Error();
    // An empty allowlist intentionally preserves the documented public-server mode.
    const allowed = (env.ALLOWED_PUBKEYS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.some(pk => !isValidPubkey(pk))) throw new HttpError(503, 'Invalid server configuration');
    if (allowed.length && !allowed.includes(event.pubkey)) throw new HttpError(403, 'Pubkey not authorized');
    return { pubkey: event.pubkey, hashes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'Invalid authorization');
  }
}
