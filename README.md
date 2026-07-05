# mame2js

Knowledge-graph-first "transpiler" from [MAME](https://github.com/mamedev/mame)
driver source to a runnable browser emulator. Point it at a game; it parses
the real MAME driver, builds a typed **source knowledge graph**, and generates
the machine wiring for a shared TypeScript runtime that runs the game on a
`<canvas>` — **zero runtime dependencies**: plain DOM, Web Audio, native
`DecompressionStream`.

**Status: Galaga, Pac-Man and Galaxian boot and play** — attract mode,
coin-up, gameplay, scoring, 60 fps, sound. What executes is the original Z80
machine code from your ROMs, run by a TypeScript Z80 core; the machine wiring
(memory + io maps, clocks, video timing, input polarity, DIPs) is generated
from parsing MAME's C++ driver source. All generated games live in **one
unified app** with a video-store-shelf boot menu (cabinet artwork covers,
live search, Esc returns to the shelf).

## Quick start

```sh
git clone https://github.com/benbruscella/mame2js
cd mame2js && npm install            # typescript only (dev dep)

# needs a MAME source checkout as sibling (../mame) or set --mame-src/$MAME_SRC
node bin/mame2js.js galaga           # generate a game (repeat per game)
node bin/mame2js.js pacman
node bin/mame2js.js galaxian
node bin/mame2js.js --serve          # serve everything (no MAME tree needed)
```

Open **http://localhost:8280/app/** — the boot menu. Pick a game (or go
straight to `/app/?g=galaga`); drop your `<game>.zip` on the page or put it
in `roms/` first. Controls: **arrows** move · **Space or X** fire (Ctrl is
deliberately unbound — macOS treats Ctrl+arrows as a system chord) ·
**5** coin · **1/2** start · **Esc** back to the menu. Add `&debug=1` to a
game URL for live input/port logging.

Optional: MAME cabinet artwork zips placed in `artwork/` (gitignored, e.g.
from Mr. Do's arcade site) become shelf covers **and** an in-game bezel
surround — the game plays inside the cabinet art's CRT window, with your own
attract-mode snapshots composited into the menu covers.

The knowledge-graph viewer is at **http://localhost:8280/<game>/viewer.html**
— a self-contained force-directed browser of the extracted source graph
(search, family filters, node inspector). Also works by just opening
`out/<game>/viewer.html` as a file.

```sh
mame2js galaga            # graph -> generate config.json -> (re)build unified app
mame2js graph galaga      # knowledge graph only (graph.json / .cypher / viewer.html)
mame2js galaga --serve    # ...and serve on :8280
mame2js --serve           # serve all generated games + menu, no MAME tree required
```

Requires **Node ≥ 23.6** (the CLI is TypeScript, run natively — no build step
except `tsc` for the browser app).

## How it works

```
MAME C++ driver source                    (src/mame/namco/galaga.cpp, pacman/pacman.cpp,
        │                                  galaxian/galaxian.cpp ...)
        │  targeted parsers for the MAME macro DSLs — not a C++ AST:
        │  GAME / ROM_START / address_map (incl. io maps + helper composition) /
        │  machine_config (incl. helper call chains) / INPUT_PORTS (incl. polarity
        │  + PORT_CONFNAME) / gfx_layout / GFXDECODE(_SCALE) / constexpr XTAL consts
        ▼
knowledge graph                           out/<game>/graph.json (+ .cypher for Neo4J,
        │                                  + viewer.html — interactive canvas browser)
        │  subgraph reachable from the game node
        ▼
generated game data                       out/<game>/config.json  (pure data, no compile:
        │                                  ROM manifest, memory/io-map wiring, screen
        │                                  timing, clocks, sound kind, input polarity,
        │                                  DIP defaults, key bindings, board family)
        ▼
unified app (out/app)                     ONE compiled copy of the shared runtime
        │                                  hosts every generated game + the boot menu
        ▼
shared runtime (src/runtime)              hand-ported, game-agnostic device library:
                                           z80 (266-check spec), bus, ls259, namco06,
                                           namco51 (HLE), namco54 (HLE), wsg + galaxian
                                           sound (AudioWorklets), starfield05xx,
                                           gfx decode, video/* and boards/* per family
```

The split is deliberate: **adding another game should touch almost nothing.**
Everything game-specific is derived from the graph; unknown memory handlers
fail loudly at generation time, naming exactly which device to add to the
library. Pac-Man and Galaxian were added this way (issue #1): parser
extensions + one board, one video, one sound module each. Next candidates
(Bosconian, Dig Dug, Xevious) share Galaga's board family.

## Documentation

**[docs/](docs/)** is written so a fresh (human or agent) session can pick the
project up cold: [architecture](docs/architecture.md) ·
[knowledge graph](docs/knowledge-graph.md) · [runtime reference](docs/runtime.md) ·
[generator](docs/generator.md) · [adding a game](docs/adding-a-game.md) ·
[testing](docs/testing.md) · [gotchas](docs/gotchas.md) · [TODO](docs/TODO.md).

[sessions/](sessions/) holds the (gzipped) Claude Code transcripts of the
sessions that built this, for the full reasoning history.

## Testing

```sh
npx tsc --noEmit
node src/runtime/z80.spec.ts             # 266 checks incl. exhaustive DAA
node src/runtime/wsg.spec.ts             # frequency-accurate WSG core
node src/runtime/galaxian-sound.spec.ts  # hum/LFO/fire/noise envelopes
node src/runtime/video/galaga.spec.ts    # gfx decode, palette, tilemap, 05xx LFSR
node src/runtime/video/pacman.spec.ts    # scan swizzle, sprites, palette weights
node src/runtime/video/galaxian.spec.ts  # column scroll, bullets, star LFSR
node src/runtime/boards/galaga.spec.ts   # integration: synthetic ROMs, real IRQ paths
node src/runtime/boards/pacman.spec.ts
node src/runtime/boards/galaxian.spec.ts
```

## ROMs

Not included, not distributable, never committed (`roms/` is gitignored). Use
your own MAME romsets (`galaga.zip`, `pacman.zip`, `galaxian.zip`) —
auto-loaded from `roms/` or drag-and-drop onto the page. ROM files are
matched by **CRC32** as well as name, so older dash-style romsets work.
Unzipping happens in the browser via native `DecompressionStream` — no zip
library. Cabinet artwork zips in `artwork/` are treated the same way
(user-supplied, gitignored).

## Knowledge graph in Neo4J (optional)

```sh
cypher-shell -u neo4j -p <pass> < out/galaga/graph.cypher
```

The graph's native store is plain JSON; Neo4J is an export, not a dependency.

## Known gaps

- Audio is spec-verified more than ear-verified; Galaga's 54xx explosion is
  an HLE approximation.
- Cocktail/flip-screen and player-2 bindings unverified.
- See [docs/TODO.md](docs/TODO.md) for the honest full list.
