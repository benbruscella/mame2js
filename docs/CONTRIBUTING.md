# CONTRIBUTING

This guide defines how to change MAMEKIT and how to add a machine without
turning the repository into a collection of handwritten emulator ports.

Read [SYSTEM ARCHITECTURE](SYSTEM_ARCHITECTURE.md) before changing compiler
boundaries. Read [TESTING](TESTING.md) before accepting a generated behavior
change or recording a game golden.

## 1. CONTRIBUTION CONTRACT

MAMEKIT is a MAME-source compiler, not a general C++ transpiler and not a
TypeScript rewrite of MAME. Contributions must preserve these invariants:

1. Emulated hardware behavior comes from MAME source, macro DSLs, opcode DSLs,
   the knowledge graph, and typed intermediate representations.
2. `src/runtime` contains only generic IR execution and browser services. It
   must not contain handwritten MAME CPUs, sound chips, video systems, boards,
   or game drivers.
3. Machine-specific facts belong in MAME source-derived graph or IR data, not
   in game-name conditionals.
4. A generated distribution is self-contained. Files under `dist` must not
   import `src`, absolute local paths, or another stale build tree.
5. Unsupported source forms fail visibly through diagnostics and reports.
   They are not silently approximated to make a catalog entry appear playable.
6. ROMs are supplied locally for testing. They are never fetched, committed,
   copied into `dist`, or used in CI.

MAME-specific assumptions are expected. It is reasonable for a compiler to
understand MAME conventions such as `_AUDIO` device types, `mute_w`, address
map builders, `GAME` macros, or an opcode-list DSL. It is not reasonable for a
shared emitter or runtime to ask whether the current game is `invaders`,
`pooyan`, or any other short name.

Hardware-specific compilers are also valid when the hardware is identified by
the extracted machine graph and its MAME source definition. The distinction is
important: a generated AY8910 implementation is reusable source lowering; a
checked-in `pooyan-sound.ts` implementation is a game port.

## 2. DEVELOPMENT ENVIRONMENT

Required:

- Node.js 23.6 or newer;
- dependencies installed with `npm ci`;
- a MAME checkout, normally at `../mame`;
- legally obtained local ROMs for acceptance and browser testing only.

Override MAME discovery with either:

```sh
export MAME_SRC=/path/to/mame
node bin/mamekit.js <target> --mame-src /path/to/mame
```

Start from a valid repository and compiler baseline:

```sh
npm ci
npm run test:unit
npm run test:current
```

`test:current` deletes and regenerates `dist`. Do not preserve local changes
there; it is disposable compiler output.

## 3. CHOOSE THE CORRECT OWNER

Fix the earliest stage that has lost or misrepresented the MAME fact.

| Evidence | Correct owner |
|---|---|
| Declaration, macro, clock, map, ROM, input, or graphics fact is absent | `src/kg/parse.ts` or graph construction |
| C++ class, method, statement, or source span is absent | MAME AST/source discovery |
| Required entity exists but is not reachable | knowledge-graph edge or closure logic |
| Handler syntax cannot be represented | handler IR parser or operation vocabulary |
| CPU instruction or state semantics differ from MAME | CPU compiler, opcode DSL, or code generator |
| Device method cannot execute | generic device compiler or handler lowering |
| Palette, bitmap, tile, sprite, crop, or rotation is wrong | video compiler and generated video plan |
| Audio ports, topology, clocks, components, routing, or gain are wrong | audio compiler and generated audio IR/worklet |
| Correct IR executes incorrectly for multiple machines | generic runtime |
| Only one game appears to need a shared-code branch | graph or IR is missing a source-derived fact |

Do not start by patching the visible browser symptom. Inspect the graph,
machine IR, hardware closure, provenance, and diagnostics first.

## 4. ADDING A MACHINE

The target outcome is a small QA token plus reusable compiler improvements.
Adding the next machine should not add a board implementation, CPU port,
renderer, or sound class under `src`.

### QUICK PATH

For an already listed target, the normal sequence is:

```sh
node bin/mamekit.js graph <target>       # inspect extraction first
npm run clean
node bin/mamekit.js <target> --skip-app  # generate only this machine
node bin/mamekit.js --build-runtime --build-app --targets <target>
npm run audit:generated
npm run serve                            # verify ROM, input, video and audio
```

Do not add the target to `gen:all` while it is still being brought up. First
fix graph, IR and generated-hardware gaps in isolation; add its adjacent game
token and golden only after the generated machine is credible.

### STEP 1: IDENTIFY AND REGISTER THE TARGET

Use the MAME short name. If it is a new required target, add it to
`src/gen/targets.ts`. Do not add it to `package.json`'s `gen:all` list yet;
that list is the currently accepted working set.

Extract its graph:

```sh
node bin/mamekit.js graph <target>
```

Inspect the CLI digest and generated graph. Confirm:

- game/system declaration, parent and category;
- machine configuration call chain;
- CPU and device tags, types and clocks;
- program and I/O maps, masks, shares and handlers;
- ROM regions, loads, offsets, sizes and hashes;
- input polarity, defaults and DIP switches;
- graphics layouts, decode entries and palette dependencies;
- callbacks, interrupts, screen timing and source locations;
- audio routes and source-defined sound hardware.

Useful output is under:

```text
dist/games/arcade/<target>/
dist/games/consoles/<target>/
```

`graph.json` is the target-reachable graph. `graph.full.json` contains the
full parsed driver context. If either is visibly incomplete, fix extraction
before attempting browser debugging.

### STEP 2: GENERATE THE TARGET IN ISOLATION

Always begin from an empty distribution:

```sh
npm run clean
node bin/mamekit.js <target> --skip-app
node bin/mamekit.js --build-runtime --build-app --targets <target>
npm run audit:generated
```

Inspect at least:

```text
generated/machine.json
generated/provenance.json
runtime-report.md
runtime-report.json
dist/runtime/generated/hardware-report.md
dist/runtime/generated/hardware-manifest.json
```

The generated board module should be a small composition wrapper around JSON
machine IR and generic runtime construction. Large constants or game logic in
that module indicate that behavior is being emitted at the wrong layer.

### STEP 3: CLOSE GENERATION GAPS

Treat each failure as evidence about a missing compiler capability:

1. A generator error usually identifies a parser, reachability, or unsupported
   source-shape gap.
2. A missing handler identifies the exact method or MAME expression that needs
   generic lowering.
3. A blocked hardware type identifies a CPU, device, video, or audio definition
   absent from the generated hardware closure.
4. Incorrect runtime behavior with correct IR identifies a generic executor
   defect.

Implement the narrowest reusable lowering rule that faithfully represents the
MAME source. Preserve the source file and span in the resulting IR. Add a
colocated compiler spec for every new AST shape, expression, operation, or
hardware semantic.

Profile before adding an optimization. If a source-derived device method is
slow because a large loop is walking handler IR, extend generic device codegen
rather than replacing the device with handwritten TypeScript. Keep unsupported
methods on the interpreter path and add a compiled-versus-interpreted
differential spec covering writes, framebuffer effects and complete device
state.

Never solve a gap by:

- adding `src/runtime/z80.ts`, `ay8910.ts`, or another handwritten chip;
- adding a game-named board, video, or audio runtime module;
- copying C++ behavior into a game token;
- checking `game === '<target>'` in shared code;
- checking a game-family device type when a generic MAME method or extracted
  capability expresses the same fact;
- marking unresolved hardware executable only to unblock the app;
- embedding serialized machine JSON in generated JavaScript;
- using Emscripten or WebAssembly as an alternate execution path.

### STEP 4: ADD THE QA TOKEN AND SOURCE SPEC

Add adjacent files:

```text
src/games/<target>.ts
src/games/<target>.spec.ts
```

Use an existing token only as a schema example. The token may declare:

- MAME short name, category, driver and machine configuration;
- ROM environment variable;
- expected native screen dimensions and generated audio kind;
- frame count, input schedule and minimum throughput;
- reviewed region, state, video and audio hashes.

It must not implement emulation behavior. The adjacent spec should assert the
MAME source facts and generated lowering essential to this machine. Generic
compiler behavior remains tested beside its compiler.

Export the token from `src/games/contracts.ts` only when it is ready to join
the real-ROM acceptance run. Extend `acceptance-harness.ts` only for a reusable
machine capability, never for game logic.

### STEP 5: VERIFY WITH REAL ROMS

Place the local archive at the token's default path or use its environment
variable. For example:

```sh
MAMEKIT_<TARGET>_ROM=/path/to/<target>.zip npm run test:games
```

Validate all of the following before recording a baseline:

1. every required ROM validates and assembles into the expected region;
2. reset and boot progress rather than settling into an error loop;
3. coin and start inputs work with the extracted polarity;
4. gameplay input reaches the machine;
5. orientation, visible area, crop and placement match MAME;
6. tiles, sprites, priorities, clipping, masks and colors remain correct during
   active gameplay, not only on the title screen;
7. audio routing works and pitch, timing, mute and gain are credible;
8. frame rate remains above the token threshold;
9. browser console and page error logs remain empty.

Run the generated app and inspect the actual canonical output:

```sh
npm run serve
```

Use screenshots and canvas-pixel checks at desktop and mobile sizes. Exercise
the game long enough to reach moving sprites, score areas, clipping boundaries,
interrupt-driven transitions, and audible effects.

Passing hashes do not prove correctness. A deterministic test can faithfully
preserve a deterministic bug. Compare questionable behavior with MAME or a
trusted reference before accepting it.

### STEP 6: RECORD AND REVIEW THE CONTRACT

Only after manual verification:

```sh
npm run test:games:record
```

Review the candidate values, add them to the token, then run the normal test:

```sh
npm run test:games
```

Do not update hashes merely to make a failing test pass. Explain whether each
change came from ROM assembly, CPU/device state, video, audio writes, generated
PCM, input timing, or an intentional source migration.

### STEP 7: JOIN THE CURRENT WORKING SET

After clean generation, audit, real-ROM acceptance, and browser validation all
pass, add the target to `gen:all`. Then regenerate every current machine from
an empty `dist` and verify that existing contracts remain unchanged.

```sh
npm test
npm run test:games
```

Run `npm run test:generation` after broad changes to parsing, graph
reachability, IR schemas, hardware closure, output layout, or app registration.
It covers the wider required-target inventory and is intentionally more
expensive than the current-game CI gate.

### DEFINITION OF DONE

A machine is ready for the current working set when clean generation and audit
pass, its runtime report has no hidden blocker, its real-ROM contract and
minimum fps pass, coin/start/gameplay/video/audio have been checked in the
browser, existing game goldens remain unchanged, and every new compiler rule
has a colocated reusable test. At that point the checked-in game-specific
surface should still be only `src/games/<target>.ts` and its adjacent spec.

## 5. TEST AND REVIEW REQUIREMENTS

Before submitting a change, run the smallest relevant checks while iterating,
then the complete applicable set:

```sh
npm run build
npm run test:unit
npm run test:current
npm run test:games              # requires local ROMs
git diff --check
```

Generated-output changes should also be inspected with:

```sh
find dist -maxdepth 5 -type f | sort
du -sh dist/app dist/runtime dist/games
rg -n "app/modules|/src/|JSON\.parse\(\"\{" dist
```

A pull request that adds or changes a machine should state:

- MAME target and source revision used;
- parser, graph, IR, codegen, or runtime capabilities added;
- why each capability is reusable rather than game-specific;
- generated audit result;
- real-ROM contract result and measured fps;
- browser checks performed, including coin/start/video/audio;
- intentional golden changes and their cause;
- known approximations or unsupported MAME behavior.

CI checks source/compiler specs and clean generation against a pinned MAME
revision. CI has no ROMs, so a green workflow does not replace local real-ROM
or browser evidence.

## 6. SOURCE AND OUTPUT HYGIENE

- Use `apply_patch` or ordinary edits for source; never hand-edit `dist` as a
  fix because regeneration will replace it.
- Keep tests beside the source or game token they constrain.
- Keep JSON as data and generated TypeScript/JavaScript as behavior.
- Preserve provenance whenever lowering MAME behavior.
- Keep the worktree's unrelated changes intact.
- Do not commit ROMs, generated temporary build trees, local media, or machine
  paths.
- Update documentation when a new compiler boundary, IR contract, command, or
  accepted approximation changes how the next engineer should work.

The measure of a successful machine contribution is not the number of files
added. It is how much more MAME source the compiler can faithfully understand
while keeping the checked-in runtime hardware-neutral.
