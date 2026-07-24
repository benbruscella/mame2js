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
  const fail = (reason: string): undefined => {
    if (process.env.MAMEKIT_DEBUG_VIDEO === '1') console.error(`video compiler: ${reason}`);
    return undefined;
  };
  const machine = graph.nodes.find(node => node.id === machineId);
  if (!machine) return fail(`missing machine ${machineId}`);
  const driver = graph.meta.driverFile;
  const driverStem = basename(driver).replace(/\.cpp$/, '');
  const driverDir = dirname(driver);
  const candidates = graph.nodes
    .filter(node => node.label === 'SourceFile')
    .map(node => String(node.props.path));
  candidates.push(
    driver,
    join(driverDir, `${driverStem}.h`),
    join(driverDir, `${driverStem}_v.cpp`),
    join(driverDir, `${driverStem}_a.cpp`),
  );
  const files: string[] = [];
  for (const candidate of candidates) {
    const resolved = [
      candidate,
      join(driverDir, candidate),
    ].find(file => existsSync(join(mameSrc, file)));
    if (!resolved || files.includes(resolved)) continue;
    files.push(resolved);
    if (/\.h(?:pp)?$/.test(resolved)) {
      const implementation = resolved.replace(/\.h(?:pp)?$/, '.cpp');
      if (existsSync(join(mameSrc, implementation)) && !files.includes(implementation)) {
        files.push(implementation);
      }
    }
  }
  if (!files.includes(driver) && existsSync(join(mameSrc, driver))) files.push(driver);
  const ast = new MameAstIndex(parseMameAst(
    [...new Set(files)].map(file => ({ file, source: readFileSync(join(mameSrc, file), 'utf8') })),
  ));
  const source = [...new Set(files)]
    .map(file => readFileSync(join(mameSrc, file), 'utf8'))
    .join('\n');
  const constants = sourceNumericConstants(source);
  const memberDefaults = sourceMemberDefaults(source, constants);
  const machineIds = machineConfigClosure(graph, machineId);
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
  if (!config) return fail(`missing config source ${String(machine.props.cls)}::${String(machine.props.name)}`);
  const startMatch =
    /MCFG_VIDEO_START_OVERRIDE\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/.exec(config.body);
  const start = startMatch
    ? ast.findFunction(startMatch[1]!, `video_start_${startMatch[2]}`)
    : ast.findFunctionInHierarchy(String(machine.props.cls), 'video_start');
  if (!start) return fail(`missing video_start for ${String(machine.props.cls)}`);

  const decodes = graph.edges
    .filter(edge => machineIds.has(edge.from) && edge.rel === 'DECODES')
    .map(edge => graph.nodes.find(node => node.id === edge.to))
    .filter((node): node is KGNode => Boolean(node));
  if (!decodes.length) return fail(`missing gfx decode in machine composition`);
  const decodeBindings = compileDecodeBindings(graph, machineIds);
  const renderScale = decodes
    .flatMap(decode => graph.edges
      .filter(edge => edge.from === decode.id && edge.rel === 'HAS_ENTRY'))
    .map(edge => graph.nodes.find(node => node.id === edge.to))
    .filter((node): node is KGNode => Boolean(node))
    .reduce((scale, entry) => Math.max(scale, Number(entry.props.xscale ?? 1)), 1);
  const numericDefaults = numericState(memberDefaults);
  const tilemaps = compileTilemaps(start, { ...constants, ...numericDefaults })
    .filter((tilemap, index, all) =>
      all.findIndex(candidate => candidate.member === tilemap.member) === index);
  if (!tilemaps.length) return fail(`video_start emitted no tilemaps`);
  const handlers: GeneratedHandler[] = [];
  const game = graph.nodes.find(node => node.label === 'Game');
  const delegates = compileInitDelegates(
    ast,
    String(machine.props.cls),
    String(game?.props.init ?? ''),
  );
  const roots = [
    ...tilemaps.flatMap(tilemap => [tilemap.mapper, tilemap.tileInfo]),
    ...(screen ? [`${screen.className}.${screen.name}`] : []),
    ...Object.values(delegates),
  ];
  addHandlerClosure(handlers, ast, roots, constants);
  const gfx = decodes.flatMap(decode => {
    const binding = decodeBindings.get(String(decode.props.name));
    return graph.edges
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
        ...(binding?.decodeMember ? { decodeMember: binding.decodeMember } : {}),
        ...(binding?.paletteMember ? { paletteMember: binding.paletteMember } : {}),
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
  });
  const paletteMembers = [...new Set(
    [...decodeBindings.values()].map(binding => binding.paletteMember),
  )];
  const palettes = paletteMembers.length > 1
    ? compileNamedPalettes(graph, ast, source, constants, paletteMembers)
    : [];
  const palette = palettes.length ? undefined : compilePalette(graph, machineIds, ast, constants);
  if (!palette && palettes.length !== paletteMembers.length) {
    return fail(`palette callback did not lower`);
  }
  const colorTables = compileVideoColorTables(source, constants);
  const lfsrTable = compileVideoLfsr(ast, String(machine.props.cls), constants);
  const needsClassDefaults = renderScale !== 1 ||
    Object.keys(delegates).length > 0 ||
    Boolean(lfsrTable);

  return {
    plan: {
      gfx,
      ...(palette ? { palette } : {}),
      ...(palettes.length ? { palettes } : {}),
      tilemaps,
      initialState: {
        ...arrayState(memberDefaults),
        ...(needsClassDefaults ? memberDefaults : {}),
        ...initialState(start.body, { ...constants, ...numericDefaults }),
      },
      ...(renderScale !== 1 ? { renderScale: { x: renderScale, y: 1 } } : {}),
      ...(Object.keys(delegates).length ? { delegates } : {}),
      ...(Object.keys(colorTables).length ? { colorTables } : {}),
      ...(lfsrTable ? { lfsrTable } : {}),
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

function compileTilemaps(
  start: MameFunction,
  values: Record<string, number> = {},
): GeneratedVideoPlan['tilemaps'] {
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
    const member = match[1]!;
    const nextCreate = start.body.slice(close + 1).search(createRe);
    const setupEnd = nextCreate < 0 ? start.body.length : close + 1 + nextCreate;
    const setup = start.body.slice(close + 1, setupEnd);
    const scrollColumns = expressionNumber(
      new RegExp(`${member}->set_scroll_cols\\s*\\(([^)]+)\\)`).exec(setup)?.[1],
      values,
    );
    const scrollRows = expressionNumber(
      new RegExp(`${member}->set_scroll_rows\\s*\\(([^)]+)\\)`).exec(setup)?.[1],
      values,
    );
    const scrollDx = tilemapScrollDelta(setup, member, 'x', values);
    const scrollDy = tilemapScrollDelta(setup, member, 'y', values);
    const transparentExpression =
      new RegExp(`${member}->set_transparent_pen\\s*\\(([^)]+)\\)`).exec(setup)?.[1]
        ?? new RegExp(`${member}->set_transparent_pen\\s*\\(([^)]+)\\)`).exec(start.body)?.[1];
    const transparentPen = transparentExpression === undefined
      ? undefined
      : expressionNumber(transparentExpression, values);
    const transparentIndirectExpression = new RegExp(
      `${member}->configure_groups\\s*\\([^,]+,\\s*([^)]+)\\)`,
    ).exec(setup)?.[1] ?? new RegExp(
      `${member}->configure_groups\\s*\\([^,]+,\\s*([^)]+)\\)`,
    ).exec(start.body)?.[1];
    const transparentIndirect = transparentIndirectExpression === undefined
      ? undefined
      : expressionNumber(transparentIndirectExpression, values);
    plans.push({
      member,
      ...(/\b(m_\w+)\b/.exec(args[0] ?? '')?.[1]
        ? { decodeMember: /\b(m_\w+)\b/.exec(args[0] ?? '')![1] }
        : {}),
      tileWidth: expressionNumber(args[3], values),
      tileHeight: expressionNumber(args[4], values),
      columns: expressionNumber(args[5], values),
      rows: expressionNumber(args[6], values),
      mapper,
      tileInfo,
      ...(scrollColumns > 0 ? { scrollColumns } : {}),
      ...(scrollRows > 0 ? { scrollRows } : {}),
      ...(scrollDx ? { scrollDx } : {}),
      ...(scrollDy ? { scrollDy } : {}),
      ...(transparentPen !== undefined && transparentPen >= 0 ? { transparentPen } : {}),
      ...(transparentIndirect !== undefined && transparentIndirect >= 0
        ? { transparentIndirect }
        : {}),
      source: sourceRef(start),
    });
    createRe.lastIndex = close + 1;
  }
  return plans;
}

function tilemapScrollDelta(
  source: string,
  member: string,
  axis: 'x' | 'y',
  values: Record<string, number>,
): [number, number] | undefined {
  const match = new RegExp(
    `${member}->set_scrolld${axis}\\s*\\(\\s*([^,]+)\\s*,\\s*([^)]+)\\)`,
  ).exec(source);
  if (!match) return undefined;
  return [
    expressionNumber(match[1], values),
    expressionNumber(match[2], values),
  ];
}

function compileDecodeBindings(
  graph: KnowledgeGraph,
  machineIds: Set<string>,
): Map<string, { decodeMember: string; paletteMember: string }> {
  const deviceIds = new Set(graph.edges
    .filter(edge => machineIds.has(edge.from) && edge.rel === 'HAS_DEVICE')
    .map(edge => edge.to));
  const bindings = new Map<string, { decodeMember: string; paletteMember: string }>();
  for (const device of graph.nodes.filter(node =>
    deviceIds.has(node.id) &&
    node.label === 'Device' &&
    node.props.type === 'GFXDECODE')) {
    const raw = ((device.props.config as string[] | undefined) ?? []).join('\n');
    const args = /GFXDECODE(?:_SCALE)?\s*\(\s*config\s*,\s*(m_\w+)\s*,\s*(m_\w+)\s*,\s*(\w+)/.exec(raw);
    if (!args) continue;
    bindings.set(args[3]!, {
      decodeMember: args[1]!,
      paletteMember: args[2]!,
    });
  }
  return bindings;
}

interface PaletteNetwork {
  min: number;
  max: number;
  scaler: number;
  resistances: number[];
  pulldown: number;
  pullup: number;
}

function compileNamedPalettes(
  graph: KnowledgeGraph,
  ast: MameAstIndex,
  source: string,
  constants: Record<string, number>,
  members: string[],
): NonNullable<GeneratedVideoPlan['palettes']> {
  const functions = ast.ast.units.flatMap(unit => unit.functions);
  const scalars = compilePaletteScalars(source, constants);
  return members.flatMap(member => {
    const fn = functions.find(candidate =>
      new RegExp(`\\b${member}->set_(?:pen|indirect)`).test(candidate.body));
    if (!fn) return [];
    const plan = compileNamedPalette(
      graph,
      source,
      fn,
      member,
      { ...constants, ...scalars },
    );
    return plan ? [{ member, plan }] : [];
  });
}

function compileNamedPalette(
  graph: KnowledgeGraph,
  source: string,
  fn: MameFunction,
  member: string,
  constants: Record<string, number>,
): GeneratedPromPalettePlan | undefined {
  const fail = (reason: string): undefined => {
    if (process.env.MAMEKIT_DEBUG_VIDEO === '1') {
      console.error(`video palette ${member}: ${reason}`);
    }
    return undefined;
  };
  const regionByVariable = new Map(
    [...fn.body.matchAll(
      /\b(\w+)\s*=\s*memregion\(\s*"([^"]+)"\s*\)->base\(\)/g,
    )].map(match => [match[1]!, match[2]!]),
  );
  const loops = numericForLoops(fn.body);
  const colorLoop = loops.find(loop =>
    new RegExp(`\\b${member}->set_(?:pen_color|indirect_color)`).test(loop.body));
  if (!colorLoop) return fail('color loop missing');
  const colorSource = /\b\w+\s*=\s*(\w+)\s*\[\s*i\s*\]/.exec(colorLoop.body)?.[1];
  const region = colorSource && regionByVariable.get(colorSource);
  if (!region) return fail(`color PROM region missing for ${String(colorSource)}`);

  const networks = compilePaletteNetworks(source, fn.body, constants);
  const channels: GeneratedPromPalettePlan['channels'] = [];
  const channelRe =
    /(?:int(?:\s+const)?|const\s+int)\s+([rgb])\s*=\s*combine_weights\(\s*(\w+)\s*,\s*([^;]+)\)\s*;/g;
  let channel: RegExpExecArray | null;
  while ((channel = channelRe.exec(colorLoop.body)) !== null) {
    const network = networks.get(channel[2]!);
    if (!network) continue;
    const bits = [...channel[3]!.matchAll(/BIT\(\s*\w+\s*,\s*(\d+)\s*\)/g)]
      .map(bit => Number(bit[1]));
    if (!bits.length) continue;
    channels.push({
      channel: channel[1] as 'r' | 'g' | 'b',
      bits,
      resistances: network.resistances,
      pulldown: network.pulldown,
      pullup: network.pullup,
    });
  }
  if (channels.length !== 3) {
    return fail(`expected three resistor channels, got ${channels.length}`);
  }

  const count = Math.max(0, colorLoop.end - colorLoop.start);
  const direct = new RegExp(`\\b${member}->set_pen_color`).test(colorLoop.body);
  const banks: GeneratedPromPalettePlan['banks'] = [];
  let lookupRegion: string | undefined;
  if (direct) {
    banks.push({
      penOffset: 0,
      colorOr: 0,
      lookupOffset: 0,
      lookupCount: count,
      direct: true,
    });
  } else {
    for (const loop of loops.filter(candidate =>
      new RegExp(`\\b${member}->set_pen_indirect`).test(candidate.body))) {
      const call = findCallArguments(loop.body, `${member}->set_pen_indirect`);
      if (!call) continue;
      const args = splitMameArgs(call);
      const valueName = args[1]?.trim();
      const sourceVariable = valueName &&
        new RegExp(`\\b${valueName}\\s*=\\s*(\\w+)\\s*\\[\\s*([^\\]]+)\\s*\\]`)
          .exec(loop.body);
      const sourceRegion = sourceVariable && regionByVariable.get(sourceVariable[1]!);
      if (!sourceRegion) continue;
      lookupRegion = sourceRegion;
      banks.push({
        penOffset: expressionAt(args[0] ?? '0', loop.start),
        colorOr: expressionNumber(
          /(?:\||\+)\s*(-?(?:0x[\da-f]+|\d+))/i.exec(args[1] ?? '')?.[1],
        ),
        lookupOffset: expressionAt(sourceVariable[2] ?? 'i', loop.start),
        lookupCount: Math.max(0, loop.end - loop.start),
      });
    }
    const fixedCall = new RegExp(
      `${member}->set_pen_indirect\\s*\\(([^;]+)\\)\\s*;`,
      'g',
    );
    for (const call of fn.body.matchAll(fixedCall)) {
      const args = splitMameArgs(call[1]!);
      if (
        args.length < 2 ||
        /\bi\b/.test(args[0]!) ||
        /\b(?:promval|color_prom)\b/.test(args[1]!)
      ) continue;
      banks.push({
        penOffset: expressionNumber(args[0], constants),
        colorOr: expressionNumber(args[1], constants),
        lookupOffset: 0,
        lookupCount: 1,
        direct: true,
      });
    }
  }
  if (!banks.length) return fail('pen lookup banks missing');
  const network = networks.values().next().value as PaletteNetwork | undefined;
  if (!network) return fail('resistor network missing');
  return {
    region,
    ...(lookupRegion && lookupRegion !== region ? { lookupRegion } : {}),
    colorCount: count,
    min: network.min,
    max: network.max,
    scaler: network.scaler,
    channels,
    lookupOffset: banks[0]!.lookupOffset ?? 0,
    lookupCount: banks[0]!.lookupCount ?? 0,
    lookupMask: 0xff,
    banks,
    transparentIndirect: 0,
    source: sourceRef(fn),
  };
}

function compilePaletteNetworks(
  source: string,
  body: string,
  constants: Record<string, number>,
): Map<string, PaletteNetwork> {
  const arrays = paletteResistanceArrays(source);
  const call = findCallArguments(body, 'compute_resistor_weights');
  const result = new Map<string, PaletteNetwork>();
  if (!call) return result;
  const args = splitMameArgs(call);
  const min = expressionNumber(args[0], constants);
  const max = expressionNumber(args[1], constants);
  const scaler = expressionNumber(args[2], constants);
  for (let index = 3; index + 4 < args.length; index += 5) {
    const count = expressionNumber(args[index], constants);
    if (!count) continue;
    const resistanceName = /^(\w+)/.exec((args[index + 1] ?? '').replace(/^&/, '').trim())?.[1];
    const resistances = resistanceName ? arrays.get(resistanceName) : undefined;
    if (!resistances) continue;
    const offset = Number(/\[\s*(\d+)\s*\]/.exec(args[index + 1] ?? '')?.[1] ?? 0);
    const name = (args[index + 2] ?? '').replace(/^&/, '').trim();
    result.set(name, {
      min,
      max,
      scaler,
      resistances: resistances.slice(offset, offset + count),
      pulldown: paletteResistanceValue(args[index + 3], arrays, constants),
      pullup: paletteResistanceValue(args[index + 4], arrays, constants),
    });
  }
  return result;
}

function compilePaletteScalars(
  source: string,
  constants: Record<string, number>,
): Record<string, number> {
  const arrays = paletteResistanceArrays(source);
  const values: Record<string, number> = {};
  const assignment = /\b(\w+)\s*=\s*compute_resistor_weights\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(source)) !== null) {
    const open = source.indexOf('(', match.index + match[0].length - 1);
    const close = matchingPair(source, open, '(', ')');
    if (close < 0) continue;
    const args = splitMameArgs(source.slice(open + 1, close));
    const max = expressionNumber(args[1], constants);
    const requested = evalExpr(substituteNumbers(args[2] ?? '', constants));
    if (requested != null && requested >= 0) {
      values[match[1]!] = requested;
      continue;
    }
    let maximum = 0;
    for (let index = 3; index + 4 < args.length; index += 5) {
      const count = expressionNumber(args[index], constants);
      const resistanceName = /^(\w+)/.exec((args[index + 1] ?? '').trim())?.[1];
      const resistances = resistanceName ? arrays.get(resistanceName)?.slice(0, count) : undefined;
      if (!resistances?.length) continue;
      const pulldown = paletteResistanceValue(args[index + 3], arrays, constants);
      const pullup = paletteResistanceValue(args[index + 4], arrays, constants);
      maximum = Math.max(maximum, resistorMaximum(resistances, pulldown, pullup, max));
    }
    if (maximum > 0) values[match[1]!] = max / maximum;
  }
  return values;
}

function paletteResistanceArrays(source: string): Map<string, number[]> {
  return new Map(
    [...source.matchAll(
      /(?:static\s+)?(?:constexpr|const)\s+int\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]+)\}/g,
    )].map(match => [
      match[1]!,
      splitMameArgs(match[2]!).map(value => expressionNumber(value)),
    ]),
  );
}

function paletteResistanceValue(
  value: string | undefined,
  arrays: Map<string, number[]>,
  constants: Record<string, number>,
): number {
  const reference = value && /^(\w+)\s*\[\s*(\d+)\s*\]$/.exec(value.trim());
  if (reference) return arrays.get(reference[1]!)?.[Number(reference[2])] ?? 0;
  return expressionNumber(value, constants);
}

function resistorMaximum(
  resistances: number[],
  pulldown: number,
  pullup: number,
  maximum: number,
): number {
  return resistances.reduce((sum, _resistance, selected) => {
    let low = pulldown ? 1 / pulldown : 1 / 1e12;
    let high = pullup ? 1 / pullup : 1 / 1e12;
    resistances.forEach((resistance, index) => {
      if (!resistance) return;
      if (index === selected) high += 1 / resistance;
      else low += 1 / resistance;
    });
    const r0 = 1 / low;
    const r1 = 1 / high;
    return sum + Math.min(maximum, Math.max(0, maximum * r0 / (r1 + r0)));
  }, 0);
}

function compilePalette(
  graph: KnowledgeGraph,
  machineIds: Set<string>,
  ast: MameAstIndex,
  constants: Record<string, number> = {},
): GeneratedPromPalettePlan | undefined {
  const deviceIds = new Set(graph.edges
    .filter(edge => machineIds.has(edge.from) && edge.rel === 'HAS_DEVICE')
    .map(edge => edge.to));
  const palette = graph.nodes.find(node =>
    deviceIds.has(node.id) && node.label === 'Device' && node.props.type === 'PALETTE');
  const raw = ((palette?.props.config as string[] | undefined) ?? []).join('\n');
  const callback = /FUNC\(\s*(\w+)::(\w+)\s*\)/.exec(raw);
  if (!callback) {
    if (process.env.MAMEKIT_DEBUG_VIDEO === '1') console.error('video palette: callback missing', raw);
    return undefined;
  }
  const fn = ast.findFunctionInHierarchy(callback[1]!, callback[2]!);
  if (!fn) {
    if (process.env.MAMEKIT_DEBUG_VIDEO === '1') console.error('video palette: source function missing', callback[0]);
    return undefined;
  }
  const body = fn.body;
  const region = /memregion\(\s*"([^"]+)"\s*\)/.exec(body)?.[1];
  const weightsCall = findCallArguments(body, 'compute_resistor_weights');
  if (!region) return undefined;
  const channels = weightsCall
    ? compileResistorChannels(body, weightsCall)
    : compileFixedWeightChannels(body);
  if (channels.length !== 3) {
    if (process.env.MAMEKIT_DEBUG_VIDEO === '1') console.error('video palette: channels', channels.length);
    return undefined;
  }
  const loops = numericForLoops(body);
  const paletteLoop = loops.find(loop =>
    loop.body.includes('set_indirect_color') ||
    loop.body.includes('set_pen_color') ||
    /\bpalette_val\s*\[\s*i\s*\]\s*=\s*rgb_t/.test(loop.body));
  const lookupLoops = loops.filter(loop =>
    loop.body.includes('set_pen_indirect') || loop.body.includes('set_pen_color'));
  const lookupOffset = expressionNumber(/color_prom\s*\+=\s*([^;]+)/.exec(body)?.[1]);
  let lookupMask = expressionNumber(/color_prom[^;]*?&\s*(0x[\da-f]+|\d+)/i.exec(
    lookupLoops.map(loop => loop.body).join('\n'),
  )?.[1]);
  let postIncrementOffset = lookupOffset + (
    paletteLoop?.body.includes('color_prom++')
      ? Math.max(0, paletteLoop.end - paletteLoop.start)
      : 0
  );
  const banks: GeneratedPromPalettePlan['banks'] = lookupLoops.flatMap(loop => {
    const method = loop.body.includes('set_pen_indirect')
      ? 'palette.set_pen_indirect'
      : 'palette.set_pen_color';
    return findCallArgumentLists(loop.body, method).flatMap(call => {
      const args = splitMameArgs(call);
      if (process.env.MAMEKIT_DEBUG_VIDEO === '1') {
        console.error('video palette: lookup loop', {
          start: loop.start,
          end: loop.end,
          body: loop.body.trim(),
          args,
        });
      }
      const lookupExpression = args[1] ?? '';
      const colorExpression = /ctabentry\s*=\s*([^;]+)/.exec(loop.body)?.[1]
        ?? lookupExpression;
      const lookupIndex = /color_prom\[\s*([^\]]+)\s*\]/.exec(colorExpression)?.[1];
      const usesPostIncrement = /\*\s*color_prom\s*\+\+/.test(colorExpression);
      // Identity mappings like set_pen_indirect(base + i, 32 + i) carry no
      // PROM lookup: the loop expressions fully describe pen and color steps.
      if (
        method === 'palette.set_pen_indirect' &&
        !lookupIndex && !usesPostIncrement && !colorExpression.includes('color_prom')
      ) {
        const penOffset = expressionAt(args[0]!, loop.start);
        const penStride = expressionAt(args[0]!, loop.start + 1) - penOffset;
        const colorOr = expressionAt(lookupExpression, loop.start);
        const colorStride = expressionAt(lookupExpression, loop.start + 1) - colorOr;
        return [{
          penOffset,
          ...(penStride !== 1 ? { penStride } : {}),
          colorOr,
          ...(colorStride !== 1 ? { colorStride } : {}),
          lookupOffset: 0,
          lookupCount: Math.max(0, loop.end - loop.start),
          direct: true,
        }];
      }
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
  });
  const palettePenCall = paletteLoop?.body.includes('set_pen_color')
    ? findCallArguments(paletteLoop.body, 'palette.set_pen_color')
    : undefined;
  const direct = Boolean(
    palettePenCall && splitMameArgs(palettePenCall)[1]?.includes('rgb_t('),
  );
  if (direct) {
    const regionNode = graph.nodes.find(node =>
      node.label === 'RomRegion' && node.props.tag === region);
    const count = Number(regionNode?.props.size ?? 0);
    if (!count) return undefined;
    lookupMask = 0xff;
    banks.splice(0, banks.length, {
      penOffset: 0,
      colorOr: 0,
      lookupOffset: 0,
      lookupCount: count,
      direct: true,
    });
  }
  if (!paletteLoop || !banks.length || !lookupMask) {
    if (process.env.MAMEKIT_DEBUG_VIDEO === '1') console.error('video palette: output', {
      paletteLoop: Boolean(paletteLoop), banks: banks.length, lookupMask, direct,
    });
    return undefined;
  }
  const args = weightsCall ? splitMameArgs(weightsCall) : [];
  const computedColors = compileComputedColorGroups(body, paletteLoop, loops);
  return {
    region,
    colorCount: direct
      ? Number(graph.nodes.find(node => node.label === 'RomRegion' && node.props.tag === region)?.props.size ?? 0)
      : Math.max(0, paletteLoop.end - paletteLoop.start),
    min: weightsCall ? expressionNumber(args[0], constants) : 0,
    max: weightsCall ? expressionNumber(args[1], constants) : 255,
    scaler: weightsCall ? Number(args[2]) || -1 : 1,
    channels,
    ...(computedColors.length ? { computedColors } : {}),
    lookupOffset,
    lookupCount: banks[0]!.lookupCount ?? 0,
    lookupMask,
    banks,
    transparentIndirect: 0,
    source: sourceRef(fn),
  };
}

/**
 * Lower indirect-color loops whose channels are computed from the color
 * INDEX bits through their own resistor network — MAME's 05xx star palette
 * shape: `r = combine_weights(rsweights, BIT(i, 0), BIT(i, 1))` followed by
 * `set_indirect_color(base + i, rgb_t(r, g, b))`.
 */
function compileComputedColorGroups(
  body: string,
  paletteLoop: { start: number; end: number; body: string } | undefined,
  loops: { start: number; end: number; body: string }[],
): NonNullable<GeneratedPromPalettePlan['computedColors']> {
  const networks = parseResistorNetworks(body);
  const groups: NonNullable<GeneratedPromPalettePlan['computedColors']> = [];
  for (const loop of loops) {
    if (loop === paletteLoop || !loop.body.includes('set_indirect_color')) continue;
    if (loop.body.includes('color_prom')) continue;
    const call = findCallArguments(loop.body, 'palette.set_indirect_color') ??
      findCallArguments(loop.body, 'set_indirect_color');
    if (!call) continue;
    const base = expressionAt(splitMameArgs(call)[0] ?? '0', loop.start);
    const channelRe =
      /(?:int\s+const|const\s+int)\s+([rgb])\s*=\s*combine_weights\(\s*(\w+)\s*,\s*([^;]+)\)\s*;/g;
    const channels: NonNullable<GeneratedPromPalettePlan['computedColors']>[number]['channels'] = [];
    let network:
      | { resistances: number[]; pulldown: number; pullup: number;
          min: number; max: number; scaler: number }
      | undefined;
    let match: RegExpExecArray | null;
    while ((match = channelRe.exec(loop.body)) !== null) {
      const candidate = networks.get(match[2]!);
      if (!candidate) continue;
      const bits = [...match[3]!.matchAll(/BIT\(\s*i\s*,\s*(\d+)\s*\)/g)]
        .map(bit => Number(bit[1]));
      if (!bits.length) continue;
      network = candidate;
      channels.push({
        channel: match[1] as 'r' | 'g' | 'b',
        bits,
        resistances: candidate.resistances,
        pulldown: candidate.pulldown,
        pullup: candidate.pullup,
      });
    }
    if (channels.length !== 3 || !network) continue;
    groups.push({
      base,
      count: Math.max(0, loop.end - loop.start),
      min: network.min,
      max: network.max,
      scaler: network.scaler,
      channels,
    });
  }
  return groups;
}

/** Parse every compute_resistor_weights call into weight-variable networks. */
function parseResistorNetworks(body: string): Map<string, {
  resistances: number[];
  pulldown: number;
  pullup: number;
  min: number;
  max: number;
  scaler: number;
}> {
  const resistanceArrays = new Map(
    [...body.matchAll(
      /(?:static\s+)?(?:constexpr|const)\s+int\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]+)\}/g,
    )].map(match => [
      match[1]!,
      splitMameArgs(match[2]!).map(value => expressionNumber(value)),
    ]),
  );
  const networks = new Map<string, {
    resistances: number[];
    pulldown: number;
    pullup: number;
    min: number;
    max: number;
    scaler: number;
  }>();
  let at = 0;
  while (true) {
    const index = body.indexOf('compute_resistor_weights(', at);
    if (index < 0) break;
    const open = body.indexOf('(', index);
    const close = matchingPair(body, open, '(', ')');
    if (close < 0) break;
    at = close;
    const args = splitMameArgs(body.slice(open + 1, close));
    const min = expressionNumber(args[0]);
    const max = expressionNumber(args[1]);
    const scaler = Number(args[2]) || -1;
    for (let position = 3; position + 4 < args.length; position += 5) {
      const count = expressionNumber(args[position]);
      if (!count) continue;
      const resistanceArg = (args[position + 1] ?? '').replace(/^&/, '').trim();
      const resistanceName = /^(\w+)/.exec(resistanceArg)?.[1] ?? '';
      const resistanceValues = resistanceArrays.get(resistanceName);
      if (!resistanceValues) continue;
      const offset = Number(/\[\s*(\d+)\s*\]/.exec(resistanceArg)?.[1] ?? 0);
      const weightName = (args[position + 2] ?? '').replace(/^&/, '').trim();
      // Pulldown/pullup may reference the resistor table (resistances[0]).
      const resistorValue = (value: string | undefined): number => {
        const reference = value && /^(\w+)\s*\[\s*(\d+)\s*\]$/.exec(value.trim());
        if (reference) return resistanceArrays.get(reference[1]!)?.[Number(reference[2])] ?? 0;
        return expressionNumber(value);
      };
      networks.set(weightName, {
        resistances: resistanceValues.slice(offset, offset + count),
        pulldown: resistorValue(args[position + 3]),
        pullup: resistorValue(args[position + 4]),
        min,
        max,
        scaler,
      });
    }
  }
  return networks;
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
    /\b(bit\d+)\s*=\s*BIT\(\s*(?:color_prom\[i\]|\*\s*color_prom)\s*,\s*(\d+)\s*\)|(?:int\s+const|const\s+int)\s+([rgb])\s*=\s*combine_weights\(\s*(\w+)\s*,\s*([^)]+)\)/g;
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

function addHandler(
  handlers: GeneratedHandler[],
  fn: MameFunction,
  constants: Record<string, number> = {},
): void {
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
    constants: Object.fromEntries(
      Object.entries(constants).filter(([name]) => new RegExp(`\\b${name}\\b`).test(fn.body)),
    ),
    source: sourceRef(fn),
  });
}

function addHandlerClosure(
  handlers: GeneratedHandler[],
  ast: MameAstIndex,
  roots: string[],
  constants: Record<string, number>,
): void {
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const [ownerClass, method] = splitHandlerKey(key);
    const fn = ast.findFunctionInHierarchy(ownerClass, method);
    if (!fn) continue;
    addHandler(handlers, fn, constants);
    queue.push(...calledSourceMethods(fn.body).map(name => `${fn.className}.${name}`));
  }
}

function machineConfigClosure(graph: KnowledgeGraph, machineId: string): Set<string> {
  const result = new Set<string>();
  const queue = [machineId];
  while (queue.length) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...graph.edges
      .filter(edge => edge.from === id && edge.rel === 'CALLS')
      .map(edge => edge.to));
  }
  return result;
}

function sourceNumericConstants(source: string): Record<string, number> {
  const expressions = new Map<string, string>();
  for (const match of source.matchAll(/^\s*#define\s+(\w+)\s+([^/\r\n]+)/gm)) {
    if (!match[2]!.includes('(') || /^\s*\(+[\dA-Za-z_]/.test(match[2]!)) {
      expressions.set(match[1]!, match[2]!.trim());
    }
  }
  for (const match of source.matchAll(
    /\b(?:static\s+)?constexpr\s+(?:\w+\s+)+(\w+)\s*(?:\([^)]*\))?\s*=\s*([^;]+);/g,
  )) {
    expressions.set(match[1]!, match[2]!.trim());
  }
  const values: Record<string, number> = {};
  for (let pass = 0; pass < expressions.size + 1; pass++) {
    let changed = false;
    for (const [name, expression] of expressions) {
      if (values[name] !== undefined) continue;
      const normalized = substituteNumbers(expression, values)
        .replace(/([\d.]+)_MHz_XTAL/g, '($1*1000000)')
        .replace(/([\d.]+)_kHz_XTAL/g, '($1*1000)')
        .replace(/\(\s*(\d+)\s*<<\s*(\d+)\s*\)/g, (_match, value, shift) =>
          String(Number(value) * 2 ** Number(shift)))
        .replace(/\.dvalue\(\)/g, '');
      const value = evalExpr(normalized);
      if (value == null || !Number.isFinite(value)) continue;
      values[name] = value;
      changed = true;
    }
    if (!changed) break;
  }
  return values;
}

function sourceMemberDefaults(
  source: string,
  constants: Record<string, number>,
): Record<string, number | number[]> {
  const defaults: Record<string, number | number[]> = {};
  const mameConstants = {
    INPUT_LINE_NMI: -1,
    INPUT_LINE_RESET: -2,
    INPUT_LINE_IRQ0: 0,
  };
  for (const match of source.matchAll(
    /\b(?:bool|int|u?int(?:8|16|32)_t|u8|u16|u32)\s+(m_\w+)\s*=\s*([^;]+);/g,
  )) {
    const expression = substituteNumbers(match[2]!, {
      ...mameConstants,
      ...constants,
      ...numericState(defaults),
    })
      .replace(/\bfalse\b/g, '0')
      .replace(/\btrue\b/g, '1');
    const value = evalExpr(expression);
    if (value != null && Number.isFinite(value)) defaults[match[1]!] = value;
  }
  for (const match of source.matchAll(
    /\b(?:bool|int|u?int(?:8|16|32)_t|u8|u16|u32)\s+(m_\w+)\s*\[\s*(\d+)\s*\]\s*\{\s*\}\s*;/g,
  )) {
    defaults[match[1]!] = new Array(Number(match[2])).fill(0);
  }
  return defaults;
}

function substituteNumbers(source: string, values: Record<string, number>): string {
  return source.replace(/\b[A-Za-z_]\w*\b/g, token =>
    values[token] === undefined ? token : `(${values[token]})`);
}

function compileInitDelegates(
  ast: MameAstIndex,
  ownerClass: string,
  initName: string,
): Record<string, string> {
  const init = initName && ast.findFunctionInHierarchy(ownerClass, initName);
  if (!init) return {};
  for (const call of calledSourceMethods(init.body)) {
    const helper = ast.findFunctionInHierarchy(ownerClass, call);
    const rawArgs = findCallArguments(init.body, call);
    if (!helper || rawArgs === undefined) continue;
    const args = splitMameArgs(rawArgs);
    const parameters = helper.parameters.split(',').map(parameter =>
      /(\w+)\s*$/.exec(parameter.trim())?.[1] ?? '');
    const byParameter = Object.fromEntries(parameters.map((name, index) => [name, args[index] ?? '']));
    const delegates: Record<string, string> = {};
    const assignment = /\b(m_\w+)\s*=\s*\w+_delegate\(\s*(\w+)\s*\?\s*\2\s*:\s*&([A-Za-z_]\w*)::(\w+)/g;
    for (const match of helper.body.matchAll(assignment)) {
      const selected = /&([A-Za-z_]\w*)::(\w+)/.exec(byParameter[match[2]!] ?? '');
      delegates[match[1]!] = selected
        ? `${selected[1]}.${selected[2]}`
        : `${match[3]}.${match[4]}`;
    }
    if (Object.keys(delegates).length) return delegates;
  }
  return {};
}

function compileVideoColorTables(
  source: string,
  constants: Record<string, number>,
): Record<string, number[]> {
  const tables: Record<string, number[]> = {};
  if (source.includes('m_star_color[i]') && constants.RGB_MAXIMUM) {
    const maximum = constants.RGB_MAXIMUM;
    const min = Math.trunc(maximum * 130 / 150);
    const mid = Math.trunc(maximum * 130 / 100);
    const max = Math.trunc(maximum * 130 / 60);
    const map = [0, min, min + Math.trunc((255 - min) * (mid - min) / (max - min)), 255];
    tables.m_star_color = Array.from({ length: 64 }, (_, index) => packRgb(
      map[(((index >> 4) & 1) << 1) | ((index >> 5) & 1)]!,
      map[(((index >> 2) & 1) << 1) | ((index >> 3) & 1)]!,
      map[((index & 1) << 1) | ((index >> 1) & 1)]!,
    ));
  }
  if (source.includes('m_bullet_color[7]') && source.includes('rgb_t(0xff,0xff,0x00)')) {
    tables.m_bullet_color = [
      ...Array.from({ length: 7 }, () => packRgb(255, 255, 255)),
      packRgb(255, 255, 0),
    ];
  }
  return tables;
}

function compileVideoLfsr(
  ast: MameAstIndex,
  ownerClass: string,
  constants: Record<string, number>,
): GeneratedVideoPlan['lfsrTable'] | undefined {
  const fn = ast.findFunctionInHierarchy(ownerClass, 'stars_init');
  if (!fn) return undefined;
  const enabled = /\(shiftreg\s*&\s*(0x[\da-f]+|\d+)\)\s*==\s*(0x[\da-f]+|\d+)/i.exec(fn.body);
  const color = /~shiftreg\s*&\s*(0x[\da-f]+|\d+)\)\s*>>\s*(\d+)/i.exec(fn.body);
  const feedback = /shiftreg\s*>>\s*(\d+)\)\s*\^\s*~shiftreg[\s\S]*?<<\s*(\d+)/.exec(fn.body);
  const period = constants.STAR_RNG_PERIOD;
  if (!enabled || !color || !feedback || !period) return undefined;
  const row = ast.findFunctionInHierarchy(ownerClass, 'stars_draw_row');
  const colorMember = row && /m_star_color\s*\[/.exec(row.body)?.[0]
    ? /\b(m_\w+)\s*\[\s*star\s*&/.exec(row.body)?.[1]
    : undefined;
  const scaleMember = row && /bitmap\.pix\s*\(\s*y\s*,\s*(m_\w+)\s*\*\s*x/.exec(row.body)?.[1];
  return {
    member: 'm_stars',
    period,
    enabledMask: Number(enabled[1]),
    enabledValue: Number(enabled[2]),
    colorMask: Number(color[1]),
    colorShift: Number(color[2]),
    feedbackTap: Number(feedback[1]),
    feedbackInvertTap: 0,
    feedbackWidth: Number(feedback[2]) + 1,
    ...(row && colorMember && scaleMember
      ? { rowRenderer: { method: row.name, colorMember, scaleMember } }
      : {}),
  };
}

function packRgb(red: number, green: number, blue: number): number {
  return (0xff000000 | (blue << 16) | (green << 8) | red) >>> 0;
}

function initialState(
  body: string,
  values: Record<string, number> = {},
): Record<string, number> {
  const state: Record<string, number> = {};
  for (const match of body.matchAll(/\b(m_\w+)\s*=\s*([^;]+)\s*;/g)) {
    const expression = substituteNumbers(match[2]!, { ...values, ...state })
      .replace(/\bfalse\b/g, '0')
      .replace(/\btrue\b/g, '1');
    const value = evalExpr(expression);
    if (value != null && Number.isFinite(value)) state[match[1]!] = value;
  }
  return state;
}

function numericState(
  values: Record<string, number | number[]>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number'),
  );
}

function arrayState(
  values: Record<string, number | number[]>,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number[]] =>
      Array.isArray(entry[1])),
  );
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

function findCallArgumentLists(source: string, name: string): string[] {
  const calls: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf(`${name}(`, cursor);
    if (at < 0) break;
    const open = source.indexOf('(', at + name.length);
    const close = matchingPair(source, open, '(', ')');
    if (close < 0) break;
    calls.push(source.slice(open + 1, close));
    cursor = close + 1;
  }
  return calls;
}

function matchingPair(source: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === left) depth++;
    else if (source[index] === right && --depth === 0) return index;
  }
  return -1;
}

function expressionNumber(
  value: string | undefined,
  constants: Record<string, number> = {},
): number {
  if (!value) return 0;
  return evalExpr(substituteNumbers(value.trim(), constants)) ?? 0;
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
    if (match[3]!.trimStart().startsWith('{')) continue;
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
