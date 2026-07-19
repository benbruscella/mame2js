import assert from 'node:assert/strict';
import { compileMameHandler } from './handler-ir.ts';

const pacmanVideo = compileMameHandler(`
  m_videoram[offset] = data;
  m_bg_tilemap->mark_tile_dirty(offset);
`);
assert.deepEqual(pacmanVideo.diagnostics, []);
assert.equal(pacmanVideo.operations.length, 2);
assert.equal(pacmanVideo.operations[0]?.op, 'assign');
assert.equal(pacmanVideo.operations[1]?.op, 'call');

const pacmanIrq = compileMameHandler(`
  m_irq_mask = state;
  if (!state)
    m_maincpu->set_input_line(INPUT_LINE_IRQ0, CLEAR_LINE);
`);
assert.deepEqual(pacmanIrq.diagnostics, []);
assert.equal(pacmanIrq.operations[1]?.op, 'if');

const galagaDsw = compileMameHandler(`
  int bit0,bit1;
  bit0 = (ioport("DSWB")->read() >> offset) & 1;
  bit1 = (ioport("DSWA")->read() >> offset) & 1;
  return bit0 | (bit1 << 1);
`);
assert.deepEqual(galagaDsw.diagnostics, []);
assert.equal(galagaDsw.operations.length, 5);
assert.equal(galagaDsw.operations.at(-1)?.op, 'return');

const gngBank = compileMameHandler(`
  if (data == 4)
    m_mainbank->set_entry(4);
  else
    m_mainbank->set_entry(data & 0x03);
`);
assert.deepEqual(gngBank.diagnostics, []);
assert.equal(gngBank.operations[0]?.op, 'if');

const unsupported = compileMameHandler('for (int i = 0; i < 3; i++) m_values[i] = data;');
assert.deepEqual(unsupported.diagnostics, []);
assert.equal(unsupported.operations[0]?.op, 'for');

const compoundFor = compileMameHandler(`
  for (offset >>= 1; offset < 0x400; offset += 32)
    m_values[offset] = data;
`);
assert.deepEqual(compoundFor.diagnostics, []);
assert.equal(compoundFor.operations[0]?.op, 'for');

const bitmap = compileMameHandler(`
  uint8_t x = 0xff;
  while (1) {
    x = x + 1;
    bitmap.pix(0, x) = rgb_t::white();
    if (x == 0) break;
  }
  return m_main_ram[((offs_t)x << 5) | 1];
`);
assert.deepEqual(bitmap.diagnostics, []);
assert.equal(bitmap.operations[1]?.op, 'while');

const bitmapPointers = compileMameHandler(`
  uint32_t *const dst = &bitmap.pix(y);
  auto color = m_palette->pen_color(*m_scroll);
  u32 *const dbase = dst + x * 3;
  dbase[0] = color;
`);
assert.deepEqual(bitmapPointers.diagnostics, []);

console.log('handler-ir.spec: 11 passed');
