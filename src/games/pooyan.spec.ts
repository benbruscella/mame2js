import assert from 'node:assert/strict';
import { executeGeneratedProgram } from '../runtime/generated-handler.ts';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { pooyan } from './pooyan.ts';
import {
  assertGameContract,
  gameSourceGraph,
  mameSourceRoot,
} from './test-support.ts';

assertGameContract(pooyan);
const mameSrc = mameSourceRoot();
const graph = gameSourceGraph(pooyan);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === pooyan.machine.className &&
  node.props.name === pooyan.machine.name);

assert.ok(machine);
const compiled = compileMameVideo(graph, mameSrc, machine.id);
assert.ok(compiled, 'Pooyan MAME video source must lower to executable video IR');
assert.ok(compiled.plan.palette);
assert.equal(compiled.plan.tilemaps[0]?.mapper, 'TILEMAP_SCAN_ROWS');
assert.deepEqual(compiled.plan.palette.banks, [
  { penOffset: 0, colorOr: 0x10, lookupOffset: 0x20, lookupCount: 0x100 },
  { penOffset: 0x100, colorOr: 0, lookupOffset: 0x120, lookupCount: 0x100 },
]);
assert.deepEqual(
  compiled.plan.palette.channels.map(channel => channel.resistances),
  [[1000, 470, 220], [1000, 470, 220], [470, 220]],
);
assert.ok(compiled.handlers.some(handler =>
  handler.method === 'draw_sprites' && handler.program?.diagnostics.length === 0));

const tileInfo = compiled.handlers.find(handler =>
  handler.method === 'get_bg_tile_info')?.program;
assert.ok(tileInfo);
for (const [attribute, expectedFlags] of [[0x40, 1], [0x80, 2], [0xc0, 3]]) {
  let actualFlags = -1;
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
      tileinfo: {
        set: (_gfx: number, _code: number, _color: number, flags: number) => {
          actualFlags = flags;
        },
      },
    },
  );
  assert.equal(actualFlags, expectedFlags);
}

console.log('pooyan.spec: game token and MAME-source video contract passed');
