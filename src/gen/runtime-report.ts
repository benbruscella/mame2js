import type { KnowledgeGraph, KGNode } from '../kg/types.ts';
import {
  DECLARATIVE_DEVICE_TYPES,
  GENERIC_HANDLER_PREFIXES,
  RUNTIME_CPU_TYPES,
  RUNTIME_DEVICE_TYPES,
} from '../runtime/capabilities.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';

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
  board: {
    cpus: RuntimeCpu[];
    ranges: RuntimeRange[];
    io?: { ranges: RuntimeRange[] };
  };
}

export interface RuntimeRequirement {
  name: string;
  status: 'generated' | 'runtime' | 'family' | 'missing';
  source?: string;
}

export interface RuntimeReport {
  schemaVersion: 1;
  game: string;
  family: string;
  boardMode: 'generated-plan-with-adapter' | 'generated' | 'missing';
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
  summary: {
    generatedFacts: number;
    runtimePrimitives: number;
    familyBehaviors: number;
    missing: number;
  };
}

export function buildRuntimeReport(
  graph: KnowledgeGraph,
  config: RuntimeConfigShape,
): RuntimeReport {
  const sourceNodes = graph.nodes.filter(node => node.label !== 'SourceFile');
  const covered = sourceNodes.filter(node => typeof node.props.sourceFile === 'string').length;
  const nodeSource = (node: KGNode): string | undefined =>
    typeof node.props.sourceFile === 'string'
      ? `${node.props.sourceFile}:${node.props.sourceLine ?? '?'}`
      : undefined;

  const cpus: RuntimeRequirement[] = config.board.cpus.map(cpu => ({
    name: `${cpu.tag}:${cpu.type ?? 'z80'}`,
    status: RUNTIME_CPU_TYPES.has(cpu.type ?? 'z80') ? 'runtime' : 'missing',
  }));

  const devices: RuntimeRequirement[] = graph.nodes
    .filter(node => node.label === 'Device')
    .filter(node => !config.board.cpus.some(cpu => cpu.tag === String(node.props.tag)))
    .map(node => {
      const type = String(node.props.type);
      const status = RUNTIME_DEVICE_TYPES.has(type)
        ? 'runtime'
        : DECLARATIVE_DEVICE_TYPES.has(type)
          ? 'generated'
          : 'family';
      return { name: `${node.props.tag}:${type}`, status, source: nodeSource(node) };
    });

  const allRanges = config.board.cpus.flatMap(cpu => [
    ...(cpu.ranges ?? []),
    ...(cpu.io?.ranges ?? []),
  ]);
  const handlerNames = [...new Set(allRanges.flatMap(range =>
    [range.read, range.write].filter((name): name is string => !!name),
  ))].sort();
  const deviceTags = new Set(graph.nodes
    .filter(node => node.label === 'Device' && RUNTIME_DEVICE_TYPES.has(String(node.props.type)))
    .map(node => String(node.props.tag)));
  const sourceHandlers = graph.nodes
    .filter(node => node.label === 'Handler' && typeof node.props.sourceBody === 'string')
    .map(node => ({
      node,
      key: `${node.props.ownerClass}.${node.props.method}`,
      program: compileMameHandler(String(node.props.sourceBody)),
    }));
  const sourceHandlerByKey = new Map(sourceHandlers.map(handler => [handler.key, handler]));
  const handlers: RuntimeRequirement[] = handlerNames.map(name => {
    const prefix = name.split('.')[0];
    const sourceHandler = sourceHandlerByKey.get(name);
    const status = GENERIC_HANDLER_PREFIXES.some(generic => name.startsWith(generic))
      ? 'generated'
      : deviceTags.has(prefix)
        ? 'runtime'
        : sourceHandler?.program.diagnostics.length === 0
          ? 'generated'
        : 'family';
    return { name, status, source: sourceHandler ? nodeSource(sourceHandler.node) : undefined };
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
  const composition: RuntimeRequirement[] = [{
    name: `boards/${config.family}.ts`,
    status: 'family',
  }];

  const mapParserGaps = graph.nodes
    .filter(node => node.label === 'AddressRange')
    .flatMap(node => {
      const raw = String(node.props.raw ?? '');
      const unsupported = [...raw.matchAll(/\.(l[wr]+8|select|umask\d*)\s*\(/g)].map(match => match[1]);
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
  const boardSupported = config.board.cpus.length > 0;
  return {
    schemaVersion: 1,
    game: config.game,
    family: config.family,
    boardMode: boardSupported ? 'generated-plan-with-adapter' : 'missing',
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
      screenUpdateCompiled: Boolean(screenProgram && screenProgram.diagnostics.length === 0),
      screenUpdateDiagnostics: screenProgram?.diagnostics ?? ['screen-update source method not found'],
    },
    summary: {
      generatedFacts: every.filter(item => item.status === 'generated').length,
      runtimePrimitives: every.filter(item => item.status === 'runtime').length,
      familyBehaviors: every.filter(item => item.status === 'family').length,
      missing: every.filter(item => item.status === 'missing').length + (boardSupported ? 0 : 1),
    },
  };
}

export function runtimeReportMarkdown(report: RuntimeReport): string {
  const lines = [
    `# ${report.game} runtime transpilation report`,
    '',
    `MAME source coverage: **${report.sourceCoverage.covered}/${report.sourceCoverage.total} ` +
      `nodes (${report.sourceCoverage.percent}%)**`,
    '',
    '| Layer | Count | Meaning |',
    '|---|---:|---|',
    `| Generated | ${report.summary.generatedFacts} | Data/wiring emitted from MAME source |`,
    `| Runtime primitives | ${report.summary.runtimePrimitives} | Reusable CPU/device implementations |`,
    `| Family behavior | ${report.summary.familyBehaviors} | Behavior still owned by \`boards/${report.family}.ts\` or video code |`,
    `| Missing | ${report.summary.missing} | Required runtime capability not present |`,
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
    '## Family behavior still handwritten',
    '',
  ];

  const family = [
    ...report.requirements.composition,
    ...report.requirements.devices,
    ...report.requirements.handlers,
  ].filter(item => item.status === 'family');
  if (family.length) {
    for (const item of family) lines.push(`- \`${item.name}\`${item.source ? ` - ${item.source}` : ''}`);
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
