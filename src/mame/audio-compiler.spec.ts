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
const plan = compileNamcoWsg('../mame', definition);
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

const ayPlan = compileAy8910('../mame', {
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
};
const ay = new ayModule.GeneratedAy8910Core(1_789_772);
assert.equal(ay.nativeRate, 1_789_772 / 8);
ay.write(0, 1);
ay.write(7, 0x3e);
ay.write(8, 0x0f);
assert.ok(Array.from({ length: 64 }, () => ay.sample()).some(sample => sample !== 0));

console.log('audio-compiler.spec: 17 passed');
