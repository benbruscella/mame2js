import assert from 'node:assert/strict';
import * as ts from 'typescript';
import {
  compileNamcoWsg,
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
    "import { executeGeneratedProgram } from './generated-handler.ts';",
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

console.log('audio-compiler.spec: 7 passed');
