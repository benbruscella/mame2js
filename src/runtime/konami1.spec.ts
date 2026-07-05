// Self-test for the KONAMI-1 decryption wrapper. Run with:
//   node src/runtime/konami1.spec.ts
// Verifies the opcode XOR transform ported from MAME konami1.cpp (lines
// 62-74): hand-encrypts instruction bytes and checks execution matches the
// plain 6809, that operands/data/vectors are NOT transformed, and that the
// encryption boundary is honored.

import { M6809, type M6809Bus } from './m6809.ts';
import { Konami1, konami1Decrypt } from './konami1.ts';

class TestBus implements M6809Bus {
  mem = new Uint8Array(0x10000);
  read(addr: number): number {
    return this.mem[addr];
  }
  write(addr: number, data: number): void {
    this.mem[addr] = data;
  }
}

// ---------------------------------------------------------------- harness

let sectionName = '';
let sectionFail = 0;
let totalPass = 0;
let totalFail = 0;
const failedSections: string[] = [];

function section(name: string): void {
  endSection();
  sectionName = name;
  sectionFail = 0;
}

function endSection(): void {
  if (sectionName !== '') {
    if (sectionFail === 0) console.log(`PASS  ${sectionName}`);
    else {
      console.log(`FAIL  ${sectionName} (${sectionFail} failing checks)`);
      failedSections.push(sectionName);
    }
  }
  sectionName = '';
}

function eq(label: string, actual: number | boolean, expected: number | boolean): void {
  if (actual === expected) {
    totalPass++;
  } else {
    totalFail++;
    sectionFail++;
    const fmt = (v: number | boolean) =>
      typeof v === 'number' ? '0x' + v.toString(16) : String(v);
    console.log(`  FAIL ${sectionName}: ${label}: got ${fmt(actual)}, want ${fmt(expected)}`);
  }
}

// ================================================================ 1. transform table

section('transform: XOR mask per address bits 1/3');
{
  // konami1.cpp: switch (adr & 0xa) { 0x0:^0x22  0x2:^0x82  0x8:^0x28  0xa:^0x88 }
  eq('adr&0xa=0 -> ^22', konami1Decrypt(0x0000, 0x00), 0x22);
  eq('adr&0xa=2 -> ^82', konami1Decrypt(0x0002, 0x00), 0x82);
  eq('adr&0xa=8 -> ^28', konami1Decrypt(0x0008, 0x00), 0x28);
  eq('adr&0xa=a -> ^88', konami1Decrypt(0x000a, 0x00), 0x88);
  // only address bits 1 and 3 participate
  eq('bits 0/2 ignored', konami1Decrypt(0x0005, 0x00), 0x22);
  eq('high bits ignored', konami1Decrypt(0xf7f4, 0x00), 0x22);
  eq('0x1236 -> ^82', konami1Decrypt(0x1236, 0x00), 0x82);
  eq('0x2718 -> ^28', konami1Decrypt(0x2718, 0x00), 0x28);
  eq('0x3ffe -> ^88', konami1Decrypt(0x3ffe, 0x00), 0x88);
  // sample real decryptions
  eq('decrypt value', konami1Decrypt(0x1000, 0x86 ^ 0x22), 0x86);
  eq('decrypt value 2', konami1Decrypt(0x100b, 0x30 ^ 0x88), 0x30);
}

section('transform is an involution (encrypt == decrypt)');
{
  let ok = true;
  for (let addr = 0; addr < 16; addr++) {
    for (const b of [0x00, 0x12, 0x86, 0xff, 0x55, 0xaa]) {
      if (konami1Decrypt(addr, konami1Decrypt(addr, b)) !== b) ok = false;
    }
  }
  eq('decrypt(decrypt(b)) == b', ok, true);
}

// ================================================================ 2. execution matches plain 6809

// Program exercising all four XOR masks on opcode fetches, including a
// $10-prefixed instruction (prefix AND following opcode byte are both
// M1-style fetches and must both be decrypted).
const ORG = 0x1000;
const PROGRAM: { bytes: number[]; opcodeOffsets: number[] } = {
  bytes: [
    0x86, 0x55, //       0x1000: LDA #$55        (opcode addr &0xa = 0 -> ^22)
    0x8e, 0x20, 0x00, // 0x1002: LDX #$2000      (&0xa = 2 -> ^82)
    0xa7, 0x84, //       0x1005: STA ,X          (&0xa = 0)
    0x10, 0x8e, 0x12, 0x34, // 0x1007: LDY #$1234 (prefix &0xa=2, opcode at 0x1008 &0xa=8 -> ^28)
    0x30, 0x1f, //       0x100b: LEAX -1,X       (&0xa = a -> ^88)
    0x3a, //             0x100d: ABX             (&0xa = 8)
    0x12, //             0x100e: NOP             (&0xa = a)
  ],
  opcodeOffsets: [0x0, 0x2, 0x5, 0x7, 0x8, 0xb, 0xd, 0xe],
};

function setVector(bus: TestBus, org: number): void {
  bus.mem[0xfffe] = (org >> 8) & 0xff; // vectors are data reads: stored PLAIN
  bus.mem[0xffff] = org & 0xff;
}

{
  section('encrypted execution == plain execution');
  // plain CPU on plain bytes
  const plainBus = new TestBus();
  setVector(plainBus, ORG);
  plainBus.mem.set(PROGRAM.bytes, ORG);
  const plain = new M6809(plainBus);

  // KONAMI-1 on bytes with ONLY the opcode fetch positions encrypted
  const encBus = new TestBus();
  setVector(encBus, ORG);
  encBus.mem.set(PROGRAM.bytes, ORG);
  for (const off of PROGRAM.opcodeOffsets) {
    const addr = ORG + off;
    encBus.mem[addr] = konami1Decrypt(addr, encBus.mem[addr]); // involution: this encrypts
  }
  const kcpu = new Konami1(encBus);

  eq('reset vector not decrypted', kcpu.pc, ORG);
  for (let i = 0; i < 7; i++) {
    const cp = plain.step();
    const ck = kcpu.step();
    eq(`step ${i} cycles match`, ck, cp);
  }
  eq('A matches', kcpu.a, plain.a);
  eq('A value', kcpu.a, 0x55);
  eq('X matches', kcpu.x, plain.x);
  eq('X value', kcpu.x, 0x1fff); // 0x2000 - 1 + B(0)
  eq('Y matches', kcpu.y, plain.y);
  eq('Y value (prefixed op decrypted)', kcpu.y, 0x1234);
  eq('PC matches', kcpu.pc, plain.pc);
  eq('PC value', kcpu.pc, ORG + 0xf);
  eq('memory write matches', encBus.mem[0x2000], plainBus.mem[0x2000]);
  eq('memory write value', encBus.mem[0x2000], 0x55);
}

// ================================================================ 3. operands and data are NOT transformed

section('operands/data not transformed');
{
  // LDA #$22 with the operand at an address where a (wrong) transform would
  // XOR with 0x22 and turn it into 0x00.
  const bus = new TestBus();
  setVector(bus, ORG);
  bus.mem[ORG] = konami1Decrypt(ORG, 0x86); // LDA # (encrypted opcode)
  bus.mem[ORG + 1] = 0x22; // operand stored PLAIN (0x1001 & 0xa = 0)
  const cpu = new Konami1(bus);
  cpu.step();
  eq('immediate operand raw', cpu.a, 0x22);
}
{
  // Data read: byte 0x88 at $2008 ((&0xa)=8) would read 0xA0 if data were
  // wrongly decrypted.
  const bus = new TestBus();
  setVector(bus, ORG);
  bus.mem[ORG] = konami1Decrypt(ORG, 0xb6); // LDA $2008
  bus.mem[ORG + 1] = 0x20;
  bus.mem[ORG + 2] = 0x08;
  bus.mem[0x2008] = 0x88;
  const cpu = new Konami1(bus);
  cpu.step();
  eq('extended data read raw', cpu.a, 0x88);
}
{
  // Writes are never transformed either.
  const bus = new TestBus();
  setVector(bus, ORG);
  bus.mem[ORG] = konami1Decrypt(ORG, 0x86); // LDA #$88
  bus.mem[ORG + 1] = 0x88;
  bus.mem[ORG + 2] = konami1Decrypt(ORG + 2, 0xb7); // STA $200A
  bus.mem[ORG + 3] = 0x20;
  bus.mem[ORG + 4] = 0x0a;
  const cpu = new Konami1(bus);
  cpu.step();
  cpu.step();
  eq('write raw', bus.mem[0x200a], 0x88);
}
{
  // Interrupt vector fetch is a data read: stored plain, even at an
  // address whose transform would mangle it (0xfff8 & 0xa = 8).
  const bus = new TestBus();
  setVector(bus, ORG);
  bus.mem[ORG] = konami1Decrypt(ORG, 0x12); // NOP
  bus.mem[0xfff8] = 0x30;
  bus.mem[0xfff9] = 0x00;
  bus.mem[0x3000] = konami1Decrypt(0x3000, 0x12); // NOP at handler
  const cpu = new Konami1(bus);
  cpu.s = 0x8000;
  cpu.cc &= ~0x10; // enable IRQ
  cpu.setIrqLine(true);
  cpu.step();
  eq('IRQ vector read raw', cpu.pc, 0x3000);
  cpu.setIrqLine(false);
  cpu.step(); // encrypted NOP at handler executes fine
  eq('handler opcode decrypted', cpu.pc, 0x3001);
}

// ================================================================ 4. encryption boundary

section('encryption boundary');
{
  // Below the boundary opcodes pass through unchanged; above they are
  // decrypted (konami1_device::set_encryption_boundary).
  const bus = new TestBus();
  setVector(bus, ORG);
  // plain code below boundary $2000
  bus.mem.set([0x86, 0x11, 0x7e, 0x30, 0x00], ORG); // LDA #$11 / JMP $3000
  // encrypted code above the boundary
  bus.mem[0x3000] = konami1Decrypt(0x3000, 0xc6); // LDB #$22
  bus.mem[0x3001] = 0x22;
  bus.mem[0x3002] = konami1Decrypt(0x3002, 0x12); // NOP
  const cpu = new Konami1(bus, 0x2000);
  cpu.step();
  eq('below boundary: plain opcode', cpu.a, 0x11);
  cpu.step();
  eq('JMP below boundary', cpu.pc, 0x3000);
  cpu.step();
  eq('above boundary: decrypted opcode', cpu.b, 0x22);
  cpu.step();
  eq('above boundary NOP', cpu.pc, 0x3003);
}
{
  // Default boundary is $0000: everything decrypted (Gyruss config).
  const bus = new TestBus();
  setVector(bus, 0x0004);
  bus.mem[0x0004] = konami1Decrypt(0x0004, 0x86); // LDA #$77 at low address
  bus.mem[0x0005] = 0x77;
  const cpu = new Konami1(bus);
  cpu.step();
  eq('default boundary decrypts at $0004', cpu.a, 0x77);
}

// ================================================================ summary

endSection();
console.log('');
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`FAILURES: ${totalFail} of ${totalPass + totalFail} checks failed`);
  console.log(`Failing sections: ${failedSections.join(', ')}`);
  process.exitCode = 1;
}
