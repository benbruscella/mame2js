import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { KnowledgeGraph, KGNode } from '../kg/types.ts';
import { evalExpr } from '../kg/parse.ts';
import type {
  GeneratedHandler,
  GeneratedPromPalettePlan,
  GeneratedSourceRef,
  GeneratedVideoPlan,
} from '../runtime/generated-machine.ts';
import { MameAstIndex, parseMameAst, splitMameArgs, type MameFunction } from './ast.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';
import { compileMameHandler } from './handler-ir.ts';

export interface CompiledMameVideo {
  plan: GeneratedVideoPlan;
  handlers: GeneratedHandler[];
}

export function compileMameVideo(
  graph: KnowledgeGraph,
  mameSrc: string,
  machineId: string,
): CompiledMameVideo | undefined {
  const machine = graph.nodes.find(node => node.id === machineId);
  if (!machine) return undefined;
  const files = graph.nodes
    .filter(node => node.label === 'SourceFile')
    .map(node => String(node.props.path))
    .filter(file => existsSync(join(mameSrc, file)));
  const driver = graph.meta.driverFile;
  const driverStem = basename(driver).replace(/\.cpp$/, '');
  const driverDir = dirname(driver);
  for (const candidate of [
    driver,
    join(driverDir, `${driverStem}.h`),
    join(driverDir, `${driverStem}_v.cpp`),
    join(driverDir, `${driverStem}_a.cpp`),
  ]) {
    if (existsSync(join(mameSrc, candidate)) && !files.includes(candidate)) files.push(candidate);
  }
  if (!files.includes(driver) && existsSync(join(mameSrc, driver))) files.push(driver);
  const ast = new MameAstIndex(parseMameAst(
    [...new Set(files)].map(file => ({ file, source: readFileSync(join(mameSrc, file), 'utf8') })),
  ));
  const screenCallback = graph.nodes.find(node =>
    node.label === 'Callback' &&
    node.props.signal === 'set_screen_update');
  const screenClass = String(screenCallback?.props.targetClass ?? machine.props.cls);
  const screenMethod = String(screenCallback?.props.targetMethod ?? '');
  const screen = ast.findFunctionInHierarchy(screenClass, screenMethod);
  const bitmap = screen && compileDirectBitmap(graph, screenClass, screenMethod, screen);
  if (bitmap) {
    return {
      plan: {
        gfx: [],
        tilemaps: [],
        initialState: {},
        bitmap,
        source: sourceRef(screen),
      },
      handlers: [],
    };
  }
  const config = ast.findFunction(String(machine.props.cls), String(machine.props.name));
  if (!config) return undefined;
  const startMatch =
    /MCFG_VIDEO_START_OVERRIDE\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(config.body);
  const start = startMatch
    ? ast.findFunction(startMatch[1]!, `video_start_${startMatch[2]}`)
    : ast.findFunctionInHierarchy(String(machine.props.cls), 'video_start');
  if (!start) return undefined;

  const tilemaps = compileTilemaps(start);
  if (!tilemaps.length) return undefined;
  const handlers: GeneratedHandler[] = [];
  for (const tilemap of tilemaps) {
    for (const key of [tilemap.mapper, tilemap.tileInfo]) {
      const [ownerClass, method] = splitHandlerKey(key);
      const fn = ast.findFunctionInHierarchy(ownerClass, method);
      if (fn) addHandler(handlers, fn);
    }
  }
  if (screen) {
    for (const name of calledSourceMethods(screen.body)) {
      const fn = ast.findFunctionInHierarchy(screen.className, name);
      if (fn && fn !== screen) addHandler(handlers, fn);
    }
  }

  const decodeEdge = graph.edges.find(edge => edge.from === machineId && edge.rel === 'DECODES');
  const decode = decodeEdge && graph.nodes.find(node => node.id === decodeEdge.to);
  if (!decode) return undefined;
  const gfx = graph.edges
    .filter(edge => edge.from === decode.id && edge.rel === 'HAS_ENTRY')
    .map(edge => graph.nodes.find(node => node.id === edge.to))
    .filter((node): node is KGNode => Boolean(node))
    .map(entry => {
      const layoutEdge = graph.edges.find(edge => edge.from === entry.id && edge.rel === 'USES_LAYOUT');
      const layout = layoutEdge && graph.nodes.find(node => node.id === layoutEdge.to);
      if (!layout) throw new Error(`${machineId}: gfx entry ${entry.id} has no layout`);
      return {
        region: String(entry.props.region),
        offset: Number(entry.props.offset),
        colorBase: Number(entry.props.colorBase),
        colorCount: Number(entry.props.colorCount),
        xscale: Number(entry.props.xscale ?? 1),
        yscale: Number(entry.props.yscale ?? 1),
        layout: {
          width: Number(layout.props.width),
          height: Number(layout.props.height),
          total: layout.props.total as number | string,
          planes: Number(layout.props.planes),
          planeOffsets: layout.props.planeOffsets as (number | string)[],
          xOffsets: layout.props.xOffsets as (number | string)[],
          yOffsets: layout.props.yOffsets as (number | string)[],
          charIncrement: Number(layout.props.charIncrement),
        },
      };
    });
  const palette = compilePalette(graph, machineId, ast);
  if (!palette) return undefined;

  return {
    plan: {
      gfx,
      palette,
      tilemaps,
      initialState: initialState(start.body),
      source: sourceRef(start),
    },
    handlers,
  };
}

function compileDirectBitmap(
  graph: KnowledgeGraph,
  ownerClass: string,
  method: string,
  screen: MameFunction,
): NonNullable<GeneratedVideoPlan['bitmap']> | undefined {
  const body = screen.body;
  const offset = /\b(?:offs_t|u\d+)\s+(?:const\s+)?\w+\s*=\s*\(\(offs_t\)(\w+)\s*<<\s*(\d+)\)\s*\|\s*\(\w+\s*>>\s*(\d+)\)/.exec(body);
  const row = offset && new RegExp(
    `\\b(?:u?int8_t|u8)\\s+${offset[1]}\\s*=\\s*(\\w+)\\s*;`,
  ).exec(body);
  const member = /\b\w+\s*=\s*(m_\w+)\s*\[\s*\w+\s*\]\s*;/.exec(body)?.[1];
  const phase = /\(\s*\w+\s*&\s*(0x[\da-f]+|\d+)\s*\)\s*==\s*(0x[\da-f]+|\d+)/i.exec(body);
  if (!row || !offset || !member || !phase) return undefined;
  if (!body.includes('video_data = video_data >> 1')) return undefined;
  const handler = graph.nodes.find(node =>
    node.label === 'Handler' &&
    node.props.ownerClass === ownerClass &&
    node.props.method === method);
  const constants = Object.fromEntries(
    (Array.isArray(handler?.props.sourceConstants) ? handler.props.sourceConstants : [])
      .map(value => /^([^=]+)=(-?(?:\d+(?:\.\d+)?|Infinity))$/.exec(String(value)))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map(match => [match[1], Number(match[2])]),
  );
  const rowStart = constants[row[1]!] ?? Number(row[1]);
  const rowShift = Number(offset[2]);
  const pixelShift = Number(offset[3]);
  const xOffset = Number(phase[2]);
  if (
    !Number.isInteger(rowStart) || rowStart < 0 || rowStart > 255 ||
    !Number.isInteger(rowShift) || rowShift < 0 || rowShift > 16 ||
    pixelShift !== 3 || !Number.isInteger(xOffset) || xOffset < 0
  ) return undefined;
  return {
    member,
    rowStart,
    rows: 256 - rowStart,
    bytesPerRow: 1 << rowShift,
    xOffset,
    lsbFirst: true,
    black: 0xff000000,
    white: 0xffffffff,
    source: sourceRef(screen),
  };
}

function compileTilemaps(start: MameFunction): GeneratedVideoPlan['tilemaps'] {
  const plans: GeneratedVideoPlan['tilemaps'] = [];
  const createRe = /\b(m_\w+)\s*=\s*&?[^;]*?\.create\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(start.body)) !== null) {
    const open = start.body.indexOf('(', match.index + match[0].length - 1);
    const close = matchingPair(start.body, open, '(', ')');
    if (close < 0) continue;
    const args = splitMameArgs(start.body.slice(open + 1, close));
    const tileInfo = funcKey(args[1]);
    const mapper = funcKey(args[2]) ?? standardTilemapMapper(args[2]);
    if (!tileInfo || !mapper || args.length < 7) continue;
    plans.push({
      member: match[1]!,
      tileWidth: expressionNumber(args[3]),
      tileHeight: expressionNumber(args[4]),
      columns: expressionNumber(args[5]),
      rows: expressionNumber(args[6]),
      mapper,
      tileInfo,
      source: sourceRef(start),
    });
    createRe.lastIndex = close + 1;
  }
  return plans;
}

function compilePalette(
  graph: KnowledgeGraph,
  machineId: string,
  ast: MameAstIndex,
): GeneratedPromPalettePlan | undefined {
  const deviceIds = new Set(graph.edges
    .filter(edge => edge.from === machineId && edge.rel === 'HAS_DEVICE')
    .map(edge => edge.to));
  const palette = graph.nodes.find(node =>
    deviceIds.has(node.id) && node.label === 'Device' && node.props.type === 'PALETTE');
  const raw = ((palette?.props.config as string[] | undefined) ?? []).join('\n');
  const callback = /FUNC\(\s*(\w+)::(\w+)\s*\)/.exec(raw);
  if (!callback) return undefined;
  const fn = ast.findFunctionInHierarchy(callback[1]!, callback[2]!);
  if (!fn) return undefined;
  const body = fn.body;
  const region = /memregion\(\s*"([^"]+)"\s*\)/.exec(body)?.[1];
  const weightsCall = findCallArguments(body, 'compute_resistor_weights');
  if (!region) return undefined;
  const channels = weightsCall
    ? compileResistorChannels(body, weightsCall)
    : compileFixedWeightChannels(body);
  if (channels.length !== 3) return undefined;
  const loops = numericForLoops(body);
  const paletteLoop = loops.find(loop =>
    loop.body.includes('set_indirect_color') ||
    /\bpalette_val\s*\[\s*i\s*\]\s*=\s*rgb_t/.test(loop.body));
  const lookupLoops = loops.filter(loop =>
    loop.body.includes('set_pen_indirect') || loop.body.includes('set_pen_color'));
  const lookupOffset = expressionNumber(/color_prom\s*\+=\s*([^;]+)/.exec(body)?.[1]);
  const lookupMask = expressionNumber(/color_prom[^;]*?&\s*(0x[\da-f]+|\d+)/i.exec(
    lookupLoops.map(loop => loop.body).join('\n'),
  )?.[1]);
  let postIncrementOffset = lookupOffset;
  const banks = lookupLoops.flatMap(loop => {
    const method = loop.body.includes('set_pen_indirect')
      ? 'palette.set_pen_indirect'
      : 'palette.set_pen_color';
    const call = findCallArguments(loop.body, method);
    if (!call) return [];
    const args = splitMameArgs(call);
    const lookupExpression = args[1] ?? '';
    const colorExpression = /ctabentry\s*=\s*([^;]+)/.exec(loop.body)?.[1]
      ?? lookupExpression;
    const lookupIndex = /color_prom\[\s*([^\]]+)\s*\]/.exec(lookupExpression)?.[1];
    const usesPostIncrement = /\*\s*color_prom\s*\+\+/.test(lookupExpression);
    const currentPostIncrementOffset = postIncrementOffset;
    if (usesPostIncrement) postIncrementOffset += Math.max(0, loop.end - loop.start);
    return [{
      penOffset: expressionAt(args[0]!, loop.start),
      colorOr: expressionNumber(
        /(?:\||\+)\s*(-?(?:0x[\da-f]+|\d+))/i.exec(colorExpression)?.[1],
      ),
      lookupOffset: usesPostIncrement
        ? currentPostIncrementOffset
        : lookupOffset + expressionAt(lookupIndex ?? 'i', loop.start),
      lookupCount: Math.max(0, loop.end - loop.start),
    }];
  });
  if (!paletteLoop || !banks.length || !lookupMask) return undefined;
  const args = weightsCall ? splitMameArgs(weightsCall) : [];
  return {
    region,
    colorCount: Math.max(0, paletteLoop.end - paletteLoop.start),
    min: weightsCall ? expressionNumber(args[0]) : 0,
    max: weightsCall ? expressionNumber(args[1]) : 255,
    scaler: weightsCall ? Number(args[2]) || -1 : 1,
    channels,
    lookupOffset,
    lookupCount: banks[0]!.lookupCount,
    lookupMask,
    banks,
    transparentIndirect: 0,
    source: sourceRef(fn),
  };
}

function compileFixedWeightChannels(
  body: string,
): GeneratedPromPalettePlan['channels'] {
  const bits = new Map<string, { offset: number; bit: number }>();
  const channels: GeneratedPromPalettePlan['channels'] = [];
  const sourceRe =
    /\b(bit\d+)\s*=\s*BIT\(\s*color_prom\[\s*([^\]]+)\s*\]\s*,\s*(\d+)\s*\)|(?:int\s+const|const\s+int)\s+([rgb])\s*=\s*([^;]+)/g;
  let match: RegExpExecArray | null;
  while ((match = sourceRe.exec(body)) !== null) {
    if (match[1]) {
      bits.set(match[1], {
        offset: expressionAt(match[2]!, 0),
        bit: Number(match[3]),
      });
      continue;
    }
    const terms = [...match[5]!.matchAll(
      /(-?(?:0x[\da-f]+|\d+))\s*\*\s*(bit\d+)/gi,
    )];
    const sources = terms.map(term => bits.get(term[2]!));
    if (!terms.length || sources.some(source => !source)) continue;
    channels.push({
      channel: match[4] as 'r' | 'g' | 'b',
      bits: sources.map(source => source!.bit),
      offsets: sources.map(source => source!.offset),
      weights: terms.map(term => expressionNumber(term[1])),
      resistances: [],
      pulldown: 0,
      pullup: 0,
    });
  }
  return channels;
}

function compileResistorChannels(
  body: string,
  weightsCall: string,
): GeneratedPromPalettePlan['channels'] {
  const resistanceArrays = new Map(
    [...body.matchAll(
      /(?:static\s+)?(?:constexpr|const)\s+int\s+(\w+)\s*\[[^\]]+\]\s*=\s*\{([^}]+)\}/g,
    )].map(match => [
      match[1]!,
      splitMameArgs(match[2]!).map(value => expressionNumber(value)),
    ]),
  );
  const args = splitMameArgs(weightsCall);
  const networks = new Map<string, {
    resistances: number[];
    pulldown: number;
    pullup: number;
  }>();
  for (let index = 3; index + 4 < args.length; index += 5) {
    const count = expressionNumber(args[index]);
    if (!count) continue;
    const resistanceArg = (args[index + 1] ?? '').replace(/^&/, '').trim();
    const resistanceName = /^(\w+)/.exec(resistanceArg)?.[1] ?? '';
    const resistanceValues = resistanceArrays.get(resistanceName);
    if (!resistanceValues) continue;
    const offset = Number(/\[\s*(\d+)\s*\]/.exec(resistanceArg)?.[1] ?? 0);
    const weightName = (args[index + 2] ?? '').replace(/^&/, '').trim();
    networks.set(weightName, {
      resistances: resistanceValues.slice(offset, offset + count),
      pulldown: expressionNumber(args[index + 3]),
      pullup: expressionNumber(args[index + 4]),
    });
  }
  const channels: GeneratedPromPalettePlan['channels'] = [];
  const bitVariables = new Map<string, number>();
  const colorRe =
    /\b(bit\d+)\s*=\s*BIT\(\s*color_prom\[i\]\s*,\s*(\d+)\s*\)|(?:int\s+const|const\s+int)\s+([rgb])\s*=\s*combine_weights\(\s*(\w+)\s*,\s*([^)]+)\)/g;
  let color: RegExpExecArray | null;
  while ((color = colorRe.exec(body)) !== null) {
    if (color[1]) {
      bitVariables.set(color[1], Number(color[2]));
      continue;
    }
    const network = networks.get(color[4]!);
    if (!network) continue;
    channels.push({
      channel: color[3] as 'r' | 'g' | 'b',
      bits: splitMameArgs(color[5]!).map(bit => bitVariables.get(bit.trim()) ?? 0),
      ...network,
    });
  }
  return channels;
}

function addHandler(handlers: GeneratedHandler[], fn: MameFunction): void {
  if (handlers.some(handler => handler.ownerClass === fn.className && handler.method === fn.name)) {
    return;
  }
  handlers.push({
    id: `handler:${fn.className}.${fn.name}`,
    ownerClass: fn.className,
    method: fn.name,
    parameters: fn.parameters.trim(),
    body: fn.body.trim(),
    program: compileMameHandler(normalizeMameExecutionSource(fn.body)),
    source: sourceRef(fn),
  });
}

function initialState(body: string): Record<string, number> {
  const state: Record<string, number> = {};
  for (const match of body.matchAll(/\b(m_\w+)\s*=\s*(-?(?:0x[\da-f]+|\d+))\s*;/gi)) {
    state[match[1]!] = expressionNumber(match[2]);
  }
  return state;
}

function calledSourceMethods(body: string): string[] {
  return [...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(match => match[1]!);
}

function splitHandlerKey(key: string): [string, string] {
  const index = key.lastIndexOf('.');
  return [key.slice(0, index), key.slice(index + 1)];
}

function funcKey(value: string | undefined): string | undefined {
  const match = value && /FUNC\(\s*(\w+)::(\w+)\s*\)/.exec(value);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

function standardTilemapMapper(value: string | undefined): string | undefined {
  const mapper = value?.trim();
  return mapper && /^TILEMAP_SCAN_(?:ROWS|COLS)$/.test(mapper) ? mapper : undefined;
}

function findCallArguments(source: string, name: string): string | undefined {
  const at = source.indexOf(`${name}(`);
  if (at < 0) return undefined;
  const open = source.indexOf('(', at + name.length);
  const close = matchingPair(source, open, '(', ')');
  return close < 0 ? undefined : source.slice(open + 1, close);
}

function matchingPair(source: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === left) depth++;
    else if (source[index] === right && --depth === 0) return index;
  }
  return -1;
}

function expressionNumber(value: string | undefined): number {
  if (!value) return 0;
  return evalExpr(value.trim()) ?? 0;
}

function expressionAt(source: string, index: number): number {
  return expressionNumber(source.replace(/\bi\b/g, String(index)));
}

function numericForLoops(source: string): {
  start: number;
  end: number;
  body: string;
}[] {
  const loops: { start: number; end: number; body: string }[] = [];
  const pattern =
    /for\s*\(\s*int\s+i\s*=\s*([^;]+)\s*;\s*i\s*<\s*([^;]+)\s*;\s*(?:i\+\+|\+\+i)\s*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('{', match.index + match[0].length - 1);
    const close = matchingPair(source, open, '{', '}');
    if (close < 0) continue;
    loops.push({
      start: expressionNumber(match[1]),
      end: expressionNumber(match[2]),
      body: source.slice(open + 1, close),
    });
    pattern.lastIndex = close + 1;
  }
  const singleStatementPattern =
    /for\s*\(\s*int\s+i\s*=\s*([^;]+)\s*;\s*i\s*<\s*([^;]+)\s*;\s*(?:i\+\+|\+\+i)\s*\)\s*(?!\{)([^;]+;)/g;
  while ((match = singleStatementPattern.exec(source)) !== null) {
    loops.push({
      start: expressionNumber(match[1]),
      end: expressionNumber(match[2]),
      body: match[3]!,
    });
  }
  return loops;
}

function sourceRef(fn: MameFunction): GeneratedSourceRef {
  return { file: fn.span.file, line: fn.span.line, column: fn.span.column };
}
