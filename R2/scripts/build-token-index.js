#!/usr/bin/env node
/**
 * Build token metadata shards from Scryfall bulk (all_parts, token layouts).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parentNameShardKey, tokenShardKey } from '../lib/shard-keys.js';
import { normalizeIndexName } from '../lib/normalize.js';
import { scryfallToIndexRecord, shouldIncludeCard } from '../lib/card-record.js';
import { writeTokenIndex } from '../lib/write-shards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    input: path.join(ROOT, 'data', 'default-cards.json'),
    out: path.join(ROOT, 'dist'),
    baseUrl: 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev',
    imageCdn: 'https://img.klrmngr.com',
  };
  for (const arg of argv) {
    if (arg.startsWith('--input=')) opts.input = arg.split('=')[1];
    else if (arg.startsWith('--out=')) opts.out = arg.split('=')[1];
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.split('=')[1];
    else if (arg.startsWith('--image-cdn=')) opts.imageCdn = arg.split('=')[1];
  }
  return opts;
}

function isTokenLike(card) {
  const tl = card.type_line || '';
  const layout = card.layout || '';
  return layout === 'token' || layout === 'emblem' || tl.includes('Token') || tl.includes('Emblem');
}

function tokenEntry(card) {
  return {
    uuid: card.id,
    name: card.name || 'Token',
    type_line: card.type_line,
    oracle_id: card.oracle_id,
    oracle_text: card.oracle_text,
    power: card.power,
    toughness: card.toughness,
    loyalty: card.loyalty,
    cmc: card.cmc,
  };
}

function addToShard(shards, shardKey, mapKey, entry) {
  if (!shards[shardKey]) shards[shardKey] = {};
  if (!shards[shardKey][mapKey]) shards[shardKey][mapKey] = [];
  const list = shards[shardKey][mapKey];
  if (!list.some((t) => (t.uuid || t) === (entry.uuid || entry))) list.push(entry);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.input)) {
    throw new Error(`Missing ${opts.input}. Run build-index.js --fetch first.`);
  }
  const cards = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
  const list = cards.data || cards;

  const parentShards = {};
  const oracleShards = {};
  const parentNameShards = {};
  const defaultsByName = {};

  for (const card of list) {
    if (!shouldIncludeCard(card) && !isTokenLike(card)) continue;

    if (isTokenLike(card)) {
      const norm = normalizeIndexName(card.name);
      if (norm && !defaultsByName[norm]) defaultsByName[norm] = card.id;
    }

    for (const part of card.all_parts || []) {
      if (!part.id) continue;
      const partType = part.type_line || '';
      if (!partType.includes('Token') && !partType.includes('Emblem')) continue;

      const entry = {
        uuid: part.id,
        name: part.name || 'Token',
        type_line: part.type_line,
      };

      const pKey = tokenShardKey(card.id);
      addToShard(parentShards, pKey, card.id, entry);

      if (card.oracle_id) {
        const oKey = tokenShardKey(card.oracle_id);
        addToShard(oracleShards, oKey, card.oracle_id, entry);
      }

      const parentNorm = normalizeIndexName(card.name);
      if (parentNorm) {
        const nKey = parentNameShardKey(parentNorm);
        addToShard(parentNameShards, nKey, parentNorm, entry);
      }
    }
  }

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

  console.log(
    `Token index: parent shards ${Object.keys(parentShards).length}, oracle shards ${Object.keys(oracleShards).length}, name shards ${Object.keys(parentNameShards).length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
