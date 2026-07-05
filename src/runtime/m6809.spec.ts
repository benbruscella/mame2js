// Self-test for the M6809 core. Run with: node src/runtime/m6809.spec.ts
// No test framework; prints PASS/FAIL per section and sets process.exitCode.

import { M6809, type M6809Bus } from './m6809.ts';

// CC bits (duplicated here on purpose; do not import internals)
const C = 0x01;
const V = 0x02;
const Z = 0x04;
const N = 0x08;
const I = 0x10;
const H = 0x20;
const F = 0x40;
const E = 0x80;

class TestBus implements M6809Bus {
  mem = new Uint8Array(0x10000);
  read(addr: number): number {
    return this.mem[addr];
  }
  write(addr: number, data: number): void {
    this.mem[addr] = data;
  }
}

const ORG = 0x1000;

function makeCpu(program: number[], org = ORG): { cpu: M6809; bus: TestBus } {
  const bus = new TestBus();
  bus.mem[0xfffe] = (org >> 8) & 0xff;
  bus.mem[0xffff] = org & 0xff;
  bus.mem.set(program, org);
  const cpu = new M6809(bus); // constructor resets: pc <- vector
  cpu.cc = 0; // clear I/F set by reset so flag expectations are exact
  cpu.s = 0x8000;
  cpu.u = 0x7000;
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

// ================================================================ 1. loads/stores 8-bit

section('LD/ST 8-bit + flags');
{
  const { cpu } = makeCpu([0x86, 0x12, 0xc6, 0x34]); // LDA #$12 / LDB #$34
  cpu.step();
  eq('LDA # value', cpu.a, 0x12);
  eq('LDA # flags', cpu.cc, 0);
  cpu.step();
  eq('LDB # value', cpu.b, 0x34);
}
{
  const { cpu } = makeCpu([0x86, 0x00, 0x86, 0x80]);
  cpu.step();
  eq('LDA #0 Z', cpu.cc, Z);
  cpu.step();
  eq('LDA #$80 N', cpu.cc, N);
}
{
  const { cpu, bus } = makeCpu([0x96, 0x44, 0xb6, 0x20, 0x50, 0xa6, 0x84]); // LDA <44 / LDA $2050 / LDA ,X
  cpu.dp = 0x20;
  bus.mem[0x2044] = 0x5a;
  bus.mem[0x2050] = 0x66;
  bus.mem[0x3000] = 0x77;
  cpu.x = 0x3000;
  cpu.step();
  eq('LDA direct', cpu.a, 0x5a);
  cpu.step();
  eq('LDA extended', cpu.a, 0x66);
  cpu.step();
  eq('LDA indexed', cpu.a, 0x77);
}
{
  const { cpu, bus } = makeCpu([0x97, 0x40, 0xd7, 0x41, 0xb7, 0x21, 0x00]); // STA <40 / STB <41 / STA $2100
  cpu.dp = 0x20;
  cpu.a = 0x80;
  cpu.b = 0x00;
  cpu.step();
  eq('STA direct mem', bus.mem[0x2040], 0x80);
  eq('STA flags N', cpu.cc, N);
  cpu.step();
  eq('STB direct mem', bus.mem[0x2041], 0x00);
  eq('STB flags Z', cpu.cc, Z);
  cpu.step();
  eq('STA extended mem', bus.mem[0x2100], 0x80);
}

// ================================================================ 2. 8-bit arithmetic

section('ADD/ADC/SUB/SBC/CMP flags');
{
  const { cpu } = makeCpu([0x8b, 0x01]); // ADDA #1
  cpu.a = 0x7f;
  cpu.step();
  eq('ADDA 7f+1 result', cpu.a, 0x80);
  eq('ADDA 7f+1 flags H N V', cpu.cc, H | N | V);
}
{
  const { cpu } = makeCpu([0x8b, 0xff]); // ADDA #$FF
  cpu.a = 0x01;
  cpu.step();
  eq('ADDA 1+ff result', cpu.a, 0x00);
  eq('ADDA 1+ff flags H Z C', cpu.cc, H | Z | C);
}
{
  const { cpu } = makeCpu([0x1a, 0x01, 0x89, 0x0f]); // ORCC #1 / ADCA #$0F
  cpu.a = 0x10;
  cpu.step();
  cpu.step();
  eq('ADCA uses carry', cpu.a, 0x20);
  eq('ADCA flags H only', cpu.cc, H);
}
{
  const { cpu } = makeCpu([0x80, 0x01]); // SUBA #1
  cpu.a = 0x00;
  cpu.step();
  eq('SUBA 0-1 result', cpu.a, 0xff);
  eq('SUBA borrow sets C', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([0x80, 0x80]); // SUBA #$80
  cpu.a = 0x7f;
  cpu.step();
  eq('SUBA overflow result', cpu.a, 0xff);
  eq('SUBA overflow flags', cpu.cc, N | V | C);
}
{
  const { cpu } = makeCpu([0x1a, 0x01, 0x82, 0x01]); // ORCC #1 / SBCA #1
  cpu.a = 0x10;
  cpu.step();
  cpu.step();
  eq('SBCA with borrow', cpu.a, 0x0e);
  eq('SBCA flags', cpu.cc, 0);
}
{
  const { cpu } = makeCpu([0x81, 0x42, 0xc1, 0x50]); // CMPA #$42 / CMPB #$50
  cpu.a = 0x42;
  cpu.b = 0x40;
  cpu.step();
  eq('CMPA equal Z', cpu.cc, Z);
  eq('CMPA leaves A', cpu.a, 0x42);
  cpu.step();
  eq('CMPB less flags', cpu.cc, N | C);
  eq('CMPB leaves B', cpu.b, 0x40);
}
{
  const { cpu } = makeCpu([0xcb, 0x01, 0xc0, 0x02]); // ADDB #1 / SUBB #2
  cpu.b = 0xff;
  cpu.step();
  eq('ADDB wraps', cpu.b, 0x00);
  eq('ADDB wrap flags', cpu.cc, H | Z | C);
  cpu.step();
  eq('SUBB result', cpu.b, 0xfe);
  // H is untouched by SUB (6809 leaves it undefined; MAME keeps the old value)
  eq('SUBB flags (H kept from ADDB)', cpu.cc, H | N | C);
}

section('AND/OR/EOR/BIT clear V');
{
  const { cpu } = makeCpu([0x1a, 0x02, 0x84, 0x0f]); // ORCC #2 / ANDA #$0F
  cpu.a = 0xf0;
  cpu.step();
  cpu.step();
  eq('ANDA result', cpu.a, 0x00);
  eq('ANDA flags Z, V cleared', cpu.cc, Z);
}
{
  const { cpu } = makeCpu([0x8a, 0x80, 0x88, 0xff, 0x85, 0x01]); // ORA #$80 / EORA #$FF / BITA #1
  cpu.a = 0x01;
  cpu.step();
  eq('ORA result', cpu.a, 0x81);
  eq('ORA flags', cpu.cc, N);
  cpu.step();
  eq('EORA result', cpu.a, 0x7e);
  eq('EORA flags', cpu.cc, 0);
  cpu.step();
  eq('BITA leaves A', cpu.a, 0x7e);
  eq('BITA flags Z', cpu.cc, Z); // 0x7e & 1 = 0
}

// ================================================================ 3. read-modify-write

section('NEG/COM/LSR/ROR/ASR/ASL/ROL/INC/DEC/TST/CLR');
{
  const { cpu } = makeCpu([0x40, 0x40, 0x40]); // NEGA x3
  cpu.a = 0x01;
  cpu.step();
  eq('NEGA 1', cpu.a, 0xff);
  eq('NEGA 1 flags', cpu.cc, N | C);
  cpu.a = 0x00;
  cpu.step();
  eq('NEGA 0', cpu.a, 0x00);
  eq('NEGA 0 flags (no C)', cpu.cc, Z);
  cpu.a = 0x80;
  cpu.step();
  eq('NEGA 80', cpu.a, 0x80);
  eq('NEGA 80 flags V', cpu.cc, N | V | C);
}
{
  const { cpu } = makeCpu([0x43]); // COMA
  cpu.a = 0x55;
  cpu.step();
  eq('COMA result', cpu.a, 0xaa);
  eq('COMA flags N C, V clear', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([0x1a, 0x02, 0x44, 0x44]); // ORCC #2 / LSRA / LSRA
  cpu.a = 0x02;
  cpu.step();
  cpu.step();
  eq('LSRA result', cpu.a, 0x01);
  eq('LSRA leaves V untouched', cpu.cc, V);
  cpu.step();
  eq('LSRA to zero', cpu.a, 0x00);
  eq('LSRA Z C', cpu.cc, V | Z | C);
}
{
  const { cpu } = makeCpu([0x1a, 0x01, 0x46]); // ORCC #1 / RORA
  cpu.a = 0x02;
  cpu.step();
  cpu.step();
  eq('RORA through carry', cpu.a, 0x81);
  eq('RORA flags', cpu.cc, N); // new C = old bit0 = 0
}
{
  const { cpu } = makeCpu([0x47]); // ASRA
  cpu.a = 0x81;
  cpu.step();
  eq('ASRA keeps sign', cpu.a, 0xc0);
  eq('ASRA flags N C', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([0x48, 0x48]); // ASLA x2
  cpu.a = 0x40;
  cpu.step();
  eq('ASLA result', cpu.a, 0x80);
  eq('ASLA V=b7^b6', cpu.cc, N | V);
  cpu.step();
  eq('ASLA to zero', cpu.a, 0x00);
  eq('ASLA Z V C', cpu.cc, Z | V | C); // 0x80<<1: C set, V = 1^0
}
{
  const { cpu } = makeCpu([0x1a, 0x01, 0x49]); // ORCC #1 / ROLA
  cpu.a = 0x40;
  cpu.step();
  cpu.step();
  eq('ROLA through carry', cpu.a, 0x81);
  eq('ROLA flags N V', cpu.cc, N | V); // V = b7^b6 of 0x40; C = old b7 = 0
}
{
  const { cpu } = makeCpu([0x1a, 0x01, 0x4c, 0x4a, 0x4a]); // ORCC #1 / INCA / DECA / DECA
  cpu.a = 0x7f;
  cpu.step();
  cpu.step();
  eq('INCA 7f', cpu.a, 0x80);
  eq('INCA V, C preserved', cpu.cc, N | V | C);
  cpu.step();
  eq('DECA 80', cpu.a, 0x7f);
  eq('DECA V, C preserved', cpu.cc, V | C);
  cpu.a = 0x01;
  cpu.step();
  eq('DECA to zero', cpu.a, 0x00);
  eq('DECA Z', cpu.cc, Z | C);
}
{
  const { cpu } = makeCpu([0x1a, 0x03, 0x4d]); // ORCC #3 / TSTA
  cpu.a = 0x80;
  cpu.step();
  cpu.step();
  eq('TSTA flags: N, V cleared, C kept', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([0x1a, 0x0f, 0x4f, 0x5f]); // ORCC #$0F / CLRA / CLRB
  cpu.a = 0x55;
  cpu.b = 0x66;
  cpu.step();
  cpu.step();
  eq('CLRA result', cpu.a, 0x00);
  eq('CLRA flags: NZVC -> Z (C cleared)', cpu.cc, Z);
  cpu.step();
  eq('CLRB result', cpu.b, 0x00);
}
{
  const { cpu, bus } = makeCpu([0x0c, 0x20, 0x03, 0x21, 0x08, 0x22, 0x0f, 0x23]);
  // INC <20 / COM <21 / ASL <22 / CLR <23 (dp=0x40)
  cpu.dp = 0x40;
  bus.mem[0x4020] = 0x7f;
  bus.mem[0x4021] = 0x0f;
  bus.mem[0x4022] = 0xc0;
  bus.mem[0x4023] = 0x99;
  cpu.step();
  eq('INC direct mem', bus.mem[0x4020], 0x80);
  eq('INC direct flags', cpu.cc, N | V);
  cpu.step();
  eq('COM direct mem', bus.mem[0x4021], 0xf0);
  cpu.step();
  eq('ASL direct mem', bus.mem[0x4022], 0x80);
  eq('ASL direct C', (cpu.cc & C) !== 0, true);
  cpu.step();
  eq('CLR direct mem', bus.mem[0x4023], 0x00);
}
{
  const { cpu, bus } = makeCpu([0x70, 0x22, 0x00]); // NEG $2200
  bus.mem[0x2200] = 0x01;
  cpu.step();
  eq('NEG extended mem', bus.mem[0x2200], 0xff);
}

// ================================================================ 4. 16-bit ops

section('16-bit load/store/arith');
{
  const { cpu } = makeCpu([0xcc, 0x12, 0x34, 0x8e, 0x56, 0x78, 0xce, 0x9a, 0xbc]);
  cpu.step(); // LDD #$1234
  eq('LDD A', cpu.a, 0x12);
  eq('LDD B', cpu.b, 0x34);
  eq('LDD flags', cpu.cc, 0);
  cpu.step(); // LDX #$5678
  eq('LDX value', cpu.x, 0x5678);
  cpu.step(); // LDU #$9ABC
  eq('LDU value', cpu.u, 0x9abc);
  eq('LDU flags N', cpu.cc, N);
}
{
  const { cpu } = makeCpu([0x10, 0x8e, 0xfe, 0xdc, 0x10, 0xce, 0x80, 0x00, 0x8e, 0x00, 0x00]);
  cpu.step(); // LDY #$FEDC
  eq('LDY value', cpu.y, 0xfedc);
  eq('LDY flags N', cpu.cc, N);
  cpu.step(); // LDS #$8000
  eq('LDS value', cpu.s, 0x8000);
  cpu.step(); // LDX #0
  eq('LDX #0 Z', cpu.cc, Z);
}
{
  const { cpu, bus } = makeCpu([
    0xdd, 0x10, 0x9f, 0x12, 0x10, 0x9f, 0x14, 0x10, 0xdf, 0x16, 0xdf, 0x18,
  ]);
  // STD <10 / STX <12 / STY <14 / STS <16 / STU <18 (dp = 0x50)
  cpu.dp = 0x50;
  cpu.a = 0x12;
  cpu.b = 0x34;
  cpu.x = 0x5678;
  cpu.y = 0x9abc;
  cpu.s = 0x8000;
  cpu.u = 0x7000;
  cpu.step();
  eq('STD hi', bus.mem[0x5010], 0x12);
  eq('STD lo', bus.mem[0x5011], 0x34);
  cpu.step();
  eq('STX hi', bus.mem[0x5012], 0x56);
  eq('STX lo', bus.mem[0x5013], 0x78);
  cpu.step();
  eq('STY hi', bus.mem[0x5014], 0x9a);
  eq('STY lo', bus.mem[0x5015], 0xbc);
  eq('STY flags N', cpu.cc, N);
  cpu.step();
  eq('STS hi', bus.mem[0x5016], 0x80);
  eq('STS lo', bus.mem[0x5017], 0x00);
  cpu.step();
  eq('STU hi', bus.mem[0x5018], 0x70);
  eq('STU lo', bus.mem[0x5019], 0x00);
}
{
  const { cpu, bus } = makeCpu([0xdc, 0x20, 0xde, 0x22, 0x10, 0xde, 0x24, 0x9e, 0x26, 0x10, 0x9e, 0x28]);
  // LDD <20 / LDU <22 / LDS <24 / LDX <26 / LDY <28 (dp=0x60)
  cpu.dp = 0x60;
  bus.mem.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa], 0x6020);
  cpu.step();
  eq('LDD direct', (cpu.a << 8) | cpu.b, 0x1122);
  cpu.step();
  eq('LDU direct', cpu.u, 0x3344);
  cpu.step();
  eq('LDS direct', cpu.s, 0x5566);
  cpu.step();
  eq('LDX direct', cpu.x, 0x7788);
  cpu.step();
  eq('LDY direct', cpu.y, 0x99aa);
}
{
  const { cpu } = makeCpu([0xc3, 0x43, 0x21, 0x83, 0x00, 0x01]); // ADDD #$4321 / SUBD #1
  cpu.a = 0x12;
  cpu.b = 0x34;
  cpu.step();
  eq('ADDD result', (cpu.a << 8) | cpu.b, 0x5555);
  eq('ADDD flags', cpu.cc, 0);
  cpu.step();
  eq('SUBD result', (cpu.a << 8) | cpu.b, 0x5554);
}
{
  const { cpu } = makeCpu([0xc3, 0x80, 0x00]); // ADDD #$8000
  cpu.a = 0x80;
  cpu.b = 0x00;
  cpu.step();
  eq('ADDD neg+neg overflow', (cpu.a << 8) | cpu.b, 0x0000);
  eq('ADDD Z V C', cpu.cc, Z | V | C);
}
{
  const { cpu } = makeCpu([0x83, 0x00, 0x01]); // SUBD #1
  cpu.a = 0x00;
  cpu.b = 0x00;
  cpu.step();
  eq('SUBD borrow', (cpu.a << 8) | cpu.b, 0xffff);
  eq('SUBD flags N C', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([
    0x8c, 0x12, 0x34, // CMPX #
    0x10, 0x83, 0x00, 0x01, // CMPD #
    0x10, 0x8c, 0x00, 0x00, // CMPY #
    0x11, 0x83, 0x70, 0x00, // CMPU #
    0x11, 0x8c, 0x80, 0x00, // CMPS #
  ]);
  cpu.x = 0x1234;
  cpu.a = 0x80;
  cpu.b = 0x00;
  cpu.y = 0x8000;
  cpu.step();
  eq('CMPX equal Z', cpu.cc, Z);
  cpu.step();
  eq('CMPD 8000-1 flags', cpu.cc, V); // 0x8000-1 = 0x7fff: overflow, no borrow
  cpu.step();
  eq('CMPY 8000 vs 0 flags', cpu.cc, N);
  cpu.step();
  eq('CMPU equal Z', cpu.cc, Z);
  cpu.step();
  eq('CMPS equal Z', cpu.cc, Z);
}

// ================================================================ 5. indexed submode matrix

section('indexed submodes: constant offsets');
{
  const { cpu, bus } = makeCpu([
    0xa6, 0x84, // LDA ,X
    0xa6, 0x0f, // LDA 15,X   (5-bit)
    0xa6, 0x10, // LDA -16,X  (5-bit)
    0xa6, 0x88, 0x20, // LDA $20,X
    0xa6, 0x88, 0xe0, // LDA -$20,X
    0xa6, 0x89, 0x01, 0x00, // LDA $0100,X
    0xa6, 0xa4, // LDA ,Y
    0xa6, 0xc4, // LDA ,U
    0xa6, 0xe4, // LDA ,S
  ]);
  cpu.x = 0x2000;
  cpu.y = 0x2101;
  cpu.u = 0x2102;
  cpu.s = 0x2103;
  bus.mem[0x2000] = 0x01;
  bus.mem[0x200f] = 0x02;
  bus.mem[0x1ff0] = 0x03;
  bus.mem[0x2020] = 0x04;
  bus.mem[0x1fe0] = 0x05;
  bus.mem[0x2100] = 0x06;
  bus.mem[0x2101] = 0x07;
  bus.mem[0x2102] = 0x08;
  bus.mem[0x2103] = 0x09;
  cpu.step();
  eq('LDA ,X', cpu.a, 0x01);
  cpu.step();
  eq('LDA 15,X (5-bit)', cpu.a, 0x02);
  cpu.step();
  eq('LDA -16,X (5-bit)', cpu.a, 0x03);
  cpu.step();
  eq('LDA 8-bit +offset', cpu.a, 0x04);
  cpu.step();
  eq('LDA 8-bit -offset', cpu.a, 0x05);
  cpu.step();
  eq('LDA 16-bit offset', cpu.a, 0x06);
  cpu.step();
  eq('LDA ,Y', cpu.a, 0x07);
  cpu.step();
  eq('LDA ,U', cpu.a, 0x08);
  cpu.step();
  eq('LDA ,S', cpu.a, 0x09);
}

section('indexed submodes: accumulator offsets + auto inc/dec');
{
  const { cpu, bus } = makeCpu([
    0xe6, 0x86, // LDB A,X
    0xa6, 0x85, // LDA B,X
    0xa6, 0x8b, // LDA D,X
  ]);
  cpu.x = 0x2000;
  cpu.a = 0xfe; // -2
  bus.mem[0x1ffe] = 0x30; // X + (-2)
  cpu.step();
  eq('LDB A,X (signed A)', cpu.b, 0x30);
  // now B = 0x30
  bus.mem[0x2030] = 0x11;
  cpu.step();
  eq('LDA B,X', cpu.a, 0x11);
  // now A=0x11 B=0x30 -> D = 0x1130
  bus.mem[(0x2000 + 0x1130) & 0xffff] = 0x99;
  cpu.step();
  eq('LDA D,X', cpu.a, 0x99);
}
{
  const { cpu, bus } = makeCpu([
    0xa6, 0x80, // LDA ,X+
    0xa6, 0x81, // LDA ,X++
    0xa6, 0x82, // LDA ,-X
    0xa6, 0x83, // LDA ,--X
    0xe6, 0xa0, // LDB ,Y+
  ]);
  cpu.x = 0x2000;
  cpu.y = 0x3000;
  bus.mem[0x2000] = 0x0a;
  bus.mem[0x2001] = 0x0b;
  bus.mem[0x2002] = 0x0c;
  bus.mem[0x3000] = 0x0d;
  cpu.step();
  eq('LDA ,X+ value', cpu.a, 0x0a);
  eq(',X+ post-increment', cpu.x, 0x2001);
  cpu.step();
  eq('LDA ,X++ value', cpu.a, 0x0b);
  eq(',X++ post-increment', cpu.x, 0x2003);
  cpu.step();
  eq('LDA ,-X value', cpu.a, 0x0c); // pre-dec to 0x2002
  eq(',-X pre-decrement', cpu.x, 0x2002);
  cpu.step();
  eq('LDA ,--X value', cpu.a, 0x0a); // pre-dec to 0x2000
  eq(',--X pre-decrement', cpu.x, 0x2000);
  cpu.step();
  eq('LDB ,Y+ value', cpu.b, 0x0d);
  eq(',Y+ increments Y', cpu.y, 0x3001);
}

section('indexed submodes: PC-relative + indirect');
{
  const { cpu, bus } = makeCpu([
    0xa6, 0x8c, 0x10, // LDA $10,PCR  (pc after = $1003, EA = $1013)
    0xa6, 0x8d, 0x01, 0x00, // LDA $0100,PCR (pc after = $1007, EA = $1107)
  ]);
  bus.mem[0x1013] = 0x21;
  bus.mem[0x1107] = 0x22;
  cpu.step();
  eq('LDA n8,PCR', cpu.a, 0x21);
  cpu.step();
  eq('LDA n16,PCR', cpu.a, 0x22);
}
{
  const { cpu, bus } = makeCpu([
    0xa6, 0x9f, 0x20, 0x00, // LDA [$2000]
    0xa6, 0x94, // LDA [,X]
    0xa6, 0x98, 0x04, // LDA [4,X]
    0xa6, 0x91, // LDA [,X++]
  ]);
  cpu.x = 0x2000;
  bus.mem[0x2000] = 0x30; // pointer hi
  bus.mem[0x2001] = 0x00; // pointer lo -> $3000
  bus.mem[0x2004] = 0x30;
  bus.mem[0x2005] = 0x10; // -> $3010
  bus.mem[0x3000] = 0x41;
  bus.mem[0x3010] = 0x42;
  cpu.step();
  eq('LDA [n16]', cpu.a, 0x41);
  cpu.step();
  eq('LDA [,X]', cpu.a, 0x41);
  cpu.step();
  eq('LDA [n8,X]', cpu.a, 0x42);
  cpu.step();
  eq('LDA [,X++] value', cpu.a, 0x41);
  eq('[,X++] increments by 2', cpu.x, 0x2002);
}

section('LEA');
{
  const { cpu } = makeCpu([
    0x30, 0x1f, // LEAX -1,X
    0x30, 0x1f, // LEAX -1,X
    0x31, 0x88, 0x10, // LEAY $10,X
    0x33, 0xa4, // LEAU ,Y
  ]);
  cpu.x = 0x0002;
  cpu.step();
  eq('LEAX result', cpu.x, 0x0001);
  eq('LEAX Z clear', cpu.cc & Z, 0);
  cpu.step();
  eq('LEAX to zero', cpu.x, 0x0000);
  eq('LEAX sets Z', cpu.cc & Z, Z);
  cpu.step();
  eq('LEAY X+0x10', cpu.y, 0x0010);
  eq('LEAY Z updated (nonzero)', cpu.cc & Z, 0);
  const ccBefore = cpu.cc;
  cpu.y = 0x0000;
  cpu.step(); // LEAU ,Y with Y=0
  eq('LEAU result', cpu.u, 0x0000);
  eq('LEAU does not touch flags', cpu.cc, ccBefore);
}

// ================================================================ 6. TFR/EXG matrix

section('TFR/EXG');
{
  const { cpu } = makeCpu([0x1f, 0x12, 0x1f, 0x89, 0x1f, 0x81, 0x1f, 0x18, 0x1f, 0xa1]);
  cpu.x = 0x1234;
  cpu.a = 0x9a;
  cpu.b = 0x00;
  cpu.cc = N | C; // 0x09
  cpu.step(); // TFR X,Y
  eq('TFR X,Y', cpu.y, 0x1234);
  cpu.step(); // TFR A,B
  eq('TFR A,B', cpu.b, 0x9a);
  cpu.step(); // TFR A,X: 16-bit target gets $FF00|A
  eq('TFR A,X pads with FF00', cpu.x, 0xff9a);
  cpu.x = 0x4455;
  cpu.step(); // TFR X,A: 8-bit target gets low byte
  eq('TFR X,A takes low byte', cpu.a, 0x55);
  cpu.step(); // TFR CC,X: CC duplicated into both bytes
  eq('TFR CC,X duplicates CC', cpu.x, ((N | C) << 8) | (N | C));
}
{
  const { cpu } = makeCpu([0x1f, 0x15]); // TFR X,PC
  cpu.x = 0x2345;
  cpu.step();
  eq('TFR X,PC jumps', cpu.pc, 0x2345);
}
{
  const { cpu } = makeCpu([0x1f, 0x68]); // TFR (invalid 6),A
  cpu.step();
  eq('TFR invalid source reads $FFFF', cpu.a, 0xff);
}
{
  const { cpu } = makeCpu([0x1e, 0x89, 0x1e, 0x12, 0x1e, 0x81]);
  cpu.a = 0x12;
  cpu.b = 0x34;
  cpu.x = 0x5678;
  cpu.y = 0x9abc;
  cpu.step(); // EXG A,B
  eq('EXG A,B -> A', cpu.a, 0x34);
  eq('EXG A,B -> B', cpu.b, 0x12);
  cpu.step(); // EXG X,Y
  eq('EXG X,Y -> X', cpu.x, 0x9abc);
  eq('EXG X,Y -> Y', cpu.y, 0x5678);
  cpu.step(); // EXG A,X (8<->16): A <- X low, X <- $FF00|A_old
  eq('EXG A,X -> A', cpu.a, 0xbc);
  eq('EXG A,X -> X', cpu.x, 0xff34);
}
{
  const { cpu } = makeCpu([0x1e, 0x18]); // EXG X,A (16 first: 168 read rules)
  cpu.a = 0x12;
  cpu.x = 0x5678;
  cpu.step();
  eq('EXG X,A -> A', cpu.a, 0x78);
  eq('EXG X,A -> X', cpu.x, 0xff12);
}

// ================================================================ 7. push/pull

section('PSHS/PULS/PSHU/PULU order and contents');
{
  const { cpu, bus } = makeCpu([0x34, 0xff]); // PSHS all
  cpu.cc = N; // 0x08
  cpu.a = 0x11;
  cpu.b = 0x22;
  cpu.dp = 0x33;
  cpu.x = 0x4455;
  cpu.y = 0x6677;
  cpu.u = 0x8899;
  cpu.step();
  eq('PSHS all new S', cpu.s, 0x8000 - 12);
  const base = 0x8000 - 12;
  eq('PSHS CC', bus.mem[base + 0], N);
  eq('PSHS A', bus.mem[base + 1], 0x11);
  eq('PSHS B', bus.mem[base + 2], 0x22);
  eq('PSHS DP', bus.mem[base + 3], 0x33);
  eq('PSHS XH', bus.mem[base + 4], 0x44);
  eq('PSHS XL', bus.mem[base + 5], 0x55);
  eq('PSHS YH', bus.mem[base + 6], 0x66);
  eq('PSHS YL', bus.mem[base + 7], 0x77);
  eq('PSHS UH', bus.mem[base + 8], 0x88);
  eq('PSHS UL', bus.mem[base + 9], 0x99);
  eq('PSHS PCH', bus.mem[base + 10], 0x10);
  eq('PSHS PCL', bus.mem[base + 11], 0x02);
}
{
  const { cpu, bus } = makeCpu([0x34, 0x16]); // PSHS A,B,X
  cpu.a = 0xaa;
  cpu.b = 0xbb;
  cpu.x = 0xccdd;
  cpu.step();
  eq('PSHS A,B,X new S', cpu.s, 0x8000 - 4);
  eq('PSHS subset A', bus.mem[0x7ffc], 0xaa);
  eq('PSHS subset B', bus.mem[0x7ffd], 0xbb);
  eq('PSHS subset XH', bus.mem[0x7ffe], 0xcc);
  eq('PSHS subset XL', bus.mem[0x7fff], 0xdd);
}
{
  const { cpu, bus } = makeCpu([0x35, 0xff]); // PULS all
  cpu.s = 0x7000;
  bus.mem.set(
    [0x0f, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x20, 0x00],
    0x7000,
  );
  cpu.step();
  eq('PULS CC', cpu.cc, 0x0f);
  eq('PULS A', cpu.a, 0x11);
  eq('PULS B', cpu.b, 0x22);
  eq('PULS DP', cpu.dp, 0x33);
  eq('PULS X', cpu.x, 0x4455);
  eq('PULS Y', cpu.y, 0x6677);
  eq('PULS U', cpu.u, 0x8899);
  eq('PULS PC', cpu.pc, 0x2000);
  eq('PULS new S', cpu.s, 0x700c);
}
{
  const { cpu, bus } = makeCpu([0x36, 0x40, 0x37, 0x40]); // PSHU S / PULU S
  cpu.u = 0x7000;
  cpu.s = 0x1234;
  cpu.step();
  eq('PSHU pushes S (not U)', (bus.mem[0x6ffe] << 8) | bus.mem[0x6fff], 0x1234);
  eq('PSHU new U', cpu.u, 0x6ffe);
  cpu.s = 0;
  cpu.step();
  eq('PULU pulls into S', cpu.s, 0x1234);
  eq('PULU restores U', cpu.u, 0x7000);
}

// ================================================================ 8. MUL/DAA/SEX/ABX

section('MUL/DAA/SEX/ABX');
{
  const { cpu } = makeCpu([0x3d, 0x3d, 0x3d]);
  cpu.a = 0x0c;
  cpu.b = 0x64;
  cpu.step();
  eq('MUL result', (cpu.a << 8) | cpu.b, 0x04b0);
  eq('MUL C = bit7 of low byte', cpu.cc, C);
  cpu.a = 0x00;
  cpu.b = 0x05;
  cpu.step();
  eq('MUL zero result', (cpu.a << 8) | cpu.b, 0);
  eq('MUL Z, C clear', cpu.cc, Z);
  cpu.cc = N | V; // MUL must not touch N/V
  cpu.a = 0x02;
  cpu.b = 0x03;
  cpu.step();
  eq('MUL preserves N/V', cpu.cc, N | V);
}
{
  const { cpu } = makeCpu([0x8b, 0x28, 0x19]); // ADDA #$28 / DAA (BCD 19+28)
  cpu.a = 0x19;
  cpu.step();
  cpu.step();
  eq('DAA 19+28 = 47', cpu.a, 0x47);
  eq('DAA no carry', cpu.cc & C, 0);
}
{
  const { cpu } = makeCpu([0x8b, 0x01, 0x19]); // ADDA #1 / DAA (BCD 99+01)
  cpu.a = 0x99;
  cpu.step();
  cpu.step();
  eq('DAA 99+01 = 00', cpu.a, 0x00);
  eq('DAA carry + zero', cpu.cc, Z | C);
}
{
  const { cpu } = makeCpu([0x1d, 0x1d, 0x1d]);
  cpu.b = 0x80;
  cpu.step();
  eq('SEX negative', (cpu.a << 8) | cpu.b, 0xff80);
  eq('SEX N', cpu.cc, N);
  cpu.b = 0x01;
  cpu.step();
  eq('SEX positive', (cpu.a << 8) | cpu.b, 0x0001);
  eq('SEX flags clear', cpu.cc, 0);
  cpu.b = 0x00;
  cpu.step();
  eq('SEX zero Z', cpu.cc, Z);
}
{
  const { cpu } = makeCpu([0x3a]);
  cpu.x = 0x1000;
  cpu.b = 0xff; // unsigned add
  cpu.cc = N | Z | V | C;
  cpu.step();
  eq('ABX unsigned', cpu.x, 0x10ff);
  eq('ABX flags untouched', cpu.cc, N | Z | V | C);
}

// ================================================================ 9. branches

section('branches short + long');
function branchTaken(op: number, cc: number): boolean {
  const { cpu } = makeCpu([op, 0x10]); // Bxx +$10
  cpu.cc = cc;
  cpu.step();
  return cpu.pc === ORG + 2 + 0x10;
}
{
  eq('BRA', branchTaken(0x20, 0), true);
  eq('BRN', branchTaken(0x21, 0), false);
  eq('BHI clear', branchTaken(0x22, 0), true);
  eq('BHI on C', branchTaken(0x22, C), false);
  eq('BHI on Z', branchTaken(0x22, Z), false);
  eq('BLS on Z', branchTaken(0x23, Z), true);
  eq('BCC', branchTaken(0x24, 0), true);
  eq('BCC on C', branchTaken(0x24, C), false);
  eq('BCS on C', branchTaken(0x25, C), true);
  eq('BNE', branchTaken(0x26, 0), true);
  eq('BNE on Z', branchTaken(0x26, Z), false);
  eq('BEQ on Z', branchTaken(0x27, Z), true);
  eq('BVC', branchTaken(0x28, 0), true);
  eq('BVS on V', branchTaken(0x29, V), true);
  eq('BPL', branchTaken(0x2a, 0), true);
  eq('BMI on N', branchTaken(0x2b, N), true);
  eq('BGE both clear', branchTaken(0x2c, 0), true);
  eq('BGE N only', branchTaken(0x2c, N), false);
  eq('BGE N and V', branchTaken(0x2c, N | V), true);
  eq('BLT N only', branchTaken(0x2d, N), true);
  eq('BLT V only', branchTaken(0x2d, V), true);
  eq('BLT both', branchTaken(0x2d, N | V), false);
  eq('BGT clear', branchTaken(0x2e, 0), true);
  eq('BGT on Z', branchTaken(0x2e, Z), false);
  eq('BGT N and V', branchTaken(0x2e, N | V), true);
  eq('BLE on Z', branchTaken(0x2f, Z), true);
  eq('BLE N only', branchTaken(0x2f, N), true);
  eq('BLE clear', branchTaken(0x2f, 0), false);
}
{
  const { cpu } = makeCpu([0x20, 0xfe]); // BRA -2 (self)
  cpu.step();
  eq('BRA backwards', cpu.pc, ORG);
}
{
  const { cpu } = makeCpu([0x16, 0x01, 0x00]); // LBRA +$100
  cpu.step();
  eq('LBRA target', cpu.pc, ORG + 3 + 0x100);
}
{
  const { cpu } = makeCpu([0x10, 0x27, 0x00, 0x20, 0x10, 0x26, 0x00, 0x20]); // LBEQ / LBNE
  cpu.cc = Z;
  const c1 = cpu.step();
  eq('LBEQ taken target', cpu.pc, ORG + 4 + 0x20);
  eq('LBEQ taken cycles', c1, 6);
  cpu.pc = ORG + 4;
  const c2 = cpu.step(); // LBNE with Z set: not taken
  eq('LBNE untaken pc', cpu.pc, ORG + 8);
  eq('LBNE untaken cycles', c2, 5);
}

// ================================================================ 10. subroutines

section('BSR/LBSR/JSR/RTS');
{
  const { cpu, bus } = makeCpu([0x8d, 0x10]); // BSR +$10
  cpu.step();
  eq('BSR target', cpu.pc, ORG + 2 + 0x10);
  eq('BSR pushes return hi', bus.mem[0x7ffe], (ORG + 2) >> 8);
  eq('BSR pushes return lo', bus.mem[0x7fff], (ORG + 2) & 0xff);
  eq('BSR S', cpu.s, 0x7ffe);
}
{
  const { cpu } = makeCpu([0x17, 0x02, 0x00]); // LBSR +$200
  cpu.step();
  eq('LBSR target', cpu.pc, ORG + 3 + 0x200);
}
{
  const { cpu, bus } = makeCpu([0xbd, 0x20, 0x00]); // JSR $2000
  bus.mem[0x2000] = 0x39; // RTS
  cpu.step();
  eq('JSR extended target', cpu.pc, 0x2000);
  const cyc = cpu.step(); // RTS
  eq('RTS returns', cpu.pc, ORG + 3);
  eq('RTS cycles', cyc, 5);
  eq('RTS restores S', cpu.s, 0x8000);
}
{
  const { cpu } = makeCpu([0x9d, 0x40]); // JSR <40
  cpu.dp = 0x20;
  cpu.step();
  eq('JSR direct target', cpu.pc, 0x2040);
}
{
  const { cpu } = makeCpu([0xad, 0x84]); // JSR ,X
  cpu.x = 0x3000;
  cpu.step();
  eq('JSR indexed target', cpu.pc, 0x3000);
}
{
  const { cpu } = makeCpu([0x6e, 0x84, 0x7e, 0x40, 0x00, 0x0e, 0x20]); // JMP ,X / JMP $4000 / JMP <20
  cpu.x = ORG + 2;
  cpu.step();
  eq('JMP indexed', cpu.pc, ORG + 2);
  cpu.step();
  eq('JMP extended', cpu.pc, 0x4000);
  cpu.pc = ORG + 5;
  cpu.dp = 0x30;
  cpu.step();
  eq('JMP direct', cpu.pc, 0x3020);
}

// ================================================================ 11. SWI / RTI

section('SWI/SWI2/SWI3/RTI');
{
  const { cpu, bus } = makeCpu([0x3f]); // SWI
  bus.mem[0xfffa] = 0x30;
  bus.mem[0xfffb] = 0x00;
  cpu.a = 0x11;
  const cyc = cpu.step();
  eq('SWI cycles', cyc, 19);
  eq('SWI vector', cpu.pc, 0x3000);
  eq('SWI sets E I F', cpu.cc, E | I | F);
  eq('SWI new S', cpu.s, 0x8000 - 12);
  eq('SWI pushed CC has E', bus.mem[0x8000 - 12], E); // E set before push, I/F after
  eq('SWI pushed PCL', bus.mem[0x7fff], 0x01);
}
{
  const { cpu, bus } = makeCpu([0x10, 0x3f, 0x11, 0x3f]); // SWI2 / SWI3
  bus.mem[0xfff4] = 0x31;
  bus.mem[0xfff5] = 0x00;
  bus.mem[0xfff2] = 0x32;
  bus.mem[0xfff3] = 0x00;
  const c1 = cpu.step();
  eq('SWI2 cycles', c1, 20);
  eq('SWI2 vector', cpu.pc, 0x3100);
  eq('SWI2 leaves I/F clear', cpu.cc & (I | F), 0);
  eq('SWI2 sets E', cpu.cc & E, E);
  cpu.pc = ORG + 2;
  const c2 = cpu.step();
  eq('SWI3 cycles', c2, 20);
  eq('SWI3 vector', cpu.pc, 0x3200);
  eq('SWI3 leaves I/F clear', cpu.cc & (I | F), 0);
}
{
  // RTI with E=1: full state restore (15 cycles)
  const { cpu, bus } = makeCpu([0x3b]);
  cpu.s = 0x7000;
  bus.mem.set(
    [E | C, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x21, 0x00],
    0x7000,
  );
  const cyc = cpu.step();
  eq('RTI(E=1) cycles', cyc, 15);
  eq('RTI(E=1) CC', cpu.cc, E | C);
  eq('RTI(E=1) A', cpu.a, 0x11);
  eq('RTI(E=1) B', cpu.b, 0x22);
  eq('RTI(E=1) DP', cpu.dp, 0x33);
  eq('RTI(E=1) X', cpu.x, 0x4455);
  eq('RTI(E=1) Y', cpu.y, 0x6677);
  eq('RTI(E=1) U', cpu.u, 0x8899);
  eq('RTI(E=1) PC', cpu.pc, 0x2100);
  eq('RTI(E=1) S', cpu.s, 0x700c);
}
{
  // RTI with E=0: CC + PC only (6 cycles)
  const { cpu, bus } = makeCpu([0x3b]);
  cpu.s = 0x7000;
  bus.mem.set([C, 0x22, 0x00], 0x7000);
  const cyc = cpu.step();
  eq('RTI(E=0) cycles', cyc, 6);
  eq('RTI(E=0) CC', cpu.cc, C);
  eq('RTI(E=0) PC', cpu.pc, 0x2200);
  eq('RTI(E=0) S', cpu.s, 0x7003);
}
{
  // SWI then RTI round-trips the entire machine state
  const { cpu, bus } = makeCpu([0x3f, 0x12]); // SWI / NOP
  bus.mem[0xfffa] = 0x30;
  bus.mem[0xfffb] = 0x00;
  bus.mem[0x3000] = 0x3b; // RTI
  cpu.a = 0xaa;
  cpu.b = 0xbb;
  cpu.x = 0x1234;
  cpu.cc = N | C;
  cpu.step(); // SWI
  cpu.a = 0;
  cpu.b = 0;
  cpu.x = 0;
  cpu.step(); // RTI
  eq('SWI+RTI PC', cpu.pc, ORG + 1);
  eq('SWI+RTI CC', cpu.cc, E | N | C);
  eq('SWI+RTI A', cpu.a, 0xaa);
  eq('SWI+RTI B', cpu.b, 0xbb);
  eq('SWI+RTI X', cpu.x, 0x1234);
  eq('SWI+RTI S', cpu.s, 0x8000);
}

// ================================================================ 12. hardware interrupts

section('IRQ');
{
  const { cpu, bus } = makeCpu([0x12, 0x12]); // NOPs
  bus.mem[0xfff8] = 0x40;
  bus.mem[0xfff9] = 0x00;
  cpu.setIrqLine(true);
  const cyc = cpu.step();
  eq('IRQ cycles', cyc, 19);
  eq('IRQ vector', cpu.pc, 0x4000);
  eq('IRQ sets I, not F, sets E', cpu.cc, E | I);
  eq('IRQ pushes 12 bytes', cpu.s, 0x8000 - 12);
  eq('IRQ pushed CC has E', bus.mem[0x8000 - 12] & E, E);
  eq('IRQ pushed PC lo', bus.mem[0x7fff], ORG & 0xff);
  eq('IRQ pushed PC hi', bus.mem[0x7ffe], ORG >> 8);
}
{
  const { cpu } = makeCpu([0x12]); // NOP, I masked
  cpu.cc = I;
  cpu.setIrqLine(true);
  cpu.step();
  eq('IRQ masked: instruction runs', cpu.pc, ORG + 1);
}
{
  // level-triggered: line held -> re-taken after RTI
  const { cpu, bus } = makeCpu([0x12, 0x12]);
  bus.mem[0xfff8] = 0x40;
  bus.mem[0xfff9] = 0x00;
  bus.mem[0x4000] = 0x3b; // RTI
  cpu.setIrqLine(true);
  cpu.step(); // IRQ
  cpu.step(); // RTI (restores CC with I clear)
  eq('RTI back', cpu.pc, ORG);
  cpu.step(); // line still high: IRQ again
  eq('IRQ retaken (level)', cpu.pc, 0x4000);
  cpu.setIrqLine(false);
  cpu.step(); // RTI
  cpu.step(); // now executes NOP
  eq('IRQ dropped after line clear', cpu.pc, ORG + 1);
}

section('FIRQ');
{
  const { cpu, bus } = makeCpu([0x12]);
  bus.mem[0xfff6] = 0x41;
  bus.mem[0xfff7] = 0x00;
  cpu.cc = E; // E was set; FIRQ must clear it
  cpu.setFirqLine(true);
  const cyc = cpu.step();
  eq('FIRQ cycles', cyc, 10);
  eq('FIRQ vector', cpu.pc, 0x4100);
  eq('FIRQ sets I+F, clears E', cpu.cc, I | F);
  eq('FIRQ pushes 3 bytes', cpu.s, 0x8000 - 3);
  eq('FIRQ pushed CC (E clear)', bus.mem[0x8000 - 3], 0);
  eq('FIRQ pushed PC hi', bus.mem[0x8000 - 2], ORG >> 8);
  eq('FIRQ pushed PC lo', bus.mem[0x8000 - 1], ORG & 0xff);
}
{
  const { cpu } = makeCpu([0x12]);
  cpu.cc = F;
  cpu.setFirqLine(true);
  cpu.step();
  eq('FIRQ masked: instruction runs', cpu.pc, ORG + 1);
}
{
  // FIRQ + RTI(E=0) round trip
  const { cpu, bus } = makeCpu([0x86, 0x55]); // LDA #$55
  bus.mem[0xfff6] = 0x41;
  bus.mem[0xfff7] = 0x00;
  bus.mem[0x4100] = 0x3b; // RTI
  cpu.setFirqLine(true);
  cpu.step(); // FIRQ
  cpu.setFirqLine(false);
  const cyc = cpu.step(); // RTI: E=0 -> partial pull
  eq('FIRQ RTI cycles (partial)', cyc, 6);
  eq('FIRQ RTI PC', cpu.pc, ORG);
  eq('FIRQ RTI S', cpu.s, 0x8000);
  cpu.step();
  eq('resumes after FIRQ', cpu.a, 0x55);
}

section('NMI edge + post-reset inhibit');
{
  const { cpu, bus } = makeCpu([0x12, 0x10, 0xce, 0x80, 0x00, 0x12, 0x12]);
  // NOP / LDS #$8000 / NOP / NOP
  bus.mem[0xfffc] = 0x42;
  bus.mem[0xfffd] = 0x00;
  cpu.nmi(); // before any LDS: must be ignored
  cpu.step();
  eq('NMI inhibited before LDS', cpu.pc, ORG + 1);
  cpu.step(); // LDS #$8000 arms NMI
  eq('LDS executed', cpu.s, 0x8000);
  cpu.step();
  eq('no phantom NMI after arming', cpu.pc, ORG + 6);
  cpu.nmi();
  const cyc = cpu.step();
  eq('NMI cycles', cyc, 19);
  eq('NMI vector', cpu.pc, 0x4200);
  eq('NMI sets E I F', cpu.cc & (E | I | F), E | I | F);
  eq('NMI pushes 12 bytes', cpu.s, 0x8000 - 12);
}
{
  // NMI is edge triggered: taken once, not retaken
  const { cpu, bus } = makeCpu([0x10, 0xce, 0x80, 0x00, 0x12, 0x12]);
  bus.mem[0xfffc] = 0x42;
  bus.mem[0xfffd] = 0x00;
  bus.mem[0x4200] = 0x3b; // RTI
  cpu.step(); // LDS
  cpu.nmi();
  cpu.step(); // NMI taken
  eq('NMI taken', cpu.pc, 0x4200);
  cpu.step(); // RTI
  cpu.step(); // NOP (no second NMI)
  eq('NMI not retaken (edge)', cpu.pc, ORG + 5);
}
{
  // NMI ignores I/F masks and wins priority over FIRQ/IRQ
  const { cpu, bus } = makeCpu([0x10, 0xce, 0x80, 0x00, 0x12]);
  bus.mem[0xfffc] = 0x42;
  bus.mem[0xfffd] = 0x00;
  cpu.step(); // LDS
  cpu.cc |= I | F;
  cpu.nmi();
  cpu.setIrqLine(true);
  cpu.setFirqLine(true);
  cpu.step();
  eq('NMI wins priority + ignores masks', cpu.pc, 0x4200);
}
{
  // FIRQ beats IRQ
  const { cpu, bus } = makeCpu([0x12]);
  bus.mem[0xfff6] = 0x41;
  bus.mem[0xfff7] = 0x00;
  cpu.setIrqLine(true);
  cpu.setFirqLine(true);
  cpu.step();
  eq('FIRQ beats IRQ', cpu.pc, 0x4100);
}

section('CWAI');
{
  // CWAI waits, then dispatches without a second push
  const { cpu, bus } = makeCpu([0x3c, 0xff]); // CWAI #$FF
  bus.mem[0xfff8] = 0x43;
  bus.mem[0xfff9] = 0x00;
  const c1 = cpu.step();
  eq('CWAI entry cycles', c1, 16);
  eq('CWAI parks', cpu.halted, true);
  eq('CWAI pushed entire state', cpu.s, 0x8000 - 12);
  eq('CWAI pushed CC has E', bus.mem[0x8000 - 12] & E, E);
  const c2 = cpu.step();
  eq('CWAI idle step', c2, 1);
  cpu.setIrqLine(true);
  const c3 = cpu.step();
  eq('CWAI dispatch cycles (no re-push)', c3, 4);
  eq('CWAI dispatch S unchanged', cpu.s, 0x8000 - 12);
  eq('CWAI vector', cpu.pc, 0x4300);
  eq('CWAI IRQ sets I not F', cpu.cc & (I | F), I);
  eq('CWAI unparks', cpu.halted, false);
}
{
  // CWAI fast dispatch: interrupt already pending once the AND unmasks it
  const { cpu, bus } = makeCpu([0x3c, 0xef]); // CWAI #$EF (clears I)
  bus.mem[0xfff8] = 0x43;
  bus.mem[0xfff9] = 0x00;
  cpu.cc = I; // IRQ masked before CWAI
  cpu.setIrqLine(true);
  const cyc = cpu.step();
  eq('CWAI fast-dispatch cycles', cyc, 20);
  eq('CWAI fast-dispatch vector', cpu.pc, 0x4300);
  eq('CWAI fast-dispatch no park', cpu.halted, false);
}
{
  // CWAI + RTI restores full state (E was pushed set)
  const { cpu, bus } = makeCpu([0x3c, 0xff, 0x12]);
  bus.mem[0xfff8] = 0x43;
  bus.mem[0xfff9] = 0x00;
  bus.mem[0x4300] = 0x3b; // RTI
  cpu.a = 0x77;
  cpu.step(); // CWAI parks
  cpu.setIrqLine(true);
  cpu.step(); // dispatch
  cpu.setIrqLine(false);
  cpu.a = 0;
  const cyc = cpu.step(); // RTI full
  eq('CWAI RTI cycles', cyc, 15);
  eq('CWAI RTI PC', cpu.pc, ORG + 2);
  eq('CWAI RTI A', cpu.a, 0x77);
}

section('SYNC');
{
  // SYNC wakes on a masked line and continues with the next instruction
  const { cpu } = makeCpu([0x13, 0x86, 0x55]); // SYNC / LDA #$55
  cpu.cc = I | F;
  const c1 = cpu.step();
  eq('SYNC entry cycles', c1, 2);
  eq('SYNC parks', cpu.halted, true);
  eq('SYNC idle step', cpu.step(), 1);
  cpu.setIrqLine(true);
  const c2 = cpu.step();
  eq('SYNC masked wake: next instruction', cpu.a, 0x55);
  eq('SYNC masked wake cycles', c2, 3); // 1 wake + LDA# 2
  eq('SYNC unparks', cpu.halted, false);
}
{
  // SYNC wakes on an unmasked line and vectors
  const { cpu, bus } = makeCpu([0x13, 0x12]);
  bus.mem[0xfff8] = 0x44;
  bus.mem[0xfff9] = 0x00;
  cpu.step(); // SYNC (cc = 0, IRQ enabled)
  cpu.setIrqLine(true);
  const cyc = cpu.step();
  eq('SYNC unmasked wake: IRQ taken', cpu.pc, 0x4400);
  eq('SYNC wake+IRQ cycles', cyc, 20);
}
{
  // SYNC wakes on FIRQ line too
  const { cpu } = makeCpu([0x13, 0x86, 0x66]);
  cpu.cc = I | F;
  cpu.step();
  cpu.setFirqLine(true);
  cpu.step();
  eq('SYNC wakes on masked FIRQ', cpu.a, 0x66);
}

// ================================================================ 13. prefix pages

section('prefix page behavior');
{
  const { cpu } = makeCpu([0x10, 0x10, 0x8e, 0x12, 0x34]); // repeated $10 prefix
  const cyc = cpu.step();
  eq('10 10 8E stays in page 2 (LDY)', cpu.y, 0x1234);
  eq('repeated prefix cycles', cyc, 5);
}
{
  const { cpu } = makeCpu([0x10, 0x86, 0x55]); // unknown page-2 op -> page 1
  const cyc = cpu.step();
  eq('unknown page-2 executes as page 1', cpu.a, 0x55);
  eq('unknown page-2 cycles', cyc, 3);
}
{
  const { cpu } = makeCpu([0x11, 0x86, 0x66]); // unknown page-3 op -> page 1
  cpu.step();
  eq('unknown page-3 executes as page 1', cpu.a, 0x66);
}

// ================================================================ 14. reset

section('reset');
{
  const { cpu, bus } = makeCpu([0x12]);
  cpu.cc = 0;
  cpu.dp = 0x99;
  bus.mem[0xfffe] = 0x56;
  bus.mem[0xffff] = 0x78;
  cpu.reset();
  eq('reset PC from vector', cpu.pc, 0x5678);
  eq('reset sets I+F', cpu.cc & (I | F), I | F);
  eq('reset clears DP', cpu.dp, 0);
  eq('reset not halted', cpu.halted, false);
}
{
  // reset re-arms the NMI inhibit
  const { cpu, bus } = makeCpu([0x10, 0xce, 0x80, 0x00, 0x12, 0x12]);
  bus.mem[0xfffc] = 0x42;
  bus.mem[0xfffd] = 0x00;
  cpu.step(); // LDS arms
  cpu.reset(); // pc back to ORG, inhibit re-armed
  cpu.cc = 0;
  cpu.nmi(); // inhibited again: dropped
  cpu.step(); // re-executes LDS (which re-arms for later)
  eq('NMI inhibit re-armed by reset', cpu.pc, ORG + 4);
  cpu.nmi(); // now honored
  cpu.step();
  eq('NMI honored after second LDS', cpu.pc, 0x4200);
}

// ================================================================ 15. cycle counts

section('cycle counts: inherent + immediate');
function cycles(program: number[], setup?: (cpu: M6809, bus: TestBus) => void): number {
  const { cpu, bus } = makeCpu(program);
  if (setup) setup(cpu, bus);
  return cpu.step();
}
{
  eq('NOP', cycles([0x12]), 2);
  eq('DAA', cycles([0x19]), 2);
  eq('SEX', cycles([0x1d]), 2);
  eq('ABX', cycles([0x3a]), 3);
  eq('MUL', cycles([0x3d]), 11);
  eq('NEGA', cycles([0x40]), 2);
  eq('CLRA', cycles([0x4f]), 2);
  eq('TSTA', cycles([0x4d]), 2);
  eq('ASLB', cycles([0x58]), 2);
  eq('LDA #', cycles([0x86, 0x00]), 2);
  eq('ADDA #', cycles([0x8b, 0x00]), 2);
  eq('LDD #', cycles([0xcc, 0x00, 0x00]), 3);
  eq('LDX #', cycles([0x8e, 0x00, 0x00]), 3);
  eq('LDU #', cycles([0xce, 0x00, 0x00]), 3);
  eq('LDY #', cycles([0x10, 0x8e, 0x00, 0x00]), 4);
  eq('LDS #', cycles([0x10, 0xce, 0x00, 0x00]), 4);
  eq('CMPX #', cycles([0x8c, 0x00, 0x00]), 4);
  eq('SUBD #', cycles([0x83, 0x00, 0x00]), 4);
  eq('ADDD #', cycles([0xc3, 0x00, 0x00]), 4);
  eq('CMPY #', cycles([0x10, 0x8c, 0x00, 0x00]), 5);
  eq('CMPD #', cycles([0x10, 0x83, 0x00, 0x00]), 5);
  eq('CMPU #', cycles([0x11, 0x83, 0x00, 0x00]), 5);
  eq('CMPS #', cycles([0x11, 0x8c, 0x00, 0x00]), 5);
  eq('ORCC #', cycles([0x1a, 0x00]), 3);
  eq('ANDCC #', cycles([0x1c, 0xff]), 3);
  eq('TFR', cycles([0x1f, 0x12]), 6);
  eq('EXG', cycles([0x1e, 0x12]), 8);
}

section('cycle counts: direct/extended');
{
  eq('LDA direct', cycles([0x96, 0x00]), 4);
  eq('STA direct', cycles([0x97, 0x00]), 4);
  eq('LDD direct', cycles([0xdc, 0x00]), 5);
  eq('STD direct', cycles([0xdd, 0x00]), 5);
  eq('CMPX direct', cycles([0x9c, 0x00]), 6);
  eq('CMPY direct', cycles([0x10, 0x9c, 0x00]), 7);
  eq('NEG direct', cycles([0x00, 0x00]), 6);
  eq('TST direct', cycles([0x0d, 0x00]), 6);
  eq('CLR direct', cycles([0x0f, 0x00]), 6);
  eq('ROL direct', cycles([0x09, 0x00]), 6);
  eq('JMP direct', cycles([0x0e, 0x00]), 3);
  eq('JSR direct', cycles([0x9d, 0x00]), 7);
  eq('LDA extended', cycles([0xb6, 0x20, 0x00]), 5);
  eq('STA extended', cycles([0xb7, 0x20, 0x00]), 5);
  eq('LDX extended', cycles([0xbe, 0x20, 0x00]), 6);
  eq('NEG extended', cycles([0x70, 0x20, 0x00]), 7);
  eq('JMP extended', cycles([0x7e, 0x20, 0x00]), 4);
  eq('JSR extended', cycles([0xbd, 0x20, 0x00]), 8);
  eq('CMPD extended', cycles([0x10, 0xb3, 0x20, 0x00]), 8);
}

section('cycle counts: indexed submodes');
{
  eq('LDA ,X', cycles([0xa6, 0x84]), 4);
  eq('LDA 5-bit,X', cycles([0xa6, 0x01]), 5);
  eq('LDA n8,X', cycles([0xa6, 0x88, 0x10]), 5);
  eq('LDA n16,X', cycles([0xa6, 0x89, 0x01, 0x00]), 8);
  eq('LDA A,X', cycles([0xa6, 0x86]), 5);
  eq('LDA B,X', cycles([0xa6, 0x85]), 5);
  eq('LDA D,X', cycles([0xa6, 0x8b]), 8);
  eq('LDA ,X+', cycles([0xa6, 0x80]), 6);
  eq('LDA ,X++', cycles([0xa6, 0x81]), 7);
  eq('LDA ,-X', cycles([0xa6, 0x82]), 6);
  eq('LDA ,--X', cycles([0xa6, 0x83]), 7);
  eq('LDA n8,PCR', cycles([0xa6, 0x8c, 0x10]), 5);
  eq('LDA n16,PCR', cycles([0xa6, 0x8d, 0x01, 0x00]), 9);
  eq('LDA [n16]', cycles([0xa6, 0x9f, 0x20, 0x00]), 9);
  eq('LDA [,X]', cycles([0xa6, 0x94]), 7);
  eq('LDA [n8,X]', cycles([0xa6, 0x98, 0x10]), 8);
  eq('LDA [,X++]', cycles([0xa6, 0x91]), 10);
  eq('LDA [D,X]', cycles([0xa6, 0x9b]), 11);
  eq('LDX ,X', cycles([0xae, 0x84]), 5);
  eq('LDY ,Y', cycles([0x10, 0xae, 0xa4]), 6);
  eq('LEAX ,X', cycles([0x30, 0x84]), 4);
  eq('LEAX n8,X', cycles([0x30, 0x88, 0x10]), 5);
  eq('JMP ,X', cycles([0x6e, 0x84]), 3);
  eq('NEG ,X', cycles([0x60, 0x84]), 6);
}

section('cycle counts: flow control + stack');
{
  eq('BRA', cycles([0x20, 0x00]), 3);
  eq('BEQ untaken', cycles([0x27, 0x00]), 3);
  eq('BEQ taken', cycles([0x27, 0x00], (cpu) => { cpu.cc = Z; }), 3);
  eq('LBRA', cycles([0x16, 0x00, 0x00]), 5);
  eq('BSR', cycles([0x8d, 0x00]), 7);
  eq('LBSR', cycles([0x17, 0x00, 0x00]), 9);
  eq('PSHS none', cycles([0x34, 0x00]), 5);
  eq('PSHS A', cycles([0x34, 0x02]), 6);
  eq('PSHS all', cycles([0x34, 0xff]), 17);
  eq('PULS none', cycles([0x35, 0x00]), 5);
  eq('PULS all', cycles([0x35, 0xff]), 17);
  eq('PSHU all', cycles([0x36, 0xff]), 17);
  eq('PULU B,X', cycles([0x37, 0x14]), 8);
  eq('SYNC entry', cycles([0x13]), 2);
  eq('CWAI entry', cycles([0x3c, 0xff]), 16);
  eq('IRQ', cycles([0x12], (cpu) => cpu.setIrqLine(true)), 19);
  eq('FIRQ', cycles([0x12], (cpu) => cpu.setFirqLine(true)), 10);
}

// ================================================================ 16. run() + misc

section('run() accumulates cycles');
{
  const { cpu } = makeCpu(new Array<number>(16).fill(0x12)); // NOPs, 2 cycles each
  const total = cpu.run(9); // 2*5 = 10 >= 9
  eq('run() total', total, 10);
  eq('run() pc', cpu.pc, ORG + 5);
}
{
  const { cpu } = makeCpu([0x13]); // SYNC: parked CPU still consumes cycles
  cpu.step();
  const total = cpu.run(5);
  eq('run() while parked', total, 5);
  eq('still parked', cpu.halted, true);
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
