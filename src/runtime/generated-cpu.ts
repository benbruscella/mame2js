import {
  executeGeneratedProgram,
  type GeneratedCallArgument,
  type GeneratedHandlerBindings,
  type GeneratedLValue,
} from './generated-handler.ts';
import type { GeneratedHandlerProgram } from './generated-machine.ts';

export interface CpuBus {
  read(address: number): number;
  write(address: number, data: number): void;
  in(port: number): number;
  out(port: number, data: number): void;
}

interface CpuAlias {
  member: string;
  part: 'scalar' | 'word' | 'high' | 'low';
  bits: 1 | 8 | 16 | 32;
}

interface CpuMember {
  name: string;
  bits?: 1 | 8 | 16 | 32;
  pair?: boolean;
  fields?: Record<string, 1 | 8 | 16 | 32>;
  initial?: number;
}

interface CpuMethod {
  name: string;
  parameters: string;
  program: GeneratedHandlerProgram;
}

interface CpuOpcode {
  key: string;
  dispatch: boolean;
  program: GeneratedHandlerProgram;
}

export interface GeneratedCpuDefinition {
  type: string;
  constants: Record<string, number>;
  aliases: Record<string, CpuAlias>;
  members: CpuMember[];
  methods: CpuMethod[];
  start: GeneratedHandlerProgram;
  reset: GeneratedHandlerProgram;
  input: GeneratedHandlerProgram;
  service: GeneratedHandlerProgram;
  fetch: GeneratedHandlerProgram;
  opcodes: CpuOpcode[];
  summary: {
    diagnostics: number;
  };
}

export interface Cpu {
  reset(): void;
  step(): number;
  run(cycles: number): number;
  setIrqLine(active: boolean, dataBus?: number): void;
  nmi(): void;
  get(name: string): number;
  set(name: string, value: number): void;
  invoke(name: string, ...args: number[]): number;
}

const DEFINITIONS = new Map<string, GeneratedCpuDefinition>();

export function registerGeneratedCpu(definition: GeneratedCpuDefinition): void {
  if (definition.summary.diagnostics) {
    throw new Error(
      `cannot register ${definition.type}: ${definition.summary.diagnostics} compiler diagnostics`,
    );
  }
  DEFINITIONS.set(definition.type.toUpperCase(), definition);
}

export function clearGeneratedCpus(): void {
  DEFINITIONS.clear();
}

export function hasGeneratedCpu(type: string): boolean {
  return DEFINITIONS.has(type.toUpperCase());
}

export function createCpu(type: string, bus: CpuBus): Cpu {
  const definition = DEFINITIONS.get(type.toUpperCase());
  if (!definition) throw new Error(`generated CPU "${type}" was not registered`);
  return new IrCpu(definition, bus);
}

class IrCpu implements Cpu {
  private readonly definition: GeneratedCpuDefinition;
  private readonly bus: CpuBus;
  private readonly members: Record<string, unknown> = {};
  private readonly memberBits = new Map<string, 1 | 8 | 16 | 32>();
  private readonly opcodes: Map<string, CpuOpcode>;
  private readonly methods: Map<string, CpuMethod>;
  private readonly bindings: GeneratedHandlerBindings;
  private irqData = 0xff;

  constructor(definition: GeneratedCpuDefinition, bus: CpuBus) {
    this.definition = definition;
    this.bus = bus;
    this.opcodes = new Map(definition.opcodes.map(opcode => [opcode.key, opcode]));
    this.methods = new Map(definition.methods.map(method => [method.name, method]));
    for (const member of definition.members) {
      if (member.fields) {
        this.members[member.name] = typedObject(member.fields);
      } else if (member.pair) {
        this.members[member.name] = new Pair16(member.initial ?? 0);
      } else {
        this.members[member.name] = member.initial ?? 0;
        if (member.bits) this.memberBits.set(member.name, member.bits);
      }
    }

    const getters: Record<string, () => unknown> = {};
    const setters: Record<string, (value: number) => void> = {};
    for (const member of definition.members) {
      getters[member.name] = () => this.readPath(member.name);
      setters[member.name] = value => this.writePath(member.name, value, member.bits);
    }
    for (const [name, alias] of Object.entries(definition.aliases)) {
      getters[name] = () => this.readAlias(alias);
      setters[name] = value => this.writeAlias(alias, value);
    }

    const referenceCalls: NonNullable<GeneratedHandlerBindings['referenceCalls']> = {};
    const callParameters: NonNullable<GeneratedHandlerBindings['callParameters']> = {};
    this.bindings = {
      members: this.members,
      getters,
      setters,
      constants: definition.constants,
      calls: this.externalCalls(),
      referenceCalls,
      callParameters,
    };
    for (const method of definition.methods) {
      const parameters = splitParameters(method.parameters);
      callParameters[method.name] = parameters;
      referenceCalls[method.name] = (...args) => this.executeMethod(method, parameters, args);
    }
    callParameters.swap = ['auto &left', 'auto &right'];
    referenceCalls.swap = (left, right) => {
      if (!isLValue(left) || !isLValue(right)) return 0;
      const value = Number(left.get()) || 0;
      const other = Number(right.get()) || 0;
      left.set(other);
      right.set(value);
      return 0;
    };

    this.execute(definition.start);
    this.reset();
  }

  reset(): void {
    this.execute(this.definition.reset);
  }

  step(): number {
    this.set('cycles', 0);
    this.set('m_icount', 1);
    this.execute(this.definition.service);
    if (this.get('cycles') > 0) return this.get('cycles');

    this.execute(this.definition.fetch);
    let dispatches = 0;
    while (true) {
      if (++dispatches > 8) throw new Error(`${this.definition.type} dispatch loop exceeded 8`);
      const opcode = this.opcodes.get(this.refKey());
      if (!opcode) throw new Error(`${this.definition.type} has no opcode ${this.refKey()}`);
      this.execute(opcode.program);
      if (!opcode.dispatch) break;
    }
    return this.get('cycles');
  }

  run(target: number): number {
    let total = 0;
    while (total < target) total += this.step();
    return total;
  }

  setIrqLine(active: boolean, dataBus = 0xff): void {
    if (active) this.irqData = dataBus;
    this.execute(this.definition.input, {
      inputnum: this.constant('INPUT_LINE_IRQ0', 0),
      state: active ? this.constant('ASSERT_LINE', 1) : this.constant('CLEAR_LINE', 0),
    });
  }

  nmi(): void {
    const inputnum = this.constant('INPUT_LINE_NMI', -1);
    this.execute(this.definition.input, { inputnum, state: this.constant('ASSERT_LINE', 1) });
    this.execute(this.definition.input, { inputnum, state: this.constant('CLEAR_LINE', 0) });
  }

  get(name: string): number {
    const alias = this.definition.aliases[name];
    const value = alias ? this.readAlias(alias) : this.readPath(name);
    return Number(value) || 0;
  }

  set(name: string, value: number): void {
    const alias = this.definition.aliases[name];
    if (alias) this.writeAlias(alias, value);
    else this.writePath(name, value, this.memberBits.get(name));
  }

  invoke(name: string, ...args: number[]): number {
    const method = this.methods.get(name);
    if (!method) throw new Error(`${this.definition.type} has no generated method "${name}"`);
    const parameters = splitParameters(method.parameters);
    return Number(this.executeMethod(method, parameters, args)) || 0;
  }

  private execute(program: GeneratedHandlerProgram, args: Record<string, unknown> = {}): unknown {
    return executeGeneratedProgram(program, this.bindings, args).value;
  }

  private executeMethod(
    method: CpuMethod,
    parameters: string[],
    args: GeneratedCallArgument[],
  ): unknown {
    const names = parameters.map(parameterName);
    return this.execute(
      method.program,
      Object.fromEntries(names.map((name, index) => [name, args[index] ?? 0])),
    );
  }

  private externalCalls(): NonNullable<GeneratedHandlerBindings['calls']> {
    return {
      'm_data.read_interruptible': address => this.bus.read(address & 0xffff) & 0xff,
      'm_data.write_interruptible': (address, value) => {
        this.bus.write(address & 0xffff, value & 0xff);
      },
      'm_opcodes.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_args.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_io.read_interruptible': port => this.bus.in(port & 0xffff) & 0xff,
      'm_io.write_interruptible': (port, value) => {
        this.bus.out(port & 0xffff, value & 0xff);
      },
      standard_irq_callback: () => this.irqData,
      daisy_get_irq_device: () => 0,
      daisy_chain_present: () => 0,
      daisy_update_irq_state: () => 0,
      access_to_be_redone: () => 0,
      debugger_enabled: () => 0,
      debugger_instruction_hook: () => 0,
      debugger_wait_hook: () => 0,
      total_cycles: () => 1,
      LOGMASKED: () => 0,
      logerror: () => 0,
      tag: () => 0,
    };
  }

  private refKey(): string {
    const ref = this.get('m_ref') >>> 0;
    return `${hex((ref >>> 16) & 0xff)}${hex((ref >>> 8) & 0xff)}`;
  }

  private constant(name: string, fallback: number): number {
    return this.definition.constants[name] ?? fallback;
  }

  private readAlias(alias: CpuAlias): unknown {
    const value = Number(this.readPath(alias.member)) || 0;
    if (alias.part === 'high') return (value >>> 8) & 0xff;
    if (alias.part === 'low') return value & 0xff;
    return value;
  }

  private writeAlias(alias: CpuAlias, value: number): void {
    if (alias.part === 'high' || alias.part === 'low') {
      const pair = Number(this.readPath(alias.member)) || 0;
      const next = alias.part === 'high'
        ? ((pair & 0x00ff) | ((value & 0xff) << 8))
        : ((pair & 0xff00) | (value & 0xff));
      this.writePath(alias.member, next, 16);
      return;
    }
    this.writePath(alias.member, value, alias.bits);
  }

  private readPath(path: string): unknown {
    const parts = path.split('.');
    let value: unknown = this.members[parts.shift()!];
    for (const part of parts) {
      if (!value || typeof value !== 'object') return 0;
      value = (value as Record<string, unknown>)[part];
    }
    return value ?? 0;
  }

  private writePath(path: string, value: number, bits?: 1 | 8 | 16 | 32): void {
    const parts = path.split('.');
    const wrapped = wrap(value, bits);
    if (parts.length === 1) {
      const current = this.members[path];
      if (current instanceof Pair16) {
        current.w = value;
        return;
      }
      this.members[path] = wrapped;
      return;
    }
    const property = parts.pop()!;
    let object = this.members[parts.shift()!];
    for (const part of parts) {
      if (!object || typeof object !== 'object') return;
      object = (object as Record<string, unknown>)[part];
    }
    if (object && typeof object === 'object') {
      (object as Record<string, unknown>)[property] = wrapped;
    }
  }
}

function splitParameters(parameters: string): string[] {
  return parameters.split(',').map(parameter => parameter.trim()).filter(Boolean);
}

function parameterName(parameter: string): string {
  return /(\w+)\s*$/.exec(parameter.replace(/\.\.\./g, '').trim())?.[1] ?? parameter;
}

function isLValue(value: GeneratedCallArgument): value is GeneratedLValue {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'get' in value &&
    'set' in value,
  );
}

function wrap(value: number, bits?: 1 | 8 | 16 | 32): number {
  if (bits === 1) return value ? 1 : 0;
  if (bits === 8) return value & 0xff;
  if (bits === 16) return value & 0xffff;
  if (bits === 32) return value >>> 0;
  return value;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function typedObject(fields: Record<string, 1 | 8 | 16 | 32>): Record<string, unknown> {
  const values: Record<string, number> = {};
  const object: Record<string, unknown> = {};
  for (const [name, bits] of Object.entries(fields)) {
    values[name] = 0;
    Object.defineProperty(object, name, {
      enumerable: true,
      get: () => values[name],
      set: (value: number) => {
        values[name] = wrap(value, bits);
      },
    });
  }
  return object;
}

class Pair16 {
  private value = 0;
  readonly b: { h: number; l: number };

  constructor(value: number) {
    this.value = value & 0xffff;
    const pair = this;
    this.b = Object.defineProperties({}, {
      h: {
        enumerable: true,
        get: () => (pair.value >>> 8) & 0xff,
        set: (next: number) => {
          pair.value = ((pair.value & 0x00ff) | ((next & 0xff) << 8)) & 0xffff;
        },
      },
      l: {
        enumerable: true,
        get: () => pair.value & 0xff,
        set: (next: number) => {
          pair.value = ((pair.value & 0xff00) | (next & 0xff)) & 0xffff;
        },
      },
    }) as { h: number; l: number };
  }

  get w(): number {
    return this.value;
  }

  set w(value: number) {
    this.value = value & 0xffff;
  }

  valueOf(): number {
    return this.value;
  }
}
