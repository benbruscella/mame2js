# TODO / backlog

Prioritized. Each item has enough context to start cold. Check
[gotchas.md](gotchas.md) before touching anything.

## P0 — correctness & sound

1. **54xx explosion noise.** The only missing Galaga sound. Two routes:
   (a) **LLE**: MB8844 CPU core (MAME `src/devices/cpu/mb88xx/`) running the
   user's `54xx.bin` dump (in roms/galaga.zip, CRC ee7357e0), feeding the
   discrete filter stage — accurate, bigger; needs the discrete network from
   `galaga_a.cpp` (DISCRETE_SOUND galaga_discrete) approximated with
   biquads/noise in the worklet.
   (b) **HLE**: trigger filtered-noise envelopes on the known 54xx command
   sequences (old MAME did this with samples). Faster, good enough.
   Wire-up already exists: 06xx slot 3 write callback in `boards/galaga.ts`.
2. **Listen to the audio.** WSG is spec-verified only. Boot the game with
   sound on, verify coin chime / theme / firing sounds by ear (or record via
   `MediaStreamAudioDestinationNode` and eyeball a spectrogram in a test page).
3. **CI**: GitHub Action — `npm ci`, `tsc --noEmit`, the four spec suites.
   All are plain `node` scripts; no browser needed for the core suites.

## P1 — the promises we made

4. **`--from-graph` mode**: regenerate the app from a committed
   `graphs/<game>.json` snapshot without any MAME checkout (~20 CLI lines).
   Commit the galaga snapshot. Makes cloned repos self-sufficient.
5. **Games #2/#3: Galaxian + Pac-Man** — tracked with gap analysis in
   **issue #1**, along with the **boot menu** (canvas game-select, attract
   aesthetic) and **Esc back-to-menu** in the shell. Playbook:
   [adding-a-game.md](adding-a-game.md).
6. **Live-state KG viewer overlay** (the "instrument panel" idea the user
   loved): viewer connects to the running emulator (BroadcastChannel or
   WebSocket through serve.ts), `board.snapshot()` + `board.shares` already
   expose the data. Click Z80 node → live pc/regs (+ tiny disassembler);
   videoram range → live tilemap dump; edge activity by bus traffic counts
   (add per-range counters to Bus behind a debug flag).

## P2 — educational features (user is enthusiastic)

7. **Memory-map bar**: per-CPU 0x0000-0xFFFF strip in the viewer, ranges
   colored by kind, click-through to handler nodes. Data already in graph.
8. **ROM anatomy gallery**: decoded gfx1/gfx2 tile sheets (reuse
   `decodeGfx`), palette PROM swatches, WSG wavetable plots. Needs ROMs
   loaded client-side (drop zone on the viewer page).
9. **Clock tree**: 18.432 MHz crystal → dividers → devices, from graph clocks.
10. **Source deep-links**: record line numbers in the parsers
    (`parse.ts` knows offsets; convert to lines), link nodes to
    `github.com/mamedev/mame/blob/master/<file>#L<n>`.
11. **`mame2js diff` / provenance**: show which driver lines each generated
    config value came from (needs #10's line capture).

## P3 — emulation quality

12. **Cocktail / flip screen**: videolatch Q7 is sampled but flip rendering
    is unverified; player-2 cocktail bindings unbound (generator skips
    PORT_COCKTAIL). Needed for 2-player alternating play.
13. **DIP switch UI**: `KeyboardInput.setDip()` exists; add a settings panel
    (dip names/settings are in the graph → config).
14. **Gamepad API** support in the shell.
15. **Save states**: serialize Z80 fields (all public numerics), shares, latch
    values, device state; snapshot()/restore() pairs per device.
16. **Watchdog enforcement** (currently no-op — fine until a game relies on
    watchdog-reset to recover; MAME galaga uses vblank-counted watchdog).
17. **Timing accuracy**: per-scanline interleave is coarser than MAME's
    scheduler; if a game shows sync bugs, consider running CPUs in shorter
    slices or cycle-accurate handoff around shared-RAM mailboxes.
18. **Z80 completeness**: SCF/CCF Q-register behavior; INIR/OTIR interrupted
    flags (needed for zexall-level compliance, not for Namco games).

## P4 — infrastructure

19. **npm publish / npx mame2js** (bin already declared).
20. **Bundle option**: single-file app output (inline modules) for easy
    hosting; keep the no-bundler default.
21. **PORT_INCLUDE resolution** in the parser (galagamw etc. clone inputs).
22. **Parser hardening**: ROM_CONTINUE/ROM_FILL, io_map (Z80 IO space —
    pacman needs `in/out`, Bus currently stubs them open-bus).

## Done (for orientation)

- KG extractor + viewer + Cypher (2026-07-05)
- Z80 (266 checks), WSG (+worklet), video (36 checks), board + 51xx/06xx HLE
- Generator + shell + zip(CRC match) + serve
- Galaga verified playing in-browser at 60fps
- Repo split to github.com/benbruscella/mame2js, symlink at <mame>/mame2js
