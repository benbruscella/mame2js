# The generator (`src/gen/generate.ts`)

Turns the game subgraph into pure data (`dist/<game>/config.json` +
`meta.json`) and (re)builds the **unified app** at `dist/app/`. Everything
here is mechanical derivation — if you find yourself hard-coding a game fact
in the generator, it belongs in the graph (fix the parser) or in a board
module (if it's behavior).

## What it emits

```
dist/
├── app/                      the ONE compiled app, shared by every game
│   ├── index.html            loads ./dist/main.js?v=<stamp> (per-build cache bust)
│   ├── g/<game>/index.html   pretty route: real dir + <base href="../../"> so
│   │                         relative URLs resolve as on /app/ (no rewrites on Pages)
│   ├── tsconfig.json         same flags as the main project; excludes *.spec.ts
│   └── src/
│       ├── main.ts           game from /g/<game>/ path or legacy ?g= ->
│       │                     fetch ../<game>/config.json -> runShell;
│       │                     no game -> runMenu(); http->https redirect on
│       │                     real domains (AudioWorklet needs secure context)
│       └── runtime/          verbatim copy of src/runtime
├── index.html                redirect / -> app/ (relative)
├── games.json                static manifest (dev server serves a live version)
└── <game>/
    ├── config.json           the full ShellConfig literal (pure KG data)
    ├── meta.json             {game,title,fullname,year,manufacturer,family,
    │                          driverFile,license?,copyrightHolders?,
    │                          gitHistory?{firstCommit,lastCommit,commits,
    │                          contributors,topAuthors},hasHistory?}
    ├── README.md             the markdown DOSSIER: chip manifest w/ CRCs,
    │                         controls, DIPs, driver credits, story — every
    │                         fact flows from the graph / side channels
    ├── history.txt           Gaming History write-up (extracted from the
    │                         user-supplied artwork/data/history/history.xml,
    │                         CRLF-normalized, attributed)
    └── graph.json / viewer.html / ...   (written by the CLI, phase 1+2)
```

All emitted URLs are **relative to the /app/ page** (`../roms/<g>.zip`,
`../<game>/config.json`) so the same build works at `/`, `/mamekit/`, or
mamehistory.com — never emit a leading `/`.

`generate()` writes the per-game JSON; `buildApp(outRoot)` copies the runtime
and compiles with `tsc -p dist/app` (the project's own node_modules/typescript).
Games are **not compiled** — adding a game after the app is built is just a
new config.json. tsc failure returns false / sets exit code but leaves
sources for debugging.

## Derivation rules (graph → config)

- **family**: driver file stem (`galaga.cpp` → `galaga`) — selects the board
  module via `boards/index.ts` `createBoard`. Also stored in meta.json.
- **cpus**: `Device` nodes whose type is in the `CPU_TYPES` map
  (Z80, KONAMI1, I8039, I8080, M6803), collected across the machine-config
  **CALLS chain** (galaxian's devices live in `galaxian_base`; gyruss has 4
  CPUs across its chain). Each cpu entry carries `{tag, type, clock, region,
  ranges, mask?, io?}` — **multi-CPU is first-class**; `region` = cpu tag.
- **ranges**: per-CPU from that cpu's `HAS_MAP` (space AS_PROGRAM) → ranges
  flattened across `INCLUDES_MAP` composition (galaxian_map = base +
  discrete), called maps first, in statement order. Cross-config
  `set_addrmap` **patches** are resolved along the game's CALLS chain via
  `PATCHES_MAP` edges (scoped to the patching config — a shared device's
  map override must not leak into sibling games; this fixed a pacman
  regression). `map.global_mask` → `cpu.mask` (mpatrol's M6803 masks its
  bus to 0x7fff — boards must honor it or the CPU runs off the map).
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
  second `Bus` from it and wire the memory bus's `in`/`dist` to it.
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
  `GALAXIAN_SOUND` → `{kind:'galaxian', clock}`; AY-3-8910 chips →
  `{kind:'ay8910', clock, chips:N}` (gyruss has 5; the worklet banks
  registers at `chip*16+reg` and scales gain 1/chips); mw8080bw's discrete
  board → `{kind:'invaders'}` (worklet-synthesized SFX); none →
  `{kind:'none'}`. The shell loads `<runtimeUrl>/<kind>-worklet.js` and
  registers processor `<kind>`; per-kind master volumes live in the shell's
  `VOLUMES` map (wsg 0.5625, ay8910 0.55).
- **roms**: RomSet → regions → loads, with offsets/sizes/CRCs and
  reloadOffsets, verbatim. Rom node ids are **region-scoped**
  (`rom:<set>/<region>/<file>`) — gyruss ships two distinct chips both
  named `gyrussk.4`.
- **inputs**: the game's port set is resolved root-first along the
  `INCLUDES_PORTS` chain (PORT_INCLUDE): a derived `PORT_START` replaces the
  whole port, a `PORT_MODIFY` replaces base fields whose masks overlap
  (mpatrol inherits m52's coin/start ports, modifies the joystick bits).
  Multi-line `#define` port macros (KONAMI8-style, KONAMI_COINAGE_LOC) are
  text-expanded before parsing. Per-field `activeLow` polarity drives each
  port's resting init byte (galaxian is active-HIGH). `PORT_CUSTOM_MEMBER`
  fields become `customs: [{port, mask, member}]` — boards wire the member
  name to a handler (invaders' CONTP1 controls).
- **dipDefaults**: dip fields → `{port, mask, value: defaultValue ?? mask}`
  (PORT_DIPUNUSED has no default in the graph; active-low "off" = mask).
  `service` fields (incl. PORT_SERVICE_DIPLOC) default to released.
- **bindings**: `bit` fields, skipping `PORT_COCKTAIL` modifiers, via the
  `KEYMAP` table (IPT_JOYSTICK_LEFT → ArrowLeft, IPT_BUTTON1 →
  **Space/KeyX — NEVER Ctrl** (user directive: macOS Ctrl+Arrow chord breaks
  movement while firing), IPT_START1 → Digit1, IPT_COIN1 → Digit5, ...).
  Extend KEYMAP for new input types; player-2 bindings are an open TODO.
- **romUrl** `../roms/<game>.zip` (relative — base-path agnostic),
  **runtimeUrl** `./dist/runtime/`, **menuUrl** `./` (Esc target; resolves
  via each route page's `<base>`).
- **meta.json extras** (education layer): license + copyrightHolders parsed
  from the driver header's raw `// copyright-holders:` line; `gitHistory`
  from `git log --follow` on the driver file in the MAME checkout;
  `hasHistory` when Gaming History text was extracted.
- **README.md dossier**: `gameMarkdown()` renders everything above as one
  standalone markdown doc. Nothing hand-written — same facts, second format.
- After `buildApp()`, the CLI writes the static `dist/games.json` manifest
  (same scanner the dev server uses live).

## Board selection

`config.family` → `createBoard()` in `src/runtime/boards/index.ts`. One board
module per *family* (galaga.cpp covers bosco/galaga/xevious/digdug — they
share the misclatch/06xx skeleton but differ in video and extra customs).

## CLI plumbing (`src/cli.ts`)

- Driver discovery scans `<mameSrc>/src/mame/**/*.cpp` for
  `GAME(\s*year,\s*<name>,` and caches hits in `dist/.driver-cache.json`.
- MAME source auto-detection order: parent of mamekit, sibling `../mame`,
  cwd; override `--mame-src` or `$MAME_SRC`.
- `mamekit --serve` (no game) rebuilds `dist/app` and serves everything —
  MAME source not required. With a game, generation runs first.
- `--serve` starts `src/serve.ts` on :8280 mounting `'' → dist/`,
  `/roms → <mamekit>/roms` and `/artwork → <mamekit>/artwork`, plus the
  dynamic `/games.json` manifest (scans `dist/*/meta.json`, flags `hasRom`
  from roms/ — shadows the static file locally). Bare directory paths
  301-redirect to the trailing-slash form (matches GitHub Pages so relative
  URLs resolve identically). URLs: `/app/` = boot menu, `/app/g/<game>/`
  (or legacy `?g=`) = game, `/<game>/viewer.html` = graph,
  `/<game>/README.md` = dossier.
