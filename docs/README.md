# mame2js documentation

Docs written for **future working sessions (human or agent)** — everything you
need to pick this project up cold. Read this index, then the file matching
your task.

| File | Read when you need... |
|------|------------------------|
| [architecture.md](architecture.md) | The big picture: pipeline phases, design decisions and their rationale, the reuse contract |
| [knowledge-graph.md](knowledge-graph.md) | Graph schema, parsers, what is/isn't extracted, viewer, Cypher/Neo4J |
| [runtime.md](runtime.md) | Every runtime module: Z80, bus, Namco chips, video, sound, shell — with the hardware facts baked in |
| [generator.md](generator.md) | How `config.ts` is derived from the graph; handler-key conventions; what fails loudly and why |
| [adding-a-game.md](adding-a-game.md) | The playbook for game #2 (Bosconian / Dig Dug / Xevious) |
| [testing.md](testing.md) | Running the spec suites, the synthetic-ROM smoke test, browser verification |
| [gotchas.md](gotchas.md) | **Read before changing anything.** Hard-won facts that are not obvious from the code |
| [TODO.md](TODO.md) | Prioritized backlog with context for each item |

## Sixty-second orientation

```
mame2js galaga --serve
```

1. Finds `GAME(..., galaga, ...)` in the MAME source tree (auto-detected at
   `../mame` or parent; override with `--mame-src` / `$MAME_SRC`).
2. Parses the driver's macro DSLs into a **knowledge graph**
   (`dist/galaga/graph.json`, `.cypher`, interactive `viewer.html`).
3. **Generates** `dist/galaga/config.json` (ROM manifest, memory map, clocks,
   screen, sound kind, DIPs, key bindings) — pure data, no per-game compile.
4. (Re)builds the **unified app** at `dist/app/` (one runtime compile hosting
   every generated game) and serves on **http://localhost:8280/app/** —
   the boot menu ("video-store shelves" + search). `/app/?g=galaga` boots the
   game; Esc returns to the menu. `mame2js --serve` alone serves everything
   without needing the MAME tree.
5. ROMs: `roms/<game>.zip` auto-loads (or drag-and-drop). Never committed.

State as of 2026-07-05: **Galaga boots and plays** — attract mode, coin-up,
gameplay, scoring, results screen, 60 fps, sound core spec-verified (not yet
ear-verified). See [TODO.md](TODO.md) for what's missing (54xx explosion
noise is the headline).

## Ground rules (user requirements — do not violate)

- **Zero runtime dependencies.** Plain DOM, canvas, Web Audio, native
  `DecompressionStream`. `typescript` is the only dev dependency.
- **Knowledge-graph-first.** Game-specific facts come from the graph, never
  hard-coded. New games should be regeneration + missing device cores only.
- **The runtime is a device library.** CPU, machine framework, video, sound,
  run loop, controls are game-agnostic and should "hardly be touched" when
  adding games.
- **ROMs are copyrighted.** `roms/` is gitignored; keep it that way.
- The project doubles as a **teaching tool** — the user wants visual,
  educational features (KG viewer, and see TODO for live-state overlay,
  memory-map bar, ROM anatomy gallery).
