# Security remediation and rollout

The Worker implements BUD-01, BUD-02, BUD-06, BUD-11 and BUD-12. Public blob retrieval and anonymous listing remain supported. Upload and delete require a valid signed Nostr event.

## Implemented

- NIP-01 event ID reconstruction and BIP-340 Schnorr verification using noble-curves.
- Strict action, expiration, timestamp, hash and optional server scoping. Multiple hash/server tags and UTF-8 Base64url are supported; legacy Base64 is also accepted. Expiration controls validity instead of an arbitrary five-minute age cutoff.
- Bounded streaming reads before storage, header/body hash checks, an isolate-wide 48 MiB upload buffer budget, and a configurable 1-byte to 32-MiB file limit (10 MiB by default).
- Native rate limiting before expensive operations plus signed-user limits for upload/delete. Missing or failing binding fails closed. Limits are approximate and per Cloudflare location, not a global storage quota. Anonymous requests also share limits when using the same IP.
- Expiry enforcement on GET, HEAD and list; no-store responses and nosniff headers.
- Per-user R2 index under __index/, ordered by reverse upload timestamp and hash. Public list requests never scan all blobs or delete data. Page limit is 1–20 (default 20), with a budget of 30 examined entries; excessive stale entries return 503 rather than a silently incomplete page.
- Conditional create prevents duplicate upload races from replacing ownership. Duplicate descriptors use stored MIME and timestamp. An expired object still physically in R2 returns 409 on upload; its owner can DELETE then re-upload, or wait for lifecycle deletion.
- Cron builds/repairs legacy indexes in batches of 25 (below the Free plan subrequest budget), cycling through the 16 hash prefixes. A checkpoint resumes truncated pages and failures retry the same page. The index is derived; GET/HEAD and authorization always consult the blob metadata.
- An invalid optional list token is rejected. Listing remains public; tokens do not make it private.
- Babel and Workers type dependencies updated. Signed regression tests replace fake-signature success fixtures.

## Before production rollout

1. Run npm test and npm run test:integration. No production storage is used.
2. Confirm the RATE_LIMITER namespace IDs in wrangler.toml are unused by unrelated Workers on your account. Different environments have different IDs.
3. Keep the existing R2 lifecycle deletion rule at one day, covering the whole bucket, including internal index objects. Custom expiresAt metadata does not itself delete bytes. GET/HEAD enforce logical expiry independently of lifecycle timing.
4. Deploy only when authorized. The repository changes do not deploy or change Cloudflare dashboard settings.
5. Allow Cron to backfill existing live blobs. Each invocation processes one page of one hash prefix; at least 16 invocations are needed for a full cycle and more for large buckets. Existing GET/HEAD links continue working immediately, but legacy list entries appear after backfill. The cycle repeats to repair failed index writes.
6. Purge any existing CDN caches for blob URLs if applicable. New no-store headers cannot invalidate responses already cached by clients under the old one-year policy; previously downloaded copies cannot be recalled.
7. Verify a real client's signed PUT, optional HEAD preflight, duplicate upload, GET/HEAD, list pagination and owner DELETE in staging. A missing/removed cursor blob returns 400; restart pagination. Malformed credentials that formerly passed are intentionally rejected.

## Specification references

- https://github.com/hzrd149/blossom/blob/master/buds/01.md
- https://github.com/hzrd149/blossom/blob/master/buds/02.md
- https://github.com/hzrd149/blossom/blob/master/buds/06.md
- https://github.com/hzrd149/blossom/blob/master/buds/11.md
- https://github.com/hzrd149/blossom/blob/master/buds/12.md
- https://github.com/nostr-protocol/nips/blob/master/01.md
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
