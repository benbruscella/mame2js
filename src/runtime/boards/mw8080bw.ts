// Midway 8080 B&W board (Space Invaders): single Intel 8080, everything
// interesting lives in the io space — inputs on IN ports, the MB14241
// shifter, the (discrete) soundboard on OUT ports. Wiring facts come from
// the generated config; behavior is hand-transpiled from
// src/mame/midw8080/mw8080bw.cpp.
//
// Interrupts (mw8080bw.cpp:147, 217-240): the video counter fires RST
// vectors 0xc7 | (64V << 4) | (!64V << 3) — 0xcf (RST 1) when the counter
// hits 0x80 (screen line 96) and 0xd7 (RST 2) at vblank start (counter
// 0xe0 = line 224). The counter starts at 0x20 on the first visible line.

import { I8080 } from '../i8080.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { MB14241 } from '../mb14241.ts';
import { Mw8080bwVideo } from '../video/mw8080bw.ts';
import { portHandlers } from '../input.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

const VCOUNTER_START = 0x20;
const INT_TRIGGER_1 = 0x80; // -> RST 1 (0xcf)
const INT_TRIGGER_2 = 0xe0; // -> RST 2 (0xd7), vblank start

export class Mw8080bwBoard implements Board {
  readonly video: VideoRenderer;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private main: I8080;
  private shifter = new MB14241();
  private cyclesPerLine: number;
  private vtotal: number;
  private frameCount = 0;
  private irqHeld = false;
  readonly shares: Record<string, Uint8Array>;

  constructor(config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) {
    this.vtotal = config.screen.vtotal;
    const cpu = config.cpus[0];
    this.cyclesPerLine = Math.round(cpu.clock / config.screen.refresh / this.vtotal);

    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;

    const registry: HandlerRegistry = {
      read: {
        ...portHandlers(cpu.io?.ranges ?? [], inputs),
        'mb14241.shift_result_r': () => this.shifter.shiftResultR(),
      },
      write: {
        'mb14241.shift_count_w': (_a, _o, d) => this.shifter.shiftCountW(d),
        'mb14241.shift_data_w': (_a, _o, d) => this.shifter.shiftDataW(d),
        'watchdog.reset_w': () => { /* watchdog not enforced (same as other boards) */ },
        // discrete soundboard ports: forwarded for a future SFX HLE
        'soundboard.p1_w': (_a, _o, d) => sinks.soundWrite(0x51, d),
        'soundboard.p2_w': (_a, _o, d) => sinks.soundWrite(0x52, d),
        'soundboard.p3_w': (_a, _o, d) => sinks.soundWrite(0x53, d),
        'soundboard.p4_w': (_a, _o, d) => sinks.soundWrite(0x54, d),
      },
    };

    const rom = regions[cpu.region];
    if (!rom) throw new Error(`missing rom region ${cpu.region}`);
    const bus = new Bus(cpu.ranges ?? config.ranges, rom, registry, shares);
    const io = new Bus(cpu.io?.ranges ?? [], new Uint8Array(0), registry, shares);
    const ioMask = cpu.io?.globalMask ?? 0xff;
    bus.in = port => io.read(port & ioMask);
    bus.out = (port, data) => io.write(port & ioMask, data);

    this.main = new I8080(bus);

    this.fbWidth = config.screen.width;
    this.fbHeight = config.screen.height;
    this.video = new Mw8080bwVideo({
      mainRam: shares['main_ram'] ?? new Uint8Array(0x2000),
    });

    this.reset();
  }

  reset(): void {
    this.main.reset();
    this.irqHeld = false;
    this.frameCount = 0;
  }

  /** deliver an RST vector; line held until the CPU accepts (INTE drops) */
  private trigger(vector: number): void {
    this.main.setIrqLine(true, vector);
    this.irqHeld = true;
  }

  private runMain(target: number): number {
    let total = 0;
    while (total < target && this.irqHeld) {
      const inteBefore = this.main.inte;
      total += this.main.step();
      if (this.irqHeld && inteBefore && !this.main.inte) {
        this.main.setIrqLine(false); // accepted (INTA disables interrupts)
        this.irqHeld = false;
      }
    }
    if (total < target) total += this.main.run(target - total);
    return total;
  }

  frame(fb: Uint32Array): void {
    const vbstart = 224; // visible lines carry vcounter 0x20..0xff exactly
    for (let line = 0; line < this.vtotal; line++) {
      // RST 1 mid-screen (vcounter 0x80 -> line 96), RST 2 at vblank start
      if (line === INT_TRIGGER_1 - VCOUNTER_START) this.trigger(0xcf);
      if (line === vbstart) this.trigger(0xd7);
      this.runMain(this.cyclesPerLine);
    }
    this.frameCount++;
    this.video.render(fb);
  }

  snapshot() {
    return {
      frame: this.frameCount,
      cpus: [{ tag: 'maincpu', pc: this.main.pc, sp: this.main.sp, a: this.main.a, halted: this.main.halted }],
    };
  }
}
