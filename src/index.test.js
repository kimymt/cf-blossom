import { describe, test, expect, jest } from '@jest/globals';
import worker, { isValidSHA256, isValidPubkey, calculateSHA256 } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBucket() {
  return {
    get: jest.fn().mockResolvedValue(null),
    head: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ objects: [], truncated: false }),
  };
}

function makeEnv(envVars = {}) {
  return { BLOSSOM_BUCKET: makeMockBucket(), ...envVars };
}

// Returns env + direct reference to the bucket mock for assertion
function makeEnvWithBucket(envVars = {}) {
  const env = makeEnv(envVars);
  return { env, bucket: env.BLOSSOM_BUCKET };
}

function makeAuthToken(overrides = {}) {
  const event = {
    kind: 24242,
    pubkey: 'a'.repeat(64),
    sig: 'aabbccdd',
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

const VALID_HASH = 'a'.repeat(64);
const VALID_PUBKEY = 'b'.repeat(64);
const ctx = {};

// ---------------------------------------------------------------------------
// isValidSHA256
// ---------------------------------------------------------------------------

describe('isValidSHA256', () => {
  test('returns true for a 64-char lowercase hex string', () => {
    expect(isValidSHA256('a'.repeat(64))).toBe(true);
    expect(isValidSHA256('0123456789abcdef'.repeat(4))).toBe(true);
  });

  test('returns false for a string shorter than 64 chars', () => {
    expect(isValidSHA256('a'.repeat(63))).toBe(false);
  });

  test('returns false for a string longer than 64 chars', () => {
    expect(isValidSHA256('a'.repeat(65))).toBe(false);
  });

  test('returns false for uppercase hex', () => {
    expect(isValidSHA256('A'.repeat(64))).toBe(false);
  });

  test('returns false for non-hex characters', () => {
    expect(isValidSHA256('g'.repeat(64))).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isValidSHA256('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidPubkey
// ---------------------------------------------------------------------------

describe('isValidPubkey', () => {
  test('returns true for a valid 64-char lowercase hex string', () => {
    expect(isValidPubkey('b'.repeat(64))).toBe(true);
  });

  test('returns false for incorrect length', () => {
    expect(isValidPubkey('b'.repeat(63))).toBe(false);
    expect(isValidPubkey('b'.repeat(65))).toBe(false);
  });

  test('returns false for uppercase or non-hex characters', () => {
    expect(isValidPubkey('B'.repeat(64))).toBe(false);
    expect(isValidPubkey('z'.repeat(64))).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isValidPubkey('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calculateSHA256
// ---------------------------------------------------------------------------

describe('calculateSHA256', () => {
  test('produces the correct hex digest for "hello"', async () => {
    const data = new TextEncoder().encode('hello');
    const hash = await calculateSHA256(data);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  test('produces a 64-character lowercase hex string', async () => {
    const data = new TextEncoder().encode('test');
    const hash = await calculateSHA256(data);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('different inputs produce different hashes', async () => {
    const enc = new TextEncoder();
    const h1 = await calculateSHA256(enc.encode('hello'));
    const h2 = await calculateSHA256(enc.encode('world'));
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Router and CORS
// ---------------------------------------------------------------------------

describe('Router and CORS', () => {
  test('OPTIONS returns 200 with all CORS headers', async () => {
    const req = new Request('http://localhost/', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  test('GET / returns 200 with a status message', async () => {
    const req = new Request('http://localhost/', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Blossom');
  });

  test('unrecognized route returns 404', async () => {
    const req = new Request('http://localhost/unknown-path', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  test('every response includes the CORS Allow-Origin header', async () => {
    const req = new Request('http://localhost/unknown-path', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// GET /<hash>
// ---------------------------------------------------------------------------

describe('GET /<hash>', () => {
  // Route regex /^\/[a-f0-9]{64}/ matches paths that START with / + 64 hex chars.
  // A 65-char hex path matches the route but fails isValidSHA256 inside the handler.
  test('returns 400 when hash is longer than 64 chars', async () => {
    const req = new Request(`http://localhost/${'a'.repeat(65)}`, { method: 'GET' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  test('returns 404 when blob does not exist in R2', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.get.mockResolvedValue(null);
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  test('returns 200 with correct headers when blob is found', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.get.mockResolvedValue({
      body: null,
      size: 1234,
      customMetadata: { contentType: 'image/png' },
    });
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Length')).toBe('1234');
    expect(res.headers.get('ETag')).toBe(`"${VALID_HASH}"`);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('falls back to application/octet-stream when no contentType in metadata', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.get.mockResolvedValue({ body: null, size: 0, customMetadata: {} });
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  test('strips file extension before looking up hash in R2', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.get.mockResolvedValue(null);
    const req = new Request(`http://localhost/${VALID_HASH}.png`, { method: 'GET' });
    await worker.fetch(req, env, ctx);
    expect(bucket.get).toHaveBeenCalledWith(VALID_HASH);
  });

  test('returns 500 when R2 throws', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.get.mockRejectedValue(new Error('R2 unavailable'));
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// HEAD /<hash>
// ---------------------------------------------------------------------------

describe('HEAD /<hash>', () => {
  test('returns 400 when hash is longer than 64 chars', async () => {
    const req = new Request(`http://localhost/${'a'.repeat(65)}`, { method: 'HEAD' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  test('returns 404 when blob does not exist', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'HEAD' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  test('returns 200 with metadata headers and no body when blob exists', async () => {
    const { env, bucket } = makeEnvWithBucket();
    const uploaded = new Date('2024-06-01T00:00:00Z');
    bucket.head.mockResolvedValue({
      size: 5678,
      uploaded,
      customMetadata: { contentType: 'video/mp4' },
    });
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'HEAD' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Content-Length')).toBe('5678');
    expect(res.headers.get('ETag')).toBe(`"${VALID_HASH}"`);
    expect(res.headers.get('Last-Modified')).toBe(uploaded.toUTCString());
    expect(await res.text()).toBe('');
  });

  test('returns 500 when R2 throws', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockRejectedValue(new Error('R2 unavailable'));
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'HEAD' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// HEAD /upload
// ---------------------------------------------------------------------------

describe('HEAD /upload', () => {
  test('returns default upload requirements', async () => {
    const req = new Request('http://localhost/upload', { method: 'HEAD' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Max-File-Size')).toBe('10485760');
    expect(res.headers.get('X-TTL')).toBe('86400');
    const mimeTypes = res.headers.get('X-Allowed-MIME-Types');
    expect(mimeTypes).toContain('image/jpeg');
    expect(mimeTypes).toContain('video/mp4');
    expect(mimeTypes).toContain('application/pdf');
  });

  test('reflects custom MAX_FILE_SIZE env var', async () => {
    const env = makeEnv({ MAX_FILE_SIZE: '52428800' });
    const req = new Request('http://localhost/upload', { method: 'HEAD' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.headers.get('X-Max-File-Size')).toBe('52428800');
  });

  test('reflects custom ALLOWED_MIME_TYPES env var', async () => {
    const env = makeEnv({ ALLOWED_MIME_TYPES: 'image/jpeg,image/png' });
    const req = new Request('http://localhost/upload', { method: 'HEAD' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.headers.get('X-Allowed-MIME-Types')).toBe('image/jpeg,image/png');
  });
});

// ---------------------------------------------------------------------------
// PUT /upload
// ---------------------------------------------------------------------------

describe('PUT /upload', () => {
  function makeUploadReq(body = 'hello', contentType = 'image/jpeg', auth = makeAuthToken()) {
    return new Request('http://localhost/upload', {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Authorization': auth },
      body,
    });
  }

  test('returns 401 when Authorization header is absent', async () => {
    const req = new Request('http://localhost/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: 'data',
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  test('returns 401 for wrong Authorization prefix (not "Nostr ")', async () => {
    const req = new Request('http://localhost/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Authorization': 'Bearer token' },
      body: 'data',
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  test('returns 401 for an event with wrong kind', async () => {
    const req = makeUploadReq('data', 'image/jpeg', makeAuthToken({ kind: 1 }));
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  test('returns 401 for an expired event (older than 5 minutes)', async () => {
    const stale = Math.floor(Date.now() / 1000) - 400;
    const req = makeUploadReq('data', 'image/jpeg', makeAuthToken({ created_at: stale }));
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  test('returns 401 for an event missing required fields', async () => {
    const token = `Nostr ${btoa(JSON.stringify({ kind: 24242, created_at: Math.floor(Date.now() / 1000) }))}`;
    const req = makeUploadReq('data', 'image/jpeg', token);
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  test('returns 401 when pubkey is not in ALLOWED_PUBKEYS whitelist', async () => {
    const env = makeEnv({ ALLOWED_PUBKEYS: 'b'.repeat(64) });
    const req = makeUploadReq('data', 'image/jpeg', makeAuthToken({ pubkey: 'a'.repeat(64) }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  test('succeeds when pubkey is in ALLOWED_PUBKEYS whitelist', async () => {
    const pubkey = 'a'.repeat(64);
    const { env, bucket } = makeEnvWithBucket({ ALLOWED_PUBKEYS: pubkey });
    bucket.head.mockResolvedValue(null);
    const req = makeUploadReq('hello', 'image/jpeg', makeAuthToken({ pubkey }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(201);
  });

  test('returns 413 when file exceeds MAX_FILE_SIZE', async () => {
    const env = makeEnv({ MAX_FILE_SIZE: '4' });
    const req = makeUploadReq('hello', 'image/jpeg'); // 5 bytes > 4 bytes limit
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(413);
  });

  test('returns 415 for an unsupported MIME type', async () => {
    const req = makeUploadReq('data', 'application/zip');
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(415);
  });

  test('allows upload when MIME type is in custom ALLOWED_MIME_TYPES', async () => {
    const { env, bucket } = makeEnvWithBucket({ ALLOWED_MIME_TYPES: 'application/zip' });
    bucket.head.mockResolvedValue(null);
    const req = makeUploadReq('data', 'application/zip');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(201);
  });

  test('returns 200 with existing descriptor on duplicate upload without calling R2 put', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue({ size: 5, uploaded: new Date() });
    const req = makeUploadReq('hello', 'image/jpeg');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('sha256');
    expect(body).toHaveProperty('size', 5);
    expect(body).toHaveProperty('url');
    expect(bucket.put).not.toHaveBeenCalled();
  });

  test('stores blob and returns 201 on new upload', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    const req = makeUploadReq('hello', 'image/jpeg');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.size).toBe(5);
    expect(body.type).toBe('image/jpeg');
    expect(body.uploaded).toBeGreaterThan(0);
    expect(body.url).toContain(body.sha256);
    expect(bucket.put).toHaveBeenCalledTimes(1);
  });

  test('passes correct metadata to R2 put', async () => {
    const pubkey = 'a'.repeat(64);
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    const req = makeUploadReq('hello', 'image/jpeg', makeAuthToken({ pubkey }));
    await worker.fetch(req, env, ctx);
    const [, , options] = bucket.put.mock.calls[0];
    expect(options.customMetadata.contentType).toBe('image/jpeg');
    expect(options.customMetadata.uploader).toBe(pubkey);
    const expiresAt = new Date(options.customMetadata.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    expect(expiresAt).toBeLessThan(Date.now() + 25 * 3600 * 1000);
  });

  test('sha256 in response matches the key passed to R2 put', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    const req = makeUploadReq('hello', 'image/jpeg');
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();
    const [putKey] = bucket.put.mock.calls[0];
    expect(body.sha256).toBe(putKey);
  });

  test('response URL includes the correct extension for the MIME type', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    const req = makeUploadReq('hello', 'image/webp');
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();
    expect(body.url).toMatch(/\.webp$/);
  });

  test('returns 500 when R2 put throws', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    bucket.put.mockRejectedValue(new Error('R2 unavailable'));
    const req = makeUploadReq('hello', 'image/jpeg');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// DELETE /<hash>
// ---------------------------------------------------------------------------

describe('DELETE /<hash>', () => {
  const uploaderPubkey = 'a'.repeat(64);

  function makeDeleteReq(hash = VALID_HASH, pubkey = uploaderPubkey) {
    return new Request(`http://localhost/${hash}`, {
      method: 'DELETE',
      headers: { 'Authorization': makeAuthToken({ pubkey }) },
    });
  }

  test('returns 401 when Authorization header is absent', async () => {
    const req = new Request(`http://localhost/${VALID_HASH}`, { method: 'DELETE' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  test('returns 404 when blob does not exist', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue(null);
    const req = makeDeleteReq();
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  test('returns 403 when requester is not the uploader', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue({
      customMetadata: { uploader: 'c'.repeat(64) },
    });
    const req = makeDeleteReq(VALID_HASH, uploaderPubkey);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });

  test('deletes blob and returns 204 when requester is the uploader', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue({ customMetadata: { uploader: uploaderPubkey } });
    const req = makeDeleteReq();
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(bucket.delete).toHaveBeenCalledWith(VALID_HASH);
    expect(bucket.delete).toHaveBeenCalledTimes(1);
  });

  test('strips file extension before looking up hash in R2', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockResolvedValue({ customMetadata: { uploader: uploaderPubkey } });
    const req = makeDeleteReq(`${VALID_HASH}.jpg`);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(bucket.head).toHaveBeenCalledWith(VALID_HASH);
    expect(bucket.delete).toHaveBeenCalledWith(VALID_HASH);
  });

  test('returns 500 when R2 throws', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.head.mockRejectedValue(new Error('R2 unavailable'));
    const req = makeDeleteReq();
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /list/<pubkey>
// ---------------------------------------------------------------------------

describe('GET /list/<pubkey>', () => {
  // The route regex /^\/list\/[a-f0-9]{64}$/ already rejects invalid pubkeys,
  // so they fall through to the 404 handler rather than reaching handleListBlobs.
  test('returns 404 for a malformed pubkey (route regex does not match)', async () => {
    const req = new Request('http://localhost/list/not-a-pubkey', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  test('returns an empty array when the bucket is empty', async () => {
    const { env } = makeEnvWithBucket();
    const req = new Request(`http://localhost/list/${VALID_PUBKEY}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('returns only blobs belonging to the requested pubkey', async () => {
    const { env, bucket } = makeEnvWithBucket();
    const myPubkey = 'a'.repeat(64);
    const otherPubkey = 'b'.repeat(64);
    bucket.list.mockResolvedValue({
      objects: [
        {
          key: '1'.repeat(64),
          size: 100,
          uploaded: new Date('2024-01-01'),
          customMetadata: { uploader: myPubkey, contentType: 'image/jpeg' },
        },
        {
          key: '2'.repeat(64),
          size: 200,
          uploaded: new Date('2024-01-02'),
          customMetadata: { uploader: otherPubkey, contentType: 'image/png' },
        },
      ],
      truncated: false,
    });
    const req = new Request(`http://localhost/list/${myPubkey}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].sha256).toBe('1'.repeat(64));
    expect(body[0].type).toBe('image/jpeg');
  });

  test('deletes expired blobs and excludes them from the response', async () => {
    const { env, bucket } = makeEnvWithBucket();
    const pubkey = 'a'.repeat(64);
    const expiredKey = '1'.repeat(64);
    const validKey = '2'.repeat(64);
    bucket.list.mockResolvedValue({
      objects: [
        {
          key: expiredKey,
          size: 100,
          uploaded: new Date(),
          customMetadata: {
            uploader: pubkey,
            contentType: 'image/jpeg',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
        {
          key: validKey,
          size: 200,
          uploaded: new Date(),
          customMetadata: {
            uploader: pubkey,
            contentType: 'image/png',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
        },
      ],
      truncated: false,
    });
    const req = new Request(`http://localhost/list/${pubkey}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].sha256).toBe(validKey);
    expect(bucket.delete).toHaveBeenCalledWith(expiredKey);
    expect(bucket.delete).toHaveBeenCalledTimes(1);
  });

  test('blob descriptor contains correct url, size, type, and uploaded fields', async () => {
    const { env, bucket } = makeEnvWithBucket();
    const pubkey = 'a'.repeat(64);
    const blobKey = '3'.repeat(64);
    const uploadedDate = new Date('2024-03-01T10:00:00Z');
    bucket.list.mockResolvedValue({
      objects: [
        {
          key: blobKey,
          size: 512,
          uploaded: uploadedDate,
          customMetadata: { uploader: pubkey, contentType: 'image/webp' },
        },
      ],
      truncated: false,
    });
    const req = new Request(`http://localhost/list/${pubkey}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    const [blob] = await res.json();
    expect(blob.sha256).toBe(blobKey);
    expect(blob.url).toBe(`http://localhost/${blobKey}.webp`);
    expect(blob.size).toBe(512);
    expect(blob.type).toBe('image/webp');
    expect(blob.uploaded).toBe(Math.floor(uploadedDate.getTime() / 1000));
  });

  test('returns 500 when R2 list throws', async () => {
    const { env, bucket } = makeEnvWithBucket();
    bucket.list.mockRejectedValue(new Error('R2 unavailable'));
    const req = new Request(`http://localhost/list/${VALID_PUBKEY}`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
  });
});
