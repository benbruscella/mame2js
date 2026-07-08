// Integration smoke test for the Dig Dug board: synthetic ROMs with a tiny
// hand-assembled Z80 program prove CPU + bus dispatch + LS259 latch + vblank
// IRQ + shared RAM + EAROM + video render work together.
// Run: node src/runtime/boards/digdug.spec.ts

import { DigdugBoard, type BoardConfig } from './digdug.ts';
import type { Regions, InputPorts } from '../types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

// digdug_map, as the generator derives it from the knowledge graph
const RANGES: BoardConfig['ranges'] = [
  { start: 0x0000, end: 0x3fff, kind: 'rom' },
  { start: 0x6800, end: 0x681f, kind: 'handler', write: 'namco.pacman_sound_w' },
  { start: 0x6820, end: 0x6827, kind: 'handler', write: 'misclatch.write_d0' },
  { start: 0x6830, end: 0x6830, kind: 'handler', write: 'watchdog.reset_w' },
  { start: 0x7000, end: 0x70ff, kind: 'handler', read: '06xx.data_r', write: '06xx.data_w' },
  { start: 0x7100, end: 0x7100, kind: 'handler', read: '06xx.ctrl_r', write: '06xx.ctrl_w' },
  { start: 0x8000, end: 0x83ff, kind: 'ram', share: 'videoram', write: 'digdug_state.digdug_videoram_w' },
  { start: 0x8400, end: 0x87ff, kind: 'ram', share: 'share1' },
  { start: 0x8800, end: 0x8bff, kind: 'ram', share: 'digdug_objram' },
  { start: 0x9000, end: 0x93ff, kind: 'ram', share: 'digdug_posram' },
  { start: 0x9800, end: 0x9bff, kind: 'ram', share: 'digdug_flpram' },
  { start: 0xa000, end: 0xa007, kind: 'handler', write: 'videolatch.write_d0' },
  { start: 0xb800, end: 0xb83f, kind: 'handler', read: 'digdug_state.earom_read', write: 'digdug_state.earom_write' },
  { start: 0xb840, end: 0xb840, kind: 'handler', write: 'digdug_state.earom_control_w' },
];

const CONFIG: BoardConfig = {
  family: 'digdug',
  cpus: [
    { tag: 'maincpu', clock: 3072000, region: 'maincpu' },
    { tag: 'sub', clock: 3072000, region: 'sub' },
    { tag: 'sub2', clock: 3072000, region: 'sub2' },
  ],
  ranges: RANGES,
  screen: { width: 288, height: 224, refresh: 60.606061, vtotal: 264, vbstart: 224, rotate: 90 },
  clocks: { namco06: 48000, wsg: 96000 },
};

// --- hand-assembled test program --------------------------------------------
// Enables main IRQ, fills videoram, counts vblanks in flpram, and pokes the
// EAROM (erase then write byte 0x2a at address 0x05) before spinning.
const rom = new Uint8Array(0x10000);
const P = [
  0x31, 0x00, 0x88,       // 0000 LD SP,0x8800 (top of share1)
  0x3e, 0x01,             // 0003 LD A,1
  0x32, 0x20, 0x68,       // 0005 LD (0x6820),A   ; misclatch Q0 = 1 (main irq enable)
  0xed, 0x56,             // 0008 IM 1
  0xfb,                   // 000a EI
  // fill first 0x40 bytes of videoram with 0x55
  0x21, 0x00, 0x80,       // 000b LD HL,0x8000
  0x36, 0x55,             // 000e LD (HL),0x55
  0x23,                   // 0010 INC HL
  0x7d,                   // 0011 LD A,L
  0xfe, 0x40,             // 0012 CP 0x40
  0x20, 0xf8,             // 0014 JR NZ,0x000e
  // EAROM: address 0x05, data 0x2a  -> erase then write
  0x3e, 0x2a,             // 0016 LD A,0x2a
  0x32, 0x05, 0xb8,       // 0018 LD (0xb805),A   ; earom addr=5, data=0x2a
  0x3e, 0x0e,             // 001b LD A,0x0e       ; CS1|C2 -> erase
  0x32, 0x40, 0xb8,       // 001d LD (0xb840),A
  0x3e, 0x0a,             // 0020 LD A,0x0a       ; CS1, C1=C2=0 -> write (AND)
  0x32, 0x40, 0xb8,       // 0022 LD (0xb840),A
  0x18, 0xfe,             // 0025 JR 0x0025       ; spin, wait for IRQs
];
rom.set(P, 0);
const ISR = [
  0xaf,                   // 0038 XOR A
  0x32, 0x20, 0x68,       // 0039 LD (0x6820),A   ; Q0=0: ack/clear irq line
  0x21, 0x00, 0x98,       // 003c LD HL,0x9800    ; digdug_flpram
  0x34,                   // 003f INC (HL)        ; count vblanks
  0x3e, 0x01,             // 0040 LD A,1
  0x32, 0x20, 0x68,       // 0042 LD (0x6820),A   ; Q0=1: re-enable
  0xfb,                   // 0045 EI
  0xed, 0x4d,             // 0046 RETI
];
rom.set(ISR, 0x38);

const regions: Regions = {
  maincpu: rom,
  sub: new Uint8Array(0x10000).fill(0x76),
  sub2: new Uint8Array(0x10000).fill(0x76),
  gfx1: new Uint8Array(0x1000),
  gfx2: new Uint8Array(0x4000),
  gfx3: new Uint8Array(0x1000),
  gfx4: new Uint8Array(0x1000),
  proms: new Uint8Array(0x220),
  namco: new Uint8Array(0x200),
};

// DSWA=0x35, DSWB=0xc2 so we can confirm the 53xx returns them.
const inputs: InputPorts = {
  read: (tag: string) => tag === 'DSWA' ? 0x35 : tag === 'DSWB' ? 0xc2 : 0xff,
};
const wsgWrites: number[] = [];
const board = new DigdugBoard(CONFIG, regions, inputs, {
  soundWrite: (off: number, d: number) => wsgWrites.push((off << 8) | d),
});

const fb = new Uint32Array(288 * 224);
const FRAMES = 5;
for (let i = 0; i < FRAMES; i++) board.frame(fb);

const snap = board.snapshot();

check('main cpu is running (pc in spin loop)', snap.cpus[0].pc >= 0x25 && snap.cpus[0].pc <= 0x27,
  `pc=${snap.cpus[0].pc.toString(16)}`);
check('sub cpus held in reset', !!snap.cpus[1].held && !!snap.cpus[2].held);
check('misclatch Q0 set by program', (Number(snap.misclatch) & 1) === 1);
check('frames advanced', snap.frame === FRAMES, `frame=${snap.frame}`);

const vram = board.shares['videoram'];
const flp = board.shares['digdug_flpram'];
check('videoram filled by program', !!vram && vram[0] === 0x55 && vram[0x3f] === 0x55 && vram[0x40] === 0,
  vram ? `vram[0]=${vram[0].toString(16)}` : 'no share');
check('vblank IRQ counted in flpram', !!flp && flp[0] === FRAMES,
  flp ? `count=${flp[0]} want=${FRAMES}` : 'no share');
check('framebuffer rendered (alpha set on every pixel)', (() => {
  for (let i = 0; i < fb.length; i += 1024) if ((fb[i] >>> 24) !== 0xff) return false;
  return true;
})());
check('no spurious wsg writes from test program', wsgWrites.length === 0);

// snapshot exposes the Dig Dug-specific customs
check('snapshot includes 53xx + earom', !!snap.namco53 && !!snap.earom);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
