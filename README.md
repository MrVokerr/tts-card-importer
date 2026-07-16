# Card Importer

A Tabletop Simulator object script for spawning Magic: The Gathering cards and importing decks.

**Original by Amuzet · Adapted by Vokerr · v6.3**

---

## How it works

| Layer | What runs | Where |
|-------|-----------|--------|
| In TTS | `Card Importer.lua` | Your table (paste into an object) |
| Card images | Kai CDN | `https://img.klrmngr.com` |
| Card / token metadata | Static JSON on Cloudflare R2 | `https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev` |
| Daily token index refresh | GitHub Actions → Scryfall bulk JSONL → R2 | Online (not your PC) |

**At play time there are no Scryfall API calls.** TTS only fetches small CDN shards. Scryfall bulk data is used only on GitHub-hosted runners to rebuild token metadata for new sets.

Credentials for publishing to R2 live in **GitHub Actions secrets** only. They are never committed to this repo.

---

## Quick reference

Type in global chat. `Importer …` and `Scryfall …` both work (same commands).

| What you want | Command |
|---------------|---------|
| Spawn a card | `Importer Lightning Bolt` |
| Spawn by set & number | `Importer Lightning Bolt (mhm) 381` |
| Import a deck URL | `Importer deck https://archidekt.com/decks/…` |
| Import from notebook | `Importer deck` |
| Spawn tokens | `Importer token` *(pointer on card)* |
| Browse printings | `Importer print Lightning Bolt` |
| Get oracle text | `Importer text Lightning Bolt` |
| Custom face on card | `Importer front https://…` *(pointer on card)* |
| Help | `Importer help` |
| Fix stuck queue | `Importer clear queue` |

---

## Install

1. Create or open a custom object in Tabletop Simulator.
2. Paste the full contents of [`Card Importer.lua`](Card%20Importer.lua) into its script.
3. Save — no local config or card database needed.

### CDN dependencies

| | URL |
|---|-----|
| Card images | [img.klrmngr.com](https://img.klrmngr.com) |
| Metadata index | [`pub-6c935b50ab2c43f291df08b7f566585b.r2.dev`](https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev) |

### Metadata CDN / self-hosting

The importer reads static JSON shards from an R2-compatible host. To **mirror**, **rebuild**, or build an **advanced metadata API**, see the [`R2/`](R2/) package:

- [R2/README.md](R2/README.md) — overview and build commands
- [R2/METADATA.md](R2/METADATA.md) — full URL and shard contract
- [R2/MIRROR.md](R2/MIRROR.md) — clone or host your own bucket + daily sync secrets
- [R2/ADVANCED.md](R2/ADVANCED.md) — extend records or add a REST Worker

Change `METADATA_CDN` at the top of `Card Importer.lua` to point at your mirror.

---

## Daily token updates (maintainers)

Workflow: [`.github/workflows/r2-token-sync.yml`](.github/workflows/r2-token-sync.yml)

- **Schedule:** daily 06:00 UTC (+ manual **Run workflow**)
- **Does:** download Scryfall `default_cards` JSONL → rebuild token shards / defaults → merge token card records into R2 → smoke-check the public CDN
- **Covers:** new tokens, DFC token faces (e.g. Incubator), parent→token links from Scryfall `all_parts`
- **Failsafes:** skip if bulk unchanged; refuse publish on empty/regressed counts; never wipe remote token prefixes first; merge card shards so seed cards are not deleted

Required secrets (repo → Settings → Secrets → Actions): `CLOUDFLARE_API_TOKEN` (or R2 S3 keys), `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`. Details in [R2/MIRROR.md](R2/MIRROR.md).

Players and TTS tables do **not** need these secrets.

---

## Commands

### Spawn cards

Default mode — type a card name or query after `Importer` (or `Scryfall`).

```
Importer Lightning Bolt
Importer spawn Lightning Bolt
Importer https://example.com/my-custom-art.jpg
```

#### Query formats

| Format | Example |
|--------|---------|
| Exact name | `Importer Sol Ring` |
| UUID | `Importer 7ea9a090-3950-438f-9c69-6129a41d0534` |
| Oracle ID | `Importer oracleid:abc12345-6789-abcd-ef0123456789` |
| Name `(set) number` | `Importer Lightning Bolt (mhm) 381` |
| Name `[set:number]` | `Importer Lightning Bolt [mhm:381]` |
| Name + set filter | `Importer Lightning Bolt&set=mhm` |
| Quantity prefix | `Importer 4 Lightning Bolt` |

Parentheses, brackets, and spaces in names are handled automatically.

---

### Import decks

```
Importer deck https://moxfield.com/decks/…
Importer deck                              ← latest notebook tab
Importer rawdeck                           ← deck list in hovered card's description
```

#### Supported sites

| Site | |
|------|---|
| [Archidekt](https://archidekt.com) | ✅ |
| [Moxfield](https://moxfield.com) | ✅ |
| [Deckstats](https://deckstats.net) | ✅ |
| [TappedOut](https://tappedout.net) | ✅ CSV |
| [MTGGoldfish](https://www.mtggoldfish.com) | ✅ user decks only |
| [Deckbox](https://deckbox.org) | ✅ |
| [Pastebin](https://pastebin.com) | ✅ raw URL |
| [MTGDecks](https://mtgdecks.net) | ✅ |
| [Cube Cobra](https://cubecobra.com) | ✅ MTGO export |
| Scryfall deck links | ❌ use Archidekt/Moxfield or paste into notebook |

> Sideboards are saved to a notebook tab during import. Run `Importer deck` again to spawn them.

---

### Tokens & emblems

Pointer must stay on the card when you press Enter. These skip the import queue.

```
Importer token
Importer token debug
```

| Command | Does |
|---------|------|
| `token` | Spawns related tokens/emblems for the hovered card (CDN `all_parts` / parent shards) |
| `token debug` | Prints how token lookup resolved (for troubleshooting) |

**v6.2+:** Double-faced tokens (e.g. Incubator // Phyrexian) spawn with TTS `States[2]` for the back face.  
**v6.3:** If Scryfall has not linked tokens yet, the script refuses wrong fuzzy oracle matches and tells you to wait for the CDN refresh.

---

### Alternate art / printings

```
Importer print Lightning Bolt
Importer print                    ← uses hovered card (or Encoder → Printings)
```

Opens a row of preview chips in front of you.

- **Click** — select a printing  
- **Double-click** — spawn that version  
- **Arrow chips** — next / previous page  

---

### Oracle text

```
Importer text Lightning Bolt      ← prints to chat
Importer text Sol Ring              ← with pointer on a card: writes to its description
```

---

### Custom card faces

```
Importer front https://example.com/face.jpg
```

Sets the face URL on the **custom card under your pointer**, then reloads it.

---

### Admin & utility

| Command | Access | Does |
|---------|--------|------|
| `Importer help` | Everyone | Prints command list to your chat |
| `Importer clear queue` | Everyone | Reloads the importer (clears stuck queue) |
| `Importer hide` | Admin | Toggle Importer chat messages on/off |
| `Importer promote me` | Host | Promote yourself |

---

## Card Encoder

With **TyrantNomad's Encoder** on the table, three buttons appear on encoded cards:

| Button | Same as |
|--------|---------|
| **Respawn** | Re-import that card from CDN |
| **Emblem And Tokens** | `Importer token` |
| **Printings** | `Importer print` |

---

## Import queue

Most commands are processed one at a time (FIFO).

- Queue position is announced when others are waiting.
- At **3+** requests: `Importer clear queue` is suggested.
- At **13** requests: queue auto-clears and continues.

`token` and `token debug` always run immediately.

---

## Repository layout

| Path | Purpose |
|------|---------|
| [`Card Importer.lua`](Card%20Importer.lua) | Paste into your TTS object (v6.3) |
| [`R2/`](R2/) | Metadata CDN build, publish, verify tooling |
| [`.github/workflows/r2-token-sync.yml`](.github/workflows/r2-token-sync.yml) | Daily online token sync |
| `LICENSE` | MIT |
| `README.md` | This file |

---

## Security

- **Do not commit** `.env`, API tokens, or R2 access keys.
- Publishing credentials belong in GitHub Actions secrets only.
- The public CDN URL and GitHub username are intentional (clients need the CDN host).
- Optional local scripts under `R2/scripts/*-local.ps1` are for maintainer debugging only — daily sync does not use your PC.

---

## License

MIT — see [LICENSE](LICENSE).

*Magic: The Gathering is a trademark of Wizards of the Coast. Scryfall is not affiliated with this project. Card data for the metadata index is derived from [Scryfall](https://scryfall.com) bulk data at build time only.*
