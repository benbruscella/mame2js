import assert from 'node:assert/strict';
import { assembleRegions } from './shell.ts';

const regions = assembleRegions(
  [
    { region: 'eraseff', size: 4, fill: 0xff, loads: [] },
    { region: 'erase00', size: 4, fill: 0x00, loads: [] },
  ],
  new Map(),
  () => {},
);

assert.deepEqual([...regions.eraseff!], [0xff, 0xff, 0xff, 0xff]);
assert.deepEqual([...regions.erase00!], [0x00, 0x00, 0x00, 0x00]);

console.log('shell.spec: MAME ROM region fill semantics passed');
