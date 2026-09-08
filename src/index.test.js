import { describe, test, expect, jest } from '@jest/globals';
import { webcrypto, createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import worker, { calculateSHA256, isValidSHA256, isValidPubkey } from './index.js';
import { indexBlob, indexKey, maintainIndex, TTL_MS } from './storage.js';
globalThis.crypto ??= webcrypto;
const secret = new Uint8Array(32); secret[31] = 1;
const secret2 = new Uint8Array(32); secret2[31] = 2;
const pk = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
const pk2 = Buffer.from(schnorr.getPublicKey(secret2)).toString('hex');
const digest = data => createHash('sha256').update(data).digest('hex');
const body = 'hello', hash = digest(body);
const origin = 'https://blossom.example';
function signed(action = 'upload', hashes = [hash], overrides = {}, key = secret, encoding = 'base64url') {
  const now = Math.floor(Date.now() / 1000);
  const event = { pubkey: Buffer.from(schnorr.getPublicKey(key)).toString('hex'), kind: 24242,
    created_at: now - 1, content: 'ファイルを操作する',
    tags: [['t', action], ['expiration', String(now + 300)], ...hashes.map(h => ['x', h])], ...overrides };
  event.id = digest(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
  event.sig = Buffer.from(schnorr.sign(Buffer.from(event.id, 'hex'), key)).toString('hex');
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString(encoding);
}
function tamper(auth, fields) {
  const event = JSON.parse(Buffer.from(auth.slice(6), 'base64url').toString());
  return 'Nostr ' + Buffer.from(JSON.stringify({ ...event, ...fields })).toString('base64url');
}
function bucketMock() {
  const data = new Map();
  const bucket = {
    data,
    head: jest.fn(async key => data.get(key) || null),
    get: jest.fn(async key => {
      const o = data.get(key);
      return o ? { ...o, body: new Response(o.bytes).body, json: async () => JSON.parse(new TextDecoder().decode(o.bytes)) } : null;
    }),
    put: jest.fn(async (key, bytes, options = {}) => {
      if (options.onlyIf?.etagDoesNotMatch === '*' && data.has(key)) return null;
      const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
      const o = { key, bytes: raw.slice(), size: raw.byteLength, uploaded: new Date(),
        customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} };
      data.set(key, o); return o;
    }),
    delete: jest.fn(async key => { data.delete(key); }),
    list: jest.fn(async options => {
      const all = [...data.values()].filter(o => o.key.startsWith(options.prefix || '') &&
        o.key > (options.cursor || options.startAfter || '')).sort((a,b) => a.key < b.key ? -1 : 1);
      const objects = all.slice(0, options.limit || 1000);
      return { objects, truncated: objects.length < all.length, cursor: objects.at(-1)?.key };
    }),
  }; return bucket;
}
function env(extra = {}) {
  return { BLOSSOM_BUCKET: bucketMock(), RATE_LIMITER: { limit: jest.fn(async () => ({ success: true })) },
    ALLOWED_PUBKEYS: pk, ...extra };
}
function req(path = '/upload', method = 'PUT', auth = signed(), data = body, headers = {}) {
  return new Request(origin + path, { method, headers: { ...(auth ? { Authorization: auth } : {}),
    ...(method === 'PUT' ? { 'Content-Type': 'text/plain' } : {}), ...headers },
    ...(method === 'PUT' ? { body: data, duplex: 'half' } : {}) });
}
async function seed(e, text = body, owner = pk, uploaded = new Date(), expiry = new Date(Date.now()+TTL_MS).toISOString()) {
  const key = digest(text);
  const o = await e.BLOSSOM_BUCKET.put(key, text, { customMetadata: { uploader: owner, contentType:'text/plain', expiresAt:expiry } });
  o.uploaded = uploaded; await indexBlob(e.BLOSSOM_BUCKET, o); return o;
}
describe('signed authentication', () => {
  test.each(['base64url', 'base64'])('valid UTF-8 %s token uploads exact bytes', async encoding => {
    const e = env(); const r = await worker.fetch(req('/upload','PUT',signed('upload',[hash],{},secret,encoding)), e);
    expect(r.status).toBe(201); expect((await r.json()).sha256).toBe(hash);
    expect(new TextDecoder().decode(e.BLOSSOM_BUCKET.data.get(hash).bytes)).toBe(body);
  });
  test.each([
    ['fake signature', () => tamper(signed(), { sig: '0'.repeat(128) })],
    ['modified content', () => tamper(signed(), { content:'changed' })],
    ['wrong id', () => tamper(signed(), { id: '0'.repeat(64) })],
    ['missing id', () => tamper(signed(), { id: undefined })],
    ['future time', () => signed('upload',[hash],{created_at: Math.floor(Date.now()/1000)+100})],
    ['string time', () => signed('upload',[hash],{created_at:'not-a-time'})],
    ['wrong kind', () => signed('upload',[hash],{kind:1})],
    ['empty content', () => signed('upload',[hash],{content:''})],
    ['wrong operation', () => signed('list')],
    ['missing tags', () => signed('upload',[hash],{tags:[]})],
    ['expired', () => signed('upload',[hash],{tags:[['t','upload'],['x',hash],['expiration','1']]})],
    ['wrong server', () => signed('upload',[hash],{tags:[['t','upload'],['x',hash],['expiration','9999999999'],['server','other.example']]})],
    ['wrong hash', () => signed('upload',['f'.repeat(64)])],
  ])('rejects %s without storage writes', async (_name, token) => {
    const e = env(); const r = await worker.fetch(req('/upload','PUT',token()), e);
    expect(r.status).toBe(401); expect(e.BLOSSOM_BUCKET.put).not.toHaveBeenCalled();
  });
  test('allows multiple hash/server tags and old, unexpired events', async () => {
    const auth = signed('upload',[hash],{ created_at:Math.floor(Date.now()/1000)-1000,
      tags:[['t','upload'],['expiration','9999999999'],['x','f'.repeat(64)],['x',hash],
        ['server','other.example'],['server','blossom.example']] });
    expect((await worker.fetch(req('/upload','PUT',auth),env())).status).toBe(201);
  });
  test('allowlist rejects a valid signature from another user', async () => {
    expect((await worker.fetch(req('/upload','PUT',signed('upload',[hash],{},secret2)),env())).status).toBe(403);
  });
  test('empty allowlist still requires valid signatures', async () => {
    expect((await worker.fetch(req('/upload','PUT',signed('upload',[hash],{},secret2)),env({ALLOWED_PUBKEYS:''}))).status).toBe(201);
    expect((await worker.fetch(req('/upload','PUT',null),env({ALLOWED_PUBKEYS:''}))).status).toBe(401);
  });
});
describe('upload bounds, rate limits and storage', () => {
  test('excess declared length rejected before reading body', async () => {
    const e=env({MAX_FILE_SIZE:'4'}), r=req('/upload','PUT',signed(),body,{'Content-Length':'5'});
    expect((await worker.fetch(r,e)).status).toBe(413); expect(r.bodyUsed).toBe(false);
  });
  test('unknown-length stream stops and cancels on overflow', async () => {
    const cancel=jest.fn(); let count=0;
    const stream=new ReadableStream({ pull(c){count++;c.enqueue(new Uint8Array(3));},cancel },{highWaterMark:0});
    const e=env({MAX_FILE_SIZE:'4'});
    expect((await worker.fetch(req('/upload','PUT',signed(),stream),e)).status).toBe(413);
    expect(count).toBe(2);expect(cancel).toHaveBeenCalled();expect(e.BLOSSOM_BUCKET.put).not.toHaveBeenCalled();
  });
  test.each(['3','6'])('rejects declared length mismatch %s', async size => {
    expect((await worker.fetch(req('/upload','PUT',signed(),body,{'Content-Length':size}),env())).status).toBe(400);
  });
  test.each(['-1','NaN','12junk','33554433'])('fails closed for invalid configured size %s', async size => {
    expect((await worker.fetch(req(),env({MAX_FILE_SIZE:size}))).status).toBe(503);
  });
  test('rejects header/body hash mismatch', async () => {
    const e=env();expect((await worker.fetch(req('/upload','PUT',signed('upload',['f'.repeat(64)]),body,{'X-SHA-256':'f'.repeat(64)}),e)).status).toBe(409);
    expect(e.BLOSSOM_BUCKET.put).not.toHaveBeenCalled();
  });
  test('duplicate descriptor uses stored MIME and timestamp', async () => {
    const e=env();const original=await seed(e);
    const r=await worker.fetch(req('/upload','PUT',signed(),body,{'Content-Type':'image/png'}),e);
    expect(r.status).toBe(200);const d=await r.json();expect(d.type).toBe('text/plain');
    expect(d.url.endsWith('.txt')).toBe(true);expect(d.uploaded).toBe(Math.floor(original.uploaded.getTime()/1000));
  });
  test('conditional upload prevents concurrent owner replacement', async () => {
    const e=env({ALLOWED_PUBKEYS:''});
    const responses=await Promise.all([worker.fetch(req(),e),worker.fetch(req('/upload','PUT',signed('upload',[hash],{},secret2)),e)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,201]);
    expect([pk,pk2]).toContain(e.BLOSSOM_BUCKET.data.get(hash).customMetadata.uploader);
  });
  test('rate limit blocks before R2 operations and has retry headers', async () => {
    const e=env();e.RATE_LIMITER.limit.mockResolvedValue({success:false});
    const r=await worker.fetch(req('/list/'+pk,'GET',null),e);
    expect(r.status).toBe(429);expect(r.headers.get('Retry-After')).toBe('60');
    expect(e.BLOSSOM_BUCKET.list).not.toHaveBeenCalled();
  });
  test('missing rate limiter fails closed', async () => {
    expect((await worker.fetch(req(),env({RATE_LIMITER:undefined}))).status).toBe(503);
  });
  test('storage failure does not report success', async () => {
    const e=env();e.BLOSSOM_BUCKET.put.mockRejectedValue(new Error('private backend details'));
    const r=await worker.fetch(req(),e);expect(r.status).toBe(503);expect(await r.text()).not.toContain('private');
  });
  test('expired duplicate cannot silently claim successful retention', async () => {
    const e=env();await seed(e,body,pk,new Date(),new Date(Date.now()-1).toISOString());
    expect((await worker.fetch(req(),e)).status).toBe(409);
  });
});
describe('retrieval and deletion', () => {
  test.each(['GET','HEAD'])('serves exact metadata without persistent cache for %s',async method=>{
    const e=env();await seed(e);
    const r=await worker.fetch(req('/'+hash+'.txt',method,null),e);
    expect(r.status).toBe(200);expect(r.headers.get('Content-Length')).toBe('5');
    expect(r.headers.get('Cache-Control')).toBe('no-store');expect(r.headers.get('Sunset')).toBeTruthy();
    expect(await r.text()).toBe(method==='HEAD'?'':body);
  });
  test.each(['GET','HEAD'])('hides expired data on %s',async method=>{
    const e=env();await seed(e,body,pk,new Date(),new Date(Date.now()-1).toISOString());
    expect((await worker.fetch(req('/'+hash,method,null),e)).status).toBe(404);
  });
  test('legacy objects without expiry fall back to upload time',async()=>{
    const e=env();const o=await seed(e,body,pk,new Date(Date.now()-2*TTL_MS));delete o.customMetadata.expiresAt;
    expect((await worker.fetch(req('/'+hash,'GET',null),e)).status).toBe(404);
  });
  test('scoped owner deletion removes data and listing entry',async()=>{
    const e=env();const o=await seed(e);
    expect((await worker.fetch(req('/'+hash+'.txt','DELETE',signed('delete')),e)).status).toBe(204);
    expect(e.BLOSSOM_BUCKET.data.has(hash)).toBe(false);expect(e.BLOSSOM_BUCKET.data.has(indexKey(o))).toBe(false);
  });
  test('valid non-owner deletion forbidden',async()=>{
    const e=env({ALLOWED_PUBKEYS:''});await seed(e);
    expect((await worker.fetch(req('/'+hash,'DELETE',signed('delete',[hash],{},secret2)),e)).status).toBe(403);
  });
  test('upload token cannot delete',async()=>{
    const e=env();await seed(e);
    expect((await worker.fetch(req('/'+hash,'DELETE',signed()),e)).status).toBe(401);
    expect(e.BLOSSOM_BUCKET.delete).not.toHaveBeenCalled();
  });
});
describe('BUD-06 and CORS',()=>{
  const headers={'X-SHA-256':hash,'X-Content-Type':'text/plain','X-Content-Length':'5'};
  test('valid signed HEAD advertises acceptance without body or writes',async()=>{
    const e=env();const r=await worker.fetch(req('/upload','HEAD',signed(),null,headers),e);
    expect(r.status).toBe(200);expect(await r.text()).toBe('');expect(e.BLOSSOM_BUCKET.put).not.toHaveBeenCalled();
  });
  test.each([
    [413,{'X-Content-Length':'999999999'}],[415,{'X-Content-Type':'application/zip'}],
    [400,{'X-SHA-256':'invalid'}],[400,{'X-Content-Length':'-2'}],
  ])('HEAD returns %s for rejected metadata',async(status,override)=>{
    const r=await worker.fetch(req('/upload','HEAD',signed(),null,{...headers,...override}),env());
    expect(r.status).toBe(status);expect(await r.text()).toBe('');expect(r.headers.get('X-Reason')).toBeTruthy();
  });
  test('HEAD enforces authentication',async()=>{
    expect((await worker.fetch(req('/upload','HEAD',null,null,headers),env())).status).toBe(401);
  });
  test('browser preflight permits Blossom headers',async()=>{
    const r=await worker.fetch(req('/upload','OPTIONS',null),env());
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(r.headers.get('Access-Control-Allow-Headers')).toContain('X-SHA-256');
    expect(r.headers.get('Access-Control-Expose-Headers')).toContain('X-Reason');
  });
});
describe('bounded indexed lists and maintenance',()=>{
  test('public list returns user-only results ordered descending with hash cursor',async()=>{
    const e=env();await seed(e,'older',pk,new Date(Date.now()-2000));
    const newest=await seed(e,'newest',pk,new Date());await seed(e,'someone else',pk2);
    const first=await worker.fetch(req('/list/'+pk+'?limit=1','GET',null),e);
    expect((await first.json())[0].sha256).toBe(newest.key);
    const next=await worker.fetch(req('/list/'+pk+'?limit=1&cursor='+newest.key,'GET',null),e);
    expect((await next.json())[0].sha256).toBe(digest('older'));
    expect(e.BLOSSOM_BUCKET.list.mock.calls.every(([o])=>o.prefix==='__index/'+pk+'/')).toBe(true);
    expect(e.BLOSSOM_BUCKET.delete).not.toHaveBeenCalled();
  });
  test('invalid optional auth is not ignored',async()=>{
    const e=env();expect((await worker.fetch(req('/list/'+pk,'GET','Bearer invalid'),e)).status).toBe(401);
    expect(e.BLOSSOM_BUCKET.list).not.toHaveBeenCalled();
  });
  test.each(['limit=0','limit=21','limit=NaN','cursor=invalid'])('rejects bad query %s',async query=>{
    expect((await worker.fetch(req('/list/'+pk+'?'+query,'GET',null),env())).status).toBe(400);
  });
  test('stale index entries never expose expired or deleted objects',async()=>{
    const e=env();await seed(e,body,pk,new Date(),new Date(Date.now()-1).toISOString());
    expect(await (await worker.fetch(req('/list/'+pk,'GET',null),e)).json()).toEqual([]);
    expect(e.BLOSSOM_BUCKET.delete).not.toHaveBeenCalled();
  });
  test('maintenance backfills legacy data, skips internal objects, resumes pages',async()=>{
    const e=env();const o=await seed(e);await e.BLOSSOM_BUCKET.delete(indexKey(o));
    await e.BLOSSOM_BUCKET.put('__maintenance/index-v1',JSON.stringify({prefix:parseInt(hash[0],16)}));
    await maintainIndex(e);
    expect(e.BLOSSOM_BUCKET.data.has(indexKey(o))).toBe(true);
    const result=await worker.fetch(req('/list/'+pk,'GET',null),e);expect((await result.json())[0].sha256).toBe(hash);
    expect(e.BLOSSOM_BUCKET.list.mock.calls[0][0].limit).toBe(25);
  });
});
test('hash utilities',async()=>{
  expect(isValidSHA256(hash)).toBe(true);expect(isValidSHA256({})).toBe(false);
  expect(isValidPubkey(pk)).toBe(true);expect(await calculateSHA256(new TextEncoder().encode(body))).toBe(hash);
});

describe('failure recovery and resource budgets', () => {
  test('index failure is reported and retry repairs the stored blob', async () => {
    const e=env(), original=e.BLOSSOM_BUCKET.put.getMockImplementation();
    e.BLOSSOM_BUCKET.put.mockImplementation(async (key,...args) => {
      if(key.startsWith('__index/')) throw new Error('index unavailable');
      return original(key,...args);
    });
    expect((await worker.fetch(req(),e)).status).toBe(503);
    expect(e.BLOSSOM_BUCKET.data.has(hash)).toBe(true);
    e.BLOSSOM_BUCKET.put.mockImplementation(original);
    expect((await worker.fetch(req(),e)).status).toBe(200);
    expect((await (await worker.fetch(req('/list/'+pk,'GET',null),e)).json())[0].sha256).toBe(hash);
  });
  test('invalid expiry fails closed', async () => {
    const e=env();await seed(e,body,pk,new Date(),'invalid');
    expect((await worker.fetch(req('/'+hash,'GET',null),e)).status).toBe(404);
  });
  test('maintenance resumes truncated pages and does not advance after failure', async () => {
    const e=env();
    for(let i=0;i<26;i++) await e.BLOSSOM_BUCKET.put(i.toString(16).padStart(64,'0'),body,{
      customMetadata:{uploader:pk,contentType:'text/plain',expiresAt:new Date(Date.now()+TTL_MS).toISOString()}
    });
    await maintainIndex(e);
    let checkpoint=await (await e.BLOSSOM_BUCKET.get('__maintenance/index-v1')).json();
    expect(checkpoint.prefix).toBe(0);expect(checkpoint.cursor).toBeTruthy();
    await maintainIndex(e);
    checkpoint=await (await e.BLOSSOM_BUCKET.get('__maintenance/index-v1')).json();
    expect(checkpoint).toEqual({prefix:1});
    expect([...e.BLOSSOM_BUCKET.data.keys()].filter(k=>k.startsWith('__index/'))).toHaveLength(26);
    e.BLOSSOM_BUCKET.list.mockRejectedValueOnce(new Error('transient'));
    await expect(maintainIndex(e)).rejects.toThrow('transient');
    expect(await (await e.BLOSSOM_BUCKET.get('__maintenance/index-v1')).json()).toEqual({prefix:1});
  });
  test('stale entries are skipped across pages within a bounded request count', async () => {
    const e=env();
    for(let i=0;i<25;i++) await seed(e,'expired-'+i,pk,new Date(Date.now()+i),new Date(Date.now()-1).toISOString());
    const live=await seed(e,'live',pk,new Date(Date.now()-1000));
    const r=await worker.fetch(req('/list/'+pk+'?limit=1','GET',null),e);
    expect(r.status).toBe(200);expect((await r.json())[0].sha256).toBe(live.key);
    expect(e.BLOSSOM_BUCKET.list).toHaveBeenCalledTimes(2);
    expect(e.BLOSSOM_BUCKET.head.mock.calls.length).toBeLessThanOrEqual(30);
  });
  test('too many stale entries return 503 instead of hiding remaining blobs', async () => {
    const e=env();
    for(let i=0;i<31;i++) await seed(e,'expired-'+i,pk,new Date(Date.now()+i),new Date(Date.now()-1).toISOString());
    const r=await worker.fetch(req('/list/'+pk+'?limit=1','GET',null),e);
    expect(r.status).toBe(503);expect(e.BLOSSOM_BUCKET.head).toHaveBeenCalledTimes(30);
  });
  test('isolate memory admission rejects excess concurrent buffers and releases on failure', async () => {
    const e=env({MAX_FILE_SIZE:'33554432'});
    let started, release;
    const reading=new Promise(resolve=>{started=resolve;});
    const blocked=new ReadableStream({start(c){release=()=>c.close();},pull(){started();}},{highWaterMark:0});
    const first=worker.fetch(req('/upload','PUT',signed(),blocked),e);
    await reading;
    expect((await worker.fetch(req(),e)).status).toBe(503);
    release();expect((await first).status).toBe(401);
    expect((await worker.fetch(req(),e)).status).toBe(201);
  });
});
