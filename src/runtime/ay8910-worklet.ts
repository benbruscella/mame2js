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
}
type Ay8910Message = InitMessage | WriteMessage;

/** Native samples rendered per refill of the internal buffer. */
const CHUNK = 256;

/** DAC route gain — MAME junofrst routes the R2R ladder at 0.25. */
const DAC_GAIN = 0.25;

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

  // --- percussion DAC (i8039 P1) -------------------------------------------
  // Samples arrive in bursts (the MCU is emulated a frame at a time), so a
  // plain zero-order hold collapses each frame's drum waveform to its last
  // byte. Instead: FIFO the bytes and drain them evenly across the output
  // block, then remove the standing DC offset (the P1 line idles nonzero —
  // mixing it raw thumps the speaker) with a slow one-pole tracker.
  private dacQueue: number[] = [];
  private dacLevel: number = 0;
  private dacNext: number = 0;
  private dacDc: number = 0;
  /** samples-per-output-sample drain rate, latched per burst (constant
   *  within a burst — recomputing per block decays exponentially and
   *  pitch-bends every drum hit downward) */
  private dacRate: number = 0;
  private dacPrevLen: number = 0;

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
          if (msg.offset === 0x80) {
            // percussion DAC (i8039 P1): unsigned byte -> centered level
            this.dacQueue.push(((msg.data & 0xff) - 128) / 128);
            if (this.dacQueue.length > 4096) this.dacQueue.splice(0, this.dacQueue.length - 4096);
            break;
          }
          if (msg.offset >= 0x90 && msg.offset < 0x90 + this.chips.length) {
            // RC filter select: raw AY port-B byte for chip (offset - 0x90)
            this.setFilter(msg.offset - 0x90, msg.data);
            break;
          }
          const chip = this.chips[msg.offset >> 4];
          if (chip) chip.writeReg(msg.offset & 0x0f, msg.data);
          break;
        }
      }
    };
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
    const gain = (1 / 3) / this.chips.length;
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
      // drain the queued DAC bytes at a rate tracking the MCU's actual
      // long-term sample rate (EMA of arrivals): per-burst rates warble the
      // speech because per-frame arrival counts swing 1..178 even though the
      // hardware rate is steady (~3.4 kHz measured on junofrst). The queue
      // absorbs the jitter; a mild pressure term keeps latency bounded.
      const arrived = this.dacQueue.length - this.dacPrevLen;
      if (arrived > 0) {
        const instRate = arrived / Math.max(out.length, sampleRate / 60);
        this.dacRate = this.dacRate ? this.dacRate * 0.9 + instRate * 0.1 : instRate;
      }
      const pressure = this.dacQueue.length / (sampleRate / 10); // >0.1 s queued -> speed up
      const dacPerSample = this.dacQueue.length ? this.dacRate * (1 + pressure) : 0;
      let dacPos = 0;
      for (let i = 0; i < out.length; i++) {
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
        dacPos += dacPerSample;
        while (dacPos >= 1 && this.dacQueue.length) {
          this.dacLevel = this.dacNext;
          this.dacNext = this.dacQueue.shift()!;
          dacPos -= 1;
        }
        // linear interpolation between DAC samples: hard zero-order hold of
        // a ~3.4 kHz stream at 48 kHz sprays metallic imaging ("scissor"
        // speech); when the queue idles, glide to rest instead of stepping
        let dacOut: number;
        if (dacPerSample > 0) {
          dacOut = this.dacLevel + (this.dacNext - this.dacLevel) * Math.min(1, dacPos);
        } else {
          this.dacLevel += (this.dacDc - this.dacLevel) * 0.005; // declick release
          this.dacNext = this.dacLevel;
          dacOut = this.dacLevel;
        }
        this.dacDc += (dacOut - this.dacDc) * 0.0008; // DC blocker
        out[i] = this.boxAvg + (dacOut - this.dacDc) * DAC_GAIN;
      }
      this.dacPrevLen = this.dacQueue.length;
    }

    // duplicate mono into any additional output channels
    for (let c = 1; c < channels.length; c++) channels[c].set(out);
    return true;
  }
}

registerProcessor('ay8910', Ay8910Processor);
