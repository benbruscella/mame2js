# Generator

mamekit is a MAME source compiler, not a generic C++ transpiler. It combines
MAME-specific source-preserving ASTs, macro/opcode DSL parsers, the knowledge
graph, and typed IR lowering to produce a self-contained browser application.

## Output

```
dist/
├── app/
│   ├── index.html
│   ├── main.js
│   ├── registry.js
│   └── g/<game>/index.html
├── runtime/
│   ├── core/                 compiled generic browser runtime
│   └── generated/            source-derived hardware, audio, DSL and IR
├── games/
│   ├── arcade/<game>/
│   └── consoles/<system>/
├── games.json
└── index.html
```

Every game/system directory contains graph exports, configuration, metadata,
documentation and:

```
generated/
├── board.ts          small composition source
├── board.js          compiled browser module
├── machine.json      complete typed machine IR
└── provenance.json   MAME source locations used by the machine
```

JSON is data. TypeScript/JavaScript is behavior. Generated modules import JSON
files instead of embedding serialized JSON strings.

## Pipeline

1. `src/mame/ast.ts` indexes the MAME C++ dialect while `src/kg/parse.ts`
   handles MAME's declarative macros.
2. `src/kg/build.ts` creates the full driver knowledge graph and a target game
   subgraph.
3. `src/gen/generate.ts` derives browser config, ROM/input facts, metadata and
   documentation from that graph.
4. `src/gen/emit-machine.ts` lowers the graph and compiled video/handler plans
   into `machine.json` plus the generic board composition module.
5. `src/mame/hardware.ts` resolves the hardware closure used by selected games
   and emits source-derived CPU, device, audio and opcode artifacts.
6. `buildApp()` stages app, runtime, hardware and game modules in
   `dist/.build`, compiles them together, copies only canonical output to
   `dist`, then removes the temporary tree.

The compiler uses the knowledge graph as more than a node viewer: graph edges
select machine dependencies, address-map handlers, callbacks, screen updates,
hardware closure membership, ROM/input facts and provenance.

## Categorization

MAME `GAME(...)` targets emit under `games/arcade`. MAME console/system targets
emit under `games/consoles`. The generated `dataPath` in config and
`dist/games.json` lets app code resolve either category without guessing.

## Runtime boundary

`src/runtime` contains only browser services and generic typed-IR execution.
Generated MAME hardware lives under `dist/runtime/generated`; game-specific
machine behavior lives under `dist/games`. Do not add a handwritten MAME chip,
sound core, renderer or board family to `src/runtime`.

When lowering fails, make the smallest general improvement in one of:

- the MAME-specific AST or macro parsers;
- the knowledge graph schema/edges;
- a typed hardware/handler/video/audio IR compiler;
- the generic runtime's operation vocabulary.

## Commands

```sh
npm run gen:all             # cleans dist, generates selected games, runtime, app
npm run audit:generated     # validates layout, source provenance and closure
node bin/mamekit.js <game>  # generate one target and rebuild the app
node bin/mamekit.js --serve # serve an existing distribution
```

`gen:all` must always clean `dist` first. This prevents deleted files, renamed
paths and old app copies from surviving into a mixed distribution.

## Self-containment

The browser distribution must not import `src`, MAME C++, or files outside
`dist`. The app registry imports canonical modules from `runtime/generated` and
`games/<category>/<game>/generated`; it does not copy them under `app`.

All browser URLs are relative so the same tree works at `/`, under a GitHub
Pages base path, and at mamehistory.com.
