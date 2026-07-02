/**
 * Match Card Importer.lua normalizeIndexName (line ~527).
 */
export function normalizeIndexName(name) {
  return (name || '')
    .replace(/\n.*/s, '')
    .toLowerCase()
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
}

export function setCollectorKey(set, collector) {
  const s = (set || '').toLowerCase().replace(/_.*$/, '');
  return `${s}|${collector || ''}`;
}
