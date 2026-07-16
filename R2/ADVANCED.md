# Advanced metadata endpoints

How to extend the metadata CDN or build a separate API on top of the same UUIDs.

---

## What TTS reads vs ignores

Card Importer only uses fields documented in [METADATA.md](METADATA.md). Extra keys on card records are **ignored** at spawn time — safe for backward-compatible extensions.

| Field category | TTS importer | Good for advanced API |
|----------------|-------------|------------------------|
| name, oracle_text, type_line, cmc | Yes | Yes |
| prices, legalities, rarity | No | Yes |
| game_changer, reserved, finishes | No | Yes |
| color_identity, keywords | No | Yes |

Build with `--include-advanced` to embed Scryfall market/format fields into shards for non-TTS consumers.

---

## Pattern A — Superset shards (same layout)

1. Run `npm run build:full -- --include-advanced`
2. Host on your R2 bucket (same paths)
3. TTS clients keep working; your tools read extra fields from the same JSON

No Worker required. Best when advanced consumers can fetch shard files directly.

---

## Pattern B — Separate advanced API

Keep the lean TTS index public; run your own service:

```
GET /v1/cards/{scryfall_uuid}
GET /v1/named?exact=Lightning+Bolt
```

Implementation sketch:

1. Load record shard from R2 (or cache) by UUID
2. Merge live Scryfall fields (prices, legalities) if needed
3. Return combined JSON

UUIDs in the index match Scryfall IDs — use them as the join key.

**Not included:** full `GET /cards/search?q=` — requires a search engine or Scryfall proxy.

---

## Pattern C — Example Worker (this repo)

See [worker/](worker/). Thin REST facade over R2 bindings:

- `GET /v1/cards/{uuid}` — record shard lookup
- `GET /v1/named?exact=...` — name shard → first UUID → record
- `GET /index/card-index.json` — passthrough manifest

Extend `worker/src/index.js` to add `prices`, `legalities`, etc. from your database or Scryfall at the edge.

---

## Scryfall at build time vs runtime

| Phase | Scryfall | This project |
|-------|----------|--------------|
| Build index | Bulk `default-cards` **JSONL.gz** (`jsonl_download_uri`) | `npm run build:fetch` / `build:tokens` via `lib/fetch-bulk.js` |
| Daily token sync | Same JSONL (CI ephemeral) | `npm run sync:tokens` → R2 |
| TTS play | Not called | R2 static JSON only |
| Advanced API | Optional live merge | Your choice |

Array JSON bulk is retired after **2026-07-20**. Respect [Scryfall API terms](https://scryfall.com/docs/api) when downloading bulk or calling live APIs.

---

## Friend / mirror operator checklist

1. Read [METADATA.md](METADATA.md) for the contract
2. Clone or rebuild index → [MIRROR.md](MIRROR.md)
3. Decide: superset shards (A) or separate API (B/C)
4. `npm run verify` against your host
5. Share your `publicBaseUrl` with table hosts

---

## Future work (out of scope)

- Full Scryfall search mirror (`q` syntax)
- Automatic price refresh pipeline
- Image CDN mirroring for `img.klrmngr.com`
