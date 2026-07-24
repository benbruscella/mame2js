import assert from 'node:assert/strict';
import { lowerAudioRoutes } from '../gen/emit-machine.ts';
import { compileMameKonami1 } from '../mame/cpu-compiler.ts';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { executeGeneratedProgram } from '../runtime/generated-handler.ts';
import { rocnrope } from './rocnrope.ts';
import {
  assertGameContract,
  gameSourceGraph,
  mameSourceRoot,
} from './test-support.ts';

assertGameContract(rocnrope);
const mameSrc = mameSourceRoot();
const graph = gameSourceGraph(rocnrope);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === rocnrope.machine.className &&
  node.props.name === rocnrope.machine.name);
assert.ok(machine);

const devices = graph.nodes.filter(node => node.label === 'Device');
assert.ok(devices.some(node =>
  node.props.type === 'KONAMI1' && node.props.tag === 'maincpu'));
assert.ok(devices.some(node =>
  node.props.type === 'TIMEPLT_AUDIO' && node.props.tag === 'timeplt_audio'));

const cpu = compileMameKonami1(mameSrc);
assert.equal(cpu.type, 'KONAMI1');
assert.equal(cpu.summary.compiledOpcodes, 768);
assert.equal(cpu.summary.diagnostics, 0);
assert.ok(cpu.opcodeDecrypt);

const video = compileMameVideo(graph, mameSrc, machine.id);
assert.ok(video, 'Roc’n Rope MAME video source must lower to executable video IR');
assert.equal(video.plan.tilemaps[0]?.mapper, 'TILEMAP_SCAN_ROWS');
assert.ok(video.handlers.every(handler => !handler.program?.diagnostics.length));
const tileInfo = video.handlers.find(
  handler => handler.method === 'get_bg_tile_info',
)?.program;
assert.ok(tileInfo);
let flags = -1;
executeGeneratedProgram(
  tileInfo,
  {
    members: {
      m_colorram: Uint8Array.of(0x60),
      m_videoram: Uint8Array.of(0x12),
    },
  },
  {
    tile_index: 0,
    tileinfo: {
      set: (_gfx: number, _code: number, _color: number, value: number) => {
        flags = value;
      },
    },
  },
);
assert.equal(flags, 3, 'Roc’n Rope terrain must preserve MAME tile flip flags');

const game = graph.nodes.find(node =>
  node.label === 'Game' && node.props.name === rocnrope.game);
assert.deepEqual(game?.props.romPatches, ['maincpu:28733:186']);

const ayDevices = devices
  .filter(node => node.props.type === 'AY8910')
  .map(node => ({ id: node.id, tag: String(node.props.tag) }));
assert.equal(ayDevices.length, 2);
assert.equal(lowerAudioRoutes(graph, ayDevices).length, 6);

console.log('rocnrope.spec: source-derived KONAMI1, video, ROM init and audio passed');
