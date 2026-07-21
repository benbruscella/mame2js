import type { GameTestContract } from './types.ts';

export const invaders: GameTestContract = {
  game: 'invaders',
  category: 'arcade',
  driver: 'src/mame/midw8080/mw8080bw.cpp',
  machine: { className: 'invaders_state', name: 'invaders' },
  romEnvironment: 'MAMEKIT_INVADERS_ROM',
  screen: { width: 260, height: 224 },
  soundKind: 'invaders',
  frames: 600,
  minimumFps: 45,
  checkpoints: [1, 60, 180, 300, 420, 600],
  actions: [
    { atFrame: 300, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 330, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
  ],
  golden: {
    regions: { maincpu: 'eaf1bbdb' },
    checkpoints: {
      1: { video: 'e8273a79', state: '3f2718bf' },
      60: { video: '55bd5504', state: '33c768dd' },
      180: { video: '55bd5504', state: '8bfd237e' },
      300: { video: '55bd5504', state: '4493cf6c' },
      420: { video: '72219ba6', state: 'f7621bb8' },
      600: { video: '2c1357a5', state: 'ebc42b6c' },
    },
    audio: {
      writes: 927,
      nonzeroWrites: 913,
      writeHash: '480c2bea',
      pcmHash: '6753c031',
      rms: 0.086925,
    },
  },
};
