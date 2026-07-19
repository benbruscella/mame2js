// Shared runtime contracts. Everything in src/runtime is game-agnostic
// (engine + device library); game-specific wiring is generated from the
// knowledge graph into out/<game>/app.

/** Loaded ROM regions, keyed by MAME region tag ("maincpu", "gfx1", "proms", ...). */
export type Regions = Record<string, Uint8Array>;

/**
 * A board video renderer. Native (pre-rotation) resolution; the shell applies
 * screen rotation (ROT90 etc.) when blitting.
 */
export interface VideoRenderer {
  readonly width: number;    // native visible width  (galaga: 288)
  readonly height: number;   // native visible height (galaga: 224)
  /** Render one full frame as packed ABGR (canvas ImageData byte order). */
  render(frame: Uint32Array): void;
  /** Called once per vblank to latch per-frame state (starfield scroll, etc). */
  vblank(): void;
}

/** One mono audio DSP core, pulled by the audio glue at its native rate. */
export interface SoundCore {
  readonly sampleRate: number;
  /** Register write, already time-ordered. */
  write(offset: number, data: number): void;
  /** Fill `out` with the next out.length mono samples in [-1, 1]. */
  render(out: Float32Array): void;
}

/** Active-low raw input port state, updated by the shell from DOM events. */
export interface InputPorts {
  /** read the current byte for a port tag ("IN0", "IN1", "DSWA", "DSWB") */
  read(tag: string): number;
}

// ---------------------------------------------------------------------------
// board contracts (shared by the shell and every boards/<family> module)
// ---------------------------------------------------------------------------

import type { RangeSpec } from './bus.ts';

export interface CpuSpec {
  tag: string;
  /** runtime core: 'z80' | 'konami1' | 'i8039' (from the device type in the graph) */
  type?: string;
  clock: number;
  region: string;
  /** this CPU's own program map (multi-CPU boards; galaga-family boards may use the shared top-level `ranges`) */
  ranges?: RangeSpec[];
  /** program-space global address mask (map.global_mask) */
  mask?: number;
  /** this CPU's io space (AS_IO) when the driver maps one */
  io?: { ranges: RangeSpec[]; globalMask?: number };
}

export interface BoardConfig {
  /** generated machine module key, injected by the shell from ShellConfig.game */
  game?: string;
  /** driver family from the graph (galaga, pacman, galaxian, gyruss) — selects the board module */
  family: string;
  cpus: CpuSpec[];
  /** cpu[0]'s program map (legacy shared-map alias for the galaga family) */
  ranges: RangeSpec[];
  /** cpu[0]'s io space (pacman IM2 vector port) */
  io?: { ranges: RangeSpec[]; globalMask?: number };
  /** IPT_CUSTOM port bits synthesized by a named driver member (the board
   * implements members by name; invaders_in1_control_r reads CONTP1) */
  customs?: { port: string; mask: number; member: string }[];
  screen: { width: number; height: number; refresh: number; vtotal: number; vbstart: number; vbend?: number; rotate: number };
  clocks: { namco06: number; wsg: number };
  /**
   * Console cartridge metadata, injected at runtime by the console room after
   * identifying a user-dropped cart (never present in generated config.json —
   * the cart bytes arrive as regions.prg / regions.chr alongside it).
   */
  cart?: { mapper: number; mirroring: 'horizontal' | 'vertical' | 'four' | 'single0' | 'single1'; battery?: boolean };
}

export interface BoardSinks {
  /**
   * Sound register write, forwarded to the audio worklet (offset space is
   * per SoundCore). `frac` is the write's position within the current video
   * frame (0..1, e.g. scanline/vtotal): boards emulate a whole frame in one
   * burst, so without it every write lands at the same instant and fast SFX
   * sweeps quantize into chirpy stair-steps. Pass it whenever known.
   */
  soundWrite: (offset: number, data: number, frac?: number) => void;
  /**
   * Bulk sample-data push to the worklet (NES DMC: the APU DSP runs in the
   * worklet and cannot read CPU memory, so the board snapshots the sample
   * bytes at trigger time and ships them). `id` names the buffer slot the
   * core's register writes refer to.
   */
  soundData?: (id: number, bytes: Uint8Array) => void;
}

export interface BoardSnapshot {
  frame: number;
  cpus: { tag: string; pc: number; sp: number; halted: boolean; held?: boolean }[];
  /** current credit count when the board tracks one (shown in the status line) */
  credits?: number;
  [extra: string]: unknown;
}

/** A composed machine: CPUs + devices + video, stepped one frame at a time. */
export interface Board {
  readonly fbWidth: number;
  readonly fbHeight: number;
  frame(fb: Uint32Array): void;
  reset(): void;
  snapshot(): BoardSnapshot;
}
