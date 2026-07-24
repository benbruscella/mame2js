import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { GraphBuilder, type KnowledgeGraph } from '../kg/types.ts';
import { parseMameSource, type MameMacro, type MameTranslationUnit } from './ast.ts';
import { compileMameHandler } from './handler-ir.ts';
import { parseZ80OpcodeDsl } from './opcode-dsl.ts';
import {
  compileMameMcs48,
  compileMameI8080,
  compileMameKonami1,
  compileMameM6803,
  compileMameZ80,
} from './cpu-compiler.ts';
import { generatedCpuExecutableSource } from './cpu-codegen.ts';
import { generatedDeviceExecutableSource } from './device-codegen.ts';
import { compileMameDevice } from './device-compiler.ts';
import { compileNamco51Protocol } from './namco51-compiler.ts';
import { compileNamco53Protocol } from './namco53-compiler.ts';
import {
  compileAy8910,
  compileDiscreteSn76477,
  compileCounterLfsrDiscrete,
  compileMsm5205,
  compileNamcoWsg,
  generatedAy8910WorkletSource,
  generatedDiscreteSn76477WorkletSource,
  generatedCounterLfsrDiscreteWorkletSource,
  generatedNamcoWsgWorkletSource,
} from './audio-compiler.ts';

export interface HardwareUse {
  game: string;
  tags: string[];
}

export interface MameHardwareDefinition {
  type: string;
  className: string;
  shortName?: string;
  description?: string;
  sourceFile: string;
  sourceLine: number;
  sourceColumn: number;
  macro: string;
}

export interface HardwareMethodIr {
  name: string;
  parameters: string;
  sourceFile: string;
  sourceLine: number;
  body: string;
  program: ReturnType<typeof compileMameHandler>;
}

export interface HardwareClosureEntry {
  type: string;
  uses: HardwareUse[];
  status: 'source-resolved' | 'declarative-host' | 'unresolved';
  definition?: MameHardwareDefinition;
  methods: HardwareMethodIr[];
  dslFiles: string[];
  sourceFiles: string[];
  /** Child device types declared by this device's MAME device_add_mconfig. */
  composedOf?: string[];
  /**
   * Device classes whose own device_add_mconfig declares every use of this
   * type (e.g. MB8843 exists only as namco_51xx_device's internal MCU). When
   * every declaring class lowers to an executable device, this entry is
   * satisfied by that lowering rather than by its own core.
   */
  declaredBy?: string[];
}

export interface HardwareClosure {
  schemaVersion: 1;
  mameSource: string;
  targets: string[];
  hardware: HardwareClosureEntry[];
  summary: {
    types: number;
    sourceResolved: number;
    declarativeHost: number;
    unresolved: number;
    methods: number;
    compiledMethods: number;
    blockedMethods: number;
    dslFiles: number;
  };
}

const DECLARATIVE_HOST_TYPES = new Set([
  'DISCRETE',
  'FILTER_RC',
  'GFXDECODE',
  'PALETTE',
  'SCREEN',
  'SPEAKER',
  'WATCHDOG_TIMER',
]);

/**
 * Parse DEFINE_DEVICE_TYPE* macros through the source-preserving MAME AST.
 * The string pre-check only avoids running the full AST over unrelated files.
 */
export function deviceDefinitionsFromSource(
  file: string,
  source: string,
): MameHardwareDefinition[] {
  if (!source.includes('DEFINE_DEVICE_TYPE') && !source.includes('DAC_GENERATOR')) return [];
  return parseMameSource(file, source).macros
    .filter(macro =>
      macro.name.startsWith('DEFINE_DEVICE_TYPE') ||
      macro.name === 'DAC_GENERATOR')
    .flatMap(definitionFromMacro);
}

function definitionFromMacro(macro: MameMacro): MameHardwareDefinition[] {
  if (macro.name === 'DAC_GENERATOR') {
    const type = cleanToken(macro.args[0]);
    const className = cleanToken(macro.args[1]);
    if (!type || !className) return [];
    return [{
      type,
      className,
      description: unquote(macro.args[6]),
      shortName: unquote(macro.args[7]),
      sourceFile: macro.span.file,
      sourceLine: macro.span.line,
      sourceColumn: macro.span.column,
      macro: macro.text,
    }];
  }
  const privateType = macro.name.includes('PRIVATE');
  const type = cleanToken(macro.args[0]);
  const className = cleanToken(macro.args[privateType ? 2 : 1]);
  if (!type || !className) return [];
  const shortNameIndex = privateType ? 3 : 2;
  const descriptionIndex = privateType ? 4 : 3;
  const shortName = unquote(macro.args[shortNameIndex]);
  const description = unquote(macro.args[descriptionIndex]);
  return [{
    type,
    className,
    ...(shortName ? { shortName } : {}),
    ...(description ? { description } : {}),
    sourceFile: macro.span.file,
    sourceLine: macro.span.line,
    sourceColumn: macro.span.column,
    macro: macro.text,
  }];
}

function cleanToken(value: string | undefined): string {
  return (value ?? '').trim().replace(/^&/, '');
}

function unquote(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  const match = trimmed && /^"([\s\S]*)"$/.exec(trimmed);
  return match?.[1];
}

export function indexMameHardware(mameSrc: string): Map<string, MameHardwareDefinition> {
  const roots = [join(mameSrc, 'src/devices'), join(mameSrc, 'src/mame')]
    .filter(existsSync);
  const definitions = new Map<string, MameHardwareDefinition>();
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const definition of deviceDefinitionsFromSource(relative(mameSrc, file), source)) {
        definitions.set(definition.type, definition);
      }
    }
  }
  return definitions;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && ['.cpp', '.h'].includes(extname(entry.name))) files.push(file);
    }
  }
  return files.sort();
}

export function buildHardwareClosure(
  mameSrc: string,
  targetGraphs: { game: string; graph: KnowledgeGraph }[],
): HardwareClosure {
  const definitions = indexMameHardware(mameSrc);
  const uses = new Map<string, Map<string, Set<string>>>();
  // Device-node ids encode where the device was declared:
  //   device:<class>.device_add_mconfig/<tag> — inside another device
  //   device:<machineConfig>/<tag>            — at board level
  // A type declared ONLY inside other devices' configs is an internal part.
  const declaringClasses = new Map<string, Set<string>>();
  const boardLevel = new Set<string>();
  const composedTypes = new Map<string, Set<string>>();
  for (const { game, graph } of targetGraphs) {
    const devices = graph.nodes.filter(node => node.label === 'Device');
    const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
    const outgoing = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) {
      const edges = outgoing.get(edge.from) ?? [];
      edges.push(edge);
      outgoing.set(edge.from, edges);
    }
    for (const device of devices) {
      const type = String(device.props.type);
      const games = uses.get(type) ?? new Map<string, Set<string>>();
      const tags = games.get(game) ?? new Set<string>();
      tags.add(String(device.props.tag));
      games.set(game, tags);
      uses.set(type, games);
      const declared = /^device:(\w+)\.device_add_mconfig\//.exec(device.id);
      if (declared) {
        const classes = declaringClasses.get(type) ?? new Set<string>();
        classes.add(declared[1]!);
        declaringClasses.set(type, classes);
      } else {
        boardLevel.add(type);
      }
      for (const call of (outgoing.get(device.id) ?? []).filter(edge => edge.rel === 'CALLS')) {
        const config = nodesById.get(call.to);
        if (config?.label !== 'MachineConfig') continue;
        const children = composedTypes.get(type) ?? new Set<string>();
        for (const edge of (outgoing.get(config.id) ?? []).filter(edge => edge.rel === 'HAS_DEVICE')) {
          const child = nodesById.get(edge.to);
          if (child?.label === 'Device') children.add(String(child.props.type));
        }
        if (children.size) composedTypes.set(type, children);
      }
    }
  }

  const unitCache = new Map<string, MameTranslationUnit>();
  const hardware = [...uses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, games]): HardwareClosureEntry => {
      const definition = resolveDefinition(type, definitions);
      const usedBy = [...games.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([game, tags]) => ({ game, tags: [...tags].sort() }));
      if (!definition || DECLARATIVE_HOST_TYPES.has(type)) {
        return {
          type,
          uses: usedBy,
          status: DECLARATIVE_HOST_TYPES.has(type) ? 'declarative-host' : 'unresolved',
          ...(definition ? { definition } : {}),
          methods: [],
          dslFiles: [],
          sourceFiles: [],
          ...(composedTypes.has(type) ? { composedOf: [...composedTypes.get(type)!].sort() } : {}),
          ...(declaringClasses.has(type) && !boardLevel.has(type)
            ? { declaredBy: [...declaringClasses.get(type)!].sort() }
            : {}),
        };
      }

      const absolute = join(mameSrc, definition.sourceFile);
      const unit = unitCache.get(absolute) ??
        parseMameSource(definition.sourceFile, readFileSync(absolute, 'utf8'));
      unitCache.set(absolute, unit);
      const methods = unit.functions
        .filter(fn => fn.className === definition.className)
        .map(fn => ({
          name: fn.name,
          parameters: fn.parameters,
          sourceFile: fn.span.file,
          sourceLine: fn.span.line,
          body: fn.body,
          program: compileMameHandler(fn.body),
        }));
      const dslFiles = findDeviceDslFiles(absolute, definition.className)
        .map(file => relative(mameSrc, file));
      const sourceFiles = sourceClosureFiles(
        absolute,
        dslFiles.map(file => join(mameSrc, file)),
      ).map(file => relative(mameSrc, file));
      return {
        type,
        uses: usedBy,
        status: 'source-resolved',
        definition,
        methods,
        dslFiles,
        sourceFiles,
        ...(composedTypes.has(type) ? { composedOf: [...composedTypes.get(type)!].sort() } : {}),
        ...(declaringClasses.has(type) && !boardLevel.has(type)
          ? { declaredBy: [...declaringClasses.get(type)!].sort() }
          : {}),
      };
    });

  const methods = hardware.flatMap(entry => entry.methods);
  return {
    schemaVersion: 1,
    mameSource: resolve(mameSrc),
    targets: targetGraphs.map(target => target.game).sort(),
    hardware,
    summary: {
      types: hardware.length,
      sourceResolved: hardware.filter(entry => entry.status === 'source-resolved').length,
      declarativeHost: hardware.filter(entry => entry.status === 'declarative-host').length,
      unresolved: hardware.filter(entry => entry.status === 'unresolved').length,
      methods: methods.length,
      compiledMethods: methods.filter(method => method.program.diagnostics.length === 0).length,
      blockedMethods: methods.filter(method => method.program.diagnostics.length > 0).length,
      dslFiles: new Set(hardware.flatMap(entry => entry.dslFiles)).size,
    },
  };
}

export function resolveCompositeExecutableTypes(
  hardware: HardwareClosureEntry[],
  leafTypes: ReadonlySet<string>,
): Set<string> {
  const executable = new Set(leafTypes);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of hardware) {
      if (executable.has(entry.type) || !entry.composedOf?.length) continue;
      const complete = entry.composedOf.every(type => {
        const child = hardware.find(candidate => candidate.type === type);
        return child?.status === 'declarative-host' || executable.has(type);
      });
      if (complete) {
        executable.add(entry.type);
        changed = true;
      }
    }
  }
  return executable;
}

function resolveDefinition(
  type: string,
  definitions: Map<string, MameHardwareDefinition>,
): MameHardwareDefinition | undefined {
  const aliases: Record<string, string> = {
    MC6809: 'M6809',
    MC6809E: 'M6809E',
  };
  return definitions.get(type) ?? definitions.get(aliases[type] ?? '');
}

function findDeviceDslFiles(sourceFile: string, className: string): string[] {
  const dir = dirname(sourceFile);
  const stem = basename(sourceFile, extname(sourceFile));
  return readdirSync(dir)
    .filter(file => file.endsWith('.lst'))
    .filter(file => {
      const lower = file.toLowerCase();
      return lower.includes(stem.toLowerCase()) ||
        lower.includes(className.replace(/_device$/, '').toLowerCase()) ||
        (stem === 'rp2a03' && lower.includes('6502')) ||
        (stem === 'konami' && lower.includes('konami'));
    })
    .map(file => join(dir, file))
    .sort();
}

function sourceClosureFiles(sourceFile: string, dslFiles: string[]): string[] {
  const files = new Set([sourceFile, ...dslFiles]);
  const source = readFileSync(sourceFile, 'utf8');
  for (const match of source.matchAll(/^\s*#include\s+"([^"]+)"/gm)) {
    const local = join(dirname(sourceFile), match[1]);
    if (existsSync(local) && statSync(local).isFile()) files.add(local);
  }
  const sameStemHeader = join(
    dirname(sourceFile),
    `${basename(sourceFile, extname(sourceFile))}.h`,
  );
  if (existsSync(sameStemHeader)) files.add(sameStemHeader);
  return [...files].sort();
}

export function hardwareKnowledgeGraph(
  closure: HardwareClosure,
  executableTypes: ReadonlySet<string> = new Set(),
): KnowledgeGraph {
  const graph = new GraphBuilder();
  for (const entry of closure.hardware) {
    const typeId = `hardware:${entry.type}`;
    graph.node('HardwareType', typeId, {
      type: entry.type,
      status: entry.status,
      games: entry.uses.map(use => use.game),
    });
    for (const use of entry.uses) {
      const gameId = `game:${use.game}`;
      graph.node('Game', gameId, { name: use.game });
      graph.edge(gameId, typeId, 'USES_HARDWARE', { tags: use.tags });
    }
    if (entry.definition) {
      const implementationId = `hardware-implementation:${entry.definition.className}`;
      graph.node('HardwareImplementation', implementationId, {
        className: entry.definition.className,
        sourceFile: entry.definition.sourceFile,
        sourceLine: entry.definition.sourceLine,
        sourceColumn: entry.definition.sourceColumn,
      });
      graph.edge(implementationId, typeId, 'IMPLEMENTS');
      for (const method of entry.methods) {
        const methodId = `hardware-method:${entry.definition.className}:${method.name}`;
        graph.node('HardwareMethod', methodId, {
          className: entry.definition.className,
          method: method.name,
          sourceFile: method.sourceFile,
          sourceLine: method.sourceLine,
          compiled: method.program.diagnostics.length === 0,
          diagnostics: method.program.diagnostics,
        });
        graph.edge(implementationId, methodId, 'HAS_METHOD');
      }
      for (const dsl of entry.dslFiles) {
        const dslId = `hardware-dsl:${dsl}`;
        graph.node('HardwareDsl', dslId, { path: dsl });
        graph.edge(implementationId, dslId, 'HAS_DSL');
      }
    }
    const artifactId = `generated-artifact:device:${entry.type}`;
    graph.node('GeneratedArtifact', artifactId, {
      path: `devices/${entry.type.toLowerCase()}.ts`,
      executable: executableTypes.has(entry.type),
      stage: executableTypes.has(entry.type) ? 'executable-ir' : 'source-ir',
    });
    graph.edge(typeId, artifactId, 'EMITS');
  }
  return graph.toGraph({
    tool: 'mamekit',
    version: '0.1.0',
    schemaVersion: 1,
    mameSrc: closure.mameSource,
    driverFile: '<hardware-closure>',
    generatedAt: new Date().toISOString(),
  });
}

export function emitHardwareClosure(closure: HardwareClosure, outRoot: string): void {
  const root = join(outRoot, 'runtime/generated');
  const devicesDir = join(root, 'devices');
  const dslDir = join(root, 'dsl');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(devicesDir, { recursive: true });
  mkdirSync(dslDir, { recursive: true });

  const compactEntry = (entry: HardwareClosureEntry) => ({
    ...entry,
    methods: entry.methods.map(method => ({
      name: method.name,
      parameters: method.parameters,
      sourceFile: method.sourceFile,
      sourceLine: method.sourceLine,
      program: method.program,
    })),
  });
  const z80 = closure.hardware.some(entry => entry.type === 'Z80')
    ? compileMameZ80(closure.mameSource)
    : undefined;
  const i8080 = closure.hardware.some(entry => entry.type === 'I8080')
    ? compileMameI8080(closure.mameSource)
    : undefined;
  const i8039 = closure.hardware.some(entry => entry.type === 'I8039')
    ? compileMameMcs48(closure.mameSource)
    : undefined;
  const m6803 = closure.hardware.some(entry => entry.type === 'M6803')
    ? compileMameM6803(closure.mameSource)
    : undefined;
  const konami1 = closure.hardware.some(entry => entry.type === 'KONAMI1')
    ? compileMameKonami1(closure.mameSource)
    : undefined;
  const generatedDevices = new Map(
    closure.hardware
      .filter(entry => [
        'GENERIC_LATCH_8',
        'ER2055',
        'LS259',
        'MB14241',
        'MB8844',
        'NAMCO_06XX',
        'NAMCO_54XX',
        'STARFIELD_05XX',
      ].includes(entry.type))
      .flatMap(entry => {
        if (!entry.definition) return [];
        const device = compileMameDevice(closure.mameSource, entry.definition);
        if (device.summary.diagnostics) return [];
        return [[entry.type, device] as const];
      }),
  );
  if (closure.hardware.some(entry => entry.type === 'NAMCO_51XX')) {
    generatedDevices.set('NAMCO_51XX', compileNamco51Protocol());
  }
  if (closure.hardware.some(entry => entry.type === 'NAMCO_53XX')) {
    generatedDevices.set('NAMCO_53XX', compileNamco53Protocol());
  }
  const namcoEntry = closure.hardware.find(entry => entry.type === 'NAMCO_WSG');
  const namcoWsg = namcoEntry?.definition
    ? compileNamcoWsg(closure.mameSource, namcoEntry.definition)
    : undefined;
  const ayEntry = closure.hardware.find(entry => entry.type === 'AY8910');
  const ay8910 = ayEntry?.definition
    ? compileAy8910(closure.mameSource, ayEntry.definition)
    : undefined;
  const msmEntry = closure.hardware.find(entry => entry.type === 'MSM5205');
  const msm5205 = msmEntry?.definition
    ? compileMsm5205(closure.mameSource, msmEntry.definition)
    : undefined;
  const routedDac = ay8910 && closure.hardware.some(entry =>
    entry.type === 'DAC_8BIT_R2R');
  const snGames = new Set(
    closure.hardware.find(entry => entry.type === 'SN76477')?.uses.map(use => use.game) ?? [],
  );
  const discreteSoundboardEntry = closure.hardware.find(entry =>
    entry.type.endsWith('_AUDIO') &&
    entry.definition &&
    entry.uses.some(use => snGames.has(use.game)));
  const discreteSn76477 = discreteSoundboardEntry?.definition
    ? compileDiscreteSn76477(closure.mameSource, discreteSoundboardEntry.definition)
    : undefined;
  const counterLfsrEntry = closure.hardware.find(entry =>
    entry.type.endsWith('_SOUND') &&
    entry.definition &&
    ['pitch_w', 'lfo_freq_w', 'sound_w'].every(name =>
      entry.methods.some(method => method.name === name)));
  const counterLfsrDiscrete = counterLfsrEntry?.definition
    ? compileCounterLfsrDiscrete(closure.mameSource, counterLfsrEntry.definition)
    : undefined;
  for (const entry of closure.hardware) {
    const device = generatedDevices.get(entry.type);
    if (!device) continue;
    const previousMethods = entry.methods;
    entry.methods = device.methods.map(method => ({
      name: method.name,
      parameters: method.parameters,
      sourceFile: method.source.file,
      sourceLine: method.source.line,
      body: '',
      program: method.program,
    }));
    entry.sourceFiles = device.sourceFiles;
    closure.summary.methods += entry.methods.length - previousMethods.length;
    closure.summary.compiledMethods +=
      entry.methods.filter(method => !method.program.diagnostics.length).length -
      previousMethods.filter(method => !method.program.diagnostics.length).length;
    closure.summary.blockedMethods +=
      entry.methods.filter(method => method.program.diagnostics.length).length -
      previousMethods.filter(method => method.program.diagnostics.length).length;
  }
  const leafExecutableTypes = new Set<string>([
    ...(z80 ? ['Z80'] : []),
    ...(i8080 ? ['I8080'] : []),
    ...(i8039 ? ['I8039'] : []),
    ...(m6803 ? ['M6803'] : []),
    ...(konami1 ? ['KONAMI1'] : []),
    ...generatedDevices.keys(),
    ...(namcoWsg ? ['NAMCO_WSG'] : []),
    ...(ay8910 ? ['AY8910'] : []),
    ...(msm5205 && ay8910 ? ['MSM5205'] : []),
    ...(routedDac ? ['DAC_8BIT_R2R'] : []),
    ...(discreteSn76477 ? [discreteSn76477.deviceType, 'SN76477'] : []),
    ...(counterLfsrDiscrete ? [counterLfsrDiscrete.deviceType] : []),
  ]);
  const executableTypes = resolveCompositeExecutableTypes(
    closure.hardware,
    leafExecutableTypes,
  );
  const compositeTypes = new Set(
    closure.hardware
      .filter(entry => entry.composedOf?.length && executableTypes.has(entry.type))
      .map(entry => entry.type),
  );
  // A type declared only inside other devices' configs is satisfied when every
  // declaring class lowers to an executable device (the 51xx protocol device
  // replaces its internal MB8843 core, so MB8843 is not a generation gap).
  const classTypes = new Map(closure.hardware
    .filter(entry => entry.definition)
    .map(entry => [entry.definition!.className, entry.type] as const));
  const hostedBy = (entry: HardwareClosureEntry): string[] | undefined => {
    if (!entry.declaredBy?.length) return undefined;
    const hosts = entry.declaredBy.map(cls => classTypes.get(cls));
    return hosts.every(host => host !== undefined && executableTypes.has(host))
      ? (hosts as string[]).sort()
      : undefined;
  };
  const compact = {
    ...closure,
    hardware: closure.hardware.map(entry => ({
      ...compactEntry(entry),
      executable: executableTypes.has(entry.type),
      ...(hostedBy(entry) ? { hostedBy: hostedBy(entry) } : {}),
      ...(['Z80', 'I8080', 'I8039', 'M6803', 'KONAMI1'].includes(entry.type)
        ? {
            executableKind: 'cpu',
            executableArtifact: `devices/${entry.type.toLowerCase()}.cpu.ir.json`,
          }
        : generatedDevices.has(entry.type)
          ? {
              executableKind: 'device',
              executableArtifact: `devices/${entry.type.toLowerCase()}.device.ir.json`,
            }
        : entry.type === 'NAMCO_WSG'
          ? {
              executableKind: 'audio',
              executableArtifact: 'audio/wsg-worklet.ts',
            }
        : entry.type === 'AY8910'
          ? {
              executableKind: 'audio',
              executableArtifact: 'audio/ay8910-worklet.ts',
            }
        : entry.type === 'MSM5205' && msm5205 && ay8910
          ? {
              executableKind: 'audio',
              executableArtifact: 'audio/msm5205.audio.ir.json',
            }
        : entry.type === 'DAC_8BIT_R2R' && routedDac
          ? {
              executableKind: 'audio',
              executableArtifact: 'audio/ay8910-worklet.ts',
            }
        : compositeTypes.has(entry.type)
          ? {
              executableKind: 'composition',
              executableArtifact: 'generated machine handlers',
            }
        : discreteSn76477 &&
            (entry.type === discreteSn76477.deviceType || entry.type === 'SN76477')
          ? {
              executableKind: entry.type === 'SN76477' ? 'composition' : 'audio',
              executableArtifact: `audio/${discreteSn76477.workletName}-worklet.ts`,
            }
        : counterLfsrDiscrete && entry.type === counterLfsrDiscrete.deviceType
          ? {
              executableKind: 'audio',
              executableArtifact: `audio/${counterLfsrDiscrete.workletName}-worklet.ts`,
            }
        : {}),
    })),
  };
  writeFileSync(join(root, 'hardware-manifest.json'), JSON.stringify(compact, null, 2));
  writeFileSync(
    join(root, 'hardware-graph.json'),
    JSON.stringify(hardwareKnowledgeGraph(closure, executableTypes), null, 2),
  );
  if (namcoWsg) {
    const audioDir = join(root, 'audio');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, 'namco-wsg.audio.ir.json'),
      JSON.stringify(namcoWsg, null, 2),
    );
    writeFileSync(join(audioDir, 'wsg-worklet.ts'), generatedNamcoWsgWorkletSource(namcoWsg));
  }
  if (ay8910) {
    const audioDir = join(root, 'audio');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, 'ay8910.audio.ir.json'),
      JSON.stringify(ay8910, null, 2),
    );
    writeFileSync(
      join(audioDir, 'ay8910-worklet.ts'),
      generatedAy8910WorkletSource(ay8910, msm5205),
    );
  }
  if (msm5205 && ay8910) {
    const audioDir = join(root, 'audio');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, 'msm5205.audio.ir.json'),
      JSON.stringify(msm5205, null, 2),
    );
  }
  if (discreteSn76477) {
    const audioDir = join(root, 'audio');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, `${discreteSn76477.workletName}.audio.ir.json`),
      JSON.stringify(discreteSn76477, null, 2),
    );
    writeFileSync(
      join(audioDir, `${discreteSn76477.workletName}-worklet.ts`),
      generatedDiscreteSn76477WorkletSource(discreteSn76477),
    );
  }
  if (counterLfsrDiscrete) {
    const audioDir = join(root, 'audio');
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(
      join(audioDir, `${counterLfsrDiscrete.workletName}.audio.ir.json`),
      JSON.stringify(counterLfsrDiscrete, null, 2),
    );
    writeFileSync(
      join(audioDir, `${counterLfsrDiscrete.workletName}-worklet.ts`),
      generatedCounterLfsrDiscreteWorkletSource(counterLfsrDiscrete),
    );
  }

  for (const entry of closure.hardware) {
    const slug = entry.type.toLowerCase();
    const emitted = compactEntry(entry);
    writeFileSync(join(devicesDir, `${slug}.ir.json`), JSON.stringify(emitted, null, 2));
    const cpu = entry.type === 'Z80'
      ? z80
      : entry.type === 'I8080'
        ? i8080
        : entry.type === 'I8039'
          ? i8039
        : entry.type === 'M6803'
          ? m6803
          : entry.type === 'KONAMI1'
            ? konami1
          : undefined;
    if (cpu) {
      writeFileSync(
        join(devicesDir, `${slug}.cpu.ir.json`),
        JSON.stringify(cpu, null, 2),
      );
      writeFileSync(join(devicesDir, `${slug}.ts`), generatedCpuExecutableSource(cpu));
      continue;
    }
    const device = generatedDevices.get(entry.type);
    if (device) {
      writeFileSync(
        join(devicesDir, `${slug}.device.ir.json`),
        JSON.stringify(device, null, 2),
      );
      writeFileSync(
        join(devicesDir, `${slug}.ts`),
        generatedDeviceExecutableSource(device, `${slug}.device.ir.json`),
      );
      continue;
    }
  }

  for (const file of new Set(closure.hardware.flatMap(entry => entry.dslFiles))) {
    const absolute = join(closure.mameSource, file);
    const stem = basename(file, extname(file));
    if (basename(file) === 'z80.lst') {
      const ir = parseZ80OpcodeDsl(file, readFileSync(absolute, 'utf8'));
      writeFileSync(join(dslDir, `${stem}.ir.json`), JSON.stringify(ir, null, 2));
    } else {
      writeFileSync(join(dslDir, `${stem}.source.json`), JSON.stringify({
        schemaVersion: 1,
        dialect: 'unlowered-mame-operation-dsl',
        sourceFile: file,
      }, null, 2));
    }
  }

  const lines = [
    '# Generated MAME hardware closure',
    '',
    `Targets: **${closure.targets.length}**`,
    '',
    `Hardware types: **${closure.summary.types}**`,
    '',
    `Source-resolved: **${closure.summary.sourceResolved}**`,
    '',
    `Declarative browser-host concepts: **${closure.summary.declarativeHost}**`,
    '',
    `Unresolved: **${closure.summary.unresolved}**`,
    '',
    `Source methods lowered to IR: **${closure.summary.compiledMethods}/${closure.summary.methods}**`,
    '',
    `MAME opcode/operation DSL files: **${closure.summary.dslFiles}**`,
    '',
    '## Hardware',
    '',
    '| Type | Status | MAME implementation | Games |',
    '|---|---|---|---|',
    ...closure.hardware.map(entry =>
      `| ${entry.type} | ${entry.status} | ` +
      `${entry.definition
        ? `${entry.definition.className} (${entry.definition.sourceFile}:${entry.definition.sourceLine})`
        : '-'} | ${entry.uses.map(use => use.game).join(', ')} |`),
    '',
    'Generated device modules are currently structured IR. They become executable as',
    'the device compiler gains the required MAME constructs; `executable: false` in the',
    'hardware graph prevents source extraction alone from being reported as completion.',
    '',
  ];
  writeFileSync(join(root, 'hardware-report.md'), lines.join('\n'));
}
