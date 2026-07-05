# Runtime reference

Everything under `src/runtime/`. All modules: strict TS, `erasableSyntaxOnly`
(no enums / namespaces / constructor parameter properties), `.ts` import
specifiers, zero dependencies. Node-runnable modules must not touch DOM;
browser-only modules are `shell.ts`, `audio.ts`, `wsg-worklet.ts`.

## Contracts — `types.ts`

- `Regions = Record<string, Uint8Array>` — loaded ROM regions by MAME tag.
- `VideoRenderer` — `width/height` (native, pre-rotation), `render(fb: Uint32Array)`
  packed **0xAABBGGRR** (ImageData byte order), `vblank()`.
- `SoundCore` — `sampleRate`, `write(offset, data)`, `render(out: Float32Array)` mono [-1,1].
- `InputPorts` — `read(tag)` returns **active-low raw bytes** ("IN0", "IN1", "DSWA", "DSWB").

## CPU — `z80.ts` (agent-written, 266 spec checks)

`class Z80 { constructor(bus: Z80Bus); reset(); setIrqLine(active, dataBus=0xff); nmi(); step(): cycles; run(tstates): actual }`
Public numeric regs `a f b c d e h l a2..l2 ix iy sp pc wz i r iff1 iff2 im`, `halted: boolean`.

Full documented + undocumented coverage (IXH/IXL, SLL, ED duplicates,
DDCB/FDCB register-copy forms), X/Y flags, WZ/MEMPTR for BIT, accurate
T-states (IM1=13, IM2=19, NMI=11, EI-delay honored), R register semantics.
Known deviations (deliberate): SCF/CCF use classic NMOS X/Y-from-A (no Q
register); INIR/OTIR interrupted-repeat P/H tweaks unmodeled; IM0 supports
RST bytes and packed CALL (`0xcd | lo<<8 | hi<<16` via dataBus).
~900 emulated MHz in Node 24 — never the bottleneck.

## Bus — `bus.ts`

Built from generated `RangeSpec[]`: flat 64k `readId`/`writeId` Uint8Array →
handler function arrays (max 255 handlers each); `base` Uint32Array packs
per-address range base (read low 16 bits / write high 16) for offset calc.
`kind: 'rom' | 'ram' | 'handler' | 'nop'`; `share` aliases RAM blocks across
the CPUs (pass ONE shares object to all three buses — the board does).
RAM ranges may also have a write handler (videoram_w pattern): bytes stored
first, then handler called. Mirror masks are applied by submask enumeration.
Handler registry keys: see [generator.md](generator.md).

## LS259 — `ls259.ts`

Addressable latch; `writeD0(offset, data)` (MAME map convention), `onQ(i, cb)`
with MAME `.append()` chaining semantics, callbacks fire **on change only**,
`reset()` clears Q0..Q7 through callbacks. `value` getter for snapshots.

## Namco 06xx — `namco06.ts` (from namco06.cpp)

Control register: bits 0-3 chip select (active high), bit 4 = read mode,
bits 5-7 clock-divide shift count (0 ⇒ timer stopped). Data reads AND
together all selected chips' bytes (open bus 0xff); writes broadcast.
NMI pacing: `tick(cpuCycles)` accumulates and pulses the main-CPU NMI every
`cpuClock / (clock >> shifts)` cycles (galaga: 48000 Hz clock, control 0x71 ⇒
shifts=3 ⇒ 6 kHz ⇒ every 512 cycles @3.072 MHz). First NMI of a **read**
burst is suppressed (`readStretch`, per MAME). Galaga's observed protocol:
`0x10` idle, `0x71` read 3 bytes from 51xx, `0xA1` write commands to 51xx,
`0xA8` write to 54xx.

## Namco 51xx — `namco51.ts` (HLE)

Hand-transpiled from **classic MAME 0.121 HLE** (`src/mame/machine/namcoio.c`,
recovered from git history — see gotchas). Commands (data & 7): 1=set
coinage (+4 arg bytes), 2=credit mode, 3/4=remap off/on, 5=switch mode.

Credit-mode read cycle (repeating 3 bytes): **[credits BCD, P1 byte, P2 byte]**
where P-byte = joy nibble (remapped through `JOY_MAP` if enabled) |
fire-edge<<4 | fire-level<<5 (both active-low). Coin/start edges detected
against `lastCoins`; coin1/coin2/service increment credits per coinage;
start1/start2 consume 1/2 credits and switch mode 1→2. Free play (coins_per_cred
0) pins credits=100. Test-mode switch (IN1 bit 0x80 low) returns 0xbb.
Switch-mode reads: [coins/start byte, joy byte, 0].

**CRITICAL port-order note**: modern MAME wires `input_callback<0..1>` = IN0
(joystick nibbles) and `<2..3>` = IN1 (buttons/coins) — matching the real MCU.
The classic HLE expects coins on ports 0/1. `Namco51` takes callbacks in
**modern order** and reorders internally (`switchByte()` = in[2]|in[3]<<4).
Do not "fix" this.

## Namco 54xx — stubbed

`boards/galaga.ts` slot 3 accepts writes and drops them. The user's romset
includes `54xx.bin` (MB8844 program, CRC ee7357e0) — LLE is a TODO.

## WSG sound — `wsg.ts` + `wsg-worklet.ts` + `audio.ts` (agent-written)

`NamcoWSG(waveRom, clock, voices=3)`, sampleRate = clock (galaga 96000 =
18.432M/6/32). `pacman_sound_w` register map (offset 0..0x1f, low nibble):
0x05/0x0a/0x0f waveform select ch0/1/2; 0x10-0x14 ch0 freq bits 0-19;
0x15 ch0 volume; 0x16-0x19/0x1a ch1 freq/vol; 0x1b-0x1e/0x1f ch2 freq/vol.
Wavetable = `(waveRom[i & 0xff] & 0x0f) - 8` (first 0x100 bytes only — 8
waveforms × 32 samples). Tone Hz = freq·clock/2²⁰. Mix scale /384 per voice.

The DSP runs **inside** an `AudioWorkletProcessor` ('wsg') so main-thread
jank can't glitch audio; main thread posts `{type:'init', waveRom, clock}`
then `{type:'write', offset, data}`; the worklet linearly resamples 96 kHz →
context rate. `AudioOutput.start(core, workletUrl)` needs a user gesture;
writes before start are buffered and replayed. MAME route gain: 0.90·10/16 ≈
**0.5625** → `audio.setVolume(0.5625)`. The worklet URL is the compiled
`dist/runtime/wsg-worklet.js`; `dist/runtime/wsg.js` must be servable next to
it (ES module import).

## Video — `video/galaga.ts`, `gfx.ts`, `starfield05xx.ts` (agent-written, 36 checks)

- `decodeGfx(layout, rom)` — generic, graph-driven; offsets in **bits**,
  MSB-first, plane 0 = MSB of pixel; resolves `RGN_FRAC(a,b)±n` against
  region size.
- `GalagaVideo` deps: regions (gfx1 0x1000, gfx2 0x2000, proms 0x220),
  videoram (0x800), ram1/2/3 (0x400 each; **sprite registers at 0x380-0x3ff**
  of each: ram1=sprite index/color, ram2=x/y, ram3=flips/size), `videolatch()`
  (Q0-5 starfield control, Q7 flip). Native 288×224.
- Palette from PROMs exactly as `galaga_palette` (resistor weights via a
  faithful `compute_resistor_weights` port): 32 RGB entries; char LUT at prom
  0x20 (pen = (lut&0x0f)|0x10); sprite LUT at 0x120; 64 star colors from
  470/220Ω nets with 1k pulldown (max r/g 222).
- Draw order (screen_update_galaga): black fill → stars → sprites → fg
  tilemap. Char pixel transparent iff LUT nibble == 0x0f; sprite pen likewise.
- `tilemapScan`: galaga's 36×28 layout with the two wrap columns each side
  (spot-checked + injectivity-tested over all 1008 cells).
- Sprites: 16×16, dual x/y double-size flags, code wraps %128.
- Starfield: 05xx LFSR (taps 16,13,11,6, seed 0x7fff, period 65535, 256
  hits/frame window), x offset 16 / limit 272 (galaga config); control bits
  latched at `vblank()`, LFSR advances during `draw()` (pre-visible → visible
  → post-visible), matching MAME's split.

## Board — `boards/galaga.ts`

Composition + interrupt wiring (hand-transpiled from galaga.cpp):

- 3× Z80 on one shared `RangeSpec[]` map, separate ROM per CPU
  (regions maincpu/sub/sub2 mapped 0x0000-0x3fff), one shared `shares` object.
- misclatch (0x6820-27): Q0 main IRQ enable/ack (clear line when 0),
  Q1 sub IRQ enable/ack, Q2 **inverted** sub2-NMI enable, Q3 **inverted**
  reset for sub+sub2+51xx+54xx (0 = held; on 0→1 both sub CPUs `.reset()`).
- videolatch (0xa000-a007): Q0-5 → starfield control, Q7 flip (sampled per
  frame by video).
- Frame loop: 264 scanlines × 192 main-CPU cycles (`= 3.072M / 60.606 / 264`),
  `n06.tick(192)` after the main slice, sub CPUs run unless held; sub2 NMI
  pulses at **scanlines 64 and 192** (cpu3_interrupt_callback); vblank at
  **line 224** asserts main/sub IRQ lines per masks + `video.vblank()`.
- Watchdog (0x6830): accepted, not enforced (deliberate — see TODO).
- `snapshot()` returns per-CPU pc/sp/halted, latch values, 51xx/06xx state —
  the hook for the future live KG viewer overlay. `shares` is public for the
  same reason.

## Shell — `shell.ts`, `input.ts`, `zip.ts`

- `runShell(config)`: fetch `/roms/<game>.zip` → else drag-drop/file-picker;
  `assembleRegions` matches zip entries by **name, then dash/underscore
  swapped, then CRC32** (romset filenames drift across MAME eras — the user's
  set is dash-style); CRC mismatches warn, missing files throw with the list.
- Canvas: native-res offscreen → visible canvas rotated (ROT90 = translate +
  rotate π/2), integer upscale, `image-rendering: pixelated`.
- Run loop: fixed-timestep accumulator at `screen.refresh` (60.606 Hz) inside
  rAF, clamped to 5 frames after tab pauses. Status line shows fps + main/sub
  pc + credits (reads `board.snapshot()` once a second).
- `KeyboardInput`: `KeyboardEvent.code`-based, active-low; DSW ports return
  configured DIP bytes (defaults from graph). `setDip()` exists for a future UI.
- `zip.ts`: central-directory parser, stored + deflate
  (`DecompressionStream('deflate-raw')`), CRC32 verified per entry.
  Also exports `crc32` (used for ROM identity matching).
