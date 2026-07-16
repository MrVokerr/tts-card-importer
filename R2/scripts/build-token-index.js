#!/usr/bin/env node
/**
 * Build token metadata shards from Scryfall bulk (all_parts, token layouts).
 * Prefers JSONL.gz via --fetch. Also upserts token UUID records into card shards
 * so Card Importer ensureCardRecords can load DFC card_faces.
 *
 * Usage:
 *   node scripts/build-token-index.js [--fetch] [--input=path] [--out=path]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parentNameShardKey, tokenShardKey } from '../lib/shard-keys.js';
import { normalizeIndexName } from '../lib/normalize.js';
import { scryfallToIndexRecord, shouldIncludeCard } from '../lib/card-record.js';
import {
  writeTokenIndex,
  writeTokenCardRecords,
  writeTokenSyncState,
} from '../lib/write-shards.js';
import { countShardMapKeys } from '../lib/token-sync-guards.js';
import { ensureBulkFile, iterateBulkCards } from '../lib/fetch-bulk.js';
import { isTokenLike, partIsTokenOrEmblem } from '../lib/token-like.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    fetch: false,
    input: path.join(ROOT, 'data', 'default-cards.jsonl.gz'),
    out: path.join(ROOT, 'dist'),
    baseUrl: 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev',
    imageCdn: 'https://img.klrmngr.com',
    writeSyncState: true,
  };
  for (const arg of argv) {
    if (arg === '--fetch') opts.fetch = true;
    else if (arg.startsWith('--input=')) opts.input = arg.split('=')[1];
    else if (arg.startsWith('--out=')) opts.out = arg.split('=')[1];
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.split('=')[1];
    else if (arg.startsWith('--image-cdn=')) opts.imageCdn = arg.split('=')[1];
    else if (arg === '--no-sync-state') opts.writeSyncState = false;
  }
  if (!opts.fetch && !fs.existsSync(opts.input)) {
    const legacy = path.join(ROOT, 'data', 'default-cards.json');
    if (fs.existsSync(legacy)) opts.input = legacy;
  }
  return opts;
}

/**
 * Append a related-token entry. Dedupes by UUID and by normalized token name so
 * aggregating all_parts across every parent printing does not spawn every art.
 * When defaultsByName has a canonical UUID for that name, prefer it.
 */
function addToShard(shards, shardKey, mapKey, entry, defaultsByName) {
  if (!shards[shardKey]) shards[shardKey] = {};
  if (!shards[shardKey][mapKey]) shards[shardKey][mapKey] = [];
  const list = shards[shardKey][mapKey];
  const entryUuid = entry.uuid || entry;
  const entryNorm = normalizeIndexName(entry.name || '');
  const idx = list.findIndex((t) => {
    const u = t.uuid || t;
    if (u === entryUuid) return true;
    if (entryNorm && normalizeIndexName(t.name || '') === entryNorm) return true;
    return false;
  });
  if (idx >= 0) {
    const preferred = entryNorm && defaultsByName ? defaultsByName[entryNorm] : null;
    if (preferred && preferred === entryUuid) {
      const cur = list[idx].uuid || list[idx];
      if (cur !== preferred) list[idx] = entry;
    }
    return;
  }
  list.push(entry);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { path: bulkPath, meta } = await ensureBulkFile({
    fetch: opts.fetch || !fs.existsSync(opts.input),
    input: opts.input,
  });

  const parentShards = {};
  const oracleShards = {};
  const parentNameShards = {};
  const defaultsByName = {};
  const tokenRecords = new Map();
  let scanned = 0;
  let tokenLikeCount = 0;

  for await (const card of iterateBulkCards(bulkPath)) {
    scanned++;
    const tokenLike = isTokenLike(card);
    if (!shouldIncludeCard(card) && !tokenLike) continue;

    if (tokenLike) {
      tokenLikeCount++;
      const norm = normalizeIndexName(card.name);
      if (norm && !defaultsByName[norm]) defaultsByName[norm] = card.id;
      if (!tokenRecords.has(card.id)) {
        tokenRecords.set(card.id, scryfallToIndexRecord(card));
      }
    }

    for (const part of card.all_parts || []) {
      if (!part.id) continue;
      if (!partIsTokenOrEmblem(part)) continue;

      const entry = {
        uuid: part.id,
        name: part.name || 'Token',
        type_line: part.type_line,
      };

      const pKey = tokenShardKey(card.id);
      addToShard(parentShards, pKey, card.id, entry, defaultsByName);

      if (card.oracle_id) {
        const oKey = tokenShardKey(card.oracle_id);
        addToShard(oracleShards, oKey, card.oracle_id, entry, defaultsByName);
      }

      const parentNorm = normalizeIndexName(card.name);
      if (parentNorm) {
        const nKey = parentNameShardKey(parentNorm);
        addToShard(parentNameShards, nKey, parentNorm, entry, defaultsByName);
      }
    }
  }

  if (scanned === 0) throw new Error('Bulk scan produced zero cards');
  if (tokenLikeCount === 0) throw new Error('No token-like cards found in bulk');

  const defaults = {
    generatedAt: new Date().toISOString(),
    imageCdn: opts.imageCdn,
    r2ImageCdn: opts.baseUrl,
    r2FallbackUuids: [],
    kaiMissUuids: [],
    byName: defaultsByName,
  };

  writeTokenIndex(opts.out, {
    parentByUuid: parentShards,
    oracleById: oracleShards,
    parentByName: parentNameShards,
    defaults,
  });

  const { shardKeys, entryCount } = writeTokenCardRecords(opts.out, tokenRecords);

  const counts = {
    oracleKeyCount: countShardMapKeys(oracleShards),
    parentKeyCount: countShardMapKeys(parentShards),
    nameKeyCount: countShardMapKeys(parentNameShards),
    tokenRecordCount: entryCount,
    defaultsCount: Object.keys(defaultsByName).length,
    tokenShardFileCount: Object.keys(parentShards).length,
    oracleShardFileCount: Object.keys(oracleShards).length,
    nameShardFileCount: Object.keys(parentNameShards).length,
    tokenCardShardFileCount: shardKeys.length,
  };

  const syncState = {
    builtAt: new Date().toISOString(),
    bulkUpdatedAt: meta?.updatedAt || null,
    jsonlUri: meta?.jsonlUri || null,
    bulkFormat: meta?.format || null,
    publicBaseUrl: opts.baseUrl,
    scanned,
    tokenLikeCount,
    counts,
  };

  if (opts.writeSyncState) {
    writeTokenSyncState(opts.out, syncState);
  }

  // Local summary for publish-r2 / sync-tokens
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(
    path.join(opts.out, 'token-build-summary.json'),
    JSON.stringify({ ...syncState, tokenCardShardKeys: shardKeys }, null, 2)
  );

  console.log(
    `Token index: parent shards ${counts.tokenShardFileCount}, oracle shards ${counts.oracleShardFileCount}, ` +
      `name shards ${counts.nameShardFileCount}, token records ${entryCount} across ${shardKeys.length} card shards`
  );
  console.log(
    `Counts: oracleKeys=${counts.oracleKeyCount} parentKeys=${counts.parentKeyCount} defaults=${counts.defaultsCount}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
