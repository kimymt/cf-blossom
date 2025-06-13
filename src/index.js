// Blossom Server on Cloudflare Workers with R2
// Implements BUD-01, BUD-02, and BUD-06 specifications

import { createHash } from 'crypto'; // Node.jsのcryptoモジュールをインポート

// 環境変数の設定
const CONFIG = {
  // 許可された公開鍵（16進形式、カンマ区切り）
  ALLOWED_PUBKEYS: 'ALLOWED_PUBKEYS',
  // 許可されたMIMEタイプ（カンマ区切り）
  ALLOWED_MIME_TYPES: 'ALLOWED_MIME_TYPES',
  // 最大ファイルサイズ（バイト）
  MAX_FILE_SIZE: 'MAX_FILE_SIZE',
  // R2バケット名 (R2_BUCKET_NAMEは文字列であり、実際のバインディングはBLOSSOM_BUCKET)
  R2_BUCKET_NAME: 'R2_BUCKET_NAME' 
};

// 環境変数が設定されていない場合のデフォルト値
const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'application/pdf', 'text/plain'
];

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// MIMEタイプとファイル拡張子のマッピング
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'text/plain': '.txt'
};

export default {
  // すべてのHTTPリクエストを処理するfetchハンドラ
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    // CORSヘッダーの設定
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // すべてのオリジンからのアクセスを許可
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400', // プリフライトリクエストのキャッシュ期間
    };

    // プリフライトリクエスト (OPTIONSメソッド) の処理
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ルートパス (/) へのGETリクエストの処理
      // Blossom Server APIが稼働していることを示すメッセージを返す
      if (pathname === '/' && method === 'GET') {
        return new Response('Blossom Server API is running. See documentation for usage.', {
          status: 200,
          headers: corsHeaders
        });
      }
      
      // ルーティングのハンドリング
      // GET /<SHA256>: オブジェクトの取得 (BUD-01)
      if (method === 'GET' && pathname.match(/^\/[a-f0-9]{64}/)) {
        return await handleGetBlob(request, env, pathname, corsHeaders);
      }
      
      // HEAD /<SHA256>: オブジェクトの存在確認 (BUD-01)
      if (method === 'HEAD' && pathname.match(/^\/[a-f0-9]{64}/)) {
        return await handleHeadBlob(request, env, pathname, corsHeaders);
      }
      
      // PUT /upload: オブジェクトのアップロード (BUD-02)
      if (method === 'PUT' && pathname === '/upload') {
        return await handleUpload(request, env, corsHeaders);
      }
      
      // HEAD /upload: アップロード要件の取得 (BUD-06)
      if (method === 'HEAD' && pathname === '/upload') {
        return await handleUploadRequirements(request, env, corsHeaders);
      }
      
      // GET /list/<pubkey>: オブジェクトのリスト表示 (BUD-02) - ★ここを追加/修正★
      if (method === 'GET' && pathname.match(/^\/list\/[a-f0-9]{64}$/)) {
        return await handleListBlobs(request, env, pathname, corsHeaders);
      }
      
      // DELETE /<SHA256>: オブジェクトの削除 (BUD-02)
      if (method === 'DELETE' && pathname.match(/^\/[a-f0-9]{64}/)) {
        return await handleDeleteBlob(request, env, pathname, corsHeaders);
      }

      // どのルートにも一致しない場合
      return new Response('Not Found', { 
        status: 404, 
        headers: corsHeaders 
      });

    } catch (error) {
      // エラーハンドリング
      console.error('Error:', error);
      return new Response('Internal Server Error', { 
        status: 500, 
        headers: corsHeaders 
      });
    }
  }
};

// BUD-01: GET /<SHA256> - オブジェクトの取得
async function handleGetBlob(request, env, pathname, corsHeaders) {
  // パスからハッシュと拡張子を抽出
  const hash = pathname.substring(1).split('.')[0]; 
  
  // SHA256形式のハッシュであるか検証
  if (!isValidSHA256(hash)) {
    return new Response('Invalid hash format', { 
      status: 400, 
      headers: corsHeaders 
    });
  }

  try {
    // R2からオブジェクトを取得 (R2バインディング名 env.BLOSSOM_BUCKET を直接使用)
    const object = await env.BLOSSOM_BUCKET.get(hash);
    
    // オブジェクトが見つからない場合
    if (!object) {
      return new Response('Blob not found', { 
        status: 404, 
        headers: corsHeaders 
      });
    }

    // カスタムメタデータからContent-Typeを取得、なければデフォルト値を使用
    const metadata = object.customMetadata || {};
    const contentType = metadata.contentType || 'application/octet-stream';
    
    // オブジェクトのボディとヘッダーを付けて応答
    return new Response(object.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Content-Length': object.size.toString(),
        'ETag': `"${hash}"`, // ETagヘッダーにハッシュを設定
        'Cache-Control': 'public, max-age=31536000, immutable' // キャッシュ制御
      }
    });
  } catch (error) {
    console.error('Error getting blob:', error);
    return new Response('Internal Server Error', { 
      status: 500, 
      headers: corsHeaders 
    });
  }
}

// BUD-01: HEAD /<SHA256> - オブジェクトの存在確認
async function handleHeadBlob(request, env, pathname, corsHeaders) {
  // パスからハッシュを抽出
  const hash = pathname.substring(1).split('.')[0];
  
  // SHA256形式のハッシュであるか検証
  if (!isValidSHA256(hash)) {
    return new Response(null, { 
      status: 400, 
      headers: corsHeaders 
    });
  }

  try {
    // R2でオブジェクトのヘッダー情報を取得
    const object = await env.BLOSSOM_BUCKET.head(hash);
    
    // オブジェクトが見つからない場合
    if (!object) {
      return new Response(null, { 
        status: 404, 
        headers: corsHeaders 
      });
    }

    // メタデータからContent-Typeを取得
    const metadata = object.customMetadata || {};
    const contentType = metadata.contentType || 'application/octet-stream';

    // オブジェクトのメタデータとヘッダーを付けて応答
    return new Response(null, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Content-Length': object.size.toString(),
        'ETag': `"${hash}"`,
        'Last-Modified': object.uploaded.toUTCString() // 最終更新日時
      }
    });
  } catch (error) {
    console.error('Error checking blob:', error);
    return new Response(null, { 
      status: 500, 
      headers: corsHeaders 
    });
  }
}

// BUD-02: PUT /upload - オブジェクトのアップロード
async function handleUpload(request, env, corsHeaders) {
  // 認証の確認
  const authResult = await verifyAuthorization(request, env, 'upload');
  if (!authResult.valid) {
    return new Response(authResult.error, { 
      status: 401, 
      headers: corsHeaders 
    });
  }

  // ファイルデータの取得とContent-Typeの特定
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const fileData = await request.arrayBuffer();
  
  // ファイルサイズの検証
  const maxSize = parseInt(env.MAX_FILE_SIZE) || DEFAULT_MAX_FILE_SIZE;
  if (fileData.byteLength > maxSize) {
    return new Response(`File too large. Maximum size: ${maxSize} bytes`, { 
      status: 413, 
      headers: corsHeaders 
    });
  }

  // MIMEタイプの検証
  const allowedTypes = env.ALLOWED_MIME_TYPES ? 
    env.ALLOWED_MIME_TYPES.split(',').map(t => t.trim()) : 
    DEFAULT_ALLOWED_MIME_TYPES;
    
  if (!allowedTypes.includes(contentType)) {
    return new Response(`Unsupported file type: ${contentType}`, { 
      status: 415, 
      headers: corsHeaders 
    });
  }

  // SHA256ハッシュの計算
  const hash = await calculateSHA256(fileData);
  
  // 既に同じハッシュのオブジェクトが存在するか確認
  const existingObject = await env.BLOSSOM_BUCKET.head(hash);
  if (existingObject) {
    // 存在する場合は既存のオブジェクトのディスクリプタを返す (重複アップロード防止)
    const extension = MIME_TO_EXT[contentType] || '';
    const url = `${new URL(request.url).origin}/${hash}${extension}`;
    
    return new Response(JSON.stringify({
      sha256: hash,
      size: existingObject.size,
      type: contentType,
      uploaded: Math.floor(existingObject.uploaded.getTime() / 1000),
      url: url
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }

  // TTL (Time To Live) の設定 (24時間)
  const ttl = 24 * 60 * 60; 
  const expiresAt = new Date(Date.now() + ttl * 1000);
  
  try {
    // R2にオブジェクトを保存
    await env.BLOSSOM_BUCKET.put(hash, fileData, {
      customMetadata: {
        contentType: contentType,
        uploader: authResult.pubkey, // アップロード者の公開鍵をメタデータとして保存
        expiresAt: expiresAt.toISOString() // 期限切れ日時をメタデータとして保存
      },
      httpMetadata: {
        contentType: contentType
      }
    });

    // オブジェクトのディスクリプタを生成して応答
    const extension = MIME_TO_EXT[contentType] || '';
    const url = `${new URL(request.url).origin}/${hash}${extension}`;
    
    const blobDescriptor = {
      sha256: hash,
      size: fileData.byteLength,
      type: contentType,
      uploaded: Math.floor(Date.now() / 1000),
      url: url
    };

    return new Response(JSON.stringify(blobDescriptor), {
      status: 201, // 201 Created ステータス
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    console.error('Error uploading blob:', error);
    return new Response('Upload failed', { 
      status: 500, 
      headers: corsHeaders 
    });
  }
}

// BUD-06: HEAD /upload - アップロード要件の取得
async function handleUploadRequirements(request, env, corsHeaders) {
  // 環境変数から最大サイズと許可MIMEタイプを取得
  const maxSize = parseInt(env.MAX_FILE_SIZE) || DEFAULT_MAX_FILE_SIZE;
  const allowedTypes = env.ALLOWED_MIME_TYPES ? 
    env.ALLOWED_MIME_TYPES.split(',').map(t => t.trim()) : 
    DEFAULT_ALLOWED_MIME_TYPES;

  // 要件をヘッダーとして応答
  return new Response(null, {
    headers: {
      ...corsHeaders,
      'X-Max-File-Size': maxSize.toString(),
      'X-Allowed-MIME-Types': allowedTypes.join(','),
      'X-TTL': '86400' // 24時間
    }
  });
}

// BUD-02: GET /list/<pubkey> - オブジェクトのリスト表示 (★新規実装/修正★)
async function handleListBlobs(request, env, pathname, corsHeaders) {
  const pubkey = pathname.split('/')[2];
  
  // Debug log: Requested pubkey
  console.log(`handleListBlobs: Requested pubkey = ${pubkey}`);

  if (!isValidPubkey(pubkey)) {
    return new Response('Invalid pubkey format', { 
      status: 400, 
      headers: corsHeaders 
    });
  }

  // オプションの認証チェック（リスト表示は認証なしでも可能）
  const authResult = await verifyAuthorization(request, env, 'list', false); // required = false

  try {
    // ★重要: R2のlist()でcustomMetadataを含めるようにincludeオプションを追加★
    const objects = await env.BLOSSOM_BUCKET.list({ include: ['customMetadata'] });
    const userBlobs = [];
    const now = Date.now();

    // Debug log: Number of objects returned by R2 list()
    console.log(`handleListBlobs: Total objects from R2 list = ${objects.objects.length}`);
    if (objects.truncated) {
        console.log(`handleListBlobs: R2 list is truncated, cursor = ${objects.cursor}`);
    }

    for (const object of objects.objects) {
      // customMetadataが取得されることを確認 (undefinedではなくなるはず)
      const metadata = object.customMetadata || {};
      
      // Debug log: Current object key and its uploader metadata
      console.log(`handleListBlobs: Checking object key = ${object.key}, uploader = ${metadata.uploader}, expiresAt = ${metadata.expiresAt}`);

      // 期限切れのオブジェクトをチェックし、期限切れなら削除してスキップ
      if (metadata.expiresAt && new Date(metadata.expiresAt).getTime() < now) {
        console.log(`Deleting expired object: ${object.key}`);
        await env.BLOSSOM_BUCKET.delete(object.key);
        continue;
      }
      
      // アップローダーの公開鍵が一致する場合のみリストに追加
      if (metadata.uploader === pubkey) {
        console.log(`handleListBlobs: Match found for key = ${object.key}`);
        const urlOrigin = new URL(request.url).origin; // リクエストのオリジンを使用
        const extension = MIME_TO_EXT[metadata.contentType] || '';
        const url = `${urlOrigin}/${object.key}${extension}`; // 正しいURLを構築
        
        userBlobs.push({
          sha256: object.key,
          size: object.size,
          type: metadata.contentType || 'application/octet-stream',
          uploaded: Math.floor(object.uploaded.getTime() / 1000),
          url: url,
          // BUD-02では含まれていないが、デバッグのために追加することも可能
          // expiresAt: metadata.expiresAt
        });
      }
    }

    // Debug log: Final number of blobs to return
    console.log(`handleListBlobs: Returning ${userBlobs.length} blobs.`);

    return new Response(JSON.stringify(userBlobs), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    console.error('Error listing blobs:', error);
    return new Response('Internal Server Error', { 
      status: 500, 
      headers: corsHeaders 
    });
  }
}

// BUD-02: DELETE /<SHA256> - オブジェクトの削除
async function handleDeleteBlob(request, env, pathname, corsHeaders) {
  // パスからハッシュを抽出
  const hash = pathname.substring(1);
  
  // SHA256形式のハッシュであるか検証
  if (!isValidSHA256(hash)) {
    return new Response('Invalid hash format', { 
      status: 400, 
      headers: corsHeaders 
    });
  }

  // 認証の確認
  const authResult = await verifyAuthorization(request, env, 'delete');
  if (!authResult.valid) {
    return new Response(authResult.error, { 
      status: 401, 
      headers: corsHeaders 
    });
  }

  try {
    // オブジェクトの存在確認と所有権の検証
    const object = await env.BLOSSOM_BUCKET.head(hash);
    
    if (!object) {
      return new Response('Blob not found', { 
        status: 404, 
        headers: corsHeaders 
      });
    }

    const metadata = object.customMetadata || {};
    // アップロード者と認証された公開鍵が一致するか確認 (所有権チェック)
    if (metadata.uploader !== authResult.pubkey) {
      return new Response('Unauthorized - not the uploader', { 
        status: 403, 
        headers: corsHeaders 
      });
    }

    // オブジェクトをR2から削除
    await env.BLOSSOM_BUCKET.delete(hash);

    // 204 No Content ステータスで応答
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });

  } catch (error) {
    console.error('Error deleting blob:', error);
    return new Response('Internal Server Error', { 
      status: 500, 
      headers: corsHeaders 
    });
  }
}

// 認証の検証 (Nostrイベント kind:24242)
async function verifyAuthorization(request, env, action, required = true) {
  const authHeader = request.headers.get('Authorization');
  
  // 認証ヘッダーが不要な場合（例：リスト表示）
  if (!authHeader && !required) {
    return { valid: true, pubkey: null };
  }

  // 認証ヘッダーがない場合
  if (!authHeader) {
    return { valid: false, error: 'Authorization header required' };
  }

  // "Nostr " プレフィックスの確認
  if (!authHeader.startsWith('Nostr ')) {
    return { valid: false, error: 'Invalid authorization format' };
  }

  const eventData = authHeader.substring(6); // 'Nostr ' プレフィックスを除去
  
  try {
    const event = JSON.parse(atob(eventData)); // Base64デコードとJSONパース
    
    // イベント構造の検証
    if (event.kind !== 24242) {
      return { valid: false, error: 'Invalid event kind' };
    }

    // 許可された公開鍵リストのチェック
    const allowedPubkeys = env.ALLOWED_PUBKEYS ? 
      env.ALLOWED_PUBKEYS.split(',').map(pk => pk.trim()) : [];
      
    // 許可された公開鍵リストが設定されていて、現在の公開鍵が含まれていない場合
    if (allowedPubkeys.length > 0 && !allowedPubkeys.includes(event.pubkey)) {
      return { valid: false, error: 'Pubkey not authorized' };
    }

    // 基本的なイベント検証（実際のNostrプロトコルでは署名検証も必要）
    if (!event.pubkey || !event.sig || !event.created_at) {
      return { valid: false, error: 'Invalid event structure' };
    }

    // イベントの古さチェック（5分以内）
    const eventAge = Math.floor(Date.now() / 1000) - event.created_at;
    if (eventAge > 300) { 
      return { valid: false, error: 'Event too old' };
    }

    // 認証成功
    return { valid: true, pubkey: event.pubkey };

  } catch (error) {
    console.error('Auth verification error:', error);
    return { valid: false, error: 'Invalid authorization format' }; 
  }
}

// ユーティリティ関数
// SHA256ハッシュ形式の検証
function isValidSHA256(hash) {
  return /^[a-f0-9]{64}$/.test(hash);
}

// 公開鍵形式の検証
function isValidPubkey(pubkey) {
  return /^[a-f0-9]{64}$/.test(pubkey);
}

// SHA256ハッシュの計算
async function calculateSHA256(data) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
