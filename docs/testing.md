# Testing

Specs are plain TypeScript programs run directly by Node. Tests are divided by
the boundary they protect.

## Unit and compiler tests

```sh
npm run test:unit
```

This runs strict type checking plus specs for:

- MAME-specific AST and macro extraction;
- opcode, CPU, device, handler, video and audio lowering;
- generic generated CPU/device/handler/video/frame execution;
- machine emission and runtime reports;
- console cartridge parsing.

These tests target source generation and generic IR behavior. They must not
reintroduce handwritten MAME hardware implementations under `src/runtime`.

## Generated distribution audit

```sh
npm run audit:generated
```

The audit checks every generated game present in `dist/games/arcade` and
`dist/games/consoles`. It verifies required machine/provenance files, generated
callbacks and screen plans, hardware closure artifacts, registry imports,
self-contained paths, absence of legacy `app/modules`, and absence of embedded
serialized IR in generated JavaScript.

## Clean all-target generation

```sh
npm run test:generation
```

This is the broad, destructive gate: it removes `dist`, generates every target
in `REQUIRED_TARGETS`, emits the shared hardware closure, compiles the app, and
runs the generated audit. Use it when changing shared extraction, lowering,
layout or build contracts.

## Real-ROM acceptance

```sh
npm run test:pooyan
```

The Pooyan acceptance test reads the local gitignored ROM, imports compiled
modules from `dist`, and checks ROM validation, coin/start input, CPU progress,
video hashes, frame timing, AY register traffic and audible PCM output.

Acceptance tests must exercise generated `dist` artifacts. A source-side fake
or handcrafted chip port would test the wrong architecture.

## Browser verification

Serve the already-generated tree and open `/app/g/<game>/`. Drop the local ROM
through the real file picker and verify:

- the menu and categorized config load;
- JSON module imports succeed with the static server MIME types;
- the framebuffer is nonblank and correctly framed;
- coin/start/gameplay inputs work;
- audio worklets resolve from `dist/runtime/generated/audio`;
- frame rate is stable and there are no page or console errors.

Use Playwright screenshots and canvas-pixel checks for UI-facing changes.
