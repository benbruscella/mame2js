// Galaxian board: single Z80, vblank-gated NMI, discrete sound latches
// forwarded to the sound sink, char/sprite/star/bullet video. Wiring facts
// (clock, ranges, screen) come from the generated config; behavior here is
// hand-transpiled from src/mame/galaxian/galaxian.cpp:
//   - irq_enable_w (:779-787): latch data & 1; disabling clears any pending
//     interrupt (our NMI is an immediate edge pulse, so there is never a
//     pending level to clear — the latch only gates future pulses).
//   - vblank_interrupt_w (:761-767): NMI on the rising edge of vblank when
//     enabled. Screen raw params (galaxian.h): VTOTAL 264, visible lines
//     16..239 (VBEND 16, VBSTART 240) — with lines indexed 0..vtotal-1,
//     vblank starts at line == vbstart (240), the same convention
//     boards/galaga.ts uses for its vbstart (224).
//   - start_lamp_w / coin_lock_w / coin_count_0_w: cabinet hardware, no-ops.
//   - watchdog reset_r: read returns open bus 0xff; watchdog not enforced
//     (deliberate, same policy as the galaga board).
// Sound: the cust (GALAXIAN_SOUND) latches are forwarded to sinks.soundWrite
// in a flat offset space: sound_w -> 0x00-0x07, lfo_freq_w -> 0x10-0x13,
// pitch_w -> 0x20 (decoded by the galaxian sound core).

import { Z80 } from '../z80.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { portHandlers } from '../input.ts';
import { GalaxianVideo } from '../video/galaxian.ts';
import type { Regions, InputPorts, Board, BoardConfig, BoardSinks } from '../types.ts';

export type { BoardConfig, BoardSinks } from '../types.ts';

export class GalaxianBoard implements Board {
  readonly video: GalaxianVideo;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private main: Z80;
  private nmiEnabled = 0;

  private cyclesPerLine: number;
  private vtotal: number;
  private vbstart: number;
  private cycleDebt = 0;
  private frameCount = 0;
  /** shared RAM blocks (videoram, spriteram) — debug/live-viewer access */
  readonly shares: Record<string, Uint8Array>;

  constructor(
    config: BoardConfig,
    regions: Regions,
    inputs: InputPorts,
    sinks: BoardSinks,
  ) {
    this.vtotal = config.screen.vtotal;
    this.vbstart = config.screen.vbstart;
    const mainClock = config.cpus[0].clock;
    this.cyclesPerLine = Math.round(mainClock / config.screen.refresh / this.vtotal);

    // --- memory map --------------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;
    const registry: HandlerRegistry = {
      read: {
        ...portHandlers(config.ranges, inputs),
        'watchdog.reset_r': () => 0xff,
      },
      write: {
        'galaxian_state.galaxian_videoram_w': () => { /* bytes stored by bus; no dirty tracking */ },
        'galaxian_state.galaxian_objram_w': () => { /* bytes stored by bus; video reads objram per frame */ },
        'galaxian_state.start_lamp_w': () => { /* cabinet lamps */ },
        'galaxian_state.coin_lock_w': () => { /* coin lockout coil */ },
        'galaxian_state.coin_count_0_w': () => { /* coin counter */ },
        'galaxian_state.irq_enable_w': (_a, _o, d) => {
          this.nmiEnabled = d & 1;
          // writing 0 also clears any pending interrupt in MAME; our NMI is
          // an edge pulse delivered at vblank, so gating is sufficient
        },
        'galaxian_state.galaxian_stars_enable_w': (_a, _o, d) => this.video.setStarsEnable(d),
        'galaxian_state.galaxian_flip_screen_x_w': (_a, _o, d) => this.video.setFlipX(d),
        'galaxian_state.galaxian_flip_screen_y_w': (_a, _o, d) => this.video.setFlipY(d),
        'cust.lfo_freq_w': (_a, off, d) => sinks.soundWrite(0x10 + off, d),
        'cust.sound_w': (_a, off, d) => sinks.soundWrite(off, d),
        'cust.pitch_w': (_a, _o, d) => sinks.soundWrite(0x20, d),
      },
    };

    const rom = regions[config.cpus[0].region];
    if (!rom) throw new Error(`missing rom region ${config.cpus[0].region}`);
    this.main = new Z80(new Bus(config.ranges, rom, registry, shares));

    // --- video --------------------------------------------------------------
    this.fbWidth = config.screen.width;
    this.fbHeight = config.screen.height;
    this.video = new GalaxianVideo({
      regions,
      videoram: shares['videoram'] ?? new Uint8Array(0x400),
      objram: shares['spriteram'] ?? new Uint8Array(0x100),
    });

    this.reset();
  }

  reset(): void {
    this.main.reset();
    this.video.reset();
    this.nmiEnabled = 0;
    this.cycleDebt = 0;
  }

  /** run one video frame and render it into `fb` */
  frame(fb: Uint32Array): void {
    const perLine = this.cyclesPerLine;
    for (let line = 0; line < this.vtotal; line++) {
      const target = perLine - this.cycleDebt;
      this.cycleDebt += (target > 0 ? this.main.run(target) : 0) - perLine;
      // vblank rising edge: NMI when enabled (vblank_interrupt_w)
      if (line === this.vbstart) {
        if (this.nmiEnabled) this.main.nmi();
        this.video.vblank();
      }
    }
    this.frameCount++;
    this.video.render(fb);
  }

  /** debug snapshot (live KG viewer hook) */
  snapshot() {
    return {
      frame: this.frameCount,
      cpus: [{
        tag: 'maincpu',
        pc: this.main.pc, sp: this.main.sp, a: this.main.a,
        halted: this.main.halted,
      }],
      nmiEnabled: this.nmiEnabled,
    };
  }
}
