// TimepltBoard smoke test: synthetic ROMs with hand-assembled Z80 programs
// exercising the real bus/latch/NMI paths (pattern: boards/pooyan.spec.ts),
// plus the timeplt-specific quirks: the PAIR-addressed mainlatch lambda at
// 0xc300-0xc30f (patched over the parser's `nop`), the scanline_r register,
// and the video-enable gate.
//
//   main program: SP -> videoram/colorram writes -> soundlatch (0xc000 W) ->
//   latch Q2 rising edge via 0xC304 (sound IRQ) -> Q4 via 0xC308 (video
//   enable) -> IN0 read at 0xC300 (must still be a PORT read despite the
//   latch write patch) -> scanline_r read at 0xC000 -> Q0 via 0xC300 (NMI
//   enable) -> spin. The NMI handler (0x66) bumps videoram[5] and re-reads
//   scanline_r into videoram[6] (must be vbstart = 240).
//
//   tpsound program: identical to pooyan.spec.ts (same shared sound board).
//
// Run: node src/runtime/boards/timeplt.spec.ts

import { TimepltBoard } from './timeplt.ts';
import type { BoardConfig, InputPorts } from '../types.ts';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
};

const cfg = JSON.parse(readFileSync(new URL('../../../dist/timeplt/config.json', import.meta.url), 'utf8'));
const config: BoardConfig = cfg.board;

// --- synthetic regions -------------------------------------------------------
const main = new Uint8Array(0x10000);
const snd = new Uint8Array(0x10000);
const regions: Record<string, Uint8Array> = {
  maincpu: main,
  'timeplt_audio:tpsound': snd, // assembleRegions key (subdevice-tagged)
  tiles: new Uint8Array(0x2000),
  sprites: new Uint8Array(0x4000),
  proms: new Uint8Array(0x240),
};

// --- main Z80 program at 0x0000 ---------------------------------------------
let p = 0;
const z = (...bytes: number[]) => { for (const b of bytes) main[p++] = b; };
z(0x31, 0xff, 0xaf);              // LD SP,$AFFF   ; work RAM 0xa800-0xafff
z(0x3e, 0x42);                    // LD A,$42
z(0x32, 0x00, 0xa4);              // LD ($A400),A  ; videoram[0] (videoram_w path)
z(0x3e, 0x07);                    // LD A,$07
z(0x32, 0x00, 0xa0);              // LD ($A000),A  ; colorram[0] (colorram_w path)
z(0x3e, 0x5a);                    // LD A,$5A
z(0x32, 0x00, 0xc0);              // LD ($C000),A  ; soundlatch (sound_data_w)
z(0x3e, 0x01);                    // LD A,$01
z(0x32, 0x04, 0xc3);              // LD ($C304),A  ; latch pair (4>>1)=Q2 rising -> sound IRQ
z(0x32, 0x08, 0xc3);              // LD ($C308),A  ; latch pair (8>>1)=Q4 -> video enable
z(0x32, 0x00, 0xc2);              // LD ($C200),A  ; watchdog reset_w (accepted)
z(0x3a, 0x00, 0xc3);              // LD A,($C300)  ; IN0 READ (not the latch!)
z(0x32, 0x01, 0xa4);              // LD ($A401),A  ; -> videoram[1] (observable share)
z(0x3a, 0x00, 0xc0);              // LD A,($C000)  ; scanline_r
z(0x32, 0x02, 0xa4);              // LD ($A402),A  ; -> videoram[2]
z(0x3e, 0x01);                    // LD A,$01
z(0x32, 0x00, 0xc3);              // LD ($C300),A  ; latch pair (0>>1)=Q0 -> NMI enable
z(0x18, 0xfe);                    // JR *          ; spin

// NMI handler: bump videoram[5], capture scanline_r into videoram[6]
p = 0x66;
z(0xf5);                          // PUSH AF
z(0x21, 0x05, 0xa4);              // LD HL,$A405
z(0x34);                          // INC (HL)      ; videoram[5]++
z(0x3a, 0x00, 0xc0);              // LD A,($C000)  ; scanline_r at vblank
z(0x32, 0x06, 0xa4);              // LD ($A406),A  ; -> videoram[6]
z(0xf1);                          // POP AF
z(0xed, 0x45);                    // RETN

// --- tpsound Z80 program (same shared sound board as pooyan.spec.ts) --------
let q = 0;
const s = (...bytes: number[]) => { for (const b of bytes) snd[q++] = b; };
s(0x31, 0xff, 0x33);              // LD SP,$33FF   ; RAM 0x3000-0x33ff
s(0xed, 0x56);                    // IM 1
s(0xfb);                          // EI
// loop: read AY1 port B (timer) into AY2 reg 1
s(0x3e, 0x0f);                    // LD A,$0F
s(0x32, 0x00, 0x50);              // LD ($5000),A  ; AY1 address = 15 (port B)
s(0x3e, 0x01);                    // LD A,$01
s(0x32, 0x00, 0x70);              // LD ($7000),A  ; AY2 address = 1
s(0x3a, 0x00, 0x40);              // LD A,($4000)  ; AY1 data_r -> timer value
s(0x32, 0x00, 0x60);              // LD ($6000),A  ; AY2 data_w -> sink 0x11
s(0x18, 0xee);                    // JR loop (0x06)
// RST38 ISR: read AY1 port A (= soundlatch) into AY2 reg 0, poke filter_w
q = 0x38;
s(0xf5);                          // PUSH AF
s(0x3e, 0x00);                    // LD A,$00
s(0x32, 0x00, 0x70);              // LD ($7000),A  ; AY2 address = 0
s(0x3e, 0x0e);                    // LD A,$0E
s(0x32, 0x00, 0x50);              // LD ($5000),A  ; AY1 address = 14 (port A)
s(0x3a, 0x00, 0x40);              // LD A,($4000)  ; AY1 data_r -> soundlatch
s(0x32, 0x00, 0x60);              // LD ($6000),A  ; AY2 data_w -> sink 0x10
s(0x32, 0x41, 0x80);              // LD ($8041),A  ; filter_w offset 0x41
s(0xf1);                          // POP AF
s(0xfb);                          // EI
s(0xed, 0x4d);                    // RETI

// --- run ---------------------------------------------------------------------
const idle: InputPorts = { read: () => 0xff };
const writes: [number, number][] = [];
const board = new TimepltBoard(config, regions, idle, {
  soundWrite: (off, d) => writes.push([off, d]),
});

const fb = new Uint32Array(board.fbWidth * board.fbHeight);
const FRAMES = 5;
for (let i = 0; i < FRAMES; i++) board.frame(fb);

const snap = board.snapshot() as ReturnType<TimepltBoard['snapshot']>;
const videoram = board.shares['videoram'];
const colorram = board.shares['colorram'];

check('framebuffer sized 256x224 native', board.fbWidth === 256 && board.fbHeight === 224);
check('videoram write stored through videoram_w', !!videoram && videoram[0] === 0x42);
check('colorram write stored through colorram_w', !!colorram && colorram[0] === 0x07);
check(`NMI handler ran once per frame while Q0 enabled (${videoram?.[5]}/${FRAMES})`,
  !!videoram && videoram[5] === FRAMES);
check('main parked in spin loop', snap.cpus[0].pc >= 0x0000 && snap.cpus[0].pc < 0x66);
check('latch pairs decoded: Q0 (0xC300 W) + Q2 (0xC304) + Q4 (0xC308) set',
  snap.mainlatch === 0b00010101);
check('nmiEnable latched from Q0 (pair address 0xC300)', snap.nmiEnable === 1);
check('videoEnable latched from Q4 (pair address 0xC308)', snap.videoEnable === 1);
check('IN0 read at 0xC300 still hits the PORT handler (idle 0xff), not the latch',
  !!videoram && videoram[1] === 0xff);
check('scanline_r returns the current line (< vtotal)',
  !!videoram && videoram[2]! < config.screen.vtotal);
check(`scanline_r inside the NMI handler reads vbstart (${videoram?.[6]} = 240)`,
  !!videoram && videoram[6] === 240);
check('soundlatch delivered (sound_data_w at 0xC000)', snap.soundlatch === 0x5a);
check('sound Z80 parked in its polling loop', snap.cpus[1].pc >= 0x06 && snap.cpus[1].pc < 0x18);

// sound IRQ chain: Q2 rising edge -> IM1 RST38 -> AY1 port A (= soundlatch)
// forwarded into AY2 reg 0 -> soundWrite sink offset 0x10 with 0x5A
check('Q2 trigger took the IM1 IRQ: soundlatch read back through AY1 port A',
  writes.some(([o, d]) => o === 0x10 && d === 0x5a));

// timer: AY1 port B values (relayed into AY2 reg 1 = sink offset 0x11)
const timerValues = new Set(writes.filter(([o]) => o === 0x11).map(([, d]) => d));
check(`timer table advances over time (${timerValues.size} distinct values)`, timerValues.size >= 3);
const TIMER_TABLE = new Set([0x00, 0x10, 0x20, 0x30, 0x40, 0x90, 0xa0, 0xb0, 0xd0]);
check('timer values all come from the timeplt table',
  [...timerValues].every(v => TIMER_TABLE.has(v)));

// filter_w offset 0x41 -> worklet byte 0x02 on both chips (see pooyan.spec)
check('filter_w forwarded to worklet chip 0 (0x90)', writes.some(([o, d]) => o === 0x90 && d === 0x02));
check('filter_w forwarded to worklet chip 1 (0x91)', writes.some(([o, d]) => o === 0x91 && d === 0x02));

check('framebuffer rendered with opaque alpha',
  (fb[0] >>> 24) === 0xff && (fb[fb.length - 1] >>> 24) === 0xff);

console.log(fail ? `\n${fail} of ${pass + fail} FAILED` : `\nALL PASS (${pass} checks)`);
process.exitCode = fail ? 1 : 0;
