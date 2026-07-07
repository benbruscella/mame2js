// Self-test for the MCS-48 (i8039) core. Run with: node src/runtime/mcs48.spec.ts
// No test framework; prints PASS/FAIL per section and sets process.exitCode.
// Expectations hand-computed from MAME's mcs48.cpp semantics.

import { Mcs48, type Mcs48Bus } from './mcs48.ts';

// PSW bits (duplicated here on purpose; do not import internals)
const C = 0x80;
const AC = 0x40;
const F0 = 0x20;
const BS = 0x10;

class TestBus implements Mcs48Bus {
  rom = new Uint8Array(0x1000); // zero-filled = NOP-filled
  io = new Uint8Array(0x100);
  ioReads: number[] = [];
  ioWrites: Array<[number, number]> = [];
  portWrites: Array<[number, number]> = [];
  p1In = 0xff;
  p2In = 0xff;
  t0 = false;
  t1 = false;
  busIn = 0xff;
  busWrites: number[] = [];
  onPortWrite: ((port: number, data: number) => void) | null = null;

  readProgram(a: number): number {
    return this.rom[a & 0xfff];
  }
  readIo(a: number): number {
    this.ioReads.push(a & 0xff);
    return this.io[a & 0xff];
  }
  writeIo(a: number, d: number): void {
    this.ioWrites.push([a & 0xff, d & 0xff]);
    this.io[a & 0xff] = d & 0xff;
  }
  readPort(p: 1 | 2): number {
    return p === 1 ? this.p1In : this.p2In;
  }
  writePort(p: 1 | 2, d: number): void {
    this.portWrites.push([p, d & 0xff]);
    if (this.onPortWrite) this.onPortWrite(p, d & 0xff);
  }
  testLine(l: 0 | 1): boolean {
    return l === 0 ? this.t0 : this.t1;
  }
  readBus(): number {
    return this.busIn;
  }
  writeBus(d: number): void {
    this.busWrites.push(d & 0xff);
  }
}

const ORG = 0x100;

function mk(program: number[], org = ORG): { cpu: Mcs48; bus: TestBus } {
  const bus = new TestBus();
  bus.rom.set(program, org);
  const cpu = new Mcs48(bus); // constructor resets (fires port/bus writes)
  bus.portWrites.length = 0;
  bus.busWrites.length = 0;
  cpu.pc = org;
  return { cpu, bus };
}

/** step() returns clock cycles; divide by 15 for machine cycles. */
function stepMc(cpu: Mcs48): number {
  return cpu.step() / 15;
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

section('reset behavior');
{
  const bus = new TestBus();
  const cpu = new Mcs48(bus);
  eq('reset pc = 0', cpu.pc, 0);
  eq('reset psw = 0 (sp=0, bank 0)', cpu.psw, 0);
  eq('reset a11 = 0 (MB0)', cpu.a11, 0);
  eq('reset f1 clear', cpu.f1, false);
  eq('reset p1 latch high', cpu.p1, 0xff);
  eq('reset p2 latch high', cpu.p2, 0xff);
  eq('reset fires 2 port writes', bus.portWrites.length, 2);
  eq('reset p1 write value', bus.portWrites[0][0] === 1 && bus.portWrites[0][1] === 0xff, true);
  eq('reset p2 write value', bus.portWrites[1][0] === 2 && bus.portWrites[1][1] === 0xff, true);
  eq('reset bus write 0xff (EA=1 float-high)', bus.busWrites.length === 1 && bus.busWrites[0] === 0xff, true);
  eq('reset RAM is 128 bytes (i8039)', cpu.ram.length, 128);

  // second reset: C/AC survive, everything else re-cleared; A/timer untouched
  cpu.a = 0x55;
  cpu.timer = 0x42;
  cpu.psw = 0xc3; // C+AC+sp=3
  cpu.f1 = true;
  cpu.a11 = 0x800;
  cpu.tirqEnabled = true;
  cpu.xirqEnabled = true;
  cpu.timecountEnabled = 1;
  cpu.reset();
  eq('reset keeps C/AC only in PSW', cpu.psw, C | AC);
  eq('reset keeps A', cpu.a, 0x55);
  eq('reset keeps timer', cpu.timer, 0x42);
  eq('reset clears f1', cpu.f1, false);
  eq('reset clears a11', cpu.a11, 0);
  eq('reset disables timer irq', cpu.tirqEnabled, false);
  eq('reset disables ext irq', cpu.xirqEnabled, false);
  eq('reset stops timer/counter', cpu.timecountEnabled, 0);
}
{
  const bus = new TestBus();
  const cpu = new Mcs48(bus, { ramSize: 64 }); // 8035-style variant hook
  eq('ramSize option honored', cpu.ram.length, 64);
}

// ================================================================ 2. clock-cycle accounting

section('clock-cycle accounting (1 machine cycle = 15 clocks)');
{
  const { cpu } = mk([0x00, 0x23, 0x12]); // NOP / MOV A,#0x12
  eq('NOP costs 15 clocks', cpu.step(), 15);
  eq('MOV A,# costs 30 clocks', cpu.step(), 30);
  eq('MOV A,# result', cpu.a, 0x12);
}
{
  // run() covers the budget with NOPs (15 clocks each)
  const { cpu } = mk([]);
  eq('run(150) = exactly 10 NOPs', cpu.run(150), 150);
  const { cpu: cpu2 } = mk([]);
  eq('run(151) overshoots to 165', cpu2.run(151), 165);
}

// ================================================================ 3. cycle counts vs MAME table

section('per-opcode machine-cycle counts (MAME burn_cycles values)');
{
  // [label, opcode bytes, machine cycles]
  const cases: Array<[string, number[], number]> = [
    ['NOP', [0x00], 1],
    ['illegal 01', [0x01], 1],
    ['OUTL BUS,A', [0x02], 2],
    ['ADD A,#', [0x03, 0x00], 2],
    ['JMP page0', [0x04, 0x00], 2],
    ['EN I', [0x05], 1],
    ['DEC A', [0x07], 1],
    ['INS A,BUS', [0x08], 2],
    ['IN A,P1', [0x09], 2],
    ['IN A,P2', [0x0a], 2],
    ['MOVD A,P4', [0x0c], 2],
    ['INC @R0', [0x10], 1],
    ['JB0', [0x12, 0x00], 2],
    ['ADC A,#', [0x13, 0x00], 2],
    ['CALL page0', [0x14, 0x00], 2],
    ['DIS I', [0x15], 1],
    ['JTF', [0x16, 0x00], 2],
    ['INC A', [0x17], 1],
    ['INC R3', [0x1b], 1],
    ['XCH A,@R0', [0x20], 1],
    ['MOV A,#', [0x23, 0x00], 2],
    ['EN TCNTI', [0x25], 1],
    ['JNT0', [0x26, 0x00], 2],
    ['CLR A', [0x27], 1],
    ['XCH A,R5', [0x2d], 1],
    ['XCHD A,@R0', [0x30], 1],
    ['DIS TCNTI', [0x35], 1],
    ['JT0', [0x36, 0x00], 2],
    ['CPL A', [0x37], 1],
    ['OUTL P1,A', [0x39], 2],
    ['OUTL P2,A', [0x3a], 2],
    ['MOVD P7,A', [0x3f], 2],
    ['ORL A,@R1', [0x41], 1],
    ['MOV A,T', [0x42], 1],
    ['ORL A,#', [0x43, 0x00], 2],
    ['STRT CNT', [0x45], 1],
    ['JNT1', [0x46, 0x00], 2],
    ['SWAP A', [0x47], 1],
    ['ORL A,R0', [0x48], 1],
    ['ANL A,#', [0x53, 0x00], 2],
    ['STRT T', [0x55], 1],
    ['JT1', [0x56, 0x00], 2],
    ['DA A', [0x57], 1],
    ['ADD A,@R0', [0x60], 1],
    ['MOV T,A', [0x62], 1],
    ['STOP TCNT', [0x65], 1],
    ['RRC A', [0x67], 1],
    ['ADD A,R7', [0x6f], 1],
    ['ADC A,@R1', [0x71], 1],
    ['ENT0 CLK', [0x75], 1],
    ['JF1', [0x76, 0x00], 2],
    ['RR A', [0x77], 1],
    ['MOVX A,@R0', [0x80], 2],
    ['MOVX A,@R1', [0x81], 2],
    ['RET', [0x83], 2],
    ['CLR F0', [0x85], 1],
    ['JNI', [0x86, 0x00], 2],
    ['ORL BUS,#', [0x88, 0x00], 2],
    ['ORL P1,#', [0x89, 0x00], 2],
    ['ORL P2,#', [0x8a, 0x00], 2],
    ['MOVX @R0,A', [0x90], 2],
    ['MOVX @R1,A', [0x91], 2],
    ['RETR', [0x93], 2],
    ['CPL F0', [0x95], 1],
    ['JNZ', [0x96, 0x00], 2],
    ['CLR C', [0x97], 1],
    ['ANL BUS,#', [0x98, 0x00], 2],
    ['ANL P1,#', [0x99, 0x00], 2],
    ['ANL P2,#', [0x9a, 0x00], 2],
    ['MOV @R0,A', [0xa0], 1],
    ['MOVP A,@A', [0xa3], 2],
    ['CLR F1', [0xa5], 1],
    ['CPL C', [0xa7], 1],
    ['MOV R2,A', [0xaa], 1],
    ['MOV @R0,#', [0xb0, 0x00], 2],
    ['JMPP @A', [0xb3], 2],
    ['CPL F1', [0xb5], 1],
    ['JF0', [0xb6, 0x00], 2],
    ['MOV R4,#', [0xbc, 0x00], 2],
    ['illegal c0', [0xc0], 1],
    ['SEL RB0', [0xc5], 1],
    ['JZ', [0xc6, 0x00], 2],
    ['MOV A,PSW', [0xc7], 1],
    ['DEC R6', [0xce], 1],
    ['XRL A,@R0', [0xd0], 1],
    ['XRL A,#', [0xd3, 0x00], 2],
    ['SEL RB1', [0xd5], 1],
    ['MOV PSW,A', [0xd7], 1],
    ['XRL A,R1', [0xd9], 1],
    ['MOVP3 A,@A', [0xe3], 2],
    ['SEL MB0', [0xe5], 1],
    ['JNC', [0xe6, 0x00], 2],
    ['RL A', [0xe7], 1],
    ['DJNZ R0', [0xe8, 0x00], 2],
    ['MOV A,@R1', [0xf1], 1],
    ['SEL MB1', [0xf5], 1],
    ['JC', [0xf6, 0x00], 2],
    ['RLC A', [0xf7], 1],
    ['MOV A,R3', [0xfb], 1],
  ];
  for (const [label, bytes, mc] of cases) {
    const { cpu } = mk(bytes);
    eq(`${label} cycles`, stepMc(cpu), mc);
  }
}

// ================================================================ 4. ADD / ADDC flags

section('ADD/ADDC: C + AC flags (imm/reg/@R)');
{
  const { cpu } = mk([0x23, 0x01, 0x03, 0x0f]); // MOV A,#1 / ADD A,#0x0f
  cpu.step();
  cpu.step();
  eq('ADD half-carry result', cpu.a, 0x10);
  eq('ADD half-carry sets AC only', cpu.psw, AC);
}
{
  const { cpu } = mk([0x23, 0x80, 0x03, 0x80]); // 0x80+0x80
  cpu.step();
  cpu.step();
  eq('ADD carry result wraps', cpu.a, 0x00);
  eq('ADD carry sets C only', cpu.psw, C);
}
{
  const { cpu } = mk([0x23, 0x12, 0x03, 0x34]); // no carries
  cpu.step();
  cpu.step();
  eq('ADD plain result', cpu.a, 0x46);
  eq('ADD plain clears C/AC', cpu.psw, 0);
}
{
  // ADD clears stale C/AC from a previous op
  const { cpu } = mk([0x03, 0x01]);
  cpu.a = 0x10;
  cpu.psw = C | AC;
  cpu.step();
  eq('ADD result ignores incoming carry', cpu.a, 0x11);
  eq('ADD clears stale flags', cpu.psw, 0);
}
{
  const { cpu } = mk([0x6b]); // ADD A,R3
  cpu.a = 0x08;
  cpu.setReg(3, 0x0f);
  cpu.step();
  eq('ADD A,R3 result', cpu.a, 0x17);
  eq('ADD A,R3 AC (8+f nibble)', cpu.psw, AC);
}
{
  const { cpu } = mk([0x60]); // ADD A,@R0
  cpu.a = 0xfe;
  cpu.setReg(0, 0x20);
  cpu.ram[0x20] = 0x05;
  cpu.step();
  eq('ADD A,@R0 result', cpu.a, 0x03);
  eq('ADD A,@R0 sets C+AC', cpu.psw, C | AC);
}
{
  const { cpu } = mk([0x13, 0x00]); // ADC A,#0 with C set
  cpu.a = 0xff;
  cpu.psw = C;
  cpu.step();
  eq('ADC carry-in wraps to 0', cpu.a, 0x00);
  eq('ADC sets C+AC (f+0+1)', cpu.psw, C | AC);
}
{
  const { cpu } = mk([0x13, 0x05]); // ADC with C clear = ADD
  cpu.a = 0x02;
  cpu.step();
  eq('ADC no carry-in', cpu.a, 0x07);
  eq('ADC no flags', cpu.psw, 0);
}
{
  const { cpu } = mk([0x7c]); // ADC A,R4
  cpu.a = 0x0f;
  cpu.psw = C;
  cpu.setReg(4, 0x00);
  cpu.step();
  eq('ADC A,R4 result', cpu.a, 0x10);
  eq('ADC A,R4 AC from carry-in', cpu.psw, AC);
}
{
  const { cpu } = mk([0x71]); // ADC A,@R1
  cpu.a = 0x10;
  cpu.psw = C;
  cpu.setReg(1, 0x30);
  cpu.ram[0x30] = 0x20;
  cpu.step();
  eq('ADC A,@R1 result', cpu.a, 0x31);
  eq('ADC A,@R1 flags clear', cpu.psw, 0);
}

// ================================================================ 5. logic ops

section('ANL/ORL/XRL A (imm/reg/@R) leave PSW alone');
{
  const { cpu } = mk([0x43, 0xf0, 0x53, 0x3c, 0xd3, 0xff]); // ORL# / ANL# / XRL#
  cpu.a = 0x0f;
  cpu.psw = C; // must survive logic ops
  cpu.step();
  eq('ORL A,# result', cpu.a, 0xff);
  cpu.step();
  eq('ANL A,# result', cpu.a, 0x3c);
  cpu.step();
  eq('XRL A,# result', cpu.a, 0xc3);
  eq('logic ops leave PSW', cpu.psw, C);
}
{
  // ORL A,Rr for all 8 registers
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0x48 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.setReg(r, 1 << r);
  cpu.a = 0;
  for (let r = 0; r < 8; r++) {
    cpu.step();
    eq(`ORL A,R${r} accumulates`, cpu.a, (1 << (r + 1)) - 1);
  }
}
{
  // ANL A,Rr for all 8 registers
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0x58 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.setReg(r, 0xff ^ (1 << r));
  cpu.a = 0xff;
  for (let r = 0; r < 8; r++) {
    cpu.step();
    eq(`ANL A,R${r} clears bit`, cpu.a, 0xff ^ ((1 << (r + 1)) - 1));
  }
}
{
  // XRL A,Rr for all 8 registers
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0xd8 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.setReg(r, 1 << r);
  cpu.a = 0;
  for (let r = 0; r < 8; r++) {
    cpu.step();
    eq(`XRL A,R${r} toggles bit`, cpu.a, (1 << (r + 1)) - 1);
  }
}
{
  const { cpu } = mk([0x40, 0x51, 0xd0]); // ORL A,@R0 / ANL A,@R1 / XRL A,@R0
  cpu.setReg(0, 0x40);
  cpu.setReg(1, 0x41);
  cpu.ram[0x40] = 0xa5;
  cpu.ram[0x41] = 0x0f;
  cpu.a = 0x00;
  cpu.step();
  eq('ORL A,@R0', cpu.a, 0xa5);
  cpu.step();
  eq('ANL A,@R1', cpu.a, 0x05);
  cpu.step();
  eq('XRL A,@R0', cpu.a, 0xa0);
}

// ================================================================ 6. INC/DEC

section('INC/DEC A, Rr, @R with wrap');
{
  const { cpu } = mk([0x17, 0x07, 0x07]); // INC A / DEC A / DEC A
  cpu.a = 0xff;
  cpu.step();
  eq('INC A wraps 0xff->0', cpu.a, 0x00);
  cpu.step();
  eq('DEC A wraps 0->0xff', cpu.a, 0xff);
  cpu.step();
  eq('DEC A 0xff->0xfe', cpu.a, 0xfe);
}
{
  // INC Rr all 8
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0x18 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.setReg(r, r === 4 ? 0xff : r * 0x10);
  for (let r = 0; r < 8; r++) cpu.step();
  for (let r = 0; r < 8; r++) {
    eq(`INC R${r}`, cpu.reg(r), r === 4 ? 0x00 : r * 0x10 + 1);
  }
}
{
  // DEC Rr all 8
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0xc8 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.setReg(r, r === 2 ? 0x00 : r + 1);
  for (let r = 0; r < 8; r++) cpu.step();
  for (let r = 0; r < 8; r++) {
    eq(`DEC R${r}`, cpu.reg(r), r === 2 ? 0xff : r);
  }
}
{
  const { cpu } = mk([0x10, 0x11]); // INC @R0 / INC @R1
  cpu.setReg(0, 0x50);
  cpu.setReg(1, 0x51);
  cpu.ram[0x50] = 0xff;
  cpu.ram[0x51] = 0x07;
  cpu.step();
  eq('INC @R0 wraps in RAM', cpu.ram[0x50], 0x00);
  cpu.step();
  eq('INC @R1', cpu.ram[0x51], 0x08);
}

// ================================================================ 7. CLR/CPL

section('CLR/CPL A, C, F0, F1');
{
  const { cpu } = mk([0x27, 0x37, 0x97, 0xa7, 0xa7, 0x85, 0x95, 0x95, 0xa5, 0xb5, 0xb5]);
  cpu.a = 0x5a;
  cpu.step();
  eq('CLR A', cpu.a, 0);
  cpu.step();
  eq('CPL A', cpu.a, 0xff);
  cpu.psw = C | F0;
  cpu.step();
  eq('CLR C', cpu.psw, F0);
  cpu.step();
  eq('CPL C set', cpu.psw, F0 | C);
  cpu.step();
  eq('CPL C clear', cpu.psw, F0);
  cpu.step();
  eq('CLR F0', cpu.psw, 0);
  cpu.step();
  eq('CPL F0 set', cpu.psw, F0);
  cpu.step();
  eq('CPL F0 clear', cpu.psw, 0);
  cpu.f1 = true;
  cpu.step();
  eq('CLR F1', cpu.f1, false);
  cpu.step();
  eq('CPL F1 set', cpu.f1, true);
  cpu.step();
  eq('CPL F1 clear', cpu.f1, false);
}

// ================================================================ 8. DA A

section('DA A decimal adjust (MAME algorithm)');
{
  const cases: Array<[number, number, number, number]> = [
    // [a-in, psw-in, a-out, psw-out] (psw only C/AC relevant; C never cleared)
    [0x0a, 0, 0x10, 0],
    [0x9a, 0, 0x00, C],
    [0xff, 0, 0x65, C],
    [0x03, AC, 0x09, AC],
    [0x99, 0, 0x99, 0],
    [0x1a, C, 0x80, C],
    [0x2c, 0, 0x32, 0],
    [0xa0, 0, 0x00, C],
  ];
  for (const [ain, pin, aout, pout] of cases) {
    const { cpu } = mk([0x57]);
    cpu.a = ain;
    cpu.psw = pin;
    cpu.step();
    eq(`DA A(${ain.toString(16)},psw=${pin.toString(16)}) result`, cpu.a, aout);
    eq(`DA A(${ain.toString(16)},psw=${pin.toString(16)}) psw`, cpu.psw, pout);
  }
}

// ================================================================ 9. rotates + SWAP

section('RL/RLC/RR/RRC/SWAP');
{
  const { cpu } = mk([0xe7, 0x77, 0x47]); // RL / RR / SWAP
  cpu.a = 0x81;
  cpu.step();
  eq('RL 0x81 -> 0x03', cpu.a, 0x03);
  cpu.a = 0x81;
  cpu.step();
  eq('RR 0x81 -> 0xc0', cpu.a, 0xc0);
  cpu.a = 0x12;
  cpu.step();
  eq('SWAP 0x12 -> 0x21', cpu.a, 0x21);
}
{
  const { cpu } = mk([0xf7, 0xf7]); // RLC twice
  cpu.a = 0x81;
  cpu.psw = 0;
  cpu.step();
  eq('RLC result (C in=0)', cpu.a, 0x02);
  eq('RLC C out = old bit7', cpu.psw, C);
  cpu.step();
  eq('RLC result (C in=1)', cpu.a, 0x05);
  eq('RLC C out clear', cpu.psw, 0);
}
{
  const { cpu } = mk([0x67, 0x67]); // RRC twice
  cpu.a = 0x81;
  cpu.psw = 0;
  cpu.step();
  eq('RRC result (C in=0)', cpu.a, 0x40);
  eq('RRC C out = old bit0', cpu.psw, C);
  cpu.step();
  eq('RRC result (C in=1)', cpu.a, 0xa0);
  eq('RRC C out clear', cpu.psw, 0);
}

// ================================================================ 10. MOV forms

section('MOV A/Rr/@R immediate + register + indirect');
{
  // MOV Rr,#n then MOV A,Rr for all 8 registers
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0xb8 | r, 0x10 + r);
  for (let r = 0; r < 8; r++) prog.push(0xf8 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.step();
  for (let r = 0; r < 8; r++) {
    eq(`MOV R${r},# stored in RAM[${r}]`, cpu.ram[r], 0x10 + r);
  }
  for (let r = 0; r < 8; r++) {
    cpu.step();
    eq(`MOV A,R${r}`, cpu.a, 0x10 + r);
  }
}
{
  // MOV Rr,A for all 8
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0x23, 0x20 + r, 0xa8 | r); // MOV A,# / MOV Rr,A
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) {
    cpu.step();
    cpu.step();
    eq(`MOV R${r},A`, cpu.reg(r), 0x20 + r);
  }
}
{
  const { cpu } = mk([0xf0, 0xa1, 0xb0, 0x77]); // MOV A,@R0 / MOV @R1,A / MOV @R0,#0x77
  cpu.setReg(0, 0x60);
  cpu.setReg(1, 0x61);
  cpu.ram[0x60] = 0x99;
  cpu.step();
  eq('MOV A,@R0', cpu.a, 0x99);
  cpu.step();
  eq('MOV @R1,A', cpu.ram[0x61], 0x99);
  cpu.step();
  eq('MOV @R0,#', cpu.ram[0x60], 0x77);
}

section('XCH / XCHD');
{
  // XCH A,Rr for all 8
  const prog: number[] = [];
  for (let r = 0; r < 8; r++) prog.push(0x28 | r);
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.setReg(r, 0x30 + r);
  cpu.a = 0x00;
  let prevA = 0x00;
  for (let r = 0; r < 8; r++) {
    cpu.step();
    eq(`XCH A,R${r}: A gets old reg`, cpu.a, 0x30 + r);
    eq(`XCH A,R${r}: reg gets old A`, cpu.reg(r), prevA);
    prevA = 0x30 + r;
  }
}
{
  const { cpu } = mk([0x20, 0x31]); // XCH A,@R0 / XCHD A,@R1
  cpu.setReg(0, 0x40);
  cpu.setReg(1, 0x41);
  cpu.ram[0x40] = 0x11;
  cpu.ram[0x41] = 0xcd;
  cpu.a = 0xee;
  cpu.step();
  eq('XCH A,@R0: A', cpu.a, 0x11);
  eq('XCH A,@R0: RAM', cpu.ram[0x40], 0xee);
  cpu.a = 0xab;
  cpu.step();
  eq('XCHD low-nibble swap: A', cpu.a, 0xad);
  eq('XCHD low-nibble swap: RAM', cpu.ram[0x41], 0xcb);
}

section('MOV A,PSW / MOV PSW,A / MOV T,A / MOV A,T');
{
  const { cpu } = mk([0xc7]); // MOV A,PSW
  cpu.psw = C | BS | 0x05;
  cpu.step();
  eq('MOV A,PSW reads bit 3 as 1', cpu.a, C | BS | 0x05 | 0x08);
}
{
  const { cpu } = mk([0xd7, 0x14, 0x00]); // MOV PSW,A / CALL 0
  cpu.a = 0xff;
  cpu.step();
  eq('MOV PSW,A drops bit 3', cpu.psw, 0xf7);
  eq('MOV PSW,A selects bank 1', cpu.reg(0) === cpu.ram[24], true);
  // stack pointer 7 -> CALL pushes at RAM 0x16/0x17
  cpu.step();
  eq('CALL after MOV PSW,A uses sp=7 slot lo', cpu.ram[0x16], 0x03);
  eq('CALL after MOV PSW,A uses sp=7 slot hi', cpu.ram[0x17], 0xf1);
  eq('sp wraps 7->0', cpu.psw & 7, 0);
}
{
  const { cpu } = mk([0x62, 0x27, 0x42]); // MOV T,A / CLR A / MOV A,T
  cpu.a = 0x9c;
  cpu.step();
  eq('MOV T,A', cpu.timer, 0x9c);
  cpu.step();
  cpu.step();
  eq('MOV A,T', cpu.a, 0x9c);
}

// ================================================================ 11. MOVP / MOVP3 / JMPP

section('MOVP/MOVP3/JMPP page arithmetic');
{
  const { cpu, bus } = mk([0xa3], 0x245); // MOVP A,@A at 0x245
  bus.rom[0x210] = 0x5a;
  cpu.a = 0x10;
  cpu.step();
  eq('MOVP reads from current page', cpu.a, 0x5a);
  eq('MOVP leaves pc after opcode', cpu.pc, 0x246);
}
{
  // MOVP at 0x2ff: pc has already advanced to 0x300, so page = 0x300
  const { cpu, bus } = mk([0xa3], 0x2ff);
  bus.rom[0x302] = 0x77;
  cpu.a = 0x02;
  cpu.step();
  eq('MOVP page comes from pc AFTER fetch', cpu.a, 0x77);
}
{
  const { cpu, bus } = mk([0xe3], 0x245); // MOVP3
  bus.rom[0x341] = 0x99;
  cpu.a = 0x41;
  cpu.step();
  eq('MOVP3 reads page 3', cpu.a, 0x99);
}
{
  const { cpu, bus } = mk([0xb3], 0x245); // JMPP @A
  bus.rom[0x230] = 0x88;
  cpu.a = 0x30;
  cpu.step();
  eq('JMPP jumps within page', cpu.pc, 0x288);
}

// ================================================================ 12. MOVX

section('MOVX external data space (readIo/writeIo)');
{
  const { cpu, bus } = mk([0x80, 0x91, 0x81, 0x90]);
  cpu.setReg(0, 0x34);
  cpu.setReg(1, 0xcd);
  bus.io[0x34] = 0xab;
  bus.io[0xcd] = 0x12;
  eq('MOVX A,@R0 costs 2 mc', stepMc(cpu), 2);
  eq('MOVX A,@R0 value', cpu.a, 0xab);
  eq('MOVX A,@R0 address', bus.ioReads[0], 0x34);
  cpu.step(); // MOVX @R1,A
  eq('MOVX @R1,A writes', bus.io[0xcd], 0xab);
  eq('MOVX @R1,A address', bus.ioWrites[0][0], 0xcd);
  cpu.step(); // MOVX A,@R1
  eq('MOVX A,@R1 value', cpu.a, 0xab);
  cpu.a = 0x9f;
  cpu.step(); // MOVX @R0,A
  eq('MOVX @R0,A writes', bus.io[0x34], 0x9f);
  eq('junofrst/gyruss soundlatch2 pattern: read count', bus.ioReads.length, 2);
}

// ================================================================ 13. ports

section('P1/P2: OUTL, ANL, ORL, IN (latch AND)');
{
  const { cpu, bus } = mk([0x39, 0x99, 0x0f, 0x89, 0xf0, 0x3a, 0x9a, 0x70, 0x8a, 0x01]);
  cpu.a = 0x3c;
  cpu.step(); // OUTL P1,A
  eq('OUTL P1,A latch', cpu.p1, 0x3c);
  eq('OUTL P1,A callback', bus.portWrites[0][0] === 1 && bus.portWrites[0][1] === 0x3c, true);
  cpu.step(); // ANL P1,#0x0f
  eq('ANL P1,# latch', cpu.p1, 0x0c);
  eq('ANL P1,# callback', bus.portWrites[1][1], 0x0c);
  cpu.step(); // ORL P1,#0xf0
  eq('ORL P1,# latch', cpu.p1, 0xfc);
  eq('ORL P1,# callback', bus.portWrites[2][1], 0xfc);
  cpu.a = 0x81;
  cpu.step(); // OUTL P2,A
  eq('OUTL P2,A latch', cpu.p2, 0x81);
  eq('OUTL P2,A callback port', bus.portWrites[3][0], 2);
  eq('OUTL P2,A callback data', bus.portWrites[3][1], 0x81);
  cpu.step(); // ANL P2,#0x70
  eq('ANL P2,# latch', cpu.p2, 0x00);
  cpu.step(); // ORL P2,#0x01
  eq('ORL P2,# latch', cpu.p2, 0x01);
  eq('every port op fired the callback', bus.portWrites.length, 6);
}
{
  const { cpu, bus } = mk([0x09, 0x39, 0x09, 0x0a]); // IN A,P1 / OUTL P1,A(=0x0f) / IN A,P1 / IN A,P2
  bus.p1In = 0x5a;
  bus.p2In = 0xa5;
  cpu.step();
  eq('IN A,P1 with latch 0xff', cpu.a, 0x5a);
  cpu.a = 0x0f;
  cpu.step();
  cpu.step();
  eq('IN A,P1 ANDs the output latch', cpu.a, 0x5a & 0x0f);
  cpu.step();
  eq('IN A,P2 ANDs latch (0xff after reset... latched 0xff)', cpu.a, 0xa5);
}

// ================================================================ 14. BUS ops

section('BUS: INS/OUTL/ORL/ANL + missing-callback defaults');
{
  const { cpu, bus } = mk([0x08, 0x02, 0x88, 0xf0, 0x98, 0x3c]);
  bus.busIn = 0x77;
  cpu.step();
  eq('INS A,BUS', cpu.a, 0x77);
  cpu.a = 0x21;
  cpu.step();
  eq('OUTL BUS,A', bus.busWrites[0], 0x21);
  bus.busIn = 0x0f;
  cpu.step();
  eq('ORL BUS,# writes in|arg', bus.busWrites[1], 0xff);
  bus.busIn = 0x35;
  cpu.step();
  eq('ANL BUS,# writes in&arg', bus.busWrites[2], 0x34);
}
{
  // bus without readBus/writeBus: INS reads 0xff, writes are dropped
  const minimal: Mcs48Bus = {
    readProgram: (a) => [0x08, 0x02][a] ?? 0,
    readIo: () => 0,
    writeIo: () => {},
    readPort: () => 0xff,
    writePort: () => {},
  };
  const cpu = new Mcs48(minimal);
  cpu.step();
  eq('INS A,BUS defaults to 0xff', cpu.a, 0xff);
  cpu.step(); // OUTL BUS,A must not throw
  eq('OUTL BUS,A without callback is a no-op', cpu.pc, 2);
}

// ================================================================ 15. JMP + memory banks

section('JMP pages, SEL MB0/MB1, PC wrap');
{
  for (let page = 0; page < 8; page++) {
    const { cpu } = mk([0x04 | (page << 5), 0x23]);
    cpu.step();
    eq(`JMP page ${page}`, cpu.pc, (page << 8) | 0x23);
  }
}
{
  const { cpu } = mk([0xf5, 0x04, 0x10, 0xe5], 0x200); // SEL MB1 / JMP 0x010 / (at 0x810:) ...
  cpu.step();
  eq('SEL MB1 latches a11', cpu.a11, 0x800);
  cpu.step();
  eq('JMP with MB1 goes to bank 1', cpu.pc, 0x810);
}
{
  const { cpu, bus } = mk([]);
  bus.rom[0x300] = 0xe5; // SEL MB0
  bus.rom[0x301] = 0xf5; // SEL MB1
  cpu.pc = 0x300;
  cpu.step();
  eq('SEL MB0 latch', cpu.a11, 0);
  cpu.step();
  eq('SEL MB1 latch again', cpu.a11, 0x800);
}
{
  // sequential PC wrap: 2K page boundary
  const { cpu, bus } = mk([]);
  bus.rom[0x7ff] = 0x17; // INC A
  cpu.pc = 0x7ff;
  cpu.step();
  eq('PC wraps 0x7ff -> 0x000', cpu.pc, 0x000);
  bus.rom[0xfff] = 0x17;
  cpu.pc = 0xfff;
  cpu.step();
  eq('PC wraps 0xfff -> 0x800 (A11 kept)', cpu.pc, 0x800);
}
{
  // 2-byte instruction spanning the wrap: arg comes from 0x000
  const { cpu, bus } = mk([]);
  bus.rom[0x7ff] = 0x23; // MOV A,#
  bus.rom[0x000] = 0x42;
  cpu.pc = 0x7ff;
  cpu.step();
  eq('arg fetch wraps within 2K page', cpu.a, 0x42);
  eq('pc after wrap-spanning 2-byte op', cpu.pc, 0x001);
}

// ================================================================ 16. CALL/RET/RETR + stack

section('CALL/RET/RETR stack layout in RAM 0x08-0x17');
{
  const { cpu } = mk([0x14, 0x40], 0x105); // CALL 0x040 from 0x105
  cpu.psw = C; // C must be saved in the stacked high nibble
  cpu.step();
  eq('CALL target', cpu.pc, 0x040);
  eq('CALL pushes PC low at RAM[8]', cpu.ram[8], 0x07);
  eq('CALL pushes PC-hi|PSW-hi at RAM[9]', cpu.ram[9], 0x81);
  eq('CALL bumps sp', cpu.psw & 7, 1);
  eq('CALL leaves flags', cpu.psw & 0xf0, C);
}
{
  // CALL with MB1: target in bank 1
  const { cpu } = mk([0xf5, 0x34, 0x20], 0x105); // SEL MB1 / CALL 0x120
  cpu.step();
  cpu.step();
  eq('CALL with MB1 target', cpu.pc, 0x920);
}
{
  // RETR restores PSW high nibble (incl. bank); RET does not
  const { cpu, bus } = mk([0xd5, 0x14, 0x40], 0x105); // SEL RB1 / CALL 0x040
  bus.rom[0x040] = 0xc5; // SEL RB0 (inside sub)
  bus.rom[0x041] = 0x93; // RETR
  cpu.step(); // SEL RB1
  eq('SEL RB1 sets BS', cpu.psw & BS, BS);
  cpu.step(); // CALL
  cpu.step(); // SEL RB0
  eq('SEL RB0 clears BS', cpu.psw & BS, 0);
  cpu.step(); // RETR
  eq('RETR return address', cpu.pc, 0x108);
  eq('RETR restores BS', cpu.psw & BS, BS);
  eq('RETR pops sp', cpu.psw & 7, 0);
}
{
  const { cpu, bus } = mk([0x14, 0x40], 0x105); // CALL 0x040
  bus.rom[0x040] = 0xa7; // CPL C
  bus.rom[0x041] = 0x83; // RET
  cpu.step();
  cpu.step(); // CPL C
  cpu.step(); // RET
  eq('RET return address', cpu.pc, 0x107);
  eq('RET keeps live PSW flags (C stays set)', cpu.psw & C, C);
  eq('RET pops sp', cpu.psw & 7, 0);
}
{
  // stack slots + 8-level wrap: sp=6 -> 0x14/0x15, sp=7 -> 0x16/0x17, then wrap to 8/9
  const { cpu, bus } = mk([]);
  bus.rom[0x105] = 0x14; bus.rom[0x106] = 0x40; // CALL 0x040
  bus.rom[0x040] = 0x14; bus.rom[0x041] = 0x60; // CALL 0x060
  bus.rom[0x060] = 0x14; bus.rom[0x061] = 0x80; // CALL 0x080
  cpu.pc = 0x105;
  cpu.psw = 0x06; // sp = 6
  cpu.step();
  eq('sp=6 slot low', cpu.ram[0x14], 0x07);
  eq('sp=6 slot high', cpu.ram[0x15], 0x01);
  cpu.step();
  eq('sp=7 slot low', cpu.ram[0x16], 0x42);
  eq('sp=7 slot high', cpu.ram[0x17], 0x00);
  eq('sp wrapped to 0', cpu.psw & 7, 0);
  cpu.step();
  eq('wrapped push reuses RAM[8]', cpu.ram[8], 0x62);
  eq('sp now 1', cpu.psw & 7, 1);
}

// ================================================================ 17. conditional jumps

section('conditional jumps: taken / not taken');
{
  // helper: run a single 2-byte jcc at ORG with offset 0x55, report pc
  const jcc = (op: number, setup: (cpu: Mcs48, bus: TestBus) => void): number => {
    const { cpu, bus } = mk([op, 0x55]);
    setup(cpu, bus);
    cpu.step();
    return cpu.pc;
  };
  const TAKEN = 0x155; // page of arg byte (0x101) = 0x100
  const NEXT = 0x102;

  eq('JC taken', jcc(0xf6, (c) => { c.psw = C; }), TAKEN);
  eq('JC not taken', jcc(0xf6, () => {}), NEXT);
  eq('JNC taken', jcc(0xe6, () => {}), TAKEN);
  eq('JNC not taken', jcc(0xe6, (c) => { c.psw = C; }), NEXT);
  eq('JZ taken', jcc(0xc6, (c) => { c.a = 0; }), TAKEN);
  eq('JZ not taken', jcc(0xc6, (c) => { c.a = 1; }), NEXT);
  eq('JNZ taken', jcc(0x96, (c) => { c.a = 1; }), TAKEN);
  eq('JNZ not taken', jcc(0x96, (c) => { c.a = 0; }), NEXT);
  eq('JT0 taken', jcc(0x36, (_c, b) => { b.t0 = true; }), TAKEN);
  eq('JT0 not taken', jcc(0x36, () => {}), NEXT);
  eq('JNT0 taken', jcc(0x26, () => {}), TAKEN);
  eq('JNT0 not taken', jcc(0x26, (_c, b) => { b.t0 = true; }), NEXT);
  eq('JT1 taken', jcc(0x56, (_c, b) => { b.t1 = true; }), TAKEN);
  eq('JT1 not taken', jcc(0x56, () => {}), NEXT);
  eq('JNT1 taken', jcc(0x46, () => {}), TAKEN);
  eq('JNT1 not taken', jcc(0x46, (_c, b) => { b.t1 = true; }), NEXT);
  eq('JF0 taken', jcc(0xb6, (c) => { c.psw = F0; }), TAKEN);
  eq('JF0 not taken', jcc(0xb6, () => {}), NEXT);
  eq('JF1 taken', jcc(0x76, (c) => { c.f1 = true; }), TAKEN);
  eq('JF1 not taken', jcc(0x76, () => {}), NEXT);
  // JNI jumps when the (active-low) INT pin is asserted: MAME jcc(irq_state)
  eq('JNI taken (line asserted)', jcc(0x86, (c) => { c.setIrqLine(true); }), TAKEN);
  eq('JNI not taken (line clear)', jcc(0x86, () => {}), NEXT);

  // JBb: all 8 bits, taken and not taken
  for (let b = 0; b < 8; b++) {
    const op = 0x12 | (b << 5);
    eq(`JB${b} taken`, jcc(op, (c) => { c.a = 1 << b; }), TAKEN);
    eq(`JB${b} not taken`, jcc(op, (c) => { c.a = 0xff ^ (1 << b); }), NEXT);
  }
}
{
  // JTF: taken when flag set, and the flag clears either way
  const { cpu } = mk([0x16, 0x55, 0x16, 0x00]);
  cpu.timerFlag = true;
  cpu.step();
  eq('JTF taken', cpu.pc, 0x155);
  eq('JTF clears the flag', cpu.timerFlag, false);
  cpu.pc = 0x102;
  cpu.step();
  eq('JTF not taken falls through', cpu.pc, 0x104);
}
{
  // page-crossing: opcode at 0x0ff, arg at 0x100 -> target page is 0x100
  const { cpu, bus } = mk([]);
  bus.rom[0x0ff] = 0xf6; // JC
  bus.rom[0x100] = 0x55;
  cpu.psw = C;
  cpu.pc = 0x0ff;
  cpu.step();
  eq('jcc page from argument byte address', cpu.pc, 0x155);
}

// ================================================================ 18. DJNZ

section('DJNZ');
{
  // DJNZ each register once with reg=1 (falls through, reg -> 0)
  for (let r = 0; r < 8; r++) {
    const { cpu } = mk([0xe8 | r, 0x55]);
    cpu.setReg(r, 1);
    cpu.step();
    eq(`DJNZ R${r} falls through at 0`, cpu.pc, 0x102);
    eq(`DJNZ R${r} decrements`, cpu.reg(r), 0);
  }
}
{
  const { cpu } = mk([0xea, 0x00]); // DJNZ R2, 0x100 (self-loop)
  cpu.setReg(2, 3);
  eq('DJNZ taken cycles', stepMc(cpu), 2);
  eq('DJNZ taken target', cpu.pc, 0x100);
  cpu.step();
  eq('DJNZ taken again', cpu.pc, 0x100);
  cpu.step();
  eq('DJNZ finally falls through', cpu.pc, 0x102);
  eq('DJNZ wrap: reg 0', cpu.reg(2), 0);
}
{
  const { cpu } = mk([0xe8, 0x00]); // DJNZ R0 with reg=0 wraps to 0xff and jumps
  cpu.setReg(0, 0);
  cpu.step();
  eq('DJNZ from 0 wraps to 0xff', cpu.reg(0), 0xff);
  eq('DJNZ from 0 is taken', cpu.pc, 0x100);
}

// ================================================================ 19. register banks

section('register banks RB0/RB1 (RAM 0-7 vs 24-31)');
{
  const prog: number[] = [0xd5]; // SEL RB1
  for (let r = 0; r < 8; r++) prog.push(0xb8 | r, 0xa0 + r); // MOV Rr,#
  prog.push(0xc5); // SEL RB0
  const { cpu } = mk(prog);
  for (let r = 0; r < 8; r++) cpu.ram[r] = 0x50 + r; // preload bank 0
  cpu.step(); // SEL RB1
  eq('SEL RB1 sets PSW.BS', cpu.psw & BS, BS);
  for (let r = 0; r < 8; r++) cpu.step();
  for (let r = 0; r < 8; r++) {
    eq(`bank1 R${r} lands at RAM[${24 + r}]`, cpu.ram[24 + r], 0xa0 + r);
  }
  for (let r = 0; r < 8; r++) {
    eq(`bank0 RAM[${r}] untouched`, cpu.ram[r], 0x50 + r);
  }
  cpu.step(); // SEL RB0
  eq('SEL RB0 clears PSW.BS', cpu.psw & BS, 0);
  eq('reg() follows bank back to 0', cpu.reg(3), 0x53);
}

// ================================================================ 20. timer

section('timer: /32 machine-cycle prescaler exactness');
{
  const { cpu } = mk([0x55]); // STRT T, then NOPs (rom zero-filled)
  cpu.prescaler = 5; // stale value
  cpu.step();
  eq('STRT T enables timer', cpu.timecountEnabled, 1);
  eq('STRT T resets prescaler', cpu.prescaler, 0);
  for (let i = 0; i < 31; i++) cpu.step(); // 31 machine cycles
  eq('timer still 0 after 31 cycles', cpu.timer, 0);
  eq('prescaler at 31', cpu.prescaler, 31);
  cpu.step(); // 32nd
  eq('timer ticks exactly at cycle 32', cpu.timer, 1);
  eq('prescaler wrapped', cpu.prescaler, 0);
  for (let i = 0; i < 32; i++) cpu.step();
  eq('timer ticks again at 64', cpu.timer, 2);
}
{
  // 2-cycle instructions advance the prescaler by 2
  const { cpu } = mk([0x55, 0x23, 0x00, 0x23, 0x00]); // STRT T / MOV A,# x2
  cpu.step();
  cpu.step();
  cpu.step();
  eq('two 2-cycle ops = prescaler 4', cpu.prescaler, 4);
}
{
  // MOV A,T sees the increment caused by its own cycle (MAME burns first)
  const { cpu, bus } = mk([0x55]);
  bus.rom[0x101 + 31] = 0x42; // MOV A,T lands on the 32nd machine cycle
  cpu.step(); // STRT T
  for (let i = 0; i < 31; i++) cpu.step(); // 31 NOPs
  cpu.step(); // MOV A,T: its own cycle is the 32nd -> reads post-tick
  eq('MOV A,T on the tick cycle reads post-tick', cpu.a, 1);
}
{
  // STOP TCNT freezes
  const { cpu, bus } = mk([0x55]);
  bus.rom[0x110] = 0x65; // STOP TCNT after 15 NOPs
  cpu.step();
  for (let i = 0; i < 16; i++) cpu.step(); // 15 NOPs + STOP
  const frozen = cpu.prescaler;
  for (let i = 0; i < 40; i++) cpu.step();
  eq('STOP TCNT freezes prescaler', cpu.prescaler, frozen);
  eq('STOP TCNT freezes timer', cpu.timer, 0);
}

section('timer flag + timer interrupt (vector 0x007)');
{
  // overflow with timer IRQ disabled: flag set, no pending interrupt
  const { cpu } = mk([0x55]);
  cpu.timer = 0xff;
  cpu.step(); // STRT T
  for (let i = 0; i < 32; i++) cpu.step();
  eq('TF set on 0xff->0x00 wrap', cpu.timerFlag, true);
  eq('timer wrapped to 0', cpu.timer, 0);
  eq('overflow NOT stored while TCNTI disabled', cpu.timerOverflow, false);
  cpu.tirqEnabled = true; // enabling later must not fire a stale interrupt
  const pcBefore = cpu.pc;
  cpu.step();
  eq('no interrupt from pre-enable overflow', cpu.pc, pcBefore + 1);
  eq('still not in progress', cpu.irqInProgress, false);
}
{
  // overflow with EN TCNTI: vector to 0x007, +2 machine cycles, RETR returns
  const { cpu, bus } = mk([0x25, 0x55]); // EN TCNTI / STRT T
  bus.rom[0x007] = 0x00; // NOP in the ISR
  bus.rom[0x008] = 0x93; // RETR
  cpu.timer = 0xff;
  cpu.step();
  cpu.step();
  for (let i = 0; i < 32; i++) cpu.step();
  eq('pending overflow stored', cpu.timerOverflow, true);
  const clocks = cpu.step(); // vectors + executes NOP at 0x007
  eq('timer irq entry costs 2 mc + NOP', clocks, 45);
  eq('ISR running after vector', cpu.pc, 0x008);
  eq('irqInProgress set', cpu.irqInProgress, true);
  eq('overflow flip-flop cleared when taken', cpu.timerOverflow, false);
  eq('return address low', cpu.ram[8], 0x22);
  eq('return address high', cpu.ram[9], 0x01);
  cpu.step(); // RETR
  eq('RETR returns to interrupted code', cpu.pc, 0x122);
  eq('RETR clears irqInProgress', cpu.irqInProgress, false);
}
{
  // DIS TCNTI clears a pending overflow
  const { cpu } = mk([0x35]); // DIS TCNTI
  cpu.timerOverflow = true;
  cpu.tirqEnabled = false; // not enabled, so checkIrqs won't consume it first
  cpu.step();
  eq('DIS TCNTI clears pending overflow', cpu.timerOverflow, false);
  eq('DIS TCNTI disables', cpu.tirqEnabled, false);
}

// ================================================================ 21. event counter

section('event counter: STRT CNT counts T1 falling edges');
{
  const { cpu, bus } = mk([0x45]); // STRT CNT, then NOPs
  bus.t1 = true;
  cpu.step();
  eq('STRT CNT enables counter', cpu.timecountEnabled, 2);
  cpu.step(); // T1 still high: no edge
  eq('no count while high', cpu.timer, 0);
  bus.t1 = false;
  cpu.step(); // falling edge
  eq('1->0 transition counts', cpu.timer, 1);
  cpu.step(); // still low: no edge
  eq('level low does not count', cpu.timer, 1);
  bus.t1 = true;
  cpu.step(); // rising edge: no count
  eq('0->1 transition does not count', cpu.timer, 1);
  bus.t1 = false;
  cpu.step();
  eq('second falling edge counts', cpu.timer, 2);
}
{
  // counter overflow raises the timer interrupt too
  const { cpu, bus } = mk([0x25, 0x45]); // EN TCNTI / STRT CNT
  bus.rom[0x007] = 0x93; // RETR at the vector
  cpu.timer = 0xff;
  bus.t1 = false;
  cpu.step();
  cpu.step();
  bus.t1 = true;
  cpu.step();
  bus.t1 = false;
  cpu.step(); // falling edge: timer wraps
  eq('counter wrap sets TF', cpu.timerFlag, true);
  eq('counter wrap pends irq', cpu.timerOverflow, true);
  cpu.step(); // vectors, executes RETR immediately
  eq('counter irq vectored + returned', cpu.irqInProgress, false);
  eq('counter irq consumed', cpu.timerOverflow, false);
}

// ================================================================ 22. external interrupt

section('external IRQ: EN I / DIS I, vector 0x003, RETR, level');
{
  // masked: line asserted but DIS I (reset default)
  const { cpu } = mk([]);
  cpu.setIrqLine(true);
  cpu.step();
  cpu.step();
  eq('IRQ ignored while disabled', cpu.pc, 0x102);
  eq('not in progress', cpu.irqInProgress, false);
}
{
  const { cpu, bus } = mk([0x05, 0x00]); // EN I / NOP
  bus.rom[0x003] = 0x00; // ISR: NOP
  bus.rom[0x004] = 0x93; // RETR
  cpu.psw = C; // must be stacked + restored
  cpu.step(); // EN I
  cpu.step(); // NOP (pc now 0x102)
  cpu.setIrqLine(true);
  const clocks = cpu.step(); // 2 mc entry + NOP at 0x003
  eq('irq entry costs 2 mc + opcode', clocks, 45);
  eq('vectored to 0x003 (executed ISR NOP)', cpu.pc, 0x004);
  eq('irqInProgress', cpu.irqInProgress, true);
  eq('stack: return low', cpu.ram[8], 0x02);
  eq('stack: return high|psw', cpu.ram[9], 0x81);
  eq('sp bumped', cpu.psw & 7, 1);

  // no re-entry while in progress, even with the line held
  cpu.step(); // RETR
  eq('RETR returned', cpu.pc, 0x102);
  eq('RETR restored C', cpu.psw & 0xf0, C);
  eq('RETR cleared in-progress', cpu.irqInProgress, false);

  // level-sensitive: line still high -> immediate re-entry
  const clocks2 = cpu.step();
  eq('level line re-enters after RETR', cpu.irqInProgress, true);
  eq('re-entry cost', clocks2, 45);
  cpu.step(); // RETR again
  cpu.setIrqLine(false);
  cpu.step();
  eq('line cleared: normal execution resumes', cpu.irqInProgress, false);
}
{
  // no nesting: timer overflow pending during external ISR stays pending
  const { cpu, bus } = mk([0x05], 0x180); // EN I
  bus.rom[0x003] = 0x00;
  cpu.step();
  cpu.tirqEnabled = true;
  cpu.timerOverflow = true;
  cpu.setIrqLine(true);
  cpu.step(); // external wins (priority) and blocks the timer irq
  eq('external IRQ takes priority', cpu.pc, 0x004);
  eq('timer overflow still pending', cpu.timerOverflow, true);
  bus.rom[0x004] = 0x93; // RETR
  cpu.setIrqLine(false);
  cpu.step(); // RETR
  cpu.step(); // now the timer irq vectors to 0x007
  eq('queued timer irq fires after RETR', cpu.pc >= 0x007 && cpu.pc <= 0x008, true);
  eq('timer irq consumed', cpu.timerOverflow, false);
  eq('in progress again', cpu.irqInProgress, true);
}
{
  // A11 suppression during interrupts: SEL MB1 outside, JMP inside ISR stays in bank 0
  const { cpu, bus } = mk([0x05, 0xf5]); // EN I / SEL MB1
  bus.rom[0x003] = 0x04; bus.rom[0x004] = 0x10; // ISR: JMP 0x010
  bus.rom[0x010] = 0x93; // RETR
  cpu.step();
  cpu.step();
  eq('MB1 latched before irq', cpu.a11, 0x800);
  cpu.setIrqLine(true);
  cpu.step(); // vector + JMP inside ISR
  eq('JMP inside ISR ignores A11', cpu.pc, 0x010);
  cpu.setIrqLine(false);
  cpu.step(); // RETR back to 0x102
  eq('back from ISR', cpu.pc, 0x102);
  // outside the ISR the latch applies again
  bus.rom[0x102] = 0x04; bus.rom[0x103] = 0x10; // JMP 0x010 -> 0x810
  cpu.step();
  eq('JMP after RETR applies A11 again', cpu.pc, 0x810);
}
{
  // MAME's JNI-poll hack: irq right after a not-taken JNI forces the branch
  const { cpu, bus } = mk([0x05, 0x86, 0x80]); // EN I / JNI 0x80
  bus.rom[0x003] = 0x00;
  cpu.step(); // EN I
  cpu.step(); // JNI, line low -> not taken, pc = 0x103
  eq('JNI not taken', cpu.pc, 0x103);
  cpu.setIrqLine(true);
  cpu.step(); // irq: JNI branch is forced, THEN vector
  eq('stacked return = JNI target low', cpu.ram[8], 0x80);
  eq('stacked return = JNI target high', cpu.ram[9] & 0x0f, 0x01);
  eq('ISR executing', cpu.pc, 0x004);
}
{
  // ...but only immediately: one instruction later the hack is off
  const { cpu, bus } = mk([0x05, 0x86, 0x80, 0x00]); // EN I / JNI 0x80 / NOP
  bus.rom[0x003] = 0x00;
  cpu.step();
  cpu.step(); // JNI not taken
  cpu.step(); // NOP clears the polled latch (pc 0x104)
  cpu.setIrqLine(true);
  cpu.step();
  eq('stale JNI poll ignored: return = 0x104', cpu.ram[8], 0x04);
}

// ================================================================ 23. board handshake integration

section('junofrst/gyruss-style P2 irq-clear handshake');
{
  // junofrst: i8039_irqen_and_status_w — P2 bit 7 low clears the INT line.
  // ISR: MOVX A,@R0 (read soundlatch2) / ANL P2,#0x7f (ack) / ORL P2,#0x80
  // (re-arm) / RETR.
  const { cpu, bus } = mk([0x05], 0x180); // EN I then NOP loop
  bus.rom[0x003] = 0x80; //   MOVX A,@R0
  bus.rom[0x004] = 0x9a; bus.rom[0x005] = 0x7f; // ANL P2,#0x7f
  bus.rom[0x006] = 0x8a; bus.rom[0x007] = 0x80; // ORL P2,#0x80
  bus.rom[0x008] = 0x93; // RETR
  bus.io[0x00] = 0x3e; // soundlatch2 value (movx address = R0 = 0)
  cpu.setReg(0, 0);
  bus.onPortWrite = (port, data) => {
    // board side of i8039_irqen_and_status_w: BIT(~data,7) -> clear line
    if (port === 2 && (data & 0x80) === 0) cpu.setIrqLine(false);
  };
  cpu.step(); // EN I
  cpu.setIrqLine(true); // Z80 wrote 0x6000
  let isrEntries = 0;
  for (let i = 0; i < 12; i++) {
    const before = cpu.irqInProgress;
    cpu.step();
    if (!before && cpu.irqInProgress) isrEntries++;
  }
  eq('ISR entered exactly once (ack cleared the line)', isrEntries, 1);
  eq('soundlatch2 byte read via MOVX', cpu.a, 0x3e);
  eq('back in the main loop', cpu.irqInProgress, false);
  eq('P2 latch re-armed', cpu.p2 & 0x80, 0x80);
}
{
  // gyruss: irq_clear_w — ANY P2 write clears the line (no bit test);
  // P1 carries the DAC sample byte.
  const { cpu, bus } = mk([0x05], 0x180);
  bus.rom[0x003] = 0x80; //   MOVX A,@R0 (soundlatch2)
  bus.rom[0x004] = 0x39; //   OUTL P1,A  (DAC)
  bus.rom[0x005] = 0x3a; //   OUTL P2,A  (irq ack, any value)
  bus.rom[0x006] = 0x93; //   RETR
  bus.io[0x00] = 0x7f;
  cpu.setReg(0, 0);
  const dacWrites: number[] = [];
  bus.onPortWrite = (port, data) => {
    if (port === 1) dacWrites.push(data);
    if (port === 2) cpu.setIrqLine(false); // gyruss clears unconditionally
  };
  cpu.step(); // EN I
  cpu.setIrqLine(true);
  for (let i = 0; i < 10; i++) cpu.step();
  eq('DAC got the sample byte on P1', dacWrites.length === 1 && dacWrites[0] === 0x7f, true);
  eq('single service, line acked', cpu.irqInProgress, false);
}

// ================================================================ 24. misc

section('illegal opcodes + unimplemented 8243/ENT0');
{
  const { cpu } = mk([0x01, 0x22, 0xc0, 0xd6]);
  cpu.a = 0x5a;
  cpu.psw = C;
  for (let i = 0; i < 4; i++) {
    eq(`illegal op ${i} is 1 cycle`, stepMc(cpu), 1);
  }
  eq('illegal ops leave A', cpu.a, 0x5a);
  eq('illegal ops leave PSW', cpu.psw, C);
  eq('illegal ops advance PC by 1', cpu.pc, 0x104);
}
{
  const { cpu, bus } = mk([0x0c, 0x3c, 0x8c, 0x9c, 0x75]);
  cpu.a = 0x5a;
  for (let i = 0; i < 4; i++) {
    eq(`8243 op ${i} burns 2 cycles`, stepMc(cpu), 2);
  }
  eq('8243 ops leave A (documented deviation)', cpu.a, 0x5a);
  eq('8243 ops touch no ports', bus.portWrites.length, 0);
  eq('ENT0 CLK is a 1-cycle no-op', stepMc(cpu), 1);
}
{
  // indirect RAM addressing wraps at the RAM size (128 for i8039)
  const { cpu } = mk([0xa0]); // MOV @R0,A
  cpu.setReg(0, 0x85); // 0x85 & 0x7f = 0x05
  cpu.a = 0x66;
  cpu.step();
  eq('@R addressing masks to RAM size', cpu.ram[0x05], 0x66);
}
{
  // timer keeps advancing through irq-entry burn cycles
  const { cpu, bus } = mk([0x05, 0x55]); // EN I / STRT T
  bus.rom[0x003] = 0x93; // RETR
  cpu.step();
  cpu.step(); // STRT T (prescaler 0 afterwards)
  for (let i = 0; i < 29; i++) cpu.step(); // prescaler 29
  cpu.setIrqLine(true);
  cpu.step(); // entry burns 2 (-> 31) then RETR burns 2 -> tick at 32, prescaler 1
  eq('irq entry cycles feed the prescaler', cpu.prescaler, 1);
  eq('timer ticked during irq entry+RETR', cpu.timer, 1);
}

// ================================================================ summary

endSection();
console.log('');
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`${totalFail} FAILURES out of ${totalPass + totalFail} checks`);
  console.log('Failing sections: ' + failedSections.join(', '));
  process.exitCode = 1;
}
