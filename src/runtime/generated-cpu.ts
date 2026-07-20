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
  readSignal?(signal: string, index?: number): number;
  writeSignal?(signal: string, value: number, index?: number): void;
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
  layout?: 'm6809q';
  fields?: Record<string, 1 | 8 | 16 | 32>;
  table?: number[];
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
  dispatch?: GeneratedHandlerProgram;
  opcodeTransform?: GeneratedHandlerProgram;
  dynamicAliases?: Record<string, {
    selector: string;
    mask?: number;
    paths: Record<string, string>;
    part: 'scalar' | 'word' | 'high' | 'low';
    bits: 8 | 16 | 32;
  }>;
  opcodes: CpuOpcode[];
  summary: {
    diagnostics: number;
  };
}

export interface GeneratedCpuExecutable {
  type: string;
  summary: {
    diagnostics: number;
    [name: string]: number;
  };
  create(bus: CpuBus): Cpu;
}

export interface Cpu {
  reset(): void;
  step(): number;
  run(cycles: number): number;
  setIrqLine(active: boolean, dataBus?: number | (() => number)): void;
  nmi(): void;
  get(name: string): number;
  set(name: string, value: number): void;
  invoke(name: string, ...args: number[]): number;
}

type GeneratedCpuRegistration = GeneratedCpuDefinition | GeneratedCpuExecutable;

const DEFINITIONS = new Map<string, GeneratedCpuRegistration>();

export function registerGeneratedCpu(definition: GeneratedCpuRegistration): void {
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
  if ('create' in definition) return definition.create(bus);
  return new IrCpu(definition, bus);
}

class IrCpu implements Cpu {
  private readonly definition: GeneratedCpuDefinition;
  private readonly bus: CpuBus;
  private readonly members: Record<string, unknown> = {};
  private readonly memberBits = new Map<string, 1 | 8 | 16 | 32>();
  private readonly opcodes: Map<string, CpuOpcode>;
  private readonly methods: Map<string, CpuMethod[]>;
  private readonly bindings: GeneratedHandlerBindings;
  private irqData: number | (() => number) = 0xff;

  constructor(definition: GeneratedCpuDefinition, bus: CpuBus) {
    this.definition = definition;
    this.bus = bus;
    this.opcodes = new Map(definition.opcodes.map(opcode => [opcode.key, opcode]));
    this.methods = new Map();
    for (const method of definition.methods) {
      const overloads = this.methods.get(method.name) ?? [];
      overloads.push(method);
      this.methods.set(method.name, overloads);
    }
    for (const member of definition.members) {
      if (member.table) {
        this.members[member.name] = Uint8Array.from(member.table);
      } else if (member.fields) {
        this.members[member.name] = typedObject(member.fields);
      } else if (member.layout === 'm6809q') {
        this.members[member.name] = new M6809Q(member.initial ?? 0);
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
    for (const [name, alias] of Object.entries(definition.dynamicAliases ?? {})) {
      getters[name] = () => this.readDynamicAlias(alias);
      setters[name] = value => this.writeDynamicAlias(alias, value);
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
    for (const [name, overloads] of this.methods) {
      const parameters = splitParameters(overloads[0]!.parameters);
      callParameters[name] = parameters;
      referenceCalls[name] = (...args) => {
        const method = overloads.find(candidate =>
          splitParameters(candidate.parameters).length === args.length) ?? overloads[0]!;
        return this.executeMethod(method, splitParameters(method.parameters), args);
      };
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
    if (this.definition.dispatch) {
      this.execute(this.definition.dispatch);
      return this.get('cycles');
    }
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

  setIrqLine(active: boolean, dataBus: number | (() => number) = 0xff): void {
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
    const dynamic = this.definition.dynamicAliases?.[name];
    const value = alias
      ? this.readAlias(alias)
      : dynamic
        ? this.readDynamicAlias(dynamic)
        : this.readPath(name);
    return Number(value) || 0;
  }

  set(name: string, value: number): void {
    const alias = this.definition.aliases[name];
    if (alias) this.writeAlias(alias, value);
    else {
      const dynamic = this.definition.dynamicAliases?.[name];
      if (dynamic) this.writeDynamicAlias(dynamic, value);
      else this.writePath(name, value, this.memberBits.get(name));
    }
  }

  invoke(name: string, ...args: number[]): number {
    const methods = this.methods.get(name);
    if (!methods?.length) throw new Error(`${this.definition.type} has no generated method "${name}"`);
    const method = methods.find(candidate =>
      splitParameters(candidate.parameters).length === args.length) ?? methods[0]!;
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
    const memoryRead = (address: number, opcode = false): number => {
      this.addCycles(1);
      const value = this.bus.read(address & 0xffff) & 0xff;
      if (!opcode || !this.definition.opcodeTransform) return value;
      const result = this.execute(this.definition.opcodeTransform, {
        adr: address & 0xffff,
        value,
        val: value,
      });
      return Number(result) & 0xff;
    };
    const readOpcode = (...args: number[]): number => {
      const address = args.length ? args[0]! : this.get('m_pc');
      if (!args.length) this.set('m_pc', address + 1);
      return memoryRead(address, true);
    };
    const readOpcodeArg = (...args: number[]): number => {
      const address = args.length ? args[0]! : this.get('m_pc');
      if (!args.length) this.set('m_pc', address + 1);
      return memoryRead(address);
    };
    const pairCalls = Object.fromEntries(
      ['m_PC', 'm_SP', 'm_AF', 'm_BC', 'm_DE', 'm_HL', 'm_WZ'].flatMap(name => [
        [`${name}_POSTINC`, () => {
          const value = this.get(name);
          this.set(name, value + 1);
          return value;
        }],
        [`${name}_POSTDEC`, () => {
          const value = this.get(name);
          this.set(name, value - 1);
          return value;
        }],
      ]),
    );
    return {
      ...pairCalls,
      'm_data.read_interruptible': address => this.bus.read(address & 0xffff) & 0xff,
      'm_data.write_interruptible': (address, value) => {
        this.bus.write(address & 0xffff, value & 0xff);
      },
      'm_opcodes.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_args.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_cprogram.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_copcodes.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_program.read_byte': address => this.bus.read(address & 0xffff) & 0xff,
      'm_program.write_byte': (address, value) => {
        this.bus.write(address & 0xffff, value & 0xff);
      },
      'm_io.read_byte': port => this.bus.in(port & 0xff) & 0xff,
      'm_io.write_byte': (port, value) => {
        this.bus.out(port & 0xff, value & 0xff);
      },
      'm_io.read_interruptible': port => this.bus.in(port & 0xffff) & 0xff,
      'm_io.write_interruptible': (port, value) => {
        this.bus.out(port & 0xffff, value & 0xff);
      },
      program_r: address => this.bus.read(address & 0xffff) & 0xff,
      ram_r: address => {
        const ram = this.members.m_ram as Record<string, unknown> | undefined;
        return Number(ram?.[String(address & 0xff)]) || 0;
      },
      ram_w: (address, value) => {
        const ram = this.members.m_ram as Record<string, unknown> | undefined;
        if (ram) ram[String(address & 0xff)] = value & 0xff;
      },
      ext_r: address => this.bus.in(address & 0xff) & 0xff,
      ext_w: (address, value) => this.bus.out(address & 0xff, value & 0xff),
      port_r: port => this.bus.readSignal?.('port', port) ?? 0xff,
      port_w: (port, value) => this.bus.writeSignal?.('port', value & 0xff, port),
      test_r: pin => this.bus.readSignal?.('test', pin) ?? 0,
      bus_r: () => this.bus.readSignal?.('bus') ?? 0xff,
      bus_w: value => this.bus.writeSignal?.('bus', value & 0xff),
      prog_w: value => this.bus.writeSignal?.('prog', value ? 1 : 0),
      BURN: count => {
        this.addCycles(count);
      },
      PAIR_LOW: (pair, value) => (pair & 0xff00) | (value & 0xff),
      PAIR_HIGH: (pair, value) => (pair & 0x00ff) | ((value & 0xff) << 8),
      popcount: value => {
        let bits = value >>> 0;
        let count = 0;
        while (bits) {
          count += bits & 1;
          bits >>>= 1;
        }
        return count;
      },
      read_memory: address => memoryRead(address),
      write_memory: (address, value) => {
        this.addCycles(1);
        this.bus.write(address & 0xffff, value & 0xff);
      },
      read_opcode: readOpcode,
      read_opcode_arg: readOpcodeArg,
      dummy_read_opcode_arg: () => {
        this.addCycles(1);
      },
      dummy_vma: count => {
        this.addCycles(count);
      },
      eat: count => {
        this.addCycles(count);
      },
      POSTINC_REG16: () => {
        const alias = this.definition.dynamicAliases!.REG16!;
        const value = Number(this.readDynamicAlias(alias)) || 0;
        this.writeDynamicAlias(alias, value + 1);
        return value;
      },
      PREDEC_REG16: () => {
        const alias = this.definition.dynamicAliases!.REG16!;
        const value = ((Number(this.readDynamicAlias(alias)) || 0) - 1) & 0xffff;
        this.writeDynamicAlias(alias, value);
        return value;
      },
      POSTINC_PC: () => {
        const value = this.get('m_pc');
        this.set('m_pc', value + 1);
        return value;
      },
      'm_lic_func': () => 0,
      'm_syncack_write_func': () => 0,
      'm_vector_read_func.isunset': () => 1,
      'm_in_inta_func.isunset': () => 1,
      'm_out_status_func.isunset': () => 1,
      m_in_inta_func: () => this.irqData,
      m_in_sid_func: () => 0,
      m_out_status_func: () => 0,
      m_out_inte_func: () => 0,
      m_out_sod_func: () => 0,
      fatalerror: () => 0,
      assert: () => 0,
      standard_irq_callback: () =>
        typeof this.irqData === 'function' ? this.irqData() : this.irqData,
      daisy_get_irq_device: () => 0,
      daisy_chain_present: () => 0,
      daisy_update_irq_state: () => 0,
      access_to_be_redone: () => 0,
      debugger_enabled: () => 0,
      debugger_instruction_hook: () => 0,
      debugger_wait_hook: () => 0,
      'm_t0_clk_func.isnull': () => 1,
      m_t0_clk_func: () => 0,
      clock: () => 0,
      total_cycles: () => 1,
      LOGMASKED: () => 0,
      LOG: () => 0,
      logerror: () => 0,
      tag: () => 0,
    };
  }

  private addCycles(count: number): void {
    this.set('cycles', this.get('cycles') + count);
    this.set('m_icount', this.get('m_icount') - count);
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

  private readDynamicAlias(
    alias: NonNullable<GeneratedCpuDefinition['dynamicAliases']>[string],
  ): unknown {
    const selector = this.get(alias.selector) & (alias.mask ?? 0xffffffff);
    const path = alias.paths[String(selector)] ?? alias.paths.default;
    return path ? readPart(this.readPath(path), alias.part) : 0;
  }

  private writeDynamicAlias(
    alias: NonNullable<GeneratedCpuDefinition['dynamicAliases']>[string],
    value: number,
  ): void {
    const selector = this.get(alias.selector) & (alias.mask ?? 0xffffffff);
    const path = alias.paths[String(selector)] ?? alias.paths.default;
    if (!path) return;
    if (alias.part === 'scalar') {
      this.writePath(path, value, alias.bits);
      return;
    }
    const current = this.readPath(path);
    if (current && typeof current === 'object' && 'w' in current) {
      const pair = current as { w: number; b?: { h: number; l: number } };
      if (alias.part === 'word') pair.w = value;
      else if (pair.b) pair.b[alias.part === 'high' ? 'h' : 'l'] = value;
    }
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
      if (current && typeof current === 'object' && 'w' in current) {
        (current as { w: number }).w = value;
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

class M6809Q {
  private value = 0;
  readonly r: {
    a: number;
    b: number;
    e: number;
    f: number;
    d: number;
    w: number;
  };
  readonly p: { d: PairView16; w: PairView16 };

  constructor(value: number) {
    this.value = value >>> 0;
    const byte = (shift: number) => ({
      enumerable: true,
      get: () => (this.value >>> shift) & 0xff,
      set: (next: number) => {
        this.value = ((this.value & ~(0xff << shift)) | ((next & 0xff) << shift)) >>> 0;
      },
    });
    this.r = Object.defineProperties({}, {
      a: byte(24),
      b: byte(16),
      e: byte(8),
      f: byte(0),
      d: {
        enumerable: true,
        get: () => (this.value >>> 16) & 0xffff,
        set: (next: number) => {
          this.value = ((this.value & 0xffff) | ((next & 0xffff) << 16)) >>> 0;
        },
      },
      w: {
        enumerable: true,
        get: () => this.value & 0xffff,
        set: (next: number) => {
          this.value = ((this.value & 0xffff0000) | (next & 0xffff)) >>> 0;
        },
      },
    }) as M6809Q['r'];
    this.p = {
      d: new PairView16(() => this.r.d, value => { this.r.d = value; }),
      w: new PairView16(() => this.r.w, value => { this.r.w = value; }),
    };
  }

  get q(): number {
    return this.value;
  }

  set q(value: number) {
    this.value = value >>> 0;
  }

  valueOf(): number {
    return this.value;
  }
}

class PairView16 {
  readonly b: { h: number; l: number };
  private readonly getValue: () => number;
  private readonly setValue: (value: number) => void;

  constructor(
    getValue: () => number,
    setValue: (value: number) => void,
  ) {
    this.getValue = getValue;
    this.setValue = setValue;
    this.b = Object.defineProperties({}, {
      h: {
        enumerable: true,
        get: () => (this.w >>> 8) & 0xff,
        set: (next: number) => { this.w = (this.w & 0xff) | ((next & 0xff) << 8); },
      },
      l: {
        enumerable: true,
        get: () => this.w & 0xff,
        set: (next: number) => { this.w = (this.w & 0xff00) | (next & 0xff); },
      },
    }) as { h: number; l: number };
  }

  get w(): number {
    return this.getValue() & 0xffff;
  }

  set w(value: number) {
    this.setValue(value & 0xffff);
  }

  valueOf(): number {
    return this.w;
  }
}

function readPart(
  value: unknown,
  part: 'scalar' | 'word' | 'high' | 'low',
): unknown {
  if (part === 'scalar') return value;
  const pair = value as { w?: number; b?: { h?: number; l?: number } };
  if (part === 'word') return pair?.w ?? Number(value) ?? 0;
  return pair?.b?.[part === 'high' ? 'h' : 'l'] ?? 0;
}
