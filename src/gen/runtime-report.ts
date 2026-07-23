import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeGraph, KGNode } from '../kg/types.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';
import { GAME_CATEGORIES, gameOutputDir } from './output-layout.ts';
import { normalizeMameExecutionSource } from '../mame/cpu-compiler.ts';

interface RuntimeRange {
  kind: string;
  read?: string;
  write?: string;
}

interface RuntimeCpu {
  tag: string;
  type?: string;
  ranges?: RuntimeRange[];
  io?: { ranges: RuntimeRange[] };
}

export interface RuntimeConfigShape {
  game: string;
  family: string;
  dataPath?: string;
  board: {
    cpus: RuntimeCpu[];
    ranges: RuntimeRange[];
    io?: { ranges: RuntimeRange[] };
  };
}

export interface HardwareGenerationEntry {
  type: string;
  status: 'source-resolved' | 'declarative-host' | 'unresolved';
  executable?: boolean;
  /** internal part satisfied by these executable host devices */
  hostedBy?: string[];
  executableKind?: 'cpu' | 'device' | 'audio';
  executableArtifact?: string;
  definition?: {
    sourceFile: string;
    sourceLine: number;
  };
  uses?: { game: string; tags: string[] }[];
}

export interface HardwareGenerationManifest {
  hardware?: HardwareGenerationEntry[];
}

export type GenerationStatus =
  | 'executable'
  | 'generated'
  | 'declarative-host'
  | 'blocked'
  | 'missing';

export interface RuntimeRequirement {
  name: string;
  status: GenerationStatus;
  source?: string;
  reason?: string;
}

export interface RuntimeReport {
  schemaVersion: 2;
  game: string;
  family: string;
  boardMode: 'generated' | 'missing';
  playable: boolean;
  generationGaps: string[];
  sourceCoverage: { covered: number; total: number; percent: number };
  requirements: {
    cpus: RuntimeRequirement[];
    devices: RuntimeRequirement[];
    handlers: RuntimeRequirement[];
    callbacks: RuntimeRequirement[];
    composition: RuntimeRequirement[];
  };
  parserGaps: { construct: string; source?: string; raw: string }[];
  handlerCompiler: {
    sourceMethods: number;
    compiledMethods: number;
    blockedMethods: number;
    usedCompiledHandlers: number;
    usedBlockedHandlers: number;
  };
  executionCompiler: {
    cpuPlans: number;
    frameCallbacks: number;
    screenUpdate?: string;
    screenUpdateCompiled: boolean;
    screenUpdateDiagnostics: string[];
  };
  summary: Record<GenerationStatus, number>;
}

const GENERIC_HANDLER_PREFIXES = ['port.', 'bank.', 'watchdog.'];

function hardwareStatus(entry: HardwareGenerationEntry | undefined): {
  status: GenerationStatus;
  reason?: string;
} {
  if (!entry) return { status: 'missing', reason: 'not present in generated hardware closure' };
  if (entry.executable) return { status: 'executable' };
  if (entry.hostedBy?.length) {
    return {
      status: 'executable',
      reason: `internal part of executable ${entry.hostedBy.join(', ')}`,
    };
  }
  if (entry.status === 'declarative-host') return { status: 'declarative-host' };
  if (entry.status === 'source-resolved') {
    return { status: 'blocked', reason: 'MAME source resolved but executable lowering is incomplete' };
  }
  return { status: 'missing', reason: 'MAME hardware implementation was not resolved' };
}

function hardwareSource(entry: HardwareGenerationEntry | undefined): string | undefined {
  return entry?.definition
    ? `${entry.definition.sourceFile}:${entry.definition.sourceLine}`
    : undefined;
}

export function buildRuntimeReport(
  graph: KnowledgeGraph,
  config: RuntimeConfigShape,
  manifest: HardwareGenerationManifest = {},
): RuntimeReport {
  const sourceNodes = graph.nodes.filter(node => node.label !== 'SourceFile');
  const covered = sourceNodes.filter(node => typeof node.props.sourceFile === 'string').length;
  const nodeSource = (node: KGNode): string | undefined =>
    typeof node.props.sourceFile === 'string'
      ? `${node.props.sourceFile}:${node.props.sourceLine ?? '?'}`
      : undefined;
  const hardwareByType = new Map(
    (manifest.hardware ?? []).map(entry => [entry.type, entry]),
  );
  const deviceNodes = graph.nodes.filter(node => node.label === 'Device');
  const deviceByTag = new Map(deviceNodes.map(node => [String(node.props.tag), node]));

  const requirementForDevice = (tag: string, type: string): RuntimeRequirement => {
    const entry = hardwareByType.get(type);
    const resolved = hardwareStatus(entry);
    return {
      name: `${tag}:${type}`,
      status: resolved.status,
      ...(hardwareSource(entry) ? { source: hardwareSource(entry) } : {}),
      ...(resolved.reason ? { reason: resolved.reason } : {}),
    };
  };

  const cpus: RuntimeRequirement[] = config.board.cpus.map(cpu => {
    const type = String(deviceByTag.get(cpu.tag)?.props.type ?? cpu.type ?? 'Z80').toUpperCase();
    return requirementForDevice(cpu.tag, type);
  });
  const cpuTags = new Set(config.board.cpus.map(cpu => cpu.tag));
  const devices = deviceNodes
    .filter(node => !cpuTags.has(String(node.props.tag)))
    .map(node => requirementForDevice(String(node.props.tag), String(node.props.type)));
  const deviceRequirementByTag = new Map(
    [...cpus, ...devices].map(requirement => [requirement.name.split(':')[0]!, requirement]),
  );

  const allRanges = config.board.cpus.flatMap(cpu => [
    ...(cpu.ranges ?? []),
    ...(cpu.io?.ranges ?? []),
  ]);
  const handlerNames = [...new Set(allRanges.flatMap(range =>
    [range.read, range.write].filter((name): name is string => !!name),
  ))].sort();
  const sourceHandlers = graph.nodes
    .filter(node => node.label === 'Handler' && typeof node.props.sourceBody === 'string')
    .map(node => ({
      node,
      key: `${node.props.ownerClass}.${node.props.method}`,
      program: compileMameHandler(
        normalizeMameExecutionSource(String(node.props.sourceBody)),
      ),
    }));
  const sourceHandlerByKey = new Map(sourceHandlers.map(handler => [handler.key, handler]));
  const handlers: RuntimeRequirement[] = handlerNames.map(name => {
    const prefix = name.split('.')[0]!;
    const sourceHandler = sourceHandlerByKey.get(name);
    if (GENERIC_HANDLER_PREFIXES.some(generic => name.startsWith(generic))) {
      return { name, status: 'generated' };
    }
    if (sourceHandler?.program.diagnostics.length === 0) {
      return { name, status: 'generated', source: nodeSource(sourceHandler.node) };
    }
    const device = deviceRequirementByTag.get(prefix);
    if (device) {
      return {
        name,
        status: device.status,
        ...(device.source ? { source: device.source } : {}),
        ...(device.reason ? { reason: device.reason } : {}),
      };
    }
    return {
      name,
      status: sourceHandler ? 'blocked' : 'missing',
      ...(sourceHandler ? { source: nodeSource(sourceHandler.node) } : {}),
      reason: sourceHandler
        ? sourceHandler.program.diagnostics.join('; ')
        : 'handler has no generated source program or executable device',
    };
  });

  const callbacks: RuntimeRequirement[] = graph.nodes
    .filter(node => node.label === 'Callback')
    .map(node => ({
      name: `${node.props.ownerTag}.${node.props.signal}` +
        `${node.props.slot !== undefined ? `<${node.props.slot}>` : ''} -> ` +
        `${node.props.targetTag ?? node.props.targetClass ?? node.props.targetPort ?? node.props.operation}` +
        `${node.props.targetMethod ? `.${node.props.targetMethod}` : ''}`,
      status: 'generated',
      source: nodeSource(node),
    }));
  const composition: RuntimeRequirement[] = config.board.cpus.length
    ? [{ name: `${config.dataPath ?? config.game}/generated/board.ts`, status: 'generated' }]
    : [{
        name: `${config.dataPath ?? config.game}/generated/board.ts`,
        status: 'missing',
        reason: 'no CPU execution plan was generated',
      }];

  const mapParserGaps = graph.nodes
    .filter(node => node.label === 'AddressRange')
    .flatMap(node => {
      const raw = String(node.props.raw ?? '');
      const unsupported = [...raw.matchAll(/\.(l[wr]+8|select|umask\d*)\s*\(/g)]
        .map(match => match[1]!);
      if (!unsupported.length) return [];
      const hasHandler = graph.edges.some(edge =>
        edge.from === node.id && (edge.rel === 'READS' || edge.rel === 'WRITES'),
      );
      return hasHandler ? [] : unsupported.map(construct => ({
        construct,
        source: nodeSource(node),
        raw,
      }));
    });
  const usedHandlerNames = new Set(handlerNames);
  const handlerParserGaps = sourceHandlers
    .filter(handler => usedHandlerNames.has(handler.key))
    .flatMap(handler => handler.program.diagnostics.map(diagnostic => ({
      construct: `handler:${diagnostic}`,
      source: nodeSource(handler.node),
      raw: `${handler.key}: ${String(handler.node.props.sourceBody)}`,
    })));
  const parserGaps = [...mapParserGaps, ...handlerParserGaps];
  const usedSourceHandlers = sourceHandlers.filter(handler => usedHandlerNames.has(handler.key));
  const screenCallback = graph.nodes.find(node =>
    node.label === 'Callback' && node.props.signal === 'set_screen_update');
  const screenUpdate = screenCallback?.props.targetClass && screenCallback.props.targetMethod
    ? `${screenCallback.props.targetClass}.${screenCallback.props.targetMethod}`
    : undefined;
  const screenProgram = screenUpdate ? sourceHandlerByKey.get(screenUpdate)?.program : undefined;
  const frameCallbacks = graph.nodes.filter(node =>
    node.label === 'Callback' &&
    ['screen_vblank', 'set_vblank_int', 'set_periodic_int'].includes(String(node.props.signal)),
  ).length;

  const every = [...cpus, ...devices, ...handlers, ...callbacks, ...composition];
  const summary = Object.fromEntries(
    (['executable', 'generated', 'declarative-host', 'blocked', 'missing'] as const)
      .map(status => [status, every.filter(item => item.status === status).length]),
  ) as Record<GenerationStatus, number>;
  const generationGaps = [...cpus, ...devices]
    .filter(item => item.status === 'blocked' || item.status === 'missing')
    .map(item => item.name)
    .sort();
  const boardMode = config.board.cpus.length ? 'generated' : 'missing';
  const screenUpdateCompiled = Boolean(screenProgram && screenProgram.diagnostics.length === 0);

  return {
    schemaVersion: 2,
    game: config.game,
    family: config.family,
    boardMode,
    playable: boardMode === 'generated' &&
      generationGaps.length === 0 &&
      summary.blocked === 0 &&
      summary.missing === 0 &&
      screenUpdateCompiled,
    generationGaps,
    sourceCoverage: {
      covered,
      total: sourceNodes.length,
      percent: sourceNodes.length ? Math.round(covered / sourceNodes.length * 1000) / 10 : 100,
    },
    requirements: { cpus, devices, handlers, callbacks, composition },
    parserGaps,
    handlerCompiler: {
      sourceMethods: sourceHandlers.length,
      compiledMethods: sourceHandlers.filter(handler => handler.program.diagnostics.length === 0).length,
      blockedMethods: sourceHandlers.filter(handler => handler.program.diagnostics.length > 0).length,
      usedCompiledHandlers: usedSourceHandlers.filter(handler => handler.program.diagnostics.length === 0).length,
      usedBlockedHandlers: usedSourceHandlers.filter(handler => handler.program.diagnostics.length > 0).length,
    },
    executionCompiler: {
      cpuPlans: config.board.cpus.length,
      frameCallbacks,
      ...(screenUpdate ? { screenUpdate } : {}),
      screenUpdateCompiled,
      screenUpdateDiagnostics: screenProgram?.diagnostics ?? ['screen-update source method not found'],
    },
    summary,
  };
}

export function runtimeReportMarkdown(report: RuntimeReport): string {
  const lines = [
    `# ${report.game} source-generation report`,
    '',
    `Playability: **${report.playable ? 'executable' : 'blocked'}**`,
    '',
    `MAME source coverage: **${report.sourceCoverage.covered}/${report.sourceCoverage.total} ` +
      `nodes (${report.sourceCoverage.percent}%)**`,
    '',
    '| Stage | Count | Meaning |',
    '|---|---:|---|',
    `| Executable | ${report.summary.executable} | Hardware lowered from MAME source to executable IR |`,
    `| Generated | ${report.summary.generated} | Wiring, handlers, schedules and composition emitted from source/KG |`,
    `| Declarative host | ${report.summary['declarative-host']} | Hardware-neutral browser service configured by generated data |`,
    `| Blocked | ${report.summary.blocked} | Source found; executable lowering is incomplete |`,
    `| Missing | ${report.summary.missing} | Required source or generated artifact is absent |`,
    '',
    '## MAME handler compiler',
    '',
    `Source methods compiled: **${report.handlerCompiler.compiledMethods}/${report.handlerCompiler.sourceMethods}**`,
    '',
    `Address-map handlers compiled: **${report.handlerCompiler.usedCompiledHandlers}/` +
      `${report.handlerCompiler.usedCompiledHandlers + report.handlerCompiler.usedBlockedHandlers}**`,
    '',
    '## Generated execution plan',
    '',
    `CPU schedules: **${report.executionCompiler.cpuPlans}**`,
    '',
    `Frame callbacks: **${report.executionCompiler.frameCallbacks}**`,
    '',
    `Screen update: **${report.executionCompiler.screenUpdate ?? 'missing'}** ` +
      `(${report.executionCompiler.screenUpdateCompiled ? 'compiled' : 'blocked'})`,
    '',
    '## Executable generation gaps',
    '',
  ];

  if (report.generationGaps.length) {
    for (const gap of report.generationGaps) lines.push(`- \`${gap}\``);
  } else {
    lines.push('- None');
  }

  lines.push('', '## Parser gaps', '');
  if (report.parserGaps.length) {
    for (const gap of report.parserGaps) {
      lines.push(`- \`${gap.construct}\`${gap.source ? ` at ${gap.source}` : ''}: \`${gap.raw}\``);
    }
  } else {
    lines.push('- None detected');
  }

  lines.push('', '## Generated callback wiring', '');
  if (report.requirements.callbacks.length) {
    for (const callback of report.requirements.callbacks) {
      lines.push(`- \`${callback.name}\`${callback.source ? ` - ${callback.source}` : ''}`);
    }
  } else {
    lines.push('- None extracted');
  }
  return lines.join('\n') + '\n';
}

export function refreshRuntimeReports(outRoot: string): number {
  const manifestPath = join(outRoot, 'runtime/generated/hardware-manifest.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as HardwareGenerationManifest
    : {};
  let refreshed = 0;
  for (const category of GAME_CATEGORIES) {
    const categoryDir = join(outRoot, 'games', category);
    if (!existsSync(categoryDir)) continue;
    for (const entry of readdirSync(categoryDir)) {
      const dir = gameOutputDir(outRoot, category, entry);
      const graphPath = join(dir, 'graph.json');
      const configPath = join(dir, 'config.json');
      if (!existsSync(graphPath) || !existsSync(configPath)) continue;
      const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as KnowledgeGraph;
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as RuntimeConfigShape;
      const report = buildRuntimeReport(graph, config, manifest);
      writeFileSync(join(dir, 'runtime-report.json'), JSON.stringify(report, null, 2));
      writeFileSync(join(dir, 'runtime-report.md'), runtimeReportMarkdown(report));
      refreshed++;
    }
  }
  return refreshed;
}
