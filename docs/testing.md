# Testing

No test framework — every spec is a plain Node script (Node ≥23.6 runs TS
directly) that prints PASS/FAIL lines and sets `process.exitCode`.

## The suites

```
node src/runtime/z80.spec.ts            # 266 checks: instruction battery, exhaustive
                                        # DAA (vs independently-written reference),
                                        # ~70 cycle counts, EI delay, IM0/1/2, NMI/RETN,
                                        # HALT, R register
node src/runtime/wsg.spec.ts            # 6 checks: silence@vol0, amplitude, frequency
                                        # accuracy via zero-crossings (0.00% err), mix
                                        # headroom, soundEnable mute
node src/runtime/video/galaga.spec.ts   # 36 checks: exact-pixel gfx decode, RGN_FRAC,
                                        # palette resistor weights, tilemap scan corner
                                        # cases + injectivity (1008 cells), LFSR
                                        # sequence/period, sprite/tilemap render+clip
node src/runtime/boards/galaga.spec.ts  # integration: synthetic ROMs w/ hand-assembled
                                        # Z80 program through real bus/latch/IRQ path
npx tsc --noEmit                        # whole project, strict
```

Run all of the above before committing runtime changes.

## The board smoke test pattern (works without ROMs)

`boards/galaga.spec.ts` builds all-zero ROM regions except a hand-assembled
program in maincpu: set SP → write misclatch Q0=1 (IRQ enable) → IM1/EI →
fill videoram 0x8000-0x803f → spin. ISR at 0x38 acks via Q0=0, bumps a
counter in shared ram3 (0x9800), re-enables, RETI. After 5 frames assert:
pc parked in spin loop, subs held in reset, videoram bytes landed, ram3
counter == frame count, framebuffer alpha set. This validates the exact
IRQ/latch chain the real game uses — copy this pattern for every new board.

## Browser verification (the real bar)

```
node bin/mame2js.js galaga --serve      # http://localhost:8280/app/
```

With Playwright (or by hand): page loads with zero console errors → press any
key (user gesture for audio) → attract mode renders (score table, starfield)
→ **hold** coin key ≥200 ms → status line credits=1 → start → play. The
status line under the canvas shows `fps · main pc=… sub=… credits=…` from
`board.snapshot()` — pc values that never change mean a wedged CPU;
`sub=held` after boot means the game never released misclatch Q3.

**Synthetic key events must be held**: the 51xx polls inputs every NMI burst;
a ~5 ms tap can fall between polls. Dispatch keydown, wait 200-250 ms, keyup
(see the `browser_evaluate` snippets in the session transcript).

## What is NOT yet covered (be honest when extending)

- Audio is spec-verified, never ear-verified.
- Long-session gameplay (challenge stages, tractor-beam capture / dual
  fighter, high-score entry), cocktail/flip-screen, service/test mode.
- No CI (TODO: GitHub Action running the four suites + tsc).
