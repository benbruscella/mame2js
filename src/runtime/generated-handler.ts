import type { HandlerRegistry, ReadHandler, WriteHandler } from './bus.ts';
import type { InputPorts } from './types.ts';
import type {
  CallbackDevice,
  GeneratedCallback,
  GeneratedExpression,
  GeneratedHandler,
  GeneratedHandlerOperation,
  GeneratedHandlerProgram,
  GeneratedMachine,
} from './generated-machine.ts';
import { callbackTarget, wireDeviceCallbacks, type WiringResult } from './generated-machine.ts';

export interface GeneratedHandlerBindings {
  /** MAME member names, including the leading m_ used in the source. */
  members?: Record<string, unknown>;
  getters?: Record<string, () => unknown>;
  setters?: Record<string, (value: number) => void>;
  inputs?: InputPorts;
  constants?: Record<string, number>;
  /**
   * Runtime device calls keyed as "m_device.method" or just "method".
   * Calls used only for MAME renderer cache maintenance are ignored by default.
   */
  calls?: Record<string, (...args: number[]) => unknown>;
  /**
   * Generated C++ methods that may receive reference parameters. Unlike
   * browser/device endpoints in `calls`, these receive l-value wrappers for
   * parameters declared with `&`.
   */
  referenceCalls?: Record<string, (...args: GeneratedCallArgument[]) => unknown>;
  callParameters?: Record<string, string[]>;
}

export interface GeneratedLValue {
  get(): unknown;
  set(value: unknown): void;
}

export type GeneratedCallArgument = unknown | GeneratedLValue;

interface ExecutionContext {
  bindings: GeneratedHandlerBindings;
  locals: Record<string, unknown>;
  localTypes: Record<string, string | undefined>;
}

interface RuntimeReference {
  reference: string;
}

interface GeneratedPointer {
  readonly generatedPointer: true;
  readonly source?: unknown;
  readonly offset: number;
  readonly target?: GeneratedLValue;
}

interface ExecutionResult {
  control?: 'return' | 'break';
  value?: unknown;
}

interface PreparedMachineCalls {
  referenceCalls: NonNullable<GeneratedHandlerBindings['referenceCalls']>;
  callParameters: NonNullable<GeneratedHandlerBindings['callParameters']>;
}

const MACHINE_CALL_CACHE = new WeakMap<
  GeneratedMachine,
  WeakMap<GeneratedHandlerBindings, Map<string, PreparedMachineCalls>>
>();
const MACHINE_CALL_STACK: string[] = [];

const DEFAULT_CONSTANTS: Record<string, number> = {
  ASSERT_LINE: 1,
  CLEAR_LINE: 0,
  HOLD_LINE: 2,
  'filter_rc_device::LOWPASS_3R': 0,
  'filter_rc_device::LOWPASS': 2,
  'filter_rc_device::HIGHPASS': 3,
  'filter_rc_device::AC': 4,
  INPUT_LINE_IRQ0: 0,
  INPUT_LINE_NMI: -1,
  INPUT_LINE_RESET: -2,
  M6809_IRQ_LINE: 0,
  TILEMAP_FLIPX: 1,
  TILEMAP_FLIPY: 2,
  TILEMAP_DRAW_OPAQUE: 0x80,
};

const CACHE_ONLY_METHODS = new Set([
  'mark_all_dirty',
  'mark_tile_dirty',
  'set_flip',
  'set_scrollx',
  'set_scrolly',
  'update_partial',
]);

export function executeGeneratedHandler(
  program: GeneratedHandlerProgram,
  bindings: GeneratedHandlerBindings,
  args: Record<string, unknown> = {},
): number | undefined {
  const result = executeGeneratedProgram(program, bindings, args);
  return result.returned && result.value !== undefined ? toNumber(result.value) : undefined;
}

export function executeGeneratedProgram(
  program: GeneratedHandlerProgram,
  bindings: GeneratedHandlerBindings,
  args: Record<string, unknown> = {},
): { returned: boolean; value?: unknown } {
  if (program.diagnostics.length) {
    throw new Error(`cannot execute handler with compiler diagnostics: ${program.diagnostics.join('; ')}`);
  }
  const context: ExecutionContext = {
    bindings,
    locals: {
      ...args,
      addr: args.addr ?? 0,
      offset: args.offset ?? 0,
      data: args.data ?? 0,
      state: args.state ?? args.data ?? 0,
    },
    localTypes: {},
  };
  const result = executeOperations(program.operations, context);
  return result.control === 'return'
    ? { returned: true, ...(result.value !== undefined ? { value: result.value } : {}) }
    : { returned: false };
}

/**
 * Build executable bus handlers for source methods that compiled without
 * diagnostics. Runtime device-tag handlers are intentionally not synthesized;
 * they belong to reusable device implementations.
 */
export function generatedHandlerRegistry(
  machine: GeneratedMachine,
  bindings: GeneratedHandlerBindings = {},
): HandlerRegistry {
  const registry: HandlerRegistry = { read: {}, write: {} };
  const handlers = new Map(
    (machine.handlers ?? [])
      .filter(handler => handler.program && handler.program.diagnostics.length === 0)
      .map(handler => [`${handler.ownerClass}.${handler.method}`, handler]),
  );
  const resolve = (key: string): GeneratedHandler | undefined => {
    const exact = handlers.get(key);
    if (exact) return exact;
    const method = key.slice(key.indexOf('.') + 1);
    const matches = [...handlers.values()].filter(handler => handler.method === method);
    return matches.length === 1 ? matches[0] : undefined;
  };

  for (const map of machine.maps ?? []) {
    for (const range of map.ranges) {
      if (range.read) {
        const handler = resolve(range.read);
        if (handler?.program && !registry.read[range.read]) {
          registry.read[range.read] = makeReadHandler(machine, handler, bindings);
        }
      }
      if (range.write) {
        const handler = resolve(range.write);
        if (handler?.program && !registry.write[range.write]) {
          registry.write[range.write] = makeWriteHandler(machine, handler, bindings);
        }
      }
    }
  }
  return registry;
}

/** Wire a generated device signal to compiled MAME methods and host endpoints. */
export function wireGeneratedDevice(
  device: CallbackDevice,
  machine: GeneratedMachine,
  ownerTag: string,
  signal: string,
  bindings: GeneratedHandlerBindings,
  endpoints: Record<string, (state: number) => void> = {},
): WiringResult {
  const compiled = new Map(
    (machine.handlers ?? [])
      .filter(handler => handler.program && handler.program.diagnostics.length === 0)
      .map(handler => [`${handler.ownerClass}.${handler.method}`, handler]),
  );
  const generatedEndpoints: Record<string, (state: number) => void> = {};
  for (const callback of machine.callbacks) {
    if (callback.ownerTag !== ownerTag || !callback.targetClass || !callback.targetMethod) continue;
    const target = callbackTarget(callback);
    const handler = compiled.get(`${callback.targetClass}.${callback.targetMethod}`);
    if (!target || !handler?.program) continue;
    generatedEndpoints[target] = state => {
      executeGeneratedMachineHandler(machine, handler, bindings, { state, data: state });
    };
  }
  return wireDeviceCallbacks(
    device,
    machine,
    ownerTag,
    signal,
    { ...generatedEndpoints, ...endpoints },
  );
}

export function dispatchGeneratedCallbacks(
  machine: GeneratedMachine,
  ownerTag: string,
  signal: string,
  state: number,
  bindings: GeneratedHandlerBindings,
  endpoints: Record<string, (state: number) => void> = {},
): WiringResult {
  const bound: string[] = [];
  const ignored = [];
  for (const callback of machine.callbacks) {
    if (callback.ownerTag !== ownerTag || callback.signal !== signal) continue;
    const result = dispatchGeneratedCallback(machine, callback, state, bindings, endpoints);
    bound.push(...result.bound);
    ignored.push(...result.ignored);
  }
  return { bound, ignored };
}

export function dispatchGeneratedCallback(
  machine: GeneratedMachine,
  callbackOrId: GeneratedCallback | string,
  state: number,
  bindings: GeneratedHandlerBindings,
  endpoints: Record<string, (state: number) => void> = {},
): WiringResult {
  const callback = typeof callbackOrId === 'string'
    ? machine.callbacks.find(candidate => candidate.id === callbackOrId)
    : callbackOrId;
  if (!callback) return { bound: [], ignored: [] };
  const target = callbackTarget(callback);
  const endpoint = target ? endpoints[target] : undefined;
  const handler = callback.targetClass && callback.targetMethod
    ? machine.handlers?.find(candidate =>
        candidate.ownerClass === callback.targetClass &&
        candidate.method === callback.targetMethod &&
        candidate.program &&
        candidate.program.diagnostics.length === 0)
    : undefined;
  const transformed = callback.transforms?.includes('invert') ? state ^ 1 : state;
  if (endpoint) {
    endpoint(transformed);
    return { bound: [target!], ignored: [] };
  }
  if (handler?.program) {
    executeGeneratedMachineHandler(
      machine,
      handler,
      bindings,
      { state: transformed, data: transformed },
    );
    return { bound: [target ?? `${handler.ownerClass}.${handler.method}`], ignored: [] };
  }
  return { bound: [], ignored: [callback] };
}

export function executeGeneratedCallbackHandler(
  machine: GeneratedMachine,
  callbackOrId: GeneratedCallback | string,
  bindings: GeneratedHandlerBindings,
  args: Record<string, unknown> = {},
): number | undefined {
  const callback = typeof callbackOrId === 'string'
    ? machine.callbacks.find(candidate => candidate.id === callbackOrId)
    : callbackOrId;
  if (!callback?.targetClass || !callback.targetMethod) return undefined;
  const handler = machine.handlers?.find(candidate =>
    candidate.ownerClass === callback.targetClass &&
    candidate.method === callback.targetMethod &&
    candidate.program &&
    candidate.program.diagnostics.length === 0);
  return handler?.program
    ? executeGeneratedMachineHandler(machine, handler, bindings, args)
    : undefined;
}

export function generatedPeriodicLines(
  machine: GeneratedMachine,
  ownerTag: string,
  refreshHz: number,
  vtotal: number,
): number[] {
  const callback = machine.callbacks.find(candidate =>
    candidate.ownerTag === ownerTag &&
    candidate.signal === 'set_periodic_int' &&
    candidate.periodHz !== undefined,
  );
  if (!callback?.periodHz || refreshHz <= 0 || vtotal <= 0) return [];
  const eventsPerFrame = callback.periodHz / refreshHz;
  const rounded = Math.round(eventsPerFrame);
  if (rounded <= 0 || Math.abs(eventsPerFrame - rounded) > 0.1) return [];
  return Array.from({ length: rounded }, (_, index) =>
    Math.floor(index * vtotal / rounded));
}

function makeReadHandler(
  machine: GeneratedMachine,
  handler: GeneratedHandler,
  bindings: GeneratedHandlerBindings,
): ReadHandler {
  return (addr, offset) => executeGeneratedMachineHandler(
    machine,
    handler,
    bindings,
    { addr, offset },
  ) ?? 0xff;
}

function makeWriteHandler(
  machine: GeneratedMachine,
  handler: GeneratedHandler,
  bindings: GeneratedHandlerBindings,
): WriteHandler {
  return (addr, offset, data) => {
    executeGeneratedMachineHandler(
      machine,
      handler,
      bindings,
      { addr, offset, data, state: data },
    );
  };
}

export function executeGeneratedMachineProgram(
  machine: GeneratedMachine,
  handler: GeneratedHandler,
  bindings: GeneratedHandlerBindings,
  args: Record<string, unknown>,
): { returned: boolean; value?: unknown } {
  const prepared = preparedMachineCalls(machine, bindings, handler.ownerClass);
  const suffix = /_(\d+)$/.exec(handler.method);
  const generatedBindings: GeneratedHandlerBindings = {
    ...bindings,
    constants: {
      ...handler.constants,
      ...bindings.constants,
      ...(suffix ? { Which: Number(suffix[1]) } : {}),
    },
    referenceCalls: prepared.referenceCalls,
    callParameters: prepared.callParameters,
  };
  return executeGeneratedProgram(handler.program!, generatedBindings, args);
}

function preparedMachineCalls(
  machine: GeneratedMachine,
  bindings: GeneratedHandlerBindings,
  ownerClass: string,
): PreparedMachineCalls {
  let byBindings = MACHINE_CALL_CACHE.get(machine);
  if (!byBindings) {
    byBindings = new WeakMap();
    MACHINE_CALL_CACHE.set(machine, byBindings);
  }
  let byOwner = byBindings.get(bindings);
  if (!byOwner) {
    byOwner = new Map();
    byBindings.set(bindings, byOwner);
  }
  const cached = byOwner.get(ownerClass);
  if (cached) return cached;

  const compiled = (machine.handlers ?? []).filter(candidate =>
    candidate.program && candidate.program.diagnostics.length === 0);
  const referenceCalls = { ...bindings.referenceCalls };
  const callParameters = { ...bindings.callParameters };
  const resolve = (method: string): GeneratedHandler | undefined =>
    compiled.find(candidate => candidate.ownerClass === ownerClass && candidate.method === method) ??
    compiled.find(candidate => candidate.method === method);
  const invoke = (target: GeneratedHandler, values: GeneratedCallArgument[]): unknown => {
    const key = `${target.ownerClass}.${target.method}`;
    if (MACHINE_CALL_STACK.length >= 64) {
      throw new Error(
        `generated handler call depth exceeded 64: ${[...MACHINE_CALL_STACK, key].join(' -> ')}`,
      );
    }
    const names = parameterNames(target.parameters);
    MACHINE_CALL_STACK.push(key);
    try {
      return executeGeneratedMachineProgram(
        machine,
        target,
        bindings,
        Object.fromEntries(names.map((name, index) => [name, values[index] ?? 0])),
      ).value ?? 0;
    } finally {
      MACHINE_CALL_STACK.pop();
    }
  };
  for (const candidate of compiled) {
    const qualified = `${candidate.ownerClass}.${candidate.method}`;
    if (!referenceCalls[qualified]) {
      referenceCalls[qualified] = (...values) => invoke(candidate, values);
    }
    if (!referenceCalls[candidate.method]) {
      referenceCalls[candidate.method] = (...values) => {
        const target = resolve(candidate.method);
        return target ? invoke(target, values) : 0;
      };
    }
    const parameters = (candidate.parameters ?? '')
      .split(',')
      .map(parameter => parameter.trim())
      .filter(Boolean);
    callParameters[qualified] = parameters;
    callParameters[candidate.method] = parameters;
  }
  const prepared = { referenceCalls, callParameters };
  byOwner.set(ownerClass, prepared);
  return prepared;
}

export function executeGeneratedMachineHandler(
  machine: GeneratedMachine,
  handler: GeneratedHandler,
  bindings: GeneratedHandlerBindings,
  args: Record<string, unknown>,
): number | undefined {
  const result = executeGeneratedMachineProgram(machine, handler, bindings, args);
  return result.returned && result.value !== undefined ? toNumber(result.value) : undefined;
}

function parameterNames(parameters: string | undefined): string[] {
  return (parameters ?? '')
    .split(',')
    .map(parameter => /(\w+)\s*$/.exec(parameter.trim())?.[1])
    .filter((name): name is string => Boolean(name));
}

function executeOperations(
  operations: GeneratedHandlerOperation[],
  context: ExecutionContext,
): ExecutionResult {
  for (const operation of operations) {
    if (operation.op === 'declare') {
      context.localTypes[operation.name] = operation.valueType;
      context.locals[operation.name] = wrapValue(operation.valueType, operation.value
        ? evaluate(operation.value, context)
        : 0);
    } else if (operation.op === 'assign') {
      assign(operation.target, operation.operator, evaluate(operation.value, context), context);
    } else if (operation.op === 'call') {
      evaluate(operation.expression, context);
    } else if (operation.op === 'return') {
      return {
        control: 'return',
        ...(operation.value ? { value: evaluate(operation.value, context) } : {}),
      };
    } else if (operation.op === 'break') {
      return { control: 'break' };
    } else if (operation.op === 'if') {
      const branch = truthy(evaluate(operation.condition, context))
        ? operation.then
        : operation.else ?? [];
      const result = executeOperations(branch, context);
      if (result.control) return result;
    } else if (operation.op === 'for') {
      const initialized = executeOperations(operation.initialize, context);
      if (initialized.control) return initialized;
      let iterations = 0;
      while (truthy(evaluate(operation.condition, context))) {
        if (++iterations > 65_536) throw new Error('generated handler loop exceeded 65536 iterations');
        const result = executeOperations(operation.body, context);
        if (result.control === 'return') return result;
        if (result.control === 'break') break;
        const iterated = executeOperations([operation.iterate], context);
        if (iterated.control === 'return') return iterated;
        if (iterated.control === 'break') break;
      }
    } else if (operation.op === 'while') {
      let iterations = 0;
      while (truthy(evaluate(operation.condition, context))) {
        if (++iterations > 65_536) throw new Error('generated handler loop exceeded 65536 iterations');
        const result = executeOperations(operation.body, context);
        if (result.control === 'return') return result;
        if (result.control === 'break') break;
      }
    } else if (operation.op === 'switch') {
      const value = toNumber(evaluate(operation.expression, context));
      let index = operation.cases.findIndex(candidate =>
        candidate.values?.some(candidateValue =>
          toNumber(evaluate(candidateValue, context)) === value));
      if (index < 0) index = operation.cases.findIndex(candidate => !candidate.values);
      for (; index >= 0 && index < operation.cases.length; index++) {
        const result = executeOperations(operation.cases[index]!.body, context);
        if (result.control === 'return') return result;
        if (result.control === 'break') break;
      }
    }
  }
  return {};
}

function evaluate(expression: GeneratedExpression, context: ExecutionContext): unknown {
  if (expression.kind === 'number' || expression.kind === 'string') return expression.value;
  if (expression.kind === 'identifier') {
    if (Object.hasOwn(context.locals, expression.name)) {
      const local = context.locals[expression.name];
      return isLValue(local) ? local.get() : local;
    }
    const getter = context.bindings.getters?.[expression.name];
    if (getter) return getter();
    if (Object.hasOwn(context.bindings.members ?? {}, expression.name)) {
      return context.bindings.members![expression.name];
    }
    const constant = context.bindings.constants?.[expression.name] ?? DEFAULT_CONSTANTS[expression.name];
    return constant ?? reference(expression.name);
  }
  if (expression.kind === 'unary') {
    if (expression.operator === '&') return addressOf(expression.operand, context);
    const raw = evaluate(expression.operand, context);
    if (expression.operator === '*') {
      return isGeneratedPointer(raw) ? pointerValue(raw, 0) : raw;
    }
    if (expression.operator === '!') return truthy(raw) ? 0 : 1;
    const value = toNumber(raw);
    if (expression.operator === '~') return ~value;
    if (expression.operator === '-') return -value;
    return value;
  }
  if (expression.kind === 'cast') {
    return wrapValue(expression.valueType, evaluate(expression.operand, context));
  }
  if (expression.kind === 'assignment') {
    const previous = expression.postfix ? evaluate(expression.target, context) : undefined;
    const value = evaluate(expression.value, context);
    assign(expression.target, expression.operator, value, context);
    return expression.postfix ? previous : evaluate(expression.target, context);
  }
  if (expression.kind === 'binary') {
    const leftValue = evaluate(expression.left, context);
    if (expression.operator === '&&') {
      return truthy(leftValue) && truthy(evaluate(expression.right, context)) ? 1 : 0;
    }
    if (expression.operator === '||') {
      return truthy(leftValue) || truthy(evaluate(expression.right, context)) ? 1 : 0;
    }
    const rightValue = evaluate(expression.right, context);
    if (expression.operator === '+' && isGeneratedPointer(leftValue)) {
      return offsetPointer(leftValue, toNumber(rightValue));
    }
    if (expression.operator === '+' && isGeneratedPointer(rightValue)) {
      return offsetPointer(rightValue, toNumber(leftValue));
    }
    if (expression.operator === '-' && isGeneratedPointer(leftValue)) {
      return offsetPointer(leftValue, -toNumber(rightValue));
    }
    if (expression.operator === '==' || expression.operator === '!=') {
      const equal = comparableValue(leftValue) === comparableValue(rightValue);
      return expression.operator === '==' ? Number(equal) : Number(!equal);
    }
    const left = toNumber(leftValue);
    const right = toNumber(rightValue);
    return binary(expression.operator, left, right);
  }
  if (expression.kind === 'conditional') {
    return evaluate(
      truthy(evaluate(expression.condition, context)) ? expression.whenTrue : expression.whenFalse,
      context,
    );
  }
  if (expression.kind === 'member') {
    const object = evaluate(expression.object, context);
    if (isReference(object)) return reference(`${object.reference}.${expression.property}`);
    if (object && typeof object === 'object' && expression.property in object) {
      return (object as Record<string, unknown>)[expression.property];
    }
    return reference(expression.property);
  }
  if (expression.kind === 'index') {
    const object = evaluate(expression.object, context);
    const index = toNumber(evaluate(expression.index, context));
    return indexValue(object, index);
  }
  return evaluateCall(expression, context);
}

function evaluateCall(
  expression: Extract<GeneratedExpression, { kind: 'call' }>,
  context: ExecutionContext,
): unknown {
  if (expression.callee.kind === 'identifier') {
    const name = expression.callee.name;
    const generated = context.bindings.referenceCalls?.[name];
    if (generated) {
      return generated(...generatedCallArguments(name, expression.args, context));
    }
    const args = expression.args.map(arg => evaluate(arg, context));
    if (name === 'BIT') return (toNumber(args[0]) >> toNumber(args[1])) & 1;
    if (name === 'rgb_t::black') return 0xff000000;
    if (name === 'rgb_t::white') return 0xffffffff;
    if (name === 'CAP_P') return toNumber(args[0]) * 1e-12;
    if (name === 'CAP_N') return toNumber(args[0]) * 1e-9;
    if (name === 'CAP_U') return toNumber(args[0]) * 1e-6;
    if (name === 'RES_K') return toNumber(args[0]) * 1e3;
    if (name === 'RES_M') return toNumber(args[0]) * 1e6;
    if (name === 'TILE_FLIPYX') return toNumber(args[0]) & 3;
    if (name === 'TILE_FLIPXY') {
      const value = toNumber(args[0]);
      return ((value & 2) >> 1) | ((value & 1) << 1);
    }
    if (name === 'TABLE') {
      const values = args.slice(1);
      const index = values.length
        ? modulo(toNumber(args[0]), values.length)
        : 0;
      return values[index] ?? 0;
    }
    if (name === 'ioport') return reference(`ioport:${String(args[0] ?? '')}`);
    if (['u8', 'uint8_t'].includes(name)) return toNumber(args[0]) & 0xff;
    if (['s8', 'int8_t'].includes(name)) return (toNumber(args[0]) << 24) >> 24;
    if (['u16', 'uint16_t'].includes(name)) return toNumber(args[0]) & 0xffff;
    if (['s16', 'int16_t'].includes(name)) return (toNumber(args[0]) << 16) >> 16;
    if (['u32', 'uint32_t'].includes(name)) return toNumber(args[0]) >>> 0;
    if (['s32', 'int32_t'].includes(name)) return toNumber(args[0]) | 0;
    if (name === 'bool') return toNumber(args[0]) ? 1 : 0;
    const handler = context.bindings.calls?.[name];
    if (handler) return handler(...args.map(toNumber));
    const member = context.bindings.members?.[name];
    if (typeof member === 'function') return member(...args.map(toNumber));
    return reference(`${name}()`);
  }
  if (expression.callee.kind === 'member') {
    const generatedName = `${generatedExpressionName(expression.callee.object)}.${expression.callee.property}`;
    const generated = context.bindings.referenceCalls?.[generatedName];
    if (generated) {
      return generated(...generatedCallArguments(generatedName, expression.args, context));
    }
    const object = evaluate(expression.callee.object, context);
    const method = expression.callee.property;
    if (isReference(object)) {
      const key = `${object.reference}.${method}`;
      const generated = context.bindings.referenceCalls?.[key];
      if (generated) {
        return generated(...generatedCallArguments(key, expression.args, context));
      }
      const args = expression.args.map(arg => evaluate(arg, context));
      if (object.reference.startsWith('ioport:') && method === 'read') {
        return context.bindings.inputs?.read(object.reference.slice('ioport:'.length)) ?? 0xff;
      }
      if (key === 'machine().scheduler().synchronize') {
        const callback = timerDelegateName(expression.args[0]);
        const generatedCallback = callback
          ? context.bindings.referenceCalls?.[callback]
          : undefined;
        if (!generatedCallback) return 0;
        return generatedCallback(
          expression.args[1] ? evaluate(expression.args[1], context) : 0,
        );
      }
      const handler = context.bindings.calls?.[key] ?? context.bindings.calls?.[method];
      if (handler) return handler(...args.map(toNumber));
      if (CACHE_ONLY_METHODS.has(method)) return 0;
      return reference(`${key}()`);
    }
    if (object && typeof object === 'object') {
      const args = expression.args.map(arg => evaluate(arg, context));
      const methodValue = (object as Record<string, unknown>)[method];
      if (typeof methodValue === 'function') return methodValue.apply(object, args);
    }
  }
  if (expression.callee.kind === 'index') {
    const callable = evaluate(expression.callee, context);
    const args = expression.args.map(arg => evaluate(arg, context));
    if (typeof callable === 'function') return callable(...args.map(toNumber));
  }
  return 0;
}

function assign(
  target: GeneratedExpression,
  operator: string,
  value: unknown,
  context: ExecutionContext,
): void {
  if (target.kind === 'identifier') {
    const local = context.locals[target.name];
    const localReference = isLValue(local) ? local : undefined;
    const current = Object.hasOwn(context.locals, target.name)
      ? localReference?.get() ?? local
      : context.bindings.getters?.[target.name]?.() ?? context.bindings.members?.[target.name];
    const next = assignmentValue(operator, current, value);
    if (Object.hasOwn(context.locals, target.name)) {
      const wrapped = wrapValue(context.localTypes[target.name], next);
      if (localReference) localReference.set(wrapped);
      else context.locals[target.name] = wrapped;
    }
    else {
      const setter = context.bindings.setters?.[target.name];
      if (setter) setter(toNumber(next));
      else (context.bindings.members ??= {})[target.name] = next;
    }
    return;
  }
  if (target.kind === 'index') {
    const object = evaluate(target.object, context);
    const index = toNumber(evaluate(target.index, context));
    const current = indexValue(object, index);
    const next = toNumber(assignmentValue(operator, current, value));
    if (isGeneratedPointer(object)) {
      setPointerValue(object, index, next);
    } else if (ArrayBuffer.isView(object)) {
      (object as Uint8Array)[index] = next;
    } else if (Array.isArray(object)) {
      object[index] = next;
    }
    return;
  }
  if (target.kind === 'unary' && target.operator === '*') {
    const pointer = evaluate(target.operand, context);
    if (!isGeneratedPointer(pointer)) {
      throw new Error('generated dereference assignment has no pointer');
    }
    const current = pointerValue(pointer, 0);
    setPointerValue(pointer, 0, assignmentValue(operator, current, value));
    return;
  }
  if (target.kind === 'member') {
    const object = evaluate(target.object, context);
    if (!object || typeof object !== 'object' || isReference(object)) {
      throw new Error(`generated member assignment has no object for "${target.property}"`);
    }
    const record = object as Record<string, unknown>;
    record[target.property] = assignmentValue(operator, record[target.property], value);
    return;
  }
  if (target.kind === 'call') {
    assignCallResult(target, value, context);
    return;
  }
  throw new Error(`unsupported generated assignment target "${target.kind}"`);
}

function assignCallResult(
  target: Extract<GeneratedExpression, { kind: 'call' }>,
  value: unknown,
  context: ExecutionContext,
): void {
  const args = target.args.map(arg => toNumber(evaluate(arg, context)));
  if (target.callee.kind === 'identifier') {
    const handler = context.bindings.calls?.[`${target.callee.name}=`];
    if (handler) {
      handler(...args, toNumber(value));
      return;
    }
  } else if (target.callee.kind === 'member') {
    const object = evaluate(target.callee.object, context);
    if (isReference(object)) {
      const handler = context.bindings.calls?.[`${object.reference}.${target.callee.property}=`];
      if (handler) {
        handler(...args, toNumber(value));
        return;
      }
    } else if (object && typeof object === 'object') {
      const handler = (object as Record<string, unknown>)[`${target.callee.property}=`];
      if (typeof handler === 'function') {
        handler.apply(object, [...args, toNumber(value)]);
        return;
      }
    }
  }
  throw new Error('generated call-result assignment has no runtime binding');
}

function assignmentValue(operator: string, current: unknown, value: unknown): unknown {
  if (operator === '=') return value;
  if (
    operator === '&=' &&
    current &&
    typeof current === 'object' &&
    typeof (current as { intersect?: unknown }).intersect === 'function'
  ) {
    (current as { intersect: (other: unknown) => void }).intersect(value);
    return current;
  }
  return binary(operator.slice(0, -1), toNumber(current), toNumber(value));
}

function wrapValue(valueType: string | undefined, value: unknown): unknown {
  if (valueType === 'auto' || valueType?.includes('*') || valueType?.includes('&')) return value;
  if (value && typeof value === 'object') return value;
  valueType = valueType?.replace(/\bconst\b/g, '').trim();
  const number = toNumber(value);
  if (valueType === 'uint8_t' || valueType === 'u8') return number & 0xff;
  if (valueType === 'int8_t' || valueType === 's8') return (number << 24) >> 24;
  if (valueType === 'char') return (number << 24) >> 24;
  if (valueType === 'bool') return number ? 1 : 0;
  if (valueType === 'uint16_t' || valueType === 'u16') return number & 0xffff;
  if (valueType === 'int16_t' || valueType === 's16') return (number << 16) >> 16;
  if (valueType === 'uint32_t' || valueType === 'u32') return number >>> 0;
  if (valueType === 'int32_t' || valueType === 's32') return number | 0;
  return number;
}

function binary(operator: string, left: number, right: number): number {
  if (operator === '|') return left | right;
  if (operator === '^') return left ^ right;
  if (operator === '&') return left & right;
  if (operator === '==') return left === right ? 1 : 0;
  if (operator === '!=') return left !== right ? 1 : 0;
  if (operator === '<') return left < right ? 1 : 0;
  if (operator === '<=') return left <= right ? 1 : 0;
  if (operator === '>') return left > right ? 1 : 0;
  if (operator === '>=') return left >= right ? 1 : 0;
  if (operator === '<<') return left << right;
  if (operator === '>>') return left >> right;
  if (operator === '+') return left + right;
  if (operator === '-') return left - right;
  if (operator === '*') return left * right;
  if (operator === '/') return Math.trunc(left / right);
  if (operator === '%') return left % right;
  return 0;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function indexValue(object: unknown, index: number): unknown {
  if (isGeneratedPointer(object)) return pointerValue(object, index);
  if (ArrayBuffer.isView(object)) return (object as Uint8Array)[index] ?? 0;
  if (Array.isArray(object)) return object[index] ?? 0;
  return 0;
}

function addressOf(expression: GeneratedExpression, context: ExecutionContext): GeneratedPointer {
  if (expression.kind === 'index') {
    const source = evaluate(expression.object, context);
    const offset = toNumber(evaluate(expression.index, context));
    return isGeneratedPointer(source)
      ? offsetPointer(source, offset)
      : { generatedPointer: true, source, offset };
  }
  return {
    generatedPointer: true,
    target: lValue(expression, context),
    offset: 0,
  };
}

function offsetPointer(pointer: GeneratedPointer, offset: number): GeneratedPointer {
  return { ...pointer, offset: pointer.offset + offset };
}

function pointerValue(pointer: GeneratedPointer, index: number): unknown {
  const offset = pointer.offset + index;
  if (pointer.target) return offset === 0 ? pointer.target.get() : 0;
  return indexValue(pointer.source, offset);
}

function setPointerValue(pointer: GeneratedPointer, index: number, value: unknown): void {
  const offset = pointer.offset + index;
  if (pointer.target) {
    if (offset === 0) pointer.target.set(value);
    return;
  }
  if (isGeneratedPointer(pointer.source)) {
    setPointerValue(pointer.source, offset, value);
  } else if (ArrayBuffer.isView(pointer.source)) {
    (pointer.source as Uint8Array)[offset] = toNumber(value);
  } else if (Array.isArray(pointer.source)) {
    pointer.source[offset] = value;
  }
}

function toNumber(value: unknown): number {
  if (isLValue(value)) return toNumber(value.get());
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number(value) || 0;
}

function comparableValue(value: unknown): unknown {
  if (isLValue(value)) return comparableValue(value.get());
  if (value && typeof value === 'object' && !isReference(value)) return value;
  return toNumber(value);
}

function truthy(value: unknown): boolean {
  if (value && typeof value === 'object' && !isReference(value) && !isLValue(value)) {
    return true;
  }
  return toNumber(value) !== 0;
}

function reference(name: string): RuntimeReference {
  return { reference: name };
}

function isReference(value: unknown): value is RuntimeReference {
  return Boolean(value && typeof value === 'object' && 'reference' in value);
}

function isGeneratedPointer(value: unknown): value is GeneratedPointer {
  return Boolean(
    value && typeof value === 'object' &&
    (value as GeneratedPointer).generatedPointer === true,
  );
}

function isLValue(value: unknown): value is GeneratedLValue {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as GeneratedLValue).get === 'function' &&
    typeof (value as GeneratedLValue).set === 'function',
  );
}

function generatedCallArguments(
  name: string,
  expressions: GeneratedExpression[],
  context: ExecutionContext,
): GeneratedCallArgument[] {
  const parameters = context.bindings.callParameters?.[name] ?? [];
  return expressions.map((expression, index) =>
    parameters[index]?.includes('&')
      ? lValue(expression, context)
      : evaluate(expression, context));
}

function lValue(expression: GeneratedExpression, context: ExecutionContext): GeneratedLValue {
  return {
    get: () => evaluate(expression, context),
    set: value => assign(expression, '=', value, context),
  };
}

function generatedExpressionName(expression: GeneratedExpression): string {
  if (expression.kind === 'identifier') return expression.name;
  if (expression.kind === 'member') {
    return `${generatedExpressionName(expression.object)}.${expression.property}`;
  }
  return '<expression>';
}

function timerDelegateName(expression: GeneratedExpression | undefined): string | undefined {
  if (
    expression?.kind !== 'call' ||
    expression.callee.kind !== 'identifier' ||
    expression.callee.name !== 'timer_expired_delegate'
  ) {
    return undefined;
  }
  const callback = expression.args[0];
  if (
    callback?.kind !== 'call' ||
    callback.callee.kind !== 'identifier' ||
    callback.callee.name !== 'FUNC'
  ) {
    return undefined;
  }
  const target = callback.args[0];
  if (target?.kind !== 'identifier') return undefined;
  return target.name.split('::').at(-1);
}
