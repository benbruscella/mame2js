import type {
  GeneratedExpression,
  GeneratedHandlerOperation,
} from '../runtime/generated-machine.ts';
import type {
  GeneratedDeviceDefinition,
  GeneratedDeviceMember,
  GeneratedDeviceMethod,
} from './device-compiler.ts';

interface EmitContext {
  definition: GeneratedDeviceDefinition;
  compiled: Set<string>;
  locals: Map<string, string | undefined>;
}

interface Target {
  code: string;
  valueType?: string;
  bits?: 1 | 8 | 16 | 32;
}

const SAFE_BINARY_OPERATORS = new Set([
  '|', '^', '&', '==', '!=', '<', '<=', '>', '>=',
  '<<', '>>', '+', '-', '*', '%', '&&', '||',
]);

/**
 * Emit direct JavaScript for expensive device methods. Selection is based on
 * IR shape rather than device identity: methods containing nested loops are
 * compiled together with the source-defined methods they call.
 */
export function generatedDeviceMethodsSource(
  definition: GeneratedDeviceDefinition,
  typescript = false,
): { source: string; methods: string[] } {
  const roots = definition.methods.filter(method =>
    method.program.diagnostics.length === 0 &&
    maximumLoopDepth(method.program.operations) >= 2);
  const selected = methodClosure(definition, roots);
  const compiled = new Set(selected.map(method => method.name));
  const supported = selected.filter(method => supportsMethod(method, definition, compiled));
  const supportedNames = new Set(supported.map(method => method.name));

  // A root may only call another compiled method directly when that dependency
  // also passed validation. Other calls retain the interpreter fallback.
  const functions = supported.map(method =>
    emitMethod(definition, method, supportedNames, typescript)).join('\n\n');
  const entries = supported.map(method =>
    `${JSON.stringify(method.name)}: method_${safeName(method.name)}`).join(',\n    ');
  const source = `(() => {
${functions}
  return {
    ${entries}
  };
})()`;
  return { source, methods: [...supportedNames] };
}

export function generatedDeviceExecutableSource(
  definition: GeneratedDeviceDefinition,
  dataFile: string,
): string {
  const emitted = generatedDeviceMethodsSource(definition, true);
  const compiled = emitted.methods.length
    ? `${emitted.source} as GeneratedDeviceMethodMap`
    : '{} as GeneratedDeviceMethodMap';
  return `// GENERATED from MAME device source; do not edit.
import type {
  GeneratedDeviceDefinition,
  GeneratedDeviceMethodMap,
} from '../../core/generated-device.js';
import deviceData from './${dataFile}' with { type: 'json' };

const definition = deviceData as unknown as GeneratedDeviceDefinition;
definition.compiledMethods = ${compiled};

export const device = definition;
export default device;
`;
}

function methodClosure(
  definition: GeneratedDeviceDefinition,
  roots: GeneratedDeviceMethod[],
): GeneratedDeviceMethod[] {
  const byName = new Map(definition.methods.map(method => [method.name, method]));
  const selected = new Map<string, GeneratedDeviceMethod>();
  const visit = (method: GeneratedDeviceMethod): void => {
    if (selected.has(method.name)) return;
    selected.set(method.name, method);
    for (const name of calledIdentifiers(method.program.operations)) {
      const dependency = byName.get(name);
      if (dependency && dependency.program.diagnostics.length === 0) visit(dependency);
    }
  };
  roots.forEach(visit);
  return [...selected.values()];
}

function calledIdentifiers(operations: GeneratedHandlerOperation[]): Set<string> {
  const names = new Set<string>();
  visitOperations(operations, operation => {
    visitOperationExpressions(operation, expression => {
      if (expression.kind === 'call' && expression.callee.kind === 'identifier') {
        names.add(expression.callee.name);
      }
    });
  });
  return names;
}

function maximumLoopDepth(
  operations: GeneratedHandlerOperation[],
  depth = 0,
): number {
  let maximum = depth;
  for (const operation of operations) {
    if (operation.op === 'for' || operation.op === 'while') {
      maximum = Math.max(maximum, maximumLoopDepth(operation.body, depth + 1));
    } else if (operation.op === 'if') {
      maximum = Math.max(
        maximum,
        maximumLoopDepth(operation.then, depth),
        maximumLoopDepth(operation.else ?? [], depth),
      );
    } else if (operation.op === 'switch') {
      for (const entry of operation.cases) {
        maximum = Math.max(maximum, maximumLoopDepth(entry.body, depth));
      }
    }
  }
  return maximum;
}

function supportsMethod(
  method: GeneratedDeviceMethod,
  definition: GeneratedDeviceDefinition,
  compiled: Set<string>,
): boolean {
  const locals = new Set(parseParameters(method.parameters).map(parameter => parameter.name));
  collectLocalNames(method.program.operations, locals);
  const members = new Set(definition.members.map(member => member.name));
  const constants = new Set(Object.keys(definition.constants));
  let supported = true;
  visitOperations(method.program.operations, operation => {
    visitOperationExpressions(operation, expression => {
      if (!supported) return;
      if (expression.kind === 'identifier') {
        supported = locals.has(expression.name) ||
          members.has(expression.name) ||
          constants.has(expression.name) ||
          ['true', 'false', 'nullptr'].includes(expression.name);
      } else if (expression.kind === 'unary') {
        supported = !['&', '*'].includes(expression.operator);
      } else if (expression.kind === 'binary') {
        supported = SAFE_BINARY_OPERATORS.has(expression.operator);
      } else if (expression.kind === 'call' && expression.callee.kind === 'identifier') {
        supported = compiled.has(expression.callee.name) ||
          ['BIT', 'BITSWAP', 'TABLE', 'bool', 'u8', 'uint8_t', 's8', 'int8_t',
            'u16', 'uint16_t', 's16', 'int16_t', 'u32', 'uint32_t',
            's32', 'int32_t'].includes(expression.callee.name);
      } else if (expression.kind === 'call' && expression.callee.kind === 'index') {
        supported = false;
      }
    });
  });
  return supported;
}

function emitMethod(
  definition: GeneratedDeviceDefinition,
  method: GeneratedDeviceMethod,
  compiled: Set<string>,
  typescript: boolean,
): string {
  const parameters = parseParameters(method.parameters);
  const context: EmitContext = {
    definition,
    compiled,
    locals: new Map(parameters.map(parameter => [parameter.name, parameter.valueType])),
  };
  collectLocals(method.program.operations, context.locals);
  const annotation = typescript ? ': any' : '';
  const args = parameters.map(parameter => `${parameter.name}${annotation}`).join(', ');
  return `  function method_${safeName(method.name)}(runtime${annotation}${args ? `, ${args}` : ''}) {
    const members = runtime.members;
${emitOperations(method.program.operations, context, 4)}
  }`;
}

function emitOperations(
  operations: GeneratedHandlerOperation[],
  context: EmitContext,
  indentation: number,
): string {
  return operations.map(operation => emitOperation(operation, context, indentation))
    .filter(Boolean)
    .join('\n');
}

function emitOperation(
  operation: GeneratedHandlerOperation,
  context: EmitContext,
  indentation: number,
): string {
  const pad = ' '.repeat(indentation);
  if (operation.op === 'declare') {
    const value = operation.value ? emitExpression(operation.value, context) : '0';
    return `${pad}let ${operation.name} = ${wrapType(value, operation.valueType)};`;
  }
  if (operation.op === 'assign') {
    return `${pad}${emitAssignment(operation.target, operation.operator, operation.value, context)};`;
  }
  if (operation.op === 'call') {
    return `${pad}${emitExpression(operation.expression, context)};`;
  }
  if (operation.op === 'return') {
    return `${pad}return${operation.value ? ` ${emitExpression(operation.value, context)}` : ''};`;
  }
  if (operation.op === 'break') return `${pad}break;`;
  if (operation.op === 'if') {
    const lines = [
      `${pad}if (${emitExpression(operation.condition, context)}) {`,
      emitOperations(operation.then, context, indentation + 2),
      `${pad}}`,
    ];
    if (operation.else) {
      lines[lines.length - 1] += ' else {';
      lines.push(emitOperations(operation.else, context, indentation + 2));
      lines.push(`${pad}}`);
    }
    return lines.filter(Boolean).join('\n');
  }
  if (operation.op === 'for') {
    const initialize = operation.initialize
      .map(item => emitOperation(item, context, 0).trim().replace(/;$/, ''))
      .map((part, index) => index > 0 && part.startsWith('let ') ? part.slice(4) : part)
      .join(', ');
    const iterate = emitOperation(operation.iterate, context, 0).trim().replace(/;$/, '');
    return [
      `${pad}for (${initialize}; ${emitExpression(operation.condition, context)}; ${iterate}) {`,
      emitOperations(operation.body, context, indentation + 2),
      `${pad}}`,
    ].filter(Boolean).join('\n');
  }
  if (operation.op === 'while') {
    return [
      `${pad}while (${emitExpression(operation.condition, context)}) {`,
      emitOperations(operation.body, context, indentation + 2),
      `${pad}}`,
    ].filter(Boolean).join('\n');
  }
  const lines = [`${pad}switch (${emitExpression(operation.expression, context)}) {`];
  for (const entry of operation.cases) {
    if (entry.values) {
      for (const value of entry.values) {
        lines.push(`${pad}  case ${emitExpression(value, context)}:`);
      }
    } else {
      lines.push(`${pad}  default:`);
    }
    lines.push(emitOperations(entry.body, context, indentation + 4));
  }
  lines.push(`${pad}}`);
  return lines.filter(Boolean).join('\n');
}

function emitExpression(expression: GeneratedExpression, context: EmitContext): string {
  if (expression.kind === 'number') return String(expression.value);
  if (expression.kind === 'string') return JSON.stringify(expression.value);
  if (expression.kind === 'identifier') {
    if (context.locals.has(expression.name)) return expression.name;
    if (expression.name === 'true') return '1';
    if (expression.name === 'false' || expression.name === 'nullptr') return '0';
    const constant = context.definition.constants[expression.name];
    if (constant !== undefined) return String(constant);
    return `members.${expression.name}`;
  }
  if (expression.kind === 'unary') {
    const operand = emitExpression(expression.operand, context);
    return expression.operator === '!' ? `((${operand}) ? 0 : 1)` : `(${expression.operator}${operand})`;
  }
  if (expression.kind === 'cast') {
    return wrapType(emitExpression(expression.operand, context), expression.valueType);
  }
  if (expression.kind === 'binary') {
    const left = emitExpression(expression.left, context);
    const right = emitExpression(expression.right, context);
    if (expression.operator === '&&' || expression.operator === '||') {
      return `(((${left}) ${expression.operator} (${right})) ? 1 : 0)`;
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(expression.operator)) {
      const operator = expression.operator === '==' ? '===' :
        expression.operator === '!=' ? '!==' : expression.operator;
      return `((Number(${left}) ${operator} Number(${right})) ? 1 : 0)`;
    }
    if (expression.operator === '>>') return `((${left}) >>> (${right}))`;
    return `((${left}) ${expression.operator} (${right}))`;
  }
  if (expression.kind === 'assignment') {
    const assignment = emitAssignment(
      expression.target,
      expression.operator,
      expression.value,
      context,
    );
    if (!expression.postfix) return `(${assignment})`;
    const target = targetInfo(expression.target, context);
    return `(() => { const previous = ${target.code}; ${assignment}; return previous; })()`;
  }
  if (expression.kind === 'conditional') {
    return `((${emitExpression(expression.condition, context)}) ? ` +
      `(${emitExpression(expression.whenTrue, context)}) : ` +
      `(${emitExpression(expression.whenFalse, context)}))`;
  }
  if (expression.kind === 'member') {
    return `${emitExpression(expression.object, context)}.${expression.property}`;
  }
  if (expression.kind === 'index') {
    return `${emitExpression(expression.object, context)}[${emitExpression(expression.index, context)}]`;
  }
  return emitCall(expression, context);
}

function emitCall(
  expression: Extract<GeneratedExpression, { kind: 'call' }>,
  context: EmitContext,
): string {
  const args = expression.args.map(argument => emitExpression(argument, context));
  if (expression.callee.kind === 'identifier') {
    const name = expression.callee.name;
    if (context.compiled.has(name)) {
      return `method_${safeName(name)}(runtime${args.length ? `, ${args.join(', ')}` : ''})`;
    }
    if (name === 'BIT') {
      const mask = args[2] ? `((1 << (${args[2]})) - 1)` : '1';
      return `(((${args[0] ?? '0'}) >>> (${args[1] ?? '0'})) & ${mask})`;
    }
    if (name === 'BITSWAP') {
      const source = args[0] ?? '0';
      const bits = args.slice(1);
      return `(${bits.map((bit, index) =>
        `(((${source}) >>> (${bit})) & 1) << ${bits.length - index - 1}`).join(' | ') || '0'})`;
    }
    if (name === 'TABLE') {
      const index = args[0] ?? '0';
      const values = args.slice(1);
      return `([${values.join(', ')}][(((${index}) % ${values.length}) + ${values.length}) % ` +
        `${values.length}] ?? 0)`;
    }
    if (name === 'bool') return `((${args[0] ?? '0'}) ? 1 : 0)`;
    if (['u8', 'uint8_t', 's8', 'int8_t', 'u16', 'uint16_t',
      's16', 'int16_t', 'u32', 'uint32_t', 's32', 'int32_t'].includes(name)) {
      return wrapType(args[0] ?? '0', name);
    }
    return `runtime.invoke(${JSON.stringify(name)}${args.length ? `, ${args.join(', ')}` : ''})`;
  }
  if (expression.callee.kind === 'member') {
    const object = emitExpression(expression.callee.object, context);
    return `${object}.${expression.callee.property}(${args.join(', ')})`;
  }
  throw new Error('device codegen does not support indexed callable expressions');
}

function emitAssignment(
  expression: GeneratedExpression,
  operator: string,
  value: GeneratedExpression,
  context: EmitContext,
): string {
  const right = emitExpression(value, context);
  if (expression.kind === 'call') {
    if (operator !== '=' || expression.callee.kind !== 'member') {
      throw new Error('device codegen only supports assignment to member call results');
    }
    const object = emitExpression(expression.callee.object, context);
    const args = expression.args.map(argument => emitExpression(argument, context));
    return `${object}[${JSON.stringify(`${expression.callee.property}=`)}](` +
      `${[...args, right].join(', ')})`;
  }
  const target = targetInfo(expression, context);
  const next = operator === '='
    ? right
    : `((${target.code}) ${operator.slice(0, -1)} (${right}))`;
  return `${target.code} = ${wrapTarget(next, target)}`;
}

function targetInfo(expression: GeneratedExpression, context: EmitContext): Target {
  if (expression.kind === 'identifier') {
    if (context.locals.has(expression.name)) {
      return { code: expression.name, valueType: context.locals.get(expression.name) };
    }
    const member = context.definition.members.find(candidate => candidate.name === expression.name);
    if (member) return { code: `members.${member.name}`, bits: member.bits };
  }
  if (expression.kind === 'index') {
    return {
      code: `${emitExpression(expression.object, context)}[${emitExpression(expression.index, context)}]`,
    };
  }
  if (expression.kind === 'member') {
    return {
      code: `${emitExpression(expression.object, context)}.${expression.property}`,
    };
  }
  throw new Error(`device codegen has unsupported assignment target "${expression.kind}"`);
}

function parseParameters(parameters: string): { name: string; valueType: string }[] {
  return parameters.split(',').map(parameter => parameter.trim()).filter(Boolean).map(parameter => {
    const name = /(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter)?.[1];
    if (!name) throw new Error(`cannot emit device parameter "${parameter}"`);
    return {
      name,
      valueType: parameter.slice(0, parameter.lastIndexOf(name)).trim(),
    };
  });
}

function collectLocals(
  operations: GeneratedHandlerOperation[],
  locals: Map<string, string | undefined>,
): void {
  visitOperations(operations, operation => {
    if (operation.op === 'declare') locals.set(operation.name, operation.valueType);
  });
}

function collectLocalNames(
  operations: GeneratedHandlerOperation[],
  locals: Set<string>,
): void {
  visitOperations(operations, operation => {
    if (operation.op === 'declare') locals.add(operation.name);
  });
}

function visitOperations(
  operations: GeneratedHandlerOperation[],
  visit: (operation: GeneratedHandlerOperation) => void,
): void {
  for (const operation of operations) {
    visit(operation);
    if (operation.op === 'if') {
      visitOperations(operation.then, visit);
      visitOperations(operation.else ?? [], visit);
    } else if (operation.op === 'for' || operation.op === 'while') {
      if (operation.op === 'for') visitOperations(operation.initialize, visit);
      visitOperations(operation.body, visit);
      if (operation.op === 'for') visitOperations([operation.iterate], visit);
    } else if (operation.op === 'switch') {
      for (const entry of operation.cases) visitOperations(entry.body, visit);
    }
  }
}

function visitOperationExpressions(
  operation: GeneratedHandlerOperation,
  visit: (expression: GeneratedExpression) => void,
): void {
  if (operation.op === 'declare' && operation.value) visitExpression(operation.value, visit);
  else if (operation.op === 'assign') {
    visitExpression(operation.target, visit);
    visitExpression(operation.value, visit);
  } else if (operation.op === 'call') visitExpression(operation.expression, visit);
  else if (operation.op === 'return' && operation.value) visitExpression(operation.value, visit);
  else if (operation.op === 'if' || operation.op === 'while') {
    visitExpression(operation.condition, visit);
  } else if (operation.op === 'for') {
    visitExpression(operation.condition, visit);
  } else if (operation.op === 'switch') visitExpression(operation.expression, visit);
}

function visitExpression(
  expression: GeneratedExpression,
  visit: (expression: GeneratedExpression) => void,
): void {
  visit(expression);
  if (expression.kind === 'unary' || expression.kind === 'cast') {
    visitExpression(expression.operand, visit);
  } else if (expression.kind === 'binary') {
    visitExpression(expression.left, visit);
    visitExpression(expression.right, visit);
  } else if (expression.kind === 'assignment') {
    visitExpression(expression.target, visit);
    visitExpression(expression.value, visit);
  } else if (expression.kind === 'conditional') {
    visitExpression(expression.condition, visit);
    visitExpression(expression.whenTrue, visit);
    visitExpression(expression.whenFalse, visit);
  } else if (expression.kind === 'member') {
    visitExpression(expression.object, visit);
  } else if (expression.kind === 'index') {
    visitExpression(expression.object, visit);
    visitExpression(expression.index, visit);
  } else if (expression.kind === 'call') {
    if (expression.callee.kind === 'member') {
      visitExpression(expression.callee.object, visit);
    } else if (expression.callee.kind === 'index') {
      visitExpression(expression.callee, visit);
    }
    expression.args.forEach(argument => visitExpression(argument, visit));
  }
}

function wrapTarget(value: string, target: Target): string {
  return target.bits ? wrapBits(value, target.bits) : wrapType(value, target.valueType);
}

function wrapBits(value: string, bits?: 1 | 8 | 16 | 32): string {
  if (bits === 1) return `((${value}) ? 1 : 0)`;
  if (bits === 8) return `((${value}) & 0xff)`;
  if (bits === 16) return `((${value}) & 0xffff)`;
  if (bits === 32) return `((${value}) >>> 0)`;
  return value;
}

function wrapType(value: string, valueType?: string): string {
  const normalized = valueType?.replace(/\bconst\b/g, '').replace(/[&*]/g, '').trim();
  if (normalized === 'bool') return `((${value}) ? 1 : 0)`;
  if (normalized === 'u8' || normalized === 'uint8_t') return `((${value}) & 0xff)`;
  if (normalized === 's8' || normalized === 'int8_t' || normalized === 'char') {
    return `((${value}) << 24 >> 24)`;
  }
  if (normalized === 'u16' || normalized === 'uint16_t') return `((${value}) & 0xffff)`;
  if (normalized === 's16' || normalized === 'int16_t') return `((${value}) << 16 >> 16)`;
  if (normalized === 'u32' || normalized === 'uint32_t') return `((${value}) >>> 0)`;
  if (normalized === 's32' || normalized === 'int32_t') return `((${value}) | 0)`;
  return value;
}

function safeName(name: string): string {
  return name.replace(/\W/g, '_');
}
