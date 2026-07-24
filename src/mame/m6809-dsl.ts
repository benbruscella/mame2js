export interface M6809DslOpcode {
  key: string;
  source: string;
  sourceLine: number;
}

export interface M6809Dsl {
  blocks: Map<string, string>;
  interrupts: {
    nmi: string;
    firq: string;
    irq: string;
  };
  waits: {
    syncResume: string;
    cwaiResume: string;
  };
  opcodes: M6809DslOpcode[];
}

interface SourceBlock {
  source: string;
  line: number;
}

/**
 * MAME's m6809make.py turns the percent-dispatch DSL into a resumable C++
 * state machine. Browser execution is instruction-atomic, so the same source
 * can be lowered more directly by expanding those continuations per opcode.
 */
export function parseM6809Dsl(
  source: string,
  includedSource: string,
): M6809Dsl {
  const combined = source.replace(
    /^\s*#include\s+"base6x09\.lst"\s*$/m,
    includedSource,
  );
  const sourceBlocks = splitBlocks(combined);
  const publicBlocks = new Map(
    [...sourceBlocks].map(([name, block]) => [name, block.source]),
  );
  const dispatchBlocks = new Map(
    ['DISPATCH01', 'DISPATCH10', 'DISPATCH11'].map(name => {
      const block = sourceBlocks.get(name);
      if (!block) throw new Error(`MAME M6809 DSL is missing ${name}`);
      return [name, { block, cases: dispatchCases(block.source) }] as const;
    }),
  );
  const baseCases = dispatchBlocks.get('DISPATCH01')!.cases;
  const opcodes: M6809DslOpcode[] = [];
  for (const [dispatch, prefix] of [
    ['DISPATCH01', ''],
    ['DISPATCH10', '10'],
    ['DISPATCH11', '11'],
  ] as const) {
    const { block, cases } = dispatchBlocks.get(dispatch)!;
    for (let opcode = 0; opcode < 256; opcode++) {
      if (!prefix && (opcode === 0x10 || opcode === 0x11)) continue;
      let dispatchSource = cases.explicit.get(opcode) ?? cases.fallback;
      if (dispatchSource === undefined) {
        throw new Error(`${dispatch} has no case for opcode ${hex(opcode)}`);
      }
      if (prefix && dispatchSource.includes('%DISPATCH01')) {
        dispatchSource = baseCases.explicit.get(opcode) ?? baseCases.fallback;
      } else if (prefix && dispatchSource.includes(`%${dispatch}`)) {
        dispatchSource = '%ILLEGAL;';
      }
      if (dispatchSource === undefined) {
        throw new Error(`DISPATCH01 has no fallback for opcode ${hex(opcode)}`);
      }
      opcodes.push({
        key: prefix ? `${prefix}${hex(opcode)}` : `${hex(opcode)}00`,
        source: expandContinuations(dispatchSource, sourceBlocks),
        sourceLine: block.line + cases.lines.get(opcode)!,
      });
    }
  }
  return {
    blocks: publicBlocks,
    interrupts: {
      nmi: expandNamedBlock('NMI', sourceBlocks),
      firq: expandNamedBlock('FIRQ', sourceBlocks),
      irq: expandNamedBlock('IRQ', sourceBlocks),
    },
    waits: {
      syncResume: sourceAfterWait(expandNamedBlock('SYNC', sourceBlocks)),
      cwaiResume: sourceAfterWait(expandNamedBlock('CWAI', sourceBlocks)),
    },
    opcodes,
  };
}

function expandNamedBlock(
  name: string,
  blocks: Map<string, SourceBlock>,
): string {
  const block = blocks.get(name);
  if (!block) throw new Error(`MAME M6809 DSL is missing ${name}`);
  return expandContinuations(block.source, blocks, [name]);
}

function sourceAfterWait(source: string): string {
  const whileAt = source.indexOf('while');
  const open = source.indexOf('{', whileAt);
  const close = matchPair(source, open, '{', '}');
  if (whileAt < 0 || open < 0 || close < 0) {
    throw new Error('MAME M6809 wait continuation source shape changed');
  }
  return source.slice(close + 1);
}

function splitBlocks(source: string): Map<string, SourceBlock> {
  const matches = [...source.matchAll(/^([A-Z][A-Za-z0-9_]*):\s*$/gm)];
  const blocks = new Map<string, SourceBlock>();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    blocks.set(match[1]!, {
      source: source.slice(start, end),
      line: lineAt(source, match.index!),
    });
  }
  return blocks;
}

function dispatchCases(source: string): {
  explicit: Map<number, string>;
  fallback?: string;
  lines: Map<number, number>;
} {
  const switchAt = source.indexOf('switch(m_opcode)');
  const open = source.indexOf('{', switchAt);
  const close = matchPair(source, open, '{', '}');
  if (switchAt < 0 || open < 0 || close < 0) {
    throw new Error('MAME M6809 dispatch switch is malformed');
  }
  const body = source.slice(open + 1, close);
  const explicit = new Map<number, string>();
  const lines = new Map<number, number>();
  let fallback: string | undefined;
  for (const match of body.matchAll(
    /^\s*((?:(?:case\s+0x[\da-f]+\s*:\s*)+)|(?:default\s*:\s*))(.+?)\breturn\s*;/gmi,
  )) {
    const operation = match[2]!.trim();
    const values = [...match[1]!.matchAll(/case\s+0x([\da-f]+)/gi)]
      .map(value => Number.parseInt(value[1]!, 16));
    if (!values.length) {
      fallback = operation;
      continue;
    }
    for (const value of values) {
      explicit.set(value, operation);
      lines.set(value, lineAt(source, open + 1 + match.index!));
    }
  }
  if (fallback !== undefined) {
    for (let opcode = 0; opcode < 256; opcode++) {
      if (!lines.has(opcode)) lines.set(opcode, lineAt(source, open));
    }
  }
  return { explicit, ...(fallback !== undefined ? { fallback } : {}), lines };
}

function expandContinuations(
  source: string,
  blocks: Map<string, SourceBlock>,
  stack: string[] = [],
): string {
  const expand = (name: string): string => {
    if (stack.includes(name)) {
      throw new Error(`MAME M6809 DSL continuation cycle: ${[...stack, name].join(' -> ')}`);
    }
    const block = blocks.get(name);
    if (!block) throw new Error(`MAME M6809 DSL references missing block ${name}`);
    return expandContinuations(block.source, blocks, [...stack, name])
      .replace(/\breturn\s*;/g, '');
  };
  let expanded = source;
  for (let pass = 0; pass < 64; pass++) {
    const before = expanded;
    expanded = expanded
      .replace(/%([A-Z][A-Za-z0-9_]*)(?:\*)?\s*;/g, (_entry, name: string) => `{\n${expand(name)}\n}`)
      .replace(/\bgoto\s+([A-Z][A-Za-z0-9_]*)\s*;/g, (_entry, name: string) => `{\n${expand(name)}\n}`);
    if (expanded === before) return expanded;
  }
  throw new Error('MAME M6809 DSL continuation expansion exceeded 64 passes');
}

function matchPair(
  source: string,
  open: number,
  openChar: string,
  closeChar: string,
): number {
  if (open < 0 || source[open] !== openChar) return -1;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === openChar) depth++;
    else if (source[index] === closeChar && --depth === 0) return index;
  }
  return -1;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}
