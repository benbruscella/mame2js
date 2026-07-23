import assert from 'node:assert/strict';
import { indexMameHardware } from './hardware.ts';
import { compileMameDevice } from './device-compiler.ts';
import {
  clearGeneratedDevices,
  createDevice,
  registerGeneratedDevice,
} from '../runtime/generated-device.ts';

const mameSrc = process.env.MAME_SRC ?? '../mame';
const hardware = indexMameHardware(mameSrc);
const definition = hardware.get('LS259');
assert.ok(definition, 'MAME hardware index should resolve LS259');

const generated = compileMameDevice(mameSrc, definition);
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

const latchDefinition = hardware.get('GENERIC_LATCH_8');
assert.ok(latchDefinition, 'MAME hardware index should resolve GENERIC_LATCH_8');
const generatedLatch = compileMameDevice(mameSrc, latchDefinition);
assert.equal(generatedLatch.summary.diagnostics, 0);
registerGeneratedDevice(generatedLatch);
const soundLatch = createDevice('GENERIC_LATCH_8');
soundLatch.call('write', 0xa5);
assert.equal(soundLatch.call('pending_r'), 1);
assert.equal(soundLatch.call('read'), 0xa5);
assert.equal(soundLatch.call('pending_r'), 0);

const earomDefinition = hardware.get('ER2055');
assert.ok(earomDefinition, 'MAME hardware index should resolve ER2055');
const generatedEarom = compileMameDevice(mameSrc, earomDefinition);
assert.equal(generatedEarom.summary.diagnostics, 0);
assert.equal(generatedEarom.summary.compiledMethods, generatedEarom.summary.methods);
assert.equal(
  generatedEarom.members.find(member => member.name === 'm_rom_data')?.values?.length,
  64,
  'dynamic MAME device arrays must lower to fixed generated storage',
);

const mb8844Definition = hardware.get('MB8844');
assert.ok(mb8844Definition, 'MAME hardware index should resolve MB8844');
const generatedMb8844 = compileMameDevice(mameSrc, mb8844Definition);
assert.equal(generatedMb8844.summary.diagnostics, 0);
assert.equal(
  generatedMb8844.members.find(member => member.name === 'm_SP')?.values?.length,
  4,
  'fixed MAME MCU arrays must retain their source-declared size',
);
assert.equal(
  generatedMb8844.members.find(member => member.name === 'm_icount')?.signed,
  true,
  'signed MAME execution counters must remain signed in device IR',
);
registerGeneratedDevice(generatedMb8844);
const mb8844 = createDevice('MB8844');
mb8844.set('m_icount', -1);
assert.equal(mb8844.get('m_icount'), -1);

console.log('device-compiler.spec: source-derived latch, ER2055 and MB8844 devices passed');
