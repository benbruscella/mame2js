import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { GeneratedHandlerProgram } from '../runtime/generated-machine.ts';
import { parseMameAst, splitMameArgs } from './ast.ts';
import { evalExpr } from '../kg/parse.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';
import { compileMameHandler } from './handler-ir.ts';
import type { MameHardwareDefinition } from './hardware.ts';
import {
  AY_FILTER_CONTROL_BASE,
  AY_FILTER_CONTROL_STRIDE,
} from '../runtime/audio-protocol.ts';

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
  filterTypes: {
    lowpass3r: number;
    lowpass: number;
    highpass: number;
    ac: number;
  };
  sourceFiles: string[];
  source: { file: string; line: number };
}

export interface GeneratedDiscreteAudioControl {
  port: number;
  mask: number;
}

export interface GeneratedDiscreteAudioVoice {
  outputNode: string;
  model:
    | 'parallel-555'
    | 'gated-555'
    | 'filtered-noise'
    | 'swept-square'
    | 'warble';
  control: GeneratedDiscreteAudioControl;
  mixerResistance: number;
  resistors: number[];
  capacitors: number[];
  toneHz?: number;
  triggerCapacitance?: number;
  parallelResistors?: number[];
  sourceMacro: string;
}

export interface GeneratedDiscreteSn76477Plan {
  schemaVersion: 1;
  type: 'DISCRETE_SN76477';
  deviceType: string;
  className: string;
  workletName: string;
  sampleRate: number;
  ports: { method: string; offset: number }[];
  amplifier: GeneratedDiscreteAudioControl;
  snControl: GeneratedDiscreteAudioControl;
  sn76477: {
    vcoResistance: number;
    vcoCapacitance: number;
    slfResistance: number;
    slfCapacitance: number;
    routeGain: number;
  };
  lfsr: {
    clock: number;
    bits: number;
    reset: number;
    tap0: number;
    tap1: number;
    outputBit: number;
  };
  voices: GeneratedDiscreteAudioVoice[];
  outputGain: number;
  discreteRouteGain: number;
  sourceFiles: string[];
  source: { file: string; line: number };
}

export function compileDiscreteSn76477(
  mameSrc: string,
  definition: MameHardwareDefinition,
): GeneratedDiscreteSn76477Plan {
  const cppFile = definition.sourceFile;
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const ast = parseMameAst([{ file: cppFile, source: cpp }]);
  const methods = ast.units.flatMap(unit => unit.functions)
    .filter(fn => fn.className === definition.className);
  const config = methods.find(fn => fn.name === 'device_add_mconfig');
  const ports = methods.filter(fn => fn.body.includes('m_discrete->write'));
  const prefix = definition.type.replace(/_AUDIO$/, '');
  const stem = definition.className.replace(/_audio_device$/, '');
  if (!config || ports.length < 1 || prefix === definition.type) {
    throw new Error(`${definition.type}: expected a MAME discrete audio device`);
  }

  const controls = new Map<string, GeneratedDiscreteAudioControl>();
  ports.forEach((method, port) => {
    const write = /m_discrete->write\(\s*\w+\(\s*(\w+)\s*,\s*\d+\s*\)\s*,\s*data\s*&\s*(0x[\da-f]+|\d+)\s*\)/gi;
    for (const match of method.body.matchAll(write)) {
      controls.set(match[1]!, { port, mask: Number(match[2]) });
    }
  });
  const snMethod = ports.findIndex(method => method.body.includes('m_sn->enable_w'));
  const snBit = Number(/m_sn->enable_w\(\s*BIT\(\s*~data\s*,\s*(\d+)\s*\)/.exec(
    ports[snMethod]?.body ?? '',
  )?.[1]);
  const ampMethod = ports.findIndex(method => method.body.includes('system_mute'));
  const ampBit = Number(/system_mute\(\s*!BIT\(\s*data\s*,\s*(\d+)\s*\)/.exec(
    ports[ampMethod]?.body ?? '',
  )?.[1]);

  const macros = preprocessorMacros(cpp);
  const mixerMacro = macros.get(`${prefix}_MIXER`);
  const mixerCall = mixerMacro && callArgs(mixerMacro, 'DISCRETE_MIXER6')[0];
  const mixerValues = structValues(cpp, `${stem}_mixer`);
  const mixerResistors = mixerValues.firstArray.map(analogValue);
  const outputGain = Number(callArgs(mixerMacro ?? '', 'DISCRETE_OUTPUT')[0]?.[1]);
  if (!mixerCall || mixerResistors.length < 6 || !outputGain) {
    throw new Error(
      `${definition.type}: MAME mixer topology is not recognized ` +
      `(call=${mixerCall?.length ?? 0}, resistors=${mixerResistors.length}, gain=${outputGain})`,
    );
  }
  const outputNodes = mixerCall.slice(2, 8).map(arg =>
    /\b([A-Z][A-Z0-9_]+_SND)\b/.exec(arg)?.[1] ?? '');
  const voices = outputNodes.map((outputNode, index): GeneratedDiscreteAudioVoice => {
    const entry = [...macros.entries()].find(([name, body]) =>
      name !== `${prefix}_MIXER` && body.includes(outputNode));
    if (!entry) throw new Error(`${definition.type}: no source topology emits ${outputNode}`);
    const [sourceMacro, body] = entry;
    const controlNode = /DISCRETE_INPUT\w*\s*\(\s*\w+\(\s*(\w+)/.exec(body)?.[1];
    const control = controlNode && controls.get(controlNode);
    if (!control) throw new Error(`${definition.type}: ${sourceMacro} has no mapped control`);
    const model = discreteVoiceModel(body);
    const concreteBody = body.replace(/_type##/g, stem);
    const references = [...concreteBody.matchAll(/&(\w+)/g)].map(match => match[1]!);
    const componentSource = [concreteBody, ...references.map(name => structValues(cpp, name).body)].join('\n');
    const resistors = componentValues(componentSource, 'RES');
    const capacitors = componentValues(componentSource, 'CAP');
    const oneShot = references.find(name => /1sht/i.test(name));
    const triggerCaps = oneShot
      ? componentValues(structValues(cpp, oneShot).body, 'CAP')
      : [];
    const compAdder = /DISCRETE_COMP_ADDER\([\s\S]*?&(\w+)\s*\)/.exec(concreteBody)?.[1];
    const fixedSquare = callArgs(concreteBody, 'DISCRETE_SQUAREWFIX')[0];
    const toneHz = fixedSquare ? requiredAnalog(fixedSquare[2]) : Number.NaN;
    return {
      outputNode,
      model,
      control,
      mixerResistance: mixerResistors[index]!,
      resistors,
      capacitors,
      ...(Number.isFinite(toneHz) && toneHz > 0 ? { toneHz } : {}),
      ...(triggerCaps[0] ? { triggerCapacitance: triggerCaps[0] } : {}),
      ...(compAdder ? { parallelResistors: resistorTable(cpp, compAdder) } : {}),
      sourceMacro,
    };
  });

  const lfsrValues = structValues(cpp, 'midway_lfsr').scalars;
  const noiseMacro = macros.get(`${prefix}_NOISE_GENERATOR`) ?? '';
  const noiseCall = callArgs(noiseMacro, 'DISCRETE_LFSR_NOISE')[0] ?? [];
  const snConfig = config.body;
  const snRoute = Number(/m_sn->add_route\([^,]+,[^,]+,\s*([\d.]+)/.exec(snConfig)?.[1]);
  const discreteRoute = Number(/m_discrete->add_route\([^,]+,[^,]+,\s*([\d.]+)/.exec(snConfig)?.[1]);
  const vco = callArgs(snConfig, 'set_vco_params')[0] ?? [];
  const slf = callArgs(snConfig, 'set_slf_params')[0] ?? [];
  if (
    snMethod < 0 || !Number.isInteger(snBit) || ampMethod < 0 || !Number.isInteger(ampBit) ||
    noiseCall.length < 4 || lfsrValues.length < 11 || vco.length < 3 || slf.length < 2 ||
    !Number.isFinite(snRoute) || !Number.isFinite(discreteRoute)
  ) {
    throw new Error(`${definition.type}: MAME DISCRETE/SN76477 source shape is incomplete`);
  }
  return {
    schemaVersion: 1,
    type: 'DISCRETE_SN76477',
    deviceType: definition.type,
    className: definition.className,
    workletName: definition.type.toLowerCase().replace(/_audio$/, ''),
    sampleRate: 48_000,
    ports: ports.map((method, offset) => ({ method: method.name, offset })),
    amplifier: { port: ampMethod, mask: 1 << ampBit },
    snControl: { port: snMethod, mask: 1 << snBit },
    sn76477: {
      vcoCapacitance: requiredAnalog(vco[1]),
      vcoResistance: requiredAnalog(vco[2]),
      slfCapacitance: requiredAnalog(slf[0]),
      slfResistance: requiredAnalog(slf[1]),
      routeGain: snRoute,
    },
    lfsr: {
      clock: requiredAnalog(noiseCall[3]),
      bits: lfsrValues[1]!,
      reset: lfsrValues[2]!,
      tap0: lfsrValues[3]!,
      tap1: lfsrValues[4]!,
      outputBit: lfsrValues[10]!,
    },
    voices,
    outputGain,
    discreteRouteGain: discreteRoute,
    sourceFiles: [cppFile],
    source: { file: config.span.file, line: config.span.line },
  };
}

function preprocessorMacros(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const head = /^\s*#define\s+(\w+)(?:\([^)]*\))?\s*(.*)$/.exec(lines[index]!);
    if (!head) continue;
    const body = [head[2]!];
    while (body.at(-1)?.trimEnd().endsWith('\\') && index + 1 < lines.length) {
      body.push(lines[++index]!);
    }
    result.set(head[1]!, body.join('\n').replace(/\\\s*\n/g, '\n'));
  }
  return result;
}

function callArgs(source: string, name: string): string[][] {
  const result: string[][] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('(', match.index);
    const close = matchingDelimiter(source, open, '(', ')');
    if (close < 0) break;
    const args = source.slice(open + 1, close)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    result.push(splitMameArgs(args));
    pattern.lastIndex = close + 1;
  }
  return result;
}

function structValues(source: string, name: string): {
  body: string;
  scalars: number[];
  firstArray: string[];
} {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(source);
  if (!match) return { body: '', scalars: [], firstArray: [] };
  const open = source.indexOf('{', match.index);
  const close = matchingDelimiter(source, open, '{', '}');
  if (close < 0) return { body: '', scalars: [], firstArray: [] };
  const body = source.slice(open + 1, close);
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const args = splitMameArgs(clean);
  const nested = args.find(value => value.trim().startsWith('{'));
  return {
    body,
    scalars: args.map(analogValue),
    firstArray: nested
      ? splitMameArgs(nested.trim().replace(/^\{/, '').replace(/\}\s*$/, ''))
      : [],
  };
}

function matchingDelimiter(
  source: string,
  open: number,
  opening: string,
  closing: string,
): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === opening) depth++;
    else if (source[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function analogValue(expression: string): number {
  let normalized = expression.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
  const units: [RegExp, number][] = [
    [/RES_K\(([^()]+)\)/g, 1e3],
    [/RES_M\(([^()]+)\)/g, 1e6],
    [/CAP_U\(([^()]+)\)/g, 1e-6],
    [/CAP_N\(([^()]+)\)/g, 1e-9],
    [/CAP_P\(([^()]+)\)/g, 1e-12],
  ];
  for (const [pattern, scale] of units) {
    normalized = normalized.replace(pattern, `(($1)*${scale})`);
  }
  return evalExpr(normalized) ?? Number.NaN;
}

function requiredAnalog(expression: string | undefined): number {
  const value = analogValue(expression ?? '');
  if (!Number.isFinite(value)) throw new Error(`unsupported MAME component expression: ${expression}`);
  return value;
}

function componentValues(source: string, kind: 'RES' | 'CAP'): number[] {
  const result: number[] = [];
  const pattern = kind === 'RES'
    ? /RES_[KM]\([^()]+\)/g
    : /CAP_[UNP]\([^()]+\)/g;
  for (const match of source.matchAll(pattern)) {
    const value = analogValue(match[0]);
    if (Number.isFinite(value)) result.push(value);
  }
  return result;
}

function resistorTable(source: string, name: string): number[] {
  return structValues(source, name).firstArray
    .map(analogValue)
    .filter(Number.isFinite);
}

function discreteVoiceModel(body: string): GeneratedDiscreteAudioVoice['model'] {
  if (body.includes('DISCRETE_COMP_ADDER') && body.includes('DISCRETE_555_ASTABLE')) {
    return 'parallel-555';
  }
  if (body.includes('DISCRETE_SQUAREWFIX') && body.includes('DISCRETE_555_ASTABLE')) {
    return 'gated-555';
  }
  if (body.includes('DISCRETE_RCFILTER') && body.includes('NOISE')) return 'filtered-noise';
  if (body.includes('DISCRETE_OP_AMP_ONESHOT')) return 'swept-square';
  if (body.includes('DISCRETE_OP_AMP_VCO')) return 'warble';
  throw new Error('unsupported MAME discrete voice topology');
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
  const filterCppFile = 'src/devices/sound/flt_rc.cpp';
  const filterHeaderFile = 'src/devices/sound/flt_rc.h';
  const filterCpp = readFileSync(join(mameSrc, filterCppFile), 'utf8');
  const filterHeader = readFileSync(join(mameSrc, filterHeaderFile), 'utf8');
  const clockDivider = Number(/stream_alloc\([^;]+master_clock\s*\/\s*(\d+)\)/.exec(cpp)?.[1]);
  const ayType =
    /if\s*\(\s*psg_type\s*==\s*PSG_TYPE_AY\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(cpp)?.[1] ?? '';
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
  const filterType = (name: string): number =>
    Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(filterHeader)?.[1]);
  const filterTypes = {
    lowpass3r: filterType('LOWPASS_3R'),
    lowpass: filterType('LOWPASS'),
    highpass: filterType('HIGHPASS'),
    ac: filterType('AC'),
  };
  const filterShape =
    filterCpp.includes('memory += (stream.get(0, sampindex) - memory) * m_k') &&
    filterCpp.includes('Req = (m_R1 * (m_R2 + m_R3)) / (m_R1 + m_R2 + m_R3)') &&
    filterCpp.includes('m_k = 1.0 - exp(-1 / (Req * m_C) / m_stream->sample_rate())');
  if (
    !clockDivider || !envelopeMask || !envelopeStep || !noise || !masks || !params ||
    Object.values(filterTypes).some(value => !Number.isFinite(value)) || !filterShape
  ) {
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
    filterTypes,
    sourceFiles: [cppFile, headerFile, filterCppFile, filterHeaderFile],
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
import { executeGeneratedProgram } from '../../core/generated-handler.js';
import type { GeneratedHandlerProgram } from '../../core/generated-machine.js';

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
// LFSR taps are extracted from MAME's AY implementation. RC behavior is
// sourced from flt_rc and route/filter controls arrive from generated machine IR.
const plan = ${JSON.stringify(plan, null, 2)};
const FILTER_CONTROL_BASE = ${AY_FILTER_CONTROL_BASE};
const FILTER_CONTROL_STRIDE = ${AY_FILTER_CONTROL_STRIDE};

export interface GeneratedAyRoute {
  chip: number;
  channel: number;
  gain: number;
  target: string;
  filter?: { index: number; bank: number; channel: number };
}

interface GeneratedFilterState {
  type: number;
  r1: number;
  r2: number;
  r3: number;
  c: number;
  k: number;
  memory: number;
}

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
  private envelopePosition = plan.envelopeMask;
  private envelopeAttack = 0;
  private envelopeHold = 0;
  private envelopeAlternate = 0;
  private envelopeHolding = false;
  private readonly mixedSamples = [0, 0, 0];

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
      this.envelopePosition = plan.envelopeMask;
      this.envelopeHolding = false;
      this.envelopeCount = 0;
    }
  }

  read(reg: number): number {
    reg &= plan.registerCount - 1;
    return this.regs[reg] & plan.readMasks[reg];
  }

  sampleChannels(output: number[]): void {
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
        if (--this.envelopePosition < 0) {
          if (this.envelopeHold) {
            if (this.envelopeAlternate) this.envelopeAttack ^= plan.envelopeMask;
            this.envelopeHolding = true;
            this.envelopePosition = 0;
          } else {
            if (this.envelopeAlternate) this.envelopeAttack ^= plan.envelopeMask;
            this.envelopePosition &= plan.envelopeMask;
          }
        }
      }
    }
    const envelope = this.envelopePosition ^ this.envelopeAttack;
    const enable = this.regs[7];
    for (let channel = 0; channel < plan.channels; channel++) {
      const toneGate = this.toneOutput[channel] | ((enable >> channel) & 1);
      const noiseGate = (this.rng & 1) | ((enable >> (channel + 3)) & 1);
      const volume = this.regs[8 + channel];
      const level = volume & 0x10 ? envelope : volume & 0x0f;
      const amplitude = plan.volumeTable[level] - plan.volumeTable[0];
      output[channel] = toneGate & noiseGate ? amplitude : -amplitude;
    }
  }

  sample(): number {
    this.sampleChannels(this.mixedSamples);
    return this.mixedSamples.reduce((sum, value) => sum + value, 0) / plan.channels;
  }
}

export class GeneratedAy8910Mixer {
  private readonly cores: GeneratedAy8910Core[];
  private readonly phases: number[];
  private readonly channelSamples: number[][];
  private readonly routes: GeneratedAyRoute[];
  private readonly filters: GeneratedFilterState[];
  private readonly gainTotal: number;
  private readonly outputRate: number;
  private muted = false;

  constructor(
    clock: number,
    chips: number,
    outputRate: number,
    routes: GeneratedAyRoute[] = [],
    chipGains: number[] = [],
  ) {
    this.outputRate = outputRate;
    const count = Math.max(1, chips);
    this.cores = Array.from({ length: count }, () => new GeneratedAy8910Core(clock));
    this.phases = this.cores.map(() => 0);
    this.channelSamples = this.cores.map(() => [0, 0, 0]);
    this.routes = routes.length
      ? routes
      : this.cores.flatMap((_, chip) =>
          Array.from({ length: plan.channels }, (_unused, channel) => ({
            chip,
            channel,
            gain: chipGains[chip] ?? 1,
            target: 'mono',
          })));
    const filterCount = this.routes.reduce(
      (maximum, route) => Math.max(maximum, (route.filter?.index ?? -1) + 1),
      0,
    );
    this.filters = Array.from({ length: filterCount }, () => ({
      type: plan.filterTypes.lowpass3r,
      r1: 1,
      r2: 1,
      r3: 1,
      c: 0,
      k: 1,
      memory: 0,
    }));
    this.gainTotal = this.routes.reduce((sum, route) => sum + route.gain, 0) || 1;
  }

  write(offset: number, data: number): void {
    if (offset < 0) {
      this.muted = data !== 0;
      return;
    }
    if (offset >= FILTER_CONTROL_BASE) {
      const control = offset - FILTER_CONTROL_BASE;
      const filter = this.filters[Math.floor(control / FILTER_CONTROL_STRIDE)];
      if (!filter) return;
      const parameter = control % FILTER_CONTROL_STRIDE;
      if (parameter === 0) filter.type = data;
      else if (parameter === 1) filter.r1 = data;
      else if (parameter === 2) filter.r2 = data;
      else if (parameter === 3) filter.r3 = data;
      else filter.c = data;
      this.recalculate(filter);
      return;
    }
    this.cores[offset >> 4]?.write(offset & 0x0f, data);
  }

  sample(): number {
    if (this.muted) return 0;
    for (let chip = 0; chip < this.cores.length; chip++) {
      const core = this.cores[chip]!;
      this.phases[chip]! += core.nativeRate / this.outputRate;
      while (this.phases[chip]! >= 1) {
        this.phases[chip]! -= 1;
        core.sampleChannels(this.channelSamples[chip]!);
      }
    }
    let mixed = 0;
    for (const route of this.routes) {
      let value = this.channelSamples[route.chip]?.[route.channel] ?? 0;
      if (route.filter) value = this.filter(value, this.filters[route.filter.index]);
      mixed += value * route.gain;
    }
    return Math.max(-1, Math.min(1, mixed / this.gainTotal));
  }

  private recalculate(filter: GeneratedFilterState): void {
    if (filter.c === 0) {
      filter.k = filter.type === plan.filterTypes.highpass || filter.type === plan.filterTypes.ac
        ? 0
        : 1;
      filter.memory = 0;
      return;
    }
    const resistance = filter.type === plan.filterTypes.lowpass3r
      ? filter.r1 * (filter.r2 + filter.r3) / (filter.r1 + filter.r2 + filter.r3)
      : filter.r1;
    filter.k = 1 - Math.exp(-1 / (resistance * filter.c) / this.outputRate);
  }

  private filter(input: number, filter: GeneratedFilterState | undefined): number {
    if (!filter) return input;
    if (filter.type === plan.filterTypes.highpass || filter.type === plan.filterTypes.ac) {
      const output = input - filter.memory;
      filter.memory += (input - filter.memory) * filter.k;
      return output;
    }
    filter.memory += (input - filter.memory) * filter.k;
    return filter.memory;
  }
}

export interface GeneratedAyWrite {
  offset: number;
  data: number;
  frac?: number;
}

/**
 * Renders one emulated video frame while applying AY writes at their MAME
 * raster position. Both the AudioWorklet and game acceptance tests use this
 * class, so browser scheduling is covered by the deterministic PCM golden.
 */
export class GeneratedAy8910FrameRenderer {
  private sampleCarry = 0;
  private readonly mixer: GeneratedAy8910Mixer;
  private readonly outputRate: number;
  private readonly refresh: number;

  constructor(
    mixer: GeneratedAy8910Mixer,
    outputRate: number,
    refresh: number,
  ) {
    this.mixer = mixer;
    this.outputRate = outputRate;
    this.refresh = refresh;
  }

  render(writes: readonly GeneratedAyWrite[]): Float32Array {
    this.sampleCarry += this.outputRate / this.refresh;
    const count = Math.floor(this.sampleCarry);
    this.sampleCarry -= count;
    const output = new Float32Array(count);
    let sampleIndex = 0;
    for (const write of writes) {
      const writeSample = Math.ceil(
        Math.max(0, Math.min(1, write.frac ?? 0)) * count,
      );
      while (sampleIndex < writeSample) output[sampleIndex++] = this.mixer.sample();
      this.mixer.write(write.offset, write.data);
    }
    while (sampleIndex < count) output[sampleIndex++] = this.mixer.sample();
    return output;
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
  private mixer?: GeneratedAy8910Mixer;
  private renderer?: GeneratedAy8910FrameRenderer;
  private readonly frames: Float32Array[] = [];
  private current?: Float32Array;
  private currentIndex = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        clock?: number;
        chips?: number;
        chipGains?: number[];
        routes?: GeneratedAyRoute[];
        refresh?: number;
        offset?: number;
        data?: number;
        writes?: GeneratedAyWrite[];
      };
      if (message.type === 'init') {
        this.mixer = new GeneratedAy8910Mixer(
          message.clock ?? 1_789_772,
          message.chips ?? 1,
          sampleRate,
          message.routes,
          message.chipGains,
        );
        this.renderer = new GeneratedAy8910FrameRenderer(
          this.mixer,
          sampleRate,
          message.refresh ?? 60,
        );
      } else if (message.type === 'write') {
        this.mixer?.write(message.offset ?? 0, message.data ?? 0);
      } else if (message.type === 'batch') {
        if (this.renderer) this.frames.push(this.renderer.render(message.writes ?? []));
      }
    };
  }

  private nextSample(): number {
    while (!this.current || this.currentIndex >= this.current.length) {
      this.current = this.frames.shift();
      this.currentIndex = 0;
      if (!this.current) return 0;
    }
    return this.current[this.currentIndex++]!;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;
    for (let index = 0; index < output.length; index++) {
      output[index] = this.nextSample();
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

export function generatedDiscreteSn76477WorkletSource(
  plan: GeneratedDiscreteSn76477Plan,
): string {
  return `// GENERATED from ${plan.source.file}:${plan.source.line}; do not edit.
// Port wiring, voice topology, component values, LFSR, mixer resistances and
// routes come from MAME. Norton op-amp stages are lowered to stable browser
// component models rather than copied into a hand-written game runtime.
const plan = ${JSON.stringify(plan, null, 2)};

export interface GeneratedDiscreteWrite { offset: number; data: number; frac?: number }

interface VoiceState {
  env: number;
  phase: number;
  phase2: number;
  time: number;
  filter1: number;
  filter2: number;
  frequency: number;
  center: number;
}

const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

export class GeneratedDiscreteAudioCore {
  readonly sampleRate: number;
  private readonly ports = new Uint8Array(plan.ports.length);
  private readonly states: VoiceState[] = plan.voices.map(() => ({
    env: 0, phase: 0, phase2: 0, time: 0,
    filter1: 0, filter2: 0, frequency: 0, center: 1200,
  }));
  private readonly minimumMixerResistance = Math.min(
    ...plan.voices.map(voice => voice.mixerResistance),
  );
  private lfsr = plan.lfsr.reset;
  private noise = -1;
  private noisePhase = 0;
  private snPhase = 0;
  private snSlfPhase = 0;
  private snEnv = 0;
  private ampGain = 1;

  constructor(outputRate = plan.sampleRate) {
    this.sampleRate = outputRate;
  }

  write(offset: number, data: number): void {
    if (offset < 0 || offset >= this.ports.length) return;
    const previous = this.ports[offset] ?? 0;
    this.ports[offset] = data & 0xff;
    plan.voices.forEach((voice, index) => {
      if (voice.control.port !== offset) return;
      const wasActive = (previous & voice.control.mask) !== 0;
      const active = (data & voice.control.mask) !== 0;
      const state = this.states[index];
      if (!state) return;
      if (active && !wasActive) {
        if (voice.model === 'swept-square' || voice.model === 'filtered-noise') {
          state.env = 1;
          state.time = 0;
        }
        if (voice.model === 'warble') {
          state.center = 1200;
          state.phase2 = 0;
        }
      }
      if (voice.model === 'parallel-555') {
        const bits = data & voice.control.mask;
        let conductance = 0;
        (voice.parallelResistors ?? []).forEach((resistance, bit) => {
          if (bits & (1 << bit)) conductance += 1 / resistance;
        });
        const r2 = voice.resistors[0] ?? 75_000;
        const c = voice.capacitors[0] ?? 0.1e-6;
        state.frequency = conductance ? 1.44 / ((1 / conductance + 2 * r2) * c) : 0;
      }
    });
  }

  render(output: Float32Array): void {
    for (let index = 0; index < output.length; index++) output[index] = this.sample();
  }

  sample(): number {
    const dt = 1 / this.sampleRate;
    this.noisePhase += plan.lfsr.clock * dt;
    while (this.noisePhase >= 1) {
      this.noisePhase -= 1;
      const feedback =
        ((this.lfsr >> plan.lfsr.tap0) ^ (this.lfsr >> plan.lfsr.tap1)) & 1;
      this.lfsr = ((this.lfsr << 1) | feedback) & ((2 ** plan.lfsr.bits) - 1);
      this.noise = (this.lfsr >> plan.lfsr.outputBit) & 1 ? 1 : -1;
    }

    const snOn = (this.ports[plan.snControl.port]! & plan.snControl.mask) !== 0;
    this.snEnv += (Number(snOn) - this.snEnv) * 0.003;
    let mix = 0;
    if (this.snEnv > 1e-5) {
      const slfHz = 0.64 /
        (plan.sn76477.slfResistance * plan.sn76477.slfCapacitance);
      const vcoTop = 0.64 /
        (plan.sn76477.vcoResistance * plan.sn76477.vcoCapacitance) * 1.4;
      this.snSlfPhase = (this.snSlfPhase + slfHz * dt) % 1;
      const triangle = this.snSlfPhase < 0.5
        ? this.snSlfPhase * 2
        : 2 - this.snSlfPhase * 2;
      const frequency = vcoTop * (0.32 + 0.68 * triangle);
      this.snPhase = (this.snPhase + frequency * dt) % 1;
      mix += (this.snPhase < 0.5 ? 1 : -1) * this.snEnv *
        plan.sn76477.routeGain * 0.64;
    }

    plan.voices.forEach((voice, voiceIndex) => {
      const state = this.states[voiceIndex]!;
      const active = (this.ports[voice.control.port]! & voice.control.mask) !== 0;
      const gain = Math.sqrt(this.minimumMixerResistance / voice.mixerResistance) *
        plan.discreteRouteGain * 0.9;
      let value = 0;
      if (voice.model === 'parallel-555') {
        state.env = active
          ? state.env + (1 - state.env) * this.lowpassK(160)
          : state.env * this.decayK(0.035);
        state.phase = (state.phase + state.frequency * dt) % 1;
        const raw = (state.phase < 0.5 ? 1 : -1) * state.env;
        const c1 = voice.capacitors[1] ?? 4.7e-6;
        const c2 = voice.capacitors[2] ?? 10e-6;
        state.filter1 += (raw - state.filter1) * this.rcK(100, c1);
        state.filter2 += (state.filter1 - state.filter2) * this.rcK(200, c2);
        value = state.filter2;
      } else if (voice.model === 'gated-555') {
        if (active) {
          const r1 = voice.resistors[0] ?? 100_000;
          const r2 = voice.resistors[1] ?? 47_000;
          const c = voice.capacitors[0] ?? 1e-6;
          const gateHz = 1.44 / ((r1 + 2 * r2) * c);
          const duty = (r1 + r2) / (r1 + 2 * r2);
          state.phase = (state.phase + gateHz * dt) % 1;
          state.phase2 = (state.phase2 + (voice.toneHz ?? 480) * dt) % 1;
          if (state.phase < duty) value = state.phase2 < 0.5 ? 1 : -1;
        }
      } else if (voice.model === 'filtered-noise') {
        const cap = voice.triggerCapacitance ?? 1e-6;
        state.env *= this.decayK(0.06 + cap * 110_000);
        const c1 = voice.capacitors[0] ?? 0.1e-6;
        const c2 = voice.capacitors[1] ?? 0.1e-6;
        const r1 = voice.resistors[0] ?? 5_600;
        const r2 = (voice.resistors[1] ?? 5_600) + (voice.resistors[2] ?? 6_800);
        state.filter1 += (this.noise * state.env - state.filter1) * this.rcK(r1, c1);
        state.filter2 += (state.filter1 - state.filter2) * this.rcK(r2, c2);
        value = state.filter2;
      } else if (voice.model === 'swept-square') {
        const cap = voice.triggerCapacitance ?? 0.5e-6;
        const scale = Math.sqrt(Math.max(0.1, cap / 0.1e-6));
        const endHz = 180 + 45 * scale;
        const rangeHz = 900 + 300 * scale;
        const sweepTau = 0.045 + 0.025 * scale;
        state.env *= this.decayK(0.07 + cap * 55_000);
        const frequency = (endHz + rangeHz * Math.exp(-state.time / sweepTau)) *
          (1 + 0.22 * this.noise);
        state.phase = (state.phase + frequency * dt) % 1;
        value = (state.phase < 0.5 ? 1 : -1) * state.env;
        state.time += dt;
      } else if (voice.model === 'warble') {
        state.env = active
          ? state.env + (1 - state.env) * 0.005
          : state.env * this.decayK(0.03);
        state.center = 500 + (state.center - 500) * this.decayK(0.5);
        state.phase2 = (state.phase2 + 6 * dt) % 1;
        const triangle = state.phase2 < 0.5
          ? state.phase2 * 2
          : 2 - state.phase2 * 2;
        state.phase = (state.phase + state.center * (0.6 + 0.4 * triangle) * dt) % 1;
        value = (state.phase < 0.5 ? 1 : -1) * state.env;
      }
      mix += value * gain;
    });

    const ampOn = (this.ports[plan.amplifier.port]! & plan.amplifier.mask) !== 0;
    this.ampGain += (Number(ampOn) - this.ampGain) * this.lowpassK(80);
    return clamp(mix * this.ampGain);
  }

  private decayK(seconds: number): number {
    return Math.exp(-1 / (Math.max(seconds, 1e-6) * this.sampleRate));
  }

  private lowpassK(hz: number): number {
    return 1 - Math.exp(-2 * Math.PI * hz / this.sampleRate);
  }

  private rcK(resistance: number, capacitance: number): number {
    return 1 - Math.exp(-1 / (resistance * capacitance * this.sampleRate));
  }
}

export class GeneratedDiscreteAudioFrameRenderer {
  private carry = 0;
  private readonly core: GeneratedDiscreteAudioCore;
  private readonly outputRate: number;
  private readonly refresh: number;
  constructor(
    core: GeneratedDiscreteAudioCore,
    outputRate: number,
    refresh: number,
  ) {
    this.core = core;
    this.outputRate = outputRate;
    this.refresh = refresh;
  }

  render(writes: readonly GeneratedDiscreteWrite[]): Float32Array {
    this.carry += this.outputRate / this.refresh;
    const count = Math.floor(this.carry);
    this.carry -= count;
    const output = new Float32Array(count);
    let sampleIndex = 0;
    for (const write of writes) {
      const writeSample = Math.ceil(Math.max(0, Math.min(1, write.frac ?? 0)) * count);
      while (sampleIndex < writeSample) output[sampleIndex++] = this.core.sample();
      this.core.write(write.offset, write.data);
    }
    while (sampleIndex < count) output[sampleIndex++] = this.core.sample();
    return output;
  }
}

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(); }
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class GeneratedDiscreteAudioProcessor extends AudioWorkletProcessor {
  private core?: GeneratedDiscreteAudioCore;
  private renderer?: GeneratedDiscreteAudioFrameRenderer;
  private readonly frames: Float32Array[] = [];
  private current?: Float32Array;
  private index = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        refresh?: number;
        offset?: number;
        data?: number;
        writes?: GeneratedDiscreteWrite[];
      };
      if (message.type === 'init') {
        this.core = new GeneratedDiscreteAudioCore(sampleRate);
        this.renderer = new GeneratedDiscreteAudioFrameRenderer(
          this.core,
          sampleRate,
          message.refresh ?? 60,
        );
      } else if (message.type === 'write') {
        this.core?.write(message.offset ?? 0, message.data ?? 0);
      } else if (message.type === 'batch' && this.renderer) {
        this.frames.push(this.renderer.render(message.writes ?? []));
      }
    };
  }

  private next(): number {
    while (!this.current || this.index >= this.current.length) {
      this.current = this.frames.shift();
      this.index = 0;
      if (!this.current) return 0;
    }
    return this.current[this.index++]!;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;
    for (let index = 0; index < output.length; index++) output[index] = this.next();
    for (let channel = 1; channel < (channels?.length ?? 0); channel++) {
      channels![channel]!.set(output);
    }
    return true;
  }
}

registerProcessor(plan.workletName, GeneratedDiscreteAudioProcessor);
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
