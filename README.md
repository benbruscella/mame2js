# mamekit

The source extraction, knowledge graph and browser runtime toolkit behind
**[MAME History](https://mamehistory.com)**.

mamekit is **not a MAME replacement, not a ROM site, and not a universal
C++ transpiler**. It is a toolkit for exploring selected arcade, console and
computer systems through the hardware knowledge preserved in
[MAME](https://github.com/mamedev/mame)'s source code.

```
MAME source
  ↓
mamekit source compiler    targeted ASTs for MAME C++ and macro/opcode DSLs
  ↓
typed machine/device IR    executable behavior with source provenance
  ↓
machine knowledge graph    reachability, audit, history and documentation
  ↓
generated TypeScript       machine wiring and reachable hardware in dist/
+ browser host ABI         canvas, audio transport, input, ROMs and storage
  ↓
mamehistory.com            playable exhibits in original cabinet artwork
```

What executes in your browser is the original machine code from your own
ROMs, run by readable TypeScript generated from the reachable MAME CPU,
device, and driver source. Machine wiring, clocks, video timing, inputs,
graphics, and sound behavior use the same source-aware compiler pipeline.
**Zero runtime dependencies** — plain DOM, canvas, Web Audio, native
`DecompressionStream`.

Handwritten TypeScript copies of MAME CPUs, sound chips, video devices, or
family boards are migration failures, not runtime architecture. Maintained
`src` code is limited to the MAME-specific compiler and a hardware-neutral
browser host ABI; generated MAME-domain implementation belongs in `dist`.

## The machines

| Machine | Year | Status |
|---|---|---|
| Galaga | 1981 | Playable · audio partial (54xx HLE) |
| Pac-Man | 1980 | Playable |
| Galaxian | 1979 | Playable |
| Gyruss | 1983 | Playable · audio partial (filters approximated) |
| Space Invaders | 1978 | Playable · SFX synthesized |
| Moon Patrol | 1982 | Playable · audio partial |
| Ghosts'n Goblins | 1985 | Playable · YM2203 FM |
| Juno First | 1983 | Playable · audio under reference comparison |

Statuses are deliberately honest: *Boots → Playable → Audio partial →
Audio complete → Reference compared → Museum quality.* See
[issue #12](https://github.com/benbruscella/mamekit/issues/12) for the
audio-fidelity work in flight.

## ROMs — the calm version

**No ROMs are hosted, distributed, fetched, or stored. Anywhere.** Bring
your own legally obtained romsets: the arcade screen becomes a drop target
that shows exactly which chips the zip must contain and verifies every one
(name, CRC32, and clone-revision alternates — all derived from the driver
source) before booting. The bytes live in your page's memory and die with
it. MAME History is an independent project and is not affiliated with or
endorsed by MAMEDEV.

## Quick start

```sh
git clone https://github.com/benbruscella/mamekit
cd mamekit && npm install            # typescript only (dev dep)

# needs a MAME source checkout as sibling (../mame) or --mame-src/$MAME_SRC
node bin/mamekit.js galaga           # extract + generate one machine
node bin/mamekit.js --serve          # serve everything (no MAME tree needed)
```

Open **http://localhost:8280/app/** — the shelf. Click a machine to read
its story (driver credits, contribution history, Gaming History write-up),
then Play. Machines live at `/app/g/<game>/`; each also gets a knowledge
graph viewer (`/​<game>/viewer.html`) and a markdown dossier
(`/​<game>/README.md`).

Controls: **arrows** move · **Space/X** fire · **Z** button 2 · **5** coin ·
**1** start · **Esc** back to the shelf.

Requires **Node ≥ 23.6** (the CLI is TypeScript run natively; the only
build step is `tsc` for the browser app).

## Why not compile MAME to WebAssembly?

Compiling MAME to WASM runs MAME in the browser — a fine thing that already
exists. mamekit has a different goal: **extract machine knowledge from MAME
source and generate small, inspectable, browser-native exhibits** for
selected machines. Every fact on a machine page — memory map, chip roster,
clock tree, DIP sheet — is data you can read, link to, and learn from, not
bytes inside a compiled blob. Mamekit does not use Emscripten or WebAssembly
for emulation. Its executable output is readable TypeScript with links back
to the MAME source constructs that produced it.

## Project shape

```
src/kg/        extractor + knowledge graph (parse, build, viewer, cypher)
src/mame/      MAME C++/macro/opcode DSL ASTs and typed lowering
src/gen/       IR -> generated TypeScript, configs, dossiers, unified app
src/runtime/   hardware-neutral browser ABI, scheduler, shell and presentation
dist/          generated machine and reachable MAME hardware implementation
tools/         dev instruments (headless audio render, reference A/B)
docs/          written for cold-start sessions — start at docs/README.md
```

Adding a machine extends the source-compiled hardware closure rather than
adding a handwritten family implementation. See issue
[#21](https://github.com/benbruscella/mamekit/issues/21) for the active
migration and acceptance criteria.

## License

Code: see [LICENSE](LICENSE). ROMs and artwork remain the property of
their rights holders and are never included.
