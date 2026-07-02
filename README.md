# Card Importer

A Tabletop Simulator object script for spawning Magic: The Gathering cards and importing decks. Original by **Amuzet**; adapted by **Vokerr** (v6.0).

## Features

- Spawn a card by name: `Importer <card name>`
- Import a deck from Archidekt, Moxfield, or other supported deck sites: `Importer deck <url>`
- Spawn related tokens for a hovered card: `Importer token`
- Browse alternate-art printings: `Importer print`
- Deck import, token resolution, and alt-art UI use a CDN metadata index (no live Scryfall API at import time)

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

## Chat commands

```
Importer <card name>          Spawn one card
Importer deck <url>           Import a deck
Importer token                Spawn tokens for hovered card
Importer print                Alternate-art printings preview
Importer clear queue          Clear a stuck import queue
```

## Layout

- `Card Importer.lua` — TTS object script (paste into a custom object)
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).

Magic: The Gathering is a trademark of Wizards of the Coast. Scryfall is not affiliated with this project.
