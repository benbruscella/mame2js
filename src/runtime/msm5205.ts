// OKI MSM5205 ADPCM speech decoder for mamekit (Irem M52/M62 sound boards).
//
// Ported from MAME src/devices/sound/msm5205.cpp (Dialogic/OKI ADPCM):
// the 49-step x 16-nibble difference table is computed exactly like MAME's
// compute_tables() (stepval = floor(16 * 1.1^step), nibble bits weighted
// stepval, /2, /4 plus the constant /8 term, sign from bit 3), the step
// index moves by index_shift[nibble & 7] = {-1,-1,-1,-1,2,4,6,8} clamped to
// 0..48, and the 12-bit signal is clamped to -2048..2047 then masked to the
// chip's 10-bit DAC (low 2 bits dropped) and scaled by 1/4096.
//
// Clocking (matches MAME's prescaler selectors):
//   sel 0 S96_3B  /96 (4 kHz @ 384 kHz), 3-bit data
//   sel 1 S48_3B  /48 (8 kHz)            sel 5 S48_4B
//   sel 2 S64_3B  /64 (6 kHz)            sel 6 S64_4B
//   sel 3 SEX_3B  VCK slave mode         sel 7 SEX_4B
//   sel 4 S96_4B  /96, 4-bit (Irem default; AY 45M port B bits 2-4 select)
// VCK toggles every prescaler/2 master clocks. `vckCallback` fires on both
// edges with the new VCK state -- the Irem board wires this straight to the
// 6803 NMI line (through an inverter on the real PCB; MAME passes the raw
// VCK state, so NMI on the rising edge of the reported value) and the M62
// board also chains it to the slave chip's vclkW.
//
// A nibble is captured and decoded at each VCK falling edge. MAME defers the
// capture 6 master clocks past the edge (the 15.6 us data-setup window); we
// fold that into the edge itself, which preserves ordering: the nibble the
// CPU wrote in response to the PREVIOUS rising-edge NMI is the one decoded.
// While the reset pin is held, each capture forces signal=0, step=0 (VCK and
// the NMIs keep running -- the Irem sound program depends on that).
//
// Two clocking modes (mutually exclusive per instance):
//  - CPU-time: the board calls tick(masterClocks) from its frame loop; VCK
//    edges fire vckCallback and each falling edge decodes the current data
//    latch (exact MAME semantics). render() then just holds the current
//    level (useful when a separate worklet-side instance produces audio).
//  - render-time: if tick() is never used, render() self-clocks at one
//    master clock per output sample (sampleRate == clock) and consumes
//    nibbles from a FIFO queued by dataW()/write(), so bursty message-driven
//    writes play back at the exact ADPCM rate; on underrun the signal holds
//    (deviation from hardware, which would re-decode the stale nibble).
//
// SoundCore-compatible: sampleRate/render/write. write() register shim:
//   offset 0 = dataW, 1 = resetW, 2 = setPrescaler (playmode), 3 = vclkW.

import type { SoundCore } from './types.ts';

// step size index shift table (MAME index_shift)
const INDEX_SHIFT: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8];

const PRESCALER_BY_SEL: readonly number[] = [96, 48, 64, 0, 96, 48, 64, 0];

export class MSM5205 implements SoundCore {
  readonly clock: number;
  readonly sampleRate: number; // stream runs at master-clock rate, like MAME
  /** Fires with the new VCK state (1=rise, 0=fall) from tick(). */
  vckCallback: ((state: number) => void) | null = null;

  private diff = new Int16Array(49 * 16); // diff_lookup
  private signalV = 0; // -2048..2047
  private stepV = 0; // 0..48
  private data = 0; // latched nibble (already width-masked)
  private resetPin = false;
  private vck = 0;
  private prescaler = 96;
  private bitwidth = 4;
  private phase = 0; // master clocks since last VCK toggle
  // render-mode nibble FIFO
  private fifo: number[] = [];
  private fifoHead = 0;
  private externallyClocked = false;

  constructor(clock: number) {
    this.clock = clock;
    this.sampleRate = clock;
    // compute the difference table exactly as MAME's compute_tables()
    for (let step = 0; step <= 48; step++) {
      const stepval = Math.floor(16 * Math.pow(11 / 10, step));
      for (let nib = 0; nib < 16; nib++) {
        const sign = (nib & 8) !== 0 ? -1 : 1;
        this.diff[step * 16 + nib] =
          sign *
          (stepval * ((nib >> 2) & 1) +
            (stepval >> 1) * ((nib >> 1) & 1) +
            (stepval >> 2) * (nib & 1) +
            (stepval >> 3));
      }
    }
  }

  /** Current 12-bit decoder output (spec/debug hook). */
  get signal(): number {
    return this.signalV;
  }

  /** Current step index 0..48 (spec/debug hook). */
  get step(): number {
    return this.stepV;
  }

  /** Prescaler/bit-width selector 0-7 (MAME playmode_w / S96_4B etc.). */
  setPrescaler(sel: number): void {
    const p = PRESCALER_BY_SEL[sel & 7];
    if (p !== this.prescaler) {
      this.prescaler = p;
      this.phase = 0; // MAME restarts the VCK timer on a rate change
    }
    this.bitwidth = (sel & 4) !== 0 ? 4 : 3;
  }

  /** Latch the next ADPCM nibble (3-bit data shifts left one, per MAME data_w). */
  dataW(data: number): void {
    const v = this.bitwidth === 4 ? data & 0x0f : (data & 0x07) << 1;
    this.data = v;
    if (!this.externallyClocked) this.fifoPush(v);
  }

  /** Reset pin (1 = held in reset: decoder output forced to 0, VCK keeps running). */
  resetW(state: number | boolean): void {
    this.resetPin = state !== 0 && state !== false;
  }

  /** External VCK input for slave mode (prescaler selector 3/7 only, per MAME). */
  vclkW(state: number | boolean): void {
    if (this.prescaler !== 0) return; // master mode: pin ignored (MAME logs an error)
    const s = state !== 0 && state !== false ? 1 : 0;
    if (this.vck === 1 && s === 0) {
      this.externallyClocked = true;
      this.decode(this.data);
    }
    this.vck = s;
  }

  /** Advance the master clock in CPU time; fires vckCallback and decodes on
   *  VCK falling edges. Switches the instance to CPU-time clocking. */
  tick(masterClocks: number): void {
    if (!this.externallyClocked) {
      this.externallyClocked = true;
      this.fifo.length = 0;
      this.fifoHead = 0;
    }
    if (this.prescaler === 0) return; // slave mode: clocked via vclkW
    const half = this.prescaler >> 1;
    this.phase += masterClocks;
    while (this.phase >= half) {
      this.phase -= half;
      this.vck ^= 1;
      if (this.vck === 0) this.decode(this.data); // capture before the CPU can react
      if (this.vckCallback !== null) this.vckCallback(this.vck);
    }
  }

  /** SoundCore register shim: 0=data, 1=reset, 2=playmode/prescaler, 3=vclk. */
  write(offset: number, data: number): void {
    switch (offset & 3) {
      case 0: this.dataW(data); return;
      case 1: this.resetW(data); return;
      case 2: this.setPrescaler(data); return;
      default: this.vclkW(data); return;
    }
  }

  /** Fill `out` with mono samples in [-1, 1] at sampleRate (== master clock).
   *  Self-clocks from the nibble FIFO unless tick()/vclkW drive the chip. */
  render(out: Float32Array): void {
    if (this.externallyClocked || this.prescaler === 0) {
      // zero-order hold of the externally-clocked decoder level
      const v = this.level();
      out.fill(v);
      return;
    }
    const half = this.prescaler >> 1;
    let v = this.level();
    for (let i = 0; i < out.length; i++) {
      if (++this.phase >= half) {
        this.phase -= half;
        this.vck ^= 1;
        if (this.vck === 0) {
          const nib = this.fifoPop();
          if (nib >= 0) {
            this.data = nib;
            this.decode(nib);
          } else if (this.resetPin) {
            this.decode(this.data); // reset zeroing needs no fresh data
          }
          // else: FIFO underrun -> hold (see header)
          v = this.level();
        }
      }
      out[i] = v;
    }
  }

  // ------------------------------------------------------------ internals

  /** MAME update_adpcm: decode one nibble (or zero everything while in reset). */
  private decode(nibble: number): void {
    if (this.resetPin) {
      this.signalV = 0;
      this.stepV = 0;
      return;
    }
    let s = this.signalV + this.diff[this.stepV * 16 + (nibble & 15)];
    if (s > 2047) s = 2047;
    else if (s < -2048) s = -2048;
    this.signalV = s;
    let st = this.stepV + INDEX_SHIFT[nibble & 7];
    if (st > 48) st = 48;
    else if (st < 0) st = 0;
    this.stepV = st;
  }

  /** Output level: 12-bit signal through the 10-bit DAC (low 2 bits masked). */
  private level(): number {
    return (this.signalV & ~3) / 4096;
  }

  private fifoPush(v: number): void {
    if (this.fifo.length - this.fifoHead >= 4096) return; // safety cap
    this.fifo.push(v);
  }

  private fifoPop(): number {
    if (this.fifoHead >= this.fifo.length) return -1;
    const v = this.fifo[this.fifoHead++];
    if (this.fifoHead >= 512 && this.fifoHead * 2 >= this.fifo.length) {
      this.fifo = this.fifo.slice(this.fifoHead);
      this.fifoHead = 0;
    }
    return v;
  }
}
