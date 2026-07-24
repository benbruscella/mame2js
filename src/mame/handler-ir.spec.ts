import assert from 'node:assert/strict';
import { compileMameHandler } from './handler-ir.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';
import { executeGeneratedHandler } from '../runtime/generated-handler.ts';

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

const staticTable = compileMameHandler(normalizeMameExecutionSource(`
  static const int timer[4] = { 0x00, 0x10, 0x20, 0x30 };
  return timer[(m_soundcpu->total_cycles() / 512) % 4];
`));
assert.deepEqual(staticTable.diagnostics, []);
assert.equal(
  executeGeneratedHandler(staticTable, {
    calls: { 'm_soundcpu.total_cycles': () => 1024 },
  }),
  0x20,
);

const tileFlipYx = compileMameHandler('return TILE_FLIPYX(data);');
assert.deepEqual(tileFlipYx.diagnostics, []);
assert.equal(executeGeneratedHandler(tileFlipYx, {}, { data: 0 }), 0);
assert.equal(executeGeneratedHandler(tileFlipYx, {}, { data: 1 }), 1);
assert.equal(executeGeneratedHandler(tileFlipYx, {}, { data: 2 }), 2);
assert.equal(executeGeneratedHandler(tileFlipYx, {}, { data: 3 }), 3);

const tileFlipXy = compileMameHandler('return TILE_FLIPXY(data);');
assert.deepEqual(tileFlipXy.diagnostics, []);
assert.equal(executeGeneratedHandler(tileFlipXy, {}, { data: 0 }), 0);
assert.equal(executeGeneratedHandler(tileFlipXy, {}, { data: 1 }), 2);
assert.equal(executeGeneratedHandler(tileFlipXy, {}, { data: 2 }), 1);
assert.equal(executeGeneratedHandler(tileFlipXy, {}, { data: 3 }), 3);

// C number literals: octal, binary, hex/decimal suffixes, floats.
const octal = compileMameHandler('return data & 017;');
assert.deepEqual(octal.diagnostics, []);
assert.equal(executeGeneratedHandler(octal, {}, { data: 0xff }), 0x0f);

const binaryLiteral = compileMameHandler('return data & 0b1010;');
assert.deepEqual(binaryLiteral.diagnostics, []);
assert.equal(executeGeneratedHandler(binaryLiteral, {}, { data: 0xff }), 0b1010);

const suffixed = compileMameHandler('return 0x10UL + 5u;');
assert.deepEqual(suffixed.diagnostics, []);
assert.equal(executeGeneratedHandler(suffixed, {}), 0x15);

// Trailing hex digits must never be eaten as f/l suffixes.
const hexTrailing = compileMameHandler('return (data & 0x0f) + 0xff + 0xffUL;');
assert.deepEqual(hexTrailing.diagnostics, []);
assert.equal(executeGeneratedHandler(hexTrailing, {}, { data: 0x3a }), 0x0a + 0xff + 0xff);

const floatLiteral = compileMameHandler('return 0.25f + 1.5;');
assert.deepEqual(floatLiteral.diagnostics, []);
assert.equal(executeGeneratedHandler(floatLiteral, {}), 1.75);

// MAME BIT(x, n, w) extracts a w-bit field, not a single bit.
const bitField = compileMameHandler('return BIT(offset, 4, 3);');
assert.deepEqual(bitField.diagnostics, []);
assert.equal(executeGeneratedHandler(bitField, {}, { offset: 0x30 }), 3);
assert.equal(executeGeneratedHandler(bitField, {}, { offset: 0x70 }), 7);

// u32 values with bit 31 set shift logically, like C++ unsigned >>.
const highShift = compileMameHandler('return rgb_t::black() >> 24;');
assert.deepEqual(highShift.diagnostics, []);
assert.equal(executeGeneratedHandler(highShift, {}), 0xff);

// Negative (signed) values keep the arithmetic shift.
const signedShift = compileMameHandler('return (0 - 16) >> 2;');
assert.deepEqual(signedShift.diagnostics, []);
assert.equal(executeGeneratedHandler(signedShift, {}), -4);

// Integer division truncates; float division must not.
const intDivision = compileMameHandler('return 7 / 2;');
assert.deepEqual(intDivision.diagnostics, []);
assert.equal(executeGeneratedHandler(intDivision, {}), 3);

const floatDivision = compileMameHandler('return 0.6 / 3;');
assert.deepEqual(floatDivision.diagnostics, []);
assert.ok(Math.abs((executeGeneratedHandler(floatDivision, {}) as number) - 0.2) < 1e-12);

const rcDivision = compileMameHandler('return 1 / (RES_K(47) * CAP_U(1));');
assert.deepEqual(rcDivision.diagnostics, []);
assert.ok(Math.abs((executeGeneratedHandler(rcDivision, {}) as number) - 21.2765957) < 1e-4);

const commaAssignments = compileMameHandler(
  'clip.min_y = 0, clip.max_y = 127;',
);
assert.deepEqual(commaAssignments.diagnostics, []);
assert.equal(commaAssignments.operations.length, 2);

const defaultRectangle = compileMameHandler('rectangle clip; clip.min_y = 4;');
assert.deepEqual(defaultRectangle.diagnostics, []);
assert.equal(defaultRectangle.operations[0]?.op, 'declare');

const inactiveIfdef = compileMameHandler(normalizeMameExecutionSource(`
#ifdef UNUSED_RENDER_PATH
  split_render();
#else
  clip = cliprect;
#endif
`));
assert.deepEqual(inactiveIfdef.diagnostics, []);
assert.equal(inactiveIfdef.operations.length, 1);

const constexprLocal = compileMameHandler('constexpr uint8_t HEIGHT = 128;');
assert.deepEqual(constexprLocal.diagnostics, []);
assert.equal(constexprLocal.operations[0]?.op, 'declare');

console.log('handler-ir.spec: 31 passed');
