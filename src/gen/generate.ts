// Phase 2: knowledge-graph subgraph -> generated browser app.
// Emits out/<game>/app/{index.html, src/config.ts, src/main.ts, runtime copy,
// tsconfig.json} and compiles it with tsc. Everything game-specific comes from
// the graph; everything behavioral comes from the shared runtime.

import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { KnowledgeGraph, KGNode } from '../kg/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');

export interface GenerateOptions {
  mameSrc: string;
  outDir: string;
  game: string;
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

  // machine configs compose via helper calls (galaxian(config) -> galaxian_base(config));
  // walk the CALLS chain and collect devices from every config in it
  const devices: KGNode[] = [];
  /** set_addrmap patches in chain order (most-derived config first) */
  const mapPatches: { space: string; tag: string; mapId: string }[] = [];
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
      queue.push(...g.out(id, 'CALLS').map(c => c.node.id));
    }
  }
  const byTag = new Map(devices.map(d => [String(d.props.tag), d]));

  // --- cpus + address maps ----------------------------------------------------
  // Every CPU carries its own program map (and io map when the driver has
  // one). Device type -> runtime core is a device-library mapping.
  const CPU_TYPES: Record<string, string> = { Z80: 'z80', KONAMI1: 'konami1', I8039: 'i8039', I8080: 'i8080', M6803: 'm6803' };
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
  const screenDev = devices.find(d => d.props.type === 'SCREEN');
  const raw = screenDev?.props.screenRaw as number[] | undefined;
  if (!raw) throw new Error('screen raw params missing');
  const [pixclock, htotal, hbend, hbstart, vtotal, vbend, vbstart] = raw;

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
  const sound = devices.some(d => d.props.type === 'NAMCO_WSG' || d.props.type === 'NAMCO')
    ? { kind: 'wsg', clock: Number(byTag.get('namco')?.props.clock ?? 96000), waveRegion: 'namco' }
    : devices.some(d => d.props.type === 'GALAXIAN_SOUND')
      ? { kind: 'galaxian', clock: cpus[0].clock }
      : devices.some(d => d.props.type === 'INVADERS_AUDIO')
        ? { kind: 'invaders', clock: cpus[0].clock }
        : ayChips.length
          ? { kind: 'ay8910', clock: Number(ayChips[0].props.clock), chips: ayChips.length }
          : { kind: 'none' };

  // --- roms ----------------------------------------------------------------------
  const roms = g.out(romset.id, 'HAS_REGION').map(({ node: region }) => ({
    region: String(region.props.tag),
    size: Number(region.props.size),
    loads: g.out(region.id, 'LOADS').map(({ node: rom }) => ({
      file: String(rom.props.file),
      offset: Number(rom.props.offset),
      size: Number(rom.props.size),
      crc: String(rom.props.crc),
      ...(rom.props.reloadOffsets ? { reloadOffsets: rom.props.reloadOffsets as number[] } : {}),
    })),
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

  // --- emit ---------------------------------------------------------------------------
  const title = `${game.props.fullname} (${game.props.company}, ${game.props.year})`;
  // board family = driver file stem; selects the board module from the registry
  const family = basename(String(graph.meta.driverFile)).replace(/\.cpp$/, '');
  const config = {
    game: opts.game,
    title,
    family,
    board: { family, cpus, ranges, ...(io ? { io } : {}), ...(customs.length ? { customs } : {}), screen, clocks },
    sound,
    roms,
    bindings,
    dipDefaults,
    ports: portSpecs,
    romUrl: `../roms/${opts.game}.zip`, // resolved from the /app/ page; base-path agnostic
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
    driverFile: graph.meta.driverFile,
    ...(graph.meta.license ? { license: graph.meta.license } : {}),
    ...(graph.meta.copyrightHolders ? { copyrightHolders: graph.meta.copyrightHolders } : {}),
    ...(gitHistory ? { gitHistory } : {}),
    ...(hasHistory ? { hasHistory: true } : {}),
  }, null, 2));

  // the game itself is pure knowledge-graph data — the unified app at
  // out/app loads it at runtime (no per-game compile)
  writeFileSync(join(opts.outDir, 'config.json'), JSON.stringify(config, null, 2));

  // the full dossier: everything above as a standalone markdown document,
  // readable outside the app (out/<game>/README.md, linked from the modal)
  writeFileSync(join(opts.outDir, 'README.md'), gameMarkdown({
    game: opts.game, title, fullname: String(game.props.fullname),
    year: String(game.props.year), company: String(game.props.company),
    family, driverFile: String(graph.meta.driverFile),
    license: graph.meta.license as string | undefined,
    copyrightHolders: graph.meta.copyrightHolders as string | undefined,
    cpus, sound, screen, roms, bindings, dipDefaults, gitHistory, historyText,
  }));
  console.log(`\ngenerated ${join(opts.outDir, 'config.json')} (+ meta.json, README.md)`);
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
}): string {
  const hex = (n: number) => '0x' + n.toString(16);
  const prettyKey = (k: string) => k.replace(/^Key|^Arrow|^Digit/, '');
  const prettyIpt = (l: string) => l.replace(/^IPT_/, '').replace(/_/g, ' ').toLowerCase();
  const md: string[] = [];

  md.push(`# ${d.fullname}`);
  md.push('');
  md.push(`**${d.company} · ${d.year}** — transpiled from the MAME driver \`${d.driverFile}\` by mame2js.`);
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
  md.push(`*Generated by [mame2js](https://github.com/benbruscella/mame2js) from the knowledge graph of MAME driver \`${d.family}\`. Play it at [../app/?g=${d.game}](../app/?g=${d.game}) or [explore the knowledge graph](viewer.html).*`);
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
  const srcDir = join(appDir, 'src');
  mkdirSync(srcDir, { recursive: true });

  cpSync(join(projectRoot, 'src/runtime'), join(srcDir, 'runtime'), { recursive: true });

  writeFileSync(join(srcDir, 'main.ts'), `// GENERATED by mame2js — do not edit.
// Unified app: no ?g= -> boot menu; ?g=<game> -> load that game's generated
// config (pure knowledge-graph data) and run it.
import { runShell, type ShellConfig } from './runtime/shell.ts';
import { runMenu } from './runtime/menu.ts';

// force https on real domains: AudioWorklet (all sound) needs a secure
// context, and github's own enforcement only kicks in after cert issuance
if (location.protocol === 'http:' && !/^(localhost|127\\.|192\\.168\\.|10\\.)/.test(location.hostname)) {
  location.replace(location.href.replace(/^http:/, 'https:'));
}

const game = new URLSearchParams(location.search).get('g');
const fail = (err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    '<pre style="color:#f66;padding:12px">' + String((err as Error)?.stack ?? err) + '</pre>');
};
if (game) {
  fetch(\`../\${encodeURIComponent(game)}/config.json\`)
    .then(r => { if (!r.ok) throw new Error(\`no generated config for "\${game}" — run: mame2js \${game}\`); return r.json(); })
    .then(cfg => runShell(cfg as ShellConfig))
    .catch(fail);
} else {
  runMenu().catch(fail);
}
`);

  writeFileSync(join(appDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true,
      allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
      erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true,
      outDir: 'dist', rootDir: 'src',
    },
    include: ['src'],
    exclude: ['src/**/*.spec.ts'],
  }, null, 2));

  writeFileSync(join(appDir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mame2js</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>👾</text></svg>">
</head>
<body>
<script type="module" src="./dist/main.js"></script>
<noscript>mame2js needs JavaScript.</noscript>
</body>
</html>
`);

  // root convenience redirect: / -> app/ (relative — works under a Pages base path)
  writeFileSync(join(outRoot, 'index.html'),
    '<!doctype html><meta http-equiv="refresh" content="0;url=app/">');

  console.log('compiling unified app with tsc...');
  const tsc = spawnSync(process.execPath, [join(projectRoot, 'node_modules/typescript/bin/tsc'), '-p', appDir], {
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    console.error('tsc failed — app emitted but not compiled');
    return false;
  }
  console.log(`app ready: ${join(appDir, 'index.html')}`);
  return true;
}
