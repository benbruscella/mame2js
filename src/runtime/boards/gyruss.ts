// Gyruss board: Z80 main + KONAMI-1 (encrypted 6809) sub sharing RAM, and a
// Z80 sound CPU driving five AY-3-8910s through its io space (+ an i8039
// percussion channel, stubbed like the 54xx once was). Wiring facts come
// from the generated config; behavior is hand-transpiled from
// src/mame/konami/gyruss.cpp:
//  - vblank (line 240): main NMI when mainlatch Q0 set; sub 6809 IRQ level
//    while slave_irq_mask set, cleared when the mask clears (gyruss.cpp
//    vblank_irq / slave_irq_mask_w / master_nmi_mask_w)
//  - sh_irqtrigger_w: HOLD-line IM1 IRQ to the sound Z80
//  - porta_r (AY3 port A): timer[(audioCycles / 1024) % 10] with the
//    gyruss.cpp:338 table
//  - mainlatch: Q0 nmi mask, Q2/Q3 coin counters, Q5 flip screen
//  - AY1/AY2 port B write = RC filter switching (accepted, not modeled)

import { Z80 } from '../z80.ts';
import { Konami1 } from '../konami1.ts';
import { AY8910 } from '../ay8910.ts';
import { LS259 } from '../ls259.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { GyrussVideo } from '../video/gyruss.ts';
import { portHandlers } from '../input.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

// gyruss.cpp:338 — value read back through AY3 port A, indexed by audio cycles
const SOUND_TIMER = [0x00, 0x01, 0x02, 0x03, 0x04, 0x09, 0x0a, 0x0b, 0x0a, 0x0d];

export class GyrussBoard implements Board {
  readonly video: VideoRenderer;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private main!: Z80;
  private sub!: Konami1;
  private audio!: Z80;

  private mainlatch = new LS259();
  private ays: AY8910[] = [];
  private ayAddr = [0, 0, 0, 0, 0];

  private nmiMask = 0;
  private slaveIrqMask = 0;
  private audioIrqHeld = false;
  private soundlatch = 0;
  private soundlatch2 = 0;
  private audioCycles = 0;
  private scanline = 0;

  private cyclesPerLine: number[];
  private vtotal: number;
  private frameCount = 0;
  readonly shares: Record<string, Uint8Array>;

  constructor(config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) {
    this.vtotal = config.screen.vtotal;
    const [mainSpec, subSpec, audioSpec] = config.cpus;
    this.cyclesPerLine = [mainSpec, subSpec, audioSpec].map(c =>
      Math.round(c.clock / config.screen.refresh / this.vtotal));

    // --- AY bank: local instances exist for register READBACK only (the
    // audio renders in the worklet, which gets the graph's clock via
    // sound.clock) — the clock here never affects readback state
    for (let i = 0; i < 5; i++) this.ays.push(new AY8910(1_789_772));
    this.ays[2].portARead = () => SOUND_TIMER[Math.floor(this.audioCycles / 1024) % 10];

    this.mainlatch.onQ(0, s => { this.nmiMask = s; });
    this.mainlatch.onQ(5, s => { (this.video as GyrussVideo).setFlip(!!s); });

    // --- handler registry ----------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;

    const registry: HandlerRegistry = {
      read: {
        ...portHandlers(mainSpec.ranges ?? [], inputs),
        'gyruss_state.scanline_r': () => this.scanline & 0xff,
        'soundlatch.read': () => this.soundlatch,
      },
      write: {
        'gyruss_state.sh_irqtrigger_w': () => { this.audio.setIrqLine(true); this.audioIrqHeld = true; },
        'gyruss_state.slave_irq_mask_w': (_a, _o, d) => {
          this.slaveIrqMask = d & 1;
          if (!this.slaveIrqMask) this.sub.setIrqLine(false);
        },
        'gyruss_state.spriteram_w': () => { /* bytes stored by bus; full-frame render */ },
        'gyruss_state.i8039_irq_w': () => { /* i8039 percussion stubbed (54xx-style upgrade later) */ },
        'soundlatch.write': (_a, _o, d) => { this.soundlatch = d; },
        'soundlatch2.write': (_a, _o, d) => { this.soundlatch2 = d; },
        'mainlatch.write_d0': (_a, off, d) => this.mainlatch.writeD0(off, d),
      },
    };
    for (let i = 0; i < 5; i++) {
      const chip = i;
      registry.write[`ay${i + 1}.address_w`] = (_a, _o, d) => { this.ayAddr[chip] = d & 0x0f; };
      registry.write[`ay${i + 1}.data_w`] = (_a, _o, d) => {
        this.ays[chip].writeReg(this.ayAddr[chip], d);
        sinks.soundWrite(chip * 16 + this.ayAddr[chip], d);
      };
      registry.read[`ay${i + 1}.data_r`] = () => this.ays[chip].readReg(this.ayAddr[chip]);
    }

    // --- CPUs + buses ---------------------------------------------------------
    const busFor = (spec: typeof mainSpec) => {
      const rom = regions[spec.region];
      if (!rom) throw new Error(`missing rom region ${spec.region}`);
      return new Bus(spec.ranges ?? [], rom, registry, shares);
    };
    this.main = new Z80(busFor(mainSpec));
    this.sub = new Konami1(busFor(subSpec));

    const audioBus = busFor(audioSpec);
    const io = new Bus(audioSpec.io?.ranges ?? [], new Uint8Array(0), registry, shares);
    const ioMask = audioSpec.io?.globalMask ?? 0xff;
    audioBus.in = port => io.read(port & ioMask);
    audioBus.out = (port, data) => io.write(port & ioMask, data);
    this.audio = new Z80(audioBus);

    // --- video ----------------------------------------------------------------
    this.fbWidth = config.screen.width;
    this.fbHeight = config.screen.height;
    this.video = new GyrussVideo({
      regions,
      videoram: shares['m_videoram'] ?? new Uint8Array(0x400),
      colorram: shares['m_colorram'] ?? new Uint8Array(0x400),
      spriteram: shares['m_spriteram'] ?? new Uint8Array(0xc0),
    });

    this.reset();
  }

  reset(): void {
    this.mainlatch.reset();
    this.nmiMask = 0;
    this.slaveIrqMask = 0;
    this.audioIrqHeld = false;
    this.soundlatch = this.soundlatch2 = 0;
    this.audioCycles = 0;
    this.main.reset();
    this.sub.reset();
    this.audio.reset();
  }

  /** run the audio Z80 modeling the HOLD-line IRQ (released on acceptance) */
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
    const [mainPerLine, subPerLine, audioPerLine] = this.cyclesPerLine;
    for (let line = 0; line < this.vtotal; line++) {
      this.scanline = line;
      if (line === 240) { // vblank start (visible 16..239)
        if (this.nmiMask) this.main.nmi();
        if (this.slaveIrqMask) this.sub.setIrqLine(true);
        this.video.vblank();
      }
      this.main.run(mainPerLine);
      this.sub.run(subPerLine);
      this.audioCycles += this.runAudio(audioPerLine);
    }
    this.frameCount++;
    this.video.render(fb);
  }

  snapshot() {
    return {
      frame: this.frameCount,
      cpus: [
        { tag: 'maincpu', pc: this.main.pc, sp: this.main.sp, a: this.main.a, halted: this.main.halted },
        { tag: 'sub', pc: this.sub.pc, sp: this.sub.s, a: this.sub.a, halted: this.sub.halted },
        { tag: 'audiocpu', pc: this.audio.pc, sp: this.audio.sp, a: this.audio.a, halted: this.audio.halted },
      ],
      mainlatch: this.mainlatch.value,
      soundlatch: this.soundlatch,
    };
  }
}
