import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GraphBuilder, type KnowledgeGraph, type PropValue } from './types.ts';
import {
  stripComments, parseDefines, parseGames, parseRomSets, parseAddressMaps,
  parseMachineConfigs, parseMemberTags, parseInputPorts, parseGfxLayouts,
  parseGfxDecodes, parseIncludes,
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

  // gather the compilation-unit family: galaga.cpp, galaga.h, galaga_v.cpp, galaga_a.cpp
  const stem = driverBase.replace(/\.cpp$/, '');
  const family = [driverBase, `${stem}.h`, `${stem}_v.cpp`, `${stem}_a.cpp`]
    .map(f => join(dir, f))
    .filter(f => existsSync(f));

  let combined = '';
  for (const file of family) {
    const raw = readFileSync(file, 'utf8');
    const rel = file.slice(mameSrc.length + 1);
    g.node('SourceFile', `file:${rel}`, { path: rel });
    for (const inc of parseIncludes(raw)) {
      g.node('SourceFile', `file:${inc}`, { path: inc, external: true });
      g.edge(`file:${rel}`, `file:${inc}`, 'INCLUDES');
    }
    combined += `\n// ==== ${rel} ====\n` + stripComments(raw);
  }
  const driverRel = driverFile.slice(mameSrc.length + 1);
  const fileId = `file:${driverRel}`;

  const consts = parseDefines(combined);
  const memberTags = parseMemberTags(combined);

  // --- games ---
  const games = parseGames(combined);
  for (const gm of games) {
    const id = `game:${gm.name}`;
    g.node('Game', id, {
      name: gm.name, year: gm.year, company: gm.company, fullname: gm.fullname,
      monitor: gm.monitor, cls: gm.cls, init: gm.init, flags: gm.flags,
    });
    g.edge(id, fileId, 'DEFINED_IN');
    if (gm.parent !== '0') g.edge(id, `game:${gm.parent}`, 'CLONE_OF');
    g.edge(id, `machine:${gm.cls}.${gm.machine}`, 'USES_MACHINE');
    g.edge(id, `inputs:${gm.input}`, 'USES_INPUTS');
    g.edge(id, `romset:${gm.name}`, 'USES_ROMSET');
  }

  // --- rom sets ---
  for (const set of parseRomSets(combined)) {
    const setId = `romset:${set.name}`;
    g.node('RomSet', setId, { name: set.name });
    g.edge(setId, fileId, 'DEFINED_IN');
    for (const region of set.regions) {
      const regId = `region:${set.name}/${region.tag}`;
      g.node('RomRegion', regId, { tag: region.tag, size: region.size, flags: region.flags });
      g.edge(setId, regId, 'HAS_REGION');
      for (const load of region.loads) {
        const romId = `rom:${set.name}/${load.file}`;
        const props: Record<string, PropValue> = {
          file: load.file, offset: load.offset, size: load.size, crc: load.crc, sha1: load.sha1,
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
  for (const map of maps) {
    const mapId = `map:${map.cls}.${map.name}`;
    const mapProps: Record<string, PropValue> = { cls: map.cls, name: map.name };
    if (map.calls.length) mapProps.calls = map.calls;
    if (map.globalMask !== undefined) mapProps.globalMask = map.globalMask;
    if (map.unmapHigh) mapProps.unmapHigh = true;
    g.node('AddressMap', mapId, mapProps);
    g.edge(mapId, fileId, 'DEFINED_IN');
    for (const callee of map.calls) {
      const target = mapByName.get(callee);
      if (target) g.edge(mapId, `map:${target.cls}.${target.name}`, 'INCLUDES_MAP');
    }
    map.ranges.forEach((r, i) => {
      const rangeId = `${mapId}/range${i}`;
      const props: Record<string, PropValue> = { start: r.start, end: r.end, raw: r.raw };
      if (r.mirror !== undefined) props.mirror = r.mirror;
      for (const flag of ['rom', 'ram', 'writeonly', 'nopw', 'nopr'] as const) {
        if (r[flag]) props[flag] = true;
      }
      if (r.share) props.share = r.share;
      if (r.portRead) props.portRead = r.portRead;
      if (r.portWrite) props.portWrite = r.portWrite;
      g.node('AddressRange', rangeId, props);
      g.edge(mapId, rangeId, 'HAS_RANGE');
      for (const dir of ['read', 'write'] as const) {
        const h = r[dir];
        if (!h) continue;
        const owner = h.deviceClass ?? map.cls;
        const hid = `handler:${owner}.${h.method}`;
        g.node('Handler', hid, { method: h.method, ownerClass: owner });
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
  for (const cfg of machineConfigs) {
    const cfgId = `machine:${cfg.cls}.${cfg.name}`;
    g.node('MachineConfig', cfgId, { cls: cfg.cls, name: cfg.name, calls: cfg.calls });
    g.edge(cfgId, fileId, 'DEFINED_IN');
    for (const callee of cfg.calls) {
      const target = cfgByName.get(callee);
      if (target) g.edge(cfgId, `machine:${target.cls}.${target.name}`, 'CALLS');
    }
    for (const dev of cfg.devices) {
      const devId = `device:${cfg.name}/${dev.tag}`;
      const props: Record<string, PropValue> = {
        type: dev.type, tag: dev.tag, clock: dev.clock, config: dev.config,
      };
      if (dev.clockExpr) props.clockExpr = dev.clockExpr;
      if (dev.screenRaw) {
        props.screenRaw = [
          dev.screenRaw.pixclock, dev.screenRaw.htotal, dev.screenRaw.hbend, dev.screenRaw.hbstart,
          dev.screenRaw.vtotal, dev.screenRaw.vbend, dev.screenRaw.vbstart,
        ];
      }
      g.node('Device', devId, props);
      g.edge(cfgId, devId, 'HAS_DEVICE');
      for (const [space, mapName] of Object.entries(dev.addrMaps)) {
        g.edge(devId, `map:${cfg.cls}.${mapName}`, 'HAS_MAP', { space });
      }
      if (dev.gfxDecodeName) g.edge(cfgId, `gfxdecode:${dev.gfxDecodeName}`, 'DECODES');
    }
  }

  // --- inputs ---
  for (const inp of parseInputPorts(combined)) {
    const inpId = `inputs:${inp.name}`;
    g.node('InputPorts', inpId, { name: inp.name });
    g.edge(inpId, fileId, 'DEFINED_IN');
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
      });
    }
  }

  // --- gfx ---
  for (const layout of parseGfxLayouts(combined)) {
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
    g.node('GfxDecode', decId, { name: dec.name });
    g.edge(decId, fileId, 'DEFINED_IN');
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

  return g.toGraph({
    tool: 'mame2js',
    version: VERSION,
    mameSrc,
    driverFile: driverRel,
    generatedAt: new Date().toISOString(),
  });
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
