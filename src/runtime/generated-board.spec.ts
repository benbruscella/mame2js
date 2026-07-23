import assert from 'node:assert/strict';
import { bindGeneratedShareState } from './generated-board.ts';

const state: Record<string, unknown> = {};
const first = new Uint8Array(0x100);
const second = new Uint8Array(0x100);

bindGeneratedShareState(state, 'spriteram[0]', first);
bindGeneratedShareState(state, 'spriteram[1]', second);

assert.equal(state['m_spriteram[0]'], first);
assert.equal(state['m_spriteram[1]'], second);
assert.deepEqual(state.m_spriteram, [first, second]);
assert.equal((first as Uint8Array & { bytes(): number }).bytes(), 0x100);

console.log('generated-board.spec: 4 passed');
