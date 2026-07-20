import assert from 'node:assert/strict';
import {
  compileMame8080,
  compileMame6809,
  compileMameMcs48,
  compileMameZ80,
} from './cpu-compiler.ts';
import {
  clearGeneratedCpus,
  createCpu,
  registerGeneratedCpu,
} from '../runtime/generated-cpu.ts';

const definition = compileMameZ80('../mame');
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

const m6809 = compileMame6809('../mame', 'MC6809');
assert.equal(m6809.summary.compiledOpcodes, 256);
assert.equal(m6809.summary.diagnostics, 0);
registerGeneratedCpu(m6809);
const m6809Memory = new Uint8Array(0x10000);
m6809Memory[0xfffe] = 0x10;
m6809Memory[0xffff] = 0x00;
m6809Memory.set([0x86, 0x7f, 0x8b, 0x01, 0xb7, 0x20, 0x00], 0x1000);
const m6809Cpu = createCpu('MC6809', {
  read: address => m6809Memory[address]!,
  write: (address, data) => { m6809Memory[address] = data; },
  in: () => 0xff,
  out: () => {},
});
assert.equal(m6809Cpu.get('PC'), 0x1000);
assert.equal(m6809Cpu.step(), 2);
assert.equal(m6809Cpu.step(), 2);
assert.equal(m6809Cpu.step(), 5);
assert.equal(m6809Memory[0x2000], 0x80);

const konami1 = compileMame6809('../mame', 'KONAMI1');
assert.equal(konami1.summary.diagnostics, 0);
registerGeneratedCpu(konami1);
const konamiMemory = new Uint8Array(0x10000);
konamiMemory[0xfffe] = 0x10;
konamiMemory[0xffff] = 0x00;
konamiMemory.set([0x86 ^ 0x22, 0x55], 0x1000);
const konamiCpu = createCpu('KONAMI1', {
  read: address => konamiMemory[address]!,
  write: (address, data) => { konamiMemory[address] = data; },
  in: () => 0xff,
  out: () => {},
});
assert.equal(konamiCpu.step(), 2);
assert.equal(konamiCpu.get('m_q.r.a'), 0x55);

const i8039 = compileMameMcs48('../mame');
assert.equal(i8039.summary.opcodes, 256);
assert.equal(i8039.summary.compiledOpcodes, 256);
assert.equal(i8039.summary.diagnostics, 0);
registerGeneratedCpu(i8039);
const i8039Memory = new Uint8Array(0x1000);
i8039Memory.set([0x23, 0x55, 0x39, 0xb8, 0x01, 0x18, 0xf8]);
const pinWrites: { signal: string; value: number; index?: number }[] = [];
const i8039Cpu = createCpu('I8039', {
  read: address => i8039Memory[address]!,
  write: () => {},
  in: () => 0xff,
  out: () => {},
  writeSignal: (signal, value, index) => {
    pinWrites.push({ signal, value, index });
  },
});
assert.equal(i8039Cpu.step(), 2);
assert.equal(i8039Cpu.get('m_a'), 0x55);
assert.equal(i8039Cpu.step(), 2);
assert.deepEqual(pinWrites.at(-1), { signal: 'port', value: 0x55, index: 1 });
assert.equal(i8039Cpu.step(), 2);
assert.equal(i8039Cpu.step(), 1);
assert.equal(i8039Cpu.get('R0'), 2);
assert.equal(i8039Cpu.step(), 1);
assert.equal(i8039Cpu.get('m_a'), 2);

const i8080 = compileMame8080('../mame');
assert.equal(i8080.summary.opcodes, 256);
assert.equal(i8080.summary.compiledOpcodes, 256);
assert.equal(i8080.summary.diagnostics, 0);
registerGeneratedCpu(i8080);
const i8080Memory = new Uint8Array(0x10000);
i8080Memory.set([
  0x31, 0x00, 0x40, // LXI SP,$4000
  0x3e, 0x7f,       // MVI A,$7f
  0xc6, 0x01,       // ADI $01
  0x32, 0x00, 0x20, // STA $2000
]);
const i8080Cpu = createCpu('I8080', {
  read: address => i8080Memory[address]!,
  write: (address, data) => { i8080Memory[address] = data; },
  in: () => 0xff,
  out: () => {},
});
assert.equal(i8080Cpu.step(), 10);
assert.equal(i8080Cpu.get('SP'), 0x4000);
assert.equal(i8080Cpu.step(), 7);
assert.equal(i8080Cpu.get('A'), 0x7f);
assert.equal(i8080Cpu.step(), 7);
assert.equal(i8080Cpu.get('A'), 0x80);
assert.equal(i8080Cpu.step(), 13);
assert.equal(i8080Memory[0x2000], 0x80);

console.log('cpu-compiler.spec: 45 passed');
