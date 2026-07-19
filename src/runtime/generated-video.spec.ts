import { compileMameHandler } from '../mame/handler-ir.ts';
import type { GeneratedMachine } from './generated-machine.ts';
import { GeneratedVideoRenderer, type GeneratedVideoPrimitives } from './generated-video.ts';

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
    screen: { width: 2, height: 2, refresh: 60, vtotal: 2, vbstart: 1, rotate: 0 },
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
if (!frame.every(pixel => pixel === 0xff010203)) {
  throw new Error(`generated bitmap.fill did not populate framebuffer: ${[...frame]}`);
}
console.log('generated-video.spec: 2 passed');
