#!/usr/bin/env node
/**
 * Daily token sync orchestrator (CI entrypoint).
 * 1) Resolve Scryfall bulk metadata
 * 2) Skip if bulkUpdatedAt matches remote token-sync-state
 * 3) Fetch JSONL + build token index locally
 * 4) Sanity gates + publish to R2
 * 5) Post-upload smoke verify
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
 *
 * Usage:
 *   node scripts/sync-tokens.js [--dry-run] [--force] [--skip-publish]
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDefaultCardsBulk } from '../lib/fetch-bulk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_PUBLIC = 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev';

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, skipPublish: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skip-publish') opts.skipPublish = true;
  }
  return opts;
}

function runNode(scriptRel, args = []) {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, scriptRel);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptRel} exited ${code}`));
    });
  });
}

async function fetchRemoteSyncState(publicBase) {
  const url = `${publicBase.replace(/\/$/, '')}/index/token-sync-state.json`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`Remote sync-state ${res.status}; treating as missing`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`Remote sync-state fetch failed: ${err.message}`);
    return null;
  }
}

async function smokeVerify(publicBase) {
  const base = publicBase.replace(/\/$/, '');
  const defaultsUrl = `${base}/index/token-cdn-defaults.json`;
  const res = await fetch(defaultsUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Smoke: token-cdn-defaults → ${res.status}`);
  const defaults = await res.json();
  if (!defaults.byName || !defaults.byName.treasure) {
    throw new Error('Smoke: token defaults missing treasure');
  }

  // Incubator // Phyrexian (double_faced_token) — ensure card shard has faces when present
  const incubatorId = defaults.byName['incubator // phyrexian'] || defaults.byName.incubator;
  if (incubatorId) {
    const shard = incubatorId.slice(0, 2).toLowerCase();
    const recRes = await fetch(`${base}/index/cards/shards/${shard}.json`);
    if (recRes.ok) {
      const shardJson = await recRes.json();
      const rec = shardJson[incubatorId];
      if (rec && (!rec.card_faces || rec.card_faces.length < 2)) {
        throw new Error('Smoke: Incubator token record missing card_faces');
      }
      console.log('Smoke: Incubator DFC token record OK');
    }
  }

  const stateRes = await fetch(`${base}/index/token-sync-state.json`);
  if (!stateRes.ok) throw new Error(`Smoke: token-sync-state → ${stateRes.status}`);
  console.log('Smoke verify OK');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC).replace(/\/$/, '');

  console.log('Resolving Scryfall default_cards bulk metadata...');
  const bulk = await resolveDefaultCardsBulk();
  console.log(`Bulk updatedAt=${bulk.updatedAt} jsonl=${Boolean(bulk.jsonlUri)}`);

  const remoteState = await fetchRemoteSyncState(publicBase);
  // Skip only for real publishes (not dry-run). Dry-run always builds so operators can validate.
  if (
    !opts.force &&
    !opts.dryRun &&
    !opts.skipPublish &&
    remoteState?.bulkUpdatedAt &&
    bulk.updatedAt &&
    remoteState.bulkUpdatedAt === bulk.updatedAt
  ) {
    console.log('Bulk unchanged since last successful sync — skip publish (exit 0)');
    return;
  }

  console.log('Building token index from JSONL...');
  await runNode('scripts/build-token-index.js', [
    '--fetch',
    `--base-url=${publicBase}`,
  ]);

  if (opts.skipPublish) {
    console.log('--skip-publish: build complete, R2 untouched');
    return;
  }

  const publishArgs = [
    `--previous-state=${publicBase}/index/token-sync-state.json`,
  ];
  if (opts.dryRun) publishArgs.push('--dry-run');

  console.log(opts.dryRun ? 'Dry-run publish...' : 'Publishing to R2...');
  await runNode('scripts/publish-r2.js', publishArgs);

  if (!opts.dryRun) {
    console.log('Post-upload smoke verify...');
    await smokeVerify(publicBase);
  }

  console.log('Token sync complete');
}

main().catch((err) => {
  console.error('SYNC FAILED:', err.message);
  process.exit(1);
});
