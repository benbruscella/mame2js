// Self-test for the Intel 8080 core. Run with: node src/runtime/i8080.spec.ts
// No test framework; prints PASS/FAIL per section and sets process.exitCode.
//
// Expected flag bytes are hand-computed from the 8080 flag layout
// S Z 0 AC 0 P 1 C (bit 1 always set, bits 3/5 always clear, P = parity),
// cross-checked against MAME src/devices/cpu/i8085/i8085.cpp in 8080 mode.

import { I8080, type I8080Bus } from './i8080.ts';

// Flag bits (duplicated here on purpose; do not import internals)
const CF = 0x01;
const BIT1 = 0x02; // always set on the 8080
const PF = 0x04;
const HF = 0x10;
const ZF = 0x40;
const SF = 0x80;

class TestBus implements I8080Bus {
  mem = new Uint8Array(0x10000);
  ioIn = new Uint8Array(0x100);
  ioLog: { port: number; data: number }[] = [];
  read(addr: number): number {
    return this.mem[addr];
  }
  write(addr: number, data: number): void {
    this.mem[addr] = data;
  }
  in(port: number): number {
    return this.ioIn[port & 0xff];
  }
  out(port: number, data: number): void {
    this.ioLog.push({ port: port & 0xff, data: data & 0xff });
  }
}

function makeCpu(program: number[], org = 0): { cpu: I8080; bus: TestBus } {
  const bus = new TestBus();
  bus.mem.set(program, org);
  const cpu = new I8080(bus);
  cpu.pc = org;
  cpu.sp = 0xff00;
  return { cpu, bus };
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

// ================================================================ 1. MOV / MVI

section('MVI and MOV matrix');
{
  // MVI A,12 / MOV B,A / MOV C,B / MOV D,C / MOV E,D / MOV H,E / MOV L,H
  const { cpu } = makeCpu([0x3e, 0x12, 0x47, 0x48, 0x51, 0x5a, 0x63, 0x6c]);
  for (let i = 0; i < 8; i++) cpu.step();
  eq('MOV chain A', cpu.a, 0x12);
  eq('MOV chain B', cpu.b, 0x12);
  eq('MOV chain C', cpu.c, 0x12);
  eq('MOV chain D', cpu.d, 0x12);
  eq('MOV chain E', cpu.e, 0x12);
  eq('MOV chain H', cpu.h, 0x12);
  eq('MOV chain L', cpu.l, 0x12);
  eq('MOV leaves flags', cpu.f, BIT1);
}
{
  const { cpu, bus } = makeCpu([0x26, 0x40, 0x2e, 0x00, 0x36, 0x77, 0x7e, 0x70]);
  cpu.step(); // MVI H,40
  cpu.step(); // MVI L,00
  cpu.step(); // MVI M,77
  eq('MVI M', bus.mem[0x4000], 0x77);
  cpu.step(); // MOV A,M
  eq('MOV A,M', cpu.a, 0x77);
  cpu.b = 0x99;
  cpu.step(); // MOV M,B
  eq('MOV M,B', bus.mem[0x4000], 0x99);
}

// ================================================================ 2. ALU flag matrix (8080 parity/AC, NOT Z80)

section('ADD/ADC: parity not overflow, AC from bit 3 carry');
{
  const { cpu } = makeCpu([0x3e, 0x44, 0xc6, 0x11]); // MVI A,44 / ADI 11
  cpu.step();
  cpu.step();
  eq('ADI result', cpu.a, 0x55);
  eq('ADI flags (P=parity even)', cpu.f, PF | BIT1);
}
{
  // 0x7f+1 = 0x80: Z80 sets V (0x04); 8080 P = parity(0x80) = odd = CLEAR
  const { cpu } = makeCpu([0x3e, 0x7f, 0xc6, 0x01]);
  cpu.step();
  cpu.step();
  eq('ADI 7f+01 result', cpu.a, 0x80);
  eq('ADI 7f+01 flags (no overflow bit!)', cpu.f, SF | HF | BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0xff, 0xc6, 0x01]);
  cpu.step();
  cpu.step();
  eq('ADI carry result', cpu.a, 0x00);
  eq('ADI carry flags', cpu.f, ZF | HF | PF | CF | BIT1);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0x00, 0xce, 0x00]); // STC / MVI A,0 / ACI 0
  cpu.step();
  cpu.step();
  cpu.step();
  eq('ACI uses carry', cpu.a, 0x01);
  eq('ACI flags', cpu.f, BIT1);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0x7f, 0xce, 0x00]); // STC / MVI A,7f / ACI 0
  cpu.step();
  cpu.step();
  cpu.step();
  eq('ACI 7f+0+C result', cpu.a, 0x80);
  eq('ACI 7f+0+C flags', cpu.f, SF | HF | BIT1);
}

section('SUB/SBB/CMP: 8080 inverted-borrow AC convention');
{
  // A-A = 0: borrow out of bit 3 did NOT happen -> AC SET (Z80 clears H here)
  const { cpu } = makeCpu([0x3e, 0x3e, 0xd6, 0x3e]);
  cpu.step();
  cpu.step();
  eq('SUI equal result', cpu.a, 0x00);
  eq('SUI equal flags (AC set!)', cpu.f, ZF | PF | HF | BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0x00, 0xd6, 0x01]); // 0 - 1
  cpu.step();
  cpu.step();
  eq('SUI borrow result', cpu.a, 0xff);
  eq('SUI borrow flags (AC clear)', cpu.f, SF | PF | CF | BIT1);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0x10, 0xde, 0x01]); // STC / MVI A,10 / SBI 1
  cpu.step();
  cpu.step();
  cpu.step();
  eq('SBI result', cpu.a, 0x0e);
  eq('SBI flags', cpu.f, BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0x02, 0xfe, 0x05]); // CPI 5 with A=2
  cpu.step();
  cpu.step();
  eq('CPI leaves A', cpu.a, 0x02);
  eq('CPI less-than flags', cpu.f, SF | CF | BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0x05, 0xfe, 0x05]);
  cpu.step();
  cpu.step();
  eq('CPI equal flags', cpu.f, ZF | PF | HF | BIT1);
}
{
  // 0x80 - 1 = 0x7f: Z80 sets V; 8080 P = parity(0x7f) = odd = clear
  const { cpu } = makeCpu([0x3e, 0x80, 0xfe, 0x01]);
  cpu.step();
  cpu.step();
  eq('CPI 80-01 flags (no overflow bit)', cpu.f, BIT1);
}

section('ANA/XRA/ORA: AC from OR of bit 3 (ANA), cleared otherwise');
{
  // ANA: AC = bit3(A) | bit3(v) = bit3(0xf0)|bit3(0x8f) = 0|1 = 1
  const { cpu } = makeCpu([0x3e, 0xf0, 0xe6, 0x8f]);
  cpu.step();
  cpu.step();
  eq('ANI result', cpu.a, 0x80);
  eq('ANI flags (AC = or of bit3)', cpu.f, SF | HF | BIT1);
}
{
  // both operands have bit 3 clear -> AC clear
  const { cpu } = makeCpu([0x3e, 0x11, 0xe6, 0x22]);
  cpu.step();
  cpu.step();
  eq('ANI no-bit3 result', cpu.a, 0x00);
  eq('ANI no-bit3 flags (AC clear)', cpu.f, ZF | PF | BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0xff, 0xee, 0xff]);
  cpu.step();
  cpu.step();
  eq('XRI result', cpu.a, 0x00);
  eq('XRI flags', cpu.f, ZF | PF | BIT1);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0xf0, 0xf6, 0x0f]); // STC first: ORA clears C
  cpu.step();
  cpu.step();
  cpu.step();
  eq('ORI result', cpu.a, 0xff);
  eq('ORI clears C and AC', cpu.f, SF | PF | BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0x00, 0xf6, 0x00]);
  cpu.step();
  cpu.step();
  eq('ORI zero flags', cpu.f, ZF | PF | BIT1);
}
{
  // register forms through the ALU block
  const { cpu } = makeCpu([0x80, 0x90, 0xa8]); // ADD B / SUB B / XRA B
  cpu.a = 0x01;
  cpu.b = 0x01;
  cpu.step();
  eq('ADD B', cpu.a, 0x02);
  cpu.step();
  eq('SUB B', cpu.a, 0x01);
  cpu.step();
  eq('XRA B', cpu.a, 0x00);
  eq('XRA B flags', cpu.f, ZF | PF | BIT1);
}
{
  const { cpu, bus } = makeCpu([0x86, 0xbe]); // ADD M / CMP M
  cpu.h = 0x40;
  cpu.l = 0x00;
  bus.mem[0x4000] = 0x22;
  cpu.a = 0x11;
  cpu.step();
  eq('ADD M', cpu.a, 0x33);
  cpu.step();
  eq('CMP M leaves A', cpu.a, 0x33);
  eq('CMP M flags (33>22)', cpu.f, PF | HF | BIT1); // 0x11: parity even, no borrow
}

section('INR/DCR: carry untouched, 8080 AC');
{
  const { cpu } = makeCpu([0x37, 0x06, 0x0f, 0x04]); // STC / MVI B,0f / INR B
  cpu.step();
  cpu.step();
  cpu.step();
  eq('INR 0f result', cpu.b, 0x10);
  eq('INR 0f flags (AC, C preserved)', cpu.f, CF | HF | BIT1);
}
{
  const { cpu } = makeCpu([0x06, 0xff, 0x04]);
  cpu.step();
  cpu.step();
  eq('INR ff result', cpu.b, 0x00);
  eq('INR ff flags', cpu.f, ZF | PF | HF | BIT1);
}
{
  // DCR 0x10 -> 0x0f: Z80 sets H (borrow); 8080 AC = no-borrow = CLEAR
  const { cpu } = makeCpu([0x06, 0x10, 0x05]);
  cpu.step();
  cpu.step();
  eq('DCR 10 result', cpu.b, 0x0f);
  eq('DCR 10 flags (AC clear!)', cpu.f, PF | BIT1);
}
{
  const { cpu } = makeCpu([0x06, 0x00, 0x05]);
  cpu.step();
  cpu.step();
  eq('DCR 00 result', cpu.b, 0xff);
  eq('DCR 00 flags', cpu.f, SF | PF | BIT1);
}
{
  const { cpu } = makeCpu([0x06, 0x01, 0x05]);
  cpu.step();
  cpu.step();
  eq('DCR 01 flags (AC set: no nibble borrow)', cpu.f, ZF | PF | HF | BIT1);
}
{
  const { cpu, bus } = makeCpu([0x34, 0x35]); // INR M / DCR M
  cpu.h = 0x40;
  cpu.l = 0x00;
  bus.mem[0x4000] = 0x41;
  cpu.step();
  eq('INR M', bus.mem[0x4000], 0x42);
  cpu.step();
  eq('DCR M', bus.mem[0x4000], 0x41);
}

section('DAD: only carry, others preserved');
{
  const { cpu } = makeCpu([0x19]); // DAD D
  cpu.h = 0x0f;
  cpu.l = 0xff;
  cpu.d = 0x00;
  cpu.e = 0x01;
  cpu.f = SF | ZF | HF | PF | CF | BIT1; // 0xd7
  cpu.step();
  eq('DAD result', (cpu.h << 8) | cpu.l, 0x1000);
  eq('DAD clears only C', cpu.f, SF | ZF | HF | PF | BIT1);
}
{
  const { cpu } = makeCpu([0x39]); // DAD SP
  cpu.h = 0xff;
  cpu.l = 0xff;
  cpu.sp = 0x0001;
  cpu.step();
  eq('DAD carry result', (cpu.h << 8) | cpu.l, 0x0000);
  eq('DAD sets C', cpu.f & CF, CF);
}
{
  const { cpu } = makeCpu([0x29]); // DAD H (double)
  cpu.h = 0x12;
  cpu.l = 0x34;
  cpu.step();
  eq('DAD H doubles', (cpu.h << 8) | cpu.l, 0x2468);
}

// ================================================================ 3. DAA (8080: always adds, sticky carry)

section('DAA battery');
{
  const { cpu } = makeCpu([0x3e, 0x15, 0xc6, 0x27, 0x27]); // 15+27=3c, DAA -> 42
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA add result', cpu.a, 0x42);
  eq('DAA add flags', cpu.f, HF | PF | BIT1);
}
{
  const { cpu } = makeCpu([0x3e, 0x99, 0xc6, 0x01, 0x27]); // 99+01=9a, DAA -> 00 C=1
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA wrap result', cpu.a, 0x00);
  eq('DAA wrap flags', cpu.f, ZF | PF | HF | CF | BIT1);
}
{
  // After SUB the 8080 STILL ADDS the correction (no N flag).
  // 05 - 06 = ff (C=1); DAA: +6 +60 -> 65. A Z80 would subtract -> 0x99.
  const { cpu } = makeCpu([0x3e, 0x05, 0xd6, 0x06, 0x27]);
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA after SUB adds (8080!)', cpu.a, 0x65);
  eq('DAA after SUB flags', cpu.f, HF | PF | CF | BIT1);
}
{
  // sticky carry: C=1 with A=0 -> +60, C stays set
  const { cpu } = makeCpu([0x37, 0x3e, 0x00, 0x27]);
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA sticky-carry result', cpu.a, 0x60);
  eq('DAA sticky-carry flags', cpu.f, PF | CF | BIT1);
}

section('DAA exhaustive (256 values x C x AC)');
{
  // Independent reference from the 8080 DAA truth table (MAME op 0x27):
  // +06 if AC or lo>9; +60 if C or A>0x99; C_out = C_in | (A>0x99);
  // AC_out = bit4 toggled by the correction; P = parity of result.
  const daaRef = (a: number, c: number, h: number): { a: number; f: number } => {
    let res = a;
    if (h !== 0 || (a & 0x0f) > 9) res += 0x06;
    const cOut = c !== 0 || a > 0x99 ? CF : 0;
    if (cOut !== 0) res += 0x60;
    res &= 0xff;
    let bits = 0;
    for (let k = 0; k < 8; k++) if ((res >> k) & 1) bits++;
    const f =
      (res & SF) |
      (res === 0 ? ZF : 0) |
      ((a ^ res) & HF) |
      (bits % 2 === 0 ? PF : 0) |
      cOut |
      BIT1;
    return { a: res, f };
  };

  const bus = new TestBus();
  bus.mem[0] = 0x27; // DAA
  const cpu = new I8080(bus);
  let bad = 0;
  for (let a = 0; a < 256; a++) {
    for (let flags = 0; flags < 4; flags++) {
      const c = flags & 1;
      const h = (flags >> 1) & 1;
      cpu.pc = 0;
      cpu.a = a;
      cpu.f = (c !== 0 ? CF : 0) | (h !== 0 ? HF : 0) | BIT1;
      cpu.step();
      const ref = daaRef(a, c, h);
      if (cpu.a !== ref.a || cpu.f !== ref.f) {
        bad++;
        if (bad <= 5) {
          eq(
            `DAA a=${a.toString(16)} c=${c} h=${h}`,
            (cpu.a << 8) | cpu.f,
            (ref.a << 8) | ref.f
          );
        }
      }
    }
  }
  eq('DAA mismatches', bad, 0);
}

// ================================================================ 4. rotates, STC/CMC/CMA

section('RLC/RRC/RAL/RAR carry chains');
{
  const { cpu } = makeCpu([0x07, 0x07]); // RLC twice
  cpu.a = 0x81;
  cpu.step();
  eq('RLC result', cpu.a, 0x03);
  eq('RLC carry', cpu.f, CF | BIT1);
  cpu.step();
  eq('RLC again result', cpu.a, 0x06);
  eq('RLC again clears C', cpu.f, BIT1);
}
{
  const { cpu } = makeCpu([0x0f]); // RRC
  cpu.a = 0x01;
  cpu.step();
  eq('RRC result', cpu.a, 0x80);
  eq('RRC carry', cpu.f, CF | BIT1);
}
{
  const { cpu } = makeCpu([0x37, 0x17]); // STC / RAL: carry rotates in, bit7 out
  cpu.a = 0x80;
  cpu.step();
  cpu.step();
  eq('RAL result (C in at bit0)', cpu.a, 0x01);
  eq('RAL carry (old bit7)', cpu.f, CF | BIT1);
}
{
  const { cpu } = makeCpu([0x37, 0x1f]); // STC / RAR
  cpu.a = 0x00;
  cpu.step();
  cpu.step();
  eq('RAR result (C in at bit7)', cpu.a, 0x80);
  eq('RAR carry (old bit0)', cpu.f, BIT1);
}
{
  const { cpu } = makeCpu([0x07]); // rotates preserve S/Z/AC/P
  cpu.a = 0x00;
  cpu.f = SF | ZF | HF | PF | CF | BIT1;
  cpu.step();
  eq('RLC preserves SZHP', cpu.f, SF | ZF | HF | PF | BIT1);
}

section('STC/CMC/CMA');
{
  const { cpu } = makeCpu([0x37, 0x3f, 0x3f]);
  cpu.step();
  eq('STC', cpu.f, CF | BIT1);
  cpu.step();
  eq('CMC clears', cpu.f, BIT1);
  cpu.step();
  eq('CMC sets', cpu.f, CF | BIT1);
}
{
  const { cpu } = makeCpu([0x2f]); // CMA: NO flags on the 8080
  cpu.a = 0x55;
  cpu.f = ZF | PF | HF | CF | BIT1;
  cpu.step();
  eq('CMA result', cpu.a, 0xaa);
  eq('CMA touches no flags', cpu.f, ZF | PF | HF | CF | BIT1);
}

// ================================================================ 5. 16-bit loads/moves

section('LXI/INX/DCX/SHLD/LHLD/STA/LDA/STAX/LDAX');
{
  const { cpu } = makeCpu([0x01, 0x34, 0x12, 0x11, 0x78, 0x56, 0x21, 0xbc, 0x9a, 0x31, 0xf0, 0xde]);
  cpu.step();
  cpu.step();
  cpu.step();
  cpu.step();
  eq('LXI B', (cpu.b << 8) | cpu.c, 0x1234);
  eq('LXI D', (cpu.d << 8) | cpu.e, 0x5678);
  eq('LXI H', (cpu.h << 8) | cpu.l, 0x9abc);
  eq('LXI SP', cpu.sp, 0xdef0);
}
{
  const { cpu } = makeCpu([0x03, 0x0b]); // INX B / DCX B
  cpu.b = 0x00;
  cpu.c = 0xff;
  cpu.f = SF | ZF | HF | PF | CF | BIT1;
  cpu.step();
  eq('INX B', (cpu.b << 8) | cpu.c, 0x0100);
  cpu.step();
  eq('DCX B back down', (cpu.b << 8) | cpu.c, 0x00ff);
  eq('INX/DCX touch no flags', cpu.f, SF | ZF | HF | PF | CF | BIT1);
}
{
  const { cpu } = makeCpu([0x1b]); // DCX D through zero
  cpu.d = 0;
  cpu.e = 0;
  cpu.step();
  eq('DCX D underflow', (cpu.d << 8) | cpu.e, 0xffff);
}
{
  const { cpu, bus } = makeCpu([0x22, 0x00, 0x60, 0x2a, 0x02, 0x60]); // SHLD / LHLD
  cpu.h = 0x12;
  cpu.l = 0x34;
  bus.mem[0x6002] = 0x78;
  bus.mem[0x6003] = 0x56;
  cpu.step();
  eq('SHLD lo', bus.mem[0x6000], 0x34);
  eq('SHLD hi', bus.mem[0x6001], 0x12);
  cpu.step();
  eq('LHLD', (cpu.h << 8) | cpu.l, 0x5678);
}
{
  const { cpu, bus } = makeCpu([0x32, 0x00, 0x60, 0x3a, 0x00, 0x60]); // STA / LDA
  cpu.a = 0x77;
  cpu.step();
  eq('STA', bus.mem[0x6000], 0x77);
  cpu.a = 0;
  cpu.step();
  eq('LDA', cpu.a, 0x77);
}
{
  const { cpu, bus } = makeCpu([0x02, 0x1a]); // STAX B / LDAX D
  cpu.a = 0x5a;
  cpu.b = 0x40;
  cpu.c = 0x01;
  cpu.d = 0x40;
  cpu.e = 0x02;
  bus.mem[0x4002] = 0xa5;
  cpu.step();
  eq('STAX B', bus.mem[0x4001], 0x5a);
  cpu.step();
  eq('LDAX D', cpu.a, 0xa5);
}

section('XCHG/XTHL/SPHL/PCHL');
{
  const { cpu } = makeCpu([0xeb]);
  cpu.d = 0x12;
  cpu.e = 0x34;
  cpu.h = 0x56;
  cpu.l = 0x78;
  cpu.step();
  eq('XCHG de', (cpu.d << 8) | cpu.e, 0x5678);
  eq('XCHG hl', (cpu.h << 8) | cpu.l, 0x1234);
}
{
  const { cpu, bus } = makeCpu([0xe3]); // XTHL
  cpu.sp = 0x8000;
  bus.mem[0x8000] = 0x34;
  bus.mem[0x8001] = 0x12;
  cpu.h = 0xab;
  cpu.l = 0xcd;
  cpu.step();
  eq('XTHL hl', (cpu.h << 8) | cpu.l, 0x1234);
  eq('XTHL mem lo', bus.mem[0x8000], 0xcd);
  eq('XTHL mem hi', bus.mem[0x8001], 0xab);
  eq('XTHL sp unchanged', cpu.sp, 0x8000);
}
{
  const { cpu } = makeCpu([0xf9, 0xe9]); // SPHL / PCHL
  cpu.h = 0x43;
  cpu.l = 0x21;
  cpu.step();
  eq('SPHL', cpu.sp, 0x4321);
  cpu.step();
  eq('PCHL', cpu.pc, 0x4321);
}

// ================================================================ 6. stack + PSW normalization

section('PUSH/POP and PSW flag-image normalization');
{
  const { cpu, bus } = makeCpu([0x01, 0x34, 0x12, 0xc5, 0xd1]); // LXI B / PUSH B / POP D
  cpu.step();
  cpu.step();
  eq('PUSH sp', cpu.sp, 0xfefe);
  eq('PUSH mem hi', bus.mem[0xfeff], 0x12);
  eq('PUSH mem lo', bus.mem[0xfefe], 0x34);
  cpu.step();
  eq('POP D', (cpu.d << 8) | cpu.e, 0x1234);
  eq('POP sp', cpu.sp, 0xff00);
}
{
  // PUSH PSW: bits 3/5 forced clear, bit 1 forced set (MAME op 0xf5)
  const { cpu, bus } = makeCpu([0xf5]);
  cpu.a = 0x9a;
  cpu.f = 0xff; // deliberately corrupt the fixed bits
  cpu.step();
  eq('PUSH PSW A', bus.mem[0xfeff], 0x9a);
  eq('PUSH PSW F normalized', bus.mem[0xfefe], 0xd7);
}
{
  const { cpu, bus } = makeCpu([0xf1, 0xf1]); // POP PSW twice
  cpu.sp = 0x8000;
  bus.mem[0x8000] = 0xff; // raw flag image
  bus.mem[0x8001] = 0x12;
  bus.mem[0x8002] = 0x00;
  bus.mem[0x8003] = 0x34;
  cpu.step();
  eq('POP PSW A', cpu.a, 0x12);
  eq('POP PSW F normalized (ff->d7)', cpu.f, 0xd7);
  cpu.step();
  eq('POP PSW A 2', cpu.a, 0x34);
  eq('POP PSW F normalized (00->02)', cpu.f, BIT1);
}

// ================================================================ 7. jumps, calls, returns, RST

section('JMP/Jcc');
{
  const { cpu } = makeCpu([0xc3, 0x10, 0x00]);
  const t = cpu.step();
  eq('JMP target', cpu.pc, 0x10);
  eq('JMP cycles', t, 10);
}
{
  const { cpu } = makeCpu([0xc2, 0x10, 0x00]); // JNZ, Z clear
  cpu.f = BIT1;
  const t = cpu.step();
  eq('JNZ taken', cpu.pc, 0x10);
  eq('JNZ taken cycles (10 on 8080)', t, 10);
}
{
  const { cpu } = makeCpu([0xc2, 0x10, 0x00]); // JNZ, Z set
  cpu.f = ZF | BIT1;
  const t = cpu.step();
  eq('JNZ not taken pc', cpu.pc, 3);
  eq('JNZ not taken cycles (also 10)', t, 10);
}
{
  // all 8 conditions, taken: JNZ JZ JNC JC JPO JPE JP JM
  const ops = [0xc2, 0xca, 0xd2, 0xda, 0xe2, 0xea, 0xf2, 0xfa];
  const flagsTaken = [0, ZF, 0, CF, 0, PF, 0, SF];
  for (let i = 0; i < 8; i++) {
    const { cpu } = makeCpu([ops[i], 0x22, 0x11]);
    cpu.f = flagsTaken[i] | BIT1;
    cpu.step();
    eq(`Jcc[${i}] taken`, cpu.pc, 0x1122);
  }
}

section('CALL/Ccc/RET/Rcc with 8080 cycle asymmetry');
{
  const { cpu, bus } = makeCpu([0xcd, 0x06, 0x00, 0x00, 0x00, 0x00, 0x3e, 0xaa, 0xc9]);
  const t = cpu.step(); // CALL 0x0006
  eq('CALL pc', cpu.pc, 6);
  eq('CALL cycles', t, 17);
  eq('CALL sp', cpu.sp, 0xfefe);
  eq('CALL stack lo', bus.mem[0xfefe], 0x03);
  eq('CALL stack hi', bus.mem[0xfeff], 0x00);
  cpu.step(); // MVI A,aa
  const tr = cpu.step(); // RET
  eq('RET pc', cpu.pc, 3);
  eq('RET cycles', tr, 10);
  eq('RET sp', cpu.sp, 0xff00);
  eq('CALL/RET a', cpu.a, 0xaa);
}
{
  const { cpu } = makeCpu([0xcc, 0x10, 0x00]); // CZ taken
  cpu.f = ZF | BIT1;
  const t = cpu.step();
  eq('CZ taken pc', cpu.pc, 0x10);
  eq('CZ taken cycles', t, 17);
}
{
  const { cpu } = makeCpu([0xcc, 0x10, 0x00]); // CZ not taken
  cpu.f = BIT1;
  const t = cpu.step();
  eq('CZ not taken pc', cpu.pc, 3);
  eq('CZ not taken cycles', t, 11);
}
{
  const { cpu, bus } = makeCpu([0xc8]); // RZ taken
  cpu.f = ZF | BIT1;
  cpu.sp = 0x8000;
  bus.mem[0x8000] = 0x34;
  bus.mem[0x8001] = 0x12;
  const t = cpu.step();
  eq('RZ taken pc', cpu.pc, 0x1234);
  eq('RZ taken cycles', t, 11);
}
{
  const { cpu } = makeCpu([0xc8]); // RZ not taken
  cpu.f = BIT1;
  const t = cpu.step();
  eq('RZ not taken pc', cpu.pc, 1);
  eq('RZ not taken cycles', t, 5);
}

section('RST 0-7');
{
  for (let n = 0; n < 8; n++) {
    const { cpu, bus } = makeCpu([0xc7 | (n << 3)]);
    const t = cpu.step();
    eq(`RST ${n} vector`, cpu.pc, n * 8);
    if (n === 0) {
      eq('RST cycles', t, 11);
      eq('RST pushed return', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0001);
    }
  }
}

// ================================================================ 8. undocumented alias opcodes

section('undocumented aliases: NOPs, 0xCB=JMP, 0xD9=RET, 0xDD/ED/FD=CALL');
{
  const { cpu } = makeCpu([0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38]);
  cpu.a = 0x42;
  cpu.f = SF | CF | BIT1;
  let cyc = 0;
  for (let i = 0; i < 7; i++) cyc += cpu.step();
  eq('alias NOPs pc', cpu.pc, 7);
  eq('alias NOPs cycles', cyc, 28);
  eq('alias NOPs no state change', cpu.a, 0x42);
  eq('alias NOPs flags', cpu.f, SF | CF | BIT1);
}
{
  const { cpu } = makeCpu([0xcb, 0x10, 0x00]); // 0xCB = JMP
  const t = cpu.step();
  eq('0xCB JMP target', cpu.pc, 0x10);
  eq('0xCB JMP cycles', t, 10);
}
{
  const { cpu, bus } = makeCpu([0xd9]); // 0xD9 = RET
  cpu.sp = 0x8000;
  bus.mem[0x8000] = 0x34;
  bus.mem[0x8001] = 0x12;
  const t = cpu.step();
  eq('0xD9 RET pc', cpu.pc, 0x1234);
  eq('0xD9 RET cycles', t, 10);
}
{
  const aliases = [0xdd, 0xed, 0xfd];
  for (const op of aliases) {
    const { cpu, bus } = makeCpu([op, 0x10, 0x00]); // = CALL 0x0010
    const t = cpu.step();
    eq(`0x${op.toString(16)} CALL target`, cpu.pc, 0x10);
    eq(`0x${op.toString(16)} CALL cycles`, t, 17);
    eq(`0x${op.toString(16)} CALL stack`, bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0003);
  }
}

// ================================================================ 9. IN/OUT

section('IN/OUT (8-bit ports)');
{
  const { cpu, bus } = makeCpu([0x3e, 0x5a, 0xd3, 0x42]); // MVI A,5a / OUT 42
  cpu.step();
  const t = cpu.step();
  eq('OUT port', bus.ioLog[0].port, 0x42);
  eq('OUT data', bus.ioLog[0].data, 0x5a);
  eq('OUT cycles', t, 10);
}
{
  const { cpu, bus } = makeCpu([0xdb, 0x37]); // IN 37
  bus.ioIn[0x37] = 0xc3;
  cpu.f = ZF | PF | BIT1;
  const t = cpu.step();
  eq('IN value', cpu.a, 0xc3);
  eq('IN cycles', t, 10);
  eq('IN leaves flags', cpu.f, ZF | PF | BIT1);
}

// ================================================================ 10. interrupts, EI delay, HLT

section('EI delay and RST interrupt jam (Space Invaders style)');
{
  const { cpu, bus } = makeCpu([0xfb, 0x00, 0x00, 0x00]); // EI / NOP / NOP
  cpu.setIrqLine(true, 0xd7); // RST 2 on the bus (invaders vblank)
  const t1 = cpu.step(); // EI
  eq('EI cycles', t1, 4);
  eq('EI inte', cpu.inte, true);
  cpu.step(); // NOP must execute (EI shadow)
  eq('EI shadow: next instr runs', cpu.pc, 2);
  const t3 = cpu.step(); // now the irq is accepted
  eq('RST 2 irq cycles', t3, 11);
  eq('RST 2 irq vector', cpu.pc, 0x0010);
  eq('irq clears inte', cpu.inte, false);
  eq('irq pushed return', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
}
{
  const { cpu } = makeCpu([0x00, 0x00]); // RST 1 (invaders mid-screen), inte forced on
  cpu.inte = true;
  cpu.setIrqLine(true, 0xcf);
  const t = cpu.step();
  eq('RST 1 irq vector', cpu.pc, 0x0008);
  eq('RST 1 irq cycles', t, 11);
}
{
  // interrupts disabled: line ignored
  const { cpu } = makeCpu([0x00, 0x00]);
  cpu.setIrqLine(true, 0xcf);
  cpu.step();
  eq('masked irq ignored', cpu.pc, 1);
}
{
  // DI in the EI shadow slot wins: no interrupt taken
  const { cpu } = makeCpu([0xfb, 0xf3, 0x00]);
  cpu.setIrqLine(true, 0xcf);
  cpu.step(); // EI
  cpu.step(); // DI (shadow instruction executes)
  eq('DI in shadow: inte off', cpu.inte, false);
  cpu.step(); // NOP, not the irq
  eq('DI in shadow: no irq', cpu.pc, 3);
}
{
  // dropping the line before acceptance cancels the request
  const { cpu } = makeCpu([0xfb, 0x00, 0x00, 0x00]);
  cpu.setIrqLine(true, 0xcf);
  cpu.step(); // EI
  cpu.setIrqLine(false);
  cpu.step(); // NOP (shadow)
  cpu.step(); // NOP — no irq
  eq('cleared irq line not taken', cpu.pc, 3);
}
{
  // packed 3-byte CALL on the bus (z80.ts IM0 convention)
  const { cpu, bus } = makeCpu([0xfb, 0x00, 0x00]);
  cpu.setIrqLine(true, 0xcd | (0x00 << 8) | (0x40 << 16)); // CALL 0x4000
  cpu.step();
  cpu.step();
  const t = cpu.step();
  eq('packed CALL cycles', t, 17);
  eq('packed CALL vector', cpu.pc, 0x4000);
  eq('packed CALL pushed return', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
}

section('HLT and interrupt wake-up');
{
  const { cpu, bus } = makeCpu([0xfb, 0x76, 0x00]); // EI / HLT
  cpu.step(); // EI
  const th = cpu.step(); // HLT
  eq('HLT cycles', th, 7);
  eq('HLT halted', cpu.halted, true);
  const ti = cpu.step(); // idle
  eq('halted idle cycles', ti, 7);
  eq('still halted', cpu.halted, true);
  cpu.setIrqLine(true, 0xcf); // RST 1
  const ta = cpu.step();
  eq('HLT irq wake cycles', ta, 11);
  eq('HLT wake vector', cpu.pc, 0x0008);
  eq('HLT wake return addr (after HLT)', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
  eq('HLT cleared', cpu.halted, false);
}
{
  const { cpu } = makeCpu([0x76, 0x00]); // HLT with interrupts off stays halted
  cpu.step();
  cpu.step();
  cpu.step();
  eq('HLT stays halted without irq', cpu.halted, true);
}

section('reset');
{
  const { cpu } = makeCpu([0xfb, 0x76]);
  cpu.step();
  cpu.step();
  eq('pre-reset halted', cpu.halted, true);
  cpu.reset();
  eq('reset pc', cpu.pc, 0);
  eq('reset inte', cpu.inte, false);
  eq('reset halted', cpu.halted, false);
  eq('reset f (bit1 set)', cpu.f, BIT1);
}

// ================================================================ 11. cycle counts (lut_cycles_8080)

section('cycle counts');
{
  type CycleTest = {
    name: string;
    bytes: number[];
    want: number;
    setup?: (cpu: I8080, bus: TestBus) => void;
  };
  const tests: CycleTest[] = [
    { name: 'NOP', bytes: [0x00], want: 4 },
    { name: 'LXI B', bytes: [0x01, 0x00, 0x00], want: 10 },
    { name: 'STAX B', bytes: [0x02], want: 7 },
    { name: 'INX B', bytes: [0x03], want: 5 },
    { name: 'INR B', bytes: [0x04], want: 5 },
    { name: 'DCR B', bytes: [0x05], want: 5 },
    { name: 'MVI B', bytes: [0x06, 0x00], want: 7 },
    { name: 'RLC', bytes: [0x07], want: 4 },
    { name: 'DAD B', bytes: [0x09], want: 10 },
    { name: 'LDAX B', bytes: [0x0a], want: 7 },
    { name: 'RAR', bytes: [0x1f], want: 4 },
    { name: 'SHLD', bytes: [0x22, 0x00, 0x60], want: 16 },
    { name: 'LHLD', bytes: [0x2a, 0x00, 0x60], want: 16 },
    { name: 'DAA', bytes: [0x27], want: 4 },
    { name: 'CMA', bytes: [0x2f], want: 4 },
    { name: 'STA', bytes: [0x32, 0x00, 0x60], want: 13 },
    { name: 'LDA', bytes: [0x3a, 0x00, 0x60], want: 13 },
    { name: 'INR M', bytes: [0x34], want: 10 },
    { name: 'DCR M', bytes: [0x35], want: 10 },
    { name: 'MVI M', bytes: [0x36, 0x00], want: 10 },
    { name: 'STC', bytes: [0x37], want: 4 },
    { name: 'CMC', bytes: [0x3f], want: 4 },
    { name: 'MOV B,C', bytes: [0x41], want: 5 },
    { name: 'MOV B,M', bytes: [0x46], want: 7 },
    { name: 'MOV M,B', bytes: [0x70], want: 7 },
    { name: 'HLT', bytes: [0x76], want: 7 },
    { name: 'ADD B', bytes: [0x80], want: 4 },
    { name: 'ADD M', bytes: [0x86], want: 7 },
    { name: 'CMP B', bytes: [0xb8], want: 4 },
    { name: 'ADI', bytes: [0xc6, 0x00], want: 7 },
    { name: 'ANI', bytes: [0xe6, 0x00], want: 7 },
    { name: 'CPI', bytes: [0xfe, 0x00], want: 7 },
    {
      name: 'RNZ not taken',
      bytes: [0xc0],
      want: 5,
      setup: (cpu) => (cpu.f = ZF | BIT1),
    },
    {
      name: 'RNZ taken',
      bytes: [0xc0],
      want: 11,
      setup: (cpu) => (cpu.f = BIT1),
    },
    { name: 'POP B', bytes: [0xc1], want: 10 },
    {
      name: 'JNZ taken',
      bytes: [0xc2, 0x00, 0x10],
      want: 10,
      setup: (cpu) => (cpu.f = BIT1),
    },
    {
      name: 'JNZ not taken',
      bytes: [0xc2, 0x00, 0x10],
      want: 10,
      setup: (cpu) => (cpu.f = ZF | BIT1),
    },
    { name: 'JMP', bytes: [0xc3, 0x00, 0x10], want: 10 },
    {
      name: 'CNZ not taken',
      bytes: [0xc4, 0x00, 0x10],
      want: 11,
      setup: (cpu) => (cpu.f = ZF | BIT1),
    },
    {
      name: 'CNZ taken',
      bytes: [0xc4, 0x00, 0x10],
      want: 17,
      setup: (cpu) => (cpu.f = BIT1),
    },
    { name: 'PUSH B', bytes: [0xc5], want: 11 },
    { name: 'RST 7', bytes: [0xff], want: 11 },
    { name: 'RET', bytes: [0xc9], want: 10 },
    { name: 'CALL', bytes: [0xcd, 0x00, 0x10], want: 17 },
    { name: 'OUT', bytes: [0xd3, 0x00], want: 10 },
    { name: 'IN', bytes: [0xdb, 0x00], want: 10 },
    { name: 'XTHL', bytes: [0xe3], want: 18 },
    { name: 'PCHL', bytes: [0xe9], want: 5 },
    { name: 'XCHG', bytes: [0xeb], want: 4 },
    { name: 'POP PSW', bytes: [0xf1], want: 10 },
    { name: 'DI', bytes: [0xf3], want: 4 },
    { name: 'PUSH PSW', bytes: [0xf5], want: 11 },
    { name: 'SPHL', bytes: [0xf9], want: 5 },
    { name: 'EI', bytes: [0xfb], want: 4 },
    { name: 'alias NOP (08)', bytes: [0x08], want: 4 },
    { name: 'alias JMP (CB)', bytes: [0xcb, 0x00, 0x10], want: 10 },
    { name: 'alias RET (D9)', bytes: [0xd9], want: 10 },
    { name: 'alias CALL (DD)', bytes: [0xdd, 0x00, 0x10], want: 17 },
  ];
  for (const t of tests) {
    const { cpu, bus } = makeCpu(t.bytes);
    cpu.h = 0x40;
    cpu.l = 0x00;
    cpu.d = 0x50;
    cpu.e = 0x00;
    if (t.setup) t.setup(cpu, bus);
    eq(`cycles ${t.name}`, cpu.step(), t.want);
  }
}

// ================================================================ 12. run()

section('run() accumulates cycles');
{
  const { cpu } = makeCpu(new Array<number>(64).fill(0x00));
  const total = cpu.run(10); // NOPs are 4 cycles each: 4+4+4 = 12 >= 10
  eq('run() total', total, 12);
  eq('run() pc', cpu.pc, 3);
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
