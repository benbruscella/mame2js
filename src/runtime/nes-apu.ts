// NES 2A03 APU (pulse x2, triangle, noise, DMC) — the console's on-die
// sound unit, driven by CPU writes to $4000-$4017 (offset = address - $4000;
// $4014 is OAM DMA and never reaches this core, 0x15 = $4015, 0x17 = $4017).
//
// One class, two roles, both deterministic from the identical write stream:
//  - worklet instance (nes-worklet.ts): receives the register stream and
//    render()s audio at sampleRate = clock/2 (one sample per APU cycle,
//    ~894886 Hz NTSC). DMC sample bytes arrive via data(0, bytes) because an
//    AudioWorklet cannot read CPU memory. Never raises IRQs to anyone.
//  - main-thread "shadow" instance (constructed by the board): receives the
//    SAME writes, is tick()ed with CPU cycles, answers read4015(), raises
//    frame-counter + DMC IRQs (irqAsserted()), accounts DMC fetch stalls
//    (consumeDmcStalls(), ~4 CPU cycles per byte) and fires onDmcStart when
//    a DMC sample begins so the board can snapshot the bytes from cart PRG
//    (wrap $FFFF -> $8000 resolved by the board) and push them to the
//    worklet via BoardSinks.soundData. It never renders.
//
// References: MAME src/devices/sound/nes_apu.cpp (Nofrendo-derived) and the
// nesdev.org APU documents. Where the two disagree this follows nesdev:
//  - a real frame sequencer (4/5-step; quarter/half clocks at CPU cycles
//    7457 / 14913 / 22371 / 29829 [/ 37281], sequence 29830 or 37282)
//    instead of MAME's per-sample envelope/length stepping tied to
//    samps_per_sync (MAME: "FIXME: tables are 4-step mode ONLY");
//  - sweep units with per-channel negate adjust (pulse 1 one's-complement,
//    pulse 2 two's-complement) and the <8 / >$7FF muting rules (MAME sweeps
//    a 16.16 phase increment and only checks freq_limit);
//  - envelopes decay 15 -> 0 with divider period V+1 quarter-frames (MAME
//    counts env_vol upward at a 4x rate and outputs 15 - env_vol);
//  - the triangle linear counter reload flag instead of MAME's write_latency
//    hack;
//  - non-linear mixer via the nesdev LUT approximations
//    (95.52 / (8128/n + 100) and 163.67 / (24329/n + 100)) rather than
//    MAME's exact per-sample 95.88 / 159.79 formula — <0.5% apart, and a
//    flat lookup per sample.
// Remaining simplifications (deviations from hardware):
//  - NTSC tables only (this runtime hosts NTSC carts);
//  - the DMC memory reader refills at output-cycle boundaries rather than
//    one APU cycle after the buffer empties, and loop restarts replay the
//    start-time snapshot (same pushed buffer — the board is only told about
//    fresh starts, per the soundData transport design);
//  - a single slow DC blocker (~10 Hz one-pole) stands in for the console's
//    90 Hz + 440 Hz high-pass pair, centering the unipolar mix around 0.

import type { SoundCore } from './types.ts';

// --- shared tables ----------------------------------------------------------

/** Standard 32-entry length counter load table (indexed by reg bits 7-3). */
export const NES_LENGTH_TABLE: readonly number[] = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
];

/** NTSC noise LFSR periods, CPU cycles per shift ($400E bits 3-0). */
export const NES_NOISE_PERIODS: readonly number[] = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
];

/** NTSC DMC rates, CPU cycles per output bit ($4010 bits 3-0). */
export const NES_DMC_RATES: readonly number[] = [
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
];

/** 8-step duty sequences for $4000/$4004 bits 7-6 (12.5/25/50/75%). */
export const DUTY: readonly (readonly number[])[] = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];

/** Non-linear pulse mix: index = pulse1 + pulse2 (0..30). */
export const NES_PULSE_MIX: Float32Array = (() => {
  const t = new Float32Array(31);
  for (let n = 1; n <= 30; n++) t[n] = 95.52 / (8128 / n + 100);
  return t;
})();

/** Non-linear tri/noise/DMC mix: index = 3*tri + 2*noise + dmc (0..202). */
export const NES_TND_MIX: Float32Array = (() => {
  const t = new Float32Array(203);
  for (let n = 1; n <= 202; n++) t[n] = 163.67 / (24329 / n + 100);
  return t;
})();

/** DC blocker corner (Hz) — see header; also sets the output centering. */
const DC_CUTOFF_HZ = 10;

/** Full-scale mix is ~1.0 unipolar; x2 after centering spans roughly ±1. */
const OUT_GAIN = 2.0;

// --- frame counter ----------------------------------------------------------
// Event positions in CPU cycles (2x the nesdev APU-cycle table: quarters at
// APU 3728.5 / 7456.5 / 11185.5 / 14914.5 [/ 18640.5]). The same table
// drives the worklet (render: 2 CPU cycles per sample) and the shadow
// (tick: raw CPU cycles), so both stay bit-identical.

interface FrameEvent {
  at: number;
  q: boolean;
  h: boolean;
  irq: boolean;
}

const FRAME_4: readonly FrameEvent[] = [
  { at: 7457, q: true, h: false, irq: false },
  { at: 14913, q: true, h: true, irq: false },
  { at: 22371, q: true, h: false, irq: false },
  { at: 29829, q: true, h: true, irq: true },
];
const FRAME_4_LEN = 29830;

const FRAME_5: readonly FrameEvent[] = [
  { at: 7457, q: true, h: false, irq: false },
  { at: 14913, q: true, h: true, irq: false },
  { at: 22371, q: true, h: false, irq: false },
  { at: 37281, q: true, h: true, irq: false },
];
const FRAME_5_LEN = 37282;

// --- channel building blocks -------------------------------------------------

/** Pulse/noise envelope unit: constant volume or 15->0 decay with loop. */
export class Envelope {
  start = false;
  /** doubles as the length counter halt flag on pulse/noise */
  loop = false;
  private constVol = false;
  private period = 0;
  private divider = 0;
  private decay = 0;

  writeReg0(v: number): void {
    this.period = v & 0x0f;
    this.constVol = (v & 0x10) !== 0;
    this.loop = (v & 0x20) !== 0;
  }

  quarter(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.period;
    } else if (this.divider === 0) {
      this.divider = this.period;
      if (this.decay > 0) this.decay--;
      else if (this.loop) this.decay = 15;
    } else {
      this.divider--;
    }
  }

  volume(): number {
    return this.constVol ? this.period : this.decay;
  }
}

class Pulse {
  enabled = false;
  length = 0;
  timerPeriod = 0;
  readonly env = new Envelope();
  /** pulse 1 sweeps with one's-complement negate, pulse 2 two's-complement */
  private readonly onesComplement: boolean;
  private duty = 0;
  private seqPos = 0;
  private timerCounter = 0;
  private sweepEnable = false;
  private sweepPeriod = 0;
  private sweepNegate = false;
  private sweepShift = 0;
  private sweepDivider = 0;
  private sweepReload = false;

  constructor(onesComplement: boolean) {
    this.onesComplement = onesComplement;
  }

  writeReg(r: number, v: number): void {
    switch (r) {
      case 0:
        this.duty = (v >> 6) & 3;
        this.env.writeReg0(v);
        break;
      case 1:
        this.sweepEnable = (v & 0x80) !== 0;
        this.sweepPeriod = (v >> 4) & 7;
        this.sweepNegate = (v & 0x08) !== 0;
        this.sweepShift = v & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | v;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((v & 7) << 8);
        if (this.enabled) this.length = NES_LENGTH_TABLE[v >> 3];
        this.seqPos = 0;
        this.env.start = true;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  private sweepTarget(): number {
    const change = this.timerPeriod >> this.sweepShift;
    if (!this.sweepNegate) return this.timerPeriod + change;
    return this.timerPeriod - change - (this.onesComplement ? 1 : 0);
  }

  /** Sweep-unit muting gates output continuously, even with sweep disabled. */
  private muted(): boolean {
    return this.timerPeriod < 8 || (!this.sweepNegate && this.sweepTarget() > 0x7ff);
  }

  half(): void {
    if (!this.env.loop && this.length > 0) this.length--;
    if (this.sweepDivider === 0 && this.sweepEnable && this.sweepShift > 0 && !this.muted()) {
      this.timerPeriod = Math.max(0, this.sweepTarget());
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }

  /** APU-rate (CPU/2) timer: call once per output sample. */
  stepTimer(): void {
    if (--this.timerCounter < 0) {
      this.timerCounter = this.timerPeriod;
      this.seqPos = (this.seqPos + 1) & 7;
    }
  }

  output(): number {
    if (this.length === 0 || this.muted()) return 0;
    return DUTY[this.duty][this.seqPos] ? this.env.volume() : 0;
  }
}

class Triangle {
  enabled = false;
  length = 0;
  private control = false; // $4008 bit 7: length halt + linear control
  private linearReload = 0;
  private linearCounter = 0;
  private reloadFlag = false;
  private timerPeriod = 0;
  private timerCounter = 0;
  private seqPos = 0;

  writeReg(r: number, v: number): void {
    switch (r) {
      case 0:
        this.control = (v & 0x80) !== 0;
        this.linearReload = v & 0x7f;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | v;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((v & 7) << 8);
        if (this.enabled) this.length = NES_LENGTH_TABLE[v >> 3];
        this.reloadFlag = true;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  quarter(): void {
    if (this.reloadFlag) this.linearCounter = this.linearReload;
    else if (this.linearCounter > 0) this.linearCounter--;
    if (!this.control) this.reloadFlag = false;
  }

  half(): void {
    if (!this.control && this.length > 0) this.length--;
  }

  /**
   * CPU-rate timer: call TWICE per output sample. Gating (length/linear)
   * freezes the sequencer at its current step — the hardware holds the DAC
   * level rather than snapping to 0. Ultrasonic periods (<2) also hold, like
   * MAME's freq<2 halt, instead of aliasing across the whole band.
   */
  stepTimer(): void {
    if (this.length === 0 || this.linearCounter === 0 || this.timerPeriod < 2) return;
    if (--this.timerCounter < 0) {
      this.timerCounter = this.timerPeriod;
      this.seqPos = (this.seqPos + 1) & 31;
    }
  }

  output(): number {
    return this.seqPos < 16 ? 15 - this.seqPos : this.seqPos - 16;
  }
}

export class Noise {
  enabled = false;
  length = 0;
  readonly env = new Envelope();
  private mode = false;
  private period = NES_NOISE_PERIODS[0] / 2; // APU cycles per LFSR shift
  private counter = NES_NOISE_PERIODS[0] / 2;
  private lfsr = 1;

  writeReg(r: number, v: number): void {
    switch (r) {
      case 0:
        this.env.writeReg0(v);
        break;
      case 2:
        this.mode = (v & 0x80) !== 0;
        this.period = NES_NOISE_PERIODS[v & 0x0f] / 2; // all entries are even
        break;
      case 3:
        if (this.enabled) this.length = NES_LENGTH_TABLE[v >> 3];
        this.env.start = true;
        break;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  half(): void {
    if (!this.env.loop && this.length > 0) this.length--;
  }

  /** APU-rate timer: call once per output sample. */
  stepTimer(): void {
    if (--this.counter <= 0) {
      this.counter += this.period;
      const fb = (this.lfsr ^ (this.lfsr >> (this.mode ? 6 : 1))) & 1;
      this.lfsr = (this.lfsr >> 1) | (fb << 14);
    }
  }

  output(): number {
    if (this.length === 0 || (this.lfsr & 1)) return 0;
    return this.env.volume();
  }
}

class Dmc {
  irqEnable = false;
  loop = false;
  rate = NES_DMC_RATES[0]; // CPU cycles per output bit
  /** 7-bit delta counter — the channel's DAC level (mix index) */
  level = 0;
  addrReg = 0;
  lenReg = 0;
  /** start-time snapshot of the sample byte length (loops replay it) */
  startLen = 0;
  bytesRemaining = 0;
  irq = false;
  /** CPU cycles stolen by fetches since last consumeDmcStalls() (~4/byte) */
  stalls = 0;
  /** sample bytes pushed via data(0, ...) — worklet side; shadow decodes 0s */
  buf: Uint8Array | null = null;
  private pos = 0;
  private counter = NES_DMC_RATES[0];
  private bufferByte = 0;
  private bufferFilled = false;
  private shift = 0;
  private bitsLeft = 8;
  private silence = true;

  writeReg(r: number, v: number): void {
    switch (r) {
      case 0:
        this.irqEnable = (v & 0x80) !== 0;
        this.loop = (v & 0x40) !== 0;
        this.rate = NES_DMC_RATES[v & 0x0f];
        if (!this.irqEnable) this.irq = false;
        break;
      case 1:
        this.level = v & 0x7f; // direct DAC load
        break;
      case 2:
        this.addrReg = v; // sample address = $C000 + v*64
        break;
      case 3:
        this.lenReg = v; // sample length = v*16 + 1
        break;
    }
  }

  /**
   * $4015 bit-4 set while idle: (re)start playback from the snapshot. The
   * sample buffer is left EMPTY so the memory reader's first fetch (and any
   * completion IRQ for a tiny sample) happens on the next step(), NOT inside
   * the $4015 write that also clears the DMC IRQ flag.
   */
  start(): void {
    this.startLen = this.lenReg * 16 + 1;
    this.bytesRemaining = this.startLen;
    this.pos = 0;
    this.bufferFilled = false;
  }

  /** Advance output unit + memory reader by CPU cycles (render + tick). */
  step(cpuCycles: number): void {
    this.counter -= cpuCycles;
    while (this.counter <= 0) {
      this.counter += this.rate;
      this.fillBuffer();
      this.clockOutput();
    }
  }

  /**
   * Memory reader: keep the 1-byte sample buffer topped up. The worklet reads
   * the pushed buffer; the shadow has none and decodes zeros — timing, $4015
   * status, stalls and IRQs are identical either way, which is all the shadow
   * answers for. Fires the completion IRQ / loop restart when the last byte
   * is fetched (bytesRemaining -> 0), matching nes_apu.cpp's apu_dpcmreset.
   */
  private fillBuffer(): void {
    if (this.bufferFilled || this.bytesRemaining === 0) return;
    this.bufferByte = this.buf && this.pos < this.buf.length ? this.buf[this.pos] : 0;
    this.pos++;
    this.bufferFilled = true;
    this.bytesRemaining--;
    this.stalls += 4;
    if (this.bytesRemaining === 0) {
      if (this.loop) {
        this.bytesRemaining = this.startLen;
        this.pos = 0;
      } else if (this.irqEnable) {
        this.irq = true;
      }
    }
  }

  private clockOutput(): void {
    if (!this.silence) {
      if (this.shift & 1) {
        if (this.level <= 125) this.level += 2;
      } else if (this.level >= 2) {
        this.level -= 2;
      }
      this.shift >>= 1;
    }
    if (--this.bitsLeft <= 0) {
      this.bitsLeft = 8;
      if (this.bufferFilled) {
        this.shift = this.bufferByte;
        this.bufferFilled = false;
        this.silence = false;
      } else {
        this.silence = true;
      }
    }
  }
}

// --- the APU -----------------------------------------------------------------

export interface NesApuOpts {
  /**
   * Shadow instance only: called when DMC sample playback starts or restarts
   * via a $4015 bit-4 write, with the CPU-space address ($C000 + A*64) and
   * byte length (L*16 + 1) so the board can snapshot and push the bytes.
   * Loop restarts do NOT refire (same buffer keeps playing).
   */
  onDmcStart?: (addr: number, len: number) => void;
}

export class NesApu implements SoundCore {
  /** clock/2 — one output sample per APU cycle (~894886 Hz NTSC) */
  readonly sampleRate: number;
  private readonly onDmcStart: ((addr: number, len: number) => void) | undefined;
  private readonly dcK: number;

  private pulse1 = new Pulse(true);
  private pulse2 = new Pulse(false);
  private tri = new Triangle();
  private noise = new Noise();
  private dmc = new Dmc();

  private frameMode5 = false;
  private frameInhibit = false; // power-up: $4017 = 0, frame IRQ enabled
  private frameIrq = false;
  private frameCycle = 0; // CPU cycles into the current sequence
  private frameIdx = 0;

  private dc = 0;

  constructor(clock: number, opts?: NesApuOpts) {
    this.sampleRate = clock / 2;
    this.onDmcStart = opts?.onDmcStart;
    this.dcK = 1 - Math.exp((-2 * Math.PI * DC_CUTOFF_HZ) / this.sampleRate);
  }

  /** offset = register - $4000 (0x00-0x17; 0x14/$4014 never arrives here). */
  write(offset: number, data: number): void {
    data &= 0xff;
    if (offset >= 0x00 && offset <= 0x03) this.pulse1.writeReg(offset, data);
    else if (offset <= 0x07) this.pulse2.writeReg(offset & 3, data);
    else if (offset <= 0x0b) this.tri.writeReg(offset & 3, data);
    else if (offset <= 0x0f) this.noise.writeReg(offset & 3, data);
    else if (offset <= 0x13) this.dmc.writeReg(offset & 3, data);
    else if (offset === 0x15) this.writeStatus(data);
    else if (offset === 0x17) this.writeFrame(data);
    // 0x16 is the joypad strobe, 0x09/0x0d are unimplemented registers
  }

  /** Worklet side: receive a pushed DMC sample buffer (id 0 = current). */
  data(id: number, bytes: Uint8Array): void {
    if (id === 0) this.dmc.buf = bytes;
  }

  /** Worklet side: render mono samples; advances the frame counter too. */
  render(out: Float32Array): void {
    const p1 = this.pulse1;
    const p2 = this.pulse2;
    const tri = this.tri;
    const noi = this.noise;
    const dmc = this.dmc;
    for (let i = 0; i < out.length; i++) {
      this.advanceFrame(2); // one sample = one APU cycle = 2 CPU cycles
      dmc.step(2);
      p1.stepTimer();
      p2.stepTimer();
      tri.stepTimer(); // triangle timer runs at CPU rate: twice per sample
      tri.stepTimer();
      noi.stepTimer();
      const x =
        NES_PULSE_MIX[p1.output() + p2.output()] +
        NES_TND_MIX[3 * tri.output() + 2 * noi.output() + dmc.level];
      this.dc += (x - this.dc) * this.dcK;
      out[i] = (x - this.dc) * OUT_GAIN;
    }
  }

  /** Shadow side: advance frame counter + DMC bookkeeping, no rendering. */
  tick(cpuCycles: number): void {
    this.advanceFrame(cpuCycles);
    this.dmc.step(cpuCycles);
  }

  /**
   * $4015 status: length>0 bits 0-3, DMC bytes-remaining bit 4, frame IRQ
   * bit 6 (reading clears it), DMC IRQ bit 7 (NOT cleared by reads).
   */
  read4015(): number {
    let v = 0;
    if (this.pulse1.length > 0) v |= 0x01;
    if (this.pulse2.length > 0) v |= 0x02;
    if (this.tri.length > 0) v |= 0x04;
    if (this.noise.length > 0) v |= 0x08;
    if (this.dmc.bytesRemaining > 0) v |= 0x10;
    if (this.frameIrq) v |= 0x40;
    if (this.dmc.irq) v |= 0x80;
    this.frameIrq = false;
    return v;
  }

  irqAsserted(): boolean {
    return this.frameIrq || this.dmc.irq;
  }

  /** Shadow side: CPU cycles stolen by DMC fetches since the last call. */
  consumeDmcStalls(): number {
    const n = this.dmc.stalls;
    this.dmc.stalls = 0;
    return n;
  }

  /** Current 7-bit DMC delta counter (exposed for tests/telemetry). */
  get dmcLevel(): number {
    return this.dmc.level;
  }

  reset(): void {
    this.pulse1 = new Pulse(true);
    this.pulse2 = new Pulse(false);
    this.tri = new Triangle();
    this.noise = new Noise();
    this.dmc = new Dmc();
    this.frameMode5 = false;
    this.frameInhibit = false;
    this.frameIrq = false;
    this.frameCycle = 0;
    this.frameIdx = 0;
    this.dc = 0;
  }

  // --- register side effects --------------------------------------------------

  private writeStatus(v: number): void {
    this.pulse1.setEnabled((v & 0x01) !== 0);
    this.pulse2.setEnabled((v & 0x02) !== 0);
    this.tri.setEnabled((v & 0x04) !== 0);
    this.noise.setEnabled((v & 0x08) !== 0);
    if (v & 0x10) {
      if (this.dmc.bytesRemaining === 0) {
        this.dmc.start();
        this.onDmcStart?.(0xc000 + this.dmc.addrReg * 64, this.dmc.startLen);
      }
      // already playing: keep going with the current sample
    } else {
      this.dmc.bytesRemaining = 0; // silences once the buffered byte drains
    }
    this.dmc.irq = false;
  }

  private writeFrame(v: number): void {
    this.frameMode5 = (v & 0x80) !== 0;
    this.frameInhibit = (v & 0x40) !== 0;
    if (this.frameInhibit) this.frameIrq = false;
    this.frameCycle = 0;
    this.frameIdx = 0;
    // 5-step mode clocks quarter + half immediately on write
    if (this.frameMode5) {
      this.quarter();
      this.half();
    }
  }

  // --- frame sequencer ---------------------------------------------------------

  private advanceFrame(cpuCycles: number): void {
    this.frameCycle += cpuCycles;
    const events = this.frameMode5 ? FRAME_5 : FRAME_4;
    const len = this.frameMode5 ? FRAME_5_LEN : FRAME_4_LEN;
    for (;;) {
      if (this.frameIdx < events.length) {
        const ev = events[this.frameIdx];
        if (this.frameCycle < ev.at) break;
        this.frameIdx++;
        if (ev.q) this.quarter();
        if (ev.h) this.half();
        if (ev.irq && !this.frameInhibit) this.frameIrq = true;
      } else if (this.frameCycle >= len) {
        this.frameCycle -= len;
        this.frameIdx = 0;
      } else {
        break;
      }
    }
  }

  /** Quarter-frame clock: envelopes + triangle linear counter. */
  private quarter(): void {
    this.pulse1.env.quarter();
    this.pulse2.env.quarter();
    this.tri.quarter();
    this.noise.env.quarter();
  }

  /** Half-frame clock: length counters + sweep units. */
  private half(): void {
    this.pulse1.half();
    this.pulse2.half();
    this.tri.half();
    this.noise.half();
  }
}
