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
  assert(
    parentNameShardKey('dáin ironfoot') === 'd1',
    `dáin ironfoot name shard expected d1 (charCodeAt), got ${parentNameShardKey('dáin ironfoot')}`
  );

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

  // Hobbit token image canary: Dáin → Axe metadata + R2 JPG when listed in kaiMissUuids
  const dainId = '7112e460-9160-4535-ad94-93f1f4ac04cf';
  const axeId = defaults.byName?.axe || '6f7a3999-e341-43bb-9b8f-6c1a05b98906';
  try {
    const parentShard = await fetchJson(
      `${base}/index/tokens/shards/parent/${tokenShardKey(dainId)}.json`
    );
    const related = parentShard[dainId] || [];
    const hasAxe = related.some((t) => (t.uuid || t) === axeId);
    if (hasAxe) console.log('Token link canary: Dáin → Axe parent shard OK');
    else console.warn('WARN: Dáin parent shard missing Axe link');
  } catch (err) {
    console.warn(`WARN: Dáin parent shard check failed: ${err.message}`);
  }

  const kaiMiss = Array.isArray(defaults.kaiMissUuids) ? defaults.kaiMissUuids : [];
  const r2Fallback = Array.isArray(defaults.r2FallbackUuids) ? defaults.r2FallbackUuids : [];

  // Routing lists must stay consistent (same UUID membership)
  const missSet = new Set(kaiMiss.map((u) => String(u).toLowerCase()));
  const r2Set = new Set(r2Fallback.map((u) => String(u).toLowerCase()));
  const onlyMiss = [...missSet].filter((u) => !r2Set.has(u));
  const onlyR2 = [...r2Set].filter((u) => !missSet.has(u));
  assert(
    onlyMiss.length === 0 && onlyR2.length === 0,
    `kaiMissUuids / r2FallbackUuids mismatch: onlyMiss=${onlyMiss.slice(0, 5).join(',')} onlyR2=${onlyR2.slice(0, 5).join(',')}`
  );

  // HEAD (GET fallback) every routed fallback UUID — require 200 image/jpeg
  const routeIds = [...missSet];
  console.log(`Checking ${routeIds.length} R2 fallback image(s)...`);
  const imgUa = { headers: { 'User-Agent': 'tts-card-metadata-verify' } };
  for (const id of routeIds) {
    const imgUrl = `${base}/cards/${id}.jpg`;
    let imgRes = await fetch(imgUrl, { ...imgUa, method: 'HEAD' });
    if (imgRes.status === 0 || imgRes.status === 403 || imgRes.status === 405) {
      imgRes = await fetch(imgUrl, imgUa);
    }
    assert(imgRes.ok, `R2 fallback missing: ${imgUrl} → ${imgRes.status}`);
    const ctype = (imgRes.headers.get('content-type') || '').toLowerCase();
    assert(
      !ctype || ctype.includes('jpeg') || ctype.includes('jpg') || ctype.includes('octet-stream'),
      `R2 fallback bad content-type: ${imgUrl} → ${ctype || '(empty)'}`
    );
  }
  if (routeIds.length > 0) {
    console.log(`Token image routing: ${routeIds.length} public JPG(s) OK`);
  } else {
    console.log('Token image routing: no kaiMiss/r2Fallback UUIDs yet');
  }

  // Legacy canary log for Axe when present
  if (missSet.has(axeId)) {
    console.log('Token image canary: Axe included in routing list');
  }

  console.log('OK — shard keys and sample records match live CDN');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
