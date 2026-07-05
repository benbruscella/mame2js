# The generator (`src/gen/generate.ts`)

Turns the game subgraph into `out/<game>/app/` and compiles it. Everything
here is mechanical derivation — if you find yourself hard-coding a game fact
in the generator, it belongs in the graph (fix the parser) or in a board
module (if it's behavior).

## What it emits

```
out/<game>/app/
├── index.html            loads ./dist/main.js as ES module
├── tsconfig.json         same flags as the main project; excludes *.spec.ts
└── src/
    ├── config.ts         `export const CONFIG: ShellConfig = {...literal...}`
    ├── main.ts           runShell(CONFIG) + error surface
    └── runtime/          verbatim copy of src/runtime (self-contained app)
```

Then runs `tsc -p app` (using the project's own node_modules/typescript) →
`app/dist`. Non-zero tsc exit sets `process.exitCode = 1` but leaves the
emitted source for debugging.

## Derivation rules (graph → config)

- **cpus**: `Device` nodes with `type === 'Z80'`, in machine-config order.
  `region` = cpu tag (holds for the galaga family; revisit for boards where
  ROM region tags differ from CPU tags).
- **ranges**: from cpu[0]'s `HAS_MAP` → `HAS_RANGE` nodes.
  - `rom` flag → `kind:'rom'`; `ram`/`writeonly` → `kind:'ram'` (+share, +write
    handler if a WRITES edge exists); otherwise `kind:'handler'`; a handler
    range with no read and no write → `'nop'`.
  - **Handler keys**: `<deviceTag>.<method>` when the READS/WRITES edge has
    `deviceTag` props (e.g. `misclatch.write_d0`, `namco.pacman_sound_w`,
    `06xx.data_r`), else `<ownerClass>.<method>` (e.g.
    `galaga_state.bosco_dsw_r`). The board's `HandlerRegistry` must provide
    every key or `Bus` **throws at construction** — this is the designed
    failure mode that tells you exactly what to implement for a new game.
- **screen**: from the SCREEN device's `set_raw` params:
  width = hbstart−hbend, height = vbstart−vbend, refresh = pixclock/(htotal·vtotal),
  plus vtotal/vbstart for the scheduler. `rotate` from the GAME row's monitor
  column (ROT90 → 90).
- **clocks**: `06xx` device clock (48000) and `namco` (WSG) device clock (96000).
- **roms**: RomSet → regions → loads, with offsets/sizes/CRCs and
  reloadOffsets, verbatim.
- **dipDefaults**: dip fields → `{port, mask, value: defaultValue ?? mask}`
  (PORT_DIPUNUSED has no default in the graph; active-low "off" = mask).
  `service` fields default to released (mask).
- **bindings**: `bit` fields, skipping `PORT_COCKTAIL` modifiers, via the
  `KEYMAP` table (IPT_JOYSTICK_LEFT → ArrowLeft, IPT_BUTTON1 → ControlLeft/
  Space, IPT_START1 → Digit1, IPT_COIN1 → Digit5, ...). Extend KEYMAP for new
  input types; player-2 bindings are an open TODO.
- **romUrl** `/roms/<game>.zip`, **workletUrl** `./dist/runtime/wsg-worklet.js`.

## Board selection

Currently hard-wired: `shell.ts` imports `boards/galaga.ts`. When a second
board family lands, add a `board` discriminator to `ShellConfig` (derive from
the driver/machine name in the graph) and a registry in the shell. Keep board
modules per *family* (galaga.cpp covers bosco/galaga/xevious/digdug — they
share the misclatch/06xx skeleton but differ in video and extra customs).

## CLI plumbing (`src/cli.ts`)

- Driver discovery scans `<mameSrc>/src/mame/**/*.cpp` for
  `GAME(\s*year,\s*<name>,` and caches hits in `out/.driver-cache.json`.
- MAME source auto-detection order: parent of mame2js, sibling `../mame`,
  cwd; override `--mame-src` or `$MAME_SRC`.
- `--serve` starts `src/serve.ts` on :8280 mounting `'' → out/<game>` and
  `/roms → <mame2js>/roms`. So: `/app/` = game, `/viewer.html` = graph viewer.
