# TODO / backlog

Prioritized. Each item has enough context to start cold. Check
[gotchas.md](gotchas.md) before touching anything.

## P0 — issue #3 phase-2 gaps (known, documented, user-visible)

0a. **Gyruss i8039 percussion**: the fourth CPU (I8039 @ 8 MHz, region
    `audio2`) is stubbed in `boards/gyruss.ts` — music + AY SFX play, drums
    don't. Needs an MCS-48 core (agent-sized, spec-suite pattern).
0b. **Moon Patrol MSM5205 audio routing**: `msm5205.ts` is timing-complete
    (vck → 6803 NMI pacing verified) but its decoded ADPCM never reaches a
    worklet — drums silent. Wire it into the ay8910 worklet path or its own.
0c. **ROMREGION_ERASEFF as graph data**: the 0xff-fill is hard-coded in
    video/m52.ts; parse the region flag and emit it in config.roms instead.
0d. **Ear-verification pending**: AY anti-alias fix and gyruss volume 0.55
    await user confirmation; ditto invaders SFX balance.

## P0 — correctness & sound

1. ~~54xx explosion noise~~ **shipped as HLE** (2026-07-05, `namco54.ts`):
   faithful galaga_a.cpp discrete-filter port + LFSR/envelope approximation
   of the MB8844 program, keyed to the real captured command stream.
   Remaining upgrade path: **LLE** — MB8844 core (MAME
   `src/devices/cpu/mb88xx/`) running the user's `54xx.bin` dump
   (roms/galaga.zip, CRC ee7357e0) in place of the envelope approximation.
2. **Listen to the audio.** WSG is spec-verified only. Boot the game with
   sound on, verify coin chime / theme / firing sounds by ear (or record via
   `MediaStreamAudioDestinationNode` and eyeball a spectrogram in a test page).
3. **CI**: GitHub Action — `npm ci`, `tsc --noEmit`, the four spec suites.
   All are plain `node` scripts; no browser needed for the core suites.

## P1 — the promises we made

4. **`--from-graph` mode**: regenerate the app from a committed
   `graphs/<game>.json` snapshot without any MAME checkout (~20 CLI lines).
   Commit the galaga snapshot. Makes cloned repos self-sufficient.
5. ~~Games #2/#3: Galaxian + Pac-Man + boot menu + Esc~~ **shipped**
   (issue #1, 2026-07-05; pacman's start-stall later fixed by PATCHES_MAP
   scoping — all six games play as of issue #3).
6. **Live-state KG viewer overlay** (the "instrument panel" idea the user
   loved): viewer connects to the running emulator (BroadcastChannel or
   WebSocket through serve.ts), `board.snapshot()` + `board.shares` already
   expose the data (`window.mamekit` debug handle exists). Click Z80 node →
   live pc/regs (+ tiny disassembler); videoram range → live tilemap dump;
   edge activity by bus traffic counts (add per-range counters to Bus
   behind a debug flag).

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
11. **`mamekit diff` / provenance**: show which driver lines each generated
    config value came from (needs #10's line capture).

## P3 — emulation quality

12. **Cocktail / flip screen**: videolatch Q7 is sampled but flip rendering
    is unverified; player-2 cocktail bindings unbound (generator skips
    PORT_COCKTAIL). Needed for 2-player alternating play.
13. **DIP switch UI**: `KeyboardInput.setDip()` exists; add a settings panel
    (dip names/settings are in the graph → config).
14. **Gamepad API** support in the shell (PS4/DualShock 4 over Bluetooth —
    design sketch in issue #25: semantic-label→standard-mapping table in
    input.ts, per-rAF poll in the shell tick, keyboard/pad held-state merge).
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

19. **npm publish / npx mamekit** (bin already declared).
20. **Bundle option**: single-file app output (inline modules) for easy
    hosting; keep the no-bundler default.
21. ~~PORT_INCLUDE resolution~~ **shipped** (issue #3: generator merges the
    INCLUDES_PORTS chain root-first, PORT_MODIFY by mask overlap).
22. **Parser hardening**: ROM_CONTINUE/ROM_FILL, ROMREGION_ERASEFF flag.
    Also: `lw8`/`lr8` map lambdas parse as `nop` (timeplt's pair-addressed
    mainlatch at 0xc300-0xc30f is hand-patched in boards/timeplt.ts —
    emitting the lambda body as graph data would restore the contract).
23. **Menu polish**: gamepad navigation, per-shelf grouping (by decade/maker),
    localStorage snapshot management UI.
24. **Organise `src/runtime/`**: the folder is flat (~60 files) with natural
    groupings — CPU cores (z80, i8080, m6502, m6803, m6809, mcs48), sound
    chips + worklets, Namco custom MCUs, misc devices (ls259, er2055,
    mb14241, konami1) — alongside the existing `boards/` and `video/`.
    Mind gotcha #0b (registry import cycles) when moving board helpers.

## P2.5 — mamehistory.com (deployed 2026-07-06; next steps)

- **Licensing outreach**: Gaming History (arcade-history.com, Alexis
  Bousiges) for commercial-use blessing of the story texts; Mr. Do's /
  Arcade Database for artwork scans (user founded MAMEWorld — has the
  contacts). Artwork currently deployed at user's explicit decision.
- **MAMEWorld / Mr. Do's / Arcade Database attribution line** in the modal
  footer + dossiers (only Gaming History is credited today).
- **Free-ROM tier**: mamedev.org/roms has a handful of freely-licensed
  romsets — generating those games would give visitors something playable
  with zero upload.
- **Automated deploys**: blocked on local-only assets (MAME checkout,
  artwork, history dat). A CI build would ship a bare site; revisit if
  assets ever get hosted. `npm run deploy -- --artwork` is the ship command.

## Done (for orientation)

- KG extractor + viewer + Cypher (2026-07-05)
- Z80 (266 checks), WSG (+worklet), video (36 checks), board + 51xx/06xx HLE
- Generator + shell + zip(CRC match) + serve
- Galaga verified playing in-browser at 60fps
- Repo split to github.com/benbruscella/mamekit, symlink at <mame>/mamekit
- Issue #1 (2026-07-05): unified app (dist/app + per-game config.json),
  Blockbuster-shelf boot menu (artwork/snapshot/tile covers + search),
  Esc-to-menu, galaxian board/video/sound (plays in-browser), pacman
  board/video (boots; start-stall under debug), parser support for modern
  constexpr/XTAL/portr/map+config composition/GFXDECODE_SCALE/io maps,
  per-field input polarity from the graph, SOCD input cleaning, bus mirror
  offset fix
- Issue #3 (2026-07-06): **Gyruss + Space Invaders + Moon Patrol play.**
  New cores: m6809+konami1, i8080, m6803, mb14241, msm5205, ay8910×N
  (+worklet, box-filter anti-alias), invaders SFX synth. Boards/video for
  gyruss (3 CPUs, 5 AYs), mw8080bw (beam-faithful 1bpp), m52 (masked-bus
  6803, ERASEFF fill). Parser: multi-line port macros, PORT_INCLUDE merge,
  PORT_SERVICE_DIPLOC, PATCHES_MAP scoping, region-scoped rom ids,
  matchParen device args, templated FUNC, same-class map resolution.
- Education layer (2026-07-06): story-first learn modal (marquee/flyer/
  cabinet hero, machine facts, driver credits + MAME git history, Gaming
  History chapters, pinned Play CTA), per-game markdown dossiers
  (`dist/games/<category>/<game>/README.md`), ROM drop zone with pre-boot chip-manifest
  validation (✓/≈/✗ per chip, wrong sets bounce instead of hanging).
- Deployment (2026-07-06, issue #4): live at **https://mamehistory.com** —
  base-path-agnostic URLs, static games.json, pretty routes /app/g/<game>/,
  gh-pages deploy script (CNAME-owning, ROMs never shipped, artwork
  opt-in), DreamHost DNS → GitHub Pages, HTTPS enforced (sound needs it),
  cache-busted bundle, MAME HISTORY rebrand + GitHub sash.
- Incident (2026-07-06): ROM zips briefly committed via a roms/→_roms/
  rename that escaped .gitignore; history scrubbed (filter-branch +
  force-push), .gitignore hardened (/roms/, /_roms/, *.zip).
- Issue #8 (2026-07-06): **Ghosts'n Goblins plays** — 7th game, 1st Capcom.
  MC6809 main (banked ROM via new `.bankr()` parsing → `bank.<name>`
  handler keys) + Z80 sound + 2× YM2203 (new OPN core: ymfm-ported FM +
  AY-reused SSG, 385 checks). m6809 gained `irqCount` for true HOLD_LINE
  (gng's boot SYNC-loop needs the line visible while masked). Video:
  fg/bg tilemaps with split-group transmasks, buffered sprites, RGBx_444
  palette RAM (71 checks). **Clone-family ROM alternates**: any sibling
  set's same-slot chip verifies (graph-derived from all ROM_START blocks) —
  classic gngb-era zips load against the modern manifest.
- Issue #27 (2026-07-19): **Pooyan + Time Pilot** — the timeplt-sound-board
  pair. The Roc'n Rope Z80+2xAY sound section (soundlatch, LS90 bi-quinary
  timer, sh_irqtrigger HOLD_LINE pacing, filter_w cap-swap) extracted to
  shared `timeplt-audio.ts` (rocnrope refactored onto it, spec-identical).
  New: `boards/pooyan.ts` + `boards/timeplt.ts` (Z80 main, vblank-NMI gated
  by latch Q0), `video/pooyan.ts` (4bpp, rocnrope-style indirect palette
  with char/sprite LUT roles SWAPPED — chars use upper 16), `video/timeplt.ts`
  (2bpp, 5-bit/channel dual-PROM palette, priority tilemap attr bit 4 over
  sprites, video-enable gate, raw-pen-0 sprite transparency). timeplt quirks:
  scanline_r (cloud multiplex), mainlatch written through an lw8 lambda at
  0xc300-0xc30f (offset>>1 pair addressing; parser emits `nop`, board
  patches the range — see P4 #22). Real-ROM boot + ear verification pending
  (user's library has no pooyan.zip/timeplt.zip yet).
- Issue #20 (2026-07-09): **Dig Dug** — 3rd galaga.cpp board, reuses the
  Namco 3×Z80 / WSG / 06xx / 51xx stack. New: `namco53.ts` (HLE DIP reader,
  alternates DSWA/DSWB — classic MAME 0.121 namcoio HLE, since MAME shipped
  no 53xx HLE afterward), `er2055.ts` (EAROM high-score NVRAM, faithful
  set_control/set_clk port, localStorage-persisted per family), `boards/
  digdug.ts`, `video/digdug.ts` (paged "dirt" bg tilemap via gfx4 map ROM +
  1bpp transparent alpha layer + galaga-style sprites, own 32+256+256 PROM
  palette). Generator: **FAMILY_BY_MACHINE override** — one driver file can
  host multiple boards (galaga.cpp = galaga *and* digdug), so board family
  keys on machine name, not just file stem. Shared resnet helpers extracted
  to `video/resnet.ts`. Artwork fetched (flyer/marquee/cabinet/bezel),
  history.xml story present.
