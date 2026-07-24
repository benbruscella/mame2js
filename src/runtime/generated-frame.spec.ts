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
const timeline: string[] = [];
const runner = new GeneratedFrameRunner({
  machine,
  processors: [{ tag: 'maincpu', run: budget => {
    cycles += budget;
    timeline.push('cpu');
    return budget;
  } }],
  video: {
    width: 1,
    height: 1,
    render: () => { renders++; timeline.push('render'); },
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
assert.deepEqual(timeline, ['cpu', 'cpu', 'cpu', 'render']);
assert.equal(runner.frameCount, 1);

const scanlines: number[] = [];
const scanlineTimeline: string[] = [];
const scanlineMachine: GeneratedMachine = {
  ...machine,
  execution: {
    ...machine.execution,
    screen: { ...machine.execution.screen, updateMode: 'scanline' },
  },
};
new GeneratedFrameRunner({
  machine: scanlineMachine,
  processors: [{ tag: 'maincpu', run: budget => {
    scanlineTimeline.push('cpu');
    return budget;
  } }],
  video: {
    width: 1,
    height: 1,
    render: () => { throw new Error('scanline mode rendered a full frame'); },
    renderLine: (_frame, line) => {
      scanlines.push(line);
      scanlineTimeline.push(`line:${line}`);
    },
    vblank: () => {},
  },
}).frame(new Uint32Array(1));
assert.deepEqual(scanlines, [0, 1, 2]);
assert.deepEqual(scanlineTimeline, ['cpu', 'line:0', 'cpu', 'line:1', 'cpu', 'line:2']);

runner.reset();
assert.equal(runner.frameCount, 0);
assert.deepEqual(runner.currentCarry, [0]);

const periodicMachine: GeneratedMachine = {
  ...machine,
  execution: {
    ...machine.execution,
    frameEvents: [{
      callbackId: 'callback:periodic',
      ownerTag: 'sound',
      signal: 'vck_callback',
      line: 0,
      state: 1,
      frequency: 25,
    }],
  },
};
let periodicCallbacks = 0;
const periodicRunner = new GeneratedFrameRunner({
  machine: periodicMachine,
  processors: [{ tag: 'maincpu', run: budget => budget }],
  onEvent: () => { periodicCallbacks++; },
});
periodicRunner.frame(new Uint32Array(1));
assert.equal(periodicCallbacks, 2);
periodicRunner.frame(new Uint32Array(1));
assert.equal(periodicCallbacks, 5);
periodicRunner.reset();
periodicRunner.frame(new Uint32Array(1));
assert.equal(periodicCallbacks, 7);

console.log('generated-frame.spec: 13 passed');
