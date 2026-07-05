# Testing

No test framework — every spec is a plain Node script (Node ≥23.6 runs TS
directly) that prints PASS/FAIL lines and sets `process.exitCode`.

## The suites

```
node src/runtime/z80.spec.ts            # 266+ checks: instruction battery, exhaustive
                                        # DAA (vs independently-written reference),
                                        # ~70 cycle counts, EI delay, IM0/1/2, NMI/RETN,
                                        # HALT, R register
node src/runtime/wsg.spec.ts            # silence@vol0, amplitude, frequency accuracy,
                                        # mix headroom, soundEnable mute
node src/runtime/galaxian-sound.spec.ts # 20 checks: hum period, LFO sweep, tone pitch,
                                        # volume monotonicity, fire envelope, noise decay
node src/runtime/video/galaga.spec.ts   # 36 checks: gfx decode, RGN_FRAC, palette,
                                        # tilemap scan injectivity, 05xx LFSR, sprites
node src/runtime/video/pacman.spec.ts   # 35 checks: palette weights, pacman_scan_rows,
                                        # sprite offsets/quirks, transparency rule
node src/runtime/video/galaxian.spec.ts # 45 checks: palette+starmap, char/sprite decode,
                                        # column scroll, bullets, 17-bit star LFSR
node src/runtime/boards/galaga.spec.ts  # integration: synthetic ROMs w/ hand-assembled
node src/runtime/boards/pacman.spec.ts  #   Z80 programs through the real bus/latch/IRQ
node src/runtime/boards/galaxian.spec.ts#   paths of each board family
npx tsc --noEmit                        # whole project, strict
```

Run all of the above before committing runtime changes. There are also
headless whole-game repro harnesses (real ROMs through the real board in
plain node — no browser) in the session scratchpads; the pattern is worth
copying for regressions: load roms/<game>.zip with zip.ts, build the board,
run frames, assert on shares/videoram/snapshot.

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
node bin/mame2js.js galaga --serve      # menu: http://localhost:8280/app/
                                        # game: http://localhost:8280/app/?g=galaga
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
