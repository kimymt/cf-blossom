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
- **Auto Deletion**: Automatic file deletion after 24 hours
- **File Restrictions**: MIME type and file size limitations

## Setup

### 1. Install Required Tools

```bash
npm install -g wrangler
npm install
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

- `ALLOWED_PUBKEYS`: Allowed Nostr public keys (HEX format, comma-separated)
- `ALLOWED_MIME_TYPES`: Allowed file formats (comma-separated)
- `MAX_FILE_SIZE`: Maximum file size (bytes)
- `R2_BUCKET_NAME`: R2 bucket name to use
- R2 bindings (`[[r2_buckets]]`): Ensure they are correctly configured directly under the `[env.production]` and `[env.development]` blocks.

### 5. Deploy

```bash
# Development environment
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
