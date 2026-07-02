import { normalizeIndexName } from './normalize.js';

/**
 * Match Card Importer.lua parentNameShardKey (lines ~148-156).
 */
export function parentNameShardKey(input) {
  const norm = normalizeIndexName(input);
  if (!norm) return '00';
  let h = 5381;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 33 + norm.charCodeAt(i)) % 4294967296;
  }
  return (h % 256).toString(16).padStart(2, '0');
}

/**
 * Match Card Importer.lua tokenShardKey (lines ~749-752).
 * Used for UUID / oracle_id record shards.
 */
export function tokenShardKey(id) {
  if (!id) return '00';
  return id.substring(0, 2).toLowerCase();
}

export function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
}
