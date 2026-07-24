import type { GameTestContract } from './types.ts';

export const pooyan: GameTestContract = {
  game: 'pooyan',
  category: 'arcade',
  driver: 'src/mame/konami/pooyan.cpp',
  machine: { className: 'pooyan_state', name: 'pooyan' },
  romEnvironment: 'MAMEKIT_POOYAN_ROM',
  screen: { width: 256, height: 224 },
  soundKind: 'ay8910',
  frames: 600,
  minimumFps: 45,
  checkpoints: [1, 60, 180, 300, 420, 600],
  actions: [
    { atFrame: 300, code: 'Digit5', heldFrames: 10, releasedFrames: 20 },
    { atFrame: 330, code: 'Digit1', heldFrames: 10, releasedFrames: 20 },
  ],
  golden: {
    regions: {
      maincpu: '55a9be82',
      proms: '0e619225',
      sprites: '473dea4e',
      tiles: 'b1d2d544',
      'timeplt_audio:tpsound': '0764635f',
    },
    checkpoints: {
      '1': {
        video: '74589235',
        state: '282d5211',
      },
      '60': {
        video: 'e31b647c',
        state: '6ff8da12',
      },
      '180': {
        video: 'c036d9ec',
        state: '784bb1a2',
      },
      '300': {
        video: '85d2acaa',
        state: '824c31f0',
      },
      '420': {
        video: 'e008d9ac',
        state: '93d76c75',
      },
      '600': {
        video: '359901e1',
        state: '90658536',
      },
    },
    audio: {
      writes: 2305,
      nonzeroWrites: 1986,
      writeHash: 'bef8a1d8',
      pcmHash: 'e554607a',
      rms: 0.020936,
    },
  },
};
