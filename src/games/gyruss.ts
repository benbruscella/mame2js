import type { GameTestContract } from './types.ts';

export const gyruss: GameTestContract = {
  game: 'gyruss',
  category: 'arcade',
  driver: 'src/mame/konami/gyruss.cpp',
  machine: { className: 'gyruss_state', name: 'gyruss' },
  romEnvironment: 'MAMEKIT_GYRUSS_ROM',
  screen: { width: 256, height: 224 },
  soundKind: 'ay8910',
  frames: 1800,
  minimumFps: 45,
  checkpoints: [1, 60, 300, 480, 720, 1200, 1800],
  actions: [
    { atFrame: 480, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 510, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 720, code: 'ArrowRight', heldFrames: 60, releasedFrames: 20 },
    { atFrame: 840, code: 'Space', heldFrames: 30, releasedFrames: 20 },
  ],
  golden: {
    regions: {
      audio2: '3f9b5dea',
      audiocpu: 'a1cb4e34',
      maincpu: '487c787d',
      proms: '617d77e3',
      sprites: '21881251',
      sub: '8d48e501',
      tiles: '27d8329b',
    },
    checkpoints: {
      1: { video: 'f7e6ac81', state: 'ee93fd47' },
      60: { video: '8f81534a', state: '7297c40c' },
      300: { video: 'f9372778', state: 'adc4cfa7' },
      480: { video: '08eff47f', state: 'b677c748' },
      720: { video: 'c239be86', state: '4663f25d' },
      1200: { video: '29a746b7', state: 'd7c52a7d' },
      1800: { video: '1b1b4c6d', state: '9556c09a' },
    },
    audio: {
      writes: 72835,
      nonzeroWrites: 54418,
      writeHash: '48414fb1',
      pcmHash: 'e7b9c2f3',
      rms: 0.022656,
    },
  },
};
