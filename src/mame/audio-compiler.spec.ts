import assert from 'node:assert/strict';
import * as ts from 'typescript';
import {
  compileAy8910,
  compileNamcoWsg,
  generatedAy8910WorkletSource,
  generatedNamcoWsgWorkletSource,
} from './audio-compiler.ts';
import type { MameHardwareDefinition } from './hardware.ts';

const definition: MameHardwareDefinition = {
  type: 'NAMCO_WSG',
  className: 'namco_wsg_device',
  shortName: 'namco_wsg',
  description: 'Namco WSG',
  sourceFile: 'src/devices/sound/namco.cpp',
  sourceLine: 52,
  sourceColumn: 1,
  macro: 'DEFINE_DEVICE_TYPE',
};
const mameSrc = process.env.MAME_SRC ?? '../mame';
const plan = compileNamcoWsg(mameSrc, definition);
assert.equal(plan.internalRate, 192_000);
assert.equal(plan.voices, 3);
assert.equal(plan.registerCount, 0x20);

const source = generatedNamcoWsgWorkletSource(plan)
  .replace(
    "import { executeGeneratedProgram } from '../../core/generated-handler.js';",
    'const executeGeneratedProgram = () => ({ returned: false });',
  );
const javaScript = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;

const globals = globalThis as Record<string, unknown>;
globals.AudioWorkletProcessor = class {};
globals.sampleRate = 48_000;
globals.registerProcessor = () => {};
const module = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
) as {
  GeneratedNamcoWsgCore: new (
    waveRom: Uint8Array,
    clock: number,
  ) => { sampleRate: number };
};
const core = new module.GeneratedNamcoWsgCore(new Uint8Array(0x100), 96_000);

// MAME doubles Pac-Man's 96 kHz device clock to its 192 kHz internal stream.
// Keeping the 16-bit phase divider while rendering at 96 kHz lowers every
// oscillator by exactly one octave.
assert.equal(core.sampleRate, 192_000);
assert.equal(
  0x1000 * core.sampleRate / (2 ** 16 * 32),
  375,
);
assert.match(source, /this\.step = this\.core\.sampleRate \/ sampleRate/);

const ayPlan = compileAy8910(mameSrc, {
  ...definition,
  type: 'AY8910',
  className: 'ay8910_device',
  sourceFile: 'src/devices/sound/ay8910.cpp',
});
assert.equal(ayPlan.clockDivider, 8);
assert.equal(ayPlan.envelopeMask, 0x0f);
assert.equal(ayPlan.envelopeStep, 2);
assert.deepEqual(ayPlan.noiseTaps, [0, 3]);
assert.deepEqual(ayPlan.readMasks.slice(0, 8), [
  0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff,
]);
assert.equal(ayPlan.volumeTable.length, 16);
assert.deepEqual(ayPlan.filterTypes, { lowpass3r: 0, lowpass: 2, highpass: 3, ac: 4 });

const aySource = generatedAy8910WorkletSource(ayPlan);
const ayJavaScript = ts.transpileModule(aySource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const ayModule = await import(
  `data:text/javascript;base64,${Buffer.from(ayJavaScript).toString('base64')}`
) as {
  GeneratedAy8910Core: new (clock: number) => {
    nativeRate: number;
    write(register: number, data: number): void;
    sample(): number;
  };
  GeneratedAy8910Mixer: new (
    clock: number,
    chips: number,
    outputRate: number,
    routes?: { chip: number; channel: number; gain: number; target: string; filter?: {
      index: number; bank: number; channel: number;
    } }[],
  ) => { write(offset: number, data: number): void; sample(): number };
  GeneratedAy8910FrameRenderer: new (
    mixer: { write(offset: number, data: number): void; sample(): number },
    outputRate: number,
    refresh: number,
  ) => { render(writes: { offset: number; data: number; frac?: number }[]): Float32Array };
};
const ay = new ayModule.GeneratedAy8910Core(1_789_772);
assert.equal(ay.nativeRate, 1_789_772 / 8);
ay.write(0, 1);
ay.write(7, 0x3e);
ay.write(8, 0x0f);
assert.ok(Array.from({ length: 64 }, () => ay.sample()).some(sample => sample !== 0));

const unfiltered = new ayModule.GeneratedAy8910Mixer(1_789_772, 1, 48_000);
const filtered = new ayModule.GeneratedAy8910Mixer(1_789_772, 1, 48_000, [{
  chip: 0, channel: 0, gain: 1, target: 'filter.0.0',
  filter: { index: 0, bank: 0, channel: 0 },
}]);
for (const mixer of [unfiltered, filtered]) {
  mixer.write(0, 1);
  mixer.write(7, 0x3e);
  mixer.write(8, 0x0f);
}
const filterBase = 0x100;
[0, 1000, 5100, 0, 220000e-12].forEach((value, index) =>
  filtered.write(filterBase + index, value));
const raw = Array.from({ length: 256 }, () => unfiltered.sample());
const lowpass = Array.from({ length: 256 }, () => filtered.sample());
const variation = (values: number[]) => values.slice(1)
  .reduce((sum, value, index) => sum + Math.abs(value - values[index]!), 0);
assert.ok(variation(lowpass) < variation(raw));

const timedMixer = new ayModule.GeneratedAy8910Mixer(1_789_772, 1, 48_000);
const frameRenderer = new ayModule.GeneratedAy8910FrameRenderer(timedMixer, 48_000, 60);
const timed = frameRenderer.render([
  { offset: 7, data: 0x3f, frac: 0 },
  { offset: 8, data: 0x0f, frac: 0.5 },
]);
assert.equal(timed.length, 800);
assert.ok(timed.slice(0, 400).every(sample => sample === 0));
assert.ok(timed.slice(400).some(sample => sample !== 0));
assert.match(aySource, /write\.frac/);

console.log('audio-compiler.spec: 23 passed');
