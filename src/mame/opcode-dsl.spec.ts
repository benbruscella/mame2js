import assert from 'node:assert/strict';
import { parseZ80OpcodeDsl } from './opcode-dsl.ts';

const ir = parseZ80OpcodeDsl('z80.lst', `
macro read %addr
  3 !! TDAT8 = data_read(%addr);

macro pair %left %right
  @read %left
  @read %right

macro r800:read %addr
  1 !! ignored(%addr);

ffff
  @read PC
  @jump TDAT8

0000 # NOP
  + 1

0001 # pair
  @pair BC DE

r800:0000
  + 9
`);

assert.equal(ir.macros.length, 2);
assert.equal(ir.opcodes.length, 3);
assert.deepEqual(ir.prefixes, { '00': 2, ff: 1 });
assert.equal(ir.opcodes.find(opcode => opcode.key === '0001')?.operations.length, 2);
assert.equal(
  ir.opcodes.find(opcode => opcode.key === '0001')?.operations[0]?.text,
  'TDAT8 = data_read(BC);',
);
assert.deepEqual(
  ir.opcodes.find(opcode => opcode.key === '0001')?.operations[0]?.expandedFrom
    ?.map(expansion => expansion.macro),
  ['pair', 'read'],
);
assert.ok(ir.diagnostics.some(diagnostic => diagnostic.includes('unknown macro @jump')));

console.log('opcode-dsl.spec: 7 passed');
