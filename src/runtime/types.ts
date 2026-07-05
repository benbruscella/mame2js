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
  /** this CPU's io space (AS_IO) when the driver maps one */
  io?: { ranges: RangeSpec[]; globalMask?: number };
}

export interface BoardConfig {
  /** driver family from the graph (galaga, pacman, galaxian, gyruss) — selects the board module */
  family: string;
  cpus: CpuSpec[];
  /** cpu[0]'s program map (legacy shared-map alias for the galaga family) */
  ranges: RangeSpec[];
  /** cpu[0]'s io space (pacman IM2 vector port) */
  io?: { ranges: RangeSpec[]; globalMask?: number };
  screen: { width: number; height: number; refresh: number; vtotal: number; vbstart: number; vbend?: number; rotate: number };
  clocks: { namco06: number; wsg: number };
}

export interface BoardSinks {
  /** sound register write, forwarded to the audio worklet (offset space is per SoundCore) */
  soundWrite: (offset: number, data: number) => void;
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
