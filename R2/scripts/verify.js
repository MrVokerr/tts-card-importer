#!/usr/bin/env node
/**
 * Verify shard key algorithms against the live public metadata CDN.
 */
import { parentNameShardKey, tokenShardKey } from '../lib/shard-keys.js';
import { normalizeIndexName } from '../lib/normalize.js';

const DEFAULT_BASE = 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev';

function parseArgs(argv) {
  let base = DEFAULT_BASE;
  for (const arg of argv) {
    if (arg.startsWith('--base-url=')) base = arg.replace(/\/$/, '');
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

  console.log('OK — shard keys and sample records match live CDN');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
