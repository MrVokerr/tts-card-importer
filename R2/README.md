# TTS Card Metadata CDN (R2)

Static JSON metadata used by [Card Importer](../Card%20Importer.lua) at runtime. This folder documents the contract, provides build tooling to reproduce the shard layout, and explains how to mirror or extend the index.

**Reference host (Vokerr):** `https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev`

No Scryfall API calls at play time. Card **images** for normal printings come from a separate image CDN (`img.klrmngr.com` in the default importer); this package is **metadata only**.

---

## Documentation

| Doc | Contents |
|-----|----------|
| [METADATA.md](METADATA.md) | Full HTTP paths, shard key algorithms, JSON record shapes |
| [MIRROR.md](MIRROR.md) | Clone the public bucket or rebuild and host your own |
| [ADVANCED.md](ADVANCED.md) | Superset records, advanced metadata API, optional Worker |
| [worker/README.md](worker/README.md) | Example Cloudflare Worker (`/v1/cards/{uuid}`) |

---

## Quick start

```bash
cd R2
npm run verify          # check shard keys against live public CDN
npm run build:fetch     # download Scryfall bulk + build seed index → dist/
npm run build:tokens    # token shards (requires data/default-cards.json)
```

Copy `config/seeds.example.json` → `config/seeds.json` to customize seed-mode builds.

Output lands in `dist/index/**` — upload that tree to your own R2 bucket (see [MIRROR.md](MIRROR.md)).

---

## Layout

```
R2/
  lib/           Shard key + Scryfall mapping (must match Card Importer.lua)
  scripts/       build-index.js, build-token-index.js, verify.js
  schema/        JSON Schema + examples
  config/        seeds.example.json
  worker/        Optional REST facade over shards
  dist/          Build output (gitignored)
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
