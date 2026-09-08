import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createHash } from 'node:crypto';

const result = await build({ entryPoints:['src/index.js'], bundle:true, write:false, format:'esm', platform:'browser' });
const mf = new Miniflare(convertV4MiniflareOptions({
  modules:true, script:result.outputFiles[0].text, compatibilityDate:'2024-09-23',
  r2Buckets:['BLOSSOM_BUCKET'],
  ratelimits:{ RATE_LIMITER:{ namespace_id:'900101', simple:{limit:1000,period:60} } },
}));
const secret = new Uint8Array(32); secret[31]=1;
const pk = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
const digest = data => createHash('sha256').update(data).digest('hex');
function token(action, hash) {
  const now=Math.floor(Date.now()/1000);
  const event={pubkey:pk,kind:24242,created_at:now-1,content:'統合テスト',tags:[['t',action],['x',hash],['expiration',String(now+60)]]};
  event.id=digest(JSON.stringify([0,pk,event.created_at,event.kind,event.tags,event.content]));
  event.sig=Buffer.from(schnorr.sign(Buffer.from(event.id,'hex'),secret)).toString('hex');
  return 'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64url');
}
try {
  const body='real R2 integration', hash=digest(body), authorization=token('upload',hash);
  const headers={Authorization:authorization,'Content-Type':'text/plain','X-SHA-256':hash};
  let r=await mf.dispatchFetch('https://blossom.example/upload',{method:'PUT',headers,body});
  assert.equal(r.status,201,await r.text());
  r=await mf.dispatchFetch('https://blossom.example/upload',{method:'PUT',headers:{...headers,'Content-Type':'image/png'},body});
  assert.equal(r.status,200);assert.equal((await r.json()).type,'text/plain');
  r=await mf.dispatchFetch('https://blossom.example/'+hash);
  assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(await r.text(),body);
  r=await mf.dispatchFetch('https://blossom.example/list/'+pk+'?limit=1');
  assert.equal(r.status,200);assert.equal((await r.json())[0].sha256,hash);
  r=await mf.dispatchFetch('https://blossom.example/list/'+pk+'?limit=1&cursor='+hash);
  assert.equal(r.status,200);assert.deepEqual(await r.json(),[]);
  r=await mf.dispatchFetch('https://blossom.example/upload',{method:'HEAD',headers:{
    Authorization:authorization,'X-SHA-256':hash,'X-Content-Type':'text/plain','X-Content-Length':String(Buffer.byteLength(body))}});
  assert.equal(r.status,200);
  r=await mf.dispatchFetch('https://blossom.example/'+hash,{method:'DELETE',headers:{Authorization:token('delete',hash)}});
  assert.equal(r.status,204);
  r=await mf.dispatchFetch('https://blossom.example/'+hash);assert.equal(r.status,404);
  console.log('Workers/R2 integration passed: signed upload, duplicate MIME, retrieval, hash pagination, HEAD and deletion.');
} finally { await mf.dispose(); }
