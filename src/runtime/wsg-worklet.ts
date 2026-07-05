// AudioWorklet module hosting the Namco WSG DSP off the main thread,
// plus the Namco 54xx noise HLE (explosions) on Galaga-class boards.
// Compiled output (dist/runtime/wsg-worklet.js) is loaded via
// audioContext.audioWorklet.addModule(url); worklet module scopes support
// ES imports, so wsg.js / namco54.js are fetched relative to this module's
// URL.
//
// Protocol (port.onmessage):
//   { type: 'init',  waveRom: Uint8Array, clock: number, voices?: number }
//   { type: 'write', offset: number, data: number }
//   { type: 'enable', on: boolean }
//
// Write offsets 0x00-0x1f are WSG registers (pacman_sound_w space);
// offsets >= 0x40 carry the 54xx command byte stream (the 06xx slot-3
// writes forwarded by the board — see boards/galaga.ts).
//
// Both cores render at the same native rate (clock, 96000 for Galaga),
// are summed here, and the sum is linearly resampled to the AudioContext
// rate (the worklet-global `sampleRate`).

import { NamcoWSG } from './wsg.ts';
import { Namco54 } from './namco54.ts';

// Relative 54xx gain. The shell applies the WSG route gain as the node
// master volume (0.90 * 10/16 = 0.5625, see audio.ts/shell), so the WSG
// renders here at 1.0 and the 54xx at its target effective route gain
// (~0.50) divided by that master: 0.50 / 0.5625.
const N54_GAIN = 0.50 / 0.5625;

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
  waveRom: Uint8Array;
  clock: number;
  voices?: number;
}
interface WriteMessage {
  type: 'write';
  offset: number;
  data: number;
}
interface EnableMessage {
  type: 'enable';
  on: boolean;
}
type WsgMessage = InitMessage | WriteMessage | EnableMessage;

/** Native samples rendered per refill of the internal buffer. */
const CHUNK = 256;

class WsgProcessor extends AudioWorkletProcessor {
  private core: NamcoWSG | null = null;
  private n54: Namco54 | null = null;
  private n54Buf: Float32Array = new Float32Array(CHUNK);
  /** native samples advanced per output sample (e.g. 96000 / 48000 = 2). */
  private step: number = 1;

  // Linear-interpolation resampler state: output sits `frac` (0..1) of the
  // way between native samples s0 and s1.
  private frac: number = 0;
  private s0: number = 0;
  private s1: number = 0;

  // Internal native-rate render buffer.
  private nativeBuf: Float32Array = new Float32Array(CHUNK);
  private nativePos: number = CHUNK; // next unread index; == length => refill

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as WsgMessage;
      switch (msg.type) {
        case 'init': {
          this.core = new NamcoWSG(msg.waveRom, msg.clock, msg.voices);
          this.n54 = new Namco54(msg.clock); // same native rate as the WSG
          this.step = msg.clock / sampleRate;
          this.frac = 0;
          this.s0 = 0;
          this.s1 = 0;
          this.nativePos = this.nativeBuf.length;
          break;
        }
        case 'write':
          if (msg.offset >= 0x40) this.n54?.write(msg.data);
          else this.core?.write(msg.offset, msg.data);
          break;
        case 'enable':
          this.core?.soundEnable(msg.on);
          break;
      }
    };
  }

  private nextNativeSample(): number {
    if (this.nativePos >= this.nativeBuf.length) {
      // cores are non-null whenever this is reached (checked in process())
      (this.core as NamcoWSG).render(this.nativeBuf);
      (this.n54 as Namco54).render(this.n54Buf);
      // sum WSG + 54xx, hard-limited to [-1, 1] (WSG alone peaks ~0.94;
      // simultaneous full-scale boom + 3 voices can exceed 1)
      const buf = this.nativeBuf;
      const n54 = this.n54Buf;
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i] + n54[i] * N54_GAIN;
        buf[i] = s > 1 ? 1 : s < -1 ? -1 : s;
      }
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

    if (!this.core) {
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

registerProcessor('wsg', WsgProcessor);
