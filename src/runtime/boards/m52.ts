// Irem M52 board (Moon Patrol): Z80 main + the Irem sound board — an M6803
// with two AY-3-8910s on its port-1 data bus and an MSM5205 ADPCM chip whose
// VCK edge drives the 6803's NMI. Wiring facts come from the generated
// config; behavior is hand-transpiled from src/mame/irem/m52.cpp and
// src/mame/irem/irem.cpp:
//  - main: IRQ0 hold-line at vblank (m52.cpp:951)
//  - protection_r = popcount(bgxpos0 & 0x7f) ^ (bgxpos0 >> 7) (m52.cpp:396)
//  - cmd_w: latch + 6803 IRQ when bit7 clear; sound_irq_ack_w clears it
//    while the latch's bit7 is set (irem.cpp)
//  - 6803 port2 falling-edge-on-bit0 writes port1 to AY address (bit2 set)
//    or data (clear), chip select bits 3 (45M) / 4 (45L); port1 reads the
//    selected chip (irem.cpp m6803_port1_r/port2_w)
//  - AY 45M port A read = sound latch; port B write = MSM playmode
//    ((d>>2)&7) + reset (d&1); AY 45L port A = analog drum triggers
//    (BD/SD/OH/CH — not fitted on the M52 soundc board)
//  - MSM5205 runs as the NMI pacemaker; its audio channel is not yet routed
//    to the worklet (AY music plays; ADPCM engine sound is a known phase-2
//    gap, 54xx-style)

import { Z80 } from '../z80.ts';
import { M6803 } from '../m6803.ts';
import { MSM5205 } from '../msm5205.ts';
import { AY8910 } from '../ay8910.ts';
import { Bus, type HandlerRegistry } from '../bus.ts';
import { M52Video } from '../video/m52.ts';
import { portHandlers } from '../input.ts';
import type { Regions, InputPorts, VideoRenderer, Board, BoardConfig, BoardSinks } from '../types.ts';

export class M52Board implements Board {
  readonly video: VideoRenderer;
  readonly fbWidth: number;
  readonly fbHeight: number;

  private main!: Z80;
  private audio!: M6803;
  private msm: MSM5205;
  private ays: AY8910[] = [];
  private ayAddr = [0, 0];

  private soundLatch = 0;
  private port1 = 0;
  private port2 = 0;
  private flipLatch = 0;

  // video latches (read live by M52Video via getters)
  private scroll = 0;
  private bgxpos = [0, 0];
  private bgypos = [0, 0];
  private bgcontrol = 0;

  private cyclesPerLine: number[];
  private msmClocksPerLine: number;
  private vtotal: number;
  private vbstart: number;
  private mainIrqHeld = false;
  private frameCount = 0;
  readonly shares: Record<string, Uint8Array>;

  constructor(config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) {
    this.vtotal = config.screen.vtotal;
    this.vbstart = config.screen.vbstart;
    const [mainSpec, audioSpec] = config.cpus;
    this.cyclesPerLine = [mainSpec, audioSpec].map(c =>
      Math.round(c.clock / config.screen.refresh / this.vtotal));

    // --- sound devices --------------------------------------------------------
    // local AYs for register readback; audio renders in the ay8910 worklet
    for (let i = 0; i < 2; i++) this.ays.push(new AY8910(894886));
    this.ays[0].portARead = () => this.soundLatch; // 45M port A = command latch
    this.msm = new MSM5205(384000);
    this.msm.vckCallback = state => { if (state) this.audio.nmi(); };
    this.msmClocksPerLine = 384000 / config.screen.refresh / this.vtotal;
    this.ays[0].portBWrite = (d: number) => {
      // irem.cpp ay8910_45M_portb_w: MSM playmode + reset
      this.msm.write(2, (d >> 2) & 7);
      this.msm.write(1, d & 1);
    };
    this.ays[1].portAWrite = () => { /* drum trigger lines not fitted on M52 soundc */ };

    // --- handler registry -----------------------------------------------------
    const shares: Record<string, Uint8Array> = {};
    this.shares = shares;

    const registry: HandlerRegistry = {
      read: {
        ...portHandlers(mainSpec.ranges ?? [], inputs),
        'm52_state.protection_r': () => {
          let pop = 0;
          for (let t = this.bgxpos[0] & 0x7f; t !== 0; t >>= 1) pop += t & 1;
          return (pop ^ (this.bgxpos[0] >> 7)) & 0xff;
        },
      },
      write: {
        'm52_state.videoram_w': () => { /* bytes stored by bus */ },
        'm52_state.colorram_w': () => { /* bytes stored by bus */ },
        'm52_state.flipscreen_w': (_a, _o, d) => { this.flipLatch = d & 1; },
        'm52_state.scroll_w': (_a, _o, d) => { this.scroll = d; },
        'm52_state.bgxpos_w_0': (_a, _o, d) => { this.bgxpos[0] = d; },
        'm52_state.bgypos_w_0': (_a, _o, d) => { this.bgypos[0] = d; },
        'm52_state.bgxpos_w_1': (_a, _o, d) => { this.bgxpos[1] = d; },
        'm52_state.bgypos_w_1': (_a, _o, d) => { this.bgypos[1] = d; },
        'm52_state.bgcontrol_w': (_a, _o, d) => { this.bgcontrol = d; },
        'irem_audio.cmd_w': (_a, _o, d) => {
          this.soundLatch = d;
          if ((d & 0x80) === 0) this.audio.setIrqLine(true);
        },
        'irem_audio_device.m52_adpcm_w': (_a, _o, d) => this.msm.write(0, d),
        'irem_audio_device.sound_irq_ack_w': () => {
          if ((this.soundLatch & 0x80) !== 0) this.audio.setIrqLine(false);
        },
      },
    };

    // --- CPUs + buses ---------------------------------------------------------
    // sub-board rom regions are namespaced ("irem_audio:iremsound")
    const regionFor = (tag: string): Uint8Array | undefined =>
      regions[tag] ?? Object.entries(regions).find(([k]) => k.endsWith(`:${tag}`))?.[1];

    const mainRom = regionFor(mainSpec.region);
    if (!mainRom) throw new Error(`missing rom region ${mainSpec.region}`);
    const mainBus = new Bus(mainSpec.ranges ?? [], mainRom, registry, shares);
    const io = new Bus(mainSpec.io?.ranges ?? [], new Uint8Array(0), registry, shares);
    const ioMask = mainSpec.io?.globalMask ?? 0xff;
    mainBus.in = port => io.read(port & ioMask);
    mainBus.out = (port, data) => io.write(port & ioMask, data);
    this.main = new Z80(mainBus);

    const audioRom = regionFor(audioSpec.region);
    if (!audioRom) throw new Error(`missing rom region ${audioSpec.region}`);
    const audioBus = new Bus(audioSpec.ranges ?? [], audioRom, registry, shares);
    // the sound map global-masks to 0x7fff: the 6803 reset vector at $FFFE
    // reads ROM $7FFE (irem.cpp m52_small_sound_map)
    const audioMask = audioSpec.mask ?? 0xffff;
    const maskedBus = {
      read: (a: number) => audioBus.read(a & audioMask),
      write: (a: number, d: number) => audioBus.write(a & audioMask, d),
    };
    this.audio = new M6803(maskedBus, {
      p1Read: () => {
        if (this.port2 & 0x08) return this.ays[0].readReg(this.ayAddr[0]);
        if (this.port2 & 0x10) return this.ays[1].readReg(this.ayAddr[1]);
        return 0xff;
      },
      p1Write: v => { this.port1 = v; },
      p2Read: () => 0x00,
      p2Write: v => {
        // falling edge of bit0 latches port1 into the selected AY
        if ((this.port2 & 0x01) && !(v & 0x01)) {
          for (const chip of [0, 1]) {
            if (!(this.port2 & (chip ? 0x10 : 0x08))) continue;
            if (this.port2 & 0x04) {
              this.ayAddr[chip] = this.port1 & 0x0f;
            } else {
              this.ays[chip].writeReg(this.ayAddr[chip], this.port1);
              sinks.soundWrite(chip * 16 + this.ayAddr[chip], this.port1);
            }
          }
        }
        this.port2 = v;
      },
    });

    // --- video ------------------------------------------------------------------
    this.fbWidth = config.screen.width;
    this.fbHeight = config.screen.height;
    this.video = new M52Video({
      regions,
      videoram: shares['videoram'] ?? shares['m_videoram'] ?? new Uint8Array(0x400),
      colorram: shares['colorram'] ?? shares['m_colorram'] ?? new Uint8Array(0x400),
      spriteram: shares['spriteram'] ?? shares['m_spriteram'] ?? new Uint8Array(0x400),
      scroll: () => this.scroll,
      bgxpos0: () => this.bgxpos[0],
      bgypos0: () => this.bgypos[0],
      bgxpos1: () => this.bgxpos[1],
      bgypos1: () => this.bgypos[1],
      bgcontrol: () => this.bgcontrol,
      flip: () => ((this.flipLatch ^ (~inputs.read('DSW2') & 1)) & 1) !== 0,
    });

    this.reset();
  }

  reset(): void {
    this.soundLatch = 0;
    this.port1 = this.port2 = 0;
    this.scroll = 0;
    this.bgxpos = [0, 0];
    this.bgypos = [0, 0];
    this.bgcontrol = 0;
    this.flipLatch = 0;
    this.mainIrqHeld = false;
    this.main.reset();
    this.audio.reset();
  }

  /** run the main Z80 with irq0_line_hold semantics (released on acceptance) */
  private runMain(target: number): number {
    let total = 0;
    while (total < target && this.mainIrqHeld) {
      const iffBefore = this.main.iff1;
      total += this.main.step();
      if (this.mainIrqHeld && iffBefore === 1 && this.main.iff1 === 0) {
        this.main.setIrqLine(false);
        this.mainIrqHeld = false;
      }
    }
    if (total < target) total += this.main.run(target - total);
    return total;
  }

  frame(fb: Uint32Array): void {
    const [mainPerLine, audioPerLine] = this.cyclesPerLine;
    for (let line = 0; line < this.vtotal; line++) {
      if (line === this.vbstart) {
        this.main.setIrqLine(true);
        this.mainIrqHeld = true;
        this.video.vblank();
      }
      this.runMain(mainPerLine);
      this.audio.run(audioPerLine);
      this.msm.tick(this.msmClocksPerLine);
    }
    this.frameCount++;
    this.video.render(fb);
  }

  snapshot() {
    return {
      frame: this.frameCount,
      cpus: [
        { tag: 'maincpu', pc: this.main.pc, sp: this.main.sp, a: this.main.a, halted: this.main.halted },
        { tag: 'iremsound', pc: this.audio.pc, sp: this.audio.sp, a: this.audio.a, halted: this.audio.halted },
      ],
      soundLatch: this.soundLatch,
      bgcontrol: this.bgcontrol,
    };
  }
}
