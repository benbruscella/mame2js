# TESTING

MAMEKIT tests a compiler, generated emulator hardware, and a browser host. A
single test style cannot cover all three honestly. This document defines the
quality gates for supported machines and the evidence required before a
behavioral baseline may change.

## 1. GOAL

When a new machine is added, Pac-Man, Pooyan, Time Pilot, Space Invaders,
Galaxian and Galaga must continue to produce the same generated machine
behavior unless an intentional, reviewed fix changes them. The tests therefore
protect both sides of the compiler boundary:

1. MAME source is parsed and lowered as expected;
2. a clean generated distribution remains complete and self-contained;
3. real ROM code follows the same input, CPU, video, and audio trajectory.

The tests do not prove universal MAME compatibility. They prove specific
source forms, generated hardware contracts, and named supported machines.

## 2. TEST LEVELS

| Gate | Command | MAME source | ROMs | CI |
|---|---|---:|---:|---:|
| Type and colocated specs | `npm run test:unit` | yes | no | yes |
| Current clean generation | `npm run test:current` | yes | no | yes |
| All registered target generation | `npm run test:generation` | yes | no | manual |
| Generated game behavior | `npm run test:games` | no after generation | yes | local |
| Browser presentation | `npm run serve` plus browser QA | no after generation | yes | local |

`npm test` runs the two CI gates: every colocated spec, then clean generation
and audit of the branch's current target set.

### TYPE AND COLOCATED SPECS

`test:unit` runs strict TypeScript checking followed by every `*.spec.ts` under
`src`. Tests live beside the implementation they constrain:

```
src/mame/video-compiler.ts
src/mame/...generic compiler specs...
src/games/pooyan.ts
src/games/pooyan.spec.ts
```

These specs cover source parsing, graph construction, IR lowering, generated
source topology, CPU/device semantics, and hardware-neutral runtime behavior.
The game specs verify the named MAME source contract used by each supported
machine. They do not load ROMs or import a handwritten game implementation.
`npm run build` is also non-emitting, so colocated specs and QA tokens can
never be compiled into or pollute the canonical generated `dist` tree.

### CURRENT CLEAN GENERATION

`test:current` invokes `gen:all`, which deletes `dist`, generates Pac-Man,
Pooyan, Time Pilot, Space Invaders, Galaxian, Galaga and Dig Dug from MAME,
builds their shared hardware closure and app, then runs the generated-output
audit. It detects stale-output masking, missing modules, unsupported hardware,
duplicate trees, embedded machine JSON, imports from `src`, and blocked
catalog entries.

### ALL-TARGET GENERATION

`test:generation` retains the wider 12-arcade-plus-NES compiler contract. It is
intentionally separate while targets are being restored one at a time. Run it
before broad parser, KG, IR schema, hardware closure, or app registry changes.

### GENERATED GAME BEHAVIOR

`test:games` imports the compiled modules from `dist`, loads local ROMs, and
executes each generated board for the frame count declared by its token. For
each supported game it checks:

- every required ROM slot and CRC;
- assembled region hashes;
- generated coin and start input bindings;
- native framebuffer dimensions;
- exact framebuffer hashes at each token's checkpoints;
- exact CPU/device state hashes at the same checkpoints;
- generated audio register write count and trace hash;
- required named-device activity for composite paths, including source clock
  events where decoding depends on them;
- generated PCM hash and RMS level;
- visible frame progression and non-silent output;
- measured full-contract throughput above the token's minimum fps.

Each token owns its checkpoint and input schedule because machines reach their
input-ready attract state at different times. Frame counts range from 600 to
2,400 so each golden reaches active gameplay; Galaga and Dig Dug use longer
contracts to cover their three-CPU self-tests before coin and start input.
Every action has deterministic press and release durations. A test failure
therefore identifies a changed trajectory, not only a final screenshot.

The throughput measurement includes CPU execution, generated video, checkpoint
hashing and deterministic audio probing. It is not the browser's presentation
counter, but it catches runtime complexity regressions before they make a game
miss real time. Tokens currently require 45 fps, except Time Pilot's 40 fps
floor, which leaves enough host-load tolerance while still detecting its
original 12 fps rendering regression. These floors leave headroom for shared
development and CI machines while rejecting Time Pilot's original uncached
scanline implementation and Galaga's original interpreted 05XX hot loop.

Generated device code must additionally pass a compiled-versus-interpreted
differential spec. Compare emitted writes, framebuffer effects and every device
member after identical calls. A relative performance assertion belongs with a
proven hot loop; absolute real-time acceptance remains in the game token.

## 3. GAME TOKENS

The `src/games` directory is the supported-machine QA inventory. Each machine
has one deliberately small token:

```
src/games/pacman.ts
src/games/pacman.spec.ts
src/games/pooyan.ts
src/games/pooyan.spec.ts
src/games/timeplt.ts
src/games/timeplt.spec.ts
src/games/invaders.ts
src/games/invaders.spec.ts
src/games/galaxian.ts
src/games/galaxian.spec.ts
src/games/galaga.ts
src/games/galaga.spec.ts
```

The token declares only:

- MAME short name, category, driver and machine configuration;
- ROM environment variable;
- expected screen and generated audio kind;
- full-contract minimum fps;
- frame checkpoints and input schedule;
- compact hashes for the accepted generated behavior.

It must never contain CPU instructions, address-map behavior, graphics decode,
palette logic, sprite drawing, sound synthesis, or a board implementation.
Those facts must continue to come from MAME through AST, KG and typed IR
lowering.

Shared mechanics belong in `acceptance-harness.ts`. The harness owns ROM
assembly, generated module loading, input dispatch, frame stepping, generated
audio probing and comparison. Adding a game should add data and focused source
assertions, not copy the harness.

### WHY THE OLD POOYAN FILES DID NOT SCALE

`src/gen/pooyan-acceptance.ts` gave a game-specific executable to the generic
generation package. Every additional game would have encouraged another copy
of ROM loading, keyboard events, frame scheduling and audio sampling. It also
made `src/gen` look responsible for Pooyan runtime behavior.

`src/mame/pooyan-video-compiler.spec.ts` was a useful test in the wrong
ownership namespace. It described a supported game's source contract, not the
generic video compiler in isolation. A growing list of game-named files under
`src/mame` would hide which games are intentionally supported and scatter each
game's acceptance evidence across unrelated packages.

The assertions were not discarded. They now live in `src/games/pooyan.spec.ts`
beside the Pooyan token, while generic video lowering remains in
`src/mame/video-compiler.ts`. This preserves colocated tests without confusing
generic compiler ownership with the supported-game inventory.

## 4. RUNNING REAL-ROM CONTRACTS

Generate a clean current distribution first:

```sh
npm run test:current
npm run test:games
```

The default ROM locations are:

```text
roms/arcade/pacman.zip
roms/arcade/pooyan.zip
roms/arcade/timeplt.zip
roms/arcade/invaders.zip
roms/arcade/galaxian.zip
roms/arcade/galaga.zip
roms/arcade/digdug.zip
roms/arcade/mpatrol.zip
```

Override them without moving files:

```sh
MAMEKIT_PACMAN_ROM=/path/pacman.zip \
MAMEKIT_POOYAN_ROM=/path/pooyan.zip \
MAMEKIT_TIMEPLT_ROM=/path/timeplt.zip \
MAMEKIT_INVADERS_ROM=/path/invaders.zip \
MAMEKIT_GALAXIAN_ROM=/path/galaxian.zip \
MAMEKIT_GALAGA_ROM=/path/galaga.zip \
MAMEKIT_DIGDUG_ROM=/path/digdug.zip \
MAMEKIT_MPATROL_ROM=/path/mpatrol.zip \
npm run test:games
```

ROMs are copyrighted, gitignored, never copied into `dist`, and never placed
in CI. This is why CI can prove source extraction and generation but cannot
claim that a real game booted.

## 5. CHANGING A GOLDEN

Do not update a golden merely to make a failing test pass. First determine
which compiler, graph, IR, generated hardware, input, timing, video, or audio
change produced the difference.

After the new behavior has been compared with MAME and manually verified in
the browser, print candidate values with:

```sh
npm run test:games:record
```

To inspect the exact final native frame from a focused contract, set a PPM
output path:

```sh
MAMEKIT_CAPTURE_FRAME=/tmp/digdug.ppm \
MAMEKIT_UPDATE_GOLDENS=1 \
node -e "import { runGameAcceptance } from './src/games/acceptance-harness.ts'; import { digdug } from './src/games/digdug.ts'; await runGameAcceptance(digdug)"
```

Review the output and edit only the affected token. Then rerun
`npm run test:games` without the recording flag. A review should be able to
explain every changed region, frame-state, video, write, or PCM hash.

Region hash changes normally mean a different ROM set or patch and require
special scrutiny. A framebuffer-only change points toward video or timing. A
state hash change before the video changes points toward CPU/device/input
execution. Audio write changes point toward board/device routing; PCM-only
changes point toward generated synthesis or resampling.

## 6. ADDING A SUPPORTED GAME

1. Add `src/games/<game>.ts` using an existing token as the schema example.
2. Add `src/games/<game>.spec.ts` for source facts and lowering rules that are
   essential to that machine.
3. Export the token from `src/games/contracts.ts`.
4. Keep the token free of emulation behavior.
5. Generate only the new game while bringing it up.
6. Verify ROM loading, coin/start, video and audio manually.
7. Run `test:games:record`, review the candidate baseline, and add it.
8. Add the game to `gen:all` only after its real-ROM contract passes.
9. Run `npm test`, `npm run test:games`, and the relevant browser checks.

If a new title requires changes to `acceptance-harness.ts`, first decide
whether the requirement is a reusable hardware category or an accidental
game-specific branch. The harness may gain generic DSP or input capabilities;
it must not gain game logic.

## 7. CI CONTRACT

`.github/workflows/ci.yml` runs on pushes and pull requests. It:

1. checks out MAMEKIT;
2. sparse-checks out the pinned MAME source commit used to establish these
   contracts;
3. installs the locked npm dependencies on Node.js 24;
4. runs every colocated spec;
5. deletes `dist`, regenerates Pac-Man, Pooyan, Time Pilot, Space Invaders,
   Galaxian, Galaga and Dig Dug, and audits the result.

The MAME commit is pinned deliberately. Updating it is a source migration and
must be reviewed separately from a MAMEKIT implementation change. Run all
source, generation and real-ROM gates before changing the pin.

## 8. FAILURE TRIAGE

| Failure | Start investigation at |
|---|---|
| Game source spec | driver AST, KG reachability, named lowering rule |
| Type check | changed IR/runtime contract or stale import |
| Clean generation | generator diagnostics and runtime report |
| Generated audit | output ownership, duplicate/stale files, blocked hardware |
| Region hash | ROM revision, clone matching, driver-init patches |
| Early state hash | CPU, memory map, reset, interrupt or device callback |
| State changes after input | binding polarity, port mapping, coin/start timing |
| Video hash only | palette, graphics decode, tile/sprite rendering, crop/rotation |
| Audio write hash | sound map, latch, callback, sound CPU/device routing |
| PCM hash only | generated DSP, chip clock, gain, mute or resampling |
| Browser only | app registry, URL/MIME, canvas, AudioWorklet or scheduler |

Always reproduce after a clean generation. A mixed `dist` is not valid test
evidence.
