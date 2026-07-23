# MAMEKIT AGENT GUIDE

Read these in order before changing the project:

1. `README.md`
2. `docs/SYSTEM_ARCHITECTURE.md`
3. `docs/ENGINEERING_GUIDE.md`

Those are the complete current documentation set. Files under `sessions/` are
historical evidence and may describe deleted architectures.

## HARD RULES

- MAMEKIT is a MAME-specific source compiler, not a general C++ transpiler.
- MAME hardware behavior must come from MAME AST/DSL lowering, the knowledge
  graph and typed generated IR.
- `src/runtime` is hardware-neutral browser hosting and generic IR execution.
  Do not add handwritten CPU, device, audio, video or board implementations.
- JSON stores generated data; TypeScript/JavaScript stores behavior.
- Complete generation starts by deleting `dist`.
- Generated output has one canonical location and must not import `src`.
- ROMs are never committed, served or deployed.
- Do not bind Control as a game input.

## ENVIRONMENT AND GATES

- MAME source is normally at `../mame`.
- Node.js 23.6+ runs repository TypeScript directly.
- `npm run gen:all` currently generates Pac-Man and Pooyan during the
  one-machine-at-a-time issue-21 migration.
- Run `npm run test:unit`, `npm run audit:generated`, and relevant real-ROM
  acceptance after changes.
- Use `npm run test:generation` for broad parser, graph, IR, runtime or output
  topology changes; it clean-generates every required target.

Historical transcripts are listed in `sessions/ARCHIVE_INDEX.md`. Never treat a
transcript as permission to restore old handwritten runtime code.
