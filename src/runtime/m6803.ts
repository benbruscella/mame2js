// Motorola MC6803 CPU emulator core for mame2js (Irem M52/M62 sound boards).
//
// Self-contained ES module: zero imports, zero runtime dependencies, no DOM.
// Instruction semantics, flag behavior, cycle counts and the on-chip
// peripheral model are ported from the MAME 6800/6801 family core
// (src/devices/cpu/m6800: m6800.cpp + 6800ops.hxx for the base ISA,
// m6801.cpp for the 6803 dispatch/cycle tables and the internal I/O block).
// The 6803 is a 6801 without internal ROM: 6800 base ISA plus the 6801
// extensions (ABX, ADDD/SUBD, ASLD/LSRD, LDD/STD, MUL, PSHX/PULX, BRN and
// 16-bit CPX with full NZVC), 128 bytes of internal RAM at $0080-$00FF and
// an internal register file at $0000-$0014.
//
// Covered:
//  - full documented 6803 instruction set (MAME's m6803_insn table),
//    including the "is this legal?" immediate stores STA/STB/STS/STD/STX #
//    that MAME keeps in the table (they write to the operand's address).
//    Illegal opcodes execute as a no-op consuming XX=4 cycles, like MAME's
//    illegl1 handlers (all 6803 illegal slots are 1-byte).
//  - cycle counts from MAME's cycles_6803 table (E-clock cycles; the board
//    divides the crystal by 4: 3.579545 MHz XTAL -> 894886 Hz E).
//  - interrupts: NMI (edge), IRQ1 (level, masked by CC.I), SWI, WAI (full
//    7-byte state push: PC, X, A, B, CC; wake costs 4 cycles instead of 12),
//    RTI; internal timer interrupts ICI/OCI/TOI ($FFF6/$FFF4/$FFF2) and SCI
//    ($FFF0) with MAME's priority order (NMI > IRQ1 > ICI > OCI > TOI > SCI).
//  - the TAP/CLI one-instruction interrupt shadow: like MAME, an interrupt
//    (even NMI) is not accepted until one more instruction has executed
//    after TAP, or after a CLI that actually cleared I.
//  - on-chip peripherals, checked against MAME's m6801_io/m6803_mem maps and
//    src/mame/shared/irem.cpp (m52_small_sound_map maps only the ADPCM /
//    IRQ-ack writes and ROM externally; ports 1/2, the timer and internal
//    RAM are all on-chip):
//      $00/$01 P1/P2 DDR (write; reads return $FF like MAME's ff_r)
//      $02/$03 P1/P2 data, routed to the M6803Ports callbacks with MAME's
//              DDR mixing ((in & ~ddr) | (data & ddr) on read; driven bits
//              plus pulled-up undriven bits on write; port 2 masked to 5
//              bits and P24 forced high while the serial TE bit is set)
//      $04-$07 P3/P4 DDR+data: latches only (no pins bonded out for the
//              Irem use; reads mix a pulled-up $FF input like MAME's devcb
//              default)
//      $08 TCSR, $09/$0A free-running counter (write: $09 latches the data
//              and forces the counter to $FFF8 -- real 6801 quirk -- and
//              $0A restores latch<<8|data), $0B/$0C output compare,
//              $0D/$0E input capture (capture edge itself not wired -- no
//              P20 TIN source on this board), with MAME's exact flag-clear
//              protocol (read TCSR arms clearing of TOF/OCF/ICF on the
//              subsequent counter read / OCR write / ICR read).
//      $0F P3CSR, $10 RMCR, $11 TRCSR, $12 RDR, $13 TDR, $14 RAM control.
//      $15-$7F fall through to the external bus (MAME's internal map ends
//              at $14), $80-$FF internal RAM.
//    The free-running counter advances every E cycle (including WAI idle
//    and interrupt-entry cycles); OCF/TOF fire exactly as in MAME's
//    check_timer_event, including the OLVL->P21 output when DDR2 bit 1 is
//    set. This timer is what paces the Irem sound program.
//
// Deliberate simplifications (documented deviations):
//  - Serial (SCI) data path is stubbed: the registers exist with MAME's
//    read/write side-effect protocol, and the SCI interrupt condition is
//    evaluated from TRCSR like MAME, but nothing is ever transmitted or
//    received and TDRE stays set (so polled serial code cannot deadlock).
//    Moon Patrol's sound board does not use the SCI.
//  - The input-capture edge input (P20/TIN) is not exposed; ICF can only be
//    observed if software never uses it (the M52 board has no TIN source).
//  - MAME's STBY/SLP (HD6301) features do not exist on the MC6803 and are
//    not modeled.

export interface M6803Bus {
  read(addr: number): number; // external read, addr 0..0xffff, returns 0..0xff
  write(addr: number, data: number): void;
}

export interface M6803Ports {
  /** Port 1 input (returns 0..0xff); missing callback reads as 0xff (pull-ups). */
  p1Read?: () => number;
  /** Port 1 output: value already mixed per DDR (undriven bits high). */
  p1Write?: (v: number) => void;
  p2Read?: () => number;
  /** Port 2 output: 5-bit value (bits 5-7 always clear), per MAME write_port2. */
  p2Write?: (v: number) => void;
}

// Condition-code bits (11HINZVC)
const CC_C = 0x01;
const CC_V = 0x02;
const CC_Z = 0x04;
const CC_N = 0x08;
const CC_I = 0x10;
const CC_H = 0x20;

// Vectors
const VEC_SCI = 0xfff0;
const VEC_TOI = 0xfff2;
const VEC_OCI = 0xfff4;
const VEC_ICI = 0xfff6;
const VEC_IRQ = 0xfff8;
const VEC_SWI = 0xfffa;
const VEC_NMI = 0xfffc;
const VEC_RESET = 0xfffe;

// TCSR bits
const TCSR_OLVL = 0x01;
const TCSR_ETOI = 0x04;
const TCSR_EOCI = 0x08;
const TCSR_EICI = 0x10;
const TCSR_TOF = 0x20;
const TCSR_OCF = 0x40;
const TCSR_ICF = 0x80;

// TRCSR bits
const TRCSR_RDRF = 0x80;
const TRCSR_ORFE = 0x40;
const TRCSR_TDRE = 0x20;
const TRCSR_RIE = 0x10;
const TRCSR_TIE = 0x04;
const TRCSR_TE = 0x02;

// MAME cycles_6803 (XX=4 for illegal opcodes)
// prettier-ignore
const CYCLES_6803: readonly number[] = [
  /*        0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f */
  /* 0 */   4, 2, 4, 4, 3, 3, 2, 2, 3, 3, 2, 2, 2, 2, 2, 2,
  /* 1 */   2, 2, 4, 4, 4, 4, 2, 2, 4, 2, 4, 2, 4, 4, 4, 4,
  /* 2 */   3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  /* 3 */   3, 3, 4, 4, 3, 3, 3, 3, 5, 5, 3, 10, 4, 10, 9, 12,
  /* 4 */   2, 4, 4, 2, 2, 4, 2, 2, 2, 2, 2, 4, 2, 2, 4, 2,
  /* 5 */   2, 4, 4, 2, 2, 4, 2, 2, 2, 2, 2, 4, 2, 2, 4, 2,
  /* 6 */   6, 4, 4, 6, 6, 4, 6, 6, 6, 6, 6, 4, 6, 6, 3, 6,
  /* 7 */   6, 4, 4, 6, 6, 4, 6, 6, 6, 6, 6, 4, 6, 6, 3, 6,
  /* 8 */   2, 2, 2, 4, 2, 2, 2, 2, 2, 2, 2, 2, 4, 6, 3, 3,
  /* 9 */   3, 3, 3, 5, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 4, 4,
  /* a */   4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 5, 5,
  /* b */   4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 5, 5,
  /* c */   2, 2, 2, 4, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4, 3, 3,
  /* d */   3, 3, 3, 5, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4,
  /* e */   4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  /* f */   4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
];

function sx8(v: number): number {
  return (v & 0x80) !== 0 ? v - 256 : v;
}

export class M6803 {
  // public registers (contract for boards/m52.ts)
  pc = 0;
  sp = 0;
  x = 0;
  a = 0;
  b = 0;
  cc = 0;
  halted = false; // parked in WAI

  private bus: M6803Bus;
  private ports: M6803Ports;
  private ram = new Uint8Array(0x80); // internal RAM $0080-$00FF

  private irqLine = false;
  private nmiPending = false;
  private waiState = false;
  private irqShadow = false; // TAP/CLI one-instruction interrupt delay
  private ea = 0;
  private cy = 0;

  // ---- on-chip peripheral state (per MAME m6801_cpu_device) ----
  private ddr1 = 0;
  private ddr2 = 0;
  private ddr3 = 0;
  private ddr4 = 0;
  private p1 = 0;
  private p2 = 0;
  private p3 = 0;
  private p4 = 0;
  private p3csr = 0;
  private port2Written = false;
  private tcsr = 0;
  private pendingTcsr = 0;
  // counter/ocd/tod are MAME's CTD/OCD/TOD: 32-bit extended values whose low
  // 16 bits are the architectural registers; the high word makes ">= next
  // event" comparisons monotonic. cleanupCounters() renormalizes.
  private counter = 0;
  private ocd = 0xffff;
  private tod = 0xffff;
  private timerNext = 0xffff;
  private latch09 = 0;
  private inputCapture = 0;
  private ramCtrl = 0;
  // SCI stub registers
  private trcsr = TRCSR_TDRE;
  private rmcr = 0;
  private rdr = 0;
  private tdr = 0;
  private trcsrReadOrfe = false;
  private trcsrReadRdrf = false;

  constructor(bus: M6803Bus, ports?: M6803Ports) {
    this.bus = bus;
    this.ports = ports ?? {};
    this.reset();
  }

  /** Hardware reset: CC=$D0 (I set), on-chip peripherals reset, PC from $FFFE/F. */
  reset(): void {
    this.cc = 0xc0 | CC_I;
    this.waiState = false;
    this.halted = false;
    this.nmiPending = false;
    this.irqShadow = false;

    this.ddr1 = this.ddr2 = this.ddr3 = this.ddr4 = 0;
    this.p3csr = 0;
    this.port2Written = false;
    this.tcsr = 0;
    this.pendingTcsr = 0;
    this.counter = 0;
    this.ocd = 0xffff;
    this.tod = 0xffff;
    this.timerNext = 0xffff;
    this.latch09 = 0;
    this.ramCtrl |= 0x40;
    this.trcsr = TRCSR_TDRE;
    this.trcsrReadOrfe = false;
    this.trcsrReadRdrf = false;

    this.pc = this.rd16(VEC_RESET);
  }

  /** Edge-triggered NMI pulse (call once per falling edge of the MSM5205 VCK inverter). */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Level-triggered IRQ1 line, masked by CC.I (the Irem soundlatch drives this). */
  setIrqLine(active: boolean): void {
    this.irqLine = active;
  }

  /** Execute one instruction (or accept an interrupt / idle one WAI cycle).
   *  Returns E-clock cycles consumed; the internal timer advances by them. */
  step(): number {
    this.cy = 0;

    if (this.irqShadow) {
      // TAP / CLI shadow: run exactly one instruction before sampling lines
      this.irqShadow = false;
    } else {
      const vec = this.pendingVector();
      if (vec !== 0) {
        if (vec === VEC_NMI) this.nmiPending = false;
        this.enterInterrupt(vec);
        this.tickCounter(this.cy);
        return this.cy;
      }
      if (this.waiState) {
        this.tickCounter(1); // timer keeps running while waiting
        return 1;
      }
    }

    const op = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.cy = CYCLES_6803[op];
    this.exec(op);
    this.tickCounter(this.cy);
    return this.cy;
  }

  /** step() until at least `cycles` are consumed; returns actual total. */
  run(cycles: number): number {
    this.cleanupCounters();
    let total = 0;
    while (total < cycles) total += this.step();
    return total;
  }

  // ------------------------------------------------------------ interrupts

  /** Priority per MAME check_irq_lines/check_irq2: NMI, IRQ1, ICI, OCI, TOI, SCI. */
  private pendingVector(): number {
    if (this.nmiPending) return VEC_NMI;
    if ((this.cc & CC_I) !== 0) return 0;
    if (this.irqLine) return VEC_IRQ;
    const t = this.tcsr;
    if ((t & (TCSR_EICI | TCSR_ICF)) === (TCSR_EICI | TCSR_ICF)) return VEC_ICI;
    if ((t & (TCSR_EOCI | TCSR_OCF)) === (TCSR_EOCI | TCSR_OCF)) return VEC_OCI;
    if ((t & (TCSR_ETOI | TCSR_TOF)) === (TCSR_ETOI | TCSR_TOF)) return VEC_TOI;
    const s = this.trcsr;
    if (
      (s & (TRCSR_RIE | TRCSR_RDRF)) === (TRCSR_RIE | TRCSR_RDRF) ||
      (s & (TRCSR_RIE | TRCSR_ORFE)) === (TRCSR_RIE | TRCSR_ORFE) ||
      (s & (TRCSR_TIE | TRCSR_TDRE)) === (TRCSR_TIE | TRCSR_TDRE)
    )
      return VEC_SCI;
    return 0;
  }

  /** MAME enter_interrupt: 12 cycles + 7-byte push, or 4 cycles from WAI. */
  private enterInterrupt(vec: number): void {
    if (this.waiState) {
      this.waiState = false;
      this.halted = false;
      this.cy += 4;
    } else {
      this.pushWord(this.pc);
      this.pushWord(this.x);
      this.pushByte(this.a);
      this.pushByte(this.b);
      this.pushByte(this.cc);
      this.cy += 12;
    }
    this.cc |= CC_I;
    this.pc = this.rd16(vec);
  }

  // ------------------------------------------------------------ bus + internal map

  /** Read with the on-chip hook: $00-$14 registers, $80-$FF RAM, rest external.
   *  ($15-$7F fall through to the bus, exactly like MAME's internal map.) */
  private rd(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x100) {
      if (addr <= 0x14) return this.ioRead(addr);
      if (addr >= 0x80) return this.ram[addr - 0x80];
    }
    return this.bus.read(addr) & 0xff;
  }

  private wr(addr: number, data: number): void {
    addr &= 0xffff;
    data &= 0xff;
    if (addr < 0x100) {
      if (addr <= 0x14) {
        this.ioWrite(addr, data);
        return;
      }
      if (addr >= 0x80) {
        this.ram[addr - 0x80] = data;
        return;
      }
    }
    this.bus.write(addr, data);
  }

  private rd16(addr: number): number {
    return (this.rd(addr) << 8) | this.rd(addr + 1);
  }

  private fetch(): number {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const hi = this.fetch();
    return (hi << 8) | this.fetch();
  }

  // ------------------------------------------------------------ stack

  private pushByte(v: number): void {
    this.wr(this.sp, v);
    this.sp = (this.sp - 1) & 0xffff;
  }

  private pushWord(v: number): void {
    this.wr(this.sp, v & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
  }

  private pullByte(): number {
    this.sp = (this.sp + 1) & 0xffff;
    return this.rd(this.sp);
  }

  private pullWord(): number {
    this.sp = (this.sp + 1) & 0xffff;
    let v = this.rd(this.sp) << 8;
    this.sp = (this.sp + 1) & 0xffff;
    v |= this.rd(this.sp);
    return v;
  }

  // ------------------------------------------------------------ flags

  private getD(): number {
    return (this.a << 8) | this.b;
  }

  private setD(v: number): void {
    this.a = (v >> 8) & 0xff;
    this.b = v & 0xff;
  }

  /** N (bit set) | Z (zero) bits for an 8-bit value. */
  private nzBits8(v: number): number {
    return ((v & 0x80) >> 4) | ((v & 0xff) === 0 ? CC_Z : 0);
  }

  /** CLR_NZV; SET_NZ8 -- for loads/stores/logic. Returns v & 0xff. */
  private nz8(v: number): number {
    this.cc = (this.cc & 0xf1) | this.nzBits8(v);
    return v & 0xff;
  }

  /** CLR_NZV; SET_NZ16. Returns v & 0xffff. */
  private nz16(v: number): number {
    v &= 0xffff;
    this.cc = (this.cc & 0xf1) | ((v & 0x8000) >> 12) | (v === 0 ? CC_Z : 0);
    return v;
  }

  /** CLR_NZVC; SET_FLAGS8(a,b,r) -- 8-bit add/sub NZVC. Returns r & 0xff.
   *  r may be any int; JS bitwise ops reproduce MAME's u16 wraparound. */
  private flags8(a: number, b: number, r: number): number {
    let cc = this.cc & 0xf0;
    cc |= this.nzBits8(r);
    cc |= ((a ^ b ^ r ^ (r >> 1)) & 0x80) >> 6; // V
    cc |= (r & 0x100) >> 8; // C
    this.cc = cc;
    return r & 0xff;
  }

  /** CLR_HNZVC; SET_FLAGS8 + SET_H -- for ADD/ADC/ABA. */
  private flags8h(a: number, b: number, r: number): number {
    let cc = this.cc & 0xd0;
    cc |= ((a ^ b ^ r) & 0x10) << 1; // H
    cc |= this.nzBits8(r);
    cc |= ((a ^ b ^ r ^ (r >> 1)) & 0x80) >> 6;
    cc |= (r & 0x100) >> 8;
    this.cc = cc;
    return r & 0xff;
  }

  /** CLR_NZVC; SET_FLAGS16 -- 16-bit add/sub NZVC (ADDD/SUBD/CPX/ASLD). */
  private flags16(a: number, b: number, r: number): number {
    let cc = this.cc & 0xf0;
    if ((r & 0xffff) === 0) cc |= CC_Z;
    cc |= (r & 0x8000) >> 12;
    cc |= ((a ^ b ^ r ^ (r >> 1)) & 0x8000) >> 14;
    if ((r & 0x10000) !== 0) cc |= CC_C;
    this.cc = cc;
    return r & 0xffff;
  }

  // ------------------------------------------------------------ addressing

  /** Effective address for modes 1=direct, 2=indexed (X + u8), 3=extended. */
  private calcEA(mode: number): void {
    if (mode === 1) this.ea = this.fetch();
    else if (mode === 2) this.ea = (this.x + this.fetch()) & 0xffff;
    else this.ea = this.fetch16();
  }

  private rd8m(mode: number): number {
    if (mode === 0) return this.fetch();
    this.calcEA(mode);
    return this.rd(this.ea);
  }

  private rd16m(mode: number): number {
    if (mode === 0) return this.fetch16();
    this.calcEA(mode);
    return this.rd16(this.ea);
  }

  /** EA for 8-bit stores; immediate mode stores to the operand byte (MAME sta_im). */
  private stEA8(mode: number): void {
    if (mode === 0) {
      this.ea = this.pc;
      this.pc = (this.pc + 1) & 0xffff;
    } else this.calcEA(mode);
  }

  private stEA16(mode: number): void {
    if (mode === 0) {
      this.ea = this.pc;
      this.pc = (this.pc + 2) & 0xffff;
    } else this.calcEA(mode);
  }

  // ------------------------------------------------------------ dispatch

  private exec(op: number): void {
    switch (op >> 4) {
      case 0x0: this.exec0x(op); return;
      case 0x1: this.exec1x(op); return;
      case 0x2: this.branch(op & 0x0f); return;
      case 0x3: this.exec3x(op); return;
      case 0x4: this.rmwReg(op & 0x0f, false); return;
      case 0x5: this.rmwReg(op & 0x0f, true); return;
      case 0x6: this.rmwMem(op & 0x0f, true); return;
      case 0x7: this.rmwMem(op & 0x0f, false); return;
      default: this.colOp(op); return;
    }
  }

  private exec0x(op: number): void {
    switch (op) {
      case 0x01: return; // NOP
      case 0x04: { // LSRD: C=bit0, N cleared, V=N^C=C, Z from 16-bit result
        const t = this.getD();
        let cc = this.cc & 0xf0;
        cc |= t & 1;
        const r = t >> 1;
        if (r === 0) cc |= CC_Z;
        if ((((cc >> 3) ^ cc) & 1) !== 0) cc |= CC_V;
        this.cc = cc;
        this.setD(r);
        return;
      }
      case 0x05: { // ASLD
        const t = this.getD();
        this.setD(this.flags16(t, t, t << 1));
        return;
      }
      case 0x06: // TAP (blocks interrupts for one more instruction, as MAME)
        this.cc = this.a;
        this.irqShadow = true;
        return;
      case 0x07: this.a = this.cc; return; // TPA
      case 0x08: // INX: only Z
        this.x = (this.x + 1) & 0xffff;
        this.cc = (this.cc & ~CC_Z) | (this.x === 0 ? CC_Z : 0);
        return;
      case 0x09: // DEX: only Z
        this.x = (this.x - 1) & 0xffff;
        this.cc = (this.cc & ~CC_Z) | (this.x === 0 ? CC_Z : 0);
        return;
      case 0x0a: this.cc &= ~CC_V; return; // CLV
      case 0x0b: this.cc |= CC_V; return; // SEV
      case 0x0c: this.cc &= ~CC_C; return; // CLC
      case 0x0d: this.cc |= CC_C; return; // SEC
      case 0x0e: { // CLI: pending IRQ not taken until next instruction (MAME)
        const wasSet = (this.cc & CC_I) !== 0;
        this.cc &= ~CC_I;
        if (wasSet) this.irqShadow = true;
        return;
      }
      case 0x0f: this.cc |= CC_I; return; // SEI
      default: return; // $00/$02/$03 illegal
    }
  }

  private exec1x(op: number): void {
    switch (op) {
      case 0x10: this.a = this.flags8(this.a, this.b, this.a - this.b); return; // SBA
      case 0x11: this.flags8(this.a, this.b, this.a - this.b); return; // CBA
      case 0x16: this.b = this.nz8(this.a); return; // TAB
      case 0x17: this.a = this.nz8(this.b); return; // TBA
      case 0x19: this.daa(); return;
      case 0x1b: this.a = this.flags8h(this.a, this.b, this.a + this.b); return; // ABA
      default: return; // illegal
    }
  }

  private exec3x(op: number): void {
    switch (op) {
      case 0x30: this.x = (this.sp + 1) & 0xffff; return; // TSX
      case 0x31: this.sp = (this.sp + 1) & 0xffff; return; // INS
      case 0x32: this.a = this.pullByte(); return; // PULA
      case 0x33: this.b = this.pullByte(); return; // PULB
      case 0x34: this.sp = (this.sp - 1) & 0xffff; return; // DES
      case 0x35: this.sp = (this.x - 1) & 0xffff; return; // TXS
      case 0x36: this.pushByte(this.a); return; // PSHA
      case 0x37: this.pushByte(this.b); return; // PSHB
      case 0x38: this.x = this.pullWord(); return; // PULX (6801)
      case 0x39: this.pc = this.pullWord(); return; // RTS
      case 0x3a: this.x = (this.x + this.b) & 0xffff; return; // ABX (6801, no flags)
      case 0x3b: // RTI: pull CC, B, A, X, PC
        this.cc = this.pullByte();
        this.b = this.pullByte();
        this.a = this.pullByte();
        this.x = this.pullWord();
        this.pc = this.pullWord();
        return;
      case 0x3c: this.pushWord(this.x); return; // PSHX (6801)
      case 0x3d: { // MUL (6801): D=A*B, only C affected (= bit 7 of low byte)
        const t = this.a * this.b;
        this.cc = (this.cc & ~CC_C) | ((t & 0x80) !== 0 ? CC_C : 0);
        this.setD(t);
        return;
      }
      case 0x3e: // WAI: push entire state, wait for interrupt
        this.pushWord(this.pc);
        this.pushWord(this.x);
        this.pushByte(this.a);
        this.pushByte(this.b);
        this.pushByte(this.cc);
        this.waiState = true;
        this.halted = true;
        return;
      case 0x3f: // SWI
        this.pushWord(this.pc);
        this.pushWord(this.x);
        this.pushByte(this.a);
        this.pushByte(this.b);
        this.pushByte(this.cc);
        this.cc |= CC_I;
        this.pc = this.rd16(VEC_SWI);
        return;
      default: return; // $38.. none illegal in this row for 6803 except none
    }
  }

  // ------------------------------------------------------------ RMW group

  /** Single-operand ALU ops shared by register and memory forms.
   *  sub: 0=NEG 3=COM 4=LSR 6=ROR 7=ASR 8=ASL 9=ROL a=DEC c=INC. */
  private alu1(sub: number, m: number): number {
    switch (sub) {
      case 0x0: return this.flags8(0, m, -m); // NEG
      case 0x3: { // COM: C set, V cleared
        const r = ~m & 0xff;
        this.cc = (this.cc & 0xf1) | this.nzBits8(r) | CC_C;
        return r;
      }
      case 0x4: { // LSR: C=bit0, N cleared, V=N^C
        let cc = this.cc & 0xf0;
        cc |= m & 1;
        const r = m >> 1;
        if (r === 0) cc |= CC_Z;
        if ((((cc >> 3) ^ cc) & 1) !== 0) cc |= CC_V;
        this.cc = cc;
        return r;
      }
      case 0x6: { // ROR through carry; V=N^C
        const r = ((this.cc & 1) << 7) | (m >> 1);
        let cc = (this.cc & 0xf0) | (m & 1) | this.nzBits8(r);
        if ((((cc >> 3) ^ cc) & 1) !== 0) cc |= CC_V;
        this.cc = cc;
        return r;
      }
      case 0x7: { // ASR: sign preserved, C=bit0, V=N^C
        const r = (m >> 1) | (m & 0x80);
        let cc = (this.cc & 0xf0) | (m & 1) | this.nzBits8(r);
        if ((((cc >> 3) ^ cc) & 1) !== 0) cc |= CC_V;
        this.cc = cc;
        return r;
      }
      case 0x8: return this.flags8(m, m, m << 1); // ASL: V=b7^b6, C=old b7
      case 0x9: return this.flags8(m, m, (m << 1) | (this.cc & 1)); // ROL
      case 0xa: { // DEC: V at $80->$7F, C untouched
        const r = (m - 1) & 0xff;
        this.cc = (this.cc & 0xf1) | this.nzBits8(r) | (r === 0x7f ? CC_V : 0);
        return r;
      }
      default: { // 0xc INC: V at $7F->$80, C untouched
        const r = (m + 1) & 0xff;
        this.cc = (this.cc & 0xf1) | this.nzBits8(r) | (r === 0x80 ? CC_V : 0);
        return r;
      }
    }
  }

  private static rmwLegal(sub: number): boolean {
    return sub !== 0x1 && sub !== 0x2 && sub !== 0x5 && sub !== 0xb;
  }

  private rmwReg(sub: number, isB: boolean): void {
    if (!M6803.rmwLegal(sub) || sub === 0xe) return; // illegal (incl. $4E/$5E)
    const v = isB ? this.b : this.a;
    let r: number;
    if (sub === 0xd) { // TST: NZ, V+C cleared
      this.cc = (this.cc & 0xf0) | this.nzBits8(v);
      return;
    } else if (sub === 0xf) { // CLR
      this.cc = (this.cc & 0xf0) | CC_Z;
      r = 0;
    } else {
      r = this.alu1(sub, v);
    }
    if (isB) this.b = r;
    else this.a = r;
  }

  private rmwMem(sub: number, indexed: boolean): void {
    if (!M6803.rmwLegal(sub)) return; // illegal slots are 1-byte no-ops (MAME illegl1)
    const ea = indexed ? (this.x + this.fetch()) & 0xffff : this.fetch16();
    if (sub === 0xe) { // JMP
      this.pc = ea;
      return;
    }
    if (sub === 0xf) { // CLR: real dead read before the write (bus side effects match MAME)
      this.rd(ea);
      this.wr(ea, 0);
      this.cc = (this.cc & 0xf0) | CC_Z;
      return;
    }
    const m = this.rd(ea);
    if (sub === 0xd) { // TST: NZ, V+C cleared, no write-back
      this.cc = (this.cc & 0xf0) | this.nzBits8(m);
      return;
    }
    this.wr(ea, this.alu1(sub, m));
  }

  // ------------------------------------------------------------ $80-$FF columns

  private colOp(op: number): void {
    const rowB = op >= 0xc0;
    const mode = (op >> 4) & 3; // 0=imm 1=dir 2=idx 3=ext
    const sub = op & 0x0f;
    switch (sub) {
      case 0x3: { // SUBD (rows 8-B) / ADDD (rows C-F)
        const m = this.rd16m(mode);
        const d = this.getD();
        this.setD(this.flags16(d, m, rowB ? d + m : d - m));
        return;
      }
      case 0x7: { // STA/STB (immediate form writes A/B over the operand byte)
        const v = rowB ? this.b : this.a;
        this.cc = (this.cc & 0xf1) | this.nzBits8(v);
        this.stEA8(mode);
        this.wr(this.ea, v);
        return;
      }
      case 0xc:
        if (rowB) this.setD(this.nz16(this.rd16m(mode))); // LDD
        else { // CPX with 6801 semantics: full 16-bit NZVC
          const m = this.rd16m(mode);
          this.flags16(this.x, m, this.x - m);
        }
        return;
      case 0xd:
        if (rowB) { // STD
          this.stEA16(mode);
          this.nz16(this.getD());
          this.wr(this.ea, this.a);
          this.wr(this.ea + 1, this.b);
        } else if (mode === 0) { // BSR
          const t = this.fetch();
          this.pushWord(this.pc);
          this.pc = (this.pc + sx8(t)) & 0xffff;
        } else { // JSR
          this.calcEA(mode);
          this.pushWord(this.pc);
          this.pc = this.ea;
        }
        return;
      case 0xe: { // LDS / LDX
        const v = this.nz16(this.rd16m(mode));
        if (rowB) this.x = v;
        else this.sp = v;
        return;
      }
      case 0xf: { // STS / STX
        const v = rowB ? this.x : this.sp;
        this.nz16(v);
        this.stEA16(mode);
        this.wr(this.ea, v >> 8);
        this.wr(this.ea + 1, v & 0xff);
        return;
      }
      default: { // two-operand 8-bit ALU on A (rows 8-B) or B (rows C-F)
        const reg = rowB ? this.b : this.a;
        const m = this.rd8m(mode);
        let v: number;
        switch (sub) {
          case 0x0: v = this.flags8(reg, m, reg - m); break; // SUB
          case 0x1: this.flags8(reg, m, reg - m); return; // CMP
          case 0x2: v = this.flags8(reg, m, reg - m - (this.cc & CC_C)); break; // SBC
          case 0x4: v = this.nz8(reg & m); break; // AND
          case 0x5: this.nz8(reg & m); return; // BIT
          case 0x6: v = this.nz8(m); break; // LD
          case 0x8: v = this.nz8(reg ^ m); break; // EOR
          case 0x9: v = this.flags8h(reg, m, reg + m + (this.cc & CC_C)); break; // ADC
          case 0xa: v = this.nz8(reg | m); break; // OR
          default: v = this.flags8h(reg, m, reg + m); break; // 0xb ADD
        }
        if (rowB) this.b = v;
        else this.a = v;
        return;
      }
    }
  }

  // ------------------------------------------------------------ control flow

  private branch(idx: number): void {
    const t = this.fetch();
    if (this.cond(idx)) this.pc = (this.pc + sx8(t)) & 0xffff;
  }

  private cond(idx: number): boolean {
    const cc = this.cc;
    const nxorv = ((cc & CC_N) !== 0) !== ((cc & CC_V) !== 0);
    switch (idx) {
      case 0x0: return true; // BRA
      case 0x1: return false; // BRN
      case 0x2: return (cc & (CC_C | CC_Z)) === 0; // BHI
      case 0x3: return (cc & (CC_C | CC_Z)) !== 0; // BLS
      case 0x4: return (cc & CC_C) === 0; // BCC
      case 0x5: return (cc & CC_C) !== 0; // BCS
      case 0x6: return (cc & CC_Z) === 0; // BNE
      case 0x7: return (cc & CC_Z) !== 0; // BEQ
      case 0x8: return (cc & CC_V) === 0; // BVC
      case 0x9: return (cc & CC_V) !== 0; // BVS
      case 0xa: return (cc & CC_N) === 0; // BPL
      case 0xb: return (cc & CC_N) !== 0; // BMI
      case 0xc: return !nxorv; // BGE
      case 0xd: return nxorv; // BLT
      case 0xe: return !(nxorv || (cc & CC_Z) !== 0); // BGT
      default: return nxorv || (cc & CC_Z) !== 0; // BLE
    }
  }

  private daa(): void {
    const msn = this.a & 0xf0;
    const lsn = this.a & 0x0f;
    let cf = 0;
    if (lsn > 0x09 || (this.cc & CC_H) !== 0) cf |= 0x06;
    if (msn > 0x80 && lsn > 0x09) cf |= 0x60;
    if (msn > 0x90 || (this.cc & CC_C) !== 0) cf |= 0x60;
    const t = this.a + cf;
    // CLR_NZV then NZ from result; C is kept from the previous op and may
    // additionally be set (never cleared) -- per MAME/hardware. H unchanged.
    this.cc = (this.cc & 0xf1) | this.nzBits8(t) | ((t & 0x100) >> 8);
    this.a = t & 0xff;
  }

  // ------------------------------------------------------------ timer (MAME m6801 free-running counter)

  /** Advance the free-running counter; fires OCF/TOF exactly like MAME's
   *  increment_counter -> check_timer_event. */
  private tickCounter(cycles: number): void {
    this.counter = (this.counter + cycles) >>> 0;
    if (this.counter >= this.timerNext) this.timerEvent();
  }

  private timerEvent(): void {
    if (this.counter >= this.ocd) {
      this.ocd = (this.ocd + 0x10000) >>> 0; // next compare point (OCH++)
      this.tcsr |= TCSR_OCF;
      this.pendingTcsr |= TCSR_OCF;
      if ((this.ddr2 & 0x02) !== 0) { // OLVL to P21 when configured as output
        this.p2 = (this.p2 & ~0x02) | ((this.tcsr & TCSR_OLVL) << 1);
        this.port2Written = true;
        this.writePort2();
      }
    }
    if (this.counter >= this.tod) {
      this.tod = (this.tod + 0x10000) >>> 0; // TOH++
      this.tcsr |= TCSR_TOF;
      this.pendingTcsr |= TCSR_TOF;
    }
    this.timerNext = Math.min(this.ocd, this.tod);
  }

  /** MAME modified_counters: rebase the compare high word after CT/OC writes. */
  private modifiedCounters(): void {
    const ct = this.counter & 0xffff;
    const cth = this.counter >>> 16;
    const oc = this.ocd & 0xffff;
    const och = (oc >= ct ? cth : cth + 1) & 0xffff;
    this.ocd = (och * 0x10000 + oc) >>> 0;
    this.timerNext = Math.min(this.ocd, this.tod);
  }

  /** MAME cleanup_counters: renormalize the 32-bit extensions (called from run()). */
  private cleanupCounters(): void {
    const cth = this.counter >>> 16;
    if (cth === 0) return;
    const rebase = (v: number): number =>
      (((((v >>> 16) - cth) & 0xffff) * 0x10000) + (v & 0xffff)) >>> 0;
    this.ocd = rebase(this.ocd);
    this.tod = rebase(this.tod);
    this.counter &= 0xffff;
    this.timerNext = Math.min(this.ocd, this.tod);
    if (this.counter >= this.timerNext) this.timerEvent();
  }

  // ------------------------------------------------------------ internal register file

  private ioRead(addr: number): number {
    switch (addr) {
      case 0x00: case 0x01: case 0x04: case 0x05:
        return 0xff; // DDRs read as $FF (MAME ff_r)
      case 0x02: { // P1 data
        const ddr = this.ddr1;
        if (ddr === 0xff) return this.p1;
        const ext = this.ports.p1Read !== undefined ? this.ports.p1Read() & 0xff : 0xff;
        return (ext & ~ddr & 0xff) | (this.p1 & ddr);
      }
      case 0x03: { // P2 data
        const ddr = this.ddr2;
        if (ddr === 0xff) return this.p2;
        const ext = this.ports.p2Read !== undefined ? this.ports.p2Read() & 0xff : 0xff;
        return (ext & ~ddr & 0xff) | (this.p2 & ddr);
      }
      case 0x06: { // P3 data (stub port: pull-ups on the input side)
        const ddr = this.ddr3;
        if (ddr === 0xff) return this.p3;
        return (0xff & ~ddr & 0xff) | (this.p3 & ddr);
      }
      case 0x07: {
        const ddr = this.ddr4;
        if (ddr === 0xff) return this.p4;
        return (0xff & ~ddr & 0xff) | (this.p4 & ddr);
      }
      case 0x08: { // TCSR: read arms the flag-clear protocol
        this.pendingTcsr = 0;
        return this.tcsr;
      }
      case 0x09: // counter high; clears TOF if TCSR was read since it was set
        if ((this.pendingTcsr & TCSR_TOF) === 0) this.tcsr &= ~TCSR_TOF;
        return (this.counter >>> 8) & 0xff;
      case 0x0a:
        return this.counter & 0xff;
      case 0x0b:
        return (this.ocd >>> 8) & 0xff;
      case 0x0c:
        return this.ocd & 0xff;
      case 0x0d: // input capture high; clears ICF per protocol
        if ((this.pendingTcsr & TCSR_ICF) === 0) this.tcsr &= ~TCSR_ICF;
        return (this.inputCapture >> 8) & 0xff;
      case 0x0e:
        return this.inputCapture & 0xff;
      case 0x0f:
        return this.p3csr;
      case 0x10:
        return this.rmcr;
      case 0x11: // TRCSR read arms RDR-read clearing of ORFE/RDRF
        if ((this.trcsr & TRCSR_ORFE) !== 0) this.trcsrReadOrfe = true;
        if ((this.trcsr & TRCSR_RDRF) !== 0) this.trcsrReadRdrf = true;
        return this.trcsr;
      case 0x12: // RDR
        if (this.trcsrReadOrfe) {
          this.trcsrReadOrfe = false;
          this.trcsr &= ~TRCSR_ORFE;
        }
        if (this.trcsrReadRdrf) {
          this.trcsrReadRdrf = false;
          this.trcsr &= ~TRCSR_RDRF;
        }
        return this.rdr;
      case 0x13:
        return 0xff; // TDR is write-only in MAME's map
      default: // 0x14 RAM control
        return this.ramCtrl | 0x3f;
    }
  }

  private ioWrite(addr: number, data: number): void {
    switch (addr) {
      case 0x00: // P1 DDR
        if (this.ddr1 !== data) {
          this.ddr1 = data;
          this.callP1();
        }
        return;
      case 0x01: // P2 DDR
        if (this.ddr2 !== data) {
          this.ddr2 = data;
          this.writePort2();
        }
        return;
      case 0x02: // P1 data
        this.p1 = data;
        this.callP1();
        return;
      case 0x03: // P2 data
        this.p2 = data;
        this.port2Written = true;
        this.writePort2();
        return;
      case 0x04: this.ddr3 = data; return;
      case 0x05: this.ddr4 = data; return;
      case 0x06: this.p3 = data; return;
      case 0x07: this.p4 = data; return;
      case 0x08: // TCSR: bits 5-7 (flags) not writable
        this.tcsr = (data & 0x1f) | (this.tcsr & 0xe0);
        this.pendingTcsr &= this.tcsr;
        return;
      case 0x09: // counter high: latch data, force CT=$FFF8 (hardware quirk)
        this.latch09 = data;
        this.setCT(0xfff8);
        return;
      case 0x0a: // counter low: CT = latch<<8 | data
        this.setCT(((this.latch09 << 8) | data) & 0xffff);
        return;
      case 0x0b: { // OCR high; clears OCF if TCSR was read since it was set
        if ((this.pendingTcsr & TCSR_OCF) === 0) this.tcsr &= ~TCSR_OCF;
        const oc = this.ocd & 0xffff;
        if ((oc >> 8) !== data) {
          this.ocd = ((this.ocd & 0xffff0000) | (data << 8) | (oc & 0xff)) >>> 0;
          this.modifiedCounters();
        }
        return;
      }
      case 0x0c: { // OCR low
        if ((this.pendingTcsr & TCSR_OCF) === 0) this.tcsr &= ~TCSR_OCF;
        const oc = this.ocd & 0xffff;
        if ((oc & 0xff) !== data) {
          this.ocd = ((this.ocd & 0xffff0000) | (oc & 0xff00) | data) >>> 0;
          this.modifiedCounters();
        }
        return;
      }
      case 0x0f: this.p3csr = data; return;
      case 0x10: this.rmcr = data; return; // SCI rate/mode: stored only (SCI stubbed)
      case 0x11: // TRCSR: bits 5-7 read-only
        this.trcsr = (this.trcsr & 0xe0) | (data & 0x1f);
        return;
      case 0x13: // TDR: stored; TDRE deliberately stays set (no transmitter modeled)
        this.tdr = data;
        return;
      case 0x14: this.ramCtrl = data; return;
      default: return; // $0D/$0E ICR read-only, $12 RDR read-only
    }
  }

  /** MAME ch_w/cl_w tail: set CT, TOH=CTH, modified_counters. */
  private setCT(ct: number): void {
    this.counter = (((this.counter >>> 16) * 0x10000) + ct) >>> 0;
    this.tod = (((this.counter >>> 16) * 0x10000) + 0xffff) >>> 0;
    this.modifiedCounters();
  }

  private callP1(): void {
    if (this.ports.p1Write !== undefined) {
      this.ports.p1Write(((this.p1 & this.ddr1) | (this.ddr1 ^ 0xff)) & 0xff);
    }
  }

  /** MAME write_port2: 5-bit port, undriven bits pulled high, P24=TX when TE. */
  private writePort2(): void {
    if (!this.port2Written) return;
    let data = this.p2;
    const ddr = this.ddr2 & 0x1f;
    if (ddr !== 0x1f && ddr !== 0) data = (this.p2 & ddr) | (ddr ^ 0xff);
    if ((this.trcsr & TRCSR_TE) !== 0) data = (data & 0xef) | 0x10; // TX idles high
    data &= 0x1f;
    if (this.ports.p2Write !== undefined) this.ports.p2Write(data);
  }
}
