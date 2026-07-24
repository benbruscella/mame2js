import type { GameTestContract } from './types.ts';

export const galaga: GameTestContract = {
  game: 'galaga',
  category: 'arcade',
  driver: 'src/mame/namco/galaga.cpp',
  machine: { className: 'galaga_state', name: 'galaga' },
  romEnvironment: 'MAMEKIT_GALAGA_ROM',
  screen: { width: 288, height: 224 },
  soundKind: 'wsg',
  // Galaga's three-CPU self-test runs ~12 s before the game will take a coin,
  // and the WSG is silent until then (matches real hardware: the boot boom is
  // the 54xx discrete circuit, not the WSG) — so all actions land post-boot.
  frames: 2600,
  // The generated 05xx hot loop is AOT-compiled from device IR.
  minimumFps: 45,
  checkpoints: [1, 300, 720, 900, 1050, 1300, 1600, 2456, 2600],
  actions: [
    { atFrame: 950, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 1000, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 1100, code: 'ArrowLeft', heldFrames: 20, releasedFrames: 10 },
    { atFrame: 1200, code: 'ArrowRight', heldFrames: 20, releasedFrames: 10 },
    { atFrame: 1250, code: 'Space', heldFrames: 10, releasedFrames: 10 },
    { atFrame: 1350, code: 'Space', heldFrames: 10, releasedFrames: 10 },
  ],
  audioRequirements: [
    {
      method: 'discrete',
      fromFrame: 2401,
      toFrame: 2456,
      minimumNonzeroWrites: 0,
      maximumNonzeroWrites: 0,
    },
    {
      method: 'discrete',
      fromFrame: 2457,
      toFrame: 2471,
      minimumNonzeroWrites: 100,
    },
  ],
  golden: {
    regions: {
      '54xx:mcu': 'ee7357e0',
      gfx1: '58b2f47c',
      gfx2: 'd11e0edf',
      maincpu: 'd249eb7d',
      namco: '55c1401a',
      proms: '33c81fa8',
      sub: 'e9ea3639',
      sub2: '6d220ddd',
    },
    checkpoints: {
      '1': {
        video: '967206d7',
        state: '564a0362',
      },
      '300': {
        video: '8fa90953',
        state: 'e4d52427',
      },
      '720': {
        video: '7f7fea0b',
        state: '8766b4c5',
      },
      '900': {
        video: 'd4ed5a0c',
        state: 'b65c7a6a',
      },
      '1050': {
        video: 'f0cb037c',
        state: '6ca53089',
      },
      '1300': {
        video: '9505b9bf',
        state: 'd3e070c8',
      },
      '1600': {
        video: '83a2539e',
        state: 'e6289a01',
      },
      '2456': {
        video: '492457b6',
        state: '35455f7c',
      },
      '2600': {
        video: 'fd5bcec5',
        state: 'af98e8f5',
      },
    },
    audio: {
      writes: 311904,
      nonzeroWrites: 30687,
      writeHash: 'bfac7536',
      pcmHash: 'fc6b5b22',
      rms: 0.075614,
    },
  },
};
