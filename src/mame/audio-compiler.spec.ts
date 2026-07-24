import assert from 'node:assert/strict';
import * as ts from 'typescript';
import {
  compileAy8910,
  compileMameSpeakerFilter,
  compileDiscreteMixer,
  compileMsm5205,
  compileNamco54Discrete,
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
assert.deepEqual(compileMameSpeakerFilter(mameSrc), {
  type: 'highpass',
  frequency: 20,
  q: 0.7071067,
  source: {
    file: 'src/emu/audio_effects/filter.cpp',
    line: 67,
  },
});
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
interface WorkletHarness {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let registeredWsgProcessor: (new () => WorkletHarness) | undefined;
globals.AudioWorkletProcessor = class {
  readonly port = { onmessage: null };
};
globals.sampleRate = 48_000;
globals.registerProcessor = (
  name: string,
  processor: new () => WorkletHarness,
) => {
  if (name === 'wsg') registeredWsgProcessor = processor;
};
const module = await import(
  `data:text/javascript;base64,${Buffer.from(javaScript).toString('base64')}`
) as {
  GeneratedNamcoWsgCore: new (
    waveRom: Uint8Array,
    clock: number,
    auxiliary?: ReturnType<typeof compileNamco54Discrete>,
  ) => {
    sampleRate: number;
    writeDiscrete(channel: number, data: number): void;
    render(output: Float32Array): void;
    renderFrame(
      output: Float32Array,
      writes: { offset: number; data: number; frac?: number; method?: string }[],
    ): void;
  };
  GeneratedNamcoWsgFrameRenderer: new (
    core: {
      sampleRate: number;
      renderFrame(
        output: Float32Array,
        writes: { offset: number; data: number; frac?: number; method?: string }[],
      ): void;
    },
    refresh: number,
  ) => {
    render(
      writes: { offset: number; data: number; frac?: number; method?: string }[],
    ): Float32Array;
  };
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

const galagaDiscrete = compileNamco54Discrete(
  mameSrc,
  'src/mame/namco/galaga.cpp',
  'galaga_discrete',
);
assert.deepEqual(galagaDiscrete.channels.map(channel => channel.input), [2, 1, 0]);
assert.equal(galagaDiscrete.source.file, 'src/mame/namco/galaga_a.cpp');
assert.deepEqual(
  galagaDiscrete.channels.map(channel => Math.round(channel.frequency)),
  [2_521, 450, 167],
  '54XX filters must use MAME multiple-feedback resistance and capacitance equations',
);
assert.deepEqual(
  galagaDiscrete.channels.map(channel => Number(channel.q.toFixed(2))),
  [1.74, 2.12, 2.47],
);
assert.equal(galagaDiscrete.levels[0], 0);
assert.equal(galagaDiscrete.levels[15], 1);
const galagaAudio = new module.GeneratedNamcoWsgCore(
  new Uint8Array(0x100),
  96_000,
  galagaDiscrete,
);
galagaAudio.writeDiscrete(0, 0x0f);
const galagaSamples = new Float32Array(4096);
galagaAudio.render(galagaSamples);
assert.ok(galagaSamples.some(sample => sample !== 0));
const timedGalagaAudio = new module.GeneratedNamcoWsgCore(
  new Uint8Array(0x100),
  96_000,
  galagaDiscrete,
);
const galagaRenderer = new module.GeneratedNamcoWsgFrameRenderer(timedGalagaAudio, 60);
const timedGalagaSamples = galagaRenderer.render([
  { offset: 0, data: 0x0f, frac: 0, method: 'discrete' },
  { offset: 0, data: 0, frac: 0.5, method: 'discrete' },
]);
assert.equal(timedGalagaSamples.length, 3_200);
assert.ok(timedGalagaSamples.slice(0, 1_600).some(sample => sample !== 0));
assert.ok(
  timedGalagaSamples.slice(0, 1_600).some((sample, index) =>
    sample !== timedGalagaSamples[index + 1]!),
  'timestamped 54XX transitions must survive frame rendering',
);
assert.match(source, /write\.frac/);
assert.ok(registeredWsgProcessor);
const processor = new registeredWsgProcessor();
processor.port.onmessage?.({
  data: {
    type: 'init',
    waveRom: new Uint8Array(0x100),
    clock: 96_000,
    refresh: 60,
    auxiliary: galagaDiscrete,
  },
});
processor.port.onmessage?.({
  data: {
    type: 'batch',
    writes: [
      { offset: 0, data: 0x0f, frac: 0, method: 'discrete' },
      { offset: 0, data: 0, frac: 0.5, method: 'discrete' },
    ],
  },
});
const workletSamples = new Float32Array(800);
for (let offset = 0; offset < workletSamples.length; offset += 128) {
  const block = workletSamples.subarray(offset, Math.min(offset + 128, workletSamples.length));
  assert.equal(processor.process([], [[block]]), true);
}
assert.ok(
  workletSamples.some(sample => sample !== 0),
  'generated WSG worklet must preserve timestamped 54XX transitions',
);

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

const msmPlan = compileMsm5205(mameSrc, {
  ...definition,
  type: 'MSM5205',
  className: 'msm5205_device',
  sourceFile: 'src/devices/sound/msm5205.cpp',
});
assert.deepEqual(msmPlan.indexShift, [-1, -1, -1, -1, 2, 4, 6, 8]);
assert.equal(msmPlan.diffLookup.length, 49 * 16);
assert.equal(msmPlan.modes.S96_4B, 4);
assert.equal(msmPlan.maximumSignal, 2047);
assert.equal(msmPlan.minimumSignal, -2048);

const aySource = generatedAy8910WorkletSource(ayPlan, msmPlan);
const ayOnlySource = generatedAy8910WorkletSource(ayPlan);
assert.match(
  ayOnlySource,
  /const msmPlan: GeneratedMsm5205PlanData \| null = null;/,
  'AY-only worklets must retain the optional MSM plan type instead of narrowing it to never',
);
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
    auxiliaryDevices?: {
      type: string;
      deviceTag: string;
      clock: number;
      initialMode?: string;
      gain: number;
      target: string;
      writeMethods: string[];
    }[],
  ) => { write(offset: number, data: number, method?: string): void; sample(): number };
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

const composite = new ayModule.GeneratedAy8910Mixer(
  894_886.25,
  2,
  48_000,
  [
    { chip: 0, channel: -1, gain: 1, target: 'filtermix' },
    { chip: 1, channel: -1, gain: 1, target: 'filtermix' },
  ],
  [{
    type: 'MSM5205',
    deviceTag: 'msm1',
    clock: 384_000,
    initialMode: 'S96_4B',
    gain: 1,
    target: 'filtermix',
    writeMethods: ['data_w', 'reset_w', 'playmode_w'],
  }],
);
composite.write(0, 7, 'msm1.data_w');
for (let index = 0; index < 16; index++) composite.write(0, 1, 'msm1.vck');
assert.notEqual(composite.sample(), 0, 'routed MSM5205 stream must reach the AY mixer');

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

const aliased = new ayModule.GeneratedAy8910Mixer(1_789_772, 1, 48_000);
const audible = new ayModule.GeneratedAy8910Mixer(1_789_772, 1, 48_000);
for (const [mixer, period] of [[aliased, 1], [audible, 16]] as const) {
  mixer.write(0, period);
  mixer.write(7, 0x3e);
  mixer.write(8, 0x0f);
}
const rms = (values: number[]) => Math.sqrt(
  values.reduce((sum, value) => sum + value * value, 0) / values.length,
);
const aliasedRms = rms(Array.from({ length: 4096 }, () => aliased.sample()).slice(256));
const audibleRms = rms(Array.from({ length: 4096 }, () => audible.sample()).slice(256));
assert.ok(
  aliasedRms < audibleRms * 0.1,
  `native AY period 1 folded into 48 kHz output (${aliasedRms} vs ${audibleRms})`,
);

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

console.log('audio-compiler.spec: generated audio cores passed');
