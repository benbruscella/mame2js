import { maskComments } from './ast.ts';
import type {
  GeneratedExpression,
  GeneratedHandlerOperation,
  GeneratedHandlerProgram,
} from '../runtime/generated-machine.ts';

interface Token {
  kind: 'identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'eof';
  text: string;
  offset: number;
}

const TYPE_WORDS = new Set([
  'auto', 'bool', 'char', 'const', 'int', 'offs_t', 'pen_t',
  's8', 's16', 's32', 'u8', 'u16', 'u32',
  'int8_t', 'int16_t', 'int32_t', 'uint8_t', 'uint16_t', 'uint32_t', 'unsigned',
]);

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '&=', '|=', '^=', '<<=', '>>=']);

/**
 * Compile the deliberately small C++ subset used by MAME driver handlers.
 * Unsupported constructs remain attached as diagnostics; callers must not
 * guess at their behavior.
 */
export function compileMameHandler(body: string): GeneratedHandlerProgram {
  const parser = new HandlerParser(tokenize(body));
  return parser.parse();
}

class HandlerParser {
  private index = 0;
  private diagnostics: string[] = [];
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): GeneratedHandlerProgram {
    const operations = this.parseOperations();
    return { operations, diagnostics: this.diagnostics };
  }

  private parseOperations(stop = ''): GeneratedHandlerOperation[] {
    const operations: GeneratedHandlerOperation[] = [];
    while (!this.at('eof') && (!stop || !this.atText(stop))) {
      const operation = this.parseStatement();
      if (Array.isArray(operation)) operations.push(...operation);
      else if (operation) operations.push(operation);
    }
    if (stop) this.consume(stop);
    return operations;
  }

  private parseStatement(): GeneratedHandlerOperation | GeneratedHandlerOperation[] | undefined {
    if (this.consume(';')) return undefined;
    if (this.consume('{')) return this.parseOperations('}');
    if (this.atText('if')) return this.parseIf();
    if (this.atText('for')) return this.parseFor();
    if (this.atText('while')) return this.parseWhile();
    if (this.atText('switch')) return this.parseSwitch();
    if (this.atText('return')) return this.parseReturn();
    if (this.atText('break')) {
      this.take();
      if (!this.consume(';')) this.unsupportedStatement('break without semicolon');
      return { op: 'break' };
    }
    if (this.atText('using')) {
      while (!this.at('eof') && !this.consume(';')) this.take();
      return undefined;
    }
    if (this.atText('do')) {
      this.unsupportedStatement(`unsupported control flow "${this.peek().text}"`);
      return undefined;
    }
    if (this.isDeclaration()) return this.parseDeclaration();

    const start = this.peek();
    const expression = this.parseExpression();
    if (!expression) {
      this.unsupportedStatement(`could not parse statement at byte ${start.offset}`);
      return undefined;
    }
    if (expression.kind === 'assignment') {
      if (!this.consume(';')) {
        this.unsupportedStatement(`invalid assignment at byte ${start.offset}`);
        return undefined;
      }
      return {
        op: 'assign',
        target: expression.target,
        operator: expression.operator,
        value: expression.value,
      };
    }
    if (ASSIGNMENT_OPERATORS.has(this.peek().text)) {
      const operator = this.take().text;
      const value = this.parseExpression();
      if (!value || !this.consume(';')) {
        this.unsupportedStatement(`invalid assignment at byte ${start.offset}`);
        return undefined;
      }
      return { op: 'assign', target: expression, operator, value };
    }
    if (this.peek().text === '++' || this.peek().text === '--') {
      const operator = this.take().text === '++' ? '+=' : '-=';
      if (!this.consume(';')) {
        this.unsupportedStatement(`invalid increment at byte ${start.offset}`);
        return undefined;
      }
      return {
        op: 'assign',
        target: expression,
        operator,
        value: { kind: 'number', value: 1 },
      };
    }
    if (!this.consume(';')) {
      this.unsupportedStatement(`unsupported expression statement at byte ${start.offset}`);
      return undefined;
    }
    if (expression.kind !== 'call') {
      this.diagnostics.push(`discarded non-call expression at byte ${start.offset}`);
      return undefined;
    }
    return { op: 'call', expression };
  }

  private parseIf(): GeneratedHandlerOperation | undefined {
    this.take();
    if (!this.consume('(')) {
      this.unsupportedStatement('if without condition');
      return undefined;
    }
    const condition = this.parseExpression();
    if (!condition || !this.consume(')')) {
      this.unsupportedStatement('invalid if condition');
      return undefined;
    }
    const then = this.parseStatementAsBlock();
    let otherwise: GeneratedHandlerOperation[] | undefined;
    if (this.consume('else')) otherwise = this.parseStatementAsBlock();
    return {
      op: 'if',
      condition,
      then,
      ...(otherwise ? { else: otherwise } : {}),
    };
  }

  private parseStatementAsBlock(): GeneratedHandlerOperation[] {
    if (this.consume('{')) return this.parseOperations('}');
    const statement = this.parseStatement();
    if (!statement) return [];
    return Array.isArray(statement) ? statement : [statement];
  }

  private parseReturn(): GeneratedHandlerOperation | undefined {
    this.take();
    if (this.consume(';')) return { op: 'return' };
    const value = this.parseExpression();
    if (!value || !this.consume(';')) {
      this.unsupportedStatement('invalid return statement');
      return undefined;
    }
    return { op: 'return', value };
  }

  private parseFor(): GeneratedHandlerOperation | undefined {
    this.take();
    if (!this.consume('(')) {
      this.unsupportedStatement('for without control clause');
      return undefined;
    }
    let initialize: GeneratedHandlerOperation[] = [];
    if (this.consume(';')) {
      initialize = [];
    } else if (this.isDeclaration()) {
      initialize = this.parseDeclaration();
    } else {
      const operation = this.parseMutation(';');
      if (!operation) {
        this.unsupportedStatement('invalid for initializer');
        return undefined;
      }
      initialize = [operation];
    }
    const condition = this.parseExpression();
    if (!condition || !this.consume(';')) {
      this.unsupportedStatement('invalid for condition');
      return undefined;
    }
    const iterate = this.parseMutation(')');
    if (!iterate) {
      this.unsupportedStatement('invalid for iteration');
      return undefined;
    }
    const body = this.parseStatementAsBlock();
    return { op: 'for', initialize, condition, iterate, body };
  }

  private parseWhile(): GeneratedHandlerOperation | undefined {
    this.take();
    if (!this.consume('(')) {
      this.unsupportedStatement('while without condition');
      return undefined;
    }
    const condition = this.parseExpression();
    if (!condition || !this.consume(')')) {
      this.unsupportedStatement('invalid while condition');
      return undefined;
    }
    return { op: 'while', condition, body: this.parseStatementAsBlock() };
  }

  private parseSwitch(): GeneratedHandlerOperation | undefined {
    this.take();
    if (!this.consume('(')) {
      this.unsupportedStatement('switch without expression');
      return undefined;
    }
    const expression = this.parseExpression();
    if (!expression || !this.consume(')') || !this.consume('{')) {
      this.unsupportedStatement('invalid switch expression');
      return undefined;
    }
    const cases: Extract<GeneratedHandlerOperation, { op: 'switch' }>['cases'] = [];
    while (!this.at('eof') && !this.atText('}')) {
      const values: GeneratedExpression[] = [];
      let isDefault = false;
      while (this.atText('case') || this.atText('default')) {
        if (this.consume('default')) {
          isDefault = true;
        } else {
          this.take();
          const value = this.parseExpression();
          if (!value) {
            this.unsupportedStatement('invalid switch case');
            return undefined;
          }
          values.push(value);
        }
        if (!this.consume(':')) {
          this.unsupportedStatement('switch case without colon');
          return undefined;
        }
      }
      if (!values.length && !isDefault) {
        this.unsupportedStatement('switch body before first case');
        return undefined;
      }
      const body: GeneratedHandlerOperation[] = [];
      while (
        !this.at('eof') &&
        !this.atText('}') &&
        !this.atText('case') &&
        !this.atText('default')
      ) {
        const statement = this.parseStatement();
        if (Array.isArray(statement)) body.push(...statement);
        else if (statement) body.push(statement);
      }
      cases.push({ ...(isDefault ? {} : { values }), body });
    }
    if (!this.consume('}')) {
      this.unsupportedStatement('unterminated switch');
      return undefined;
    }
    return { op: 'switch', expression, cases };
  }

  private parseMutation(terminator: string): GeneratedHandlerOperation | undefined {
    const target = this.parseExpression();
    if (!target) return undefined;
    let operator = this.peek().text;
    let value: GeneratedExpression | undefined;
    if (ASSIGNMENT_OPERATORS.has(operator)) {
      this.take();
      value = this.parseExpression();
    } else if (operator === '++' || operator === '--') {
      this.take();
      operator = operator === '++' ? '+=' : '-=';
      value = { kind: 'number', value: 1 };
    } else {
      return undefined;
    }
    if (!value || !this.consume(terminator)) return undefined;
    return { op: 'assign', target, operator, value };
  }

  private isDeclaration(): boolean {
    return this.peek().kind === 'identifier' && TYPE_WORDS.has(this.peek().text);
  }

  private parseDeclaration(): GeneratedHandlerOperation[] {
    const typeWords: string[] = [];
    while (this.peek().kind === 'identifier' && TYPE_WORDS.has(this.peek().text)) {
      typeWords.push(this.take().text);
    }
    while (this.consume('*') || this.consume('&')) {
      // pointer/reference syntax does not affect the generated value model.
    }
    while (this.consume('const')) {
      // MAME commonly places const after a pointer declarator.
    }
    const valueType = typeWords.find(word => word !== 'const');
    const declarations: GeneratedHandlerOperation[] = [];
    while (!this.at('eof')) {
      const name = this.peek();
      if (name.kind !== 'identifier') {
        this.unsupportedStatement(`invalid declaration at byte ${name.offset}`);
        return declarations;
      }
      this.take();
      let value: GeneratedExpression | undefined;
      if (this.consume('=')) value = this.parseExpression();
      declarations.push({
        op: 'declare',
        name: name.text,
        ...(valueType ? { valueType } : {}),
        ...(value ? { value } : {}),
      });
      if (this.consume(';')) return declarations;
      if (!this.consume(',')) {
        this.unsupportedStatement(`invalid declaration of "${name.text}"`);
        return declarations;
      }
    }
    return declarations;
  }

  private parseExpression(minPrecedence = 0): GeneratedExpression | undefined {
    let left = this.parseUnary();
    if (!left) return undefined;
    while (true) {
      const operator = this.peek().text;
      const precedence = BINARY_PRECEDENCE[operator] ?? -1;
      if (precedence < minPrecedence) break;
      this.take();
      const right = this.parseExpression(precedence + 1);
      if (!right) return undefined;
      left = { kind: 'binary', operator, left, right };
    }
    if (minPrecedence === 0 && this.consume('?')) {
      const whenTrue = this.parseExpression();
      if (!whenTrue || !this.consume(':')) return undefined;
      const whenFalse = this.parseExpression();
      if (!whenFalse) return undefined;
      left = { kind: 'conditional', condition: left, whenTrue, whenFalse };
    }
    if (minPrecedence === 0 && ASSIGNMENT_OPERATORS.has(this.peek().text)) {
      const operator = this.take().text;
      const value = this.parseExpression();
      if (!value) return undefined;
      left = { kind: 'assignment', target: left, operator, value };
    }
    return left;
  }

  private parseUnary(): GeneratedExpression | undefined {
    if (this.atText('(') && this.isCast()) {
      this.take();
      const valueType: string[] = [];
      while (this.peek().kind === 'identifier' && TYPE_WORDS.has(this.peek().text)) {
        valueType.push(this.take().text);
      }
      while (this.consume('*') || this.consume('&')) {
        // Cast pointer/reference syntax is irrelevant to the numeric runtime.
      }
      this.consume(')');
      const operand = this.parseUnary();
      return operand
        ? { kind: 'cast', valueType: valueType.filter(word => word !== 'const').join(' '), operand }
        : undefined;
    }
    if (this.peek().text === '++' || this.peek().text === '--') {
      const operator = this.take().text === '++' ? '+=' : '-=';
      const target = this.parseUnary();
      return target
        ? {
            kind: 'assignment',
            target,
            operator,
            value: { kind: 'number', value: 1 },
          }
        : undefined;
    }
    if (['!', '~', '-', '+', '&', '*'].includes(this.peek().text)) {
      const operator = this.take().text;
      const operand = this.parseUnary();
      return operand ? { kind: 'unary', operator, operand } : undefined;
    }
    return this.parsePostfix();
  }

  private isCast(): boolean {
    let cursor = this.index + 1;
    if (this.tokens[cursor]?.kind !== 'identifier' || !TYPE_WORDS.has(this.tokens[cursor]!.text)) {
      return false;
    }
    while (
      this.tokens[cursor]?.kind === 'identifier' &&
      TYPE_WORDS.has(this.tokens[cursor]!.text)
    ) cursor++;
    while (this.tokens[cursor]?.text === '*' || this.tokens[cursor]?.text === '&') cursor++;
    return this.tokens[cursor]?.text === ')';
  }

  private parsePostfix(): GeneratedExpression | undefined {
    let expression = this.parsePrimary();
    if (!expression) return undefined;
    while (true) {
      if (this.consume('(')) {
        const args = this.parseArguments();
        if (!args) return undefined;
        expression = { kind: 'call', callee: expression, args };
      } else if (this.consume('[')) {
        const index = this.parseExpression();
        if (!index || !this.consume(']')) return undefined;
        expression = { kind: 'index', object: expression, index };
      } else if (this.consume('->') || this.consume('.')) {
        const property = this.peek();
        if (property.kind !== 'identifier') return undefined;
        this.take();
        expression = { kind: 'member', object: expression, property: property.text };
      } else if (this.consume('::')) {
        const property = this.peek();
        if (property.kind !== 'identifier') return undefined;
        this.take();
        expression = {
          kind: 'identifier',
          name: `${expressionName(expression)}::${property.text}`,
        };
      } else {
        break;
      }
    }
    return expression;
  }

  private parseArguments(): GeneratedExpression[] | undefined {
    const args: GeneratedExpression[] = [];
    if (this.consume(')')) return args;
    while (!this.at('eof')) {
      const arg = this.parseExpression();
      if (!arg) return undefined;
      args.push(arg);
      if (this.consume(')')) return args;
      if (!this.consume(',')) return undefined;
    }
    return undefined;
  }

  private parsePrimary(): GeneratedExpression | undefined {
    const token = this.take();
    if (token.kind === 'number') return { kind: 'number', value: parseNumber(token.text) };
    if (token.kind === 'string') return { kind: 'string', value: unquote(token.text) };
    if (token.kind === 'identifier') {
      if (token.text === 'true') return { kind: 'number', value: 1 };
      if (token.text === 'false' || token.text === 'nullptr') return { kind: 'number', value: 0 };
      return { kind: 'identifier', name: token.text };
    }
    if (token.text === '(') {
      const expression = this.parseExpression();
      return expression && this.consume(')') ? expression : undefined;
    }
    this.index--;
    return undefined;
  }

  private unsupportedStatement(message: string): void {
    this.diagnostics.push(message);
    let parens = 0;
    let braces = 0;
    while (!this.at('eof')) {
      const token = this.take().text;
      if (token === '(') parens++;
      else if (token === ')') parens = Math.max(0, parens - 1);
      else if (token === '{') braces++;
      else if (token === '}') {
        if (braces === 0) {
          this.index--;
          return;
        }
        braces--;
      } else if (token === ';' && parens === 0 && braces === 0) {
        return;
      }
    }
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(): Token {
    return this.tokens[this.index++]!;
  }

  private at(kind: Token['kind']): boolean {
    return this.peek().kind === kind;
  }

  private atText(text: string): boolean {
    return this.peek().text === text;
  }

  private consume(text: string): boolean {
    if (!this.atText(text)) return false;
    this.index++;
    return true;
  }
}

function tokenize(source: string): Token[] {
  const masked = maskComments(source);
  const tokens: Token[] = [];
  const operators = [
    '>>=', '<<=', '->', '::', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
    '+=', '-=', '&=', '|=', '^=', '++', '--',
  ];
  let index = 0;
  while (index < masked.length) {
    const char = masked[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index++;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index++] === char) break;
      }
      tokens.push({ kind: 'string', text: source.slice(start, index), offset: start });
      continue;
    }
    const number = /^(?:0x[0-9a-f]+|\d+)(?:[uUlL]+)?/i.exec(masked.slice(index));
    if (number) {
      tokens.push({ kind: 'number', text: number[0], offset: index });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_]\w*/.exec(masked.slice(index));
    if (identifier) {
      tokens.push({ kind: 'identifier', text: identifier[0], offset: index });
      index += identifier[0].length;
      continue;
    }
    const operator = operators.find(candidate => masked.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: 'operator', text: operator, offset: index });
      index += operator.length;
      continue;
    }
    const kind = '(){}[],;?:.'.includes(char) ? 'punctuation' : 'operator';
    tokens.push({ kind, text: char, offset: index++ });
  }
  tokens.push({ kind: 'eof', text: '', offset: source.length });
  return tokens;
}

function parseNumber(text: string): number {
  const normalized = text.replace(/[uUlL]+$/g, '');
  return normalized.toLowerCase().startsWith('0x')
    ? Number.parseInt(normalized.slice(2), 16)
    : Number.parseInt(normalized, 10);
}

function unquote(text: string): string {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text.slice(1, -1);
}

function expressionName(expression: GeneratedExpression): string {
  if (expression.kind === 'identifier') return expression.name;
  if (expression.kind === 'member') return `${expressionName(expression.object)}.${expression.property}`;
  return '<expression>';
}
