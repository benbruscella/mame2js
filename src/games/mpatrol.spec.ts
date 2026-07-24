import assert from 'node:assert/strict';
import { compileMameM6803 } from '../mame/cpu-compiler.ts';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { mpatrol } from './mpatrol.ts';
import {
  assertGameContract,
  gameSourceGraph,
  mameSourceRoot,
} from './test-support.ts';

assertGameContract(mpatrol);
const mameSrc = mameSourceRoot();
const graph = gameSourceGraph(mpatrol);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === mpatrol.machine.className &&
  node.props.name === mpatrol.machine.name);
assert.ok(machine);

const types = new Set(
  graph.nodes
    .filter(node => node.label === 'Device')
    .map(node => String(node.props.type)),
);
for (const type of ['Z80', 'M6803', 'AY8910', 'MSM5205', 'DISCRETE']) {
  assert.ok(types.has(type), `Moon Patrol graph must extract ${type}`);
}

const video = compileMameVideo(graph, mameSrc, machine.id);
assert.ok(video, 'Moon Patrol MAME video source must lower to executable video IR');
assert.deepEqual(video.plan.gfx.map(entry => entry.region), [
  'sp', 'tx', 'bg0', 'bg1', 'bg2',
]);
assert.deepEqual(video.plan.palettes?.map(palette => palette.member), [
  'm_sp_palette', 'm_tx_palette', 'm_bg_palette',
]);
assert.deepEqual(video.plan.tilemaps[0]?.scrollDx, [127, 127]);
assert.deepEqual(video.plan.tilemaps[0]?.scrollDy, [16, 16]);
assert.deepEqual(video.plan.initialState.m_bgxpos, [0, 0]);
assert.deepEqual(video.plan.initialState.m_bgypos, [0, 0]);
assert.equal(video.plan.initialState.m_spritelimit, 0xfc);
assert.equal(video.plan.initialState.m_do_bg_fills, 1);
assert.ok(video.handlers.every(handler => !handler.program?.diagnostics.length));
const flipHandler = graph.nodes.find(node =>
  node.label === 'Handler' &&
  node.props.ownerClass === 'm52_state' &&
  node.props.method === 'flipscreen_w');
assert.deepEqual(flipHandler?.props.inputMembers, ['m_dsw2=DSW2']);

const m6803 = compileMameM6803(mameSrc);
assert.equal(m6803.summary.opcodes, 256);
assert.equal(m6803.summary.compiledOpcodes, 256);
assert.equal(m6803.summary.diagnostics, 0);
assert.deepEqual(m6803.internal?.ram, [{ start: 0x80, end: 0xff }]);

console.log('mpatrol.spec: game token and MAME-source machine contract passed');
