/**
 * Semantic token-link overrides for same-named related tokens.
 *
 * Stored on R2 as `token-cdn-defaults.json` → `tokenLinkOverrides` (keyed by
 * parent oracle UUID). A committed seed at config/token-link-overrides.json is
 * merged in so critical canaries survive even if remote defaults lose the field.
 *
 * Override entries publish distinct `name` aliases so Card Importer 6.6's
 * name-based dedupe keeps every variant; hydrated card records still use the
 * real token name from ensureCardRecords.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeIndexName } from './normalize.js';
import { parentNameShardKey, tokenShardKey } from './shard-keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOKEN_LINK_OVERRIDES_PATH = path.join(
  __dirname,
  '..',
  'config',
  'token-link-overrides.json'
);

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_TOKEN_LINK_OVERRIDES = 64;
export const MAX_TOKENS_PER_OVERRIDE = 16;
export const MAX_ALIAS_LENGTH = 128;

/**
 * @typedef {{ uuid: string, alias: string, type_line?: string }} TokenLinkOverrideToken
 * @typedef {{ tokens: TokenLinkOverrideToken[], parentNames?: string[], parentPrintings?: string[] }} TokenLinkOverride
 * @typedef {Record<string, TokenLinkOverride>} TokenLinkOverridesMap
 */

/**
 * Normalize and strictly validate a tokenLinkOverrides object.
 * Fail-closed on malformed UUIDs, empty/duplicate aliases, empty lists, or size caps.
 *
 * @param {unknown} raw
 * @param {string} [label='tokenLinkOverrides']
 * @returns {TokenLinkOverridesMap}
 */
export function normalizeAndValidateTokenLinkOverrides(raw, label = 'tokenLinkOverrides') {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object keyed by parent oracle UUID`);
  }

  const oracleKeys = Object.keys(raw);
  if (oracleKeys.length > MAX_TOKEN_LINK_OVERRIDES) {
    throw new Error(
      `${label}: ${oracleKeys.length} entries exceeds cap ${MAX_TOKEN_LINK_OVERRIDES}`
    );
  }

  /** @type {TokenLinkOverridesMap} */
  const out = {};

  for (const [rawOracleId, value] of Object.entries(raw)) {
    const oracleId = String(rawOracleId || '')
      .trim()
      .toLowerCase();
    if (!UUID_RE.test(oracleId)) {
      throw new Error(`${label}: invalid parent oracle UUID '${rawOracleId}'`);
    }

    const tokensRaw = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray(value.tokens)
        ? value.tokens
        : null;
    if (!tokensRaw || tokensRaw.length === 0) {
      throw new Error(`${label}[${oracleId}]: tokens must be a non-empty array`);
    }
    if (tokensRaw.length > MAX_TOKENS_PER_OVERRIDE) {
      throw new Error(
        `${label}[${oracleId}]: ${tokensRaw.length} tokens exceeds cap ${MAX_TOKENS_PER_OVERRIDE}`
      );
    }

    const aliasNorms = new Set();
    const uuids = new Set();
    /** @type {TokenLinkOverrideToken[]} */
    const tokens = [];

    for (let i = 0; i < tokensRaw.length; i++) {
      const t = tokensRaw[i];
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        throw new Error(`${label}[${oracleId}].tokens[${i}]: must be an object`);
      }
      const uuid = String(t.uuid || '')
        .trim()
        .toLowerCase();
      const alias = String(t.alias != null ? t.alias : t.name || '').trim();
      if (!UUID_RE.test(uuid)) {
        throw new Error(`${label}[${oracleId}].tokens[${i}]: invalid uuid`);
      }
      if (!alias) {
        throw new Error(`${label}[${oracleId}].tokens[${i}]: alias/name required`);
      }
      if (alias.length > MAX_ALIAS_LENGTH) {
        throw new Error(
          `${label}[${oracleId}].tokens[${i}]: alias exceeds ${MAX_ALIAS_LENGTH} chars`
        );
      }
      const aliasNorm = normalizeIndexName(alias);
      if (!aliasNorm) {
        throw new Error(`${label}[${oracleId}].tokens[${i}]: alias normalizes empty`);
      }
      if (uuids.has(uuid)) {
        throw new Error(`${label}[${oracleId}]: duplicate token uuid ${uuid}`);
      }
      if (aliasNorms.has(aliasNorm)) {
        throw new Error(
          `${label}[${oracleId}]: duplicate alias '${alias}' (normalized '${aliasNorm}')`
        );
      }
      uuids.add(uuid);
      aliasNorms.add(aliasNorm);

      /** @type {TokenLinkOverrideToken} */
      const entry = { uuid, alias };
      if (t.type_line != null && String(t.type_line).trim()) {
        entry.type_line = String(t.type_line).trim();
      }
      tokens.push(entry);
    }

    const parentNames = [];
    if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.parentNames)) {
      for (const n of value.parentNames) {
        const norm = normalizeIndexName(String(n || ''));
        if (!norm) {
          throw new Error(`${label}[${oracleId}]: parentNames entry normalizes empty`);
        }
        if (!parentNames.includes(norm)) parentNames.push(norm);
      }
    }

    const parentPrintings = [];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Array.isArray(value.parentPrintings)
    ) {
      for (const rawId of value.parentPrintings) {
        const id = String(rawId || '')
          .trim()
          .toLowerCase();
        if (!UUID_RE.test(id)) {
          throw new Error(`${label}[${oracleId}]: invalid parentPrintings uuid '${rawId}'`);
        }
        if (!parentPrintings.includes(id)) parentPrintings.push(id);
      }
    }

    /** @type {TokenLinkOverride} */
    const entry = { tokens };
    if (parentNames.length) entry.parentNames = parentNames;
    if (parentPrintings.length) entry.parentPrintings = parentPrintings;
    out[oracleId] = entry;
  }

  return out;
}

/**
 * Merge override maps. Later sources win for the same parent oracle UUID.
 * @param {...unknown} sources
 * @returns {TokenLinkOverridesMap}
 */
export function mergeTokenLinkOverrides(...sources) {
  /** @type {TokenLinkOverridesMap} */
  const merged = {};
  for (const src of sources) {
    const part = normalizeAndValidateTokenLinkOverrides(src);
    Object.assign(merged, part);
  }
  return merged;
}

/**
 * Load overrides from a JSON file (object or `{ tokenLinkOverrides: ... }`).
 * Missing file → `{}`.
 * @param {string} filePath
 * @returns {TokenLinkOverridesMap}
 */
export function loadTokenLinkOverridesFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.tokenLinkOverrides) {
    return normalizeAndValidateTokenLinkOverrides(raw.tokenLinkOverrides, filePath);
  }
  return normalizeAndValidateTokenLinkOverrides(raw, filePath);
}

/**
 * Resolve overrides from optional local seed + previous R2 defaults.
 * Seed wins over remote for the same oracle (committed canaries are durable).
 *
 * @param {object|null|undefined} previousDefaults
 * @param {string} [seedPath]
 * @returns {TokenLinkOverridesMap}
 */
export function resolveTokenLinkOverrides(
  previousDefaults,
  seedPath = DEFAULT_TOKEN_LINK_OVERRIDES_PATH
) {
  const fromRemote = previousDefaults?.tokenLinkOverrides || {};
  const fromSeed = loadTokenLinkOverridesFile(seedPath);
  return mergeTokenLinkOverrides(fromRemote, fromSeed);
}

/**
 * Build related-token shard entries from an override (distinct aliases as `name`).
 * @param {TokenLinkOverride} override
 * @param {Map<string, object>|null|undefined} tokenRecords
 * @returns {{ uuid: string, name: string, type_line?: string }[]}
 */
export function overrideToRelatedEntries(override, tokenRecords) {
  return override.tokens.map((t) => {
    const rec = tokenRecords?.get?.(t.uuid) || tokenRecords?.[t.uuid];
    const type_line = t.type_line || rec?.type_line || undefined;
    const entry = { uuid: t.uuid, name: t.alias };
    if (type_line) entry.type_line = type_line;
    return entry;
  });
}

/**
 * Replace oracle / parent-name / parent-printing shard lists for each override.
 * Fail-closed if a configured parent oracle was never seen in bulk, or a token
 * UUID is missing from token records.
 *
 * @param {object} opts
 * @param {TokenLinkOverridesMap} opts.overrides
 * @param {Record<string, Record<string, object[]>>} opts.oracleShards
 * @param {Record<string, Record<string, object[]>>} opts.parentShards
 * @param {Record<string, Record<string, object[]>>} opts.parentNameShards
 * @param {Map<string, { parentUuids: Set<string>, parentNames: Set<string> }>} opts.observedParents
 * @param {Map<string, object>|null|undefined} [opts.tokenRecords]
 * @returns {{ applied: number, parentPrintings: number, parentNames: number }}
 */
export function applyTokenLinkOverrides({
  overrides,
  oracleShards,
  parentShards,
  parentNameShards,
  observedParents,
  tokenRecords,
}) {
  const validated = normalizeAndValidateTokenLinkOverrides(overrides);
  let applied = 0;
  let parentPrintings = 0;
  let parentNames = 0;

  for (const [oracleId, override] of Object.entries(validated)) {
    const observed = observedParents?.get(oracleId);
    if (!observed || observed.parentUuids.size === 0) {
      throw new Error(
        `tokenLinkOverrides[${oracleId}]: no parent printings observed in bulk (missing parent oracle)`
      );
    }
    if (!observed.parentNames || observed.parentNames.size === 0) {
      throw new Error(`tokenLinkOverrides[${oracleId}]: no parent names observed in bulk`);
    }

    for (const t of override.tokens) {
      const rec = tokenRecords?.get?.(t.uuid) || tokenRecords?.[t.uuid];
      if (!rec) {
        throw new Error(
          `tokenLinkOverrides[${oracleId}]: token uuid ${t.uuid} not found in token records`
        );
      }
    }

    const entries = overrideToRelatedEntries(override, tokenRecords);

    const oKey = tokenShardKey(oracleId);
    if (!oracleShards[oKey]) oracleShards[oKey] = {};
    // Drop any prior casing of the same oracle UUID so only the override list remains.
    for (const k of Object.keys(oracleShards[oKey])) {
      if (String(k).toLowerCase() === oracleId) delete oracleShards[oKey][k];
    }
    oracleShards[oKey][oracleId] = entries;

    for (const parentUuid of observed.parentUuids) {
      const pKey = tokenShardKey(parentUuid);
      if (!parentShards[pKey]) parentShards[pKey] = {};
      parentShards[pKey][parentUuid] = entries;
      parentPrintings++;
    }

    for (const parentNorm of observed.parentNames) {
      const nKey = parentNameShardKey(parentNorm);
      if (!parentNameShards[nKey]) parentNameShards[nKey] = {};
      parentNameShards[nKey][parentNorm] = entries;
      parentNames++;
    }

    applied++;
  }

  return { applied, parentPrintings, parentNames };
}

/**
 * Serialize overrides for embedding in token-cdn-defaults.json.
 * @param {TokenLinkOverridesMap} overrides
 * @returns {TokenLinkOverridesMap}
 */
export function serializeTokenLinkOverrides(overrides) {
  return normalizeAndValidateTokenLinkOverrides(overrides);
}
