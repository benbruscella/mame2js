// Phase 2: knowledge-graph subgraph -> generated browser app.
// Emits out/<game>/app/{index.html, src/config.ts, src/main.ts, runtime copy,
// tsconfig.json} and compiles it with tsc. Everything game-specific comes from
// the graph; everything behavioral comes from the shared runtime.

import { mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
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
  {
    const seen = new Set<string>();
    const queue = [machine.id];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      devices.push(...g.out(id, 'HAS_DEVICE').map(d => d.node));
      queue.push(...g.out(id, 'CALLS').map(c => c.node.id));
    }
  }
  const byTag = new Map(devices.map(d => [String(d.props.tag), d]));

  // --- cpus + address map ----------------------------------------------------
  const cpuDevs = devices.filter(d => d.props.type === 'Z80');
  if (cpuDevs.length === 0) throw new Error('no Z80 devices found in machine config');
  const cpus = cpuDevs.map(d => ({
    tag: String(d.props.tag),
    clock: Number(d.props.clock),
    region: String(d.props.tag), // rom region tag == cpu tag across supported families
  }));

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

  const cpuDevNode = cpuDevs[0];
  const mapRefs = g.out(cpuDevNode.id, 'HAS_MAP');
  const programMap = mapRefs.find(m => (m.edge.props?.space ?? 'AS_PROGRAM') === 'AS_PROGRAM');
  if (!programMap) throw new Error(`no address map on ${cpus[0].tag}`);
  const ranges = collectRanges(programMap.node.id).map(rangeSpec);

  // io space (AS_IO): pacman writes its IM2 vector through an out port
  const ioMapRef = mapRefs.find(m => m.edge.props?.space === 'AS_IO');
  let io: Record<string, unknown> | undefined;
  if (ioMapRef) {
    io = { ranges: collectRanges(ioMapRef.node.id).map(rangeSpec) };
    if (ioMapRef.node.props.globalMask !== undefined) io.globalMask = Number(ioMapRef.node.props.globalMask);
  }

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
  const sound = devices.some(d => d.props.type === 'NAMCO_WSG' || d.props.type === 'NAMCO')
    ? { kind: 'wsg', clock: Number(byTag.get('namco')?.props.clock ?? 96000), waveRegion: 'namco' }
    : devices.some(d => d.props.type === 'GALAXIAN_SOUND')
      ? { kind: 'galaxian', clock: cpus[0].clock }
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
  const ports = g.out(inputs.id, 'HAS_PORT').map(p => p.node);
  const portSpecs: { tag: string; init: number }[] = [];
  const bindings: unknown[] = [];
  const dipDefaults: unknown[] = [];
  for (const port of ports) {
    const tag = String(port.props.tag);
    let init = 0;
    for (const { node: f } of g.out(port.id, 'HAS_FIELD')) {
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
        if (mods.includes('PORT_COCKTAIL')) continue; // player-2 cocktail path: unbound
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
    board: { family, cpus, ranges, ...(io ? { io } : {}), screen, clocks },
    sound,
    roms,
    bindings,
    dipDefaults,
    ports: portSpecs,
    romUrl: `/roms/${opts.game}.zip`,
    runtimeUrl: './dist/runtime/',
    menuUrl: './',
  };

  // per-game metadata for the boot menu manifest
  writeFileSync(join(opts.outDir, 'meta.json'), JSON.stringify({
    game: opts.game,
    title,
    fullname: game.props.fullname,
    year: game.props.year,
    manufacturer: game.props.company,
    family,
  }, null, 2));

  // the game itself is pure knowledge-graph data — the unified app at
  // out/app loads it at runtime (no per-game compile)
  writeFileSync(join(opts.outDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`\ngenerated ${join(opts.outDir, 'config.json')}`);
  if (!existsSync(join(projectRoot, 'roms', `${opts.game}.zip`))) {
    console.log(`note: put ${opts.game}.zip in ${join(projectRoot, 'roms')}/ to auto-load ROMs (or drop the zip onto the page)`);
  }
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

const game = new URLSearchParams(location.search).get('g');
const fail = (err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    '<pre style="color:#f66;padding:12px">' + String((err as Error)?.stack ?? err) + '</pre>');
};
if (game) {
  fetch(\`/\${encodeURIComponent(game)}/config.json\`)
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

  // root convenience redirect: / -> /app/
  writeFileSync(join(outRoot, 'index.html'),
    '<!doctype html><meta http-equiv="refresh" content="0;url=/app/">');

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
