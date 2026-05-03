# cf-blossom
All contents of this repository are generated using LLMs by non-engineer.
Please carefully verify the content and use it at your own responsibility.

## About
Implementation of a file storage server for the [Blossom protocol](https://github.com/hzrd149/blossom) using Cloudflare Workers and R2 storage.

## Features

- **[BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md)**: Server requirements and blob retrieval
- **[BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md)**: Blob upload and management
- **[BUD-06](https://github.com/hzrd149/blossom/blob/master/buds/06.md)**: Upload requirements
- **[Nostr](https://github.com/nostr-protocol/nostr) Authentication**: Authentication and access control using public keys
- **R2 Storage**: High-speed file storage using Cloudflare R2
- **Auto Deletion**: 24-hour TTL stored in object metadata, lazy cleanup on `GET /list/<pubkey>`, plus permanent removal via R2 lifecycle rules
- **File Restrictions**: MIME type and file size limitations

## Setup

### 1. Install Required Tools

`wrangler` is included as a dev dependency, so a plain install is sufficient:

```bash
npm install
```

If you prefer to invoke `wrangler` globally instead of via `npx`/`npm run`, you can optionally install it globally:

```bash
npm install -g wrangler
```

### 2. Configure Cloudflare Account

```bash
wrangler login
```

### 3. Create R2 Buckets

```bash
# For production environment
wrangler r2 bucket create blossom-bucket
# For development environment
wrangler r2 bucket create blossom-bucket-dev
```

### 4. Configure Environment Variables

Set the following environment variables in the `wrangler.toml` file:

- `ALLOWED_PUBKEYS`: Allowed Nostr public keys (HEX format, comma-separated). Leave empty to allow any pubkey.
- `ALLOWED_MIME_TYPES`: Allowed file formats (comma-separated)
- `MAX_FILE_SIZE`: Maximum file size (bytes)
- `R2_BUCKET_NAME`: Informational only — kept in `wrangler.toml` for reference. The Worker accesses R2 through the binding (`BLOSSOM_BUCKET`), not this variable.
- R2 bindings (`[[r2_buckets]]`): The Worker reads/writes via the binding name `BLOSSOM_BUCKET`. Ensure each environment block (`[[env.production.r2_buckets]]` and `[[env.development.r2_buckets]]`) defines `binding = "BLOSSOM_BUCKET"` and points to the corresponding bucket.

### 5. Deploy

```bash
# Development environment (script name is "staging" but it runs `wrangler deploy --env development`)
npm run deploy:staging
# Production environment
npm run deploy:production
```

### 6. Configure R2 Bucket Lifecycle Rules

Configure automatic deletion rules for R2 buckets in the Cloudflare dashboard.

1. Log in to the Cloudflare dashboard and navigate to **R2**.
2. Select the bucket you want to use (e.g., `blossom-bucket`).
3. Go to the **Settings** tab.
4. Find the **Object Lifecycle Rules** section and click **Create rule**.
5. Set a rule name, select `Delete objects after N Day(s)`, set it to "1" day, and save.

## Local Development

Run the Worker locally with miniflare via wrangler:

```bash
npm run dev
```

## Testing

The repository ships with a Jest test suite (`src/index.test.js`). Tests run under the experimental ESM VM modules flag:

```bash
npm test
```

## Logs

Tail live logs from a deployed Worker:

```bash
npm run tail
```

## API Endpoints

| Method | Path                  | BUD    | Description                                  | Auth |
| ------ | --------------------- | ------ | -------------------------------------------- | ---- |
| GET    | `/`                   | —      | Health/status message                        | No   |
| GET    | `/<sha256>[.ext]`     | BUD-01 | Retrieve a blob                              | No   |
| HEAD   | `/<sha256>[.ext]`     | BUD-01 | Check whether a blob exists                  | No   |
| PUT    | `/upload`             | BUD-02 | Upload a blob, returns blob descriptor JSON  | Yes  |
| HEAD   | `/upload`             | BUD-06 | Returns upload requirements as headers       | No   |
| GET    | `/list/<pubkey>`      | BUD-02 | List blobs uploaded by the given pubkey      | Optional |
| DELETE | `/<sha256>[.ext]`     | BUD-02 | Delete a blob (uploader only)                | Yes  |

Authentication uses Nostr `kind:24242` events, base64-encoded and supplied via the `Authorization: Nostr <base64-event>` header. Events older than 5 minutes are rejected.
