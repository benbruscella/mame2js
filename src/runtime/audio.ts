// Browser-only Web Audio glue for a worklet-hosted sound core (no libraries).
//
// The DSP runs inside an AudioWorkletProcessor (see wsg-worklet.ts) so
// main-thread jank never glitches audio. AudioOutput only owns the
// AudioContext / GainNode wiring and forwards register writes to the
// worklet over its MessagePort.

/**
 * What the worklet needs to boot its own DSP instance. `{ sampleRate }`
 * alone is enough for the wiring; for the Namco WSG pass `waveRom` (the
 * first 0x100 bytes of the "namco" PROM region are the wavetable) and
 * `clock` (defaults to sampleRate — for the WSG they are the same, 96000).
 */
export interface WorkletCoreConfig {
  readonly sampleRate: number;
  readonly waveRom?: Uint8Array;
  readonly clock?: number;
  readonly voices?: number;
}

interface PendingWrite {
  offset: number;
  data: number;
}

export class AudioOutput {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private volume: number = 1;
  /** register writes issued before start() resolves, replayed in order */
  private pending: PendingWrite[] = [];

  constructor() {}

  /**
   * Call from a user gesture (browsers block AudioContext otherwise).
   * Loads the compiled worklet module (e.g. "runtime/wsg-worklet.js"
   * relative to dist), wires node -> gain -> destination and sends the
   * init message.
   */
  async start(core: WorkletCoreConfig, workletUrl: string, processorName = 'wsg'): Promise<void> {
    if (this.ctx) return; // already started

    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(ctx, processorName, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    node.connect(gain);
    gain.connect(ctx.destination);

    node.port.postMessage({
      type: 'init',
      waveRom: core.waveRom ?? new Uint8Array(0x100),
      clock: core.clock ?? core.sampleRate,
      voices: core.voices,
    });

    this.ctx = ctx;
    this.node = node;
    this.gain = gain;

    // replay writes that happened before the context existed
    for (const w of this.pending) {
      node.port.postMessage({ type: 'write', offset: w.offset, data: w.data });
    }
    this.pending.length = 0;

    if (ctx.state !== 'running') await ctx.resume();
  }

  /**
   * Forward a register write to the worklet. Writes are applied in message
   * order (frameTime granularity is one process() quantum, ~2.7 ms at 48 kHz,
   * which is well under a video frame).
   */
  write(offset: number, data: number): void {
    if (this.node) {
      this.node.port.postMessage({ type: 'write', offset, data });
    } else {
      this.pending.push({ offset, data });
    }
  }

  /** Master volume 0..1 via the GainNode. */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }
}
