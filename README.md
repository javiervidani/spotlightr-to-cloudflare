# 🎬 Spotlightr → Cloudflare Stream Migration

Bulk-migrate videos from **Spotlightr** to **Cloudflare Stream** using Cloudflare's "copy from URL" API.

Reads a Spotlightr CSV export, extracts the original file URLs, and uploads each video to your Cloudflare account — with progress tracking and resume support.

## Features

- **CSV parsing** — reads the standard Spotlightr dashboard export  
- **Resume-safe** — saves progress after each video; re-run to continue  
- **Dry-run mode** — preview what will be migrated without making API calls  
- **Project filter** — migrate only a specific Spotlightr project  
- **Rate-limit aware** — configurable delay between API calls  
- **Skips deleted** — automatically skips videos marked as DELETED  

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/spotlightr-to-cloudflare.git
cd spotlightr-to-cloudflare

# 2. Install dependencies
npm install

# 3. Configure credentials
cp .env.example .env
# Edit .env with your Cloudflare API token and Account ID

# 4. Place your Spotlightr CSV export in the project root

# 5. Preview the migration
npm run dry-run

# 6. Run the migration
npm start
```

## Configuration (.env)

| Variable               | Description                          | Required |
|------------------------|--------------------------------------|----------|
| `CLOUDFLARE_API_TOKEN` | Your Cloudflare API bearer token     | ✅       |
| `CLOUDFLARE_ACCOUNT_ID`| Your Cloudflare account ID           | ✅       |
| `CSV_FILE`             | Path to the Spotlightr CSV export    | optional |
| `DELAY_MS`             | Delay between API calls (ms)         | optional |

## CLI Options

```bash
# Dry run — preview without uploading
node migrate.js --dry-run

# Filter by Spotlightr project ID
node migrate.js --project=52321

# Combine flags
node migrate.js --dry-run --project=54137
```

## How It Works

1. Parses the Spotlightr CSV export
2. Extracts the `original file URL` for each video
3. Skips videos with deleted source files
4. Sends each URL to Cloudflare's `/stream/copy` endpoint
5. Saves results to `migration-results.json` after each video
6. On re-run, skips already-migrated videos

## Output — `migration-results.json`

After migration, `migration-results.json` contains a record for each video:

```json
{
  "spotlightrId": "2000001",
  "name": "Welcome to the Course.mp4",
  "projectId": "10001",
  "sourceUrl": "https://example.com/backup/welcome-to-the-course.mp4",
  "cloudflareUid": "a1b2c3d4e5f6...",
  "success": true,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### How resume & retry works

- The script reads this file on every run and **skips** any video whose `spotlightrId` already has `"success": true`.
- **Failed uploads** are saved with `"success": false` and an `"error"` message explaining what went wrong.
- To **retry a failed video**:
  1. Fix the root cause (e.g. correct a broken source URL in the CSV).
  2. Delete that video's entry from `migration-results.json` (or remove the whole file to re-run everything).
  3. Run `npm start` again — only the missing/failed videos will be uploaded.

### Common failure causes

| Error | Cause | Fix |
|-------|-------|-----|
| `Bad Request` | Source URL is malformed or unreachable | Check/replace the `original file URL` in the CSV |
| `Unauthorized` | Invalid API token | Update `CLOUDFLARE_API_TOKEN` in `.env` |
| `Rate limited` | Too many requests | Increase `DELAY_MS` in `.env` |

## License

MIT
