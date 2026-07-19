// mamekit CLI
//   mamekit <game>            full pipeline: graph -> generate -> build web app
//   mamekit graph <game>      knowledge graph only (graph.json + graph.cypher)
//   mamekit from-graph <game> rebuild from a graph snapshot (no MAME required)
// options:
//   --mame-src <path>   MAME source root (default: auto-detect / $MAME_SRC)
//   --out <dir>         output root (default: <mamekit>/out)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, gameSubgraph } from './kg/build.ts';
import { toCypher } from './kg/cypher.ts';
import { viewerHtml } from './kg/viewer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

function usage(): never {
  console.error('usage: mamekit [graph|from-graph] <game> [--mame-src <path>] [--out <dir>] [--serve [port]]');
  console.error('       mamekit <game> --from-graph [graph.json]');
  console.error('       mamekit --build-runtime [--build-app]');
  console.error('       mamekit --serve            serve the unified app + all generated games');
  process.exit(2);
}

const argv = process.argv.slice(2);
const positional: string[] = [];
const opts: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) {
    positional.push(a);
    continue;
  }
  const key = a.slice(2);
  const next = argv[i + 1];
  if (key === 'serve') {
    opts[key] = next && /^\d+$/.test(next) ? argv[++i] : 'true';
  } else if (key === 'from-graph') {
    opts[key] = next && next.endsWith('.json') ? argv[++i] : 'true';
  } else if (key === 'skip-app' || key === 'build-app' || key === 'build-runtime') {
    opts[key] = 'true';
  } else {
    opts[key] = next && !next.startsWith('--') ? argv[++i] : '';
  }
}

const command = positional[0] === 'graph'
  ? 'graph'
  : positional[0] === 'from-graph' || 'from-graph' in opts
    ? 'from-graph'
    : 'run';
const game = positional[0] === 'graph' || positional[0] === 'from-graph'
  ? positional[1]
  : positional[0];
const serveOnly = !game && ('serve' in opts || argv.includes('--serve'));
const buildAppOnly = !game && 'build-app' in opts;
const buildRuntimeOnly = !game && 'build-runtime' in opts;
if (!game && !serveOnly && !buildAppOnly && !buildRuntimeOnly) usage();

const outRoot = resolve(opts.out ?? join(projectRoot, 'dist'));
const explicitMameSrc = opts['mame-src'] ?? process.env.MAME_SRC;
const detectedMameSrc = serveOnly ? '' : detectMameSrc(command !== 'from-graph');
const mameSrc = serveOnly
  ? ''
  : explicitMameSrc
    ? resolve(explicitMameSrc)
    : detectedMameSrc;

function detectMameSrc(required: boolean): string {
  // mamekit conventionally lives inside or next to a mame checkout
  const candidates = [
    resolve(projectRoot, '..'),         // mamekit inside the mame repo
    resolve(projectRoot, '../mame'),    // mamekit as a sibling of the mame repo
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'src/mame'))) return candidate;
  }
  if (!required) return '';
  console.error('error: cannot find MAME source tree; pass --mame-src or set $MAME_SRC');
  process.exit(1);
}

/** Locate the driver .cpp that defines GAME/CONS/SYST/COMP(..., <game>, ...) — cached. */
function findDriverFile(game: string): string {
  const cacheFile = join(outRoot, '.driver-cache.json');
  let cache: Record<string, string> = {};
  if (existsSync(cacheFile)) {
    try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* rebuild */ }
  }
  if (cache[game] && existsSync(join(mameSrc, cache[game]))) return join(mameSrc, cache[game]);

  // rows may carry a leading /* NNN */ index comment (mw8080bw.cpp style);
  // console/system rows use CONS/SYST/COMP and may have "19??" years
  const gameRe = new RegExp(`^\\s*(?:/\\*[^*]*\\*/\\s*)?(?:GAME[XL]?|CONS|SYST|COMP)\\(\\s*[\\d?]{4},\\s*${game}\\s*,`, 'm');
  const root = join(mameSrc, 'src/mame');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith('.cpp')) {
        const text = readFileSync(full, 'utf8');
        if (gameRe.test(text)) {
          cache[game] = full.slice(mameSrc.length + 1);
          mkdirSync(outRoot, { recursive: true });
          writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
          return full;
        }
      }
    }
  }
  console.error(`error: no driver in ${root} defines game "${game}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

if (buildAppOnly || buildRuntimeOnly) {
  const { REQUIRED_TARGETS } = await import('./gen/targets.ts');
  const { buildHardwareClosure, emitHardwareClosure } = await import('./mame/hardware.ts');
  const targetGraphs = REQUIRED_TARGETS.map(target => {
    const graphPath = join(outRoot, target, 'graph.json');
    if (!existsSync(graphPath)) {
      throw new Error(`cannot build runtime hardware closure: missing ${graphPath}`);
    }
    return {
      game: target,
      graph: JSON.parse(readFileSync(graphPath, 'utf8')),
    };
  });
  console.log(`mamekit: resolving MAME hardware used by ${targetGraphs.length} targets`);
  const closure = buildHardwareClosure(mameSrc, targetGraphs);
  emitHardwareClosure(closure, outRoot);
  const { refreshRuntimeReports } = await import('./gen/runtime-report.ts');
  const refreshedReports = refreshRuntimeReports(outRoot);
  console.log(
    `generated hardware closure: ${closure.summary.sourceResolved}/${closure.summary.types} ` +
    `types source-resolved, ${closure.summary.unresolved} unresolved; ` +
    `${refreshedReports} generation reports refreshed`,
  );
  if (!buildAppOnly) process.exit(0);
  const { buildApp } = await import('./gen/generate.ts');
  if (!buildApp(outRoot)) {
    process.exitCode = 1;
  } else {
    const { gamesManifest } = await import('./serve.ts');
    writeFileSync(join(outRoot, 'games.json'),
      await gamesManifest(outRoot, join(projectRoot, 'artwork')));
  }
} else if (serveOnly) {
  const { buildApp } = await import('./gen/generate.ts');
  buildApp(outRoot);
  const { serve } = await import('./serve.ts');
  const port = await serve(
    { '': outRoot, artwork: join(projectRoot, 'artwork') }, // ROMs are never served
    Number(opts.serve) || 8280,
  );
  console.log(`\nserving http://localhost:${port}/app/  (menu; games at /app/g/<game>/)`);
} else if (command === 'from-graph') {
  await pipelineFromGraph(game!);
} else {
  await pipeline(game!);
}

async function pipeline(game: string): Promise<void> {
console.log(`mamekit: searching MAME source at ${mameSrc}`);
const driverFile = findDriverFile(game);
console.log(`mamekit: driver for "${game}" -> ${driverFile.slice(mameSrc.length + 1)}`);

const graph = buildGraph(mameSrc, driverFile);
const sub = gameSubgraph(graph, game);
if (!sub.nodes.some(n => n.id === `game:${game}`)) {
  console.error(`error: game "${game}" not found in parsed graph (parser gap?)`);
  process.exit(1);
}

const outDir = join(outRoot, game);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'graph.full.json'), JSON.stringify(graph, null, 2));
writeFileSync(join(outDir, 'graph.json'), JSON.stringify(sub, null, 2));
writeFileSync(join(outDir, 'graph.cypher'), toCypher(sub));
writeFileSync(join(outDir, 'viewer.html'), viewerHtml(sub, `${game} — knowledge graph`));
writeFileSync(join(outDir, 'viewer.full.html'), viewerHtml(graph, `${basename(driverFile)} driver — knowledge graph`));

const counts = new Map<string, number>();
for (const n of sub.nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
console.log(`\nknowledge graph for "${game}": ${sub.nodes.length} nodes, ${sub.edges.length} edges`);
for (const [label, count] of [...counts.entries()].sort()) {
  console.log(`  ${label.padEnd(16)} ${count}`);
}
console.log(`\nwrote ${join(outDir, 'graph.json')} (+ graph.full.json, graph.cypher)`);

// quick human-readable digest of the essentials
const devices = sub.nodes.filter(n => n.label === 'Device');
if (devices.length) {
  console.log('\ndevices:');
  for (const d of devices) {
    const clock = typeof d.props.clock === 'number' ? ` @ ${(d.props.clock / 1e6).toFixed(3)} MHz` : '';
    console.log(`  ${String(d.props.type).padEnd(16)} "${d.props.tag}"${clock}`);
  }
}
const regions = sub.nodes.filter(n => n.label === 'RomRegion' && n.id.startsWith(`region:${game}/`));
if (regions.length) {
  console.log('\nrom regions:');
  for (const r of regions) {
    console.log(`  ${String(r.props.tag).padEnd(10)} 0x${Number(r.props.size).toString(16)}`);
  }
}

if (command === 'run') {
  const { generate, buildApp } = await import('./gen/generate.ts');
  await generate(sub, { mameSrc, outDir, game, fullGraph: graph });
  if (!('skip-app' in opts) && !buildApp(outRoot)) process.exitCode = 1;
  // static manifest so the built tree is servable as plain files (github
  // pages); the dev server's live /games.json route shadows it locally
  const { gamesManifest } = await import('./serve.ts');
  writeFileSync(join(outRoot, 'games.json'),
    await gamesManifest(outRoot, join(projectRoot, 'artwork')));
}

if ('serve' in opts || argv.includes('--serve')) {
  const { serve } = await import('./serve.ts');
  const port = await serve(
    { '': outRoot, artwork: join(projectRoot, 'artwork') }, // ROMs are never served
    Number(opts.serve) || 8280,
  );
  console.log(`\nserving http://localhost:${port}/app/  (game: /app/g/${game}/, viewer: /${game}/viewer.html)`);
}
}

async function pipelineFromGraph(game: string): Promise<void> {
  const graphPath = resolve(
    opts['from-graph'] && opts['from-graph'] !== 'true'
      ? opts['from-graph']
      : join(outRoot, game, 'graph.json'),
  );
  if (!existsSync(graphPath)) {
    console.error(`error: graph snapshot not found: ${graphPath}`);
    process.exit(1);
  }

  const loaded = JSON.parse(readFileSync(graphPath, 'utf8'));
  const sub = gameSubgraph(loaded, game);
  if (!sub.nodes.some(n => n.id === `game:${game}`)) {
    console.error(`error: graph snapshot does not contain game "${game}"`);
    process.exit(1);
  }

  const fullPath = join(dirname(graphPath), 'graph.full.json');
  const fullGraph = existsSync(fullPath)
    ? JSON.parse(readFileSync(fullPath, 'utf8'))
    : loaded;
  const outDir = join(outRoot, game);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'graph.json'), JSON.stringify(sub, null, 2));
  writeFileSync(join(outDir, 'graph.cypher'), toCypher(sub));
  writeFileSync(join(outDir, 'viewer.html'), viewerHtml(sub, `${game} — knowledge graph`));

  console.log(`mamekit: rebuilding "${game}" from ${graphPath}`);
  console.log(`knowledge graph: ${sub.nodes.length} nodes, ${sub.edges.length} edges`);

  const { generate, buildApp } = await import('./gen/generate.ts');
  await generate(sub, { mameSrc, outDir, game, fullGraph });
  if (!('skip-app' in opts) && !buildApp(outRoot)) process.exitCode = 1;
  const { gamesManifest } = await import('./serve.ts');
  writeFileSync(join(outRoot, 'games.json'),
    await gamesManifest(outRoot, join(projectRoot, 'artwork')));

  if ('serve' in opts) {
    const { serve } = await import('./serve.ts');
    const port = await serve(
      { '': outRoot, artwork: join(projectRoot, 'artwork') },
      Number(opts.serve) || 8280,
    );
    console.log(`\nserving http://localhost:${port}/app/`);
  }
}
