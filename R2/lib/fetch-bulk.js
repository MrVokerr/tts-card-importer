/**
 * Scryfall default_cards bulk ingest via JSONL.gz (jsonl_download_uri).
 * Array JSON bulk is deprecated after 2026-07-20 — fail closed after that date.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream, createReadStream } from 'fs';

export const USER_AGENT = 'TTS-Card-Importer-R2/1.0 (github.com/MrVokerr/tts-card-importer)';
export const BULK_META_URL = 'https://api.scryfall.com/bulk-data/default-cards';
/** Scryfall retires array JSON bulk on this date (UTC). */
export const JSON_ARRAY_RETIRE_DATE = '2026-07-20';

const DEFAULT_RETRIES = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPastJsonArrayRetirement(now = new Date()) {
  return now.toISOString().slice(0, 10) >= JSON_ARRAY_RETIRE_DATE;
}

export async function fetchWithRetry(url, opts = {}, retries = DEFAULT_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          Accept: '*/*',
          'User-Agent': USER_AGENT,
          ...(opts.headers || {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = 500 * 2 ** (attempt - 1);
        console.warn(`Retry ${attempt}/${retries} after error: ${err.message} (wait ${wait}ms)`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/**
 * Resolve latest default_cards bulk metadata from Scryfall.
 * @returns {Promise<{ updatedAt: string, jsonlUri: string|null, downloadUri: string|null, size: number, name: string }>}
 */
export async function resolveDefaultCardsBulk() {
  const res = await fetchWithRetry(BULK_META_URL, {
    headers: { Accept: 'application/json' },
  });
  const meta = await res.json();
  const jsonlUri = meta.jsonl_download_uri || null;
  const downloadUri = meta.download_uri || null;

  if (!jsonlUri) {
    if (isPastJsonArrayRetirement()) {
      throw new Error(
        `Scryfall default_cards has no jsonl_download_uri after ${JSON_ARRAY_RETIRE_DATE} retirement. ` +
          'Array JSON bulk is no longer supported.'
      );
    }
    if (!downloadUri) {
      throw new Error('Scryfall default_cards bulk metadata missing download URIs');
    }
    console.warn(
      'WARNING: jsonl_download_uri missing; falling back to deprecated download_uri (array JSON). ' +
        `Migrate before ${JSON_ARRAY_RETIRE_DATE}.`
    );
  }

  return {
    updatedAt: meta.updated_at,
    jsonlUri,
    downloadUri,
    size: meta.size || 0,
    name: meta.name || 'Default Cards',
  };
}

/**
 * Download bulk file to disk with retries.
 * Prefers JSONL.gz; may fall back to array JSON before retirement.
 */
export async function downloadDefaultCardsBulk(destPath, bulkMeta = null) {
  const meta = bulkMeta || (await resolveDefaultCardsBulk());
  const useJsonl = Boolean(meta.jsonlUri);
  const url = useJsonl ? meta.jsonlUri : meta.downloadUri;
  if (!url) throw new Error('No bulk download URL available');

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + '.tmp';
  console.log(`Downloading ${useJsonl ? 'JSONL.gz' : 'array JSON'} → ${destPath}`);
  console.log(`  source: ${url}`);
  console.log(`  bulk updatedAt: ${meta.updatedAt}`);

  const res = await fetchWithRetry(url);
  if (!res.body) throw new Error(`Empty response body for ${url}`);
  try {
    const nodeStream =
      typeof Readable.fromWeb === 'function' ? Readable.fromWeb(res.body) : res.body;
    await pipeline(nodeStream, createWriteStream(tmp));
    fs.renameSync(tmp, destPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }

  const bytes = fs.statSync(destPath).size;
  if (bytes < 1000) {
    try {
      fs.unlinkSync(destPath);
    } catch {
      /* ignore */
    }
    throw new Error(`Downloaded bulk file too small (${bytes} bytes) — likely truncated`);
  }
  console.log(`Saved ${destPath} (${Math.round(bytes / 1024 / 1024)} MB)`);
  return { ...meta, path: destPath, format: useJsonl ? 'jsonl.gz' : 'json' };
}

/**
 * Async iterator yielding card objects from a local bulk file (JSONL.gz or array JSON).
 */
export async function* iterateBulkCards(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing bulk file: ${filePath}`);
  }

  const lower = filePath.toLowerCase();
  // Prefer explicit .jsonl.gz; bare .gz is treated as JSONL only if not a plain .json.gz array dump name
  if (lower.endsWith('.jsonl.gz') || (lower.endsWith('.gz') && !lower.endsWith('.json.gz'))) {
    let lines = 0;
    let parsed = 0;
    const stream = createReadStream(filePath).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines++;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`JSONL parse error at line ${lines}: ${err.message}`);
      }
      if (obj && obj.id) {
        parsed++;
        yield obj;
      }
    }
    if (parsed === 0) {
      throw new Error(`JSONL file produced zero card objects (${lines} non-empty lines)`);
    }
    return;
  }

  // Legacy array JSON (transition window only)
  if (isPastJsonArrayRetirement()) {
    throw new Error(
      `Refusing to parse array JSON bulk after ${JSON_ARRAY_RETIRE_DATE}. Use .jsonl.gz.`
    );
  }
  console.warn(`WARNING: Parsing legacy array JSON from ${filePath}`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = raw.data || raw;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Legacy bulk JSON contained zero cards');
  }
  for (const card of list) {
    if (card && card.id) yield card;
  }
}

/**
 * Ensure a local bulk file exists (download if --fetch / missing), return path + meta.
 */
export async function ensureBulkFile(opts) {
  const {
    fetch: doFetch = false,
    input,
    preferJsonlExt = true,
  } = opts;

  let dest = input;
  if (doFetch || !fs.existsSync(dest)) {
    const meta = await resolveDefaultCardsBulk();
    if (preferJsonlExt && meta.jsonlUri && !dest.toLowerCase().endsWith('.gz')) {
      dest = dest.replace(/\.json$/i, '.jsonl.gz');
      if (!dest.toLowerCase().endsWith('.jsonl.gz')) {
        dest = path.join(path.dirname(dest), 'default-cards.jsonl.gz');
      }
    }
    const downloaded = await downloadDefaultCardsBulk(dest, meta);
    return { path: dest, meta: downloaded };
  }

  // Local file present — still resolve meta for skip-if-unchanged when possible
  let meta = null;
  try {
    meta = await resolveDefaultCardsBulk();
  } catch (err) {
    console.warn(`Could not refresh bulk metadata: ${err.message}`);
  }
  return {
    path: dest,
    meta: meta
      ? { ...meta, path: dest, format: dest.toLowerCase().endsWith('.gz') ? 'jsonl.gz' : 'json' }
      : { path: dest, updatedAt: null, jsonlUri: null, format: dest.toLowerCase().endsWith('.gz') ? 'jsonl.gz' : 'json' },
  };
}
