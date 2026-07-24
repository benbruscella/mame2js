import assert from 'node:assert/strict';
import { Bus } from './bus.ts';

const rom = Uint8Array.of(0x11, 0x22, 0x33, 0x44);
const reads: Array<[number, number]> = [];
const writes: Array<[number, number, number]> = [];
const shares: Record<string, Uint8Array> = {};
const bus = new Bus([
  { start: 0x0000, end: 0x0003, kind: 'rom' },
  { start: 0x1000, end: 0x1003, kind: 'ram', share: 'work' },
  { start: 0x2000, end: 0x2001, mirror: 0x0100, kind: 'handler', read: 'read', write: 'write' },
  {
    start: 0x3000,
    end: 0x3001,
    kind: 'ram',
    share: 'video',
    write: 'videoWrite',
    writeHandlerOwnsRam: true,
  },
  { start: 0x4000, end: 0x4001, kind: 'ram', share: 'palette', write: 'paletteWrite' },
], rom, {
  read: {
    read: (address, offset) => {
      reads.push([address, offset]);
      return 0x1ff;
    },
  },
  write: {
    write: (address, offset, data) => writes.push([address, offset, data]),
    videoWrite: (address, offset, data) => {
      writes.push([address, offset, shares.video![offset]!]);
      shares.video![offset] = data;
    },
    paletteWrite: (address, offset, data) => writes.push([address, offset, data]),
  },
}, shares);

assert.equal(bus.read(0), 0x11);
assert.equal(bus.read(3), 0x44);
assert.equal(bus.read(0x9999), 0xff);
bus.write(0x1002, 0x1a5);
assert.equal(bus.read(0x1002), 0xa5);
assert.equal(bus.shares.work?.[2], 0xa5);

assert.equal(bus.read(0x2101), 0xff);
assert.deepEqual(reads, [[0x2101, 1]]);
bus.write(0x2100, 0x1fe);
assert.deepEqual(writes[0], [0x2100, 0, 0xfe]);

bus.write(0x3001, 0x77);
assert.equal(bus.read(0x3001), 0x77);
assert.deepEqual(writes[1], [0x3001, 1, 0], 'handler must observe old shared RAM');
bus.write(0x4001, 0x66);
assert.equal(bus.read(0x4001), 0x66);
assert.deepEqual(writes[2], [0x4001, 1, 0x66], 'device-backed RAM remains write-through');
assert.equal(bus.in(0), 0xff);

assert.throws(
  () => new Bus([{ start: 0, end: 0, kind: 'handler', read: 'missing' }], rom, { read: {}, write: {} }),
  /missing read handler/,
);

console.log('bus.spec: ROM, RAM, shares, mirrors, handlers and open bus passed');
