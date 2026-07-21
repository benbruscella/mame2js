import type { GameTestContract } from './types.ts';

export const invaders: GameTestContract = {
  game: 'invaders',
  category: 'arcade',
  driver: 'src/mame/midw8080/mw8080bw.cpp',
  machine: { className: 'invaders_state', name: 'invaders' },
  romEnvironment: 'MAMEKIT_INVADERS_ROM',
  screen: { width: 260, height: 224 },
  soundKind: 'discrete',
  frames: 600,
  minimumFps: 45,
  checkpoints: [1, 60, 180, 300, 420, 600],
  actions: [
    { atFrame: 300, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 330, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 390, code: 'ArrowLeft', heldFrames: 20, releasedFrames: 10 },
    { atFrame: 430, code: 'ArrowRight', heldFrames: 20, releasedFrames: 10 },
    { atFrame: 470, code: 'Space', heldFrames: 10, releasedFrames: 10 },
  ],
  golden: {
    regions: { maincpu: 'eaf1bbdb' },
    checkpoints: {
      1: { video: 'e8273a79', state: '3f2718bf' },
      60: { video: '7f097af0', state: '1586695e' },
      180: { video: '0f631559', state: 'e057e2a0' },
      300: { video: '64709a0d', state: 'b7d90dd9' },
      420: { video: 'e2d8e7f5', state: '3f1613f9' },
      600: { video: '12ab6419', state: '651086c7' },
    },
    audio: {
      writes: 721,
      nonzeroWrites: 717,
      writeHash: 'ef33bb62',
      pcmHash: 'c2e2b458',
      rms: 0.035226,
    },
  },
};
