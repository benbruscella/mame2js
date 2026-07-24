import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { GeneratedHandlerProgram } from '../runtime/generated-machine.ts';
import { parseMameAst, splitMameArgs, type MameFunction } from './ast.ts';
import { evalExpr } from '../kg/parse.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';
import { compileMameHandler } from './handler-ir.ts';
import type { MameHardwareDefinition } from './hardware.ts';
import {
  AY_FILTER_CONTROL_BASE,
  AY_FILTER_CONTROL_STRIDE,
  type GeneratedDacFilterPlan,
  type GeneratedSpeakerFilterPlan,
} from '../runtime/audio-protocol.ts';

export function compileMameSpeakerFilter(
  mameSrc: string,
): GeneratedSpeakerFilterPlan {
  const cppFile = 'src/emu/audio_effects/filter.cpp';
  const headerFile = 'src/emu/audio_effects/filter.h';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const frequencyMatch =
    /m_fh\s*=\s*d\s*\?\s*d->fh\(\)\s*:\s*([0-9.]+)\s*;/.exec(cpp);
  const qMatch =
    /DEFAULT_Q\s*=\s*([0-9.]+)f?\s*;/.exec(header);
  const enabledByDefault =
    /m_highpass_active\s*=\s*d\s*\?\s*d->highpass_active\(\)\s*:\s*true\s*;/.test(cpp);
  if (!frequencyMatch || !qMatch || !enabledByDefault) {
    throw new Error('unsupported MAME default speaker filter');
  }
  return {
    type: 'highpass',
    frequency: Number(frequencyMatch[1]),
    q: Number(qMatch[1]),
    source: {
      file: cppFile,
      line: cpp.slice(0, frequencyMatch.index).split('\n').length,
    },
  };
}

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

/**
 * Lower a NAMCO 54XX DAC/op-amp discrete netlist into a compact DSP plan.
 * Device firmware supplies the three nibble streams; this pass preserves the
 * source component topology and mixer weighting without copying a game driver.
 */
export function compileNamco54Discrete(
  mameSrc: string,
  driverFile: string,
  netlist: string,
): GeneratedDacFilterPlan {
  const stem = basename(driverFile, extname(driverFile));
  const candidate = join(dirname(driverFile), `${stem}_a.cpp`);
  const sourceFile = existsSync(join(mameSrc, candidate)) ? candidate : driverFile;
  const source = readFileSync(join(mameSrc, sourceFile), 'utf8');
  const marker = new RegExp(`DISCRETE_SOUND_START\\s*\\(\\s*${netlist}\\s*\\)`).exec(source);
  if (!marker) throw new Error(`${netlist}: MAME discrete netlist not found`);
  const end = source.indexOf('DISCRETE_SOUND_END', marker.index);
  if (end < 0) throw new Error(`${netlist}: unterminated MAME discrete netlist`);
  const body = source.slice(marker.index, end);
  const dacs = macroArguments(body, 'DISCRETE_DAC_R1');
  const filters = macroArguments(body, 'DISCRETE_OP_AMP_FILTER');
  const mixer = macroArguments(body, 'DISCRETE_MIXER3')[0];
  if (dacs.length !== 3 || filters.length !== 3 || !mixer) {
    throw new Error(`${netlist}: unsupported 54XX discrete topology`);
  }
  const mixerName = symbolName(mixer.at(-1));
  const mixerResistors = mixerName
    ? resistorTable(source, mixerName).slice(0, 3)
    : [];
  if (mixerResistors.length !== 3) {
    throw new Error(`${netlist}: missing three-input mixer resistance table`);
  }
  const ladderName = symbolName(dacs[0]?.at(-1));
  const ladderResistors = ladderName
    ? resistorTable(source, ladderName)
    : [];
  if (ladderResistors.length !== 4) {
    throw new Error(`${netlist}: missing four-bit DAC resistance ladder`);
  }
  const ladderConductance = ladderResistors.reduce((sum, value) => sum + 1 / value, 0);
  const dacResistance = 1 / ladderConductance;
  const levels = Array.from({ length: 16 }, (_, data) =>
    ladderResistors.reduce((sum, resistance, bit) =>
      sum + ((data >> bit) & 1) / resistance, 0) / ladderConductance);
  const channels = dacs.map(dac => {
    const outputNode = symbolName(dac[0]);
    const input = Number(/NAMCO_54XX_(\d)_DATA/.exec(dac[1]!)?.[1]);
    const filter = filters.find(candidate => symbolName(candidate[2]) === outputNode);
    const filterName = symbolName(filter?.at(-1));
    const components = filterName ? structValues(source, filterName).body : '';
    const resistors = componentValues(components, 'RES');
    const capacitors = componentValues(components, 'CAP');
    if (!Number.isInteger(input) || resistors.length < 3 || capacitors.length < 2) {
      throw new Error(`${netlist}: incomplete 54XX channel component data`);
    }
    const [seriesResistance, biasResistance, feedbackResistance] = resistors;
    const inputResistance = seriesResistance! + dacResistance;
    const totalResistance = 1 / (
      1 / inputResistance +
      1 / biasResistance!
    );
    const frequency = 1 / (
      2 * Math.PI * Math.sqrt(
        totalResistance * feedbackResistance! * capacitors[0]! * capacitors[1]!,
      )
    );
    const damping = (capacitors[0]! + capacitors[1]!) / Math.sqrt(
      feedbackResistance! / totalResistance * capacitors[0]! * capacitors[1]!,
    );
    const q = 1 / damping;
    const mixerIndex = filters.indexOf(filter!);
    const filterGain = feedbackResistance! / totalResistance *
      capacitors[1]! / (capacitors[0]! + capacitors[1]!);
    const gain = filterGain / mixerResistors[mixerIndex]!;
    return { input, frequency, q, gain };
  });
  const gainTotal = channels.reduce((sum, channel) => sum + channel.gain, 0);
  return {
    type: 'DAC_FILTER',
    levels,
    channels: channels.map(channel => ({
      ...channel,
      gain: channel.gain / gainTotal,
    })),
    outputGain: 0.65,
    source: {
      file: sourceFile,
      line: source.slice(0, marker.index).split('\n').length,
      netlist,
    },
  };
}

function symbolName(expression: string | undefined): string | undefined {
  return /&?\s*(\w+)/.exec(
    expression?.replace(/\/\*[\s\S]*?\*\//g, '').trim() ?? '',
  )?.[1];
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

export interface GeneratedMsm5205Plan {
  schemaVersion: 1;
  type: 'MSM5205';
  className: string;
  indexShift: number[];
  diffLookup: number[];
  modes: Record<string, number>;
  maximumStep: number;
  minimumSignal: number;
  maximumSignal: number;
  sampleScale: number;
  dacBits: number;
  sourceFiles: string[];
  source: { file: string; line: number };
}

/**
 * Compile the MSM5205 ADPCM tables and limits from MAME. The emitted worklet
 * consumes this data; no separately maintained decoder table lives in src.
 */
export function compileMsm5205(
  mameSrc: string,
  definition: MameHardwareDefinition,
): GeneratedMsm5205Plan {
  const cppFile = definition.sourceFile;
  const headerFile = relative(
    mameSrc,
    join(dirname(join(mameSrc, cppFile)), `${basename(cppFile, extname(cppFile))}.h`),
  );
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const shifts = /index_shift\s*\[\s*8\s*\]\s*=\s*\{([^}]+)\}/.exec(cpp);
  const stepLoop = /for\s*\(\s*int step\s*=\s*0\s*;\s*step\s*<=\s*(\d+)/.exec(cpp);
  const stepFormula =
    /floor\s*\(\s*16\.0\s*\*\s*pow\s*\(\s*11\.0\s*\/\s*10\.0/.test(cpp);
  const signalLimits =
    /if\s*\(\s*new_signal\s*>\s*(\d+)\s*\)[\s\S]*?new_signal\s*=\s*\1[\s\S]*?new_signal\s*<\s*-(\d+)/.exec(cpp);
  const sampleScale =
    /sample_scale\s*=\s*1\.0\s*\/\s*double\s*\(\s*1\s*<<\s*(\d+)\s*\)/.exec(cpp);
  const dacBits = /MSM5205,\s*tag,\s*owner,\s*clock,\s*(\d+)\s*\)/.exec(cpp);
  if (!shifts || !stepLoop || !stepFormula || !signalLimits || !sampleScale || !dacBits) {
    throw new Error('MSM5205: MAME source shape is not executable by the audio compiler');
  }
  const indexShift = splitMameArgs(shifts[1]!).map(Number);
  const maximumStep = Number(stepLoop[1]);
  const modes = Object.fromEntries(
    [...header.matchAll(/static constexpr int\s+(\w+)\s*=\s*([^;]+);/g)]
      .map(match => [match[1]!, evalExpr(match[2]!)])
      .filter((entry): entry is [string, number] => entry[1] !== null),
  );
  const diffLookup = Array.from({ length: (maximumStep + 1) * 16 }, (_, index) => {
    const step = Math.floor(index / 16);
    const nibble = index & 15;
    const stepValue = Math.floor(16 * Math.pow(11 / 10, step));
    const magnitude =
      stepValue / 8 +
      ((nibble & 4) ? stepValue : 0) +
      ((nibble & 2) ? stepValue / 2 : 0) +
      ((nibble & 1) ? stepValue / 4 : 0);
    return Math.trunc((nibble & 8 ? -1 : 1) * magnitude);
  });
  return {
    schemaVersion: 1,
    type: 'MSM5205',
    className: definition.className,
    indexShift,
    diffLookup,
    modes,
    maximumStep,
    minimumSignal: -Number(signalLimits[2]),
    maximumSignal: Number(signalLimits[1]),
    sampleScale: 1 / (1 << Number(sampleScale[1])),
    dacBits: Number(dacBits[1]),
    sourceFiles: [cppFile, headerFile],
    source: {
      file: cppFile,
      line: cpp.slice(0, cpp.indexOf('void msm5205_device::update_adpcm')).split('\n').length,
    },
  };
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
  processorName: 'discrete';
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

export interface GeneratedCounterLfsrDiscretePlan {
  schemaVersion: 1;
  type: 'COUNTER_LFSR_DISCRETE';
  deviceType: string;
  className: string;
  workletName: string;
  processorName: 'discrete';
  methodBases: Record<string, number>;
  methodRoles: { pitch: string; lfo: string; controls: string };
  controls: {
    background: number[];
    noise: number;
    fire: number;
    volume: number[];
  };
  clockDivider: number;
  lfsr: { bits: number; reset: number; tap0: number; tap1: number };
  lfoResistors: number[];
  backgroundResistors: number[];
  backgroundCapacitors: number[];
  toneResistors: number[];
  hitFilter: {
    resistance: number;
    capacitance: number;
    inputVoltage: number;
    diodeDrop: number;
    bandpass: {
      inputResistance: number;
      biasResistance: number;
      feedbackResistance: number;
      capacitance1: number;
      capacitance2: number;
      referenceVoltage: number;
      positiveVoltage: number;
      negativeVoltage: number;
      positiveRailOffset: number;
    };
    mixGain: number;
  };
  fire: { resistance: number; capacitance: number };
  sourceFiles: string[];
  source: { file: string; line: number };
}

export function compileCounterLfsrDiscrete(
  mameSrc: string,
  definition: MameHardwareDefinition,
): GeneratedCounterLfsrDiscretePlan {
  const cppFile = definition.sourceFile;
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const ast = parseMameAst([{ file: cppFile, source: cpp }]);
  const methods = ast.units.flatMap(unit => unit.functions)
    .filter(fn => fn.className === definition.className);
  const publicWrites = methods.filter(method =>
    method.body.includes('m_discrete->write') ||
    (method.body.includes('switch') && method.body.includes('_w(')));
  const controlsMethod = publicWrites.find(method => method.body.includes('switch'));
  const lfoMethod = publicWrites.find(method => method.body.includes('m_lfo_val'));
  const pitchMethod = publicWrites.find(method =>
    method !== controlsMethod && method !== lfoMethod &&
    /m_discrete->write\([^,]+,\s*data\s*\)/.test(method.body));
  const config = methods.find(method => method.name === 'device_add_mconfig');
  const netlistName = /set_intf\(\s*(\w+)\s*\)/.exec(config?.body ?? '')?.[1];
  const netlist = netlistName ? discreteSoundBody(cpp, netlistName) : '';
  const mapped = [controlsMethod, lfoMethod, pitchMethod]
    .filter((method): method is MameFunction => Boolean(method));
  if (mapped.length !== 3 || !netlist) {
    throw new Error(`${definition.type}: counter/LFSR discrete source shape is incomplete`);
  }
  const macros = preprocessorMacros(cpp);
  const analog = (expression: string | undefined): number => {
    let expanded = expression ?? '';
    for (let pass = 0; pass < 4; pass++) {
      expanded = expanded.replace(/\b[A-Za-z_]\w*\b/g, token =>
        macros.get(token)?.replace(/\/\*[\s\S]*?\*\//g, '').trim() ?? token);
    }
    return requiredAnalog(expanded.replace(/\.dvalue\(\)/g, ''));
  };
  const lfsrName = /DISCRETE_LFSR_NOISE\([\s\S]*?&(\w+)\s*\)/.exec(netlist)?.[1];
  const lfsr = lfsrName ? structValues(cpp, lfsrName).scalars : [];
  const note = callArgs(netlist, 'DISCRETE_NOTE')[0] ?? [];
  const clockSymbol = /\b([A-Za-z_]\w*)\.dvalue\(\)/.exec(note[2] ?? '')?.[1];
  const soundClock = (clockSymbol ? macros.get(clockSymbol) ?? '' : '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .trim();
  const divider = Number(/\/\s*(\d+)\s*\)?\s*$/.exec(soundClock)?.[1]);
  if (lfsr.length < 5 || !divider) {
    throw new Error(`${definition.type}: counter/LFSR clock source shape is incomplete`);
  }
  const dac = callArgs(netlist, 'DISCRETE_DAC_R1')[0] ?? [];
  const dacDescriptor = /&(\w+)/.exec(dac.at(-1) ?? '')?.[1];
  const lfoResistors = dacDescriptor
    ? structValues(cpp, dacDescriptor).firstArray.slice(0, 4).map(analog)
    : [];
  const astables = callArgs(netlist, 'DISCRETE_555_ASTABLE_CV')
    .filter(args => !/^1(?:\.0)?$/.test(args[1]?.trim() ?? ''));
  const backgroundResistors = astables.map(args => analog(args[3]));
  const backgroundCapacitors = astables.map(args => analog(args[4]));
  const backgroundNodes = astables.map(args => args[1]!.trim());
  const inputData = callArgs(netlist, 'DISCRETE_INPUTX_DATA');
  const inputResistors = new Map(inputData.map(args => [args[0]!.trim(), analog(args[1])]));
  const bitsNode = callArgs(netlist, 'DISCRETE_BITS_DECODE')[0]?.[0]?.trim();
  const toneMixer = callArgs(netlist, 'DISCRETE_MIXER5').find(args =>
    bitsNode && args.some(arg => arg.includes(`${bitsNode}_`)));
  const toneDescriptor = /&(\w+)/.exec(toneMixer?.at(-1) ?? '')?.[1];
  const toneArrays = toneDescriptor ? structArrays(cpp, toneDescriptor) : [];
  const fixedTone = (toneArrays[0] ?? []).slice(0, 4)
    .filter(value => value.trim() !== '0')
    .map(analog);
  const variableTone = (toneArrays[1] ?? []).slice(0, 4)
    .filter(value => value.trim() !== '0')
    .map(value => inputResistors.get(value.trim()) ?? Number.NaN);
  const toneResistors = [...fixedTone, ...variableTone];
  const rcDischarges = callArgs(netlist, 'DISCRETE_RCDISC5');
  const hit = rcDischarges.find(args => inputResistors.has(args[2]?.trim() ?? ''));
  const fire = rcDischarges.find(args => args !== hit);
  const hitNode = hit?.[0]?.trim();
  const hitInput = inputData.find(args => args[0]?.trim() === hit?.[2]?.trim());
  const hitBandpass = callArgs(netlist, 'DISCRETE_OP_AMP_FILTER').find(args =>
    args[2]?.trim() === hitNode && args[4]?.includes('BAND_PASS_1M'));
  const hitBandpassName = /&(\w+)/.exec(hitBandpass?.at(-1) ?? '')?.[1];
  const hitBandpassValues = hitBandpassName
    ? splitMameArgs(structValues(cpp, hitBandpassName).body)
      .map(value => analog(value))
    : [];
  const hitFilterNode = hitBandpass?.[0]?.trim();
  const finalMixer = callArgs(netlist, 'DISCRETE_MIXER3').find(args =>
    hitFilterNode && args.slice(2, -1).some(arg => arg.trim() === hitFilterNode));
  const finalMixerName = /&(\w+)/.exec(finalMixer?.at(-1) ?? '')?.[1];
  const finalMixerResistors = finalMixerName
    ? structValues(cpp, finalMixerName).firstArray.map(value => analog(value))
    : [];
  const hitMixerIndex = finalMixer?.slice(2, -1)
    .findIndex(arg => arg.trim() === hitFilterNode) ?? -1;
  const finalConductance = finalMixerResistors
    .filter(value => value > 0)
    .reduce((sum, value) => sum + 1 / value, 0);
  const hitMixGain = hitMixerIndex >= 0 && finalConductance > 0
    ? (1 / finalMixerResistors[hitMixerIndex]!) / finalConductance
    : Number.NaN;
  const discreteFilterFile = 'src/devices/sound/disc_flt.hxx';
  const discreteHeaderFile = 'src/devices/sound/discrete.h';
  const discreteFilterSource = readFileSync(join(mameSrc, discreteFilterFile), 'utf8');
  const discreteHeaderSource = readFileSync(join(mameSrc, discreteHeaderFile), 'utf8');
  const diodeDrop = Number(/DST_RCDISC5__IN\s*-\s*([\d.]+)/.exec(
    discreteFilterSource,
  )?.[1]);
  const positiveRailOffset = Number(/#define\s+OP_AMP_VP_RAIL_OFFSET\s+([\d.]+)/.exec(
    discreteHeaderSource,
  )?.[1]);
  const fireNode = callArgs(netlist, 'DISCRETE_LOGIC_INVERT')[0]?.[1]?.trim();
  const volumeNodes = new Set((toneArrays[1] ?? [])
    .map(value => value.trim())
    .filter(value => value !== '0'));
  const helpers = publicWrites.filter(method => !mapped.includes(method));
  const helperTarget = (body: string): string | undefined =>
    /m_discrete->write\(\s*(?:NODE_RELATIVE\(\s*)?(\w+)/.exec(body)?.[1];
  const offsetsFor = (predicate: (target: string) => boolean): number[] => helpers
    .filter(method => {
      const target = helperTarget(method.body);
      return target ? predicate(target) : false;
    })
    .flatMap(method => switchCallOffsets(controlsMethod!.body, method.name));
  const controls = {
    background: offsetsFor(target => target === backgroundNodes[0]),
    noise: offsetsFor(target => target === hit?.[2]?.trim())[0] ?? -1,
    fire: offsetsFor(target => target === fireNode)[0] ?? -1,
    volume: offsetsFor(target => volumeNodes.has(target)),
  };
  if (
    lfoResistors.length !== 4 || backgroundResistors.length !== 3 ||
    backgroundCapacitors.length !== 3 || toneResistors.length !== 4 ||
    !hit || !fire || hitBandpassValues.length < 11 || !Number.isFinite(hitMixGain) ||
    !Number.isFinite(diodeDrop) || !Number.isFinite(positiveRailOffset) ||
    controls.background.length !== 3 ||
    controls.noise < 0 || controls.fire < 0 || controls.volume.length !== 2
  ) {
    throw new Error(`${definition.type}: discrete component topology is incomplete`);
  }
  const methodBases = Object.fromEntries(
    mapped.map(method => method.name).sort().map((name, index) => [name, index * 0x100]),
  );
  return {
    schemaVersion: 1,
    type: 'COUNTER_LFSR_DISCRETE',
    deviceType: definition.type,
    className: definition.className,
    workletName: definition.type.toLowerCase().replace(/_/g, '-'),
    processorName: 'discrete',
    methodBases,
    methodRoles: {
      pitch: pitchMethod!.name,
      lfo: lfoMethod!.name,
      controls: controlsMethod!.name,
    },
    controls,
    clockDivider: divider,
    lfsr: {
      bits: lfsr[1]!,
      reset: lfsr[2]!,
      tap0: lfsr[3]!,
      tap1: lfsr[4]!,
    },
    lfoResistors,
    backgroundResistors,
    backgroundCapacitors,
    toneResistors,
    hitFilter: {
      resistance: analog(hit[3]),
      capacitance: analog(hit[4]),
      inputVoltage: analog(hitInput?.[1]),
      diodeDrop,
      bandpass: {
        inputResistance: hitBandpassValues[0]!,
        biasResistance: hitBandpassValues[1]!,
        feedbackResistance: hitBandpassValues[4]!,
        capacitance1: hitBandpassValues[5]!,
        capacitance2: hitBandpassValues[6]!,
        referenceVoltage: hitBandpassValues[8]!,
        positiveVoltage: hitBandpassValues[9]!,
        negativeVoltage: hitBandpassValues[10]!,
        positiveRailOffset,
      },
      mixGain: hitMixGain,
    },
    fire: {
      resistance: analog(fire[3]),
      capacitance: analog(fire[4]),
    },
    sourceFiles: [cppFile, discreteFilterFile, discreteHeaderFile],
    source: { file: mapped[0]!.span.file, line: mapped[0]!.span.line },
  };
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
    workletName: definition.type.toLowerCase().replace(/_/g, '-'),
    processorName: 'discrete',
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

function discreteSoundBody(source: string, name: string): string {
  const start = new RegExp(`\\bDISCRETE_SOUND_START\\s*\\(\\s*${name}\\s*\\)`).exec(source);
  if (!start) return '';
  const end = source.indexOf('DISCRETE_SOUND_END', start.index + start[0].length);
  return end < 0 ? '' : source.slice(start.index + start[0].length, end);
}

function switchCallOffsets(source: string, method: string): number[] {
  const offsets: number[] = [];
  let pending: number[] = [];
  for (const line of source.split('\n')) {
    const caseValue = /\bcase\s+(0x[\da-f]+|\d+)\s*:/i.exec(line)?.[1];
    if (caseValue) pending.push(Number(caseValue));
    if (new RegExp(`\\b${method}\\s*\\(`).test(line)) offsets.push(...pending);
    if (/\bbreak\s*;/.test(line)) pending = [];
  }
  return offsets;
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

function structArrays(source: string, name: string): string[][] {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(source);
  if (!match) return [];
  const open = source.indexOf('{', match.index);
  const close = matchingDelimiter(source, open, '{', '}');
  if (close < 0) return [];
  const clean = source.slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  return splitMameArgs(clean)
    .filter(value => value.trim().startsWith('{'))
    .map(value => splitMameArgs(value.trim().replace(/^\{/, '').replace(/\}\s*$/, '')));
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

function macroArguments(source: string, name: string): string[][] {
  const calls: string[][] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('(', match.index);
    const close = matchingDelimiter(source, open, '(', ')');
    if (close < 0) break;
    calls.push(splitMameArgs(source.slice(open + 1, close)));
    pattern.lastIndex = close + 1;
  }
  return calls;
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

export function generatedCounterLfsrDiscreteWorkletSource(
  plan: GeneratedCounterLfsrDiscretePlan,
): string {
  return `// GENERATED from ${plan.source.file}:${plan.source.line}; do not edit.
// Register routing, clock division, component values and LFSR topology are
// lowered from the selected MAME discrete sound device and netlist.
const plan = ${JSON.stringify(plan, null, 2)};

export interface GeneratedDiscreteWrite {
  offset: number;
  data: number;
  frac?: number;
  method?: string;
}

const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

export class GeneratedDiscreteAudioCore {
  readonly sampleRate: number;
  private readonly clock: number;
  private pitch = 0xff;
  private volume = 0;
  private tonePhase = 0;
  private lfoValue = 0;
  private lfoPhase = 0;
  private readonly backgroundEnabled = [false, false, false];
  private readonly backgroundPhase = new Float64Array(3);
  private hitEnabled = false;
  private hitCapacitor = 0;
  private hitInput1 = 0;
  private hitInput2 = 0;
  private hitOutput1 = 0;
  private hitOutput2 = 0;
  private readonly hitA1: number;
  private readonly hitA2: number;
  private readonly hitB0: number;
  private readonly hitB2: number;
  private noisePhase = 0;
  private lfsr = plan.lfsr.reset;
  private noise = -1;
  private fire = false;
  private fireEnvelope = 0;
  private firePhase = 0;
  private fireTime = 0;

  constructor(outputRate = 48_000, clock = 3_072_000) {
    this.sampleRate = outputRate;
    this.clock = clock;
    const filter = plan.hitFilter.bandpass;
    const totalResistance = 1 / (
      1 / filter.inputResistance +
      (filter.biasResistance > 0 ? 1 / filter.biasResistance : 0)
    );
    const centerHz = 1 / (2 * Math.PI * Math.sqrt(
      totalResistance * filter.feedbackResistance *
      filter.capacitance1 * filter.capacitance2
    ));
    const damping = (filter.capacitance1 + filter.capacitance2) / Math.sqrt(
      filter.feedbackResistance / totalResistance *
      filter.capacitance1 * filter.capacitance2
    );
    const twoOverT = 2 * outputRate;
    const warped = outputRate * 2 * Math.tan(Math.PI * centerHz / outputRate);
    const denominator = twoOverT ** 2 + damping * warped * twoOverT + warped ** 2;
    const gain = -filter.feedbackResistance / totalResistance *
      filter.capacitance2 / (filter.capacitance1 + filter.capacitance2);
    this.hitA1 = 2 * (-(twoOverT ** 2) + warped ** 2) / denominator;
    this.hitA2 = (twoOverT ** 2 - damping * warped * twoOverT + warped ** 2) /
      denominator;
    this.hitB0 = damping * warped * twoOverT / denominator * gain;
    this.hitB2 = -this.hitB0;
  }

  write(encodedOffset: number, data: number, methodName?: string): void {
    // Boards send the raw register offset plus the target method name; the
    // legacy numeric methodBases decoding remains for un-named writes only.
    let name = methodName;
    let offset = encodedOffset;
    if (name === undefined) {
      const method = Object.entries(plan.methodBases)
        .find(([, base]) => encodedOffset >= base && encodedOffset < base + 0x100);
      if (!method) return;
      name = method[0];
      offset = encodedOffset - method[1];
    }
    data &= 0xff;
    if (name === plan.methodRoles.pitch) {
      this.pitch = data;
      return;
    }
    if (name === plan.methodRoles.lfo) {
      this.lfoValue = (this.lfoValue & ~(1 << offset)) | ((data & 1) << offset);
      return;
    }
    if (name !== plan.methodRoles.controls) return;
    const bit = (data & 1) !== 0;
    const background = plan.controls.background.indexOf(offset);
    if (background >= 0) {
      this.backgroundEnabled[background] = bit;
      return;
    }
    if (offset === plan.controls.noise) {
      this.hitEnabled = bit;
      return;
    }
    if (offset === plan.controls.fire) {
      if (bit && !this.fire) {
        this.fireEnvelope = 1;
        this.fireTime = 0;
        this.firePhase = 0;
      }
      this.fire = bit;
      return;
    }
    const volume = plan.controls.volume.indexOf(offset);
    if (volume >= 0) {
      this.volume = (this.volume & ~(1 << volume)) | (Number(bit) << volume);
    }
  }

  render(output: Float32Array): void {
    for (let index = 0; index < output.length; index++) output[index] = this.sample();
  }

  sample(): number {
    const dt = 1 / this.sampleRate;
    const soundClock = this.clock / plan.clockDivider;
    let mix = 0;

    if (this.pitch !== 0xff) {
      const counterRate = soundClock / Math.max(1, 256 - this.pitch);
      this.tonePhase = (this.tonePhase + counterRate * dt) % 16;
      const counter = Math.floor(this.tonePhase) & 15;
      const conductances = [
        (counter & 1) ? 1 / plan.toneResistors[0] : 0,
        (counter & 4) ? 1 / plan.toneResistors[1] : 0,
        (counter & 4) && (this.volume & 1) ? 1 / plan.toneResistors[2] : 0,
        (counter & 8) && (this.volume & 2) ? 1 / plan.toneResistors[3] : 0,
      ];
      const maximum = plan.toneResistors.reduce((sum, resistance) => sum + 1 / resistance, 0);
      mix += (conductances.reduce((sum, value) => sum + value, 0) / maximum - 0.25) * 0.7;
    }

    let lfoConductance = 1 / 330_000;
    plan.lfoResistors.forEach((resistance, bit) => {
      if (this.lfoValue & (1 << bit)) lfoConductance += 1 / resistance;
    });
    const lfoHz = 0.15 + 600_000 * lfoConductance;
    this.lfoPhase = (this.lfoPhase + lfoHz * dt) % 1;
    const sweep = this.lfoPhase < 0.5 ? this.lfoPhase * 2 : 2 - this.lfoPhase * 2;
    for (let voice = 0; voice < 3; voice++) {
      if (!this.backgroundEnabled[voice]) continue;
      const r = plan.backgroundResistors[voice];
      const c = plan.backgroundCapacitors[voice];
      const base = 1.44 / ((100_000 + 2 * r) * c);
      this.backgroundPhase[voice] = (this.backgroundPhase[voice]! +
        base * (0.68 + 0.32 * sweep) * dt) % 1;
      mix += (this.backgroundPhase[voice]! < 0.5 ? 1 : -1) * 0.075;
    }

    this.noisePhase += 7_920 * dt;
    while (this.noisePhase >= 1) {
      this.noisePhase -= 1;
      const feedback = ((this.lfsr >> plan.lfsr.tap0) ^
        (this.lfsr >> plan.lfsr.tap1) ^ 1) & 1;
      this.lfsr = ((this.lfsr << 1) | feedback) & ((2 ** plan.lfsr.bits) - 1);
      this.noise = this.lfsr & 1 ? 1 : -1;
    }
    const hitTarget = this.hitEnabled
      ? Math.max(0, plan.hitFilter.inputVoltage - plan.hitFilter.diodeDrop)
      : 0;
    let hitDifference = hitTarget - this.hitCapacitor;
    let hitNode = 0;
    if (this.noise > 0) {
      if (hitDifference < 0) {
        hitDifference *= 1 - Math.exp(
          -dt / (plan.hitFilter.resistance * plan.hitFilter.capacitance),
        );
      }
      this.hitCapacitor += hitDifference;
      hitNode = this.hitCapacitor;
    } else if (hitDifference > 0) {
      this.hitCapacitor = hitTarget;
    }
    const hitUnclipped = -this.hitA1 * this.hitOutput1 - this.hitA2 * this.hitOutput2 +
      this.hitB0 * hitNode + this.hitB2 * this.hitInput2;
    const hitVoltage = Math.max(
      plan.hitFilter.bandpass.negativeVoltage,
      Math.min(
        plan.hitFilter.bandpass.positiveVoltage -
          plan.hitFilter.bandpass.positiveRailOffset,
        hitUnclipped + plan.hitFilter.bandpass.referenceVoltage,
      ),
    );
    const hitFiltered = hitVoltage - plan.hitFilter.bandpass.referenceVoltage;
    this.hitInput2 = this.hitInput1;
    this.hitInput1 = hitNode;
    this.hitOutput2 = this.hitOutput1;
    this.hitOutput1 = hitFiltered;
    const hitSupply = plan.hitFilter.bandpass.positiveVoltage -
      plan.hitFilter.bandpass.negativeVoltage;
    mix += hitFiltered / hitSupply * plan.hitFilter.mixGain;

    if (this.fireEnvelope > 0.0001) {
      const tau = plan.fire.resistance * plan.fire.capacitance;
      const frequency = 150 + 1_350 * Math.exp(-this.fireTime / Math.max(0.04, tau * 0.7)) +
        this.noise * 90;
      this.firePhase = (this.firePhase + frequency * dt) % 1;
      mix += (this.firePhase < 0.5 ? 1 : -1) * this.fireEnvelope * 0.28;
      this.fireEnvelope *= Math.exp(-dt / Math.max(0.08, tau * 2));
      this.fireTime += dt;
    }
    return clamp(mix * 0.9);
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
    let index = 0;
    for (const write of writes) {
      const at = Math.ceil(Math.max(0, Math.min(1, write.frac ?? 0)) * count);
      while (index < at) output[index++] = this.core.sample();
      this.core.write(write.offset, write.data, write.method);
    }
    while (index < count) output[index++] = this.core.sample();
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
  private position = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string; clock?: number; refresh?: number;
        offset?: number; data?: number; method?: string;
        writes?: GeneratedDiscreteWrite[];
      };
      if (message.type === 'init') {
        this.core = new GeneratedDiscreteAudioCore(sampleRate, message.clock ?? 3_072_000);
        this.renderer = new GeneratedDiscreteAudioFrameRenderer(
          this.core, sampleRate, message.refresh ?? 60.606,
        );
      } else if (message.type === 'write') {
        this.core?.write(message.offset ?? 0, message.data ?? 0, message.method);
      } else if (message.type === 'batch' && this.renderer) {
        this.frames.push(this.renderer.render(message.writes ?? []));
        while (this.frames.length > 8) this.frames.shift();
      }
    };
  }

  private nextSample(): number {
    while (!this.current || this.position >= this.current.length) {
      this.current = this.frames.shift();
      this.position = 0;
      if (!this.current) return 0;
    }
    return this.current[this.position++]!;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;
    for (let index = 0; index < output.length; index++) output[index] = this.nextSample();
    for (let channel = 1; channel < (channels?.length ?? 0); channel++) {
      channels![channel]!.set(output);
    }
    return true;
  }
}

registerProcessor(plan.processorName, GeneratedDiscreteAudioProcessor);
`;
}

export function generatedAy8910WorkletSource(
  plan: GeneratedAy8910Plan,
  msm5205?: GeneratedMsm5205Plan,
): string {
  return `// GENERATED from ${plan.source.file}:${plan.source.line} and ${plan.sourceFiles[1]}; do not edit.
// Register masks, resistor DAC curve, clock divider, envelope parameters and
// LFSR taps are extracted from MAME's AY implementation. RC behavior is
// sourced from flt_rc and route/filter controls arrive from generated machine IR.
const plan = ${JSON.stringify(plan, null, 2)};
const msmPlan: GeneratedMsm5205PlanData | null = ${JSON.stringify(msm5205 ?? null, null, 2)};
const FILTER_CONTROL_BASE = ${AY_FILTER_CONTROL_BASE};
const FILTER_CONTROL_STRIDE = ${AY_FILTER_CONTROL_STRIDE};

interface GeneratedMsm5205PlanData {
  schemaVersion: number;
  type: string;
  className: string;
  indexShift: number[];
  diffLookup: number[];
  modes: Record<string, number>;
  maximumStep: number;
  minimumSignal: number;
  maximumSignal: number;
  sampleScale: number;
  dacBits: number;
  sourceFiles: string[];
  source: { file: string; line: number };
}

export interface GeneratedAyRoute {
  chip: number;
  channel: number;
  gain: number;
  target: string;
  filter?: { index: number; bank: number; channel: number };
}

export interface GeneratedAuxiliaryAudioDevice {
  type: string;
  deviceTag: string;
  clock: number;
  initialMode?: string;
  gain: number;
  target: string;
  targetInput?: number;
  writeMethods: string[];
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

export class GeneratedMsm5205Core {
  private data = 0;
  private reset = false;
  private bitwidth = 4;
  private modeValue = 4;
  private signal = 0;
  private step = 0;

  constructor(initialMode?: string) {
    if (!msmPlan) throw new Error('MSM5205 plan is not present in this generated worklet');
    const mode = initialMode
      ? (msmPlan.modes as Record<string, number>)[initialMode]
      : undefined;
    if (mode !== undefined) this.playmode(mode);
  }

  write(method: string, data: number): void {
    if (method === 'data_w') {
      this.data = this.bitwidth === 4 ? data & 0x0f : (data & 0x07) << 1;
    } else if (method === 'reset_w') {
      this.reset = data !== 0;
    } else if (method === 'playmode_w') {
      this.playmode(data);
    } else if (method === 's1_w') {
      this.playmode((this.mode() & ~1) | (data ? 1 : 0));
    } else if (method === 's2_w') {
      this.playmode((this.mode() & ~2) | (data ? 2 : 0));
    } else if (method === 'vck' && data) {
      this.clock();
    }
  }

  sample(): number {
    if (!msmPlan) return 0;
    const mask = msmPlan.dacBits >= 12 ? 0 : (1 << (12 - msmPlan.dacBits)) - 1;
    return (this.signal & ~mask) * msmPlan.sampleScale;
  }

  private mode(): number {
    return this.modeValue;
  }

  private playmode(data: number): void {
    this.modeValue = data & 7;
    this.bitwidth = data & 4 ? 4 : 3;
  }

  private clock(): void {
    if (!msmPlan) return;
    if (this.reset) {
      this.signal = 0;
      this.step = 0;
      return;
    }
    const value = this.data & 15;
    this.signal = Math.max(
      msmPlan.minimumSignal,
      Math.min(
        msmPlan.maximumSignal,
        this.signal + msmPlan.diffLookup[this.step * 16 + value],
      ),
    );
    this.step = Math.max(
      0,
      Math.min(msmPlan.maximumStep, this.step + msmPlan.indexShift[value & 7]),
    );
  }
}

export class GeneratedDac8Core {
  private value = 0x80;

  write(method: string, data: number): void {
    if (method === 'data_w') this.value = data & 0xff;
  }

  sample(): number {
    return (this.value - 0x80) / 0x80;
  }
}

export class GeneratedAy8910Mixer {
  private readonly cores: GeneratedAy8910Core[];
  private readonly phases: number[];
  private readonly channelSamples: number[][];
  private readonly routes: GeneratedAyRoute[];
  private readonly filters: GeneratedFilterState[];
  private readonly gainTotal: number;
  private readonly auxiliary: {
    deviceTag: string;
    gain: number;
    core: GeneratedMsm5205Core | GeneratedDac8Core;
  }[];
  private readonly auxiliaryGainTotal: number;
  private readonly outputRate: number;
  private muted = false;

  constructor(
    clock: number,
    chips: number,
    outputRate: number,
    routes: GeneratedAyRoute[] = [],
    chipGains: number[] = [],
    auxiliaryDevices: GeneratedAuxiliaryAudioDevice[] = [],
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
    this.auxiliary = auxiliaryDevices.flatMap<{
      deviceTag: string;
      gain: number;
      core: GeneratedMsm5205Core | GeneratedDac8Core;
    }>(device =>
      device.type === 'MSM5205' && msmPlan
        ? [{
            deviceTag: device.deviceTag,
            gain: device.gain,
            core: new GeneratedMsm5205Core(device.initialMode),
          }]
        : device.type === 'DAC_8BIT_R2R'
          ? [{
              deviceTag: device.deviceTag,
              gain: device.gain,
              core: new GeneratedDac8Core(),
            }]
          : []);
    this.auxiliaryGainTotal = this.auxiliary.reduce(
      (sum, device) => sum + device.gain,
      0,
    );
  }

  write(offset: number, data: number, method?: string): void {
    const auxiliaryWrite = /^([^.]+)\\.(\\w+)$/.exec(method ?? '');
    if (auxiliaryWrite) {
      this.auxiliary.find(device =>
        device.deviceTag === auxiliaryWrite[1])?.core.write(auxiliaryWrite[2]!, data);
      return;
    }
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
      const samples = this.channelSamples[route.chip];
      let value = route.channel === -1
        ? (samples?.reduce((sum, sample) => sum + sample, 0) ?? 0) / plan.channels
        : samples?.[route.channel] ?? 0;
      if (route.filter) value = this.filter(value, this.filters[route.filter.index]);
      mixed += value * route.gain;
    }
    for (const device of this.auxiliary) mixed += device.core.sample() * device.gain;
    return Math.max(
      -1,
      Math.min(1, mixed / (this.gainTotal + this.auxiliaryGainTotal)),
    );
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
  method?: string;
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
      this.mixer.write(write.offset, write.data, write.method);
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
        auxiliaryDevices?: GeneratedAuxiliaryAudioDevice[];
        refresh?: number;
        offset?: number;
        data?: number;
        method?: string;
        writes?: GeneratedAyWrite[];
      };
      if (message.type === 'init') {
        this.mixer = new GeneratedAy8910Mixer(
          message.clock ?? 1_789_772,
          message.chips ?? 1,
          sampleRate,
          message.routes,
          message.chipGains,
          message.auxiliaryDevices,
        );
        this.renderer = new GeneratedAy8910FrameRenderer(
          this.mixer,
          sampleRate,
          message.refresh ?? 60,
        );
      } else if (message.type === 'write') {
        this.mixer?.write(message.offset ?? 0, message.data ?? 0, message.method);
      } else if (message.type === 'batch') {
        if (this.renderer) {
          this.frames.push(this.renderer.render(message.writes ?? []));
          while (this.frames.length > 8) this.frames.shift();
        }
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

export interface GeneratedDiscreteWrite {
  offset: number;
  data: number;
  frac?: number;
  method?: string;
}

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

  write(offset: number, data: number, methodName?: string): void {
    // Boards route writes by method name; plan.ports carries the lowered
    // method -> port table, so no offset-numbering convention is shared.
    if (methodName !== undefined) {
      const port = plan.ports.find(entry => entry.method === methodName);
      if (!port) return;
      offset = port.offset;
    }
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
      this.core.write(write.offset, write.data, write.method);
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
        method?: string;
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
        this.core?.write(message.offset ?? 0, message.data ?? 0, message.method);
      } else if (message.type === 'batch' && this.renderer) {
        this.frames.push(this.renderer.render(message.writes ?? []));
        while (this.frames.length > 8) this.frames.shift();
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

registerProcessor(plan.processorName, GeneratedDiscreteAudioProcessor);
`;
}

function generatedNamcoWsgSuffix(plan: GeneratedNamcoWsgPlan): string {
  return `
interface DacFilterPlan {
  levels: number[];
  channels: { input: number; frequency: number; q: number; gain: number }[];
  outputGain: number;
}

interface BiquadState {
  input: number;
  gain: number;
  b0: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export interface GeneratedNamcoWsgWrite {
  offset: number;
  data: number;
  frac?: number;
  method?: string;
}

class GeneratedDacFilterCore {
  private readonly values = new Float64Array(3);
  private readonly levels: number[];
  private readonly filters: BiquadState[];
  private readonly outputGain: number;

  constructor(plan: DacFilterPlan, sampleRate: number) {
    this.levels = plan.levels;
    this.outputGain = plan.outputGain;
    this.filters = plan.channels.map(channel => {
      const omega = 2 * Math.PI * channel.frequency / sampleRate;
      const alpha = Math.sin(omega) / (2 * channel.q);
      const a0 = 1 + alpha;
      return {
        input: channel.input,
        gain: channel.gain,
        b0: alpha / a0,
        b2: -alpha / a0,
        a1: -2 * Math.cos(omega) / a0,
        a2: (1 - alpha) / a0,
        x1: 0,
        x2: 0,
        y1: 0,
        y2: 0,
      };
    });
  }

  write(input: number, data: number): void {
    if (input >= 0 && input < this.values.length) {
      this.values[input] = this.levels[data & 0x0f] ?? 0;
    }
  }

  renderInto(output: Float32Array): void {
    for (let index = 0; index < output.length; index++) {
      let mixed = 0;
      for (const filter of this.filters) {
        const x = this.values[filter.input] ?? 0;
        const y = filter.b0 * x + filter.b2 * filter.x2 -
          filter.a1 * filter.y1 - filter.a2 * filter.y2;
        filter.x2 = filter.x1;
        filter.x1 = x;
        filter.y2 = filter.y1;
        filter.y1 = y;
        mixed += y * filter.gain;
      }
      output[index] = Math.max(-1, Math.min(1, output[index]! + mixed * this.outputGain));
    }
  }
}

export class GeneratedNamcoWsgCore {
  readonly sampleRate: number;
  private readonly waveRom: Uint8Array;
  private readonly voices: Voice[];
  private readonly soundregs = new Uint8Array(plan.registerCount);
  private enabled = true;
  private readonly fracBits: number;
  private readonly discrete?: GeneratedDacFilterCore;

  constructor(waveRom: Uint8Array, clock: number, auxiliary?: DacFilterPlan) {
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
    if (auxiliary) this.discrete = new GeneratedDacFilterCore(auxiliary, this.sampleRate);
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

  writeDiscrete(channel: number, data: number): void {
    this.discrete?.write(channel, data);
  }

  render(out: Float32Array): void {
    out.fill(0);
    if (this.enabled) for (const voice of this.voices) {
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
    this.discrete?.renderInto(out);
  }

  renderFrame(out: Float32Array, writes: readonly GeneratedNamcoWsgWrite[]): void {
    const discreteWrites: GeneratedNamcoWsgWrite[] = [];
    for (const write of writes) {
      if (write.method === 'discrete') discreteWrites.push(write);
      else if (write.offset < 0) this.soundEnable(write.data);
      else this.write(write.offset, write.data);
    }

    let rendered = 0;
    let index = 0;
    while (index < discreteWrites.length) {
      const frac = Math.max(0, Math.min(1, discreteWrites[index]!.frac ?? 0));
      const position = Math.max(rendered, Math.min(out.length, Math.ceil(frac * out.length)));
      if (position > rendered) this.render(out.subarray(rendered, position));
      while (index < discreteWrites.length) {
        const write = discreteWrites[index]!;
        const writeFrac = Math.max(0, Math.min(1, write.frac ?? 0));
        const writePosition = Math.max(rendered, Math.min(out.length, Math.ceil(writeFrac * out.length)));
        if (writePosition !== position) break;
        this.writeDiscrete(write.offset, write.data);
        index++;
      }
      rendered = position;
    }
    if (rendered < out.length) this.render(out.subarray(rendered));
  }
}

export class GeneratedNamcoWsgFrameRenderer {
  private carry = 0;
  private readonly core: GeneratedNamcoWsgCore;
  private readonly refresh: number;

  constructor(core: GeneratedNamcoWsgCore, refresh: number) {
    this.core = core;
    this.refresh = refresh;
  }

  render(writes: readonly GeneratedNamcoWsgWrite[]): Float32Array {
    this.carry += this.core.sampleRate / this.refresh;
    const count = Math.floor(this.carry);
    this.carry -= count;
    const output = new Float32Array(count);
    this.core.renderFrame(output, writes);
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

class GeneratedNamcoWsgProcessor extends AudioWorkletProcessor {
  private core: GeneratedNamcoWsgCore | null = null;
  private renderer: GeneratedNamcoWsgFrameRenderer | null = null;
  private step = 1;
  private fraction = 0;
  private sample0 = 0;
  private sample1 = 0;
  private readonly frames: Float32Array[] = [];
  private current: Float32Array | null = null;
  private nativePosition = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        waveRom?: Uint8Array;
        clock?: number;
        refresh?: number;
        offset?: number;
        data?: number;
        method?: string;
        auxiliary?: DacFilterPlan;
        writes?: GeneratedNamcoWsgWrite[];
      };
      if (message.type === 'init') {
        const clock = message.clock ?? 96_000;
        this.core = new GeneratedNamcoWsgCore(
          message.waveRom ?? new Uint8Array(0x100),
          clock,
          message.auxiliary,
        );
        this.renderer = new GeneratedNamcoWsgFrameRenderer(
          this.core,
          message.refresh ?? 60,
        );
        this.step = this.core.sampleRate / sampleRate;
        this.current = null;
        this.nativePosition = 0;
      } else if (message.type === 'write') {
        this.apply(message.offset ?? 0, message.data ?? 0, message.method);
      } else if (message.type === 'batch' && this.renderer) {
        this.frames.push(this.renderer.render(message.writes ?? []));
        while (this.frames.length > 8) this.frames.shift();
      }
    };
  }

  private apply(offset: number, data: number, method?: string): void {
    if (method === 'discrete') this.core?.writeDiscrete(offset, data);
    else if (offset < 0) this.core?.soundEnable(data);
    else this.core?.write(offset, data);
  }

  private nextNative(): number {
    while (!this.current || this.nativePosition >= this.current.length) {
      this.current = this.frames.shift() ?? null;
      this.nativePosition = 0;
      if (!this.current) return 0;
    }
    return this.current[this.nativePosition++]!;
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
