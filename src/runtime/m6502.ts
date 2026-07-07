// MOS 6502 (NMOS) CPU emulator core for mamekit.
//
// Self-contained ES module: zero imports, zero runtime dependencies, no DOM.
// Instruction semantics, flag behavior and cycle counts follow the MAME 6502
// core (src/devices/cpu/m6502 — om6502.lst is the readable per-cycle source;
// m6502.cpp is generated from it) and the NMOS behavior it encodes. Covers
// the full documented set plus the NMOS unofficial opcodes: LAX, SAX, DCP,
// ISB/ISC, SLO, RLA, SRE, RRA (all addressing modes), SBC $EB, ANC, ALR,
// ARR, AXS/SBX, LAS, the whole NOP family, and the JAM/KIL opcodes.
//
// The NES RP2A03 is this core with `{ bcd: false }`: the D flag is still
// set/cleared normally (SED/CLD/PLP/RTI) but ADC/SBC always compute binary.
// With BCD enabled, decimal ADC/SBC reproduce the NMOS quirks (Z from the
// binary sum, N/V from the intermediate high-nibble adjust).
//
// Deliberate simplifications vs. MAME (documented choices):
//  - Dummy bus reads/writes are not modeled (the indexed-addressing read at
//    the un-carried address, the RMW double-write, stack/operand dummy
//    fetches). Cycle counts still match the hardware tables, including the
//    +1 page-cross penalty on indexed reads and branch-taken penalties.
//  - Interrupt-recognition timing quirks are not modeled: CLI/SEI/PLP take
//    effect immediately for IRQ sampling (no one-instruction delay) and an
//    NMI cannot hijack an in-progress BRK/IRQ sequence. Interrupts are
//    sampled only at instruction boundaries (NMI edge before IRQ level).
//  - Unstable "high byte + 1" stores (SHA/SHX/SHY/TAS) use the stable model
//    value = reg & (EA_hi + 1) without the page-cross address corruption;
//    XAA/LXA use the common (A | 0xEE) magic-constant model; ARR's
//    decimal-mode fixup is not modeled (binary ARR always).
//  - JAM/KIL opcodes set `halted` and leave PC pointing at the jam opcode; a
//    jammed CPU ignores IRQ/NMI (like the real part) and step() returns 1
//    cycle per call until reset().
//  - reset() loads PC from $FFFC and forces S=$FD / P=I|U without replaying
//    the 7-cycle bus sequence; A/X/Y are preserved (as on real hardware).

export interface M6502Bus {
  read(addr: number): number; // memory read, addr 0..0xffff, returns 0..0xff
  write(addr: number, data: number): void;
}

// Flag bits (P register layout NV1BDIZC)
const FC = 0x01; // carry
const FZ = 0x02; // zero
const FI = 0x04; // IRQ disable
const FD = 0x08; // decimal
const FB = 0x10; // break (only ever set on pushed copies)
const FU = 0x20; // unused, always 1
const FV = 0x40; // overflow
const FN = 0x80; // negative

// Interrupt/reset vectors
const VEC_NMI = 0xfffa;
const VEC_RESET = 0xfffc;
const VEC_IRQ = 0xfffe; // also BRK

// Precomputed N/Z flag pairs for every 8-bit result
const NZ = new Uint8Array(256);
for (let i = 0; i < 256; i++) NZ[i] = (i & FN) | (i === 0 ? FZ : 0);

// Base cycles per opcode. Page-cross penalties (+1 on indexed reads) and
// branch penalties (+1 taken, +2 taken across a page) are added at runtime.
// prettier-ignore
const CYCLES = new Uint8Array([
  //0 1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
  7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6, // 0x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 1x
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6, // 2x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 3x
  6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6, // 4x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 5x
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6, // 6x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 7x
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // 8x
  2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5, // 9x
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // ax
  2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4, // bx
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // cx
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // dx
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // ex
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // fx
]);

export class M6502 {
  // public registers
  a = 0;
  x = 0;
  y = 0;
  s = 0xfd; // stack pointer (low byte; stack lives at $0100-$01FF)
  pc = 0;
  /** P register, NV1BDIZC. U (0x20) is always set and B (0x10) is never set
   *  in the live register — B only appears on bytes pushed by PHP/BRK. */
  p = FI | FU;
  halted = false; // parked on a JAM/KIL opcode; only reset() recovers
  /** count of IRQ vectors taken — lets boards model MAME's HOLD_LINE
   *  (deassert exactly when the interrupt is acknowledged) */
  irqCount = 0;

  private bus: M6502Bus;
  private bcd: boolean; // decimal mode implemented? (false on RP2A03/NES)
  private irqLine = false;
  private nmiPending = false;
  private extra = 0; // page-cross / branch penalty cycles for the current op

  constructor(bus: M6502Bus, opts?: { bcd?: boolean }) {
    this.bus = bus;
    this.bcd = opts?.bcd !== false;
    this.reset();
  }

  reset(): void {
    this.pc = this.rd(VEC_RESET) | (this.rd(VEC_RESET + 1) << 8);
    this.s = 0xfd;
    this.p = FI | FU;
    this.halted = false;
    this.nmiPending = false;
    // A/X/Y keep their values, like the real part.
  }

  /** Level-triggered maskable IRQ line (gated by the I flag). */
  setIrqLine(active: boolean): void {
    this.irqLine = active;
  }

  /** Edge-triggered NMI pulse; latched until the next step() boundary. */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Execute one instruction (or take a pending interrupt).
   *  Returns cycles consumed. */
  step(): number {
    if (this.halted) return 1;
    if (this.nmiPending) {
      this.nmiPending = false;
      return this.interrupt(VEC_NMI);
    }
    if (this.irqLine && (this.p & FI) === 0) {
      this.irqCount++;
      return this.interrupt(VEC_IRQ);
    }
    this.extra = 0;
    const op = this.fetch();
    this.exec(op);
    return CYCLES[op] + this.extra;
  }

  /** step() until at least `cycles` are consumed; returns actual total. */
  run(cycles: number): number {
    let total = 0;
    while (total < cycles) total += this.step();
    return total;
  }

  // ------------------------------------------------------------------ bus

  private rd(addr: number): number {
    return this.bus.read(addr & 0xffff) & 0xff;
  }

  private wr(addr: number, data: number): void {
    this.bus.write(addr & 0xffff, data & 0xff);
  }

  private fetch(): number {
    const v = this.bus.read(this.pc) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  private push(v: number): void {
    this.wr(0x100 | this.s, v);
    this.s = (this.s - 1) & 0xff;
  }

  private pull(): number {
    this.s = (this.s + 1) & 0xff;
    return this.rd(0x100 | this.s);
  }

  // -------------------------------------------------- effective addresses

  private zpx(): number {
    return (this.fetch() + this.x) & 0xff;
  }

  private zpy(): number {
    return (this.fetch() + this.y) & 0xff;
  }

  /** abs,X; pen=true adds the +1 read penalty when indexing crosses a page. */
  private absx(pen: boolean): number {
    const base = this.fetch16();
    const ea = (base + this.x) & 0xffff;
    if (pen && ((base ^ ea) & 0xff00) !== 0) this.extra++;
    return ea;
  }

  private absy(pen: boolean): number {
    const base = this.fetch16();
    const ea = (base + this.y) & 0xffff;
    if (pen && ((base ^ ea) & 0xff00) !== 0) this.extra++;
    return ea;
  }

  /** (zp,X): pointer wraps within the zero page, incl. its high byte. */
  private izx(): number {
    const z = (this.fetch() + this.x) & 0xff;
    return this.rd(z) | (this.rd((z + 1) & 0xff) << 8);
  }

  /** (zp),Y: pointer high byte comes from (zp+1)&0xFF. */
  private izy(pen: boolean): number {
    const z = this.fetch();
    const base = this.rd(z) | (this.rd((z + 1) & 0xff) << 8);
    const ea = (base + this.y) & 0xffff;
    if (pen && ((base ^ ea) & 0xff00) !== 0) this.extra++;
    return ea;
  }

  // ------------------------------------------------------------ operations

  /** Set N/Z from an 8-bit value, return it masked. */
  private nz(v: number): number {
    v &= 0xff;
    this.p = (this.p & ~(FN | FZ)) | NZ[v];
    return v;
  }

  private adc(m: number): void {
    const c = this.p & FC;
    if (this.bcd && (this.p & FD) !== 0) {
      // NMOS decimal ADC: Z from the binary sum, N/V from the value after
      // the low-nibble adjust, C from the final decimal adjust.
      let al = (this.a & 0x0f) + (m & 0x0f) + c;
      if (al >= 0x0a) al = ((al + 0x06) & 0x0f) + 0x10;
      let sum = (this.a & 0xf0) + (m & 0xf0) + al;
      let f = this.p & ~(FN | FV | FZ | FC);
      if (((this.a + m + c) & 0xff) === 0) f |= FZ;
      if ((sum & 0x80) !== 0) f |= FN;
      if ((~(this.a ^ m) & (this.a ^ sum) & 0x80) !== 0) f |= FV;
      if (sum >= 0xa0) sum += 0x60;
      if (sum >= 0x100) f |= FC;
      this.p = f;
      this.a = sum & 0xff;
    } else {
      const r = this.a + m + c;
      let f = this.p & ~(FN | FV | FZ | FC);
      if (r > 0xff) f |= FC;
      if ((~(this.a ^ m) & (this.a ^ r) & 0x80) !== 0) f |= FV;
      this.a = r & 0xff;
      this.p = f | NZ[this.a];
    }
  }

  private sbc(m: number): void {
    const c = (this.p & FC) !== 0 ? 0 : 1;
    const diff = this.a - m - c;
    // N/V/Z/C always come from the binary subtraction, even in decimal mode.
    let f = this.p & ~(FN | FV | FZ | FC);
    if (diff >= 0) f |= FC;
    if (((this.a ^ m) & (this.a ^ diff) & 0x80) !== 0) f |= FV;
    f |= NZ[diff & 0xff];
    if (this.bcd && (this.p & FD) !== 0) {
      let al = (this.a & 0x0f) - (m & 0x0f) - c;
      if (al < 0) al = ((al - 0x06) & 0x0f) - 0x10;
      let r = (this.a & 0xf0) - (m & 0xf0) + al;
      if (r < 0) r -= 0x60;
      this.a = r & 0xff;
    } else {
      this.a = diff & 0xff;
    }
    this.p = f;
  }

  private cp(reg: number, m: number): void {
    const d = reg - m;
    this.p = (this.p & ~(FN | FZ | FC)) | NZ[d & 0xff] | (d >= 0 ? FC : 0);
  }

  private bit(m: number): void {
    this.p =
      (this.p & ~(FN | FV | FZ)) | (m & (FN | FV)) | ((this.a & m) === 0 ? FZ : 0);
  }

  private asl(v: number): number {
    this.p = (this.p & ~FC) | ((v >> 7) & FC);
    return this.nz((v << 1) & 0xff);
  }

  private lsr(v: number): number {
    this.p = (this.p & ~FC) | (v & FC);
    return this.nz(v >> 1);
  }

  private rol(v: number): number {
    const c = this.p & FC;
    this.p = (this.p & ~FC) | ((v >> 7) & FC);
    return this.nz(((v << 1) | c) & 0xff);
  }

  private ror(v: number): number {
    const c = this.p & FC;
    this.p = (this.p & ~FC) | (v & FC);
    return this.nz((v >> 1) | (c << 7));
  }

  /** Conditional relative branch: +1 cycle taken, +2 if the target is on a
   *  different page than the instruction following the branch. */
  private br(taken: boolean): void {
    const off = this.fetch();
    if (!taken) return;
    this.extra++;
    const target = (this.pc + ((off & 0x80) !== 0 ? off - 256 : off)) & 0xffff;
    if (((target ^ this.pc) & 0xff00) !== 0) this.extra++;
    this.pc = target;
  }

  /** IRQ/NMI entry: push PC and P (B clear, U set), set I, load vector.
   *  7 cycles. */
  private interrupt(vector: number): number {
    this.push((this.pc >> 8) & 0xff);
    this.push(this.pc & 0xff);
    this.push((this.p & ~FB) | FU);
    this.p |= FI;
    this.pc = this.rd(vector) | (this.rd(vector + 1) << 8);
    return 7;
  }

  private jam(): void {
    this.pc = (this.pc - 1) & 0xffff; // stay parked on the jam opcode
    this.halted = true;
  }

  // -------------------------------------------------------------- dispatch

  private exec(op: number): void {
    switch (op) {
      // ---------------------------------------------------------- loads
      case 0xa9: this.a = this.nz(this.fetch()); break;
      case 0xa5: this.a = this.nz(this.rd(this.fetch())); break;
      case 0xb5: this.a = this.nz(this.rd(this.zpx())); break;
      case 0xad: this.a = this.nz(this.rd(this.fetch16())); break;
      case 0xbd: this.a = this.nz(this.rd(this.absx(true))); break;
      case 0xb9: this.a = this.nz(this.rd(this.absy(true))); break;
      case 0xa1: this.a = this.nz(this.rd(this.izx())); break;
      case 0xb1: this.a = this.nz(this.rd(this.izy(true))); break;
      case 0xa2: this.x = this.nz(this.fetch()); break;
      case 0xa6: this.x = this.nz(this.rd(this.fetch())); break;
      case 0xb6: this.x = this.nz(this.rd(this.zpy())); break;
      case 0xae: this.x = this.nz(this.rd(this.fetch16())); break;
      case 0xbe: this.x = this.nz(this.rd(this.absy(true))); break;
      case 0xa0: this.y = this.nz(this.fetch()); break;
      case 0xa4: this.y = this.nz(this.rd(this.fetch())); break;
      case 0xb4: this.y = this.nz(this.rd(this.zpx())); break;
      case 0xac: this.y = this.nz(this.rd(this.fetch16())); break;
      case 0xbc: this.y = this.nz(this.rd(this.absx(true))); break;

      // --------------------------------------------------------- stores
      case 0x85: this.wr(this.fetch(), this.a); break;
      case 0x95: this.wr(this.zpx(), this.a); break;
      case 0x8d: this.wr(this.fetch16(), this.a); break;
      case 0x9d: this.wr(this.absx(false), this.a); break;
      case 0x99: this.wr(this.absy(false), this.a); break;
      case 0x81: this.wr(this.izx(), this.a); break;
      case 0x91: this.wr(this.izy(false), this.a); break;
      case 0x86: this.wr(this.fetch(), this.x); break;
      case 0x96: this.wr(this.zpy(), this.x); break;
      case 0x8e: this.wr(this.fetch16(), this.x); break;
      case 0x84: this.wr(this.fetch(), this.y); break;
      case 0x94: this.wr(this.zpx(), this.y); break;
      case 0x8c: this.wr(this.fetch16(), this.y); break;

      // ------------------------------------------------------ transfers
      case 0xaa: this.x = this.nz(this.a); break; // TAX
      case 0xa8: this.y = this.nz(this.a); break; // TAY
      case 0x8a: this.a = this.nz(this.x); break; // TXA
      case 0x98: this.a = this.nz(this.y); break; // TYA
      case 0xba: this.x = this.nz(this.s); break; // TSX
      case 0x9a: this.s = this.x; break; // TXS (no flags)

      // ---------------------------------------------------------- stack
      case 0x48: this.push(this.a); break; // PHA
      case 0x68: this.a = this.nz(this.pull()); break; // PLA
      case 0x08: this.push(this.p | FB | FU); break; // PHP
      case 0x28: this.p = (this.pull() & ~FB) | FU; break; // PLP

      // ---------------------------------------------------------- logic
      case 0x29: this.a = this.nz(this.a & this.fetch()); break;
      case 0x25: this.a = this.nz(this.a & this.rd(this.fetch())); break;
      case 0x35: this.a = this.nz(this.a & this.rd(this.zpx())); break;
      case 0x2d: this.a = this.nz(this.a & this.rd(this.fetch16())); break;
      case 0x3d: this.a = this.nz(this.a & this.rd(this.absx(true))); break;
      case 0x39: this.a = this.nz(this.a & this.rd(this.absy(true))); break;
      case 0x21: this.a = this.nz(this.a & this.rd(this.izx())); break;
      case 0x31: this.a = this.nz(this.a & this.rd(this.izy(true))); break;
      case 0x09: this.a = this.nz(this.a | this.fetch()); break;
      case 0x05: this.a = this.nz(this.a | this.rd(this.fetch())); break;
      case 0x15: this.a = this.nz(this.a | this.rd(this.zpx())); break;
      case 0x0d: this.a = this.nz(this.a | this.rd(this.fetch16())); break;
      case 0x1d: this.a = this.nz(this.a | this.rd(this.absx(true))); break;
      case 0x19: this.a = this.nz(this.a | this.rd(this.absy(true))); break;
      case 0x01: this.a = this.nz(this.a | this.rd(this.izx())); break;
      case 0x11: this.a = this.nz(this.a | this.rd(this.izy(true))); break;
      case 0x49: this.a = this.nz(this.a ^ this.fetch()); break;
      case 0x45: this.a = this.nz(this.a ^ this.rd(this.fetch())); break;
      case 0x55: this.a = this.nz(this.a ^ this.rd(this.zpx())); break;
      case 0x4d: this.a = this.nz(this.a ^ this.rd(this.fetch16())); break;
      case 0x5d: this.a = this.nz(this.a ^ this.rd(this.absx(true))); break;
      case 0x59: this.a = this.nz(this.a ^ this.rd(this.absy(true))); break;
      case 0x41: this.a = this.nz(this.a ^ this.rd(this.izx())); break;
      case 0x51: this.a = this.nz(this.a ^ this.rd(this.izy(true))); break;
      case 0x24: this.bit(this.rd(this.fetch())); break;
      case 0x2c: this.bit(this.rd(this.fetch16())); break;

      // ----------------------------------------------------- arithmetic
      case 0x69: this.adc(this.fetch()); break;
      case 0x65: this.adc(this.rd(this.fetch())); break;
      case 0x75: this.adc(this.rd(this.zpx())); break;
      case 0x6d: this.adc(this.rd(this.fetch16())); break;
      case 0x7d: this.adc(this.rd(this.absx(true))); break;
      case 0x79: this.adc(this.rd(this.absy(true))); break;
      case 0x61: this.adc(this.rd(this.izx())); break;
      case 0x71: this.adc(this.rd(this.izy(true))); break;
      case 0xe9:
      case 0xeb: this.sbc(this.fetch()); break; // $EB = unofficial SBC imm
      case 0xe5: this.sbc(this.rd(this.fetch())); break;
      case 0xf5: this.sbc(this.rd(this.zpx())); break;
      case 0xed: this.sbc(this.rd(this.fetch16())); break;
      case 0xfd: this.sbc(this.rd(this.absx(true))); break;
      case 0xf9: this.sbc(this.rd(this.absy(true))); break;
      case 0xe1: this.sbc(this.rd(this.izx())); break;
      case 0xf1: this.sbc(this.rd(this.izy(true))); break;

      // ------------------------------------------------------- compares
      case 0xc9: this.cp(this.a, this.fetch()); break;
      case 0xc5: this.cp(this.a, this.rd(this.fetch())); break;
      case 0xd5: this.cp(this.a, this.rd(this.zpx())); break;
      case 0xcd: this.cp(this.a, this.rd(this.fetch16())); break;
      case 0xdd: this.cp(this.a, this.rd(this.absx(true))); break;
      case 0xd9: this.cp(this.a, this.rd(this.absy(true))); break;
      case 0xc1: this.cp(this.a, this.rd(this.izx())); break;
      case 0xd1: this.cp(this.a, this.rd(this.izy(true))); break;
      case 0xe0: this.cp(this.x, this.fetch()); break;
      case 0xe4: this.cp(this.x, this.rd(this.fetch())); break;
      case 0xec: this.cp(this.x, this.rd(this.fetch16())); break;
      case 0xc0: this.cp(this.y, this.fetch()); break;
      case 0xc4: this.cp(this.y, this.rd(this.fetch())); break;
      case 0xcc: this.cp(this.y, this.rd(this.fetch16())); break;

      // ---------------------------------------------- increment/decrement
      case 0xe6: { const ea = this.fetch(); this.wr(ea, this.nz(this.rd(ea) + 1)); break; }
      case 0xf6: { const ea = this.zpx(); this.wr(ea, this.nz(this.rd(ea) + 1)); break; }
      case 0xee: { const ea = this.fetch16(); this.wr(ea, this.nz(this.rd(ea) + 1)); break; }
      case 0xfe: { const ea = this.absx(false); this.wr(ea, this.nz(this.rd(ea) + 1)); break; }
      case 0xc6: { const ea = this.fetch(); this.wr(ea, this.nz(this.rd(ea) - 1)); break; }
      case 0xd6: { const ea = this.zpx(); this.wr(ea, this.nz(this.rd(ea) - 1)); break; }
      case 0xce: { const ea = this.fetch16(); this.wr(ea, this.nz(this.rd(ea) - 1)); break; }
      case 0xde: { const ea = this.absx(false); this.wr(ea, this.nz(this.rd(ea) - 1)); break; }
      case 0xe8: this.x = this.nz(this.x + 1); break; // INX
      case 0xc8: this.y = this.nz(this.y + 1); break; // INY
      case 0xca: this.x = this.nz(this.x - 1); break; // DEX
      case 0x88: this.y = this.nz(this.y - 1); break; // DEY

      // -------------------------------------------------- shifts/rotates
      case 0x0a: this.a = this.asl(this.a); break;
      case 0x06: { const ea = this.fetch(); this.wr(ea, this.asl(this.rd(ea))); break; }
      case 0x16: { const ea = this.zpx(); this.wr(ea, this.asl(this.rd(ea))); break; }
      case 0x0e: { const ea = this.fetch16(); this.wr(ea, this.asl(this.rd(ea))); break; }
      case 0x1e: { const ea = this.absx(false); this.wr(ea, this.asl(this.rd(ea))); break; }
      case 0x4a: this.a = this.lsr(this.a); break;
      case 0x46: { const ea = this.fetch(); this.wr(ea, this.lsr(this.rd(ea))); break; }
      case 0x56: { const ea = this.zpx(); this.wr(ea, this.lsr(this.rd(ea))); break; }
      case 0x4e: { const ea = this.fetch16(); this.wr(ea, this.lsr(this.rd(ea))); break; }
      case 0x5e: { const ea = this.absx(false); this.wr(ea, this.lsr(this.rd(ea))); break; }
      case 0x2a: this.a = this.rol(this.a); break;
      case 0x26: { const ea = this.fetch(); this.wr(ea, this.rol(this.rd(ea))); break; }
      case 0x36: { const ea = this.zpx(); this.wr(ea, this.rol(this.rd(ea))); break; }
      case 0x2e: { const ea = this.fetch16(); this.wr(ea, this.rol(this.rd(ea))); break; }
      case 0x3e: { const ea = this.absx(false); this.wr(ea, this.rol(this.rd(ea))); break; }
      case 0x6a: this.a = this.ror(this.a); break;
      case 0x66: { const ea = this.fetch(); this.wr(ea, this.ror(this.rd(ea))); break; }
      case 0x76: { const ea = this.zpx(); this.wr(ea, this.ror(this.rd(ea))); break; }
      case 0x6e: { const ea = this.fetch16(); this.wr(ea, this.ror(this.rd(ea))); break; }
      case 0x7e: { const ea = this.absx(false); this.wr(ea, this.ror(this.rd(ea))); break; }

      // ------------------------------------------------- jumps/subroutines
      case 0x4c: this.pc = this.fetch16(); break; // JMP abs
      case 0x6c: { // JMP (ind) — the NMOS page-wrap bug
        const ptr = this.fetch16();
        const lo = this.rd(ptr);
        const hi = this.rd((ptr & 0xff00) | ((ptr + 1) & 0xff));
        this.pc = lo | (hi << 8);
        break;
      }
      case 0x20: { // JSR: pushes (address of last operand byte)
        const target = this.fetch16();
        const ret = (this.pc - 1) & 0xffff;
        this.push((ret >> 8) & 0xff);
        this.push(ret & 0xff);
        this.pc = target;
        break;
      }
      case 0x60: { // RTS
        const lo = this.pull();
        const hi = this.pull();
        this.pc = (((hi << 8) | lo) + 1) & 0xffff;
        break;
      }
      case 0x40: { // RTI: pull P (B ignored, U forced), then PC
        this.p = (this.pull() & ~FB) | FU;
        const lo = this.pull();
        const hi = this.pull();
        this.pc = (hi << 8) | lo;
        break;
      }
      case 0x00: { // BRK: 2-byte instruction; pushes P with B|U set
        const ret = (this.pc + 1) & 0xffff;
        this.push((ret >> 8) & 0xff);
        this.push(ret & 0xff);
        this.push(this.p | FB | FU);
        this.p |= FI;
        this.pc = this.rd(VEC_IRQ) | (this.rd(VEC_IRQ + 1) << 8);
        break;
      }

      // ------------------------------------------------------- branches
      case 0x10: this.br((this.p & FN) === 0); break; // BPL
      case 0x30: this.br((this.p & FN) !== 0); break; // BMI
      case 0x50: this.br((this.p & FV) === 0); break; // BVC
      case 0x70: this.br((this.p & FV) !== 0); break; // BVS
      case 0x90: this.br((this.p & FC) === 0); break; // BCC
      case 0xb0: this.br((this.p & FC) !== 0); break; // BCS
      case 0xd0: this.br((this.p & FZ) === 0); break; // BNE
      case 0xf0: this.br((this.p & FZ) !== 0); break; // BEQ

      // ----------------------------------------------------------- flags
      case 0x18: this.p &= ~FC; break; // CLC
      case 0x38: this.p |= FC; break; // SEC
      case 0x58: this.p &= ~FI; break; // CLI
      case 0x78: this.p |= FI; break; // SEI
      case 0xb8: this.p &= ~FV; break; // CLV
      case 0xd8: this.p &= ~FD; break; // CLD
      case 0xf8: this.p |= FD; break; // SED

      // ---------------------------------------------- NOPs (official + un)
      case 0xea: case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa:
        break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: // NOP imm
        this.fetch();
        break;
      case 0x04: case 0x44: case 0x64: // NOP zp
        this.rd(this.fetch());
        break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: // NOP zp,X
        this.rd(this.zpx());
        break;
      case 0x0c: // NOP abs
        this.rd(this.fetch16());
        break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: // NOP abs,X
        this.rd(this.absx(true));
        break;

      // ----------------------------------------- unofficial: LAX/SAX & co
      case 0xa7: this.a = this.x = this.nz(this.rd(this.fetch())); break;
      case 0xb7: this.a = this.x = this.nz(this.rd(this.zpy())); break;
      case 0xaf: this.a = this.x = this.nz(this.rd(this.fetch16())); break;
      case 0xbf: this.a = this.x = this.nz(this.rd(this.absy(true))); break;
      case 0xa3: this.a = this.x = this.nz(this.rd(this.izx())); break;
      case 0xb3: this.a = this.x = this.nz(this.rd(this.izy(true))); break;
      case 0xab: // LXA imm (unstable; common magic-constant model)
        this.a = this.x = this.nz((this.a | 0xee) & this.fetch());
        break;
      case 0x87: this.wr(this.fetch(), this.a & this.x); break; // SAX zp
      case 0x97: this.wr(this.zpy(), this.a & this.x); break; // SAX zp,Y
      case 0x8f: this.wr(this.fetch16(), this.a & this.x); break; // SAX abs
      case 0x83: this.wr(this.izx(), this.a & this.x); break; // SAX (zp,X)

      // ------------------------------------- unofficial: RMW + ALU combos
      // DCP = DEC then CMP
      case 0xc7: { const ea = this.fetch(); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      case 0xd7: { const ea = this.zpx(); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      case 0xcf: { const ea = this.fetch16(); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      case 0xdf: { const ea = this.absx(false); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      case 0xdb: { const ea = this.absy(false); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      case 0xc3: { const ea = this.izx(); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      case 0xd3: { const ea = this.izy(false); const r = (this.rd(ea) - 1) & 0xff; this.wr(ea, r); this.cp(this.a, r); break; }
      // ISB/ISC = INC then SBC
      case 0xe7: { const ea = this.fetch(); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      case 0xf7: { const ea = this.zpx(); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      case 0xef: { const ea = this.fetch16(); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      case 0xff: { const ea = this.absx(false); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      case 0xfb: { const ea = this.absy(false); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      case 0xe3: { const ea = this.izx(); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      case 0xf3: { const ea = this.izy(false); const r = (this.rd(ea) + 1) & 0xff; this.wr(ea, r); this.sbc(r); break; }
      // SLO = ASL then ORA
      case 0x07: { const ea = this.fetch(); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      case 0x17: { const ea = this.zpx(); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      case 0x0f: { const ea = this.fetch16(); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      case 0x1f: { const ea = this.absx(false); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      case 0x1b: { const ea = this.absy(false); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      case 0x03: { const ea = this.izx(); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      case 0x13: { const ea = this.izy(false); const r = this.asl(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a | r); break; }
      // RLA = ROL then AND
      case 0x27: { const ea = this.fetch(); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      case 0x37: { const ea = this.zpx(); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      case 0x2f: { const ea = this.fetch16(); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      case 0x3f: { const ea = this.absx(false); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      case 0x3b: { const ea = this.absy(false); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      case 0x23: { const ea = this.izx(); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      case 0x33: { const ea = this.izy(false); const r = this.rol(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a & r); break; }
      // SRE = LSR then EOR
      case 0x47: { const ea = this.fetch(); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      case 0x57: { const ea = this.zpx(); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      case 0x4f: { const ea = this.fetch16(); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      case 0x5f: { const ea = this.absx(false); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      case 0x5b: { const ea = this.absy(false); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      case 0x43: { const ea = this.izx(); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      case 0x53: { const ea = this.izy(false); const r = this.lsr(this.rd(ea)); this.wr(ea, r); this.a = this.nz(this.a ^ r); break; }
      // RRA = ROR then ADC (ADC sees the carry produced by ROR)
      case 0x67: { const ea = this.fetch(); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }
      case 0x77: { const ea = this.zpx(); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }
      case 0x6f: { const ea = this.fetch16(); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }
      case 0x7f: { const ea = this.absx(false); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }
      case 0x7b: { const ea = this.absy(false); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }
      case 0x63: { const ea = this.izx(); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }
      case 0x73: { const ea = this.izy(false); const r = this.ror(this.rd(ea)); this.wr(ea, r); this.adc(r); break; }

      // --------------------------------------- unofficial: immediate ALU
      case 0x0b: case 0x2b: // ANC: AND imm, C = N
        this.a = this.nz(this.a & this.fetch());
        this.p = (this.p & ~FC) | ((this.a >> 7) & FC);
        break;
      case 0x4b: // ALR: AND imm then LSR A
        this.a = this.lsr(this.a & this.fetch());
        break;
      case 0x6b: { // ARR: AND imm then ROR A with weird C/V (binary model)
        const t = this.a & this.fetch();
        const r = (t >> 1) | ((this.p & FC) << 7);
        this.a = this.nz(r);
        this.p =
          (this.p & ~(FC | FV)) |
          ((r >> 6) & FC) |
          ((((r >> 6) ^ (r >> 5)) & 1) !== 0 ? FV : 0);
        break;
      }
      case 0x8b: // XAA (unstable; common magic-constant model)
        this.a = this.nz((this.a | 0xee) & this.x & this.fetch());
        break;
      case 0xcb: { // AXS/SBX: X = (A & X) - imm, flags like CMP
        const m = this.fetch();
        const d = (this.a & this.x) - m;
        this.p = (this.p & ~(FN | FZ | FC)) | NZ[d & 0xff] | (d >= 0 ? FC : 0);
        this.x = d & 0xff;
        break;
      }

      // ------------------------------------ unofficial: unstable stores
      case 0xbb: { // LAS: A = X = S = mem & S
        const v = this.rd(this.absy(true)) & this.s;
        this.a = this.x = this.s = this.nz(v);
        break;
      }
      case 0x9f: { const ea = this.absy(false); this.wr(ea, this.a & this.x & (((ea >> 8) + 1) & 0xff)); break; } // SHA abs,Y
      case 0x93: { const ea = this.izy(false); this.wr(ea, this.a & this.x & (((ea >> 8) + 1) & 0xff)); break; } // SHA (zp),Y
      case 0x9e: { const ea = this.absy(false); this.wr(ea, this.x & (((ea >> 8) + 1) & 0xff)); break; } // SHX abs,Y
      case 0x9c: { const ea = this.absx(false); this.wr(ea, this.y & (((ea >> 8) + 1) & 0xff)); break; } // SHY abs,X
      case 0x9b: { // TAS: S = A & X, then SHA-style store
        const ea = this.absy(false);
        this.s = this.a & this.x;
        this.wr(ea, this.s & (((ea >> 8) + 1) & 0xff));
        break;
      }

      // ------------------------------------------------------- JAM/KIL
      case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
      case 0x62: case 0x72: case 0x92: case 0xb2: case 0xd2: case 0xf2:
        this.jam();
        break;

      default:
        // unreachable — every opcode 0x00-0xFF is handled above
        break;
    }
  }
}
