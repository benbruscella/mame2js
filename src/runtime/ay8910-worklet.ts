// AudioWorklet module hosting a BANK of AY-3-8910 PSGs off the main thread
// (gyruss drives five). Compiled output (dist/runtime/ay8910-worklet.js) is
// loaded via audioContext.audioWorklet.addModule(url); worklet module
// scopes support ES imports, so ay8910.js is fetched relative to this
// module's URL.
//
// Protocol (port.onmessage):
//   { type: 'init',  clock: number, chips?: number, waveRom?, voices? }
//     (waveRom/voices are part of the shared shell contract; the AY has no
//      wavetable ROM and ignores them; chips defaults to 1)
//   { type: 'write', offset: number, data: number }
//     offset = chip*16 + register (0x00-0x4f for five chips); the register
//     within the chip is offset & 0x0f, the chip index is offset >> 4.
//     offset 0x80 = percussion DAC sample byte (unsigned 8-bit, zero-order
//     hold) — the i8039 MCU on junofrst/gyruss boards writes its P1 DAC
//     here; mixed at DAC_GAIN alongside the PSG bank.
//     offset 0x90 + chip = RC filter select for that chip: the raw AY
//     port-B byte, decoded exactly as junofrst_state::portB_w (two bits
//     per channel; bit0 -> 47000 pF, bit1 -> 220000 pF; LOWPASS_3R with
//     R1=1000 R2=2200 R3=200). C = 0 -> bypass. The one-pole runs per
//     channel at the native AY rate, before the box-filter decimation.
//
// All chips render at the shared native rate (clock / 8, ~223.7 kHz for
// the 14.31818 MHz / 8 gyruss clock): each chip's three channels render
// separately, pass through their switchable RC low-pass, are summed at
// 1/3 per chip and 1/chips across the bank so a full blast bank stays
// within [-1, 1], and the sum is resampled here to the AudioContext rate
// (the worklet-global `sampleRate`).

import {
  AY8910,
  konamiFilterCaps,
  lowpass3RCoeff,
  rcLowPass,
  KONAMI_FILTER_R1,
  KONAMI_FILTER_R2,
  KONAMI_FILTER_R3,
} from './ay8910.ts';

// --- AudioWorklet global scope declarations -------------------------------
// These globals exist only inside AudioWorkletGlobalScope and are not part
// of the DOM lib; declare them locally instead of adding lib files.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;
// ---------------------------------------------------------------------------

interface InitMessage {
  type: 'init';
  clock: number;
  chips?: number;
  waveRom?: Uint8Array;
  voices?: number;
}
interface WriteMessage {
  type: 'write';
  offset: number;
  data: number;
  /** position of the write within its video frame (0..1, scanline/vtotal) */
  frac?: number;
}
type Ay8910Message = InitMessage | WriteMessage;

/** Native samples rendered per refill of the internal buffer. */
const CHUNK = 256;

/** DAC route gain — MAME junofrst routes the R2R ladder at 0.25. */
const DAC_GAIN = 0.25;

/**
 * AY bank gain, matched to real MAME output level (junofrst, MAME 0.288
 * wavwrite, pure-AY attract-music window: ours was a uniform +9.4 dB across
 * every octave band). Two factors: our channels swing bipolar ±vol (2× the
 * hardware's unipolar swing — ay8910.cpp build_single_table maps a channel
 * to (norm - 0.25) * 0.5, swing 0.5), and MAME routes each channel at 0.30
 * (junofrst.cpp add_route). Without this the DAC (drums/speech, routed at
 * a MAME-exact 0.25) sits ~9 dB too low relative to the PSGs and the mix
 * turns bass-heavy with buried percussion.
 */
const AY_BANK_GAIN = 0.34;

class Ay8910Processor extends AudioWorkletProcessor {
  private chips: AY8910[] = [];
  /** native samples advanced per output sample (e.g. 223721.5 / 48000). */
  private step: number = 1;

  // Linear-interpolation resampler state: output sits `frac` (0..1) of the
  // way between native samples s0 and s1.
  private frac: number = 0;
  private s0: number = 0;
  private s1: number = 0;
  private boxAvg: number = 0;

  // Internal native-rate render buffers (bank sum + per-channel scratch).
  private nativeBuf: Float32Array = new Float32Array(CHUNK);
  private scratchA: Float32Array = new Float32Array(CHUNK);
  private scratchB: Float32Array = new Float32Array(CHUNK);
  private scratchC: Float32Array = new Float32Array(CHUNK);
  private nativePos: number = CHUNK; // next unread index; == length => refill

  // --- Konami switchable RC low-pass (offset 0x90 + chip) -------------------
  // One one-pole per chip channel: filterK[chip*3 + ch] (1 = bypass) and its
  // running memory. Coefficients follow MAME flt_rc LOWPASS_3R with the
  // junofrst network R1=1000 R2=2200 R3=200 at the native AY rate.
  private filterK: number[] = [];
  private filterMem: number[] = [];

  // --- timestamped write scheduler -------------------------------------------
  // Boards emulate a whole video frame in one burst, so every register write
  // of a frame arrives at the worklet within a millisecond. Applying them on
  // arrival quantizes fast SFX sweeps into stair-steps ("chirpy" Konami
  // whooshes) and collapses DAC sample streams. Each write instead carries
  // its in-frame position (frac = scanline/vtotal) and is applied at the
  // matching output sample, one frame period behind arrival.
  private sched: { at: number; offset: number; data: number }[] = [];
  private clock2 = 0;          // output samples elapsed (scheduler timeline)
  private frameBase = 0;       // scheduler epoch of the frame being received
  private lastFrac = 2;        // detects frame wrap (frac decreasing)

  // --- percussion DAC (i8039 P1 / MSM5205) ----------------------------------
  // DAC bytes are scheduled like every other write; linear interpolation
  // between consecutive samples kills zero-order-hold imaging, and a slow
  // one-pole removes the standing DC so the idle line doesn't thump.
  private dacLevel: number = 0;
  private dacNext: number = 0;
  private dacFrom = 0;         // scheduler time of dacLevel
  private dacUntil = 0;        // scheduler time of dacNext
  private dacDc: number = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as Ay8910Message;
      switch (msg.type) {
        case 'init': {
          const count = msg.chips && msg.chips > 0 ? msg.chips : 1;
          this.chips = [];
          for (let i = 0; i < count; i++) this.chips.push(new AY8910(msg.clock));
          this.step = this.chips[0].sampleRate / sampleRate;
          this.frac = 0;
          this.s0 = 0;
          this.s1 = 0;
          this.nativePos = this.nativeBuf.length;
          this.filterK = new Array(count * 3).fill(1);
          this.filterMem = new Array(count * 3).fill(0);
          break;
        }
        case 'write': {
          const framePeriod = sampleRate / 60;
          if (msg.frac === undefined) {
            // untimed write: apply immediately (back-compat)
            this.apply(msg.offset, msg.data);
            break;
          }
          if (msg.frac < this.lastFrac) {
            // new emulation frame began: its writes play over the NEXT
            // frame period of output (one frame of latency buys accuracy)
            this.frameBase = Math.max(this.clock2, this.frameBase + framePeriod);
          }
          this.lastFrac = msg.frac;
          this.sched.push({ at: this.frameBase + msg.frac * framePeriod, offset: msg.offset, data: msg.data });
          if (this.sched.length > 65536) this.sched.splice(0, this.sched.length - 65536);
          break;
        }
      }
    };
  }

  /** Apply one register/DAC/filter write NOW (scheduler-dispatched). */
  private apply(offset: number, data: number): void {
    if (offset === 0x80) {
      // DAC sample: becomes the interpolation target until the next one.
      // Ramp over HALF the stream's own inter-write gap: a FIXED ramp longer
      // than the gap never completes and eats 8-18 dB off fast streams
      // (junofrst speech/drums arrive every ~0.2-0.3 ms), while a full-gap
      // ramp triangle-izes square drum streams (-4 dB fundamental vs the
      // hardware ZOH). Half-gap slews the edges just enough to kill imaging
      // and lands within ~2 dB of real-MAME drum band levels. Cap keeps
      // sparse writes (idle blips) from gliding audibly.
      const gap = Math.max(1, Math.min((this.clock2 - this.dacFrom) * 0.5, sampleRate / 2000));
      this.dacLevel = this.dacInterp(this.clock2);
      this.dacFrom = this.clock2;
      this.dacNext = ((data & 0xff) - 128) / 128;
      this.dacUntil = this.clock2 + gap;
      return;
    }
    if (offset >= 0x90 && offset < 0x90 + this.chips.length) {
      this.setFilter(offset - 0x90, data);
      return;
    }
    const chip = this.chips[offset >> 4];
    if (chip) chip.writeReg(offset & 0x0f, data);
  }

  /** DAC level at scheduler time t: linear ramp dacLevel -> dacNext. */
  private dacInterp(t: number): number {
    if (t >= this.dacUntil) return this.dacNext;
    const span = this.dacUntil - this.dacFrom;
    return span <= 0 ? this.dacNext
      : this.dacLevel + (this.dacNext - this.dacLevel) * ((t - this.dacFrom) / span);
  }

  /** Program chip's three one-poles from the raw port-B select byte. */
  private setFilter(chipIndex: number, data: number): void {
    const caps = konamiFilterCaps(data);
    const nativeRate = this.chips[chipIndex].sampleRate;
    for (let ch = 0; ch < 3; ch++) {
      const k = lowpass3RCoeff(
        KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, caps[ch], nativeRate);
      const idx = chipIndex * 3 + ch;
      this.filterK[idx] = k;
      if (k === 1) this.filterMem[idx] = 0; // flt_rc recalc: disabled clears memory
    }
  }

  /**
   * Render one CHUNK of the bank into nativeBuf: per chip, the three
   * channels render separately, each passes its RC low-pass (k = 1 =>
   * bypass, bit-transparent), then sum at 1/3 (chip mix) * 1/chips (bank).
   */
  private renderBankFiltered(): void {
    const out = this.nativeBuf;
    out.fill(0);
    const gain = (AY_BANK_GAIN / 3) / this.chips.length;
    for (let c = 0; c < this.chips.length; c++) {
      this.chips[c].renderChannels(this.scratchA, this.scratchB, this.scratchC);
      const bufs = [this.scratchA, this.scratchB, this.scratchC];
      for (let ch = 0; ch < 3; ch++) {
        const idx = c * 3 + ch;
        const k = this.filterK[idx];
        if (k < 1) this.filterMem[idx] = rcLowPass(bufs[ch], k, this.filterMem[idx]);
      }
      for (let i = 0; i < out.length; i++) {
        out[i] += (this.scratchA[i] + this.scratchB[i] + this.scratchC[i]) * gain;
      }
    }
  }

  private nextNativeSample(): number {
    if (this.nativePos >= this.nativeBuf.length) {
      // chips is non-empty whenever this is reached (checked in process())
      this.renderBankFiltered();
      this.nativePos = 0;
    }
    return this.nativeBuf[this.nativePos++];
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const out = channels[0];

    if (this.chips.length === 0) {
      out.fill(0);
    } else {
      // keep the scheduler from starving or ballooning: if the backlog is
      // over two frame periods, fast-forward (applies late writes at once)
      const lag = this.sched.length && (this.sched[this.sched.length - 1].at - this.clock2);
      if (lag && lag > (sampleRate / 60) * 3) {
        const jump = lag - (sampleRate / 60) * 2;
        for (const w of this.sched) w.at -= jump;
      }
      for (let i = 0; i < out.length; i++) {
        // dispatch every write scheduled at or before this output sample
        while (this.sched.length && this.sched[0].at <= this.clock2) {
          const w = this.sched.shift()!;
          this.apply(w.offset, w.data);
        }
        // box-filter decimation: average every native sample this output
        // sample spans. Point-sampling a ~224 kHz square-wave stream down to
        // 48 kHz aliases badly (chirpy high-pitched SFX); the box average is
        // a cheap anti-alias low-pass.
        this.frac += this.step;
        let acc = 0;
        let n = 0;
        while (this.frac >= 1) {
          this.frac -= 1;
          this.s0 = this.s1;
          this.s1 = this.nextNativeSample();
          acc += this.s1;
          n++;
        }
        if (n > 0) this.boxAvg = acc / n;
        const dacOut = this.dacInterp(this.clock2);
        this.dacDc += (dacOut - this.dacDc) * 0.0008; // DC blocker
        out[i] = this.boxAvg + (dacOut - this.dacDc) * DAC_GAIN;
        this.clock2++;
      }
    }

    // duplicate mono into any additional output channels
    for (let c = 1; c < channels.length; c++) channels[c].set(out);
    return true;
  }
}

registerProcessor('ay8910', Ay8910Processor);
