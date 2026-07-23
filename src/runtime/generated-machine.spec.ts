import {
  callbackTarget,
  clearGeneratedMachines,
  defineMachine,
  generatedMachine,
  registerGeneratedMachine,
  wireDeviceCallbacks,
} from './generated-machine.ts';

let passed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  passed++;
}

const machine = defineMachine({
  schemaVersion: 2,
  game: 'fixture',
  family: 'fixture',
  driverFile: 'src/mame/fixture.cpp',
  execution: {
    cpus: [],
    screen: { width: 1, height: 1, refresh: 60, vtotal: 1, vbstart: 0, rotate: 0 },
    frameEvents: [],
  },
  callbacks: [
    {
      id: 'callback:0',
      ownerTag: 'mainlatch', signal: 'q_out_cb', slot: 0, operation: 'set',
      targetClass: 'fixture_state', targetMethod: 'irq_w',
    },
    {
      id: 'callback:1',
      ownerTag: 'mainlatch', signal: 'q_out_cb', slot: 1, operation: 'set',
      targetTag: 'screen', targetClass: 'screen_device', targetMethod: 'flip_w',
      transforms: ['invert'],
    },
    {
      id: 'callback:2',
      ownerTag: 'mainlatch', signal: 'q_out_cb', slot: 7, operation: 'set',
      targetClass: 'fixture_state', targetMethod: 'bookkeeping_w',
    },
  ],
});

clearGeneratedMachines();
registerGeneratedMachine(machine);
check('registry', generatedMachine('fixture'), machine);
check('target class', callbackTarget(machine.callbacks[0]), 'fixture_state.irq_w');
check('target tag wins', callbackTarget(machine.callbacks[1]), 'screen.flip_w');

const listeners = new Map<number, (...args: number[]) => void>();
const device = {
  on: (_signal: string, callback: (...args: number[]) => void, slot = 0) => {
    listeners.set(slot, callback);
  },
};
const states: number[] = [];
const result = wireDeviceCallbacks(device, machine, 'mainlatch', 'q_out_cb', {
  'fixture_state.irq_w': state => states.push(state),
  'screen.flip_w': state => states.push(state * 10),
});
listeners.get(0)?.(0, 1);
listeners.get(1)?.(1);
check('generated callbacks execute with transforms', states, [1, 0]);
check('bound targets', result.bound, ['fixture_state.irq_w', 'screen.flip_w']);
check('unimplemented target remains explicit', result.ignored.length, 1);

console.log(`generated-machine.spec: ${passed} passed, 0 failed`);
