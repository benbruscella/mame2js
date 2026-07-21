import assert from 'node:assert/strict';
import { GeneratedFrameRunner } from './generated-frame.ts';
import type { GeneratedMachine } from './generated-machine.ts';

const machine: GeneratedMachine = {
  schemaVersion: 2,
  game: 'fixture',
  family: 'fixture',
  driverFile: 'fixture.cpp',
  callbacks: [{
    id: 'callback:vblank',
    ownerTag: 'screen',
    signal: 'screen_vblank',
    operation: 'set',
  }],
  execution: {
    cpus: [{ tag: 'maincpu', type: 'z80', clock: 600, region: 'maincpu' }],
    screen: { width: 1, height: 1, refresh: 10, vtotal: 3, vbstart: 2, rotate: 0 },
    frameEvents: [{
      callbackId: 'callback:vblank',
      ownerTag: 'screen',
      signal: 'screen_vblank',
      line: 2,
      state: 1,
    }],
  },
};

let cycles = 0;
let renders = 0;
let vblanks = 0;
const lines: number[] = [];
const events: string[] = [];
const runner = new GeneratedFrameRunner({
  machine,
  processors: [{ tag: 'maincpu', run: budget => { cycles += budget; return budget; } }],
  video: {
    width: 1,
    height: 1,
    render: () => { renders++; },
    vblank: () => { vblanks++; },
  },
  onLine: (line, phase) => {
    if (phase === 'before-processors') lines.push(line);
  },
  onEvent: event => events.push(event.callbackId),
});
runner.frame(new Uint32Array(1));

assert.equal(cycles, 60);
assert.deepEqual(lines, [0, 1, 2]);
assert.deepEqual(events, ['callback:vblank']);
assert.equal(vblanks, 1);
assert.equal(renders, 1);
assert.equal(runner.frameCount, 1);

const scanlines: number[] = [];
const scanlineMachine: GeneratedMachine = {
  ...machine,
  execution: {
    ...machine.execution,
    screen: { ...machine.execution.screen, updateMode: 'scanline' },
  },
};
new GeneratedFrameRunner({
  machine: scanlineMachine,
  processors: [{ tag: 'maincpu', run: budget => budget }],
  video: {
    width: 1,
    height: 1,
    render: () => { throw new Error('scanline mode rendered a full frame'); },
    renderLine: (_frame, line) => { scanlines.push(line); },
    vblank: () => {},
  },
}).frame(new Uint32Array(1));
assert.deepEqual(scanlines, [0, 1, 2]);

runner.reset();
assert.equal(runner.frameCount, 0);
assert.deepEqual(runner.currentCarry, [0]);

console.log('generated-frame.spec: 8 passed');
