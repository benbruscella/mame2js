import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeGraph } from '../kg/types.ts';
import type {
  GeneratedAddressMap,
  GeneratedAudioRoute,
  GeneratedCallback,
  GeneratedDevice,
  GeneratedExpression,
  GeneratedExecutionPlan,
  GeneratedHandler,
  GeneratedHandlerOperation,
  GeneratedMachine,
  GeneratedSourceRef,
  GeneratedVideoPlan,
} from '../runtime/generated-machine.ts';
import type { BoardConfig } from '../runtime/types.ts';
import type { GeneratedAuxiliaryAudioDevice } from '../runtime/audio-protocol.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';
import { normalizeMameExecutionSource } from '../mame/cpu-compiler.ts';

export function lowerGeneratedMachine(
  graph: KnowledgeGraph,
  game: string,
  family: string,
  board: BoardConfig,
  compiledVideo?: { plan: GeneratedVideoPlan; handlers: GeneratedHandler[] },
): GeneratedMachine {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const tagCounts = new Map<string, number>();
  for (const device of graph.nodes.filter(node => node.label === 'Device')) {
    const tag = String(device.props.tag);
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const nestedHostTags = new Map<string, string>();
  for (const device of graph.nodes.filter(node => node.label === 'Device')) {
    const ownerConfig = graph.edges.find(edge =>
      edge.rel === 'HAS_DEVICE' && edge.to === device.id);
    if (!ownerConfig) continue;
    const hostEdge = graph.edges.find(edge =>
      edge.rel === 'CALLS' && edge.to === ownerConfig.from &&
      byId.get(edge.from)?.label === 'Device');
    const host = hostEdge && byId.get(hostEdge.from);
    if (host?.props.tag) nestedHostTags.set(device.id, String(host.props.tag));
  }
  const emittedDeviceTag = (deviceId: string, rawTag: string): string => {
    const hostTag = nestedHostTags.get(deviceId);
    return hostTag && (tagCounts.get(rawTag) ?? 0) > 1
      ? `${hostTag}:${rawTag}`
      : rawTag;
  };
  const callbacks: GeneratedCallback[] = graph.nodes
    .filter(node => node.label === 'Callback')
    .map(node => {
      const props = node.props;
      const ownerDevice = graph.edges.find(edge =>
        edge.rel === 'HAS_CALLBACK' && edge.to === node.id);
      const callback: GeneratedCallback = {
        id: node.id,
        ownerTag: ownerDevice
          ? emittedDeviceTag(ownerDevice.from, String(props.ownerTag))
          : String(props.ownerTag),
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
      tag: emittedDeviceTag(node.id, String(node.props.tag)),
      type: String(node.props.type),
      ...(nestedHostTags.has(node.id) ? { hostTag: nestedHostTags.get(node.id) } : {}),
      ...(deviceMember(node.props) ? { member: deviceMember(node.props) } : {}),
      ...(typeof node.props.clock === 'number' ? { clock: node.props.clock } : {}),
      ...(deviceCallbackHz(node.props) ? { callbackHz: deviceCallbackHz(node.props) } : {}),
      ...(Array.isArray(node.props.configCalls) ? {
        configuration: node.props.configCalls.flatMap(value => {
          const match = /^(\w+)\((.*)\)$/.exec(String(value));
          return match ? [{
            method: match[1]!,
            args: match[2]!.split(',').map(argument => Number(argument.trim())),
          }] : [];
        }),
      } : {}),
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
  const inputMembers = new Map<string, string[]>();
  for (const node of graph.nodes.filter(candidate => candidate.label === 'Handler')) {
    for (const encoded of Array.isArray(node.props.inputMembers)
      ? node.props.inputMembers.map(String)
      : []) {
      const separator = encoded.indexOf('=');
      if (separator < 1) continue;
      inputMembers.set(
        encoded.slice(0, separator),
        encoded.slice(separator + 1).split(',').filter(Boolean),
      );
    }
  }
  const execution: GeneratedExecutionPlan = {
    cpus: board.cpus.map(cpu => {
      const interruptVectorWriters = inferInterruptVectorWriters(
        cpu.tag,
        cpu.io?.ranges ?? [],
        callbacks,
        handlers,
      );
      return {
        ...cpu,
        cycleClock: cpu.type === 'mc6809'
          ? cpu.clock / 4
          : cpu.type === 'i8039'
            ? cpu.clock / 15
            : cpu.clock,
        ...(interruptVectorWriters.length ? { interruptVectorWriters } : {}),
        ...(deviceByTag.get(cpu.tag)?.source ? { source: deviceByTag.get(cpu.tag)!.source } : {}),
      };
    }),
    ...(graph.nodes.some(node => node.label === 'MemoryBank') ? {
      banks: graph.nodes
        .filter(node => node.label === 'MemoryBank')
        .map(node => ({
          tag: String(node.props.tag),
          member: String(node.props.member),
          startEntry: Number(node.props.startEntry),
          entries: Number(node.props.entries),
          region: String(node.props.region),
          offset: Number(node.props.offset),
          stride: Number(node.props.stride),
          ...(sourceRef(node.props) ? { source: sourceRef(node.props) } : {}),
        })),
    } : {}),
    screen: {
      ...board.screen,
      ...(deviceByTag.get('screen')?.source ? { source: deviceByTag.get('screen')!.source } : {}),
    },
    ...(board.customs?.length ? { customs: board.customs } : {}),
    ...(inputMembers.size ? {
      inputMembers: [...inputMembers].map(([member, tags]) => ({ member, tags })),
    } : {}),
    frameEvents: lowerFrameEvents(
      callbacks,
      devices,
      board.screen.refresh,
      board.screen.vtotal,
      board.screen.vbstart,
      board.screen.vbend ?? 0,
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
  const mappedWriteKeys = maps.flatMap(map => map.ranges)
    .map(range => range.write)
    .filter((key): key is string => Boolean(key));
  const generatedSoundboard = ayDevices.length
    ? undefined
    : devices.find(device =>
        (device.type.endsWith('_AUDIO') || device.type.endsWith('_SOUND')) &&
        mappedWriteKeys.some(key => key.startsWith(`${device.tag}.`)));
  const audioRoutes = lowerAudioRoutes(graph, ayDevices);
  const filterRank = inferredMemberIndexRank(handlers, 'm_filter');
  const auxiliaryDevices = lowerAuxiliaryAudioDevices(graph, devices);
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
          ...(audioRoutes.length ? { routes: audioRoutes } : {}),
          ...(audioRoutes.some(route => route.filter) && filterRank ? {
            filterLayout: filterRank === 1 ? 'flat' as const : 'matrix' as const,
          } : {}),
          ...(auxiliaryDevices.length ? { auxiliaryDevices } : {}),
        }
    : generatedSoundboard
      ? (() => {
          const writeMethods = [...new Set(maps.flatMap(map => map.ranges)
            .map(range => range.write)
            .filter((key): key is string => Boolean(key?.startsWith(`${generatedSoundboard.tag}.`)))
            .map(key => key.slice(generatedSoundboard.tag.length + 1)))].sort();
          return {
            kind: generatedSoundboard.type.toLowerCase().replace(/_(?:audio|sound)$/, ''),
            deviceTag: generatedSoundboard.tag,
            deviceType: generatedSoundboard.type,
            writeMethods,
            enableMethods: [],
            controlOffset: -1,
          };
        })()
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

export function inferredMemberIndexRank(
  handlers: GeneratedHandler[],
  member: string,
): number {
  let maximum = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.kind === 'index') {
      let rank = 0;
      let object: unknown = node;
      while (
        object &&
        typeof object === 'object' &&
        (object as Record<string, unknown>).kind === 'index'
      ) {
        rank++;
        object = (object as Record<string, unknown>).object;
      }
      if (
        object &&
        typeof object === 'object' &&
        (object as Record<string, unknown>).kind === 'identifier' &&
        (object as Record<string, unknown>).name === member
      ) {
        maximum = Math.max(maximum, rank);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  for (const handler of handlers) visit(handler.program);
  return maximum;
}

export function lowerAudioRoutes(
  graph: KnowledgeGraph,
  devices: { id: string; tag: string }[],
): GeneratedAudioRoute[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const filters = new Map<string, number>();
  const routes: GeneratedAudioRoute[] = [];
  devices.forEach((device, chip) => {
    const sourceDevice = byId.get(device.id);
    const config = Array.isArray(sourceDevice?.props.config)
      ? sourceDevice.props.config.map(String).join('\n')
      : '';
    const singleOutput = config.includes('AY8910_SINGLE_OUTPUT');
    for (const edge of graph.edges.filter(candidate =>
      candidate.from === device.id && candidate.rel === 'HAS_AUDIO_ROUTE')) {
      const node = byId.get(edge.to);
      if (!node) continue;
      const rawChannel = Number(node.props.output);
      const channel = singleOutput && rawChannel === 0 ? -1 : rawChannel;
      const gain = Number(node.props.gain);
      const target = String(node.props.target);
      const targetInput = Number(node.props.input);
      if (!Number.isInteger(channel) || channel < -1 || !Number.isFinite(gain)) continue;
      const match = /^filter\.(\d+)\.(\d+)$/.exec(target);
      let filter: GeneratedAudioRoute['filter'];
      if (match) {
        let index = filters.get(target);
        if (index === undefined) {
          index = filters.size;
          filters.set(target, index);
        }
        filter = {
          index,
          bank: Number(match[1]),
          channel: Number(match[2]),
        };
      }
      routes.push({
        chip,
        channel,
        gain,
        target,
        ...(Number.isInteger(targetInput) ? { targetInput } : {}),
        ...(filter ? { filter } : {}),
      });
    }
  });
  return routes;
}

const AUXILIARY_AUDIO_METHODS: Record<string, string[]> = {
  DAC_8BIT_R2R: ['data_w'],
  MSM5205: ['data_w', 'reset_w', 'playmode_w', 's1_w', 's2_w', 'vclk_w'],
};

/**
 * Lower routed secondary sound devices independently of the game using them.
 * The method surface belongs to the generated hardware compiler capability;
 * tags, clocks, modes and routes remain facts from the machine graph.
 */
export function lowerAuxiliaryAudioDevices(
  graph: KnowledgeGraph,
  devices: {
    id: string;
    tag: string;
    type: string;
    member?: string;
    clock?: number;
  }[],
): GeneratedAuxiliaryAudioDevice[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  return devices.flatMap(device => {
    const writeMethods = AUXILIARY_AUDIO_METHODS[device.type];
    if (!writeMethods || !Number.isFinite(device.clock)) return [];
    const routeEdge = graph.edges.find(edge =>
      edge.from === device.id && edge.rel === 'HAS_AUDIO_ROUTE');
    const route = routeEdge ? byId.get(routeEdge.to) : undefined;
    if (!route) return [];
    const gain = Number(route.props.gain);
    if (!Number.isFinite(gain)) return [];
    const sourceDevice = byId.get(device.id);
    const config = Array.isArray(sourceDevice?.props.config)
      ? sourceDevice.props.config.map(String).join('\n')
      : '';
    const initialMode =
      /set_prescaler_selector\([^)]*::(\w+)\)/.exec(config)?.[1];
    const targetInput = Number(route.props.input);
    return [{
      type: device.type,
      deviceTag: device.tag,
      ...(device.member ? { member: device.member } : {}),
      clock: device.clock!,
      ...(initialMode ? { initialMode } : {}),
      gain,
      target: String(route.props.target),
      ...(Number.isInteger(targetInput) ? { targetInput } : {}),
      writeMethods,
    }];
  });
}

function deviceMember(props: Record<string, unknown>): string | undefined {
  const config = Array.isArray(props.config) ? props.config.map(String).join('\n') : '';
  return /\(\s*config\s*,\s*(m_\w+)/.exec(config)?.[1];
}

function inferInterruptVectorWriters(
  cpuTag: string,
  ioRanges: BoardConfig['cpus'][number]['ranges'],
  callbacks: GeneratedCallback[],
  handlers: GeneratedHandler[],
): string[] {
  const acknowledge = callbacks.find(callback =>
    callback.ownerTag === cpuTag &&
    callback.signal === 'set_irq_acknowledge_callback' &&
    callback.targetClass &&
    callback.targetMethod);
  if (!acknowledge) return [];

  const reader = handlers.find(handler =>
    handler.ownerClass === acknowledge.targetClass &&
    handler.method === acknowledge.targetMethod);
  const members = returnedIdentifiers(reader?.program?.operations ?? []);
  if (!members.size) return [];

  const mappedWriters = new Set(
    (ioRanges ?? []).flatMap(range => range.write ? [range.write] : []),
  );
  return handlers.flatMap(writer => {
    const key = `${writer.ownerClass}.${writer.method}`;
    return writer.ownerClass === reader?.ownerClass &&
      mappedWriters.has(key) &&
      assignsAnyIdentifier(writer.program?.operations ?? [], members)
      ? [key]
      : [];
  });
}

function returnedIdentifiers(
  operations: GeneratedHandlerOperation[],
): Set<string> {
  const result = new Set<string>();
  visitOperations(operations, operation => {
    if (operation.op !== 'return' || !operation.value) return;
    const identifier = directIdentifier(operation.value);
    if (identifier) result.add(identifier);
  });
  return result;
}

function assignsAnyIdentifier(
  operations: GeneratedHandlerOperation[],
  names: Set<string>,
): boolean {
  let matched = false;
  visitOperations(operations, operation => {
    if (
      operation.op === 'assign' &&
      operation.target.kind === 'identifier' &&
      names.has(operation.target.name)
    ) {
      matched = true;
    }
  });
  return matched;
}

function directIdentifier(expression: GeneratedExpression): string | undefined {
  if (expression.kind === 'identifier') return expression.name;
  if (expression.kind === 'cast') return directIdentifier(expression.operand);
  return undefined;
}

function visitOperations(
  operations: GeneratedHandlerOperation[],
  visit: (operation: GeneratedHandlerOperation) => void,
): void {
  for (const operation of operations) {
    visit(operation);
    if (operation.op === 'if') {
      visitOperations(operation.then, visit);
      visitOperations(operation.else ?? [], visit);
    } else if (operation.op === 'for') {
      visitOperations(operation.initialize, visit);
      visitOperations([operation.iterate], visit);
      visitOperations(operation.body, visit);
    } else if (operation.op === 'while') {
      visitOperations(operation.body, visit);
    } else if (operation.op === 'switch') {
      for (const entry of operation.cases) visitOperations(entry.body, visit);
    }
  }
}

function lowerFrameEvents(
  callbacks: GeneratedCallback[],
  devices: GeneratedDevice[],
  refreshHz: number,
  vtotal: number,
  vbstart: number,
  vbend: number,
): GeneratedExecutionPlan['frameEvents'] {
  const events: GeneratedExecutionPlan['frameEvents'] = [];
  for (const callback of callbacks) {
    if (callback.signal === 'vck_callback') {
      const frequency = devices.find(device => device.tag === callback.ownerTag)?.callbackHz;
      if (frequency) {
        events.push({
          callbackId: callback.id,
          ownerTag: callback.ownerTag,
          signal: callback.signal,
          line: 0,
          state: 1,
          frequency,
          ...(callback.source ? { source: callback.source } : {}),
        });
      }
      continue;
    }
    if (callback.signal === 'screen_vblank' || callback.signal === 'set_vblank_int') {
      events.push({
        callbackId: callback.id,
        ownerTag: callback.ownerTag,
        signal: callback.signal,
        line: vbstart,
        state: 1,
        ...(callback.source ? { source: callback.source } : {}),
      });
      // MAME screen_vblank delegates see both edges; the falling edge lands
      // at vblank end (handlers like galaga's starfield config run on !state).
      if (callback.signal === 'screen_vblank') {
        events.push({
          callbackId: callback.id,
          ownerTag: callback.ownerTag,
          signal: callback.signal,
          line: vbend,
          state: 0,
          ...(callback.source ? { source: callback.source } : {}),
        });
      }
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

function deviceCallbackHz(props: Record<string, unknown>): number | undefined {
  if (props.type !== 'MSM5205' || typeof props.clock !== 'number') return undefined;
  const config = Array.isArray(props.config) ? props.config.map(String).join('\n') : '';
  const divisor = /set_prescaler_selector\([^)]*::S(\d+)_/.exec(config)?.[1];
  return divisor ? props.clock / Number(divisor) : undefined;
}

export function generatedBoardSource(machine: GeneratedMachine): string {
  const runtimeImport = '../../../../runtime/core';
  return `// GENERATED executable machine composition from ${machine.driverFile}; do not edit.
import { defineMachine, type GeneratedMachine } from '${runtimeImport}/generated-machine.js';
import type { BoardConfig, BoardSinks, InputPorts, Regions } from '${runtimeImport}/types.js';
import { createGeneratedBoard } from '${runtimeImport}/generated-board.js';
import machineData from './machine.json' with { type: 'json' };

const defined = defineMachine(machineData as unknown as GeneratedMachine);
export default {
  machine: defined,
  createBoard: (
    config: BoardConfig,
    regions: Regions,
    inputs: InputPorts,
    sinks: BoardSinks,
  ) => createGeneratedBoard(defined, config, regions, inputs, sinks),
};
`;
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
  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, 'board.ts'), generatedBoardSource(machine));
  writeFileSync(join(generatedDir, 'machine.json'), JSON.stringify(machine, null, 2));
  writeFileSync(
    join(generatedDir, 'provenance.json'),
    JSON.stringify(collectProvenance(machine), null, 2),
  );
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
