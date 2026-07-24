# MAMEKIT

MAMEKIT is a MAME-source compiler for producing inspectable, browser-native
machine exhibits. It is the engineering toolkit behind
[MAME History](https://mamehistory.com).

The project treats MAME source as an archival technical record. It extracts
machine facts and executable behavior from selected MAME drivers, preserves
source provenance through a knowledge graph and typed intermediate
representations, and generates a self-contained web application.

MAMEKIT is deliberately:

- **MAME-specific**, not a general C++ transpiler;
- **source-derived**, not a collection of handwritten TypeScript chip ports;
- **inspectable**, not an opaque native or WebAssembly build of MAME;
- **selective**, generating verified machines rather than claiming universal
  driver compatibility;
- **ROM-free**, requiring users or tests to supply legally obtained dumps.

## SYSTEM MODEL

```
MAME C++ and macro/opcode DSLs
                |
                v
MAME-specific source-preserving ASTs
                |
                v
machine knowledge graph + source provenance
                |
                v
typed machine / handler / CPU / device / video / audio IR
                |
                v
generated JSON + TypeScript/JavaScript in dist
                |
                v
generic browser host: canvas, Web Audio, input, files, scheduling
```

The original program code from the supplied ROM executes in generated CPU
definitions. MAME machine configuration, address maps, callbacks, graphics,
video, sound, and device behavior are lowered from MAME source. Checked-in
runtime code provides generic IR execution and browser services only.

There is no Emscripten emulation build and no checked-in TypeScript copy of
MAME hardware.

## QUICK START

Requirements:

- Node.js 23.6 or newer;
- this repository;
- a MAME source checkout at `../mame`, or an explicit `--mame-src` /
  `MAME_SRC` path;
- local ROMs only for acceptance or browser testing.

```sh
npm ci
npm run gen:all
npm run test:unit
npm run audit:generated
npm run serve
```

`npm run gen:all` always deletes `dist` before generation. The current branch
keeps that command scoped to Pac-Man, Pooyan, Time Pilot, Space Invaders,
Galaxian, Galaga, Dig Dug, Moon Patrol and Roc'n Rope while the
source-generation pattern is validated one machine at a time.

The generated application is served at `http://localhost:8280/app/`.

## REPOSITORY MAP

```
src/mame/       MAME ASTs, opcode DSL parsing, typed lowering and hardware closure
src/kg/         knowledge-graph construction, schema, Cypher and viewer
src/gen/        machine/config emitters, app build, reports and generated audits
src/games/      small supported-game QA tokens, source specs and shared acceptance
src/runtime/    browser host and generic typed-IR execution
bin/            CLI entry point
scripts/        deployment automation
tools/          engineering diagnostics
docs/           current architecture, contribution, engineering and QA references
sessions/       historical build transcripts; never current instructions
dist/           disposable generated distribution
```

## GENERATED DISTRIBUTION

```
dist/
├── app/                         app entry, registry and static game routes
├── runtime/
│   ├── core/                    compiled generic runtime
│   └── generated/               MAME-derived hardware, IR and audio modules
├── games/
│   ├── arcade/<game>/           arcade graph, machine, metadata and dossier
│   └── consoles/<system>/       console graph, machine, metadata and dossier
├── games.json                   generated catalog
└── index.html                   redirect to app/
```

The output is canonical and self-contained:

- app files are not duplicated under game directories;
- game modules are not duplicated under `app`;
- generated data is stored as JSON, not embedded in JavaScript strings;
- generated behavior imports canonical JSON and shared runtime modules;
- browser modules never import `src` or files outside `dist`.

`dist` is disposable. Never diagnose or preserve a mixed build: clean and
regenerate it.

## ENGINEERING DOCUMENTATION

There is one README and four current engineering documents:

- [SYSTEM ARCHITECTURE](docs/SYSTEM_ARCHITECTURE.md): system design, compiler stages,
  knowledge graph, typed IR, generated runtime, browser execution, provenance,
  and hard boundaries.
- [CONTRIBUTING](docs/CONTRIBUTING.md): contribution contract, adding a machine,
  fixing generation gaps, acceptance evidence, and review requirements.
- [ENGINEERING GUIDE](docs/ENGINEERING_GUIDE.md): commands, extending a target,
  debugging generation gaps, tests, browser verification, deployment, and
  maintenance rules.
- [TESTING](docs/TESTING.md): QA levels, supported-game tokens, deterministic
  real-ROM contracts, CI, golden review, and failure triage.

Historical transcripts are indexed by
[ARCHIVE INDEX](sessions/ARCHIVE_INDEX.md). Archive content records how the
project arrived here; it does not override current documentation or code.

## NON-NEGOTIABLE INVARIANTS

1. MAME hardware behavior is generated from MAME source.
2. `src/runtime` contains no handwritten MAME CPU, device, audio, video, or
   board implementations.
3. The knowledge graph is an executable dependency and provenance model, not
   only a visualization format.
4. JSON stores data; TypeScript/JavaScript stores behavior.
5. `dist` is cleaned before complete generation.
6. Generated output is self-contained and has one canonical copy of each
   artifact.
7. Arcade ROMs are never served, committed, or persisted by the application.
8. Unsupported source shapes fail visibly through diagnostics and reports.

## LEGAL AND PROJECT SCOPE

MAMEKIT does not contain or distribute ROMs. Artwork and historical material
remain the property of their rights holders. MAMEKIT is independent from and
not endorsed by MAMEDEV.

Current implementation work is tracked in
[GitHub issue 21](https://github.com/benbruscella/mamekit/issues/21).
