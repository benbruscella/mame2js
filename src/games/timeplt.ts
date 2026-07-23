import type { GameTestContract } from './types.ts';

export const timeplt: GameTestContract = {
  game: 'timeplt',
  category: 'arcade',
  driver: 'src/mame/konami/timeplt.cpp',
  machine: { className: 'timeplt_state', name: 'timeplt' },
  romEnvironment: 'MAMEKIT_TIMEPLT_ROM',
  screen: { width: 256, height: 224 },
  soundKind: 'ay8910',
  frames: 1200,
  minimumFps: 40,
  checkpoints: [1, 60, 300, 540, 720, 1200],
  actions: [
    { atFrame: 540, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 570, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
  ],
  golden: {
    regions: {
      maincpu: 'c8976cae',
      proms: '8dba87f3',
      sprites: '51c0401c',
      tiles: 'c2507f40',
      'timeplt_audio:tpsound': '3142803f',
    },
    checkpoints: {
      '1': {
        video: '1b1664f7',
        state: '0b350316',
      },
      '60': {
        video: 'b95a6e16',
        state: 'ae9b3ae1',
      },
      '300': {
        video: '958f2475',
        state: '3e4b5bd5',
      },
      '540': {
        video: '3757fed1',
        state: '7f95cddf',
      },
      '720': {
        video: 'bf127b3b',
        state: '289f4c90',
      },
      '1200': {
        video: '80b74718',
        state: 'af922604',
      },
    },
    audio: {
      writes: 5831,
      nonzeroWrites: 5556,
      writeHash: '636af7b8',
      pcmHash: 'fd1dd828',
      rms: 0.028542,
    },
  },
};
