// Phase 2: knowledge-graph subgraph -> generated browser app.
// Emits out/<game>/app/{index.html, src/config.ts, src/main.ts, runtime copy,
// tsconfig.json} and compiles it with tsc. Everything game-specific comes from
// the graph; everything behavioral comes from the shared runtime.

import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { KnowledgeGraph, KGNode } from '../kg/types.ts';
import { parseSoftwareList, buildCatalog } from '../kg/softlist.ts';
import {
  buildRuntimeReport, runtimeReportMarkdown, type RuntimeConfigShape,
} from './runtime-report.ts';
import { emitGeneratedMachine } from './emit-machine.ts';
import type { BoardConfig } from '../runtime/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');

export interface GenerateOptions {
  mameSrc: string;
  outDir: string;
  game: string;
  /** full driver graph (all sets) — enables clone-family ROM alternates */
  fullGraph?: KnowledgeGraph;
}

// keyboard bindings per MAME input type (player 1 / non-cocktail only)
const KEYMAP: Record<string, string[]> = {
  IPT_JOYSTICK_LEFT: ['ArrowLeft'],
  IPT_JOYSTICK_RIGHT: ['ArrowRight'],
  IPT_JOYSTICK_UP: ['ArrowUp'],
  IPT_JOYSTICK_DOWN: ['ArrowDown'],
  // NOTE: never bind Ctrl — macOS eats Ctrl+Arrow (Mission Control), which
  // force-releases left/right movement while firing (user directive)
  IPT_BUTTON1: ['Space', 'KeyX'],
  IPT_BUTTON2: ['KeyZ'],
  IPT_START1: ['Digit1'],
  IPT_START2: ['Digit2'],
  IPT_COIN1: ['Digit5'],
  IPT_COIN2: ['Digit6'],
  IPT_SERVICE1: ['Digit9'],
  // console pads (nes joypad: A=IPT_BUTTON2 -> KeyZ, B=IPT_BUTTON1 -> KeyX/Space)
  IPT_START: ['Enter'],
  IPT_SELECT: ['ShiftRight'],
};

// Cart-slot options (mappers/PCBs) each runtime board family implements —
// a device-library capability table like CPU_TYPES, not a game fact. The
// softlist catalog carries every cart's slot; the app greys out the rest.
const CART_SLOT_SUPPORT: Record<string, string[]> = {
  nes: ['nrom', 'uxrom', 'cnrom', 'sxrom', 'txrom'], // iNES mappers 0, 2, 3, 1, 4
};

const CART_INTERFACE_BY_FAMILY: Record<string, string> = {
  nes: 'nes_cart',
};

// Explicitly supported cartridge titles (softlist parent short-names; clones
// of a listed parent count too). Playability is gated on THIS list, not just
// the mapper — titles are added one at a time as they're verified end-to-end
// (user directive 2026-07-07: "support explicit games, not all, so I can
// test"). The full catalog still identifies every cart on the shelf.
const CART_GAME_SUPPORT: Record<string, string[]> = {
  nes: ['smb'], // Super Mario Bros. (parent set; covers smb1 "World" etc.)
};

class Graph {
  private byId: Map<string, KGNode>;
  private g: KnowledgeGraph;
  constructor(g: KnowledgeGraph) {
    this.g = g;
    this.byId = new Map(g.nodes.map(n => [n.id, n]));
  }
  node(id: string): KGNode | undefined { return this.byId.get(id); }
  out(id: string, rel?: string) {
    return this.g.edges
      .filter(e => e.from === id && (!rel || e.rel === rel))
      .map(e => ({ edge: e, node: this.byId.get(e.to)! }))
      .filter(x => x.node);
  }
  byLabel(label: string): KGNode[] { return this.g.nodes.filter(n => n.label === label); }
}

export async function generate(graph: KnowledgeGraph, opts: GenerateOptions): Promise<void> {
  const g = new Graph(graph);
  const game = g.node(`game:${opts.game}`);
  if (!game) throw new Error(`game:${opts.game} missing from graph`);

  const machine = g.out(game.id, 'USES_MACHINE')[0]?.node;
  const romset = g.out(game.id, 'USES_ROMSET')[0]?.node;
  const inputs = g.out(game.id, 'USES_INPUTS')[0]?.node;
  if (!machine || !romset || !inputs) {
    throw new Error(`graph incomplete for ${opts.game}: machine=${!!machine} romset=${!!romset} inputs=${!!inputs}`);
  }

  // Board family selects the runtime board module. It defaults to the driver
  // file stem, but a single driver file can host several distinct boards
  // (galaga.cpp defines both galaga and digdug, with different maps/video/I/O).
  // A machine whose board differs from its file's default is remapped by name.
  const FAMILY_BY_MACHINE: Record<string, string> = { digdug: 'digdug' };
  const family = FAMILY_BY_MACHINE[String(machine.props.name)]
    ?? basename(String(graph.meta.driverFile)).replace(/\.cpp$/, '');

  // machine configs compose via helper calls (galaxian(config) -> galaxian_base(config));
  // walk the CALLS chain and collect devices from every config in it
  const devices: KGNode[] = [];
  /** set_addrmap patches in chain order (most-derived config first) */
  const mapPatches: { space: string; tag: string; mapId: string }[] = [];
  /** SOFTWARE_LIST declarations (consoles/computers) in chain order */
  const softlistNodes: KGNode[] = [];
  {
    const seen = new Set<string>();
    const queue = [machine.id];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const d of g.out(id, 'HAS_DEVICE')) {
        devices.push(d.node);
        // board-style devices carry a sub-machine (device_add_mconfig)
        queue.push(...g.out(d.node.id, 'CALLS').map(c => c.node.id));
      }
      for (const p of g.out(id, 'PATCHES_MAP')) {
        mapPatches.push({
          space: String(p.edge.props?.space),
          tag: String(p.edge.props?.deviceTag),
          mapId: p.node.id,
        });
      }
      softlistNodes.push(...g.out(id, 'HAS_SOFTLIST').map(s => s.node));
      queue.push(...g.out(id, 'CALLS').map(c => c.node.id));
    }
  }
  const kind: 'console' | undefined = game.props.kind === 'console' ? 'console' : undefined;
  const byTag = new Map(devices.map(d => [String(d.props.tag), d]));

  // --- cpus + address maps ----------------------------------------------------
  // Every CPU carries its own program map (and io map when the driver has
  // one). Device type -> runtime core is a device-library mapping.
  const CPU_TYPES: Record<string, string> = { Z80: 'z80', KONAMI1: 'konami1', I8039: 'i8039', I8080: 'i8080', M6803: 'm6803', MC6809: 'mc6809', MC6809E: 'mc6809e', RP2A03: 'rp2a03', RP2A03G: 'rp2a03' };
  const cpuDevs = devices.filter(d => String(d.props.type) in CPU_TYPES);
  if (cpuDevs.length === 0) throw new Error('no supported CPU devices found in machine config');

  // address maps compose via helper calls too (galaxian_map = base + discrete);
  // flatten ranges depth-first in statement order
  const collectRanges = (mapId: string, seen = new Set<string>()): KGNode[] => {
    if (seen.has(mapId)) return [];
    seen.add(mapId);
    const own = g.out(mapId, 'HAS_RANGE').map(r => r.node);
    const called = g.out(mapId, 'INCLUDES_MAP').flatMap(m => collectRanges(m.node.id, seen));
    return [...called, ...own];
  };

  const handlerKey = (h: { edge: { props?: Record<string, unknown> }; node: KGNode }) => {
    const tag = h.edge.props?.deviceTag;
    const owner = tag ?? String(h.node.props.ownerClass);
    return `${owner}.${h.node.props.method}`;
  };
  const rangeSpec = (r: KGNode) => {
    const reads = g.out(r.id, 'READS');
    const writes = g.out(r.id, 'WRITES');
    const spec: Record<string, unknown> = {
      start: Number(r.props.start),
      end: Number(r.props.end),
      kind: r.props.rom ? 'rom' : r.props.ram || r.props.writeonly ? 'ram' : 'handler',
    };
    if (r.props.mirror) spec.mirror = Number(r.props.mirror);
    if (r.props.share) spec.share = String(r.props.share);
    if (reads[0]) spec.read = handlerKey(reads[0]);
    if (writes[0]) spec.write = handlerKey(writes[0]);
    // .portr("IN0") -> read handler key "port.IN0" (boards register these from InputPorts)
    if (r.props.portRead) spec.read = `port.${r.props.portRead}`;
    if (r.props.portWrite) spec.write = `port.${r.props.portWrite}`;
    // .bankr(m_mainbank) -> "bank.mainbank" (the board owns bank switching)
    if (r.props.bankRead) spec.read = `bank.${r.props.bankRead}`;
    if (r.props.bankWrite) spec.write = `bank.${r.props.bankWrite}`;
    if (spec.kind === 'handler' && !spec.read && !spec.write) spec.kind = 'nop';
    return spec;
  };

  const cpuMaps = (dev: KGNode) => {
    // a set_addrmap patch from the game's config chain (most-derived first)
    // overrides the map set at device instantiation
    const mapRefs = g.out(dev.id, 'HAS_MAP');
    const forSpace = (space: string): KGNode | undefined => {
      const patch = mapPatches.find(p => p.tag === String(dev.props.tag) && p.space === space);
      if (patch) return g.node(patch.mapId);
      return mapRefs.find(m => (m.edge.props?.space ?? 'AS_PROGRAM') === space)?.node;
    };
    const programMap = forSpace('AS_PROGRAM');
    if (!programMap) throw new Error(`no address map on ${dev.props.tag}`);
    const ranges = collectRanges(programMap.id).map(rangeSpec);
    // program-space global_mask (the Irem sound 6803 masks to 0x7fff so its
    // reset vector at $FFFE reads ROM $7FFE)
    const mask = programMap.props.globalMask !== undefined ? Number(programMap.props.globalMask) : undefined;
    const ioMap = forSpace('AS_IO');
    let io: Record<string, unknown> | undefined;
    if (ioMap) {
      io = { ranges: collectRanges(ioMap.id).map(rangeSpec) };
      if (ioMap.props.globalMask !== undefined) io.globalMask = Number(ioMap.props.globalMask);
    }
    return { ranges, ...(mask !== undefined ? { mask } : {}), io };
  };

  const cpus = cpuDevs.map(d => ({
    tag: String(d.props.tag),
    type: CPU_TYPES[String(d.props.type)],
    clock: Number(d.props.clock),
    region: String(d.props.tag), // rom region tag == cpu tag across supported families
    ...cpuMaps(d),
  }));

  // legacy alias: boards for single-map families read cpus[n].ranges; the
  // shared `ranges` field mirrors cpu[0] for the galaga family's shared map
  const ranges = cpus[0].ranges;
  const io = cpus[0].io;

  // --- screen ------------------------------------------------------------------
  // Arcade drivers use set_raw; consoles (nes.cpp) use the
  // set_refresh_hz/set_size/set_visarea trio instead.
  const screenDev = devices.find(d => d.props.type === 'SCREEN');
  const raw = screenDev?.props.screenRaw as number[] | undefined;
  let pixclock: number, htotal: number, hbend: number, hbstart: number, vtotal: number, vbend: number, vbstart: number;
  if (raw) {
    [pixclock, htotal, hbend, hbstart, vtotal, vbend, vbstart] = raw;
  } else if (screenDev?.props.screenRefreshHz && screenDev.props.screenSize && screenDev.props.screenVisarea) {
    const [w] = screenDev.props.screenSize as number[];
    const [x0, x1, y0, y1] = screenDev.props.screenVisarea as number[];
    vtotal = (screenDev.props.screenSize as number[])[1];
    hbend = x0; hbstart = x1 + 1;
    vbend = y0; vbstart = y1 + 1;
    htotal = w;
    pixclock = Number(screenDev.props.screenRefreshHz) * htotal * vtotal;
  } else {
    throw new Error('screen raw params missing');
  }

  // the galaxian driver renders horizontally pre-scaled (GFXDECODE_SCALE
  // xscale 3, h params scaled to match); divide back to native pixels
  let xscale = 1;
  {
    const machineIds = new Set<string>();
    const q = [machine.id];
    while (q.length) {
      const id = q.shift()!;
      if (machineIds.has(id)) continue;
      machineIds.add(id);
      q.push(...g.out(id, 'CALLS').map(c => c.node.id));
    }
    for (const id of machineIds) {
      for (const { node: dec } of g.out(id, 'DECODES')) {
        for (const { node: e } of g.out(dec.id, 'HAS_ENTRY')) {
          xscale = Math.max(xscale, Number(e.props.xscale ?? 1));
        }
      }
    }
  }

  const monitor = String(game.props.monitor);
  const screen = {
    width: (hbstart - hbend) / xscale,
    height: vbstart - vbend,
    refresh: pixclock / (htotal * vtotal),
    vtotal,
    vbstart,
    vbend,
    rotate: monitor === 'ROT90' ? 90 : monitor === 'ROT270' ? 270 : monitor === 'ROT180' ? 180 : 0,
  };

  // --- clocks + sound -------------------------------------------------------------
  const clocks = {
    namco06: Number(byTag.get('06xx')?.props.clock ?? 48000),
    wsg: Number(byTag.get('namco')?.props.clock ?? 96000),
  };
  // sound device -> runtime SoundCore kind (device-library mapping, not game-specific)
  const ayChips = devices.filter(d => d.props.type === 'AY8910');
  const ymChips = devices.filter(d => d.props.type === 'YM2203');
  // Per-family analog mix weights, hand-derived from each driver's discrete
  // resistor network — the one MAME layer the graph can't carry yet (the
  // nets are data tables inside DISCRETE_SOUND_START, not device wiring).
  // Values are relative: chipGains[] scales each PSG inside the bank, and
  // dacGain replaces the worklet's junofrst-derived default (0.25).
  // TODO(#12): parse plain add_route gains from the graph for the simple
  // (non-discrete) boards, and lift these into graph facts.
  const soundFamily = family;
  const AY_MIX: Record<string, { chipGains?: number[]; dacGain?: number }> = {
    // gyruss.cpp sound_discrete + konami_*_mixer_desc: chips 0/1 feed the
    // mixer at 1.0 through 2.2k per channel; chips 2-4 at 0.33 through
    // 1.1k (= 0.66 of a chip-0 channel); the i8039 DAC (4V TTL) through
    // 4.7k ≈ 0.62 of ONE channel's full swing — vs our flat bank where it
    // was ~11 channels' worth ("pulsing drums way too loud").
    gyruss: { chipGains: [1, 1, 0.66, 0.66, 0.66], dacGain: 0.014 },
  };
  const sound = devices.some(d => String(d.props.type).startsWith('RP2A03'))
    // the NES APU lives on the CPU die — the RP2A03 is its own sound device
    ? { kind: 'nes', clock: cpus[0].clock }
    : devices.some(d => d.props.type === 'NAMCO_WSG' || d.props.type === 'NAMCO')
    ? { kind: 'wsg', clock: Number(byTag.get('namco')?.props.clock ?? 96000), waveRegion: 'namco' }
    : devices.some(d => d.props.type === 'GALAXIAN_SOUND')
      ? { kind: 'galaxian', clock: cpus[0].clock }
      : devices.some(d => d.props.type === 'INVADERS_AUDIO')
        ? { kind: 'invaders', clock: cpus[0].clock }
        : ymChips.length
          ? { kind: 'ym2203', clock: Number(ymChips[0].props.clock), chips: ymChips.length }
          : ayChips.length
            ? { kind: 'ay8910', clock: Number(ayChips[0].props.clock), chips: ayChips.length, ...AY_MIX[soundFamily] }
            : { kind: 'none' };

  // --- roms ----------------------------------------------------------------------
  // Clone-family alternates: MAME renames/redumps program ROMs across
  // revisions (current "gng" wants mm_c_04; a classic set carries gg4.bin
  // with a different CRC — both are real Ghosts'n Goblins). Any sibling
  // set's chip occupying the same region/offset/size slot is an acceptable
  // alternative, derived entirely from the driver's other ROM_START blocks.
  const altSlots = new Map<string, { file: string; crc: string }[]>();
  if (opts.fullGraph) {
    const full = new Graph(opts.fullGraph);
    const gameId = `game:${opts.game}`;
    const parentId = full.out(gameId, 'CLONE_OF')[0]?.node.id ?? gameId;
    const family = opts.fullGraph.nodes.filter(n =>
      n.label === 'Game' && n.id !== gameId &&
      (n.id === parentId || full.out(n.id, 'CLONE_OF')[0]?.node.id === parentId));
    for (const sib of family) {
      const sibSet = full.out(sib.id, 'USES_ROMSET')[0]?.node;
      if (!sibSet) continue;
      for (const { node: region } of full.out(sibSet.id, 'HAS_REGION')) {
        for (const { node: rom } of full.out(region.id, 'LOADS')) {
          const key = `${region.props.tag}/${rom.props.offset}/${rom.props.size}`;
          (altSlots.get(key) ?? altSlots.set(key, []).get(key)!)
            .push({ file: String(rom.props.file), crc: String(rom.props.crc) });
        }
      }
    }
  }
  const roms = g.out(romset.id, 'HAS_REGION').map(({ node: region }) => ({
    region: String(region.props.tag),
    size: Number(region.props.size),
    loads: g.out(region.id, 'LOADS').map(({ node: rom }) => {
      const crc = String(rom.props.crc);
      const alts = (altSlots.get(`${region.props.tag}/${rom.props.offset}/${rom.props.size}`) ?? [])
        .filter((a, i, arr) => a.crc !== crc && arr.findIndex(x => x.crc === a.crc) === i);
      return {
        file: String(rom.props.file),
        offset: Number(rom.props.offset),
        size: Number(rom.props.size),
        crc,
        ...(alts.length ? { alt: alts } : {}),
        ...(rom.props.reloadOffsets ? { reloadOffsets: rom.props.reloadOffsets as number[] } : {}),
      };
    }),
  }));

  // --- inputs -----------------------------------------------------------------------
  // Port polarity comes from the graph per field: galaga/pacman inputs are
  // active-low, galaxian's are active-HIGH (coin bit 0 at rest) — the resting
  // ("init") byte must be computed per port or galaxian sees a stuck coin switch.
  //
  // PORT_INCLUDE resolution: walk the INCLUDES_PORTS chain root-first and
  // merge — a PORT_START in a derived set replaces the whole port; a
  // PORT_MODIFY replaces base fields whose masks overlap (mpatrol inherits
  // m52's coin/start/service ports and modifies the joystick bits).
  interface EffPort { tag: string; fields: KGNode[] }
  const inputsChain: KGNode[] = [];
  for (let n: KGNode | undefined = inputs; n; n = g.out(n.id, 'INCLUDES_PORTS')[0]?.node) {
    inputsChain.unshift(n);
    if (inputsChain.length > 8) break; // cycle guard
  }
  const effPorts = new Map<string, EffPort>();
  for (const setNode of inputsChain) {
    for (const { node: port } of g.out(setNode.id, 'HAS_PORT')) {
      const tag = String(port.props.tag);
      const fields = g.out(port.id, 'HAS_FIELD').map(f => f.node);
      if (port.props.modify && effPorts.has(tag)) {
        const eff = effPorts.get(tag)!;
        for (const f of fields) {
          const mask = Number(f.props.mask);
          eff.fields = eff.fields.filter(b => (Number(b.props.mask) & mask) === 0);
          eff.fields.push(f);
        }
      } else {
        effPorts.set(tag, { tag, fields });
      }
    }
  }
  const ports = [...effPorts.values()];
  const portSpecs: { tag: string; init: number }[] = [];
  const bindings: unknown[] = [];
  const dipDefaults: unknown[] = [];
  const customs: { port: string; mask: number; member: string }[] = [];
  for (const port of ports) {
    const tag = port.tag;
    let init = 0;
    for (const f of port.fields) {
      const kind = f.props.kind;
      const mask = Number(f.props.mask);
      const activeLow = f.props.activeLow !== false; // default LOW (classic hardware)
      if (kind === 'dip') {
        const value = Number(f.props.defaultValue ?? mask); // unused dips default to off (active low)
        init = (init & ~mask) | (value & mask);
        dipDefaults.push({ port: tag, mask, value, name: String(f.props.name ?? '') });
      } else if (kind === 'service') {
        // service switch at rest = released
        if (activeLow) init |= mask;
        dipDefaults.push({ port: tag, mask, value: activeLow ? mask : 0, name: 'Service Mode' });
      } else if (kind === 'bit') {
        if (activeLow) init |= mask; // released = bit set; active-high released = bit clear
        const type = String(f.props.type ?? '');
        const mods = (f.props.modifiers as string[] | undefined) ?? [];
        // IPT_CUSTOM bits are synthesized from other ports by a named driver
        // member (invaders reads CONTP1 into IN0/IN1/IN2 bits 4-6) — emit
        // the wiring fact for the board's member table
        const customMember = mods
          .map(m => m.startsWith('PORT_CUSTOM_MEMBER') ? /(\w+)\s*\)*$/.exec(m)?.[1] : undefined)
          .find(Boolean);
        if (type === 'IPT_CUSTOM' && customMember) {
          customs.push({ port: tag, mask, member: customMember });
          continue;
        }
        if (mods.includes('PORT_COCKTAIL')) continue;  // player-2 cocktail path: unbound
        if (mods.includes('PORT_PLAYER(2)')) continue; // don't double-bind P1 keys
        const keys = KEYMAP[type];
        if (keys) bindings.push({ port: tag, mask, keys, label: type, activeLow });
      }
    }
    portSpecs.push({ tag, init });
  }

  // Console control ports live on the default slot device, not the driver
  // (nes.cpp's INPUT_PORTS_START(nes) is empty; the joypad's fields come from
  // bus/nes_ctrl/joypad.cpp via the graph's Device->InputPorts USES_INPUTS
  // edge). Port tags are namespaced `${devTag}:${portTag}` (ctrl1:JOYPAD);
  // only the first control port gets keyboard bindings (P2 unbound first cut).
  if (kind === 'console') {
    let boundController = false;
    for (const dev of devices) {
      const slotInputs = g.out(dev.id, 'USES_INPUTS')[0]?.node;
      if (!slotInputs) continue;
      for (const { node: port } of g.out(slotInputs.id, 'HAS_PORT')) {
        const tag = `${dev.props.tag}:${port.props.tag}`;
        let init = 0;
        for (const f of g.out(port.id, 'HAS_FIELD').map(x => x.node)) {
          if (f.props.kind !== 'bit') continue;
          const mask = Number(f.props.mask);
          const activeLow = f.props.activeLow !== false;
          if (activeLow) init |= mask;
          if (boundController) continue;
          const type = String(f.props.type ?? '');
          const keys = KEYMAP[type];
          if (!keys) continue;
          const mods = (f.props.modifiers as string[] | undefined) ?? [];
          const named = mods.map(m => /PORT_NAME\("(?:%p )?([^"]+)"\)/.exec(m)?.[1]).find(Boolean);
          bindings.push({ port: tag, mask, keys, label: named ?? type, activeLow });
        }
        portSpecs.push({ tag, init });
      }
      boundController = true;
    }
  }

  // --- emit ---------------------------------------------------------------------------
  const title = `${game.props.fullname} (${game.props.company}, ${game.props.year})`;

  // Console cart catalog: the machine's primary software list (first
  // status:'original' whose hash/<name>.xml exists) extracted to a sibling
  // artifact — dist/<machine>/softlist.json. The graph carries the LIST fact;
  // the 4,500+ cart entries stay out of graph.json (they'd swamp the viewer).
  let cart: Record<string, unknown> | undefined;
  let cartEntries = 0;
  if (kind === 'console') {
    mkdirSync(opts.outDir, { recursive: true });
    for (const listNode of softlistNodes) {
      if (listNode.props.status !== 'original') continue;
      const listName = String(listNode.props.name);
      const xmlPath = join(opts.mameSrc, 'hash', `${listName}.xml`);
      const catalogPath = join(opts.outDir, 'softlist.json');
      const catalog = existsSync(xmlPath)
        ? buildCatalog(
            parseSoftwareList(readFileSync(xmlPath, 'utf8')),
            listNode.props.filter ? String(listNode.props.filter) : undefined,
          )
        : existsSync(catalogPath)
          ? JSON.parse(readFileSync(catalogPath, 'utf8'))
          : null;
      if (!catalog) continue;
      if (existsSync(xmlPath)) {
        // compact on purpose: ~4.5k entries; indented it triples in size
        writeFileSync(catalogPath, JSON.stringify(catalog));
      }
      cart = {
        interface: catalog.interface,
        list: listName,
        catalogUrl: 'softlist.json',
        slots: CART_SLOT_SUPPORT[family] ?? [],
        games: CART_GAME_SUPPORT[family] ?? [],
      };
      cartEntries = catalog.entries.length;
      console.log(`softlist "${listName}": ${catalog.entries.length} cartridges catalogued`);
      break;
    }
    if (!cart) {
      const listNode = softlistNodes.find(node => node.props.status === 'original');
      const cartInterface = CART_INTERFACE_BY_FAMILY[family];
      if (listNode && cartInterface) {
        cart = {
          interface: cartInterface,
          list: String(listNode.props.name),
          catalogUrl: 'softlist.json',
          slots: CART_SLOT_SUPPORT[family] ?? [],
          games: CART_GAME_SUPPORT[family] ?? [],
        };
      }
    }
    if (!cart) console.warn('  ! console machine has no resolvable software list — carts will be header-identified only');
  }

  // driver-init ROM byte patches (rocnrope's one-instruction fix), applied by
  // the shell after region assembly
  const romPatches = Array.isArray(game.props.romPatches)
    ? game.props.romPatches.map(s => {
        const [region, offset, value] = String(s).split(':');
        return { region, offset: Number(offset), value: Number(value) };
      })
    : undefined;

  const config = {
    game: opts.game,
    title,
    family,
    ...(kind ? { kind } : {}),
    board: { family, cpus, ranges, ...(io ? { io } : {}), ...(customs.length ? { customs } : {}), screen, clocks },
    sound,
    roms,
    ...(romPatches ? { romPatches } : {}),
    ...(cart ? { cart } : {}),
    bindings,
    dipDefaults,
    ports: portSpecs,
    // no romUrl: ROMs are never fetched — the shell only accepts user drops
    // (console carts are remembered per-browser in IndexedDB via
    // runtime/cartstore.ts, by explicit user approval 2026-07-07)
    runtimeUrl: './dist/runtime/',
    menuUrl: './',
  };

  // per-game metadata for the boot menu manifest + "learn" modal:
  // driver credits from the source header, contribution history from the
  // MAME git checkout (best effort — absent when git/history unavailable)
  let gitHistory: Record<string, unknown> | undefined;
  try {
    const log = spawnSync('git', ['-C', opts.mameSrc, 'log', '--follow', '--format=%as|%an', '--', String(graph.meta.driverFile)],
      { encoding: 'utf8', timeout: 30000 });
    const lines = (log.stdout ?? '').trim().split('\n').filter(Boolean);
    if (lines.length) {
      const authors = new Map<string, number>();
      for (const l of lines) {
        const name = l.split('|')[1];
        if (name) authors.set(name, (authors.get(name) ?? 0) + 1);
      }
      gitHistory = {
        firstCommit: lines[lines.length - 1].split('|')[0],
        lastCommit: lines[0].split('|')[0],
        commits: lines.length,
        contributors: authors.size,
        topAuthors: [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n),
      };
    }
  } catch { /* no git history available */ }

  // Gaming History write-up (user-supplied arcade-history.com history.xml in
  // artwork/data/, gitignored like the artwork; attribution shown in the app)
  let hasHistory = false;
  let historyText = '';
  const historyXmlPath = join(projectRoot, 'artwork/data/history/history.xml');
  if (existsSync(historyXmlPath)) {
    try {
      const xml = readFileSync(historyXmlPath, 'utf8');
      const at = xml.indexOf(`<system name="${opts.game}"`);
      if (at >= 0) {
        const entryStart = xml.lastIndexOf('<entry>', at);
        const textStart = xml.indexOf('<text>', entryStart);
        const textEnd = xml.indexOf('</text>', textStart);
        if (entryStart >= 0 && textStart >= 0 && textEnd > textStart) {
          historyText = xml.slice(textStart + 6, textEnd)
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .replace(/\r\n/g, '\n') // the .dat ships CRLF; regexes downstream assume \n
            .trim();
          writeFileSync(join(opts.outDir, 'history.txt'),
            historyText + '\n\n— Gaming History (arcade-history.com)\n');
          hasHistory = true;
        }
      }
    } catch { /* malformed dat — skip */ }
  }

  writeFileSync(join(opts.outDir, 'meta.json'), JSON.stringify({
    game: opts.game,
    title,
    fullname: game.props.fullname,
    year: game.props.year,
    manufacturer: game.props.company,
    family,
    ...(kind ? { kind } : {}),
    driverFile: graph.meta.driverFile,
    ...(graph.meta.license ? { license: graph.meta.license } : {}),
    ...(graph.meta.copyrightHolders ? { copyrightHolders: graph.meta.copyrightHolders } : {}),
    ...(gitHistory ? { gitHistory } : {}),
    ...(hasHistory ? { hasHistory: true } : {}),
  }, null, 2));

  // the game itself is pure knowledge-graph data — the unified app at
  // out/app loads it at runtime (no per-game compile)
  writeFileSync(join(opts.outDir, 'config.json'), JSON.stringify(config, null, 2));
  const runtimeReport = buildRuntimeReport(graph, config as unknown as RuntimeConfigShape);
  writeFileSync(join(opts.outDir, 'runtime-report.json'), JSON.stringify(runtimeReport, null, 2));
  writeFileSync(join(opts.outDir, 'runtime-report.md'), runtimeReportMarkdown(runtimeReport));
  emitGeneratedMachine(
    graph,
    opts.game,
    family,
    opts.outDir,
    config.board as unknown as BoardConfig,
  );

  // the full dossier: everything above as a standalone markdown document,
  // readable outside the app (out/<game>/README.md, linked from the modal)
  writeFileSync(join(opts.outDir, 'README.md'), gameMarkdown({
    game: opts.game, title, fullname: String(game.props.fullname),
    year: String(game.props.year), company: String(game.props.company),
    family, driverFile: String(graph.meta.driverFile),
    license: graph.meta.license as string | undefined,
    copyrightHolders: graph.meta.copyrightHolders as string | undefined,
    cpus, sound, screen, roms, bindings, dipDefaults, gitHistory, historyText,
    ...(cart ? {
      cart: { list: String(cart.list), entries: cartEntries, slots: cart.slots as string[] },
    } : {}),
  }));
  console.log(`\ngenerated ${join(opts.outDir, 'config.json')} (+ meta.json, README.md, runtime report)`);
  if (!existsSync(join(projectRoot, 'roms', `${opts.game}.zip`))) {
    console.log(`note: put ${opts.game}.zip in ${join(projectRoot, 'roms')}/ to auto-load ROMs (or drop the zip onto the page)`);
  }
}

/**
 * Render the per-game dossier: the same knowledge-graph facts the app shows,
 * as one standalone markdown document. Nothing here is hand-written — every
 * fact flows from the graph (or MAME git / Gaming History side-channels).
 */
function gameMarkdown(d: {
  game: string; title: string; fullname: string; year: string; company: string;
  family: string; driverFile: string; license?: string; copyrightHolders?: string;
  cpus: { tag: string; type?: string; clock: number; ranges: unknown[] }[];
  sound: { kind: string; clock?: number; chips?: number };
  screen: { width: number; height: number; refresh: number; rotate?: number };
  roms: { region: string; size: number; loads: { file: string; offset: number; size: number; crc: string }[] }[];
  bindings: unknown[]; dipDefaults: unknown[];
  gitHistory?: Record<string, unknown>; historyText: string;
  cart?: { list: string; entries: number; slots: string[] };
}): string {
  const hex = (n: number) => '0x' + n.toString(16);
  const prettyKey = (k: string) => k.replace(/^Key|^Arrow|^Digit/, '');
  const prettyIpt = (l: string) => l.replace(/^IPT_/, '').replace(/_/g, ' ').toLowerCase();
  const md: string[] = [];

  md.push(`# ${d.fullname}`);
  md.push('');
  md.push(`**${d.company} · ${d.year}** — transpiled from the MAME driver \`${d.driverFile}\` by mamekit.`);
  md.push('');
  md.push(`![marquee](/artwork/media/marquees/${d.game}.png)`);
  md.push('');
  md.push(`| Flyer | Cabinet |`);
  md.push(`| --- | --- |`);
  md.push(`| ![flyer](/artwork/covers/${d.game}.png) | ![cabinet](/artwork/media/cabinets/${d.game}.png) |`);
  md.push('');

  md.push('## The machine');
  md.push('');
  md.push('| CPU | Type | Clock | Mapped ranges |');
  md.push('| --- | --- | --- | --- |');
  for (const c of d.cpus) {
    md.push(`| \`${c.tag}\` | ${(c.type ?? 'z80').toUpperCase()} | ${(c.clock / 1e6).toFixed(3)} MHz | ${c.ranges.length} |`);
  }
  md.push('');
  md.push(`- **Sound:** ${d.sound.kind === 'none' ? 'discrete analog board' : d.sound.kind}` +
    (d.sound.chips ? ` × ${d.sound.chips}` : '') +
    (d.sound.clock ? ` @ ${(d.sound.clock / 1e6).toFixed(3)} MHz` : ''));
  md.push(`- **Screen:** ${d.screen.width}×${d.screen.height} @ ${d.screen.refresh.toFixed(2)} Hz` +
    (d.screen.rotate ? ` · rotated ${d.screen.rotate}°` : ''));
  md.push('');

  if (d.cart) {
    md.push('### Cartridges');
    md.push('');
    md.push(`The machine itself needs no ROMs — all software comes on cartridges. ` +
      `${d.cart.entries.toLocaleString('en-US')} cartridges are catalogued from the MAME \`${d.cart.list}\` ` +
      `software list; ${d.cart.slots.length} PCB types are currently supported ` +
      `(${d.cart.slots.map(s => `\`${s}\``).join(', ')}). Drop your own legally-dumped ` +
      `cart files onto the console page to play.`);
    md.push('');
  } else {
    md.push('### ROM chips');
    md.push('');
    md.push('| Region | Chip | Offset | Size | CRC |');
    md.push('| --- | --- | --- | --- | --- |');
    for (const r of d.roms) {
      for (const l of r.loads) {
        md.push(`| \`${r.region}\` | \`${l.file}\` | ${hex(l.offset)} | ${hex(l.size)} | \`${l.crc}\` |`);
      }
    }
    md.push('');
  }

  const binds = d.bindings as { port: string; mask: number; keys: string[]; label: string }[];
  if (binds.length) {
    md.push('## Controls');
    md.push('');
    md.push('| Key | Function | Port | Bit |');
    md.push('| --- | --- | --- | --- |');
    for (const b of binds) {
      md.push(`| ${b.keys.map(prettyKey).join(' / ')} | ${prettyIpt(b.label)} | \`${b.port}\` | ${hex(b.mask)} |`);
    }
    md.push('');
  }

  const dips = (d.dipDefaults as { port: string; mask: number; value: number; name: string }[])
    .filter(x => x.name);
  if (dips.length) {
    md.push('## DIP switches (factory defaults)');
    md.push('');
    md.push('| Setting | Port | Mask | Default |');
    md.push('| --- | --- | --- | --- |');
    for (const x of dips) md.push(`| ${x.name} | \`${x.port}\` | ${hex(x.mask)} | ${hex(x.value)} |`);
    md.push('');
  }

  md.push('## The MAME driver — the people who reverse-engineered it');
  md.push('');
  md.push(`- **Driver source:** \`${d.driverFile}\``);
  if (d.copyrightHolders) md.push(`- **Written by:** ${d.copyrightHolders}`);
  if (d.license) md.push(`- **License:** ${d.license}`);
  if (d.gitHistory) {
    const gh = d.gitHistory as { firstCommit: string; lastCommit: string; commits: number; contributors: number; topAuthors: string[] };
    md.push(`- **Development:** ${gh.commits} commits by ${gh.contributors} contributors, ${gh.firstCommit.slice(0, 4)}–${gh.lastCommit.slice(0, 4)}`);
    md.push(`- **Top contributors:** ${gh.topAuthors.join(', ')}`);
  }
  md.push('');

  if (d.historyText) {
    md.push('## The story');
    md.push('');
    // Gaming History marks chapters as "- TRIVIA -" lines: promote to headings
    md.push(d.historyText.replace(/^- ([A-Z][A-Z0-9 .&'/-]{2,}) -\s*$/gm,
      (_, name: string) => `### ${name.charAt(0) + name.slice(1).toLowerCase()}`));
    md.push('');
    md.push('*Story courtesy of [Gaming History](https://www.arcade-history.com/) (arcade-history.com).*');
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push(`*Generated by [mamekit](https://github.com/benbruscella/mamekit) from the knowledge graph of MAME driver \`${d.family}\`. Play it at [../app/g/${d.game}/](../app/g/${d.game}/) or [explore the knowledge graph](viewer.html).*`);
  md.push('');
  return md.join('\n');
}

/**
 * Build the unified browser app at <outRoot>/app: one runtime compile shared
 * by every generated game. /app/ is the boot menu; /app/?g=<game> boots a
 * game from its /<game>/config.json.
 */
export function buildApp(outRoot: string): boolean {
  const appDir = join(outRoot, 'app');
  const buildDir = join(appDir, '.build');
  const srcDir = join(buildDir, 'src');
  const modulesDir = join(appDir, 'modules');
  // The app is entirely generated. Recreate it so renamed output directories
  // and deleted runtime modules cannot survive as mixed build artifacts.
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });

  cpSync(join(projectRoot, 'src/runtime'), join(srcDir, 'runtime'), {
    recursive: true,
    filter: source =>
      !source.endsWith('.spec.ts') &&
      !source.endsWith('/capabilities.ts'),
  });
  const hardwareImports: string[] = [];
  const cpuBindings: string[] = [];
  const deviceBindings: string[] = [];
  const hardwareManifestPath = join(outRoot, 'runtime/generated/hardware-manifest.json');
  if (existsSync(hardwareManifestPath)) {
    const manifest = JSON.parse(readFileSync(hardwareManifestPath, 'utf8')) as {
      hardware?: {
        type: string;
        executable?: boolean;
        executableKind?: 'cpu' | 'device';
      }[];
    };
    const sourceDir = join(outRoot, 'runtime/generated/devices');
    const targetDir = join(srcDir, 'generated-hardware/devices');
    mkdirSync(targetDir, { recursive: true });
    for (const hardware of manifest.hardware ?? []) {
      if (!hardware.executable) continue;
      const slug = hardware.type.toLowerCase();
      const sourceFile = join(sourceDir, `${slug}.ts`);
      if (!existsSync(sourceFile)) continue;
      const binding = hardware.executableKind === 'device'
        ? `device_${deviceBindings.length}`
        : `cpu_${cpuBindings.length}`;
      hardwareImports.push(`import ${binding} from './generated-hardware/devices/${slug}.ts';`);
      if (hardware.executableKind === 'device') deviceBindings.push(binding);
      else cpuBindings.push(binding);
      writeFileSync(
        join(targetDir, `${slug}.ts`),
        readFileSync(sourceFile, 'utf8')
          .replaceAll('../../../app/modules/runtime/', '../../runtime/'),
      );
    }
  }
  const generatedImports: string[] = [];
  for (const entry of readdirSync(outRoot).sort()) {
    const generatedDir = join(outRoot, entry, 'generated');
    const boardSource = join(generatedDir, 'board.ts');
    if (!existsSync(boardSource)) continue;
    const target = join(srcDir, 'generated', entry);
    mkdirSync(target, { recursive: true });
    cpSync(generatedDir, target, { recursive: true });
    for (const file of readdirSync(target).filter(file => file.endsWith('.ts'))) {
      const targetFile = join(target, file);
      const source = readFileSync(targetFile, 'utf8');
      writeFileSync(
        targetFile,
        source.replaceAll('../../app/modules/runtime/', '../../runtime/'),
      );
    }
    const binding = `board_${generatedImports.length}`;
    generatedImports.push(`import ${binding} from './${entry}/board.ts';`);
  }
  const boardBindings = generatedImports.map((_, index) => `board_${index}`);
  mkdirSync(join(srcDir, 'generated'), { recursive: true });
  writeFileSync(join(srcDir, 'generated/registry.ts'), `// GENERATED by mamekit — do not edit.
import { registerGeneratedMachine } from '../runtime/generated-machine.ts';
import { registerGeneratedBoard } from '../runtime/boards/index.ts';
import { registerGeneratedCpu } from '../runtime/generated-cpu.ts';
import { registerGeneratedDevice } from '../runtime/generated-device.ts';
${hardwareImports.join('\n')}
${generatedImports.join('\n')}

export function registerGeneratedMachines(): void {
  for (const cpu of [${cpuBindings.join(', ')}]) registerGeneratedCpu(cpu);
  for (const device of [${deviceBindings.join(', ')}]) registerGeneratedDevice(device);
  for (const board of [${boardBindings.join(', ')}]) {
    registerGeneratedMachine(board.machine);
    registerGeneratedBoard(board.machine.game, board.createBoard);
  }
}
`);

  writeFileSync(join(srcDir, 'main.ts'), `// GENERATED by mamekit — do not edit.
// Unified app: no ?g= -> boot menu; ?g=<game> -> load that game's generated
// config (pure knowledge-graph data) and run it.
import { runShell, type ShellConfig } from './runtime/shell.ts';
import { runConsole } from './runtime/console.ts';
import { runMenu } from './runtime/menu.ts';
import { registerGeneratedMachines } from './generated/registry.ts';

registerGeneratedMachines();

// force https on real domains: AudioWorklet (all sound) needs a secure
// context, and github's own enforcement only kicks in after cert issuance
if (location.protocol === 'http:' && !/^(localhost|127\\.|192\\.168\\.|10\\.)/.test(location.hostname)) {
  location.replace(location.href.replace(/^http:/, 'https:'));
}

// game comes from the pretty route /app/g/<game>/ or the legacy ?g= param
const game = decodeURIComponent(/\\/g\\/([^/]+)\\/?$/.exec(location.pathname)?.[1] ?? '')
  || new URLSearchParams(location.search).get('g');
const fail = (err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    '<pre style="color:#f66;padding:12px">' + String((err as Error)?.stack ?? err) + '</pre>');
};
if (game) {
  fetch(\`../\${encodeURIComponent(game)}/config.json\`)
    .then(r => { if (!r.ok) throw new Error(\`no generated config for "\${game}" — run: mamekit \${game}\`); return r.json(); })
    .then(cfg => (cfg as ShellConfig).kind === 'console'
      ? runConsole(cfg as ShellConfig)   // console room: cart shelf, drop zone, per-cart boot
      : runShell(cfg as ShellConfig))
    .catch(fail);
} else {
  runMenu().catch(fail);
}
`);

  writeFileSync(join(buildDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true,
      allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
      erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true,
      outDir: '../modules', rootDir: 'src',
    },
    include: ['src'],
  }, null, 2));

  // per-build stamp on the module URL: browsers cache module scripts hard,
  // and pages' CDN adds 10 min — the query flips both on every deploy
  const stamp = Date.now().toString(36);
  writeFileSync(join(appDir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAME History</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>👾</text></svg>">
</head>
<body>
<script type="module" src="./modules/main.js?v=${stamp}"></script>
<noscript>mamekit needs JavaScript.</noscript>
</body>
</html>
`);

  // root convenience redirect: / -> app/ (relative — works under a Pages base path)
  writeFileSync(join(outRoot, 'index.html'),
    '<!doctype html><meta http-equiv="refresh" content="0;url=app/">');

  // pretty per-game routes: /app/g/<game>/ as REAL directories (static hosts
  // have no rewrites). <base href="../../"> makes every relative URL resolve
  // exactly as it does on /app/, so the one compiled bundle serves all routes.
  for (const entry of readdirSync(outRoot)) {
    if (!existsSync(join(outRoot, entry, 'meta.json'))) continue;
    let title = entry;
    try { title = JSON.parse(readFileSync(join(outRoot, entry, 'meta.json'), 'utf8')).title ?? entry; } catch { /* keep slug */ }
    const dir = join(appDir, 'g', entry);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<base href="../../">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>👾</text></svg>">
</head>
<body>
<script type="module" src="./modules/main.js?v=${stamp}"></script>
<noscript>mamekit needs JavaScript.</noscript>
</body>
</html>
`);
  }

  console.log('compiling unified app with tsc...');
  const tsc = spawnSync(process.execPath, [
    join(projectRoot, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(buildDir, 'tsconfig.json'),
  ], {
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    console.error('tsc failed — app emitted but not compiled');
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(modulesDir, { recursive: true, force: true });
    return false;
  }
  rmSync(buildDir, { recursive: true, force: true });
  console.log(`app ready: ${join(appDir, 'index.html')}`);
  return true;
}
