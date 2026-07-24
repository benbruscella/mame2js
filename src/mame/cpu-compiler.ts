import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  GeneratedHandlerProgram,
  GeneratedSourceRef,
} from '../runtime/generated-machine.ts';
import { parseMameAst, parseMameSource, splitMameArgs } from './ast.ts';
import { compileMameHandler } from './handler-ir.ts';
import {
  parseZ80OpcodeDsl,
  type OpcodeDslOperation,
  type Z80OpcodeDsl,
} from './opcode-dsl.ts';

export interface GeneratedCpuAlias {
  member: string;
  part: 'scalar' | 'word' | 'high' | 'low';
  bits: 1 | 8 | 16 | 32;
}

export interface GeneratedCpuMember {
  name: string;
  bits?: 1 | 8 | 16 | 32;
  pair?: boolean;
  values?: number[];
  fields?: Record<string, 1 | 8 | 16 | 32>;
  initial?: number;
}

export interface GeneratedCpuMethod {
  name: string;
  parameters: string;
  program: GeneratedHandlerProgram;
  source: GeneratedSourceRef;
}

export interface GeneratedCpuOpcode {
  key: string;
  description?: string;
  dispatch: boolean;
  program: GeneratedHandlerProgram;
  source: GeneratedSourceRef;
}

export interface GeneratedCpuDefinition {
  schemaVersion: 1;
  type: string;
  dialect: string;
  sourceFiles: string[];
  constants: Record<string, number>;
  aliases: Record<string, GeneratedCpuAlias>;
  members: GeneratedCpuMember[];
  methods: GeneratedCpuMethod[];
  start: GeneratedHandlerProgram;
  reset: GeneratedHandlerProgram;
  input: GeneratedHandlerProgram;
  /** Source-derived execution of exactly one instruction or interrupt. */
  step?: GeneratedHandlerProgram;
  service: GeneratedHandlerProgram;
  fetch: GeneratedHandlerProgram;
  opcodes: GeneratedCpuOpcode[];
  internal?: {
    ram: { start: number; end: number }[];
    ports: {
      dataAddress: number;
      directionAddress: number;
      inputSignal: string;
      outputSignal: string;
      outputMask: number;
    }[];
  };
  summary: {
    opcodes: number;
    compiledOpcodes: number;
    methods: number;
    compiledMethods: number;
    diagnostics: number;
  };
}

/**
 * Compile the generic Z80 variant using MAME's own operation DSL, helper
 * methods, register aliases and reset/input logic. The output contains no
 * handwritten opcode or flag implementation.
 */
export function compileMameZ80(mameSrc: string): GeneratedCpuDefinition {
  const cppFile = 'src/devices/cpu/z80/z80.cpp';
  const headerFile = 'src/devices/cpu/z80/z80.h';
  const aliasesFile = 'src/devices/cpu/z80/z80.inc';
  const dslFile = 'src/devices/cpu/z80/z80.lst';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const aliasesSource = readFileSync(join(mameSrc, aliasesFile), 'utf8');
  const dsl = parseZ80OpcodeDsl(dslFile, readFileSync(join(mameSrc, dslFile), 'utf8'));
  const unit = parseMameSource(cppFile, cpp);
  const methods = unit.functions
    .filter(fn => fn.className === 'z80_device')
    .filter(fn => ![
      'device_validity_check',
      'device_start',
      'device_reset',
      'execute_run',
      'execute_set_input',
      'state_import',
      'state_export',
      'state_string_export',
      'create_disassembler',
      'memory_space_config',
    ].includes(fn.name))
    .map(fn => ({
      name: fn.name,
      parameters: fn.parameters,
      program: compileMameHandler(normalizeMameExecutionSource(fn.body)),
      source: sourceRef(fn.span.file, fn.span.line),
    }));

  const object = extractObject(header, 'm_f');
  const objectFields = object ? declaredFields(object.body) : {};
  for (const method of object?.methods ?? []) {
    methods.push({
      name: `m_f.${method.name}`,
      parameters: method.parameters,
      program: compileMameHandler(qualifyObjectFields(
        normalizeMameExecutionSource(method.body),
        'm_f',
        Object.keys(objectFields),
      )),
      source: sourceRef(headerFile, lineAt(header, method.start)),
    });
  }
  for (const method of extractInlineMethods(header, object && [object.start, object.end])) {
    const program = compileMameHandler(normalizeMameExecutionSource(method.body));
    if (program.diagnostics.length) continue;
    methods.push({
      name: method.name,
      parameters: method.parameters,
      program,
      source: sourceRef(headerFile, lineAt(header, method.start)),
    });
  }

  const startMethod = unit.functions.find(fn =>
    fn.className === 'z80_device' && fn.name === 'device_start');
  const resetMethod = unit.functions.find(fn =>
    fn.className === 'z80_device' && fn.name === 'device_reset');
  const inputMethod = unit.functions.find(fn =>
    fn.className === 'z80_device' && fn.name === 'execute_set_input');
  const serviceOpcode = dsl.opcodes.find(opcode => opcode.key === 'ffff');
  if (!startMethod || !resetMethod || !inputMethod || !serviceOpcode) {
    throw new Error('MAME Z80 source is missing start/reset/input/service definitions');
  }

  const fetchAt = serviceOpcode.operations.findIndex(operation =>
    operation.text.trim() === 'PRVPC = PC;');
  if (fetchAt < 0) throw new Error('MAME Z80 service DSL has no instruction fetch boundary');
  const service = compileOpcodeOperations(serviceOpcode.operations.slice(0, fetchAt), {
    continueAsReturn: true,
  });
  const fetch = compileOpcodeOperations(serviceOpcode.operations.slice(fetchAt));
  const opcodes = dsl.opcodes
    .filter(opcode => opcode.key !== 'ffff')
    .map(opcode => ({
      key: opcode.key,
      ...(opcode.description ? { description: opcode.description } : {}),
      dispatch: opcode.operations.some(operation => operation.text.trim() === 'goto process;'),
      program: compileOpcodeOperations(opcode.operations),
      source: sourceRef(opcode.source.file, opcode.source.line),
    }));
  const start = compileMameHandler(normalizeMameExecutionSource(
    stripMameFrameworkSetup(startMethod.body),
  ));
  const reset = compileMameHandler(normalizeMameExecutionSource(resetMethod.body));
  const input = compileMameHandler(normalizeMameExecutionSource(inputMethod.body));
  const constants = {
    ...extractDefineConstants(aliasesSource),
    ...extractEnumConstants(header, {
      INPUT_LINE_IRQ0: 0,
      INPUT_LINE_NMI: -1,
    }),
    ...extractConstexprConstants(header),
  };
  const aliases = extractAliases(aliasesSource, header);
  const initializers = extractConstructorInitializers(cpp, 'z80_device');
  const members = extractMembers(header, objectFields).map(member => ({
    ...member,
    ...(initializers[member.name] !== undefined
      ? { initial: initializers[member.name] }
      : {}),
  }));
  const programs = [
    start,
    reset,
    input,
    service,
    fetch,
    ...methods.map(method => method.program),
    ...opcodes.map(opcode => opcode.program),
  ];
  return {
    schemaVersion: 1,
    type: 'Z80',
    dialect: dsl.dialect,
    sourceFiles: [cppFile, headerFile, aliasesFile, dslFile],
    constants,
    aliases,
    members,
    methods,
    start,
    reset,
    input,
    service,
    fetch,
    opcodes,
    summary: {
      opcodes: opcodes.length,
      compiledOpcodes: opcodes.filter(opcode => opcode.program.diagnostics.length === 0).length,
      methods: methods.length,
      compiledMethods: methods.filter(method => method.program.diagnostics.length === 0).length,
      diagnostics: programs.reduce((count, program) => count + program.diagnostics.length, 0),
    },
  };
}

/**
 * Compile MAME's shared 8080/8085 implementation with the i8080 subclass
 * overrides selected. Unlike the Z80 core, this CPU has no opcode DSL: MAME's
 * executable source is a single 256-case `execute_one` switch.
 */
export function compileMameI8080(mameSrc: string): GeneratedCpuDefinition {
  const cppFile = 'src/devices/cpu/i8085/i8085.cpp';
  const headerFile = 'src/devices/cpu/i8085/i8085.h';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const unit = parseMameSource(cppFile, cpp);
  const sourceMethods = unit.functions.filter(fn => fn.className === 'i8085a_cpu_device');
  const find = (name: string) => sourceMethods.find(fn => fn.name === name);
  const startMethod = find('device_start');
  const resetMethod = find('device_reset');
  const inputMethod = find('execute_set_input');
  const runMethod = find('execute_run');
  if (!startMethod || !resetMethod || !inputMethod || !runMethod || !find('execute_one')) {
    throw new Error('MAME I8080 source is missing start/reset/input/execute definitions');
  }

  const normalize = (source: string): string => normalizeI8080Source(
    normalizeMameExecutionSource(source),
  );
  const excluded = new Set([
    'memory_space_config',
    'device_config_complete',
    'device_clock_changed',
    'device_start',
    'device_reset',
    'state_import',
    'state_export',
    'state_string_export',
    'create_disassembler',
    'execute_run',
  ]);
  const methods = sourceMethods
    .filter(fn => !excluded.has(fn.name))
    .map(fn => ({
      name: fn.name,
      parameters: fn.parameters,
      program: compileMameHandler(normalize(fn.body)),
      source: sourceRef(fn.span.file, fn.span.line),
    }));
  for (const name of ['ret_taken', 'jmp_taken', 'call_taken', 'is_8085']) {
    const inline = inlineMethodForClass(header, name, name === 'ret_taken'
      ? 'i8085a_cpu_device'
      : 'i8080_cpu_device');
    if (!inline) throw new Error(`MAME I8080 source is missing ${name} override`);
    methods.push({
      name,
      parameters: inline.parameters,
      program: compileMameHandler(normalize(inline.body)),
      source: sourceRef(headerFile, lineAt(header, inline.start)),
    });
  }

  const startSource = startMethod.body.slice(
    0,
    startMethod.body.indexOf('init_tables();') + 'init_tables();'.length,
  );
  const start = compileMameHandler(normalize(startSource));
  const reset = compileMameHandler(normalize(resetMethod.body));
  const input = compileMameHandler(
    normalize(inputMethod.body).replace(/\birqline\b/g, 'inputnum'),
  );
  const step = compileMameHandler(normalize(singleIterationSource(runMethod.body)));
  const constants = {
    ...extractDefineConstants(header),
    ...extractGlobalConstants(cpp),
    ...extractEnumConstants(header, {
      INPUT_LINE_IRQ0: 0,
      INPUT_LINE_NMI: -1,
    }),
    I8085_INTR_LINE: 0,
    I8085_RST55_LINE: 1,
    I8085_RST65_LINE: 2,
    I8085_RST75_LINE: 3,
    I8085_TRAP_LINE: -1,
    CLEAR_LINE: 0,
    ASSERT_LINE: 1,
  };
  const members: GeneratedCpuMember[] = [
    ...['m_PC', 'm_SP', 'm_AF', 'm_BC', 'm_DE', 'm_HL', 'm_WZ']
      .map(name => ({ name, bits: 16 as const, pair: true })),
    ...[
      'm_halt', 'm_im', 'm_status', 'm_after_ei', 'm_nmi_state',
      'm_trap_im_copy', 'm_sod_state', 'm_ietemp',
    ].map(name => ({ name, bits: 8 as const })),
    { name: 'm_trap_pending', bits: 1 },
    { name: 'm_in_acknowledge', bits: 1 },
    // MAME's cycle budget is a signed int and intentionally becomes negative.
    { name: 'm_icount' },
    { name: 'm_irq_state', bits: 8, values: [0, 0, 0, 0] },
    { name: 'lut_cycles_8080', bits: 8, values: extractNumericArray(cpp, 'lut_cycles_8080') },
    { name: 'lut_cycles_8085', bits: 8, values: extractNumericArray(cpp, 'lut_cycles_8085') },
    { name: 'lut_cycles', bits: 8, values: Array(256).fill(0) },
    { name: 'lut_zs', bits: 8, values: Array(256).fill(0) },
    { name: 'lut_zsp', bits: 8, values: Array(256).fill(0) },
  ];
  const aliases = extractStateAliases(startMethod.body);
  const service = compileMameHandler('');
  const fetch = compileMameHandler('');
  const programs = [start, reset, input, step, ...methods.map(method => method.program)];
  return {
    schemaVersion: 1,
    type: 'I8080',
    dialect: 'mame-cpp-switch',
    sourceFiles: [cppFile, headerFile],
    constants,
    aliases,
    members,
    methods,
    start,
    reset,
    input,
    step,
    service,
    fetch,
    opcodes: [],
    summary: {
      opcodes: 256,
      compiledOpcodes: step.diagnostics.length ? 0 : 256,
      methods: methods.length,
      compiledMethods: methods.filter(method => !method.program.diagnostics.length).length,
      diagnostics: programs.reduce((count, program) => count + program.diagnostics.length, 0),
    },
  };
}

/**
 * Compile MAME's 6800-family opcode source with the M6803 dispatch and cycle
 * tables selected. MAME keeps the instruction semantics in 6800ops.hxx behind
 * C preprocessor macros; this pass expands those macros before lowering the
 * resulting ordinary C++ statements to handler IR.
 */
export function compileMameM6803(mameSrc: string): GeneratedCpuDefinition {
  const cppFile = 'src/devices/cpu/m6800/m6800.cpp';
  const headerFile = 'src/devices/cpu/m6800/m6800.h';
  const variantFile = 'src/devices/cpu/m6800/m6801.cpp';
  const variantHeaderFile = 'src/devices/cpu/m6800/m6801.h';
  const operationsFile = 'src/devices/cpu/m6800/6800ops.hxx';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const variant = readFileSync(join(mameSrc, variantFile), 'utf8');
  const operations = readFileSync(join(mameSrc, operationsFile), 'utf8');
  const macroSource = cpp.slice(0, cpp.indexOf('#include "6800ops.hxx"'));
  const macros = parseMameOperationMacros(macroSource);
  const normalize = (body: string): string => normalizeMameExecutionSource(
    normalizePairLocals(expandMameOperationMacros(body, macros), false)
      .replace(/\bWM16\(\s*([^,]+),\s*&\s*(m_\w+)\s*\)/g, 'WM16($1, $2.w)')
      .replace(/\benter_interrupt\(\s*"[^"]*"/g, 'enter_interrupt(0'),
  );

  const operationAst = parseMameAst([{
    file: operationsFile,
    source: operations.replace(
      /OP_HANDLER\s*\(\s*(\w+)\s*\)/g,
      'void m6800_cpu_device::$1()',
    ),
  }]);
  const opcodeMethods = operationAst.units[0]!.functions.map(fn => ({
    name: fn.name,
    parameters: fn.parameters,
    program: compileMameHandler(normalize(fn.body)),
    source: sourceRef(operationsFile, fn.span.line),
  }));

  const baseAst = parseMameAst([{ file: cppFile, source: cpp }]);
  const baseFunctions = baseAst.units[0]!.functions;
  const base = (name: string) => baseFunctions.find(fn =>
    fn.className === 'm6800_cpu_device' && fn.name === name);
  const required = [
    'RM16',
    'WM16',
    'enter_interrupt',
    'check_irq_lines',
    'check_irq1_enabled',
    'device_reset',
    'execute_set_input',
  ];
  const missing = required.filter(name => !base(name));
  if (missing.length) {
    throw new Error(`MAME M6803 source is missing ${missing.join(', ')}`);
  }
  const helperNames = [
    'RM16',
    'WM16',
    'enter_interrupt',
    'check_irq_lines',
    'check_irq1_enabled',
  ];
  const methods = [
    ...opcodeMethods,
    ...helperNames.map(name => {
      const fn = base(name)!;
      return {
        name,
        parameters: name === 'WM16' ? 'u32 Addr, u16 p' : fn.parameters,
        program: compileMameHandler(
          name === 'WM16'
            ? normalize(fn.body)
                .replace(/\bp\.b\.h\b/g, 'u8(p >> 8)')
                .replace(/\bp\.b\.l\b/g, 'u8(p)')
            : normalize(fn.body),
        ),
        source: sourceRef(cppFile, fn.span.line),
      };
    }),
    {
      name: 'increment_counter',
      parameters: 'int amount',
      program: compileMameHandler('cycles += amount;'),
      source: sourceRef(cppFile, base('enter_interrupt')!.span.line),
    },
    {
      name: 'check_irq2',
      parameters: '',
      program: compileMameHandler(''),
      source: sourceRef(headerFile, lineAt(header, header.indexOf('check_irq2()'))),
    },
    {
      name: 'execute_one',
      parameters: '',
      program: compileMameHandler(''),
      source: sourceRef(cppFile, base('check_irq_lines')!.span.line),
    },
    {
      name: 'eat_cycles',
      parameters: '',
      program: compileMameHandler('cycles += 1;'),
      source: sourceRef(cppFile, base('check_irq_lines')!.span.line),
    },
    {
      name: 'take_trap',
      parameters: '',
      program: compileMameHandler(''),
      source: sourceRef(headerFile, lineAt(header, header.indexOf('take_trap()'))),
    },
  ];

  const cycles = extractMameByteArray(variant, 'cycles_6803', { XX: 4 });
  const dispatch = extractM6803Dispatch(variant);
  const opcodes = dispatch.map((method, opcode) => ({
    key: `${opcode.toString(16).padStart(2, '0')}00`,
    dispatch: false,
    program: compileMameHandler(`${method}(); cycles += ${cycles[opcode]};`),
    source: sourceRef(variantFile, lineAt(variant, variant.indexOf('m6803_insn'))),
  }));
  const resetMethod = base('device_reset')!;
  const inputMethod = base('execute_set_input')!;
  const start = compileMameHandler('');
  const reset = compileMameHandler(normalize(resetMethod.body));
  const input = compileMameHandler(
    normalize(inputMethod.body).replace(/\birqline\b/g, 'inputnum'),
  );
  const service = compileMameHandler(`
    check_irq_lines();
    if (cycles > 0) return;
    if (m_wai_state & (M6800_WAI | M6800_SLP)) {
      cycles += 1;
      return;
    }
  `);
  const fetch = compileMameHandler(`
    m_ref = m_copcodes.read_byte(m_pc.w) << 16;
    m_pc.w++;
  `);
  const constants = {
    M6800_IRQ_LINE: 0,
    M6800_WAI: 8,
    M6800_SLP: 0x10,
    INPUT_LINE_IRQ0: 0,
    INPUT_LINE_NMI: -1,
    CLEAR_LINE: 0,
    ASSERT_LINE: 1,
  };
  const members: GeneratedCpuMember[] = [
    ...['m_ppc', 'm_pc', 'm_s', 'm_x', 'm_d', 'm_ea']
      .map(name => ({ name, bits: 16 as const, pair: true })),
    ...['m_cc', 'm_wai_state', 'm_nmi_state', 'm_nmi_pending']
      .map(name => ({ name, bits: 8 as const })),
    { name: 'm_irq_state', bits: 8, values: [0, 0, 0, 0, 0] },
    { name: 'flags8i', bits: 8, values: extractMameByteArray(cpp, 'flags8i') },
    { name: 'flags8d', bits: 8, values: extractMameByteArray(cpp, 'flags8d') },
    { name: 'm_ref', bits: 32 },
    { name: 'cycles' },
    { name: 'm_icount' },
  ];
  const internal = compileM6803InternalPlan(variant);
  const programs = [
    start,
    reset,
    input,
    service,
    fetch,
    ...methods.map(method => method.program),
    ...opcodes.map(opcode => opcode.program),
  ];
  return {
    schemaVersion: 1,
    type: 'M6803',
    dialect: 'mame-cpp-op-handler',
    sourceFiles: [cppFile, headerFile, variantFile, variantHeaderFile, operationsFile],
    constants,
    aliases: {},
    members,
    methods,
    start,
    reset,
    input,
    service,
    fetch,
    opcodes,
    internal,
    summary: {
      opcodes: opcodes.length,
      compiledOpcodes: opcodes.filter(opcode => !opcode.program.diagnostics.length).length,
      methods: methods.length,
      compiledMethods: methods.filter(method => !method.program.diagnostics.length).length,
      diagnostics: programs.reduce((count, program) => count + program.diagnostics.length, 0),
    },
  };
}

interface MameOperationMacro {
  parameters?: string[];
  body: string;
}

function parseMameOperationMacros(source: string): Map<string, MameOperationMacro> {
  const macros = new Map<string, MameOperationMacro>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*#define\s+(\w+)(?:\(([^)]*)\))?\s+(.+)$/.exec(line);
    if (!match) continue;
    macros.set(match[1]!, {
      ...(match[2] !== undefined
        ? { parameters: match[2].split(',').map(value => value.trim()) }
        : {}),
      body: match[3]!,
    });
  }
  return macros;
}

function expandMameOperationMacros(
  source: string,
  macros: Map<string, MameOperationMacro>,
): string {
  let expanded = source;
  const functions = [...macros].filter(([, macro]) => macro.parameters);
  const objects = [...macros].filter(([, macro]) => !macro.parameters);
  for (let pass = 0; pass < 32; pass++) {
    const before = expanded;
    for (const [name, macro] of functions) {
      const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
      let cursor = 0;
      while (cursor < expanded.length) {
        pattern.lastIndex = cursor;
        const match = pattern.exec(expanded);
        if (!match) break;
        const open = expanded.indexOf('(', match.index + name.length);
        const close = matchPair(expanded, open, '(', ')');
        if (close < 0) break;
        const args = splitMameArgs(expanded.slice(open + 1, close));
        let body = macro.body;
        const parameterIndexes = new Map(
          macro.parameters!
            .map((parameter, index) => [parameter, index] as const)
            .filter(([parameter]) => /^\w+$/.test(parameter)),
        );
        if (parameterIndexes.size) {
          body = body.replace(
            new RegExp(`\\b(?:${[...parameterIndexes.keys()].join('|')})\\b`, 'g'),
            parameter => args[parameterIndexes.get(parameter)!] ?? '',
          );
        }
        expanded = expanded.slice(0, match.index) + body + expanded.slice(close + 1);
        cursor = match.index + body.length;
      }
    }
    for (const [name, macro] of objects) {
      expanded = expanded.replace(new RegExp(`\\b${name}\\b`, 'g'), macro.body);
    }
    if (expanded === before) break;
  }
  return expanded;
}

function extractMameByteArray(
  source: string,
  name: string,
  symbols: Record<string, number> = {},
): number[] {
  const match = new RegExp(
    `${name}\\s*\\[[^\\]]+\\]\\s*=\\s*(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)?\\{([\\s\\S]*?)\\};`,
  ).exec(source);
  if (!match) throw new Error(`MAME M6803 source is missing ${name}`);
  const values = match[1]!
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => symbols[value] ?? Number(value));
  if (values.length !== 256 || values.some(value => !Number.isFinite(value))) {
    throw new Error(`${name} contains ${values.length} invalid entries`);
  }
  return values;
}

function extractM6803Dispatch(source: string): string[] {
  const match = /m6803_insn\s*\[[^\]]+\]\s*=\s*\{([\s\S]*?)\};/.exec(source);
  if (!match) throw new Error('MAME M6803 opcode dispatch table is missing');
  const methods = [...match[1]!.matchAll(/&m6801_cpu_device::(\w+)/g)]
    .map(entry => entry[1]!);
  if (methods.length !== 256) {
    throw new Error(`MAME M6803 dispatch contains ${methods.length}, expected 256`);
  }
  return methods;
}

function compileM6803InternalPlan(
  source: string,
): NonNullable<GeneratedCpuDefinition['internal']> {
  const address = (method: string): number => {
    const match = new RegExp(
      `map\\(\\s*(0x[\\da-f]+|\\d+)\\s*,[^;]+FUNC\\([^)]*::${method}\\)`,
      'i',
    ).exec(source);
    if (!match) throw new Error(`MAME M6803 internal map is missing ${method}`);
    return Number(match[1]);
  };
  const map = /void\s+m6801_cpu_device::m6803_mem[\s\S]*?\{([\s\S]*?)\}/.exec(source)?.[1] ?? '';
  const ram = /map\(\s*(0x[\da-f]+|\d+)\s*,\s*(0x[\da-f]+|\d+)\s*\)\.ram/.exec(map);
  if (!ram) throw new Error('MAME M6803 internal RAM map is missing');
  const outputMask = Number(
    /void\s+m6801_cpu_device::write_port2[\s\S]*?\bdata\s*&=\s*(0x[\da-f]+|\d+)/i
      .exec(source)?.[1],
  ) || 0xff;
  return {
    ram: [{ start: Number(ram[1]), end: Number(ram[2]) }],
    ports: [1, 2].map(port => ({
      dataAddress: address(`p${port}_data_w`),
      directionAddress: address(`p${port}_ddr_w`),
      inputSignal: `in_p${port}_cb`,
      outputSignal: `out_p${port}_cb`,
      outputMask: port === 2 ? outputMask : 0xff,
    })),
  };
}

function normalizeI8080Source(source: string): string {
  return normalizePairLocals(source);
}

function normalizePairLocals(source: string, rewriteMemberPostfix = true): string {
  let normalized = source
    .replace(/\b(m_\w+)\.w\.l\b/g, '$1.w')
    .replace(/\b(m_\w+)\.d\b/g, '$1.w');
  if (rewriteMemberPostfix) {
    normalized = normalized
      .replace(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\+\+/g, 'POSTINC($1)')
      .replace(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)--/g, 'POSTDEC($1)');
  }
  const pairDeclaration = /\bPAIR\s+(\w+(?:\s*,\s*\w+)*)\s*;/g;
  const pairLocals = [...normalized.matchAll(pairDeclaration)]
    .flatMap(match => match[1]!.split(',').map(name => name.trim()))
    .filter(name => /^\w+$/.test(name));
  normalized = normalized.replace(
    pairDeclaration,
    (_match, names: string) =>
      `u32 ${names.split(',').map(name => `${name.trim()} = 0`).join(', ')};`,
  );
  for (const name of pairLocals) {
    normalized = normalized
      .replace(new RegExp(`\\b${name}\\.b\\.l\\s*=\\s*([^;]+);`, 'g'),
        `${name} = (${name} & 0xff00) | (u8($1));`)
      .replace(new RegExp(`\\b${name}\\.b\\.h\\s*=\\s*([^;]+);`, 'g'),
        `${name} = (${name} & 0x00ff) | (u16($1) << 8);`)
      .replace(new RegExp(`\\b${name}\\.w\\.l\\b`, 'g'), name)
      .replace(new RegExp(`\\b${name}\\.(?:w|d)\\b`, 'g'), name)
      .replace(new RegExp(`\\b${name}\\.b\\.l\\b`, 'g'), `u8(${name})`)
      .replace(new RegExp(`\\b${name}\\.b\\.h\\b`, 'g'), `u8(${name} >> 8)`);
  }
  return normalized;
}

function singleIterationSource(source: string): string {
  const doMatch = /(?:^|\n)\s*do\s*\n/.exec(source);
  const doAt = doMatch?.index ?? -1;
  const open = source.indexOf('{', doAt);
  const close = matchBrace(source, open);
  if (doAt < 0 || open < 0 || close < 0) {
    throw new Error('MAME I8080 execute_run source shape changed');
  }
  return `m_icount = 0;\n${source.slice(0, doAt)}\n${source.slice(open + 1, close)}\nreturn -m_icount;`;
}

function extractGlobalConstants(source: string): Record<string, number> {
  const expressions = new Map<string, string>();
  for (const match of source.matchAll(/\bconstexpr\s+\w+\s+(\w+)\s*=\s*([^;]+);/g)) {
    expressions.set(match[1]!, match[2]!.trim());
  }
  return resolveConstants(expressions);
}

function extractNumericArray(source: string, name: string): number[] {
  const match = new RegExp(`${name}\\s*\\[[^\\]]+\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
  if (!match) throw new Error(`MAME I8080 source is missing ${name}`);
  const values = match[1]!
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
  if (values.length !== 256) throw new Error(`${name} contains ${values.length}, expected 256`);
  return values;
}

function extractStateAliases(source: string): Record<string, GeneratedCpuAlias> {
  const aliases: Record<string, GeneratedCpuAlias> = {};
  for (const match of source.matchAll(/state_add\([^,]+,\s*"([A-Z]+)",\s*(m_\w+)(?:(\.w\.l|\.d)|\.b\.(h|l))?\)/g)) {
    const part = match[4] === 'h'
      ? 'high'
      : match[4] === 'l'
        ? 'low'
        : match[3]
          ? 'word'
          : 'scalar';
    aliases[match[1]!] = {
      member: match[2]!,
      part,
      bits: part === 'word' ? 16 : 8,
    };
  }
  return aliases;
}

function inlineMethodForClass(
  source: string,
  name: string,
  className: string,
): { parameters: string; body: string; start: number } | undefined {
  const classAt = source.indexOf(`class ${className}`);
  const open = source.indexOf('{', classAt);
  const close = matchBrace(source, open);
  if (classAt < 0 || open < 0 || close < 0) return undefined;
  return extractInlineMethods(source.slice(open + 1, close))
    .find(method => method.name === name);
}

function compileOpcodeOperations(
  operations: OpcodeDslOperation[],
  options: { continueAsReturn?: boolean } = {},
): GeneratedHandlerProgram {
  const source = operations.flatMap(operation => {
    const text = operation.text.trim();
    if (!text || text.startsWith('//') || text === 'goto process;') return [];
    if (text.startsWith('#')) return [];
    if (options.continueAsReturn && text === 'continue;') return ['return;'];
    if (operation.kind === 'cycle') return [`cycles += ${operation.cycles};`];
    if (operation.kind === 'interruptible-access') {
      return [text, `cycles += ${operation.cycles};`];
    }
    return [text];
  }).join('\n');
  return compileMameHandler(normalizeMameExecutionSource(source));
}

export function normalizeMameExecutionSource(source: string): string {
  let normalized = stripInactivePreprocessorBranches(source)
    .replaceAll('[[fallthrough]];', '')
    .replace(/\bstatic_assert\s*\([^;]*\)\s*;/g, '')
    .replace(/\bbitswap\s*<\s*\d+\s*>\s*\(/g, 'BITSWAP(')
    .replace(
      /\bdo\s*\{([^{}]*)\}\s*while\s*\(\s*--(\w+)\s*\)\s*;/g,
      (_entry, body: string, counter: string) =>
        `while (${counter}) { ${body}; ${counter}--; }`,
    )
    .replace(
      /\bset_service_attention\s*<\s*([^,>]+)\s*,\s*([^>]+)\s*>\s*\(\s*\)/g,
      'set_service_attention($1, $2)',
    )
    .replace(
      /\bget_service_attention\s*<\s*([^>]+)\s*>\s*\(\s*\)/g,
      'get_service_attention($1)',
    )
    .replace(
      /\b(?:[\w:<>]+\s+)+\*\s*(\w+)\s*=/g,
      'auto $1 =',
    );
  for (const match of normalized.matchAll(
    /\bstatic\s+const\s+\w+\s+(\w+)\s*\[\s*(\d+)\s*\]\s*\[\s*(\d+)\s*\]\s*=\s*\{\s*((?:\{[^{}]*\}\s*,?\s*)+)\}\s*;/g,
  )) {
    const name = match[1]!;
    const columns = Number(match[3]);
    const values = [...match[4]!.matchAll(/\{([^{}]*)\}/g)]
      .flatMap(row => row[1]!.split(',').map(value => value.trim()).filter(Boolean));
    normalized = normalized
      .replace(match[0], '')
      .replace(
        new RegExp(`\\b${name}\\s*\\[([^\\]]+)\\]\\s*\\[([^\\]]+)\\]`, 'g'),
        (_entry, row: string, column: string) =>
          `TABLE((${row}) * ${columns} + (${column}), ${values.join(', ')})`,
      );
  }
  for (const match of normalized.matchAll(
    /\bstatic\s+const\s+\w+\s+(\w+)\s*\[[^\]]+\]\s*=\s*\{([^}]+)\}\s*;/g,
  )) {
    const name = match[1]!;
    const values = match[2]!.split(',').map(value => value.trim()).filter(Boolean);
    normalized = normalized
      .replace(match[0], '')
      .replace(
        new RegExp(`\\b${name}\\s*\\[([^\\]]+)\\]`, 'g'),
        (_entry, index: string) => `TABLE(${index}, ${values.join(', ')})`,
      );
  }
  return normalized;
}

function stripInactivePreprocessorBranches(source: string): string {
  let normalized = source;
  const branch =
    /^[ \t]*#(ifdef|ifndef)\s+\w+[^\r\n]*\r?\n([\s\S]*?)(?:^[ \t]*#else[^\r\n]*\r?\n([\s\S]*?))?^[ \t]*#endif[^\r\n]*(?:\r?\n|$)/gm;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    normalized = normalized.replace(
      branch,
      (_match, directive: string, primary: string, alternate = '') => {
        changed = true;
        return directive === 'ifndef' ? primary : alternate;
      },
    );
    if (!changed) break;
  }
  return normalized;
}

function stripMameFrameworkSetup(body: string): string {
  return body
    .split(/\r?\n/)
    .filter(line => {
      const text = line.trim();
      return !text.startsWith('save_item(') &&
        !text.startsWith('space(') &&
        !text.startsWith('state_add(') &&
        !text.startsWith('set_icountptr(');
    })
    .join('\n');
}

function extractAliases(source: string, header: string): Record<string, GeneratedCpuAlias> {
  const memberBits = Object.fromEntries(extractMembers(header, {}).map(member => [
    member.name,
    member.bits ?? 32,
  ]));
  const aliases: Record<string, GeneratedCpuAlias> = {};
  for (const match of source.matchAll(/^\s*#define\s+(\w+)\s+([^/\r\n]+)/gm)) {
    const name = match[1]!;
    const value = match[2]!.trim();
    let target: RegExpExecArray | null;
    if ((target = /^(m_\w+)\.w$/.exec(value))) {
      aliases[name] = { member: target[1]!, part: 'word', bits: 16 };
    } else if ((target = /^(m_\w+)\.b\.h$/.exec(value))) {
      aliases[name] = { member: target[1]!, part: 'high', bits: 8 };
    } else if ((target = /^(m_\w+)\.b\.l$/.exec(value))) {
      aliases[name] = { member: target[1]!, part: 'low', bits: 8 };
    } else if ((target = /^(m_\w+)$/.exec(value))) {
      const bits = memberBits[target[1]!] ?? 32;
      aliases[name] = {
        member: target[1]!,
        part: 'scalar',
        bits: bits === 1 || bits === 8 || bits === 16 ? bits : 32,
      };
    } else if ((target = /^(m_f)\.(\w+)$/.exec(value))) {
      aliases[name] = { member: `${target[1]}.${target[2]}`, part: 'scalar', bits: 8 };
    }
  }
  return aliases;
}

function extractMembers(
  header: string,
  objectFields: Record<string, 1 | 8 | 16 | 32>,
): GeneratedCpuMember[] {
  const members = new Map<string, GeneratedCpuMember>();
  for (const match of header.matchAll(/^\s*PAIR16\s+(m_\w+)\s*;/gm)) {
    members.set(match[1]!, { name: match[1]!, bits: 16, pair: true });
  }
  for (const match of header.matchAll(
    /^\s*(bool|u8|u16|u32|int)\s+(m_\w+)\s*(?:\[[^\]]+\])?\s*;/gm,
  )) {
    const bits = typeBits(match[1]!);
    members.set(match[2]!, { name: match[2]!, bits });
  }
  members.set('m_f', { name: 'm_f', fields: objectFields });
  members.set('cycles', { name: 'cycles', bits: 32 });
  return [...members.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function declaredFields(source: string): Record<string, 1 | 8 | 16 | 32> {
  const fields: Record<string, 1 | 8 | 16 | 32> = {};
  for (const match of source.matchAll(/^\s*(bool|u8|u16|u32|int)\s+(\w+)\s*;/gm)) {
    fields[match[2]!] = typeBits(match[1]!);
  }
  return fields;
}

function typeBits(type: string): 1 | 8 | 16 | 32 {
  if (type === 'bool') return 1;
  if (type === 'u8') return 8;
  if (type === 'u16') return 16;
  return 32;
}

function extractDefineConstants(source: string): Record<string, number> {
  const expressions = new Map<string, string>();
  for (const match of source.matchAll(/^\s*#define\s+(\w+)\s+([^/\r\n]+)/gm)) {
    expressions.set(match[1]!, match[2]!.trim());
  }
  return resolveConstants(expressions);
}

function extractConstexprConstants(source: string): Record<string, number> {
  const expressions = new Map<string, string>();
  for (const match of source.matchAll(
    /\bstatic\s+constexpr\s+\w+\s+(\w+)\s*=\s*([^;]+);/g,
  )) {
    expressions.set(match[1]!, match[2]!.trim());
  }
  return resolveConstants(expressions);
}

function extractEnumConstants(
  source: string,
  seed: Record<string, number>,
): Record<string, number> {
  const resolved = { ...seed };
  for (const match of source.matchAll(/\benum\s*\{([\s\S]*?)\};/g)) {
    let next = 0;
    for (const rawEntry of match[1]!.split(',')) {
      const entry = rawEntry.replace(/\/\/.*$/gm, '').trim();
      if (!entry) continue;
      const parsed = /^(\w+)(?:\s*=\s*([\s\S]+))?$/.exec(entry);
      if (!parsed) continue;
      if (parsed[2]) {
        const expression = parsed[2]!.replace(/\b[A-Za-z_]\w*\b/g, token =>
          Object.hasOwn(resolved, token) ? String(resolved[token]) : token);
        if (/^[\dxa-fA-F\s()+\-~|&<>]+$/.test(expression)) {
          try {
            const value = Function(`"use strict"; return (${expression});`)();
            if (typeof value === 'number') next = value;
          } catch {
            continue;
          }
        } else {
          continue;
        }
      }
      resolved[parsed[1]!] = next++;
    }
  }
  for (const key of Object.keys(seed)) delete resolved[key];
  return resolved;
}

function extractConstructorInitializers(
  source: string,
  className: string,
): Record<string, number> {
  const initial: Record<string, number> = {};
  const re = new RegExp(
    `${className}::${className}\\s*\\([^)]*\\)\\s*:\\s*([\\s\\S]*?)\\n\\s*\\{`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    for (const initializer of match[1]!.matchAll(/\b(m_\w+)\s*\(\s*(0x[\da-f]+|\d+)\s*\)/gi)) {
      initial[initializer[1]!] = Number(initializer[2]);
    }
  }
  return initial;
}

function resolveConstants(expressions: Map<string, string>): Record<string, number> {
  const resolved: Record<string, number> = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, source] of expressions) {
      if (Object.hasOwn(resolved, name)) continue;
      const normalized = source.replace(/\b[A-Za-z_]\w*\b/g, token =>
        Object.hasOwn(resolved, token) ? String(resolved[token]) : token);
      if (!/^[\dxa-fA-F\s()+\-~|&<>]+$/.test(normalized)) continue;
      try {
        // MAME constant expressions are trusted input and restricted above.
        const value = Function(`"use strict"; return (${normalized});`)();
        if (typeof value === 'number' && Number.isFinite(value)) {
          resolved[name] = value;
          changed = true;
        }
      } catch {
        // The unresolved constant is retained as a compiler diagnostic later.
      }
    }
  }
  return resolved;
}

function extractObject(
  source: string,
  objectName: string,
): {
  body: string;
  methods: { name: string; parameters: string; body: string; start: number }[];
  start: number;
  end: number;
} | undefined {
  const endMatch = new RegExp(`\\}\\s*${objectName}\\s*;`).exec(source);
  if (!endMatch) return undefined;
  const end = endMatch.index;
  let open = source.lastIndexOf('struct', end);
  open = source.indexOf('{', open);
  if (open < 0) return undefined;
  const close = matchBrace(source, open);
  if (close !== end) return undefined;
  const body = source.slice(open + 1, close);
  const methods: { name: string; parameters: string; body: string; start: number }[] = [];
  const methodRe =
    /(?:^|\n)\s*(?:[\w:<>,~*&]+\s+)+(\w+)\s*\(([^;{}]*)\)\s*(?:const\s*)?\{/g;
  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(body)) !== null) {
    const brace = body.indexOf('{', match.index + match[0].length - 1);
    const methodEnd = matchBrace(body, brace);
    if (methodEnd < 0) continue;
    methods.push({
      name: match[1]!,
      parameters: match[2]!,
      body: body.slice(brace + 1, methodEnd),
      start: open + 1 + match.index,
    });
    methodRe.lastIndex = methodEnd + 1;
  }
  return { body, methods, start: open, end: close };
}

function extractInlineMethods(
  source: string,
  exclude?: [number, number],
): { name: string; parameters: string; body: string; start: number }[] {
  const methods: { name: string; parameters: string; body: string; start: number }[] = [];
  const methodRe =
    /(?:^|\n)\s*(?:template\s*<([^>]+)>\s*)?(?:(?:virtual|static|constexpr|inline)\s+)*(?:[\w:<>,~*&]+\s+)+(\w+)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:ATTR_\w+\s*)?\{/g;
  let match: RegExpExecArray | null;
  while ((match = methodRe.exec(source)) !== null) {
    if (exclude && match.index >= exclude[0] && match.index <= exclude[1]) continue;
    const brace = source.indexOf('{', match.index + match[0].length - 1);
    const end = matchBrace(source, brace);
    if (end < 0) continue;
    const templateParameters = (match[1] ?? '')
      .split(',')
      .map(parameter => parameter.trim())
      .filter(Boolean);
    const parameters = [
      ...templateParameters,
      ...match[3]!.split(',').map(parameter => parameter.trim()).filter(Boolean),
    ].join(', ');
    methods.push({
      name: match[2]!,
      parameters,
      body: source.slice(brace + 1, end),
      start: match.index,
    });
    methodRe.lastIndex = end + 1;
  }
  return methods;
}

function qualifyObjectFields(
  source: string,
  objectName: string,
  fields: string[],
): string {
  let qualified = source;
  for (const field of fields) {
    qualified = qualified.replace(
      new RegExp(`(?<![\\w.])${field}\\b`, 'g'),
      `${objectName}.${field}`,
    );
  }
  return qualified;
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

function matchPair(
  source: string,
  open: number,
  left: string,
  right: string,
): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === left) depth++;
    else if (source[index] === right && --depth === 0) return index;
  }
  return -1;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function sourceRef(file: string, line: number): GeneratedSourceRef {
  return { file, line };
}

export function z80SourcePaths(mameSrc: string): string[] {
  return [
    'src/devices/cpu/z80/z80.cpp',
    'src/devices/cpu/z80/z80.h',
    'src/devices/cpu/z80/z80.inc',
    'src/devices/cpu/z80/z80.lst',
  ].map(file => relative(mameSrc, join(mameSrc, file)));
}
