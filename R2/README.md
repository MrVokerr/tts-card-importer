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
| [MIRROR.md](MIRROR.md) | Clone the public bucket, daily token sync, R2 secrets |
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
npm run sync:tokens            # daily CI path: build + publish + smoke (needs R2 secrets)
```

Copy `config/seeds.example.json` → `config/seeds.json` to customize seed-mode builds.

Output lands in `dist/index/**` (gitignored). **Never** publish the bulk `.jsonl.gz` to the public bucket.

---

## Daily token sync (GitHub Actions)

Workflow: [`.github/workflows/r2-token-sync.yml`](../.github/workflows/r2-token-sync.yml)

- Runs daily (06:00 UTC) + manual `workflow_dispatch`
- Rebuilds token metadata from latest Scryfall JSONL
- Upserts token UUID records (including DFC `card_faces`) into card shards (merged with live R2)
- Fail-closed: skips publish if bulk unchanged; refuses publish on empty/regressed counts
- Does not change Card Importer.lua

Required GitHub secrets — see [MIRROR.md](MIRROR.md#daily-token-sync-secrets).

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
