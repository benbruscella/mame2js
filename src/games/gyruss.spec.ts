import assert from 'node:assert/strict';
import { compileDiscreteMixer } from '../mame/audio-compiler.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { gyruss } from './gyruss.ts';
import { assertGameContract, gameSourceGraph, mameSourceRoot } from './test-support.ts';

assertGameContract(gyruss);
const mameSrc = mameSourceRoot();
const graph = gameSourceGraph(gyruss);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === gyruss.machine.className &&
  node.props.name === gyruss.machine.name);
assert.ok(machine);

const deviceTypes = graph.nodes
  .filter(node => node.label === 'Device')
  .map(node => String(node.props.type));
for (const type of ['Z80', 'KONAMI1', 'I8039', 'AY8910', 'DISCRETE']) {
  assert.ok(deviceTypes.includes(type), `Gyruss must extract ${type}`);
}

const video = compileMameVideo(graph, mameSrc, machine.id);
assert.ok(video, 'Gyruss MAME video source must lower to executable video IR');
assert.deepEqual(video.plan.tilemaps.map(tilemap => tilemap.transmasks), [[
  { group: 0, foreground: 0, background: 0 },
  { group: 1, foreground: 0x0f, background: 0 },
]]);
assert.deepEqual(video.plan.palette?.banks.map(bank => ({
  penOffset: bank.penOffset,
  colorOr: bank.colorOr,
  lookupOffset: bank.lookupOffset,
  lookupCount: bank.lookupCount,
})), [
  { penOffset: 0, colorOr: 0, lookupOffset: 32, lookupCount: 256 },
  { penOffset: 256, colorOr: 0x10, lookupOffset: 288, lookupCount: 64 },
]);
assert.ok(video.handlers.every(handler => !handler.program?.diagnostics.length));

const mixer = compileDiscreteMixer(
  mameSrc,
  gyruss.driver,
  'sound_discrete',
);
assert.ok(mixer);
assert.equal(mixer.streamInputs.length, 15);
assert.equal(mixer.dataInputs[0]?.node, 16);
assert.equal(mixer.filters.length, 6);
assert.deepEqual(mixer.adders.map(adder => adder.node), [40, 41, 42]);
assert.deepEqual(mixer.mixers.map(output => output.resistances), [
  [2200, 2200, 2200, 1100, 1100],
  [2200, 2200, 2200, 1100, 4700],
]);
assert.deepEqual(mixer.outputs, [
  { node: 50, gain: 11 },
  { node: 51, gain: 11 },
]);

const timer = graph.nodes.find(node =>
  node.label === 'Handler' &&
  node.props.ownerClass === 'gyruss_state' &&
  node.props.method === 'porta_r');
assert.match(String(timer?.props.sourceBody), /\bTABLE\s*\(/);
assert.deepEqual(
  compileMameHandler(String(timer!.props.sourceBody)).diagnostics,
  [],
  'file-scope MAME timer table must lower to executable handler IR',
);

console.log('gyruss.spec: CPUs, tile groups, timer table and discrete mixer passed');
