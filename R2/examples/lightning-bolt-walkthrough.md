# Lightning Bolt lookup walkthrough

Example trace for `Importer Lightning Bolt` / `Importer text Lightning Bolt`.

## 1. Normalize name

```
"Lightning Bolt" → "lightning bolt"
```

## 2. Name shard key

djb2 hash → **`3a`**

```
GET /index/cards/names-by-name/shards/3a.json
```

Response snippet:

```json
{
  "lightning bolt": [
    "77c6fa74-5543-42ac-9ead-0e890b188e99",
    "b9399b98-a545-47b2-99bb-6d8251d9ae76"
  ]
}
```

First UUID wins for spawn: `77c6fa74-5543-42ac-9ead-0e890b188e99`

## 3. Record shard

```
shard = "77"  (first 2 chars of UUID)

GET /index/cards/shards/77.json
```

Record (see [schema/examples/lightning-bolt-record.json](../schema/examples/lightning-bolt-record.json)):

```json
{
  "name": "Lightning Bolt",
  "oracle_text": "Lightning Bolt deals 3 damage to any target.",
  "oracle_id": "4457ed35-7c10-48c8-9776-456485fdf070",
  "set": "clu",
  "collectorNumber": "141"
}
```

## 4. Image (separate from R2 metadata)

```
https://img.klrmngr.com/large/front/7/7/77c6fa74-5543-42ac-9ead-0e890b188e99.jpg
```

## 5. Printings (Importer print)

```
oracle shard key = "44"

GET /index/cards/printings-by-oracle/shards/44.json
→ printings["4457ed35-7c10-48c8-9776-456485fdf070"]
```

## Verify locally

```bash
npm run verify
```
