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

assert.deepEqual(messages.slice(1), [
  { type: 'batch', writes: [{ offset: 3, data: 7, frac: 0.25 }] },
  { type: 'batch', writes: [] },
]);

console.log('audio.spec: 1 passed');
