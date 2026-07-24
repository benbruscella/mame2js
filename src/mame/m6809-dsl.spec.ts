import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseM6809Dsl } from './m6809-dsl.ts';

const mameSrc = process.env.MAME_SRC ?? '../mame';
const directory = join(mameSrc, 'src/devices/cpu/m6809');
const source = readFileSync(join(directory, 'm6809.lst'), 'utf8');
const base = readFileSync(join(directory, 'base6x09.lst'), 'utf8');
const dsl = parseM6809Dsl(source, base);

assert.equal(dsl.opcodes.length, 766);
assert.equal(new Set(dsl.opcodes.map(opcode => opcode.key)).size, 766);
assert.match(dsl.opcodes.find(opcode => opcode.key === '8600')!.source, /read_operand/);
assert.match(dsl.opcodes.find(opcode => opcode.key === '1026')!.source, /branch_taken/);
assert.doesNotMatch(dsl.opcodes.find(opcode => opcode.key === 'bd00')!.source, /%|goto/);
assert.ok(dsl.blocks.has('INDEXED'));
assert.ok(dsl.blocks.has('INTERRUPT_VECTOR'));

console.log('m6809-dsl.spec: 6 passed');
