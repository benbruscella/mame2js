import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { evalExpr } from '../kg/parse.ts';
import type {
  GeneratedHandlerProgram,
  GeneratedSourceRef,
} from '../runtime/generated-machine.ts';
import {
  parseMameAst,
  splitMameArgs,
  type MameClass,
  type MameFunction,
} from './ast.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';
import { compileMameHandler } from './handler-ir.ts';
import type { MameHardwareDefinition } from './hardware.ts';

export interface GeneratedDeviceMember {
  name: string;
  valueType: string;
  bits?: 1 | 8 | 16 | 32;
  signed?: boolean;
  initial?: number;
  values?: number[];
}

export interface GeneratedDeviceCallback {
  signal: string;
  member: string;
  slots: number;
  initial?: number;
}

export interface GeneratedDeviceTimer {
  member: string;
  callback: string;
}

export interface GeneratedDeviceMethod {
  name: string;
  parameters: string;
  program: GeneratedHandlerProgram;
  source: GeneratedSourceRef;
}

export interface GeneratedDeviceDefinition {
  schemaVersion: 1;
  type: string;
  className: string;
  hierarchy: string[];
  sourceFiles: string[];
  constants: Record<string, number>;
  members: GeneratedDeviceMember[];
  callbacks: GeneratedDeviceCallback[];
  timers: GeneratedDeviceTimer[];
  methods: GeneratedDeviceMethod[];
  /** Ratio between the configured input clock and one execute_run cycle. */
  clockDivider?: number;
  start?: string;
  reset?: string;
  summary: {
    methods: number;
    compiledMethods: number;
    diagnostics: number;
  };
}

/**
 * Compile a MAME device class and its MAME-defined base classes into the
 * hardware-neutral executable-device IR.
 */
export function compileMameDevice(
  mameSrc: string,
  definition: MameHardwareDefinition,
  type = definition.type,
): GeneratedDeviceDefinition {
  const sourceFiles = localSourceFiles(mameSrc, definition.sourceFile);
  const sources = sourceFiles.map(file => ({
    file,
    source: readFileSync(join(mameSrc, file), 'utf8'),
  }));
  const ast = parseMameAst(sources);
  const classes = new Map(
    ast.units.flatMap(unit => unit.classes).map(declaration => [declaration.name, declaration]),
  );
  const hierarchy = classHierarchy(definition.className, classes);
  const classSet = new Set(hierarchy);
  const constants = Object.assign(
    {},
    ...sources.map(({ source }) => numericConstants(source)),
  );
  const sourceTables = Object.assign(
    {},
    ...sources.map(({ source }) => constantTables(source)),
  );
  const interruptCallbacks = sources.flatMap(({ source }) => [...source.matchAll(
    /\b(m_\w+)->set_input_line\s*\(\s*(INPUT_LINE_\w+)/g,
  )].map(match => ({
    member: match[1]!,
    line: match[2]!,
    signal: match[2] === 'INPUT_LINE_NMI' ? 'nmi' : 'irq',
  })));
  const ignoredMethods = new Set([
    'device_add_mconfig',
    'device_rom_region',
    'memory_space_config',
    'create_disassembler',
    // Browser persistence is a host concern. Device state and default bytes
    // remain source-derived, but MAME stream serialization is not executable
    // device behavior.
    'nvram_default',
    'nvram_read',
    'nvram_write',
  ]);
  const methods = ast.units
    .flatMap(unit => unit.functions)
    .filter(method => classSet.has(method.className))
    .filter(method => !ignoredMethods.has(method.name))
    .map(method => compileMethod(method, interruptCallbacks, sourceTables));

  for (const className of hierarchy) {
    const declaration = classes.get(className);
    if (!declaration) continue;
    for (const method of inlineMethods(declaration)) {
      if (methods.some(candidate =>
        candidate.name === method.name && candidate.parameters === method.parameters)) continue;
      if (ignoredMethods.has(method.name)) continue;
      methods.push(compileMethod(method, interruptCallbacks, sourceTables));
    }
  }

  const callbacks: GeneratedDeviceCallback[] = [];
  const allocatedArrays = allocatedMemberArrays(
    sources.map(source => source.source).join('\n'),
    constants,
  );
  const fixedArrays = fixedMemberArrays(
    [...classes.values()].map(declaration => declaration.body).join('\n'),
    constants,
  );
  const members: GeneratedDeviceMember[] = hierarchy.flatMap(className => {
    const declaration = classes.get(className);
    if (!declaration) return [];
    return memberDeclarations(declaration).flatMap(member => {
      if (member.valueType.startsWith('devcb_')) {
        callbacks.push({
          signal: member.name.replace(/^m_/, ''),
          member: member.name,
          slots: callbackSlots(member.valueType),
          initial: member.valueType.startsWith('devcb_read8') ? 0xff : 0,
        });
        return [];
      }
      const bits = integerBits(member.valueType);
      const signed = integerSigned(member.valueType);
      const allocated = allocatedArrays.get(member.name) ?? fixedArrays.get(member.name);
      return [{
        name: member.name,
        valueType: member.valueType,
        ...(bits ? { bits } : {}),
        ...(signed ? { signed } : {}),
        ...(allocated ? { values: allocated } : {}),
      }];
    });
  });
  for (const className of hierarchy) {
    const body = classes.get(className)?.body ?? '';
    for (const accessor of body.matchAll(
      /\bauto\s+(\w+)\s*\([^)]*\)\s*\{\s*return\s+(m_\w+)(?:\[[^\]]+\])?\.bind\s*\(\s*\)\s*;\s*\}/g,
    )) {
      const callback = callbacks.find(candidate => candidate.member === accessor[2]);
      if (callback) callback.signal = accessor[1]!;
    }
  }
  for (const callback of interruptCallbacks) {
    if (callbacks.some(candidate => candidate.signal === callback.signal)) continue;
    callbacks.push({
      signal: callback.signal,
      member: `m_${callback.signal}`,
      slots: 1,
      initial: 0,
    });
  }
  const constructorValues = constructorInitialValues(
    definition.className,
    sources.map(source => source.source).join('\n'),
    constants,
  );
  for (const member of members) {
    if (constructorValues[member.name] !== undefined) {
      member.initial = constructorValues[member.name];
    }
  }
  const timers = sources.flatMap(({ source }) => [...source.matchAll(
    /\b(m_\w+)\s*=\s*timer_alloc\s*\(\s*FUNC\(\s*\w+::(\w+)\s*\)/g,
  )].map(match => ({ member: match[1]!, callback: match[2]! })));
  const diagnostics = methods.reduce(
    (count, method) => count + method.program.diagnostics.length,
    0,
  );
  return {
    schemaVersion: 1,
    type,
    className: definition.className,
    hierarchy,
    sourceFiles,
    constants,
    members,
    callbacks,
    timers,
    methods,
    ...(executionClockDivider(sources.map(source => source.source).join('\n'))
      ? { clockDivider: executionClockDivider(sources.map(source => source.source).join('\n')) }
      : {}),
    ...(methods.some(method => method.name === 'device_start') ? { start: 'device_start' } : {}),
    ...(methods.some(method => method.name === 'device_reset') ? { reset: 'device_reset' } : {}),
    summary: {
      methods: methods.length,
      compiledMethods: methods.filter(method => !method.program.diagnostics.length).length,
      diagnostics,
    },
  };
}

export function mameDeviceRomSet(
  mameSrc: string,
  sourceFile: string,
  className: string,
): string | undefined {
  const source = readFileSync(join(mameSrc, sourceFile), 'utf8');
  const method = parseMameAst([{ file: sourceFile, source }]).units
    .flatMap(unit => unit.functions)
    .find(candidate =>
      candidate.className === className && candidate.name === 'device_rom_region');
  const scoped = method && /\bROM_NAME\s*\(\s*(\w+)\s*\)/.exec(method.body)?.[1];
  if (scoped) return scoped;
  const fallback = new RegExp(
    `${className}::device_rom_region[\\s\\S]*?ROM_NAME\\s*\\(\\s*(\\w+)\\s*\\)`,
  ).exec(source);
  return fallback?.[1];
}

function executionClockDivider(source: string): number | undefined {
  const match = /execute_cycles_to_clocks\s*\([^)]*\)[^{]*\{[^}]*return\s*\([^;]*\*\s*(\d+)\s*\)/s
    .exec(source);
  const divider = Number(match?.[1]);
  return Number.isInteger(divider) && divider > 0 ? divider : undefined;
}

function localSourceFiles(mameSrc: string, sourceFile: string): string[] {
  const absolute = join(mameSrc, sourceFile);
  const header = join(dirname(absolute), `${basename(absolute, extname(absolute))}.h`);
  return [sourceFile, relative(mameSrc, header)];
}

function classHierarchy(
  className: string,
  classes: Map<string, MameClass>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const declaration = classes.get(name);
    for (const base of declaration?.bases ?? []) {
      const unqualified = base.split('::').at(-1)!;
      if (classes.has(unqualified)) visit(unqualified);
    }
    if (declaration) result.push(name);
  };
  visit(className);
  return result;
}

function compileMethod(
  method: MameFunction,
  interruptCallbacks: { member: string; line: string; signal: string }[] = [],
  sourceTables: Record<string, string[]> = {},
): GeneratedDeviceMethod {
  let body = method.body.replace(
    /\bm_\w+\s*=\s*std::make_unique\s*<[^;]+;\s*/g,
    '',
  );
  for (const callback of interruptCallbacks) {
    body = body.replace(
      new RegExp(
        `${callback.member}->set_input_line\\s*\\(\\s*${callback.line}\\s*,\\s*` +
        '([^;]+)\\)',
        'g',
      ),
      `m_${callback.signal}($1)`,
    );
  }
  for (const [name, values] of Object.entries(sourceTables)) {
    body = body.replace(
      new RegExp(`\\b${name}\\s*\\[([^\\]]+)\\]`, 'g'),
      (_entry, index: string) => `TABLE(${index}, ${values.join(', ')})`,
    );
  }
  return {
    name: method.name,
    parameters: method.parameters,
    program: compileMameHandler(normalizeMameExecutionSource(body)),
    source: {
      file: method.span.file,
      line: method.span.line,
      column: method.span.column,
    },
  };
}

function inlineMethods(declaration: MameClass): MameFunction[] {
  const methods: MameFunction[] = [];
  const source = declaration.body;
  const masked = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, match =>
    match.replace(/[^\r\n]/g, ' '));
  const pattern =
    /(?:^|\n)\s*(?:template\s*<[^>{}]+>\s*)?(?:[\w:<>,~*&]+\s+)+(\w+)\s*\(([^;{}]*)\)\s*(?:const\s*)?\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const braceStart = masked.indexOf('{', match.index + match[0].length - 1);
    const braceEnd = matchingBrace(masked, braceStart);
    if (braceEnd < 0) continue;
    const absoluteStart = declaration.bodySpan.start + match.index;
    const bodyStart = declaration.bodySpan.start + braceStart + 1;
    const bodyEnd = declaration.bodySpan.start + braceEnd;
    const line = declaration.bodySpan.line + source.slice(0, match.index).split('\n').length - 1;
    const bodyLine = declaration.bodySpan.line + source.slice(0, braceStart + 1).split('\n').length - 1;
    methods.push({
      kind: 'function',
      className: declaration.name,
      name: match[1]!,
      parameters: source.slice(
        masked.indexOf('(', match.index) + 1,
        matchingPair(masked, masked.indexOf('(', match.index), '(', ')'),
      ),
      body: source.slice(braceStart + 1, braceEnd),
      statements: [],
      span: {
        file: declaration.span.file,
        start: absoluteStart,
        end: declaration.bodySpan.start + braceEnd + 1,
        line,
        column: 1,
        endLine: line + source.slice(match.index, braceEnd + 1).split('\n').length - 1,
        endColumn: 1,
      },
      bodySpan: {
        file: declaration.span.file,
        start: bodyStart,
        end: bodyEnd,
        line: bodyLine,
        column: 1,
        endLine: bodyLine + source.slice(braceStart + 1, braceEnd).split('\n').length - 1,
        endColumn: 1,
      },
    });
    pattern.lastIndex = braceEnd + 1;
  }
  return methods;
}

function memberDeclarations(
  declaration: MameClass,
): { name: string; valueType: string }[] {
  const members: { name: string; valueType: string }[] = [];
  const patterns = [
    /^\s*((?:const\s+)?[\w:]+(?:\s+const)?(?:::\w+<\d+>)?)\s+(m_\w+)\s*(?:\[[^\]]+\])?\s*;/gm,
    /^\s*((?:const\s+)?[\w:]+<[^;\r\n]+>)\s+(m_\w+)\s*;/gm,
  ];
  for (const pattern of patterns) {
    for (const match of declaration.body.matchAll(pattern)) {
      if (members.some(member => member.name === match[2])) continue;
      members.push({
        valueType: match[1]!.replace(/\s+/g, ' ').trim(),
        name: match[2]!,
      });
    }
  }
  return members;
}

function callbackSlots(valueType: string): number {
  return Number(/::array<(\d+)>/.exec(valueType)?.[1] ?? 1);
}

function integerBits(valueType: string): 1 | 8 | 16 | 32 | undefined {
  const normalized = valueType.replace(/\bconst\b/g, '').trim();
  if (normalized === 'bool') return 1;
  if (['u8', 's8', 'uint8_t', 'int8_t', 'char'].includes(normalized)) return 8;
  if (['u16', 's16', 'uint16_t', 'int16_t'].includes(normalized)) return 16;
  if (['u32', 's32', 'uint32_t', 'int32_t', 'int', 'unsigned'].includes(normalized)) return 32;
  return undefined;
}

function integerSigned(valueType: string): boolean {
  const normalized = valueType.replace(/\bconst\b/g, '').trim();
  return ['s8', 'int8_t', 'char', 's16', 'int16_t', 's32', 'int32_t', 'int'].includes(normalized);
}

interface Constructor {
  className: string;
  parameters: string[];
  initializers: { name: string; args: string[] }[];
}

function constructorInitialValues(
  concreteClass: string,
  source: string,
  constants: Record<string, number> = {},
): Record<string, number> {
  const constructors = new Map<string, Constructor>();
  const pattern = /\b(\w+)::\1\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('(', match.index);
    const close = matchingPair(source, open, '(', ')');
    if (close < 0) continue;
    const brace = source.indexOf('{', close + 1);
    if (brace < 0) continue;
    const between = source.slice(close + 1, brace).trim();
    const initializerSource = between.startsWith(':') ? between.slice(1) : '';
    constructors.set(match[1]!, {
      className: match[1]!,
      parameters: splitMameArgs(source.slice(open + 1, close)).map(parameterName),
      initializers: splitMameArgs(initializerSource).flatMap(initializer => {
        const parsed = /^(\w+)\s*\(([\s\S]*)\)$/.exec(initializer.trim());
        return parsed ? [{ name: parsed[1]!, args: splitMameArgs(parsed[2]!) }] : [];
      }),
    });
    pattern.lastIndex = brace + 1;
  }
  const result: Record<string, number> = {};
  const visit = (className: string, values: number[] = []): void => {
    const constructor = constructors.get(className);
    if (!constructor) return;
    const env = Object.fromEntries(
      constructor.parameters.map((parameter, index) => [parameter, values[index] ?? 0]),
    );
    for (const initializer of constructor.initializers) {
      const args = initializer.args.map(arg => constantValue(arg, { ...constants, ...env }));
      if (constructors.has(initializer.name)) visit(initializer.name, args);
      else if (initializer.name.startsWith('m_') && args.length === 1) {
        result[initializer.name] = args[0]!;
      }
    }
  };
  visit(concreteClass);
  return result;
}

function parameterName(parameter: string): string {
  return /(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter.trim())?.[1] ?? parameter.trim();
}

function constantValue(expression: string, env: Record<string, number>): number {
  const value = expression.trim();
  if (value === 'true') return 1;
  if (value === 'false' || value === 'nullptr') return 0;
  if (env[value] !== undefined) return env[value];
  if (/^0x[\da-f]+$/i.test(value)) return Number.parseInt(value, 16);
  if (/^-?\d+$/.test(value)) return Number(value);
  return 0;
}

function numericConstants(source: string): Record<string, number> {
  const expressions = new Map<string, string>();
  for (const match of source.matchAll(/^\s*#define\s+(\w+)\s+([^\r\n/]+)/gmi)) {
    expressions.set(match[1]!, match[2]!.trim());
  }
  for (const match of source.matchAll(
    /\b(?:static\s+)?constexpr\s+(?:\w+\s+)+(\w+)\s*=\s*([^;]+);/g,
  )) {
    expressions.set(match[1]!, match[2]!.trim());
  }
  const constants: Record<string, number> = {};
  for (let pass = 0; pass <= expressions.size; pass++) {
    for (const [name, expression] of expressions) {
      if (constants[name] !== undefined) continue;
      const substituted = expression.replace(
        /\b[A-Za-z_]\w*\b/g,
        token => constants[token] !== undefined ? String(constants[token]) : token,
      );
      const value = evalExpr(substituted, constants);
      if (value !== null && Number.isFinite(value)) constants[name] = value;
    }
  }
  return constants;
}

function allocatedMemberArrays(
  source: string,
  constants: Record<string, number>,
): Map<string, number[]> {
  const arrays = new Map<string, number[]>();
  for (const allocation of source.matchAll(
    /\b(m_\w+)\s*=\s*std::make_unique\s*<[^>]*\[\]>\s*\(([^)]+)\)\s*;/g,
  )) {
    const count = evalExpr(allocation[2]!.trim(), constants);
    if (count === null || !Number.isInteger(count) || count <= 0) continue;
    const fill = new RegExp(
      `std::fill_n\\s*\\(\\s*&${allocation[1]}\\[0\\]\\s*,\\s*` +
      `[^,]+,\\s*([^\\)]+)\\)`,
    ).exec(source);
    const initial = fill ? evalExpr(fill[1]!.trim(), constants) : 0;
    arrays.set(
      allocation[1]!,
      Array.from({ length: count }, () => initial ?? 0),
    );
  }
  return arrays;
}

function fixedMemberArrays(
  source: string,
  constants: Record<string, number>,
): Map<string, number[]> {
  const arrays = new Map<string, number[]>();
  for (const declaration of source.matchAll(
    /^\s*(?:const\s+)?[\w:]+\s+(m_\w+)\s*\[([^\]]+)\]\s*;/gm,
  )) {
    const count = evalExpr(declaration[2]!.trim(), constants);
    if (count === null || !Number.isInteger(count) || count <= 0) continue;
    arrays.set(declaration[1]!, Array.from({ length: count }, () => 0));
  }
  return arrays;
}

function constantTables(source: string): Record<string, string[]> {
  return Object.fromEntries([...source.matchAll(
    /\bstatic\s+const\s+\w+\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^{}]+)\}\s*;/g,
  )].map(match => [
    match[1]!,
    splitMameArgs(match[2]!).map(value => value.trim()),
  ]));
}

function matchingBrace(source: string, open: number): number {
  return matchingPair(source, open, '{', '}');
}

function matchingPair(source: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === left) depth++;
    else if (source[index] === right && --depth === 0) return index;
  }
  return -1;
}
