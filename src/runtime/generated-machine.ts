import type { RangeSpec } from './bus.ts';

export interface GeneratedSourceRef {
  file: string;
  line: number;
  column?: number;
}

export interface GeneratedCallback {
  id: string;
  ownerTag: string;
  signal: string;
  slot?: number;
  operation: string;
  targetTag?: string;
  targetClass?: string;
  targetMethod?: string;
  targetPort?: string;
  inputLine?: string;
  periodHz?: number;
  periodExpr?: string;
  scanlines?: number[];
  transforms?: string[];
  source?: GeneratedSourceRef;
}

export interface GeneratedDevice {
  id: string;
  tag: string;
  type: string;
  clock?: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedHandler {
  id: string;
  ownerClass: string;
  method: string;
  parameters?: string;
  body?: string;
  constants?: Record<string, number>;
  program?: GeneratedHandlerProgram;
  source?: GeneratedSourceRef;
}

export type GeneratedExpression =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'unary'; operator: string; operand: GeneratedExpression }
  | { kind: 'cast'; valueType: string; operand: GeneratedExpression }
  | { kind: 'binary'; operator: string; left: GeneratedExpression; right: GeneratedExpression }
  | {
      kind: 'assignment';
      target: GeneratedExpression;
      operator: string;
      value: GeneratedExpression;
    }
  | { kind: 'conditional'; condition: GeneratedExpression; whenTrue: GeneratedExpression; whenFalse: GeneratedExpression }
  | { kind: 'member'; object: GeneratedExpression; property: string }
  | { kind: 'index'; object: GeneratedExpression; index: GeneratedExpression }
  | { kind: 'call'; callee: GeneratedExpression; args: GeneratedExpression[] };

export type GeneratedHandlerOperation =
  | { op: 'declare'; name: string; valueType?: string; value?: GeneratedExpression }
  | { op: 'assign'; target: GeneratedExpression; operator: string; value: GeneratedExpression }
  | { op: 'call'; expression: Extract<GeneratedExpression, { kind: 'call' }> }
  | { op: 'return'; value?: GeneratedExpression }
  | { op: 'break' }
  | {
      op: 'if';
      condition: GeneratedExpression;
      then: GeneratedHandlerOperation[];
      else?: GeneratedHandlerOperation[];
    }
  | {
      op: 'for';
      initialize: GeneratedHandlerOperation[];
      condition: GeneratedExpression;
      iterate: GeneratedHandlerOperation;
      body: GeneratedHandlerOperation[];
    }
  | {
      op: 'while';
      condition: GeneratedExpression;
      body: GeneratedHandlerOperation[];
    }
  | {
      op: 'switch';
      expression: GeneratedExpression;
      cases: {
        values?: GeneratedExpression[];
        body: GeneratedHandlerOperation[];
      }[];
    };

export interface GeneratedHandlerProgram {
  operations: GeneratedHandlerOperation[];
  diagnostics: string[];
}

export interface GeneratedRange {
  id: string;
  start: number;
  end: number;
  raw: string;
  read?: string;
  write?: string;
  props: Record<string, unknown>;
  source?: GeneratedSourceRef;
}

export interface GeneratedAddressMap {
  id: string;
  className: string;
  name: string;
  ranges: GeneratedRange[];
  source?: GeneratedSourceRef;
}

export interface GeneratedExecutionCpu {
  tag: string;
  type?: string;
  clock: number;
  /** Effective instruction-cycle clock after a MAME device's internal divider. */
  cycleClock?: number;
  region: string;
  ranges?: RangeSpec[];
  mask?: number;
  io?: { ranges: RangeSpec[]; globalMask?: number };
  source?: GeneratedSourceRef;
}

export interface GeneratedScreen {
  width: number;
  height: number;
  refresh: number;
  vtotal: number;
  vbstart: number;
  vbend?: number;
  rotate: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedFrameEvent {
  callbackId: string;
  ownerTag: string;
  signal: string;
  line: number;
  state: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedExecutionPlan {
  cpus: GeneratedExecutionCpu[];
  screen: GeneratedScreen;
  customs?: { port: string; mask: number; member: string }[];
  frameEvents: GeneratedFrameEvent[];
  screenUpdate?: {
    handler: string;
    source?: GeneratedSourceRef;
  };
}

export interface GeneratedGfxLayout {
  width: number;
  height: number;
  total: number | string;
  planes: number;
  planeOffsets: (number | string)[];
  xOffsets: (number | string)[];
  yOffsets: (number | string)[];
  charIncrement: number;
}

export interface GeneratedGfxEntry {
  region: string;
  offset: number;
  colorBase: number;
  colorCount: number;
  xscale: number;
  yscale: number;
  layout: GeneratedGfxLayout;
}

export interface GeneratedPromPalettePlan {
  region: string;
  colorCount: number;
  min: number;
  max: number;
  scaler: number;
  channels: {
    channel: 'r' | 'g' | 'b';
    bits: number[];
    resistances: number[];
    pulldown: number;
    pullup: number;
  }[];
  lookupOffset: number;
  lookupCount: number;
  lookupMask: number;
  banks: { penOffset: number; colorOr: number }[];
  transparentIndirect: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedTilemapPlan {
  member: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  mapper: string;
  tileInfo: string;
  source?: GeneratedSourceRef;
}

export interface GeneratedVideoPlan {
  gfx: GeneratedGfxEntry[];
  palette: GeneratedPromPalettePlan;
  tilemaps: GeneratedTilemapPlan[];
  initialState: Record<string, number>;
  source?: GeneratedSourceRef;
}

export interface GeneratedSoundBinding {
  kind: string;
  deviceTag: string;
  deviceType: string;
  writeMethods: string[];
  enableMethods: string[];
  controlOffset: number;
}

export interface GeneratedMachine {
  schemaVersion: 2;
  game: string;
  family: string;
  driverFile: string;
  callbacks: GeneratedCallback[];
  execution: GeneratedExecutionPlan;
  devices?: GeneratedDevice[];
  handlers?: GeneratedHandler[];
  maps?: GeneratedAddressMap[];
  video?: GeneratedVideoPlan;
  sound?: GeneratedSoundBinding;
}

export type SignalEndpoint = (state: number) => void;

export interface CallbackDevice {
  on(signal: string, callback: SignalEndpoint, slot?: number): unknown;
}

const MACHINES = new Map<string, GeneratedMachine>();

export function defineMachine(machine: GeneratedMachine): GeneratedMachine {
  return machine;
}

export function registerGeneratedMachine(machine: GeneratedMachine): void {
  MACHINES.set(machine.game, machine);
}

export function generatedMachine(game: string): GeneratedMachine {
  const machine = MACHINES.get(game);
  if (!machine) {
    throw new Error(`generated machine "${game}" was not registered`);
  }
  return machine;
}

export function clearGeneratedMachines(): void {
  MACHINES.clear();
}

export interface WiringResult {
  bound: string[];
  ignored: GeneratedCallback[];
}

/** Apply source-generated callback wiring to an executable generated device. */
export function wireDeviceCallbacks(
  device: CallbackDevice,
  machine: GeneratedMachine,
  ownerTag: string,
  signal: string,
  endpoints: Record<string, SignalEndpoint>,
): WiringResult {
  const bound: string[] = [];
  const ignored: GeneratedCallback[] = [];
  for (const callback of machine.callbacks) {
    if (callback.ownerTag !== ownerTag || callback.signal !== signal) continue;
    if (callback.slot === undefined) {
      ignored.push(callback);
      continue;
    }
    const target = callbackTarget(callback);
    const endpoint = target ? endpoints[target] : undefined;
    if (!target || !endpoint) {
      ignored.push(callback);
      continue;
    }
    const invert = callback.transforms?.some(transform => transform === 'invert') ?? false;
    device.on(signal, state => endpoint(invert ? state ^ 1 : state), callback.slot);
    bound.push(target);
  }
  return { bound, ignored };
}

export function callbackTarget(callback: GeneratedCallback): string | undefined {
  if (callback.targetTag && callback.inputLine) return `${callback.targetTag}.${callback.inputLine}`;
  if (!callback.targetMethod) return undefined;
  if (callback.targetTag) return `${callback.targetTag}.${callback.targetMethod}`;
  if (callback.targetClass) return `${callback.targetClass}.${callback.targetMethod}`;
  return callback.targetMethod;
}

export function generatedScreenHandler(machine: GeneratedMachine): GeneratedHandler | undefined {
  const target = machine.execution.screenUpdate?.handler;
  if (!target) return undefined;
  return machine.handlers?.find(handler => `${handler.ownerClass}.${handler.method}` === target);
}
