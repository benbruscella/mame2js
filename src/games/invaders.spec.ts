import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import {
  compileDiscreteSn76477,
  generatedDiscreteSn76477WorkletSource,
} from '../mame/audio-compiler.ts';
import { compileMameI8080 } from '../mame/cpu-compiler.ts';
import { compileMameDevice } from '../mame/device-compiler.ts';
import { deviceDefinitionsFromSource } from '../mame/hardware.ts';
import { compileMameVideo } from '../mame/video-compiler.ts';
import { invaders } from './invaders.ts';
import {
  assertGameContract,
  gameSourceGraph,
  mameSourceRoot,
} from './test-support.ts';

assertGameContract(invaders);
const mameSrc = mameSourceRoot();
const graph = gameSourceGraph(invaders);
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === invaders.machine.className &&
  node.props.name === invaders.machine.name);
assert.ok(machine);

const customHandlers = graph.nodes.filter(node =>
  node.label === 'Handler' &&
  String(node.props.ownerClass) === 'invaders_state' &&
  /^(?:invaders_in[012]_control_r|invaders_sw5_r|invaders_sw6_sw7_r)$/.test(
    String(node.props.method),
  ));
assert.equal(customHandlers.length, 5);
assert.ok(graph.edges.some(edge =>
  edge.from === 'inputs:invaders/IN1/f4' &&
  edge.rel === 'CALLS_HANDLER' &&
  edge.to === 'handler:invaders_state.invaders_in1_control_r'));
assert.deepEqual(
  customHandlers.find(node => node.props.method === 'invaders_in1_control_r')
    ?.props.inputMembers,
  ['m_player_controls=CONTP1,CONTP2'],
);
assert.match(
  String(customHandlers.find(node => node.props.method === 'invaders_sw6_sw7_r')
    ?.props.sourceBody),
  /ioport\("SW6SW7"\)/,
);

const video = compileMameVideo(graph, mameSrc, machine.id);
assert.ok(video, 'Invaders MAME bitmap source must lower to executable video IR');
assert.deepEqual(video.plan.bitmap, {
  member: 'm_main_ram',
  rowStart: 32,
  rows: 224,
  bytesPerRow: 32,
  xOffset: 4,
  lsbFirst: true,
  black: 0xff000000,
  white: 0xffffffff,
  source: {
    file: 'src/mame/midw8080/mw8080bw_v.cpp',
    line: 14,
    column: 1,
  },
});

const cpu = compileMameI8080(mameSrc);
assert.equal(cpu.summary.opcodes, 256);
assert.equal(cpu.summary.compiledOpcodes, 256);
assert.equal(cpu.summary.diagnostics, 0);
assert.ok(cpu.step && !cpu.step.diagnostics.length);

const machineSource = 'src/devices/machine/mb14241.cpp';
const machineText = readFileSync(join(mameSrc, machineSource), 'utf8');
const shifterDefinition = deviceDefinitionsFromSource(machineSource, machineText)
  .find(definition => definition.type === 'MB14241');
assert.ok(shifterDefinition);
const shifter = compileMameDevice(mameSrc, shifterDefinition);
assert.equal(shifter.summary.methods, shifter.summary.compiledMethods);
assert.equal(shifter.summary.diagnostics, 0);

const audioSource = 'src/mame/midw8080/mw8080bw_a.cpp';
const audioText = readFileSync(join(mameSrc, audioSource), 'utf8');
const audioDefinition = deviceDefinitionsFromSource(audioSource, audioText)
  .find(definition => definition.type === 'INVADERS_AUDIO');
assert.ok(audioDefinition);
const audio = compileDiscreteSn76477(mameSrc, audioDefinition);
assert.deepEqual(audio.ports, [
  { method: 'p1_w', offset: 0 },
  { method: 'p2_w', offset: 1 },
]);
assert.deepEqual(audio.lfsr, {
  clock: 7515,
  bits: 17,
  reset: 0x1ffff,
  tap0: 4,
  tap1: 16,
  outputBit: 12,
});
assert.deepEqual(audio.voices.map(voice => voice.model), [
  'warble',
  'parallel-555',
  'gated-555',
  'swept-square',
  'filtered-noise',
  'swept-square',
]);
assert.equal(audio.sn76477.vcoResistance, 8200);
assert.equal(audio.sn76477.slfResistance, 120_000);

const source = generatedDiscreteSn76477WorkletSource(audio);
const javaScript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const globals = globalThis as Record<string, unknown>;
globals.AudioWorkletProcessor = class {};
globals.sampleRate = 48_000;
globals.registerProcessor = () => {};
const generated = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
) as {
  GeneratedDiscreteAudioCore: new (rate: number) => {
    write(offset: number, data: number): void;
    render(output: Float32Array): void;
  };
};
const core = new generated.GeneratedDiscreteAudioCore(48_000);
core.write(0, 0x22);
const samples = new Float32Array(4096);
core.render(samples);
assert.ok(samples.some(sample => sample !== 0));
assert.ok(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1));

console.log('invaders.spec: CPU, bitmap, shifter and synthesized audio lowering passed');
