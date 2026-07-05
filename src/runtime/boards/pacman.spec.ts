// Integration smoke test for the Pac-Man board: synthetic ROMs with a tiny
// hand-assembled Z80 program prove CPU + bus dispatch + io-space vector port +
// LS259 mainlatch + IM2 vblank IRQ (HOLD_LINE) + shared RAM + sound gating +
// video render work together. Run: node src/runtime/boards/pacman.spec.ts

import { PacmanBoard, type BoardConfig } from './pacman.ts';
import type { Regions, InputPorts } from '../types.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

// pacman_map + writeport, as the generator derives them from the knowledge graph
const RANGES: BoardConfig['ranges'] = [
  { start: 0x0000, end: 0x3fff, kind: 'rom', mirror: 0x8000 },
  { start: 0x4000, end: 0x43ff, kind: 'ram', mirror: 0xa000, share: 'videoram', write: 'pacman_state.pacman_videoram_w' },
  { start: 0x4400, end: 0x47ff, kind: 'ram', mirror: 0xa000, share: 'colorram', write: 'pacman_state.pacman_colorram_w' },
  { start: 0x4800, end: 0x4bff, kind: 'handler', mirror: 0xa000, read: 'pacman_state.pacman_read_nop' },
  { start: 0x4c00, end: 0x4fef, kind: 'ram', mirror: 0xa000 },
  { start: 0x4ff0, end: 0x4fff, kind: 'ram', mirror: 0xa000, share: 'spriteram' },
  { start: 0x5000, end: 0x5007, kind: 'handler', mirror: 0xaf38, write: 'mainlatch.write_d0' },
  { start: 0x5040, end: 0x505f, kind: 'handler', mirror: 0xaf00, write: 'namco.pacman_sound_w' },
  { start: 0x5060, end: 0x506f, kind: 'ram', mirror: 0xaf00, share: 'spriteram2' },
  { start: 0x5070, end: 0x507f, kind: 'nop', mirror: 0xaf00 },
  { start: 0x5080, end: 0x5080, kind: 'nop', mirror: 0xaf3f },
  { start: 0x50c0, end: 0x50c0, kind: 'handler', mirror: 0xaf3f, write: 'watchdog.reset_w' },
  { start: 0x5000, end: 0x5000, kind: 'handler', mirror: 0xaf3f, read: 'port.IN0' },
  { start: 0x5040, end: 0x5040, kind: 'handler', mirror: 0xaf3f, read: 'port.IN1' },
  { start: 0x5080, end: 0x5080, kind: 'handler', mirror: 0xaf3f, read: 'port.DSW1' },
  { start: 0x50c0, end: 0x50c0, kind: 'handler', mirror: 0xaf3f, read: 'port.DSW2' },
];

const CONFIG: BoardConfig = {
  family: 'pacman',
  cpus: [{ tag: 'maincpu', clock: 3072000, region: 'maincpu' }],
  ranges: RANGES,
  io: {
    ranges: [
      { start: 0x00, end: 0x00, kind: 'handler', write: 'pacman_state.pacman_interrupt_vector_w' },
    ],
    globalMask: 0xff,
  },
  screen: { width: 288, height: 224, refresh: 60.606061, vtotal: 264, vbstart: 224, vbend: 0, rotate: 90 },
  clocks: { namco06: 48000, wsg: 96000 },
};

// --- hand-assembled test program --------------------------------------------
const rom = new Uint8Array(0x10000);
const P = [
  // reset
  0x31, 0xf0, 0x4f,       // 0000 LD SP,0x4ff0
  0x3e, 0x20,             // 0003 LD A,0x20
  0xed, 0x47,             // 0005 LD I,A          ; IM2 table page = 0x20
  0x3e, 0x02,             // 0007 LD A,0x02
  0xd3, 0x00,             // 0009 OUT (0),A       ; interrupt vector = 0x02 -> table @0x2002
  0xed, 0x5e,             // 000b IM 2
  0x3e, 0x07,             // 000d LD A,7
  0x32, 0x45, 0x50,       // 000f LD (0x5045),A   ; wsg ch0 waveform = 7
  0x3e, 0x0f,             // 0012 LD A,0x0f
  0x32, 0x55, 0x50,       // 0014 LD (0x5055),A   ; wsg ch0 volume = 15 (Q1 still 0 -> gated)
  0x3e, 0x01,             // 0017 LD A,1
  0x32, 0x01, 0x50,       // 0019 LD (0x5001),A   ; mainlatch Q1 = 1 (sound enable)
  0x32, 0x00, 0x50,       // 001c LD (0x5000),A   ; mainlatch Q0 = 1 (irq enable)
  0x21, 0x00, 0x40,       // 001f LD HL,0x4000
  0x36, 0x55,             // 0022 LD (HL),0x55    ; fill first 0x40 bytes of videoram
  0x23,                   // 0024 INC HL
  0x7d,                   // 0025 LD A,L
  0xfe, 0x40,             // 0026 CP 0x40
  0x20, 0xf8,             // 0028 JR NZ,0x0022
  0x3a, 0x00, 0x50,       // 002a LD A,(0x5000)   ; read IN0 (read side of 0x5000 is the port)
  0x32, 0x40, 0x40,       // 002d LD (0x4040),A   ; stash it in videoram for inspection
  0xfb,                   // 0030 EI
  0x18, 0xfe,             // 0031 JR 0x0031       ; spin, wait for IRQs
];
rom.set(P, 0);
// ISR does NOT touch the irq line or the mask: it re-enables and returns, so
// it runs exactly once per vblank only if HOLD_LINE release works.
const ISR = [
  0xf5,                   // 0100 PUSH AF
  0x21, 0x00, 0x44,       // 0101 LD HL,0x4400
  0x34,                   // 0104 INC (HL)        ; count vblank IRQs in colorram[0]
  0xf1,                   // 0105 POP AF
  0xfb,                   // 0106 EI
  0xed, 0x4d,             // 0107 RETI
];
rom.set(ISR, 0x100);
// IM2 vector table entry at (I<<8)|vector = 0x2002 -> 0x0100
rom[0x2002] = 0x00;
rom[0x2003] = 0x01;

const regions: Regions = {
  maincpu: rom,
  gfx1: new Uint8Array(0x2000),
  proms: new Uint8Array(0x120),
  namco: new Uint8Array(0x200),
};

const inputs: InputPorts = { read: (tag: string) => (tag === 'IN0' ? 0x5a : 0xff) };
const wsgWrites: { off: number; data: number }[] = [];
const board = new PacmanBoard(CONFIG, regions, inputs, {
  soundWrite: (off: number, data: number) => wsgWrites.push({ off, data }),
});

const fb = new Uint32Array(288 * 224);
const FRAMES = 5;
for (let i = 0; i < FRAMES; i++) board.frame(fb);

const snap = board.snapshot();

check('main cpu is running (pc in spin loop)', snap.cpus[0].pc >= 0x31 && snap.cpus[0].pc <= 0x33,
  `pc=${snap.cpus[0].pc.toString(16)}`);
check('mainlatch Q0+Q1 set by program', ((snap.mainlatch as number) & 3) === 3,
  `latch=${(snap.mainlatch as number).toString(2)}`);
check('interrupt vector stored via io port 0', snap.irqVector === 0x02, `vector=${snap.irqVector}`);
check('frames advanced', snap.frame === FRAMES, `frame=${snap.frame}`);

const vram = board.shares['videoram'];
const cram = board.shares['colorram'];
check('videoram filled by program', !!vram && vram[0] === 0x55 && vram[0x3f] === 0x55 && vram[0x41] === 0,
  vram ? `vram[0]=${vram[0].toString(16)}` : 'no share');
check('port.IN0 read returned the InputPorts value', !!vram && vram[0x40] === 0x5a,
  vram ? `got=${vram[0x40].toString(16)}` : 'no share');
// exactly once per assertion: a stuck (non-released) irq line would re-enter
// the ISR after every EI/RETI and count thousands per frame
check('vblank IM2 ISR ran exactly once per frame (HOLD_LINE)', !!cram && cram[0] === FRAMES,
  cram ? `count=${cram[0]} want=${FRAMES}` : 'no share');

// sound: waveform write passes through; the volume write made while the
// mainlatch sound-enable (Q1) was still 0 is gated to 0, then replayed with
// the real value when Q1 goes high
const wave = wsgWrites.filter(w => w.off === 0x05);
const vols = wsgWrites.filter(w => w.off === 0x15);
check('wsg waveform write reached the sink', wave.length === 1 && wave[0].data === 7,
  JSON.stringify(wave));
check('volume gated to 0 while sound disabled', vols.length >= 2 && vols[0].data === 0,
  JSON.stringify(vols));
check('volume replayed on sound enable', vols[vols.length - 1].data === 0x0f && snap.soundOn === true,
  JSON.stringify(vols));

check('framebuffer rendered (alpha set on every pixel)', (() => {
  for (let i = 0; i < fb.length; i += 1024) if ((fb[i] >>> 24) !== 0xff) return false;
  return true;
})());

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
