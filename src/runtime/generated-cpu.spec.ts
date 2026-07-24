import assert from 'node:assert/strict';
import { compileMameHandler } from '../mame/handler-ir.ts';
import {
  clearGeneratedCpus,
  createCpu,
  hasGeneratedCpu,
  registerGeneratedCpu,
  type GeneratedCpuDefinition,
} from './generated-cpu.ts';

const emptyProgram = { operations: [], diagnostics: [] };
const definition = (
  type: string,
  overrides: Partial<GeneratedCpuDefinition> = {},
): GeneratedCpuDefinition => ({
  type,
  constants: {
    ASSERT_LINE: 1,
    CLEAR_LINE: 0,
    INPUT_LINE_IRQ0: 0,
    INPUT_LINE_NMI: -1,
  },
  aliases: {},
  members: [],
  methods: [],
  start: emptyProgram,
  reset: emptyProgram,
  input: emptyProgram,
  service: emptyProgram,
  fetch: emptyProgram,
  opcodes: [],
  summary: { diagnostics: 0 },
  ...overrides,
});

clearGeneratedCpus();
assert.equal(hasGeneratedCpu('fixture'), false);
assert.throws(
  () => createCpu('missing', {
    read: () => 0,
    write: () => {},
    in: () => 0,
    out: () => {},
  }),
  /was not registered/,
);
assert.throws(
  () => registerGeneratedCpu(definition('broken', {
    summary: { diagnostics: 1 },
  })),
  /1 compiler diagnostics/,
);

const memory = new Uint8Array(0x10000);
memory[0x1234] = 0x7f;
const writes: Array<[number, number]> = [];
const outputs: Array<[number, number]> = [];
registerGeneratedCpu(definition('fixture', {
  aliases: {
    A: { member: 'm_pair', part: 'high', bits: 8 },
    F: { member: 'm_pair', part: 'low', bits: 8 },
  },
  members: [
    { name: 'm_pair', pair: true },
    { name: 'm_byte', bits: 8 },
    { name: 'cycles', bits: 32 },
  ],
  methods: [{
    name: 'exercise_bus',
    parameters: '',
    program: compileMameHandler(`
      int value = READ(0x1234);
      WRITE(0x1235, value + 1);
      m_io.write_interruptible(0x45, value);
      return cycles;
    `),
  }],
  step: compileMameHandler('return 3;'),
}));
assert.equal(hasGeneratedCpu('FIXTURE'), true);
const cpu = createCpu('FiXtUrE', {
  read: address => memory[address]!,
  write: (address, data) => {
    writes.push([address, data]);
    memory[address] = data;
  },
  in: () => 0xff,
  out: (port, data) => outputs.push([port, data]),
});
cpu.set('A', 0x12);
cpu.set('F', 0x34);
assert.equal(cpu.get('m_pair.w'), 0x1234);
cpu.set('m_byte', 0x1ff);
assert.equal(cpu.get('m_byte'), 0xff);
assert.equal(cpu.invoke('exercise_bus'), 2);
assert.deepEqual(writes, [[0x1235, 0x80]]);
assert.deepEqual(outputs, [[0x45, 0x7f]]);
assert.equal(cpu.run(8), 9, 'run must stop after whole source-derived instructions');

let acknowledgements = 0;
registerGeneratedCpu(definition('lazy_irq', {
  step: compileMameHandler('return standard_irq_callback();'),
}));
const irqCpu = createCpu('lazy_irq', {
  read: () => 0,
  write: () => {},
  in: () => 0,
  out: () => {},
});
irqCpu.setIrqLine(true, () => {
  acknowledgements++;
  return 0xd7;
}, true);
assert.equal(acknowledgements, 0, 'IRQ data must remain lazy until acknowledge');
assert.equal(irqCpu.step(), 0xd7);
assert.equal(acknowledgements, 1);

const internalSignals: Array<[string, number]> = [];
registerGeneratedCpu(definition('internal_io', {
  members: [{ name: 'm_dataptr', bits: 8, values: new Array(128).fill(0) }],
  methods: [{
    name: 'internal_round_trip',
    parameters: '',
    program: compileMameHandler(`
      ram_w(0x81, 0x1ff);
      port_w(1, ram_r(1));
      return ram_r(0x81);
    `),
  }],
}));
const internalCpu = createCpu('internal_io', {
  read: () => 0,
  write: () => {},
  in: () => 0,
  out: () => {},
  signal: (name, state) => {
    internalSignals.push([name, state]);
    return 0;
  },
});
assert.equal(internalCpu.invoke('internal_round_trip'), 0xff);
assert.deepEqual(internalSignals, [['p1_out_cb', 0xff]]);

let delegated = 0;
registerGeneratedCpu({
  type: 'delegated',
  summary: { diagnostics: 0 },
  create: () => {
    delegated++;
    return cpu;
  },
});
assert.equal(createCpu('DELEGATED', {
  read: () => 0,
  write: () => {},
  in: () => 0,
  out: () => {},
}), cpu);
assert.equal(delegated, 1);

clearGeneratedCpus();
assert.equal(hasGeneratedCpu('fixture'), false);

console.log('generated-cpu.spec: registration, bus, state, IRQ and internal I/O passed');
