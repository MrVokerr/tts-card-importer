#!/usr/bin/env node
/**
 * Verify shard key algorithms and token canaries against the public metadata CDN.
 */
import { parentNameShardKey, tokenShardKey } from '../lib/shard-keys.js';
import { normalizeIndexName } from '../lib/normalize.js';

const DEFAULT_BASE = 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev';

function parseArgs(argv) {
  let base = DEFAULT_BASE;
  for (const arg of argv) {
    if (arg.startsWith('--base-url=')) base = arg.slice('--base-url='.length).replace(/\/$/, '');
  }
  return { base };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { base } = parseArgs(process.argv.slice(2));
  console.log(`Verifying against ${base}`);

  const manifest = await fetchJson(`${base}/index/card-index.json`);
  assert(manifest.version >= 2, 'manifest.version should be >= 2');
  assert(manifest.shardUrls?.record, 'manifest.shardUrls.record missing');
  console.log(`Manifest v${manifest.version}, mode=${manifest.mode}, entries=${manifest.stats?.entries}`);

  const nameKey = parentNameShardKey('Lightning Bolt');
  assert(nameKey === '3a', `Lightning Bolt name shard expected 3a, got ${nameKey}`);

  const norm = normalizeIndexName('Lightning Bolt');
  const nameShard = await fetchJson(`${base}/index/cards/names-by-name/shards/${nameKey}.json`);
  assert(Array.isArray(nameShard[norm]) && nameShard[norm].length > 0, 'lightning bolt missing in name shard');

  const uuid = nameShard[norm][0];
  const rKey = tokenShardKey(uuid);
  const recordShard = await fetchJson(`${base}/index/cards/shards/${rKey}.json`);
  const rec = recordShard[uuid];
  assert(rec?.name === 'Lightning Bolt', 'record name mismatch');
  assert(rec?.oracle_text, 'record missing oracle_text');

  const defaults = await fetchJson(`${base}/index/token-cdn-defaults.json`);
  assert(defaults.byName?.treasure, 'token defaults missing treasure');

  // Token canary: Treasure default UUID should resolve as a token-like record when present in card shards
  const treasureId = defaults.byName.treasure;
  if (treasureId) {
    const tShard = await fetchJson(`${base}/index/cards/shards/${tokenShardKey(treasureId)}.json`);
    // After token sync, treasure should exist; before first sync, may be absent — warn only
    if (!tShard[treasureId]) {
      console.warn('WARN: treasure UUID not in card shard yet (run token sync to upsert token records)');
    } else {
      console.log('Token canary: treasure card record present');
    }
  }

  // Optional sync-state
  try {
    const state = await fetchJson(`${base}/index/token-sync-state.json`);
    console.log(
      `token-sync-state: builtAt=${state.builtAt} bulkUpdatedAt=${state.bulkUpdatedAt} oracleKeys=${state.counts?.oracleKeyCount}`
    );
  } catch {
    console.warn('WARN: token-sync-state.json not published yet');
  }

  // DFC token canary when defaults include Incubator
  const incubatorId =
    defaults.byName?.['incubator // phyrexian'] || defaults.byName?.incubator;
  if (incubatorId) {
    const iShard = await fetchJson(`${base}/index/cards/shards/${tokenShardKey(incubatorId)}.json`);
    const iRec = iShard[incubatorId];
    if (iRec?.card_faces?.length >= 2) {
      console.log('DFC canary: Incubator card_faces OK');
    } else if (iRec) {
      console.warn('WARN: Incubator record present but card_faces incomplete');
    } else {
      console.warn('WARN: Incubator UUID not in card shard yet');
    }
  }

  console.log('OK — shard keys and sample records match live CDN');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
