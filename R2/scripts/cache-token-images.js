#!/usr/bin/env node
/**
 * Cache Kai-missing token JPGs to R2 at cards/{uuid}.jpg and merge routing lists
 * into index/token-cdn-defaults.json (kaiMissUuids / r2FallbackUuids).
 *
 * Daily runs auto-discover non-digital Scryfall token sets in a bounded window
 * (30d back / 120d ahead), union optional --sets= extras, and fail-closed on
 * caps / upload / public verification. DFC tokens are not R2-fallbackable in
 * Card Importer 6.6 — the job verifies a Kai two-sided canonical exists.
 *
 * Env: R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_BASE_URL
 * Auth: CLOUDFLARE_API_TOKEN or R2_ACCESS_KEY_ID+R2_SECRET_ACCESS_KEY
 *
 * Usage:
 *   node scripts/cache-token-images.js [--sets=tfra,tfrc] [--no-auto] [--dry-run] [--force]
 *   node scripts/cache-token-images.js --delay-ms=2000
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { loadPreviousDefaults, unionUuidLists } from '../lib/image-routing.js';
import {
  LOOKAHEAD_DAYS,
  LOOKBACK_DAYS,
  MAX_CANDIDATE_CARDS,
  MAX_DISCOVERED_SETS,
  assertCandidateCardCap,
  assertValidJpegBuffer,
  dfcNoKaiCanonicalMessage,
  parseSetCodes,
  partitionTokenImageCards,
  resolveDiscoverySetCodes,
  unionSetCodes,
} from '../lib/token-image-discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_PUBLIC = 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev';
const KAI_CDN = 'https://img.klrmngr.com';
const SCRYFALL_UA = 'tts-card-importer-token-image-cache/1.1';
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULTS_CACHE_CONTROL = 'public, max-age=300';

function parseArgs(argv) {
  const opts = {
    sets: [],
    auto: true,
    dryRun: false,
    force: false,
    delayMs: 2000,
    imageCdn: KAI_CDN,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--no-auto') opts.auto = false;
    else if (arg === '--auto') opts.auto = true;
    else if (arg.startsWith('--sets=')) {
      opts.sets = parseSetCodes(arg.slice('--sets='.length));
    } else if (arg.startsWith('--delay-ms=')) {
      opts.delayMs = Math.max(0, Number(arg.split('=')[1]) || 0);
    } else if (arg.startsWith('--image-cdn=')) {
      opts.imageCdn = arg.split('=')[1];
    }
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

function scryfallLargeJpgUrl(uuid, face = 'front') {
  const id = uuid.toLowerCase();
  return `https://cards.scryfall.io/large/${face}/${id[0]}/${id[1]}/${id}.jpg`;
}

function kaiLargeJpgUrl(uuid, imageCdn, face = 'front') {
  const id = uuid.toLowerCase();
  const base = (imageCdn || KAI_CDN).replace(/\/$/, '');
  return `${base}/large/${face}/${id[0]}/${id[1]}/${id}.jpg`;
}

function r2CardKey(uuid) {
  return `cards/${uuid.toLowerCase()}.jpg`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': SCRYFALL_UA },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchScryfallSets() {
  const page = await fetchJson('https://api.scryfall.com/sets');
  return page.data || [];
}

async function searchSetCards(setCode) {
  const cards = [];
  let url =
    'https://api.scryfall.com/cards/search?' +
    new URLSearchParams({
      q: `e:${setCode}`,
      unique: 'prints',
      order: 'set',
      include_extras: 'true',
    }).toString();
  while (url) {
    const page = await fetchJson(url);
    cards.push(...(page.data || []));
    url = page.next_page || null;
    if (url) await sleep(100);
  }
  return cards;
}

/**
 * Probe URL; prefer HEAD then GET. Returns { status, contentType }.
 */
async function probeUrl(url, method = 'HEAD') {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': SCRYFALL_UA },
      redirect: 'follow',
    });
    return {
      status: res.status,
      contentType: (res.headers.get('content-type') || '').toLowerCase(),
    };
  } catch {
    return { status: 0, contentType: '' };
  }
}

async function probeImage(url) {
  let probe = await probeUrl(url, 'HEAD');
  if (probe.status === 0 || probe.status === 403 || probe.status === 405) {
    probe = await probeUrl(url, 'GET');
  }
  return probe;
}

function isOkJpegProbe(probe) {
  if (!probe || probe.status !== 200) return false;
  const ctype = probe.contentType || '';
  if (!ctype) return true; // some CDNs omit type on HEAD
  return ctype.includes('jpeg') || ctype.includes('jpg') || ctype.includes('octet-stream');
}

async function downloadJpg(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': SCRYFALL_UA },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Download ${url} → ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || '';
  assertValidJpegBuffer(buf, ctype);
  return buf;
}

function createUploader() {
  const accountId = requireEnv('R2_ACCOUNT_ID');
  const bucket = requireEnv('R2_BUCKET');
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
  const cfToken = process.env.CLOUDFLARE_API_TOKEN || '';
  const useS3 = Boolean(accessKeyId && secretAccessKey);
  const useCfRest = Boolean(cfToken);

  if (!useS3 && !useCfRest) {
    throw new Error(
      'Missing R2 auth: set R2_ACCESS_KEY_ID+R2_SECRET_ACCESS_KEY or CLOUDFLARE_API_TOKEN'
    );
  }

  if (useS3) {
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    return {
      mode: 's3',
      async exists(key) {
        try {
          await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return true;
        } catch (err) {
          const status = err?.$metadata?.httpStatusCode || err?.name;
          if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
            return false;
          }
          return null;
        }
      },
      async put(key, body, contentType, cacheControl) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            CacheControl: cacheControl,
          })
        );
      },
    };
  }

  return {
    mode: 'cf-rest',
    async exists(key) {
      const url =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
        `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${cfToken}` },
      });
      if (res.status === 404) return false;
      if (res.ok) return true;
      return null;
    },
    async put(key, body, contentType, cacheControl) {
      const url =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
        `/r2/buckets/${encodeURIComponent(bucket)}/objects/${key
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`CF REST PUT ${key} → ${res.status}: ${text.slice(0, 300)}`);
      }
    },
  };
}

async function publicImageOk(publicBase, key) {
  const url = `${publicBase.replace(/\/$/, '')}/${key}`;
  return isOkJpegProbe(await probeImage(url));
}

async function kaiFaceOk(uuid, imageCdn, face) {
  return isOkJpegProbe(await probeImage(kaiLargeJpgUrl(uuid, imageCdn, face)));
}

async function kaiHasFront(uuid, imageCdn) {
  return kaiFaceOk(uuid, imageCdn, 'front');
}

async function kaiHasTwoSided(uuid, imageCdn) {
  const front = await kaiFaceOk(uuid, imageCdn, 'front');
  if (!front) return false;
  const back = await kaiFaceOk(uuid, imageCdn, 'back');
  return back;
}

/**
 * Find any Kai two-sided printing for this DFC (self, defaults, or Scryfall siblings).
 */
async function findKaiBackedDfcCanonical(card, previousDefaults, imageCdn) {
  const checked = [];
  const tryUuid = async (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase();
    if (!id || checked.includes(id)) return null;
    checked.push(id);
    if (await kaiHasTwoSided(id, imageCdn)) return id;
    return null;
  };

  const self = await tryUuid(card.id);
  if (self) return { uuid: self, checked };

  const byName = previousDefaults?.byName || {};
  const nameKey = typeof card.name === 'string' ? card.name.toLowerCase() : '';
  if (nameKey && byName[nameKey]) {
    const hit = await tryUuid(byName[nameKey]);
    if (hit) return { uuid: hit, checked };
  }
  // Face-name fallback (e.g. defaults keyed as "incubator")
  const frontName = card.card_faces?.[0]?.name;
  if (frontName) {
    const faceKey = String(frontName).toLowerCase();
    if (byName[faceKey]) {
      const hit = await tryUuid(byName[faceKey]);
      if (hit) return { uuid: hit, checked };
    }
  }

  if (card.oracle_id) {
    try {
      const url =
        'https://api.scryfall.com/cards/search?' +
        new URLSearchParams({
          q: `oracleid:${card.oracle_id}`,
          unique: 'prints',
          include_extras: 'true',
        }).toString();
      const page = await fetchJson(url);
      for (const sibling of page.data || []) {
        if (sibling.layout !== 'double_faced_token' && sibling.layout !== card.layout) continue;
        const hit = await tryUuid(sibling.id);
        if (hit) return { uuid: hit, checked };
        await sleep(50);
      }
    } catch (err) {
      console.warn(`DFC sibling search failed for ${card.name}: ${err.message}`);
    }
  }

  return { uuid: null, checked };
}

async function resolveSetCodes(opts) {
  const manual = opts.sets || [];
  if (!opts.auto) {
    if (manual.length === 0) {
      throw new Error('No set codes: pass --sets=... or omit --no-auto for discovery');
    }
    return { auto: [], manual, sets: unionSetCodes(manual) };
  }
  console.log(
    `Discovering token sets (${LOOKBACK_DAYS}d back / ${LOOKAHEAD_DAYS}d ahead, cap ${MAX_DISCOVERED_SETS})...`
  );
  const scryfallSets = await fetchScryfallSets();
  const resolved = resolveDiscoverySetCodes(scryfallSets, manual, {
    maxDiscoveredSets: MAX_DISCOVERED_SETS,
  });
  console.log(
    `Discovery: auto=[${resolved.auto.join(',') || '(none)'}] manual=[${resolved.manual.join(',') || '(none)'}]`
  );
  if (resolved.sets.length === 0) {
    console.log('No token sets in window and no manual extras — nothing to cache');
  }
  return resolved;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC).replace(/\/$/, '');

  const resolved = await resolveSetCodes(opts);
  console.log(
    `Token image cache sets=[${resolved.sets.join(',') || '(none)'}] auto=${opts.auto} dryRun=${opts.dryRun} force=${opts.force}`
  );
  console.log(`Public base: ${publicBase}`);

  if (resolved.sets.length === 0) {
    console.log('Done. uploaded=0 downloaded=0 (empty set list)');
    return;
  }

  const cards = [];
  for (const setCode of resolved.sets) {
    console.log(`Fetching Scryfall set ${setCode}...`);
    try {
      const setCards = await searchSetCards(setCode);
      cards.push(...setCards);
    } catch (err) {
      // Empty / unknown set codes from manual extras should fail closed
      throw new Error(`Scryfall search for set ${setCode} failed: ${err.message}`);
    }
    await sleep(Math.min(opts.delayMs, 200));
  }

  const { singleFaced, doubleFaced, skipped } = partitionTokenImageCards(cards);
  assertCandidateCardCap(singleFaced.length + doubleFaced.length, MAX_CANDIDATE_CARDS);
  console.log(
    `Partition: singleFaced=${singleFaced.length} dfc=${doubleFaced.length} skipped=${skipped} raw=${cards.length}`
  );

  const defaultsUrl = `${publicBase}/index/token-cdn-defaults.json`;
  const previous = await loadPreviousDefaults(defaultsUrl);
  if (!previous || !previous.byName) {
    throw new Error(`Cannot load live token-cdn-defaults from ${defaultsUrl}`);
  }

  // DFC policy: never route via R2; require a Kai two-sided canonical
  for (const card of doubleFaced) {
    const label = `${card.set} ${card.collector_number} ${card.name}`;
    const { uuid: kaiUuid, checked } = await findKaiBackedDfcCanonical(
      card,
      previous,
      opts.imageCdn
    );
    if (!kaiUuid) {
      throw new Error(dfcNoKaiCanonicalMessage(card, checked));
    }
    console.log(`DFC OK ${label} → Kai canonical ${kaiUuid}`);
    await sleep(Math.min(opts.delayMs, 100));
  }

  const localDir = path.join(ROOT, 'dist', 'cards');
  fs.mkdirSync(localDir, { recursive: true });

  const uploader = opts.dryRun ? null : createUploader();
  if (uploader) console.log(`Upload auth: ${uploader.mode}`);

  const routingUuids = [];
  const failures = [];
  let uploaded = 0;
  let skippedExists = 0;
  let skippedKai = 0;
  let downloaded = 0;

  for (const card of singleFaced) {
    const uuid = card.id.toLowerCase();
    const key = r2CardKey(uuid);
    const label = `${card.set} ${card.collector_number} ${card.name}`;

    try {
      let existsPublic = await publicImageOk(publicBase, key);
      if (!existsPublic && uploader) {
        const authExists = await uploader.exists(key);
        if (authExists === true) {
          // Auth says present but public probe failed — re-check public (CDN lag)
          existsPublic = await publicImageOk(publicBase, key);
          if (!existsPublic && !opts.force) {
            // Object exists privately but public not image/jpeg yet — still try verify later path
            console.log(`WARN private-exists public-miss ${label} (${uuid}); will re-verify after`);
          }
        }
      }

      if (existsPublic && !opts.force) {
        console.log(`SKIP exists ${label} (${uuid})`);
        routingUuids.push(uuid);
        skippedExists++;
        continue;
      }

      const onKai = await kaiHasFront(uuid, opts.imageCdn);
      if (onKai && !opts.force) {
        console.log(`SKIP kai-ok ${label} (${uuid})`);
        skippedKai++;
        continue;
      }

      const src = scryfallLargeJpgUrl(uuid, 'front');
      console.log(`FETCH ${label} ← ${src}`);
      if (opts.dryRun) {
        // Dry-run: count as would-route but do not mutate live defaults
        routingUuids.push(uuid);
        downloaded++;
        await sleep(opts.delayMs);
        continue;
      }

      const body = await downloadJpg(src);
      const localPath = path.join(localDir, `${uuid}.jpg`);
      fs.writeFileSync(localPath, body);
      await uploader.put(key, body, 'image/jpeg', IMAGE_CACHE_CONTROL);
      console.log(`PUT ${key} (${body.length} bytes)`);

      // Fail-closed: never route until public CDN serves image/jpeg
      let verified = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (await publicImageOk(publicBase, key)) {
          verified = true;
          break;
        }
        await sleep(500 + attempt * 250);
      }
      if (!verified) {
        throw new Error(`Public verify failed for ${key} (expected 200 image/jpeg)`);
      }
      console.log(`VERIFY OK ${key}`);

      routingUuids.push(uuid);
      uploaded++;
      downloaded++;
      await sleep(opts.delayMs);
    } catch (err) {
      failures.push(`${label} (${uuid}): ${err.message}`);
      console.error(`FAIL ${label}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Fail-closed: ${failures.length} eligible token image(s) failed; ` +
        `defaults NOT published.\n` +
        failures.map((f) => `  - ${f}`).join('\n')
    );
  }

  const nextDefaults = {
    ...previous,
    generatedAt: new Date().toISOString(),
    imageCdn: previous.imageCdn || opts.imageCdn,
    r2ImageCdn: previous.r2ImageCdn || publicBase,
    kaiMissUuids: unionUuidLists(previous.kaiMissUuids, routingUuids),
    r2FallbackUuids: unionUuidLists(previous.r2FallbackUuids, routingUuids),
    byName: previous.byName,
  };

  const defaultsLocal = path.join(ROOT, 'dist', 'index', 'token-cdn-defaults.json');
  fs.mkdirSync(path.dirname(defaultsLocal), { recursive: true });
  fs.writeFileSync(defaultsLocal, JSON.stringify(nextDefaults));

  console.log(
    `Defaults: kaiMiss=${nextDefaults.kaiMissUuids.length} r2Fallback=${nextDefaults.r2FallbackUuids.length} routing+=${routingUuids.length}`
  );

  if (!opts.dryRun) {
    await uploader.put(
      'index/token-cdn-defaults.json',
      Buffer.from(JSON.stringify(nextDefaults), 'utf8'),
      'application/json; charset=utf-8',
      DEFAULTS_CACHE_CONTROL
    );
    console.log('Updated index/token-cdn-defaults.json');
  } else {
    console.log('Dry run — defaults written locally only, R2 unchanged');
  }

  // Smoke: Treasure (TFRA) and/or Axe (thob) when in routing
  const smokeIds = [
    '03992f88-7a15-4234-9bed-b7617d7ff09c', // Treasure TFRA
    '6f7a3999-e341-43bb-9b8f-6c1a05b98906', // Axe thob
  ];
  if (!opts.dryRun) {
    for (const id of smokeIds) {
      if (!nextDefaults.kaiMissUuids.includes(id) && !routingUuids.includes(id)) continue;
      const ok = await publicImageOk(publicBase, r2CardKey(id));
      if (!ok) {
        throw new Error(`Smoke failed: public ${r2CardKey(id)} not 200 image/jpeg`);
      }
      console.log(`Smoke OK: ${r2CardKey(id)}`);
    }
  }

  console.log(
    `Done. uploaded=${uploaded} downloaded=${downloaded} skipExists=${skippedExists} skipKai=${skippedKai} routing+=${routingUuids.length}`
  );
}

main().catch((err) => {
  console.error('TOKEN IMAGE CACHE FAILED:', err.message);
  process.exit(1);
});
