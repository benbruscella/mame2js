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
  initial?: number;
}

interface DeviceCallback {
  signal: string;
  member: string;
  slots: number;
}

interface DeviceMethod {
  name: string;
  parameters: string;
  program: GeneratedHandlerProgram;
}

export interface GeneratedDeviceDefinition {
  type: string;
  constants: Record<string, number>;
  members: DeviceMember[];
  callbacks: DeviceCallback[];
  methods: DeviceMethod[];
  start?: string;
  reset?: string;
  summary: {
    diagnostics: number;
  };
}

export type DeviceCallbackListener = (...args: number[]) => void;

export interface Device {
  reset(): void;
  call(name: string, ...args: number[]): number;
  get(name: string): number;
  set(name: string, value: number): void;
  arity(name: string): number;
  methodNames(): readonly string[];
  signalNames(): readonly string[];
  on(signal: string, listener: DeviceCallbackListener, slot?: number): Device;
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

export function createDevice(type: string): Device {
  const definition = DEFINITIONS.get(type.toUpperCase());
  if (!definition) throw new Error(`generated device "${type}" was not registered`);
  return new IrDevice(definition);
}

class IrDevice implements Device {
  private readonly definition: GeneratedDeviceDefinition;
  private readonly members: Record<string, unknown> = {};
  private readonly memberBits = new Map<string, 1 | 8 | 16 | 32>();
  private readonly methods: Map<string, DeviceMethod>;
  private readonly listeners = new Map<string, DeviceCallbackListener[][]>();
  private readonly bindings: GeneratedHandlerBindings;

  constructor(definition: GeneratedDeviceDefinition) {
    this.definition = definition;
    this.methods = new Map(definition.methods.map(method => [method.name, method]));
    for (const member of definition.members) {
      this.members[member.name] = member.initial ?? 0;
      if (member.bits) this.memberBits.set(member.name, member.bits);
    }
    for (const callback of definition.callbacks) {
      const slots = Array.from({ length: callback.slots }, () => [] as DeviceCallbackListener[]);
      this.listeners.set(callback.signal, slots);
      const emitters = slots.map(listeners =>
        (...args: number[]) => {
          for (const listener of listeners) listener(...args);
        });
      this.members[callback.member] = callback.slots === 1 ? emitters[0] : emitters;
    }

    const getters: Record<string, () => unknown> = {};
    const setters: Record<string, (value: number) => void> = {};
    for (const member of definition.members) {
      getters[member.name] = () => this.members[member.name] ?? 0;
      setters[member.name] = value => {
        this.members[member.name] = wrap(value, member.bits);
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
      },
      referenceCalls,
      callParameters,
    };
    for (const method of definition.methods) {
      const parameters = splitParameters(method.parameters);
      callParameters[method.name] = parameters;
      referenceCalls[method.name] = (...args) => this.executeMethod(method, parameters, args);
    }

    if (definition.start) this.call(definition.start);
    this.reset();
  }

  reset(): void {
    if (this.definition.reset) this.call(this.definition.reset);
  }

  call(name: string, ...args: number[]): number {
    const method = this.methods.get(name);
    if (!method) throw new Error(`${this.definition.type} has no generated method "${name}"`);
    const parameters = splitParameters(method.parameters);
    return Number(this.executeMethod(method, parameters, args)) || 0;
  }

  get(name: string): number {
    return Number(this.members[name]) || 0;
  }

  set(name: string, value: number): void {
    this.members[name] = wrap(value, this.memberBits.get(name));
  }

  arity(name: string): number {
    const method = this.methods.get(name);
    return method ? splitParameters(method.parameters).length : 0;
  }

  methodNames(): readonly string[] {
    return [...this.methods.keys()];
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

  private executeMethod(
    method: DeviceMethod,
    parameters: string[],
    args: GeneratedCallArgument[],
  ): unknown {
    return executeGeneratedProgram(
      method.program,
      this.bindings,
      Object.fromEntries(parameters.map((parameter, index) => [
        parameterName(parameter),
        args[index] ?? 0,
      ])),
    ).value;
  }
}

function splitParameters(parameters: string): string[] {
  return parameters.split(',').map(parameter => parameter.trim()).filter(Boolean);
}

function parameterName(parameter: string): string {
  return /(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter)?.[1] ?? parameter;
}

function wrap(value: number, bits?: 1 | 8 | 16 | 32): number {
  if (bits === 1) return value ? 1 : 0;
  if (bits === 8) return value & 0xff;
  if (bits === 16) return value & 0xffff;
  if (bits === 32) return value >>> 0;
  return value;
}
