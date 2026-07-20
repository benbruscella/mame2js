import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeGraph } from '../kg/types.ts';
import type {
  GeneratedAddressMap,
  GeneratedCallback,
  GeneratedDevice,
  GeneratedExecutionPlan,
  GeneratedHandler,
  GeneratedMachine,
  GeneratedSourceRef,
  GeneratedVideoPlan,
} from '../runtime/generated-machine.ts';
import type { BoardConfig } from '../runtime/types.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';
import { normalizeMameExecutionSource } from '../mame/cpu-compiler.ts';

export function lowerGeneratedMachine(
  graph: KnowledgeGraph,
  game: string,
  family: string,
  board: BoardConfig,
  compiledVideo?: { plan: GeneratedVideoPlan; handlers: GeneratedHandler[] },
): GeneratedMachine {
  const callbacks: GeneratedCallback[] = graph.nodes
    .filter(node => node.label === 'Callback')
    .map(node => {
      const props = node.props;
      const callback: GeneratedCallback = {
        id: node.id,
        ownerTag: String(props.ownerTag),
        signal: String(props.signal),
        operation: String(props.operation),
      };
      if (props.slot !== undefined && Number.isFinite(Number(props.slot))) {
        callback.slot = Number(props.slot);
      }
      if (props.targetTag) callback.targetTag = String(props.targetTag);
      if (props.targetClass) callback.targetClass = String(props.targetClass);
      if (props.targetMethod) callback.targetMethod = String(props.targetMethod);
      if (props.targetPort) callback.targetPort = String(props.targetPort);
      if (props.inputLine) callback.inputLine = String(props.inputLine);
      if (props.periodHz !== undefined) callback.periodHz = Number(props.periodHz);
      if (props.periodExpr) callback.periodExpr = String(props.periodExpr);
      if (Array.isArray(props.scanlines)) callback.scanlines = props.scanlines.map(Number);
      if (Array.isArray(props.transforms)) callback.transforms = props.transforms.map(String);
      if (props.sourceFile && props.sourceLine) {
        callback.source = {
          file: String(props.sourceFile),
          line: Number(props.sourceLine),
          ...(props.sourceColumn ? { column: Number(props.sourceColumn) } : {}),
        };
      }
      return callback;
    });
  const sourceRef = (props: Record<string, unknown>): GeneratedSourceRef | undefined =>
    props.sourceFile && props.sourceLine
      ? {
          file: String(props.sourceFile),
          line: Number(props.sourceLine),
          ...(props.sourceColumn ? { column: Number(props.sourceColumn) } : {}),
        }
      : undefined;
  const devices: GeneratedDevice[] = graph.nodes
    .filter(node => node.label === 'Device')
    .map(node => ({
      id: node.id,
      tag: String(node.props.tag),
      type: String(node.props.type),
      ...(deviceMember(node.props) ? { member: deviceMember(node.props) } : {}),
      ...(typeof node.props.clock === 'number' ? { clock: node.props.clock } : {}),
      ...(sourceRef(node.props) ? { source: sourceRef(node.props) } : {}),
    }));
  const handlers: GeneratedHandler[] = graph.nodes
    .filter(node => node.label === 'Handler')
    .map(node => {
      const constants = Object.fromEntries(
        (Array.isArray(node.props.sourceConstants) ? node.props.sourceConstants : [])
          .map(entry => /^([^=]+)=(-?(?:\d+(?:\.\d+)?|Infinity))$/.exec(String(entry)))
          .filter((match): match is RegExpExecArray => Boolean(match))
          .map(match => [match[1], Number(match[2])]),
      );
      return {
        id: node.id,
        ownerClass: String(node.props.ownerClass),
        method: String(node.props.method),
        ...(node.props.sourceParameters ? { parameters: String(node.props.sourceParameters) } : {}),
        ...(node.props.sourceBody ? { body: String(node.props.sourceBody) } : {}),
        ...(Object.keys(constants).length ? { constants } : {}),
        ...(node.props.sourceBody ? {
          program: compileMameHandler(normalizeMameExecutionSource(String(node.props.sourceBody))),
        } : {}),
        ...(sourceRef(node.props) ? { source: sourceRef(node.props) } : {}),
      };
    });
  for (const handler of compiledVideo?.handlers ?? []) {
    const existing = handlers.find(candidate =>
      candidate.ownerClass === handler.ownerClass && candidate.method === handler.method);
    if (existing) Object.assign(existing, handler);
    else handlers.push(handler);
  }
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const maps: GeneratedAddressMap[] = graph.nodes
    .filter(node => node.label === 'AddressMap')
    .map(node => ({
      id: node.id,
      className: String(node.props.cls),
      name: String(node.props.name),
      ranges: graph.edges
        .filter(edge => edge.from === node.id && edge.rel === 'HAS_RANGE')
        .map(edge => byId.get(edge.to))
        .filter(range => range?.label === 'AddressRange')
        .map(range => {
          const read = graph.edges.find(edge => edge.from === range!.id && edge.rel === 'READS');
          const write = graph.edges.find(edge => edge.from === range!.id && edge.rel === 'WRITES');
          return {
            id: range!.id,
            start: Number(range!.props.start),
            end: Number(range!.props.end),
            raw: String(range!.props.raw),
            ...(read ? { read: handlerKey(read, byId.get(read.to)) } : {}),
            ...(write ? { write: handlerKey(write, byId.get(write.to)) } : {}),
            props: range!.props,
            ...(sourceRef(range!.props) ? { source: sourceRef(range!.props) } : {}),
          };
        }),
      ...(sourceRef(node.props) ? { source: sourceRef(node.props) } : {}),
    }));
  const deviceByTag = new Map(devices.map(device => [device.tag, device]));
  const screenCallback = callbacks.find(callback => callback.signal === 'set_screen_update');
  const screenHandler = screenCallback?.targetClass && screenCallback.targetMethod
    ? handlers.find(handler =>
        handler.ownerClass === screenCallback.targetClass &&
        handler.method === screenCallback.targetMethod)
    : undefined;
  const execution: GeneratedExecutionPlan = {
    cpus: board.cpus.map(cpu => ({
      ...cpu,
      cycleClock: ['mc6809', 'konami1'].includes(cpu.type ?? '')
        ? cpu.clock / 4
        : cpu.type === 'i8039'
          ? cpu.clock / 15
          : cpu.clock,
      ...(deviceByTag.get(cpu.tag)?.source ? { source: deviceByTag.get(cpu.tag)!.source } : {}),
    })),
    ...(board.banks?.length ? { banks: board.banks } : {}),
    screen: {
      ...board.screen,
      ...(deviceByTag.get('screen')?.source ? { source: deviceByTag.get('screen')!.source } : {}),
    },
    ...(board.customs?.length ? { customs: board.customs } : {}),
    frameEvents: lowerFrameEvents(
      callbacks,
      board.screen.refresh,
      board.screen.vtotal,
      board.screen.vbstart,
    ),
    ...(screenCallback?.targetClass && screenCallback.targetMethod ? {
      screenUpdate: {
        handler: `${screenCallback.targetClass}.${screenCallback.targetMethod}`,
        ...((screenHandler?.source ?? screenCallback.source)
          ? { source: screenHandler?.source ?? screenCallback.source }
          : {}),
      },
    } : {}),
  };
  const soundDevice = devices.find(device => device.type === 'NAMCO_WSG');
  const ayDevices = devices.filter(device => device.type === 'AY8910');
  const sound = soundDevice
    ? {
        kind: 'wsg',
        deviceTag: soundDevice.tag,
        deviceType: soundDevice.type,
        writeMethods: [...new Set(maps.flatMap(map => map.ranges)
          .map(range => range.write)
          .filter((key): key is string => Boolean(key?.startsWith(`${soundDevice.tag}.`)))
          .map(key => key.slice(soundDevice.tag.length + 1)))],
        enableMethods: [...new Set(callbacks
          .filter(callback => callback.targetTag === soundDevice.tag && callback.targetMethod)
          .map(callback => callback.targetMethod!))],
        controlOffset: -1,
      }
    : ayDevices.length
      ? {
          kind: 'ay8910',
          deviceTag: ayDevices[0]!.tag,
          deviceTags: ayDevices.map(device => device.tag),
          deviceType: 'AY8910',
          writeMethods: ['address_w', 'data_w'],
          enableMethods: [],
          controlOffset: -1,
        }
      : undefined;
  return {
    schemaVersion: 2,
    game,
    family,
    driverFile: graph.meta.driverFile,
    callbacks,
    execution,
    devices,
    handlers,
    maps,
    ...(compiledVideo ? { video: compiledVideo.plan } : {}),
    ...(sound ? { sound } : {}),
  };
}

function deviceMember(props: Record<string, unknown>): string | undefined {
  const config = Array.isArray(props.config) ? props.config.map(String).join('\n') : '';
  return /\(\s*config\s*,\s*(m_\w+)/.exec(config)?.[1];
}

function lowerFrameEvents(
  callbacks: GeneratedCallback[],
  refreshHz: number,
  vtotal: number,
  vbstart: number,
): GeneratedExecutionPlan['frameEvents'] {
  const events: GeneratedExecutionPlan['frameEvents'] = [];
  for (const callback of callbacks) {
    if (callback.signal === 'screen_vblank' || callback.signal === 'set_vblank_int') {
      events.push({
        callbackId: callback.id,
        ownerTag: callback.ownerTag,
        signal: callback.signal,
        line: vbstart,
        state: 1,
        ...(callback.source ? { source: callback.source } : {}),
      });
      continue;
    }
    if (callback.signal !== 'set_periodic_int' || !callback.periodHz) continue;
    const eventsPerFrame = callback.periodHz / refreshHz;
    const count = Math.round(eventsPerFrame);
    if (count <= 0 || Math.abs(eventsPerFrame - count) > 0.1) continue;
    for (let index = 0; index < count; index++) {
      events.push({
        callbackId: callback.id,
        ownerTag: callback.ownerTag,
        signal: callback.signal,
        line: Math.floor(index * vtotal / count),
        state: 1,
        ...(callback.source ? { source: callback.source } : {}),
      });
    }
  }
  for (const callback of callbacks.filter(candidate =>
    candidate.signal === 'timer' && candidate.scanlines?.length)) {
    for (const line of callback.scanlines ?? []) {
      events.push({
        callbackId: callback.id,
        ownerTag: callback.ownerTag,
        signal: callback.signal,
        line,
        state: 1,
        ...(callback.source ? { source: callback.source } : {}),
      });
    }
  }
  return events.sort((a, b) => a.line - b.line || a.callbackId.localeCompare(b.callbackId));
}

export function generatedMachineSource(machine: GeneratedMachine): string {
  return `// GENERATED by mamekit from ${machine.driverFile}; do not edit.
// Every callback includes its MAME source location for auditability.
import { defineMachine, type GeneratedMachine } from '../../app/modules/runtime/generated-machine.js';

const machine = JSON.parse(${JSON.stringify(JSON.stringify(machine))}) as GeneratedMachine;
export default defineMachine(machine);
`;
}

function generatedModuleSources(machine: GeneratedMachine): Record<string, string> {
  const screenHandlerKey = machine.execution.screenUpdate?.handler;
  const screenHandler = machine.handlers?.find(handler =>
    `${handler.ownerClass}.${handler.method}` === screenHandlerKey);
  const handlers = (machine.handlers ?? []).filter(handler => handler !== screenHandler);
  const base = {
    schemaVersion: machine.schemaVersion,
    game: machine.game,
    family: machine.family,
    driverFile: machine.driverFile,
    execution: machine.execution,
    devices: machine.devices,
    maps: machine.maps,
    video: machine.video,
    sound: machine.sound,
  };
  const runtimeImport = '../../app/modules/runtime/generated-machine.js';
  return {
    'machine.ts': `// GENERATED from ${machine.driverFile}; do not edit.
import type { GeneratedMachine } from '${runtimeImport}';

export const machine = JSON.parse(${JSON.stringify(JSON.stringify(base))}) as
  Omit<GeneratedMachine, 'callbacks' | 'handlers'>;
`,
    'handlers.ts': `// GENERATED MAME callbacks and executable handler IR; do not edit.
import type { GeneratedCallback, GeneratedHandler } from '${runtimeImport}';

export const callbacks = JSON.parse(${JSON.stringify(JSON.stringify(machine.callbacks))}) as GeneratedCallback[];
export const handlers = JSON.parse(${JSON.stringify(JSON.stringify(handlers))}) as GeneratedHandler[];
`,
    'video.ts': `// GENERATED MAME screen-update program; do not edit.
import type { GeneratedHandler } from '${runtimeImport}';

export const screenUpdate = ${screenHandler
    ? `JSON.parse(${JSON.stringify(JSON.stringify(screenHandler))}) as GeneratedHandler`
    : 'undefined'};
`,
    'board.ts': `// GENERATED executable machine composition; do not edit.
import { defineMachine, type GeneratedMachine } from '${runtimeImport}';
import type { BoardConfig, BoardSinks, InputPorts, Regions } from '../../app/modules/runtime/types.js';
import { createGeneratedBoard } from '../../app/modules/runtime/generated-board.js';
import { machine } from './machine.ts';
import { callbacks, handlers } from './handlers.ts';
import { screenUpdate } from './video.ts';

const generated = {
  ...machine,
  callbacks,
  handlers: screenUpdate ? [...handlers, screenUpdate] : handlers,
} as GeneratedMachine;

const defined = defineMachine(generated);
export default {
  machine: defined,
  createBoard: (
    config: BoardConfig,
    regions: Regions,
    inputs: InputPorts,
    sinks: BoardSinks,
  ) => createGeneratedBoard(defined, config, regions, inputs, sinks),
};
`,
  };
}

function handlerKey(
  edge: KnowledgeGraph['edges'][number],
  handler: KnowledgeGraph['nodes'][number] | undefined,
): string {
  if (!handler) return edge.to.replace(/^handler:/, '');
  const owner = edge.props?.deviceTag ?? handler.props.ownerClass;
  return `${owner}.${handler.props.method}`;
}

export function emitGeneratedMachine(
  graph: KnowledgeGraph,
  game: string,
  family: string,
  outDir: string,
  board: BoardConfig,
  compiledVideo?: { plan: GeneratedVideoPlan; handlers: GeneratedHandler[] },
): GeneratedMachine {
  const machine = lowerGeneratedMachine(graph, game, family, board, compiledVideo);
  const generatedDir = join(outDir, 'generated');
  mkdirSync(generatedDir, { recursive: true });
  for (const [file, source] of Object.entries(generatedModuleSources(machine))) {
    writeFileSync(join(generatedDir, file), source);
  }
  writeFileSync(
    join(generatedDir, 'provenance.json'),
    JSON.stringify(collectProvenance(machine), null, 2),
  );
  writeFileSync(join(outDir, 'machine.ir.json'), JSON.stringify(machine, null, 2));
  return machine;
}

function collectProvenance(machine: GeneratedMachine): {
  generatedFrom: string;
  entries: { path: string; file: string; line: number; column?: number }[];
} {
  const entries: { path: string; file: string; line: number; column?: number }[] = [];
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (
      'file' in value &&
      'line' in value &&
      typeof value.file === 'string' &&
      typeof value.line === 'number'
    ) {
      entries.push({
        path,
        file: value.file,
        line: value.line,
        ...(('column' in value && typeof value.column === 'number')
          ? { column: value.column }
          : {}),
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${path}/${key}`);
  };
  visit(machine, '');
  return { generatedFrom: machine.driverFile, entries };
}
