# TTS Card Metadata CDN (R2)

Static JSON metadata used by [Card Importer](../Card%20Importer.lua) at runtime. This folder documents the contract, provides build tooling to reproduce the shard layout, and explains how to mirror or extend the index.

**Reference host (Vokerr):** `https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev`

No Scryfall API calls at **play time**. Card **images** for normal printings come from a separate image CDN (`img.klrmngr.com` in the default importer); this package is **metadata only**.

Players never download Scryfall bulk files — only small CDN shards. Bulk JSONL is used only on CI/dev runners to rebuild the online index.

---

## Documentation

| Doc | Contents |
|-----|----------|
| [METADATA.md](METADATA.md) | Full HTTP paths, shard key algorithms, JSON record shapes |
| [MIRROR.md](MIRROR.md) | Clone the public bucket or host your own |
| [ADVANCED.md](ADVANCED.md) | Superset records, advanced metadata API, optional Worker |
| [worker/README.md](worker/README.md) | Example Cloudflare Worker (`/v1/cards/{uuid}`) |

---

## Scryfall bulk format (JSONL.gz)

As of Scryfall’s **2026-07-20** change, array JSON bulk is retired. All fetch paths use `jsonl_download_uri` (`.jsonl.gz`) via `lib/fetch-bulk.js`.

```bash
cd R2
npm install
npm run verify                 # check shard keys against live public CDN
npm run build:fetch            # JSONL → seed card index → dist/
npm run build:tokens           # JSONL → token shards + token card records → dist/
npm run sync:tokens:dry        # build + sanity gates, no R2 write
npm run sync:tokens            # build + publish + smoke
npm run cache:token-images:dry # auto-discover recent token sets; list Kai-missing JPGs (no R2 write)
npm run cache:token-images     # download large.jpg → R2 /cards/{uuid}.jpg + kaiMissUuids
```

### Token image policy

Daily **R2 token sync** auto-discovers non-digital Scryfall **token** sets released within **30 days back / 120 days ahead**, unions optional `image_sets` workflow extras, and caches Kai-missing single-faced token/emblem JPEGs to `cards/{uuid}.jpg`.

- Caps: max 40 discovered sets and 2000 candidate cards per run (fail-closed).
- Upload only after JPEG MIME + magic bytes + minimum size checks; public CDN must return `200 image/jpeg` before a UUID is added to routing.
- Merged `token-cdn-defaults.json` is published only after every eligible image succeeds (no half-published routing).
- Double-faced tokens are **not** R2-fallbackable in Card Importer 6.6 — the job verifies a Kai-backed two-sided canonical printing exists and fails with an actionable message otherwise.
- Existing `kaiMissUuids` / `r2FallbackUuids` are preserved across rebuilds via `unionUuidLists`.

```bash
# Auto-discovery only
npm run cache:token-images

# Union manual extras (e.g. re-audit an older set)
npm run cache:token-images -- --sets=thob

# Manual-only (skip discovery)
npm run cache:token-images -- --no-auto --sets=tfra,tfrc,tfdc
```

Copy `config/seeds.example.json` → `config/seeds.json` to customize seed-mode builds.

Output lands in `dist/index/**` (gitignored). Do not publish the bulk `.jsonl.gz` to the public bucket.

---

## Layout

```
R2/
  lib/           Shard keys, Scryfall mapping, fetch-bulk (JSONL), sync guards
  scripts/       build-index, build-token-index, sync-tokens, publish-r2, verify
  schema/        JSON Schema + examples
  config/        seeds.example.json
  worker/        Optional REST facade over shards
  dist/          Build output (gitignored)
  data/          Ephemeral bulk downloads (gitignored)
```

---

## Point Card Importer at your mirror

In `Card Importer.lua`:

```lua
local METADATA_CDN='https://your-bucket.example.com'
```

See [MIRROR.md](MIRROR.md) for image CDN notes.

---

## License

Same as parent repo (MIT). Magic: The Gathering is a trademark of Wizards of the Coast. Card data derived from [Scryfall](https://scryfall.com) bulk data at **build time** only.
