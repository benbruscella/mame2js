import assert from 'node:assert/strict';
import { compileMameHandler } from '../mame/handler-ir.ts';
import {
  executeGeneratedHandler,
  generatedHandlerRegistry,
  wireGeneratedDevice,
} from './generated-handler.ts';
import type { GeneratedMachine } from './generated-machine.ts';

const shares = { m_videoram: new Uint8Array(8) };
const program = compileMameHandler(`
  m_videoram[offset] = data;
  m_bg_tilemap->mark_tile_dirty(offset);
`);
executeGeneratedHandler(program, { members: shares }, { offset: 3, data: 0xa5 });
assert.equal(shares.m_videoram[3], 0xa5);

const dsw = compileMameHandler(`
  int bit0, bit1;
  bit0 = (ioport("DSWB")->read() >> offset) & 1;
  bit1 = (ioport("DSWA")->read() >> offset) & 1;
  return bit0 | (bit1 << 1);
`);
assert.equal(executeGeneratedHandler(dsw, {
  inputs: { read: tag => tag === 'DSWA' ? 0b10 : 0b01 },
}, { offset: 0 }), 1);
assert.equal(executeGeneratedHandler(dsw, {
  inputs: { read: tag => tag === 'DSWA' ? 0b10 : 0b01 },
}, { offset: 1 }), 2);

let bank = -1;
const bankProgram = compileMameHandler(`
  if (data == 4) m_mainbank->set_entry(4);
  else m_mainbank->set_entry(data & 0x03);
`);
executeGeneratedHandler(bankProgram, {
  calls: { 'm_mainbank.set_entry': value => { bank = value; } },
}, { data: 7 });
assert.equal(bank, 3);

let enabled = 0;
executeGeneratedHandler(compileMameHandler('m_irq_enabled = data & 1;'), {
  setters: { m_irq_enabled: value => { enabled = value; } },
}, { data: 3 });
assert.equal(enabled, 1);

const values = new Uint8Array(4);
executeGeneratedHandler(compileMameHandler(`
  for (int i = 0; i < 4; i++)
    m_values[i] = i + 1;
`), { members: { m_values: values } });
assert.deepEqual([...values], [1, 2, 3, 4]);

const pixels: number[] = [];
const bitmapProgram = compileMameHandler(`
  uint8_t x = 0xfe;
  while (1) {
    x = x + 1;
    bitmap.pix(0, x) = x;
    if (x == 0) break;
  }
  return ((offs_t)x << 5) | 1;
`);
assert.equal(executeGeneratedHandler(bitmapProgram, {
  calls: { 'bitmap.pix=': (_y, _x, value) => { pixels.push(value); } },
}), 1);
assert.deepEqual(pixels, [0xff, 0]);

const machine: GeneratedMachine = {
  schemaVersion: 2,
  game: 'fixture',
  family: 'fixture',
  driverFile: 'fixture.cpp',
  execution: {
    cpus: [],
    screen: { width: 1, height: 1, refresh: 60, vtotal: 1, vbstart: 0, rotate: 0 },
    frameEvents: [],
  },
  callbacks: [],
  handlers: [{
    id: 'handler:fixture_state:read',
    ownerClass: 'fixture_state',
    method: 'read',
    program: compileMameHandler('return 0xbf;'),
  }],
  maps: [{
    id: 'map',
    className: 'fixture_state',
    name: 'main',
    ranges: [{
      id: 'range',
      start: 0,
      end: 0,
      raw: '',
      read: 'fixture_state.read',
      props: {},
    }],
  }],
};
const registry = generatedHandlerRegistry(machine);
assert.equal(registry.read['fixture_state.read']!(0, 0), 0xbf);

let irqMask = 0;
let q0: ((state: number) => void) | undefined;
const device = {
  on: (_signal: string, callback: (state: number) => void, slot = 0) => {
    if (slot === 0) q0 = callback;
  },
};
wireGeneratedDevice(device, {
  ...machine,
  callbacks: [{
    id: 'callback:latch:0',
    ownerTag: 'latch',
    signal: 'q_out_cb',
    slot: 0,
    operation: 'set',
    targetClass: 'fixture_state',
    targetMethod: 'irq_w',
  }],
  handlers: [{
    id: 'handler:fixture_state:irq_w',
    ownerClass: 'fixture_state',
    method: 'irq_w',
    program: compileMameHandler('m_irq_mask = state;'),
  }],
}, 'latch', 'q_out_cb', {
  setters: { m_irq_mask: value => { irqMask = value; } },
});
q0?.(1);
assert.equal(irqMask, 1);

console.log('generated-handler.spec: 10 passed');
