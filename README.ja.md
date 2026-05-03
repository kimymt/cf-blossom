# cf-blossom
このリポジトリの内容はすべて、エンジニアではない人物がLLMを用いて生成したものです。
内容を十分にご確認のうえ、自己責任でご利用ください。

> 英語版は [README.md](./README.md) を参照してください。

## 概要
[Blossomプロトコル](https://github.com/hzrd149/blossom)に対応したファイルストレージサーバーを、Cloudflare Workers と R2 ストレージで実装したものです。

## 機能

- **[BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md)**: サーバー要件およびブロブ取得
- **[BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md)**: ブロブのアップロード・管理
- **[BUD-06](https://github.com/hzrd149/blossom/blob/master/buds/06.md)**: アップロード要件
- **[Nostr](https://github.com/nostr-protocol/nostr) 認証**: 公開鍵による認証とアクセス制御
- **R2 ストレージ**: Cloudflare R2 を用いた高速なファイル保存
- **自動削除**: オブジェクトのメタデータに 24 時間 TTL を保持し、`GET /list/<pubkey>` 時の遅延削除に加え、R2 ライフサイクルルールによって恒久的に削除します
- **ファイル制限**: MIME タイプおよびファイルサイズの制限

## セットアップ

### 1. 必要ツールのインストール

`wrangler` は dev dependency に含まれているため、通常のインストールで十分です。

```bash
npm install
```

`npx` や `npm run` 経由ではなく `wrangler` を直接呼び出したい場合は、任意でグローバルインストールしてください。

```bash
npm install -g wrangler
```

### 2. Cloudflare アカウントの設定

```bash
wrangler login
```

### 3. R2 バケットの作成

```bash
# 本番環境用
wrangler r2 bucket create blossom-bucket
# 開発環境用
wrangler r2 bucket create blossom-bucket-dev
```

### 4. 環境変数の設定

`wrangler.toml` に以下の環境変数を設定します。

- `ALLOWED_PUBKEYS`: 許可する Nostr 公開鍵（HEX 形式、カンマ区切り）。空にするとすべての公開鍵を許可します。
- `ALLOWED_MIME_TYPES`: 許可するファイル形式（カンマ区切り）
- `MAX_FILE_SIZE`: 最大ファイルサイズ（バイト）
- `R2_BUCKET_NAME`: 参考情報として `wrangler.toml` に残しているのみで、現在の Worker コードからは参照されません。R2 アクセスはバインディング（`BLOSSOM_BUCKET`）経由で行われます。
- R2 バインディング（`[[r2_buckets]]`）: Worker は `BLOSSOM_BUCKET` というバインディング名で R2 を読み書きします。`[[env.production.r2_buckets]]` と `[[env.development.r2_buckets]]` の各ブロックで `binding = "BLOSSOM_BUCKET"` を定義し、それぞれ対応するバケットを指すようにしてください。

### 5. デプロイ

```bash
# 開発環境（スクリプト名は "staging" ですが、実際は `wrangler deploy --env development` を実行します）
npm run deploy:staging
# 本番環境
npm run deploy:production
```

### 6. R2 バケットのライフサイクルルール設定

Cloudflare ダッシュボードで R2 バケットの自動削除ルールを設定します。

1. Cloudflare ダッシュボードにログインし、**R2** に移動します。
2. 使用するバケット（例: `blossom-bucket`）を選択します。
3. **Settings** タブを開きます。
4. **Object Lifecycle Rules** セクションを探し、**Create rule** をクリックします。
5. ルール名を入力し、`Delete objects after N Day(s)` を選択して「1」日に設定し、保存します。

## ローカル開発

wrangler 経由で miniflare を使い、Worker をローカル実行します。

```bash
npm run dev
```

## テスト

リポジトリには Jest によるテストスイート（`src/index.test.js`）が含まれています。テストは ESM VM modules の実験的フラグを付けて実行します。

```bash
npm test
```

## ログ

デプロイ済み Worker のライブログを取得します。

```bash
npm run tail
```

## API エンドポイント

| メソッド | パス                  | BUD    | 概要                                          | 認証     |
| -------- | --------------------- | ------ | --------------------------------------------- | -------- |
| GET      | `/`                   | —      | ヘルス・ステータスメッセージ                  | 不要     |
| GET      | `/<sha256>[.ext]`     | BUD-01 | ブロブの取得                                  | 不要     |
| HEAD     | `/<sha256>[.ext]`     | BUD-01 | ブロブの存在確認                              | 不要     |
| PUT      | `/upload`             | BUD-02 | ブロブのアップロード（JSON ディスクリプタ返却）| 必要     |
| HEAD     | `/upload`             | BUD-06 | アップロード要件をヘッダーで返却              | 不要     |
| GET      | `/list/<pubkey>`      | BUD-02 | 指定 pubkey がアップロードしたブロブの一覧    | 任意     |
| DELETE   | `/<sha256>[.ext]`     | BUD-02 | ブロブの削除（アップロード者のみ可）          | 必要     |

認証には Nostr の `kind:24242` イベントを Base64 エンコードし、`Authorization: Nostr <base64-event>` ヘッダーで送信します。作成から 5 分以上経過したイベントは拒否されます。
