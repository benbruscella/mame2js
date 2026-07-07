# Architecture

## The pipeline

```
MAME C++ driver source            e.g. <mame>/src/mame/namco/galaga.cpp (+ .h, _v.cpp, _a.cpp)
        │
        │  PHASE 1: EXTRACT (src/kg/parse.ts, build.ts)
        │  Targeted parsers for MAME's macro DSLs — deliberately NOT a C++ AST:
        │  GAME(...) rows, ROM_START blocks, address_map functions,
        │  machine_config functions, INPUT_PORTS blocks, gfx_layout structs,
        │  GFXDECODE tables, #defines (clock constants), constructor member->tag maps
        ▼
Knowledge graph                   dist/<game>/graph.json (full driver: graph.full.json)
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
Game data                         dist/<game>/{config.json, meta.json,
        │                          README.md dossier, history.txt}  (pure data)
        │
        │  PHASE 4: UNIFIED APP + SERVE (generate.ts buildApp, src/serve.ts)
        │  ONE app at dist/app (runtime copy + tsc) hosts every generated game;
        │  static dist/games.json written at generate time (dev server also
        │  serves a live version); real dirs app/g/<game>/ for pretty routes
        │  (<base href="../../">); all URLs relative -> works at any base path
        ▼
Browser                           /app/ = boot menu (shelves + search + story-
                                  first learn modal), /app/g/<game>/ = the game
                                  (legacy ?g= works; Esc -> menu; ROM drop zone
                                  with manifest validation when no zip served),
                                  /<game>/viewer.html = the graph,
                                  /<game>/README.md = the markdown dossier.
                                  Deployed: https://mamehistory.com (docs/deployment.md)
```

At runtime the **original machine code from the ROMs** is what executes —
on TS cores for Z80, M6809 (+ the KONAMI-1 decrypting variant via an
`opcodeFetch` hook), Intel 8080 and M6803; the C++ was never translated
line-by-line (see "role of the C++ source" below).

## Key design decisions and why

### Knowledge graph first (user decision, 2026-07-05)
The graph (`src/kg/types.ts`) is the single contract between extraction and
generation. Native store is dependency-free JSON; Cypher is an *export*, not a
dependency (`cypher-shell < dist/galaga/graph.cypher` if you want Neo4J).
Rationale: makes game #2 cheap, makes the extracted facts inspectable and
teachable (viewer), and decouples parser improvements from runtime work.

### No C++ AST
The machine description lives in highly regular declarative macros. Targeted
parsers get ~95% of the value; libclang would fight the preprocessor for the
rest. If mamekit ever needs to scale across many exotic drivers, revisit —
but extend the parsers first (they're ~600 lines total).

### Role of the C++ source (three distinct uses)
1. **Automatically consumed as data**: the declarative macros (this is what
   the pipeline parses on every run).
2. **Reference for hand-ported cores**: z80.cpp, namco.cpp, galaga_v.cpp,
   starfield_05xx.cpp, namco06.cpp were read by humans/agents and re-written
   as clean TS with tests. Not mechanical.
3. **Not used at runtime at all.**

MAME is therefore a *dev-time* dependency: needed to extract or extend, not
to build/play an already-extracted game. (A `--from-graph` mode that skips
MAME entirely is on the TODO list.)

### The reuse contract (user requirement)
`src/runtime/` is an **engine + device library** and must stay game-agnostic:

- engine: `bus.ts`, `shell.ts`, `menu.ts`, `input.ts`, `zip.ts`, `audio.ts`,
  `artwork.ts`, `types.ts`
- CPU cores: `z80.ts`, `m6809.ts` (+ `konami1.ts` decrypt wrapper),
  `i8080.ts`, `m6803.ts` (on-chip timer + I/O ports)
- devices: `ls259.ts`, `namco06.ts`, `namco51.ts`, `mb14241.ts`,
  `msm5205.ts`, `wsg.ts`, `namco54.ts`, `ay8910.ts`, `invaders-sound.ts`,
  `galaxian-sound.ts`, `starfield05xx.ts`, `gfx.ts` (+ the `*-worklet.ts`
  AudioWorklet hosts)
- board composition: `boards/<family>.ts` (per board *family*, not per game)
  selected via the `boards/index.ts` registry, `video/<family>.ts`
  (families: galaga, pacman, galaxian, gyruss, mw8080bw, m52)

Game-specific data lives ONLY in generated `config.json`. When a new game
needs behavior we don't have, add a new **device** or **board** module —
never special-case an existing one with game names.

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
│   ├── serve.ts            zero-dep static server ('' -> dist/, /roms -> roms/, /games.json manifest)
│   ├── kg/                 phase 1+2: types, parse, build, cypher, viewer
│   ├── gen/generate.ts     phase 3: graph -> config.json; buildApp() -> dist/app
│   └── runtime/            the engine + device library (copied into the unified app)
├── scripts/deploy-pages.sh publish dist/ to gh-pages (docs/deployment.md)
├── docs/                   you are here
├── roms/                   gitignored (currently renamed _roms/ locally); all six zips
├── artwork/                gitignored; bezel zips, covers/, media/, data/history/history.xml
└── dist/                   gitignored; per-game artifacts + generated app
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
