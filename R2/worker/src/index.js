/**
 * Example Cloudflare Worker — REST facade over R2 metadata shards.
 * Bind R2 bucket as METADATA_BUCKET; set PUBLIC_BASE_URL var.
 */
import { parentNameShardKey, tokenShardKey } from '../../lib/shard-keys.js';
import { normalizeIndexName } from '../../lib/normalize.js';

async function getObject(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return JSON.parse(await obj.text());
}

async function getRecord(bucket, uuid) {
  const shard = await getObject(bucket, `index/cards/shards/${tokenShardKey(uuid)}.json`);
  return shard?.[uuid] ?? null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bucket = env.METADATA_BUCKET;
    if (!bucket) return new Response('METADATA_BUCKET not bound', { status: 500 });

    if (url.pathname === '/index/card-index.json') {
      const manifest = await getObject(bucket, 'index/card-index.json');
      if (!manifest) return new Response('Not found', { status: 404 });
      return Response.json(manifest);
    }

    const cardMatch = url.pathname.match(/^\/v1\/cards\/([0-9a-f-]{36})$/i);
    if (cardMatch) {
      const rec = await getRecord(bucket, cardMatch[1]);
      if (!rec) return new Response('Not found', { status: 404 });
      const body = { ...rec, id: cardMatch[1] };
      if (env.MERGE_SCRYFALL === 'true') {
        body._note = 'Add live Scryfall merge here for prices/legalities';
      }
      return Response.json(body);
    }

    if (url.pathname === '/v1/named') {
      const exact = url.searchParams.get('exact');
      if (!exact) return new Response('exact query required', { status: 400 });
      const norm = normalizeIndexName(exact);
      const nameShard = await getObject(
        bucket,
        `index/cards/names-by-name/shards/${parentNameShardKey(norm)}.json`
      );
      const ids = nameShard?.[norm];
      if (!ids?.length) return new Response('Not found', { status: 404 });
      const rec = await getRecord(bucket, ids[0]);
      if (!rec) return new Response('Not found', { status: 404 });
      return Response.json({ ...rec, id: ids[0] });
    }

    return new Response('TTS Card Metadata Worker — see /index/card-index.json, /v1/cards/{uuid}, /v1/named?exact=', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
