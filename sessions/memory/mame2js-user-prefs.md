---
name: mame2js-user-prefs
description: "User preferences for mame2js — zero-dependency DOM/canvas, KG-first, wants visual/educational tooling"
metadata: 
  node_type: memory
  type: user
  originSessionId: 472dbdc1-5df7-4168-90c4-c04777fc26b1
---

Ben wants mame2js built with the DOM directly — no runtime libraries ("or as little as possible"; typescript as the only dev dep is fine). He decided to start with a source-code knowledge graph before the emulator, is interested in Neo4J (satisfied via .cypher export, no server dependency), and asked for a visual KG browser to explore MAME source. He's enthusiastic about features that help people learn arcade emulation (live-state graph overlay, memory-map visualization, ROM anatomy).

**Why:** He treats the project as both an emulator and a teaching/exploration tool for MAME internals.

**How to apply:** When extending mame2js, prefer generated-from-graph over hand-written per-game code, keep everything dependency-free and browser-native (DecompressionStream, AudioWorklet, canvas), and surface internals visually where possible. See [[mame2js-project]].
