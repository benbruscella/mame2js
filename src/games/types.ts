import type { GameCategory } from '../gen/output-layout.ts';

export interface GameInputAction {
  atFrame: number;
  code: string;
  heldFrames: number;
  releasedFrames: number;
}

export interface GameCheckpointGolden {
  video: string;
  state: string;
}

export interface GameAcceptanceGolden {
  regions: Record<string, string>;
  checkpoints: Record<string, GameCheckpointGolden>;
  audio: {
    writes: number;
    nonzeroWrites: number;
    writeHash: string;
    pcmHash: string;
    rms: number;
  };
}

/**
 * Small, declarative QA token for one supported generated machine.
 * It contains no emulation behavior; the shared harness executes `dist`.
 */
export interface GameTestContract {
  game: string;
  category: GameCategory;
  driver: string;
  machine: { className: string; name: string };
  romEnvironment: string;
  screen: { width: number; height: number };
  soundKind: 'wsg' | 'ay8910';
  frames: number;
  /** Minimum full-contract throughput, including video hashing and audio probing. */
  minimumFps: number;
  checkpoints: number[];
  actions: GameInputAction[];
  golden?: GameAcceptanceGolden;
}
