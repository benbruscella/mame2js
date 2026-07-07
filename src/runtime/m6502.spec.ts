// Self-test for the 6502 core. Run with: node src/runtime/m6502.spec.ts
// No test framework; prints PASS/FAIL per section and sets process.exitCode.
//
// If _roms2/nestest.nes and _roms2/nestest.log exist at the repo root, the
// final section replays the nestest golden log (PC/A/X/Y/P/SP/CYC per
// instruction); otherwise it prints a SKIP line and does not fail.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { M6502, type M6502Bus } from './m6502.ts';

// Flag bits (duplicated here on purpose; do not import internals)
const FC = 0x01;
const FZ = 0x02;
const FI = 0x04;
const FD = 0x08;
const FB = 0x10;
const FU = 0x20;
const FV = 0x40;
const FN = 0x80;

class TestBus implements M6502Bus {
  mem = new Uint8Array(0x10000);
  read(addr: number): number {
    return this.mem[addr & 0xffff];
  }
  write(addr: number, data: number): void {
    this.mem[addr & 0xffff] = data & 0xff;
  }
}

function makeCpu(
  program: number[],
  org = 0x0200,
  opts?: { bcd?: boolean },
): { cpu: M6502; bus: TestBus } {
  const bus = new TestBus();
  bus.mem.set(program, org);
  bus.mem[0xfffc] = org & 0xff;
  bus.mem[0xfffd] = (org >> 8) & 0xff;
  const cpu = new M6502(bus, opts);
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

// ================================================================ 1. reset

section('reset and vector init');
{
  const { cpu } = makeCpu([0xea], 0x1234);
  eq('pc from $FFFC', cpu.pc, 0x1234);
  eq('s', cpu.s, 0xfd);
  eq('p = I|U', cpu.p, FI | FU);
  eq('a', cpu.a, 0);
  eq('x', cpu.x, 0);
  eq('y', cpu.y, 0);
  eq('halted', cpu.halted, false);
  eq('irqCount', cpu.irqCount, 0);
}

// ================================================================ 2. loads

section('LDA/LDX/LDY flag battery');
{
  const { cpu } = makeCpu([0xa9, 0x00, 0xa9, 0x80, 0xa9, 0x01]);
  eq('LDA #0 cycles', cpu.step(), 2);
  eq('LDA #0 a', cpu.a, 0);
  eq('LDA #0 Z', (cpu.p & FZ) !== 0, true);
  eq('LDA #0 N', (cpu.p & FN) !== 0, false);
  cpu.step();
  eq('LDA #$80 N', (cpu.p & FN) !== 0, true);
  eq('LDA #$80 Z', (cpu.p & FZ) !== 0, false);
  cpu.step();
  eq('LDA #1 flags clear', cpu.p & (FN | FZ), 0);
}
{
  const { cpu } = makeCpu([0xa2, 0x00, 0xa0, 0xff]);
  cpu.step();
  eq('LDX #0 Z', (cpu.p & FZ) !== 0, true);
  cpu.step();
  eq('LDY #$FF N', (cpu.p & FN) !== 0, true);
  eq('y', cpu.y, 0xff);
}

section('stores');
{
  const { cpu, bus } = makeCpu([0x85, 0x10, 0x86, 0x11, 0x84, 0x12, 0x8d, 0x00, 0x03]);
  cpu.a = 0x42;
  cpu.x = 0x43;
  cpu.y = 0x44;
  const p0 = cpu.p;
  eq('STA zp cycles', cpu.step(), 3);
  eq('STA zp', bus.mem[0x10], 0x42);
  cpu.step();
  eq('STX zp', bus.mem[0x11], 0x43);
  cpu.step();
  eq('STY zp', bus.mem[0x12], 0x44);
  eq('STA abs cycles', cpu.step(), 4);
  eq('STA abs', bus.mem[0x0300], 0x42);
  eq('stores leave flags alone', cpu.p, p0);
}

// ==================================================== 3. addressing modes

section('addressing modes and wraps');
{
  // LDA zp,X wraps within the zero page
  const { cpu, bus } = makeCpu([0xb5, 0x80]);
  bus.mem[0x10] = 0x42;
  cpu.x = 0x90;
  eq('LDA zp,X cycles', cpu.step(), 4);
  eq('LDA zp,X wrap', cpu.a, 0x42);
}
{
  // LDX zp,Y wraps too
  const { cpu, bus } = makeCpu([0xb6, 0x80]);
  bus.mem[0x10] = 0x37;
  cpu.y = 0x90;
  cpu.step();
  eq('LDX zp,Y wrap', cpu.x, 0x37);
}
{
  // LDA abs / abs,X / abs,Y
  const { cpu, bus } = makeCpu([0xad, 0x34, 0x02, 0xbd, 0x30, 0x02, 0xb9, 0x2f, 0x02]);
  bus.mem[0x0234] = 0x11;
  cpu.step();
  eq('LDA abs', cpu.a, 0x11);
  cpu.x = 4;
  eq('LDA abs,X cycles (no cross)', cpu.step(), 4);
  eq('LDA abs,X', cpu.a, 0x11);
  cpu.y = 5;
  cpu.step();
  eq('LDA abs,Y', cpu.a, 0x11);
}
{
  // (zp,X) with index wrap
  const { cpu, bus } = makeCpu([0xa1, 0xf0]);
  bus.mem[0x10] = 0x34;
  bus.mem[0x11] = 0x02;
  bus.mem[0x0234] = 0x77;
  cpu.x = 0x20;
  eq('LDA (zp,X) cycles', cpu.step(), 6);
  eq('LDA (zp,X) wrap', cpu.a, 0x77);
}
{
  // (zp,X) pointer at $FF: high byte comes from $00
  const { cpu, bus } = makeCpu([0xa1, 0xff]);
  bus.mem[0xff] = 0x40;
  bus.mem[0x00] = 0x02;
  bus.mem[0x0240] = 0x55;
  cpu.x = 0;
  cpu.step();
  eq('LDA (zp,X) ptr wrap at $FF', cpu.a, 0x55);
}
{
  // (zp),Y pointer at $FF: high byte comes from $00
  const { cpu, bus } = makeCpu([0xb1, 0xff]);
  bus.mem[0xff] = 0x00;
  bus.mem[0x00] = 0x03;
  bus.mem[0x0301] = 0x66;
  cpu.y = 1;
  eq('LDA (zp),Y cycles (no cross)', cpu.step(), 5);
  eq('LDA (zp),Y ptr wrap at $FF', cpu.a, 0x66);
}
{
  // STA all indexed modes
  const { cpu, bus } = makeCpu([0x95, 0x80, 0x9d, 0x00, 0x03, 0x99, 0x00, 0x03, 0x81, 0x40, 0x91, 0x42]);
  cpu.a = 0x99;
  cpu.x = 0x90;
  cpu.y = 0x05;
  bus.mem[0xd0] = 0x00; // (0x40 + 0x90) & 0xff = 0xd0
  bus.mem[0xd1] = 0x03;
  bus.mem[0x42] = 0x10;
  bus.mem[0x43] = 0x03;
  cpu.step();
  eq('STA zp,X wrap', bus.mem[0x10], 0x99);
  eq('STA abs,X cycles (fixed 5)', cpu.step(), 5);
  eq('STA abs,X', bus.mem[0x0390], 0x99);
  cpu.step();
  eq('STA abs,Y', bus.mem[0x0305], 0x99);
  eq('STA (zp,X) cycles', cpu.step(), 6);
  eq('STA (zp,X)', bus.mem[0x0300], 0x99);
  eq('STA (zp),Y cycles (fixed 6)', cpu.step(), 6);
  eq('STA (zp),Y', bus.mem[0x0315], 0x99);
}

// ======================================================== 4. ADC/SBC binary

section('ADC binary edge cases');
{
  const adcCase = (a: number, m: number, cin: number) => {
    const { cpu } = makeCpu([0x69, m]);
    cpu.a = a;
    cpu.p = FI | FU | (cin !== 0 ? FC : 0);
    cpu.step();
    return cpu;
  };
  // the classic overflow truth table
  let c = adcCase(0x50, 0x10, 0);
  eq('50+10 result', c.a, 0x60);
  eq('50+10 V', (c.p & FV) !== 0, false);
  eq('50+10 C', (c.p & FC) !== 0, false);
  c = adcCase(0x50, 0x50, 0);
  eq('50+50 result', c.a, 0xa0);
  eq('50+50 V', (c.p & FV) !== 0, true);
  eq('50+50 N', (c.p & FN) !== 0, true);
  eq('50+50 C', (c.p & FC) !== 0, false);
  c = adcCase(0x50, 0x90, 0);
  eq('50+90 V', (c.p & FV) !== 0, false);
  c = adcCase(0x50, 0xd0, 0);
  eq('50+d0 result', c.a, 0x20);
  eq('50+d0 C', (c.p & FC) !== 0, true);
  eq('50+d0 V', (c.p & FV) !== 0, false);
  c = adcCase(0xd0, 0x90, 0);
  eq('d0+90 result', c.a, 0x60);
  eq('d0+90 V', (c.p & FV) !== 0, true);
  eq('d0+90 C', (c.p & FC) !== 0, true);
  c = adcCase(0xff, 0x01, 0);
  eq('ff+01 result', c.a, 0x00);
  eq('ff+01 Z', (c.p & FZ) !== 0, true);
  eq('ff+01 C', (c.p & FC) !== 0, true);
  c = adcCase(0xff, 0x00, 1);
  eq('ff+00+C result', c.a, 0x00);
  eq('ff+00+C C', (c.p & FC) !== 0, true);
  c = adcCase(0x7f, 0x00, 1);
  eq('7f+00+C result', c.a, 0x80);
  eq('7f+00+C V', (c.p & FV) !== 0, true);
}

section('SBC binary edge cases');
{
  const sbcCase = (a: number, m: number, cin: number) => {
    const { cpu } = makeCpu([0xe9, m]);
    cpu.a = a;
    cpu.p = FI | FU | (cin !== 0 ? FC : 0);
    cpu.step();
    return cpu;
  };
  let c = sbcCase(0x50, 0xf0, 1);
  eq('50-f0 result', c.a, 0x60);
  eq('50-f0 C (borrow)', (c.p & FC) !== 0, false);
  eq('50-f0 V', (c.p & FV) !== 0, false);
  c = sbcCase(0x50, 0xb0, 1);
  eq('50-b0 result', c.a, 0xa0);
  eq('50-b0 V', (c.p & FV) !== 0, true);
  c = sbcCase(0xd0, 0xb0, 1);
  eq('d0-b0 result', c.a, 0x20);
  eq('d0-b0 C', (c.p & FC) !== 0, true);
  eq('d0-b0 V', (c.p & FV) !== 0, false);
  c = sbcCase(0xd0, 0x70, 1);
  eq('d0-70 result', c.a, 0x60);
  eq('d0-70 V', (c.p & FV) !== 0, true);
  c = sbcCase(0x40, 0x40, 1);
  eq('40-40 result', c.a, 0x00);
  eq('40-40 Z', (c.p & FZ) !== 0, true);
  eq('40-40 C', (c.p & FC) !== 0, true);
  c = sbcCase(0x00, 0x01, 1);
  eq('00-01 result', c.a, 0xff);
  eq('00-01 C (borrow)', (c.p & FC) !== 0, false);
  eq('00-01 N', (c.p & FN) !== 0, true);
  c = sbcCase(0x40, 0x40, 0); // borrow in
  eq('40-40-1 result', c.a, 0xff);
  eq('40-40-1 C', (c.p & FC) !== 0, false);
}

// ============================================================ 5. ADC/SBC BCD

section('BCD ADC/SBC (bcd enabled by default)');
{
  const { cpu } = makeCpu([0xf8, 0x18, 0xa9, 0x09, 0x69, 0x01]);
  for (let i = 0; i < 4; i++) cpu.step();
  eq('BCD 09+01', cpu.a, 0x10);
  eq('BCD 09+01 C', (cpu.p & FC) !== 0, false);
}
{
  const { cpu } = makeCpu([0xf8, 0x38, 0xa9, 0x58, 0x69, 0x46]);
  for (let i = 0; i < 4; i++) cpu.step();
  eq('BCD 58+46+C', cpu.a, 0x05);
  eq('BCD 58+46+C carry', (cpu.p & FC) !== 0, true);
}
{
  const { cpu } = makeCpu([0xf8, 0x18, 0xa9, 0x99, 0x69, 0x01]);
  for (let i = 0; i < 4; i++) cpu.step();
  eq('BCD 99+01', cpu.a, 0x00);
  eq('BCD 99+01 C', (cpu.p & FC) !== 0, true);
  // NMOS quirk: Z reflects the BINARY sum (0x9a), not the decimal result
  eq('BCD 99+01 Z from binary', (cpu.p & FZ) !== 0, false);
}
{
  const { cpu } = makeCpu([0xf8, 0x38, 0xa9, 0x10, 0xe9, 0x05]);
  for (let i = 0; i < 4; i++) cpu.step();
  eq('BCD 10-05', cpu.a, 0x05);
  eq('BCD 10-05 C', (cpu.p & FC) !== 0, true);
}
{
  const { cpu } = makeCpu([0xf8, 0x38, 0xa9, 0x00, 0xe9, 0x01]);
  for (let i = 0; i < 4; i++) cpu.step();
  eq('BCD 00-01', cpu.a, 0x99);
  eq('BCD 00-01 C (borrow)', (cpu.p & FC) !== 0, false);
}

section('bcd:false ignores D flag (RP2A03)');
{
  const { cpu } = makeCpu([0xf8, 0x18, 0xa9, 0x09, 0x69, 0x01], 0x0200, { bcd: false });
  for (let i = 0; i < 4; i++) cpu.step();
  eq('binary 09+01 despite SED', cpu.a, 0x0a);
  eq('D flag still set', (cpu.p & FD) !== 0, true);
}
{
  const { cpu } = makeCpu([0xf8, 0x38, 0xa9, 0x10, 0xe9, 0x05], 0x0200, { bcd: false });
  for (let i = 0; i < 4; i++) cpu.step();
  eq('binary 10-05 despite SED', cpu.a, 0x0b);
}
{
  // CLD clears D even with bcd:false
  const { cpu } = makeCpu([0xf8, 0xd8], 0x0200, { bcd: false });
  cpu.step();
  eq('SED sets D', (cpu.p & FD) !== 0, true);
  cpu.step();
  eq('CLD clears D', (cpu.p & FD) !== 0, false);
}

// ========================================================= 6. compares/BIT

section('compares and BIT');
{
  const { cpu } = makeCpu([0xc9, 0x40, 0xc9, 0x41, 0xc9, 0x3f]);
  cpu.a = 0x40;
  cpu.step();
  eq('CMP equal Z', (cpu.p & FZ) !== 0, true);
  eq('CMP equal C', (cpu.p & FC) !== 0, true);
  eq('CMP equal N', (cpu.p & FN) !== 0, false);
  cpu.step();
  eq('CMP less C', (cpu.p & FC) !== 0, false);
  eq('CMP less N', (cpu.p & FN) !== 0, true);
  cpu.step();
  eq('CMP greater C', (cpu.p & FC) !== 0, true);
  eq('CMP greater Z', (cpu.p & FZ) !== 0, false);
}
{
  const { cpu } = makeCpu([0xe0, 0x10, 0xc0, 0x20]);
  cpu.x = 0x10;
  cpu.y = 0x10;
  cpu.step();
  eq('CPX equal', cpu.p & (FZ | FC), FZ | FC);
  cpu.step();
  eq('CPY less C', (cpu.p & FC) !== 0, false);
}
{
  const { cpu, bus } = makeCpu([0x24, 0x10, 0x24, 0x11]);
  bus.mem[0x10] = 0xc0;
  bus.mem[0x11] = 0x0f;
  cpu.a = 0x0f;
  eq('BIT zp cycles', cpu.step(), 3);
  eq('BIT N from mem', (cpu.p & FN) !== 0, true);
  eq('BIT V from mem', (cpu.p & FV) !== 0, true);
  eq('BIT Z from and', (cpu.p & FZ) !== 0, true);
  cpu.step();
  eq('BIT nonzero Z', (cpu.p & FZ) !== 0, false);
  eq('BIT nonzero N', (cpu.p & FN) !== 0, false);
  eq('BIT nonzero V', (cpu.p & FV) !== 0, false);
}

// ===================================================== 7. shifts and rotates

section('shifts/rotates (accumulator and memory)');
{
  const { cpu } = makeCpu([0xa9, 0x80, 0x0a]);
  cpu.step();
  cpu.step();
  eq('ASL A result', cpu.a, 0x00);
  eq('ASL A C', (cpu.p & FC) !== 0, true);
  eq('ASL A Z', (cpu.p & FZ) !== 0, true);
}
{
  const { cpu } = makeCpu([0x38, 0xa9, 0x40, 0x2a]);
  for (let i = 0; i < 3; i++) cpu.step();
  eq('ROL A result (carry in)', cpu.a, 0x81);
  eq('ROL A C out', (cpu.p & FC) !== 0, false);
  eq('ROL A N', (cpu.p & FN) !== 0, true);
}
{
  const { cpu } = makeCpu([0xa9, 0x01, 0x4a]);
  cpu.step();
  cpu.step();
  eq('LSR A result', cpu.a, 0x00);
  eq('LSR A C', (cpu.p & FC) !== 0, true);
  eq('LSR A Z', (cpu.p & FZ) !== 0, true);
}
{
  const { cpu } = makeCpu([0x38, 0xa9, 0x00, 0x6a]);
  for (let i = 0; i < 3; i++) cpu.step();
  eq('ROR A result (carry in)', cpu.a, 0x80);
  eq('ROR A C out', (cpu.p & FC) !== 0, false);
  eq('ROR A N', (cpu.p & FN) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0x06, 0x10, 0x46, 0x11, 0x26, 0x12, 0x66, 0x13]);
  bus.mem[0x10] = 0xc0;
  bus.mem[0x11] = 0x03;
  bus.mem[0x12] = 0x80;
  bus.mem[0x13] = 0x01;
  eq('ASL zp cycles', cpu.step(), 5);
  eq('ASL zp mem', bus.mem[0x10], 0x80);
  eq('ASL zp C', (cpu.p & FC) !== 0, true);
  cpu.p &= ~FC;
  cpu.step();
  eq('LSR zp mem', bus.mem[0x11], 0x01);
  eq('LSR zp C', (cpu.p & FC) !== 0, true);
  cpu.step(); // ROL $12 with C=1 from LSR
  eq('ROL zp mem', bus.mem[0x12], 0x01);
  eq('ROL zp C', (cpu.p & FC) !== 0, true);
  cpu.step(); // ROR $13 with C=1
  eq('ROR zp mem', bus.mem[0x13], 0x80);
  eq('ROR zp C', (cpu.p & FC) !== 0, true);
}

// ============================================================== 8. inc/dec

section('inc/dec');
{
  const { cpu, bus } = makeCpu([0xe6, 0x10, 0xc6, 0x11, 0xe8, 0xca, 0xc8, 0x88]);
  bus.mem[0x10] = 0xff;
  bus.mem[0x11] = 0x00;
  eq('INC zp cycles', cpu.step(), 5);
  eq('INC zp wrap', bus.mem[0x10], 0x00);
  eq('INC zp Z', (cpu.p & FZ) !== 0, true);
  cpu.step();
  eq('DEC zp wrap', bus.mem[0x11], 0xff);
  eq('DEC zp N', (cpu.p & FN) !== 0, true);
  cpu.x = 0xff;
  cpu.step();
  eq('INX wrap', cpu.x, 0x00);
  eq('INX Z', (cpu.p & FZ) !== 0, true);
  cpu.step();
  eq('DEX wrap', cpu.x, 0xff);
  cpu.y = 0x7f;
  cpu.step();
  eq('INY', cpu.y, 0x80);
  eq('INY N', (cpu.p & FN) !== 0, true);
  cpu.step();
  eq('DEY', cpu.y, 0x7f);
}

// ============================================================ 9. transfers

section('transfers');
{
  const { cpu } = makeCpu([0xaa, 0xa8, 0x8a, 0x98, 0xba, 0x9a]);
  cpu.a = 0x80;
  cpu.step();
  eq('TAX', cpu.x, 0x80);
  eq('TAX N', (cpu.p & FN) !== 0, true);
  cpu.step();
  eq('TAY', cpu.y, 0x80);
  cpu.a = 0;
  cpu.x = 0x12;
  cpu.step();
  eq('TXA', cpu.a, 0x12);
  cpu.y = 0x00;
  cpu.step();
  eq('TYA Z', (cpu.p & FZ) !== 0, true);
  cpu.s = 0x91;
  cpu.step();
  eq('TSX', cpu.x, 0x91);
  eq('TSX N', (cpu.p & FN) !== 0, true);
  const p0 = cpu.p;
  cpu.x = 0x00;
  cpu.p = p0; // TSX left N; TXS with X=0 must NOT set Z
  cpu.step();
  eq('TXS s', cpu.s, 0x00);
  eq('TXS leaves flags alone', cpu.p, p0);
}

// ============================================================== 10. stack

section('stack ops (PHA/PLA/PHP/PLP)');
{
  const { cpu, bus } = makeCpu([0x48, 0x68]);
  cpu.a = 0x42;
  eq('PHA cycles', cpu.step(), 3);
  eq('PHA mem', bus.mem[0x01fd], 0x42);
  eq('PHA s', cpu.s, 0xfc);
  cpu.a = 0;
  eq('PLA cycles', cpu.step(), 4);
  eq('PLA a', cpu.a, 0x42);
  eq('PLA s', cpu.s, 0xfd);
}
{
  const { cpu, bus } = makeCpu([0xa9, 0x80, 0x48, 0xa9, 0x01, 0x68]);
  for (let i = 0; i < 4; i++) cpu.step();
  eq('PLA sets N', (cpu.p & FN) !== 0, true);
  eq('PLA a', cpu.a, 0x80);
  void bus;
}
{
  const { cpu, bus } = makeCpu([0x08]);
  eq('PHP cycles', cpu.step(), 3);
  eq('PHP pushes B|U set', bus.mem[0x01fd], FI | FU | FB | FU);
  eq('live p unchanged (no B)', cpu.p, FI | FU);
}
{
  const { cpu, bus } = makeCpu([0x28, 0x28]);
  bus.mem[0x01fe] = 0xff; // all bits incl. B
  bus.mem[0x01ff] = 0x00; // no bits incl. U
  eq('PLP cycles', cpu.step(), 4);
  eq('PLP ignores B, keeps U', cpu.p, 0xff & ~FB);
  cpu.step();
  eq('PLP forces U on', cpu.p, FU);
}

// ============================================================ 11. JSR/RTS

section('JSR/RTS');
{
  const { cpu, bus } = makeCpu([0x20, 0x00, 0x03]);
  bus.mem[0x0300] = 0x60; // RTS
  eq('JSR cycles', cpu.step(), 6);
  eq('JSR pc', cpu.pc, 0x0300);
  eq('JSR s', cpu.s, 0xfb);
  eq('JSR pushed hi', bus.mem[0x01fd], 0x02);
  eq('JSR pushed lo (pc of last operand byte)', bus.mem[0x01fc], 0x02);
  eq('RTS cycles', cpu.step(), 6);
  eq('RTS pc (pushed+1)', cpu.pc, 0x0203);
  eq('RTS s', cpu.s, 0xfd);
}

// ============================================================ 12. BRK/RTI

section('BRK/RTI');
{
  const { cpu, bus } = makeCpu([0x00, 0xff, 0xea]);
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x05;
  bus.mem[0x0500] = 0x40; // RTI
  cpu.p = FU; // I clear so we can see BRK set it
  eq('BRK cycles', cpu.step(), 7);
  eq('BRK pc', cpu.pc, 0x0500);
  eq('BRK pushed hi', bus.mem[0x01fd], 0x02);
  eq('BRK pushed lo (pc+2, 2-byte instr)', bus.mem[0x01fc], 0x02);
  eq('BRK pushed p has B|U', bus.mem[0x01fb], FU | FB);
  eq('BRK sets I', (cpu.p & FI) !== 0, true);
  eq('BRK does not count as IRQ', cpu.irqCount, 0);
  eq('RTI cycles', cpu.step(), 6);
  eq('RTI pc', cpu.pc, 0x0202);
  eq('RTI restores p (B dropped, U kept)', cpu.p, FU);
}

// ====================================================== 13. branch cycles

section('branches and branch cycles');
{
  // not taken: 2 cycles
  const { cpu } = makeCpu([0xd0, 0x04], 0x0250);
  cpu.p |= FZ;
  eq('BNE not taken cycles', cpu.step(), 2);
  eq('BNE not taken pc', cpu.pc, 0x0252);
}
{
  // taken, same page: 3 cycles
  const { cpu } = makeCpu([0xd0, 0x04], 0x0250);
  eq('BNE taken cycles', cpu.step(), 3);
  eq('BNE taken pc', cpu.pc, 0x0256);
}
{
  // taken, forward page cross (relative to the following instruction): 4
  const { cpu } = makeCpu([0xd0, 0x0e], 0x02f0);
  eq('BNE cross cycles', cpu.step(), 4);
  eq('BNE cross pc', cpu.pc, 0x0300);
}
{
  // taken, target at $02FF (same page as $02F2 follower): 3
  const { cpu } = makeCpu([0xd0, 0x0d], 0x02f0);
  eq('BNE edge-of-page cycles', cpu.step(), 3);
  eq('BNE edge-of-page pc', cpu.pc, 0x02ff);
}
{
  // taken, backward page cross: 4
  const { cpu } = makeCpu([0xd0, 0xfc], 0x0300);
  eq('BNE back-cross cycles', cpu.step(), 4);
  eq('BNE back-cross pc', cpu.pc, 0x02fe);
}
{
  // taken, backward same page: 3
  const { cpu } = makeCpu([0xd0, 0xfc], 0x0310);
  eq('BNE back same-page cycles', cpu.step(), 3);
  eq('BNE back same-page pc', cpu.pc, 0x030e);
}
{
  // each branch takes on the right flag
  const checks: [number, number, boolean][] = [
    [0x10, FN, false], // BPL
    [0x30, FN, true], // BMI
    [0x50, FV, false], // BVC
    [0x70, FV, true], // BVS
    [0x90, FC, false], // BCC
    [0xb0, FC, true], // BCS
    [0xd0, FZ, false], // BNE
    [0xf0, FZ, true], // BEQ
  ];
  for (const [op, flag, takenWhenSet] of checks) {
    const { cpu } = makeCpu([op, 0x02]);
    cpu.p = FI | FU | (takenWhenSet ? flag : 0);
    cpu.step();
    eq(`branch ${op.toString(16)} taken`, cpu.pc, 0x0204);
    const { cpu: cpu2 } = makeCpu([op, 0x02]);
    cpu2.p = FI | FU | (takenWhenSet ? 0 : flag);
    cpu2.step();
    eq(`branch ${op.toString(16)} not taken`, cpu2.pc, 0x0202);
  }
}

// ================================================== 14. JMP + indirect bug

section('JMP and JMP indirect page-wrap bug');
{
  const { cpu } = makeCpu([0x4c, 0x34, 0x12]);
  eq('JMP abs cycles', cpu.step(), 3);
  eq('JMP abs pc', cpu.pc, 0x1234);
}
{
  const { cpu, bus } = makeCpu([0x6c, 0xff, 0x02], 0x0600);
  bus.mem[0x02ff] = 0x34;
  bus.mem[0x0300] = 0x99; // must be ignored
  bus.mem[0x0200] = 0x12; // high byte wraps to $0200
  eq('JMP (ind) cycles', cpu.step(), 5);
  eq('JMP ($xxFF) wraps in page', cpu.pc, 0x1234);
}
{
  const { cpu, bus } = makeCpu([0x6c, 0x40, 0x03]);
  bus.mem[0x0340] = 0x78;
  bus.mem[0x0341] = 0x56;
  cpu.step();
  eq('JMP (ind) normal', cpu.pc, 0x5678);
}

// ================================================================ 15. IRQ

section('IRQ gating, sequence, irqCount');
{
  const { cpu, bus } = makeCpu([0x58, 0xea, 0xea]); // CLI; NOP; NOP
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x04;
  bus.mem[0x0400] = 0x40; // RTI
  cpu.setIrqLine(true);
  // I is set after reset: the first step must execute CLI, not the IRQ
  eq('masked IRQ not taken (cycles=CLI)', cpu.step(), 2);
  eq('masked IRQ pc', cpu.pc, 0x0201);
  eq('irqCount still 0', cpu.irqCount, 0);
  // now I is clear: IRQ taken at the next boundary
  eq('IRQ sequence cycles', cpu.step(), 7);
  eq('IRQ vector', cpu.pc, 0x0400);
  eq('irqCount', cpu.irqCount, 1);
  eq('IRQ sets I', (cpu.p & FI) !== 0, true);
  eq('IRQ pushed pc hi', bus.mem[0x01fd], 0x02);
  eq('IRQ pushed pc lo', bus.mem[0x01fc], 0x01);
  eq('IRQ pushed p (B clear, U set)', bus.mem[0x01fb], FU);
  // handler RTI restores I=0; line still held -> retriggers (level)
  eq('RTI cycles', cpu.step(), 6);
  eq('RTI pc', cpu.pc, 0x0201);
  cpu.step();
  eq('level IRQ retriggers after RTI', cpu.irqCount, 2);
  eq('retrigger pc', cpu.pc, 0x0400);
  // drop the line inside the handler: after RTI, normal execution resumes
  cpu.setIrqLine(false);
  cpu.step(); // RTI
  cpu.step(); // NOP at 0x0201
  eq('line dropped: no third IRQ', cpu.irqCount, 2);
  eq('resumed pc', cpu.pc, 0x0202);
}

// ================================================================ 16. NMI

section('NMI edge, priority over IRQ');
{
  const { cpu, bus } = makeCpu([0xea, 0xea]);
  bus.mem[0xfffa] = 0x00;
  bus.mem[0xfffb] = 0x05;
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x04;
  bus.mem[0x0500] = 0xea; // NOP inside handler
  cpu.nmi();
  eq('NMI taken despite I set, cycles', cpu.step(), 7);
  eq('NMI vector', cpu.pc, 0x0500);
  eq('NMI pushed p (B clear)', bus.mem[0x01fb], FI | FU);
  eq('NMI does not bump irqCount', cpu.irqCount, 0);
  // edge: pending flag consumed; handler runs without retrigger
  cpu.step();
  eq('no NMI retrigger', cpu.pc, 0x0501);
  // a fresh nmi() call re-arms it
  cpu.nmi();
  cpu.step();
  eq('re-armed NMI taken', cpu.pc, 0x0500);
}
{
  // both pending: NMI wins
  const { cpu, bus } = makeCpu([0xea]);
  bus.mem[0xfffa] = 0x00;
  bus.mem[0xfffb] = 0x05;
  bus.mem[0xfffe] = 0x00;
  bus.mem[0xffff] = 0x04;
  cpu.p &= ~FI;
  cpu.setIrqLine(true);
  cpu.nmi();
  cpu.step();
  eq('NMI beats IRQ', cpu.pc, 0x0500);
  eq('IRQ not counted', cpu.irqCount, 0);
}

// ============================================== 17. page-cross penalties

section('page-cross cycle penalties per mode');
{
  const { cpu, bus } = makeCpu([0xbd, 0xff, 0x02]);
  bus.mem[0x0300] = 1;
  cpu.x = 1;
  eq('LDA abs,X cross', cpu.step(), 5);
}
{
  const { cpu } = makeCpu([0xbd, 0x00, 0x03]);
  cpu.x = 0xff;
  eq('LDA abs,X no cross', cpu.step(), 4);
}
{
  const { cpu } = makeCpu([0xb9, 0xff, 0x02]);
  cpu.y = 1;
  eq('LDA abs,Y cross', cpu.step(), 5);
}
{
  const { cpu, bus } = makeCpu([0xb1, 0x40]);
  bus.mem[0x40] = 0xff;
  bus.mem[0x41] = 0x02;
  cpu.y = 1;
  eq('LDA (zp),Y cross', cpu.step(), 6);
}
{
  const { cpu } = makeCpu([0xbe, 0xff, 0x02]);
  cpu.y = 1;
  eq('LDX abs,Y cross', cpu.step(), 5);
}
{
  const { cpu } = makeCpu([0xbc, 0xff, 0x02]);
  cpu.x = 1;
  eq('LDY abs,X cross', cpu.step(), 5);
}
{
  const { cpu } = makeCpu([0xdd, 0xff, 0x02]);
  cpu.x = 1;
  eq('CMP abs,X cross', cpu.step(), 5);
}
{
  // stores never take the penalty
  const { cpu } = makeCpu([0x9d, 0xff, 0x02]);
  cpu.x = 1;
  eq('STA abs,X cross still 5', cpu.step(), 5);
}
{
  const { cpu, bus } = makeCpu([0x91, 0x40]);
  bus.mem[0x40] = 0xff;
  bus.mem[0x41] = 0x02;
  cpu.y = 1;
  eq('STA (zp),Y cross still 6', cpu.step(), 6);
}
{
  // RMW abs,X is always 7
  const { cpu } = makeCpu([0xfe, 0xff, 0x02]);
  cpu.x = 1;
  eq('INC abs,X cross still 7', cpu.step(), 7);
  const { cpu: cpu2 } = makeCpu([0xfe, 0x00, 0x03]);
  eq('INC abs,X no cross still 7', cpu2.step(), 7);
}

// ======================================================= 18. unofficial ops

section('unofficial: LAX/SAX');
{
  const { cpu, bus } = makeCpu([0xa7, 0x10]);
  bus.mem[0x10] = 0x80;
  eq('LAX zp cycles', cpu.step(), 3);
  eq('LAX a', cpu.a, 0x80);
  eq('LAX x', cpu.x, 0x80);
  eq('LAX N', (cpu.p & FN) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0xb3, 0x40]);
  bus.mem[0x40] = 0xff;
  bus.mem[0x41] = 0x02;
  bus.mem[0x0301] = 0x5a;
  cpu.y = 2;
  eq('LAX (zp),Y cross cycles', cpu.step(), 6);
  eq('LAX (zp),Y value', cpu.a, 0x5a);
  eq('LAX (zp),Y x', cpu.x, 0x5a);
}
{
  const { cpu, bus } = makeCpu([0xbf, 0xff, 0x02]);
  bus.mem[0x0301] = 0x21;
  cpu.y = 2;
  eq('LAX abs,Y cross cycles', cpu.step(), 5);
  eq('LAX abs,Y value', cpu.x, 0x21);
}
{
  const { cpu, bus } = makeCpu([0xb7, 0x80]);
  bus.mem[0x10] = 0x33; // zp,Y wrap
  cpu.y = 0x90;
  eq('LAX zp,Y cycles', cpu.step(), 4);
  eq('LAX zp,Y wrap', cpu.a, 0x33);
}
{
  const { cpu, bus } = makeCpu([0x87, 0x20, 0x97, 0x30, 0x8f, 0x00, 0x03, 0x83, 0x50]);
  cpu.a = 0x33;
  cpu.x = 0x0f;
  cpu.y = 0x04;
  bus.mem[0x5f] = 0x40; // (0x50 + 0x0f)
  bus.mem[0x60] = 0x03;
  const p0 = cpu.p;
  eq('SAX zp cycles', cpu.step(), 3);
  eq('SAX zp value', bus.mem[0x20], 0x03);
  eq('SAX zp,Y cycles', cpu.step(), 4);
  eq('SAX zp,Y value', bus.mem[0x34], 0x03);
  eq('SAX abs cycles', cpu.step(), 4);
  eq('SAX abs value', bus.mem[0x0300], 0x03);
  eq('SAX (zp,X) cycles', cpu.step(), 6);
  eq('SAX (zp,X) value', bus.mem[0x0340], 0x03);
  eq('SAX leaves flags alone', cpu.p, p0);
}

section('unofficial: DCP/ISB/SLO/RLA/SRE/RRA');
{
  const { cpu, bus } = makeCpu([0xc7, 0x10]);
  bus.mem[0x10] = 0x41;
  cpu.a = 0x40;
  eq('DCP zp cycles', cpu.step(), 5);
  eq('DCP mem', bus.mem[0x10], 0x40);
  eq('DCP CMP Z', (cpu.p & FZ) !== 0, true);
  eq('DCP CMP C', (cpu.p & FC) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0xd3, 0x40]);
  bus.mem[0x40] = 0xff;
  bus.mem[0x41] = 0x02;
  bus.mem[0x0301] = 0x10;
  cpu.y = 2;
  eq('DCP (zp),Y cycles (fixed 8)', cpu.step(), 8);
  eq('DCP (zp),Y mem', bus.mem[0x0301], 0x0f);
}
{
  const { cpu, bus } = makeCpu([0xdf, 0xff, 0x02]);
  bus.mem[0x0300] = 0x05;
  cpu.x = 1;
  eq('DCP abs,X cycles (fixed 7)', cpu.step(), 7);
  eq('DCP abs,X mem', bus.mem[0x0300], 0x04);
}
{
  const { cpu, bus } = makeCpu([0xe7, 0x10]);
  bus.mem[0x10] = 0x0f;
  cpu.a = 0x20;
  cpu.p |= FC;
  eq('ISB zp cycles', cpu.step(), 5);
  eq('ISB mem', bus.mem[0x10], 0x10);
  eq('ISB a (SBC of inc-ed value)', cpu.a, 0x10);
  eq('ISB C', (cpu.p & FC) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0x07, 0x10]);
  bus.mem[0x10] = 0x41;
  cpu.a = 0x02;
  eq('SLO zp cycles', cpu.step(), 5);
  eq('SLO mem', bus.mem[0x10], 0x82);
  eq('SLO a', cpu.a, 0x82);
  eq('SLO C', (cpu.p & FC) !== 0, false);
  eq('SLO N', (cpu.p & FN) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0x27, 0x10]);
  bus.mem[0x10] = 0x80;
  cpu.a = 0xff;
  cpu.p |= FC;
  eq('RLA zp cycles', cpu.step(), 5);
  eq('RLA mem (rol w/ carry in)', bus.mem[0x10], 0x01);
  eq('RLA a', cpu.a, 0x01);
  eq('RLA C out', (cpu.p & FC) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0x47, 0x10]);
  bus.mem[0x10] = 0x03;
  cpu.a = 0x10;
  eq('SRE zp cycles', cpu.step(), 5);
  eq('SRE mem', bus.mem[0x10], 0x01);
  eq('SRE a', cpu.a, 0x11);
  eq('SRE C', (cpu.p & FC) !== 0, true);
}
{
  const { cpu, bus } = makeCpu([0x67, 0x10]);
  bus.mem[0x10] = 0x03;
  cpu.a = 0x10;
  cpu.p &= ~FC;
  eq('RRA zp cycles', cpu.step(), 5);
  eq('RRA mem (ror)', bus.mem[0x10], 0x01);
  // ADC sees C=1 produced by the ROR: 0x10 + 0x01 + 1
  eq('RRA a', cpu.a, 0x12);
  eq('RRA C out', (cpu.p & FC) !== 0, false);
}
{
  // (zp,X) forms take 8 cycles
  const { cpu, bus } = makeCpu([0x03, 0x40]);
  bus.mem[0x40] = 0x00;
  bus.mem[0x41] = 0x03;
  bus.mem[0x0300] = 0x01;
  eq('SLO (zp,X) cycles', cpu.step(), 8);
  eq('SLO (zp,X) mem', bus.mem[0x0300], 0x02);
}
{
  // abs,Y forms take 7 cycles
  const { cpu, bus } = makeCpu([0xfb, 0xff, 0x02]);
  bus.mem[0x0300] = 0x00;
  cpu.y = 1;
  cpu.a = 0x10;
  cpu.p |= FC;
  eq('ISB abs,Y cycles (fixed 7)', cpu.step(), 7);
  eq('ISB abs,Y mem', bus.mem[0x0300], 0x01);
  eq('ISB abs,Y a', cpu.a, 0x0f);
}

section('unofficial: SBC $EB and NOP family');
{
  const { cpu } = makeCpu([0xeb, 0x01]);
  cpu.a = 0x10;
  cpu.p |= FC;
  eq('SBC $EB cycles', cpu.step(), 2);
  eq('SBC $EB result', cpu.a, 0x0f);
  eq('SBC $EB C', (cpu.p & FC) !== 0, true);
}
{
  // implied 2-cycle NOPs
  for (const op of [0xea, 0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) {
    const { cpu } = makeCpu([op]);
    eq(`NOP $${op.toString(16)} cycles`, cpu.step(), 2);
    eq(`NOP $${op.toString(16)} pc`, cpu.pc, 0x0201);
  }
  // 2-byte immediate NOPs
  for (const op of [0x80, 0x82, 0x89, 0xc2, 0xe2]) {
    const { cpu } = makeCpu([op, 0x55]);
    eq(`NOP imm $${op.toString(16)} cycles`, cpu.step(), 2);
    eq(`NOP imm $${op.toString(16)} pc`, cpu.pc, 0x0202);
  }
  // zp NOPs: 3 cycles
  for (const op of [0x04, 0x44, 0x64]) {
    const { cpu } = makeCpu([op, 0x10]);
    eq(`NOP zp $${op.toString(16)} cycles`, cpu.step(), 3);
    eq(`NOP zp $${op.toString(16)} pc`, cpu.pc, 0x0202);
  }
  // zp,X NOPs: 4 cycles
  for (const op of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) {
    const { cpu } = makeCpu([op, 0x10]);
    eq(`NOP zp,X $${op.toString(16)} cycles`, cpu.step(), 4);
  }
  // abs NOP: 4 cycles
  {
    const { cpu } = makeCpu([0x0c, 0x00, 0x03]);
    eq('NOP abs $0c cycles', cpu.step(), 4);
    eq('NOP abs $0c pc', cpu.pc, 0x0203);
  }
  // abs,X NOPs: 4 (+1 cross)
  for (const op of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) {
    const { cpu } = makeCpu([op, 0x00, 0x03]);
    eq(`NOP abs,X $${op.toString(16)} cycles`, cpu.step(), 4);
    const { cpu: cpu2 } = makeCpu([op, 0xff, 0x02]);
    cpu2.x = 1;
    eq(`NOP abs,X $${op.toString(16)} cross cycles`, cpu2.step(), 5);
  }
  // NOPs must not touch registers or flags
  {
    const { cpu } = makeCpu([0x1c, 0xff, 0x02]);
    cpu.a = 0x12;
    cpu.x = 0x01;
    cpu.y = 0x34;
    const p0 = cpu.p;
    cpu.step();
    eq('NOP leaves a', cpu.a, 0x12);
    eq('NOP leaves flags', cpu.p, p0);
  }
}

// ================================================================ 19. JAM

section('JAM/KIL');
{
  const { cpu, bus } = makeCpu([0x02]);
  bus.mem[0xfffa] = 0x00;
  bus.mem[0xfffb] = 0x05;
  const c = cpu.step();
  eq('JAM step returns cycles', c > 0, true);
  eq('JAM halted', cpu.halted, true);
  eq('JAM pc parked on opcode', cpu.pc, 0x0200);
  eq('halted step still returns cycles', cpu.step() > 0, true);
  eq('halted pc unchanged', cpu.pc, 0x0200);
  cpu.nmi();
  cpu.step();
  eq('jammed CPU ignores NMI', cpu.pc, 0x0200);
  cpu.reset();
  eq('reset clears halted', cpu.halted, false);
}
{
  // all 12 jam opcodes
  for (const op of [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]) {
    const { cpu } = makeCpu([op]);
    cpu.step();
    eq(`JAM $${op.toString(16)}`, cpu.halted, true);
  }
}

// ================================================= 20. all-opcode smoke test

section('all 256 opcodes execute');
{
  for (let op = 0; op < 256; op++) {
    const { cpu } = makeCpu([op, 0x10, 0x02]);
    const cycles = cpu.step();
    eq(`opcode $${op.toString(16)} cycles sane`, cycles >= 1 && cycles <= 8, true);
  }
}

// ============================================================ 21. run()

section('run() consumes at least the requested cycles');
{
  const { cpu } = makeCpu([0xea, 0xea, 0xea, 0xea, 0xea]);
  const t = cpu.run(5); // NOPs are 2 cycles: 2+2+2 = 6
  eq('run total', t, 6);
  eq('run pc', cpu.pc, 0x0203);
}

// ======================================================== 22. nestest log

section('nestest golden log');
{
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const nesPath = root + '_roms2/nestest.nes';
  const logPath = root + '_roms2/nestest.log';
  if (!existsSync(nesPath) || !existsSync(logPath)) {
    console.log('SKIP nestest (place nestest.nes + nestest.log in _roms2/ to enable)');
  } else {
    const rom = readFileSync(nesPath);
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/);
    const bus = new TestBus();
    const prg = rom.subarray(16, 16 + 16384); // iNES: 16-byte header, 16K PRG
    bus.mem.set(prg, 0x8000); // mirrored at $8000 and $C000
    bus.mem.set(prg, 0xc000);
    const cpu = new M6502(bus, { bcd: false }); // RP2A03: no decimal mode
    cpu.pc = 0xc000; // automation entry point
    cpu.p = 0x24;
    cpu.s = 0xfd;
    let cyc = 7;
    const re =
      /^([0-9A-F]{4}).*?A:([0-9A-F]{2}) X:([0-9A-F]{2}) Y:([0-9A-F]{2}) P:([0-9A-F]{2}) SP:([0-9A-F]{2}).*?CYC:(\d+)/;
    let mismatch = false;
    let compared = 0;
    for (let i = 0; i < lines.length && !mismatch; i++) {
      const m = re.exec(lines[i]);
      if (m === null) continue;
      const want = {
        pc: parseInt(m[1], 16),
        a: parseInt(m[2], 16),
        x: parseInt(m[3], 16),
        y: parseInt(m[4], 16),
        p: parseInt(m[5], 16),
        s: parseInt(m[6], 16),
        cyc: parseInt(m[7], 10),
      };
      if (
        cpu.pc !== want.pc ||
        cpu.a !== want.a ||
        cpu.x !== want.x ||
        cpu.y !== want.y ||
        cpu.p !== want.p ||
        cpu.s !== want.s ||
        cyc !== want.cyc
      ) {
        mismatch = true;
        const hex = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');
        console.log(`  nestest mismatch at log line ${i + 1}:`);
        console.log(`    expected ${lines[i].trim()}`);
        console.log(
          `    got      PC:${hex(cpu.pc, 4)} A:${hex(cpu.a, 2)} X:${hex(cpu.x, 2)} ` +
            `Y:${hex(cpu.y, 2)} P:${hex(cpu.p, 2)} SP:${hex(cpu.s, 2)} CYC:${cyc}`,
        );
        break;
      }
      compared++;
      cyc += cpu.step();
    }
    eq('nestest log mismatch', mismatch, false);
    eq('nestest lines compared > 5000', compared > 5000, true);
    eq('nestest official result byte $02', bus.mem[0x02], 0);
    eq('nestest unofficial result byte $03', bus.mem[0x03], 0);
  }
}

// ================================================================ summary

endSection();
console.log('');
if (totalFail === 0) {
  console.log(`OK: all ${totalPass} checks passed`);
} else {
  console.log(`FAILED: ${totalFail} of ${totalPass + totalFail} checks failed`);
  for (const s of failedSections) console.log(`  failed section: ${s}`);
  process.exitCode = 1;
}
