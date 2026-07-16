/**
 * Fail-closed sanity gates for token index builds before R2 publish.
 */

export const DEFAULT_MIN_ORACLE_KEYS = 1000;
export const DEFAULT_MAX_REGRESSION = 0.05;

/**
 * Count map keys across shard files: { shardKey: { mapKey: [...] } }
 */
export function countShardMapKeys(shards) {
  let n = 0;
  for (const shard of Object.values(shards || {})) {
    n += Object.keys(shard || {}).length;
  }
  return n;
}

/**
 * @param {{ oracleKeyCount: number, parentKeyCount: number, nameKeyCount: number, tokenRecordCount: number, defaultsCount: number }} counts
 * @param {object|null} previousState from token-sync-state.json
 * @param {{ minOracleKeys?: number, maxRegression?: number }} opts
 */
export function assertTokenBuildSane(counts, previousState = null, opts = {}) {
  const minOracle = opts.minOracleKeys ?? DEFAULT_MIN_ORACLE_KEYS;
  const maxReg = opts.maxRegression ?? DEFAULT_MAX_REGRESSION;

  if (!counts || counts.oracleKeyCount <= 0) {
    throw new Error('Sanity gate: oracle key count is zero — refusing publish');
  }
  if (counts.oracleKeyCount < minOracle) {
    throw new Error(
      `Sanity gate: oracle keys ${counts.oracleKeyCount} < floor ${minOracle} — refusing publish`
    );
  }
  if (counts.parentKeyCount <= 0) {
    throw new Error('Sanity gate: parent key count is zero — refusing publish');
  }
  if (counts.tokenRecordCount <= 0) {
    throw new Error('Sanity gate: no token card records written — refusing publish');
  }
  if (counts.defaultsCount <= 0) {
    throw new Error('Sanity gate: token-cdn-defaults byName empty — refusing publish');
  }

  const prev = previousState?.counts;
  if (prev && typeof prev.oracleKeyCount === 'number' && prev.oracleKeyCount > 0) {
    const drop = (prev.oracleKeyCount - counts.oracleKeyCount) / prev.oracleKeyCount;
    if (drop > maxReg) {
      throw new Error(
        `Sanity gate: oracle keys regressed ${(drop * 100).toFixed(1)}% ` +
          `(${prev.oracleKeyCount} → ${counts.oracleKeyCount}) > ${maxReg * 100}% — refusing publish`
      );
    }
    if (prev.parentKeyCount > 0) {
      const pDrop = (prev.parentKeyCount - counts.parentKeyCount) / prev.parentKeyCount;
      if (pDrop > maxReg) {
        throw new Error(
          `Sanity gate: parent keys regressed ${(pDrop * 100).toFixed(1)}% ` +
            `(${prev.parentKeyCount} → ${counts.parentKeyCount}) — refusing publish`
        );
      }
    }
  }

  return true;
}
