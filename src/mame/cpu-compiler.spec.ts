import assert from 'node:assert/strict';
import { compileMameI8080, compileMameM6803, compileMameZ80 } from './cpu-compiler.ts';
import { generatedCpuExecutableSource } from './cpu-codegen.ts';
import {
  clearGeneratedCpus,
  createCpu,
  registerGeneratedCpu,
  type GeneratedCpuDefinition,
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
assert.match(
  generatedCpuExecutableSource(i8080Definition),
  /typeof source === 'function' \? source\(\) : source/,
);
const emptyProgram = { operations: [], diagnostics: [] };
const lazyIrqDefinition: GeneratedCpuDefinition = {
  type: 'LAZY_IRQ_TEST',
  constants: {},
  aliases: {},
  members: [],
  methods: [],
  start: emptyProgram,
  reset: emptyProgram,
  input: emptyProgram,
  step: {
    operations: [{
      op: 'return',
      value: {
        kind: 'call',
        callee: { kind: 'identifier', name: 'standard_irq_callback' },
        args: [],
      },
    }],
    diagnostics: [],
  },
  service: emptyProgram,
  fetch: emptyProgram,
  opcodes: [],
  summary: { diagnostics: 0 },
};
registerGeneratedCpu(lazyIrqDefinition);
let acknowledgements = 0;
const lazyIrq = createCpu('LAZY_IRQ_TEST', {
  read: () => 0,
  write: () => {},
  in: () => 0xff,
  out: () => {},
});
lazyIrq.setIrqLine(true, () => {
  acknowledgements++;
  return 0xd7;
});
assert.equal(acknowledgements, 0, 'CPU must defer vector evaluation until acknowledge');
assert.equal(lazyIrq.step(), 0xd7);
assert.equal(acknowledgements, 1, 'CPU must evaluate its vector on acknowledge');

// Multi-declarator C++ for-initializers must emit valid JS (one `let`, comma
// separated declarators) all the way through new Function.
import { compileMameHandler } from './handler-ir.ts';

const multiDeclDefinition: GeneratedCpuDefinition = {
  ...lazyIrqDefinition,
  type: 'MULTI_DECL_TEST',
  methods: [{
    name: 'sum_bits',
    parameters: '',
    program: compileMameHandler(`
      int total = 0;
      for (int i = 0, n = 8; i < n; i++)
        total += (m_a >> i) & 1;
      return total;
    `),
  }],
  members: [{ name: 'm_a', bits: 8, initial: 0xb3 }],
};
assert.equal(multiDeclDefinition.methods[0]!.program.diagnostics.length, 0);
const multiDeclSource = generatedCpuExecutableSource({
  ...multiDeclDefinition,
  schemaVersion: 1,
  dialect: 'z80',
  sourceFiles: [],
  methods: multiDeclDefinition.methods.map(method => ({
    ...method,
    source: { file: 'cpu-compiler.spec.ts', line: 1 },
  })),
  opcodes: [],
  summary: { opcodes: 0, compiledOpcodes: 0, methods: 1, compiledMethods: 1, diagnostics: 0 },
});
assert.match(multiDeclSource, /for \(let i = \(\(0\) \| 0\), n = \(\(8\) \| 0\); /);
assert.doesNotMatch(multiDeclSource, /, let /);
registerGeneratedCpu(multiDeclDefinition);
const multiDecl = createCpu('MULTI_DECL_TEST', {
  read: () => 0,
  write: () => {},
  in: () => 0xff,
  out: () => {},
});
assert.equal(multiDecl.invoke('sum_bits'), 5);

const m6803Definition = compileMameM6803(process.env.MAME_SRC ?? '../mame');
assert.ok(generatedCpuExecutableSource(m6803Definition).length > 100_000);
assert.equal(m6803Definition.summary.opcodes, 256);
assert.equal(m6803Definition.summary.compiledOpcodes, 256);
assert.equal(m6803Definition.summary.diagnostics, 0);
assert.deepEqual(m6803Definition.internal?.ram, [{ start: 0x80, end: 0xff }]);
assert.deepEqual(
  m6803Definition.internal?.ports.map(port => port.dataAddress),
  [0x02, 0x03],
);
assert.equal(
  m6803Definition.sourceFiles.includes('src/devices/cpu/m6800/6800ops.hxx'),
  true,
);

clearGeneratedCpus();
registerGeneratedCpu(m6803Definition);
const m6803Memory = new Uint8Array(0x10000);
m6803Memory.set([0x86, 0x5a, 0x97, 0x02, 0x01], 0x0200);
m6803Memory[0xfffe] = 0x02;
m6803Memory[0xffff] = 0x00;
const m6803Signals: Array<[string, number]> = [];
const m6803 = createCpu('M6803', {
  read: address => m6803Memory[address]!,
  write: (address, data) => { m6803Memory[address] = data; },
  in: () => 0xff,
  out: () => {},
  signal: (name, value) => {
    m6803Signals.push([name, value ?? 0]);
    return 0;
  },
});
m6803.reset();
assert.equal(m6803.step(), 2);
assert.equal(m6803.get('m_d.b.h'), 0x5a);
assert.equal(m6803.step(), 3);
assert.deepEqual(m6803Signals.at(-1), ['out_p1_cb', 0x5a]);

console.log('cpu-compiler.spec: 30 passed');
