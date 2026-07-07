// AudioWorklet module hosting the NES 2A03 APU off the main thread (issue
// #17). Compiled output (dist/runtime/nes-worklet.js) is loaded via
// audioContext.audioWorklet.addModule(url); worklet module scopes support ES
// imports, so nes-apu.js is fetched relative to this module's URL (same as
// ay8910-worklet.ts imports ./ay8910.ts and ym2203-worklet.ts imports
// ./ym2203.ts). The processor is registered as 'nes' — the shell derives the
// name from cfg.sound.kind.
//
// Protocol (port.onmessage) — the SAME message set the ay8910/ym2203 worklets
// handle (a worklet that ignored 'batch' went silent once, commit cb513c9),
// plus a NEW 'data' message carrying bulk DMC sample bytes:
//   { type: 'init',  clock: number, chips?, waveRom?, voices? }
//     (waveRom/voices are part of the shared shell contract; the APU has none
//      and ignores them; chips is ignored — one 2A03 per console)
//   { type: 'write', offset, data, frac? }   offset = register - $4000
//   { type: 'batch', writes: [{offset,data,frac?}, ...] }  one per frame
//   { type: 'data',  id, bytes }  DMC sample buffer -> core.data(id, bytes)
//     (an AudioWorklet cannot read CPU memory, so the board snapshots the
//      DMC sample from cart PRG and ships it; id 0 = current DMC sample)
//   { type: 'reset' }  rebuild the core from the last init parameters
//
// The APU renders one mono stream at its native rate (clock/2, ~894.9 kHz
// NTSC — one sample per APU cycle) and it is resampled to the AudioContext
// rate by the same box-filter StreamResampler as ym2203-worklet.ts. At this
// native rate the box average spans ~18 native samples per 48 kHz output
// sample, a cheap anti-alias low-pass over the pulse/noise square edges.

import { NesApu } from './nes-apu.ts';

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
  frac?: number;
}
interface BatchMessage {
  type: 'batch';
  writes: { offset: number; data: number; frac?: number }[];
}
interface DataMessage {
  type: 'data';
  id: number;
  bytes: Uint8Array;
}
interface ResetMessage {
  type: 'reset';
}
type NesMessage = InitMessage | WriteMessage | BatchMessage | DataMessage | ResetMessage;

/** Native samples rendered per refill of the internal buffer. */
const CHUNK = 1024;

/**
 * Box-filter decimating resampler over one native-rate render stream (copied
 * from ym2203-worklet.ts's StreamResampler — the shared house pattern).
 */
class StreamResampler {
  /** native samples advanced per output sample */
  private readonly step: number;
  private frac = 0;
  private boxAvg = 0;
  private readonly nativeBuf = new Float32Array(CHUNK);
  private nativePos = CHUNK; // next unread index; == length => refill
  private readonly render: (out: Float32Array) => void;

  constructor(nativeRate: number, render: (out: Float32Array) => void) {
    this.step = nativeRate / sampleRate;
    this.render = render;
  }

  private nextNativeSample(): number {
    if (this.nativePos >= this.nativeBuf.length) {
      this.render(this.nativeBuf);
      this.nativePos = 0;
    }
    return this.nativeBuf[this.nativePos++];
  }

  /** Next output-rate sample: average every native sample it spans. */
  next(): number {
    this.frac += this.step;
    let acc = 0;
    let n = 0;
    while (this.frac >= 1) {
      this.frac -= 1;
      acc += this.nextNativeSample();
      n++;
    }
    if (n > 0) this.boxAvg = acc / n;
    return this.boxAvg;
  }
}

class NesProcessor extends AudioWorkletProcessor {
  private clock = 0;
  private apu: NesApu | null = null;
  private resampler: StreamResampler | null = null;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as NesMessage;
      switch (msg.type) {
        case 'init':
          this.clock = msg.clock;
          this.build();
          break;
        case 'write':
          this.apu?.write(msg.offset, msg.data);
          break;
        case 'batch':
          if (this.apu) for (const w of msg.writes) this.apu.write(w.offset, w.data);
          break;
        case 'data':
          this.apu?.data(msg.id, msg.bytes);
          break;
        case 'reset':
          this.build();
          break;
      }
    };
  }

  private build(): void {
    const apu = new NesApu(this.clock);
    this.apu = apu;
    this.resampler = new StreamResampler(apu.sampleRate, (out) => apu.render(out));
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const out = channels[0];

    if (!this.resampler) {
      out.fill(0);
    } else {
      for (let i = 0; i < out.length; i++) out[i] = this.resampler.next();
    }

    // duplicate mono into any additional output channels
    for (let c = 1; c < channels.length; c++) channels[c].set(out);
    return true;
  }
}

registerProcessor('nes', NesProcessor);
