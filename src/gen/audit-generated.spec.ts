import assert from 'node:assert/strict';
import { REQUIRED_TARGETS } from './audit-generated.ts';

assert.equal(REQUIRED_TARGETS.length, 13);
assert.deepEqual(REQUIRED_TARGETS.slice(-2), ['timeplt', 'nes']);
assert.equal(new Set(REQUIRED_TARGETS).size, REQUIRED_TARGETS.length);

console.log('audit-generated.spec: 3 passed');
