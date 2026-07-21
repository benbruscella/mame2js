import assert from 'node:assert/strict';
import { compileMameI8080, compileMameZ80 } from './cpu-compiler.ts';
import {
  clearGeneratedCpus,
  createCpu,
  registerGeneratedCpu,
} from '../runtime/generated-cpu.ts';

const definition = compileMameZ80(process.env.MAME_SRC ?? '../mame');
assert.equal(definition.summary.opcodes, 1536);
assert.equal(definition.summary.compiledOpcodes, 1536);
assert.equal(definition.summary.diagnostics, 0);
assert.ok(definition.methods.some(method => method.name === 'get_f'));
assert.ok(definition.methods.some(method => method.name === 'm_f.pv'));
assert.equal(definition.sourceFiles.includes('src/devices/cpu/z80/z80.lst'), true);

clearGeneratedCpus();
registerGeneratedCpu(definition);
const memory = new Uint8Array(0x10000);
memory.set([0x3e, 0x7f, 0xc6, 0x01, 0xcb, 0x07]);
const cpu = createCpu('Z80', {
  read: address => memory[address]!,
  write: (address, data) => { memory[address] = data; },
  in: () => 0xff,
  out: () => {},
});
assert.equal(cpu.step(), 7);
assert.equal(cpu.get('A'), 0x7f);
assert.equal(cpu.step(), 7);
assert.equal(cpu.get('A'), 0x80);
assert.equal(cpu.invoke('get_f'), 0x94);
assert.equal(cpu.step(), 8);
assert.equal(cpu.get('A'), 0x01);

const i8080Definition = compileMameI8080(process.env.MAME_SRC ?? '../mame');
registerGeneratedCpu(i8080Definition);
const interruptMemory = new Uint8Array(0x10000);
interruptMemory.set([0xfb, 0x00, 0x00]);
let acknowledgements = 0;
const i8080 = createCpu('I8080', {
  read: address => interruptMemory[address]!,
  write: (address, data) => { interruptMemory[address] = data; },
  in: () => 0xff,
  out: () => {},
});
i8080.set('SP', 0x9000);
i8080.setIrqLine(true, () => {
  acknowledgements++;
  i8080.setIrqLine(false);
  return 0xd7;
});
i8080.step();
i8080.step();
assert.equal(acknowledgements, 0, 'I8080 must defer acknowledge through the EI shadow');
i8080.step();
assert.equal(acknowledgements, 1, 'I8080 must evaluate its vector on acknowledge');

console.log('cpu-compiler.spec: 15 passed');
