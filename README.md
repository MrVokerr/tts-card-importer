# Card Importer

A Tabletop Simulator object script for spawning Magic: The Gathering cards and importing decks.

**Original by Amuzet · Adapted by Vokerr**

---

## How it works

| Layer | What runs |
|-------|-----------|
| In TTS | `Card Importer.lua` |
| Card images | [img.klrmngr.com](https://img.klrmngr.com) |
| Card / token metadata | [`pub-6c935b50ab2c43f291df08b7f566585b.r2.dev`](https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev) |

**At play time there are no Scryfall API calls.** TTS only fetches small CDN shards.

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
- [R2/MIRROR.md](R2/MIRROR.md) — clone or host your own bucket
- [R2/ADVANCED.md](R2/ADVANCED.md) — extend records or add a REST Worker

Change `METADATA_CDN` at the top of `Card Importer.lua` to point at your mirror.

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
| `token` | Spawns related tokens/emblems for the hovered card |
| `token debug` | Prints how token lookup resolved (for troubleshooting) |

Double-faced tokens (e.g. Incubator // Phyrexian) spawn with a TTS back-face state when the CDN has face data.

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

## Files

| File | Purpose |
|------|---------|
| `Card Importer.lua` | Paste into your TTS object |
| `R2/` | Metadata CDN build tooling and docs |
| `LICENSE` | MIT |
| `README.md` | This file |

---

## License

MIT — see [LICENSE](LICENSE).

*Magic: The Gathering is a trademark of Wizards of the Coast. Scryfall is not affiliated with this project.*
