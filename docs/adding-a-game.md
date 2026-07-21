# Adding a game or console

The target workflow is generation work, not a handwritten port.

## 1. Register the target

Add the MAME short name to `src/gen/targets.ts` when it is ready to join the
supported generation suite. While validating one target, keep `gen:all` scoped
to the games currently known to work.

## 2. Extract and inspect

```sh
node bin/mamekit.js graph <game>
```

Inspect the CLI device/ROM digest and the generated graph:

```
dist/games/arcade/<game>/viewer.html
dist/games/consoles/<system>/viewer.html
```

The category comes from the MAME game/system declaration. Verify clocks,
address maps, callbacks, ROM regions, input ports, graphics layouts and source
provenance before debugging runtime behavior.

## 3. Generate in isolation

```sh
npm run clean
node bin/mamekit.js <game> --skip-app
node bin/mamekit.js --build-runtime --build-app --targets <game>
npm run audit:generated
```

Cleaning first is mandatory. The app must import the target from its canonical
`games/<category>/<game>/generated/board.js`, with no copy under `app`.

## 4. Close generation gaps

Typical failures and their correct owners:

| Failure | Fix |
|---|---|
| Missing graph fact or wrong source span | MAME AST/macro parser or KG builder |
| Unsupported C++ expression/statement | typed handler/device/video/audio lowering |
| CPU opcode diagnostics | opcode DSL or CPU compiler |
| Hardware closure marked non-executable | source-derived hardware compiler |
| IR operation cannot execute | generic generated runtime vocabulary |
| Wrong URL/category | output layout or generated `dataPath` |

Do not fix a gap by adding `src/runtime/<chip>.ts`, a game-named conditional, or
a handwritten board family. The improvement should be reusable by the next MAME
driver with the same source shape.

## 5. Verify with real ROMs

Use a local, gitignored legal ROM set. The browser never serves or persists
arcade ROMs; tests may read local files directly.

Verify, in order:

1. ROM manifest and CRC matching.
2. CPU boot progression and generated device state.
3. Coin, start and gameplay inputs.
4. Nonblank, correctly oriented video and stable frame rate.
5. Generated audio writes, pitch and timing.
6. Browser load with no console/page errors.

Add a deterministic acceptance test that imports the compiled artifacts from
`dist`, not a source-side hardware implementation. Pooyan's acceptance test is
the current example.

## 6. Run the gates

```sh
npm run test:unit
npm run audit:generated
npm run test:pooyan       # when touching shared Z80/Konami/AY behavior
```

For changes affecting all supported targets, run `npm run test:generation`.
That test deletes `dist`, generates every target in `REQUIRED_TARGETS`, builds
one self-contained app, and audits the result.

## 7. Add education assets

Confirm generated metadata, history, README and graph viewer are coherent.
Artwork is optional and remains outside the compiler contract. ROMs are never
published.
