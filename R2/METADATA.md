# Metadata CDN contract

Authoritative reference for the static JSON host consumed by Card Importer v6.0.

**Base URL:** `https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev` (replace with your mirror)

---

## Manifest

```
GET /index/card-index.json
```

Example:

```json
{
  "version": 3,
  "updatedAt": "2026-07-01T00:32:05.551Z",
  "publicBaseUrl": "https://your-public-base.example.com",
  "mode": "seed-only",
  "stats": { "entries": 4264, "nameEntries": 3193, "..." : "..." },
  "shardUrls": {
    "record": "index/cards/shards/{shard}.json",
    "name": "index/cards/names-by-name/shards/{shard}.json",
    "setCollector": "index/cards/set-collector/shards/{shard}.json",
    "oracleId": "index/cards/oracle-ids/shards/{shard}.json",
    "printings": "index/cards/printings-by-oracle/shards/{shard}.json"
  }
}
```

- **version 3** — shard-only manifest (embedded lookup tables in v1/v2 are ignored by current importer)
- **mode** — `seed-only` (curated subset) or `full` (complete build)
- **publicBaseUrl** — canonical public origin for this index (set correctly when publishing)

---

## Card shards

| Path | Key in shard file | Shard file `{shard}` |
|------|-------------------|----------------------|
| `/index/cards/shards/{shard}.json` | Scryfall UUID | First 2 hex chars of UUID, lowercased |
| `/index/cards/names-by-name/shards/{shard}.json` | Normalized card name | djb2 hash of name (see below) |
| `/index/cards/set-collector/shards/{shard}.json` | `set\|collector` | djb2 hash of `set\|collector` key |
| `/index/cards/oracle-ids/shards/{shard}.json` | Oracle UUID | First 2 hex chars of oracle_id |
| `/index/cards/printings-by-oracle/shards/{shard}.json` | Oracle UUID | First 2 hex chars of oracle_id |

### Shard key algorithms

**UUID / oracle_id shards** (`tokenShardKey` in Lua):

```
shard = uuid.substring(0, 2).toLowerCase()
```

**Name / set-collector shards** (`parentNameShardKey` in Lua):

1. Normalize: lowercase, trim, strip text after first newline
2. djb2: `h = 5381`; for each byte: `h = (h * 33 + byte) % 2^32`
3. `shard = sprintf("%02x", h % 256)`

**Verify:** `Lightning Bolt` → shard `3a`

### Name normalization

```
normalize(name) = lower(trim(first_line(name)))
```

---

## Card record shape

Each UUID maps to one object in a record shard:

| Field | Type | Used by TTS importer |
|-------|------|----------------------|
| `name` | string | Yes |
| `set` | string | Yes (nickname suffix) |
| `collectorNumber` | string | Yes |
| `oracle_id` | uuid string | Yes (memo, printings) |
| `type_line` | string | Yes |
| `cmc` | number | Yes |
| `lang` | string | Yes |
| `layout` | string | Yes |
| `oracle_text` | string | Yes (`Importer text`) |
| `power`, `toughness`, `loyalty` | string | Yes |
| `card_faces` | array | Yes (DFCs) |
| `relatedTokens` | array | Yes (token spawn) |
| `imageCdn` | url string | Optional image override |

**Not in base index:** `prices`, `legalities`, `game_changer`, `rarity`, `finishes` — mirrors may add these; importer ignores unknown fields.

See [schema/card-record.schema.json](schema/card-record.schema.json) and [schema/examples/](schema/examples/).

### Printings array entries

```json
{
  "uuid": "...",
  "name": "Lightning Bolt",
  "set": "mhm",
  "collector_number": "381",
  "collectorNumber": "381",
  "layout": "normal",
  "type_line": "Instant"
}
```

---

## Token metadata

| Path | Purpose |
|------|---------|
| `GET /index/token-cdn-defaults.json` | Default token UUIDs by normalized name, image CDN hints |
| `GET /index/tokens/shards/parent/{shard}.json` | Parent card UUID → `[{uuid, name, ...}]` |
| `GET /index/tokens/shards/oracle/{shard}.json` | Oracle ID → related tokens |
| `GET /index/tokens/parents-by-name/shards/{shard}.json` | Parent card name → related tokens |

`token-cdn-defaults.json` fields:

- `imageCdn` — primary image host for tokens
- `r2ImageCdn` — fallback image base (`/cards/{uuid}.jpg`)
- `byName` — map normalized token name → default UUID
- `r2FallbackUuids`, `kaiMissUuids` — per-UUID image routing overrides

---

## UI assets (optional for mirrors)

| Path | Purpose |
|------|---------|
| `/ui/left-65-64.png` | Alt-art preview prev arrow |
| `/ui/right-arrow-37-64.png` | Alt-art preview next arrow |
| `/cards/{uuid}.jpg` | Token image fallback on R2 |

---

## Lookup flows (client)

### Spawn by name

1. `GET .../names-by-name/shards/{hash(name)}.json`
2. Read `names[normalize(name)][0]` → UUID
3. `GET .../cards/shards/{uuid[0:2]}.json` → record
4. Image from Kai CDN or `imageCdn` / R2 fallback

### Spawn by set + collector

1. Key = `set|collector` (set lowercased, strip `_promo` suffix)
2. `GET .../set-collector/shards/{hash(key)}.json`

### Alternate printings

1. Resolve oracle_id from record
2. `GET .../printings-by-oracle/shards/{oracle[0:2]}.json`

---

## Not supported

- `api.scryfall.com` at runtime
- Scryfall search syntax (`t:creature`, `c:g`, `o:"..."`, etc.)
- Fuzzy `/cards/named` REST API (unless you add a Worker — see [ADVANCED.md](ADVANCED.md))

---

## JSON Schema

- [card-index.manifest.schema.json](schema/card-index.manifest.schema.json)
- [card-record.schema.json](schema/card-record.schema.json)
