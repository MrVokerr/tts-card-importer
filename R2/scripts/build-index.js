#!/usr/bin/env node
/**
 * Build card metadata shards from Scryfall default_cards bulk.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BULK_URL = 'https://data.scryfall.io/default-cards/default-cards.json';
const DEFAULT_OUT = path.join(ROOT, 'dist');

function parseArgs(argv) {
  const opts = {
    fetch: false,
    mode: 'seed',
    input: path.join(ROOT, 'data', 'default-cards.json'),
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
  return opts;
}

async function loadBulk(opts) {
  if (opts.fetch) {
    console.log('Downloading Scryfall bulk default_cards...');
    const res = await fetch(BULK_URL);
    if (!res.ok) throw new Error(`Bulk download failed: ${res.status}`);
    fs.mkdirSync(path.dirname(opts.input), { recursive: true });
    const text = await res.text();
    fs.writeFileSync(opts.input, text);
    console.log(`Saved ${opts.input}`);
  }
  if (!fs.existsSync(opts.input)) {
    throw new Error(`Missing bulk file: ${opts.input}. Run with --fetch or place default-cards.json in data/`);
  }
  console.log(`Reading ${opts.input}...`);
  return JSON.parse(fs.readFileSync(opts.input, 'utf8'));
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
  const bulk = await loadBulk(opts);
  const cards = bulk.data || bulk;
  const seed = opts.mode === 'seed' ? loadSeedSet(opts) : null;
  if (seed) console.log(`Seed mode using ${seed.file}`);

  const records = new Map();
  const allByOracle = new Map();

  for (const card of cards) {
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

  console.log(`Indexed ${records.size} cards, ${allByOracle.size} oracle printings groups`);
  const manifest = writeCardIndex(opts.out, records, allByOracle, {
    publicBaseUrl: opts.baseUrl,
    mode: opts.mode === 'seed' ? 'seed-only' : 'full',
  });
  console.log(`Wrote ${opts.out}/index/card-index.json (version ${manifest.version}, entries ${manifest.stats.entries})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
