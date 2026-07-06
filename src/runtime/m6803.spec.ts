// Self-test for the M6803 core. Run with: node src/runtime/m6803.spec.ts
// No test framework; prints PASS/FAIL per section and sets process.exitCode.
// Expectations hand-computed from MAME's 6800ops.hxx / m6801.cpp semantics.

import { M6803, type M6803Bus, type M6803Ports } from './m6803.ts';

// CC bits (duplicated here on purpose; do not import internals)
const C = 0x01;
const V = 0x02;
const Z = 0x04;
const N = 0x08;
const I = 0x10;
const H = 0x20;

class TestBus implements M6803Bus {
  mem = new Uint8Array(0x10000);
  lowReads: number[] = []; // external-bus accesses below 0x100 (should only be $15-$7F)
  lowWrites: number[] = [];
  read(addr: number): number {
    if (addr < 0x100) this.lowReads.push(addr);
    return this.mem[addr];
  }
  write(addr: number, data: number): void {
    if (addr < 0x100) this.lowWrites.push(addr);
    this.mem[addr] = data;
  }
}

const ORG = 0x2000;

function makeCpu(
  program: number[],
  ports?: M6803Ports,
  org = ORG,
): { cpu: M6803; bus: TestBus } {
  const bus = new TestBus();
  bus.mem[0xfffe] = (org >> 8) & 0xff;
  bus.mem[0xffff] = org & 0xff;
  bus.mem.set(program, org);
  const cpu = new M6803(bus, ports); // constructor resets: pc <- vector, cc = $D0
  cpu.cc = 0; // clear I set by reset so flag expectations are exact
  cpu.sp = 0x1f00;
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

section('LD/ST 8-bit + flags (imm/dir/idx/ext)');
{
  const { cpu } = makeCpu([0x86, 0x12, 0xc6, 0x34]); // LDAA #$12 / LDAB #$34
  cpu.step();
  eq('LDAA # value', cpu.a, 0x12);
  eq('LDAA # flags', cpu.cc, 0);
  cpu.step();
  eq('LDAB # value', cpu.b, 0x34);
}
{
  const { cpu } = makeCpu([0x86, 0x00, 0x86, 0x80]);
  cpu.step();
  eq('LDAA #0 Z', cpu.cc, Z);
  cpu.step();
  eq('LDAA #$80 N', cpu.cc, N);
}
{
  // LDAA <$44 / LDAA $2050 / LDAA $10,X  (direct page $15-$7F is external bus)
  const { cpu, bus } = makeCpu([0x96, 0x44, 0xb6, 0x20, 0x50, 0xa6, 0x10]);
  bus.mem[0x0044] = 0x5a;
  bus.mem[0x2050] = 0x66;
  bus.mem[0x3010] = 0x77;
  cpu.x = 0x3000;
  cpu.step();
  eq('LDAA direct', cpu.a, 0x5a);
  cpu.step();
  eq('LDAA extended', cpu.a, 0x66);
  cpu.step();
  eq('LDAA indexed', cpu.a, 0x77);
}
{
  // STAA <$40 / STAB $2100 / STAA $05,X
  const { cpu, bus } = makeCpu([0x97, 0x40, 0xf7, 0x21, 0x00, 0xa7, 0x05]);
  cpu.a = 0x80;
  cpu.b = 0x00;
  cpu.x = 0x3000;
  cpu.step();
  eq('STAA direct mem', bus.mem[0x0040], 0x80);
  eq('STAA flags N', cpu.cc, N);
  cpu.step();
  eq('STAB extended mem', bus.mem[0x2100], 0x00);
  eq('STAB flags Z', cpu.cc, Z);
  cpu.step();
  eq('STAA indexed mem', bus.mem[0x3005], 0x80);
}
{
  const { cpu, bus } = makeCpu([0xd6, 0x30, 0xe6, 0x02]); // LDAB <$30 / LDAB $02,X
  bus.mem[0x0030] = 0xfe;
  bus.mem[0x0032] = 0x01;
  cpu.x = 0x0030;
  cpu.step();
  eq('LDAB direct', cpu.b, 0xfe);
  eq('LDAB direct N', cpu.cc, N);
  cpu.step();
  eq('LDAB indexed (X in low page)', cpu.b, 0x01);
}

// ================================================================ 2. 8-bit arithmetic

section('ADD/ADC/SUB/SBC/CMP + H flag');
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
  const { cpu } = makeCpu([0x0d, 0x89, 0x0f]); // SEC / ADCA #$0F
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
  const { cpu } = makeCpu([0x0d, 0x82, 0x01]); // SEC / SBCA #1
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
  const { cpu } = makeCpu([0xcb, 0x01]); // ADDB #1
  cpu.b = 0xff;
  cpu.step();
  eq('ADDB wraps', cpu.b, 0x00);
  eq('ADDB wrap flags', cpu.cc, H | Z | C);
}
{
  const { cpu } = makeCpu([0x10, 0x11]); // SBA / CBA
  cpu.a = 0x50;
  cpu.b = 0x60;
  cpu.step();
  eq('SBA result', cpu.a, 0xf0);
  eq('SBA flags', cpu.cc, N | C);
  cpu.a = 0x22;
  cpu.b = 0x22;
  cpu.step();
  eq('CBA leaves A', cpu.a, 0x22);
  eq('CBA Z', cpu.cc, Z);
}
{
  const { cpu } = makeCpu([0x1b]); // ABA
  cpu.a = 0x0f;
  cpu.b = 0x01;
  cpu.step();
  eq('ABA result', cpu.a, 0x10);
  eq('ABA H', cpu.cc, H);
}

// ================================================================ 3. logic

section('AND/OR/EOR/BIT clear V');
{
  const { cpu } = makeCpu([0x0b, 0x84, 0x0f]); // SEV / ANDA #$0F
  cpu.a = 0xf0;
  cpu.step();
  cpu.step();
  eq('ANDA result', cpu.a, 0x00);
  eq('ANDA flags Z, V cleared', cpu.cc, Z);
}
{
  const { cpu } = makeCpu([0x8a, 0x80, 0x88, 0xff, 0x85, 0x01]); // ORAA / EORA / BITA
  cpu.a = 0x01;
  cpu.step();
  eq('ORAA result', cpu.a, 0x81);
  eq('ORAA flags', cpu.cc, N);
  cpu.step();
  eq('EORA result', cpu.a, 0x7e);
  eq('EORA flags', cpu.cc, 0);
  cpu.step();
  eq('BITA leaves A', cpu.a, 0x7e);
  eq('BITA flags Z', cpu.cc, Z); // 0x7e & 1 = 0
}
{
  const { cpu } = makeCpu([0xc4, 0xf0, 0xca, 0x0f, 0xc8, 0x8f, 0xc5, 0x80]); // B forms
  cpu.b = 0x8f;
  cpu.step();
  eq('ANDB result', cpu.b, 0x80);
  cpu.step();
  eq('ORAB result', cpu.b, 0x8f);
  cpu.step();
  eq('EORB result', cpu.b, 0x00);
  eq('EORB Z', cpu.cc, Z);
  cpu.step();
  eq('BITB Z (0 & $80)', cpu.cc, Z);
}

// ================================================================ 4. read-modify-write

section('NEG/COM/LSR/ROR/ASR/ASL/ROL/DEC/INC/TST/CLR register forms');
{
  const { cpu } = makeCpu([0x40, 0x40, 0x40]); // NEGA x3
  cpu.a = 0x01;
  cpu.step();
  eq('NEGA 1 -> ff', cpu.a, 0xff);
  eq('NEGA 1 flags', cpu.cc, N | C);
  cpu.a = 0x00;
  cpu.step();
  eq('NEGA 0 -> 0', cpu.a, 0x00);
  eq('NEGA 0 flags Z (no C)', cpu.cc, Z);
  cpu.a = 0x80;
  cpu.step();
  eq('NEGA 80 -> 80', cpu.a, 0x80);
  eq('NEGA 80 flags N V C', cpu.cc, N | V | C);
}
{
  const { cpu } = makeCpu([0x43, 0x53]); // COMA / COMB
  cpu.a = 0x55;
  cpu.b = 0xff;
  cpu.step();
  eq('COMA result', cpu.a, 0xaa);
  eq('COMA flags N C', cpu.cc, N | C);
  cpu.step();
  eq('COMB result', cpu.b, 0x00);
  eq('COMB flags Z C', cpu.cc, Z | C);
}
{
  const { cpu } = makeCpu([0x44, 0x44]); // LSRA x2
  cpu.a = 0x01;
  cpu.step();
  eq('LSRA 1 -> 0', cpu.a, 0x00);
  eq('LSRA flags Z C V(=N^C)', cpu.cc, Z | C | V);
  cpu.a = 0x80;
  cpu.step();
  eq('LSRA 80 -> 40', cpu.a, 0x40);
  eq('LSRA 80 flags clear', cpu.cc, 0);
}
{
  const { cpu } = makeCpu([0x0d, 0x46]); // SEC / RORA
  cpu.a = 0x01;
  cpu.step();
  cpu.step();
  eq('RORA thru carry', cpu.a, 0x80);
  eq('RORA flags N C', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([0x47]); // ASRA
  cpu.a = 0x81;
  cpu.step();
  eq('ASRA keeps sign', cpu.a, 0xc0);
  eq('ASRA flags N C', cpu.cc, N | C);
}
{
  const { cpu } = makeCpu([0x48]); // ASLA
  cpu.a = 0x80;
  cpu.step();
  eq('ASLA 80 -> 0', cpu.a, 0x00);
  eq('ASLA flags Z V C', cpu.cc, Z | V | C);
}
{
  const { cpu } = makeCpu([0x0d, 0x49]); // SEC / ROLA
  cpu.a = 0x40;
  cpu.step();
  cpu.step();
  eq('ROLA thru carry', cpu.a, 0x81);
  eq('ROLA flags N V', cpu.cc, N | V);
}
{
  const { cpu } = makeCpu([0x4a, 0x4a, 0x5c]); // DECA x2 / INCB
  cpu.a = 0x80;
  cpu.step();
  eq('DECA 80 -> 7f', cpu.a, 0x7f);
  eq('DECA 80 flags V', cpu.cc, V);
  cpu.a = 0x01;
  cpu.step();
  eq('DECA 1 -> 0 flags Z', cpu.cc, Z);
  cpu.b = 0x7f;
  cpu.step();
  eq('INCB 7f -> 80', cpu.b, 0x80);
  eq('INCB flags N V', cpu.cc, N | V);
}
{
  const { cpu } = makeCpu([0x0d, 0x4d, 0x4f]); // SEC / TSTA / CLRA
  cpu.a = 0x80;
  cpu.step();
  cpu.step();
  eq('TSTA flags N, C cleared (6800 semantics)', cpu.cc, N);
  cpu.step();
  eq('CLRA result', cpu.a, 0x00);
  eq('CLRA flags Z only', cpu.cc, Z);
}

section('RMW memory forms (indexed/extended)');
{
  const { cpu, bus } = makeCpu([0x70, 0x30, 0x00, 0x6c, 0x05, 0x63, 0x06]); // NEG ext / INC idx / COM idx
  bus.mem[0x3000] = 0x01;
  bus.mem[0x3005] = 0x7f;
  bus.mem[0x3006] = 0x0f;
  cpu.x = 0x3000;
  cpu.step();
  eq('NEG ext mem', bus.mem[0x3000], 0xff);
  eq('NEG ext flags', cpu.cc, N | C);
  cpu.step();
  eq('INC idx mem', bus.mem[0x3005], 0x80);
  eq('INC idx flags (C kept from NEG)', cpu.cc, N | V | C);
  cpu.step();
  eq('COM idx mem', bus.mem[0x3006], 0xf0);
}
{
  const { cpu, bus } = makeCpu([0x74, 0x30, 0x00, 0x7a, 0x30, 0x01]); // LSR ext / DEC ext
  bus.mem[0x3000] = 0x03;
  bus.mem[0x3001] = 0x00;
  cpu.step();
  eq('LSR ext mem', bus.mem[0x3000], 0x01);
  eq('LSR ext C', cpu.cc, C | V);
  cpu.step();
  eq('DEC ext mem', bus.mem[0x3001], 0xff);
}
{
  const { cpu, bus } = makeCpu([0x6d, 0x02, 0x7f, 0x30, 0x02]); // TST idx / CLR ext
  bus.mem[0x3002] = 0x80;
  cpu.x = 0x3000;
  cpu.cc = C;
  cpu.step();
  eq('TST idx flags (C cleared)', cpu.cc, N);
  eq('TST idx leaves mem', bus.mem[0x3002], 0x80);
  cpu.step();
  eq('CLR ext mem', bus.mem[0x3002], 0x00);
  eq('CLR ext flags', cpu.cc, Z);
}
{
  const { cpu } = makeCpu([0x6e, 0x10, 0x00, 0x7e, 0x40, 0x00]); // JMP idx / (JMP ext at 3010)
  cpu.x = 0x3000;
  cpu.step();
  eq('JMP idx pc', cpu.pc, 0x3010);
}
{
  const { cpu } = makeCpu([0x7e, 0x12, 0x34]); // JMP ext
  cpu.step();
  eq('JMP ext pc', cpu.pc, 0x1234);
}

// ================================================================ 5. inherent transfers

section('TAB/TBA/TAP/TPA/INX/DEX/TSX/TXS/INS/DES + flag ops');
{
  const { cpu } = makeCpu([0x16, 0x17]); // TAB / TBA
  cpu.a = 0x80;
  cpu.b = 0x00;
  cpu.step();
  eq('TAB b', cpu.b, 0x80);
  eq('TAB flags N', cpu.cc, N);
  cpu.b = 0x00;
  cpu.step();
  eq('TBA a', cpu.a, 0x00);
  eq('TBA flags Z', cpu.cc, Z);
}
{
  const { cpu } = makeCpu([0x06, 0x07]); // TAP / TPA
  cpu.a = 0x35;
  cpu.step();
  eq('TAP cc = A', cpu.cc, 0x35);
  cpu.a = 0x00;
  cpu.step();
  eq('TPA a = cc', cpu.a, 0x35);
}
{
  const { cpu } = makeCpu([0x08, 0x09, 0x09]); // INX / DEX / DEX
  cpu.x = 0xffff;
  cpu.cc = N | C; // INX/DEX touch only Z
  cpu.step();
  eq('INX wraps to 0', cpu.x, 0x0000);
  eq('INX flags Z only added', cpu.cc, N | C | Z);
  cpu.step();
  eq('DEX to ffff', cpu.x, 0xffff);
  eq('DEX clears Z, keeps others', cpu.cc, N | C);
  cpu.x = 0x0001;
  cpu.step();
  eq('DEX to 0 sets Z', cpu.cc, N | C | Z);
}
{
  const { cpu } = makeCpu([0x30, 0x35, 0x31, 0x34]); // TSX / TXS / INS / DES
  cpu.sp = 0x1000;
  cpu.step();
  eq('TSX x = sp+1', cpu.x, 0x1001);
  eq('TSX leaves sp', cpu.sp, 0x1000);
  cpu.x = 0x2001;
  cpu.step();
  eq('TXS sp = x-1', cpu.sp, 0x2000);
  cpu.step();
  eq('INS', cpu.sp, 0x2001);
  cpu.step();
  eq('DES', cpu.sp, 0x2000);
}
{
  const { cpu } = makeCpu([0x0b, 0x0a, 0x0d, 0x0c, 0x0f]); // SEV CLV SEC CLC SEI
  cpu.step();
  eq('SEV', cpu.cc, V);
  cpu.step();
  eq('CLV', cpu.cc, 0);
  cpu.step();
  eq('SEC', cpu.cc, C);
  cpu.step();
  eq('CLC', cpu.cc, 0);
  cpu.step();
  eq('SEI', cpu.cc, I);
}

// ================================================================ 6. DAA

section('DAA');
{
  const { cpu } = makeCpu([0x86, 0x19, 0x8b, 0x28, 0x19]); // LDAA #$19 / ADDA #$28 / DAA
  cpu.step();
  cpu.step();
  eq('pre-DAA binary sum', cpu.a, 0x41);
  cpu.step();
  eq('DAA 19+28 = 47 BCD', cpu.a, 0x47);
  eq('DAA no carry (H kept)', cpu.cc, H);
}
{
  const { cpu } = makeCpu([0x86, 0x99, 0x8b, 0x01, 0x19]); // 99+01
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA 99+01 = 00', cpu.a, 0x00);
  eq('DAA 99+01 flags Z C', cpu.cc, Z | C);
}
{
  const { cpu } = makeCpu([0x86, 0x80, 0x8b, 0x80, 0x19]); // 80+80
  cpu.step();
  cpu.step();
  cpu.step();
  eq('DAA 80+80 = 60', cpu.a, 0x60);
  eq('DAA 80+80 keeps C', (cpu.cc & C) !== 0, true);
}

// ================================================================ 7. 16-bit load/store

section('LDD/STD/LDX/STX/LDS/STS');
{
  const { cpu } = makeCpu([0xcc, 0x12, 0x34, 0xcc, 0x00, 0x00, 0xcc, 0x80, 0x00]); // LDD #
  cpu.step();
  eq('LDD A', cpu.a, 0x12);
  eq('LDD B', cpu.b, 0x34);
  eq('LDD flags', cpu.cc, 0);
  cpu.step();
  eq('LDD #0 Z', cpu.cc, Z);
  cpu.step();
  eq('LDD #$8000 N', cpu.cc, N);
}
{
  const { cpu, bus } = makeCpu([0xdd, 0x40, 0xfd, 0x30, 0x00]); // STD <$40 / STD $3000
  cpu.a = 0xab;
  cpu.b = 0xcd;
  cpu.step();
  eq('STD dir hi', bus.mem[0x0040], 0xab);
  eq('STD dir lo', bus.mem[0x0041], 0xcd);
  eq('STD flags N', cpu.cc, N);
  cpu.step();
  eq('STD ext hi', bus.mem[0x3000], 0xab);
  eq('STD ext lo', bus.mem[0x3001], 0xcd);
}
{
  const { cpu, bus } = makeCpu([0xce, 0x45, 0x67, 0xff, 0x30, 0x00, 0xde, 0x20]); // LDX # / STX ext / LDX dir
  bus.mem[0x0020] = 0x11;
  bus.mem[0x0021] = 0x22;
  cpu.step();
  eq('LDX #', cpu.x, 0x4567);
  cpu.step();
  eq('STX ext hi', bus.mem[0x3000], 0x45);
  eq('STX ext lo', bus.mem[0x3001], 0x67);
  cpu.step();
  eq('LDX dir', cpu.x, 0x1122);
}
{
  const { cpu, bus } = makeCpu([0x8e, 0x1e, 0x00, 0x9f, 0x40, 0xbe, 0x30, 0x00]); // LDS # / STS dir / LDS ext
  bus.mem[0x3000] = 0x1f;
  bus.mem[0x3001] = 0x80;
  cpu.step();
  eq('LDS #', cpu.sp, 0x1e00);
  cpu.step();
  eq('STS dir hi', bus.mem[0x0040], 0x1e);
  eq('STS dir lo', bus.mem[0x0041], 0x00);
  cpu.step();
  eq('LDS ext', cpu.sp, 0x1f80);
  eq('LDS ext flags', cpu.cc, 0);
}
{
  const { cpu, bus } = makeCpu([0xec, 0x04, 0xed, 0x06]); // LDD idx / STD idx
  bus.mem[0x3004] = 0xbe;
  bus.mem[0x3005] = 0xef;
  cpu.x = 0x3000;
  cpu.step();
  eq('LDD idx', (cpu.a << 8) | cpu.b, 0xbeef);
  cpu.step();
  eq('STD idx hi', bus.mem[0x3006], 0xbe);
  eq('STD idx lo', bus.mem[0x3007], 0xef);
}

// ================================================================ 8. 6801 extensions

section('6801 extensions: ABX/ADDD/SUBD/ASLD/LSRD/MUL/PSHX/PULX/BRN/CPX');
{
  const { cpu } = makeCpu([0x3a]); // ABX
  cpu.x = 0x1000;
  cpu.b = 0xff;
  cpu.cc = N | Z | V | C;
  cpu.step();
  eq('ABX unsigned add', cpu.x, 0x10ff);
  eq('ABX no flags', cpu.cc, N | Z | V | C);
}
{
  const { cpu } = makeCpu([0xc3, 0x00, 0x01, 0xc3, 0x7f, 0xff]); // ADDD #
  cpu.a = 0xff;
  cpu.b = 0xff;
  cpu.step();
  eq('ADDD ffff+1', (cpu.a << 8) | cpu.b, 0x0000);
  eq('ADDD ffff+1 flags Z C', cpu.cc, Z | C);
  cpu.a = 0x00;
  cpu.b = 0x01;
  cpu.step();
  eq('ADDD 1+7fff', (cpu.a << 8) | cpu.b, 0x8000);
  eq('ADDD 1+7fff flags N V', cpu.cc, N | V);
}
{
  const { cpu, bus } = makeCpu([0x83, 0x00, 0x01, 0x93, 0x40, 0xa3, 0x00, 0xb3, 0x30, 0x00]); // SUBD im/di/ix/ex
  bus.mem[0x0040] = 0x00;
  bus.mem[0x0041] = 0x02;
  bus.mem[0x3000] = 0x00;
  bus.mem[0x3001] = 0x03;
  cpu.a = 0x00;
  cpu.b = 0x00;
  cpu.x = 0x3000;
  cpu.step();
  eq('SUBD 0-1', (cpu.a << 8) | cpu.b, 0xffff);
  eq('SUBD 0-1 flags N C', cpu.cc, N | C);
  cpu.step();
  eq('SUBD dir ffff-2', (cpu.a << 8) | cpu.b, 0xfffd);
  cpu.step();
  eq('SUBD idx fffd-3', (cpu.a << 8) | cpu.b, 0xfffa);
  cpu.step();
  eq('SUBD ext fffa-3', (cpu.a << 8) | cpu.b, 0xfff7);
}
{
  const { cpu } = makeCpu([0x04, 0x04]); // LSRD x2
  cpu.a = 0x00;
  cpu.b = 0x03;
  cpu.step();
  eq('LSRD result', (cpu.a << 8) | cpu.b, 0x0001);
  eq('LSRD flags C V', cpu.cc, C | V);
  cpu.step();
  eq('LSRD to zero', (cpu.a << 8) | cpu.b, 0x0000);
  eq('LSRD zero flags Z C V', cpu.cc, Z | C | V);
}
{
  const { cpu } = makeCpu([0x05]); // ASLD
  cpu.a = 0x80;
  cpu.b = 0x01;
  cpu.step();
  eq('ASLD result', (cpu.a << 8) | cpu.b, 0x0002);
  eq('ASLD flags V C', cpu.cc, V | C);
}
{
  const { cpu } = makeCpu([0x3d, 0x3d]); // MUL x2
  cpu.a = 0x0c;
  cpu.b = 0x64;
  cpu.cc = Z | V; // MUL touches only C
  cpu.step();
  eq('MUL result', (cpu.a << 8) | cpu.b, 0x04b0);
  eq('MUL C from bit7 of low byte, others kept', cpu.cc, Z | V | C);
  cpu.a = 0x02;
  cpu.b = 0x03;
  cpu.step();
  eq('MUL small result', (cpu.a << 8) | cpu.b, 0x0006);
  eq('MUL C clear', cpu.cc, Z | V);
}
{
  const { cpu, bus } = makeCpu([0x3c, 0x38]); // PSHX / PULX
  cpu.x = 0x1234;
  cpu.sp = 0x1f00;
  cpu.step();
  eq('PSHX low byte first', bus.mem[0x1f00], 0x34);
  eq('PSHX high byte', bus.mem[0x1eff], 0x12);
  eq('PSHX sp', cpu.sp, 0x1efe);
  cpu.x = 0;
  cpu.step();
  eq('PULX restores', cpu.x, 0x1234);
  eq('PULX sp', cpu.sp, 0x1f00);
}
{
  const { cpu } = makeCpu([0x21, 0x10, 0x01]); // BRN +$10 / NOP
  cpu.step();
  eq('BRN never branches', cpu.pc, ORG + 2);
}
{
  // 6801 CPX semantics: full NZVC (the 6800 left C untouched)
  const { cpu } = makeCpu([0x8c, 0x00, 0x01, 0x8c, 0x80, 0x00]);
  cpu.x = 0x0000;
  cpu.step();
  eq('CPX 0-1 flags N C (6801 sets C!)', cpu.cc, N | C);
  eq('CPX leaves X', cpu.x, 0x0000);
  cpu.x = 0x8000;
  cpu.step();
  eq('CPX equal Z', cpu.cc, Z);
}
{
  const { cpu, bus } = makeCpu([0x9c, 0x40]); // CPX dir
  bus.mem[0x0040] = 0x00;
  bus.mem[0x0041] = 0x01;
  cpu.x = 0x8000;
  cpu.step();
  // 0x8000 - 1 = 0x7fff: signed overflow -> V, no borrow
  eq('CPX 8000-0001 flags V', cpu.cc, V);
}

// ================================================================ 9. branches

section('branch conditions (all 16)');
{
  const cases: [number, string, number, boolean][] = [
    [0x20, 'BRA', 0, true],
    [0x21, 'BRN', 0, false],
    [0x22, 'BHI cc=0', 0, true],
    [0x22, 'BHI C', C, false],
    [0x22, 'BHI Z', Z, false],
    [0x23, 'BLS C', C, true],
    [0x23, 'BLS cc=0', 0, false],
    [0x24, 'BCC cc=0', 0, true],
    [0x24, 'BCC C', C, false],
    [0x25, 'BCS C', C, true],
    [0x26, 'BNE cc=0', 0, true],
    [0x26, 'BNE Z', Z, false],
    [0x27, 'BEQ Z', Z, true],
    [0x28, 'BVC cc=0', 0, true],
    [0x29, 'BVS V', V, true],
    [0x2a, 'BPL cc=0', 0, true],
    [0x2b, 'BMI N', N, true],
    [0x2c, 'BGE N V', N | V, true],
    [0x2c, 'BGE N', N, false],
    [0x2d, 'BLT N', N, true],
    [0x2d, 'BLT N V', N | V, false],
    [0x2e, 'BGT cc=0', 0, true],
    [0x2e, 'BGT Z', Z, false],
    [0x2e, 'BGT N', N, false],
    [0x2f, 'BLE Z', Z, true],
    [0x2f, 'BLE N', N, true],
    [0x2f, 'BLE cc=0', 0, false],
  ];
  for (const [op, name, cc, taken] of cases) {
    const { cpu } = makeCpu([op, 0x10]);
    cpu.cc = cc;
    cpu.step();
    eq(name, cpu.pc, taken ? ORG + 2 + 0x10 : ORG + 2);
  }
}
{
  const { cpu } = makeCpu([0x20, 0xfe]); // BRA -2 (self)
  cpu.step();
  eq('backward branch', cpu.pc, ORG);
}

// ================================================================ 10. JSR/BSR/RTS

section('JSR/BSR/RTS');
{
  const { cpu, bus } = makeCpu([0xbd, 0x30, 0x00]); // JSR $3000
  bus.mem[0x3000] = 0x39; // RTS
  cpu.sp = 0x1f00;
  cpu.step();
  eq('JSR pc', cpu.pc, 0x3000);
  eq('JSR pushes return lo', bus.mem[0x1f00], 0x03);
  eq('JSR pushes return hi', bus.mem[0x1eff], 0x20);
  eq('JSR sp', cpu.sp, 0x1efe);
  cpu.step();
  eq('RTS returns', cpu.pc, ORG + 3);
  eq('RTS sp', cpu.sp, 0x1f00);
}
{
  const { cpu } = makeCpu([0x8d, 0x04]); // BSR +4
  cpu.sp = 0x1f00;
  cpu.step();
  eq('BSR target', cpu.pc, ORG + 2 + 4);
  eq('BSR sp', cpu.sp, 0x1efe);
}
{
  const { cpu } = makeCpu([0x9d, 0x60]); // JSR direct
  cpu.step();
  eq('JSR dir pc', cpu.pc, 0x0060);
}
{
  const { cpu } = makeCpu([0xad, 0x08]); // JSR idx
  cpu.x = 0x4000;
  cpu.step();
  eq('JSR idx pc', cpu.pc, 0x4008);
}

// ================================================================ 11. stack order / SWI / RTI

section('PSH/PUL order, SWI stack frame, RTI');
{
  const { cpu, bus } = makeCpu([0x36, 0x37, 0x33, 0x32]); // PSHA PSHB PULB PULA
  cpu.a = 0x11;
  cpu.b = 0x22;
  cpu.sp = 0x1f00;
  cpu.step();
  eq('PSHA mem', bus.mem[0x1f00], 0x11);
  eq('PSHA sp', cpu.sp, 0x1eff);
  cpu.step();
  eq('PSHB mem', bus.mem[0x1eff], 0x22);
  cpu.a = 0;
  cpu.b = 0;
  cpu.step();
  eq('PULB', cpu.b, 0x22);
  cpu.step();
  eq('PULA', cpu.a, 0x11);
  eq('PUL sp restored', cpu.sp, 0x1f00);
}
{
  const { cpu, bus } = makeCpu([0x3f]); // SWI
  bus.mem[0xfffa] = 0x40;
  bus.mem[0xfffb] = 0x00;
  cpu.a = 0xaa;
  cpu.b = 0xbb;
  cpu.x = 0x1234;
  cpu.cc = C | V;
  cpu.sp = 0x1f00;
  cpu.step();
  eq('SWI vector', cpu.pc, 0x4000);
  eq('SWI sets I', (cpu.cc & I) !== 0, true);
  eq('SWI frame PCL', bus.mem[0x1f00], 0x01);
  eq('SWI frame PCH', bus.mem[0x1eff], 0x20);
  eq('SWI frame XL', bus.mem[0x1efe], 0x34);
  eq('SWI frame XH', bus.mem[0x1efd], 0x12);
  eq('SWI frame A', bus.mem[0x1efc], 0xaa);
  eq('SWI frame B', bus.mem[0x1efb], 0xbb);
  eq('SWI frame CC', bus.mem[0x1efa], C | V);
  eq('SWI sp', cpu.sp, 0x1ef9);
}
{
  const { cpu, bus } = makeCpu([0x3f]); // SWI then RTI from handler
  bus.mem[0xfffa] = 0x40;
  bus.mem[0xfffb] = 0x00;
  bus.mem[0x4000] = 0x3b; // RTI
  cpu.a = 0x55;
  cpu.b = 0x66;
  cpu.x = 0xbeef;
  cpu.cc = N;
  cpu.sp = 0x1f00;
  cpu.step();
  cpu.a = 0;
  cpu.b = 0;
  cpu.x = 0;
  cpu.step(); // RTI
  eq('RTI pc', cpu.pc, ORG + 1);
  eq('RTI a', cpu.a, 0x55);
  eq('RTI b', cpu.b, 0x66);
  eq('RTI x', cpu.x, 0xbeef);
  eq('RTI cc', cpu.cc, N);
  eq('RTI sp', cpu.sp, 0x1f00);
}

// ================================================================ 12. interrupts

section('IRQ1: level, masked by I, 12-cycle entry');
{
  const { cpu, bus } = makeCpu([0x01, 0x01]); // NOPs
  bus.mem[0xfff8] = 0x50;
  bus.mem[0xfff9] = 0x00;
  cpu.setIrqLine(true);
  const cyc = cpu.step();
  eq('IRQ entry cycles', cyc, 12);
  eq('IRQ vector', cpu.pc, 0x5000);
  eq('IRQ sets I', (cpu.cc & I) !== 0, true);
  eq('IRQ pushed 7 bytes', cpu.sp, 0x1f00 - 7);
  eq('IRQ frame CC at sp+1', bus.mem[cpu.sp + 1], 0x00);
}
{
  const { cpu } = makeCpu([0x01, 0x01]);
  cpu.cc = I; // masked
  cpu.setIrqLine(true);
  cpu.step();
  eq('masked IRQ executes instruction', cpu.pc, ORG + 1);
}
{
  // full round trip: IRQ -> handler -> RTI resumes
  const { cpu, bus } = makeCpu([0x86, 0x42, 0x01]); // LDAA #$42 / NOP
  bus.mem[0xfff8] = 0x50;
  bus.mem[0xfff9] = 0x00;
  bus.mem[0x5000] = 0x3b; // RTI
  cpu.setIrqLine(true);
  cpu.step(); // dispatch
  cpu.setIrqLine(false);
  cpu.step(); // RTI
  eq('resume pc', cpu.pc, ORG);
  cpu.step();
  eq('resumed instruction', cpu.a, 0x42);
}

section('NMI: edge, unmasked, priority over IRQ');
{
  const { cpu, bus } = makeCpu([0x01, 0x01, 0x01]);
  bus.mem[0xfffc] = 0x60;
  bus.mem[0xfffd] = 0x00;
  cpu.cc = I; // NMI ignores I
  cpu.nmi();
  const cyc = cpu.step();
  eq('NMI entry cycles', cyc, 12);
  eq('NMI vector', cpu.pc, 0x6000);
  bus.mem[0x6000] = 0x01; // NOP at handler
  cpu.step();
  eq('NMI is edge (no re-entry)', cpu.pc, 0x6001);
}
{
  const { cpu, bus } = makeCpu([0x01]);
  bus.mem[0xfff8] = 0x50;
  bus.mem[0xfffc] = 0x60;
  cpu.nmi();
  cpu.setIrqLine(true);
  cpu.step();
  eq('NMI wins over IRQ', cpu.pc, 0x6000);
  cpu.cc &= ~I; // unmask inside handler
  cpu.step();
  eq('then IRQ taken', cpu.pc, 0x5000);
}

section('WAI: state push, wake timing, halted flag');
{
  const { cpu, bus } = makeCpu([0x3e, 0x01]); // WAI (I set: only NMI can wake)
  bus.mem[0xfffc] = 0x60;
  bus.mem[0xfffd] = 0x00;
  cpu.cc = I;
  const waiCyc = cpu.step();
  eq('WAI cycles', waiCyc, 9);
  eq('WAI halted', cpu.halted, true);
  eq('WAI pushed 7 bytes', cpu.sp, 0x1f00 - 7);
  const idle = cpu.step();
  eq('WAI idle burns 1 cycle', idle, 1);
  cpu.setIrqLine(true); // masked -> still waiting
  cpu.step();
  eq('WAI stays halted under masked IRQ', cpu.halted, true);
  const spBefore = cpu.sp;
  cpu.nmi();
  const wake = cpu.step();
  eq('WAI wake cycles (no second push)', wake, 4);
  eq('WAI wake pc', cpu.pc, 0x6000);
  eq('WAI wake sp unchanged', cpu.sp, spBefore);
  eq('WAI wake clears halted', cpu.halted, false);
}
{
  const { cpu, bus } = makeCpu([0x3e]); // WAI with I clear, IRQ wakes
  bus.mem[0xfff8] = 0x50;
  bus.mem[0xfff9] = 0x00;
  cpu.step();
  cpu.step();
  cpu.setIrqLine(true);
  const wake = cpu.step();
  eq('WAI IRQ wake cycles', wake, 4);
  eq('WAI IRQ wake pc', cpu.pc, 0x5000);
  eq('I set after wake', (cpu.cc & I) !== 0, true);
}

section('TAP/CLI one-instruction interrupt shadow');
{
  const { cpu, bus } = makeCpu([0x0e, 0x86, 0x99, 0x01]); // CLI / LDAA #$99 / NOP
  bus.mem[0xfff8] = 0x50;
  bus.mem[0xfff9] = 0x00;
  cpu.cc = I;
  cpu.setIrqLine(true);
  cpu.step(); // CLI (arms shadow)
  eq('CLI clears I', (cpu.cc & I) !== 0, false);
  cpu.step(); // shadow: LDAA executes before the IRQ is taken
  eq('shadow instruction ran', cpu.a, 0x99);
  cpu.step();
  eq('IRQ taken after shadow', cpu.pc, 0x5000);
}
{
  const { cpu, bus } = makeCpu([0x06, 0x86, 0x77, 0x01]); // TAP / LDAA #$77 / NOP
  bus.mem[0xfff8] = 0x50;
  bus.mem[0xfff9] = 0x00;
  cpu.cc = I;
  cpu.a = 0x00; // TAP clears I
  cpu.setIrqLine(true);
  cpu.step(); // TAP
  cpu.step(); // shadow
  eq('TAP shadow instruction ran', cpu.a, 0x77);
  cpu.step();
  eq('IRQ taken after TAP shadow', cpu.pc, 0x5000);
}
{
  const { cpu } = makeCpu([0x0e, 0x01]); // CLI with I already clear: no shadow needed
  cpu.cc = 0;
  cpu.setIrqLine(false);
  cpu.step();
  cpu.step();
  eq('CLI with I clear is inert', cpu.pc, ORG + 2);
}

// ================================================================ 13. internal timer

section('free-running counter');
{
  const { cpu } = makeCpu([0x96, 0x09, 0xd6, 0x0a]); // LDAA <$09 / LDAB <$0A
  cpu.step();
  eq('counter high at t=0', cpu.a, 0x00);
  cpu.step(); // during exec, counter = 3 (first LDAA took 3 cycles)
  eq('counter low after 3 cycles', cpu.b, 0x03);
}
{
  // $09 write forces CT=$FFF8 and latches; $0A write restores latch<<8|data
  const { cpu } = makeCpu([0x86, 0x12, 0x97, 0x09, 0xc6, 0x34, 0xd7, 0x0a, 0x96, 0x09, 0xd6, 0x0a]);
  cpu.step(); // LDAA #$12
  cpu.step(); // STAA $09 -> CT = $FFF8
  cpu.step(); // LDAB #$34
  cpu.step(); // STAB $0A -> CT = $1234
  cpu.step(); // LDAA $09 (counter = $1234 + 3 by exec time)
  eq('counter high after cl_w', cpu.a, 0x12);
  cpu.step();
  eq('counter low after cl_w (+6 cycles)', cpu.b, 0x3a);
}

section('output compare: OCF, OCI vector, flag-clear protocol');
{
  // LDD #$0060 / STD $0B / LDAA #$08 (EOCI) / STAA $08 / CLI / BRA *
  const prog = [0xcc, 0x00, 0x60, 0xdd, 0x0b, 0x86, 0x08, 0x97, 0x08, 0x0e, 0x20, 0xfe];
  const { cpu, bus } = makeCpu(prog);
  const isr = 0x5000;
  bus.mem[0xfff4] = isr >> 8;
  bus.mem[0xfff5] = isr & 0xff;
  // ISR: LDAA $08 / LDAB $0B / STAB $0B (clears OCF: TCSR was read) / LDAB $08
  bus.mem.set([0x96, 0x08, 0xd6, 0x0b, 0xd7, 0x0b, 0xd6, 0x08], isr);
  cpu.cc = I;
  let total = 0;
  let dispatched = -1;
  for (let i = 0; i < 100 && dispatched < 0; i++) {
    const c = cpu.step();
    if (cpu.pc === isr && c === 12) dispatched = total;
    total += c;
  }
  eq('OCI dispatched', cpu.pc, isr);
  eq('OCI fires just past OC=$60', dispatched >= 0x60 && dispatched <= 0x63, true);
  eq('OCI masks I', (cpu.cc & I) !== 0, true);
  eq('OCI pushed frame', cpu.sp, 0x1f00 - 7);
  cpu.step(); // LDAA $08
  eq('TCSR shows OCF|EOCI', cpu.a, 0x48);
  cpu.step(); // LDAB $0B
  cpu.step(); // STAB $0B (write after TCSR read clears OCF)
  cpu.step(); // LDAB $08
  eq('OCF cleared by TCSR-read + OCR-write', cpu.b, 0x08);
}
{
  // OCF flag must NOT dispatch when EOCI clear: set OC small, no EOCI, run past
  const { cpu } = makeCpu([0xcc, 0x00, 0x20, 0xdd, 0x0b, 0x0e, 0x20, 0xfe]);
  cpu.cc = I;
  for (let i = 0; i < 30; i++) cpu.step();
  eq('no OCI without EOCI (still looping)', cpu.pc >= ORG + 5 && cpu.pc <= ORG + 8, true);
}

section('timer overflow: TOF, TOI vector');
{
  // LDAA #$04 (ETOI) / STAA $08 / CLI / STAA $09 (CT=$FFF8) / BRA *
  const prog = [0x86, 0x04, 0x97, 0x08, 0x0e, 0x97, 0x09, 0x20, 0xfe];
  const { cpu, bus } = makeCpu(prog);
  const isr = 0x5100;
  bus.mem[0xfff2] = isr >> 8;
  bus.mem[0xfff3] = isr & 0xff;
  // ISR: LDAA $08 / LDAB $09 (clears TOF after TCSR read) / LDAB $08
  bus.mem.set([0x96, 0x08, 0xd6, 0x09, 0xd6, 0x08], isr);
  cpu.cc = I;
  let dispatched = false;
  for (let i = 0; i < 50 && !dispatched; i++) {
    const c = cpu.step();
    if (cpu.pc === isr && c === 12) dispatched = true;
  }
  eq('TOI dispatched', cpu.pc, isr);
  cpu.step();
  eq('TCSR shows TOF (and OCF from $FFFF compare) + ETOI', cpu.a, 0x64);
  cpu.step(); // counter-high read clears TOF
  cpu.step();
  eq('TOF cleared by TCSR-read + counter-read', cpu.b, 0x44);
}

section('OLVL output to P21 on compare');
{
  const p2log: number[] = [];
  const prog = [
    0x86, 0x02, 0x97, 0x01, // LDAA #$02 / STAA $01 (DDR2 bit1 out)
    0x4f, 0x97, 0x03,       // CLRA / STAA $03 (P2 latch = 0)
    0x86, 0x09, 0x97, 0x08, // LDAA #$09 / STAA $08 (OLVL | EOCI)
    0xcc, 0x00, 0x30, 0xdd, 0x0b, // LDD #$30 / STD $0B
    0x20, 0xfe,             // BRA *
  ];
  const { cpu, bus } = makeCpu(prog, { p2Write: (v) => p2log.push(v) });
  bus.mem[0xfff4] = 0x51;
  bus.mem[0xfff5] = 0x00;
  bus.mem[0x5100] = 0x20; // BRA *
  bus.mem[0x5101] = 0xfe;
  cpu.cc = I;
  for (let i = 0; i < 40; i++) cpu.step();
  eq('P2 written before compare', p2log[0], 0x1d); // (0 & 2) | ~2, 5 bits
  eq('P21 = OLVL after compare', p2log[p2log.length - 1], 0x1f);
}

// ================================================================ 14. ports

section('port 1/2 registers and callbacks');
{
  const p1log: number[] = [];
  const { cpu } = makeCpu(
    [0x86, 0xff, 0x97, 0x00, 0x86, 0x5a, 0x97, 0x02, 0x96, 0x00],
    { p1Write: (v) => p1log.push(v) },
  );
  cpu.step();
  cpu.step(); // DDR1=FF -> callback with current latch (0)
  eq('DDR write fires callback', p1log[0], 0x00);
  cpu.step();
  cpu.step(); // P1 = $5A
  eq('P1 data write value', p1log[1], 0x5a);
  cpu.step(); // LDAA $00: DDR reads as $FF
  eq('DDR1 reads as $FF', cpu.a, 0xff);
}
{
  let reads = 0;
  const { cpu } = makeCpu(
    [0x86, 0x0f, 0x97, 0x00, 0x86, 0x05, 0x97, 0x02, 0x96, 0x02],
    {
      p1Read: () => {
        reads++;
        return 0xa0;
      },
    },
  );
  cpu.step();
  cpu.step(); // DDR1 = $0F
  cpu.step();
  cpu.step(); // P1 latch = $05
  cpu.step(); // LDAA $02
  eq('P1 read mixes input and latch per DDR', cpu.a, 0xa5);
  eq('P1 input callback used', reads >= 1, true);
}
{
  let reads = 0;
  const { cpu } = makeCpu(
    [0x86, 0xff, 0x97, 0x00, 0x86, 0x77, 0x97, 0x02, 0x96, 0x02],
    {
      p1Read: () => {
        reads++;
        return 0x00;
      },
    },
  );
  for (let i = 0; i < 5; i++) cpu.step();
  eq('P1 read with DDR=$FF returns latch', cpu.a, 0x77);
  eq('P1 input not sampled when all-output', reads, 0);
}
{
  const p2log: number[] = [];
  const { cpu } = makeCpu(
    [0x86, 0x1f, 0x97, 0x01, 0x86, 0x15, 0x97, 0x03],
    { p2Write: (v) => p2log.push(v) },
  );
  for (let i = 0; i < 4; i++) cpu.step();
  eq('P2 all-output write (5-bit)', p2log[p2log.length - 1], 0x15);
}
{
  const { cpu } = makeCpu(
    [0x86, 0x03, 0x97, 0x01, 0x86, 0x15, 0x97, 0x03, 0x96, 0x03],
    { p2Read: () => 0x1c },
  );
  for (let i = 0; i < 5; i++) cpu.step();
  eq('P2 read mixes input and latch per DDR', cpu.a, 0x1d);
}
{
  const { cpu } = makeCpu([0x96, 0x02, 0xd6, 0x03]); // no callbacks: pull-ups
  cpu.step();
  eq('P1 default input reads $FF', cpu.a, 0xff);
  cpu.step();
  eq('P2 default input reads $FF', cpu.b, 0xff);
}

// ================================================================ 15. internal map

section('internal RAM $80-$FF and register fallthrough $15-$7F');
{
  const { cpu, bus } = makeCpu([
    0x86, 0xa5, 0x97, 0x80, // STAA $80
    0x97, 0xff,             // STAA $FF
    0xd6, 0x80,             // LDAB $80
    0x96, 0x20,             // LDAA $20 (external!)
    0x97, 0x15,             // STAA $15 (external!)
  ]);
  bus.mem[0x0020] = 0x99;
  cpu.step();
  cpu.step();
  cpu.step();
  cpu.step();
  eq('internal RAM roundtrip', cpu.b, 0xa5);
  cpu.step();
  eq('$20 falls through to bus', cpu.a, 0x99);
  cpu.step();
  eq('$15 write reaches bus', bus.mem[0x0015], 0x99);
  eq('no bus writes in $80-$FF', bus.lowWrites.filter((a) => a >= 0x80).length, 0);
  eq('no bus reads in $00-$14', bus.lowReads.filter((a) => a <= 0x14).length, 0);
  eq('bus saw the $15-$7F accesses', bus.lowReads.includes(0x20) && bus.lowWrites.includes(0x15), true);
}
{
  const { cpu, bus } = makeCpu([0xce, 0x00, 0x80, 0x86, 0x7b, 0xa7, 0x05, 0xe6, 0x05]); // LDX #$80 / STAA 5,X / LDAB 5,X
  cpu.step();
  cpu.step();
  cpu.step();
  cpu.step();
  eq('indexed access hits internal RAM', cpu.b, 0x7b);
  eq('indexed internal write kept off bus', bus.lowWrites.length, 0);
}
{
  const { cpu } = makeCpu([0x96, 0x14, 0x96, 0x13]); // RAM control, TDR read
  cpu.step();
  eq('RAM control reads with unused bits set', cpu.a, 0x7f); // $40 | $3F
  cpu.step();
  eq('TDR write-only reads $FF', cpu.a, 0xff);
}

// ================================================================ 16. SCI stub

section('SCI stub: TRCSR protocol, SCI interrupt');
{
  const { cpu } = makeCpu([0x96, 0x11, 0x86, 0x1f, 0x97, 0x11, 0x96, 0x11]);
  cpu.cc = I; // keep SCI masked while poking TRCSR
  cpu.step();
  eq('TRCSR reset value TDRE', cpu.a, 0x20);
  cpu.step();
  cpu.step(); // write $1F: only bits 0-4 writable
  cpu.step();
  eq('TRCSR upper bits read-only', cpu.a, 0x3f); // TDRE | $1F
}
{
  const { cpu, bus } = makeCpu([0x86, 0x04, 0x97, 0x11, 0x0e, 0x01, 0x01]); // enable TIE, CLI
  bus.mem[0xfff0] = 0x52;
  bus.mem[0xfff1] = 0x00;
  cpu.cc = I;
  cpu.step();
  cpu.step();
  cpu.step(); // CLI (shadow)
  cpu.step(); // shadow NOP
  cpu.step(); // SCI dispatch (TIE + TDRE)
  eq('SCI interrupt vector', cpu.pc, 0x5200);
}

// ================================================================ 17. cycle counts

section('cycle table spot checks (cycles_6803)');
{
  // [opcode, expected cycles, label]; operands are zero bytes (harmless)
  const cases: [number, number, string][] = [
    [0x01, 2, 'NOP'],
    [0x04, 3, 'LSRD'],
    [0x05, 3, 'ASLD'],
    [0x06, 2, 'TAP'],
    [0x07, 2, 'TPA'],
    [0x08, 3, 'INX'],
    [0x09, 3, 'DEX'],
    [0x0e, 2, 'CLI'],
    [0x0f, 2, 'SEI'],
    [0x10, 2, 'SBA'],
    [0x16, 2, 'TAB'],
    [0x19, 2, 'DAA'],
    [0x1b, 2, 'ABA'],
    [0x20, 3, 'BRA'],
    [0x21, 3, 'BRN'],
    [0x26, 3, 'BNE'],
    [0x30, 3, 'TSX'],
    [0x31, 3, 'INS'],
    [0x32, 4, 'PULA'],
    [0x34, 3, 'DES'],
    [0x35, 3, 'TXS'],
    [0x36, 3, 'PSHA'],
    [0x38, 5, 'PULX'],
    [0x39, 5, 'RTS'],
    [0x3a, 3, 'ABX'],
    [0x3b, 10, 'RTI'],
    [0x3c, 4, 'PSHX'],
    [0x3d, 10, 'MUL'],
    [0x3e, 9, 'WAI'],
    [0x3f, 12, 'SWI'],
    [0x40, 2, 'NEGA'],
    [0x53, 2, 'COMB'],
    [0x60, 6, 'NEG idx'],
    [0x6e, 3, 'JMP idx'],
    [0x70, 6, 'NEG ext'],
    [0x7e, 3, 'JMP ext'],
    [0x7f, 6, 'CLR ext'],
    [0x80, 2, 'SUBA #'],
    [0x83, 4, 'SUBD #'],
    [0x8c, 4, 'CPX #'],
    [0x8d, 6, 'BSR'],
    [0x8e, 3, 'LDS #'],
    [0x93, 5, 'SUBD dir'],
    [0x97, 3, 'STAA dir'],
    [0x9d, 5, 'JSR dir'],
    [0xa3, 6, 'SUBD idx'],
    [0xa6, 4, 'LDAA idx'],
    [0xad, 6, 'JSR idx'],
    [0xb6, 4, 'LDAA ext'],
    [0xbd, 6, 'JSR ext'],
    [0xc3, 4, 'ADDD #'],
    [0xcc, 3, 'LDD #'],
    [0xce, 3, 'LDX #'],
    [0xd3, 5, 'ADDD dir'],
    [0xdd, 4, 'STD dir'],
    [0xe3, 6, 'ADDD idx'],
    [0xec, 5, 'LDD idx'],
    [0xed, 5, 'STD idx'],
    [0xf3, 6, 'ADDD ext'],
    [0xfc, 5, 'LDD ext'],
    [0xff, 5, 'STX ext'],
  ];
  for (const [op, want, label] of cases) {
    const { cpu } = makeCpu([op, 0x00, 0x00]);
    eq(`${label} cycles`, cpu.step(), want);
  }
}
{
  // WAI wake and interrupt entry cycle costs already checked in section 12
  const { cpu } = makeCpu([0x24, 0x10]); // BCC taken: still 3 (6800 family fixed)
  eq('taken branch cycles', cpu.step(), 3);
}

// ================================================================ 18. illegal + immediate-store oddities

section('illegal opcodes and immediate stores');
{
  const { cpu } = makeCpu([0x00, 0x12]); // two illegal 1-byte slots
  cpu.a = 0x42;
  const c1 = cpu.step();
  eq('illegal $00 cycles (XX=4)', c1, 4);
  eq('illegal $00 advances 1 byte', cpu.pc, ORG + 1);
  eq('illegal leaves regs', cpu.a, 0x42);
  const c2 = cpu.step();
  eq('illegal $12 cycles', c2, 4);
  eq('illegal $12 advances 1 byte', cpu.pc, ORG + 2);
}
{
  const { cpu, bus } = makeCpu([0x87, 0x00, 0x01]); // STAA # (writes A over operand)
  cpu.a = 0x33;
  const c = cpu.step();
  eq('STAA # cycles', c, 2);
  eq('STAA # writes operand byte', bus.mem[ORG + 1], 0x33);
  eq('STAA # pc', cpu.pc, ORG + 2);
}
{
  const { cpu, bus } = makeCpu([0xcf, 0x00, 0x00, 0x01]); // STX #
  cpu.x = 0x1234;
  const c = cpu.step();
  eq('STX # cycles', c, 3);
  eq('STX # hi', bus.mem[ORG + 1], 0x12);
  eq('STX # lo', bus.mem[ORG + 2], 0x34);
  eq('STX # pc', cpu.pc, ORG + 3);
}

// ================================================================ 19. reset

section('reset behavior');
{
  const { cpu, bus } = makeCpu([0x01]);
  bus.mem[0xfffe] = 0x21;
  bus.mem[0xffff] = 0x00;
  cpu.a = 0x55;
  cpu.reset();
  eq('reset vector', cpu.pc, 0x2100);
  eq('reset cc = $D0', cpu.cc, 0xd0);
  eq('reset keeps A (only CC/peripherals reset)', cpu.a, 0x55);
  eq('reset clears halted', cpu.halted, false);
}
{
  // run() with the cycle budget: returns at least the request
  const { cpu } = makeCpu([0x20, 0xfe]); // BRA *
  const ran = cpu.run(100);
  eq('run() covers the budget', ran >= 100 && ran <= 102, true);
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
