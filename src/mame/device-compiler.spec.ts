import assert from 'node:assert/strict';
import { indexMameHardware } from './hardware.ts';
import { compileMameDevice } from './device-compiler.ts';
import {
  clearGeneratedDevices,
  createDevice,
  registerGeneratedDevice,
} from '../runtime/generated-device.ts';

const definitions = indexMameHardware('../mame');
const definition = definitions.get('LS259');
assert.ok(definition, 'MAME hardware index should resolve LS259');

const generated = compileMameDevice('../mame', definition);
assert.deepEqual(
  generated.hierarchy,
  ['addressable_latch_device', 'ls259_device'],
);
assert.equal(generated.summary.methods, 27);
assert.equal(generated.summary.compiledMethods, generated.summary.methods);
assert.equal(generated.summary.diagnostics, 0);
assert.ok(generated.sourceFiles.every(file => file.startsWith('src/')));
assert.ok(generated.methods.every(method => method.source.file && method.source.line > 0));

clearGeneratedDevices();
registerGeneratedDevice(generated);
const latch = createDevice('LS259');
const states: number[] = [];
latch.on('q_out_cb', state => states.push(state), 3);
assert.equal(latch.get('m_q'), 0);
latch.call('write_d0', 3, 1);
assert.equal(latch.get('m_q'), 0x08);
assert.deepEqual(states, [1]);
latch.call('write_d0', 3, 0);
assert.equal(latch.call('output_state'), 0);
assert.deepEqual(states, [1, 0]);

const genericDefinition = definitions.get('GENERIC_LATCH_8');
assert.ok(genericDefinition, 'MAME hardware index should resolve GENERIC_LATCH_8');
const genericGenerated = compileMameDevice('../mame', genericDefinition);
assert.equal(genericGenerated.summary.diagnostics, 0);
registerGeneratedDevice(genericGenerated);
const genericLatch = createDevice('GENERIC_LATCH_8');
genericLatch.call('write', 0x5a);
assert.equal(genericLatch.call('read'), 0x5a);

console.log('device-compiler.spec: 16 passed');
