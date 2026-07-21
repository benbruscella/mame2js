import type { GameTestContract } from './types.ts';

export const galaxian: GameTestContract = {
  game: 'galaxian',
  category: 'arcade',
  driver: 'src/mame/galaxian/galaxian.cpp',
  machine: { className: 'galaxian_state', name: 'galaxian' },
  romEnvironment: 'MAMEKIT_GALAXIAN_ROM',
  screen: { width: 256, height: 224 },
  soundKind: 'discrete',
  frames: 900,
  minimumFps: 45,
  checkpoints: [1, 60, 180, 300, 480, 500, 900],
  actions: [
    { atFrame: 300, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 330, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 390, code: 'ArrowLeft', heldFrames: 20, releasedFrames: 10 },
    { atFrame: 440, code: 'ArrowRight', heldFrames: 20, releasedFrames: 10 },
    { atFrame: 490, code: 'Space', heldFrames: 10, releasedFrames: 10 },
  ],
  golden: {
    regions: {
      gfx1: 'b2b81d38',
      maincpu: 'f64af3ca',
      proms: 'c3ac9467',
    },
    checkpoints: {
      1: { video: 'f7e6ac81', state: 'be17ce9d' },
      60: { video: 'eccebf8e', state: '1419bc9e' },
      180: { video: '91227fd8', state: '53aefead' },
      300: { video: 'd63f2643', state: '216d30f1' },
      480: { video: '2727e0da', state: 'b9383f89' },
      500: { video: 'f002958b', state: '0edb7399' },
      900: { video: '1aee009f', state: '055823fc' },
    },
    audio: {
      writes: 4002,
      nonzeroWrites: 2175,
      writeHash: '9bc84a53',
      pcmHash: 'd04601f8',
      rms: 0.104197,
    },
  },
};
