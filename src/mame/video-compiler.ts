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
  const screenCallback = graph.nodes.find(node =>
    node.label === 'Callback' &&
    node.props.signal === 'set_screen_update');
  const screenClass = String(screenCallback?.props.targetClass ?? machine.props.cls);
  const screenMethod = String(screenCallback?.props.targetMethod ?? '');
  const screen = ast.findFunctionInHierarchy(screenClass, screenMethod) ??
    ast.ast.units.flatMap(unit => unit.functions).find(fn => fn.name === screenMethod);
  const linearBitmap = screen && compileLinearBitmapVideo(
    graph,
    mameSrc,
    machineId,
    files,
    screen,
  );
  if (linearBitmap) return linearBitmap;
  const packedBitmap = screen && compilePackedBitmapVideo(
    graph,
    mameSrc,
    machineId,
    ast,
    files,
    screen,
  );
  if (packedBitmap) return packedBitmap;

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

function compileLinearBitmapVideo(
  _graph: KnowledgeGraph,
  mameSrc: string,
  _machineId: string,
  files: string[],
  screen: MameFunction,
): CompiledMameVideo | undefined {
  const share = /\bvideo_data\s*=\s*(m_\w+)\[\s*offs\s*\]/.exec(screen.body)?.[1];
  const address = /\boffs\s*=\s*\(\s*\(offs_t\)\s*y\s*<<\s*(\d+)\s*\)\s*\|\s*\(x\s*>>\s*(\d+)\s*\)/
    .exec(screen.body);
  const phase = /\(\s*x\s*&\s*(0x[\da-f]+|\d+)\s*\)\s*==\s*(0x[\da-f]+|\d+)/i
    .exec(screen.body);
  const yExpression = /\buint8_t\s+y\s*=\s*([^;]+);/.exec(screen.body)?.[1];
  if (
    !share ||
    !address ||
    !phase ||
    !yExpression ||
    !screen.body.includes('rgb_t::white()') ||
    !screen.body.includes('rgb_t::black()') ||
    !/video_data\s*=\s*video_data\s*>>\s*1/.test(screen.body)
  ) return undefined;
  const rowShift = Number(address[1]);
  const pixelShift = Number(address[2]);
  const dataXOffset = Number(phase[2]);
  const dataYOffset = evalExpr(yExpression, Object.fromEntries(files.flatMap(file =>
    Object.entries(sourceConstants(readFileSync(join(mameSrc, file), 'utf8')))
  ))) ?? sourceConstant(files, mameSrc, yExpression.trim());
  if (!Number.isFinite(dataYOffset)) return undefined;
  const handlers: GeneratedHandler[] = [];
  addHandler(handlers, screen);
  return {
    plan: {
      gfx: [],
      palette: {
        kind: 'fixed',
        colors: [0xff000000, 0xffffffff],
        colorCount: 2,
        min: 0,
        max: 255,
        scaler: -1,
        channels: [],
        lookupOffset: 0,
        lookupCount: 2,
        lookupMask: 1,
        banks: [{ penOffset: 0, colorOr: 0, lookupCount: 2 }],
        transparentIndirect: 0,
        source: sourceRef(screen),
      },
      tilemaps: [],
      bitmap: {
        share: share.replace(/^m_/, ''),
        bytesPerRow: 1 << rowShift,
        logicalWidth: (1 << 8) + dataXOffset,
        logicalHeight: (1 << 8) - dataYOffset,
        xscale: 1,
        pixelsPerByte: 1 << pixelShift,
        bitsPerPixel: 1,
        lowPixelFirst: true,
        dataXOffset,
        dataYOffset,
        source: sourceRef(screen),
      },
      initialState: {},
      source: sourceRef(screen),
    },
    handlers,
  };
}

function compilePackedBitmapVideo(
  graph: KnowledgeGraph,
  mameSrc: string,
  machineId: string,
  ast: MameAstIndex,
  files: string[],
  screen: MameFunction,
): CompiledMameVideo | undefined {
  const address = /\b(m_\w+)\[\s*effy\s*\*\s*(\d+)\s*\+\s*effx\s*\/\s*(\d+)\s*\]/
    .exec(screen.body);
  const shift = />>\s*\(\s*(\d+)\s*\*\s*\(\s*effx\s*&\s*(\d+)\s*\)\s*\)/
    .exec(screen.body);
  if (!address || !shift) return undefined;
  const bytesPerRow = Number(address[2]);
  const pixelsPerByte = Number(address[3]);
  const bitsPerPixel = Number(shift[1]);
  if (!bytesPerRow || !pixelsPerByte || !bitsPerPixel) return undefined;
  const palette = compileDirectRamPalette(graph, machineId, ast, mameSrc);
  if (!palette) return undefined;
  const scaleName = /\bdst\s*\+\s*x\s*\*\s*(\w+)/.exec(screen.body)?.[1];
  const videoHeader = join(
    dirname(screen.span.file),
    basename(screen.span.file).replace(/_v\.cpp$/, '.h'),
  );
  const xscale = scaleName
    ? sourceConstant(
        existsSync(join(mameSrc, videoHeader)) ? [...files, videoHeader] : files,
        mameSrc,
        scaleName,
      )
    : 1;
  const flipXMember = /\bxorx\s*=\s*(m_\w+)\s*\?/.exec(screen.body)?.[1];
  const flipYMember = /\bxory\s*=\s*(m_\w+)\s*\?/.exec(screen.body)?.[1];
  const scrollMember = /\byscroll\s*=\s*\([^?]+\?\s*\*(m_\w+)/.exec(screen.body)?.[1];
  const scrollColumns = expressionNumber(
    /\beffx\s*<\s*([^&|)]+)/.exec(screen.body)?.[1],
  );
  const handlers: GeneratedHandler[] = [];
  addHandler(handlers, screen);
  return {
    plan: {
      gfx: [],
      palette,
      tilemaps: [],
      bitmap: {
        share: address[1]!.replace(/^m_/, ''),
        paletteShare: palette.share ?? 'palette',
        bytesPerRow,
        logicalWidth: bytesPerRow * pixelsPerByte,
        logicalHeight: 1 << 8,
        xscale: xscale || 1,
        pixelsPerByte,
        bitsPerPixel,
        lowPixelFirst: true,
        ...(flipXMember ? { flipXMember } : {}),
        ...(flipYMember ? { flipYMember } : {}),
        ...(scrollMember ? { scrollMember } : {}),
        ...(scrollColumns ? { scrollColumns } : {}),
        source: sourceRef(screen),
      },
      initialState: {
        ...(flipXMember ? { [flipXMember]: 0 } : {}),
        ...(flipYMember ? { [flipYMember]: 0 } : {}),
      },
      source: sourceRef(screen),
    },
    handlers,
  };
}

function compileDirectRamPalette(
  graph: KnowledgeGraph,
  machineId: string,
  ast: MameAstIndex,
  mameSrc: string,
): GeneratedPromPalettePlan | undefined {
  const deviceIds = new Set(graph.edges
    .filter(edge => edge.from === machineId && edge.rel === 'HAS_DEVICE')
    .map(edge => edge.to));
  const palette = graph.nodes.find(node =>
    deviceIds.has(node.id) && node.label === 'Device' && node.props.type === 'PALETTE');
  const raw = ((palette?.props.config as string[] | undefined) ?? []).join('\n');
  const format = /set_format\(\s*[^,]+,\s*(\w+)::(\w+)\s*,\s*([^)]+)\)/.exec(raw);
  if (!palette || !format) return undefined;
  const fn = ast.findFunctionInHierarchy(format[1]!, format[2]!);
  if (!fn) return undefined;
  const weightsCall = findCallArguments(fn.body, 'compute_resistor_weights');
  if (!weightsCall) return undefined;
  const channels = compileResistorChannels(fn.body, weightsCall);
  if (channels.length !== 3) return undefined;
  const constants = sourceConstants(readFileSync(join(mameSrc, fn.span.file), 'utf8'));
  const weightsArgs = splitMameArgs(weightsCall);
  return {
    kind: 'ram',
    share: String(palette.props.tag),
    colorCount: evalExpr(format[3]!, constants) ?? expressionNumber(format[3]),
    min: evalExpr(weightsArgs[0]!, constants) ?? 0,
    max: evalExpr(weightsArgs[1]!, constants) ?? 255,
    scaler: evalExpr(weightsArgs[2]!, constants) ?? -1,
    channels,
    lookupOffset: 0,
    lookupCount: 0,
    lookupMask: 0xff,
    banks: [],
    transparentIndirect: 0,
    source: sourceRef(fn),
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
    : compileExplicitWeightedChannels(body);
  if (channels.length !== 3) return undefined;
  const loops = numericForLoops(body);
  const lookupOffset = expressionNumber(/color_prom\s*\+=\s*([^;]+)/.exec(body)?.[1]);
  const paletteLoops = loops.filter(loop =>
    loop.body.includes('set_indirect_color') || loop.body.includes('palette_val'));
  const lookupLoops = loops.filter(loop => loop.body.includes('set_pen_indirect'));
  const lookupMask = expressionNumber(
    /(?:ctabentry\s*=\s*[^;]*?|color_prom\+\+\s*)&\s*([^;|)\]]+)/.exec(body)?.[1],
  );
  const indirectBanks = lookupLoops.flatMap(loop => {
    const call = /set_pen_indirect\(\s*([^,]+)\s*,\s*([^)]+)\)/.exec(loop.body);
    if (!call) return [];
    const lookupIndex = /color_prom\[\s*([^\]]+)\s*\]/.exec(loop.body)?.[1] ?? 'i';
    return [{
      penOffset: expressionAt(call[1]!, loop.start),
      colorOr: expressionNumber(/\|\s*(-?(?:0x[\da-f]+|\d+))/i.exec(loop.body)?.[1]),
      lookupOffset: lookupOffset + expressionAt(lookupIndex, loop.start),
      lookupCount: Math.max(0, loop.end - loop.start),
    }];
  });
  const directBanks = compileSequentialPaletteBanks(body, lookupOffset);
  const banks = indirectBanks.length ? indirectBanks : directBanks;
  const lookupCount = banks[0]?.lookupCount ?? 0;
  if (!lookupCount) return undefined;
  return {
    region,
    colorCount: paletteLoops[0]
      ? Math.max(0, paletteLoops[0].end - paletteLoops[0].start)
      : 0,
    min: weightsCall ? expressionNumber(splitMameArgs(weightsCall)[0]) : 0,
    max: weightsCall ? expressionNumber(splitMameArgs(weightsCall)[1]) : 255,
    scaler: weightsCall ? Number(splitMameArgs(weightsCall)[2]) || -1 : 1,
    channels,
    lookupOffset,
    lookupCount,
    lookupMask,
    banks,
    transparentIndirect: 0,
    source: sourceRef(fn),
  };
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
  if (!resistanceArrays.size) return [];
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
    /\b(bit\d+)\s*=\s*BIT\(\s*(?:color_prom\[i\]|raw)\s*,\s*(\d+)\s*\)|(?:int\s+const|const\s+int)\s+([rgb])\s*=\s*combine_weights\(\s*(\w+)\s*,\s*([^)]+)\)/g;
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

function compileExplicitWeightedChannels(
  body: string,
): GeneratedPromPalettePlan['channels'] {
  const channels: GeneratedPromPalettePlan['channels'] = [];
  const bits = new Map<string, { bit: number; offset: number }>();
  const pattern =
    /\b(bit\d+)\s*=\s*BIT\(\s*color_prom\[\s*i(?:\s*\+\s*([^\]]+))?\s*\]\s*,\s*(\d+)\s*\)|(?:int\s+const|const\s+int)\s+([rgb])\s*=\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1]) {
      bits.set(match[1], {
        bit: expressionNumber(match[3]),
        offset: expressionNumber(match[2]),
      });
      continue;
    }
    const channelBits: number[] = [];
    const offsets: number[] = [];
    const weights: number[] = [];
    for (const term of match[5]!.matchAll(
      /(-?(?:0x[\da-f]+|\d+))\s*\*\s*(bit\d+)/gi,
    )) {
      const source = bits.get(term[2]!);
      if (!source) continue;
      channelBits.push(source.bit);
      offsets.push(source.offset);
      weights.push(expressionNumber(term[1]));
    }
    channels.push({
      channel: match[4] as 'r' | 'g' | 'b',
      bits: channelBits,
      offsets,
      weights,
    });
  }
  return channels;
}

function compileSequentialPaletteBanks(
  body: string,
  lookupOffset: number,
): GeneratedPromPalettePlan['banks'] {
  const banks: GeneratedPromPalettePlan['banks'] = [];
  const pattern =
    /for\s*\(\s*int\s+i\s*=\s*([^;]+)\s*;\s*i\s*<\s*([^;]+)\s*;\s*(?:i\+\+|\+\+i)\s*\)\s*palette\.set_pen_color\(\s*([^,]+)\s*,\s*palette_val\[\s*(.*?)\s*\]\s*\)\s*;/gs;
  let cursor = lookupOffset;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const start = expressionNumber(match[1]);
    const end = expressionNumber(match[2]);
    const count = Math.max(0, end - start);
    banks.push({
      penOffset: expressionAt(match[3]!, start),
      colorOr: expressionNumber(
        /(?:\+|\|)\s*(-?(?:0x[\da-f]+|\d+))\s*$/i.exec(match[4]!)?.[1],
      ),
      lookupOffset: cursor,
      lookupCount: count,
    });
    cursor += count;
  }
  return banks;
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

function sourceConstant(files: string[], mameSrc: string, name: string): number {
  for (const file of files) {
    const value = sourceConstants(readFileSync(join(mameSrc, file), 'utf8'))[name];
    if (value !== undefined) return value;
  }
  return 0;
}

function sourceConstants(source: string): Record<string, number> {
  const pending = new Map<string, string>();
  for (const match of source.matchAll(
    /\bstatic\s+constexpr\s+[\w:<>]+\s+(\w+)\s*=\s*([^;]+);/g,
  )) {
    pending.set(match[1]!, match[2]!.trim());
  }
  for (const match of source.matchAll(/^\s*#define\s+(\w+)\s+([^/\r\n]+)/gm)) {
    if (!match[2]!.includes('(') || /^\s*\(/.test(match[2]!)) {
      pending.set(match[1]!, match[2]!.trim());
    }
  }
  const values: Record<string, number> = {};
  for (let pass = 0; pass <= pending.size; pass++) {
    for (const [name, expression] of pending) {
      const value = evalExpr(expression, values);
      if (value !== null) values[name] = value;
    }
  }
  return values;
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
  return loops;
}

function sourceRef(fn: MameFunction): GeneratedSourceRef {
  return { file: fn.span.file, line: fn.span.line, column: fn.span.column };
}
