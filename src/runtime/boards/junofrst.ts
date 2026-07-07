// Juno First board: KONAMI-1 (encrypted 6809) main with 16-way ROM banking
// and a nibble blitter over bitmap VRAM, Z80 sound with one AY-3-8910, and
// the i8039 percussion MCU driving an 8-bit DAC. Wiring facts come from the
// generated config; behavior is hand-transpiled from
// src/mame/konami/junofrst.cpp (+ tutankhm.cpp base class):
//  - main IRQ: every OTHER vblank (30 Hz) while mainlatch Q0 set; writing
//    Q0=0 clears the line (tutankhm irq_enable_w)
//  - mainlatch: Q0 irq enable, Q1/Q2 coin counters, Q4 flip X, Q5 flip Y
//  - bankselect (0x8060): 16 × 0x1000 pages from rom[0x10000] at 0x9000
//  - blitter (0x8070-73): 16×16 nibble blit from the un-mapped blitrom into
//    VRAM, triggered by the 4th byte; bit0 of the source = copy/clear
//  - sh_irqtrigger_w: 0→1 edge = HOLD_LINE IM1 IRQ to the sound Z80
//  - AY port A read: audio-cycle timer (cycles/512 & 0x0f) << 4 | i8039
//    status nibble; port B write (AY reg 15) = per-channel RC filter select
//    (junofrst.cpp portB_w), forwarded to the ay8910 worklet as offset 0x90
//  - audio 0x6000 asserts the i8039 INT line; the MCU's P2 write clears it
//    (bit 7 low) and publishes the status nibble; P1 = DAC sample, sent to
//    the worklet as offset 0x80

import { Konami1 } from '../konami1.ts';
import { Z80 } from '../z80.ts';
import { Mcs48 } from '../mcs48.ts';
import { AY8910 } from '../ay8910.ts';
import { LS259 } from '../ls259.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { JunofrstVideo } from '../video/junofrst.ts';
import { portHandlers } from '../input.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

export class JunofrstBoard implements Board {
  readonly video: VideoRenderer;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private main!: Konami1;
  private audio!: Z80;
  private mcu!: Mcs48;

  private mainlatch = new LS259();
  private ay = new AY8910(1_789_772);
  private ayAddr = 0;

  private mainRom: Uint8Array;
  private blitRom: Uint8Array;
  private bankBase = 0x10000;
  private blitterData = new Uint8Array(4);

  private irqEnable = 0;
  private irqToggle = false;
  private audioIrqHeld = false;
  private lastIrqTrigger = 0;
  private soundlatch = 0;
  private soundlatch2 = 0;
  private mcuStatus = 0;
  private audioCycles = 0;
  private curLine = 0;
  private flipX = false;
  private flipY = false;

  private cyclesPerLine: number[];
  private vtotal: number;
  private frameCount = 0;
  readonly shares: Record<string, Uint8Array>;

  constructor(config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) {
    this.vtotal = config.screen.vtotal;
    const [mainSpec, audioSpec, mcuSpec] = config.cpus;
    this.cyclesPerLine = [mainSpec, audioSpec, mcuSpec].map(c =>
      Math.round(c.clock / config.screen.refresh / this.vtotal));

    this.mainRom = regions[mainSpec.region];
    this.blitRom = regions['blitrom'];
    if (!this.mainRom || !this.blitRom) throw new Error('missing maincpu/blitrom regions');

    // AY port A: audio-CPU timer in the high nibble, i8039 status in the low
    // (junofrst.cpp portA_r — total_cycles() / (1024/2))
    this.ay.portARead = () => (((this.audioCycles / 512) & 0x0f) << 4) | this.mcuStatus;

    this.mainlatch.onQ(0, s => {
      this.irqEnable = s;
      if (!s) this.main.setIrqLine(false);
    });
    // Q1/Q2 coin counters: bookkeeping only; Q3 nop
    this.mainlatch.onQ(4, s => { this.flipX = !!s; });
    this.mainlatch.onQ(5, s => { this.flipY = !!s; });

    // --- handler registry ----------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;

    const registry: HandlerRegistry = {
      read: {
        ...portHandlers(mainSpec.ranges ?? [], inputs),
        'watchdog.reset_r': () => 0xff, // accepted, not enforced (galaga precedent)
        'bank.mainbank': (_a, off) => this.mainRom[this.bankBase + off],
        'soundlatch.read': () => this.soundlatch,
        'aysnd.data_r': () => this.ay.readReg(this.ayAddr),
      },
      write: {
        'palette.write8': () => { /* bytes stored by bus into the palette share */ },
        'mainlatch.write_d0': (_a, off, d) => this.mainlatch.writeD0(off, d),
        'junofrst_state.sh_irqtrigger_w': (_a, _o, d) => {
          if (this.lastIrqTrigger === 0 && d === 1) {
            this.audio.setIrqLine(true);
            this.audioIrqHeld = true;
          }
          this.lastIrqTrigger = d;
        },
        'soundlatch.write': (_a, _o, d) => { this.soundlatch = d; },
        'junofrst_state.bankselect_w': (_a, _o, d) => {
          this.bankBase = 0x10000 + (d & 0x0f) * 0x1000;
        },
        'junofrst_state.blitter_w': (_a, off, d) => this.blit(off, d),
        'aysnd.address_w': (_a, _o, d) => { this.ayAddr = d & 0x0f; },
        'aysnd.data_w': (_a, _o, d) => {
          this.ay.writeReg(this.ayAddr, d);
          sinks.soundWrite(this.ayAddr, d, this.curLine / this.vtotal);
          // reg 15 = port B = RC filter select (junofrst.cpp wires portB_w
          // to the AY's IOB output): tell the worklet to reprogram chip 0's
          // per-channel low-pass (protocol offset 0x90 + chip)
          if (this.ayAddr === 15) sinks.soundWrite(0x90, d, this.curLine / this.vtotal);
        },
        'soundlatch2.write': (_a, _o, d) => { this.soundlatch2 = d; },
        'junofrst_state.i8039_irq_w': () => this.mcu.setIrqLine(true),
      },
    };

    // --- CPUs + buses ---------------------------------------------------------
    const busFor = (spec: typeof mainSpec) => {
      const r = regions[spec.region];
      if (!r) throw new Error(`missing rom region ${spec.region}`);
      return new Bus(spec.ranges ?? [], r, registry, shares);
    };
    this.main = new Konami1(busFor(mainSpec));
    this.audio = new Z80(busFor(audioSpec));

    const mcuRom = regions[mcuSpec.region];
    this.mcu = new Mcs48({
      readProgram: addr => mcuRom[addr & 0x0fff],
      readIo: () => this.soundlatch2,
      writeIo: () => { /* no external RAM writes on this board */ },
      readPort: () => 0xff,
      writePort: (port, d) => {
        if (port === 1) sinks.soundWrite(0x80, d, this.curLine / this.vtotal); // DAC sample byte
        if (port === 2) {
          if ((d & 0x80) === 0) this.mcu?.setIrqLine(false); // ctor-safe: reset fires port writes
          this.mcuStatus = (d & 0x70) >> 4;
        }
      },
    });

    // --- video ----------------------------------------------------------------
    // bitmap hardware has no GFXDECODE, so the renderer owns the native
    // geometry (256×224) — the config's 768-wide raw params are the ×3
    // galaxian pixel clock, not the VRAM size
    this.video = new JunofrstVideo({
      videoram: () => shares['videoram'] ?? new Uint8Array(0x8000),
      paletteRam: () => shares['palette'] ?? new Uint8Array(0x10),
      flipX: () => this.flipX,
      flipY: () => this.flipY,
    });
    this.fbWidth = this.video.width;
    this.fbHeight = this.video.height;

    this.reset();
  }

  /** junofrst.cpp blitter_w: 16×16 nibble blit, triggered by byte 3 */
  private blit(offset: number, data: number): void {
    this.blitterData[offset] = data;
    if (offset !== 3) return;
    const vram = this.shares['videoram'];
    if (!vram) return;
    let src = ((this.blitterData[2] << 8) | this.blitterData[3]) & 0xfffc;
    let dest = (this.blitterData[0] << 8) | this.blitterData[1];
    const copy = (this.blitterData[3] & 1) !== 0;
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        let px = (src & 1) ? (this.blitRom[src >> 1] & 0x0f) : (this.blitRom[src >> 1] >> 4);
        src++;
        if (px) {
          if (!copy) px = 0;
          const idx = (dest >> 1) & 0x7fff;
          if (dest & 1) vram[idx] = (vram[idx] & 0x0f) | (px << 4);
          else vram[idx] = (vram[idx] & 0xf0) | px;
        }
        dest++;
      }
      dest += 240;
    }
  }

  reset(): void {
    this.mainlatch.reset();
    this.bankBase = 0x10000;
    this.blitterData.fill(0);
    this.irqEnable = 0;
    this.irqToggle = false;
    this.audioIrqHeld = false;
    this.lastIrqTrigger = 0;
    this.soundlatch = this.soundlatch2 = 0;
    this.mcuStatus = 0;
    this.main.reset();
    this.audio.reset();
    this.mcu.reset();
  }

  /** HOLD_LINE IM1 IRQ on the sound Z80 (released on acceptance) */
  private runAudio(target: number): number {
    let total = 0;
    while (total < target && this.audioIrqHeld) {
      const iffBefore = this.audio.iff1;
      total += this.audio.step();
      if (this.audioIrqHeld && iffBefore === 1 && this.audio.iff1 === 0) {
        this.audio.setIrqLine(false);
        this.audioIrqHeld = false;
      }
    }
    if (total < target) total += this.audio.run(target - total);
    return total;
  }

  frame(fb: Uint32Array): void {
    const [mainPerLine, audioPerLine, mcuPerLine] = this.cyclesPerLine;
    for (let line = 0; line < this.vtotal; line++) {
      this.curLine = line;
      if (line === 240) { // vblank: main IRQ every other frame (30 Hz, tutankhm)
        this.irqToggle = !this.irqToggle;
        if (this.irqToggle && this.irqEnable) this.main.setIrqLine(true);
        this.video.vblank();
      }
      this.main.run(mainPerLine);
      this.audioCycles += this.runAudio(audioPerLine);
      this.mcu.run(mcuPerLine);
    }
    this.frameCount++;
    this.video.render(fb);
  }

  snapshot() {
    return {
      frame: this.frameCount,
      cpus: [
        { tag: 'maincpu', pc: this.main.pc, sp: this.main.s, a: this.main.a, halted: this.main.halted },
        { tag: 'audiocpu', pc: this.audio.pc, sp: this.audio.sp, a: this.audio.a, halted: this.audio.halted },
        { tag: 'mcu', pc: this.mcu.pc, sp: 0, a: this.mcu.a, halted: false },
      ],
      mainlatch: this.mainlatch.value,
      bankBase: this.bankBase,
      soundlatch: this.soundlatch,
      soundlatch2: this.soundlatch2,
    };
  }
}
