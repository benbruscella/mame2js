import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  GeneratedHandlerProgram,
  GeneratedSourceRef,
} from '../runtime/generated-machine.ts';
import { parseMameSource } from './ast.ts';
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
  layout?: 'm6809q';
  fields?: Record<string, 1 | 8 | 16 | 32>;
  table?: number[];
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
  opcodes: GeneratedCpuOpcode[];
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
  const constants: Record<string, number> = {
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
 * Compile MAME's 6809 operation-list DSL as an executable dispatch program.
 * KONAMI1 reuses this core and contributes only its source-defined opcode
 * fetch transform.
 */
export function compileMame6809(
  mameSrc: string,
  type: 'MC6809' | 'KONAMI1',
): GeneratedCpuDefinition {
  const cppFile = 'src/devices/cpu/m6809/m6809.cpp';
  const headerFile = 'src/devices/cpu/m6809/m6809.h';
  const inlineFile = 'src/devices/cpu/m6809/m6809inl.h';
  const dslFile = 'src/devices/cpu/m6809/m6809.lst';
  const baseDslFile = 'src/devices/cpu/m6809/base6x09.lst';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const inlineSource = readFileSync(join(mameSrc, inlineFile), 'utf8');
  const dslSource = readFileSync(join(mameSrc, dslFile), 'utf8')
    .replace(
      /^\s*#include\s+"base6x09\.lst"\s*$/m,
      readFileSync(join(mameSrc, baseDslFile), 'utf8'),
    );
  const labels = splitOperationLabels(dslSource);
  const main = labels.find(label => label.name === 'MAIN');
  if (!main) throw new Error('MAME 6809 operation DSL has no MAIN dispatch');

  const methods: GeneratedCpuMethod[] = labels
    .filter(label => label.name !== 'MAIN')
    .map(label => ({
      name: label.name,
      parameters: '',
      program: compileMameHandler(normalize6809Source(label.body)),
      source: operationLabelSource(label.name, dslFile, baseDslFile, mameSrc),
    }));
  const inlineUnit = parseMameSource(inlineFile, inlineSource);
  for (const fn of inlineUnit.functions.filter(fn =>
    fn.className === 'm6809_base_device' &&
    !['rotate_right', 'rotate_left', 'set_flags'].includes(fn.name))) {
    methods.push({
      name: fn.name,
      parameters: fn.parameters,
      program: compileMameHandler(normalize6809Source(fn.body, fn.name)),
      source: sourceRef(fn.span.file, fn.span.line),
    });
  }
  for (const fn of inlineUnit.functions.filter(fn =>
    fn.className === 'm6809_base_device' &&
    ['rotate_right', 'rotate_left', 'set_flags'].includes(fn.name))) {
    for (const bits of [8, 16] as const) {
      const valueType = bits === 8 ? 'uint8_t' : 'uint16_t';
      methods.push({
        name: `${fn.name}${bits}`,
        parameters: fn.parameters.replace(/\bT\b/g, valueType),
        program: compileMameHandler(normalize6809Source(
          fn.body
            .replaceAll('sizeof(T)', bits === 8 ? '1' : '2')
            .replace(/\bT\b/g, valueType),
          `${fn.name}${bits}`,
        )),
        source: sourceRef(fn.span.file, fn.span.line),
      });
    }
  }
  const cppUnit = parseMameSource(cppFile, cpp);
  for (const fn of cppUnit.functions.filter(fn =>
    fn.className === 'm6809_base_device' &&
    ['read_tfr_exg_816_register', 'read_exg_168_register',
      'write_exgtfr_register', 'log_illegal'].includes(fn.name))) {
    methods.push({
      name: fn.name,
      parameters: fn.parameters,
      program: compileMameHandler(normalize6809Source(fn.body, fn.name)),
      source: sourceRef(fn.span.file, fn.span.line),
    });
  }
  const inlineNames = new Set([
    'read_ea', 'write_ea', 'set_ea', 'set_ea_h', 'set_ea_l',
    'nop', 'set_a', 'set_b', 'set_d', 'set_imm',
    'is_register_register_op_16_bit', 'add8_sets_h', 'hd6309_native_mode',
    'cond_hi', 'cond_cc', 'cond_ne', 'cond_vc', 'cond_pl', 'cond_ge', 'cond_gt',
    'set_cond', 'branch_taken', 'firq_saves_entire_state',
    'partial_state_registers', 'entire_state_registers', 'is_ea_addressing_mode',
  ]);
  for (const method of extractInlineMethods(header).filter(method =>
    inlineNames.has(method.name))) {
    methods.push({
      name: method.name,
      parameters: method.parameters,
      program: compileMameHandler(normalize6809Source(method.body, method.name)),
      source: sourceRef(headerFile, lineAt(header, method.start)),
    });
  }

  const resetMethod = cppUnit.functions.find(fn =>
    fn.className === 'm6809_base_device' && fn.name === 'device_reset');
  const inputMethod = cppUnit.functions.find(fn =>
    fn.className === 'm6809_base_device' && fn.name === 'execute_set_input');
  if (!resetMethod || !inputMethod) throw new Error('MAME 6809 reset/input source is missing');
  const start = compileMameHandler(normalize6809Source(`
    m_cc = 0;
    m_pc.w = 0;
    m_ppc.w = 0;
    m_s.w = 0;
    m_u.w = 0;
    m_q.q = 0;
    m_x.w = 0;
    m_y.w = 0;
    m_dp = 0;
    m_temp.w = 0;
    m_opcode = 0;
    m_reg = 0;
    m_nmi_line = false;
    m_nmi_asserted = false;
    m_firq_line = false;
    m_irq_line = false;
    m_lds_encountered = false;
    m_addressing_mode = ADDRESSING_MODE_IMMEDIATE;
    m_cond = false;
    m_free_run = false;
  `));
  const reset = compileMameHandler(normalize6809Source(`
    ${resetMethod.body}
    m_pc.b.h = read_vector(0);
    m_pc.b.l = read_vector(1);
  `));
  const input = compileMameHandler(normalize6809Source(
    inputMethod.body.replace(/LOGMASKED\s*\([^;]+;/s, ''),
  ));
  const dispatch = compileMameHandler(normalize6809Source(`${main.body}\nDISPATCH01();`));
  const empty = compileMameHandler('');
  const constants = {
    ASSERT_LINE: 1,
    CLEAR_LINE: 0,
    HOLD_LINE: 2,
    INPUT_LINE_IRQ0: 0,
    INPUT_LINE_NMI: -1,
    M6809_IRQ_LINE: 0,
    M6809_FIRQ_LINE: 1,
    M6809_A: 1,
    M6809_B: 2,
    M6809_D: 3,
    M6809_X: 4,
    M6809_Y: 5,
    M6809_U: 6,
    M6809_S: 7,
    ...extractEnumConstants(header, {}),
  };
  const members: GeneratedCpuMember[] = [
    ...['m_pc', 'm_ppc', 'm_s', 'm_u', 'm_x', 'm_y', 'm_temp', 'm_ea']
      .map(name => ({ name, bits: 16 as const, pair: true })),
    { name: 'm_q', bits: 32, layout: 'm6809q' },
    ...[
      ['m_dp', 8], ['m_cc', 8], ['m_opcode', 8], ['m_reg', 32],
      ['m_nmi_line', 1], ['m_nmi_asserted', 1], ['m_firq_line', 1],
      ['m_irq_line', 1], ['m_lds_encountered', 1], ['m_addressing_mode', 32],
      ['m_icount', 32], ['m_cond', 1], ['m_free_run', 1], ['cycles', 32],
    ].map(([name, bits]) => ({
      name: name as string,
      bits: bits as 1 | 8 | 16 | 32,
    })),
  ];
  const aliases: Record<string, GeneratedCpuAlias> = {
    PC: { member: 'm_pc', part: 'word', bits: 16 },
    SP: { member: 'm_s', part: 'word', bits: 16 },
  };
  const dynamicAliases: NonNullable<GeneratedCpuDefinition['dynamicAliases']> = {
    REG8: {
      selector: 'm_reg',
      paths: {
        [String(constants.M6809_A)]: 'm_q.r.a',
        [String(constants.M6809_B)]: 'm_q.r.b',
      },
      part: 'scalar',
      bits: 8,
    },
    REG16: {
      selector: 'm_reg',
      paths: {
        [String(constants.M6809_D)]: 'm_q.p.d',
        [String(constants.M6809_X)]: 'm_x',
        [String(constants.M6809_Y)]: 'm_y',
        [String(constants.M6809_U)]: 'm_u',
        [String(constants.M6809_S)]: 'm_s',
      },
      part: 'word',
      bits: 16,
    },
    REG16_H: {
      selector: 'm_reg',
      paths: {
        [String(constants.M6809_D)]: 'm_q.p.d',
        [String(constants.M6809_X)]: 'm_x',
        [String(constants.M6809_Y)]: 'm_y',
        [String(constants.M6809_U)]: 'm_u',
        [String(constants.M6809_S)]: 'm_s',
      },
      part: 'high',
      bits: 8,
    },
    REG16_L: {
      selector: 'm_reg',
      paths: {
        [String(constants.M6809_D)]: 'm_q.p.d',
        [String(constants.M6809_X)]: 'm_x',
        [String(constants.M6809_Y)]: 'm_y',
        [String(constants.M6809_U)]: 'm_u',
        [String(constants.M6809_S)]: 'm_s',
      },
      part: 'low',
      bits: 8,
    },
    IREG: {
      selector: 'm_opcode',
      mask: 0x60,
      paths: { '0': 'm_x', '32': 'm_y', '64': 'm_u', '96': 'm_s' },
      part: 'word',
      bits: 16,
    },
  };
  let opcodeTransform: GeneratedHandlerProgram | undefined;
  const sourceFiles = [cppFile, headerFile, inlineFile, dslFile, baseDslFile];
  if (type === 'KONAMI1') {
    const konamiFile = 'src/mame/konami/konami1.cpp';
    const konami = readFileSync(join(mameSrc, konamiFile), 'utf8');
    const signature = /konami1_device::mi_konami1::read_opcode\s*\([^)]*\)\s*\{/.exec(konami);
    if (!signature) throw new Error('MAME KONAMI1 opcode transform is missing');
    const open = konami.indexOf('{', signature.index);
    const close = matchBrace(konami, open);
    const transformBody = konami.slice(open + 1, close);
    opcodeTransform = compileMameHandler(normalize6809Source(
      transformBody
        .replace(/uint8_t\s+val\s*=\s*csprogram\.read_byte\(adr\)\s*;/, '')
        .replace(/\bm_boundary\b/g, '0'),
    ));
    sourceFiles.push(konamiFile);
  }
  const programs = [
    start, reset, input, dispatch, ...methods.map(method => method.program),
    ...(opcodeTransform ? [opcodeTransform] : []),
  ];
  return {
    schemaVersion: 1,
    type,
    dialect: 'mame-m6809-operation-list',
    sourceFiles,
    constants,
    aliases,
    dynamicAliases,
    members,
    methods,
    start,
    reset,
    input,
    service: empty,
    fetch: empty,
    dispatch,
    ...(opcodeTransform ? { opcodeTransform } : {}),
    opcodes: [],
    summary: {
      opcodes: 256,
      compiledOpcodes: dispatch.diagnostics.length ? 0 : 256,
      methods: methods.length,
      compiledMethods: methods.filter(method => !method.program.diagnostics.length).length,
      diagnostics: programs.reduce((count, program) => count + program.diagnostics.length, 0),
    },
  };
}

/**
 * Compile the external-ROM Intel 8039 from MAME's MCS-48 implementation.
 * MAME expresses this core as OPHANDLER macros plus a 256-entry function
 * table, so both constructs are parsed as source DSL rather than duplicated.
 */
export function compileMameMcs48(
  mameSrc: string,
  type: 'I8039' = 'I8039',
): GeneratedCpuDefinition {
  const cppFile = 'src/devices/cpu/mcs48/mcs48.cpp';
  const headerFile = 'src/devices/cpu/mcs48/mcs48.h';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const unit = parseMameSource(cppFile, cpp);
  const handlers = extractMacroHandlers(cpp, 'OPHANDLER');
  const table = extractOpcodeHandlerTable(cpp, 's_mcs48_opcodes');
  if (table.length !== 256) {
    throw new Error(`MAME MCS-48 opcode table has ${table.length}/256 entries`);
  }

  const helperNames = new Set([
    'opcode_fetch',
    'argument_fetch',
    'push_pc_psw',
    'pull_pc_psw',
    'pull_pc',
    'execute_add',
    'execute_addc',
    'execute_jmp',
    'execute_call',
    'execute_jcc',
    'p2_mask',
    'expander_operation',
    'check_irqs',
    'burn_cycles',
  ]);
  const methods: GeneratedCpuMethod[] = unit.functions
    .filter(fn => fn.className === 'mcs48_cpu_device' && helperNames.has(fn.name))
    .map(fn => {
      let body = fn.body;
      if (fn.name === 'burn_cycles') {
        body = `int burned = count;\n${body}`.replace(
          /m_icount\s*-=\s*count\s*;/,
          'cycles += burned; m_icount -= count;',
        );
      }
      return {
        name: fn.name,
        parameters: fn.parameters,
        program: compileMameHandler(normalizeMcs48Source(body)),
        source: sourceRef(fn.span.file, fn.span.line),
      };
    });
  methods.push(...handlers.map(handler => ({
    name: handler.name,
    parameters: '',
    program: compileMameHandler(normalizeMcs48Source(handler.body)),
    source: sourceRef(cppFile, lineAt(cpp, handler.start)),
  })));

  const resetMethod = unit.functions.find(fn =>
    fn.className === 'mcs48_cpu_device' && fn.name === 'device_reset');
  const inputMethod = unit.functions.find(fn =>
    fn.className === 'mcs48_cpu_device' && fn.name === 'execute_set_input');
  if (!resetMethod || !inputMethod) {
    throw new Error('MAME MCS-48 reset/input source is missing');
  }

  const constants: Record<string, number> = {
    ASSERT_LINE: 1,
    CLEAR_LINE: 0,
    HOLD_LINE: 2,
    INPUT_LINE_IRQ0: 0,
    INPUT_LINE_NMI: -1,
    ...extractDefineConstants(cpp),
    ...extractEnumConstants(header, {}),
  };
  const members: GeneratedCpuMember[] = [
    { name: 'm_ram', fields: Object.fromEntries(
      Array.from({ length: 128 }, (_, address) => [String(address), 8 as const]),
    ) },
    ...['m_prevpc', 'm_pc', 'm_a11'].map(name => ({
      name,
      bits: 16 as const,
    })),
    ...[
      'm_a', 'm_psw', 'm_p1', 'm_p2', 'm_ea', 'm_timer', 'm_prescaler',
      'm_t1_history', 'm_sts', 'm_dbbi', 'm_dbbo', 'm_timecount_enabled',
      'm_feature_mask', 'm_rtemp', 'm_opcode',
    ].map(name => ({ name, bits: 8 as const })),
    ...[
      'm_f1', 'm_irq_state', 'm_irq_polled', 'm_irq_in_progress',
      'm_timer_overflow', 'm_timer_flag', 'm_tirq_enabled', 'm_xirq_enabled',
      'm_flags_enabled', 'm_dma_enabled',
    ].map(name => ({ name, bits: 1 as const })),
    { name: 'm_rom_size', bits: 16, initial: 0 },
    { name: 'm_ram_size', bits: 16, initial: 128 },
    { name: 'm_icount', bits: 32 },
    { name: 'cycles', bits: 32 },
  ];
  const aliases: Record<string, GeneratedCpuAlias> = {
    PC: { member: 'm_pc', part: 'scalar', bits: 16 },
  };
  const dynamicAliases: NonNullable<GeneratedCpuDefinition['dynamicAliases']> =
    Object.fromEntries(Array.from({ length: 8 }, (_, register) => [
      `R${register}`,
      {
        selector: 'm_psw',
        mask: constants.B_FLAG ?? 0x10,
        paths: {
          '0': `m_ram.${register}`,
          [String(constants.B_FLAG ?? 0x10)]: `m_ram.${24 + register}`,
        },
        part: 'scalar' as const,
        bits: 8 as const,
      },
    ]));
  const start = compileMameHandler(normalizeMcs48Source(`
    m_prevpc = 0;
    m_pc = 0;
    m_a = 0;
    m_psw = 0;
    m_f1 = false;
    m_a11 = 0;
    m_p1 = 0xff;
    m_p2 = 0xff;
    m_ea = 1;
    m_timer = 0;
    m_prescaler = 0;
    m_t1_history = 0;
    m_sts = 0;
    m_dbbi = 0;
    m_dbbo = 0;
    m_irq_state = false;
    m_irq_polled = false;
    m_irq_in_progress = false;
    m_timer_overflow = false;
    m_timer_flag = false;
    m_tirq_enabled = false;
    m_xirq_enabled = false;
    m_timecount_enabled = 0;
    m_flags_enabled = false;
    m_dma_enabled = false;
    m_feature_mask = I8048_FEATURE;
    m_rom_size = 0;
    m_ram_size = 128;
  `));
  const reset = compileMameHandler(normalizeMcs48Source(resetMethod.body));
  const input = compileMameHandler(normalizeMcs48Source(inputMethod.body));
  const dispatch = compileMameHandler(normalizeMcs48Source(`
    check_irqs();
    m_irq_polled = false;
    m_prevpc = m_pc;
    debugger_instruction_hook(m_pc);
    m_opcode = opcode_fetch();
    switch (m_opcode) {
      ${table.map((handler, opcode) =>
        `case 0x${opcode.toString(16).padStart(2, '0')}: ${handler}(); break;`
      ).join('\n')}
    }
  `));
  const empty = compileMameHandler('');
  const methodByName = new Map(methods.map(method => [method.name, method]));
  const compiledOpcodes = table.filter(name =>
    !methodByName.get(name)?.program.diagnostics.length).length;
  const programs = [
    start, reset, input, dispatch, ...methods.map(method => method.program),
  ];
  return {
    schemaVersion: 1,
    type,
    dialect: 'mame-mcs48-ophandler-table',
    sourceFiles: [cppFile, headerFile],
    constants,
    aliases,
    dynamicAliases,
    members,
    methods,
    start,
    reset,
    input,
    service: empty,
    fetch: empty,
    dispatch,
    opcodes: [],
    summary: {
      opcodes: table.length,
      compiledOpcodes,
      methods: methods.length,
      compiledMethods: methods.filter(method => !method.program.diagnostics.length).length,
      diagnostics: programs.reduce((count, program) => count + program.diagnostics.length, 0),
    },
  };
}

/**
 * Compile MAME's Intel 8080 implementation from its source opcode switch and
 * helper methods. MAME's PAIR union syntax is lowered to the IR's 16-bit pair
 * value model; opcode and flag behavior remains source-derived.
 */
export function compileMame8080(
  mameSrc: string,
  type: 'I8080' | 'I8080A' = 'I8080',
): GeneratedCpuDefinition {
  const cppFile = 'src/devices/cpu/i8085/i8085.cpp';
  const headerFile = 'src/devices/cpu/i8085/i8085.h';
  const cpp = readFileSync(join(mameSrc, cppFile), 'utf8');
  const header = readFileSync(join(mameSrc, headerFile), 'utf8');
  const unit = parseMameSource(cppFile, cpp);
  const cycles = extractNumericTable(cpp, 'i8085a_cpu_device::lut_cycles_8080');
  if (cycles.length !== 256) {
    throw new Error(`MAME I8080 cycle table has ${cycles.length}/256 entries`);
  }

  const methodNames = new Set([
    'set_sod',
    'set_inte',
    'set_status',
    'get_rim_value',
    'break_halt_for_interrupt',
    'check_for_interrupts',
    'read_arg',
    'read_arg16',
    'read_op',
    'read_inta',
    'read_mem',
    'write_mem',
    'op_push',
    'op_pop',
    'op_ora',
    'op_xra',
    'op_ana',
    'op_inr',
    'op_dcr',
    'op_add',
    'op_adc',
    'op_sub',
    'op_sbb',
    'op_cmp',
    'op_dad',
    'op_jmp',
    'op_call',
    'op_ret',
    'op_rst',
    'execute_one',
  ]);
  const methods: GeneratedCpuMethod[] = unit.functions
    .filter(fn => fn.className === 'i8085a_cpu_device' && methodNames.has(fn.name))
    .map(fn => ({
      name: fn.name,
      parameters: normalize8080Parameters(fn.parameters),
      program: compileMameHandler(normalize8080Source(fn.body)),
      source: sourceRef(fn.span.file, fn.span.line),
    }));
  const executeOne = methods.find(method => method.name === 'execute_one');
  const startMethod = unit.functions.find(fn =>
    fn.className === 'i8085a_cpu_device' && fn.name === 'device_start');
  const resetMethod = unit.functions.find(fn =>
    fn.className === 'i8085a_cpu_device' && fn.name === 'device_reset');
  const inputMethod = unit.functions.find(fn =>
    fn.className === 'i8085a_cpu_device' && fn.name === 'execute_set_input');
  const initTables = unit.functions.find(fn =>
    fn.className === 'i8085a_cpu_device' && fn.name === 'init_tables');
  if (!executeOne || !startMethod || !resetMethod || !inputMethod || !initTables) {
    throw new Error('MAME I8080 source is missing execution/start/reset/input definitions');
  }

  const constants: Record<string, number> = {
    ASSERT_LINE: 1,
    CLEAR_LINE: 0,
    HOLD_LINE: 2,
    INPUT_LINE_IRQ0: 0,
    INPUT_LINE_NMI: -1,
    I8085_TRAP_LINE: -1,
    ...extractDefineConstants(header),
    ...extractConstexprConstants(cpp),
    ...extractConstexprConstants(header),
  };
  const members: GeneratedCpuMember[] = [
    ...['m_PC', 'm_SP', 'm_AF', 'm_BC', 'm_DE', 'm_HL', 'm_WZ'].map(name => ({
      name,
      bits: 16 as const,
      pair: true,
    })),
    ...[
      'm_halt', 'm_im', 'm_status', 'm_after_ei', 'm_nmi_state',
      'm_trap_im_copy', 'm_sod_state', 'm_ietemp',
    ].map(name => ({ name, bits: 8 as const })),
    ...['m_trap_pending', 'm_in_acknowledge'].map(name => ({
      name,
      bits: 1 as const,
    })),
    { name: 'm_irq_state', table: [0, 0, 0, 0] },
    { name: 'lut_cycles', table: cycles },
    { name: 'lut_zs', table: Array<number>(256).fill(0) },
    { name: 'lut_zsp', table: Array<number>(256).fill(0) },
    { name: 'm_icount', bits: 32 },
    { name: 'cycles', bits: 32 },
  ];
  const aliases: Record<string, GeneratedCpuAlias> = {
    PC: { member: 'm_PC', part: 'word', bits: 16 },
    SP: { member: 'm_SP', part: 'word', bits: 16 },
    AF: { member: 'm_AF', part: 'word', bits: 16 },
    BC: { member: 'm_BC', part: 'word', bits: 16 },
    DE: { member: 'm_DE', part: 'word', bits: 16 },
    HL: { member: 'm_HL', part: 'word', bits: 16 },
    A: { member: 'm_AF', part: 'high', bits: 8 },
    F: { member: 'm_AF', part: 'low', bits: 8 },
    B: { member: 'm_BC', part: 'high', bits: 8 },
    C: { member: 'm_BC', part: 'low', bits: 8 },
    D: { member: 'm_DE', part: 'high', bits: 8 },
    E: { member: 'm_DE', part: 'low', bits: 8 },
    H: { member: 'm_HL', part: 'high', bits: 8 },
    L: { member: 'm_HL', part: 'low', bits: 8 },
  };
  const tableInitBody = initTables.body.replace(
    /lut_cycles\s*\[\s*i\s*\]\s*=\s*[^;]+;/,
    '',
  );
  const startBody = startMethod.body
    .split('// set up the state table')[0]!
    .replace('init_tables();', tableInitBody);
  const start = compileMameHandler(normalize8080Source(startBody));
  const reset = compileMameHandler(normalize8080Source(resetMethod.body));
  const input = compileMameHandler(normalize8080Source(
    inputMethod.body.replace(/\birqline\b/g, 'inputnum'),
  ));
  const dispatch = compileMameHandler(normalize8080Source(`
    if (m_trap_pending || m_after_ei == 0)
      check_for_interrupts();
    if (m_after_ei != 0 && --m_after_ei == 0)
      check_for_interrupts();
    m_in_acknowledge = false;
    debugger_instruction_hook(m_PC.w);
    execute_one(read_op());
  `));
  const empty = compileMameHandler('');
  const programs = [
    start, reset, input, dispatch, ...methods.map(method => method.program),
  ];
  return {
    schemaVersion: 1,
    type,
    dialect: 'mame-i8085-execute-one-switch',
    sourceFiles: [cppFile, headerFile],
    constants,
    aliases,
    members,
    methods,
    start,
    reset,
    input,
    service: empty,
    fetch: empty,
    dispatch,
    opcodes: [],
    summary: {
      opcodes: 256,
      compiledOpcodes: executeOne.program.diagnostics.length ? 0 : 256,
      methods: methods.length,
      compiledMethods: methods.filter(method => !method.program.diagnostics.length).length,
      diagnostics: programs.reduce((count, program) => count + program.diagnostics.length, 0),
    },
  };
}

function normalize8080Parameters(parameters: string): string {
  return parameters.replace(/\bPAIR\b/g, 'u16');
}

function normalize8080Source(source: string): string {
  let normalized = source
    .replace(/\bis_8085\s*\(\s*\)/g, 'false')
    .replace(/\bjmp_taken\s*\(\s*\)/g, '0')
    .replace(/\bcall_taken\s*\(\s*\)/g, '6')
    .replace(/\bret_taken\s*\(\s*\)/g, '6')
    .replace(/\bstd::size\s*\(\s*m_irq_state\s*\)/g, '4')
    .replace(/\bstd::popcount\s*\(/g, 'popcount(')
    .replace(/\bPAIR\s+(\w+)\s*=\s*/g, 'u16 $1 = ')
    .replace(/\bPAIR\s+(\w+)\s*;/g, 'u16 $1 = 0;')
    .replace(/\b(m_\w+|p)\.w\.l\b/g, '$1.w')
    .replace(/\b(m_\w+)\.d\b/g, '$1.w')
    .replace(/\b(p)\.b\.l\s*=\s*([^;]+);/g, '$1 = PAIR_LOW($1, $2);')
    .replace(/\b(p)\.b\.h\s*=\s*([^;]+);/g, '$1 = PAIR_HIGH($1, $2);')
    .replace(/\bp\.b\.l\b/g, '(p & 0xff)')
    .replace(/\bp\.b\.h\b/g, '((p >> 8) & 0xff)')
    .replace(/\b(m_[A-Z]+)\.w\+\+/g, '$1_POSTINC()')
    .replace(/\b(m_[A-Z]+)\.w--/g, '$1_POSTDEC()')
    .replace(/\bm_icount\s*-=\s*([^;]+);/g, 'BURN($1);');
  normalized = normalizeMameExecutionSource(normalized);
  return normalized;
}

function extractNumericTable(source: string, name: string): number[] {
  const declaration = source.indexOf(name);
  if (declaration < 0) return [];
  const open = source.indexOf('{', declaration);
  const close = matchBrace(source, open);
  if (open < 0 || close < 0) return [];
  return source.slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

function extractMacroHandlers(
  source: string,
  macro: string,
): { name: string; body: string; start: number }[] {
  const handlers: { name: string; body: string; start: number }[] = [];
  const pattern = new RegExp(`\\b${macro}\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('{', match.index);
    const close = matchBrace(source, open);
    if (close < 0) continue;
    handlers.push({
      name: match[1]!,
      body: source.slice(open + 1, close),
      start: match.index,
    });
    pattern.lastIndex = close + 1;
  }
  return handlers;
}

function extractOpcodeHandlerTable(source: string, table: string): string[] {
  const declaration = new RegExp(`\\b${table}\\s*\\[\\s*256\\s*\\]\\s*=\\s*\\{`).exec(source);
  if (!declaration) return [];
  const open = source.indexOf('{', declaration.index);
  const close = matchBrace(source, open);
  if (close < 0) return [];
  return [...source.slice(open + 1, close).matchAll(/\bOP\s*\(\s*(\w+)\s*\)/g)]
    .map(match => match[1]!);
}

function normalizeMcs48Source(source: string): string {
  return normalizeMameExecutionSource(source
    .replace(/\bupdate_regptr\s*\(\s*\)\s*;/g, '')
    .replace(/\bupdate_ea\s*\(\s*\)\s*;/g, '')
    .replace(/count--\s*,\s*m_icount--/g, 'count--')
    .replace(/\bm_program\.read_byte\s*\(/g, 'program_r(')
    .replace(
      /m_bus_out_cb\s*\(\s*0\s*,\s*0xff\s*,\s*m_ea\s*\?\s*0xff\s*:\s*0\s*\)\s*;/g,
      'bus_w(0xff);',
    ));
}

function splitOperationLabels(source: string): {
  name: string;
  body: string;
}[] {
  const labels = [...source.matchAll(/^([A-Z][A-Za-z0-9_]*)\s*:\s*$/gm)];
  return labels.map((label, index) => ({
    name: label[1]!,
    body: source.slice(
      label.index + label[0].length,
      labels[index + 1]?.index ?? source.length,
    ),
  }));
}

function operationLabelSource(
  name: string,
  dslFile: string,
  baseDslFile: string,
  mameSrc: string,
): GeneratedSourceRef {
  for (const file of [dslFile, baseDslFile]) {
    const source = readFileSync(join(mameSrc, file), 'utf8');
    const match = new RegExp(`^${name}:`, 'm').exec(source);
    if (match) return sourceRef(file, lineAt(source, match.index));
  }
  return sourceRef(dslFile, 1);
}

function normalize6809Source(source: string, method = ''): string {
  let normalized = source
    .replace(/^(\s*)@/gm, '$1')
    .replace(/\(void\)\s*/g, '')
    .replace(/\bUNEXPECTED\s*\(/g, '(')
    .replace(/\bLIKELY\s*\(/g, '(')
    .replace(/&regop16\(\)\s*==\s*&m_s/g, 'm_reg == M6809_S')
    .replace(/regop16\(\)\.b\.h/g, 'REG16_H')
    .replace(/regop16\(\)\.b\.l/g, 'REG16_L')
    .replace(/regop16\(\)\.w/g, 'REG16')
    .replace(/regop8\(\)/g, 'REG8')
    .replace(/ireg\(\)/g, 'IREG')
    .replace(/set_regop8\(\s*m_q\.r\.a\s*\)/g, 'm_reg = M6809_A')
    .replace(/set_regop8\(\s*m_q\.r\.b\s*\)/g, 'm_reg = M6809_B')
    .replace(/set_regop16\(\s*m_q\.p\.d\s*\)/g, 'm_reg = M6809_D')
    .replace(/set_regop16\(\s*m_x\s*\)/g, 'm_reg = M6809_X')
    .replace(/set_regop16\(\s*m_y\s*\)/g, 'm_reg = M6809_Y')
    .replace(/set_regop16\(\s*m_u\s*\)/g, 'm_reg = M6809_U')
    .replace(/set_regop16\(\s*m_s\s*\)/g, 'm_reg = M6809_S')
    .replace(/read_memory\(\s*REG16\+\+\s*\)/g, 'read_memory(POSTINC_REG16())')
    .replace(/write_memory\(\s*--REG16\s*,/g, 'write_memory(PREDEC_REG16(),')
    .replace(/write_memory\(\s*m_pc\.w\+\+\s*,/g, 'write_memory(POSTINC_PC(),')
    .replace(/%([A-Z][A-Za-z0-9_]*)\s*;/g, '$1();')
    .replace(/\bset_flags\s*<\s*uint8_t\s*>/g, 'set_flags8')
    .replace(/\bset_flags\s*<\s*uint16_t\s*>/g, 'set_flags16');
  normalized = normalized.split('\n').map(line => {
    let match = /^(\s*)if\s*\((.*)\)\s*goto\s+([A-Z][A-Za-z0-9_]*)\s*;\s*$/.exec(line);
    if (match) return `${match[1]}if (${match[2]}) { ${match[3]}(); return; }`;
    match = /^(\s*case\s+[^:]+:\s*)goto\s+([A-Z][A-Za-z0-9_]*)\s*;\s*$/.exec(line);
    if (match) return `${match[1]}${match[2]}(); return;`;
    return line.replace(
      /goto\s+([A-Z][A-Za-z0-9_]*)\s*;/g,
      '$1(); return;',
    );
  }).join('\n');
  normalized = rewriteTypedCall(normalized, 'set_flags', args =>
    /\b(?:REG16|m_temp\.w|m_q\.r\.d|m_ea\.w|uint16_t|int16_t|result)\b/.test(args)
      ? 'set_flags16'
      : 'set_flags8');
  normalized = rewriteTypedCall(normalized, 'rotate_right', args =>
    /\.w\b|REG16/.test(args) ? 'rotate_right16' : 'rotate_right8');
  normalized = rewriteTypedCall(normalized, 'rotate_left', args =>
    /\.w\b|REG16/.test(args) ? 'rotate_left16' : 'rotate_left8');
  if (method === 'daa') normalized = normalized.replaceAll('set_flags8', 'set_flags8');
  if (method === 'mul') normalized = normalized.replaceAll('set_flags8', 'set_flags16');
  return normalizeMameExecutionSource(normalized);
}

function rewriteTypedCall(
  source: string,
  name: string,
  rename: (args: string) => string,
): string {
  let result = '';
  let cursor = 0;
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('(', match.index);
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index++) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')' && --depth === 0) {
        close = index;
        break;
      }
    }
    if (close < 0) break;
    result += source.slice(cursor, match.index) +
      rename(source.slice(open + 1, close)) +
      source.slice(open, close + 1);
    cursor = close + 1;
    pattern.lastIndex = close + 1;
  }
  return result + source.slice(cursor);
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
  let normalized = source
    .replaceAll('[[fallthrough]];', '')
    .replace(/\bstatic_assert\s*\([^;]*\)\s*;/g, '')
    .replace(
      /machine\(\)\.scheduler\(\)\.synchronize\s*\(\s*timer_expired_delegate\s*\(\s*FUNC\(\s*[\w:]+::(\w+)\s*\)\s*,\s*this\s*\)\s*(?:,\s*([^;)]+))?\s*\)\s*;/g,
      (_match, method: string, argument: string | undefined) =>
        `${method}(${argument?.trim() || '0'});`,
    )
    .replaceAll('machine().side_effects_disabled()', 'false')
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
    /\b(?:static\s+)?constexpr\s+\w+\s+(\w+)\s*=\s*([^;]+);/g,
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
