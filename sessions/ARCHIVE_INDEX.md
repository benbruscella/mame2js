# ARCHIVE INDEX

This directory preserves raw development-session transcripts as historical
evidence for MAMEKIT.

Archive content is not current engineering guidance. It records experiments,
temporary designs, local paths, abandoned implementations, old filenames and
decisions that were later reversed. When archive content conflicts with the
repository, use this precedence order:

1. current source and generated tests;
2. root `README.md`;
3. `docs/SYSTEM_ARCHITECTURE.md`;
4. `docs/ENGINEERING_GUIDE.md`;
5. archived transcripts.

## TRANSCRIPTS

### `2026_07_05_INITIAL_BUILD.jsonl.gz`

Initial extractor, graph viewer, browser runtime experiments, first Galaga
boot, generator, shell and early documentation. This transcript predates the
issue-21 source-generated hardware architecture and therefore contains many
handwritten-core decisions that are no longer valid.

### `2026_07_06_GAMES_4_TO_8_EDUCATION_DEPLOY_AUDIO_MAMEKIT.jsonl.gz`

Expansion to additional machines, education UI, deployment, audio work,
project rename and historical operating decisions. It also predates the current
AST/KG/typed-IR generation boundary.

## READING A TRANSCRIPT

The files are gzip-compressed JSONL. For example:

```sh
gzip -cd sessions/2026_07_05_INITIAL_BUILD.jsonl.gz \
  | jq -r 'select(.type == "assistant" or .type == "user")'
```

Image payloads may have been stripped to reduce archive size. Tool calls,
reasoning and text results remain available.

## DURABLE HISTORICAL CONSTRAINTS

The following decisions originated in archived sessions and remain current
because they are also enforced by current code/documentation:

- the project is named MAMEKIT and powers MAME History;
- ROMs are never committed or deployed;
- arcade ROMs are not served or persisted by the application;
- keyboard controls do not bind Control because macOS intercepts
  Control+Arrow combinations;
- MAME source is a generation-time dependency;
- archived reasoning never overrides current compiler/runtime boundaries.

No additional README or memory index should be added here. Add a transcript to
this index only when it captures a major historical implementation phase.
