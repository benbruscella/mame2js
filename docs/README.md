# mamekit documentation

Docs written for **future working sessions (human or agent)** — everything you
need to pick this project up cold. Read this index, then the file matching
your task.

| File | Read when you need... |
|------|------------------------|
| [architecture.md](architecture.md) | The big picture: pipeline phases, design decisions and their rationale, the reuse contract |
| [knowledge-graph.md](knowledge-graph.md) | Graph schema, parsers, what is/isn't extracted, viewer, Cypher/Neo4J |
| [runtime.md](runtime.md) | Every runtime module: CPUs (Z80/M6809/KONAMI-1/I8080/M6803), buses, sound cores, video, shell — with the hardware facts baked in |
| [generator.md](generator.md) | How config/meta/dossier/manifest are derived from the graph; handler-key conventions; what fails loudly and why |
| [adding-a-game.md](adding-a-game.md) | The playbook — proven six times now |
| [testing.md](testing.md) | Running the spec suites (35 of them), the synthetic-ROM smoke test, headless real-ROM harnesses, browser verification |
| [deployment.md](deployment.md) | mamehistory.com: GitHub Pages, custom domain/DNS, the deploy script, caching, HTTPS-or-no-sound |
| [gotchas.md](gotchas.md) | **Read before changing anything.** Hard-won facts that are not obvious from the code |
| [TODO.md](TODO.md) | Prioritized backlog with context for each item |

## Sixty-second orientation

```
mamekit galaga --serve
```

1. Finds `GAME(..., galaga, ...)` in the MAME source tree (auto-detected at
   `../mame` or parent; override with `--mame-src` / `$MAME_SRC`).
2. Parses the driver's macro DSLs into a **knowledge graph**
   (`dist/galaga/graph.json`, `.cypher`, interactive `viewer.html`).
3. **Generates** `dist/galaga/config.json` (ROM manifest, memory map, clocks,
   screen, sound kind, DIPs, key bindings) plus `meta.json`, a markdown
   dossier `README.md`, and `history.txt` (Gaming History text, if the dat
   is present) — pure data, no per-game compile.
4. (Re)builds the **unified app** at `dist/app/` (one runtime compile hosting
   every generated game) and serves on **http://localhost:8280/app/** —
   the boot menu ("video-store shelves" + search). Clicking a game opens the
   **story-first "learn" modal** (machine facts, MAME-driver credits + git
   history, Gaming History chapters, artwork) with the Play button inside.
   Games live at `/app/g/<game>/` (pretty route; legacy `?g=` still works);
   Esc returns to the menu. `mamekit --serve` alone serves everything
   without needing the MAME tree.
5. ROMs: **never read from the server or the project tree** (hard user
   directive, 2026-07-06). The arcade screen is a drag-drop zone showing the
   required chip manifest; the zip is validated per-chip (✓/≈/✗) **before**
   booting. Arcade ROMs are **not** persisted (the bytes die with the page).
   **Console cartridges** are the exception — a dropped cart is remembered in
   the visitor's own browser (IndexedDB `mamekit-carts`, `runtime/cartstore.ts`)
   by explicit user approval (2026-07-07), still never on the server.
   Dev-time headless harnesses may read `_roms/` / `_roms2/` directly; the
   app may not.

State as of 2026-07-07: **eight arcade games boot and play** — Galaga,
Pac-Man, Galaxian (issue #1), Gyruss, Space Invaders, Moon Patrol (issue #3),
Ghosts'n Goblins, Juno First (issue #12) — plus the project's **first
console, the NES** (issue #17): drop a cartridge dump onto the console room
and Super Mario Bros. plays (verified allowlist; other carts on the five
supported mappers — NROM/UxROM/CNROM/MMC1/MMC3 — are playable as
experimental). The whole thing is **deployed at https://mamehistory.com**
(issue #4). 35 spec suites green. Known gaps: gyruss i8039 percussion stub,
mpatrol MSM5205 drums not routed to the worklet, NES DMC mid-sample bank
staleness + scanline-granularity PPU timing — see [TODO.md](TODO.md).

## Ground rules (user requirements — do not violate)

- **Zero runtime dependencies.** Plain DOM, canvas, Web Audio, native
  `DecompressionStream`. `typescript` is the only dev dependency.
- **Knowledge-graph-first.** Game-specific facts come from the graph, never
  hard-coded — "it should work it out from the cpp code". New games should
  be regeneration + missing device cores only.
- **The runtime is a device library.** CPU, machine framework, video, sound,
  run loop, controls are game-agnostic and should "hardly be touched" when
  adding games.
- **ROMs are copyrighted.** `roms/` (currently renamed `_roms/` locally) is
  gitignored — as are `*.zip` globally after the 2026-07-06 accidental-commit
  incident (scrubbed from history). Never commit, never fetch ROMs.
- **Never bind Ctrl as a game key** (macOS Ctrl+Arrow is a system chord that
  breaks movement-while-firing). Fire = Space/X.
- The project doubles as a **teaching tool** — mamehistory.com is an
  educational arcade-history site: story-first modals, per-game markdown
  dossiers, driver credits, KG viewer.
