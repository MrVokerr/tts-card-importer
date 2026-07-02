# Example metadata Worker

Optional Cloudflare Worker that exposes a small REST API over the same R2 shard files Card Importer reads directly.

**Note:** Tabletop Simulator uses static `WebGetSSL` on shard URLs. This Worker is for **tools, browsers, and advanced metadata** — not required for TTS spawn.

## Routes

| Route | Description |
|-------|-------------|
| `GET /index/card-index.json` | Manifest passthrough |
| `GET /v1/cards/{uuid}` | Single card record from shard |
| `GET /v1/named?exact=Lightning+Bolt` | Name lookup → first printing record |

## Setup

1. Create an R2 bucket and upload `dist/index/**` from a local build
2. Copy `wrangler.toml.example` → `wrangler.toml`
3. Set `bucket_name` and `PUBLIC_BASE_URL`
4. `npx wrangler deploy`

## Extending for advanced metadata

Edit `src/index.js` after loading `rec` from R2:

- Fetch `https://api.scryfall.com/cards/{uuid}` for live prices
- Merge into response: `{ ...rec, prices, legalities, game_changer }`
- TTS importer unaffected (uses R2 shards directly)

See [../ADVANCED.md](../ADVANCED.md).
