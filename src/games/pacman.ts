import type { GameTestContract } from './types.ts';

export const pacman: GameTestContract = {
  game: 'pacman',
  category: 'arcade',
  driver: 'src/mame/pacman/pacman.cpp',
  machine: { className: 'pacman_state', name: 'pacman' },
  romEnvironment: 'MAMEKIT_PACMAN_ROM',
  screen: { width: 288, height: 224 },
  soundKind: 'wsg',
  frames: 600,
  minimumFps: 45,
  checkpoints: [1, 60, 180, 300, 420, 600],
  actions: [
    { atFrame: 300, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 330, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
  ],
  golden: {
    regions: {
      gfx1: '0be015aa',
      maincpu: '332838db',
      namco: '3f2ff826',
      proms: 'c1e7e6a7',
    },
    checkpoints: {
      1: { video: '1556d338', state: '0e2ea5f3' },
      60: { video: '1556d338', state: '3665b638' },
      180: { video: 'c835ca20', state: '1e93e277' },
      300: { video: '12f89a0a', state: '201babd2' },
      420: { video: 'cd637e69', state: '70b06825' },
      600: { video: 'fe38a959', state: 'd4e273cc' },
    },
    audio: {
      writes: 5830,
      nonzeroWrites: 2375,
      writeHash: '3706a0ca',
      pcmHash: '30c742bc',
      rms: 0.170869,
    },
  },
};
