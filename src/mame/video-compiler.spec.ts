import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildGraph, gameSubgraph } from '../kg/build.ts';
import { compileMameVideo } from './video-compiler.ts';

const mameSrc = resolve('../mame');
const driver = resolve(mameSrc, 'src/mame/pacman/pacman.cpp');
const full = buildGraph(mameSrc, driver);
const graph = gameSubgraph(full, 'pacman');
const machine = graph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === 'pacman_state' &&
  node.props.name === 'pacman');

assert.equal(graph.meta.driverFile, 'src/mame/pacman/pacman.cpp');
assert.ok(graph.nodes.some(node => node.id === 'game:pacman'));
assert.ok(machine, 'Pac-Man machine config must be reachable from the game');
assert.ok(graph.nodes.some(node =>
  node.label === 'Device' && node.props.type === 'Z80' && node.props.tag === 'maincpu'));
assert.ok(graph.nodes.some(node =>
  node.label === 'Device' && node.props.type === 'NAMCO_WSG' && node.props.tag === 'namco'));
assert.ok(graph.nodes.some(node =>
  node.label === 'AddressRange' &&
  node.props.share === 'videoram' &&
  String(node.props.raw).includes('pacman_videoram_w')));
assert.ok(graph.nodes.some(node =>
  node.label === 'Callback' &&
  node.props.signal === 'set_screen_update' &&
  node.props.targetMethod === 'screen_update_pacman'));
assert.ok(graph.nodes.some(node =>
  node.label === 'SourceFile' &&
  node.props.path === 'src/mame/pacman/pacman_v.cpp'));

const reachable = new Set(['game:pacman']);
for (let changed = true; changed;) {
  changed = false;
  for (const edge of graph.edges) {
    if (!reachable.has(edge.from) || reachable.has(edge.to)) continue;
    reachable.add(edge.to);
    changed = true;
  }
}
assert.deepEqual(
  graph.nodes.filter(node => !reachable.has(node.id)).map(node => node.id),
  [],
  'the game subgraph must contain only source-reachable nodes',
);

const compiled = compileMameVideo(graph, mameSrc, machine!.id);
assert.ok(compiled, 'Pac-Man MAME video source must lower to executable video IR');
assert.equal(compiled.plan.gfx.length, 2);
assert.equal(compiled.plan.tilemaps.length, 1);
assert.deepEqual(
  {
    member: compiled.plan.tilemaps[0]?.member,
    tileWidth: compiled.plan.tilemaps[0]?.tileWidth,
    tileHeight: compiled.plan.tilemaps[0]?.tileHeight,
    columns: compiled.plan.tilemaps[0]?.columns,
    rows: compiled.plan.tilemaps[0]?.rows,
  },
  {
    member: 'm_bg_tilemap',
    tileWidth: 8,
    tileHeight: 8,
    columns: 36,
    rows: 28,
  },
);
assert.equal(compiled.plan.palette.region, 'proms');
assert.equal(compiled.plan.palette.colorCount, 32);
assert.equal(compiled.plan.palette.lookupCount, 256);
assert.equal(compiled.plan.source?.file, 'src/mame/pacman/pacman_v.cpp');
assert.ok(compiled.handlers.length >= 3);
assert.ok(compiled.handlers.every(handler =>
  handler.source?.file.startsWith('src/mame/pacman/') &&
  handler.source.line > 0 &&
  handler.program?.diagnostics.length === 0));

const pooyanDriver = resolve(mameSrc, 'src/mame/konami/pooyan.cpp');
const pooyanFull = buildGraph(mameSrc, pooyanDriver);
const pooyanGraph = gameSubgraph(pooyanFull, 'pooyan');
const pooyanMachine = pooyanGraph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === 'pooyan_state' &&
  node.props.name === 'pooyan');
assert.ok(pooyanMachine);
const pooyan = compileMameVideo(pooyanGraph, mameSrc, pooyanMachine.id);
assert.ok(pooyan, 'modern MAME video_start must lower to executable video IR');
assert.equal(pooyan.plan.tilemaps[0]?.mapper, 'TILEMAP_SCAN_ROWS');
assert.deepEqual(pooyan.plan.palette.banks, [
  { penOffset: 0, colorOr: 0x10, lookupOffset: 0x20, lookupCount: 0x100 },
  { penOffset: 0x100, colorOr: 0, lookupOffset: 0x120, lookupCount: 0x100 },
]);
assert.deepEqual(
  pooyan.plan.palette.channels.map(channel => channel.resistances),
  [[1000, 470, 220], [1000, 470, 220], [470, 220]],
);
assert.ok(pooyan.handlers.some(handler =>
  handler.method === 'draw_sprites' && handler.program?.diagnostics.length === 0));

const timepltDriver = resolve(mameSrc, 'src/mame/konami/timeplt.cpp');
const timepltFull = buildGraph(mameSrc, timepltDriver);
const timepltGraph = gameSubgraph(timepltFull, 'timeplt');
const timepltMachine = timepltGraph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === 'timeplt_state' &&
  node.props.name === 'timeplt');
assert.ok(timepltMachine);
const timeplt = compileMameVideo(timepltGraph, mameSrc, timepltMachine.id);
assert.ok(timeplt, 'explicit weighted PROM palettes must lower to video IR');
assert.deepEqual(timeplt.plan.palette.channels[0], {
  channel: 'r',
  bits: [1, 2, 3, 4, 5],
  offsets: [32, 32, 32, 32, 32],
  weights: [0x19, 0x24, 0x35, 0x40, 0x4d],
});
assert.deepEqual(timeplt.plan.palette.banks, [
  { penOffset: 0x80, colorOr: 0, lookupOffset: 0x40, lookupCount: 0x100 },
  { penOffset: 0, colorOr: 0x10, lookupOffset: 0x140, lookupCount: 0x80 },
]);
assert.ok(timeplt.handlers.some(handler =>
  handler.method === 'draw_sprites' && handler.program?.diagnostics.length === 0));

const junoDriver = resolve(mameSrc, 'src/mame/konami/junofrst.cpp');
const junoFull = buildGraph(mameSrc, junoDriver);
const junoGraph = gameSubgraph(junoFull, 'junofrst');
const junoMachine = junoGraph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === 'junofrst_state' &&
  node.props.name === 'junofrst');
assert.ok(junoMachine);
const juno = compileMameVideo(junoGraph, mameSrc, junoMachine.id);
assert.ok(juno, 'packed bitmap source must lower to executable video IR');
assert.deepEqual(
  junoGraph.nodes.find(node => node.label === 'MemoryBank')?.props,
  {
    tag: 'mainbank',
    member: 'm_mainbank',
    firstEntry: 0,
    entries: 16,
    region: 'maincpu',
    offset: 0x10000,
    stride: 0x1000,
    sourceFile: 'src/mame/konami/junofrst.cpp',
    sourceLine: 349,
    sourceColumn: 1,
    sourceEndLine: 362,
  },
);
assert.deepEqual(juno.plan.bitmap, {
  share: 'videoram',
  paletteShare: 'palette',
  bytesPerRow: 128,
  logicalWidth: 256,
  logicalHeight: 256,
  xscale: 3,
  pixelsPerByte: 2,
  bitsPerPixel: 4,
  lowPixelFirst: true,
  flipXMember: 'm_flipscreen_x',
  flipYMember: 'm_flipscreen_y',
  scrollMember: 'm_scroll',
  scrollColumns: 192,
  source: {
    file: 'src/mame/konami/tutankhm_v.cpp',
    line: 97,
    column: 1,
  },
});
assert.equal(juno.plan.palette.kind, 'ram');
assert.equal(juno.plan.palette.share, 'palette');
assert.equal(juno.plan.palette.max, 224);
assert.deepEqual(
  juno.plan.palette.channels.map(channel => channel.resistances),
  [[1000, 470, 220], [1000, 470, 220], [470, 220]],
);

const invadersDriver = resolve(mameSrc, 'src/mame/midw8080/mw8080bw.cpp');
const invadersFull = buildGraph(mameSrc, invadersDriver);
const invadersGraph = gameSubgraph(invadersFull, 'invaders');
const invadersMachine = invadersGraph.nodes.find(node =>
  node.label === 'MachineConfig' &&
  node.props.cls === 'mw8080bw_state' &&
  node.props.name === 'mw8080bw_root');
assert.ok(invadersMachine);
const invaders = compileMameVideo(invadersGraph, mameSrc, invadersMachine.id);
assert.ok(invaders, 'MAME shifted one-bit RAM scanout must lower to executable video IR');
assert.deepEqual(invaders.plan.bitmap, {
  share: 'main_ram',
  bytesPerRow: 32,
  logicalWidth: 260,
  logicalHeight: 224,
  xscale: 1,
  pixelsPerByte: 8,
  bitsPerPixel: 1,
  lowPixelFirst: true,
  dataXOffset: 4,
  dataYOffset: 32,
  source: {
    file: 'src/mame/midw8080/mw8080bw_v.cpp',
    line: 14,
    column: 1,
  },
});
assert.equal(invaders.plan.palette.kind, 'fixed');
assert.deepEqual(invaders.plan.palette.colors, [0xff000000, 0xffffffff]);

console.log('video-compiler.spec: 42 passed');
