import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GraphBuilder, type KnowledgeGraph, type PropValue } from './types.ts';
import {
  MameAstIndex, parseCallChain, parseMameAst, spanProps, splitMameArgs,
  type MameFunction, type SourceSpan,
} from '../mame/ast.ts';
import { compileMameHandler } from '../mame/handler-ir.ts';
import {
  executeGeneratedHandler,
  type GeneratedHandlerBindings,
} from '../runtime/generated-handler.ts';
import {
  stripComments, parseDefines, parseGames, parseRomSets, parseAddressMaps,
  parseMachineConfigs, parseMemberTags, parseInputPorts, parseGfxLayouts,
  parseGfxDecodes, parseIncludes, parseDeviceTypeDecls, parseDeviceDefaultClocks,
  parseInitPatches, parseTextMacros, parseMemoryBanks, evalExpr,
  type InputPortsDef,
} from './parse.ts';

const VERSION = '0.1.0';

/**
 * Build the knowledge graph for one MAME driver file (plus its .h header and
 * any sibling _v/_a compilation units, which share the state class).
 */
export function buildGraph(mameSrc: string, driverFile: string): KnowledgeGraph {
  const g = new GraphBuilder();
  const driverBase = basename(driverFile); // e.g. galaga.cpp
  const dir = dirname(driverFile);

  // gather the compilation-unit family: galaga.cpp, galaga.h, galaga_v.cpp,
  // galaga_a.cpp — plus same-directory includes and their .cpp twins
  // (m52.cpp includes irem.h; irem.cpp holds the audio-board device's
  // device_add_mconfig with the M6803 + AY8910s + MSM5205)
  const stem = driverBase.replace(/\.cpp$/, '');
  const family = [driverBase, `${stem}.h`, `${stem}_v.cpp`, `${stem}_a.cpp`]
    .map(f => join(dir, f))
    .filter(f => existsSync(f));

  for (let familyIndex = 0; familyIndex < family.length; familyIndex++) {
    const file = family[familyIndex]!;
    for (const inc of parseIncludes(readFileSync(file, 'utf8'))) {
      if (inc.includes('/')) continue; // same-directory includes only
      // MAME's build puts src/mame/shared on every driver's include path
      // (rocnrope.cpp includes "timeplt_a.h" which lives there)
      const incDir = existsSync(join(dir, inc)) ? dir : join(mameSrc, 'src/mame/shared');
      const includedStem = inc.replace(/\.h$/, '');
      for (const extra of [
        join(incDir, inc),
        join(incDir, `${includedStem}.cpp`),
        join(incDir, `${includedStem}_v.cpp`),
        join(incDir, `${includedStem}_a.cpp`),
      ]) {
        if (existsSync(extra) && !family.includes(extra)) family.push(extra);
      }
    }
  }

  // driver header credits (parsed from RAW text — comments are stripped below)
  const driverRaw = readFileSync(join(dir, driverBase), 'utf8');
  const license = /^\/\/\s*license\s*:\s*(.+)$/m.exec(driverRaw)?.[1].trim();
  const copyrightHolders = /^\/\/\s*copyright-holders\s*:\s*(.+)$/m.exec(driverRaw)?.[1].trim();

  let combined = '';
  const sourceUnits: { file: string; source: string }[] = [];
  const slashIncludes: string[] = [];
  for (const file of family) {
    const raw = readFileSync(file, 'utf8');
    const rel = file.slice(mameSrc.length + 1);
    sourceUnits.push({ file: rel, source: raw });
    g.node('SourceFile', `file:${rel}`, { path: rel });
    for (const inc of parseIncludes(raw)) {
      if (inc.includes('/') && !slashIncludes.includes(inc)) slashIncludes.push(inc);
      g.node('SourceFile', `file:${inc}`, { path: inc, external: true });
      g.edge(`file:${rel}`, `file:${inc}`, 'INCLUDES');
    }
    combined += `\n// ==== ${rel} ====\n` + stripComments(raw);
  }
  const driverRel = driverFile.slice(mameSrc.length + 1);
  const fileId = `file:${driverRel}`;
  const ast = new MameAstIndex(parseMameAst(sourceUnits));
  const definedIn = (nodeId: string, source?: SourceSpan): void => {
    const target = source ? `file:${source.file}` : fileId;
    g.edge(nodeId, target, 'DEFINED_IN', source ? spanProps(source) : undefined);
  };

  // constants from external includes (clock XTALs live in device headers:
  // cpu/m6502/rp2a03.h defines NTSC_APU_CLOCK) — defines only, no graph nodes.
  // Externals seed first, the driver family's own defines win.
  let extConsts: Record<string, number> = {};
  for (const inc of slashIncludes) {
    for (const cand of [join(mameSrc, 'src/devices', inc), join(mameSrc, 'src', inc), join(mameSrc, 'src/mame', inc)]) {
      if (!existsSync(cand)) continue;
      extConsts = parseDefines(stripComments(readFileSync(cand, 'utf8')), extConsts);
      break;
    }
  }
  const consts = parseDefines(combined, extConsts);
  const textMacros = parseTextMacros(combined);
  const ioportMembers = parseIoportMembers(combined, textMacros.strings);
  emitSourceTimerCallbacks(g, ast, consts, definedIn);
  const memberTags = parseMemberTags(combined);
  const deviceTypes = parseDeviceTypeDecls(combined);

  // --- games ---
  const games = parseGames(combined);
  const initPatches = parseInitPatches(combined, consts);
  for (const gm of games) {
    const id = `game:${gm.name}`;
    const source = ast.findAnyMacro(
      ['GAME', 'GAMEX', 'GAMEL', 'CONS', 'SYST', 'COMP'], 1, gm.name,
    )?.span;
    g.node('Game', id, {
      name: gm.name, year: gm.year, company: gm.company, fullname: gm.fullname,
      monitor: gm.monitor, cls: gm.cls, init: gm.init, flags: gm.flags,
      kind: gm.kind,
      ...spanProps(source),
      // driver init fns that patch ROM bytes (rocnrope's one-instruction fix)
      // flow through as "region:offset:value" triples
      ...(initPatches[gm.init]
        ? { romPatches: initPatches[gm.init].map(p => `${p.region}:${p.offset}:${p.value}`) }
        : {}),
      // compat (CONS/SYST/COMP arg 4) is a software-compatibility group, NOT
      // a clone relationship — famicom is compat with nes but its own machine
      ...(gm.compat !== '0' ? { compat: gm.compat } : {}),
    });
    definedIn(id, source);
    if (gm.parent !== '0') g.edge(id, `game:${gm.parent}`, 'CLONE_OF');
    g.edge(id, `machine:${gm.cls}.${gm.machine}`, 'USES_MACHINE');
    g.edge(id, `inputs:${gm.input}`, 'USES_INPUTS');
    g.edge(id, `romset:${gm.name}`, 'USES_ROMSET');
  }

  // --- rom sets ---
  for (const set of parseRomSets(combined)) {
    const setId = `romset:${set.name}`;
    const setSource = ast.findMacro('ROM_START', 0, set.name)?.span;
    g.node('RomSet', setId, { name: set.name, ...spanProps(setSource) });
    definedIn(setId, setSource);
    for (const region of set.regions) {
      const regId = `region:${set.name}/${region.tag}`;
      const regionSource = ast.findMacro('ROM_REGION', 1, region.tag)?.span;
      g.node('RomRegion', regId, {
        tag: region.tag, size: region.size, flags: region.flags,
        ...spanProps(regionSource),
      });
      g.edge(setId, regId, 'HAS_REGION');
      for (const load of region.loads) {
        // region-scoped: the same FILE NAME can be two different ROMs in two
        // regions (gyruss has two distinct "gyrussk.4" chips)
        const romId = `rom:${set.name}/${region.tag}/${load.file}`;
        const props: Record<string, PropValue> = {
          file: load.file, offset: load.offset, size: load.size, crc: load.crc, sha1: load.sha1,
          ...spanProps(ast.findMacro('ROM_LOAD', 0, load.file)?.span),
        };
        if (load.reloadOffsets.length) props.reloadOffsets = load.reloadOffsets;
        g.node('Rom', romId, props);
        g.edge(regId, romId, 'LOADS');
      }
    }
  }

  // --- address maps ---
  const maps = parseAddressMaps(combined);
  const mapByName = new Map(maps.map(m => [m.name, m]));
  // same-class match first: different state classes in one driver file can
  // reuse map names (m52_state::main_map vs alpha1v_state::main_map)
  const resolveMap = (cls: string, name: string) =>
    maps.find(m => m.cls === cls && m.name === name) ?? mapByName.get(name);
  for (const map of maps) {
    const mapId = `map:${map.cls}.${map.name}`;
    const mapFunction = ast.findFunction(map.cls, map.name);
    const mapProps: Record<string, PropValue> = {
      cls: map.cls, name: map.name, ...spanProps(mapFunction?.span),
    };
    if (map.calls.length) mapProps.calls = map.calls;
    if (map.globalMask !== undefined) mapProps.globalMask = map.globalMask;
    if (map.unmapHigh) mapProps.unmapHigh = true;
    g.node('AddressMap', mapId, mapProps);
    definedIn(mapId, mapFunction?.span);
    for (const callee of map.calls) {
      const target = resolveMap(map.cls, callee);
      if (target) g.edge(mapId, `map:${target.cls}.${target.name}`, 'INCLUDES_MAP');
    }
    map.ranges.forEach((r, i) => {
      const rangeId = `${mapId}/range${i}`;
      const rangeSource = ast.findStatement(r.raw, mapFunction)?.span;
      const props: Record<string, PropValue> = {
        start: r.start, end: r.end, raw: r.raw, ...spanProps(rangeSource),
      };
      if (r.mirror !== undefined) props.mirror = r.mirror;
      for (const flag of ['rom', 'ram', 'writeonly', 'nopw', 'nopr'] as const) {
        if (r[flag]) props[flag] = true;
      }
      if (r.share) props.share = r.share;
      if (r.portRead) props.portRead = r.portRead;
      if (r.portWrite) props.portWrite = r.portWrite;
      if (r.bankRead) props.bankRead = r.bankRead;
      if (r.bankWrite) props.bankWrite = r.bankWrite;
      g.node('AddressRange', rangeId, props);
      g.edge(mapId, rangeId, 'HAS_RANGE');
      for (const dir of ['read', 'write'] as const) {
        const h = r[dir];
        if (!h) continue;
        const owner = h.deviceClass ?? map.cls;
        const hid = `handler:${owner}.${h.method}`;
        if (h.inlineBody !== undefined) {
          g.node('Handler', hid, handlerProps(ast, owner, h.method, consts, rangeSource, h));
        } else {
          emitSourceHandlerClosure(g, ast, owner, h.method, consts, rangeSource);
        }
        const edgeProps: Record<string, PropValue> = {};
        if (h.deviceRef) {
          edgeProps.deviceTag = memberTags[h.deviceRef] ?? h.deviceRef.replace(/^m_/, '');
        }
        g.edge(rangeId, hid, dir === 'read' ? 'READS' : 'WRITES',
          h.deviceRef ? edgeProps : undefined);
      }
    });
  }

  // --- machine configs ---
  const gfxDecodes = parseGfxDecodes(combined, consts);
  const machineConfigs = parseMachineConfigs(combined, memberTags, consts);
  const cfgByName = new Map(machineConfigs.map(c => [c.name, c]));

  // Clock resolution: a device instantiated with no clock runs at its
  // constructor default (timeplt_a.h: `uint32_t clock = 14'318'181`), and
  // DERIVED_CLOCK(n, d) inside its device_add_mconfig is that clock * n/d.
  const defaultClocks = parseDeviceDefaultClocks(combined);
  for (const cfg of machineConfigs) {
    for (const dev of cfg.devices) {
      if (dev.clock !== null || dev.clockExpr) continue;
      const cls = deviceTypes[dev.type];
      if (cls && defaultClocks[cls] !== undefined) dev.clock = defaultClocks[cls];
    }
  }
  for (const cfg of machineConfigs) {
    for (const dev of cfg.devices) {
      const devCls = deviceTypes[dev.type];
      if (!devCls || dev.clock === null) continue;
      const sub = machineConfigs.find(c => c.cls === devCls && c.name === 'device_add_mconfig');
      for (const sd of sub?.devices ?? []) {
        const dm = sd.clockExpr && /^DERIVED_CLOCK\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(sd.clockExpr);
        if (dm) { sd.clock = (dev.clock * Number(dm[1])) / Number(dm[2]); delete sd.clockExpr; }
      }
    }
  }
  for (const cfg of machineConfigs) {
    const cfgId = `machine:${cfg.cls}.${cfg.name}`;
    const cfgFunction = ast.findFunction(cfg.cls, cfg.name);
    g.node('MachineConfig', cfgId, {
      cls: cfg.cls, name: cfg.name, calls: cfg.calls, ...spanProps(cfgFunction?.span),
    });
    definedIn(cfgId, cfgFunction?.span);
    for (const callback of g.nodes.values()) {
      if (callback.label !== 'Callback' || callback.props.signal !== 'timer') continue;
      const targetClass = String(callback.props.targetClass ?? '');
      const targetMethod = String(callback.props.targetMethod ?? '');
      const resolved = ast.findFunctionInHierarchy(cfg.cls, targetMethod);
      if (resolved?.className === targetClass) g.edge(cfgId, callback.id, 'HAS_CALLBACK');
    }
    for (const callee of cfg.calls) {
      const target = cfgByName.get(callee);
      if (target) g.edge(cfgId, `machine:${target.cls}.${target.name}`, 'CALLS');
    }
    const machineStart = ast.findFunctionInHierarchy(cfg.cls, 'machine_start');
    for (const bank of parseMemoryBanks(machineStart?.body ?? '', memberTags, consts)) {
      const bankId = `bank:${cfg.cls}.${cfg.name}/${bank.tag}`;
      g.node('MemoryBank', bankId, {
        tag: bank.tag,
        member: bank.member,
        startEntry: bank.startEntry,
        entries: bank.entries,
        region: bank.region,
        offset: bank.offset,
        stride: bank.stride,
        raw: bank.raw,
        ...spanProps(machineStart?.span),
      });
      g.edge(cfgId, bankId, 'HAS_BANK');
      definedIn(bankId, machineStart?.span);
    }
    for (const list of cfg.softwareLists) {
      const listId = `softlist:${list.name}`;
      g.node('SoftwareList', listId, {
        name: list.name, tag: list.tag, status: list.status,
        ...(list.filter ? { filter: list.filter } : {}),
      });
      g.edge(cfgId, listId, 'HAS_SOFTLIST');
    }
    // patches: set_addrmap on devices instantiated in a CALLED config. The
    // edge lives on the PATCHING config (not the shared device node —
    // attaching there would leak one game's map into every other game that
    // calls the same base config, e.g. cannonbp's protection map into
    // pacman). The generator resolves patches along the game's CALLS chain.
    for (const patch of cfg.patches) {
      for (const [space, mapName] of Object.entries(patch.addrMaps)) {
        const target = resolveMap(cfg.cls, mapName);
        if (!target) continue;
        g.edge(cfgId, `map:${target.cls}.${target.name}`, 'PATCHES_MAP', { space, deviceTag: patch.tag });
      }
    }
    for (const dev of cfg.devices) {
      // namespaced by class AND config name: every device-board class has a
      // config called device_add_mconfig, and different classes reuse tags
      // (m52/m62 audio boards both have an "iremsound" cpu)
      const devId = `device:${cfg.cls}.${cfg.name}/${dev.tag}`;
      const props: Record<string, PropValue> = {
        type: dev.type, tag: dev.tag, clock: dev.clock, config: dev.config,
        ...spanProps(ast.findStatement(dev.config[0] ?? '', cfgFunction)?.span),
      };
      const configCalls = dev.config.flatMap(raw => {
        const call = /(?:\w+|m_\w+)\s*(?:->|\.)\s*(\w+)\s*\(([\s\S]*)\)\s*;?$/.exec(raw.trim());
        if (!call) return [];
        const values = splitMameArgs(call[2]!).map(value => evalExpr(value, consts));
        return values.every((value): value is number => value !== null)
          ? [`${call[1]}(${values.join(',')})`]
          : [];
      });
      if (configCalls.length) props.configCalls = configCalls;
      if (dev.clockExpr) props.clockExpr = dev.clockExpr;
      if (dev.screenRaw) {
        props.screenRaw = [
          dev.screenRaw.pixclock, dev.screenRaw.htotal, dev.screenRaw.hbend, dev.screenRaw.hbstart,
          dev.screenRaw.vtotal, dev.screenRaw.vbend, dev.screenRaw.vbstart,
        ];
      }
      if (dev.screenRefreshHz !== undefined) props.screenRefreshHz = dev.screenRefreshHz;
      if (dev.screenSize) props.screenSize = [dev.screenSize.w, dev.screenSize.h];
      if (dev.screenVisarea) {
        props.screenVisarea = [dev.screenVisarea.x0, dev.screenVisarea.x1, dev.screenVisarea.y0, dev.screenVisarea.y1];
      }
      if (dev.screenVideoAttributes?.length) props.screenVideoAttributes = dev.screenVideoAttributes;
      if (dev.slotOptions) props.slotOptions = dev.slotOptions;
      if (dev.slotDefault) props.slotDefault = dev.slotDefault;
      g.node('Device', devId, props);
      g.edge(cfgId, devId, 'HAS_DEVICE');
      for (const [index, route] of (dev.audioRoutes ?? []).entries()) {
        const routeId = `audioroute:${devId}/${index}`;
        g.node('AudioRoute', routeId, {
          output: route.output,
          target: route.target,
          gain: route.gain,
          ...(route.input !== undefined ? { input: route.input } : {}),
          raw: route.raw,
          ...spanProps(ast.findStatement(route.raw, cfgFunction)?.span),
        });
        g.edge(devId, routeId, 'HAS_AUDIO_ROUTE');
      }
      emitCallbacks(g, ast, cfgFunction, devId, dev.tag, dev.config, memberTags, consts);
      // board-style devices (IREM_M52_SOUNDC_AUDIO...) carry their own
      // sub-machine in device_add_mconfig — link so the subgraph walk
      // reaches the M6803/AY8910s/MSM5205 inside
      const devCls = deviceTypes[dev.type];
      if (devCls) {
        const sub = machineConfigs.find(c => c.cls === devCls && c.name === 'device_add_mconfig');
        if (sub) g.edge(devId, `machine:${sub.cls}.${sub.name}`, 'CALLS');
      }
      for (const [space, mapName] of Object.entries(dev.addrMaps)) {
        // resolve by map NAME: set_addrmap may reference the map through a
        // derived class while the function is defined on the base
        // (m52_soundc_audio_device -> irem_audio_device::m52_small_sound_map)
        const target = resolveMap(cfg.cls, mapName);
        g.edge(devId, target ? `map:${target.cls}.${target.name}` : `map:${cfg.cls}.${mapName}`, 'HAS_MAP', { space });
      }
      if (dev.gfxDecodeName) g.edge(cfgId, `gfxdecode:${dev.gfxDecodeName}`, 'DECODES');
    }
  }

  // --- inputs ---
  for (const inp of parseInputPorts(combined, textMacros)) {
    const source = ast.findMacro('INPUT_PORTS_START', 0, inp.name)?.span;
    emitInputPorts(g, inp, source ? `file:${source.file}` : fileId, source, {
      ast,
      constants: consts,
      ioportMembers,
      stringConstants: textMacros.strings,
    });
  }

  // --- console control-port inputs (live on the default slot device, not the
  // driver: nes.cpp's INPUT_PORTS_START(nes) is empty; the joypad fields are
  // in bus/nes_ctrl/joypad.cpp) ---
  resolveSlotInputs(g, mameSrc, slashIncludes, machineConfigs);

  // --- gfx ---
  // MAME exposes standard layouts from emu/video/generic.cpp via extern
  // declarations. Include that source-owned table so driver graphs retain
  // the concrete layout instead of an unresolved symbol.
  const genericGfxFile = join(mameSrc, 'src/emu/video/generic.cpp');
  const gfxLayoutSource = existsSync(genericGfxFile)
    ? `${combined}\n${stripComments(readFileSync(genericGfxFile, 'utf8'))}`
    : combined;
  for (const layout of parseGfxLayouts(gfxLayoutSource)) {
    g.node('GfxLayout', `gfxlayout:${layout.name}`, {
      name: layout.name, width: layout.width, height: layout.height,
      total: layout.total, planes: layout.planes,
      planeOffsets: layout.planeOffsets, xOffsets: layout.xOffsets, yOffsets: layout.yOffsets,
      charIncrement: layout.charIncrement,
    });
    g.edge(`gfxlayout:${layout.name}`, fileId, 'DEFINED_IN');
  }
  for (const dec of gfxDecodes) {
    const decId = `gfxdecode:${dec.name}`;
    const source = ast.findMacro('GFXDECODE_START', 0, dec.name)?.span;
    g.node('GfxDecode', decId, { name: dec.name, ...spanProps(source) });
    definedIn(decId, source);
    dec.entries.forEach((e, i) => {
      const eid = `${decId}/e${i}`;
      g.node('GfxDecodeEntry', eid, {
        region: e.region, offset: e.offset, layout: e.layout,
        colorBase: e.colorBase, colorCount: e.colorCount,
        xscale: e.xscale, yscale: e.yscale,
      });
      g.edge(decId, eid, 'HAS_ENTRY');
      g.edge(eid, `gfxlayout:${e.layout}`, 'USES_LAYOUT');
    });
  }

  for (const handler of g.nodes.values()) {
    if (handler.label !== 'Handler') continue;
    annotateInputHandlerClosure(
      g,
      handler.id,
      ioportMembers,
      textMacros.strings,
    );
  }

  return g.toGraph({
    tool: 'mamekit',
    version: VERSION,
    schemaVersion: 2,
    mameSrc,
    driverFile: driverRel,
    generatedAt: new Date().toISOString(),
    ...(license ? { license } : {}),
    ...(copyrightHolders ? { copyrightHolders } : {}),
  });
}

function emitSourceTimerCallbacks(
  g: GraphBuilder,
  ast: MameAstIndex,
  constants: Record<string, number>,
  definedIn: (nodeId: string, source?: SourceSpan) => void,
): void {
  const functions = ast.ast.units.flatMap(unit => unit.functions);
  const allocations = functions.flatMap(fn =>
    [...fn.body.matchAll(
      /\b(m_\w+)\s*=\s*timer_alloc\s*\(\s*FUNC\(\s*(\w+)::(\w+)\s*\)/g,
    )].map(match => ({
      timer: match[1],
      ownerClass: match[2],
      method: match[3],
    })),
  );

  for (const allocation of allocations) {
    const callback = ast.findFunctionInHierarchy(allocation.ownerClass, allocation.method);
    const reset = functions.find(fn =>
      /(?:machine_reset|reset)$/.test(fn.name) &&
      fn.body.includes(`${allocation.timer}->adjust`));
    if (!callback || !reset) continue;
    const scanlines = evaluateTimerScanlines(
      ast,
      callback,
      reset,
      allocation.timer,
      constants,
    );
    if (!scanlines.length) continue;

    const callbackId = `callback:timer/${allocation.ownerClass}.${allocation.method}`;
    const props: Record<string, PropValue> = {
      ownerTag: allocation.timer.replace(/^m_/, ''),
      signal: 'timer',
      operation: 'adjust',
      targetClass: allocation.ownerClass,
      targetMethod: allocation.method,
      scanlines,
      ...spanProps(callback.span),
    };
    g.node('Callback', callbackId, props);
    definedIn(callbackId, callback.span);
    const handlerId = emitSourceHandlerClosure(
      g,
      ast,
      allocation.ownerClass,
      allocation.method,
      constants,
      callback.span,
    );
    g.edge(callbackId, handlerId, 'CALLS_HANDLER');
  }
}

export function evaluateTimerScanlines(
  ast: MameAstIndex,
  callback: MameFunction,
  reset: MameFunction,
  timer: string,
  constants: Record<string, number>,
): number[] {
  const programs = new Map(
    ast.ast.units
      .flatMap(unit => unit.functions)
      .map(fn => [`${fn.className}.${fn.name}`, {
        fn,
        program: compileMameHandler(fn.body),
      }]),
  );
  let currentLine = 0;
  let adjustedLine: number | undefined;
  const calls: Record<string, (...args: number[]) => unknown> = {
    'm_screen.vpos': () => currentLine,
    'm_screen.time_until_pos': line => line,
    'machine().time': () => 0,
    [`${timer}.adjust`]: (...args) => {
      adjustedLine = args.length > 1 ? args.at(-1) : args[0];
    },
    'm_maincpu.set_input_line': () => 0,
    'm_subcpu2.pulse_input_line': () => 0,
  };
  const invoke = (className: string, name: string, args: number[]): number => {
    const entry = programs.get(`${className}.${name}`) ??
      (() => {
        const inherited = ast.findFunctionInHierarchy(className, name);
        return inherited ? programs.get(`${inherited.className}.${inherited.name}`) : undefined;
      })();
    if (!entry || entry.program.diagnostics.length) return 0;
    const names = entry.fn.parameters
      .split(',')
      .map(parameter => /(\w+)\s*$/.exec(parameter.trim())?.[1])
      .filter((name): name is string => Boolean(name));
    return executeGeneratedHandler(
      entry.program,
      bindings,
      Object.fromEntries(names.map((name, index) => [name, args[index] ?? 0])),
    ) ?? 0;
  };
  for (const { fn } of programs.values()) {
    calls[fn.name] ??= (...args) => invoke(callback.className, fn.name, args);
  }
  const bindings: GeneratedHandlerBindings = {
    constants,
    members: {
      m_int_enable: 1,
      m_sub2_nmi_mask: 0,
    },
    calls,
  };
  const resetProgram = compileMameHandler(reset.body);
  const callbackProgram = compileMameHandler(callback.body);
  if (resetProgram.diagnostics.length || callbackProgram.diagnostics.length) return [];

  executeGeneratedHandler(resetProgram, bindings);
  if (!Number.isFinite(adjustedLine)) return [];
  currentLine = Math.trunc(adjustedLine!);
  const lines: number[] = [];
  for (let iteration = 0; iteration < 32; iteration++) {
    if (lines.includes(currentLine)) break;
    lines.push(currentLine);
    adjustedLine = undefined;
    executeGeneratedHandler(callbackProgram, bindings, { param: currentLine });
    if (!Number.isFinite(adjustedLine)) return [];
    currentLine = Math.trunc(adjustedLine!);
  }
  return lines.length > 1 ? lines : [];
}

function emitInputPorts(
  g: GraphBuilder,
  inp: InputPortsDef,
  fileId: string,
  source?: SourceSpan,
  context?: {
    ast: MameAstIndex;
    constants: Record<string, number>;
    ioportMembers: Record<string, string[]>;
    stringConstants: Record<string, string>;
  },
): void {
  const inpId = `inputs:${inp.name}`;
  g.node('InputPorts', inpId, { name: inp.name, ...spanProps(source) });
  g.edge(inpId, fileId, 'DEFINED_IN', source ? spanProps(source) : undefined);
  if (inp.include) g.edge(inpId, `inputs:${inp.include}`, 'INCLUDES_PORTS');
  for (const port of inp.ports) {
    const portId = `${inpId}/${port.tag}`;
    g.node('Port', portId, { tag: port.tag, modify: port.modify ?? false });
    g.edge(inpId, portId, 'HAS_PORT');
    port.fields.forEach((f, i) => {
      const fid = `${portId}/f${i}`;
      const props: Record<string, PropValue> = { kind: f.kind, mask: f.mask };
      if (f.activeLow !== undefined) props.activeLow = f.activeLow;
      if (f.type) props.type = f.type;
      if (f.modifiers) props.modifiers = f.modifiers;
      if (f.name) props.name = f.name;
      if (f.defaultValue !== undefined) props.defaultValue = f.defaultValue;
      if (f.location) props.location = f.location;
      if (f.settings?.length) {
        props.settings = f.settings.map(s => `${s.value}=${s.name}${s.condition ? ` [if ${s.condition}]` : ''}`);
      }
      g.node('PortField', fid, props);
      g.edge(portId, fid, 'HAS_FIELD');
      const custom = f.modifiers
        ?.map(modifier => /PORT_CUSTOM_MEMBER\s*\(\s*FUNC\s*\(\s*(\w+)::(\w+)\s*\)/.exec(modifier))
        .find((match): match is RegExpExecArray => Boolean(match));
      if (custom && context) {
        const handlerId = emitSourceHandlerClosure(
          g,
          context.ast,
          custom[1]!,
          custom[2]!,
          context.constants,
          source,
        );
        g.edge(fid, handlerId, 'CALLS_HANDLER');
        annotateInputHandlerClosure(g, handlerId, context.ioportMembers, context.stringConstants);
      }
    });
  }
}

function parseIoportMembers(
  source: string,
  stringConstants: Record<string, string>,
): Record<string, string[]> {
  const sizes = new Map<string, number>();
  for (const match of source.matchAll(
    /\b(?:required|optional)_ioport(?:_array\s*<\s*(\d+)\s*>)?\s+(m_\w+)\s*;/g,
  )) {
    sizes.set(match[2]!, Number(match[1] ?? 1));
  }

  const members: Record<string, string[]> = {};
  for (const [member, size] of sizes) {
    const initializer = new RegExp(
      `\\b${member}\\s*\\(\\s*\\*this\\s*,\\s*("[^"]+"|\\w+)` +
      `(?:\\s*,\\s*(\\d+)(?:U|UL|ULL)?)?\\s*\\)`,
    ).exec(source);
    if (!initializer) continue;
    const expression = initializer[1]!;
    const pattern = expression.startsWith('"')
      ? expression.slice(1, -1)
      : stringConstants[expression];
    if (!pattern) continue;
    const start = Number(initializer[2] ?? 0);
    members[member] = pattern.includes('%u')
      ? Array.from({ length: size }, (_, index) => pattern.replace('%u', String(start + index)))
      : [pattern];
  }
  return members;
}

function annotateInputHandlerClosure(
  g: GraphBuilder,
  root: string,
  ioportMembers: Record<string, string[]>,
  stringConstants: Record<string, string>,
): void {
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const handler = g.nodes.get(id);
    if (handler?.label === 'Handler' && typeof handler.props.sourceBody === 'string') {
      let body = handler.props.sourceBody;
      for (const [name, value] of Object.entries(stringConstants)) {
        body = body.replace(new RegExp(`\\b${name}\\b`, 'g'), JSON.stringify(value));
      }
      handler.props.sourceBody = body;
      const inputs = Object.entries(ioportMembers)
        .filter(([member]) => new RegExp(`\\b${member}\\b`).test(body))
        .map(([member, tags]) => `${member}=${tags.join(',')}`);
      if (inputs.length) handler.props.inputMembers = inputs;
    }
    for (const edge of g.edges) {
      if (edge.from === id && edge.rel === 'CALLS_HANDLER') pending.push(edge.to);
    }
  }
}

const CALLBACK_OPERATIONS = new Set([
  'set', 'append', 'set_ioport', 'set_inputline', 'append_inputline', 'set_nop',
  'set_screen_update', 'set_vblank_int', 'set_periodic_int',
  'set_irq_acknowledge_callback',
  'set_maincpu',
]);

function emitCallbacks(
  g: GraphBuilder,
  ast: MameAstIndex,
  cfgFunction: MameFunction | undefined,
  devId: string,
  deviceTag: string,
  config: string[],
  memberTags: Record<string, string>,
  constants: Record<string, number>,
): void {
  let callbackIndex = 0;
  const configPrefix = devId.slice(0, devId.lastIndexOf('/') + 1);
  const findConfigDevice = (tag: string) => [...g.nodes.values()].find(node =>
    node.label === 'Device' &&
    node.id.startsWith(configPrefix) &&
    String(node.props.tag) === tag,
  );
  for (const raw of config) {
    const statement = ast.findStatement(raw, cfgFunction);
    const source = statement?.span;
    const calls = statement?.calls ?? parseCallChain(
      source?.file ?? 'unknown', raw, source?.start ?? 0,
    );
    const operationIndex = calls.findIndex(call =>
      CALLBACK_OPERATIONS.has(call.name) &&
      (call.name !== 'set' || call.args.some(arg => /FUNC\s*\(|INPUT_LINE_/.test(arg))),
    );
    if (operationIndex < 0) continue;

    const operation = calls[operationIndex];
    const signal = operationIndex > 0 ? calls[operationIndex - 1] : operation;
    const transforms = calls.slice(operationIndex + 1).map(call =>
      `${call.name}${call.args.length ? `(${call.args.join(', ')})` : ''}`,
    );
    const callbackId = `${devId}/callback${callbackIndex++}`;
    const props: Record<string, PropValue> = {
      signal: signal.name,
      operation: operation.name,
      raw,
      ownerTag: deviceTag,
      ...spanProps(source),
    };
    if (signal.templateArgs.length) props.slot = signal.templateArgs.join(',');
    if (transforms.length) props.transforms = transforms;
    if (operation.name === 'set_periodic_int') {
      const period = operation.args.find(arg => arg.includes('from_hz'));
      const hzExpr = period ? /from_hz\(([^)]+)\)/.exec(period)?.[1] : undefined;
      const hz = hzExpr ? evalExpr(hzExpr) : null;
      if (hz !== null) props.periodHz = hz;
      if (period) props.periodExpr = period;
    }

    const funcArg = operation.args.find(arg => arg.includes('FUNC('));
    const func = funcArg
      ? /FUNC\(\s*(?:(\w+)::)?(\w+(?:<\d+>)?)\s*\)/.exec(funcArg)
      : null;
    const quotedTarget = operation.args
      .map(arg => /^"([^"]+)"$/.exec(arg.trim())?.[1])
      .find((value): value is string => value !== undefined);
    if (quotedTarget) props.targetTag = quotedTarget;
    if (operation.name === 'set_ioport' && quotedTarget) props.targetPort = quotedTarget;
    if (operation.name.includes('inputline')) {
      const line = operation.args.find(arg => /INPUT_LINE_|^\d+$/.test(arg.trim()));
      if (line) props.inputLine = line.trim();
    }
    if (operation.name === 'set_maincpu') {
      props.signal = 'nmi';
      props.inputLine = 'INPUT_LINE_NMI';
    }
    if (func) {
      props.targetClass = func[1] ?? '';
      props.targetMethod = func[2].replace(/<(\d+)>/, '_$1');
    }

    g.node('Callback', callbackId, props);
    g.edge(devId, callbackId, 'HAS_CALLBACK');

    if (func) {
      const owner = func[1] ?? '';
      const method = func[2].replace(/<(\d+)>/, '_$1');
      const handlerId = emitSourceHandlerClosure(
        g,
        ast,
        owner || 'driver',
        method,
        constants,
        source,
      );
      g.edge(callbackId, handlerId, 'CALLS_HANDLER');
    }

    if (quotedTarget) {
      const target = findConfigDevice(quotedTarget);
      if (target) g.edge(callbackId, target.id, 'TARGETS_DEVICE');
    } else {
      const targetArg = operation.args.find(arg => /^m_\w+$/.test(arg.trim()));
      const targetTag = targetArg ? memberTags[targetArg.trim()] : undefined;
      if (targetTag) {
        props.targetTag = targetTag;
        const target = findConfigDevice(targetTag);
        if (target) g.edge(callbackId, target.id, 'TARGETS_DEVICE');
      }
    }
  }
}

function handlerProps(
  ast: MameAstIndex,
  ownerClass: string,
  method: string,
  constants: Record<string, number>,
  fallbackSource?: SourceSpan,
  inline?: { inlineParameters?: string; inlineBody?: string },
): Record<string, PropValue> {
  const sourceName = method.replace(/_\d+$/, '');
  const fn = ast.findFunctionInHierarchy(ownerClass, sourceName);
  let body = inline?.inlineBody ?? fn?.body;
  if (body && fn) {
    const source = ast.ast.units.map(unit => unit.source).join('\n');
    for (const table of source.matchAll(
      /\bstatic\s+(?:(?:const|constexpr)\s+)+[\w:]+\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^{}]+)\}\s*;/g,
    )) {
      if (!new RegExp(`\\b${table[1]}\\s*\\[`).test(body)) continue;
      const values = splitMameArgs(table[2]!).map(value => value.trim());
      if (body.includes(table[0])) body = body.replace(table[0], '');
      body = body.replace(
        new RegExp(`\\b${table[1]}\\s*\\[([^\\]]+)\\]`, 'g'),
        (_entry, index: string) => `TABLE(${index}, ${values.join(', ')})`,
      );
    }
  }
  const identifiers = new Set(body?.match(/\b[A-Za-z_]\w*\b/g) ?? []);
  const sourceConstants = Object.entries(constants)
    .filter(([name]) => identifiers.has(name))
    .map(([name, value]) => `${name}=${value}`);
  return {
    method,
    ownerClass,
    ...spanProps(fn?.span ?? fallbackSource),
    ...(sourceConstants.length ? { sourceConstants } : {}),
    ...(inline?.inlineBody !== undefined ? {
      sourceParameters: inline.inlineParameters ?? '',
      sourceBody: body ?? inline.inlineBody,
      inline: true,
    } : fn ? {
      sourceParameters: fn.parameters.trim(),
      sourceBody: body!.trim(),
    } : {}),
  };
}

function emitSourceHandlerClosure(
  g: GraphBuilder,
  ast: MameAstIndex,
  ownerClass: string,
  method: string,
  constants: Record<string, number>,
  fallbackSource?: SourceSpan,
  visited = new Set<string>(),
): string {
  const sourceName = method.replace(/_\d+$/, '');
  const fn = ast.findFunctionInHierarchy(ownerClass, sourceName);
  const handlerId = `handler:${ownerClass}.${method}`;
  if (visited.has(handlerId)) return handlerId;
  visited.add(handlerId);
  g.node('Handler', handlerId, handlerProps(
    ast,
    ownerClass,
    method,
    constants,
    fallbackSource,
  ));
  if (!fn) return handlerId;

  for (const call of fn.statements.flatMap(statement => statement.calls)) {
    const dependency = ast.findFunctionInHierarchy(fn.className, call.name);
    if (!dependency || dependency === fn) continue;
    const dependencyId = emitSourceHandlerClosure(
      g,
      ast,
      dependency.className,
      dependency.name,
      constants,
      dependency.span,
      visited,
    );
    g.edge(handlerId, dependencyId, 'CALLS_HANDLER');
  }
  return handlerId;
}

/**
 * For slot devices declared with an options table and a quoted default
 * (NES_CONTROL_PORT(config, m_ctrl1, nes_control_port1_devices, "joypad")),
 * resolve the default option to its device class and extract that device's
 * INPUT_PORTS. Emits an InputPorts subtree plus a Device->InputPorts
 * USES_INPUTS edge with { option } props. Warn-and-continue on any miss —
 * generation then ships without bindings rather than failing.
 */
function resolveSlotInputs(
  g: GraphBuilder,
  mameSrc: string,
  slashIncludes: string[],
  machineConfigs: { cls: string; name: string; devices: { tag: string; slotOptions?: string; slotDefault?: string }[] }[],
): void {
  const busDirs = [...new Set(
    slashIncludes.filter(inc => inc.startsWith('bus/')).map(inc => join(mameSrc, 'src/devices', dirname(inc))),
  )].filter(d => existsSync(d));
  if (!busDirs.length) return;

  // (slotOptions, slotDefault) -> InputPorts node id, or null when unresolved
  const cache = new Map<string, string | null>();

  const resolve = (slotOptions: string, slotDefault: string): string | null => {
    const key = `${slotOptions}/${slotDefault}`;
    if (cache.has(key)) return cache.get(key)!;
    let result: string | null = null;
    for (const dir of busDirs) {
      const files = readdirSync(dir).filter(f => f.endsWith('.cpp'));
      // 1) the options function: void nes_control_port1_devices(device_slot_interface &device)
      let deviceType: string | undefined;
      for (const f of files) {
        const src = readFileSync(join(dir, f), 'utf8');
        if (!src.includes(`void ${slotOptions}(device_slot_interface`)) continue;
        const m = new RegExp(
          `option_add(?:_internal)?\\(\\s*"${slotDefault}"\\s*,\\s*(\\w+)\\s*\\)`,
        ).exec(src);
        if (m) { deviceType = m[1]; break; }
      }
      if (!deviceType) continue;
      // 2) the device definition: DEFINE_DEVICE_TYPE(NES_JOYPAD, nes_joypad_device, ...)
      for (const f of files) {
        const raw = readFileSync(join(dir, f), 'utf8');
        const dm = new RegExp(`DEFINE_DEVICE_TYPE\\(\\s*${deviceType}\\s*,\\s*(\\w+)\\s*,`).exec(raw);
        if (!dm) continue;
        const cls = dm[1];
        // 3) ioport_constructor cls::device_input_ports() { return INPUT_PORTS_NAME(nes_joypad); }
        const stripped = stripComments(raw);
        const pm = new RegExp(
          `${cls}::device_input_ports\\(\\)[^{]*\\{[^}]*INPUT_PORTS_NAME\\(\\s*(\\w+)\\s*\\)`,
        ).exec(stripped);
        if (!pm) continue;
        const portsName = pm[1];
        const def = parseInputPorts(stripped, parseTextMacros(stripped)).find(p => p.name === portsName);
        if (!def) continue;
        const rel = join(dir, f).slice(mameSrc.length + 1);
        g.node('SourceFile', `file:${rel}`, { path: rel });
        emitInputPorts(g, def, `file:${rel}`);
        result = `inputs:${portsName}`;
        break;
      }
      if (result) break;
    }
    if (!result) {
      console.warn(`  ! slot inputs unresolved: ${slotOptions} default "${slotDefault}"`);
    }
    cache.set(key, result);
    return result;
  };

  for (const cfg of machineConfigs) {
    for (const dev of cfg.devices) {
      if (!dev.slotOptions || !dev.slotDefault) continue;
      const inputsId = resolve(dev.slotOptions, dev.slotDefault);
      if (!inputsId) continue;
      g.edge(`device:${cfg.cls}.${cfg.name}/${dev.tag}`, inputsId, 'USES_INPUTS', { option: dev.slotDefault });
    }
  }
}

/**
 * Extract the subgraph reachable from one game (clones resolve to parents for
 * shared machine/inputs). Everything the generator needs, nothing else.
 */
export function gameSubgraph(graph: KnowledgeGraph, game: string): KnowledgeGraph {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out = new Map<string, boolean>();
  const outEdges = new Map<string, typeof graph.edges>();
  for (const e of graph.edges) {
    let list = outEdges.get(e.from);
    if (!list) { list = []; outEdges.set(e.from, list); }
    list.push(e);
  }
  const keepEdges: typeof graph.edges = [];
  const queue = [`game:${game}`];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id) || !byId.has(id)) continue;
    out.set(id, true);
    for (const e of outEdges.get(id) ?? []) {
      keepEdges.push(e);
      queue.push(e.to);
    }
  }
  return {
    meta: graph.meta,
    nodes: graph.nodes.filter(n => out.has(n.id)),
    edges: keepEdges.filter(e => out.has(e.from) && out.has(e.to)),
  };
}
