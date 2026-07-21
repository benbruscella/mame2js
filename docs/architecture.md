# Architecture

## The pipeline

```
MAME C++ driver source            e.g. <mame>/src/mame/namco/galaga.cpp (+ .h, _v.cpp, _a.cpp)
        │
        │  PHASE 1: EXTRACT (src/mame/ast.ts, src/kg/parse.ts, build.ts)
        │  Source-preserving ASTs targeted at MAME's C++ and macro DSLs:
        │  GAME(...) rows, ROM_START blocks, address_map functions,
        │  machine_config functions, INPUT_PORTS blocks, gfx_layout structs,
        │  GFXDECODE tables, #defines (clock constants), constructor member->tag maps
        ▼
Knowledge graph                   dist/games/<category>/<game>/graph.json
        │                         (full driver: graph.full.json)
        │                         + graph.cypher (Neo4J) + viewer.html / viewer.full.html
        │
        │  PHASE 2: RESOLVE (src/kg/build.ts gameSubgraph)
        │  BFS from game:<name> over typed edges -> only what this game needs
        ▼
Game subgraph                     ~116 nodes for galaga
        │
        │  PHASE 3: GENERATE (src/gen/generate.ts)
        │  Graph -> ShellConfig JSON: family, cpus[] (multi-CPU, each with
        │  type/clock/ranges/mask/io), screen timing (from set_raw), sound
        │  kind, ROM manifest with CRCs, DIP defaults, per-field input
        │  polarity, keyboard bindings, custom port members.
        │  Unknown handler names -> loud failure.
        │  Side channels: driver-header copyright credits, MAME git history
        │  (git log --follow on the driver), Gaming History text extraction.
        ▼
Game data                         dist/games/{arcade,consoles}/<game>/
        │                          {config.json, meta.json, generated/machine.json,
        │                          generated/board.js, README.md, history.txt}
        │
        │  PHASE 4: UNIFIED APP + SERVE (generate.ts buildApp, src/serve.ts)
        │  ONE small app at dist/app hosts every generated game;
        │  compiled host code lives at dist/runtime/core and source-derived
        │  hardware lives at dist/runtime/generated;
        │  static dist/games.json written at generate time (dev server also
        │  serves a live version); real dirs app/g/<game>/ for pretty routes
        │  (<base href="../../">); all URLs relative -> works at any base path
        ▼
Browser                           /app/ = boot menu (shelves + search + story-
                                  first learn modal), /app/g/<game>/ = the game
                                  (legacy ?g= works; Esc -> menu; ROM drop zone
                                  with manifest validation when no zip served),
                                  /games/<category>/<game>/viewer.html = graph,
                                  /games/<category>/<game>/README.md = dossier.
                                  Deployed: https://mamehistory.com (docs/deployment.md)
```

At runtime the **original machine code from the ROMs** executes on hardware
definitions generated from MAME source. The checked-in TypeScript supplies the
browser host and generic IR interpreters, not handwritten copies of MAME chips.

## Key design decisions and why

### Knowledge graph first (user decision, 2026-07-05)
The graph (`src/kg/types.ts`) is the single contract between extraction and
generation. Native store is dependency-free JSON; Cypher is an *export*, not a
dependency (`cypher-shell < dist/games/arcade/galaga/graph.cypher` if you want Neo4J).
Rationale: makes game #2 cheap, makes the extracted facts inspectable and
teachable (viewer), and decouples parser improvements from runtime work.

### MAME-specific ASTs, not a generic C++ transpiler
The machine description lives in highly regular declarative macros. Targeted,
source-preserving ASTs capture the MAME dialect without requiring libclang to
fight the preprocessor for the rest. If new drivers expose missing source
shapes, extend the MAME-specific AST and lowering rules first.

### Role of the C++ source (three distinct uses)
1. **Machine facts**: declarative macros become the knowledge graph and game
   configuration.
2. **Executable behavior**: CPU, device, video, audio and handler source is
   lowered through typed IR and MAME-specific DSL compilers.
3. **Generated browser artifacts**: the resulting JSON and JavaScript live in
   `dist/games` and `dist/runtime/generated`; MAME C++ is not shipped.

MAME is therefore a *generation-time* dependency. `--from-graph` can rebuild
the game layer from a saved graph, while regenerating hardware definitions
still reads the sibling MAME source tree.

### The reuse contract (user requirement)
`src/runtime/` is a **browser host + generic IR runtime** and must stay
game-agnostic:

- engine: `bus.ts`, `shell.ts`, `menu.ts`, `input.ts`, `zip.ts`, `audio.ts`,
  `artwork.ts`, `types.ts`
- IR execution: `generated-cpu.ts`, `generated-device.ts`,
  `generated-handler.ts`, `generated-video.ts`, `generated-frame.ts`
- composition: `generated-machine.ts` and `generated-board.ts`
- generated MAME hardware: emitted to `dist/runtime/generated`, never checked
  into `src/runtime`

Game-specific data and executable machine composition live only under
`dist/games/<category>/<game>`. When a new game exposes a missing behavior,
extend the MAME AST/DSL lowering or generic IR runtime, not a handwritten game
or chip copy.

### Zero dependencies (user requirement)
Browser: canvas 2D, Web Audio (AudioWorklet), `DecompressionStream('deflate-raw')`
for zip inflation. CLI: node:fs/path/http only. Node ≥ 23.6 runs the
TypeScript CLI directly (native type stripping) — there is **no build step for
the CLI**, only for the browser app.

## Repository layout

```
mamekit/
├── bin/mamekit.js          CLI entry (imports src/cli.ts — Node runs TS natively)
├── src/
│   ├── cli.ts              arg parsing, driver discovery (cached), orchestration
│   ├── serve.ts            zero-dep static server (dist + live games manifest)
│   ├── mame/               MAME-specific AST, DSL and hardware lowering
│   ├── kg/                 graph types, extraction, Cypher and viewer
│   ├── gen/                graph/machine emitters, app build and audits
│   └── runtime/            browser host and generic generated-code runtime
├── scripts/deploy-pages.sh publish dist/ to gh-pages (docs/deployment.md)
├── docs/                   you are here
├── roms/                   gitignored local ROMs used only by tests/manual drops
├── artwork/                gitignored; bezel zips, covers/, media/, data/history/history.xml
└── dist/                   gitignored; app, runtime and categorized games
```

The repo lives at `~/Projects/Github/mamekit` (github.com/benbruscella/mamekit)
with a **symlink** at `<mame>/mamekit` for convenience. The MAME checkout is
auto-detected as sibling (`../mame`) or parent.

## Performance envelope (so you don't over-engineer)

- TS Z80 core: ~900 emulated MHz in Node 24. Galaga needs 3 × 3.072 MHz.
  ~100× headroom — do not micro-optimize CPU code without a profile.
- Bus dispatch: flat 64k Uint8Array handler-id tables + function arrays;
  ~10M calls/sec is fine.
- Frame loop: 264 scanlines × 3 CPUs × 192 cycles; render is full-frame
  (no dirty tracking) and comfortably 60fps. Interleave quantum = 1 scanline
  (MAME uses 6000 Hz boost; ours is finer at ~15.8 kHz).
