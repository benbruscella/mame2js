import type { GameTestContract } from './types.ts';

export const rocnrope: GameTestContract = {
  game: 'rocnrope',
  category: 'arcade',
  driver: 'src/mame/konami/rocnrope.cpp',
  machine: { className: 'rocnrope_state', name: 'rocnrope' },
  romEnvironment: 'MAMEKIT_ROCNROPE_ROM',
  screen: { width: 256, height: 224 },
  soundKind: 'ay8910',
  frames: 1200,
  minimumFps: 45,
  checkpoints: [1, 60, 300, 540, 720, 1200],
  optionalRomFiles: ['h100.6g'],
  actions: [
    { atFrame: 540, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 570, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 720, code: 'ArrowRight', heldFrames: 60, releasedFrames: 20 },
    { atFrame: 840, code: 'Space', heldFrames: 20, releasedFrames: 20 },
  ],
  golden: {
    regions: {
      maincpu: '40717b8a',
      pal_cpuvidbd: 'd202ef8d',
      proms: '5484cc33',
      sprites: '8ce87af8',
      tiles: 'd3b1b72f',
      'timeplt_audio:tpsound': 'f47e6800',
    },
    checkpoints: {
      '1': { video: 'fee07cee', state: 'fa48c445' },
      '60': { video: 'c04023ad', state: '7f483305' },
      '300': { video: '0ba4f893', state: 'a9efceb5' },
      '540': { video: '5512b739', state: 'fafdee9b' },
      '720': { video: '4205a71e', state: '9216dd69' },
      '1200': { video: '98e016ff', state: '160b2eaf' },
    },
    audio: {
      writes: 1422,
      nonzeroWrites: 1291,
      writeHash: '6f7920bc',
      pcmHash: 'e6a71079',
      rms: 0.019646,
    },
  },
};
