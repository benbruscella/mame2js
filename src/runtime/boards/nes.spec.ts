// Self-test for the NES board wiring — no real ROMs. A hand-assembled NROM
// program proves the full loop: CPU executes from cart PRG, the PPU NMI fires
// each vblank, the NMI handler strobes the controller at $4016 and shifts the
// 8 pad bits back in, then writes the reconstructed byte as the universal
// backdrop color — so a single framebuffer pixel witnesses CPU+PPU+input all
// working. Run with: node src/runtime/boards/nes.spec.ts

import { NesBoard } from './nes.ts';
import { NesPpu, type PpuHost } from '../video/nes-ppu.ts';
import type { BoardConfig, InputPorts, Regions } from '../types.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    totalPass++;
  } else {
    totalFail++;
    console.log(`  FAIL ${label}: got ${a}, want ${e}`);
  }
}

// --- synthetic cart -----------------------------------------------------------
// reset: SEI/CLD, stack, NMI on ($2000=$80), rendering off ($2001=0), spin.
// NMI:   INC $10; strobe pads; read 8 bits of $4016 -> $11 (ROL, so the
//        first-read bit lands in bit 7 — 0xA5 is a bit-reversal palindrome);
//        $3F00 = $11 & $3F; v back to 0; RTI.
const PRG = new Uint8Array(0x4000);
PRG.set([
  0x78, 0xd8, 0xa2, 0xff, 0x9a,             // $8000 SEI CLD LDX #$FF TXS
  0xa9, 0x80, 0x8d, 0x00, 0x20,             // $8005 LDA #$80 STA $2000
  0xa9, 0x00, 0x8d, 0x01, 0x20,             // $800A LDA #$00 STA $2001
  0x4c, 0x0f, 0x80,                         // $800F JMP $800F (spin)
], 0);
PRG.set([
  0xe6, 0x10,                               // $8020 INC $10
  0xa9, 0x01, 0x8d, 0x16, 0x40,             // $8022 LDA #$01 STA $4016
  0xa9, 0x00, 0x8d, 0x16, 0x40,             // $8027 LDA #$00 STA $4016 (latch)
  0xa2, 0x08,                               // $802C LDX #$08
  0xad, 0x16, 0x40,                         // $802E LDA $4016
  0x4a,                                     // $8031 LSR A (bit0 -> C)
  0x26, 0x11,                               // $8032 ROL $11
  0xca,                                     // $8034 DEX
  0xd0, 0xf7,                               // $8035 BNE $802E
  0xa9, 0x3f, 0x8d, 0x06, 0x20,             // $8037 LDA #$3F STA $2006
  0xa9, 0x00, 0x8d, 0x06, 0x20,             // $803C LDA #$00 STA $2006
  0xa5, 0x11, 0x29, 0x3f, 0x8d, 0x07, 0x20, // $8041 LDA $11 AND #$3F STA $2007
  0xa9, 0x00, 0x8d, 0x06, 0x20,             // $8048 LDA #$00 STA $2006
  0x8d, 0x06, 0x20,                         // $804D STA $2006 (v -> 0)
  0x40,                                     // $8050 RTI (also the IRQ vector)
], 0x20);
// vectors (PRG offset $3FFA..): NMI=$8020, RESET=$8000, IRQ=$8050
PRG.set([0x20, 0x80, 0x00, 0x80, 0x50, 0x80], 0x3ffa);

const config = {
  family: 'nes',
  cpus: [{ tag: 'maincpu', type: 'rp2a03', clock: 1789772.6666666667, region: 'maincpu' }],
  ranges: [],
  screen: { width: 256, height: 240, refresh: 60.0988, vtotal: 262, vbstart: 240, vbend: 0, rotate: 0 },
  clocks: { namco06: 0, wsg: 0 },
  cart: { mapper: 0, mirroring: 'vertical' as const },
} as unknown as BoardConfig;

const PAD = 0xa5; // bit-reversal palindrome: reconstructed byte == pad byte
const inputs: InputPorts = { read: (tag: string) => (tag === 'ctrl1:JOYPAD' ? PAD : 0) };

const soundWrites: number[][] = [];
const board = new NesBoard(config, { prg: PRG } as Regions, inputs, {
  soundWrite: (offset, data) => soundWrites.push([offset, data]),
});

const fb = new Uint32Array(256 * 240);

// frame 1: NMI fires at line 241 — after the visible lines — so frame 1 still
// shows backdrop 0; from frame 2 on, the handler has painted $3F00 = $25
board.frame(fb);
const black = fb[0];
board.frame(fb);
board.frame(fb);

// reference: what the PPU renders for backdrop $25 with rendering disabled
const refHost: PpuHost = {
  chrRead: () => 0, chrWrite: () => {}, ntRead: () => 0, ntWrite: () => {}, scanlineTick: () => {},
};
const refPpu = new NesPpu(refHost);
refPpu.writeReg(0x2006, 0x3f); refPpu.writeReg(0x2006, 0x00);
refPpu.writeReg(0x2007, PAD & 0x3f);
refPpu.writeReg(0x2006, 0x00); refPpu.writeReg(0x2006, 0x00);
const refFb = new Uint32Array(256 * 240);
refPpu.renderLine(0, refFb);

eq('cpu parked in spin loop', board.snapshot().cpus[0].pc >= 0x800f && board.snapshot().cpus[0].pc <= 0x8011, true);
eq('cpu not halted', board.snapshot().cpus[0].halted, false);
eq('frame counter', board.snapshot().frame, 3);
eq('backdrop reflects controller byte (cpu+nmi+input+ppu)', fb[0], refFb[0]);
eq('backdrop is not the boot black', fb[0] === black, false);
eq('framebuffer uniform', fb[123 * 256 + 45], fb[0]);
eq('alpha channel set', fb[0] >>> 24, 0xff);

// reset: back to boot state, frame 1 black again
board.reset();
board.frame(fb);
eq('reset -> first frame black again', fb[0], black);
board.frame(fb);
eq('reset -> nmi loop resumes', fb[0], refFb[0]);

console.log(`\nboards/nes.spec: ${totalPass} passed, ${totalFail} failed`);
if (totalFail > 0) process.exitCode = 1;
