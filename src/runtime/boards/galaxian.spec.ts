// Integration smoke test for the Galaxian board: synthetic ROM with a tiny
// hand-assembled Z80 program proves CPU + bus dispatch + NMI enable latch +
// vblank NMI + port reads + watchdog read + sound-sink mapping + shared RAM
// + video render work together. Run: node src/runtime/boards/galaxian.spec.ts

import { GalaxianBoard, type BoardConfig } from './galaxian.ts';
import type { Regions, InputPorts } from '../types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

// galaxian_map, as the generator derives it from the knowledge graph
// (mirrors out/galaxian/app/src/config.ts, values in hex)
const RANGES: BoardConfig['ranges'] = [
  { start: 0x0000, end: 0x3fff, kind: 'rom' },
  { start: 0x4000, end: 0x43ff, kind: 'ram', mirror: 0x0400 },
  { start: 0x5000, end: 0x53ff, kind: 'ram', mirror: 0x0400, share: 'videoram', write: 'galaxian_state.galaxian_videoram_w' },
  { start: 0x5800, end: 0x58ff, kind: 'ram', mirror: 0x0700, share: 'spriteram', write: 'galaxian_state.galaxian_objram_w' },
  { start: 0x6000, end: 0x6000, kind: 'handler', mirror: 0x07ff, read: 'port.IN0' },
  { start: 0x6000, end: 0x6001, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.start_lamp_w' },
  { start: 0x6002, end: 0x6002, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.coin_lock_w' },
  { start: 0x6003, end: 0x6003, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.coin_count_0_w' },
  { start: 0x6004, end: 0x6007, kind: 'handler', mirror: 0x07f8, write: 'cust.lfo_freq_w' },
  { start: 0x6800, end: 0x6800, kind: 'handler', mirror: 0x07ff, read: 'port.IN1' },
  { start: 0x6800, end: 0x6807, kind: 'handler', mirror: 0x07f8, write: 'cust.sound_w' },
  { start: 0x7000, end: 0x7000, kind: 'handler', mirror: 0x07ff, read: 'port.IN2' },
  { start: 0x7001, end: 0x7001, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.irq_enable_w' },
  { start: 0x7004, end: 0x7004, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.galaxian_stars_enable_w' },
  { start: 0x7006, end: 0x7006, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.galaxian_flip_screen_x_w' },
  { start: 0x7007, end: 0x7007, kind: 'handler', mirror: 0x07f8, write: 'galaxian_state.galaxian_flip_screen_y_w' },
  { start: 0x7800, end: 0x7800, kind: 'handler', mirror: 0x07ff, read: 'watchdog.reset_r' },
  { start: 0x7800, end: 0x7800, kind: 'handler', mirror: 0x07ff, write: 'cust.pitch_w' },
];

const CONFIG: BoardConfig = {
  family: 'galaxian',
  cpus: [{ tag: 'maincpu', clock: 3072000, region: 'maincpu' }],
  ranges: RANGES,
  screen: { width: 256, height: 224, refresh: 60.606061, vtotal: 264, vbstart: 240, vbend: 16, rotate: 90 },
  clocks: { namco06: 48000, wsg: 96000 },
};

// --- hand-assembled test program --------------------------------------------
const rom = new Uint8Array(0x4000);
const P = [
  // reset
  0x31, 0x00, 0x44,       // 0000 LD SP,0x4400 (top of work RAM)
  // sound latch writes, checked against the sink offset mapping
  0x3e, 0x11,             // 0003 LD A,0x11
  0x32, 0x04, 0x60,       // 0005 LD (0x6004),A   ; lfo_freq_w off 0 -> (0x10,0x11)
  0x3e, 0x22,             // 0008 LD A,0x22
  0x32, 0x07, 0x60,       // 000a LD (0x6007),A   ; lfo_freq_w off 3 -> (0x13,0x22)
  0x3e, 0x33,             // 000d LD A,0x33
  0x32, 0x00, 0x68,       // 000f LD (0x6800),A   ; sound_w off 0    -> (0x00,0x33)
  0x3e, 0x44,             // 0012 LD A,0x44
  0x32, 0x07, 0x68,       // 0014 LD (0x6807),A   ; sound_w off 7    -> (0x07,0x44)
  0x3e, 0x55,             // 0017 LD A,0x55
  0x32, 0x00, 0x78,       // 0019 LD (0x7800),A   ; pitch_w          -> (0x20,0x55)
  // watchdog + input port reads, stored into videoram for inspection
  0x3a, 0x00, 0x78,       // 001c LD A,(0x7800)   ; watchdog read -> 0xff
  0x32, 0x41, 0x50,       // 001f LD (0x5041),A
  0x3a, 0x00, 0x60,       // 0022 LD A,(0x6000)   ; IN0
  0x32, 0x42, 0x50,       // 0025 LD (0x5042),A
  0x3a, 0x00, 0x68,       // 0028 LD A,(0x6800)   ; IN1
  0x32, 0x43, 0x50,       // 002b LD (0x5043),A
  0x3a, 0x00, 0x70,       // 002e LD A,(0x7000)   ; IN2
  0x32, 0x44, 0x50,       // 0031 LD (0x5044),A
  // fill videoram 0x5000-0x503f with 0x55
  0x21, 0x00, 0x50,       // 0034 LD HL,0x5000
  0x36, 0x55,             // 0037 LD (HL),0x55
  0x23,                   // 0039 INC HL
  0x7d,                   // 003a LD A,L
  0xfe, 0x40,             // 003b CP 0x40
  0x20, 0xf8,             // 003d JR NZ,0x0037
  // enable the vblank NMI and spin
  0x3e, 0x01,             // 003f LD A,1
  0x32, 0x01, 0x70,       // 0041 LD (0x7001),A   ; irq_enable_w = 1
  0x18, 0xfe,             // 0044 JR 0x0044       ; spin, wait for NMIs
];
rom.set(P, 0);
const NMI = [
  // count vblanks in videoram[0x40]; after the 5th, disable further NMIs
  0x21, 0x40, 0x50,       // 0066 LD HL,0x5040
  0x34,                   // 0069 INC (HL)
  0x7e,                   // 006a LD A,(HL)
  0xfe, 0x05,             // 006b CP 5
  0x20, 0x04,             // 006d JR NZ,0x0073
  0xaf,                   // 006f XOR A
  0x32, 0x01, 0x70,       // 0070 LD (0x7001),A   ; irq_enable_w = 0
  0xed, 0x45,             // 0073 RETN
];
rom.set(NMI, 0x66);

const regions: Regions = {
  maincpu: rom,
  gfx1: new Uint8Array(0x1000),
  proms: new Uint8Array(0x20),
};

const PORTS: Record<string, number> = { IN0: 0x12, IN1: 0x34, IN2: 0x56 };
const inputs: InputPorts = { read: (tag) => PORTS[tag] ?? 0xff };
const soundWrites: [number, number][] = [];
const board = new GalaxianBoard(CONFIG, regions, inputs, {
  soundWrite: (off, d) => soundWrites.push([off, d]),
});

check('board native fb is 256x224', board.fbWidth === 256 && board.fbHeight === 224);

const fb = new Uint32Array(256 * 224);
board.frame(fb);
board.frame(fb);

const vram = board.shares['videoram'];
check('videoram share exists', !!vram);
check('NMI fires once per frame (2 after 2 frames)', !!vram && vram[0x40] === 2,
  vram ? `count=${vram[0x40]}` : 'no share');

for (let i = 0; i < 5; i++) board.frame(fb);

const snap = board.snapshot();
check('main cpu is in the spin loop', snap.cpus[0].pc >= 0x44 && snap.cpus[0].pc <= 0x46,
  `pc=${snap.cpus[0].pc.toString(16)}`);
check('frames advanced', snap.frame === 7, `frame=${snap.frame}`);
check('NMI stops when disabled (counter pinned at 5)', !!vram && vram[0x40] === 5,
  vram ? `count=${vram[0x40]}` : 'no share');
check('board reports NMI disabled', snap.nmiEnabled === 0, `nmiEnabled=${snap.nmiEnabled}`);

check('videoram filled by program', !!vram && vram[0] === 0x55 && vram[0x3f] === 0x55 && vram[0x45] === 0,
  vram ? `vram[0]=${vram[0].toString(16)}` : 'no share');
check('watchdog read returned 0xff', !!vram && vram[0x41] === 0xff,
  vram ? `got=${vram[0x41].toString(16)}` : 'no share');
check('port reads return InputPorts values (IN0/IN1/IN2)',
  !!vram && vram[0x42] === 0x12 && vram[0x43] === 0x34 && vram[0x44] === 0x56,
  vram ? `${vram[0x42].toString(16)},${vram[0x43].toString(16)},${vram[0x44].toString(16)}` : 'no share');

const wantSound = [[0x10, 0x11], [0x13, 0x22], [0x00, 0x33], [0x07, 0x44], [0x20, 0x55]];
check('sound writes mapped to sink offsets 0x00-0x07/0x10-0x13/0x20',
  JSON.stringify(soundWrites) === JSON.stringify(wantSound),
  JSON.stringify(soundWrites));

check('framebuffer rendered (alpha set on every pixel)', (() => {
  for (let i = 0; i < fb.length; i += 512) if ((fb[i] >>> 24) !== 0xff) return false;
  return true;
})());

// reset() returns the board to a cold state: NMIs disabled again
board.reset();
if (vram) vram[0x40] = 0;
board.frame(fb);
board.frame(fb);
check('after reset the program re-runs and NMIs count again', !!vram && vram[0x40] === 2,
  vram ? `count=${vram[0x40]}` : 'no share');

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
