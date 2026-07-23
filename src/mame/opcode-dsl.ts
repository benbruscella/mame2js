export interface OpcodeDslSourceRef {
  file: string;
  line: number;
}

export interface OpcodeDslOperation {
  text: string;
  kind: 'statement' | 'cycle' | 'interruptible-access' | 'directive';
  cycles?: string;
  source: OpcodeDslSourceRef;
  expandedFrom?: {
    macro: string;
    definition: OpcodeDslSourceRef;
    call: OpcodeDslSourceRef;
  }[];
}

export interface OpcodeDslMacro {
  name: string;
  parameters: string[];
  source: OpcodeDslSourceRef;
  operations: OpcodeDslOperation[];
}

export interface OpcodeDslOpcode {
  key: string;
  prefix: string;
  code: string;
  description?: string;
  source: OpcodeDslSourceRef;
  operations: OpcodeDslOperation[];
}

export interface Z80OpcodeDsl {
  schemaVersion: 1;
  dialect: 'mame-z80-lst';
  sourceFile: string;
  macros: OpcodeDslMacro[];
  opcodes: OpcodeDslOpcode[];
  prefixes: Record<string, number>;
  diagnostics: string[];
}

interface Definition {
  kind: 'macro' | 'opcode' | 'ignored';
  variant?: string;
  name: string;
  parameters: string[];
  key?: string;
  prefix?: string;
  code?: string;
  description?: string;
  source: OpcodeDslSourceRef;
  operations: OpcodeDslOperation[];
}

/**
 * Parse MAME's z80.lst generator DSL. This intentionally follows z80make.py's
 * generic-Z80 variant selection and macro precedence, while retaining source
 * locations and expansion provenance for generated TypeScript.
 */
export function parseZ80OpcodeDsl(file: string, source: string): Z80OpcodeDsl {
  const definitions: Definition[] = [];
  const macros = new Map<string, Definition>();
  const opcodes = new Map<string, Definition>();
  const diagnostics: string[] = [];
  const lines = source.split(/\r?\n/);
  let current: Definition | undefined;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (!trimmed || (trimmed.startsWith('#') &&
      !trimmed.startsWith('#if') &&
      !trimmed.startsWith('#endif'))) continue;
    const indented = /^\s/.test(raw) || trimmed.startsWith('{') || trimmed.startsWith('}');
    if (indented) {
      if (!current || current.kind === 'ignored') continue;
      const operation = operationFromLine(file, index + 1, trimmed);
      if (current.kind === 'macro') {
        current.operations.push(operation);
      } else {
        current.operations.push(...expandOperation(operation, macros, diagnostics, []));
      }
      continue;
    }

    const [head, ...tail] = trimmed.split(/\s+/);
    if (head === 'macro') {
      const qualified = tail.shift() ?? '';
      const [variant, name] = splitVariant(qualified);
      current = {
        kind: variant && variant !== 'z80' ? 'ignored' : 'macro',
        variant,
        name,
        parameters: tail,
        source: { file, line: index + 1 },
        operations: [],
      };
      definitions.push(current);
      if (current.kind === 'macro') {
        const existing = macros.get(name);
        if (!variant || variant === 'z80' || !existing) macros.set(name, current);
      }
      continue;
    }

    const [variant, key] = splitVariant(head);
    if (variant && variant !== 'z80') {
      current = {
        kind: 'ignored',
        variant,
        name: key,
        parameters: [],
        source: { file, line: index + 1 },
        operations: [],
      };
      continue;
    }
    const prefix = key.slice(0, 2).toLowerCase();
    const code = key.slice(2).toLowerCase();
    if (!/^[0-9a-f]{2}$/.test(prefix) || !/^[0-9a-f]{2}$/.test(code)) {
      diagnostics.push(`${file}:${index + 1}: invalid opcode key ${key}`);
    }
    const commentAt = raw.indexOf('#');
    current = {
      kind: 'opcode',
      variant,
      name: key,
      parameters: [],
      key: key.toLowerCase(),
      prefix,
      code,
      ...(commentAt >= 0 ? { description: raw.slice(commentAt + 1).trim() } : {}),
      source: { file, line: index + 1 },
      operations: [],
    };
    definitions.push(current);
    opcodes.set(key.toLowerCase(), current);
  }

  const parsedMacros = definitions
    .filter((definition): definition is Definition & { kind: 'macro' } =>
      definition.kind === 'macro' && macros.get(definition.name) === definition)
    .map(definition => ({
      name: definition.name,
      parameters: definition.parameters,
      source: definition.source,
      operations: definition.operations,
    }));
  const parsedOpcodes = [...opcodes.values()]
    .sort((left, right) => left.key!.localeCompare(right.key!))
    .map(definition => ({
      key: definition.key!,
      prefix: definition.prefix!,
      code: definition.code!,
      ...(definition.description ? { description: definition.description } : {}),
      source: definition.source,
      operations: definition.operations,
    }));
  return {
    schemaVersion: 1,
    dialect: 'mame-z80-lst',
    sourceFile: file,
    macros: parsedMacros,
    opcodes: parsedOpcodes,
    prefixes: Object.fromEntries(
      [...new Set(parsedOpcodes.map(opcode => opcode.prefix))]
        .sort()
        .map(prefix => [prefix, parsedOpcodes.filter(opcode => opcode.prefix === prefix).length]),
    ),
    diagnostics,
  };
}

function splitVariant(value: string): [string | undefined, string] {
  const colon = value.indexOf(':');
  return colon < 0
    ? [undefined, value]
    : [value.slice(0, colon), value.slice(colon + 1)];
}

function operationFromLine(file: string, line: number, text: string): OpcodeDslOperation {
  const interruptible = /^(.+?)\s+!!\s+([\s\S]+)$/.exec(text);
  if (interruptible) {
    return {
      text: interruptible[2]!,
      kind: 'interruptible-access',
      cycles: interruptible[1]!.trim(),
      source: { file, line },
    };
  }
  const cycle = /^\+\s+(.+)$/.exec(text);
  if (cycle) {
    return {
      text,
      kind: 'cycle',
      cycles: cycle[1]!.trim(),
      source: { file, line },
    };
  }
  return {
    text,
    kind: text.startsWith('#') ? 'directive' : 'statement',
    source: { file, line },
  };
}

function expandOperation(
  operation: OpcodeDslOperation,
  macros: Map<string, Definition>,
  diagnostics: string[],
  stack: string[],
): OpcodeDslOperation[] {
  const repeated = /^(\d+)\s+\*\s+(@[\s\S]+)$/.exec(operation.text);
  if (repeated) {
    return Array.from({ length: Number(repeated[1]) }, () =>
      expandOperation({ ...operation, text: repeated[2]! }, macros, diagnostics, stack),
    ).flat();
  }
  const call = /^@(\w+)(?:\s+([\s\S]+))?$/.exec(operation.text);
  if (!call) return [operation];
  const name = call[1]!;
  const macro = macros.get(name);
  if (!macro) {
    diagnostics.push(`${operation.source.file}:${operation.source.line}: unknown macro @${name}`);
    return [operation];
  }
  if (stack.includes(name)) {
    diagnostics.push(`${operation.source.file}:${operation.source.line}: recursive macro @${name}`);
    return [operation];
  }
  const args = splitMacroArgs(call[2] ?? '', macro.parameters.length);
  if (args.length !== macro.parameters.length) {
    diagnostics.push(
      `${operation.source.file}:${operation.source.line}: @${name} expects ` +
      `${macro.parameters.length} args, got ${args.length}`,
    );
  }
  const expansion = {
    macro: name,
    definition: macro.source,
    call: operation.source,
  };
  return macro.operations.flatMap(template => {
    let text = template.text;
    macro.parameters.forEach((parameter, index) => {
      text = text.replaceAll(parameter, args[index] ?? '');
    });
    return expandOperation({
      ...template,
      text,
      expandedFrom: [...(operation.expandedFrom ?? []), expansion],
    }, macros, diagnostics, [...stack, name]);
  });
}

function splitMacroArgs(value: string, count: number): string[] {
  if (count === 0) return value.trim() ? [value.trim()] : [];
  if (count === 1) return [value.trim()];
  const comma = value.split(',').map(part => part.trim());
  if (comma.length === count) return comma;
  return value.trim().split(/\s+/).slice(0, count);
}
