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
mamekit extractor          targeted parsers for MAME's macro DSLs
  ↓
machine knowledge graph    typed nodes/edges: CPUs, maps, ROMs, inputs, gfx
  ↓
browser-native configs     pure data + a shared hand-ported device library
+ dossiers                 (markdown per machine: chips, credits, history)
  ↓
mamehistory.com            playable exhibits in original cabinet artwork
```

What executes in your browser is the original machine code from your own
ROMs, run by hand-ported TypeScript CPU cores; the machine wiring (memory
and IO maps, clocks, video timing, input polarity, DIP switches) is
generated from parsing the real MAME driver source. **Zero runtime
dependencies** — plain DOM, canvas, Web Audio, native `DecompressionStream`.

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

## Why not just compile MAME to WebAssembly?

Compiling MAME to WASM runs MAME in the browser — a fine thing that already
exists. mamekit has a different goal: **extract machine knowledge from MAME
source and generate small, inspectable, browser-native exhibits** for
selected machines. Every fact on a machine page — memory map, chip roster,
clock tree, DIP sheet — is data you can read, link to, and learn from, not
bytes inside a compiled blob. The runtime is a legible device library
(a Z80 you can read in an afternoon), not an emulation monolith.

## Project shape

```
src/kg/        extractor + knowledge graph (parse, build, viewer, cypher)
src/gen/       graph -> config.json, dossiers, manifest, unified app
src/runtime/   the device library: CPU cores (Z80, M6809/KONAMI-1, I8080,
               M6803, MCS-48), sound cores (+AudioWorklets), video per
               family, boards per family, shell/menu
tools/         dev instruments (headless audio render, reference A/B)
docs/          written for cold-start sessions — start at docs/README.md
```

Adding a machine is regeneration plus whatever device cores are missing —
see [docs/adding-a-game.md](docs/adding-a-game.md). Every core ships with a
plain-Node spec suite (26 suites, ~3,400 checks): `npm test`.

## License

Code: see [LICENSE](LICENSE). ROMs and artwork remain the property of
their rights holders and are never included.
