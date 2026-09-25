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
import { normalizeIndexName } from '../lib/normalize.js';
import { unionUuidLists } from '../lib/image-routing.js';
import {
  LOOKAHEAD_DAYS,
  LOOKBACK_DAYS,
  MAX_CANDIDATE_CARDS,
  MAX_DISCOVERED_SETS,
  assertCandidateCardCap,
  assertValidJpegBuffer,
  dfcNoKaiCanonicalMessage,
  discoveryWindow,
  hasJpegMagic,
  isDoubleFacedToken,
  parseSetCodes,
  partitionTokenImageCards,
  releasedAtInWindow,
  resolveDiscoverySetCodes,
  selectTokenSetCodes,
  shouldSkipTokenImageCard,
  unionSetCodes,
} from '../lib/token-image-discovery.js';
import {
  applyTokenLinkOverrides,
  mergeTokenLinkOverrides,
  normalizeAndValidateTokenLinkOverrides,
  overrideToRelatedEntries,
} from '../lib/token-link-overrides.js';

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
  assert(parentNameShardKey('dáin ironfoot') === 'd1', 'dáin ironfoot shard key is d1 (UTF-16 code units)');
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

  const mergedUuids = unionUuidLists(
    ['AAAA-1111', 'bbbb-2222'],
    ['bbbb-2222', 'cccc-3333'],
    null,
    ['']
  );
  assert(
    mergedUuids.length === 3 &&
      mergedUuids[0] === 'aaaa-1111' &&
      mergedUuids.includes('bbbb-2222') &&
      mergedUuids.includes('cccc-3333'),
    'unionUuidLists lowercases, dedupes, and sorts'
  );

  // --- token-image-discovery ---
  assert(
    JSON.stringify(parseSetCodes(' TFRA, tfrc,,TFRA ')) === JSON.stringify(['tfra', 'tfrc']),
    'parseSetCodes lowercases and dedupes'
  );
  assert(
    JSON.stringify(unionSetCodes(['thob'], ['tfra', 'THOB'], null)) ===
      JSON.stringify(['tfra', 'thob']),
    'unionSetCodes sorts and dedupes'
  );

  const now = new Date('2026-09-24T12:00:00Z');
  const window = discoveryWindow(now, LOOKBACK_DAYS, LOOKAHEAD_DAYS);
  assert(
    releasedAtInWindow('2026-09-01', window) &&
      releasedAtInWindow('2026-10-02', window) &&
      !releasedAtInWindow('2026-01-01', window) &&
      !releasedAtInWindow('2027-06-01', window),
    `discovery window ${LOOKBACK_DAYS}d/${LOOKAHEAD_DAYS}d bounds`
  );

  const fakeSets = [
    { code: 'tfra', set_type: 'token', digital: false, released_at: '2026-10-02' },
    { code: 'tfrc', set_type: 'token', digital: false, released_at: '2026-10-02' },
    { code: 'tfdc', set_type: 'token', digital: false, released_at: '2026-10-02' },
    { code: 'thob', set_type: 'token', digital: false, released_at: '2023-11-03' }, // old
    { code: 'mtga', set_type: 'token', digital: true, released_at: '2026-10-02' },
    { code: 'blb', set_type: 'expansion', digital: false, released_at: '2026-10-02' },
  ];
  const selected = selectTokenSetCodes(fakeSets, { now });
  assert(
    selected.length === 3 &&
      selected.includes('tfra') &&
      selected.includes('tfrc') &&
      selected.includes('tfdc') &&
      !selected.includes('thob') &&
      !selected.includes('mtga'),
    'selectTokenSetCodes keeps non-digital token sets in window'
  );

  const resolved = resolveDiscoverySetCodes(fakeSets, ['thob', 'TFRA'], { now });
  assert(
    resolved.auto.length === 3 &&
      resolved.manual.includes('thob') &&
      resolved.sets.includes('thob') &&
      resolved.sets.includes('tfra'),
    'resolveDiscoverySetCodes unions manual extras with auto'
  );

  let capThrew = false;
  try {
    resolveDiscoverySetCodes(fakeSets, [], { now, maxDiscoveredSets: 2 });
  } catch (err) {
    capThrew = /exceeds cap 2/.test(err.message);
  }
  assert(capThrew, 'resolveDiscoverySetCodes fail-closed on set cap');

  capThrew = false;
  try {
    assertCandidateCardCap(MAX_CANDIDATE_CARDS + 1);
  } catch (err) {
    capThrew = /exceeds cap/.test(err.message);
  }
  assert(capThrew, 'assertCandidateCardCap fail-closed');
  assert(MAX_DISCOVERED_SETS >= 1 && MAX_CANDIDATE_CARDS >= 1, 'caps are positive');

  const jpegOk = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(1200, 1)]);
  assert(hasJpegMagic(jpegOk), 'hasJpegMagic detects FF D8 FF');
  assert(!hasJpegMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'hasJpegMagic rejects PNG');
  assertValidJpegBuffer(jpegOk, 'image/jpeg');
  let jpegThrew = false;
  try {
    assertValidJpegBuffer(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg');
  } catch {
    jpegThrew = true;
  }
  assert(jpegThrew, 'assertValidJpegBuffer rejects tiny payload');
  jpegThrew = false;
  try {
    assertValidJpegBuffer(Buffer.from([0x00, 0x01, ...Buffer.alloc(1200)]), 'image/jpeg');
  } catch {
    jpegThrew = true;
  }
  assert(jpegThrew, 'assertValidJpegBuffer rejects bad magic');

  assert(isDoubleFacedToken({ layout: 'double_faced_token', type_line: 'Token' }), 'DFC layout');
  assert(
    isDoubleFacedToken({
      layout: 'token',
      type_line: 'Token Artifact',
      card_faces: [{ name: 'A' }, { name: 'B' }],
    }),
    'DFC via card_faces + token-like'
  );
  assert(!isDoubleFacedToken({ layout: 'token', type_line: 'Token Artifact — Treasure' }), 'single-faced token');

  const parts = partitionTokenImageCards([
    {
      id: '11111111-1111-1111-1111-111111111111',
      layout: 'token',
      type_line: 'Token Artifact — Treasure',
      digital: false,
      set: 'tfra',
    },
    {
      id: '11111111-1111-1111-1111-111111111111', // dup
      layout: 'token',
      type_line: 'Token Artifact — Treasure',
      digital: false,
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      layout: 'double_faced_token',
      type_line: 'Token Artifact // Token Creature',
      digital: false,
      card_faces: [{ name: 'Incubator' }, { name: 'Phyrexian' }],
    },
    { id: '33333333-3333-3333-3333-333333333333', layout: 'art_series', type_line: 'Card', digital: false },
    { id: '44444444-4444-4444-4444-444444444444', layout: 'token', type_line: 'Token', digital: true },
  ]);
  assert(
    parts.singleFaced.length === 1 &&
      parts.doubleFaced.length === 1 &&
      parts.singleFaced[0].id.startsWith('1111') &&
      parts.doubleFaced[0].id.startsWith('2222'),
    'partitionTokenImageCards splits, dedupes, skips art/digital'
  );
  assert(shouldSkipTokenImageCard({ layout: 'normal', type_line: 'Creature' }), 'skip non-token');

  const dfcMsg = dfcNoKaiCanonicalMessage(
    {
      name: 'Incubator // Phyrexian',
      set: 'tfdc',
      collector_number: '8',
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
    ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']
  );
  assert(
    /6\.6 cannot use R2 DFC/.test(dfcMsg) && /tfdc #8/.test(dfcMsg),
    'dfcNoKaiCanonicalMessage is actionable'
  );

  // --- token-link-overrides (Wurmcoil same-name variants) ---
  const wurmcoilOracle = 'd1a60f44-7696-49ee-91fb-cab5b3102962';
  const wurmLife = 'a6ee0db9-ac89-4ab6-ac2e-8a7527d9ecbd';
  const wurmDeath = 'b68e816f-f9ac-435b-ad0b-ceedbe72447a';
  const wurmcoilParent = '5d275f04-cc60-4e3f-95cc-3d02bc916b82';
  const wurmcoilOverride = {
    [wurmcoilOracle]: {
      tokens: [
        { uuid: wurmLife, alias: 'Wurm — Lifelink', type_line: 'Token Artifact Creature — Wurm' },
        { uuid: wurmDeath, alias: 'Wurm — Deathtouch', type_line: 'Token Artifact Creature — Wurm' },
      ],
    },
  };
  const validatedOverride = normalizeAndValidateTokenLinkOverrides(wurmcoilOverride);
  assert(
    validatedOverride[wurmcoilOracle]?.tokens?.length === 2 &&
      validatedOverride[wurmcoilOracle].tokens[0].uuid === wurmLife &&
      validatedOverride[wurmcoilOracle].tokens[1].alias === 'Wurm — Deathtouch',
    'Wurmcoil override validates with distinct aliases'
  );

  let overrideThrew = false;
  try {
    normalizeAndValidateTokenLinkOverrides({
      [wurmcoilOracle]: {
        tokens: [
          { uuid: wurmLife, alias: 'Wurm — Lifelink' },
          { uuid: wurmDeath, alias: 'Wurm — Lifelink' },
        ],
      },
    });
  } catch (err) {
    overrideThrew = /duplicate alias/i.test(err.message);
  }
  assert(overrideThrew, 'tokenLinkOverrides fail-closed on duplicate aliases');

  overrideThrew = false;
  try {
    normalizeAndValidateTokenLinkOverrides({ 'not-a-uuid': { tokens: [{ uuid: wurmLife, alias: 'A' }] } });
  } catch (err) {
    overrideThrew = /invalid parent oracle/i.test(err.message);
  }
  assert(overrideThrew, 'tokenLinkOverrides fail-closed on malformed parent oracle UUID');

  const entries = overrideToRelatedEntries(validatedOverride[wurmcoilOracle], null);
  assert(
    entries.length === 2 &&
      entries[0].name === 'Wurm — Lifelink' &&
      entries[1].name === 'Wurm — Deathtouch' &&
      normalizeIndexName(entries[0].name) !== normalizeIndexName(entries[1].name),
    'override aliases stay distinct after normalize'
  );

  const oracleShards = {
    [tokenShardKey(wurmcoilOracle)]: {
      [wurmcoilOracle]: [{ uuid: wurmLife, name: 'Wurm' }],
    },
  };
  const parentShards = {
    [tokenShardKey(wurmcoilParent)]: {
      [wurmcoilParent]: [{ uuid: wurmLife, name: 'Wurm' }],
    },
  };
  const parentNameShards = {
    [parentNameShardKey('wurmcoil engine')]: {
      'wurmcoil engine': [{ uuid: wurmLife, name: 'Wurm' }],
    },
  };
  const tokenRecordsMap = new Map([
    [wurmLife, { name: 'Wurm', type_line: 'Token Artifact Creature — Wurm' }],
    [wurmDeath, { name: 'Wurm', type_line: 'Token Artifact Creature — Wurm' }],
  ]);
  const observedParents = new Map([
    [
      wurmcoilOracle,
      {
        parentUuids: new Set([wurmcoilParent]),
        parentNames: new Set(['wurmcoil engine']),
      },
    ],
  ]);
  const applyStats = applyTokenLinkOverrides({
    overrides: wurmcoilOverride,
    oracleShards,
    parentShards,
    parentNameShards,
    observedParents,
    tokenRecords: tokenRecordsMap,
  });
  assert(applyStats.applied === 1, 'applyTokenLinkOverrides applies Wurmcoil once');
  const oracleList = oracleShards[tokenShardKey(wurmcoilOracle)][wurmcoilOracle];
  const parentList = parentShards[tokenShardKey(wurmcoilParent)][wurmcoilParent];
  const nameList = parentNameShards[parentNameShardKey('wurmcoil engine')]['wurmcoil engine'];
  assert(
    oracleList.length === 2 &&
      parentList.length === 2 &&
      nameList.length === 2 &&
      oracleList.some((t) => t.uuid === wurmLife && t.name === 'Wurm — Lifelink') &&
      oracleList.some((t) => t.uuid === wurmDeath && t.name === 'Wurm — Deathtouch') &&
      parentList.some((t) => t.uuid === wurmDeath) &&
      nameList.some((t) => t.uuid === wurmLife),
    'Wurmcoil override replaces oracle/parent/name shards with both UUIDs'
  );

  overrideThrew = false;
  try {
    applyTokenLinkOverrides({
      overrides: wurmcoilOverride,
      oracleShards: {},
      parentShards: {},
      parentNameShards: {},
      observedParents: new Map(),
      tokenRecords: tokenRecordsMap,
    });
  } catch (err) {
    overrideThrew = /missing parent oracle|no parent printings/i.test(err.message);
  }
  assert(overrideThrew, 'applyTokenLinkOverrides fail-closed when parent oracle missing from bulk');

  const mergedOverrides = mergeTokenLinkOverrides(
    { [wurmcoilOracle]: { tokens: [{ uuid: wurmLife, alias: 'Old' }] } },
    wurmcoilOverride
  );
  assert(
    mergedOverrides[wurmcoilOracle].tokens.length === 2,
    'mergeTokenLinkOverrides later source wins'
  );

  fs.rmSync(out, { recursive: true, force: true });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
