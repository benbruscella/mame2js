# Runtime reference

`src/runtime/` is the browser host and generic execution layer for generated
MAME artifacts. It deliberately contains no TypeScript copies of Z80, AY8910,
LS259, MAME boards, or other emulated hardware.

The build places runtime output in two distinct trees:

```
dist/runtime/core/        compiled generic browser runtime
dist/runtime/generated/   MAME-derived CPU, device, audio and DSL artifacts
```

## Core contracts

### `types.ts`

- `Regions`: loaded ROM bytes indexed by MAME region tag.
- `BoardConfig`: graph-derived maps, clocks, screen timing and CPU metadata.
- `Board`: frame execution, framebuffer dimensions and debug snapshots.
- `InputPorts` and `BoardSinks`: host boundaries for controls, audio and data.

### `generated-machine.ts`

Defines and validates the typed machine IR emitted as each game's
`generated/machine.json`. The registry indexes machines by game key.

### `generated-board.ts`

Composes a machine from its generated CPU plans, memory maps, devices,
callbacks, scheduler, video plan and sound routes. Per-game `board.js` modules
only import `machine.json` and call this generic composition layer.

### `generated-cpu.ts`

Hosts executable CPU definitions produced by the MAME CPU compiler. The
generated definition supplies register layout, opcode programs, timing and
source provenance; the runtime supplies memory access and execution mechanics.

### `generated-device.ts`

Registers and instantiates source-derived device definitions. Generated device
IR owns device behavior and state shape; this module owns the generic lifecycle
and callback interface.

### `generated-handler.ts`

Evaluates typed handler programs lowered from MAME methods. It implements the
small operation vocabulary used by memory handlers, callbacks and generated
audio/device behavior.

### `generated-video.ts`

Executes source-derived palette, tilemap, sprite and screen-update plans against
ROM regions and shared memory. `gfx.ts` provides graph-driven graphics decoding,
not a game-specific renderer.

### `generated-frame.ts`

Runs scanline/frame events from generated screen timing and interrupt callback
plans. This keeps scheduling policy out of game-specific modules.

## Browser host

- `bus.ts`: constructs memory and I/O buses from generated address ranges.
- `input.ts`: maps graph-derived MAME ports and DIP defaults to browser input.
- `audio.ts`: owns the Web Audio boundary and queues writes for generated
  AudioWorklets under `dist/runtime/generated/audio/`.
- `shell.ts`: ROM validation, board startup, frame presentation and controls.
- `menu.ts`: game catalog and dossier UI using categorized `dataPath` values.
- `console.ts`: console cartridge room and generated console startup.
- `zip.ts`, `artwork.ts`, `cartstore.ts`: host-only file and browser services.

## Generation boundary

MAME C++ is read only while generating. The browser receives typed JSON,
generated JavaScript and source provenance, never C++ and never Emscripten
output. A missing hardware behavior is fixed in `src/mame/` lowering or in the
generic IR vocabulary, then regenerated into `dist`; it is not added as a
handwritten hardware module under `src/runtime/`.

## Testing

Tests under `src/mame/` verify AST parsing, opcode/device/audio/video lowering
and generated source. Tests under `src/runtime/` verify the generic execution
vocabulary. Real-ROM acceptance tests validate the generated artifacts in
`dist`, including input, timing, video and audio.
