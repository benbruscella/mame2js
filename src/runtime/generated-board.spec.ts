import assert from 'node:assert/strict';
import {
  bindGeneratedAudioFilters,
  bindGeneratedDriverState,
  bindGeneratedShareState,
} from './generated-board.ts';

const state: Record<string, unknown> = {};
const first = new Uint8Array(0x100);
const second = new Uint8Array(0x100);

bindGeneratedShareState(state, 'spriteram[0]', first);
bindGeneratedShareState(state, 'spriteram[1]', second);

assert.equal(state['m_spriteram[0]'], first);
assert.equal(state['m_spriteram[1]'], second);
assert.deepEqual(state.m_spriteram, [first, second]);
assert.equal((first as Uint8Array & { bytes(): number }).bytes(), 0x100);

const driverState: Record<string, unknown> = {};
const driverCalls: Record<string, (...args: number[]) => number | void> = {};
bindGeneratedDriverState(driverState, driverCalls);
assert.equal(driverCalls.flip_screen!(), 0);
driverCalls.flip_screen_set!(1);
assert.equal(driverCalls.flip_screen!(), 1);
assert.equal(driverCalls.flip_screen_x!(), 1);
assert.equal(driverCalls.flip_screen_y!(), 1);
driverCalls.flip_screen_x_set!(0);
assert.equal(driverCalls.flip_screen!(), 1);
driverCalls.flip_screen_y_set!(0);
assert.equal(driverCalls.flip_screen!(), 0);

const filterWrites: Array<[number, number]> = [];
const flatFilterState: Record<string, unknown> = {};
bindGeneratedAudioFilters(
  flatFilterState,
  {
    kind: 'ay8910',
    deviceTag: 'ay',
    deviceType: 'AY8910',
    writeMethods: ['data_w'],
    enableMethods: [],
    controlOffset: -1,
    filterLayout: 'flat',
    routes: [0, 1, 2].map(channel => ({
      chip: 0,
      channel,
      gain: 1,
      target: `filter.0.${channel}`,
      filter: { index: channel, bank: 0, channel },
    })),
  },
  (offset, data) => filterWrites.push([offset, data]),
);
const flatFilters = flatFilterState.m_filter as {
  filter_rc_set_RC(...values: number[]): void;
}[];
assert.equal(flatFilters.length, 3);
flatFilters[2]!.filter_rc_set_RC(0, 1000, 2200, 200, 0.22e-6);
assert.equal(filterWrites.length, 5);

const matrixFilterState: Record<string, unknown> = {};
bindGeneratedAudioFilters(
  matrixFilterState,
  {
    kind: 'ay8910',
    deviceTag: 'ay1',
    deviceTags: ['ay1', 'ay2'],
    deviceType: 'AY8910',
    writeMethods: ['data_w'],
    enableMethods: [],
    controlOffset: -1,
    filterLayout: 'matrix',
    routes: [{
      chip: 1,
      channel: 2,
      gain: 1,
      target: 'filter.1.2',
      filter: { index: 0, bank: 1, channel: 2 },
    }],
  },
  () => {},
);
const matrixFilters = matrixFilterState.m_filter as unknown[][];
assert.equal(typeof (matrixFilters[1]![2] as Record<string, unknown>).filter_rc_set_RC, 'function');

console.log('generated-board.spec: shares, flips and generated filter layouts passed');
