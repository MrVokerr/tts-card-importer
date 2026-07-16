#!/usr/bin/env node
/**
 * Trial: simulate Card Importer oracle-name token resolve for sample cards.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeIndexName } from '../lib/normalize.js';
import { parentNameShardKey, tokenShardKey } from '../lib/shard-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const defaults = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'dist', 'index', 'token-cdn-defaults.json'), 'utf8')
).byName;

function normalizeTokenLookupName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(/^a\s+/i, '').replace(/^an\s+/i, '').replace(/^\d+\s+/, '');
  s = s.replace(/^\d+\/\d+\s+/, '');
  for (const color of ['white', 'blue', 'black', 'red', 'green', 'colorless']) {
    if (s.toLowerCase().startsWith(color + ' ')) {
      s = s.replace(/^\S+\s+/, '');
      break;
    }
  }
  s = s
    .replace(/\s+creature\s*$/i, '')
    .replace(/\s+artifact\s*$/i, '')
    .replace(/\s+enchantment\s*$/i, '');
  s = s.replace(/\s+tokens?$/i, '').trim();
  return s;
}

function parseTokenNamesFromOracle(text) {
  const names = [];
  const seen = {};
  if (!text) return names;
  function add(raw) {
    const clean = normalizeTokenLookupName(raw);
    if (!clean) return;
    const key = normalizeIndexName(clean);
    if (/^create|whenever|^if |^at |for each|token you control/.test(key)) return;
    if (seen[key]) return;
    seen[key] = true;
    names.push(clean);
  }
  for (const sentence of (text + '.').split(/[.!?\n]+/)) {
    const lower = sentence.toLowerCase();
    if (!lower.includes('token') || lower.includes('token copy of')) continue;
    const m = sentence.match(/[Cc]reate(.*?[Tt]okens?)/);
    if (m && !m[1].toLowerCase().includes('token copy')) add(m[1]);
    for (const n of sentence.matchAll(/(\w[\w\-/\d\s]+)[Tt]oken/g)) {
      const nLower = n[1].toLowerCase();
      if (!nLower.includes('create') && nLower.trim() !== 'copy' && !nLower.includes('for each')) {
        add(n[1]);
      }
    }
  }
  return names;
}

function resolve(name) {
  const clean = normalizeTokenLookupName(name);
  const norm = normalizeIndexName(clean);
  if (defaults[norm]) return { parsedAs: clean, uuid: defaults[norm], via: 'exact:' + norm };
  let best = null;
  let bestLen = 0;
  for (const [key, uuid] of Object.entries(defaults)) {
    if (norm === key || (norm.includes(key) && key.length > bestLen)) {
      best = { parsedAs: clean, uuid, via: 'fuzzy:' + key };
      bestLen = key.length;
    }
  }
  return best || { parsedAs: clean, uuid: null, via: null };
}

function lookupNameIndex(cardName) {
  const norm = normalizeIndexName(cardName);
  const shardPath = path.join(
    ROOT,
    'dist',
    'index',
    'tokens',
    'parents-by-name',
    'shards',
    parentNameShardKey(norm) + '.json'
  );
  if (!fs.existsSync(shardPath)) return null;
  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  return shard[norm] || null;
}

const cards = [
  {
    name: 'In the Pale Moonlight',
    mana: '{3}{B}{B}',
    oracle: [
      '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)',
      'I — Each opponent sacrifices a nontoken creature of their choice.',
      'II — Investigate. (Create a Clue token. It\'s an artifact with "{2}, Sacrifice this token: Draw a card.")',
      'III — You may sacrifice an artifact or creature. If you do, create two 2/2 black Romulan creature tokens.',
    ].join('\n'),
  },
  {
    name: 'Captain James T. Kirk',
    mana: '{2}{R}',
    oracle: [
      'Whenever Captain Kirk enters or attacks, choose one. If you have no cards in hand, choose one or more instead.',
      '• Discard a card, then draw a card.',
      '• Create a 1/1 red Officer creature token.',
      '• Creatures you control get +1/+0 until end of turn.',
    ].join('\n'),
  },
  {
    name: 'An Unexpected Party',
    mana: '{2}{W}{W}',
    note: 'Adventure back face At the Door creates the tokens',
    oracle: [
      'As this enchantment enters, choose a creature type.',
      'Creatures you control of the chosen type get +2/+2.',
      'Create X 2/2 red Dwarf creature tokens. (Then exile this card. You may cast the enchantment later from exile.)',
    ].join('\n'),
  },
];

for (const c of cards) {
  const cdnRelated = lookupNameIndex(c.name);
  const parsed = parseTokenNamesFromOracle(c.oracle);
  const resolved = parsed.map(resolve);
  const wouldSpawn = resolved.filter((r) => r.uuid);
  const unresolved = resolved.filter((r) => !r.uuid).map((r) => r.parsedAs);
  console.log(
    JSON.stringify(
      {
        card: c.name,
        mana: c.mana,
        note: c.note || undefined,
        cdnParentByName: cdnRelated,
        oracleParsedNames: parsed,
        wouldSpawnFromOracleFallback: wouldSpawn,
        unresolvedTokenNames: unresolved,
      },
      null,
      2
    )
  );
  console.log('---');
}
