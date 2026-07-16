#!/usr/bin/env node
/**
 * Publish local dist/ token metadata to Cloudflare R2 (S3 API).
 * Fail-closed: never deletes remote token prefix first; refuses upload if sanity gates fail.
 *
 * Env:
 *   R2_ACCOUNT_ID, R2_BUCKET (required)
 *   R2_PUBLIC_BASE_URL (optional; for logging / shard merge)
 *   Auth (one of):
 *     R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY  — S3-compatible API
 *     CLOUDFLARE_API_TOKEN — Cloudflare REST R2 object API (wrangler OAuth works)
 *
 * Usage:
 *   node scripts/publish-r2.js [--out=dist] [--dry-run] [--skip-guards]
 *   node scripts/publish-r2.js --previous-state=url-or-path
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { assertTokenBuildSane } from '../lib/token-sync-guards.js';
import { mergeShardRecords } from '../lib/write-shards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function argValue(arg, prefix) {
  return arg.slice(prefix.length);
}

function parseArgs(argv) {
  const opts = {
    out: path.join(ROOT, 'dist'),
    dryRun: false,
    skipGuards: false,
    previousState: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) opts.out = argValue(arg, '--out=');
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--skip-guards') opts.skipGuards = true;
    else if (arg.startsWith('--previous-state=')) opts.previousState = argValue(arg, '--previous-state=');
  }
  return opts;
}

async function loadPreviousState(ref) {
  if (!ref) return null;
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    const res = await fetch(ref, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`Previous state fetch ${res.status} — continuing without regression compare`);
      return null;
    }
    return res.json();
  }
  if (fs.existsSync(ref)) {
    return JSON.parse(fs.readFileSync(ref, 'utf8'));
  }
  console.warn(`Previous state not found: ${ref}`);
  return null;
}

function collectUploadFiles(outDir) {
  const files = [];

  // Token card shards listed in build summary
  const summaryPath = path.join(outDir, 'token-build-summary.json');
  let shardKeys = [];
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    shardKeys = summary.tokenCardShardKeys || [];
  }

  function walk(dir, baseRel) {
    if (!fs.existsSync(dir)) return;
    const st = fs.statSync(dir);
    if (st.isFile()) {
      files.push({ abs: dir, key: baseRel.replace(/\\/g, '/') });
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      walk(path.join(dir, name), path.join(baseRel, name));
    }
  }

  walk(path.join(outDir, 'index', 'tokens'), 'index/tokens');
  const defaults = path.join(outDir, 'index', 'token-cdn-defaults.json');
  if (fs.existsSync(defaults)) {
    files.push({ abs: defaults, key: 'index/token-cdn-defaults.json' });
  }

  for (const k of shardKeys) {
    const abs = path.join(outDir, 'index', 'cards', 'shards', `${k}.json`);
    if (fs.existsSync(abs)) {
      files.push({ abs, key: `index/cards/shards/${k}.json` });
    }
  }

  // sync-state LAST — caller should ensure we upload it after others; we sort it to end
  const syncState = path.join(outDir, 'index', 'token-sync-state.json');
  const withoutState = files.filter((f) => f.key !== 'index/token-sync-state.json');
  if (fs.existsSync(syncState)) {
    withoutState.push({ abs: syncState, key: 'index/token-sync-state.json' });
  }

  // De-dupe by key
  const byKey = new Map();
  for (const f of withoutState) byKey.set(f.key, f);
  const ordered = [...byKey.values()].sort((a, b) => {
    if (a.key === 'index/token-sync-state.json') return 1;
    if (b.key === 'index/token-sync-state.json') return -1;
    return a.key.localeCompare(b.key);
  });
  return ordered;
}

function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

async function fetchRemoteJson(publicBase, key) {
  if (!publicBase) return null;
  const url = `${publicBase.replace(/\/$/, '')}/${key}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`Remote GET ${key} → ${res.status}; uploading local only`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`Remote GET ${key} failed: ${err.message}`);
    return null;
  }
}

/**
 * Card shards must merge with live R2 so token-only local builds do not wipe seed card records.
 */
async function bodyForUpload(file, publicBase) {
  let body = fs.readFileSync(file.abs);
  if (!file.key.startsWith('index/cards/shards/') || !file.key.endsWith('.json')) {
    return body;
  }
  const local = JSON.parse(body.toString('utf8'));
  const remote = await fetchRemoteJson(publicBase, file.key);
  const merged = mergeShardRecords(remote, local);
  return Buffer.from(JSON.stringify(merged), 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const summaryPath = path.join(opts.out, 'token-build-summary.json');
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Missing ${summaryPath}. Run build-token-index.js first.`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const publicBase = (
    process.env.R2_PUBLIC_BASE_URL ||
    summary.publicBaseUrl ||
    ''
  ).replace(/\/$/, '');

  const previous = await loadPreviousState(
    opts.previousState ||
      (publicBase ? `${publicBase}/index/token-sync-state.json` : null)
  );

  if (!opts.skipGuards) {
    assertTokenBuildSane(summary.counts, previous);
    console.log('Sanity gates OK');
  } else {
    console.warn('WARNING: --skip-guards set; publishing without regression checks');
  }

  const files = collectUploadFiles(opts.out);
  if (files.length === 0) throw new Error('No files to upload');

  console.log(`Prepared ${files.length} objects for upload from ${opts.out}`);

  if (opts.dryRun) {
    for (const f of files.slice(0, 20)) console.log(`  DRY-RUN ${f.key}`);
    if (files.length > 20) console.log(`  ... +${files.length - 20} more`);
    console.log('Dry run complete — R2 unchanged');
    return;
  }

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

  const cacheControl = (key) =>
    key.endsWith('token-sync-state.json') ? 'no-cache' : 'public, max-age=300';

  let uploadOne;
  if (useS3) {
    console.log('Publish auth: S3-compatible R2 API keys');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    uploadOne = async (key, body) => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentTypeFor(key),
          CacheControl: cacheControl(key),
        })
      );
    };
  } else {
    console.log('Publish auth: Cloudflare REST (CLOUDFLARE_API_TOKEN)');
    uploadOne = async (key, body) => {
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
          'Content-Type': contentTypeFor(key),
          'Cache-Control': cacheControl(key),
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`CF REST PUT ${key} → ${res.status}: ${text.slice(0, 300)}`);
      }
    };
  }

  let uploaded = 0;
  for (const f of files) {
    const body = await bodyForUpload(f, publicBase);
    await uploadOne(f.key, body);
    uploaded++;
    if (uploaded % 50 === 0 || f.key.endsWith('token-sync-state.json')) {
      console.log(`Uploaded ${uploaded}/${files.length}: ${f.key}`);
    }
  }

  console.log(`Published ${uploaded} objects to R2 bucket ${bucket}`);
  if (publicBase) console.log(`Public base: ${publicBase}`);
}

main().catch((err) => {
  console.error('PUBLISH FAILED:', err.message);
  process.exit(1);
});
