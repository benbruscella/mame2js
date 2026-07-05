// Pac-Man board: single Z80, LS259 mainlatch, IM2 interrupt vector on io
// port 0, WSG sound, tile/sprite video. Wiring facts (clocks, ranges,
// screen) come from the generated config; behavior here is hand-transpiled
// from src/mame/pacman/pacman.cpp (cross-checked against the classic driver
// at MAME 0.121, git 7b77f121862:src/mame/drivers/pacman.c).

import { Z80 } from '../z80.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { LS259 } from '../ls259.ts';
import { PacmanVideo } from '../video/pacman.ts';
import { portHandlers } from '../input.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

export type { BoardConfig, BoardSinks } from '../types.ts';

// namco WSG volume registers (pacman_sound_w offsets), used to implement
// sound_enable_w through the write-only sound sink
const WSG_VOLUME_REGS: readonly number[] = [0x15, 0x1a, 0x1f];

export class PacmanBoard implements Board {
  readonly video: VideoRenderer;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private main: Z80;
  private mainlatch = new LS259();
  private sinks: BoardSinks;

  // interrupt state — pacman.cpp:362-397. vblank_irq asserts IRQ0 when the
  // mask (mainlatch Q0) is set; classic MAME used HOLD_LINE semantics
  // (irq0_line_hold), so the line is released as soon as the CPU accepts.
  private irqMask = 0;
  private irqVector = 0;    // pacman_interrupt_vector_w, fed back as the IM2 vector byte
  private irqHeld = false;  // line asserted, waiting for the CPU to accept

  // namco_audio_device::sound_enable_w (mainlatch Q1) has no dedicated sink,
  // so it is modeled by zeroing the WSG volume registers while disabled and
  // replaying the shadowed values on enable.  LS259 resets to 0 => muted
  // until the game writes 5001 = 1, as on hardware.
  private soundOn = false;
  private soundRegs = new Uint8Array(0x20);

  private cyclesPerLine: number;
  private vtotal: number;
  private vbstart: number;
  private cycleDebt = 0;
  private frameCount = 0;
  /** shared RAM blocks (videoram, colorram, spriteram, spriteram2) — debug/live-viewer access */
  readonly shares: Record<string, Uint8Array>;

  private inputs: InputPorts;

  constructor(
    config: BoardConfig,
    regions: Regions,
    inputs: InputPorts,
    sinks: BoardSinks,
  ) {
    this.inputs = inputs;
    this.sinks = sinks;
    this.vtotal = config.screen.vtotal;
    this.vbstart = config.screen.vbstart;
    const mainClock = config.cpus[0].clock;
    this.cyclesPerLine = Math.round(mainClock / config.screen.refresh / this.vtotal);

    // --- mainlatch (74LS259 at 8K, pacman.cpp:3713-3723) --------------------
    this.mainlatch.onQ(0, s => {
      // irq_mask_w (pacman.cpp:380-385): clearing the mask also clears the line
      this.irqMask = s;
      if (!s) {
        this.main.setIrqLine(false);
        this.irqHeld = false;
      }
    });
    this.mainlatch.onQ(1, s => this.soundEnable(s !== 0)); // namco sound_enable_w
    // Q3 = flipscreen_w — sampled by the video via the latch value getter.
    // Q4/Q5 (LEDs) and Q6 (coin lockout) are not hooked up on real Pac-Man
    // boards (see the NOTE in pacman.cpp:3719-3723); Q7 = coin_counter_w is
    // bookkeeping only.  All remain visible through snapshot().mainlatch.

    // --- memory map ----------------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;
    const registry: HandlerRegistry = {
      read: {
        // "return value of reading the bus with no devices enabled" (pacman.cpp:1030-1040)
        'pacman_state.pacman_read_nop': () => 0xbf,
        ...portHandlers(config.ranges, inputs),
        ...portHandlers(config.io?.ranges ?? [], inputs),
      },
      write: {
        // bytes stored by the bus; the video reads the shares every frame,
        // so the tilemap-dirty side of MAME's handlers is a no-op here
        'pacman_state.pacman_videoram_w': () => { /* no dirty tracking */ },
        'pacman_state.pacman_colorram_w': () => { /* no dirty tracking */ },
        'mainlatch.write_d0': (_a, off, d) => this.mainlatch.writeD0(off, d),
        'namco.pacman_sound_w': (_a, off, d) => this.soundWrite(off, d),
        'watchdog.reset_w': () => { /* watchdog not enforced (same as galaga) */ },
        // pacman_interrupt_vector_w: stores the IM2 vector; the classic
        // driver (0.121) also clears the irq line on this write
        'pacman_state.pacman_interrupt_vector_w': (_a, _o, d) => {
          this.irqVector = d;
          this.main.setIrqLine(false);
          this.irqHeld = false;
        },
      },
    };

    const rom = regions[config.cpus[0].region];
    if (!rom) throw new Error(`missing rom region ${config.cpus[0].region}`);
    const bus = new Bus(config.ranges, rom, registry, shares);

    // io space (AS_IO, writeport in pacman.cpp:1475-1479): global_mask(0xff),
    // port 0x00 = interrupt vector write.  Built as a second Bus and wired
    // into the main bus's in/out with the mask applied.
    if (config.io) {
      const ioBus = new Bus(config.io.ranges, new Uint8Array(0), registry, {});
      const mask = config.io.globalMask ?? 0xffff;
      bus.in = (port) => ioBus.read(port & mask);
      bus.out = (port, data) => ioBus.write(port & mask, data);
    }

    this.main = new Z80(bus);

    // --- video ---------------------------------------------------------------
    this.fbWidth = config.screen.width;
    this.fbHeight = config.screen.height;
    this.video = new PacmanVideo({
      regions,
      videoram: shares['videoram'] ?? new Uint8Array(0x400),
      colorram: shares['colorram'] ?? new Uint8Array(0x400),
      spriteram: shares['spriteram'] ?? new Uint8Array(0x10),
      spriteram2: shares['spriteram2'] ?? new Uint8Array(0x10),
      mainlatch: () => this.mainlatch.value,
    });

    this.reset();
  }

  reset(): void {
    this.mainlatch.reset();     // clears Q0..Q7 -> irq masked, sound disabled
    this.irqMask = 0;
    this.irqVector = 0;
    this.irqHeld = false;
    this.soundOn = false;
    this.main.reset();
    this.main.setIrqLine(false);
    this.cycleDebt = 0;
  }

  /** run one video frame and render it into `fb` */
  frame(fb: Uint32Array): void {
    const perLine = this.cyclesPerLine;
    for (let line = 0; line < this.vtotal; line++) {
      const target = perLine - this.cycleDebt;
      this.cycleDebt += (target > 0 ? this.runMain(target) : 0) - perLine;
      // vblank (screen_vblank -> vblank_irq, pacman.cpp:362-366)
      if (line === this.vbstart) {
        if (this.irqMask) {
          this.main.setIrqLine(true, this.irqVector); // IM2 vector on the data bus
          this.irqHeld = true;
        }
        this.video.vblank();
      }
    }
    this.frameCount++;
    this.video.render(fb);
  }

  /**
   * Run the main CPU, modeling HOLD_LINE: while the vblank irq is held,
   * step instruction-by-instruction and release the line as soon as the CPU
   * accepts the interrupt (observable as iff1 falling 1 -> 0 while the line
   * is asserted — the only other 1 -> 0 path would be a DI in the one-
   * instruction EI shadow, which no real program does with an irq pending).
   */
  private runMain(target: number): number {
    let total = 0;
    while (total < target && this.irqHeld) {
      const iffBefore = this.main.iff1;
      total += this.main.step();
      if (this.irqHeld && iffBefore === 1 && this.main.iff1 === 0) {
        this.main.setIrqLine(false); // HOLD_LINE: accepted -> released
        this.irqHeld = false;
      }
    }
    if (total < target) total += this.main.run(target - total);
    return total;
  }

  // --- sound enable gate -----------------------------------------------------

  private soundWrite(off: number, d: number): void {
    off &= 0x1f;
    d &= 0x0f;
    this.soundRegs[off] = d;
    // while sound is disabled, volume registers reach the DSP as 0
    const gated = !this.soundOn && WSG_VOLUME_REGS.includes(off) ? 0 : d;
    this.sinks.soundWrite(off, gated);
  }

  private soundEnable(on: boolean): void {
    this.soundOn = on;
    for (const off of WSG_VOLUME_REGS) {
      this.sinks.soundWrite(off, on ? this.soundRegs[off]! : 0);
    }
  }

  /** debug snapshot (live KG viewer hook) */
  snapshot() {
    return {
      frame: this.frameCount,
      cpus: [{
        tag: 'maincpu',
        pc: this.main.pc, sp: this.main.sp, a: this.main.a, halted: this.main.halted,
      }],
      mainlatch: this.mainlatch.value,
      irqVector: this.irqVector,
      irqMask: this.irqMask,
      soundOn: this.soundOn,
    };
  }
}
