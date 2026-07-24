import assert from 'node:assert/strict';
import {
  deviceDefinitionsFromSource,
  hardwareKnowledgeGraph,
  resolveCompositeExecutableTypes,
} from './hardware.ts';
import type { HardwareClosureEntry } from './hardware.ts';

const definitions = deviceDefinitionsFromSource('src/devices/sound/test.cpp', `
// DEFINE_DEVICE_TYPE(IGNORED, bad, "bad", "comment")
DEFINE_DEVICE_TYPE(AY8910, ay8910_device, "ay8910", "AY-3-8910A PSG")
DEFINE_DEVICE_TYPE_PRIVATE(TEST_CARD, device_card_interface, test_card_device,
  "test_card", "Test Card")
DAC_GENERATOR(DAC_8BIT_R2R, dac_8bit_r2r_device, dac_base, mapper, 8, gain,
  "8-Bit R-2R DAC", "dac_8bit_r2r")
`);

assert.deepEqual(
  definitions.map(definition => [
    definition.type,
    definition.className,
    definition.shortName,
    definition.description,
  ]),
  [
    ['AY8910', 'ay8910_device', 'ay8910', 'AY-3-8910A PSG'],
    ['TEST_CARD', 'test_card_device', 'test_card', 'Test Card'],
    ['DAC_8BIT_R2R', 'dac_8bit_r2r_device', 'dac_8bit_r2r', '8-Bit R-2R DAC'],
  ],
);
assert.equal(definitions[0]?.sourceLine, 3);

const graph = hardwareKnowledgeGraph({
  schemaVersion: 1,
  mameSource: '/mame',
  targets: ['test'],
  hardware: [{
    type: 'AY8910',
    status: 'source-resolved',
    uses: [{ game: 'test', tags: ['ay1'] }],
    definition: definitions[0],
    methods: [],
    dslFiles: [],
    sourceFiles: ['src/devices/sound/test.cpp'],
  }],
  summary: {
    types: 1,
    sourceResolved: 1,
    declarativeHost: 0,
    unresolved: 0,
    methods: 0,
    compiledMethods: 0,
    blockedMethods: 0,
    dslFiles: 0,
  },
});

assert.ok(graph.nodes.some(node => node.id === 'hardware:AY8910'));
assert.ok(graph.edges.some(edge =>
  edge.from === 'game:test' &&
  edge.to === 'hardware:AY8910' &&
  edge.rel === 'USES_HARDWARE'));

const compositeHardware: HardwareClosureEntry[] = [
  {
    type: 'CPU',
    status: 'source-resolved',
    uses: [],
    methods: [],
    dslFiles: [],
    sourceFiles: [],
  },
  {
    type: 'SPEAKER',
    status: 'declarative-host',
    uses: [],
    methods: [],
    dslFiles: [],
    sourceFiles: [],
  },
  {
    type: 'SOUND_BOARD',
    status: 'source-resolved',
    uses: [],
    methods: [],
    dslFiles: [],
    sourceFiles: [],
    composedOf: ['CPU', 'SPEAKER'],
  },
  {
    type: 'CABINET',
    status: 'source-resolved',
    uses: [],
    methods: [],
    dslFiles: [],
    sourceFiles: [],
    composedOf: ['SOUND_BOARD'],
  },
  {
    type: 'INCOMPLETE_BOARD',
    status: 'source-resolved',
    uses: [],
    methods: [],
    dslFiles: [],
    sourceFiles: [],
    composedOf: ['MISSING_CHIP'],
  },
];
const executable = resolveCompositeExecutableTypes(compositeHardware, new Set(['CPU']));
assert.ok(executable.has('SOUND_BOARD'));
assert.ok(executable.has('CABINET'));
assert.ok(!executable.has('INCOMPLETE_BOARD'));

console.log('hardware.spec: 8 passed');
