# Claude Code sessions

Snapshots of the Claude Code sessions that built this project, committed so
the full reasoning history travels with the repo.

- `2026-07-05-initial-build.jsonl.gz` — the session that created everything:
  knowledge-graph extractor, viewer, Z80/WSG/video cores (3 parallel agents),
  51xx/06xx HLE, generator, shell, first successful Galaga boot, repo split,
  docs. Read with `zcat <file> | jq -r 'select(.type=="assistant" or .type=="user")'`
  or just `zcat | grep`.
- `2026-07-06-games4-8-education-deploy-audio-mamekit.jsonl.gz` — the long
  second arc (2026-07-06 → 07). Games #4–8: gyruss, Space Invaders, Moon
  Patrol (issue #3), Ghosts'n Goblins (#8, YM2203), Juno First (#10, MCS-48 —
  which also closed the gyruss percussion stub). New CPU cores m6809/konami1,
  i8080, m6803, mcs48; sound cores ay8910, ym2203, invaders-sound, msm5205.
  The education layer (story-first learn modal, per-game markdown dossiers,
  driver credits + git history, Gaming History integration). Deployment to
  **mamehistory.com** (issue #4: GitHub Pages, DreamHost DNS, HTTPS, pretty
  routes, deploy watchdog). The **no-server-ROMs** mandate (drop-zone only,
  no persistence). A deep **audio-fidelity** push (timestamped write
  scheduling, Konami RC filters, DAC interpolation, the `tools/render-audio`
  + `tools/compare-audio` "ears", issue #12). And the **mame2js → mamekit**
  rename (issue #11). *Image payloads stripped* (`<stripped …b base64>`) to
  keep the file lean — reasoning, tool calls, and results are intact.
- `memory/` — snapshot of the persistent memory files (current as of the
  second arc: mamekit identity, no-server-ROMs directive, MAMEWorld
  provenance, local ROM/artwork inventory, never-bind-Ctrl).

Notes for agents:
- These are **snapshots**, not live state. The curated, current knowledge is
  `CLAUDE.md` + `docs/` — trust those over transcripts when they disagree.
- Transcripts are raw JSONL (one event per line: user/assistant messages,
  tool calls with inputs/results). They contain local absolute paths from the
  original machine; nothing secret, but don't treat paths as current.
- When a future session makes a significant push (new game, big feature),
  consider snapshotting it here the same way:
  `gzip -c ~/.claude/projects/<slug>/<session-id>.jsonl > sessions/<date>-<topic>.jsonl.gz`
