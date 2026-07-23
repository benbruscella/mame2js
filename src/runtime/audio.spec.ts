import assert from 'node:assert/strict';
import { AudioOutput } from './audio.ts';

const messages: unknown[] = [];

class TestAudioContext {
  readonly audioWorklet = { addModule: async () => {} };
  readonly destination = {};
  readonly state = 'running';
  readonly sampleRate = 48_000;
  readonly baseLatency = 0;

  createGain(): GainNode {
    return { gain: { value: 1 }, connect: () => {} } as unknown as GainNode;
  }

  async resume(): Promise<void> {}
  addEventListener(): void {}
}

class TestAudioWorkletNode {
  readonly port = {
    postMessage(message: unknown) {
      messages.push(message);
    },
  };

  constructor() {}
  connect(): void {}
}

Object.assign(globalThis, {
  AudioContext: TestAudioContext,
  AudioWorkletNode: TestAudioWorkletNode,
});

const output = new AudioOutput();
output.write(3, 7, 0.25);
output.flush();
output.flush();
await output.start({ sampleRate: 48_000, refresh: 60 }, 'test-worklet.js', 'test');

// Frames emulated before start() are history: they collapse into ONE batch so
// the worklet never boots with a multi-frame backlog of permanent latency.
assert.deepEqual(messages.slice(1), [
  { type: 'batch', writes: [{ offset: 3, data: 7, frac: 0.25 }] },
]);

// Post-start frames keep their boundaries, and writes carry the routing
// method name when the board supplies one.
output.write(1, 2, 0.5, 'sound_w');
output.flush();
output.flush();
assert.deepEqual(messages.slice(2), [
  { type: 'batch', writes: [{ offset: 1, data: 2, frac: 0.5, method: 'sound_w' }] },
  { type: 'batch', writes: [] },
]);

console.log('audio.spec: 2 passed');
