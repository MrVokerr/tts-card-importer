/**
 * Shared token/emblem detection for index builds (must stay aligned with Lua token paths).
 */

export function isTokenLike(card) {
  if (!card) return false;
  const tl = card.type_line || '';
  const layout = card.layout || '';
  return (
    layout === 'token' ||
    layout === 'emblem' ||
    layout === 'double_faced_token' ||
    tl.includes('Token') ||
    tl.includes('Emblem')
  );
}

export function partIsTokenOrEmblem(part) {
  if (!part) return false;
  const partType = part.type_line || '';
  return partType.includes('Token') || partType.includes('Emblem');
}
