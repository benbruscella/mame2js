import {
  executeGeneratedProgram,
  type GeneratedCallArgument,
  type GeneratedHandlerBindings,
} from './generated-handler.ts';
import type { GeneratedHandlerProgram } from './generated-machine.ts';

interface DeviceMember {
  name: string;
  valueType: string;
  bits?: 1 | 8 | 16 | 32;
  signed?: boolean;
  initial?: number;
  values?: number[];
}

interface DeviceCallback {
  signal: string;
  member: string;
  slots: number;
  initial?: number;
}

interface DeviceTimer {
  member: string;
  callback: string;
}

interface DeviceMethod {
  name: string;
  parameters: string;
  program: GeneratedHandlerProgram;
}

export interface GeneratedDeviceExecutionContext {
  readonly members: Record<string, unknown>;
  invoke(name: string, ...args: GeneratedCallArgument[]): unknown;
}

export type GeneratedDeviceMethodExecutable = (
  runtime: GeneratedDeviceExecutionContext,
  ...args: GeneratedCallArgument[]
) => unknown;

export type GeneratedDeviceMethodMap = Record<string, GeneratedDeviceMethodExecutable>;

export interface GeneratedDeviceDefinition {
  type: string;
  constants: Record<string, number>;
  members: DeviceMember[];
  callbacks: DeviceCallback[];
  timers?: DeviceTimer[];
  methods: DeviceMethod[];
  clockDivider?: number;
  compiledMethods?: GeneratedDeviceMethodMap;
  start?: string;
  reset?: string;
  summary: {
    diagnostics: number;
  };
}

export type DeviceCallbackListener = (...args: number[]) => number | void;

export interface Device {
  reset(): void;
  tick(seconds: number): void;
  call(name: string, ...args: number[]): number;
  get(name: string): number;
  set(name: string, value: number): void;
  methodNames(): readonly string[];
  arity(name: string): number;
  signalNames(): readonly string[];
  on(signal: string, listener: DeviceCallbackListener, slot?: number): Device;
  bindCall(name: string, listener: (...args: number[]) => unknown): Device;
  cycleClock(): number;
}

const DEFINITIONS = new Map<string, GeneratedDeviceDefinition>();

export function registerGeneratedDevice(definition: GeneratedDeviceDefinition): void {
  if (definition.summary.diagnostics) {
    throw new Error(
      `cannot register ${definition.type}: ${definition.summary.diagnostics} compiler diagnostics`,
    );
  }
  DEFINITIONS.set(definition.type.toUpperCase(), definition);
}

export function clearGeneratedDevices(): void {
  DEFINITIONS.clear();
}

export function hasGeneratedDevice(type: string): boolean {
  return DEFINITIONS.has(type.toUpperCase());
}

export function createDevice(type: string, options: { clock?: number } = {}): Device {
  const definition = DEFINITIONS.get(type.toUpperCase());
  if (!definition) throw new Error(`generated device "${type}" was not registered`);
  return new IrDevice(definition, options.clock ?? 0);
}

class IrTimer {
  private remaining = Infinity;
  private period = Infinity;
  private parameter = 0;

  adjust(delay: number, parameter = 0, period = Infinity): void {
    this.remaining = Number.isFinite(delay) && delay >= 0 ? delay : Infinity;
    this.period = Number.isFinite(period) && period > 0 ? period : Infinity;
    this.parameter = parameter;
  }

  tick(seconds: number, callback: (parameter: number) => void): void {
    if (!Number.isFinite(this.remaining)) return;
    this.remaining -= seconds;
    let firings = 0;
    while (this.remaining <= 0) {
      if (++firings > 65_536) throw new Error('generated device timer exceeded 65536 firings');
      callback(this.parameter);
      if (!Number.isFinite(this.period)) {
        this.remaining = Infinity;
        break;
      }
      this.remaining += this.period;
    }
  }
}

class IrDevice implements Device {
  private readonly definition: GeneratedDeviceDefinition;
  private readonly members: Record<string, unknown> = {};
  private readonly memberBits = new Map<string, 1 | 8 | 16 | 32>();
  private readonly memberSigned = new Set<string>();
  private readonly methods: Map<string, DeviceMethod>;
  /** Parameter names resolved once per method (the regex is a hot-path cost). */
  private readonly methodParams = new Map<string, string[]>();
  private readonly listeners = new Map<string, DeviceCallbackListener[][]>();
  private readonly bindings: GeneratedHandlerBindings;
  private readonly executionContext: GeneratedDeviceExecutionContext;
  private readonly timers = new Map<string, { timer: IrTimer; callback: string }>();
  private readonly clock: number;

  constructor(definition: GeneratedDeviceDefinition, clock: number) {
    this.definition = definition;
    this.clock = clock;
    this.methods = new Map(definition.methods.map(method => [method.name, method]));
    for (const member of definition.members) {
      this.members[member.name] = member.values ? [...member.values] : member.initial ?? 0;
      if (member.bits) this.memberBits.set(member.name, member.bits);
      if (member.signed) this.memberSigned.add(member.name);
    }
    for (const callback of definition.callbacks) {
      const slots = Array.from({ length: callback.slots }, () => [] as DeviceCallbackListener[]);
      this.listeners.set(callback.signal, slots);
      const emitters = slots.map(listeners =>
        (...args: number[]) => {
          let result = callback.initial ?? 0;
          for (const listener of listeners) {
            const value = listener(...args);
            if (value !== undefined) result = value;
          }
          return result;
        });
      this.members[callback.member] = callback.slots === 1 ? emitters[0] : emitters;
    }
    for (const specification of definition.timers ?? []) {
      const timer = new IrTimer();
      this.timers.set(specification.member, { timer, callback: specification.callback });
      this.members[specification.member] = timer;
    }

    const getters: Record<string, () => unknown> = {};
    const setters: Record<string, (value: number) => void> = {};
    for (const member of definition.members) {
      getters[member.name] = () => this.members[member.name] ?? 0;
      setters[member.name] = value => {
        this.members[member.name] = wrap(value, member.bits, member.signed);
      };
    }
    const referenceCalls: NonNullable<GeneratedHandlerBindings['referenceCalls']> = {};
    const callParameters: NonNullable<GeneratedHandlerBindings['callParameters']> = {};
    this.bindings = {
      members: this.members,
      getters,
      setters,
      constants: definition.constants,
      calls: {
        save_item: () => 0,
        logerror: () => 0,
        clock: () => clock,
      },
      referenceCalls,
      callParameters,
    };
    this.executionContext = {
      members: this.members,
      invoke: (name, ...args) => {
        const method = this.methods.get(name);
        if (!method) throw new Error(`${this.definition.type} has no generated method "${name}"`);
        return this.executeMethod(method, this.methodParams.get(name)!, args);
      },
    };
    const pendingTimers = [...this.timers.values()];
    this.bindings.calls!.timer_alloc = () => pendingTimers.shift()?.timer ?? 0;
    for (const method of definition.methods) {
      const parameters = splitParameters(method.parameters);
      const names = parameters.map(parameterName);
      callParameters[method.name] = parameters;
      this.methodParams.set(method.name, names);
      referenceCalls[method.name] = (...args) => this.executeMethod(method, names, args);
    }

    if (definition.start) this.call(definition.start);
    this.reset();
  }

  reset(): void {
    if (this.definition.reset) this.call(this.definition.reset);
  }

  tick(seconds: number): void {
    for (const { timer, callback } of this.timers.values()) {
      timer.tick(seconds, parameter => this.call(callback, parameter));
    }
  }

  call(name: string, ...args: number[]): number {
    const method = this.methods.get(name);
    if (!method) throw new Error(`${this.definition.type} has no generated method "${name}"`);
    return Number(this.executeMethod(method, this.methodParams.get(name)!, args)) || 0;
  }

  get(name: string): number {
    return Number(this.members[name]) || 0;
  }

  set(name: string, value: number): void {
    this.members[name] = wrap(
      value,
      this.memberBits.get(name),
      this.memberSigned.has(name),
    );
  }

  methodNames(): readonly string[] {
    return [...this.methods.keys()];
  }

  arity(name: string): number {
    return splitParameters(this.methods.get(name)?.parameters ?? '').length;
  }

  signalNames(): readonly string[] {
    return [...this.listeners.keys()];
  }

  on(signal: string, listener: DeviceCallbackListener, slot = 0): Device {
    const channels = this.listeners.get(signal);
    if (!channels) throw new Error(`${this.definition.type} has no callback signal "${signal}"`);
    const listeners = channels[slot];
    if (!listeners) {
      throw new Error(`${this.definition.type} callback "${signal}" has no slot ${slot}`);
    }
    listeners.push(listener);
    return this;
  }

  bindCall(name: string, listener: (...args: number[]) => unknown): Device {
    this.bindings.calls![name] = listener;
    return this;
  }

  cycleClock(): number {
    return this.clock / (this.definition.clockDivider ?? 1);
  }

  private executeMethod(
    method: DeviceMethod,
    parameterNames: string[],
    args: GeneratedCallArgument[],
  ): unknown {
    const compiled = this.definition.compiledMethods?.[method.name];
    if (compiled) return compiled(this.executionContext, ...args);
    const locals: Record<string, unknown> = {};
    for (let index = 0; index < parameterNames.length; index++) {
      locals[parameterNames[index]!] = args[index] ?? 0;
    }
    return executeGeneratedProgram(method.program, this.bindings, locals).value;
  }
}

function splitParameters(parameters: string): string[] {
  return parameters.split(',').map(parameter => parameter.trim()).filter(Boolean);
}

function parameterName(parameter: string): string {
  return /(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter)?.[1] ?? parameter;
}

function wrap(value: number, bits?: 1 | 8 | 16 | 32, signed = false): number {
  if (bits === 1) return value ? 1 : 0;
  if (bits === 8) return signed ? value << 24 >> 24 : value & 0xff;
  if (bits === 16) return signed ? value << 16 >> 16 : value & 0xffff;
  if (bits === 32) return signed ? value | 0 : value >>> 0;
  return value;
}
