# SYSTEM ARCHITECTURE

This document is the canonical technical description of MAMEKIT. It explains
what the system compiles, why each intermediate representation exists, where
behavior is allowed to live, and how the generated browser application runs.

## 1. PURPOSE AND BOUNDARY

MAMEKIT compiles selected MAME source into small, inspectable browser exhibits.
The objective is not to support arbitrary C++, reproduce all of MAME, or hide
MAME behind WebAssembly. The objective is to preserve and expose the machine
knowledge encoded in MAME while producing executable browser artifacts.

The compiler is allowed to assume MAME conventions:

- `GAME`, `CONS`, ROM, input, graphics and device macros;
- MAME driver/state classes and machine configuration patterns;
- address-map builder syntax;
- MAME CPU opcode DSL files such as `z80.lst`;
- MAME device lifecycle and callback idioms;
- known source-tree organization.

These assumptions are a feature. They keep the compiler focused, inspectable,
and maintainable.

## 2. CORE TERMS

### SOURCE AST

A source-preserving, MAME-specific representation of classes, methods, macros,
statements and source spans. It is not a complete ISO C++ semantic model.

### KNOWLEDGE GRAPH

The dependency and provenance model for a driver. Nodes represent games,
machine configurations, devices, maps, handlers, callbacks, ROMs, inputs,
graphics layouts and source files. Typed edges record how those entities are
connected.

### INTERMEDIATE REPRESENTATION (IR)

A typed, serializable execution plan lowered from source. MAMEKIT has several
focused IRs rather than one universal representation:

- machine composition IR;
- handler program IR;
- CPU/opcode IR;
- device IR;
- video/palette/rendering IR;
- audio plan IR.

### HARDWARE CLOSURE

The reachable set of CPU, device, audio and DSL definitions required by the
selected generated targets.

### BROWSER HOST

The checked-in, hardware-neutral runtime responsible for browser APIs, buses,
generic IR execution, scheduling, input, ROM ingestion, canvas, audio transport
and application presentation.

## 3. END-TO-END DATA FLOW

```
MAME checkout
    |
    | discover target declaration and related source units
    v
MAME AST + macro/opcode DSL parsers
    |
    | retain MAME source spans and source text
    v
full driver knowledge graph
    |
    | graph reachability from game:<target>
    v
target machine subgraph
    |
    | lower facts and behavior through focused compilers
    v
typed machine + hardware IR
    |
    | emit JSON data and small TypeScript behavior modules
    v
temporary unified TypeScript build
    |
    | compile and copy only canonical outputs
    v
self-contained dist/
```

Each stage has one responsibility. Parser fixes recover source structure. Graph
fixes recover relationships. IR compiler fixes recover executable semantics.
Runtime fixes add generic operations. Game-specific patches in the browser host
are not an accepted stage.

## 4. SOURCE DISCOVERY AND PARSING

The CLI finds the MAME source declaration for a target and caches driver
discovery in `dist/.driver-cache.json`. MAME is normally a sibling checkout at
`../mame`; callers can override it with `--mame-src` or `MAME_SRC`.

`src/mame/ast.ts` builds a small source-preserving AST for the MAME C++ dialect.
It records classes, inheritance, methods, member macros, statements, macro
calls and source spans. It follows source patterns required by selected MAME
drivers without pretending to be Clang.

`src/kg/parse.ts` handles declarative MAME DSLs, including:

- game/system declarations;
- ROM sets, regions and loads;
- machine configurations and device creation;
- address maps and map composition;
- input ports, DIP switches and included port sets;
- graphics layouts and decode tables;
- clocks and evaluable constant expressions.

`src/mame/opcode-dsl.ts` parses MAME CPU operation-list DSLs separately from
C++. The Z80 compiler expands macros while retaining definition and call-site
provenance.

The parser should reject or report unsupported source shapes. Silent fallback
is dangerous because it creates plausible but incorrect machines.

## 5. KNOWLEDGE GRAPH

The graph is assembled in `src/kg/build.ts`. Its primary purpose is compiler
reachability and provenance; the HTML viewer and Cypher export are secondary
views of the same model.

### IMPORTANT NODE TYPES

| Node | Responsibility |
|---|---|
| `Game` | target identity, category, machine/input/ROM references |
| `MachineConfig` | machine configuration method and inherited/called configs |
| `Device` | type, tag, clock and source configuration |
| `AddressMap` | memory or I/O address-space definition |
| `AddressRange` | range bounds, storage kind, sharing and handler references |
| `Handler` | source method and lowered executable program |
| `Callback` | interrupt, latch, timer or device callback wiring |
| `RomSet` / `RomRegion` / `Rom` | ROM topology, sizes, offsets and hashes |
| `InputPorts` / `Port` / `PortField` | electrical polarity, bindings and DIP facts |
| `GfxLayout` / `GfxDecode` | graphics bit layout and region relationships |
| `SourceFile` | source ownership and provenance anchor |

Important edge types include `USES_MACHINE`, `HAS_DEVICE`, `HAS_MAP`,
`HAS_RANGE`, `READS`, `WRITES`, `CALLS`, `PATCHES_MAP`, `HAS_REGION`,
`LOADS`, `USES_INPUTS`, `HAS_PORT`, `HAS_FIELD`, `DECODES`, `USES_LAYOUT`,
and `DEFINED_IN`.

`gameSubgraph()` performs reachability from the selected `Game` node. This
subgraph determines what machine facts and behavior can be emitted. The
hardware closure separately follows device types into shared MAME hardware
source.

### GRAPH OUTPUT

Each generated target includes:

- `graph.json`: target-reachable graph;
- `graph.full.json`: full parsed driver graph;
- `graph.cypher`: idempotent Neo4j import;
- `viewer.html` and `viewer.full.html`: standalone graph viewers.

Graph output lives under `dist/games/<category>/<target>/`.

## 6. MACHINE AND HANDLER LOWERING

`src/gen/emit-machine.ts` creates the complete generated machine definition.
The serialized machine contains:

- CPU instances and clocks;
- program and I/O maps;
- generated handlers and callbacks;
- shared-memory and device plans;
- screen timing and frame events;
- compiled video plan;
- sound routing metadata;
- source locations for executable elements.

The machine is emitted as `generated/machine.json`. The adjacent `board.ts` is
intentionally small: it imports the JSON, validates it through
`defineMachine()`, and delegates construction to `createGeneratedBoard()`.

Handler source is parsed into typed operations in `src/mame/handler-ir.ts`.
The operation vocabulary covers numeric expressions, state access, branches,
calls, memory/device access and returns needed by selected MAME methods.
Unsupported syntax produces diagnostics attached to generated reports.

The machine IR is the contract between source lowering and browser execution.
It must not contain browser APIs or game-specific TypeScript classes.

## 7. HARDWARE COMPILERS

`src/mame/hardware.ts` resolves the selected targets' hardware closure and
coordinates focused compilers.

### CPU

CPU definitions combine MAME class/state information with source-derived
instruction programs. Z80 lowers MAME's expanded `z80.lst` opcode DSL. I8080
lowers the 256 cases in MAME's `execute_one` C++ switch, its helper methods,
state aliases and cycle tables. `src/mame/cpu-compiler.ts` and
`cpu-codegen.ts` produce executable TypeScript plus auditable CPU IR. The
browser runtime supplies generic register, bus and program-execution machinery.

### DEVICE

`src/mame/device-compiler.ts` follows MAME device inheritance and methods,
lowers executable methods to typed programs, and emits device IR. Small device
modules import that JSON and register it with the generic device runtime.

`src/mame/device-codegen.ts` identifies methods with nested hot loops and emits
direct, static JavaScript for those methods plus their source-defined
dependencies. Selection is based on IR shape, not a game or device name. The
generated module attaches compiled methods to the same device definition; any
method omitted by codegen continues through the generic IR interpreter. This
keeps the interpreter as the semantic reference while removing per-operation
tree walking from pixel-scale loops such as the MAME 05XX starfield.

Compiled device methods are build artifacts, not handwritten runtime ports and
not runtime `eval`. Colocated specs execute emitted source against the
interpreter and compare writes and complete device state. Unsupported
expressions are excluded during generation rather than guessed or tested
speculatively during browser registration.

### VIDEO

`src/mame/video-compiler.ts` resolves screen-update methods, palette behavior,
graphics decode, tilemap and sprite operations into rendering plans. It also
recognizes MAME's direct packed-bitmap loops and lowers their source arithmetic
to a compact bitmap plan. This avoids interpreting one handler operation per
pixel while retaining the source method and memory-layout provenance. The
generic video runtime executes either plan against ROM regions and shared
memory.

### AUDIO

`src/mame/audio-compiler.ts` lowers supported MAME audio implementations and
emits AudioWorklet source plus audio IR. Worklets live under
`dist/runtime/generated/audio` and import shared operations from
`dist/runtime/core` when required.

The current audio profiles include Namco WSG, AY8910 with generated RC routing,
and MAME `DISCRETE` soundboards, including SN76477 and counter/LFSR topologies.
Discrete plans emit port wiring, method roles, control nodes, LFSR parameters,
component values, mixer resistances and route gains from MAME. Every such board
uses the runtime capability `sound.kind = "discrete"`; `sound.worklet` selects
the generated MAME-device artifact in `dist`. Runtime and QA code must never
branch on a game or board-family name.

Norton op-amp stages are lowered to stable browser component models; MAMEKIT
does not yet implement MAME's complete analog discrete solver. The generated
IR records that boundary instead of hiding it in a checked-in game sound class.

### DSL ARTIFACTS

Source-derived DSL AST/IR remains available as JSON for auditability. Data-only
artifacts do not get pointless JavaScript wrappers.

## 8. GENERIC RUNTIME

`src/runtime` is checked-in code, but it is not an emulated hardware library.
It has two responsibilities.

### GENERIC EXECUTION

- `generated-machine.ts`: validates and registers machine IR;
- `generated-board.ts`: composes generated CPUs, buses, devices and rendering;
- `generated-cpu.ts`: executes generated CPU definitions;
- `generated-device.ts`: instantiates generated device definitions;
- `generated-handler.ts`: evaluates handler programs;
- `generated-video.ts`: executes video plans;
- `generated-frame.ts`: schedules generated scanline/frame events.

### BROWSER SERVICES

- `bus.ts`: builds memory and I/O buses from generated ranges;
- `shell.ts`: ROM validation, machine startup and frame presentation;
- `input.ts`: keyboard state, MAME polarity and DIP defaults;
- `audio.ts`: Web Audio startup and generated worklet transport;
- `menu.ts`: catalog and dossier presentation;
- `console.ts`: console cartridge workflow;
- `zip.ts`, `artwork.ts`, `cartstore.ts`: file and browser persistence services.

A checked-in file implementing a specific MAME CPU, sound chip, device, board,
or renderer is an architectural regression.

## 9. BROWSER BOOT SEQUENCE

1. `/app/main.js` imports the generated registry.
2. The registry registers shared generated CPU/device definitions and each
   target's canonical generated board.
3. The route `/app/g/<target>/` resolves the target's generated `dataPath`.
4. The app fetches `games/<category>/<target>/config.json`.
5. Arcade targets request a user-supplied ROM zip and validate every required
   chip against graph-derived names and CRCs.
6. The shell creates the generated board, starts frame scheduling, presents the
   framebuffer, and activates generated audio worklets after a user gesture.

Static route pages use `<base href="../../">`; runtime URLs are relative to
`/app/`. Game metadata carries `dataPath`, so app code never guesses whether a
target is arcade or console.

## 10. BUILD AND OUTPUT LAYOUT

Complete generation starts with `rm -rf dist`. Per-target generation writes
canonical source/data under `dist/games`. Hardware generation writes canonical
source/data under `dist/runtime/generated`.

`buildApp()` then:

1. removes prior app, runtime core and temporary build trees;
2. stages runtime source, generated hardware and generated boards under
   `dist/.build/src` with their final relative topology;
3. creates generated app entry and registry source;
4. compiles the staged tree with TypeScript;
5. copies compiled `app`, `runtime` and `games` groups into canonical locations;
6. removes `dist/.build`.

The final layout is:

```
dist/
├── app/                       only app HTML and compiled entry/registry
├── runtime/
│   ├── core/                  compiled generic runtime
│   └── generated/             shared MAME-derived hardware
├── games/
│   ├── arcade/<game>/
│   └── consoles/<system>/
└── games.json
```

Generated game directories contain configuration, graphs, metadata, reports,
`DOSSIER.md`, and a `generated/` directory with `board.ts`, `board.js`,
`machine.json` and `provenance.json`.

## 11. DATA AND BEHAVIOR RULE

Large structured values are emitted as JSON. TypeScript and JavaScript import
that data and provide behavior. The generator must not serialize JSON into a
`JSON.parse("...")` source string.

This rule reduces duplicated output, keeps diffs inspectable, lets archival
tools consume IR without executing JavaScript, and separates compiler data from
browser behavior.

## 12. PROVENANCE AND AUDITABILITY

Source spans flow from MAME AST nodes through graph properties and typed IR.
Generated callbacks, handlers, CPU operations and devices retain their MAME
source locations wherever the compiler can establish them.

Generated runtime reports distinguish:

- source-resolved hardware;
- executable generated hardware;
- declarative browser-host services;
- unresolved or unsupported generation gaps.

`audit:generated` verifies canonical files, machine schema, callbacks, frame
events, screen plans, hardware artifacts, registry imports, absence of
handwritten MAME runtime files, absence of duplicated app modules, absence of
embedded serialized IR, and self-contained browser imports.

## 13. CATEGORY MODEL

MAME arcade game declarations emit under `games/arcade`. Console/system
declarations emit under `games/consoles`. Category is source-derived and part of
the generated manifest/config contract.

Category helpers live in `src/gen/output-layout.ts`. New code should use those
helpers or generated `dataPath`; it should not construct legacy `dist/<game>`
paths.

## 14. CONTENT AND SECURITY BOUNDARY

MAME source is a generation-time dependency and is not shipped. MAMEKIT does
not publish ROMs. Arcade ROM bytes are accepted from the browser user, validated
in memory, and discarded with the page. Console carts may be persisted only in
the visitor's browser through the explicit console workflow.

AudioWorklet requires a secure context outside localhost. Production therefore
uses HTTPS. All static URLs remain relative so the distribution can run at a
custom domain root or a GitHub Pages subpath.

## 15. DESIGN TEST

Before accepting a change, ask:

1. Did this fact come from MAME source or the graph?
2. Is this behavior represented in typed generated IR?
3. Is checked-in runtime code hardware-neutral?
4. Is the generated artifact canonical, inspectable and source-linked?
5. Will the same lowering improvement apply to the next MAME driver with the
   same source shape?

If the answer to any question is no, the change is probably at the wrong layer.
