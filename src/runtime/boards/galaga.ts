// Galaga board: 3x Z80 on a shared memory map, LS259 latches, Namco 06xx bus
// interface with 51xx (I/O) and 54xx (noise, HLE in namco54.ts) customs, WSG sound,
// tile/sprite/starfield video. Wiring facts (clocks, ranges, screen) come from
// the generated config; behavior here is hand-transpiled from
// src/mame/namco/galaga.cpp.

import { Z80 } from '../z80.ts';
import { Bus, type RangeSpec, type HandlerRegistry } from '../bus.ts';
import { LS259 } from '../ls259.ts';
import { Namco51 } from '../namco51.ts';
import { Namco06 } from '../namco06.ts';
import { GalagaVideo } from '../video/galaga.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

export type { BoardConfig, BoardSinks } from '../types.ts';

export class GalagaBoard implements Board {
  readonly video: VideoRenderer;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private cpus: Z80[] = [];
  private main!: Z80;
  private sub!: Z80;
  private sub2!: Z80;

  private misclatch = new LS259();
  private videolatch = new LS259();
  private n51: Namco51;
  private n06: Namco06;

  private mainIrqMask = 0;
  private subIrqMask = 0;
  private sub2NmiMask = 0;
  private subsHeld = true;

  private cyclesPerLine: number;
  private vtotal: number;
  private vbstart: number;
  private cycleDebt = [0, 0, 0];
  private frameCount = 0;
  /** shared RAM blocks (videoram, galaga_ram1/2/3) — debug/live-viewer access */
  readonly shares: Record<string, Uint8Array>;

  private inputs: InputPorts;

  constructor(
    config: BoardConfig,
    regions: Regions,
    inputs: InputPorts,
    sinks: BoardSinks,
  ) {
    this.inputs = inputs;
    this.vtotal = config.screen.vtotal;
    this.vbstart = config.screen.vbstart;
    const mainClock = config.cpus[0].clock;
    this.cyclesPerLine = Math.round(mainClock / config.screen.refresh / this.vtotal);

    // --- devices -----------------------------------------------------------
    this.n51 = new Namco51({
      in: [
        () => this.inputs.read('IN0') & 0x0f,
        () => this.inputs.read('IN0') >> 4,
        () => this.inputs.read('IN1') & 0x0f,
        () => this.inputs.read('IN1') >> 4,
      ],
      frame: () => this.frameCount,
    });

    this.n06 = new Namco06(config.clocks.namco06, mainClock, () => this.main.nmi(), [
      { read: () => this.n51.read(), write: d => this.n51.write(d), chipSelect: () => { /* level tracked in Namco06 */ } },
      null,
      null,
      // 54xx noise generator: the command byte stream is forwarded to the
      // audio worklet on sound-offset 0x40 (offsets 0x00-0x1f are WSG
      // registers; >= 0x40 is the 54xx command channel — see wsg-worklet.ts).
      { write: d => sinks.soundWrite(0x40, d) },
    ]);

    this.misclatch.onQ(0, s => {
      this.mainIrqMask = s;
      if (!s) this.main.setIrqLine(false);
    });
    this.misclatch.onQ(1, s => {
      this.subIrqMask = s;
      if (!s) this.sub.setIrqLine(false);
    });
    this.misclatch.onQ(2, s => { this.sub2NmiMask = s ? 0 : 1; });
    this.misclatch.onQ(3, s => {
      // inverted reset line to sub CPUs + 51xx/54xx
      if (!s) { this.subsHeld = true; this.n51.reset(); }
      else if (this.subsHeld) { this.subsHeld = false; this.sub.reset(); this.sub2.reset(); }
    });

    // --- memory map --------------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;
    const registry: HandlerRegistry = {
      read: {
        'galaga_state.bosco_dsw_r': (_a, off) =>
          ((this.inputs.read('DSWB') >> off) & 1) | (((this.inputs.read('DSWA') >> off) & 1) << 1),
        '06xx.data_r': () => this.n06.dataRead(),
        '06xx.ctrl_r': () => this.n06.ctrlRead(),
      },
      write: {
        'galaga_state.galaga_videoram_w': () => { /* bytes stored by bus; no dirty tracking */ },
        'namco.pacman_sound_w': (_a, off, d) => sinks.soundWrite(off, d),
        'misclatch.write_d0': (_a, off, d) => this.misclatch.writeD0(off, d),
        'videolatch.write_d0': (_a, off, d) => this.videolatch.writeD0(off, d),
        'watchdog.reset_w': () => { /* watchdog not enforced */ },
        '06xx.data_w': (_a, _o, d) => this.n06.dataWrite(d),
        '06xx.ctrl_w': (_a, _o, d) => this.n06.ctrlWrite(d),
      },
    };

    for (const cpu of config.cpus) {
      const rom = regions[cpu.region];
      if (!rom) throw new Error(`missing rom region ${cpu.region}`);
      const bus = new Bus(config.ranges, rom, registry, shares);
      this.cpus.push(new Z80(bus));
    }
    [this.main, this.sub, this.sub2] = this.cpus;

    // --- video ---------------------------------------------------------------
    this.fbWidth = config.screen.width;
    this.fbHeight = config.screen.height;
    this.video = new GalagaVideo({
      regions,
      videoram: shares['videoram'] ?? new Uint8Array(0x800),
      ram1: shares['galaga_ram1'] ?? new Uint8Array(0x400),
      ram2: shares['galaga_ram2'] ?? new Uint8Array(0x400),
      ram3: shares['galaga_ram3'] ?? new Uint8Array(0x400),
      videolatch: () => this.videolatch.value,
    });

    this.reset();
  }

  reset(): void {
    this.misclatch.reset();
    this.videolatch.reset();
    this.n51.reset();
    this.n06.reset();
    this.subsHeld = true;
    for (const cpu of this.cpus) cpu.reset();
    this.cycleDebt = [0, 0, 0];
  }

  /** run one video frame and render it into `fb` */
  frame(fb: Uint32Array): void {
    const perLine = this.cyclesPerLine;
    const runCpu = (cpu: Z80, i: number) => {
      const target = perLine - this.cycleDebt[i];
      this.cycleDebt[i] += (target > 0 ? cpu.run(target) : 0) - perLine;
    };
    for (let line = 0; line < this.vtotal; line++) {
      runCpu(this.main, 0);
      this.n06.tick(perLine);
      // sub CPUs (held in reset until released via misclatch Q3)
      if (!this.subsHeld) {
        runCpu(this.sub, 1);
        runCpu(this.sub2, 2);
      }
      // 3rd CPU NMI at scanlines 64 and 192 (galaga.cpp cpu3_interrupt_callback)
      if ((line === 64 || line === 192) && this.sub2NmiMask && !this.subsHeld) {
        this.sub2.nmi();
      }
      // vblank
      if (line === this.vbstart) {
        if (this.mainIrqMask) this.main.setIrqLine(true);
        if (this.subIrqMask && !this.subsHeld) this.sub.setIrqLine(true);
        this.video.vblank();
      }
    }
    this.frameCount++;
    this.video.render(fb);
  }

  /** debug snapshot (live KG viewer hook) */
  snapshot() {
    const namco51 = this.n51.snapshot();
    return {
      frame: this.frameCount,
      cpus: this.cpus.map((c, i) => ({
        tag: ['maincpu', 'sub', 'sub2'][i],
        pc: c.pc, sp: c.sp, a: c.a, halted: c.halted,
        held: i > 0 && this.subsHeld,
      })),
      credits: namco51.credits as number,
      misclatch: this.misclatch.value,
      videolatch: this.videolatch.value,
      namco51,
      namco06: this.n06.snapshot(),
    };
  }
}
