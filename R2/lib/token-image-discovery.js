/**
 * Bounded discovery + validation helpers for token image caching.
 * Pure/offline-testable pieces live here; network I/O stays in the script.
 */
import { isTokenLike } from './token-like.js';

/** Days before today to include released token sets. */
export const LOOKBACK_DAYS = 30;
/** Days after today to include upcoming token sets (pre-cache). */
export const LOOKAHEAD_DAYS = 120;
/** Fail-closed cap on auto-discovered set codes per run. */
export const MAX_DISCOVERED_SETS = 40;
/** Fail-closed cap on candidate token/emblem cards per run. */
export const MAX_CANDIDATE_CARDS = 2000;
/** Minimum accepted JPEG payload size (bytes). */
export const MIN_JPEG_BYTES = 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {string|null|undefined} csv
 * @returns {string[]}
 */
export function parseSetCodes(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const part of csv.split(',')) {
    const code = part.trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * @param {...(string[]|null|undefined)} lists
 * @returns {string[]}
 */
export function unionSetCodes(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const code = raw.trim().toLowerCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
  }
  out.sort();
  return out;
}

/**
 * @param {Date} now
 * @param {number} lookbackDays
 * @param {number} lookaheadDays
 * @returns {{ start: Date, end: Date }}
 */
export function discoveryWindow(now = new Date(), lookbackDays = LOOKBACK_DAYS, lookaheadDays = LOOKAHEAD_DAYS) {
  const start = new Date(now.getTime() - lookbackDays * MS_PER_DAY);
  const end = new Date(now.getTime() + lookaheadDays * MS_PER_DAY);
  return { start, end };
}

/**
 * @param {string|null|undefined} releasedAt
 * @param {{ start: Date, end: Date }} window
 * @returns {boolean}
 */
export function releasedAtInWindow(releasedAt, window) {
  if (!releasedAt || typeof releasedAt !== 'string') return false;
  const t = Date.parse(releasedAt);
  if (Number.isNaN(t)) return false;
  return t >= window.start.getTime() && t <= window.end.getTime();
}

/**
 * Select non-digital Scryfall token sets inside the discovery window.
 * @param {object[]} sets - Scryfall /sets data array
 * @param {object} [opts]
 * @returns {string[]}
 */
export function selectTokenSetCodes(sets, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const lookbackDays = opts.lookbackDays ?? LOOKBACK_DAYS;
  const lookaheadDays = opts.lookaheadDays ?? LOOKAHEAD_DAYS;
  const window = discoveryWindow(now, lookbackDays, lookaheadDays);
  const codes = [];
  for (const set of Array.isArray(sets) ? sets : []) {
    if (!set || typeof set !== 'object') continue;
    if (set.digital) continue;
    if (set.set_type !== 'token') continue;
    const code = typeof set.code === 'string' ? set.code.trim().toLowerCase() : '';
    if (!code) continue;
    if (!releasedAtInWindow(set.released_at, window)) continue;
    codes.push(code);
  }
  return unionSetCodes(codes);
}

/**
 * Resolve auto + manual set codes and enforce the discovered-set cap.
 * Manual extras are always included; only auto-discovered codes count toward the cap.
 * @param {object[]} scryfallSets
 * @param {string[]} [manualCodes]
 * @param {object} [opts]
 * @returns {{ auto: string[], manual: string[], sets: string[] }}
 */
export function resolveDiscoverySetCodes(scryfallSets, manualCodes = [], opts = {}) {
  const maxSets = opts.maxDiscoveredSets ?? MAX_DISCOVERED_SETS;
  const auto = selectTokenSetCodes(scryfallSets, opts);
  if (auto.length > maxSets) {
    throw new Error(
      `Auto-discovered ${auto.length} token sets exceeds cap ${maxSets} ` +
        `(window ${opts.lookbackDays ?? LOOKBACK_DAYS}d back / ${opts.lookaheadDays ?? LOOKAHEAD_DAYS}d ahead). ` +
        `Fail-closed — narrow the window or raise MAX_DISCOVERED_SETS intentionally.`
    );
  }
  const manual = unionSetCodes(manualCodes);
  const sets = unionSetCodes(auto, manual);
  return { auto, manual, sets };
}

/**
 * @param {number} candidateCount
 * @param {number} [maxCards]
 */
export function assertCandidateCardCap(candidateCount, maxCards = MAX_CANDIDATE_CARDS) {
  if (candidateCount > maxCards) {
    throw new Error(
      `Candidate token/emblem cards ${candidateCount} exceeds cap ${maxCards}. ` +
        `Fail-closed — refuse unbounded mirror.`
    );
  }
}

/**
 * @param {Buffer|Uint8Array|null|undefined} buf
 * @returns {boolean}
 */
export function hasJpegMagic(buf) {
  if (!buf || buf.length < 3) return false;
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * Validate a downloaded image buffer (MIME hint + magic + min size).
 * @param {Buffer|Uint8Array} buf
 * @param {string} [contentType]
 * @param {object} [opts]
 */
export function assertValidJpegBuffer(buf, contentType = '', opts = {}) {
  const minBytes = opts.minBytes ?? MIN_JPEG_BYTES;
  const ctype = (contentType || '').toLowerCase();
  if (
    ctype &&
    !ctype.includes('jpeg') &&
    !ctype.includes('jpg') &&
    !ctype.includes('octet-stream')
  ) {
    throw new Error(`Expected JPEG content-type, got ${ctype}`);
  }
  if (!buf || buf.length < minBytes) {
    throw new Error(`Suspiciously small image (${buf ? buf.length : 0} bytes, min ${minBytes})`);
  }
  if (!hasJpegMagic(buf)) {
    throw new Error('JPEG magic bytes missing (expected FF D8 FF)');
  }
}

/**
 * @param {object|null|undefined} card
 * @returns {boolean}
 */
export function isDoubleFacedToken(card) {
  if (!card) return false;
  if (card.layout === 'double_faced_token') return true;
  return Array.isArray(card.card_faces) && card.card_faces.length >= 2 && isTokenLike(card);
}

/**
 * Shared skip filter for art series / digital / MTGO-only / non-token.
 * @param {object|null|undefined} card
 * @returns {boolean} true = skip
 */
export function shouldSkipTokenImageCard(card) {
  if (!card) return true;
  if (card.digital) return true;
  if (card.layout === 'art_series') return true;
  if (Array.isArray(card.games) && card.games.length === 1 && card.games[0] === 'mtgo') {
    return true;
  }
  if (!isTokenLike(card)) return true;
  return false;
}

/**
 * Split candidates into single-faced (R2-eligible) vs DFC (Kai-only policy).
 * Dedupes by lowercase UUID.
 * @param {object[]} cards
 * @returns {{ singleFaced: object[], doubleFaced: object[], skipped: number }}
 */
export function partitionTokenImageCards(cards) {
  const seen = new Set();
  const singleFaced = [];
  const doubleFaced = [];
  let skipped = 0;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card?.id || shouldSkipTokenImageCard(card)) {
      skipped++;
      continue;
    }
    const uuid = String(card.id).toLowerCase();
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    if (isDoubleFacedToken(card)) doubleFaced.push(card);
    else singleFaced.push(card);
  }
  return { singleFaced, doubleFaced, skipped };
}

/**
 * Build an actionable DFC failure message (6.6 cannot use R2 DFC fallback).
 * @param {object} card
 * @param {string[]} [checkedUuids]
 * @returns {string}
 */
export function dfcNoKaiCanonicalMessage(card, checkedUuids = []) {
  const name = card?.name || '(unknown)';
  const set = card?.set || '?';
  const cn = card?.collector_number || '?';
  const uuid = card?.id ? String(card.id).toLowerCase() : '(no-id)';
  const checked =
    checkedUuids.length > 0
      ? ` Checked Kai printings: ${checkedUuids.join(', ')}.`
      : '';
  return (
    `DFC token "${name}" (${set} #${cn}, ${uuid}) has no Kai-backed two-sided printing. ` +
    `Card Importer 6.6 cannot use R2 DFC image fallback — leave a Kai-mirrored ` +
    `canonical printing in token-cdn-defaults / parent shards, or wait for Kai.${checked}`
  );
}
