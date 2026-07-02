# Card Importer

A Tabletop Simulator object script for spawning Magic: The Gathering cards and importing decks. Original by **Amuzet**; adapted by **Vokerr**.

## Features

- Spawn cards by name, UUID, set/collector, or custom image URL
- Import decks from popular deck sites or pasted lists
- Spawn related tokens and emblems for hovered cards
- Browse alternate-art printings in a preview grid (double-click to import)
- CDN metadata index at runtime — no live Scryfall API calls during import

## Install

1. In Tabletop Simulator, create a custom object (or use an existing importer chip).
2. Open the object's script editor.
3. Paste the full contents of [`Card Importer.lua`](Card%20Importer.lua).
4. Save. No configuration required — default CDN URLs work out of the box.

## Runtime dependencies

Card faces and metadata are loaded from hosted CDNs (not bundled in this repo):

| Role | Host |
|------|------|
| **Card images** | [Kai CDN](https://img.klrmngr.com) (`img.klrmngr.com`) |
| **Metadata** (indexes, tokens, printings, UI assets) | Vokerr public metadata CDN (`pub-6c935b50ab2c43f291df08b7f566585b.r2.dev`) |

---

## Chat commands

Type in global chat. A leading `!` is optional (`!Importer ...` works the same as `Importer ...`).

### Spawn a card (default)

| Command | Description |
|---------|-------------|
| `Importer <card name>` | Spawn one card by exact name from the CDN index |
| `Importer spawn <card name>` | Same as above (explicit mode) |
| `Importer <image URL>` | Spawn a card using a custom face image URL |
| `Importer spawn <image URL>` | Same as above (explicit mode) |

**Card query syntax** (use after `Importer` or `Importer spawn`):

| Syntax | Example |
|--------|---------|
| Exact name | `Importer Lightning Bolt` |
| Scryfall UUID | `Importer 7ea9a090-3950-438f-9c69-6129a41d0534` |
| Oracle ID | `Importer oracleid:abc12345-6789-...` |
| Name + set + collector `(set) num` | `Importer Lightning Bolt (mhm) 381` |
| Name + set + collector `[set:num]` | `Importer Lightning Bolt [mhm:381]` |
| Name filtered to set | `Importer Lightning Bolt&set=mhm` |
| Quantity prefix (deck-style) | `Importer 4 Lightning Bolt` |

Special characters in card names are URL-encoded automatically (spaces, `()`, `[]`, etc.).

### Deck import

| Command | Description |
|---------|-------------|
| `Importer deck <url>` | Import a deck from a supported site URL |
| `Importer deck` | Spawn from the **latest notebook tab** (deck list text) |
| `Importer rawdeck` | Spawn from the **description** of the card under your pointer |

**Supported deck sites** (via `Importer deck <url>`):

| Site | Notes |
|------|-------|
| [Archidekt](https://archidekt.com) | Full API import |
| [Moxfield](https://moxfield.com) | Full API import |
| [Deckstats](https://deckstats.net) | Text export |
| [Pastebin](https://pastebin.com) | Raw paste URL |
| [MTGDecks](https://mtgdecks.net) | `/dec` export |
| [Deckbox](https://deckbox.org) | Export URL |
| [TappedOut](https://tappedout.net) | CSV export |
| [MTGGoldfish](https://www.mtggoldfish.com) | User deck download only (archetype pages are rejected) |
| [Cube Cobra](https://cubecobra.com) | MTGO-format cube deck download |

**Not supported:** Scryfall deck URLs. Use Archidekt/Moxfield or paste the list into a notebook tab and run `Importer deck`.

Sideboards found during import are saved to a notebook tab; spawn them with `Importer deck` after import.

### Tokens & emblems

| Command | Description |
|---------|-------------|
| `Importer token` | Spawn tokens/emblems for the card under your pointer (runs immediately, bypasses queue) |
| `Importer token debug` | Print token-resolution diagnostics for the hovered card (runs immediately) |

Keep your laser on the card while pressing Enter. If the card does not create tokens, you get a message instead of spawning.

### Alternate art / printings

| Command | Description |
|---------|-------------|
| `Importer print <name>` | Show a paginated preview row of alternate printings for that card name |
| `Importer print` | Same, using the card under your pointer (via Encoder **Printings** button) |

**In the preview UI:** click a printing to select it; **double-click** to spawn that version. Use the arrow chips to change pages.

### Oracle text

| Command | Description |
|---------|-------------|
| `Importer text <card name>` | Look up oracle text and print it to chat |
| `Importer text <card name>` *(with hovered card)* | Write oracle text onto that card's description |

### Custom card faces

| Command | Description |
|---------|-------------|
| `Importer front <image URL>` | Set the face image of the custom card under your pointer to the given URL |

Requires hovering over a custom card object.

### Help & admin

| Command | Who | Description |
|---------|-----|-------------|
| `Importer help` | Anyone | Print the in-script command summary to your chat |
| `Importer hide` | Admin | Toggle suppression of Importer chat feedback |
| `Importer clear queue` | Anyone | Reload the importer object (clears a stuck queue) |
| `Importer promote me` | Host | Promote yourself |

---

## Card Encoder integration

If **TyrantNomad's Encoder** is on the table, this script registers as a Card Importer tool with three buttons on encoded cards:

| Button | Action |
|--------|--------|
| **Respawn** | Re-import the card from CDN using its current name |
| **Emblem And Tokens** | Same as `Importer token` for that card |
| **Printings** | Same as `Importer print` for that card |

---

## Import queue

Most commands go through a FIFO queue (one request processed at a time). You'll see queue position messages when multiple imports are pending.

- After **3** queued requests: you can use `Importer clear queue` to force-reset
- After **13** queued requests: the queue auto-clears and continues

`Importer token` and `Importer token debug` always run immediately, even if the queue is busy.

---

## Layout

- `Card Importer.lua` — TTS object script (paste into a custom object)
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).

Magic: The Gathering is a trademark of Wizards of the Coast. Scryfall is not affiliated with this project.
