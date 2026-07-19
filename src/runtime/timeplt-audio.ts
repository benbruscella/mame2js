// The shared Konami "Time Pilot" sound board (src/mame/shared/timeplt_a.cpp):
// a Z80 + two AY-3-8910s + the LS90 bi-quinary timer + per-channel RC filter
// banks. Used verbatim by Time Pilot, Pooyan and Roc'n Rope (and more Konami
// classics), so the behavior lives here once; each board wires its own
// mainlatch bits to shIrqTrigger/mute and steps the CPU via run().
//
// Hand-transpiled facts (timeplt_a.cpp):
//  - AY1 port A read = soundlatch (sound_data_w from the main CPU)
//  - AY1 port B read = the LS90 bi-quinary timer table indexed by
//    sound-CPU cycles / 512
//  - sh_irqtrigger_w: rising edge -> HOLD_LINE IM1 IRQ on the sound Z80
//    (held until the CPU accepts it, then released)
//  - mute_w: LA4460 amp DC mute (tracked; the ay8910 worklet has no mute
//    control yet, so the bit is not enforced)
//  - filter_w (0x8000-0xffff on the sound map): RC caps selected by ADDRESS
//    bits, two per channel — ay2 ch0/1/2 = offset bits 0/2/4, ay1 ch0/1/2 =
//    6/8/10. The hardware's bit0 = 220000 pF / bit1 = 47000 pF is the
//    REVERSE of the worklet's junofrst-convention 0x90+chip byte (bit0 =
//    47000 pF, bit1 = 220000 pF, see konamiFilterCaps), so each 2-bit field
//    is swapped before forwarding.

import { Z80 } from './z80.ts';
import { AY8910 } from './ay8910.ts';
import { Bus, type HandlerRegistry } from './bus.ts';
import type { BoardSinks, CpuSpec } from './types.ts';

// timeplt_a.cpp portB_r: divide-by-512 then a divide-by-10 LS90 bi-quinary
// sequence feeding the upper bits of AY1 port B
const SOUND_TIMER = [0x00, 0x10, 0x20, 0x30, 0x40, 0x90, 0xa0, 0xb0, 0xa0, 0xd0];

export class TimepltAudio {
  readonly cpu: Z80;

  soundlatch = 0;
  /** mainlatch mute_w bit (tracked but not enforced — see header). */
  muted = false;
  /** total sound-CPU cycles run (drives the LS90 timer). */
  cycles = 0;

  private irqHeld = false;
  // local AY instances exist for register READBACK only (audio renders in
  // the worklet, which gets the graph's clock via sound.clock)
  private ays = [new AY8910(1_789_772), new AY8910(1_789_772)];
  private ayAddr = [0, 0];

  /**
   * Installs the sound-board handlers into `registry` and builds the sound
   * CPU on its own bus from the generated map. Call BEFORE any Bus that
   * references these handler keys is constructed.
   */
  constructor(spec: CpuSpec, rom: Uint8Array, registry: HandlerRegistry,
              shares: Record<string, Uint8Array>, sinks: BoardSinks, frac: () => number) {
    this.ays[0].portARead = () => this.soundlatch;
    this.ays[0].portBRead = () => SOUND_TIMER[Math.floor(this.cycles / 512) % 10];

    registry.write['timeplt_audio.sound_data_w'] = (_a, _o, d) => { this.soundlatch = d; };
    registry.write['timeplt_audio_device.filter_w'] = (_a, off) => {
      const swap2 = (v: number) => ((v & 1) << 1) | ((v >> 1) & 1);
      const chipByte = (c0: number, c1: number, c2: number) =>
        swap2(c0) | (swap2(c1) << 2) | (swap2(c2) << 4);
      sinks.soundWrite(0x90, chipByte((off >> 6) & 3, (off >> 8) & 3, (off >> 10) & 3), frac()); // ay1
      sinks.soundWrite(0x91, chipByte(off & 3, (off >> 2) & 3, (off >> 4) & 3), frac());         // ay2
    };
    for (let i = 0; i < 2; i++) {
      const chip = i;
      registry.write[`ay${i + 1}.address_w`] = (_a, _o, d) => { this.ayAddr[chip] = d & 0x0f; };
      registry.write[`ay${i + 1}.data_w`] = (_a, _o, d) => {
        this.ays[chip].writeReg(this.ayAddr[chip], d);
        sinks.soundWrite(chip * 16 + this.ayAddr[chip], d, frac());
      };
      registry.read[`ay${i + 1}.data_r`] = () => this.ays[chip].readReg(this.ayAddr[chip]);
    }

    this.cpu = new Z80(new Bus(spec.ranges ?? [], rom, registry, shares));
  }

  /** sh_irqtrigger_w: LS259 callbacks only fire on change, so s=1 IS the rising edge. */
  shIrqTrigger(s: number): void {
    if (s) { this.cpu.setIrqLine(true); this.irqHeld = true; }
  }

  mute(s: number): void { this.muted = !!s; }

  /**
   * Run the sound CPU for ~target cycles (HOLD_LINE semantics: the IM1 IRQ
   * line is released as soon as the CPU accepts it). Returns cycles actually
   * run (the last instruction may overshoot).
   */
  run(target: number): number {
    let total = 0;
    while (total < target && this.irqHeld) {
      const iffBefore = this.cpu.iff1;
      total += this.cpu.step();
      if (this.irqHeld && iffBefore === 1 && this.cpu.iff1 === 0) {
        this.cpu.setIrqLine(false);
        this.irqHeld = false;
      }
    }
    if (total < target) total += this.cpu.run(target - total);
    this.cycles += total;
    return total;
  }

  reset(): void {
    this.soundlatch = 0;
    this.muted = false;
    this.cycles = 0;
    this.irqHeld = false;
    this.ayAddr = [0, 0];
    this.cpu.reset();
  }
}
