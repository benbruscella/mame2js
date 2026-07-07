# mame2js

Knowledge-graph-first "transpiler" from [MAME](https://github.com/mamedev/mame)
driver source to a runnable browser emulator. Point it at a game; it parses
the real MAME driver, builds a typed **source knowledge graph**, and generates
the machine wiring for a shared TypeScript runtime that runs the game on a
`<canvas>` — **zero runtime dependencies**: plain DOM, Web Audio, native
`DecompressionStream`.

**Live at [mamehistory.com](https://mamehistory.com)** — an educational
arcade-history site: every game opens with its story (Gaming History
write-up, the machine's real chip spec from the knowledge graph, and the
MAME driver's credits + git contribution history) before you play.

**Status: six games boot and play** — Galaga, Pac-Man, Galaxian, Gyruss,
Space Invaders, Moon Patrol. What executes is the original machine code
from your ROMs, run by TypeScript CPU cores (Z80, M6809 + KONAMI-1
decrypting variant, Intel 8080, M6803); the machine wiring (memory + io
maps, clocks, video timing, input polarity, DIPs) is generated from parsing
MAME's C++ driver source. All games live in **one unified app** with a
video-store-shelf boot menu.

## Quick start

```sh
git clone https://github.com/benbruscella/mame2js
cd mame2js && npm install            # typescript only (dev dep)

# needs a MAME source checkout as sibling (../mame) or set --mame-src/$MAME_SRC
node bin/mame2js.js galaga           # generate a game (repeat per game)
node bin/mame2js.js --serve          # serve everything (no MAME tree needed)
```

Open **http://localhost:8280/app/** — the boot menu. Click a game to read
its story, then Play (pretty routes: `/app/g/galaga/`). If no ROM is served
the arcade screen becomes a drag-drop zone that lists exactly which chips
the zip must contain and validates it (per-chip ✓/≈/✗ against the CRCs in
the knowledge graph) before booting.

Controls: **arrows** move · **Space or X** fire (Ctrl is deliberately
unbound — macOS treats Ctrl+arrows as a system chord) · **5** coin ·
**1/2** start · **Esc** back to the menu. Add `&debug=1` for live input
logging.

Optional, all user-supplied and gitignored: MAME cabinet artwork zips in
`artwork/` become shelf covers and in-game bezel surrounds; flyer/marquee/
cabinet scans under `artwork/covers/` and `artwork/media/`; the Gaming
History dat at `artwork/data/history/history.xml` feeds the story modals
and dossiers.

Each generated game also gets a **markdown dossier** at
`dist/<game>/README.md` — chip manifest with CRCs, controls, DIPs, driver
credits, story — and the knowledge-graph viewer at
`dist/<game>/viewer.html` (self-contained force-directed browser of the
extracted source graph).

```sh
mame2js galaga            # graph -> config.json + meta + dossier -> (re)build unified app
mame2js graph galaga      # knowledge graph only (graph.json / .cypher / viewer.html)
mame2js galaga --serve    # ...and serve on :8280
mame2js --serve           # serve all generated games + menu, no MAME tree required
npm run deploy -- --artwork   # publish dist/ to GitHub Pages (mamehistory.com)
```

Requires **Node ≥ 23.6** (the CLI is TypeScript, run natively — no build step
except `tsc` for the browser app).

## How it works

```
MAME C++ driver source                    (namco/galaga.cpp, pacman/pacman.cpp,
        │                                  galaxian/galaxian.cpp, konami/gyruss.cpp,
        │                                  midw8080/mw8080bw.cpp, irem/m52.cpp)
        │  targeted parsers for the MAME macro DSLs — not a C++ AST:
        │  GAME / ROM_START / address_map (io maps, helper composition, global_mask,
        │  cross-config set_addrmap patches) / machine_config (helper call chains,
        │  device_add_mconfig) / INPUT_PORTS (polarity, PORT_INCLUDE merge, multi-line
        │  #define port macros, PORT_CUSTOM_MEMBER) / gfx_layout / GFXDECODE(_SCALE) /
        │  constexpr XTAL consts / driver-header copyright credits
        ▼
knowledge graph                           dist/<game>/graph.json (+ .cypher for Neo4J,
        │                                  + viewer.html — interactive canvas browser)
        │  subgraph reachable from the game node
        ▼
generated game data                       dist/<game>/{config.json, meta.json,
        │                                  README.md dossier, history.txt}
        ▼
unified app (dist/app)                    ONE compiled copy of the shared runtime
        │                                  hosts every game: boot menu, story modals,
        │                                  pretty routes /app/g/<game>/, ROM drop zone
        ▼
shared runtime (src/runtime)              hand-ported, game-agnostic device library:
                                           CPUs z80 · m6809/konami1 · i8080 · m6803;
                                           sound wsg+namco54 · galaxian · ay8910×n ·
                                           invaders SFX synth · msm5205 (AudioWorklets);
                                           mb14241, ls259, namco06/51 (HLE), gfx decode,
                                           video/* and boards/* per driver family
```

The split is deliberate: **adding another game should touch almost nothing.**
Everything game-specific is derived from the graph; unknown memory handlers
fail loudly at generation time, naming exactly which device to add to the
library. Pac-Man and Galaxian were added this way (issue #1), then Gyruss,
Space Invaders and Moon Patrol (issue #3): parser extensions + per-family
board/video modules + the missing CPU/sound cores, each with its own spec
suite.

## Documentation

**[docs/](docs/)** is written so a fresh (human or agent) session can pick the
project up cold: [architecture](docs/architecture.md) ·
[knowledge graph](docs/knowledge-graph.md) · [runtime reference](docs/runtime.md) ·
[generator](docs/generator.md) · [adding a game](docs/adding-a-game.md) ·
[testing](docs/testing.md) · [deployment](docs/deployment.md) ·
[gotchas](docs/gotchas.md) · [TODO](docs/TODO.md).

[sessions/](sessions/) holds the (gzipped) Claude Code transcripts of the
sessions that built this, for the full reasoning history.

## Testing

```sh
npm test        # tsc --noEmit + all 23 spec suites (~2,400 checks)
```

Suites cover every CPU core (z80 266 · m6809 459 · konami1 40 · i8080 276 ·
m6803 388), sound cores (wsg, namco54, galaxian, ay8910 634, invaders SFX,
msm5205), devices (mb14241), all six video pipelines, and per-board
integration tests with synthetic hand-assembled ROMs.

## ROMs

Not included, not distributable, never committed (`roms/`, `_roms/` and
`*.zip` are gitignored) — and **never read from the server**: the app's only
ROM source is your own drag-drop, validated against the knowledge graph's
chip manifest (name, dash/underscore swap, CRC32, and clone-revision
alternates) before booting, then remembered by your browser (IndexedDB) so
you drop each zip once. Unzipping happens in the browser via native
`DecompressionStream`. Artwork and the Gaming History dat are user-supplied
and gitignored the same way.

## Knowledge graph in Neo4J (optional)

```sh
cypher-shell -u neo4j -p <pass> < dist/galaga/graph.cypher
```

The graph's native store is plain JSON; Neo4J is an export, not a dependency.

## Known gaps

- Gyruss i8039 percussion CPU is stubbed (music + AY SFX play).
- Moon Patrol MSM5205 ADPCM drums are timing-emulated but not routed to the
  audio worklet yet.
- Cocktail/flip-screen and player-2 bindings unverified.
- See [docs/TODO.md](docs/TODO.md) for the honest full list.
