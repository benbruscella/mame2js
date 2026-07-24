import assert from 'node:assert/strict';
import { lowerAuxiliaryAudioDevices } from '../gen/emit-machine.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';
import {
  compileMameMcs48,
  normalizeMameExecutionSource,
} from '../mame/cpu-compiler.ts';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { executeGeneratedProgram } from '../runtime/generated-handler.ts';
import { junofrst } from './junofrst.ts';
import {
  assertGameContract,
  gameSourceGraph,
  mameSourceRoot,
} from './test-support.ts';

assertGameContract(junofrst);
const mameSrc = mameSourceRoot();
const graph = gameSourceGraph(junofrst);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === junofrst.machine.className &&
  node.props.name === junofrst.machine.name);
assert.ok(machine);

const devices = graph.nodes
  .filter(node => node.label === 'Device')
  .map(node => ({
    id: node.id,
    tag: String(node.props.tag),
    type: String(node.props.type),
    ...(typeof node.props.clock === 'number' ? { clock: node.props.clock } : {}),
  }));
for (const type of ['KONAMI1', 'Z80', 'I8039', 'AY8910', 'DAC_8BIT_R2R']) {
  assert.ok(devices.some(device => device.type === type), `Juno First must extract ${type}`);
}

const bank = graph.nodes.find(node =>
  node.label === 'MemoryBank' && node.props.tag === 'mainbank');
assert.equal(bank?.props.member, 'm_mainbank');
assert.equal(bank?.props.startEntry, 0);
assert.equal(bank?.props.entries, 16);
assert.equal(bank?.props.region, 'maincpu');
assert.equal(bank?.props.offset, 0x10000);
assert.equal(bank?.props.stride, 0x1000);
assert.equal(bank?.props.sourceFile, 'src/mame/konami/junofrst.cpp');

assert.deepEqual(lowerAuxiliaryAudioDevices(graph, devices), [{
  type: 'DAC_8BIT_R2R',
  deviceTag: 'dac',
  clock: 0,
  gain: 0.25,
  target: 'speaker',
  writeMethods: ['data_w'],
}]);

const mcs48 = compileMameMcs48(mameSrc);
assert.equal(mcs48.type, 'I8039');
assert.equal(mcs48.summary.opcodes, 256);
assert.equal(mcs48.summary.compiledOpcodes, 256);
assert.equal(mcs48.summary.compiledMethods, mcs48.summary.methods);
assert.equal(mcs48.summary.diagnostics, 0);

const video = compileMameVideo(graph, mameSrc, machine.id);
assert.ok(video, 'Juno First MAME video source must lower to executable bitmap IR');
assert.equal(video.plan.bitmap?.member, 'm_videoram');
assert.equal(video.plan.bitmap?.rowStart, 16);
assert.equal(video.plan.bitmap?.rows, 224);
assert.equal(video.plan.bitmap?.bytesPerRow, 128);
assert.equal(video.plan.bitmap?.bitsPerPixel, 4);
assert.equal(video.plan.bitmap?.paletteRam?.entries, 16);
assert.deepEqual(video.plan.initialState.m_blitterdata, [0, 0, 0, 0]);

const blitter = graph.nodes.find(node =>
  node.label === 'Handler' &&
  node.props.ownerClass === 'junofrst_state' &&
  node.props.method === 'blitter_w');
assert.equal(typeof blitter?.props.sourceBody, 'string');
const blitterProgram = compileMameHandler(
  normalizeMameExecutionSource(String(blitter!.props.sourceBody)),
);
assert.deepEqual(blitterProgram.diagnostics, []);
const videoRam = new Uint8Array(0x8000);
executeGeneratedProgram(
  blitterProgram,
  {
    members: {
      m_blitterdata: [0, 0, 0, 0],
      m_blitrom: Uint8Array.of(0xa0),
      m_videoram: videoRam,
    },
  },
  { offset: 3, data: 1 },
);
assert.equal(videoRam[0] & 0x0f, 0x0a, 'source-derived blitter must copy ROM pixels');

console.log('junofrst.spec: bank, I8039, bitmap, blitter and DAC lowering passed');
