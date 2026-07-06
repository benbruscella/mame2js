# Adding a game — the playbook

The promise: **regeneration + missing devices only.** Here's the checklist,
proven three times now (galaga, then pacman + galaxian in issue #1 — those
two took: parser extensions, one board module, one video module, one sound
core each, zero changes to existing engine modules beyond generalization).

## 1. Extract and inspect

```
node bin/mame2js.js graph <game>
open dist/<game>/viewer.html      # or read graph.json
```

Check the CLI digest: devices + clocks, rom regions. Open the viewer and eyeball
the memory map ranges and handler names. Parser gaps show up here (a device
with clock null and a `clockExpr` string, missing ranges, etc.) — fix
`src/kg/parse.ts`, not the generator.

## 2. Attempt generation

```
node bin/mame2js.js <game>
```

Two designed failure points tell you the work list:

1. **Generator throws** (missing machine/romset/inputs, no screen raw) —
   parser gap or a genuinely different driver structure.
2. **Bus throws `missing read/write handler: <key>`** at app runtime (or the
   board constructor) — each key names a device method to implement or wire.

## 3. Gap analysis by subsystem

| Subsystem | Reuses as-is when... | Needs work when... |
|---|---|---|
| CPU | it's a Z80 | 6502/6809/etc. — new CPU core (big; agent-sized task with spec suite like z80.spec.ts) |
| Bus/shell/zip/input | always | — |
| Sound | Namco WSG (pacman!) | new SoundCore (e.g. galaxian tone+noise, AY-3-8910, 54xx LLE) |
| Video | — | usually per-family: new `video/<family>.ts` implementing `VideoRenderer` (decodeGfx + palette port + tilemap scan + sprites) |
| Board | same family (bosco/xevious/digdug ≈ galaga skeleton) | new `boards/<family>.ts` (interrupt scheme, latches, customs wiring) |
| Customs | 06xx/51xx present | 50xx (bosco score protection), 52xx (samples), 53xx (digdug I/O), 54xx (noise), EAROM (digdug) |

## 4. Family notes (from the galaga.cpp driver, already in the full graph)

- **bosco**: 2 boards, two 06xx, 50xx + 52xx customs, radar dots (dotlayout),
  starfield shared with galaga. Video: bg scroll + radar.
- **xevious**: 51xx used only for protection check at boot; bigger video
  (bgcharlayout, 3-plane sprites, terrain ROMs, dual tilemaps).
- **digdug**: 53xx custom, EAROM (high-score NVRAM — map 0xb800), 1bpp chars,
  no starfield.
- **pacman / galaxian**: see issue #1 — simpler than galaga (single Z80).

## 5. Verification bar (same as galaga)

- Core specs still pass (`node src/runtime/*.spec.ts` and subdirs).
- A board smoke test with synthetic ROMs (copy `boards/galaga.spec.ts` pattern:
  hand-assembled program exercising the interrupt + latch scheme).
- Browser: boots to attract, coin-up works, a game can be started and played,
  60 fps, zero console errors. Use Playwright as in docs/testing.md — hold
  keys ≥200 ms so the I/O chip polling sees the edges.

## 6. Register the board family

`src/runtime/boards/index.ts` FAMILIES map: driver-file stem → board class.
That's the only shared file a new game touches. (Board modules import
helpers from `input.ts`/`types.ts`, never from the registry — cycle, see
gotchas 0b.)

## 7. Keep the contract

If you catch yourself writing `if (game === 'digdug')` anywhere in
src/runtime or src/gen — stop; that fact belongs in the graph (parser), the
generated config, or a device/board module boundary. Same for input
polarity, io maps, clocks: the graph knows; extend the parser if it
doesn't.
