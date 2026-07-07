# mamekit — agent orientation

**Start here: read `docs/README.md`** — it indexes everything (architecture,
knowledge graph, runtime reference, generator, adding-a-game playbook,
testing, gotchas, TODO). `docs/gotchas.md` is mandatory before changing code.

Quick facts:

- `mamekit galaga --serve` → knowledge graph + unified app on
  http://localhost:8280/app/ (boot menu; game at /app/?g=galaga, viewer at
  /galaga/viewer.html). `mamekit --serve` alone serves all generated games.
- MAME source auto-detected at `../mame` (sibling checkout) or parent;
  override with `--mame-src` / `$MAME_SRC`. MAME is a dev-time dependency
  only (extraction + reference for hand-porting device cores).
- Node ≥ 23.6 runs the TS CLI directly — no build step except `tsc` for the
  browser app (the generator runs it).
- Hard rules: zero runtime dependencies (DOM/canvas/Web Audio only);
  game-specific facts come from the knowledge graph, never hard-coded;
  `src/runtime/` stays game-agnostic; `roms/` is copyrighted — never commit.
- tsconfig uses `erasableSyntaxOnly`: no enums, no constructor parameter
  properties; `.ts` import extensions; `import type` for types.
- Tests: `node src/runtime/{z80,wsg}.spec.ts`,
  `node src/runtime/video/galaga.spec.ts`,
  `node src/runtime/boards/galaga.spec.ts`, `npx tsc --noEmit`.
  Run all before committing runtime changes.
- Backlog: `docs/TODO.md`. Games #2/#3 + boot menu: GitHub issue #1.
- `sessions/` holds gzipped Claude Code transcripts + memory snapshots from
  the sessions that built this — grep them for the full reasoning history.
