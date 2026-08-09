#!/usr/bin/env node
/**
 * Cache Kai-missing token JPGs to R2 at cards/{uuid}.jpg and merge routing lists
 * into index/token-cdn-defaults.json (kaiMissUuids / r2FallbackUuids).
 *
 * Patterns borrowed from community R2 mirrors: skip-if-exists, Cache-Control,
 * Scryfall throttle, URI built by path pattern (large.jpg for TTS).
 *
 * Env: R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_BASE_URL
 * Auth: CLOUDFLARE_API_TOKEN or R2_ACCESS_KEY_ID+R2_SECRET_ACCESS_KEY
 *
 * Usage:
 *   node scripts/cache-token-images.js [--sets=thob] [--dry-run] [--force] [--delay-ms=2000]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { isTokenLike } from '../lib/token-like.js';
import { loadPreviousDefaults, unionUuidLists } from '../lib/image-routing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_PUBLIC = 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev';
const KAI_CDN = 'https://img.klrmngr.com';
const SCRYFALL_UA = 'tts-card-importer-token-image-cache/1.0';
const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULTS_CACHE_CONTROL = 'public, max-age=300';

function parseArgs(argv) {
  const opts = {
    sets: ['thob'],
    dryRun: false,
    force: false,
    delayMs: 2000,
    imageCdn: KAI_CDN,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg.startsWith('--sets=')) {
      opts.sets = arg
        .slice('--sets='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
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

function scryfallLargeJpgUrl(uuid) {
  const id = uuid.toLowerCase();
  return `https://cards.scryfall.io/large/front/${id[0]}/${id[1]}/${id}.jpg`;
}

function kaiLargeJpgUrl(uuid, imageCdn) {
  const id = uuid.toLowerCase();
  const base = (imageCdn || KAI_CDN).replace(/\/$/, '');
  return `${base}/large/front/${id[0]}/${id[1]}/${id}.jpg`;
}

function r2CardKey(uuid) {
  return `cards/${uuid.toLowerCase()}.jpg`;
}

function shouldSkipCard(card) {
  if (!card) return true;
  if (card.digital) return true;
  if (card.layout === 'art_series') return true;
  // MTGO-only promos / non-paper extras
  if (Array.isArray(card.games) && card.games.length === 1 && card.games[0] === 'mtgo') {
    return true;
  }
  if (!isTokenLike(card)) return true;
  return false;
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

async function searchSetCards(setCode) {
  const cards = [];
  let url =
    'https://api.scryfall.com/cards/search?' +
    new URLSearchParams({
      q: `e:${setCode}`,
      unique: 'prints',
      order: 'set',
    }).toString();
  while (url) {
    const page = await fetchJson(url);
    cards.push(...(page.data || []));
    url = page.next_page || null;
    if (url) await sleep(100);
  }
  return cards;
}

async function httpStatus(url, method = 'GET') {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': SCRYFALL_UA },
      redirect: 'follow',
    });
    // Some CDNs dislike HEAD; fall back handled by caller
    return res.status;
  } catch {
    return 0;
  }
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
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype && !ctype.includes('jpeg') && !ctype.includes('jpg') && !ctype.includes('octet-stream')) {
    throw new Error(`Expected JPEG from ${url}, got ${ctype}`);
  }
  if (buf.length < 1000) {
    throw new Error(`Suspiciously small image from ${url} (${buf.length} bytes)`);
  }
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
          // Fall through: treat unknown as missing and let public check decide
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

async function publicObjectExists(publicBase, key) {
  const url = `${publicBase.replace(/\/$/, '')}/${key}`;
  let status = await httpStatus(url, 'HEAD');
  if (status === 0 || status === 403 || status === 405) {
    status = await httpStatus(url, 'GET');
  }
  return status === 200;
}

async function kaiHasImage(uuid, imageCdn) {
  const url = kaiLargeJpgUrl(uuid, imageCdn);
  let status = await httpStatus(url, 'GET');
  return status === 200;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC).replace(/\/$/, '');

  console.log(`Token image cache sets=[${opts.sets.join(',')}] dryRun=${opts.dryRun} force=${opts.force}`);
  console.log(`Public base: ${publicBase}`);

  const cards = [];
  for (const setCode of opts.sets) {
    console.log(`Fetching Scryfall set ${setCode}...`);
    const setCards = await searchSetCards(setCode);
    cards.push(...setCards);
    await sleep(Math.min(opts.delayMs, 200));
  }

  const candidates = cards.filter((c) => c?.id && !shouldSkipCard(c));
  console.log(`Candidates after filters: ${candidates.length} / ${cards.length}`);

  const localDir = path.join(ROOT, 'dist', 'cards');
  fs.mkdirSync(localDir, { recursive: true });

  const uploader = opts.dryRun ? null : createUploader();
  if (uploader) console.log(`Upload auth: ${uploader.mode}`);

  const routingUuids = [];
  let uploaded = 0;
  let skippedExists = 0;
  let skippedKai = 0;
  let downloaded = 0;

  for (const card of candidates) {
    const uuid = card.id.toLowerCase();
    const key = r2CardKey(uuid);
    const label = `${card.set} ${card.collector_number} ${card.name}`;

    let exists = await publicObjectExists(publicBase, key);
    if (!exists && uploader) {
      const authExists = await uploader.exists(key);
      if (authExists === true) exists = true;
    }

    if (exists && !opts.force) {
      console.log(`SKIP exists ${label} (${uuid})`);
      routingUuids.push(uuid);
      skippedExists++;
      continue;
    }

    const onKai = await kaiHasImage(uuid, opts.imageCdn);
    if (onKai && !opts.force) {
      console.log(`SKIP kai-ok ${label} (${uuid})`);
      skippedKai++;
      continue;
    }

    const src = scryfallLargeJpgUrl(uuid);
    console.log(`FETCH ${label} ← ${src}`);
    if (opts.dryRun) {
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
    routingUuids.push(uuid);
    uploaded++;
    downloaded++;
    await sleep(opts.delayMs);
  }

  // Merge routing lists into token-cdn-defaults.json
  const defaultsUrl = `${publicBase}/index/token-cdn-defaults.json`;
  const previous = await loadPreviousDefaults(defaultsUrl);
  if (!previous || !previous.byName) {
    throw new Error(`Cannot load live token-cdn-defaults from ${defaultsUrl}`);
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
    `Defaults: kaiMiss=${nextDefaults.kaiMissUuids.length} r2Fallback=${nextDefaults.r2FallbackUuids.length}`
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

  // Smoke: Axe (thob/10) when present in routing or already on miss list
  const axe = '6f7a3999-e341-43bb-9b8f-6c1a05b98906';
  if (nextDefaults.kaiMissUuids.includes(axe) || routingUuids.includes(axe)) {
    if (!opts.dryRun) {
      const ok = await publicObjectExists(publicBase, r2CardKey(axe));
      if (!ok) {
        throw new Error(`Smoke failed: public ${r2CardKey(axe)} not 200`);
      }
      console.log(`Smoke OK: ${r2CardKey(axe)}`);
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
