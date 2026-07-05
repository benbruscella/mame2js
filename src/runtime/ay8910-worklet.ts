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
//
// All chips render at the shared native rate (clock / 8, ~223.7 kHz for
// the 14.31818 MHz / 8 gyruss clock), are summed at 1/chips gain so a full
// blast bank stays within [-1, 1], and the sum is linearly resampled here
// to the AudioContext rate (the worklet-global `sampleRate`).

import { AY8910, renderBank } from './ay8910.ts';

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

class Ay8910Processor extends AudioWorkletProcessor {
  private chips: AY8910[] = [];
  /** native samples advanced per output sample (e.g. 223721.5 / 48000). */
  private step: number = 1;

  // Linear-interpolation resampler state: output sits `frac` (0..1) of the
  // way between native samples s0 and s1.
  private frac: number = 0;
  private s0: number = 0;
  private s1: number = 0;

  // Internal native-rate render buffers (bank sum + per-chip scratch).
  private nativeBuf: Float32Array = new Float32Array(CHUNK);
  private scratch: Float32Array = new Float32Array(CHUNK);
  private nativePos: number = CHUNK; // next unread index; == length => refill

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
          break;
        }
        case 'write': {
          const chip = this.chips[msg.offset >> 4];
          if (chip) chip.writeReg(msg.offset & 0x0f, msg.data);
          break;
        }
      }
    };
  }

  private nextNativeSample(): number {
    if (this.nativePos >= this.nativeBuf.length) {
      // chips is non-empty whenever this is reached (checked in process())
      renderBank(this.chips, this.nativeBuf, this.scratch);
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
      for (let i = 0; i < out.length; i++) {
        this.frac += this.step;
        while (this.frac >= 1) {
          this.frac -= 1;
          this.s0 = this.s1;
          this.s1 = this.nextNativeSample();
        }
        out[i] = this.s0 + (this.s1 - this.s0) * this.frac;
      }
    }

    // duplicate mono into any additional output channels
    for (let c = 1; c < channels.length; c++) channels[c].set(out);
    return true;
  }
}

registerProcessor('ay8910', Ay8910Processor);
