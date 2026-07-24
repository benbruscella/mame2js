import assert from 'node:assert/strict';
import { compileMameHandler } from '../mame/handler-ir.ts';
import { executeGeneratedProgram } from './generated-handler.ts';
import type { GeneratedMachine } from './generated-machine.ts';
import {
  createGeneratedTileInfoTarget,
  generatedScrollBand,
  generatedTileGroupTransparentMask,
  generatedTileMemoryIndex,
  GeneratedMameVideoPrimitives,
  GeneratedVideoRenderer,
  type GeneratedVideoPrimitives,
} from './generated-video.ts';

assert.deepEqual(
  Array.from({ length: 32 }, (_, row) => generatedScrollBand(row, 32, 4)),
  [
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2,
    3, 3, 3, 3, 3, 3, 3, 3,
  ],
);

const calls: string[] = [];
const primitives: GeneratedVideoPrimitives = {
  width: 2,
  height: 2,
  vblank: () => calls.push('vblank'),
  render: () => {
    throw new Error('handwritten composition must not run');
  },
  generatedVideoBindings: () => ({
    calls: {
      'm_bg_tilemap.draw': () => calls.push('background'),
      draw_sprites: () => calls.push('sprites'),
      'm_fg_tilemap.draw': () => calls.push('foreground'),
    },
    referenceCalls: {
      rectangle: () => ({ min_x: 0, max_x: 0, min_y: 0, max_y: 0 }),
    },
  }),
};
const body = `
  bitmap.fill(0xff010203, cliprect);
  rectangle band;
  band.min_x = 2;
  band.max_x = 2;
  band.min_y = 3;
  band.max_y = 3;
  bitmap.fill(0xff070809, band);
  bitmap.pix(2, 1) = 0xff040506;
  m_bg_tilemap->draw(screen, bitmap, cliprect, 0, 0);
  draw_sprites(bitmap, cliprect);
  m_fg_tilemap->draw(screen, bitmap, cliprect, 0, 0);
  return 0;
`;
const machine: GeneratedMachine = {
  schemaVersion: 2,
  game: 'fixture',
  family: 'fixture',
  driverFile: 'fixture.cpp',
  callbacks: [{
    id: 'callback:screen',
    ownerTag: 'screen',
    signal: 'set_screen_update',
    operation: 'set_screen_update',
    targetClass: 'fixture_state',
    targetMethod: 'screen_update',
  }],
  handlers: [{
    id: 'handler:screen',
    ownerClass: 'fixture_state',
    method: 'screen_update',
    body,
    program: compileMameHandler(body),
  }],
  execution: {
    cpus: [],
    screen: {
      width: 2,
      height: 2,
      xOffset: 1,
      yOffset: 2,
      refresh: 60,
      vtotal: 2,
      vbstart: 1,
      rotate: 0,
    },
    frameEvents: [],
    screenUpdate: { handler: 'fixture_state.screen_update' },
  },
};

const renderer = new GeneratedVideoRenderer(machine, primitives);
const frame = new Uint32Array(4);
renderer.vblank();
renderer.render(frame);
if (calls.join(',') !== 'vblank,background,sprites,foreground') {
  throw new Error(`generated composition order mismatch: ${calls.join(',')}`);
}
if (
  frame[0] !== 0xff040506 ||
  frame[1] !== 0xff010203 ||
  frame[2] !== 0xff010203 ||
  frame[3] !== 0xff070809
) {
  throw new Error(`generated visible-area translation is wrong: ${[...frame]}`);
}
const partialStarts: number[] = [];
const partialMachine: GeneratedMachine = {
  ...machine,
  callbacks: [{
    ...machine.callbacks[0]!,
    targetMethod: 'screen_update_partial',
  }],
  handlers: [{
    id: 'handler:screen_partial',
    ownerClass: 'fixture_state',
    method: 'screen_update_partial',
    program: compileMameHandler(`
      if (cliprect.min_y == screen.visible_area().min_y)
        frame_start();
      return 0;
    `),
  }],
  execution: {
    ...machine.execution,
    screen: { ...machine.execution.screen, updateMode: 'partial' },
    screenUpdate: { handler: 'fixture_state.screen_update_partial' },
  },
};
const partialRenderer = new GeneratedVideoRenderer(partialMachine, {
  width: 2,
  height: 2,
  vblank: () => {},
  render: () => {},
  generatedVideoBindings: () => ({
    calls: { frame_start: () => partialStarts.push(1) },
  }),
});
const partialFrame = new Uint32Array(4);
partialRenderer.updatePartial(partialFrame, 2);
partialRenderer.updatePartial(partialFrame, 3);
partialRenderer.render(partialFrame);
assert.equal(partialStarts.length, 1, 'partial clips must retain the full MAME visible area');
const cachedTile = { gfx: 0, code: 0, color: 0, flags: 0, category: 0, group: 0 };
const tileinfo = createGeneratedTileInfoTarget(cachedTile);
tileinfo.category = 1;
tileinfo.group = 7;
tileinfo.set(2, 3, 4, 5);
if (cachedTile.category !== 1) throw new Error('tile category did not reach the render cache');
if (cachedTile.group !== 7) throw new Error('tile group did not reach the render cache');
if (cachedTile.gfx !== 2 || cachedTile.code !== 3 || cachedTile.color !== 4 || cachedTile.flags !== 5) {
  throw new Error('tileinfo.set did not reach the render cache');
}
if (generatedTileMemoryIndex(1012) !== 1012) {
  throw new Error('custom mapper memory index was folded into the logical tile count');
}
const splitPlan = {
  member: 'm_bg_tilemap',
  tileWidth: 8,
  tileHeight: 8,
  columns: 1,
  rows: 1,
  mapper: 'TILEMAP_SCAN_ROWS',
  tileInfo: 'fixture_state.tile_info',
  transmasks: [
    { group: 0, foreground: 0, background: 0 },
    { group: 1, foreground: 0x0f, background: 0 },
  ],
};
assert.equal(generatedTileGroupTransparentMask(splitPlan, 1, 0), 0x0f);
assert.equal(generatedTileGroupTransparentMask(splitPlan, 1, 0x10), 0x0f);
assert.equal(generatedTileGroupTransparentMask(splitPlan, 1, 0x20), 0);
assert.equal(generatedTileGroupTransparentMask(splitPlan, 1, 0x30), 0x0f);
assert.equal(generatedTileGroupTransparentMask(splitPlan, 2, 0), undefined);
const screenState: Record<string, unknown> = {};
const videoRegion = Uint8Array.of(0x12, 0x34);
const generatedPrimitives = new GeneratedMameVideoPrimitives(
  machine,
  { gfx4: videoRegion },
  screenState,
  { calls: { 'm_screen.vpos': () => 37 } },
);
const romRead = compileMameHandler(`
  uint8_t *rom = memregion("gfx4")->base();
  return rom[1];
`);
const romReadResult = executeGeneratedProgram(
  romRead,
  generatedPrimitives.generatedVideoBindings(new Uint32Array(4)),
);
if (romReadResult.value !== 0x34) {
  throw new Error(`generated memregion binding returned ${String(romReadResult.value)}`);
}
const generatedScreen = screenState.m_screen as {
  __frame: number;
  frame_number(): number;
  vpos(): number;
  update_partial(line: number): void;
};
if (generatedScreen.vpos() !== 37) {
  throw new Error('generated screen shadowed the board scanline binding');
}
generatedScreen.update_partial(37);
let partialLine = -1;
const partialPrimitives = new GeneratedMameVideoPrimitives(
  machine,
  {},
  {},
  {},
  line => { partialLine = line; },
);
executeGeneratedProgram(
  compileMameHandler('m_screen->update_partial(19);'),
  partialPrimitives.generatedVideoBindings(new Uint32Array(4)),
);
assert.equal(partialLine, 19, 'generated screen must forward partial raster updates');
generatedPrimitives.vblank();
if (generatedScreen.frame_number() !== 1) {
  throw new Error('generated screen frame counter did not advance at vblank');
}

const tileMachine: GeneratedMachine = {
  ...machine,
  handlers: [
    ...machine.handlers!,
    {
      id: 'handler:tile_info',
      ownerClass: 'fixture_state',
      method: 'tile_info',
      program: compileMameHandler('tileinfo.set(0, 0, 0, 0);'),
    },
  ],
  video: {
    initialState: {},
    gfx: [],
    tilemaps: [{
      member: 'm_bg_tilemap',
      tileWidth: 8,
      tileHeight: 8,
      columns: 1,
      rows: 1,
      mapper: 'TILEMAP_SCAN_ROWS',
      tileInfo: 'fixture_state.tile_info',
    }],
  },
};
const tileState: Record<string, unknown> = {};
const tilePrimitives = new GeneratedMameVideoPrimitives(tileMachine, {}, tileState, {});
const tilemap = tileState.m_bg_tilemap as {
  tiles: unknown[];
  dirty: number[];
};
tilemap.tiles.push(cachedTile);
tilemap.dirty.push(0);
executeGeneratedProgram(
  compileMameHandler('m_bg_tilemap->mark_all_dirty();'),
  tilePrimitives.generatedVideoBindings(new Uint32Array(4)),
);
if (tilemap.tiles.length !== 0 || tilemap.dirty.length !== 0) {
  throw new Error('mark_all_dirty did not invalidate generated tile cache');
}

console.log('generated-video.spec: 19 passed');
