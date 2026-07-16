#!/usr/bin/env node
/**
 * Build card metadata shards from Scryfall default_cards bulk (JSONL.gz).
 * Usage: node scripts/build-index.js [--fetch] [--mode=seed|full] [--input=path] [--base-url=url]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  scryfallToIndexRecord,
  printingEntryFromCard,
  isPlayablePrinting,
  shouldIncludeCard,
} from '../lib/card-record.js';
import { normalizeIndexName } from '../lib/normalize.js';
import { writeCardIndex } from '../lib/write-shards.js';
import { ensureBulkFile, iterateBulkCards } from '../lib/fetch-bulk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'dist');
const DEFAULT_INPUT = path.join(ROOT, 'data', 'default-cards.jsonl.gz');

function parseArgs(argv) {
  const opts = {
    fetch: false,
    mode: 'seed',
    input: DEFAULT_INPUT,
    out: DEFAULT_OUT,
    baseUrl: 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev',
    includeAdvanced: false,
    seeds: path.join(ROOT, 'config', 'seeds.json'),
  };
  for (const arg of argv) {
    if (arg === '--fetch') opts.fetch = true;
    else if (arg.startsWith('--mode=')) opts.mode = arg.split('=')[1];
    else if (arg.startsWith('--input=')) opts.input = arg.split('=')[1];
    else if (arg.startsWith('--out=')) opts.out = arg.split('=')[1];
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.split('=')[1];
    else if (arg === '--include-advanced') opts.includeAdvanced = true;
    else if (arg.startsWith('--seeds=')) opts.seeds = arg.split('=')[1];
  }
  // Legacy default path: if only .json exists and no .jsonl.gz, allow it (pre-cutoff)
  if (!opts.fetch && !fs.existsSync(opts.input)) {
    const legacy = path.join(ROOT, 'data', 'default-cards.json');
    if (fs.existsSync(legacy)) opts.input = legacy;
  }
  return opts;
}

function loadSeedSet(opts) {
  const example = path.join(ROOT, 'config', 'seeds.example.json');
  const file = fs.existsSync(opts.seeds) ? opts.seeds : example;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = new Set((data.cardNames || []).map((n) => normalizeIndexName(n)));
  const sets = data.includeSets || [];
  return { names, sets: new Set(sets.map((s) => s.toLowerCase())), file };
}

function passesSeedFilter(card, seed) {
  if (seed.names.size === 0 && seed.sets.size === 0) return true;
  if (seed.names.has(normalizeIndexName(card.name))) return true;
  if (seed.sets.has((card.set || '').toLowerCase())) return true;
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { path: bulkPath } = await ensureBulkFile({
    fetch: opts.fetch,
    input: opts.input,
  });

  const seed = opts.mode === 'seed' ? loadSeedSet(opts) : null;
  if (seed) console.log(`Seed mode using ${seed.file}`);

  const records = new Map();
  const allByOracle = new Map();
  let scanned = 0;

  for await (const card of iterateBulkCards(bulkPath)) {
    scanned++;
    if (!shouldIncludeCard(card)) continue;
    if (opts.mode === 'seed' && !passesSeedFilter(card, seed)) continue;

    if (!records.has(card.id)) {
      records.set(card.id, scryfallToIndexRecord(card, { includeAdvanced: opts.includeAdvanced }));
    }

    if (!card.oracle_id) continue;
    if (!allByOracle.has(card.oracle_id)) allByOracle.set(card.oracle_id, []);
    const list = allByOracle.get(card.oracle_id);
    if (!list.some((p) => p.uuid === card.id) && isPlayablePrinting(card)) {
      list.push(printingEntryFromCard(card));
    }
  }

  if (scanned === 0) throw new Error('Bulk scan produced zero cards');

  console.log(
    `Scanned ${scanned} bulk rows; indexed ${records.size} cards, ${allByOracle.size} oracle printings groups`
  );
  const manifest = writeCardIndex(opts.out, records, allByOracle, {
    publicBaseUrl: opts.baseUrl,
    mode: opts.mode === 'seed' ? 'seed-only' : 'full',
  });
  console.log(
    `Wrote ${opts.out}/index/card-index.json (version ${manifest.version}, entries ${manifest.stats.entries})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
