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
import type { GeneratedAudioRoute } from './generated-machine.ts';
import type { GeneratedDacFilterPlan } from './audio-protocol.ts';

export interface WorkletCoreConfig {
  readonly sampleRate: number;
  readonly waveRom?: Uint8Array;
  readonly clock?: number;
  readonly voices?: number;
  /** number of chip instances the worklet should host (ay8910 bank) */
  readonly chips?: number;
  /** per-chip mix weights (board analog net); defaults to all-equal */
  readonly chipGains?: number[];
  readonly routes?: GeneratedAudioRoute[];
  /** DAC route gain override */
  readonly dacGain?: number;
  readonly auxiliary?: GeneratedDacFilterPlan;
  /** video refresh rate (Hz) — paces the worklet's write scheduler */
  readonly refresh?: number;
  /** log worklet scheduler stats to the console once per second */
  readonly debug?: boolean;
}

interface PendingWrite {
  offset: number;
  data: number;
  frac?: number;
  /** Target device write method; worklets route by name, never by offset math. */
  method?: string;
}

/** A bulk sample-data push (NES DMC), queued in order with register writes. */
interface PendingData {
  id: number;
  bytes: Uint8Array;
}

type PendingItem =
  | { kind: 'write'; write: PendingWrite }
  | { kind: 'data'; data: PendingData };

export class AudioOutput {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private volume: number = 1;
  /** writes + data pushes, kept in issue order, flushed once per frame */
  private pending: PendingItem[] = [];
  /** Complete frames produced while the async AudioWorklet is starting. */
  private pendingFrames: PendingItem[][] = [];

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
      chips: core.chips,
      chipGains: core.chipGains,
      routes: core.routes,
      dacGain: core.dacGain,
      auxiliary: core.auxiliary,
      refresh: core.refresh,
      debug: core.debug,
    });

    // worklet scheduler telemetry (posted once per second when debug)
    if (core.debug) {
      node.port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { type?: string } & Record<string, unknown>;
        if (m.type === 'stats') {
          const { type: _t, ...rest } = m;
          console.log('[audio]', JSON.stringify(rest));
        }
      };
      console.log(`[audio] context rate=${ctx.sampleRate} state=${ctx.state} baseLatency=${ctx.baseLatency}`);
      ctx.addEventListener('statechange', () => console.log(`[audio] state -> ${ctx.state}`));
    }

    this.ctx = ctx;
    this.node = node;
    this.gain = gain;

    // Frames that ran while addModule() was awaiting are pre-audio history:
    // collapse them into ONE batch so the register state lands correctly
    // without queueing N rendered frames of permanent backlog latency
    // (worklets drain exactly one queued frame per video frame).
    const backlog = this.pendingFrames.splice(0).flat();
    if (backlog.length) this.postFrame(node, backlog);

    if (ctx.state !== 'running') await ctx.resume();
  }

  /**
   * Queue a register write for the worklet. Writes accumulate and go out as
   * ONE batch message per video frame via flush() — junofrst's i8039 DAC
   * alone is ~4k writes/s, and per-write postMessage overhead starves the
   * scheduler under main-thread jank. Complete frames produced before
   * start() finishes remain separate in `pendingFrames`.
   */
  write(offset: number, data: number, frac?: number, method?: string): void {
    const write: PendingWrite = { offset, data, frac };
    if (method !== undefined) write.method = method;
    this.pending.push({ kind: 'write', write });
  }

  /**
   * Queue a bulk sample-data push (NES DMC) in the SAME ordered stream as
   * register writes, so the buffer lands at the worklet before any later
   * write that starts playing it (the board pushes bytes, then writes $4015).
   */
  data(id: number, bytes: Uint8Array): void {
    this.pending.push({ kind: 'data', data: { id, bytes } });
  }

  /** Post all queued writes/data preserving order. Call once per frame. */
  flush(): void {
    const frame = this.pending.splice(0);
    if (this.node) this.postFrame(this.node, frame);
    else this.pendingFrames.push(frame);
  }

  /**
   * Drain one frame to the worklet, batching consecutive register writes into
   * one 'batch' message but breaking the batch at every data push so ordering
   * (write < data < write) is preserved across the port.
   */
  private postFrame(node: AudioWorkletNode, items: PendingItem[]): void {
    let batch: PendingWrite[] = [];
    for (const item of items) {
      if (item.kind === 'write') {
        batch.push(item.write);
      } else {
        if (batch.length) {
          node.port.postMessage({ type: 'batch', writes: batch });
          batch = [];
        }
        node.port.postMessage({ type: 'data', id: item.data.id, bytes: item.data.bytes });
      }
    }
    // An empty batch still represents one emulated frame. Timestamp-aware
    // worklets need it to advance sound even when no registers changed.
    node.port.postMessage({ type: 'batch', writes: batch });
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
