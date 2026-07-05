# The generator (`src/gen/generate.ts`)

Turns the game subgraph into pure data (`out/<game>/config.json` +
`meta.json`) and (re)builds the **unified app** at `out/app/`. Everything
here is mechanical derivation — if you find yourself hard-coding a game fact
in the generator, it belongs in the graph (fix the parser) or in a board
module (if it's behavior).

## What it emits

```
out/
├── app/                      the ONE compiled app, shared by every game
│   ├── index.html            loads ./dist/main.js as ES module
│   ├── tsconfig.json         same flags as the main project; excludes *.spec.ts
│   └── src/
│       ├── main.ts           ?g=<game> -> fetch /<game>/config.json -> runShell;
│       │                     no ?g= -> runMenu() (the boot menu)
│       └── runtime/          verbatim copy of src/runtime
├── index.html                redirect / -> /app/
└── <game>/
    ├── config.json           the full ShellConfig literal (pure KG data)
    ├── meta.json             {game,title,fullname,year,manufacturer,family}
    └── graph.json / viewer.html / ...   (written by the CLI, phase 1+2)
```

`generate()` writes the per-game JSON; `buildApp(outRoot)` copies the runtime
and compiles with `tsc -p out/app` (the project's own node_modules/typescript).
Games are **not compiled** — adding a game after the app is built is just a
new config.json. tsc failure returns false / sets exit code but leaves
sources for debugging.

## Derivation rules (graph → config)

- **family**: driver file stem (`galaga.cpp` → `galaga`) — selects the board
  module via `boards/index.ts` `createBoard`. Also stored in meta.json.
- **cpus**: `Device` nodes with `type === 'Z80'`, collected across the
  machine-config **CALLS chain** (galaxian's devices live in `galaxian_base`,
  reached from `machine:galaxian_state.galaxian` via CALLS edges).
  `region` = cpu tag (holds for all supported families).
- **ranges**: from cpu[0]'s `HAS_MAP` (space AS_PROGRAM) → ranges flattened
  across `INCLUDES_MAP` composition (galaxian_map = base + discrete), called
  maps first, in statement order.
  - `rom` flag → `kind:'rom'`; `ram`/`writeonly` → `kind:'ram'` (+share, +write
    handler if a WRITES edge exists); otherwise `kind:'handler'`; a handler
    range with no read and no write → `'nop'`.
  - **Handler keys**: `<deviceTag>.<method>` when the READS/WRITES edge has
    `deviceTag` props (e.g. `misclatch.write_d0`, `cust.sound_w`,
    `06xx.data_r`), else `<ownerClass>.<method>` (e.g.
    `galaga_state.bosco_dsw_r`). `.portr("IN0")` ranges become read key
    `port.IN0` (boards register these via `portHandlers()` from
    `boards/index.ts`). The board's `HandlerRegistry` must provide every key
    or `Bus` **throws at construction** — this is the designed failure mode
    that tells you exactly what to implement for a new game.
- **io**: when cpu[0] has an `AS_IO` map, `board.io = { ranges, globalMask? }`
  (pacman: out port 0 = IM2 vector write, global_mask 0xff). Boards build a
  second `Bus` from it and wire the memory bus's `in`/`out` to it.
- **screen**: from the SCREEN device's `set_raw` params:
  width = (hbstart−hbend)/xscale, height = vbstart−vbend,
  refresh = pixclock/(htotal·vtotal), plus vtotal/vbstart/vbend for the
  scheduler. `xscale` = max GFXDECODE_SCALE x-scale across the config chain
  (galaxian pre-scales 3×; we render native). `rotate` from the GAME row's
  monitor column (ROT90 → 90).
- **clocks**: `06xx` device clock (48000) and `namco` (WSG) device clock
  (96000) — galaga-board wiring facts, defaults harmless elsewhere.
- **sound**: device-library mapping from sound device type:
  `NAMCO`/`NAMCO_WSG` → `{kind:'wsg', clock, waveRegion:'namco'}`;
  `GALAXIAN_SOUND` → `{kind:'galaxian', clock}`; none → `{kind:'none'}`.
  The shell loads `<runtimeUrl>/<kind>-worklet.js` and registers processor
  `<kind>`.
- **roms**: RomSet → regions → loads, with offsets/sizes/CRCs and
  reloadOffsets, verbatim.
- **dipDefaults**: dip fields → `{port, mask, value: defaultValue ?? mask}`
  (PORT_DIPUNUSED has no default in the graph; active-low "off" = mask).
  `service` fields default to released (mask).
- **bindings**: `bit` fields, skipping `PORT_COCKTAIL` modifiers, via the
  `KEYMAP` table (IPT_JOYSTICK_LEFT → ArrowLeft, IPT_BUTTON1 → ControlLeft/
  Space, IPT_START1 → Digit1, IPT_COIN1 → Digit5, ...). Extend KEYMAP for new
  input types; player-2 bindings are an open TODO.
- **romUrl** `/roms/<game>.zip`, **runtimeUrl** `./dist/runtime/`,
  **menuUrl** `/` (Esc target).

## Board selection

`config.family` → `createBoard()` in `src/runtime/boards/index.ts`. One board
module per *family* (galaga.cpp covers bosco/galaga/xevious/digdug — they
share the misclatch/06xx skeleton but differ in video and extra customs).

## CLI plumbing (`src/cli.ts`)

- Driver discovery scans `<mameSrc>/src/mame/**/*.cpp` for
  `GAME(\s*year,\s*<name>,` and caches hits in `out/.driver-cache.json`.
- MAME source auto-detection order: parent of mame2js, sibling `../mame`,
  cwd; override `--mame-src` or `$MAME_SRC`.
- `mame2js --serve` (no game) rebuilds `out/app` and serves everything —
  MAME source not required. With a game, generation runs first.
- `--serve` starts `src/serve.ts` on :8280 mounting `'' → out/` and
  `/roms → <mame2js>/roms`, plus the dynamic `/games.json` manifest
  (scans `out/*/meta.json`, flags `hasRom` from roms/). URLs:
  `/app/` = boot menu, `/app/?g=<game>` = game, `/<game>/viewer.html` = graph.
