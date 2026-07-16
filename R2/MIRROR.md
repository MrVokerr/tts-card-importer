# Mirroring the metadata CDN

Three ways to run your own copy compatible with Card Importer.

---

## Option 1 — Static clone (fastest)

Copy the public index tree from the reference host:

**Source:** `https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev`

**Minimum paths to copy:**

```
index/
  card-index.json
  token-cdn-defaults.json
  cards/shards/
  cards/names-by-name/shards/
  cards/set-collector/shards/
  cards/oracle-ids/shards/
  cards/printings-by-oracle/shards/
  tokens/shards/parent/
  tokens/shards/oracle/
  tokens/parents-by-name/shards/
ui/                    (optional — alt-art nav arrows)
cards/                 (optional — token image fallbacks)
```

### rclone (example)

Configure an R2 remote in `~/.config/rclone/rclone.conf`, then:

```bash
rclone copy r2:your-source-bucket/index ./mirror/index --progress
```

### AWS CLI with R2 S3 API

```bash
aws s3 sync s3://your-bucket/index ./mirror/index \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com
```

### Cloudflare dashboard

R2 → your bucket → upload `dist/index` folder after a local build (Option 2).

Enable **public access** (R2 custom domain or `r2.dev` subdomain) so TTS can `WebGetSSL` the JSON files.

---

## Option 2 — Rebuild from Scryfall bulk (JSONL.gz)

Scryfall retires array JSON bulk on **2026-07-20**. Builds use `jsonl_download_uri` (`.jsonl.gz`) streamed by `lib/fetch-bulk.js`. Bulk files stay in gitignored `data/` on the builder only — **never** host them on the public CDN.

```bash
cd R2
npm install
cp config/seeds.example.json config/seeds.json   # edit as needed
npm run build:fetch      # --mode=seed (default) or --mode=full
npm run build:tokens     # token shards + token UUID card records
```

Output: `dist/index/**`

Upload `dist/index` to your bucket root (paths must match [METADATA.md](METADATA.md)), or use the automated publisher below.

### Build flags

| Flag | Purpose |
|------|---------|
| `--fetch` | Download latest `default-cards` **JSONL.gz** from Scryfall |
| `--mode=seed` | Use `config/seeds.json` name/set filters |
| `--mode=full` | All English non-digital paper cards |
| `--base-url=https://...` | Set `publicBaseUrl` in manifest |
| `--include-advanced` | Include prices, legalities, etc. in records |
| `--input=path` | Use existing bulk `.jsonl.gz` (or legacy `.json` before cutoff) |
| `--out=path` | Output directory (default `dist`) |

---

## Option 3 — Point the TTS client

Edit [Card Importer.lua](../Card%20Importer.lua) near the top:

```lua
local METADATA_CDN='https://your-public-bucket.example.com'
```

Only change the origin — paths after that are identical (`/index/card-index.json`, etc.).

### Images

Default importer still uses Kai CDN for card faces:

```lua
local IMAGE_CDN='https://img.klrmngr.com'
```

To fully self-host images:

1. Mirror images separately, or use R2 `/cards/{uuid}.jpg` fallbacks for tokens
2. Set `IMAGE_CDN` to your image host, and/or
3. Set `imageCdn` on individual records / `token-cdn-defaults.json`

---

## Verify your mirror

```bash
npm run verify -- --base-url=https://your-bucket.example.com
```

Or against reference:

```bash
npm run verify
```

---

## Publishing checklist

- [ ] `GET /index/card-index.json` returns 200 with `version: 3`
- [ ] `publicBaseUrl` in manifest matches your public URL
- [ ] CORS not required (TTS uses server-side `WebGetSSL`)
- [ ] HTTPS enabled
- [ ] Run `npm run verify` against your base URL
- [ ] Update `METADATA_CDN` in your table's Card Importer script

---

## Daily token sync (automated)

GitHub Actions workflow [`.github/workflows/r2-token-sync.yml`](../.github/workflows/r2-token-sync.yml) rebuilds **token metadata only** once per day and publishes to R2.

```bash
# Local dry run (no credentials / no R2 writes)
npm run sync:tokens:dry

# Full sync (requires env secrets)
npm run sync:tokens
```

### Behavior / failsafes

- Skip publish when Scryfall `bulk.updated_at` matches remote `index/token-sync-state.json`
- Build entirely into local `dist/` before any R2 write
- Refuse publish if oracle/parent counts are empty or drop >5% vs previous sync-state
- Never delete the remote `index/tokens/` prefix first (overwrite keys only)
- Card shards: **merge** local token records into live R2 shards so seed card records are not wiped
- Write `index/token-sync-state.json` last
- Post-upload smoke check; failed job leaves last good index for clients

### Daily token sync (primary: local Windows task)

GitHub Actions schedule is **disabled** (manual `workflow_dispatch` only). Primary path:

1. Copy `R2/.env.example` → `R2/.env` and set `CLOUDFLARE_API_TOKEN` (or R2 S3 keys).
2. Register the task once:

```powershell
powershell -ExecutionPolicy Bypass -File "R2/scripts/install-token-sync-task.ps1"
```

3. Manual run:

```powershell
powershell -ExecutionPolicy Bypass -File "R2/scripts/sync-tokens-local.ps1" -Force
```

Logs: `R2/logs/token-sync-*.log`. The PC must be on around **23:00 local (Pacific)** ≈ 06:00 UTC.

Optional GitHub secrets (manual Actions backup only): `CLOUDFLARE_API_TOKEN`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`. Do not commit credentials.

---

## One-time upload (manual)

After a local build you can still upload without Actions:

1. Cloudflare dashboard → R2 → Upload `dist/index` folder
2. Or `npm run publish:r2` with the same env secrets as above

Do not commit API tokens or bucket credentials.
