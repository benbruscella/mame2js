---
name: mame2js-project
description: mame2js — KG-first MAME→TS transpiler living at mame2js/ inside the MAME repo; galaga boots and plays (verified 2026-07-05)
metadata: 
  node_type: memory
  type: project
  originSessionId: 472dbdc1-5df7-4168-90c4-c04777fc26b1
---

mame2js lives at `~/Projects/Github/mame2js` (own git repo, pushed to https://github.com/benbruscella/mame2js), with a symlink at `mame/mame2js` for convenient in-tree work (symlink excluded from MAME git via .git/info/exclude). The CLI auto-detects the MAME source at `../mame` (sibling) or parent; roms/ and out/ are gitignored. Pipeline: `mame2js galaga [--serve]` → parses MAME driver macros (no C++ AST, by design) → knowledge graph (out/<game>/graph.json + graph.cypher for Neo4J + self-contained viewer.html) → generates out/<game>/app (config.ts from graph) → compiles with tsc → serves on :8280 (app at /app/).

**Why:** User chose knowledge-graph-first architecture (JSON native, Cypher export, no Neo4J dependency) and wants maximal reuse: runtime (src/runtime: z80, bus, ls259, namco06, namco51 HLE, wsg, starfield05xx, gfx, video/, boards/, shell) is game-agnostic; everything game-specific is generated. Adding a game should touch almost nothing.

**How to apply:** Node ≥23.6 runs the TS CLI directly (no build). erasableSyntaxOnly is on — no enums/param-properties. All cores have node-runnable .spec.ts files (z80: 266 checks). ROMs at mame2js/roms/galaga.zip (old dash-style names; shell matches by CRC). 54xx explosion noise still stubbed — user's romset includes 54xx.bin (MB8844 dump) for future LLE. Classic 51xx HLE protocol was recovered from git history: `git show 7b77f121862:src/mame/machine/namcoio.c` (MAME 0.121). Next ideas user liked: live-state KG viewer overlay, memory-map bar, ROM anatomy gallery, clock tree. See [[mame2js-user-prefs]].
