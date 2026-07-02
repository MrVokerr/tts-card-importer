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

## Option 2 — Rebuild from Scryfall bulk

```bash
cd R2
cp config/seeds.example.json config/seeds.json   # edit as needed
npm run build:fetch      # --mode=seed (default) or --mode=full
npm run build:tokens
```

Output: `dist/index/**`

Upload `dist/index` to your bucket root (paths must match [METADATA.md](METADATA.md)).

### Build flags

| Flag | Purpose |
|------|---------|
| `--fetch` | Download `default-cards.json` from Scryfall |
| `--mode=seed` | Use `config/seeds.json` name/set filters |
| `--mode=full` | All English non-digital paper cards |
| `--base-url=https://...` | Set `publicBaseUrl` in manifest |
| `--include-advanced` | Include prices, legalities, etc. in records |
| `--input=path` | Use existing bulk JSON |
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

## One-time upload (manual)

No upload automation ships in this repo. After building:

1. Cloudflare dashboard → R2 → Upload folder
2. Or `wrangler r2 object put` per file (see Cloudflare docs)

Do not commit API tokens or bucket credentials.
