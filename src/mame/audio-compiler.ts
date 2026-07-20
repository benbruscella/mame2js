import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { GeneratedHandlerProgram } from '../runtime/generated-machine.ts';
import { parseMameAst, splitMameArgs } from './ast.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';
import { compileMameHandler } from './handler-ir.ts';
import type { MameHardwareDefinition } from './hardware.ts';

export interface GeneratedNamcoWsgPlan {
  schemaVersion: 1;
  type: 'NAMCO_WSG';
  className: string;
  voices: number;
  packed: boolean;
  registerCount: number;
  internalRate: number;
  mixResolution: number;
  writeMethod: string;
  writeProgram: GeneratedHandlerProgram;
  sourceFiles: string[];
  source: { file: string; line: number };
}

export interface GeneratedAy8910Plan {
  schemaVersion: 1;
  type: 'AY8910';
  className: string;
  channels: number;
  registerCount: number;
  clockDivider: number;
  envelopeMask: number;
  envelopeStep: number;
  noiseTaps: [number, number];
  readMasks: number[];
  volumeTable: number[];
  sourceFiles: string[];
  source: { file: string; line: number };
}

export function compileAy8910(
  mameSrc: string,
  definition: MameHardwareDefinition,
): GeneratedAy8910Plan {
  const cppFile = definition.sourceFile;
  const headerFile = relative(
    mameSrc,
    join(dirname(join(mameSrc, cppFile)), `${basename(cppFile, extname(cppFile))}.h`),
  );
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const clockDivider = Number(/stream_alloc\([^;]+master_clock\s*\/\s*(\d+)\)/.exec(cpp)?.[1]);
  const ayType = /if\s*\(\s*psg_type\s*==\s*PSG_TYPE_AY\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(cpp)?.[1] ?? '';
  const envelopeMask = Number(/m_env_step_mask\s*=\s*(0x[\da-f]+|\d+)/i.exec(ayType)?.[1]);
  const envelopeStep = Number(/m_step\s*=\s*(0x[\da-f]+|\d+)/i.exec(ayType)?.[1]);
  const noise = [...header.matchAll(
    /m_rng\s*=\s*\(m_rng\s*>>\s*1\)\s*\|\s*\(\(BIT\(m_rng,\s*(\d+)\)\s*\^\s*BIT\(m_rng,\s*(\d+)\)\)/g,
  )].at(-1);
  const masks = [...cpp.matchAll(
    /if\s*\(\s*chip_type\s*==\s*AY8910\s*\)[\s\S]*?mask\[0x10\]\s*=\s*\{([^}]+)\}/g,
  )][0];
  const params = [...cpp.matchAll(
    /static\s+const\s+ay8910_device::ay_ym_param\s+ay8910_param\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\{([^}]+)\}/g,
  )].at(-1);
  if (!clockDivider || !envelopeMask || !envelopeStep || !noise || !masks || !params) {
    throw new Error('AY8910: MAME source shape is not executable by the audio compiler');
  }
  const resistances = splitMameArgs(params[4]!).map(Number);
  const rDown = Number(params[1]);
  const rUp = Number(params[2]);
  const levels = Number(params[3]);
  const load = 1000;
  const raw = resistances.slice(0, levels).map((resistance, index) => {
    let total = 1 / rDown + 1 / load + 1 / resistance;
    let high = 1 / resistance;
    if (index !== 0) {
      total += 1 / rUp;
      high += 1 / rUp;
    }
    return high / total;
  });
  const minimum = Math.min(...raw);
  const maximum = Math.max(...raw);
  const volumeTable = raw.map(value =>
    (((value - minimum) / (maximum - minimum)) - 0.25) * 0.5);
  return {
    schemaVersion: 1,
    type: 'AY8910',
    className: definition.className,
    channels: 3,
    registerCount: 16,
    clockDivider,
    envelopeMask,
    envelopeStep,
    noiseTaps: [Number(noise[1]), Number(noise[2])],
    readMasks: splitMameArgs(masks[1]!).map(value => Number(value)),
    volumeTable,
    sourceFiles: [cppFile, headerFile],
    source: {
      file: cppFile,
      line: cpp.slice(0, cpp.indexOf('void ay8910_device::sound_stream_update')).split('\n').length,
    },
  };
}

export function compileNamcoWsg(
  mameSrc: string,
  definition: MameHardwareDefinition,
): GeneratedNamcoWsgPlan {
  const cppFile = definition.sourceFile;
  const headerFile = relative(
    mameSrc,
    join(dirname(join(mameSrc, cppFile)), `${basename(cppFile, extname(cppFile))}.h`),
  );
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const ast = parseMameAst([
    { file: cppFile, source: cpp },
    { file: headerFile, source: header },
  ]);
  const inheritance = new RegExp(
    `class\\s+${definition.className}\\s*:\\s*public\\s+namco_audio_device\\s*<\\s*(\\d+)\\s*,\\s*(true|false)\\s*>`,
  ).exec(header);
  const write = ast.units
    .flatMap(unit => unit.functions)
    .find(fn => fn.className === definition.className && fn.name === 'pacman_sound_w');
  const start = ast.units
    .flatMap(unit => unit.functions)
    .find(fn => fn.className === definition.className && fn.name === 'device_start');
  const internalRate = Number(
    /static\s+constexpr\s+uint32_t\s+INTERNAL_RATE\s*=\s*(\d+)/.exec(cpp)?.[1],
  );
  const registerCount = Number(
    /make_unique_clear<uint8_t\[\]>\(\s*(0x[\da-f]+|\d+)\s*\)/i.exec(start?.body ?? '')?.[1],
  );
  if (!inheritance || !write || !internalRate || !registerCount) {
    throw new Error('NAMCO_WSG: MAME source shape is not executable by the audio compiler');
  }
  const voices = Number(inheritance[1]);
  const writeProgram = compileMameHandler(normalizeMameExecutionSource(write.body));
  if (writeProgram.diagnostics.length) {
    throw new Error(`NAMCO_WSG write lowering failed: ${writeProgram.diagnostics.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    type: 'NAMCO_WSG',
    className: definition.className,
    voices,
    packed: inheritance[2] === 'true',
    registerCount,
    internalRate,
    mixResolution: 128 * voices,
    writeMethod: write.name,
    writeProgram,
    sourceFiles: [cppFile, headerFile],
    source: { file: write.span.file, line: write.span.line },
  };
}

export function generatedNamcoWsgWorkletSource(plan: GeneratedNamcoWsgPlan): string {
  return `// GENERATED from ${plan.source.file}:${plan.source.line} and ${plan.sourceFiles[1]}; do not edit.
// Register behavior is executable MAME handler IR. Mixer constants and waveform
// addressing are lowered from namco_audio_device<${plan.voices}, ${plan.packed}>.
import { executeGeneratedProgram } from './generated-handler.ts';
import type { GeneratedHandlerProgram } from './generated-machine.ts';

const plan = ${JSON.stringify(plan, null, 2)} as unknown as {
  voices: number;
  packed: boolean;
  registerCount: number;
  internalRate: number;
  mixResolution: number;
  writeProgram: GeneratedHandlerProgram;
};

interface Voice {
  frequency: number;
  counter: number;
  volume: number[];
  waveform_select: number;
}
` + generatedNamcoWsgSuffix(plan);
}

export function generatedAy8910WorkletSource(plan: GeneratedAy8910Plan): string {
  return `// GENERATED from ${plan.source.file}:${plan.source.line} and ${plan.sourceFiles[1]}; do not edit.
// Register masks, resistor DAC curve, clock divider, envelope parameters and
// LFSR taps are extracted from the selected MAME AY-3-8910 implementation.
const plan = ${JSON.stringify(plan, null, 2)};

export class GeneratedAy8910Core {
  readonly nativeRate: number;
  private readonly regs = new Uint8Array(plan.registerCount);
  private readonly tonePeriod = [1, 1, 1];
  private readonly toneCount = [0, 0, 0];
  private readonly toneOutput = [0, 0, 0];
  private noiseCount = 0;
  private noisePrescale = 0;
  private rng = 1;
  private envelopePeriod = 0;
  private envelopeCount = 0;
  private envelopeStep = plan.envelopeMask;
  private envelopeAttack = 0;
  private envelopeHold = 0;
  private envelopeAlternate = 0;
  private envelopeHolding = false;

  constructor(clock: number) {
    this.nativeRate = clock / plan.clockDivider;
  }

  write(reg: number, data: number): void {
    reg &= plan.registerCount - 1;
    this.regs[reg] = data & 0xff;
    if (reg <= 5) {
      const channel = reg >> 1;
      this.tonePeriod[channel] = Math.max(
        1,
        this.regs[channel * 2] | ((this.regs[channel * 2 + 1] & 0x0f) << 8),
      );
    } else if (reg === 11 || reg === 12) {
      this.envelopePeriod = this.regs[11] | (this.regs[12] << 8);
    } else if (reg === 13) {
      const shape = data & plan.envelopeMask;
      this.envelopeAttack = shape & 0x04 ? plan.envelopeMask : 0;
      if (!(shape & 0x08)) {
        this.envelopeHold = 1;
        this.envelopeAlternate = this.envelopeAttack;
      } else {
        this.envelopeHold = shape & 1;
        this.envelopeAlternate = shape & 2;
      }
      this.envelopeStep = plan.envelopeMask;
      this.envelopeHolding = false;
      this.envelopeCount = 0;
    }
  }

  read(reg: number): number {
    reg &= plan.registerCount - 1;
    return this.regs[reg] & plan.readMasks[reg];
  }

  sample(): number {
    for (let channel = 0; channel < plan.channels; channel++) {
      if (++this.toneCount[channel] >= this.tonePeriod[channel]) {
        this.toneCount[channel] = 0;
        this.toneOutput[channel] ^= 1;
      }
    }
    const noisePeriod = Math.max(1, this.regs[6] & 0x1f);
    if (++this.noiseCount >= noisePeriod) {
      this.noiseCount = 0;
      this.noisePrescale ^= 1;
      if (!this.noisePrescale) {
        const input =
          ((this.rng >> plan.noiseTaps[0]) ^ (this.rng >> plan.noiseTaps[1])) & 1;
        this.rng = (this.rng >>> 1) | (input << 16);
      }
    }
    if (!this.envelopeHolding) {
      const period = Math.max(1, this.envelopePeriod * plan.envelopeStep);
      if (++this.envelopeCount >= period) {
        this.envelopeCount = 0;
        if (--this.envelopeStep < 0) {
          if (this.envelopeHold) {
            if (this.envelopeAlternate) this.envelopeAttack ^= plan.envelopeMask;
            this.envelopeHolding = true;
            this.envelopeStep = 0;
          } else {
            if (this.envelopeAlternate) this.envelopeAttack ^= plan.envelopeMask;
            this.envelopeStep &= plan.envelopeMask;
          }
        }
      }
    }
    const envelope = this.envelopeStep ^ this.envelopeAttack;
    const enable = this.regs[7];
    let mixed = 0;
    for (let channel = 0; channel < plan.channels; channel++) {
      const toneGate = this.toneOutput[channel] | ((enable >> channel) & 1);
      const noiseGate = (this.rng & 1) | ((enable >> (channel + 3)) & 1);
      const volume = this.regs[8 + channel];
      const level = volume & 0x10 ? envelope : volume & 0x0f;
      const amplitude = plan.volumeTable[level] - plan.volumeTable[0];
      mixed += (toneGate & noiseGate ? amplitude : -amplitude);
    }
    return mixed / plan.channels;
  }
}

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class GeneratedAy8910Processor extends AudioWorkletProcessor {
  private cores: GeneratedAy8910Core[] = [];
  private gains: number[] = [];
  private phases: number[] = [];
  private samples: number[] = [];
  private dac = 0;
  private dacGain = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        clock?: number;
        chips?: number;
        chipGains?: number[];
        dacGain?: number;
        offset?: number;
        data?: number;
        writes?: { offset: number; data: number }[];
      };
      if (message.type === 'init') {
        const count = Math.max(1, message.chips ?? 1);
        this.cores = Array.from(
          { length: count },
          () => new GeneratedAy8910Core(message.clock ?? 1_789_772),
        );
        this.gains = this.cores.map((_, index) => message.chipGains?.[index] ?? 1);
        this.phases = this.cores.map(() => 0);
        this.samples = this.cores.map(() => 0);
        this.dacGain = message.dacGain ?? 0;
      } else if (message.type === 'write') {
        this.apply(message.offset ?? 0, message.data ?? 0);
      } else if (message.type === 'batch') {
        for (const write of message.writes ?? []) this.apply(write.offset, write.data);
      }
    };
  }

  private apply(offset: number, data: number): void {
    if (offset === 0x80) {
      this.dac = ((data & 0xff) - 128) / 128;
      return;
    }
    if (offset >= 0x90) return;
    this.cores[offset >> 4]?.write(offset & 0x0f, data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;
    output.fill(0);
    const gainTotal = this.gains.reduce((sum, gain) => sum + gain, 0) || 1;
    for (let index = 0; index < output.length; index++) {
      let mixed = this.dac * this.dacGain;
      for (let chip = 0; chip < this.cores.length; chip++) {
        this.phases[chip] += this.cores[chip].nativeRate / sampleRate;
        while (this.phases[chip] >= 1) {
          this.phases[chip] -= 1;
          this.samples[chip] = this.cores[chip].sample();
        }
        mixed += this.samples[chip] * this.gains[chip] / gainTotal;
      }
      output[index] = Math.max(-1, Math.min(1, mixed));
    }
    for (let channel = 1; channel < (channels?.length ?? 0); channel++) {
      channels![channel]!.set(output);
    }
    return true;
  }
}

registerProcessor('ay8910', GeneratedAy8910Processor);
`;
}

function generatedNamcoWsgSuffix(plan: GeneratedNamcoWsgPlan): string {
  return `
export class GeneratedNamcoWsgCore {
  readonly sampleRate: number;
  private readonly waveRom: Uint8Array;
  private readonly voices: Voice[];
  private readonly soundregs = new Uint8Array(plan.registerCount);
  private enabled = true;
  private readonly fracBits: number;

  constructor(waveRom: Uint8Array, clock: number) {
    this.waveRom = waveRom;
    let nativeClock = clock;
    let clockMultiple = 0;
    while (nativeClock < plan.internalRate) {
      nativeClock *= 2;
      clockMultiple++;
    }
    this.sampleRate = nativeClock;
    this.fracBits = clockMultiple + 15;
    this.voices = Array.from({ length: plan.voices }, () => ({
      frequency: 0,
      counter: 0,
      volume: [0, 0, 0, 0],
      waveform_select: 0,
    }));
  }

  soundEnable(state: number): void {
    this.enabled = state !== 0;
  }

  write(offset: number, data: number): void {
    executeGeneratedProgram(
      plan.writeProgram,
      {
        members: {
          m_soundregs: this.soundregs,
          m_channel_list: this.voices,
          m_stream: { update: () => 0 },
        },
        constants: { MAX_VOICES: plan.voices },
      },
      { offset, data },
    );
  }

  render(out: Float32Array): void {
    out.fill(0);
    if (!this.enabled) return;
    for (const voice of this.voices) {
      const volume = voice.volume[0] ?? 0;
      if (!volume) continue;
      const waveBase = voice.waveform_select << 5;
      let counter = voice.counter >>> 0;
      for (let index = 0; index < out.length; index++) {
        const position = waveBase | ((counter >>> this.fracBits) & 0x1f);
        const byte = this.waveRom[(position >>> ${plan.packed ? 1 : 0}) & 0xff] ?? 0;
        const sample = ${plan.packed
          ? '((byte >> (((~position) & 1) << 2)) & 0x0f) - 8'
          : '(byte & 0x0f) - 8'};
        out[index] += sample * volume / plan.mixResolution;
        counter = (counter + voice.frequency) >>> 0;
      }
      voice.counter = counter;
    }
  }
}

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

const CHUNK = 256;

class GeneratedNamcoWsgProcessor extends AudioWorkletProcessor {
  private core: GeneratedNamcoWsgCore | null = null;
  private step = 1;
  private fraction = 0;
  private sample0 = 0;
  private sample1 = 0;
  private readonly native = new Float32Array(CHUNK);
  private nativePosition = CHUNK;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        waveRom?: Uint8Array;
        clock?: number;
        offset?: number;
        data?: number;
        writes?: { offset: number; data: number }[];
      };
      if (message.type === 'init') {
        const clock = message.clock ?? 96_000;
        this.core = new GeneratedNamcoWsgCore(
          message.waveRom ?? new Uint8Array(0x100),
          clock,
        );
        this.step = this.core.sampleRate / sampleRate;
        this.nativePosition = CHUNK;
      } else if (message.type === 'write') {
        this.apply(message.offset ?? 0, message.data ?? 0);
      } else if (message.type === 'batch') {
        for (const write of message.writes ?? []) this.apply(write.offset, write.data);
      }
    };
  }

  private apply(offset: number, data: number): void {
    if (offset < 0) this.core?.soundEnable(data);
    else this.core?.write(offset, data);
  }

  private nextNative(): number {
    if (this.nativePosition >= CHUNK) {
      this.core!.render(this.native);
      this.nativePosition = 0;
    }
    return this.native[this.nativePosition++]!;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;
    if (!this.core) {
      output.fill(0);
    } else {
      for (let index = 0; index < output.length; index++) {
        this.fraction += this.step;
        while (this.fraction >= 1) {
          this.fraction -= 1;
          this.sample0 = this.sample1;
          this.sample1 = this.nextNative();
        }
        output[index] = this.sample0 + (this.sample1 - this.sample0) * this.fraction;
      }
    }
    for (let channel = 1; channel < (channels?.length ?? 0); channel++) {
      channels![channel]!.set(output);
    }
    return true;
  }
}

registerProcessor('wsg', GeneratedNamcoWsgProcessor);
`;
}
