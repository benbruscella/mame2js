import { compileMameHandler } from '../mame/handler-ir.ts';
import type { GeneratedMachine } from './generated-machine.ts';
import {
  createGeneratedTileInfoTarget,
  generatedTileMemoryIndex,
  GeneratedMameVideoPrimitives,
  GeneratedVideoRenderer,
  type GeneratedVideoPrimitives,
} from './generated-video.ts';

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
  }),
};
const body = `
  bitmap.fill(0xff010203, cliprect);
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
if (frame[0] !== 0xff040506 || !frame.slice(1).every(pixel => pixel === 0xff010203)) {
  throw new Error(`generated visible-area translation is wrong: ${[...frame]}`);
}
const cachedTile = { gfx: 0, code: 0, color: 0, flags: 0, category: 0 };
const tileinfo = createGeneratedTileInfoTarget(cachedTile);
tileinfo.category = 1;
tileinfo.set(2, 3, 4, 5);
if (cachedTile.category !== 1) throw new Error('tile category did not reach the render cache');
if (cachedTile.gfx !== 2 || cachedTile.code !== 3 || cachedTile.color !== 4 || cachedTile.flags !== 5) {
  throw new Error('tileinfo.set did not reach the render cache');
}
if (generatedTileMemoryIndex(1012) !== 1012) {
  throw new Error('custom mapper memory index was folded into the logical tile count');
}
const screenState: Record<string, unknown> = {};
const generatedPrimitives = new GeneratedMameVideoPrimitives(
  machine,
  {},
  screenState,
  { calls: { 'm_screen.vpos': () => 37 } },
);
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
generatedPrimitives.vblank();
if (generatedScreen.frame_number() !== 1) {
  throw new Error('generated screen frame counter did not advance at vblank');
}
console.log('generated-video.spec: 8 passed');
