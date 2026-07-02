/**
 * Map Scryfall bulk/API card objects to TTS metadata index records.
 * Fields consumed by Card Importer.lua indexRecordToCardObject.
 */

function faceFromScryfall(face, imageUuid) {
  if (!face) return null;
  const out = {
    name: face.name,
    type_line: face.type_line || '',
    oracle_text: face.oracle_text || '',
    cmc: face.cmc,
    power: face.power,
    toughness: face.toughness,
    loyalty: face.loyalty,
  };
  if (imageUuid) out.image_uuid = imageUuid;
  return out;
}

function relatedTokensFromCard(card) {
  const out = [];
  const seen = new Set();
  for (const part of card.all_parts || []) {
    if (!part.id || seen.has(part.id)) continue;
    const tl = part.type_line || '';
    if (!tl.includes('Token') && !tl.includes('Emblem')) continue;
    seen.add(part.id);
    out.push({
      uuid: part.id,
      name: part.name || 'Token',
      type_line: part.type_line,
    });
  }
  return out.length ? out : undefined;
}

/**
 * @param {object} card Scryfall card
 * @param {{ includeAdvanced?: boolean }} opts
 */
export function scryfallToIndexRecord(card, opts = {}) {
  const record = {
    name: card.name,
    set: (card.set || '').toLowerCase(),
    collectorNumber: String(card.collector_number ?? ''),
    oracle_id: card.oracle_id,
    type_line: card.type_line || '',
    cmc: card.cmc ?? 0,
    lang: card.lang || 'en',
    layout: card.layout || 'normal',
    oracle_text: card.oracle_text || '',
  };

  if (card.power != null) record.power = card.power;
  if (card.toughness != null) record.toughness = card.toughness;
  if (card.loyalty != null) record.loyalty = card.loyalty;

  const related = relatedTokensFromCard(card);
  if (related) record.relatedTokens = related;

  if (card.card_faces && card.card_faces.length >= 2) {
    record.card_faces = card.card_faces.map((face, i) =>
      faceFromScryfall(face, i === 0 ? card.id : face.id || card.id)
    );
  }

  if (opts.includeAdvanced) {
    if (card.rarity) record.rarity = card.rarity;
    if (card.prices) record.prices = card.prices;
    if (card.legalities) record.legalities = card.legalities;
    if (card.game_changer != null) record.game_changer = card.game_changer;
    if (card.reserved != null) record.reserved = card.reserved;
    if (card.finishes) record.finishes = card.finishes;
    if (card.color_identity) record.color_identity = card.color_identity;
    if (card.keywords) record.keywords = card.keywords;
  }

  return record;
}

export function printingEntryFromCard(card) {
  return {
    uuid: card.id,
    name: card.name,
    set: (card.set || '').toLowerCase(),
    collector_number: String(card.collector_number ?? ''),
    collectorNumber: String(card.collector_number ?? ''),
    layout: card.layout || 'normal',
    type_line: card.type_line || '',
  };
}

export function isPlayablePrinting(card) {
  const layout = card.layout || 'normal';
  const typeLine = card.type_line || '';
  if (['art_series', 'token', 'emblem', 'double_faced_token'].includes(layout)) return false;
  if (typeLine.includes('Token') || typeLine.includes('Emblem')) return false;
  return true;
}

export function shouldIncludeCard(card, mode) {
  if (!card || !card.id || !card.oracle_id) return false;
  if (card.lang && card.lang !== 'en') return false;
  if (card.digital === true) return false;
  const layout = card.layout || '';
  if (layout === 'art_series') return false;
  return true;
}
