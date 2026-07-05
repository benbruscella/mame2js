# Claude Code sessions

Snapshots of the Claude Code sessions that built this project, committed so
the full reasoning history travels with the repo.

- `2026-07-05-initial-build.jsonl.gz` — the session that created everything:
  knowledge-graph extractor, viewer, Z80/WSG/video cores (3 parallel agents),
  51xx/06xx HLE, generator, shell, first successful Galaga boot, repo split,
  docs. Read with `zcat <file> | jq -r 'select(.type=="assistant" or .type=="user")'`
  or just `zcat | grep`.
- `memory/` — snapshot of the persistent memory files from the same period.

Notes for agents:
- These are **snapshots**, not live state. The curated, current knowledge is
  `CLAUDE.md` + `docs/` — trust those over transcripts when they disagree.
- Transcripts are raw JSONL (one event per line: user/assistant messages,
  tool calls with inputs/results). They contain local absolute paths from the
  original machine; nothing secret, but don't treat paths as current.
- When a future session makes a significant push (new game, big feature),
  consider snapshotting it here the same way:
  `gzip -c ~/.claude/projects/<slug>/<session-id>.jsonl > sessions/<date>-<topic>.jsonl.gz`
