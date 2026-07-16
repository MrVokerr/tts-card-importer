#!/usr/bin/env node
/**
 * Offline QA self-test for R2 token sync libs (no R2 credentials required).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { isTokenLike, partIsTokenOrEmblem } from '../lib/token-like.js';
import {
  assertTokenBuildSane,
  countShardMapKeys,
  DEFAULT_MIN_ORACLE_KEYS,
} from '../lib/token-sync-guards.js';
import { mergeShardRecords, writeTokenCardRecords } from '../lib/write-shards.js';
import { iterateBulkCards, JSON_ARRAY_RETIRE_DATE } from '../lib/fetch-bulk.js';
import { parentNameShardKey, tokenShardKey } from '../lib/shard-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'data', 'qa-fixture.jsonl.gz');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
    return;
  }
  passed++;
  console.log(`OK: ${msg}`);
}

function writeFixture() {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  const cards = [
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      oracle_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      name: 'Incubator // Phyrexian',
      type_line: 'Token Artifact — Incubator // Token Creature — Phyrexian',
      layout: 'double_faced_token',
      lang: 'en',
      digital: false,
      set: 'one',
      collector_number: '1',
      card_faces: [
        { name: 'Incubator', type_line: 'Token Artifact — Incubator', oracle_text: '{2}: Transform.' },
        { name: 'Phyrexian', type_line: 'Token Creature — Phyrexian', power: '0', toughness: '0' },
      ],
    },
    {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      oracle_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      name: 'Test Creature',
      type_line: 'Creature — Test',
      layout: 'normal',
      lang: 'en',
      digital: false,
      set: 'tst',
      collector_number: '2',
      oracle_text: 'Create a Treasure token.',
      all_parts: [
        {
          id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          name: 'Treasure',
          type_line: 'Token Artifact — Treasure',
        },
      ],
    },
    {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      oracle_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      name: 'Treasure',
      type_line: 'Token Artifact — Treasure',
      layout: 'token',
      lang: 'en',
      digital: false,
      set: 'tst',
      collector_number: 'T1',
    },
  ];
  const jsonl = cards.map((c) => JSON.stringify(c)).join('\n') + '\n';
  fs.writeFileSync(FIXTURE, zlib.gzipSync(jsonl));
}

async function main() {
  console.log('=== R2 QA self-test ===');

  assert(parentNameShardKey('Lightning Bolt') === '3a', 'Lightning Bolt shard key is 3a');
  assert(tokenShardKey('c5229eb0-9356-43a6-9b1b-6366f3c1e405') === 'c5', 'UUID shard key first 2 hex');

  assert(isTokenLike({ layout: 'double_faced_token', type_line: 'Token' }), 'DFC token layout detected');
  assert(isTokenLike({ layout: 'token', type_line: 'Token Artifact' }), 'token layout detected');
  assert(!isTokenLike({ layout: 'normal', type_line: 'Creature — Elf' }), 'normal creature not token-like');
  assert(partIsTokenOrEmblem({ type_line: 'Token Artifact — Treasure' }), 'all_parts token detected');
  assert(!partIsTokenOrEmblem({ type_line: 'Creature — Human' }), 'creature part not token');

  assert(
    countShardMapKeys({ a: { x: 1, y: 2 }, b: { z: 3 } }) === 3,
    'countShardMapKeys sums map keys'
  );

  const good = {
    oracleKeyCount: 2000,
    parentKeyCount: 3000,
    tokenRecordCount: 1000,
    defaultsCount: 500,
  };
  assert(assertTokenBuildSane(good, null) === true, 'sane build passes floor gates');

  let threw = false;
  try {
    assertTokenBuildSane({ ...good, oracleKeyCount: 10 }, null);
  } catch {
    threw = true;
  }
  assert(threw, `oracle floor ${DEFAULT_MIN_ORACLE_KEYS} rejects tiny builds`);

  threw = false;
  try {
    assertTokenBuildSane(good, { counts: { oracleKeyCount: 3000, parentKeyCount: 4000 } });
  } catch {
    threw = true;
  }
  assert(threw, 'regression >5% rejects publish');

  assert(
    JSON.stringify(mergeShardRecords({ a: 1, b: 2 }, { b: 9, c: 3 })) ===
      JSON.stringify({ a: 1, b: 9, c: 3 }),
    'mergeShardRecords prefers local overrides'
  );
  assert(
    JSON.stringify(mergeShardRecords(null, { a: 1 })) === JSON.stringify({ a: 1 }),
    'mergeShardRecords handles null remote'
  );

  writeFixture();
  const ids = [];
  for await (const card of iterateBulkCards(FIXTURE)) {
    ids.push(card.id);
  }
  assert(ids.length === 3, `JSONL fixture yields 3 cards (got ${ids.length})`);

  const out = path.join(ROOT, 'dist-qa');
  fs.rmSync(out, { recursive: true, force: true });
  const recs = new Map([
    [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      {
        name: 'Incubator // Phyrexian',
        layout: 'double_faced_token',
        card_faces: [{ name: 'Incubator' }, { name: 'Phyrexian' }],
      },
    ],
  ]);
  const { entryCount, shardKeys } = writeTokenCardRecords(out, recs);
  assert(entryCount === 1 && shardKeys.includes('aa'), 'writeTokenCardRecords writes shard aa');
  const shardPath = path.join(out, 'index', 'cards', 'shards', 'aa.json');
  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  assert(shard['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']?.card_faces?.length === 2, 'DFC faces persisted');

  // Merge into existing shard file
  writeTokenCardRecords(out, new Map([['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { name: 'Updated' }]]));
  const merged = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  assert(merged['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'].name === 'Updated', 'local shard merge updates record');

  assert(typeof JSON_ARRAY_RETIRE_DATE === 'string', `retire date constant set (${JSON_ARRAY_RETIRE_DATE})`);

  fs.rmSync(out, { recursive: true, force: true });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
