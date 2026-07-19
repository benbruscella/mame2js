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
  const config = ast.findFunction(String(machine.props.cls), String(machine.props.name));
  if (!config) return undefined;
  const startMatch =
    /MCFG_VIDEO_START_OVERRIDE\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(config.body);
  if (!startMatch) return undefined;
  const start = ast.findFunction(startMatch[1]!, `video_start_${startMatch[2]}`);
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
  const screenCallback = graph.nodes.find(node =>
    node.label === 'Callback' &&
    node.props.signal === 'set_screen_update');
  const screenClass = String(screenCallback?.props.targetClass ?? machine.props.cls);
  const screenMethod = String(screenCallback?.props.targetMethod ?? '');
  const screen = ast.findFunctionInHierarchy(screenClass, screenMethod);
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
    const mapper = funcKey(args[2]);
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
  const resistanceMatch =
    /(?:static\s+)?constexpr\s+int\s+(\w+)\s*\[[^\]]+\]\s*=\s*\{([^}]+)\}/.exec(body);
  const weightsCall = findCallArguments(body, 'compute_resistor_weights');
  if (!region || !resistanceMatch || !weightsCall) return undefined;
  const resistanceValues = splitMameArgs(resistanceMatch[2]!)
    .map(value => expressionNumber(value));
  const args = splitMameArgs(weightsCall);
  const networks = new Map<string, {
    resistances: number[];
    pulldown: number;
    pullup: number;
  }>();
  for (let index = 3; index + 4 < args.length; index += 5) {
    const count = expressionNumber(args[index]);
    if (!count) continue;
    const offset = Number(/\[\s*(\d+)\s*\]/.exec(args[index + 1] ?? '')?.[1] ?? 0);
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
  const loops = [...body.matchAll(/for\s*\(\s*int\s+i\s*=\s*0\s*;\s*i\s*<\s*([^;]+);/g)];
  const lookupOffset = expressionNumber(/color_prom\s*\+=\s*([^;]+)/.exec(body)?.[1]);
  const lookupCount = expressionNumber(loops[1]?.[1]);
  const lookupMask = expressionNumber(/ctabentry\s*=\s*color_prom\[i\]\s*&\s*([^;]+)/.exec(body)?.[1]);
  if (channels.length !== 3 || !lookupCount) return undefined;
  const banks = [...body.matchAll(/set_pen_indirect\(\s*i(?:\s*\+\s*([^,]+))?\s*,\s*([^;)]+)\)/g)]
    .map(bank => ({
      penOffset: expressionNumber(bank[1]),
      colorOr: expressionNumber(/([^|]+)\|\s*ctabentry/.exec(bank[2]!)?.[1]),
    }));
  return {
    region,
    colorCount: expressionNumber(loops[0]?.[1]),
    min: expressionNumber(args[0]),
    max: expressionNumber(args[1]),
    scaler: Number(args[2]) || -1,
    channels,
    lookupOffset,
    lookupCount,
    lookupMask,
    banks: banks.length ? banks : [{ penOffset: 0, colorOr: 0 }],
    transparentIndirect: 0,
    source: sourceRef(fn),
  };
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

function sourceRef(fn: MameFunction): GeneratedSourceRef {
  return { file: fn.span.file, line: fn.span.line, column: fn.span.column };
}
