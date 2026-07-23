// Conformance test for the Z80 core generated from the sibling MAME checkout.
// Run with: node src/mame/z80-conformance.spec.ts
// No test framework; prints PASS/FAIL per section and sets process.exitCode.

import { compileMameZ80 } from './cpu-compiler.ts';
import { generatedCpuExecutableSource } from './cpu-codegen.ts';
import * as ts from 'typescript';
import {
  clearGeneratedCpus,
  createCpu,
  registerGeneratedCpu,
  type Cpu,
  type CpuBus as Z80Bus,
} from '../runtime/generated-cpu.ts';

clearGeneratedCpus();
const definition = compileMameZ80(process.env.MAME_SRC ?? '../mame');
const executableSource = generatedCpuExecutableSource(definition);
const executableJavaScript = ts.transpileModule(executableSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const executableModule = await import(
  `data:text/javascript;base64,${Buffer.from(executableJavaScript).toString('base64')}`
) as { default: Parameters<typeof registerGeneratedCpu>[0] };
registerGeneratedCpu(executableModule.default);

// Test-only compatibility surface for the historical conformance vectors.
// It contains no CPU behavior; every operation executes emitted MAME-derived code.
class Z80 {
  private readonly core: Cpu;

  constructor(bus: Z80Bus) {
    this.core = createCpu('Z80', bus);
  }

  step(): number { return this.core.step(); }
  run(cycles: number): number { return this.core.run(cycles); }
  setIrqLine(active: boolean, dataBus = 0xff, hold = false): void {
    this.core.setIrqLine(active, dataBus, hold);
  }
  nmi(): void { this.core.nmi(); }

  private get8(name: string): number { return this.core.get(name) & 0xff; }
  private set8(name: string, value: number): void { this.core.set(name, value & 0xff); }
  private get16(name: string): number { return this.core.get(name) & 0xffff; }
  private set16(name: string, value: number): void { this.core.set(name, value & 0xffff); }

  get a() { return this.get8('A'); } set a(v) { this.set8('A', v); }
  get f() { return this.core.invoke('get_f') & 0xff; }
  set f(v) { this.set8('F', v); this.core.invoke('set_f', v & 0xff); }
  get b() { return this.get8('B'); } set b(v) { this.set8('B', v); }
  get c() { return this.get8('C'); } set c(v) { this.set8('C', v); }
  get d() { return this.get8('D'); } set d(v) { this.set8('D', v); }
  get e() { return this.get8('E'); } set e(v) { this.set8('E', v); }
  get h() { return this.get8('H'); } set h(v) { this.set8('H', v); }
  get l() { return this.get8('L'); } set l(v) { this.set8('L', v); }
  get a2() { return this.get8('m_af2.b.h'); } set a2(v) { this.set8('m_af2.b.h', v); }
  get f2() { return this.get8('m_af2.b.l'); } set f2(v) { this.set8('m_af2.b.l', v); }
  get b2() { return this.get8('m_bc2.b.h'); } set b2(v) { this.set8('m_bc2.b.h', v); }
  get c2() { return this.get8('m_bc2.b.l'); } set c2(v) { this.set8('m_bc2.b.l', v); }
  get d2() { return this.get8('m_de2.b.h'); } set d2(v) { this.set8('m_de2.b.h', v); }
  get e2() { return this.get8('m_de2.b.l'); } set e2(v) { this.set8('m_de2.b.l', v); }
  get h2() { return this.get8('m_hl2.b.h'); } set h2(v) { this.set8('m_hl2.b.h', v); }
  get l2() { return this.get8('m_hl2.b.l'); } set l2(v) { this.set8('m_hl2.b.l', v); }
  get ix() { return this.get16('IX'); } set ix(v) { this.set16('IX', v); }
  get iy() { return this.get16('IY'); } set iy(v) { this.set16('IY', v); }
  get sp() { return this.get16('SP'); } set sp(v) { this.set16('SP', v); }
  get pc() { return this.get16('PC'); } set pc(v) { this.set16('PC', v); }
  get wz() { return this.get16('WZ'); } set wz(v) { this.set16('WZ', v); }
  get i() { return this.get8('m_i'); } set i(v) { this.set8('m_i', v); }
  get r() { return (this.get8('m_r') & 0x7f) | (this.get8('m_r2') & 0x80); }
  set r(v) { this.set8('m_r', v & 0x7f); this.set8('m_r2', v & 0x80); }
  get iff1() { return this.get8('m_iff1'); } set iff1(v) { this.set8('m_iff1', v); }
  get iff2() { return this.get8('m_iff2'); } set iff2(v) { this.set8('m_iff2', v); }
  get im() { return this.get8('m_im'); } set im(v) { this.set8('m_im', v); }
  get halted() { return Boolean(this.core.get('m_halt')); }
}

// Flag bits (duplicated here on purpose; do not import internals)
const CF = 0x01;
const NF = 0x02;
const PF = 0x04;
const XF = 0x08;
const HF = 0x10;
const YF = 0x20;
const ZF = 0x40;
const SF = 0x80;

class TestBus implements Z80Bus {
  mem = new Uint8Array(0x10000);
  ioIn = new Uint8Array(0x10000);
  ioLog: { port: number; data: number }[] = [];
  read(addr: number): number {
    return this.mem[addr];
  }
  write(addr: number, data: number): void {
    this.mem[addr] = data;
  }
  in(port: number): number {
    return this.ioIn[port & 0xffff];
  }
  out(port: number, data: number): void {
    this.ioLog.push({ port: port & 0xffff, data: data & 0xff });
  }
}

function makeCpu(program: number[], org = 0): { cpu: Z80; bus: TestBus } {
  const bus = new TestBus();
  bus.mem.set(program, org);
  const cpu = new Z80(bus);
  cpu.pc = org;
  cpu.a = 0;
  cpu.f = 0;
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

// ================================================================ 1. instruction battery

section('LD and 8-bit ALU');
{
  // LD A,n / LD r,r'
  const { cpu } = makeCpu([0x3e, 0x12, 0x47, 0x48, 0x51, 0x5a, 0x63, 0x6c]);
  for (let i = 0; i < 8; i++) cpu.step();
  eq('LD chain A', cpu.a, 0x12);
  eq('LD chain B', cpu.b, 0x12);
  eq('LD chain C', cpu.c, 0x12);
  eq('LD chain D', cpu.d, 0x12);
  eq('LD chain E', cpu.e, 0x12);
  eq('LD chain H', cpu.h, 0x12);
  eq('LD chain L', cpu.l, 0x12);
}
{
  const { cpu } = makeCpu([0x3e, 0x44, 0xc6, 0x11]); // LD A,44 / ADD A,11
  cpu.step();
  cpu.step();
  eq('ADD result', cpu.a, 0x55);
  eq('ADD flags', cpu.f, 0x00);
}
{
  const { cpu } = makeCpu([0x3e, 0x7f, 0xc6, 0x01]);
  cpu.step();
  cpu.step();
  eq('ADD ovf result', cpu.a, 0x80);
  eq('ADD ovf flags', cpu.f, SF | HF | PF);
}
{
  const { cpu } = makeCpu([0x3e, 0xff, 0xc6, 0x01]);
  cpu.step();
  cpu.step();
  eq('ADD carry result', cpu.a, 0x00);
  eq('ADD carry flags', cpu.f, ZF | HF | CF);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0x00, 0xce, 0x00]); // SCF / LD A,0 / ADC A,0
  cpu.step();
  cpu.step();
  cpu.step();
  eq('ADC uses carry', cpu.a, 0x01);
  eq('ADC flags', cpu.f, 0x00);
}
{
  const { cpu } = makeCpu([0x3e, 0x3e, 0xd6, 0x3e]);
  cpu.step();
  cpu.step();
  eq('SUB result', cpu.a, 0x00);
  eq('SUB flags', cpu.f, ZF | NF);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0x10, 0xde, 0x01]); // SCF / LD A,10 / SBC A,1
  cpu.step();
  cpu.step();
  cpu.step();
  eq('SBC result', cpu.a, 0x0e);
  eq('SBC flags', cpu.f, NF | HF | XF);
}
{
  const { cpu } = makeCpu([0x3e, 0xf0, 0xe6, 0x8f]);
  cpu.step();
  cpu.step();
  eq('AND result', cpu.a, 0x80);
  eq('AND flags', cpu.f, SF | HF);
}
{
  const { cpu } = makeCpu([0x3e, 0x00, 0xf6, 0x00]);
  cpu.step();
  cpu.step();
  eq('OR result', cpu.a, 0x00);
  eq('OR flags', cpu.f, ZF | PF);
}
{
  const { cpu } = makeCpu([0x3e, 0xff, 0xee, 0xff]);
  cpu.step();
  cpu.step();
  eq('XOR result', cpu.a, 0x00);
  eq('XOR flags', cpu.f, ZF | PF);
}
{
  const { cpu } = makeCpu([0x3e, 0x00, 0xfe, 0x28]); // CP 28: X/Y from operand
  cpu.step();
  cpu.step();
  eq('CP leaves A', cpu.a, 0x00);
  eq('CP flags (XY from operand)', cpu.f, SF | YF | XF | HF | NF | CF);
}

section('INC/DEC/DAA/rotates/CPL/SCF/CCF');
{
  const { cpu } = makeCpu([0x3e, 0x7f, 0x3c]);
  cpu.step();
  cpu.step();
  eq('INC A result', cpu.a, 0x80);
  eq('INC A flags', cpu.f, SF | HF | PF);
}
{
  const { cpu } = makeCpu([0x37, 0x3e, 0x7f, 0x3c]); // carry preserved by INC
  cpu.step();
  cpu.step();
  cpu.step();
  eq('INC preserves C', cpu.f, SF | HF | PF | CF);
}
{
  const { cpu } = makeCpu([0x3e, 0x80, 0x3d]);
  cpu.step();
  cpu.step();
  eq('DEC A result', cpu.a, 0x7f);
  eq('DEC A flags', cpu.f, NF | PF | HF | YF | XF);
}
{
  const { cpu } = makeCpu([0x3e, 0x15, 0xc6, 0x27, 0x27]); // 15+27=3c, DAA -> 42
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA result', cpu.a, 0x42);
  eq('DAA flags', cpu.f, HF | PF);
}
{
  const { cpu } = makeCpu([0x3e, 0x80, 0x07]); // RLCA
  cpu.step();
  cpu.step();
  eq('RLCA result', cpu.a, 0x01);
  eq('RLCA flags', cpu.f, CF);
}
{
  const { cpu } = makeCpu([0x3e, 0x01, 0x1f]); // RRA with C=0
  cpu.step();
  cpu.step();
  eq('RRA result', cpu.a, 0x00);
  eq('RRA flags', cpu.f, CF);
}
{
  const { cpu } = makeCpu([0x3e, 0x55, 0x2f]); // CPL
  cpu.step();
  cpu.step();
  eq('CPL result', cpu.a, 0xaa);
  eq('CPL flags', cpu.f, HF | NF | YF | XF);
}
{
  const { cpu } = makeCpu([0x3e, 0x28, 0x37, 0x3f]); // SCF then CCF, A=28
  cpu.step();
  cpu.step();
  eq('SCF flags', cpu.f, CF | YF | XF);
  cpu.step();
  eq('CCF flags (H from old C)', cpu.f, HF | YF | XF);
}

section('16-bit arithmetic');
{
  const { cpu } = makeCpu([0x21, 0xff, 0x0f, 0x11, 0x01, 0x00, 0x19]); // ADD HL,DE
  cpu.step();
  cpu.step();
  cpu.step();
  eq('ADD HL result', (cpu.h << 8) | cpu.l, 0x1000);
  eq('ADD HL flags', cpu.f, HF);
}
{
  const { cpu } = makeCpu([0xed, 0x4a]); // ADC HL,BC
  cpu.h = 0xff;
  cpu.l = 0xff;
  cpu.b = 0x00;
  cpu.c = 0x01;
  cpu.step();
  eq('ADC HL result', (cpu.h << 8) | cpu.l, 0x0000);
  eq('ADC HL flags', cpu.f, ZF | HF | CF);
}
{
  const { cpu } = makeCpu([0xed, 0x42]); // SBC HL,BC
  cpu.h = 0;
  cpu.l = 0;
  cpu.b = 0;
  cpu.c = 1;
  cpu.step();
  eq('SBC HL result', (cpu.h << 8) | cpu.l, 0xffff);
  eq('SBC HL flags', cpu.f, SF | YF | XF | HF | NF | CF);
}

section('exchanges and stack');
{
  const { cpu } = makeCpu([0x08]); // EX AF,AF'
  cpu.a = 1;
  cpu.f = 2;
  cpu.a2 = 3;
  cpu.f2 = 4;
  cpu.step();
  eq('EX AF a', cpu.a, 3);
  eq('EX AF f', cpu.f, 4);
  eq("EX AF a'", cpu.a2, 1);
  eq("EX AF f'", cpu.f2, 2);
}
{
  const { cpu } = makeCpu([0xd9]); // EXX
  cpu.b = 1;
  cpu.c = 2;
  cpu.d = 3;
  cpu.e = 4;
  cpu.h = 5;
  cpu.l = 6;
  cpu.b2 = 0x11;
  cpu.c2 = 0x22;
  cpu.d2 = 0x33;
  cpu.e2 = 0x44;
  cpu.h2 = 0x55;
  cpu.l2 = 0x66;
  cpu.step();
  eq('EXX B', cpu.b, 0x11);
  eq('EXX L', cpu.l, 0x66);
  eq("EXX B'", cpu.b2, 1);
  eq("EXX L'", cpu.l2, 6);
}
{
  const { cpu } = makeCpu([0xeb]); // EX DE,HL
  cpu.d = 0x12;
  cpu.e = 0x34;
  cpu.h = 0x56;
  cpu.l = 0x78;
  cpu.step();
  eq('EX DE,HL de', (cpu.d << 8) | cpu.e, 0x5678);
  eq('EX DE,HL hl', (cpu.h << 8) | cpu.l, 0x1234);
}
{
  const { cpu, bus } = makeCpu([0xe3]); // EX (SP),HL
  cpu.sp = 0x8000;
  bus.mem[0x8000] = 0x34;
  bus.mem[0x8001] = 0x12;
  cpu.h = 0xab;
  cpu.l = 0xcd;
  cpu.step();
  eq('EX (SP),HL hl', (cpu.h << 8) | cpu.l, 0x1234);
  eq('EX (SP),HL mem lo', bus.mem[0x8000], 0xcd);
  eq('EX (SP),HL mem hi', bus.mem[0x8001], 0xab);
}
{
  const { cpu, bus } = makeCpu([0x01, 0x34, 0x12, 0xc5, 0xd1]); // LD BC / PUSH BC / POP DE
  cpu.step();
  cpu.step();
  eq('PUSH sp', cpu.sp, 0xfefe);
  eq('PUSH mem hi', bus.mem[0xfeff], 0x12);
  eq('PUSH mem lo', bus.mem[0xfefe], 0x34);
  cpu.step();
  eq('POP DE', (cpu.d << 8) | cpu.e, 0x1234);
  eq('POP sp', cpu.sp, 0xff00);
}
{
  const { cpu } = makeCpu([0xf5, 0xc1]); // PUSH AF / POP BC
  cpu.a = 0x9a;
  cpu.f = 0x5b;
  cpu.step();
  cpu.step();
  eq('PUSH/POP AF roundtrip', (cpu.b << 8) | cpu.c, 0x9a5b);
}

section('block operations');
{
  const { cpu, bus } = makeCpu([0xed, 0xb0]); // LDIR
  bus.mem[0x4000] = 0xaa;
  bus.mem[0x4001] = 0xbb;
  bus.mem[0x4002] = 0xcc;
  cpu.h = 0x40;
  cpu.l = 0x00;
  cpu.d = 0x50;
  cpu.e = 0x00;
  cpu.b = 0x00;
  cpu.c = 0x03;
  const t1 = cpu.step();
  const t2 = cpu.step();
  const t3 = cpu.step();
  eq('LDIR copy 0', bus.mem[0x5000], 0xaa);
  eq('LDIR copy 1', bus.mem[0x5001], 0xbb);
  eq('LDIR copy 2', bus.mem[0x5002], 0xcc);
  eq('LDIR HL', (cpu.h << 8) | cpu.l, 0x4003);
  eq('LDIR DE', (cpu.d << 8) | cpu.e, 0x5003);
  eq('LDIR BC', (cpu.b << 8) | cpu.c, 0x0000);
  eq('LDIR PV clear at end', cpu.f & PF, 0);
  eq('LDIR N/H clear', cpu.f & (NF | HF), 0);
  eq('LDIR repeat cycles', t1, 21);
  eq('LDIR repeat cycles 2', t2, 21);
  eq('LDIR final cycles', t3, 16);
  eq('LDIR pc', cpu.pc, 2);
}
{
  const { cpu, bus } = makeCpu([0xed, 0xb1]); // CPIR
  bus.mem[0x4000] = 0x01;
  bus.mem[0x4001] = 0x02;
  bus.mem[0x4002] = 0x03;
  cpu.a = 0x03;
  cpu.h = 0x40;
  cpu.l = 0x00;
  cpu.b = 0x00;
  cpu.c = 0x08;
  cpu.step();
  cpu.step();
  cpu.step();
  eq('CPIR HL', (cpu.h << 8) | cpu.l, 0x4003);
  eq('CPIR BC', (cpu.b << 8) | cpu.c, 0x0005);
  eq('CPIR found (Z)', cpu.f & ZF, ZF);
  eq('CPIR PV (BC!=0)', cpu.f & PF, PF);
  eq('CPIR pc', cpu.pc, 2);
}
{
  const { cpu, bus } = makeCpu([0xed, 0xa0]); // LDI single
  bus.mem[0x4000] = 0x7e;
  cpu.h = 0x40;
  cpu.l = 0x00;
  cpu.d = 0x50;
  cpu.e = 0x00;
  cpu.b = 0;
  cpu.c = 2;
  cpu.a = 0x00;
  cpu.step();
  // n = A + copied byte = 0x7e: XF from bit3 (1), YF from bit1 (1)
  eq('LDI XY flags', cpu.f & (YF | XF), YF | XF);
  eq('LDI PV', cpu.f & PF, PF);
}

section('CB: rotates, BIT/SET/RES');
{
  const { cpu } = makeCpu([0xcb, 0x00]); // RLC B
  cpu.b = 0x81;
  cpu.step();
  eq('RLC B result', cpu.b, 0x03);
  eq('RLC B flags', cpu.f, PF | CF);
}
{
  const { cpu } = makeCpu([0xcb, 0x37]); // SLL A (undocumented)
  cpu.a = 0x80;
  cpu.step();
  eq('SLL A result', cpu.a, 0x01);
  eq('SLL A flags', cpu.f, CF);
}
{
  const { cpu } = makeCpu([0xcb, 0x40]); // BIT 0,B with B=0
  cpu.b = 0;
  cpu.step();
  eq('BIT 0,B flags', cpu.f, ZF | PF | HF);
}
{
  const { cpu, bus } = makeCpu([0xcb, 0x7e]); // BIT 7,(HL)
  cpu.h = 0x40;
  cpu.l = 0x00;
  bus.mem[0x4000] = 0x80;
  cpu.wz = 0x2800; // X/Y must come from WZ high byte
  cpu.step();
  eq('BIT 7,(HL) flags use WZ', cpu.f, SF | HF | YF | XF);
}
{
  const { cpu } = makeCpu([0xcb, 0xc7, 0xcb, 0x87]); // SET 0,A / RES 0,A
  cpu.a = 0;
  cpu.step();
  eq('SET 0,A', cpu.a, 0x01);
  cpu.step();
  eq('RES 0,A', cpu.a, 0x00);
}
{
  const { cpu, bus } = makeCpu([0xcb, 0xde]); // SET 3,(HL)
  cpu.h = 0x40;
  cpu.l = 0x00;
  bus.mem[0x4000] = 0x00;
  cpu.step();
  eq('SET 3,(HL)', bus.mem[0x4000], 0x08);
}

section('jumps, loops, calls');
{
  // LD B,5 ; loop: INC A ; DJNZ loop
  const { cpu } = makeCpu([0x06, 0x05, 0x3c, 0x10, 0xfd]);
  let guard = 0;
  while (cpu.pc !== 5 && guard++ < 100) cpu.step();
  eq('DJNZ loop count', cpu.a, 5);
  eq('DJNZ loop B', cpu.b, 0);
}
{
  // JR forward over a trap
  const { cpu } = makeCpu([0x18, 0x02, 0x3e, 0xff, 0x3c]); // JR +2 / (skipped LD A,ff) / INC A
  cpu.step();
  eq('JR target', cpu.pc, 4);
  cpu.step();
  eq('JR skipped trap', cpu.a, 1);
}
{
  const { cpu, bus } = makeCpu([0xcd, 0x06, 0x00, 0x00, 0x00, 0x00, 0x3e, 0xaa, 0xc9]);
  cpu.step(); // CALL 0x0006
  eq('CALL pc', cpu.pc, 6);
  eq('CALL sp', cpu.sp, 0xfefe);
  eq('CALL stack lo', bus.mem[0xfefe], 0x03);
  eq('CALL stack hi', bus.mem[0xfeff], 0x00);
  cpu.step(); // LD A,aa
  cpu.step(); // RET
  eq('RET pc', cpu.pc, 3);
  eq('RET sp', cpu.sp, 0xff00);
  eq('CALL/RET a', cpu.a, 0xaa);
}
{
  const { cpu, bus } = makeCpu([0xdf]); // RST 18h
  cpu.step();
  eq('RST pc', cpu.pc, 0x18);
  eq('RST stack', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0001);
}
{
  const { cpu } = makeCpu([0xfe, 0x00, 0xca, 0x10, 0x00]); // CP 0 (A=0 -> Z) / JP Z,0x10
  cpu.step();
  cpu.step();
  eq('JP cc taken', cpu.pc, 0x10);
}

section('IX/IY indexed and undocumented halves');
{
  const { cpu, bus } = makeCpu([
    0xdd, 0x21, 0x00, 0x40, // LD IX,4000
    0xdd, 0x36, 0x05, 0x5a, // LD (IX+5),5a
    0xdd, 0x7e, 0x05, // LD A,(IX+5)
    0xdd, 0x34, 0x05, // INC (IX+5)
    0xdd, 0x86, 0x05, // ADD A,(IX+5)
  ]);
  cpu.step();
  eq('LD IX,nn', cpu.ix, 0x4000);
  cpu.step();
  eq('LD (IX+d),n', bus.mem[0x4005], 0x5a);
  cpu.step();
  eq('LD A,(IX+d)', cpu.a, 0x5a);
  cpu.step();
  eq('INC (IX+d)', bus.mem[0x4005], 0x5b);
  cpu.step();
  eq('ADD A,(IX+d)', cpu.a, (0x5a + 0x5b) & 0xff);
}
{
  const { cpu } = makeCpu([
    0xfd, 0x21, 0x00, 0x40, // LD IY,4000
    0xfd, 0x36, 0xfe, 0x99, // LD (IY-2),99
    0xfd, 0x7e, 0xfe, // LD A,(IY-2)
  ]);
  cpu.step();
  cpu.step();
  cpu.step();
  eq('LD A,(IY-2) negative disp', cpu.a, 0x99);
}
{
  const { cpu } = makeCpu([
    0xdd, 0x26, 0x12, // LD IXH,12
    0xdd, 0x2e, 0x34, // LD IXL,34
    0xdd, 0x7c, // LD A,IXH
    0xdd, 0x84, // ADD A,IXH
    0xdd, 0x44, // LD B,IXH
  ]);
  cpu.step();
  cpu.step();
  eq('LD IXH/IXL', cpu.ix, 0x1234);
  cpu.step();
  eq('LD A,IXH', cpu.a, 0x12);
  cpu.step();
  eq('ADD A,IXH', cpu.a, 0x24);
  cpu.step();
  eq('LD B,IXH', cpu.b, 0x12);
}
{
  const { cpu, bus } = makeCpu([0xdd, 0xcb, 0x05, 0x00]); // RLC (IX+5) -> also copied to B
  cpu.ix = 0x4000;
  bus.mem[0x4005] = 0x81;
  cpu.step();
  eq('DDCB RLC mem', bus.mem[0x4005], 0x03);
  eq('DDCB RLC reg copy', cpu.b, 0x03);
  eq('DDCB RLC flags', cpu.f, PF | CF);
}
{
  const { cpu, bus } = makeCpu([0xdd, 0xcb, 0x05, 0x4e]); // BIT 1,(IX+5)
  cpu.ix = 0x4000;
  bus.mem[0x4005] = 0x03;
  cpu.step();
  // X/Y from high byte of effective address (0x40 -> neither X nor Y)
  eq('DDCB BIT flags', cpu.f, HF);
}
{
  const { cpu, bus } = makeCpu([0xdd, 0xcb, 0x7f, 0xcf]); // SET 1,(IX+7f) -> copy to A
  cpu.ix = 0x4000;
  bus.mem[0x407f] = 0x00;
  cpu.step();
  eq('DDCB SET mem', bus.mem[0x407f], 0x02);
  eq('DDCB SET reg copy', cpu.a, 0x02);
}

section('ED: NEG, RRD/RLD, LD A,I/R, IN/OUT (C), 16-bit loads');
{
  const { cpu } = makeCpu([0x3e, 0x01, 0xed, 0x44]); // NEG
  cpu.step();
  cpu.step();
  eq('NEG result', cpu.a, 0xff);
  eq('NEG flags', cpu.f, SF | YF | XF | HF | NF | CF);
}
{
  const { cpu } = makeCpu([0xed, 0x5c]); // NEG duplicate
  cpu.a = 0x01;
  cpu.step();
  eq('NEG duplicate', cpu.a, 0xff);
}
{
  const { cpu, bus } = makeCpu([0xed, 0x67]); // RRD
  cpu.a = 0x84;
  cpu.h = 0x40;
  cpu.l = 0x00;
  bus.mem[0x4000] = 0x20;
  cpu.step();
  eq('RRD A', cpu.a, 0x80);
  eq('RRD (HL)', bus.mem[0x4000], 0x42);
  eq('RRD flags', cpu.f, SF);
}
{
  const { cpu, bus } = makeCpu([0xed, 0x6f]); // RLD
  cpu.a = 0x84;
  cpu.h = 0x40;
  cpu.l = 0x00;
  bus.mem[0x4000] = 0x20;
  cpu.step();
  eq('RLD A', cpu.a, 0x82);
  eq('RLD (HL)', bus.mem[0x4000], 0x04);
}
{
  const { cpu } = makeCpu([0xed, 0x57]); // LD A,I with IFF2 set
  cpu.i = 0x00;
  cpu.iff2 = 1;
  cpu.step();
  eq('LD A,I value', cpu.a, 0x00);
  eq('LD A,I flags (Z + PV=IFF2)', cpu.f, ZF | PF);
}
{
  const { cpu } = makeCpu([0xed, 0x5f]); // LD A,R with IFF2 clear
  cpu.r = 0x40;
  cpu.iff2 = 0;
  cpu.step();
  eq('LD A,R value', cpu.a, 0x42); // R incremented twice by the two M1 fetches
  eq('LD A,R flags', cpu.f, 0x00);
}
{
  const { cpu, bus } = makeCpu([0xed, 0x40]); // IN B,(C)
  cpu.b = 0x12;
  cpu.c = 0x34;
  bus.ioIn[0x1234] = 0x80;
  cpu.step();
  eq('IN B,(C) value', cpu.b, 0x80);
  eq('IN B,(C) flags', cpu.f, SF);
}
{
  const { cpu, bus } = makeCpu([0xed, 0x70]); // IN F,(C): flags only
  cpu.b = 0x12;
  cpu.c = 0x34;
  bus.ioIn[0x1234] = 0x00;
  cpu.d = 0x99;
  cpu.step();
  eq('IN F,(C) flags', cpu.f, ZF | PF);
  eq('IN F,(C) no reg write', cpu.d, 0x99);
}
{
  const { cpu, bus } = makeCpu([0xed, 0x71]); // OUT (C),0 (NMOS)
  cpu.b = 0x12;
  cpu.c = 0x34;
  cpu.step();
  eq('OUT (C),0 port', bus.ioLog[0].port, 0x1234);
  eq('OUT (C),0 data', bus.ioLog[0].data, 0x00);
}
{
  const { cpu, bus } = makeCpu([0xed, 0x43, 0x00, 0x60, 0xed, 0x5b, 0x00, 0x60]); // LD (6000),BC / LD DE,(6000)
  cpu.b = 0xbe;
  cpu.c = 0xef;
  cpu.step();
  eq('LD (nn),BC lo', bus.mem[0x6000], 0xef);
  eq('LD (nn),BC hi', bus.mem[0x6001], 0xbe);
  cpu.step();
  eq('LD DE,(nn)', (cpu.d << 8) | cpu.e, 0xbeef);
}
{
  const { cpu, bus } = makeCpu([0x22, 0x00, 0x60, 0x2a, 0x02, 0x60]); // LD (nn),HL / LD HL,(nn)
  cpu.h = 0x12;
  cpu.l = 0x34;
  bus.mem[0x6002] = 0x78;
  bus.mem[0x6003] = 0x56;
  cpu.step();
  eq('LD (nn),HL', bus.mem[0x6000] | (bus.mem[0x6001] << 8), 0x1234);
  cpu.step();
  eq('LD HL,(nn)', (cpu.h << 8) | cpu.l, 0x5678);
}
{
  const { cpu, bus } = makeCpu([0x32, 0x00, 0x60, 0x3a, 0x00, 0x60]); // LD (nn),A / LD A,(nn)
  cpu.a = 0x77;
  cpu.step();
  eq('LD (nn),A', bus.mem[0x6000], 0x77);
  cpu.a = 0;
  cpu.step();
  eq('LD A,(nn)', cpu.a, 0x77);
}

// ================================================================ 2. DAA exhaustive

section('DAA exhaustive (256 values x 8 flag combos)');
{
  // Independent reference implemented from the canonical DAA truth table.
  const daaRef = (a: number, c: number, h: number, n: number): { a: number; f: number } => {
    const lo = a & 0x0f;
    let diff = 0;
    if (h !== 0 || lo > 9) diff |= 0x06;
    if (c !== 0 || a > 0x99) diff |= 0x60;
    const res = (n !== 0 ? a - diff : a + diff) & 0xff;
    const cOut = c !== 0 || a > 0x99 ? CF : 0;
    let hOut = 0;
    if (n === 0) hOut = lo > 9 ? HF : 0;
    else hOut = h !== 0 && lo < 6 ? HF : 0;
    let bits = 0;
    for (let k = 0; k < 8; k++) if ((res >> k) & 1) bits++;
    const f =
      (res & SF) |
      (res === 0 ? ZF : 0) |
      (res & (YF | XF)) |
      hOut |
      (bits % 2 === 0 ? PF : 0) |
      (n !== 0 ? NF : 0) |
      cOut;
    return { a: res, f };
  };

  const bus = new TestBus();
  bus.mem[0] = 0x27; // DAA
  const cpu = new Z80(bus);
  let bad = 0;
  for (let a = 0; a < 256; a++) {
    for (let flags = 0; flags < 8; flags++) {
      const c = flags & 1;
      const n = (flags >> 1) & 1;
      const h = (flags >> 2) & 1;
      cpu.pc = 0;
      cpu.a = a;
      cpu.f = (c !== 0 ? CF : 0) | (n !== 0 ? NF : 0) | (h !== 0 ? HF : 0);
      cpu.step();
      const ref = daaRef(a, c, h, n);
      if (cpu.a !== ref.a || cpu.f !== ref.f) {
        bad++;
        if (bad <= 5) {
          eq(
            `DAA a=${a.toString(16)} c=${c} h=${h} n=${n}`,
            (cpu.a << 8) | cpu.f,
            (ref.a << 8) | ref.f
          );
        }
      }
    }
  }
  eq('DAA mismatches', bad, 0);
}

// ================================================================ 3. cycle counts

section('cycle counts');
{
  type CycleTest = {
    name: string;
    bytes: number[];
    want: number;
    setup?: (cpu: Z80, bus: TestBus) => void;
    steps?: number;
  };
  const tests: CycleTest[] = [
    { name: 'NOP', bytes: [0x00], want: 4 },
    { name: 'LD A,n', bytes: [0x3e, 0x00], want: 7 },
    { name: 'LD BC,nn', bytes: [0x01, 0x00, 0x00], want: 10 },
    { name: 'LD (BC),A', bytes: [0x02], want: 7 },
    { name: 'INC BC', bytes: [0x03], want: 6 },
    { name: 'INC B', bytes: [0x04], want: 4 },
    { name: 'INC (HL)', bytes: [0x34], want: 11 },
    { name: 'LD (HL),n', bytes: [0x36, 0x00], want: 10 },
    { name: 'ADD HL,BC', bytes: [0x09], want: 11 },
    { name: 'LD r,r', bytes: [0x41], want: 4 },
    { name: 'LD r,(HL)', bytes: [0x46], want: 7 },
    { name: 'ADD A,n', bytes: [0xc6, 0x00], want: 7 },
    { name: 'ADD A,(HL)', bytes: [0x86], want: 7 },
    { name: 'JR d', bytes: [0x18, 0x00], want: 12 },
    {
      name: 'JR NZ taken',
      bytes: [0x20, 0x00],
      want: 12,
      setup: (cpu) => (cpu.f = 0),
    },
    {
      name: 'JR NZ not taken',
      bytes: [0x20, 0x00],
      want: 7,
      setup: (cpu) => (cpu.f = ZF),
    },
    {
      name: 'DJNZ taken',
      bytes: [0x10, 0x00],
      want: 13,
      setup: (cpu) => (cpu.b = 2),
    },
    {
      name: 'DJNZ not taken',
      bytes: [0x10, 0x00],
      want: 8,
      setup: (cpu) => (cpu.b = 1),
    },
    { name: 'JP nn', bytes: [0xc3, 0x00, 0x10], want: 10 },
    {
      name: 'JP Z not taken',
      bytes: [0xca, 0x00, 0x10],
      want: 10,
      setup: (cpu) => (cpu.f = 0),
    },
    { name: 'CALL nn', bytes: [0xcd, 0x00, 0x10], want: 17 },
    {
      name: 'CALL Z not taken',
      bytes: [0xcc, 0x00, 0x10],
      want: 10,
      setup: (cpu) => (cpu.f = 0),
    },
    { name: 'RET', bytes: [0xc9], want: 10 },
    {
      name: 'RET Z taken',
      bytes: [0xc8],
      want: 11,
      setup: (cpu) => (cpu.f = ZF),
    },
    {
      name: 'RET Z not taken',
      bytes: [0xc8],
      want: 5,
      setup: (cpu) => (cpu.f = 0),
    },
    { name: 'PUSH BC', bytes: [0xc5], want: 11 },
    { name: 'POP BC', bytes: [0xc1], want: 10 },
    { name: 'RST 38h', bytes: [0xff], want: 11 },
    { name: 'EX (SP),HL', bytes: [0xe3], want: 19 },
    { name: 'JP (HL)', bytes: [0xe9], want: 4 },
    { name: 'LD SP,HL', bytes: [0xf9], want: 6 },
    { name: 'OUT (n),A', bytes: [0xd3, 0x00], want: 11 },
    { name: 'IN A,(n)', bytes: [0xdb, 0x00], want: 11 },
    { name: 'HALT', bytes: [0x76], want: 4 },
    { name: 'CB RLC B', bytes: [0xcb, 0x00], want: 8 },
    { name: 'CB RLC (HL)', bytes: [0xcb, 0x06], want: 15 },
    { name: 'CB BIT 3,(HL)', bytes: [0xcb, 0x5e], want: 12 },
    { name: 'CB SET 2,(HL)', bytes: [0xcb, 0xd6], want: 15 },
    { name: 'ED SBC HL,BC', bytes: [0xed, 0x42], want: 15 },
    { name: 'ED LD (nn),BC', bytes: [0xed, 0x43, 0x00, 0x60], want: 20 },
    { name: 'ED NEG', bytes: [0xed, 0x44], want: 8 },
    { name: 'ED RETN', bytes: [0xed, 0x45], want: 14 },
    { name: 'ED IM 1', bytes: [0xed, 0x56], want: 8 },
    { name: 'ED LD A,I', bytes: [0xed, 0x57], want: 9 },
    { name: 'ED RRD', bytes: [0xed, 0x67], want: 18 },
    { name: 'ED IN B,(C)', bytes: [0xed, 0x40], want: 12 },
    { name: 'ED OUT (C),B', bytes: [0xed, 0x41], want: 12 },
    { name: 'ED nop (ED 00)', bytes: [0xed, 0x00], want: 8 },
    {
      name: 'LDI',
      bytes: [0xed, 0xa0],
      want: 16,
      setup: (cpu) => {
        cpu.b = 0;
        cpu.c = 1;
      },
    },
    {
      name: 'LDIR repeat',
      bytes: [0xed, 0xb0],
      want: 21,
      setup: (cpu) => {
        cpu.b = 0;
        cpu.c = 2;
      },
    },
    {
      name: 'LDIR end',
      bytes: [0xed, 0xb0],
      want: 16,
      setup: (cpu) => {
        cpu.b = 0;
        cpu.c = 1;
      },
    },
    {
      name: 'CPIR repeat',
      bytes: [0xed, 0xb1],
      want: 21,
      setup: (cpu) => {
        cpu.a = 0xff;
        cpu.b = 0;
        cpu.c = 2;
      },
    },
    {
      name: 'CPIR end (BC=1)',
      bytes: [0xed, 0xb1],
      want: 16,
      setup: (cpu) => {
        cpu.a = 0xff;
        cpu.b = 0;
        cpu.c = 1;
      },
    },
    {
      name: 'INIR repeat',
      bytes: [0xed, 0xb2],
      want: 21,
      setup: (cpu) => (cpu.b = 2),
    },
    {
      name: 'OTIR end',
      bytes: [0xed, 0xb3],
      want: 16,
      setup: (cpu) => (cpu.b = 1),
    },
    { name: 'DD LD IX,nn', bytes: [0xdd, 0x21, 0x00, 0x00], want: 14 },
    { name: 'DD ADD IX,BC', bytes: [0xdd, 0x09], want: 15 },
    { name: 'DD LD A,(IX+d)', bytes: [0xdd, 0x7e, 0x00], want: 19 },
    { name: 'DD LD (IX+d),n', bytes: [0xdd, 0x36, 0x00, 0x00], want: 19 },
    { name: 'DD INC (IX+d)', bytes: [0xdd, 0x34, 0x00], want: 23 },
    { name: 'DD ADD A,(IX+d)', bytes: [0xdd, 0x86, 0x00], want: 19 },
    { name: 'DD ADD A,IXH', bytes: [0xdd, 0x84], want: 8 },
    { name: 'DD LD IXH,n', bytes: [0xdd, 0x26, 0x00], want: 11 },
    { name: 'DD PUSH IX', bytes: [0xdd, 0xe5], want: 15 },
    { name: 'DD POP IX', bytes: [0xdd, 0xe1], want: 14 },
    { name: 'DD EX (SP),IX', bytes: [0xdd, 0xe3], want: 23 },
    { name: 'DD JP (IX)', bytes: [0xdd, 0xe9], want: 8 },
    { name: 'DD prefix on plain op', bytes: [0xdd, 0x00], want: 8 },
    { name: 'DDCB SET 0,(IX+d)', bytes: [0xdd, 0xcb, 0x00, 0xc6], want: 23 },
    { name: 'DDCB BIT 0,(IX+d)', bytes: [0xdd, 0xcb, 0x00, 0x46], want: 20 },
    { name: 'FDCB RLC (IY+d),B', bytes: [0xfd, 0xcb, 0x00, 0x00], want: 23 },
  ];
  for (const t of tests) {
    const { cpu, bus } = makeCpu(t.bytes);
    cpu.ix = 0x4000;
    cpu.iy = 0x4000;
    cpu.h = 0x40;
    cpu.l = 0x00;
    cpu.d = 0x50;
    cpu.e = 0x00;
    if (t.setup) t.setup(cpu, bus);
    let got = 0;
    const steps = t.steps ?? 1;
    for (let s = 0; s < steps; s++) got += cpu.step();
    eq(`T-states ${t.name}`, got, t.want);
  }
}

// ================================================================ 4. interrupts, EI delay, HALT, R

section('EI delay and IM1 acceptance');
{
  const { cpu, bus } = makeCpu([0xfb, 0x00, 0x00, 0x00]); // EI / NOP / NOP
  cpu.im = 1;
  cpu.setIrqLine(true);
  const t1 = cpu.step(); // EI
  eq('EI cycles', t1, 4);
  eq('EI iff1', cpu.iff1, 1);
  cpu.step(); // NOP must execute (EI delay)
  eq('EI delay: next instr runs', cpu.pc, 2);
  const t3 = cpu.step(); // now the irq is accepted
  eq('IM1 cycles', t3, 13);
  eq('IM1 vector', cpu.pc, 0x0038);
  eq('IM1 iff1 cleared', cpu.iff1, 0);
  eq('IM1 iff2 cleared', cpu.iff2, 0);
  eq('IM1 pushed return', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
}
{
  // no irq when iff1 = 0
  const { cpu } = makeCpu([0x00, 0x00]);
  cpu.im = 1;
  cpu.setIrqLine(true);
  cpu.step();
  eq('masked irq ignored', cpu.pc, 1);
}

section('IM2 and IM0 vectoring');
{
  const { cpu, bus } = makeCpu([0xfb, 0x00, 0x00]);
  cpu.im = 2;
  cpu.i = 0x12;
  bus.mem[0x1234] = 0x78;
  bus.mem[0x1235] = 0x56;
  cpu.setIrqLine(true, 0x34);
  cpu.step(); // EI
  cpu.step(); // NOP (delay slot)
  const t = cpu.step();
  eq('IM2 cycles', t, 19);
  eq('IM2 vector', cpu.pc, 0x5678);
  eq('IM2 pushed return', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
}
{
  const { cpu } = makeCpu([0xfb, 0x00, 0x00]);
  cpu.im = 0;
  cpu.setIrqLine(true, 0xd7); // RST 10h on the bus
  cpu.step();
  cpu.step();
  const t = cpu.step();
  eq('IM0 RST cycles', t, 13);
  eq('IM0 RST vector', cpu.pc, 0x0010);
}
{
  const { cpu } = makeCpu([0xfb, 0x00, 0x00]);
  cpu.im = 0;
  cpu.setIrqLine(true, (0xcd << 16) | 0x4000); // MAME IM0 packed CALL 4000h
  cpu.step();
  cpu.step();
  const t = cpu.step();
  eq('IM0 CALL cycles', t, 19);
  eq('IM0 CALL vector', cpu.pc, 0x4000);
}

section('HOLD_LINE clears on acknowledge');
{
  const { cpu, bus } = makeCpu([0xfb, 0x00, 0x00, 0x00]);
  cpu.im = 1;
  bus.mem[0x0038] = 0xfb; // EI
  bus.mem[0x0039] = 0xed; // RETI
  bus.mem[0x003a] = 0x4d;
  cpu.setIrqLine(true, 0xff, true);
  cpu.step(); // EI
  cpu.step(); // delay-slot NOP
  cpu.step(); // acknowledge held IRQ
  cpu.step(); // EI in ISR
  cpu.step(); // RETI
  cpu.step(); // original program continues instead of re-entering IRQ
  eq('HOLD_LINE one-shot PC', cpu.pc, 3);
}

section('NMI, RETN, IFF semantics');
{
  const { cpu, bus } = makeCpu([0xfb, 0x00, 0x00]);
  bus.mem[0x66] = 0xed; // RETN at NMI vector
  bus.mem[0x67] = 0x45;
  cpu.step(); // EI -> iff1 = iff2 = 1
  cpu.step(); // NOP
  cpu.nmi();
  const t = cpu.step();
  eq('NMI cycles', t, 11);
  eq('NMI vector', cpu.pc, 0x0066);
  eq('NMI iff1 cleared', cpu.iff1, 0);
  eq('NMI iff2 preserved', cpu.iff2, 1);
  eq('NMI pushed return', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
  const t2 = cpu.step(); // RETN
  eq('RETN cycles', t2, 14);
  eq('RETN pc', cpu.pc, 0x0002);
  eq('RETN restores iff1', cpu.iff1, 1);
}

section('HALT behavior');
{
  const { cpu, bus } = makeCpu([0xfb, 0x76, 0x00]); // EI / HALT
  cpu.im = 1;
  cpu.step(); // EI
  const th = cpu.step(); // HALT
  eq('HALT cycles', th, 4);
  eq('HALT halted', cpu.halted, true);
  eq('HALT pc past instruction', cpu.pc, 2);
  const ti = cpu.step(); // idle
  eq('halted idle cycles', ti, 4);
  eq('still halted', cpu.halted, true);
  cpu.setIrqLine(true);
  const ta = cpu.step();
  eq('HALT irq wakeup cycles', ta, 13);
  eq('HALT wakeup vector', cpu.pc, 0x0038);
  eq('HALT wakeup return addr', bus.mem[0xfefe] | (bus.mem[0xfeff] << 8), 0x0002);
  eq('HALT cleared', cpu.halted, false);
}
{
  const { cpu } = makeCpu([0x76, 0x00]); // HALT, wake by NMI
  cpu.step();
  cpu.step();
  cpu.nmi();
  cpu.step();
  eq('HALT NMI wakeup', cpu.pc, 0x0066);
  eq('HALT NMI cleared', cpu.halted, false);
}

section('R register');
{
  const { cpu } = makeCpu([0x00, 0x00, 0x00]);
  cpu.r = 0;
  cpu.step();
  cpu.step();
  cpu.step();
  eq('R after 3 NOPs', cpu.r, 3);
}
{
  const { cpu } = makeCpu([0xdd, 0x7e, 0x00, 0xcb, 0x00, 0xed, 0x44, 0xdd, 0xcb, 0x00, 0x06]);
  cpu.ix = 0x4000;
  cpu.r = 0;
  cpu.step(); // DD op: +2
  eq('R after DD op', cpu.r, 2);
  cpu.step(); // CB op: +2
  eq('R after CB op', cpu.r, 4);
  cpu.step(); // ED op: +2
  eq('R after ED op', cpu.r, 6);
  cpu.step(); // DDCB op: +2 (displacement/opcode fetches do not refresh)
  eq('R after DDCB op', cpu.r, 8);
}
{
  const { cpu } = makeCpu(new Array<number>(130).fill(0x00));
  cpu.r = 0xfe; // bit 7 set
  cpu.step();
  eq('R bit7 preserved (fe->ff)', cpu.r, 0xff);
  cpu.step();
  eq('R 7-bit wrap keeps bit7', cpu.r, 0x80);
}

section('run() accumulates T-states');
{
  const { cpu } = makeCpu(new Array<number>(64).fill(0x00));
  const total = cpu.run(10); // NOPs are 4T each: 4+4+4 = 12 >= 10
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
