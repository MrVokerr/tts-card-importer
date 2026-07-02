import fs from 'fs';
import path from 'path';
import { parentNameShardKey, tokenShardKey } from './shard-keys.js';
import { normalizeIndexName, setCollectorKey } from './normalize.js';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function shardStats(shards) {
  const keys = Object.keys(shards);
  let maxBytes = 0;
  for (const k of keys) {
    const bytes = Buffer.byteLength(JSON.stringify(shards[k]));
    if (bytes > maxBytes) maxBytes = bytes;
  }
  return { count: keys.length, maxKb: Math.ceil(maxBytes / 1024) };
}

/**
 * @param {string} outDir dist root (e.g. dist)
 * @param {Map<string, object>} records uuid -> record
 * @param {Map<string, object[]>} printingsByOracle oracle_id -> printing[]
 */
export function writeCardIndex(outDir, records, printingsByOracle, opts = {}) {
  const recordShards = {};
  const nameShards = {};
  const setColShards = {};
  const oracleShards = {};
  const printingShards = {};

  for (const [uuid, rec] of records) {
    const rKey = tokenShardKey(uuid);
    if (!recordShards[rKey]) recordShards[rKey] = {};
    recordShards[rKey][uuid] = rec;

    const norm = normalizeIndexName(rec.name);
    if (norm) {
      const nKey = parentNameShardKey(norm);
      if (!nameShards[nKey]) nameShards[nKey] = {};
      if (!nameShards[nKey][norm]) nameShards[nKey][norm] = [];
      if (!nameShards[nKey][norm].includes(uuid)) nameShards[nKey][norm].push(uuid);
    }

    if (rec.set && rec.collectorNumber != null) {
      const scKey = setCollectorKey(rec.set, rec.collectorNumber);
      const sKey = parentNameShardKey(scKey);
      if (!setColShards[sKey]) setColShards[sKey] = {};
      setColShards[sKey][scKey] = uuid;
    }

    if (rec.oracle_id) {
      const oKey = tokenShardKey(rec.oracle_id);
      if (!oracleShards[oKey]) oracleShards[oKey] = {};
      if (!oracleShards[oKey][rec.oracle_id]) oracleShards[oKey][rec.oracle_id] = [];
      if (!oracleShards[oKey][rec.oracle_id].includes(uuid)) {
        oracleShards[oKey][rec.oracle_id].push(uuid);
      }
    }
  }

  for (const [oracleId, printings] of printingsByOracle) {
    const pKey = tokenShardKey(oracleId);
    if (!printingShards[pKey]) printingShards[pKey] = {};
    printingShards[pKey][oracleId] = printings;
  }

  const base = path.join(outDir, 'index', 'cards');
  for (const [k, shard] of Object.entries(recordShards)) {
    writeJson(path.join(base, 'shards', `${k}.json`), shard);
  }
  for (const [k, shard] of Object.entries(nameShards)) {
    writeJson(path.join(base, 'names-by-name', 'shards', `${k}.json`), shard);
  }
  for (const [k, shard] of Object.entries(setColShards)) {
    writeJson(path.join(base, 'set-collector', 'shards', `${k}.json`), shard);
  }
  for (const [k, shard] of Object.entries(oracleShards)) {
    writeJson(path.join(base, 'oracle-ids', 'shards', `${k}.json`), shard);
  }
  for (const [k, shard] of Object.entries(printingShards)) {
    writeJson(path.join(base, 'printings-by-oracle', 'shards', `${k}.json`), shard);
  }

  let nameEntries = 0;
  for (const shard of Object.values(nameShards)) nameEntries += Object.keys(shard).length;

  const manifest = {
    version: 3,
    updatedAt: new Date().toISOString(),
    publicBaseUrl: opts.publicBaseUrl || 'https://your-bucket.example.com',
    mode: opts.mode || 'full',
    stats: {
      entries: records.size,
      recordShardCount: Object.keys(recordShards).length,
      recordShardMaxKb: shardStats(recordShards).maxKb,
      nameShardCount: Object.keys(nameShards).length,
      nameShardMaxKb: shardStats(nameShards).maxKb,
      setColShardCount: Object.keys(setColShards).length,
      setColShardMaxKb: shardStats(setColShards).maxKb,
      oracleShardCount: Object.keys(oracleShards).length,
      oracleShardMaxKb: shardStats(oracleShards).maxKb,
      nameEntries,
      setColEntries: records.size,
      oracleEntries: printingsByOracle.size,
    },
    shardUrls: {
      record: 'index/cards/shards/{shard}.json',
      name: 'index/cards/names-by-name/shards/{shard}.json',
      setCollector: 'index/cards/set-collector/shards/{shard}.json',
      oracleId: 'index/cards/oracle-ids/shards/{shard}.json',
      printings: 'index/cards/printings-by-oracle/shards/{shard}.json',
    },
  };

  writeJson(path.join(outDir, 'index', 'card-index.json'), manifest);
  return manifest;
}

/**
 * @param {string} outDir
 * @param {{ parentByUuid: Map, oracleById: Map, parentByName: Map, defaults: object }} tokenData
 */
export function writeTokenIndex(outDir, tokenData) {
  const base = path.join(outDir, 'index', 'tokens');
  for (const [k, shard] of Object.entries(tokenData.parentByUuid || {})) {
    writeJson(path.join(base, 'shards', 'parent', `${k}.json`), shard);
  }
  for (const [k, shard] of Object.entries(tokenData.oracleById || {})) {
    writeJson(path.join(base, 'shards', 'oracle', `${k}.json`), shard);
  }
  for (const [k, shard] of Object.entries(tokenData.parentByName || {})) {
    writeJson(path.join(base, 'parents-by-name', 'shards', `${k}.json`), shard);
  }
  writeJson(path.join(outDir, 'index', 'token-cdn-defaults.json'), tokenData.defaults);
}
