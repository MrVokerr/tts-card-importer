/**
 * Helpers for token image CDN routing lists (kaiMissUuids / r2FallbackUuids).
 */

/**
 * @param {...(string[]|null|undefined)} lists
 * @returns {string[]}
 */
export function unionUuidLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  out.sort();
  return out;
}

/**
 * Load prior token-cdn-defaults from a URL or local path.
 * @param {string|null|undefined} ref
 * @returns {Promise<object|null>}
 */
export async function loadPreviousDefaults(ref) {
  if (!ref) return null;
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    try {
      const res = await fetch(ref, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) {
        console.warn(`Previous defaults fetch ${res.status}; continuing without`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`Previous defaults fetch failed: ${err.message}`);
      return null;
    }
  }
  const fs = await import('fs');
  if (fs.existsSync(ref)) {
    return JSON.parse(fs.readFileSync(ref, 'utf8'));
  }
  console.warn(`Previous defaults not found: ${ref}`);
  return null;
}
