import assert from 'node:assert/strict';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { lowerAudioRoutes } from '../gen/emit-machine.ts';
import { executeGeneratedProgram } from '../runtime/generated-handler.ts';
import { timeplt } from './timeplt.ts';
import {
  assertGameContract,
  gameSourceGraph,
  mameSourceRoot,
} from './test-support.ts';

assertGameContract(timeplt);
const graph = gameSourceGraph(timeplt);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === timeplt.machine.className &&
  node.props.name === timeplt.machine.name);
assert.ok(machine);
const compiled = compileMameVideo(graph, mameSourceRoot(), machine.id);
assert.ok(compiled, 'Time Pilot MAME video source must lower to executable video IR');
assert.deepEqual(compiled.plan.palette.channels.map(channel => ({
  channel: channel.channel,
  offsets: channel.offsets,
  weights: channel.weights,
})), [
  { channel: 'r', offsets: [32, 32, 32, 32, 32], weights: [25, 36, 53, 64, 77] },
  { channel: 'g', offsets: [32, 32, 0, 0, 0], weights: [25, 36, 53, 64, 77] },
  { channel: 'b', offsets: [0, 0, 0, 0, 0], weights: [25, 36, 53, 64, 77] },
]);
assert.deepEqual(compiled.plan.palette.banks, [
  { penOffset: 128, colorOr: 0, lookupOffset: 64, lookupCount: 256 },
  { penOffset: 0, colorOr: 16, lookupOffset: 320, lookupCount: 128 },
]);
assert.equal(compiled.plan.tilemaps[0]?.mapper, 'TILEMAP_SCAN_ROWS');
assert.ok(compiled.handlers.every(handler => !handler.program?.diagnostics.length));
const screen = graph.nodes.find(node =>
  node.label === 'Device' && node.props.type === 'SCREEN');
assert.deepEqual(screen?.props.screenVideoAttributes, ['VIDEO_UPDATE_SCANLINE']);
const ayDevices = graph.nodes
  .filter(node => node.label === 'Device' && node.props.type === 'AY8910')
  .map(node => ({ id: node.id, tag: String(node.props.tag) }));
const routes = lowerAudioRoutes(graph, ayDevices);
assert.equal(routes.length, 6);
assert.deepEqual(routes.map(route => ({
  chip: route.chip,
  channel: route.channel,
  gain: route.gain,
  target: route.target,
  filter: route.filter,
})), [
  { chip: 0, channel: 0, gain: 0.6, target: 'filter.0.0', filter: { index: 0, bank: 0, channel: 0 } },
  { chip: 0, channel: 1, gain: 0.6, target: 'filter.0.1', filter: { index: 1, bank: 0, channel: 1 } },
  { chip: 0, channel: 2, gain: 0.6, target: 'filter.0.2', filter: { index: 2, bank: 0, channel: 2 } },
  { chip: 1, channel: 0, gain: 0.6, target: 'filter.1.0', filter: { index: 3, bank: 1, channel: 0 } },
  { chip: 1, channel: 1, gain: 0.6, target: 'filter.1.1', filter: { index: 4, bank: 1, channel: 1 } },
  { chip: 1, channel: 2, gain: 0.6, target: 'filter.1.2', filter: { index: 5, bank: 1, channel: 2 } },
]);
assert.ok(graph.nodes.some(node =>
  node.label === 'Handler' &&
  node.props.method === 'set_filter' &&
  String(node.props.sourceBody).includes('filter_rc_set_RC')));

const tileInfo = compiled.handlers.find(handler => handler.method === 'get_tile_info')?.program;
assert.ok(tileInfo);
for (const [attribute, expectedCategory] of [[0x00, 0], [0x10, 1]]) {
  let code = -1;
  const tileinfo = {
    category: -1,
    set: (_gfx: number, value: number) => { code = value; },
  };
  executeGeneratedProgram(
    tileInfo,
    {
      members: {
        m_colorram: Uint8Array.of(attribute),
        m_videoram: Uint8Array.of(0x12),
      },
    },
    {
      tile_index: 0,
      tileinfo,
    },
  );
  assert.equal(tileinfo.category, expectedCategory);
  assert.equal(code, 0x12);
}

console.log('timeplt.spec: game token and MAME-source video contract passed');
