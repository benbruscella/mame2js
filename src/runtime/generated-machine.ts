import type { RangeSpec } from './bus.ts';
import type { GeneratedAuxiliaryAudioDevice } from './audio-protocol.ts';

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
  /** Owning board device for a device_add_mconfig child. */
  hostTag?: string;
  member?: string;
  clock?: number;
  /** Source-derived rate for device clock callbacks such as MSM5205 VCK. */
  callbackHz?: number;
  configuration?: { method: string; args: number[] }[];
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
      postfix?: boolean;
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
  interruptVectorWriters?: string[];
  source?: GeneratedSourceRef;
}

export interface GeneratedScreen {
  width: number;
  height: number;
  /** Native MAME visible-area origin within the full raster. */
  xOffset?: number;
  yOffset?: number;
  refresh: number;
  vtotal: number;
  vbstart: number;
  vbend?: number;
  /** Rendering cadence requested by MAME screen attributes or update_partial calls. */
  updateMode?: 'frame' | 'scanline' | 'partial';
  rotate: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedFrameEvent {
  callbackId: string;
  ownerTag: string;
  signal: string;
  line: number;
  state: number;
  /** Periodic callbacks accumulate at this exact rate across scanlines. */
  frequency?: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedExecutionPlan {
  cpus: GeneratedExecutionCpu[];
  banks?: {
    tag: string;
    member: string;
    startEntry: number;
    entries: number;
    region: string;
    offset: number;
    stride: number;
    source?: GeneratedSourceRef;
  }[];
  screen: GeneratedScreen;
  customs?: { port: string; mask: number; member: string; handler?: string }[];
  inputMembers?: { member: string; tags: string[] }[];
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
  /** MAME gfxdecode device member owning this entry. */
  decodeMember?: string;
  /** MAME palette device member used by this decode entry. */
  paletteMember?: string;
  colorBase: number;
  colorCount: number;
  xscale: number;
  yscale: number;
  layout: GeneratedGfxLayout;
}

export interface GeneratedPromPalettePlan {
  region: string;
  /** Lookup PROM when it is separate from the RGB PROM. */
  lookupRegion?: string;
  colorCount: number;
  min: number;
  max: number;
  scaler: number;
  channels: {
    channel: 'r' | 'g' | 'b';
    bits: number[];
    /** Byte offset from the palette index for each source bit. */
    offsets?: number[];
    /** MAME-declared contribution for each bit when the source uses fixed weights. */
    weights?: number[];
    resistances: number[];
    pulldown: number;
    pullup: number;
  }[];
  /**
   * Indirect-color sections computed from the color INDEX bits rather than a
   * PROM (e.g. the 05xx starfield palette): each channel's bits select bits
   * of the index and feed a resistor network of its own.
   */
  computedColors?: {
    base: number;
    count: number;
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
  }[];
  lookupOffset: number;
  lookupCount: number;
  lookupMask: number;
  banks: {
    penOffset: number;
    /** Distance between destination pens written by successive loop iterations. */
    penStride?: number;
    colorOr: number;
    /** Distance between direct indirect-color values; defaults to one. */
    colorStride?: number;
    lookupOffset?: number;
    lookupCount?: number;
    /** Direct palettes map pen N to color colorOr + N without a lookup PROM. */
    direct?: boolean;
  }[];
  transparentIndirect: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedTilemapPlan {
  member: string;
  /** MAME gfxdecode member passed to tilemap::create. */
  decodeMember?: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  mapper: string;
  tileInfo: string;
  scrollColumns?: number;
  scrollRows?: number;
  /** MAME tilemap origin offsets for normal and flipped rendering. */
  scrollDx?: [number, number];
  scrollDy?: [number, number];
  transparentPen?: number;
  transparentIndirect?: number;
  /** Per-tile group pen masks declared through MAME tilemap_t::set_transmask. */
  transmasks?: {
    group: number;
    foreground: number;
    background: number;
  }[];
  source?: GeneratedSourceRef;
}

export interface GeneratedBitmapPlan {
  member: string;
  rowStart: number;
  rows: number;
  bytesPerRow: number;
  xOffset: number;
  lsbFirst: boolean;
  /** Packed source pixels; omitted for the original one-bit framebuffer plan. */
  bitsPerPixel?: number;
  /** Source-derived palette RAM network used by packed bitmap hardware. */
  paletteRam?: {
    member: string;
    entries: number;
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
  };
  flipXMember?: string;
  flipYMember?: string;
  black: number;
  white: number;
  source?: GeneratedSourceRef;
}

export interface GeneratedVideoPlan {
  gfx: GeneratedGfxEntry[];
  palette?: GeneratedPromPalettePlan;
  palettes?: {
    member: string;
    plan: GeneratedPromPalettePlan;
  }[];
  tilemaps: GeneratedTilemapPlan[];
  initialState: Record<string, number | number[]>;
  /** MAME may render at a hardware sub-pixel scale (Galaxian uses 3x horizontally). */
  renderScale?: { x: number; y: number };
  /** Driver-init delegate member -> selected MAME method. */
  delegates?: Record<string, string>;
  /** Small source-derived color arrays used by generated video handlers. */
  colorTables?: Record<string, number[]>;
  /** Source-derived LFSR table initialized once and consumed by generated handlers. */
  lfsrTable?: {
    member: string;
    period: number;
    enabledMask: number;
    enabledValue: number;
    colorMask: number;
    colorShift: number;
    feedbackTap: number;
    feedbackInvertTap: number;
    feedbackWidth: number;
    rowRenderer?: {
      method: string;
      colorMember: string;
      scaleMember: string;
    };
  };
  bitmap?: GeneratedBitmapPlan;
  source?: GeneratedSourceRef;
}

export interface GeneratedSoundBinding {
  kind: string;
  deviceTag: string;
  deviceTags?: string[];
  deviceType: string;
  writeMethods: string[];
  enableMethods: string[];
  controlOffset: number;
  routes?: GeneratedAudioRoute[];
  /** Index rank inferred from MAME handler IR for the routed filter member. */
  filterLayout?: 'flat' | 'matrix';
  auxiliaryDevices?: GeneratedAuxiliaryAudioDevice[];
}

export interface GeneratedAudioRoute {
  chip: number;
  channel: number;
  gain: number;
  target: string;
  targetInput?: number;
  filter?: { index: number; bank: number; channel: number };
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

export type SignalEndpoint = (state: number) => number | void;

export interface CallbackDevice {
  on(signal: string, callback: (...args: number[]) => number | void, slot?: number): unknown;
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
    const target = callbackTarget(callback);
    const endpoint = target ? endpoints[target] : undefined;
    if (!target || !endpoint) {
      ignored.push(callback);
      continue;
    }
    // Read callbacks (set_ioport) pull a value FROM the port: the device calls
    // the callback with no data and the transform (mask/rshift) applies to the
    // value read back. Write callbacks push data TO the endpoint: the transform
    // applies to the emitted argument.
    device.on(
      signal,
      callback.targetPort
        ? () => applySignalTransforms(Number(endpoint(0)) || 0, callback.transforms)
        : (...args) => {
            // MAME devcb_write{8,16,32} emits (offset, data, mask), while
            // devcb_write_line emits only state. The configured endpoint
            // consumes data/state, never the trailing access mask.
            const value = args.length >= 3 ? args.at(-2) : args.at(-1);
            return endpoint(applySignalTransforms(value ?? 0, callback.transforms));
          },
      callback.slot ?? 0,
    );
    bound.push(target);
  }
  return { bound, ignored };
}

export function applySignalTransforms(value: number, transforms: string[] = []): number {
  let result = value;
  for (const transform of transforms) {
    // devcb invert() complements the callback's full width; the KG only
    // extracts invert from line callbacks today, where the width is one bit.
    if (transform === 'invert') result ^= 1;
    const mask = /^mask\((0x[\da-f]+|\d+)\)$/i.exec(transform);
    if (mask) result &= Number(mask[1]);
    const shift = /^rshift\((\d+)\)$/.exec(transform);
    if (shift) result >>>= Number(shift[1]);
  }
  return result;
}

export function callbackTarget(callback: GeneratedCallback): string | undefined {
  if (callback.targetPort) return `port.${callback.targetPort}`;
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
