// Dig Dug board: 3x Z80 on a shared memory map (galaga.cpp sibling), LS259
// latches, Namco 06xx bus interface with 51xx (I/O) and 53xx (DIP reader, HLE
// in namco53.ts) customs, WSG sound, ER2055 EAROM for non-volatile high
// scores, and a dual-playfield tile/sprite video (video/digdug.ts). Wiring
// facts (clocks, ranges, screen) come from the generated config; behavior here
// is hand-transpiled from src/mame/namco/galaga.cpp (digdug_state).

import { Z80 } from '../z80.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { LS259 } from '../ls259.ts';
import { Namco51 } from '../namco51.ts';
import { Namco53 } from '../namco53.ts';
import { Namco06 } from '../namco06.ts';
import { ER2055 } from '../er2055.ts';
import { DigdugVideo } from '../video/digdug.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

export type { BoardConfig, BoardSinks } from '../types.ts';

export class DigdugBoard implements Board {
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
  private n53: Namco53;
  private n06: Namco06;
  private earom = new ER2055();

  private mainIrqMask = 0;
  private subIrqMask = 0;
  private sub2NmiMask = 0;
  private subsHeld = true;

  private cyclesPerLine: number;
  private vtotal: number;
  private vbstart: number;
  private cycleDebt = [0, 0, 0];
  private frameCount = 0;
  /** shared RAM blocks (videoram, sprite RAM banks, EAROM) — debug/live viewer */
  readonly shares: Record<string, Uint8Array>;

  private inputs: InputPorts;
  private earomKey: string;

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
    this.earomKey = `mamekit.earom.${config.family}`;

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

    // 53xx: DIP-switch reader (DSWA lo/hi, DSWB lo/hi) polled read-only.
    this.n53 = new Namco53({
      in: [
        () => this.inputs.read('DSWA') & 0x0f,
        () => this.inputs.read('DSWA') >> 4,
        () => this.inputs.read('DSWB') & 0x0f,
        () => this.inputs.read('DSWB') >> 4,
      ],
    });

    // 06xx slots: chip-select 0 -> 51xx (I/O), chip-select 1 -> 53xx (read-only).
    this.n06 = new Namco06(config.clocks.namco06, mainClock, () => this.main.nmi(), [
      { read: () => this.n51.read(), write: d => this.n51.write(d) },
      { read: () => this.n53.read() },
      null,
      null,
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
      // inverted reset line to sub CPUs + 51xx/53xx customs
      if (!s) { this.subsHeld = true; this.n51.reset(); this.n53.reset(); }
      else if (this.subsHeld) { this.subsHeld = false; this.sub.reset(); this.sub2.reset(); }
    });

    // EAROM: seed from localStorage, persist on every write/erase.
    this.loadEarom();
    this.earom.onStore = () => this.saveEarom();

    // --- memory map --------------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;
    const registry: HandlerRegistry = {
      read: {
        '06xx.data_r': () => this.n06.dataRead(),
        '06xx.ctrl_r': () => this.n06.ctrlRead(),
        // EAROM data read: last CPU-written byte or the byte latched by a read op
        'digdug_state.earom_read': () => this.earom.read(),
      },
      write: {
        'digdug_state.digdug_videoram_w': () => { /* bytes stored by bus; video reads vram directly */ },
        'namco.pacman_sound_w': (_a, off, d) => sinks.soundWrite(off, d),
        'misclatch.write_d0': (_a, off, d) => this.misclatch.writeD0(off, d),
        'videolatch.write_d0': (_a, off, d) => this.videolatch.writeD0(off, d),
        'watchdog.reset_w': () => { /* watchdog not enforced */ },
        '06xx.data_w': (_a, _o, d) => this.n06.dataWrite(d),
        '06xx.ctrl_w': (_a, _o, d) => this.n06.ctrlWrite(d),
        // EAROM: data write latches address (offset) + data; control byte drives
        // the CS/C1/C2/CK lines (galaga.cpp earom_write / earom_control_w).
        'digdug_state.earom_write': (_a, off, d) => { this.earom.setAddress(off & 0x3f); this.earom.setData(d); },
        'digdug_state.earom_control_w': (_a, _o, d) => {
          this.earom.setControl((d >> 3) & 1, 1, (d >> 1) & 1 ? 0 : 1, (d >> 2) & 1);
          this.earom.setClk(d & 1);
        },
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
    this.video = new DigdugVideo({
      regions,
      videoram: shares['videoram'] ?? new Uint8Array(0x400),
      objram: shares['digdug_objram'] ?? new Uint8Array(0x400),
      posram: shares['digdug_posram'] ?? new Uint8Array(0x400),
      flpram: shares['digdug_flpram'] ?? new Uint8Array(0x400),
      videolatch: () => this.videolatch.value,
    });

    this.reset();
  }

  private loadEarom(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const saved = localStorage.getItem(this.earomKey);
      if (!saved) return;
      const bytes = saved.split(',');
      if (bytes.length !== this.earom.data.length) return;
      for (let i = 0; i < bytes.length; i++) this.earom.data[i] = Number(bytes[i]) & 0xff;
    } catch { /* private-mode / quota: fall back to fresh 0xff EAROM */ }
  }

  private saveEarom(): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(this.earomKey, this.earom.data.join(',')); } catch { /* ignore */ }
  }

  reset(): void {
    this.misclatch.reset();
    this.videolatch.reset();
    this.n51.reset();
    this.n53.reset();
    this.n06.reset();
    this.earom.reset();
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
      if (!this.subsHeld) {
        runCpu(this.sub, 1);
        runCpu(this.sub2, 2);
      }
      // 3rd CPU NMI at scanlines 64 and 192 (galaga.cpp cpu3_interrupt_callback)
      if ((line === 64 || line === 192) && this.sub2NmiMask && !this.subsHeld) {
        this.sub2.nmi();
      }
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
      namco53: this.n53.snapshot(),
      namco06: this.n06.snapshot(),
      earom: this.earom.snapshot(),
    };
  }
}
