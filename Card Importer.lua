-- Original by: Amuzet. Adapted by: Vokerr.
-- Card images: https://img.klrmngr.com (Kai CDN)
-- Metadata:   https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev (Vokerr public index)
-- Mirror hosts: see R2/METADATA.md and R2/MIRROR.md (set METADATA_CDN below).
-- CDN-only at runtime — no Scryfall API.
mod_name,version='Card Importer','6.0'
self.setName('[854FD9]'..mod_name..' [49D54F]'..version)
textItems={}
newText=setmetatable({
  type='3DText',
  position={0,2,0},
  rotation={90,0,0}},
  {__call=function(t,p,text,f)
    t.position=p
    local o=spawnObject(t)
    table.insert(textItems,o)
    o.TextTool.setValue(text)
    o.TextTool.setFontSize(f or 50)
    return function(t)
      if t then
        o.TextTool.setValue(t)
      else
        for i,oo in ipairs(textItems) do
          if oo==o then
            table.remove(textItems,i)
          end
        end
        o.destruct()
      end
    end
  end})

--[[Variables]]
local Deck,Tick=1,0.2
local Card
local DEFAULT_BACK='https://steamusercontent-a.akamaihd.net/ugc/1647720103762682461/35EF6E87970E2A5D6581E7D96A99F8A575B7A15F/'
local IMAGE_CDN='https://img.klrmngr.com'
local METADATA_CDN='https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev'
local USER_AGENT='TTS-MTG-Card-Importer/'..tostring(version)
local R2_IMAGE_CDN=METADATA_CDN
local TOKEN_SHARD_PARENT=METADATA_CDN..'/index/tokens/shards/parent/'
local TOKEN_SHARD_ORACLE=METADATA_CDN..'/index/tokens/shards/oracle/'
local TOKEN_DEFAULTS_URL=METADATA_CDN..'/index/token-cdn-defaults.json'
local TOKEN_PARENTS_SHARD_BASE=METADATA_CDN..'/index/tokens/parents-by-name/shards/'
local CDN_INDEX_URL=METADATA_CDN..'/index/card-index.json'
local CARD_SHARD_BASE=METADATA_CDN..'/index/cards/shards/'
local NAME_SHARD_BASE=METADATA_CDN..'/index/cards/names-by-name/shards/'
local SET_COL_SHARD_BASE=METADATA_CDN..'/index/cards/set-collector/shards/'
local ORACLE_ID_SHARD_BASE=METADATA_CDN..'/index/cards/oracle-ids/shards/'
local PRINTINGS_ORACLE_SHARD_BASE=METADATA_CDN..'/index/cards/printings-by-oracle/shards/'
local ALT_ART_PREVIEW_PAGE_SIZE=24
local ALT_ART_PREVIEW_NAV_TAG='AltArtPreviewNav'
local ALT_ART_NAV_PREV_URL=METADATA_CDN..'/ui/left-65-64.png'
local ALT_ART_NAV_NEXT_URL=METADATA_CDN..'/ui/right-arrow-37-64.png'
local ALT_ART_PREVIEW_TAG='AltArtPreview'
local altArtPreviewScale=0.475
local altArtPreviewUp=2.6
local altArtPreviewSpacing=1.2
local altArtPreviewPerRow=6
local altArtPreviewRowStep=1.8
local altArtPreviewDoubleClickSecs=0.5
local ALT_ART_SPAWN_DELAY=0.25
local altArtPreviews={}
local altArtPreviewGen={}
local altArtPreviewData={}
local altArtPreviewDoubleClick={}
local altArtPreviewSessions={}
local altArtPreviewNavData={}
local indexManifest=nil
local indexManifestLoading=false
local indexManifestWaiters={}
local indexManifestTried=false
local legacyFatIndex=nil
local cardRecordCache={}
local cardShardCache={}
local cardShardLoading={}
local cardShardWaiters={}
local nameShardCache={}
local nameShardLoading={}
local nameShardWaiters={}
local setColShardCache={}
local setColShardLoading={}
local setColShardWaiters={}
local oracleIdShardCache={}
local oracleIdShardLoading={}
local oracleIdShardWaiters={}
local printingsOracleShardCache={}
local printingsOracleShardLoading={}
local printingsOracleShardWaiters={}
local tokenDefaultsByName=nil
local tokenDefaultsLoading=false
local tokenDefaultsWaiters={}
local tokenParentShardCache={}
local tokenParentShardLoading={}
local tokenParentShardWaiters={}
local tokenR2Fallbacks={}
local tokenKaiMisses={}
local tokenR2ImageCdn=R2_IMAGE_CDN
local tokenShardCache={}
local tokenShardLoading={}
local tokenShardWaiters={}
local WEB_GET_TIMEOUT=15
local TOKEN_WEB_TIMEOUT=6

--Generic HTTPS GET with timeout so a hung CDN request cannot block the importer queue forever
function WebGetSSL(url, callback, headers, timeoutSec)
  timeoutSec = timeoutSec or WEB_GET_TIMEOUT
  local settled = false
  Wait.time(function()
    if settled then return end
    settled = true
    callback({ is_error = true, error = 'Timeout after '..timeoutSec..'s', text = '' })
  end, timeoutSec)
  WebRequest.custom(url, 'GET', true, nil, headers or {
    ['User-Agent'] = USER_AGENT,
    ['Accept'] = 'application/json'
  }, function(wr)
    if settled then return end
    settled = true
    callback(wr)
  end)
end

function TokenWebGetSSL(url, callback, headers)
  WebGetSSL(url, callback, headers, TOKEN_WEB_TIMEOUT)
end

function chatTargetFromPlayer(p)
  if not p then return nil end
  local target = p.getHoverObject()
  if target then return target end
  local ok, ray = pcall(function() return p.castRay() end)
  if ok and ray and ray.hit then return ray.hit end
  return nil
end

function tokenChatTable(p, mode, full)
  return {
    position = p.getPointerPosition(),
    target = chatTargetFromPlayer(p),
    player = p.steam_id,
    color = p.color,
    mode = mode,
    full = full or mode,
    standalone = true,
  }
end

function parentNameShardKey(cardName)
  local norm = normalizeIndexName(cardName)
  if not norm or norm == '' then return '00' end
  local h = 5381
  for i = 1, #norm do
    h = (h * 33 + norm:byte(i)) % 4294967296
  end
  return string.format('%02x', h % 256)
end

function fetchParentNameShard(shardKey, callback, fast)
  if tokenParentShardCache[shardKey] then
    callback(tokenParentShardCache[shardKey])
    return
  end
  if not tokenParentShardWaiters[shardKey] then tokenParentShardWaiters[shardKey] = {} end
  table.insert(tokenParentShardWaiters[shardKey], callback)
  if tokenParentShardLoading[shardKey] then return end
  tokenParentShardLoading[shardKey] = true
  local httpGet = fast and TokenWebGetSSL or WebGetSSL
  httpGet(TOKEN_PARENTS_SHARD_BASE..shardKey..'.json', function(wr)
    tokenParentShardLoading[shardKey] = false
    local parsed = nil
    if not wr.is_error and wr.text and wr.text ~= '' then
      parsed = safeJSON(wr.text)
    end
    if parsed then tokenParentShardCache[shardKey] = parsed end
    for _, cb in ipairs(tokenParentShardWaiters[shardKey] or {}) do cb(parsed) end
    tokenParentShardWaiters[shardKey] = {}
  end)
end

function lookupParentTokensByCardName(cardName, callback, fast)
  if not cardName or cardName == '' then callback(nil) return end
  local norm = normalizeIndexName(cardName)
  if norm == '' then callback(nil) return end
  fetchParentNameShard(parentNameShardKey(cardName), function(shard)
    if not shard then callback(nil) return end
    callback(relatedTokensFromParentNameEntry(shard[norm]))
  end, fast)
end

function relatedTokensFromParentNameEntry(entry)
  if not entry or #entry == 0 then return nil end
  local out = {}
  for _, part in ipairs(entry) do
    local uuid, name
    if type(part) == 'string' then
      uuid, name = part, 'Token'
    elseif type(part) == 'table' then
      uuid = part.uuid
      name = part.name or 'Token'
    end
    if uuid then
      table.insert(out, {
        uuid = uuid,
        name = name,
        type_line = type(part) == 'table' and part.type_line or nil,
        power = type(part) == 'table' and part.power or nil,
        toughness = type(part) == 'table' and part.toughness or nil,
        imageCdn = type(part) == 'table' and part.imageCdn or nil,
      })
    end
  end
  return #out > 0 and out or nil
end

function faceUuidFromTarget(target)
  if not target then return nil end
  local custom = target.getCustomObject()
  if custom and custom.face and custom.face ~= '' then
    local uuid = uuidFromCdnUrl(cleanImageUrl(custom.face))
    if uuid then return uuid end
  end
  return uuidFromCdnUrl(faceUrlFromJson(target.getJSON()))
end

function fetchLookupShard(base, shardKey, cache, loading, waiters, callback, fast)
  if cache[shardKey] then
    callback(cache[shardKey])
    return
  end
  if not waiters[shardKey] then waiters[shardKey] = {} end
  table.insert(waiters[shardKey], callback)
  if loading[shardKey] then return end
  loading[shardKey] = true
  local httpGet = fast and TokenWebGetSSL or WebGetSSL
  httpGet(base..shardKey..'.json', function(wr)
    loading[shardKey] = false
    local parsed = nil
    if not wr.is_error and wr.text and wr.text ~= '' then
      parsed = safeJSON(wr.text)
    end
    if parsed then cache[shardKey] = parsed end
    for _, cb in ipairs(waiters[shardKey] or {}) do cb(parsed) end
    waiters[shardKey] = {}
  end)
end

function fetchNameShard(shardKey, callback, fast)
  fetchLookupShard(NAME_SHARD_BASE, shardKey, nameShardCache, nameShardLoading, nameShardWaiters, callback, fast)
end

function fetchSetColShard(shardKey, callback, fast)
  fetchLookupShard(SET_COL_SHARD_BASE, shardKey, setColShardCache, setColShardLoading, setColShardWaiters, callback, fast)
end

function fetchOracleIdLookupShard(shardKey, callback, fast)
  fetchLookupShard(ORACLE_ID_SHARD_BASE, shardKey, oracleIdShardCache, oracleIdShardLoading, oracleIdShardWaiters, callback, fast)
end

function loadIndexManifest(callback)
  if indexManifest then callback(indexManifest) return end
  if indexManifestTried then callback(nil) return end
  table.insert(indexManifestWaiters, callback)
  if indexManifestLoading then return end
  indexManifestLoading = true

  local function finish(manifest)
    indexManifestLoading = false
    indexManifestTried = true
    if manifest then
      indexManifest = manifest
      if manifest.byExactName and next(manifest.byExactName) ~= nil then
        legacyFatIndex = manifest
      end
    end
    for _, cb in ipairs(indexManifestWaiters) do cb(indexManifest) end
    indexManifestWaiters = {}
  end

  WebGetSSL(CDN_INDEX_URL, function(wr)
    if wr.is_error or not wr.text or wr.text == '' then
      finish(nil)
      return
    end
    local parsed = safeJSON(wr.text)
    if not parsed then
      finish(nil)
      return
    end
    if parsed.byId and (parsed.version or 1) < 2 then
      legacyFatIndex = parsed
      finish({
        version = 1,
        byExactName = {},
        bySetCollector = {},
        byOracleId = {},
        byId = parsed.byId or {},
      })
      return
    end
    if parsed.byExactName and next(parsed.byExactName) ~= nil then
      finish({
        version = parsed.version or 2,
        byExactName = parsed.byExactName or {},
        bySetCollector = parsed.bySetCollector or {},
        byOracleId = parsed.byOracleId or {},
        byId = {},
        stats = parsed.stats,
        shardUrls = parsed.shardUrls,
      })
      return
    end
    finish(parsed)
  end)
end

function legacyNameIds(norm)
  if not legacyFatIndex or not legacyFatIndex.byExactName then return nil end
  return legacyFatIndex.byExactName[norm]
end

function legacySetColUuid(key)
  if not legacyFatIndex or not legacyFatIndex.bySetCollector then return nil end
  return legacyFatIndex.bySetCollector[key]
end

function legacyOracleIds(oracleId)
  if not legacyFatIndex or not legacyFatIndex.byOracleId then return nil end
  return legacyFatIndex.byOracleId[oracleId]
end

function lookupAllUuidsByName(name, callback)
  local norm = normalizeIndexName(name)
  if norm == '' then callback(nil) return end
  local legacy = legacyNameIds(norm)
  if legacy then callback(legacy) return end
  fetchNameShard(parentNameShardKey(norm), function(shard)
    callback(shard and shard[norm] or nil)
  end)
end

function lookupUuidByName(name, callback)
  lookupAllUuidsByName(name, function(ids)
    callback(ids and ids[1] or nil)
  end)
end

function lookupUuidBySetCollector(set, collector, callback)
  set = (set or ''):lower():gsub('_.*', '')
  local key = set..'|'..(collector or '')
  local legacy = legacySetColUuid(key)
  if legacy then callback(legacy) return end
  fetchSetColShard(parentNameShardKey(key), function(shard)
    callback(shard and shard[key] or nil)
  end)
end

function lookupUuidByOracleId(oracleId, callback)
  if not oracleId or not isUuid(oracleId) then callback(nil) return end
  local legacy = legacyOracleIds(oracleId)
  if legacy and legacy[1] then callback(legacy[1]) return end
  fetchOracleIdLookupShard(tokenShardKey(oracleId), function(shard)
    local ids = shard and shard[oracleId]
    callback(ids and ids[1] or nil)
  end)
end

function lookupOracleIdByName(name, callback)
  lookupUuidByName(name, function(uuid)
    if not uuid then callback(nil) return end
    fetchCardRecordByUuid(uuid, function(rec)
      callback(rec and rec.oracle_id or nil, uuid)
    end)
  end)
end

function cacheCardRecord(uuid, rec)
  if uuid and rec then cardRecordCache[uuid] = rec end
end

function getCachedRecord(uuid)
  if not uuid then return nil end
  return cardRecordCache[uuid]
end

function fetchCardShard(shardKey, callback, fast)
  if cardShardCache[shardKey] then
    callback(cardShardCache[shardKey])
    return
  end
  if not cardShardWaiters[shardKey] then cardShardWaiters[shardKey] = {} end
  table.insert(cardShardWaiters[shardKey], callback)
  if cardShardLoading[shardKey] then return end
  cardShardLoading[shardKey] = true

  local httpGet = fast and TokenWebGetSSL or WebGetSSL
  httpGet(CARD_SHARD_BASE..shardKey..'.json', function(wr)
    cardShardLoading[shardKey] = false
    local parsed = nil
    if not wr.is_error and wr.text and wr.text ~= '' then
      parsed = safeJSON(wr.text)
    end
    if parsed then
      cardShardCache[shardKey] = parsed
      for uid, rec in pairs(parsed) do cacheCardRecord(uid, rec) end
    end
    for _, cb in ipairs(cardShardWaiters[shardKey] or {}) do cb(parsed) end
    cardShardWaiters[shardKey] = {}
  end)
end

function ensureCardRecords(uuids, callback)
  local shardsNeeded = {}
  for _, uuid in ipairs(uuids or {}) do
    if uuid and uuid ~= '' and not cardRecordCache[uuid] then
      shardsNeeded[tokenShardKey(uuid)] = true
    end
  end

  local pending = 0
  for _ in pairs(shardsNeeded) do pending = pending + 1 end
  if pending == 0 then callback() return end

  for key in pairs(shardsNeeded) do
    fetchCardShard(key, function()
      pending = pending - 1
      if pending == 0 then callback() end
    end)
  end
end

function parseMtgFooter(text)
  if not text or text == '' then return nil, nil end
  local footer = text:match('%[mtg:([^%]]+)%]')
  if not footer then return nil, nil end
  local oid = footer:match('oid=([%x%-]+)')
  if oid and not isUuid(oid) then oid = nil end
  local tokStr = footer:match('tok=([^;]+)')
  local tokens = nil
  if tokStr then
    tokens = {}
    for uuid in tokStr:gmatch('[%x%-]+') do
      table.insert(tokens, { uuid = uuid, name = 'Token' })
    end
    if #tokens == 0 then tokens = nil end
  end
  return oid, tokens
end

function oracleIdFromTags(target)
  if not target then return nil end
  local tags = target.getTags()
  if not tags then return nil end
  for _, tag in ipairs(tags) do
    local oid = tag:match('^oid:([%x%-]+)$')
    if oid and isUuid(oid) then return oid end
  end
  return nil
end

function relatedTokensFromDescription(text)
  local _, tokens = parseMtgFooter(text)
  return tokens
end

function webRequestFailed(wr, qTbl, source)
  if wr.is_error or not wr.text or wr.text == '' then
    local msg = wr.error and tostring(wr.error) or 'SSL/network error'
    if msg:find('404') then msg = 'Deck not found. Is it public?' end
    Player[qTbl.color].broadcast((source or 'Request')..' failed: '..msg, {1,0,0})
    endLoop()
    return true
  end
  return false
end

--Image Handler — CDN-only. Strip ?timestamp cache-busters; TTS needs .jpg at URL end.
function cleanImageUrl(uri)
  if not uri or uri == '' then return '' end
  uri = uri:gsub('%?.*', '')
  uri = uri:gsub('cards%.scryfall%.io', 'img.klrmngr.com')
  return uri
end

function cleanSpawnJson(jsonLine)
  if not jsonLine then return jsonLine end
  jsonLine = jsonLine:gsub('(https://[^"%?]+%.[a-zA-Z0-9]+)%?[%w%-_=%%%.]+', '%1')
  jsonLine = jsonLine:gsub('cards%.scryfall%.io', 'img.klrmngr.com')
  return jsonLine
end

function cdnImageFromUuid(uuid, side)
  if not uuid or uuid == '' then return '' end
  side = side or 'front'
  return IMAGE_CDN..'/large/'..side..'/'..uuid:sub(1,1)..'/'..uuid:sub(2,2)..'/'..uuid..'.jpg'
end

function r2ImageFromUuid(uuid)
  if not uuid or uuid == '' or not tokenR2ImageCdn or tokenR2ImageCdn == '' then return '' end
  return tokenR2ImageCdn..'/cards/'..uuid..'.jpg'
end

function faceUrlFromUuid(uuid, imageCdn)
  if not uuid or uuid == '' then return '' end
  if imageCdn and imageCdn ~= '' and imageCdn ~= IMAGE_CDN then
    return imageCdn..'/cards/'..uuid..'.jpg'
  end
  if tokenKaiMisses[uuid] then
    local r2 = r2ImageFromUuid(uuid)
    if r2 ~= '' then return r2 end
    return cdnImageFromUuid(uuid, 'front')
  end
  if tokenR2Fallbacks[uuid] then
    local r2 = r2ImageFromUuid(uuid)
    if r2 ~= '' then return r2 end
  end
  return cdnImageFromUuid(uuid, 'front')
end

function cachedImageUri(imageUris, uuid, side, qual)
  if uuid and uuid ~= '' then return cdnImageFromUuid(uuid, side or 'front') end
  if not imageUris then return '' end
  qual = qual or 'large'
  local uri = imageUris[qual] or imageUris.large or imageUris.normal or imageUris.small or ''
  return cleanImageUrl(uri)
end

function normalizeIndexName(name)
  return (name or ''):gsub('\n.*', ''):lower():gsub('^%s+', ''):gsub('%s+$', '')
end

function isUuid(s)
  if not s or s == '' then return false end
  return s:match('^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') ~= nil
end

function uuidFromCdnUrl(url)
  if not url or url == '' then return nil end
  url = cleanImageUrl(url)
  return url:match('(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)%.[a-zA-Z0-9]+')
    or url:match('/(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)/')
    or url:match('(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)')
end

function faceUrlFromJson(json)
  if not json or json == '' then return nil end
  return json:match('"FaceURL"%s*:%s*"([^"]+)"')
end

function oracleIdFromMemo(memo)
  if not memo or memo == '' then return nil end
  local oracleId = memo:match('^([^|]+)')
  if oracleId and oracleId:find('^oracleid:') then
    oracleId = oracleId:match('^oracleid:(.+)$')
  end
  if oracleId and isUuid(oracleId) then return oracleId end
  return nil
end

function parentIdsFromTarget(target, qTbl)
  if not target then return nil, nil end
  local uuid = faceUuidFromTarget(target)
  local oracleId = oracleIdFromMemo(target.memo)
  if (not oracleId or oracleId == '') and qTbl and qTbl.oracleid then
    oracleId = oracleIdFromMemo(qTbl.oracleid)
  end
  if not oracleId or oracleId == '' then
    oracleId = oracleIdFromTags(target)
  end
  if not oracleId or oracleId == '' then
    local descOid = parseMtgFooter(target.getDescription() or '')
    oracleId = descOid
  end
  return uuid, oracleId
end

function setCollectorFromTarget(target)
  if not target then return nil, nil end
  local nick = target.getName() or ''
  local setCode, colNum = nick:match('\n·%s*([%w_]+)%s+#(%S+)')
  if setCode and colNum then
    return setCode:lower():gsub('_.*', ''), colNum
  end
  setCode, colNum = nick:match('\n(%u%+%u%+%u)%s+#(%S+)')
  if setCode and colNum then return setCode:lower(), colNum end
  return nil, nil
end

function resolveOracleIdLight(target, qTbl, callback, fast)
  fast = fast == true
  local uuid, oracleId = parentIdsFromTarget(target, qTbl)
  if oracleId and isUuid(oracleId) then
    callback(oracleId, uuid, 'embedded')
    return
  end
  if uuid and uuid ~= '' then
    fetchCardRecordByUuid(uuid, function(rec)
      if rec and rec.oracle_id and isUuid(rec.oracle_id) then
        callback(rec.oracle_id, uuid, 'card_shard')
        return
      end
      callback(nil, uuid, 'none')
    end, fast)
    return
  end
  callback(nil, nil, 'none')
end

function resolveOracleIdFromIdentity(target, qTbl, callback)
  local uuid, oracleId = parentIdsFromTarget(target, qTbl)
  if oracleId and oracleId ~= '' and isUuid(oracleId) then
    callback(oracleId, uuid, 'memo_or_tags')
    return
  end

  local desc = target and (target.getDescription() or '') or ''
  local footerOid, footerTokens = parseMtgFooter(desc)
  if footerOid then
    callback(footerOid, uuid, 'description_footer')
    return
  end

  if uuid and uuid ~= '' then
    fetchCardRecordByUuid(uuid, function(rec)
      if rec and rec.oracle_id and isUuid(rec.oracle_id) then
        callback(rec.oracle_id, uuid, 'card_shard_uuid')
        return
      end
      resolveOracleIdFromNameAndSet(target, uuid, callback)
    end)
    return
  end

  resolveOracleIdFromNameAndSet(target, uuid, callback)
end

function resolveOracleIdFromNameAndSet(target, uuid, callback)
  local setCode, colNum = setCollectorFromTarget(target)
  local function afterSetMiss()
    local cardName = cardNameFromTarget(target)
    if cardName and cardName ~= '' then
      lookupUuidByName(cardName, function(id)
        if id then
          fetchCardRecordByUuid(id, function(rec)
            if rec and rec.oracle_id and isUuid(rec.oracle_id) then
              callback(rec.oracle_id, id, 'name_shard')
              return
            end
            callback(nil, uuid, 'none')
          end)
          return
        end
        callback(nil, uuid, 'none')
      end)
      return
    end
    callback(nil, uuid, 'none')
  end

  if setCode and colNum then
    lookupUuidBySetCollector(setCode, colNum, function(id)
      if id then
        fetchCardRecordByUuid(id, function(rec)
          if rec and rec.oracle_id and isUuid(rec.oracle_id) then
            callback(rec.oracle_id, id or uuid, 'set_collector')
            return
          end
          afterSetMiss()
        end)
        return
      end
      afterSetMiss()
    end)
    return
  end
  afterSetMiss()
end

function fetchCardRecordByUuid(uuid, callback, fast)
  if not uuid or uuid == '' then callback(nil) return end
  if cardRecordCache[uuid] then
    callback(cardRecordCache[uuid])
    return
  end
  if not fast and legacyFatIndex and legacyFatIndex.byId and legacyFatIndex.byId[uuid] then
    local rec = legacyFatIndex.byId[uuid]
    cacheCardRecord(uuid, rec)
    callback(rec)
    return
  end
  fetchCardShard(tokenShardKey(uuid), function(shard)
    local rec = shard and shard[uuid] or nil
    if rec then cacheCardRecord(uuid, rec) end
    callback(rec)
  end, fast)
end

function enrichParentOracleId(parentUuid, parentOracleId, callback, fast)
  if parentOracleId and parentOracleId ~= '' and isUuid(parentOracleId) then
    callback(parentOracleId)
    return
  end
  if not parentUuid or parentUuid == '' then callback(nil) return end
  fetchCardRecordByUuid(parentUuid, function(rec)
    callback(rec and rec.oracle_id or nil)
  end, fast)
end

function cardNameFromTarget(target)
  if not target then return nil end
  local nick = (target.getName() or ''):gsub('%b[]', ''):gsub('^%s+', ''):gsub('%s+$', '')
  local first = nick:match('^([^\n]+)')
  return first and first:gsub('%s+$', '') or nil
end

function fetchRelatedTokensByOracleId(oracleId, callback, fast)
  fetchRelatedTokens(nil, oracleId, callback, fast)
end

function loadTokenDefaults(callback)
  if tokenDefaultsByName then callback(tokenDefaultsByName) return end
  table.insert(tokenDefaultsWaiters, callback)
  if tokenDefaultsLoading then return end
  tokenDefaultsLoading = true
  WebGetSSL(TOKEN_DEFAULTS_URL, function(wr)
    tokenDefaultsLoading = false
    local parsed = nil
    if not wr.is_error and wr.text and wr.text ~= '' then
      parsed = safeJSON(wr.text)
    end
    tokenDefaultsByName = (parsed and parsed.byName) or {}
    tokenR2ImageCdn = (parsed and parsed.r2ImageCdn) or R2_IMAGE_CDN
    tokenR2Fallbacks = {}
    tokenKaiMisses = {}
    if parsed and parsed.r2FallbackUuids then
      for _, uid in ipairs(parsed.r2FallbackUuids) do
        tokenR2Fallbacks[uid] = true
      end
    end
    if parsed and parsed.kaiMissUuids then
      for _, uid in ipairs(parsed.kaiMissUuids) do
        tokenKaiMisses[uid] = true
      end
    end
    for _, cb in ipairs(tokenDefaultsWaiters) do cb(tokenDefaultsByName) end
    tokenDefaultsWaiters = {}
  end)
end

function tokenShardKey(id)
  if not id or id == '' then return '00' end
  return id:sub(1, 2):lower()
end

function fetchTokenShard(shardBase, shardKey, callback, fast)
  if tokenShardCache[shardBase..shardKey] then
    callback(tokenShardCache[shardBase..shardKey])
    return
  end
  local waitKey = shardBase..shardKey
  if not tokenShardWaiters[waitKey] then tokenShardWaiters[waitKey] = {} end
  table.insert(tokenShardWaiters[waitKey], callback)
  if tokenShardLoading[waitKey] then return end
  tokenShardLoading[waitKey] = true

  local httpGet = fast and TokenWebGetSSL or WebGetSSL
  httpGet(shardBase..shardKey..'.json', function(wr)
    tokenShardLoading[waitKey] = false
    local parsed = nil
    if not wr.is_error and wr.text and wr.text ~= '' then
      parsed = safeJSON(wr.text)
    end
    if parsed then tokenShardCache[waitKey] = parsed end
    for _, cb in ipairs(tokenShardWaiters[waitKey] or {}) do cb(parsed) end
    tokenShardWaiters[waitKey] = {}
  end)
end

function fetchRelatedTokens(parentUuid, parentOracleId, callback, fast)
  fast = fast == true
  local hasOid = parentOracleId and parentOracleId ~= '' and isUuid(parentOracleId)
  local hasUuid = parentUuid and parentUuid ~= ''

  local function tryOracle(oracleId)
    if not oracleId or oracleId == '' or not isUuid(oracleId) then
      callback(nil)
      return
    end
    local oKey = tokenShardKey(oracleId)
    fetchTokenShard(TOKEN_SHARD_ORACLE, oKey, function(oShard)
      callback(oShard and oShard[oracleId] or nil)
    end, fast)
  end

  if hasUuid and hasOid then
    local settled = false
    local function deliver(related)
      if settled then return end
      if related and #related > 0 then
        settled = true
        callback(related)
      end
    end
    local pending = 2
    local function checkDone()
      pending = pending - 1
      if pending == 0 and not settled then callback(nil) end
    end
    local key = tokenShardKey(parentUuid)
    fetchTokenShard(TOKEN_SHARD_PARENT, key, function(shard)
      deliver(shard and shard[parentUuid] or nil)
      checkDone()
    end, fast)
    local oKey = tokenShardKey(parentOracleId)
    fetchTokenShard(TOKEN_SHARD_ORACLE, oKey, function(oShard)
      deliver(oShard and oShard[parentOracleId] or nil)
      checkDone()
    end, fast)
    return
  end

  if hasUuid then
    local key = tokenShardKey(parentUuid)
    fetchTokenShard(TOKEN_SHARD_PARENT, key, function(shard)
      if shard and shard[parentUuid] then
        callback(shard[parentUuid])
        return
      end
      enrichParentOracleId(parentUuid, parentOracleId, tryOracle, fast)
    end, fast)
  elseif hasOid then
    tryOracle(parentOracleId)
  else
    callback(nil)
  end
end

function tokenRecordFromEntry(entry)
  if not entry then return { name = 'Token', type_line = 'Token', cmc = 0 } end
  return {
    name = entry.name or 'Token',
    type_line = entry.type_line or 'Token',
    oracle_text = entry.oracle_text or '',
    oracle_id = entry.oracle_id,
    power = entry.power,
    toughness = entry.toughness,
    loyalty = entry.loyalty,
    cmc = entry.cmc or 0,
    imageCdn = entry.imageCdn,
  }
end

function deckSpawnRecord(entry)
  local record = getCachedRecord(entry.uuid)
  if record then return record end
  return {
    name = entry.name,
    oracle_id = entry.oracle_id,
    oracle_text = entry.oracle_text or '',
    type_line = entry.type_line or '',
    cmc = entry.cmc or 0,
  }
end

function decodeQueryName(raw)
  if not raw or raw == '' then return '' end
  return raw:gsub('%%20', ' '):gsub('%%28', '('):gsub('%%29', ')'):gsub('%%3A', ':'):gsub('%%2F', '/')
end

function resolveQueryUuidAsync(rawName, callback)
  local name = decodeQueryName(rawName or '')
  name = name:gsub('^%s+', ''):gsub('%s+$', '')

  local oraclePrefix = name:match('^oracleid:(%S+)')
  if oraclePrefix then
    lookupUuidByOracleId(oraclePrefix, callback)
    return
  end

  local uuid = name:match('(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)')
  if uuid then callback(uuid) return end

  local qty, rest = name:match('^(%d+)%s+(.+)$')
  if qty then name = rest end

  local cardName, setCode, colNum = name:match('^(.+)%s+%(([%w_]+)%)%s+(%S+)$')
  if cardName and setCode and colNum then
    lookupUuidBySetCollector(setCode:lower():gsub('_.*', ''), colNum, callback)
    return
  end

  cardName, setCode, colNum = name:match('^(.+)%s+%[([%w_]+):(%w+)%]')
  if cardName and setCode and colNum then
    lookupUuidBySetCollector(setCode:lower():gsub('_.*', ''), colNum, callback)
    return
  end

  local fuzzyName, fuzzySet = name:match('^(.+)&set=(%w+)$')
  if fuzzyName and fuzzySet then
    local lookupName = decodeQueryName(fuzzyName)
    local setLower = fuzzySet:lower()
    lookupAllUuidsByName(lookupName, function(ids)
      if not ids then callback(nil) return end
      local idx = 1
      local function tryNext()
        if idx > #ids then callback(nil) return end
        local id = ids[idx]
        idx = idx + 1
        fetchCardRecordByUuid(id, function(rec)
          if rec and rec.set == setLower then
            callback(id)
          else
            tryNext()
          end
        end, true)
      end
      tryNext()
    end)
    return
  end

  lookupUuidByName(name, callback)
end

function resolveDeckLine(rest, callback)
  local uuid = rest:match('(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)')
  if uuid then
    callback(uuid, rest:gsub(uuid, ''):gsub('^%s+', ''))
    return
  end
  resolveQueryUuidAsync(rest, function(id)
    callback(id, rest)
  end)
end

function resolveDeckTextEntries(deckText, qTbl, callback)
  local pending = {}
  for line in (deckText or ''):gmatch('[^\r\n]+') do
    line = line:match('^%s*(.-)%s*$')
    if line ~= '' and not line:match('^//') and not line:match('^#')
      and not line:lower():match('^sideboard') and not line:lower():match('^maybeboard') then
      local qty, rest = line:match('^(%d+)%s+(.+)$')
      if not qty then qty, rest = '1', line end
      table.insert(pending, { qty = tonumber(qty) or 1, rest = rest })
    end
  end

  local entries = {}
  local uuids = {}
  local idx = 1

  local function nextLine()
    if idx > #pending then callback(entries, uuids) return end
    local p = pending[idx]
    idx = idx + 1
    resolveDeckLine(p.rest, function(uuid, name)
      if uuid then
        for _ = 1, p.qty do
          table.insert(entries, { uuid = uuid, name = name or p.rest })
          table.insert(uuids, uuid)
        end
      else
        Player[qTbl.color].broadcast('Not in CDN index: '..p.rest, {1, 0.5, 0})
      end
      nextLine()
    end)
  end

  if #pending == 0 then callback(entries, uuids) else nextLine() end
end

function archidektTypeLine(oc)
  if not oc then return '' end
  local parts = {}
  if oc.superTypes then for _, t in ipairs(oc.superTypes) do table.insert(parts, t) end end
  if oc.types then for _, t in ipairs(oc.types) do table.insert(parts, t) end end
  if oc.subTypes then
    if #parts > 0 then parts[#parts] = parts[#parts] .. ' — ' .. table.concat(oc.subTypes, ' ') end
  end
  return table.concat(parts, ' ')
end

function indexRecordToCardObject(uuid, record)
  local card = {
    id = uuid,
    oracle_id = memoWithTokens(record),
    name = record.name,
    type_line = record.type_line or '',
    cmc = record.cmc or 0,
    oracle_text = record.oracle_text or '',
    layout = record.layout or 'normal',
    lang = record.lang or 'en',
    set = record.set,
    collector_number = record.collectorNumber,
    power = record.power,
    toughness = record.toughness,
    loyalty = record.loyalty,
  }

  if record.card_faces and #record.card_faces >= 2 then
    card.card_faces = {}
    for i, face in ipairs(record.card_faces) do
      local faceUuid = face.image_uuid or (i == 1 and uuid or nil)
      local side = (i == 1) and 'front' or 'back'
      table.insert(card.card_faces, {
        name = face.name,
        type_line = face.type_line or '',
        oracle_text = face.oracle_text or '',
        power = face.power,
        toughness = face.toughness,
        loyalty = face.loyalty,
        cmc = face.cmc or record.cmc,
        image_uuid = faceUuid,
        image_uris = faceUuid and { large = cdnImageFromUuid(faceUuid, side) } or nil,
      })
    end
  else
    card.image_uris = { large = cdnImageFromUuid(uuid, 'front') }
  end
  return card
end

function memoWithTokens(record)
  local memo = record.oracle_id or ''
  if record.relatedTokens and #record.relatedTokens > 0 then
    local ids = {}
    for _, tok in ipairs(record.relatedTokens) do
      if tok.uuid then table.insert(ids, tok.uuid) end
    end
    if #ids > 0 then memo = memo .. '|tokens:' .. table.concat(ids, ',') end
  end
  return memo
end

function rawOracleIdFromRecord(record)
  if not record then return nil end
  local oid = record.oracle_id or ''
  if oid:find('|') then oid = oid:match('^([^|]+)') or oid end
  if oid:find('^oracleid:') then oid = oid:match('^oracleid:(.+)$') or oid end
  if oid and isUuid(oid) then return oid end
  return nil
end

function buildMtgEmbedSuffix(oracleId, related)
  if not oracleId or not isUuid(oracleId) then return '' end
  local s = '[mtg:oid=' .. oracleId
  if related and #related > 0 then
    local ids = {}
    for _, tok in ipairs(related) do
      if tok.uuid then table.insert(ids, tok.uuid) end
    end
    if #ids > 0 then s = s .. ';tok=' .. table.concat(ids, ',') end
  end
  return s .. ']'
end

function cardSpawnEmbeds(record, related)
  record = record or {}
  related = related or record.relatedTokens
  local oid = rawOracleIdFromRecord(record)
  local memo = memoWithTokens({ oracle_id = oid, relatedTokens = related })
  local tags = {}
  if oid then table.insert(tags, 'oid:' .. oid) end
  local footer = buildMtgEmbedSuffix(oid, related)
  return memo, tags, footer
end

function enrichRecordRelatedTokens(record, callback)
  if not record then callback(record) return end
  if record.relatedTokens and #record.relatedTokens > 0 then
    callback(record)
    return
  end
  if not oracleCreatesTokens(record.oracle_text or '') then
    callback(record)
    return
  end
  local oid = rawOracleIdFromRecord(record)
  if not oid then callback(record) return end
  fetchRelatedTokensByOracleId(oid, function(related)
    if related and #related > 0 then
      record.relatedTokens = related
      callback(record)
      return
    end
    local parentName = record.name and record.name:gsub('\n.*', '')
    if parentName and parentName ~= '' then
      lookupParentTokensByCardName(parentName, function(fromName)
        if fromName then record.relatedTokens = fromName end
        callback(record)
      end, true)
      return
    end
    callback(record)
  end)
end

function relatedTokensFromMemo(memo)
  if not memo or memo == '' then return nil end
  local tokenStr = memo:match('|tokens:([^|]+)')
  if not tokenStr then return nil end
  local related = {}
  for uuid in tokenStr:gmatch('[^,%s]+') do
    if isUuid(uuid) then
      table.insert(related, { uuid = uuid, name = 'Token' })
    end
  end
  return #related > 0 and related or nil
end

function minimalCardFromUuid(uuid, displayName, record)
  record = record or {}
  return {
    id = uuid,
    oracle_id = memoWithTokens(record),
    name = displayName or record.name or 'Card',
    type_line = record.type_line or '',
    cmc = record.cmc or 0,
    oracle_text = record.oracle_text or '',
    layout = record.layout or 'normal',
    card_faces = record.card_faces,
    image_uris = { large = cdnImageFromUuid(uuid, 'front') },
  }
end

function failNotInCache(qTbl, label)
  Player[qTbl.color].broadcast(
    (label or 'Card')..' not found. Use a deck URL (Archidekt/Moxfield), a card UUID, or hover a card with a '..IMAGE_CDN..' image.',
    {1, 0.3, 0.3}
  )
  if not (qTbl and qTbl.standalone) then endLoop() end
end

function respawnFromTarget(qTbl)
  if not qTbl or not qTbl.target then
    if qTbl and qTbl.color then
      Player[qTbl.color].broadcast('Hover over a card to respawn.', {1, 0, 0})
    end
    return
  end
  local json = cleanSpawnJson(qTbl.target.getJSON())
  if not json or json == '' then return end
  local yRot = 0
  if qTbl.color and Player[qTbl.color] then yRot = Player[qTbl.color].getPointerRotation() end
  spawnObjectJSON({
    json = json,
    position = qTbl.position or qTbl.target.getPosition(),
    rotation = Vector(0, yRot, 0),
  })
end

-- TyrantNomad / Easy Modules ↺ calls Global.ReImport → Importer({ full = "Reimporting Card", ... }).
-- We cannot edit Global; hijack that request and run CDN Respawn (JSON clone) instead of legacy Scryfall spawn.
function isExternalReimportRequest(qTbl)
  return qTbl and qTbl.target and qTbl.full == 'Reimporting Card'
end

function fulfillExternalReimportRequest(qTbl)
  local cardName = (qTbl.name or qTbl.target.getName() or ''):gsub('\n.*', '')
  if cardName == '' then
    if qTbl.color then Player[qTbl.color].broadcast('Card has no name!', {1, 0, 1}) end
    return
  end
  respawnFromTarget(qTbl)
end

function ReImport(tar, ply, alt)
  if not tar then return end
  fulfillExternalReimportRequest({
    target = tar,
    color = ply,
    player = Player[ply].steam_id,
    name = tar.getName():gsub('\n.*', ''),
    position = tar.getPosition() + tar.getTransformForward():scale(-3.2) + Vector(0, 0.025, 0),
    full = 'Reimporting Card',
  })
end

function spawnDeckEntries(entries, qTbl, opts)
  opts = opts or {}
  if #entries == 0 then
    Player[qTbl.color].broadcast('No cards to spawn.', {1, 0, 0})
    endLoop()
    return
  end
  Card.n = 1
  Deck = 1
  qTbl.deck = #entries

  local function spawnAll()
    for i, entry in ipairs(entries) do
      Wait.time(function()
        local shardRec = getCachedRecord(entry.uuid)
        if opts.minimalOnly then
          if shardRec then
            Card(indexRecordToCardObject(entry.uuid, shardRec), qTbl, {})
          else
            Card(minimalCardFromUuid(entry.uuid, entry.name, {}), qTbl, {})
          end
          return
        end
        local record = deckSpawnRecord(entry)
        enrichRecordRelatedTokens(shardRec or record, function(enriched)
          if shardRec and enriched.relatedTokens then shardRec.relatedTokens = enriched.relatedTokens end
          local card = shardRec and indexRecordToCardObject(entry.uuid, shardRec)
            or minimalCardFromUuid(entry.uuid, entry.name, enriched)
          Card(card, qTbl, enriched)
        end)
      end, i * Tick)
    end
  end

  local uuids = {}
  for _, entry in ipairs(entries) do
    if entry.uuid then table.insert(uuids, entry.uuid) end
  end
  ensureCardRecords(uuids, function()
    spawnAll()
  end)
end

function spawnDeckFromText(deckText, qTbl)
  loadIndexManifest(function()
    resolveDeckTextEntries(deckText, qTbl, function(entries, uuids)
      ensureCardRecords(uuids, function()
        spawnDeckEntries(entries, qTbl)
      end)
    end)
  end)
end

function fetchArchidektDeck(deckUrl, qTbl)
  local deckId = deckUrl:match('archidekt%.com/decks/(%d+)')
  if not deckId then
    Player[qTbl.color].broadcast('Invalid Archidekt URL', {1, 0, 0})
    endLoop()
    return
  end
  WebGetSSL('https://archidekt.com/api/decks/'..deckId..'/cards/', function(wr)
    if webRequestFailed(wr, qTbl, 'Archidekt') then return end
    local data = safeJSON(wr.text)
    if not data then endLoop() return end
    local rows = type(data) == 'table' and (data.cards or data) or {}
    local entries = {}
    for _, row in ipairs(rows) do
      local card = row.card
      if card and card.uid then
        local oc = card.oracleCard
        local name = (oc and oc.name) or card.displayName or 'Card'
        local qty = row.quantity or 1
        local entry = {
          uuid = card.uid,
          name = name,
          oracle_text = oc and oc.text or '',
          type_line = archidektTypeLine(oc),
          cmc = oc and oc.cmc or 0,
        }
        for _ = 1, qty do table.insert(entries, entry) end
      end
    end
    spawnDeckEntries(entries, qTbl)
  end)
end

function fetchMoxfieldDeck(deckUrl, qTbl)
  local deckId = deckUrl:match('moxfield%.com/decks/([^/%?]+)')
  if not deckId then
    Player[qTbl.color].broadcast('Invalid Moxfield URL', {1, 0, 0})
    endLoop()
    return
  end
  WebGetSSL('https://api2.moxfield.com/v2/decks/all/'..deckId..'/', function(wr)
    if webRequestFailed(wr, qTbl, 'Moxfield') then return end
    local data = safeJSON(wr.text)
    if not data then endLoop() return end
    local entries = {}
    local function addBoard(board)
      for _, entry in pairs(board or {}) do
        local card = entry.card
        if card and card.scryfall_id then
          local qty = entry.quantity or 1
          for _ = 1, qty do
            table.insert(entries, { uuid = card.scryfall_id, name = card.name or 'Card' })
          end
        end
      end
    end
    addBoard(data.commanders)
    addBoard(data.companions)
    addBoard(data.mainboard)
    spawnDeckEntries(entries, qTbl)
  end, {
    ['User-Agent'] = USER_AGENT,
    ['Accept'] = 'application/json',
    ['Referer'] = 'https://www.moxfield.com/',
  })
end

function spawnFromCdnQuery(qTbl)
  local light = qTbl.lightSpawn == true
  local function spawnUuid(uuid)
    if not uuid then
      failNotInCache(qTbl, decodeQueryName(qTbl.name):gsub('\n.*', ''))
      return
    end
    ensureCardRecords({uuid}, function()
      local record = getCachedRecord(uuid)
      if record then
        if light then
          Card(indexRecordToCardObject(uuid, record), qTbl, record)
        else
          enrichRecordRelatedTokens(record, function(enriched)
            Card(indexRecordToCardObject(uuid, enriched), qTbl, enriched)
          end)
        end
      else
        Card(minimalCardFromUuid(uuid, decodeQueryName(qTbl.name), record), qTbl)
      end
    end)
  end

  if qTbl.target then
    local hoverUuid = faceUuidFromTarget(qTbl.target) or uuidFromCdnUrl(faceUrlFromJson(qTbl.target.getJSON()))
    if hoverUuid then spawnUuid(hoverUuid) return end
  end

  local rawName = decodeQueryName(qTbl.name or ''):gsub('^%s+', ''):gsub('%s+$', '')
  local inlineUuid = rawName:match('(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)')
  if inlineUuid then spawnUuid(inlineUuid) return end

  loadIndexManifest(function()
    resolveQueryUuidAsync(qTbl.name, spawnUuid)
  end)
end

function getTokenSpawnTransform(qTbl)
  local spawnPos, spawnRot
  if qTbl.target then
    spawnPos = qTbl.target.positionToWorld({-2.5, 0.5, 0})
    spawnRot = qTbl.target.getRotation()
  else
    local rawPos = qTbl.position or self.getPosition()
    if type(rawPos) == 'table' and not rawPos.x then
      rawPos = Vector(rawPos[1] or 0, rawPos[2] or 0, rawPos[3] or 0)
    end
    spawnPos = rawPos + Vector(2, 0.5, 0)
    local yRot = 0
    if Player[qTbl.color] then yRot = Player[qTbl.color].getPointerRotation() end
    spawnRot = Vector(0, yRot, 0)
  end
  return spawnPos, spawnRot
end


function collectTokenEntries(related, parentUuid)
  local tokens = {}
  local seen = {}
  for _, part in ipairs(related) do
    local tokenUuid = part.uuid or part.id
    if tokenUuid and not seen[tokenUuid] and tokenUuid ~= parentUuid then
      seen[tokenUuid] = true
      local tokenRec = getCachedRecord(tokenUuid)
      if not tokenRec then
        tokenRec = tokenRecordFromEntry(part)
      end
      if not tokenRec.name or tokenRec.name == '' then
        tokenRec.name = part.name or 'Token'
      end
      if not tokenRec.type_line then tokenRec.type_line = 'Token' end
      table.insert(tokens, {uuid = tokenUuid, record = tokenRec})
    end
  end
  return tokens
end

function buildTokenCardDat(n, uuid, record, back)
  local faceUrl = faceUrlFromUuid(uuid, record.imageCdn)
  local cmc = record.cmc or 0
  local nickname = record.name:gsub('"', '')..'\n'..(record.type_line or 'Token')..'\n'..cmc..'CMC'
  local oracle = setOracle({
    oracle_text = record.oracle_text or '',
    power = record.power,
    toughness = record.toughness,
    loyalty = record.loyalty,
  })
  return {
    Transform = {posX=0, posY=0, posZ=0, rotX=0, rotY=0, rotZ=0, scaleX=1, scaleY=1, scaleZ=1},
    Name = 'Card',
    Nickname = nickname,
    Description = oracle,
    Memo = record.oracle_id or '',
    CardID = n * 100,
    CustomDeck = {[tostring(n)] = {
      FaceURL = faceUrl,
      BackURL = back,
      NumWidth = 1,
      NumHeight = 1,
      Type = 0,
      BackIsHidden = true,
      UniqueBack = false,
    }},
  }
end

function spawnTokenDeck(qTbl, tokens)
  loadTokenDefaults(function()
    if #tokens == 0 then
      Player[qTbl.color].broadcast('No related tokens for '..qTbl.name, {1,0.5,0})
      if not qTbl.standalone then endLoop() end
      return
    end

    local spawnPos, spawnRot = getTokenSpawnTransform(qTbl)
    local back = DEFAULT_BACK
    local yRot = 0
    if Player[qTbl.color] then yRot = Player[qTbl.color].getPointerRotation() end

    if #tokens == 1 then
      spawnObjectData({
        data = buildTokenCardDat(1, tokens[1].uuid, tokens[1].record, back),
        position = spawnPos,
        rotation = spawnRot or Vector(0, yRot, 0),
      })
    else
      local deckDat = {
        Transform = {posX=0, posY=0, posZ=0, rotX=0, rotY=0, rotZ=0, scaleX=1, scaleY=1, scaleZ=1},
        Name = 'Deck',
        Nickname = 'Tokens',
        Description = qTbl.name,
        DeckIDs = {},
        CustomDeck = {},
        ContainedObjects = {},
      }
      for i, tok in ipairs(tokens) do
        local cardDat = buildTokenCardDat(i, tok.uuid, tok.record, back)
        deckDat.DeckIDs[i] = cardDat.CardID
        deckDat.CustomDeck[tostring(i)] = cardDat.CustomDeck[tostring(i)]
        deckDat.ContainedObjects[i] = cardDat
      end
      spawnObjectData({
        data = deckDat,
        position = spawnPos,
        rotation = Vector(0, yRot, 180),
      })
    end
  if not qTbl.standalone then endLoop() end
  end)
end

function spawnRelatedTokens(qTbl, related, parentUuid)
  spawnTokenDeck(qTbl, collectTokenEntries(related, parentUuid))
end

function backfillTokenEmbedOnTarget(target, qTbl, related, oracleId)
  if not target or not related or #related == 0 then return end
  local oid = oracleId
  if (not oid or not isUuid(oid)) and target.memo then
    oid = oracleIdFromMemo(target.memo)
  end
  if (not oid or not isUuid(oid)) and qTbl then
    local _, embeddedOid = parentIdsFromTarget(target, qTbl)
    oid = embeddedOid
  end

  local memo = memoWithTokens({ oracle_id = oid, relatedTokens = related })
  if memo and memo ~= '' then target.setMemo(memo) end

  local desc = target.getDescription() or ''
  if not desc:find('%[mtg:') then
    local footer = buildMtgEmbedSuffix(oid, related)
    if footer ~= '' then
      if desc:find('%S') then desc = desc .. '\n' end
      target.setDescription(desc .. footer)
    end
  end

  if oid and isUuid(oid) then
    local tags = target.getTags() or {}
    local hasOid = false
    for _, tag in ipairs(tags) do
      if tag:match('^oid:') then hasOid = true break end
    end
    if not hasOid then
      table.insert(tags, 'oid:' .. oid)
      target.setTags(tags)
    end
  end
end

function spawnRelatedTokensWithBackfill(qTbl, related, parentUuid, oracleId)
  spawnRelatedTokens(qTbl, related, parentUuid)
  if qTbl.target then
    backfillTokenEmbedOnTarget(qTbl.target, qTbl, related, oracleId)
  end
end

local AMBIGUOUS_TOKEN_NAMES = {
  elemental=true, goblin=true, elf=true, spirit=true, zombie=true, human=true,
  warrior=true, vampire=true, beast=true, soldier=true, angel=true, dragon=true,
  bird=true, cat=true, copy=true, shapeshifter=true, insect=true, plant=true,
  thopter=true, myr=true, construct=true, servo=true, gnome=true, citizen=true,
  ['elf warrior']=true, ['human warrior']=true, ['human soldier']=true,
  ['goblin warrior']=true, ['zombie army']=true,
}

function isAmbiguousTokenName(norm)
  return norm and AMBIGUOUS_TOKEN_NAMES[norm] == true
end

function indexLookupByTokenName(name)
  if not legacyFatIndex or not legacyFatIndex.byExactName then return nil, nil end
  local ids = legacyFatIndex.byExactName[normalizeIndexName(name)]
  if not ids then return nil, nil end
  for _, id in ipairs(ids) do
    local rec = legacyFatIndex.byId and legacyFatIndex.byId[id] or getCachedRecord(id)
    if rec and (rec.layout == 'token' or (rec.type_line or ''):find('Token')) then
      return rec, id
    end
  end
  return nil, nil
end

function normalizeTokenLookupName(raw)
  if not raw or raw == '' then return '' end
  raw = raw:gsub('^%s+', ''):gsub('%s+$', '')
  raw = raw:gsub('^a%s+', ''):gsub('^an%s+', ''):gsub('^%d+%s+', '')
  raw = raw:gsub('^%d+/%d+%s+', '')
  for _, color in ipairs({'white','blue','black','red','green','colorless'}) do
    if raw:lower():find('^'..color..'%s+') then
      raw = raw:gsub('^%S+%s+', '', 1)
      break
    end
  end
  raw = raw:gsub('%s+creature%s*$', ''):gsub('%s+artifact%s*$', ''):gsub('%s+enchantment%s*$', '')
  raw = raw:gsub('%s+tokens?$', ''):gsub('^%s+', ''):gsub('%s+$', '')
  return raw
end

function resolveTokenUuidByName(name, defaults, opts)
  defaults = defaults or tokenDefaultsByName or {}
  opts = opts or {}
  local allowAmbiguous = opts.allowAmbiguousDefaults ~= false
  local clean = normalizeTokenLookupName(name)
  if clean == '' then return nil, nil end
  local norm = normalizeIndexName(clean)

  local rec, id = indexLookupByTokenName(clean)
  if rec then return id, rec end

  if defaults[norm] and (allowAmbiguous or not isAmbiguousTokenName(norm)) then
    local uid = defaults[norm]
    local rec = { name = clean, type_line = 'Token' }
    if tokenR2Fallbacks[uid] then rec.imageCdn = tokenR2ImageCdn end
    return uid, rec
  end

  local bestKey, bestLen = nil, 0
  for key, uuid in pairs(defaults) do
    if norm == key or (norm:find(key, 1, true) and #key > bestLen) then
      if allowAmbiguous or not isAmbiguousTokenName(key) then
        bestKey, bestLen = key, #key
      end
    end
  end
  if bestKey then
    local uid = defaults[bestKey]
    local rec = { name = clean, type_line = 'Token' }
    if tokenR2Fallbacks[uid] then rec.imageCdn = tokenR2ImageCdn end
    return uid, rec
  end

  return nil, nil
end

function oracleCreatesTokens(text)
  if not text or text == '' then return false end
  local lower = text:lower()
  if lower:find('would create one or more tokens') then return false end
  if lower:find('twice that many of those tokens') then return false end
  if lower:find('twice as many') and lower:find('token') then return false end
  if lower:find('three times that many') and lower:find('token') then return false end
  if lower:find('nontoken') then return false end
  if lower:find('untapped tokens') and not lower:find('create') then return false end
  if lower:find('tokens you control') and not lower:find('create') then return false end
  if lower:find('token you control') and not lower:find('create') then return false end
  if lower:find('for each token') and not lower:find('create') then return false end
  if lower:find('whenever one or more tokens') and not lower:find('create') then return false end
  if lower:find('whenever a token') and not lower:find('create') then return false end
  if lower:find("'s a token or") or lower:find("that's a token or") then return false end
  if lower:find('create') and lower:find('token') then return true end
  if lower:find('offspring') then return true end
  if lower:find("that's a copy") then return true end
  if lower:find('create a food') or lower:find('create a treasure') then return true end
  if lower:find('create a clue') or lower:find('create a blood') then return true end
  if lower:find('create') and lower:find('food token') then return true end
  if lower:find('create') and lower:find('treasure token') then return true end
  return false
end

function oracleCreatesEmblem(text)
  if not text or text == '' then return false end
  local lower = text:lower()
  if lower:find('get an emblem') then return true end
  if lower:find('you get ') and lower:find(' emblem') then return true end
  if lower:find('creates ') and lower:find(' emblem') then return true end
  return false
end

function oracleExpectsRelatedParts(text)
  return oracleCreatesTokens(text) or oracleCreatesEmblem(text)
end

function relatedTokensFromCardRecord(rec)
  if not rec or not rec.relatedTokens or #rec.relatedTokens == 0 then return nil end
  local out = {}
  for _, tok in ipairs(rec.relatedTokens) do
    if tok.uuid then
      table.insert(out, { uuid = tok.uuid, name = tok.name or 'Token' })
    end
  end
  return #out > 0 and out or nil
end

function parseTokenNamesFromOracle(text)
  local names, seen = {}, {}
  if not text or text == '' then return names end

  local function add(raw)
    local clean = normalizeTokenLookupName(raw)
    if clean == '' then return end
    local key = normalizeIndexName(clean)
    if key:find('^create') or key:find('whenever') or key:find('^if ') or key:find('^at ') then return end
    if key:find('for each') or key:find('token you control') then return end
    if seen[key] then return end
    seen[key] = true
    table.insert(names, clean)
  end

  for sentence in (text..'.'):gmatch('[^%.!?\n]+') do
    local lower = sentence:lower()
    if lower:find('token') and not lower:find('token copy of') then
      sentence:gsub('"([^"]+)"', function(q)
        if sentence:lower():find(q:lower()) then add(q) end
        return q
      end)
      local created = sentence:match('[Cc]reate(.-[Tt]okens?)')
      if created and not created:lower():find('token copy') then add(created) end
      for n in sentence:gmatch('(%a[%a%-%/%d%s]+)[Tt]oken') do
        local nLower = n:lower()
        if not nLower:find('create') and not nLower:find('^copy$') and not nLower:find('for each') then
          add(n)
        end
      end
    end
  end
  return names
end

function parseEmblemNamesFromOracle(text)
  local names, seen = {}, {}
  if not text or text == '' then return names end

  local function add(raw)
    local clean = normalizeTokenLookupName(raw)
    if clean == '' then return end
    local key = normalizeIndexName(clean)
    if seen[key] then return end
    seen[key] = true
    table.insert(names, clean)
  end

  for sentence in (text..'.'):gmatch('[^%.!?\n]+') do
    local lower = sentence:lower()
    if lower:find('emblem') then
      sentence:gsub('"([^"]+)"', function(q)
        if sentence:lower():find(q:lower()) then add(q) end
        return q
      end)
      for n in sentence:gmatch("(%a[%a%-'%s]+)[Ee]mblem") do
        local nLower = n:lower():gsub('^%s+', ''):gsub('%s+$', '')
        if nLower ~= '' and not nLower:find('^an? ') and not nLower:find('^the ') then
          add(n)
        end
      end
    end
  end
  return names
end

function tokensFromOracleText(oracleText, defaults, opts)
  local out = {}
  local seen = {}
  local function addEntry(uuid, rec, name)
    if not uuid or seen[uuid] then return end
    seen[uuid] = true
    table.insert(out, { uuid = uuid, record = rec or { name = name or 'Token', type_line = 'Token' } })
  end
  for _, name in ipairs(parseTokenNamesFromOracle(oracleText)) do
    local uuid, rec = resolveTokenUuidByName(name, defaults, opts)
    if uuid then addEntry(uuid, rec, name) end
  end
  for _, name in ipairs(parseEmblemNamesFromOracle(oracleText)) do
    local emblemName = name
    if not emblemName:lower():find('emblem') then
      emblemName = emblemName .. ' Emblem'
    end
    local uuid, rec = resolveTokenUuidByName(emblemName, defaults, opts)
    if uuid then addEntry(uuid, rec, emblemName) end
  end
  return out
end

function spawnTokensFromOracle(qTbl, oracleText, defaults, opts)
  local tokens = tokensFromOracleText(oracleText, defaults, opts)
  if #tokens == 0 then return false end
  spawnTokenDeck(qTbl, tokens)
  return true
end

function finishTokenLookup(qTbl, parentUuid, parentOracleId, fromHover, expectsTokens, onSettled)
  fromHover = fromHover == true
  expectsTokens = expectsTokens == true
  local oracleText = ''
  if qTbl.target then oracleText = qTbl.target.getDescription() or '' end
  if not expectsTokens then expectsTokens = oracleExpectsRelatedParts(oracleText) end
  local resolveOpts = { allowAmbiguousDefaults = false }

  local function markSettled()
    if onSettled then onSettled() end
  end

  local function noTokensFound()
    markSettled()
    if expectsTokens then
      Player[qTbl.color].broadcast(
        'Token data not found for this card. Try reimporting the deck, or check metadata CDN.',
        {1, 0.5, 0}
      )
    else
      Player[qTbl.color].broadcast(
        'This card does not create tokens.',
        {0.8, 0.8, 0.5}
      )
    end
    if not qTbl.standalone then endLoop() end
  end

  local cardName = qTbl.target and cardNameFromTarget(qTbl.target)
  lookupParentTokensByCardName(cardName or '', function(fromName)
    loadTokenDefaults(function(defaults)
      if fromName and #fromName > 0 then
        markSettled()
        spawnRelatedTokensWithBackfill(qTbl, fromName, parentUuid, parentOracleId)
        return
      end

      if qTbl.target and spawnTokensFromOracle(qTbl, oracleText, defaults, resolveOpts) then
        markSettled()
        return
      end

      local tokenName = decodeQueryName(qTbl.name):gsub('\n.*', '')
      local tokenUuid, tokenRec = resolveTokenUuidByName(tokenName, defaults, resolveOpts)
      if tokenUuid then
        markSettled()
        spawnTokenDeck(qTbl, { { uuid = tokenUuid, record = tokenRec } })
        return
      end

      tokenUuid = tokenName:match('(%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x)')
      if tokenUuid then
        markSettled()
        spawnTokenDeck(qTbl, { { uuid = tokenUuid, record = tokenRecordFromEntry({ uuid = tokenUuid, name = 'Token' }) } })
        return
      end

      noTokensFound()
    end)
  end, true)
end

function targetHasEmbeddedTokens(target)
  if not target then return false end
  local memoRelated = relatedTokensFromMemo(target.memo)
  if memoRelated and #memoRelated > 0 then return true end
  local descRelated = relatedTokensFromDescription(target.getDescription() or '')
  return descRelated ~= nil and #descRelated > 0
end

function broadcastNoTokensForCard(qTbl)
  Player[qTbl.color].broadcast('This card does not create tokens.', {0.8, 0.8, 0.5})
  if not qTbl.standalone then endLoop() end
end

function cardLikelyCreatesTokens(target)
  if not target then return false end
  if targetHasEmbeddedTokens(target) then return true end
  local desc = target.getDescription() or ''
  if oracleExpectsRelatedParts(desc) then return true end
  return false
end

-- Tiered token resolution: parent name map → embeds → token shards → defaults (no 2MB name-oracle-map).
function resolveTokensForTarget(qTbl, callback)
  local target = qTbl.target
  local uuid, oracleId = nil, nil
  if target then
    uuid, oracleId = parentIdsFromTarget(target, qTbl)
  end

  if not target then
    callback(nil, uuid, oracleId)
    return
  end

  local tryDefaultsFallback
  local tryLightIdentity
  local tryTokenShards
  local continueShardCascade
  local afterParentNameMiss

  tryDefaultsFallback = function(resolvedOid)
    loadTokenDefaults(function(defaults)
      local oracleText = target.getDescription() or ''
      local resolveOpts = { allowAmbiguousDefaults = false }
      if spawnTokensFromOracle(qTbl, oracleText, defaults, resolveOpts) then
        callback('__spawned__', uuid, resolvedOid)
        return
      end
      callback(nil, uuid, resolvedOid)
    end)
  end

  tryLightIdentity = function(priorOid)
    resolveOracleIdLight(target, qTbl, function(lightOid, lightUuid, _)
      if lightUuid and lightUuid ~= '' then uuid = lightUuid end
      if lightOid and isUuid(lightOid) and lightOid ~= priorOid then
        fetchRelatedTokensByOracleId(lightOid, function(related)
          if related and #related > 0 then
            callback(related, uuid, lightOid)
            return
          end
          tryDefaultsFallback(lightOid)
        end, true)
      else
        tryDefaultsFallback(priorOid or lightOid)
      end
    end, true)
  end

  tryTokenShards = function(rec)
    local oid = oracleId
    if rec and rec.oracle_id and isUuid(rec.oracle_id) then oid = rec.oracle_id end
    fetchRelatedTokens(uuid, oid, function(related)
      if related and #related > 0 then
        callback(related, uuid, oid)
        return
      end
      tryLightIdentity(oid)
    end, true)
  end

  continueShardCascade = function()
    if uuid and uuid ~= '' then
      fetchCardRecordByUuid(uuid, function(rec)
        local fromRec = relatedTokensFromCardRecord(rec)
        if fromRec and #fromRec > 0 then
          callback(fromRec, uuid, rec and rec.oracle_id or oracleId)
          return
        end
        tryTokenShards(rec)
      end, true)
      return
    end

    if oracleId and isUuid(oracleId) then
      fetchRelatedTokensByOracleId(oracleId, function(related)
        if related and #related > 0 then
          callback(related, uuid, oracleId)
          return
        end
        tryLightIdentity(oracleId)
      end, true)
      return
    end

    tryLightIdentity(nil)
  end

  afterParentNameMiss = function()
    local memoRelated = relatedTokensFromMemo(target.memo)
    if memoRelated and #memoRelated > 0 then
      callback(memoRelated, uuid, oracleId)
      return
    end

    local descRelated = relatedTokensFromDescription(target.getDescription() or '')
    if descRelated and #descRelated > 0 then
      callback(descRelated, uuid, oracleId)
      return
    end

    continueShardCascade()
  end

  local cardName = cardNameFromTarget(target)
  lookupParentTokensByCardName(cardName or '', function(fromName)
    if fromName and #fromName > 0 then
      callback(fromName, uuid, oracleId)
      return
    end
    afterParentNameMiss()
  end, true)
end

function debugTokenResolution(qTbl)
  local target = qTbl.target
  local player = qTbl.color and Player[qTbl.color]
  if not player then return end
  if not target then
    player.broadcast(
      'No card under pointer. Keep the laser on a card while pressing Enter, or use Encoder → Emblem And Tokens.',
      {1, 0.5, 0}
    )
    return
  end

  player.broadcast('Token debug running...', {0.7, 0.85, 1})

  local settled = false
  local function finish(msg, color)
    if settled then return end
    settled = true
    player.broadcast(msg, color or {0.7, 0.9, 1})
  end

  Wait.time(function()
    finish('Token debug timed out. CDN unreachable or import queue stuck — try `Importer clear queue`.', {1, 0.3, 0.3})
  end, TOKEN_WEB_TIMEOUT * 3)

  local lines = {}
  local faceUuid, memoOid = parentIdsFromTarget(target, qTbl)
  table.insert(lines, 'Face UUID: ' .. (faceUuid or 'none'))
  table.insert(lines, 'Memo/Tags oracle: ' .. (memoOid or 'none'))

  local setCode, colNum = setCollectorFromTarget(target)
  if setCode then
    table.insert(lines, 'Set+collector: ' .. setCode .. ' #' .. colNum)
  end

  local cardName = cardNameFromTarget(target)
  if cardName then
    table.insert(lines, 'Card name: ' .. cardName)
    table.insert(lines, 'Name shard: ' .. parentNameShardKey(cardName))
  end

  local memoRelated = relatedTokensFromMemo(target.memo)
  if memoRelated and #memoRelated > 0 then
    table.insert(lines, 'Memo tokens: ' .. #memoRelated)
  end

  local descRelated = relatedTokensFromDescription(target.getDescription() or '')
  if descRelated and #descRelated > 0 then
    table.insert(lines, 'Footer tokens: ' .. #descRelated)
  end

  lookupParentTokensByCardName(cardName or '', function(fromName)
    if cardName and fromName then
      table.insert(lines, 'Parent name map: ' .. #fromName .. ' token(s)')
    elseif cardName then
      table.insert(lines, 'Parent name map: miss')
    end

    resolveTokensForTarget(qTbl, function(related, resolvedUuid, resolvedOid)
      if settled then return end
      if related == '__spawned__' then
        table.insert(lines, 'Tokens: spawned via oracle parse')
        finish(table.concat(lines, '\n'))
        return
      end
      if related and #related > 0 then
        table.insert(lines, 'Tokens (' .. #related .. '):')
        for _, t in ipairs(related) do
          table.insert(lines, '  ' .. (t.name or 'Token') .. ' ' .. (t.uuid or ''))
        end
      else
        table.insert(lines, 'Tokens: none')
      end
      if resolvedOid then
        table.insert(lines, 'Resolved oracle: ' .. resolvedOid)
      end
      if resolvedUuid then
        table.insert(lines, 'Resolved UUID: ' .. resolvedUuid)
      end
      finish(table.concat(lines, '\n'))
    end)
  end, true)
end

function spawnTokensForCard(qTbl)
  if qTbl.target and not cardLikelyCreatesTokens(qTbl.target) then
    broadcastNoTokensForCard(qTbl)
    return
  end

  local settled = false
  local oracleText = qTbl.target and (qTbl.target.getDescription() or '') or ''
  local expectsTokens = oracleExpectsRelatedParts(oracleText)

  local function tokenFail(msg)
    if settled then return end
    settled = true
    Player[qTbl.color].broadcast(msg or 'Token lookup failed.', {1, 0.3, 0.3})
    if not qTbl.standalone then endLoop() end
  end
  Wait.time(function()
    tokenFail('Token import timed out. Metadata CDN may be unreachable from TTS.')
  end, TOKEN_WEB_TIMEOUT * 4)

  if qTbl.target then
    Player[qTbl.color].broadcast('Looking up tokens...', {0.7, 0.85, 1})
  end

  local uuid, oracleId = nil, nil
  if qTbl.target then
    uuid, oracleId = parentIdsFromTarget(qTbl.target, qTbl)
  end

  resolveTokensForTarget(qTbl, function(related, resolvedUuid, resolvedOid)
    if settled then return end
    if related == '__spawned__' then
      settled = true
      if not qTbl.standalone then endLoop() end
      return
    end
    if related and #related > 0 then
      settled = true
      spawnRelatedTokensWithBackfill(qTbl, related, resolvedUuid or uuid, resolvedOid or oracleId)
      return
    end
    finishTokenLookup(qTbl, resolvedUuid or uuid, resolvedOid or oracleId, qTbl.target ~= nil, expectsTokens, function()
      settled = true
    end)
  end)
end

function safeJSON(text)
  if not text or text == '' then return nil end
  if text:find('^%s*<') then return nil end -- HTML check
  local ok, res = pcall(JSON.decode, text)
  if ok then return res else return nil end
end

--[[Card Spawning Class]]
-- pieHere:
-- replaced spawnObjectJSON with spawnObjectData, cuz TTS's JSON stuff sucks anyways
-- spawning deck old-school style, not one card at a time
-- added a pcall "restart on error" just in case
Card=setmetatable({n=1,image=false},
  {__call=function(t,c,qTbl,spawnRecord)
    success,errorMSG=pcall(function()
      spawnRecord = spawnRecord or {}
      --NeededFeilds in c:name,type_line,cmc,card_faces,oracle_text,power,toughness,loyalty
      c.face,c.oracle,c.back='','',DEFAULT_BACK
      local n,state=t.n,false
      t.n=n+1

			local orientation={false}--Tabletop Card Sideways
			--Oracle text Handling for Split then DFC then Normal
      if c.card_faces and c.image_uris then--Adventure/Split face.type_line:find('Room')
				local instantSorcery=0
        for i,f in ipairs(c.card_faces)do
					f.name=f.name:gsub('"','')..'\n'..f.type_line..'\n'..c.cmc..'CMC'
          if i==1 then c.name=f.name end
          c.oracle=c.oracle..f.name..'\n'..setOracle(f)..(i==#c.card_faces and''or'\n')
					
					--Count nonPermanent text boxes, exclude Aftermath
					if c.layout and ('split'):find(c.layout) and c.oracle and not c.oracle:find('Aftermath') then
						instantSorcery=1+instantSorcery end
				end
				if instantSorcery==2 then--Split/Fuse
					orientation[1]=true end

			elseif c.card_faces then--DFC
				local f=c.card_faces[1]
				local cmc=c.cmc or f.cmc or 0
        c.name=f.name:gsub('"','')..'\n'..f.type_line..'\n'..cmc..'CMC DFC'
        c.oracle=setOracle(f)
				for i,face in ipairs(c.card_faces)do
					local tl = face.type_line or ''
					if tl:find('Battle') or tl:find('Room') then
						orientation[i]=true
					else
						orientation[i]=false
					end
				end
			else--NORMAL
        c.name=(c.name or 'Card'):gsub('"','')..'\n'..(c.type_line or '')..'\n'..(c.cmc or 0)..'CMC'
        if c.set and c.collector_number then
          c.name = c.name .. '\n· ' .. c.set:lower() .. ' #' .. c.collector_number
        end
        c.oracle=setOracle(c)
				if c.layout and ('planar'):find(c.layout) then orientation[1]=true end
      end

      local backDat=nil
      --Image Handling
      if qTbl.deck and qTbl.image and qTbl.image[n] then
        c.face=cleanImageUrl(qTbl.image[n])
      elseif c.card_faces and not c.image_uris then --DFC REWORKED for STATES!
        local frontUuid = c.id or (c.card_faces[1] and c.card_faces[1].image_uuid)
        local backUuid = (c.card_faces[2] and c.card_faces[2].image_uuid) or frontUuid
        local faceAddress = cachedImageUri(c.card_faces[1].image_uris, frontUuid, 'front')
        local backAddress = cachedImageUri(c.card_faces[2].image_uris, backUuid, 'back')
        if faceAddress:find('/back/') and backAddress:find('/front/') then
          local temp=faceAddress;faceAddress=backAddress;backAddress=temp end
        if t.image then faceAddress,backAddress=t.image,t.image end
        c.face=faceAddress
        local f=c.card_faces[2]
				local cmc=c.cmc or f.cmc or 0
        local name=f.name:gsub('"','')..'\n'..f.type_line..'\n'..cmc..'CMC DFC'
        local oracle=setOracle(f)
        local b=n
				
        if qTbl.deck then b=qTbl.deck+n end
        backDat={
          Transform={posX=0,posY=0,posZ=0,rotX=0,rotY=0,rotZ=0,scaleX=1,scaleY=1,scaleZ=1},
          Name="Card",
          Nickname=name,
          Description=oracle,
          Memo=c.oracle_id,
          CardID=b*100,
          CustomDeck={[b]={
							FaceURL=backAddress,
							BackURL=c.back,
							NumWidth=1,NumHeight=1,Type=0,
							BackIsHidden=true,UniqueBack=false}},
        }
      elseif t.image then --Custom Image
        c.face=cleanImageUrl(t.image)
        t.image=false
      elseif c.image_uris or c.id then
        c.face=cachedImageUri(c.image_uris, c.id, 'front')
      elseif c.card_faces and c.card_faces[1] then
        local frontUuid = c.id or c.card_faces[1].image_uuid
        c.face=cachedImageUri(c.card_faces[1].image_uris, frontUuid, 'front')
      end
      if c.face=='' or not c.face then
        Player[qTbl.color].broadcast('No image for '..c.name:gsub('\n.*',''),{1,0.5,0})
      end

      local embedMemo, embedTags, embedFooter = cardSpawnEmbeds(spawnRecord, spawnRecord.relatedTokens)
      if embedMemo and embedMemo ~= '' then c.oracle_id = embedMemo end
      if embedFooter and embedFooter ~= '' then
        c.oracle = (c.oracle or '') .. '\n' .. embedFooter
      end

      -- prepare cardDat
      local cardDat={
        Transform={posX=0,posY=0,posZ=0,rotX=0,rotY=0,rotZ=0,scaleX=1,scaleY=1,scaleZ=1},
        Name="Card",
        Nickname=c.name,
        Description=c.oracle,
        Memo=c.oracle_id,
        Tags=embedTags,
        CardID=n*100,
        CustomDeck={[n]={
						FaceURL=c.face,
						BackURL=c.back,
						NumWidth=1,NumHeight=1,Type=0,
						BackIsHidden=true,UniqueBack=false}},
      }
			
      if backDat then --backface is state#2
        cardDat.States={[2]=backDat}end
			
			local landscapeView={0,180,270}
			--AltView
			if orientation[1]then cardDat.AltLookAngle=landscapeView end
			if orientation[2]then cardDat.States[2].AltLookAngle=landscapeView end

      -- Spawn
      if not(qTbl.deck) or qTbl.deck==1 then        --Spawn solo card
        local spawnDat={
          data=cardDat,
          position=qTbl.position or {0,2,0},
          rotation=Vector(0,Player[qTbl.color].getPointerRotation(),0)
        }
        spawnObjectData(spawnDat)
        if not qTbl.standalone then endLoop() end
      else                          --Spawn deck
        if Deck==1 then             --initialize deckDat
          deckDat={}
          deckDat={
            Transform={posX=0,posY=0,posZ=0,rotX=0,rotY=0,rotZ=0,scaleX=1,scaleY=1,scaleZ=1},
            Name="Deck",
            Nickname=Player[qTbl.color].steam_name or "Deck",
            Description=qTbl.full or "Deck",
            DeckIDs={},
            CustomDeck={},
            ContainedObjects={},
          }
        end
        deckDat.DeckIDs[Deck]=cardDat.CardID      -- add card info into deckDat
        deckDat.CustomDeck[n]=cardDat.CustomDeck[n]
        deckDat.ContainedObjects[Deck]=cardDat
        if Deck<qTbl.deck then
          if qTbl.text then qTbl.text('Spawning here\n'..Deck..' cards loaded') end
          Deck=Deck+1
        elseif Deck==qTbl.deck then
          local spawnDat={
            data=deckDat,
            position=qTbl.position or {0,2,0},
            rotation=Vector(0,Player[qTbl.color].getPointerRotation(),180)
          }
          spawnObjectData(spawnDat)
          Player[qTbl.color].broadcast('All '..Deck..' cards loaded!',{0.5,0.5,0.5})
          Deck=1
          if not qTbl.standalone then endLoop() end
        end
      end
    end)
    if not success then
      printToAll('Something went wrong and the importer crashed, giving the error:',{1,0,0})
      printToAll(errorMSG,{0.8,0,0})
      printToAll("If you were doing everything you were supposed to, please let Amuzet know on discord or the workshop page (please remember what you typed to get the error, and the error message itself).",{0,1,1})
      printToAll('Restarting Importer...',{0,0.5,1})
      for i,o in ipairs(textItems) do
        if o~=nil then
          o.destruct()
        end
      end
      self.reload()
    end
  end})

function setOracle(c)
  local n='\n[b]'
  if c.power then n=n..c.power..'/'..c.toughness
  elseif c.loyalty then n=n..tostring(c.loyalty)
  else n=false end
  local text = c.oracle_text or ''
  return text:gsub('\"',"'")..(n and n..'[/b]' or '')
end

--[[Deck spawning — CDN images via UUID from deck text or deck sites]]
function spawnDeck(wr,qTbl)
  if not wr.text or wr.text=='' or wr.is_error then
    Player[qTbl.color].broadcast('Failed to fetch deck list: '..(wr.error or 'SSL/network error'),{1,0,0})
    endLoop()
    return
  end
  if wr.text:find('!DOCTYPE')then
    uNotebook('D'..qTbl.color,wr.url)
    Player[qTbl.color].broadcast('Your Deck list could not be found\nMake sure the Deck is set to PUBLIC',{1,0.5,0})
    textItems[#textItems].destruct()
	  table.remove(textItems,#textItems)
    endLoop()
  else
    local sideboard=''
    local list=wr.text:gsub('\n%S*Sideboard(.*)',function(a)sideboard=a return ''end)
    if sideboard~=''then
      Player[qTbl.color].broadcast('Sideboard Found and pasted into Notebook\n"Importer deck" to spawn most recent Notebook Tab')
      uNotebook(qTbl.url,sideboard)end
    spawnDeckFromText(list, qTbl)
  end
end

setCSV=4
function spawnCSV(wr,qTbl)
  local side, lines = '', {}
  for line in wr.text:gmatch('([^\r\n]+)')do
    local tbl,l={},','..line:gsub(',("[^"]+"),',function(g)return','..g:gsub(',','')..','end)
    l=l:gsub(',',', ')
    for csv in l:gmatch(',([^,]+)')do
      if csv:len()==1 then break
      else
        table.insert(tbl,csv:sub(2))
      end
    end
    if #tbl<setCSV-1 then printToAll('Deck CSV parse error:\n'..qTbl.full)
      endLoop()
      return
    elseif not tbl[2]:find('%d+')then--FirstCSVLine
    elseif(setCSV==3)or(
      setCSV==4 and tbl[1]:find('main'))or(
      setCSV==7 and not tbl[1]:find('board'))then
      local deckLine = tbl[2]..' '..tbl[3]
      if tbl[setCSV] and tbl[setCSV]~='000' then
        deckLine = deckLine..' ('..tbl[setCSV]:upper()..')'
      end
      table.insert(lines, deckLine)
    else--Side/Maybe
      side=side..tbl[2]..' '..tbl[3]..'\n'
    end
  end
  if side~=''then
    Player[qTbl.color].broadcast('Sideboard Found and pasted into Notebook\n"Importer deck" to spawn most recent Notebook Tab')
    uNotebook(qTbl.url,side)
  end
  spawnDeckFromText(table.concat(lines, '\n'), qTbl)
end

local DeckSites={
  archidekt=function(a)
    return a, function(_, qTbl) fetchArchidektDeck(a, qTbl) end
  end,
  moxfield=function(a)
    return a, function(_, qTbl) fetchMoxfieldDeck(a, qTbl) end
  end,
  deckstats=function(a)return a:gsub('%?cb=%d.+','')..'?include_comments=1&export_txt=1',spawnDeck end,
  pastebin=function(a)return a:gsub('com/','com/raw/'),spawnDeck end,
  mtgdecks=function(a)return a..'/dec',spawnDeck end,

  deckbox=function(a)return a..'/export',function(r,qTbl)
    local wr={url=r.url}
    wr.text=r.text:match('%Wbody%W(.+)%W%Wbody%W'):gsub('<br.?>','\n')
    spawnDeck(wr,qTbl)end end,
  -- TappedOut deck URLs: append ?fmt=csv for export format
  tappedout=function(a)if a:find('/lists/')then setCSV=3 else setCSV=4 end
    return a:gsub('.cb=%d+','')..'?fmt=csv',spawnCSV end,
--A function which returns a url and function which handels that url's output
  mtggoldfish=function(a)
    if a:find('/archetype/')then return a,function(wr,qTbl)Player[qTbl.color].broadcast('This is an Archtype!\nPlease spawn a User made Deck.',{0.9,0.1,0.1})endLoop()end
    elseif a:find('/deck/')then return a:gsub('/deck/','/deck/download/'):gsub('#.+',''),spawnDeck
    else return a,function(wr,qTbl)Player[qTbl.color].broadcast('This MTGgoldfish url is malformated.\nOr unsupported contact Amuzet.')end end end,
  cubecobra=function(a)return a:gsub('cube/deck','cube/deck/download/mtgo'):gsub('?seat=', '/'),spawnDeck end
}

function isPlayablePrintingEntry(entry)
  if not entry or not entry.uuid then return false end
  local layout = entry.layout or 'normal'
  local typeLine = entry.type_line or ''
  if layout == 'art_series' or layout == 'token' or layout == 'emblem' or layout == 'double_faced_token' then
    return false
  end
  if typeLine:find('Token') or typeLine:find('Emblem') then return false end
  return true
end

function fetchOraclePrintings(oracleId, callback)
  if not oracleId or not isUuid(oracleId) then callback(nil) return end
  local shardKey = tokenShardKey(oracleId)
  if printingsOracleShardCache[shardKey] then
    local shard = printingsOracleShardCache[shardKey]
    callback(shard and shard[oracleId] or nil)
    return
  end
  if not printingsOracleShardWaiters[shardKey] then printingsOracleShardWaiters[shardKey] = {} end
  table.insert(printingsOracleShardWaiters[shardKey], { oracleId = oracleId, cb = callback })
  if printingsOracleShardLoading[shardKey] then return end
  printingsOracleShardLoading[shardKey] = true
  WebGetSSL(PRINTINGS_ORACLE_SHARD_BASE..shardKey..'.json', function(wr)
    printingsOracleShardLoading[shardKey] = false
    local parsed = nil
    if not wr.is_error and wr.text and wr.text ~= '' then
      parsed = safeJSON(wr.text)
    end
    if parsed then printingsOracleShardCache[shardKey] = parsed end
    for _, waiter in ipairs(printingsOracleShardWaiters[shardKey] or {}) do
      waiter.cb(parsed and parsed[waiter.oracleId] or nil)
    end
    printingsOracleShardWaiters[shardKey] = {}
  end)
end

function resolvePrintOracleId(qTbl, callback)
  local target = qTbl and qTbl.target
  if target then
    resolveOracleIdFromIdentity(target, qTbl, function(oracleId)
      callback(oracleId)
    end)
    return
  end
  local cardName = decodeQueryName(qTbl.name or ''):gsub('\n.*', '')
  if cardName == '' then callback(nil) return end
  lookupOracleIdByName(cardName, function(oracleId)
    callback(oracleId)
  end)
end

function printingsToSpawnEntries(printings, fallbackName)
  local entries = {}
  local seen = {}
  for _, printing in ipairs(printings or {}) do
    if isPlayablePrintingEntry(printing) and not seen[printing.uuid] then
      seen[printing.uuid] = true
      table.insert(entries, {
        uuid = printing.uuid,
        name = printing.name or fallbackName or 'Card',
        set = printing.set,
        collector_number = printing.collector_number or printing.collectorNumber,
      })
    end
  end
  return entries
end

function playersExcept(color)
  local out = {}
  for _, c in ipairs(Color.list) do
    if c ~= color then table.insert(out, c) end
  end
  return out
end

function altArtPreviewOwnerGuid(qTbl)
  if qTbl.target then return qTbl.target.getGUID() end
  return 'print_' .. tostring(qTbl.player or qTbl.color or 'anon')
end

function altArtPreviewOrientYaw(qTbl)
  if qTbl.target then return qTbl.target.getRotation().y end
  if qTbl.color and Player[qTbl.color] then return Player[qTbl.color].getPointerRotation() end
  return 0
end

function altArtPreviewBasePos(qTbl)
  if qTbl.target then return qTbl.target.getPosition() end
  local rawPos = qTbl.position or self.getPosition()
  if type(rawPos) == 'table' and not rawPos.x then
    rawPos = Vector(rawPos[1] or 0, rawPos[2] or 0, rawPos[3] or 0)
  end
  return rawPos
end

function altArtPreviewSlotPosition(qTbl, slotIndex, total)
  local idx = slotIndex - 1
  local row = math.floor(idx / altArtPreviewPerRow)
  local col = idx % altArtPreviewPerRow
  local nInRow = math.min(altArtPreviewPerRow, total - row * altArtPreviewPerRow)
  local offRight = (col - (nInRow - 1) / 2) * altArtPreviewSpacing
  local offFwd = -(altArtPreviewUp + row * altArtPreviewRowStep)
  local yaw = math.rad(altArtPreviewOrientYaw(qTbl))
  local fwd = { x = math.sin(yaw), z = math.cos(yaw) }
  local rgt = { x = math.cos(yaw), z = -math.sin(yaw) }
  local base = altArtPreviewBasePos(qTbl)
  return {
    x = base.x + fwd.x * offFwd + rgt.x * offRight,
    y = base.y + 0.5,
    z = base.z + fwd.z * offFwd + rgt.z * offRight,
  }
end

function clearAltArtPreviews(ownerGuid, keepSession)
  altArtPreviewGen[ownerGuid] = (altArtPreviewGen[ownerGuid] or 0) + 1
  local list = altArtPreviews[ownerGuid]
  if list then
    for _, p in ipairs(list) do
      if p ~= nil then
        altArtPreviewData[p.getGUID()] = nil
        altArtPreviewNavData[p.getGUID()] = nil
        pcall(function() destroyObject(p) end)
      end
    end
  end
  altArtPreviews[ownerGuid] = nil
  if not keepSession then
    altArtPreviewSessions[ownerGuid] = nil
  end
end

function clearAltArtPreviewSession(ownerGuid)
  clearAltArtPreviews(ownerGuid, false)
end

function clearAllAltArtPreviews()
  for guid, _ in pairs(altArtPreviewSessions) do
    clearAltArtPreviewSession(guid)
  end
  for guid, _ in pairs(altArtPreviews) do
    clearAltArtPreviewSession(guid)
  end
  altArtPreviewSessions = {}
  for _, obj in ipairs(getAllObjects()) do
    if obj.hasTag and (obj.hasTag(ALT_ART_PREVIEW_TAG) or obj.hasTag(ALT_ART_PREVIEW_NAV_TAG)) then
      pcall(function() destroyObject(obj) end)
    end
  end
end

function clearImporterPreviews(ownerGuid)
  clearAltArtPreviewSession(ownerGuid)
end

function clearAllImporterPreviews()
  clearAllAltArtPreviews()
end

function isAltArtPreviewDoubleClick(key, window)
  window = window or altArtPreviewDoubleClickSecs
  local now = os.clock()
  local last = altArtPreviewDoubleClick[key]
  if last ~= nil and (now - last) <= window then
    altArtPreviewDoubleClick[key] = nil
    return true
  end
  altArtPreviewDoubleClick[key] = now
  return false
end

function buildAltArtPreviewCardData(entry, deckNum, qTbl)
  local face = cdnImageFromUuid(entry.uuid, 'front')
  local back = DEFAULT_BACK
  local displayName = (entry.name or 'Card'):gsub('"', '')
  local nickname = displayName
  if entry.set and entry.collector_number then
    nickname = nickname .. '\n· ' .. tostring(entry.set):lower() .. ' #' .. tostring(entry.collector_number)
  end
  return {
    Transform = {
      posX = 0, posY = 0, posZ = 0, rotX = 0, rotY = 0, rotZ = 0,
      scaleX = altArtPreviewScale, scaleY = altArtPreviewScale, scaleZ = altArtPreviewScale,
    },
    Name = 'Card',
    Nickname = nickname,
    Description = '',
    Tags = { ALT_ART_PREVIEW_TAG },
    CardID = deckNum * 100,
    CustomDeck = {
      [deckNum] = {
        FaceURL = face,
        BackURL = back,
        NumWidth = 1,
        NumHeight = 1,
        Type = 0,
        BackIsHidden = true,
        UniqueBack = false,
      },
    },
  }
end

function altArtParentEmbeds(qTbl, session)
  if session and session.parentDesc and session.parentDesc ~= '' then
    return session.parentDesc, session.parentMemo or '', session.parentTags
  end
  if qTbl and qTbl.target then
    return qTbl.target.getDescription() or '', qTbl.target.getMemo() or '', qTbl.target.getTags()
  end
  return '', '', nil
end

function captureAltArtParentEmbeds(qTbl)
  if not qTbl or not qTbl.target then
    return { parentDesc = '', parentMemo = '', parentTags = nil, parentNickname = '' }
  end
  return {
    parentDesc = qTbl.target.getDescription() or '',
    parentMemo = qTbl.target.getMemo() or '',
    parentTags = qTbl.target.getTags(),
    parentNickname = qTbl.target.getName() or '',
  }
end

function altArtImportNickname(entry, qTbl, session)
  local parentNick = ''
  if session and session.parentNickname and session.parentNickname ~= '' then
    parentNick = session.parentNickname
  elseif qTbl and qTbl.target then
    parentNick = qTbl.target.getName() or ''
  end
  local name = (entry.name or 'Card'):gsub('"', '')
  if parentNick == '' then return name end
  local kept = {}
  local idx = 0
  for line in (parentNick .. '\n'):gmatch('([^\n]*)\n') do
    idx = idx + 1
    if idx == 1 then
      table.insert(kept, name)
    elseif not line:match('^Alternate Art') and not line:match('^%s*·%s*%S+%s*#') and line ~= '' then
      table.insert(kept, line)
    end
  end
  if #kept <= 1 then return name end
  return table.concat(kept, '\n')
end

function altArtImportPosition(qTbl)
  if qTbl.target then
    local o = qTbl.target
    return o.getPosition() + Vector(0, 0.5, 0) + o.getTransformRight():scale(-2.4)
  end
  local pos, _ = altArtLayoutPosition(qTbl, 1)
  return pos
end

function resolveAltArtPreview(info)
  local qTbl = info.qTbl
  local yRot = altArtPreviewOrientYaw(qTbl)
  spawnLightAltArtCard(
    info.entry, qTbl, 1, Card.n,
    altArtImportPosition(qTbl), Vector(0, yRot, 0)
  )
  Player[qTbl.color].broadcast(
    'Imported ' .. (info.entry.name or 'card') .. '.',
    {0.5, 1, 0.5}
  )
  clearAltArtPreviewSession(info.ownerGuid)
end

function altArtPreviewClick(obj, color, alt)
  local info = altArtPreviewData[obj.getGUID()]
  if info == nil or color ~= info.color then return end
  if isAltArtPreviewDoubleClick(obj.getGUID()) then
    resolveAltArtPreview(info)
  end
end

function altArtPreviewPageSlice(session)
  local startIdx = session.page * session.pageSize + 1
  local endIdx = math.min(startIdx + session.pageSize - 1, #session.entries)
  local slice = {}
  for i = startIdx, endIdx do
    table.insert(slice, session.entries[i])
  end
  return slice
end

function altArtPreviewNavPosition(qTbl, cardsOnPage, side)
  -- Both arrows on row 1, one card-gap outside the preview grid.
  local yaw = math.rad(altArtPreviewOrientYaw(qTbl))
  local rgt = { x = math.cos(yaw), z = -math.sin(yaw) }
  local gap = altArtPreviewSpacing
  local anchorSlot = 1
  local sign = 1
  if side == 'next' then
    anchorSlot = 1
    sign = -1
  else
    anchorSlot = math.min(altArtPreviewPerRow, cardsOnPage)
    sign = 1
  end
  local pos = altArtPreviewSlotPosition(qTbl, anchorSlot, cardsOnPage)
  return {
    x = pos.x + rgt.x * gap * sign,
    y = pos.y,
    z = pos.z + rgt.z * gap * sign,
  }
end

function buildAltArtNavChipData(imageUrl, deckNum)
  return {
    Transform = {
      posX = 0, posY = 0, posZ = 0, rotX = 0, rotY = 0, rotZ = 0,
      scaleX = 0.35, scaleY = 0.35, scaleZ = 0.35,
    },
    Name = 'Card',
    Nickname = '',
    Description = '',
    Tags = { ALT_ART_PREVIEW_NAV_TAG },
    CardID = deckNum * 100,
    CustomDeck = {
      [deckNum] = {
        FaceURL = imageUrl,
        BackURL = DEFAULT_BACK,
        NumWidth = 1,
        NumHeight = 1,
        Type = 0,
        BackIsHidden = true,
        UniqueBack = false,
      },
    },
  }
end

function spawnAltArtNavArrow(qTbl, ownerGuid, direction, cardsOnPage)
  local pos = altArtPreviewNavPosition(qTbl, cardsOnPage, direction)
  local orientYaw = altArtPreviewOrientYaw(qTbl)
  local imageUrl = direction == 'next' and ALT_ART_NAV_NEXT_URL or ALT_ART_NAV_PREV_URL
  local clickFn = direction == 'next' and 'altArtPreviewNextPage' or 'altArtPreviewPrevPage'
  local deckNum = direction == 'next' and 7001 or 7000
  local chip = spawnObjectData({
    data = buildAltArtNavChipData(imageUrl, deckNum),
    position = pos,
    rotation = { 0, orientYaw, 0 },
    callback_function = function(obj)
      if obj == nil then return end
      obj.setVar('noencode', true)
      obj.setLock(true)
      obj.setInvisibleTo(playersExcept(qTbl.color))
      altArtPreviewNavData[obj.getGUID()] = {
        ownerGuid = ownerGuid,
        color = qTbl.color,
      }
      obj.createButton({
        click_function = clickFn,
        function_owner = self,
        label = '',
        position = { 0, 0.3, 0 },
        rotation = { 0, 0, 0 },
        width = 1200,
        height = 1200,
        scale = { 1, 1, 1 },
        color = { 0, 0, 0, 0 },
      })
    end,
  })
  if not altArtPreviews[ownerGuid] then altArtPreviews[ownerGuid] = {} end
  table.insert(altArtPreviews[ownerGuid], chip)
end

function altArtPreviewNextPage(obj, color, alt)
  local nav = altArtPreviewNavData[obj.getGUID()]
  if not nav or color ~= nav.color then return end
  local session = altArtPreviewSessions[nav.ownerGuid]
  if not session then return end
  if (session.page + 1) * session.pageSize >= #session.entries then return end
  session.page = session.page + 1
  local pages = math.ceil(#session.entries / session.pageSize)
  Player[color].broadcast(
    'Alternate arts page '..(session.page + 1)..'/'..pages..'.',
    {0.7, 0.9, 1}
  )
  showAltArtPreviewPage(nav.ownerGuid)
end

function altArtPreviewPrevPage(obj, color, alt)
  local nav = altArtPreviewNavData[obj.getGUID()]
  if not nav or color ~= nav.color then return end
  local session = altArtPreviewSessions[nav.ownerGuid]
  if not session or session.page <= 0 then return end
  session.page = session.page - 1
  local pages = math.ceil(#session.entries / session.pageSize)
  Player[color].broadcast(
    'Alternate arts page '..(session.page + 1)..'/'..pages..'.',
    {0.7, 0.9, 1}
  )
  showAltArtPreviewPage(nav.ownerGuid)
end

function showAltArtPreviewPage(ownerGuid)
  local session = altArtPreviewSessions[ownerGuid]
  if not session then return end
  clearAltArtPreviews(ownerGuid, true)
  altArtPreviews[ownerGuid] = {}
  local gen = altArtPreviewGen[ownerGuid]
  local qTbl = session.qTbl
  local entries = altArtPreviewPageSlice(session)
  local total = #entries
  local orientYaw = altArtPreviewOrientYaw(qTbl)
  local rot = { 0, orientYaw, 0 }
  local deckBase = 8000 + session.page * 100

  if session.page > 0 then
    spawnAltArtNavArrow(qTbl, ownerGuid, 'prev', total)
  end
  if (session.page + 1) * session.pageSize < #session.entries then
    spawnAltArtNavArrow(qTbl, ownerGuid, 'next', total)
  end

  local function spawnOne(i)
    if i > total then return end
    if altArtPreviewGen[ownerGuid] ~= gen then return end
    local entry = entries[i]
    local pos = altArtPreviewSlotPosition(qTbl, i, total)
    local cardData = buildAltArtPreviewCardData(entry, deckBase + i, qTbl)
    local preview = spawnObjectData({
      data = cardData,
      position = pos,
      rotation = rot,
      scale = { altArtPreviewScale, altArtPreviewScale, altArtPreviewScale },
      callback_function = function(obj)
        if altArtPreviewGen[ownerGuid] ~= gen then
          pcall(function() destroyObject(obj) end)
          return
        end
        obj.setVar('noencode', true)
        obj.setLock(true)
        obj.setInvisibleTo(playersExcept(qTbl.color))
        altArtPreviewData[obj.getGUID()] = {
          color = qTbl.color,
          ownerGuid = ownerGuid,
          entry = entry,
          qTbl = qTbl,
        }
        obj.createButton({
          click_function = 'altArtPreviewClick',
          function_owner = self,
          label = '',
          position = { 0, 0.3, 0 },
          rotation = { 0, 0, 0 },
          width = 1500,
          height = 2100,
          scale = { 1, 1, 1 },
          color = { 0, 0, 0, 0 },
        })
      end,
    })
    if altArtPreviewGen[ownerGuid] ~= gen then
      pcall(function() destroyObject(preview) end)
      return
    end
    if altArtPreviews[ownerGuid] ~= nil then
      table.insert(altArtPreviews[ownerGuid], preview)
    end
    Wait.time(function()
      spawnOne(i + 1)
    end, ALT_ART_SPAWN_DELAY)
  end
  spawnOne(1)
end

function altArtLayoutPosition(qTbl, slotIndex)
  local yRot = 0
  if qTbl.color and Player[qTbl.color] then
    yRot = Player[qTbl.color].getPointerRotation()
  end
  local rot = Vector(0, yRot, 0)
  local spread = 2.4
  local offset = (slotIndex - 1) * spread

  if qTbl.target then
    local o = qTbl.target
    local right = o.getTransformRight()
    local base = qTbl.position or (o.getPosition() + Vector(0, 0.5, 0) + right:scale(-spread))
    return base + right:scale(-offset), rot
  end

  local rawPos = qTbl.position or self.getPosition()
  if type(rawPos) == 'table' and not rawPos.x then
    rawPos = Vector(rawPos[1] or 0, rawPos[2] or 0, rawPos[3] or 0)
  end
  local rad = math.rad(yRot)
  return rawPos + Vector(-math.sin(rad) * offset, 0, -math.cos(rad) * offset), rot
end

function spawnLightAltArtCard(entry, qTbl, slotIndex, cardNum, posOverride, rotOverride)
  local n = cardNum or Card.n
  Card.n = n + 1
  local pos, rot = posOverride, rotOverride
  if not pos or not rot then
    pos, rot = altArtLayoutPosition(qTbl, slotIndex)
  end
  local face = cdnImageFromUuid(entry.uuid, 'front')
  local back = DEFAULT_BACK
  local ownerGuid = altArtPreviewOwnerGuid(qTbl)
  local session = altArtPreviewSessions[ownerGuid]
  local nickname = altArtImportNickname(entry, qTbl, session)
  local parentDesc, parentMemo, parentTags = altArtParentEmbeds(qTbl, session)
  local cardData = {
    Transform = {posX = 0, posY = 0, posZ = 0, rotX = 0, rotY = 0, rotZ = 0, scaleX = 1, scaleY = 1, scaleZ = 1},
    Name = 'Card',
    Nickname = nickname,
    Description = parentDesc,
    Memo = parentMemo,
    CardID = n * 100,
    CustomDeck = {
      [n] = {
        FaceURL = face,
        BackURL = back,
        NumWidth = 1,
        NumHeight = 1,
        Type = 0,
        BackIsHidden = true,
        UniqueBack = false,
      },
    },
  }
  if parentTags and #parentTags > 0 then
    cardData.Tags = parentTags
  end
  spawnObjectData({
    data = cardData,
    position = pos,
    rotation = rot,
  })
end

function spawnAlternateArtPrintings(entries, qTbl)
  if #entries == 0 then
    Player[qTbl.color].broadcast('No alternate art printings found on Kai CDN.', {1, 0, 0})
    if not qTbl.standalone then endLoop() end
    return
  end
  local ownerGuid = altArtPreviewOwnerGuid(qTbl)
  clearImporterPreviews(ownerGuid)
  Card.n = 1
  local total = #entries
  local pages = math.ceil(total / ALT_ART_PREVIEW_PAGE_SIZE)
  local parentEmbeds = captureAltArtParentEmbeds(qTbl)
  altArtPreviewSessions[ownerGuid] = {
    entries = entries,
    qTbl = qTbl,
    page = 0,
    pageSize = ALT_ART_PREVIEW_PAGE_SIZE,
    parentDesc = parentEmbeds.parentDesc,
    parentMemo = parentEmbeds.parentMemo,
    parentTags = parentEmbeds.parentTags,
    parentNickname = parentEmbeds.parentNickname,
  }
  local msg = 'Double-click a preview to import.'
  if pages > 1 then
    msg = 'Page 1/'..pages..' ('..total..' printings). '..msg..' Use ← / → beside the row to browse pages.'
  else
    msg = total..' alternate art preview'..(total == 1 and '' or 's')..'. '..msg
  end
  Player[qTbl.color].broadcast(msg, {0.5, 1, 0.5})
  showAltArtPreviewPage(ownerGuid)
  if not qTbl.standalone then endLoop() end
end

function cardOracleText(record)
  if not record then return '' end
  local text = record.name or ''
  if record.type_line and record.type_line ~= '' then
    text = text..'\n'..record.type_line
  end
  if record.oracle_text and record.oracle_text ~= '' then
    text = text..'\n\n'..record.oracle_text
  end
  if record.card_faces then
    for i, face in ipairs(record.card_faces) do
      if i > 1 or (face.oracle_text and face.oracle_text ~= '') then
        text = text..'\n\n'..(face.name or '')..'\n'..(face.oracle_text or '')
      end
    end
  end
  return text
end
--[[Importer Data Structure]]
Importer=setmetatable({
  --Variables
  request={},
  --Functions
  Front=function(qTbl)
    if qTbl.target then
      local custom = qTbl.target.getCustomObject()
      if custom and custom.face then
        custom.face = qTbl.url
        qTbl.target.setCustomObject(custom)
        qTbl.target.reload()
        Player[qTbl.color].broadcast('Card Front set to\n'..qTbl.url,{0.9,0.9,0.9})
      else
        Player[qTbl.color].broadcast('Target is not a custom card.',{1,0,0})
      end
    else
      Player[qTbl.color].broadcast('You must be hovering over a card to use "Importer front"',{1,0,0})
    end
    endLoop()end,

  Spawn=function(qTbl)
    if qTbl.standalone and qTbl.target then
      respawnFromTarget(qTbl)
      return
    end
    if Card.image then
      local function spawnWithImage(uuid)
        ensureCardRecords(uuid and {uuid} or {}, function()
          local record = uuid and getCachedRecord(uuid)
          if record then
            enrichRecordRelatedTokens(record, function(enriched)
              local card = indexRecordToCardObject(uuid, enriched)
              card.image_uris = { large = Card.image }
              Card(card, qTbl, enriched)
            end)
          else
            Card({
              name = decodeQueryName(qTbl.name),
              type_line = '',
              cmc = 0,
              oracle_text = '',
              image_uris = { large = Card.image },
            }, qTbl)
          end
          Card.image = false
        end)
      end
      loadIndexManifest(function()
        resolveQueryUuidAsync(qTbl.name, spawnWithImage)
      end)
      return
    end
    spawnFromCdnQuery(qTbl)
  end,

  Token=function(qTbl)
    spawnTokensForCard(qTbl)
  end,

  TokenDebug=function(qTbl)
    debugTokenResolution(qTbl)
  end,

  Print=function(qTbl)
    local cardName = decodeQueryName(qTbl.name or ''):gsub('\n.*', '')
    resolvePrintOracleId(qTbl, function(oracleId)
      if not oracleId then
        failNotInCache(qTbl, cardName)
        return
      end
      fetchOraclePrintings(oracleId, function(printings)
        local entries = printingsToSpawnEntries(printings, cardName)
        if #entries > 0 then
          spawnAlternateArtPrintings(entries, qTbl)
          return
        end
        Player[qTbl.color].broadcast('No alternate art printings found on Kai CDN.', {1, 0, 0})
        if not qTbl.standalone then endLoop() end
      end)
    end)
  end,

  Text=function(qTbl)
    resolveQueryUuidAsync(qTbl.name, function(uuid)
      if not uuid then
        failNotInCache(qTbl, decodeQueryName(qTbl.name))
        return
      end
      ensureCardRecords({uuid}, function()
        local record = getCachedRecord(uuid)
        if not record then
          failNotInCache(qTbl, decodeQueryName(qTbl.name))
          return
        end
        local text = cardOracleText(record)
        if qTbl.target then qTbl.target.setDescription(text)
        else Player[qTbl.color].broadcast(text) end
        if not qTbl.standalone then endLoop() end
      end)
    end)
  end,

  Deck=function(qTbl)
    if qTbl.url and qTbl.url:find('scryfall%.com') then
      Player[qTbl.color].broadcast('That deck site is not supported. Use Archidekt/Moxfield or paste a deck list.', {1, 0.5, 0})
      endLoop()
      return true
    end
    if qTbl.url then
      if qTbl.url:find('archidekt%.com') then
        qTbl.mode='Deck'
        fetchArchidektDeck(qTbl.url, qTbl)
        return true
      end
      if qTbl.url:find('moxfield%.com') then
        qTbl.mode='Deck'
        fetchMoxfieldDeck(qTbl.url, qTbl)
        return true
      end
      for k,v in pairs(DeckSites) do
        if qTbl.url:find(k)then
          qTbl.mode='Deck'
          local url,deckFunction=v(qTbl.url)
          if not url then
            deckFunction({}, qTbl)
          elseif url:find('^https://') then
            WebGetSSL(url, function(wr) deckFunction(wr,qTbl) end)
          else
            WebRequest.get(url, function(wr) deckFunction(wr,qTbl) end)
          end
          return true end end
    elseif qTbl.mode=='Deck'then
      local d=getNotebookTabs();d=d[#d]
      spawnDeck({text=d.body,url='Notebook '..d.title..d.color},qTbl)
    end return false end,

  Rawdeck=function(qTbl)
    if qTbl.target then
      local dec=qTbl.target.getDescription()
      
      spawnDeck({text=dec,url='Description '..qTbl.target.getName()},qTbl)
    end end,

    },{
  __call=function(t,qTbl)
    if isExternalReimportRequest(qTbl) then
      fulfillExternalReimportRequest(qTbl)
      return
    end
    if qTbl and qTbl.standalone then
      if qTbl.url then
        if not t.Deck(qTbl) then
          Card.image=qTbl.url
          t.Spawn(qTbl)
        end
      elseif t[qTbl.mode] then
        t[qTbl.mode](qTbl)
      else
        t.Spawn(qTbl)
      end
      return
    end
    if qTbl then
      qTbl.text=newText(qTbl.position,Player[qTbl.color].steam_name..'\n'..qTbl.full)
      table.insert(t.request,qTbl)
      log(qTbl,'Importer Request '..qTbl.color)
    end
    --Main Logic
    if t.request[13] and qTbl then
      Player[qTbl.color].broadcast('Clearing Previous requests yours added and being processed.')
      endLoop()
    elseif qTbl and t.request[2]then
      local msg='Queueing request '..#t.request
      if t.request[4]then msg=msg..'. Queue auto clears after the 13th request!'
      elseif t.request[3]then msg=msg..'. Type `Importer clear queue` to Force quit the queue!'end
      Player[qTbl.color].broadcast(msg)
    elseif t.request[1]then
      local tbl=t.request[1]
      if isExternalReimportRequest(tbl) then
        fulfillExternalReimportRequest(tbl)
        endLoop()
      elseif tbl.url then
        if not t.Deck(tbl)then
        Card.image=tbl.url
        t.Spawn(tbl)end
      elseif t[tbl.mode]then t[tbl.mode](tbl)
      else t.Spawn(tbl)end--Attempt to Spawn
    elseif qTbl then broadcastToAll('Something went Wrong please contact Amuzet\nImporter did not get a mode. MAIN LOGIC')
  end end})
MODES=''
for k,v in pairs(Importer)do if not('request'):find(k)then
MODES=MODES..' '..k end end
--[[Functions used everywhere else]]
local Usage=[[Card Importer (CDN) — chat commands

Importer <card name>          Spawn one card from Kai CDN
Importer deck <url>           Import deck (Archidekt, Moxfield, legacy sites)
Importer deck                 Spawn from latest notebook tab
Importer token                Spawn tokens for card under pointer
Importer token debug          Token resolution diagnostics
Importer print <name>         Alternate-art preview row (double-click to import)

Admin:
  Importer hide               Toggle chat feedback (admin)
  Importer clear queue        Reload importer
  Importer promote me         Promote player (host)
]]
function endLoop()
  if Importer.request[1] then
    if Importer.request[1].text then Importer.request[1].text() end
    table.remove(Importer.request, 1)
  end
  Importer()
end
function uNotebook(t,b,c)local p={index=-1,title=t,body=b or'',color=c or'Grey'}
  for i,v in ipairs(getNotebookTabs())do if v.title==p.title then p.index=i end end
  if p.index<0 then addNotebookTab(p)else editNotebookTab(p)end return p.index end
function onSave() self.script_state = '' end
function onLoad(data)
  loadTokenDefaults(function() end)
end
function onDestroy()
  clearAllImporterPreviews()
  for _, o in pairs(textItems) do
    if o ~= nil then o.destruct() end
  end
end

local CHAT_COLOR={0.5,1,0.8}
local chatToggle=false
function onChat(msg,p)
  if msg:find('!?[Ii]mporter ') then
    local a=msg:match('!?[Ii]mporter (.*)') or false
    if a=='hide'and p.admin then
      chatToggle=not chatToggle
      if chatToggle then msg='supressing' else msg='showing'end
      broadcastToAll('Importer now '..msg..' chat messages.', CHAT_COLOR)
    elseif a=='help'then
      p.print(Usage,{0.9,0.9,0.9})return false
    elseif a=='promote me' and p.host then
      p.promote()
    elseif a=='clear queue'then
      printToAll('Respawning Importer!', CHAT_COLOR)
      self.reload()
    elseif a:lower():match('^token debug') then
      if Importer.request[1] then
        p.broadcast('Importer queue busy — debug runs immediately anyway.', {1, 0.8, 0.4})
      end
      debugTokenResolution(tokenChatTable(p, 'TokenDebug', a))
      return false
    elseif a:lower() == 'token' then
      if Importer.request[1] then
        p.broadcast('Importer queue busy — token spawn runs immediately anyway.', {1, 0.8, 0.4})
      end
      local tbl = tokenChatTable(p, 'Token', a)
      if not tbl.target then
        p.broadcast('No card under pointer. Keep the laser on a card while pressing Enter.', {1, 0.5, 0})
        return false
      end
      spawnTokensForCard(tbl)
      return false
    elseif a then
      --pieHere, allow using spaces instead of + when doing search syntax, also allow ( ) grouping
      local tbl={position=p.getPointerPosition(),target=chatTargetFromPlayer(p),player=p.steam_id,color=p.color,url=a:match('(http%S+)'),mode=a:gsub('(http%S+)',''):match('(%S+)'),name=a:gsub('(http%S+)',''),full=a}
      if tbl.color=='Grey' then
        tbl.position={0,2,0}
      end
      if tbl.mode then
        for k,v in pairs(Importer) do
          if tbl.mode:lower()==k:lower() and type(v)=='function' then
            tbl.mode,tbl.name=k,tbl.name:lower():gsub(k:lower(),'',1)
            break end end end

      if tbl.name:len()<1 then
        tbl.name='blank card'
      else
        if tbl.name:sub(1,1)==' ' then
          tbl.name=tbl.name:sub(2,-1)   --pieHere, remove 1st space
        end
        -- URL-encode special characters in card search syntax
        charEncoder={ [' '] ='%%20',
                      ['>'] ='%%3E',
                      ['<'] ='%%3C',
                      [':'] ='%%3A',
                      ['%(']='%%28',
                      ['%)']='%%29',
                      ['%{']='%%7B',
                      ['%}']='%%7D',
                      ['%[']='%%5B',
                      ['%]']='%%5D',
                      ['%|']='%%7C',
                      ['%/']='%%2F',
                      ['\\']='%%5C',
                      ['%^']='%%5E',
                      ['%$']='%%24',
                      ['%?']='%%3F',
                      ['%!']='%%3F'}
        for char,replacement in pairs(charEncoder) do
          tbl.name=tbl.name:gsub(char,replacement)
        end
      end
      Importer(tbl)
      if chatToggle then return false end
    end
  end
end

--[[Card Encoder]]
pID=mod_name
function registerModule()
  enc=Global.getVar('Encoder')
  if enc then
    local prop={name=pID,funcOwner=self,activateFunc='toggleMenu'}
    local v=enc.getVar('version')
    buttons={'Respawn','Emblem\nAnd Tokens','Printings'}
    if v and(type(v)=='string'and tonumber(v:match('%d+%.%d+'))or v)<4.4 then
      prop.toolID=pID
      prop.display=true
      enc.call('APIregisterTool',prop)
    else
      prop.values={}
      prop.visible=true
      prop.propID=pID
      prop.tags='tool,cardImporter,Amuzet'
      enc.call('APIregisterProperty',prop)end
    function eEmblemAndTokens(o,p)ENC(o,p,'Token')end function ePrintings(o,p)ENC(o,p,'Print')end
    function eRespawn(o,p)
      ENC(o,p)
      if o.getName()=='' then
        Player[p].broadcast('Card has no name!',{1,0,1})
      else
        respawnFromTarget({
          target=o,
          color=p,
          position=o.getPosition()+Vector(0,1,0)+o.getTransformRight():scale(-2.4),
        })
      end
    end
  end
end

function ENC(o,p,m)
  enc.call('APIrebuildButtons',{obj=o})
  if m then
    if o.getName()=='' then
      Player[p].broadcast('Card has no name!',{1,0,1})
    else
      local oracleid=nil
      if o.memo~=nil and o.memo~='' then
        oracleid='oracleid:'..o.memo
      end
      Importer({
        position=o.getPosition()+Vector(0,1,0)+o.getTransformRight():scale(-2.4),
        target=o,
        player=Player[p].steam_id,
        color=p,
        oracleid=oracleid,
        name=o.getName():gsub('\n.*','')or'Energy Reserve',
        mode=m,
        full='Card Encoder',
        standalone=true,
      })
    end
  end
end

function toggleMenu(o)enc=Global.getVar('Encoder')if enc then flip=enc.call("APIgetFlip",{obj=o})for i,v in ipairs(buttons)do Button(o,v,flip)end Button:reset()end end
Button=setmetatable({label='UNDEFINED',click_function='eRespawn',function_owner=self,height=400,width=2100,font_size=360,scale={0.4,0.4,0.4},position={0,0.28,-1.35},rotation={0,0,90},reset=function(t)t.label='UNDEFINED';t.position={0,0.28,-1.35}end
  },{__call=function(t,o,l,f)
      local inc,i=0.325,0
      l:gsub('\n',function()t.height,inc,i=t.height+400,inc+0.1625,i+1 end)
      t.label,t.click_function,t.position,t.rotation[3]=l,'e'..l:gsub('%s',''),{0,0.28*f,t.position[3]+inc},90-90*f
      o.createButton(t)
      t.height=400
      if i%2==1 then t.position[3]=t.position[3]+0.1625 end end})
Wait.time(function() registerModule() end, 1)
--EOF