// Motorola MC6809 CPU emulator core for mame2js.
//
// Self-contained ES module: zero imports, zero runtime dependencies, no DOM.
// Instruction semantics, flag behavior and cycle counts are ported from the
// MAME 6809 core (src/devices/cpu/m6809: m6809.lst / base6x09.lst /
// m6809inl.h / m6809.cpp), which counts one cycle per bus access (including
// the dummy/VMA accesses) and thereby reproduces the MC6809 datasheet cycle
// tables. Covered:
//  - full documented instruction set, all addressing modes (inherent,
//    immediate, direct, extended, every indexed submode incl. auto inc/dec
//    by 1/2, A/B/D accumulator offsets, 5/8/16-bit constant offsets,
//    PC-relative, extended indirect and all indirect forms)
//  - $10/$11 prefix pages (repeated prefixes stay in the same page, exactly
//    like MAME's DISPATCH10/DISPATCH11), TFR/EXG including the 8<->16 bit
//    0xff00 padding and CC/DP duplication rules, PSHS/PULS/PSHU/PULU with
//    hardware push/pull order and one cycle per byte, MUL, DAA, SEX, ABX,
//    short + long branches, BSR/LBSR/JSR/RTS, RTI (E-flag dependent),
//    SWI/SWI2/SWI3, CWAI, SYNC, NOP
//  - interrupts: NMI (edge-triggered, inhibited until S has been loaded
//    after reset - the "LDS encountered" rule, per MAME), IRQ (entire state
//    push, E=1, masks I only), FIRQ (PC+CC only, E=0, masks I+F), vectors
//    $FFF2-$FFFE, CWAI fast dispatch (no second push), SYNC waking on any
//    interrupt line regardless of masks.
//
// Deliberate simplifications vs. MAME (documented choices):
//  - Undocumented opcodes are NOT implemented (Konami games do not use
//    them). Unknown opcodes execute as a 1-cycle no-op; the free aliases
//    that MAME folds onto documented handlers ($01=NEG dir, $05=LSR dir,
//    $1B=NOP, and the $x1/$x5 register/indexed/extended aliases) are kept
//    since they share dispatch lines. Unknown $10/$11-page opcodes execute
//    as their page-1 equivalent without re-fetching (real-hardware
//    behavior; MAME's generated fallthrough differs here).
//  - MAME's dummy bus accesses (dummy_vma / dummy reads used for cycle
//    padding) are counted as cycles but do not touch the bus, so handlers
//    can never see phantom reads at $FFFF.
//  - The trailing "dead" read of PULS/PULU/RTS/RTI and the pre-push read of
//    PSHS/PSHU are likewise cycle-only.
//
// The opcodeFetch hook is applied to every byte MAME fetches via
// read_opcode(): the first byte of an instruction AND the $10/$11 prefix
// bytes AND the opcode byte following a prefix. Operands, vectors and data
// use plain bus reads. konami1.ts uses this hook for the KONAMI-1 opcode
// decryption.

export interface M6809Bus {
  read(addr: number): number; // memory read, addr 0..0xffff, returns 0..0xff
  write(addr: number, data: number): void;
}

// Condition-code register bits
const CC_C = 0x01; // carry
const CC_V = 0x02; // overflow
const CC_Z = 0x04; // zero
const CC_N = 0x08; // negative
const CC_I = 0x10; // IRQ inhibit
const CC_H = 0x20; // half carry
const CC_F = 0x40; // FIRQ inhibit
const CC_E = 0x80; // entire state pushed

const CC_NZ = CC_N | CC_Z;
const CC_NZV = CC_N | CC_Z | CC_V;
const CC_NZVC = CC_N | CC_Z | CC_V | CC_C;
const CC_HNZVC = CC_H | CC_NZVC;

// Interrupt/reset vectors
const VEC_SWI3 = 0xfff2;
const VEC_SWI2 = 0xfff4;
const VEC_FIRQ = 0xfff6;
const VEC_IRQ = 0xfff8;
const VEC_SWI = 0xfffa;
const VEC_NMI = 0xfffc;
const VEC_RESET = 0xfffe;

// Operand addressing modes (mirrors MAME's ADDRESSING_MODE_*)
const MODE_IMM = 0;
const MODE_EA = 1;
const MODE_A = 2;
const MODE_B = 3;

function sx8(v: number): number {
  return (v & 0x80) !== 0 ? v - 256 : v;
}

export class M6809 {
  // public registers
  pc = 0;
  s = 0;
  u = 0;
  x = 0;
  y = 0;
  a = 0;
  b = 0;
  dp = 0;
  cc = 0;
  halted = false; // parked in SYNC or CWAI wait

  private bus: M6809Bus;
  private opcodeXform: ((addr: number, byte: number) => number) | null;
  private irqLine = false;
  private firqLine = false;
  private nmiPending = false;
  private ldsEncountered = false; // NMI inhibited until S loaded after reset
  private syncWait = false;
  private cwaiWait = false;
  private cy = 0; // cycle accumulator for the current step
  private ea = 0;
  private mode = MODE_IMM;

  constructor(
    bus: M6809Bus,
    opts?: { opcodeFetch?: (addr: number, byte: number) => number },
  ) {
    this.bus = bus;
    this.opcodeXform = opts?.opcodeFetch ?? null;
    this.reset();
  }

  /** Hardware reset: DP=0, I+F set, PC loaded from vector $FFFE/F.
   *  Also re-arms the NMI-until-LDS inhibit. */
  reset(): void {
    this.nmiPending = false;
    this.ldsEncountered = false;
    this.syncWait = false;
    this.cwaiWait = false;
    this.halted = false;
    this.dp = 0;
    this.cc |= CC_I | CC_F;
    this.pc = (this.rd(VEC_RESET) << 8) | this.rd(VEC_RESET + 1);
  }

  /** Edge-triggered NMI pulse. Ignored until S has been loaded after reset
   *  (LDS / TFR ..,S / LEAS), matching MAME's m_lds_encountered rule. */
  nmi(): void {
    if (this.ldsEncountered) this.nmiPending = true;
  }

  /** Level-triggered IRQ line. Taken at instruction boundaries when CC.I is clear. */
  setIrqLine(active: boolean): void {
    this.irqLine = active;
  }

  /** Level-triggered FIRQ line. Taken at instruction boundaries when CC.F is clear. */
  setFirqLine(active: boolean): void {
    this.firqLine = active;
  }

  /** Execute one instruction (or accept a pending interrupt / burn one
   *  cycle if parked in SYNC/CWAI). Returns cycles consumed. */
  step(): number {
    this.cy = 0;

    if (this.cwaiWait) {
      // CWAI already pushed the entire state; dispatch straight to the vector
      const vec = this.pendingVector();
      if (vec === 0) return 1;
      this.cwaiDispatch(vec);
      return this.cy;
    }

    if (this.syncWait) {
      // SYNC wakes on any interrupt line, masked or not
      if (!this.nmiPending && !this.firqLine && !this.irqLine) return 1;
      this.syncWait = false;
      this.halted = false;
      this.cy++; // MAME eats one cycle on wake
      // fall through to the interrupt check / next instruction
    }

    const vec = this.pendingVector();
    if (vec === VEC_NMI) {
      this.nmiPending = false;
      this.idle(3);
      this.cc |= CC_E;
      this.s = this.pushRegs(this.s, 0xff, this.u);
      this.cc |= CC_I | CC_F;
      this.intVector(VEC_NMI);
      return this.cy; // 19
    }
    if (vec === VEC_FIRQ) {
      this.idle(3);
      this.cc &= ~CC_E;
      this.s = this.pushRegs(this.s, 0x81, this.u); // PC + CC only
      this.cc |= CC_I | CC_F;
      this.intVector(VEC_FIRQ);
      return this.cy; // 10
    }
    if (vec === VEC_IRQ) {
      this.idle(3);
      this.cc |= CC_E;
      this.s = this.pushRegs(this.s, 0xff, this.u);
      this.cc |= CC_I; // IRQ does not set F
      this.intVector(VEC_IRQ);
      return this.cy; // 19
    }

    this.exec(this.fetchOp());
    return this.cy;
  }

  /** step() until at least `cycles` are consumed; returns actual total. */
  run(cycles: number): number {
    let total = 0;
    while (total < cycles) total += this.step();
    return total;
  }

  // ---------------------------------------------------------------- bus helpers

  private rd(addr: number): number {
    this.cy++;
    return this.bus.read(addr & 0xffff) & 0xff;
  }

  private wr(addr: number, data: number): void {
    this.cy++;
    this.bus.write(addr & 0xffff, data & 0xff);
  }

  private idle(n: number): void {
    this.cy += n; // dummy/VMA cycles: counted, not driven onto the bus
  }

  /** Opcode fetch (M1-equivalent): goes through the opcodeFetch transform. */
  private fetchOp(): number {
    let v = this.rd(this.pc);
    if (this.opcodeXform !== null) v = this.opcodeXform(this.pc, v) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  /** Operand byte fetch: NOT transformed. */
  private fetchArg(): number {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetchArg16(): number {
    const hi = this.fetchArg();
    return (hi << 8) | this.fetchArg();
  }

  // ---------------------------------------------------------------- flags

  // Port of MAME's set_flags<uint8_t>(mask, a, b, r); returns r & 0xff.
  // r may be any int (negative values behave like MAME's uint32 wraparound
  // under JS bitwise ops).
  private flags8(mask: number, a: number, b: number, r: number): number {
    let cc = this.cc & ~mask;
    if ((mask & CC_H) !== 0 && ((a ^ b ^ r) & 0x10) !== 0) cc |= CC_H;
    if ((mask & CC_N) !== 0 && (r & 0x80) !== 0) cc |= CC_N;
    if ((mask & CC_Z) !== 0 && (r & 0xff) === 0) cc |= CC_Z;
    if ((mask & CC_V) !== 0 && ((a ^ b ^ r ^ (r >> 1)) & 0x80) !== 0) cc |= CC_V;
    if ((mask & CC_C) !== 0 && (r & 0x100) !== 0) cc |= CC_C;
    this.cc = cc;
    return r & 0xff;
  }

  // Port of MAME's set_flags<uint16_t>(mask, a, b, r); returns r & 0xffff.
  private flags16(mask: number, a: number, b: number, r: number): number {
    let cc = this.cc & ~mask;
    if ((mask & CC_N) !== 0 && (r & 0x8000) !== 0) cc |= CC_N;
    if ((mask & CC_Z) !== 0 && (r & 0xffff) === 0) cc |= CC_Z;
    if ((mask & CC_V) !== 0 && ((a ^ b ^ r ^ (r >> 1)) & 0x8000) !== 0) cc |= CC_V;
    if ((mask & CC_C) !== 0 && (r & 0x10000) !== 0) cc |= CC_C;
    this.cc = cc;
    return r & 0xffff;
  }

  /** N/Z from 8-bit value, V cleared (LD8/ST8/TST semantics). */
  private nz8v0(v: number): number {
    this.cc = (this.cc & ~CC_NZV) | ((v & 0x80) !== 0 ? CC_N : 0) | ((v & 0xff) === 0 ? CC_Z : 0);
    return v & 0xff;
  }

  /** N/Z from 16-bit value, V cleared (LD16/ST16 semantics). */
  private nz16v0(v: number): number {
    v &= 0xffff;
    this.cc = (this.cc & ~CC_NZV) | ((v & 0x8000) !== 0 ? CC_N : 0) | (v === 0 ? CC_Z : 0);
    return v;
  }

  // ---------------------------------------------------------------- register helpers

  private getD(): number {
    return (this.a << 8) | this.b;
  }

  private setD(v: number): void {
    this.a = (v >> 8) & 0xff;
    this.b = v & 0xff;
  }

  // ---------------------------------------------------------------- addressing modes

  private amDirect(): void {
    this.ea = (this.dp << 8) | this.fetchArg();
    this.idle(1);
    this.mode = MODE_EA;
  }

  private amExtended(): void {
    this.ea = this.fetchArg16();
    this.idle(1);
    this.mode = MODE_EA;
  }

  private ireg(post: number): number {
    switch ((post >> 5) & 3) {
      case 0: return this.x;
      case 1: return this.y;
      case 2: return this.u;
      default: return this.s;
    }
  }

  private setIreg(post: number, v: number): void {
    v &= 0xffff;
    switch ((post >> 5) & 3) {
      case 0: this.x = v; break;
      case 1: this.y = v; break;
      case 2: this.u = v; break;
      default: this.s = v; break;
    }
  }

  private amIndexed(): void {
    const post = this.fetchArg();
    let t: number;
    if ((post & 0x80) !== 0) {
      const idx = this.ireg(post);
      switch (post & 0x0f) {
        case 0x00: // ,R+
          t = idx;
          this.setIreg(post, idx + 1);
          this.idle(3);
          break;
        case 0x01: // ,R++
          t = idx;
          this.setIreg(post, idx + 2);
          this.idle(4);
          break;
        case 0x02: // ,-R
          t = idx - 1;
          this.setIreg(post, t);
          this.idle(3);
          break;
        case 0x03: // ,--R
          t = idx - 2;
          this.setIreg(post, t);
          this.idle(4);
          break;
        case 0x04: // ,R
          t = idx;
          this.idle(1);
          break;
        case 0x05: // B,R
          t = idx + sx8(this.b);
          this.idle(2);
          break;
        case 0x06: // A,R
          t = idx + sx8(this.a);
          this.idle(2);
          break;
        case 0x08: // n8,R
          t = idx + sx8(this.fetchArg());
          this.idle(1);
          break;
        case 0x09: // n16,R (sign irrelevant mod 64k)
          t = idx + this.fetchArg16();
          this.idle(3);
          break;
        case 0x0b: // D,R
          t = idx + this.getD();
          this.idle(5);
          break;
        case 0x0c: // n8,PCR (PC after the offset byte)
          t = sx8(this.fetchArg());
          t += this.pc;
          this.idle(1);
          break;
        case 0x0d: // n16,PCR (PC after both offset bytes)
          t = this.fetchArg16();
          t += this.pc;
          this.idle(4);
          break;
        case 0x0f: // [n16] extended indirect (address part)
          t = this.fetchArg16();
          this.idle(1);
          break;
        default: // 0x07 / 0x0a / 0x0e invalid -> $0000, as MAME
          t = 0;
          break;
      }
      if ((post & 0x10) !== 0) {
        // indirect: EA = word at computed address
        t &= 0xffff;
        t = (this.rd(t) << 8) | this.rd(t + 1);
        this.idle(1);
      }
    } else {
      // 5-bit signed constant offset
      t = this.ireg(post) + ((post & 0x0f) - ((post & 0x10) !== 0 ? 16 : 0));
      this.idle(2);
    }
    this.ea = t & 0xffff;
    this.mode = MODE_EA;
  }

  /** Addressing for the $80-$FF columns: bits 5-4 select imm/dir/idx/ext. */
  private amCol(op: number): void {
    switch ((op >> 4) & 3) {
      case 0: this.mode = MODE_IMM; break;
      case 1: this.amDirect(); break;
      case 2: this.amIndexed(); break;
      default: this.amExtended(); break;
    }
  }

  // ---------------------------------------------------------------- operand access

  private readOperand(): number {
    switch (this.mode) {
      case MODE_EA: return this.rd(this.ea);
      case MODE_IMM: return this.fetchArg();
      case MODE_A: return this.a;
      default: return this.b;
    }
  }

  private readOperand16(): number {
    if (this.mode === MODE_EA) return (this.rd(this.ea) << 8) | this.rd(this.ea + 1);
    return this.fetchArg16();
  }

  private writeOperand(v: number): void {
    switch (this.mode) {
      case MODE_EA: this.wr(this.ea, v); break;
      case MODE_A: this.a = v & 0xff; break;
      case MODE_B: this.b = v & 0xff; break;
      // MODE_IMM: nothing
    }
  }

  // ---------------------------------------------------------------- stack / interrupts

  /** Push per PSHS mask order: PC, U/S, Y, X, DP, B, A, CC (one cycle per byte). */
  private pushRegs(sp: number, mask: number, other: number): number {
    if ((mask & 0x80) !== 0) {
      sp = (sp - 1) & 0xffff; this.wr(sp, this.pc & 0xff);
      sp = (sp - 1) & 0xffff; this.wr(sp, this.pc >> 8);
    }
    if ((mask & 0x40) !== 0) {
      sp = (sp - 1) & 0xffff; this.wr(sp, other & 0xff);
      sp = (sp - 1) & 0xffff; this.wr(sp, other >> 8);
    }
    if ((mask & 0x20) !== 0) {
      sp = (sp - 1) & 0xffff; this.wr(sp, this.y & 0xff);
      sp = (sp - 1) & 0xffff; this.wr(sp, this.y >> 8);
    }
    if ((mask & 0x10) !== 0) {
      sp = (sp - 1) & 0xffff; this.wr(sp, this.x & 0xff);
      sp = (sp - 1) & 0xffff; this.wr(sp, this.x >> 8);
    }
    if ((mask & 0x08) !== 0) { sp = (sp - 1) & 0xffff; this.wr(sp, this.dp); }
    if ((mask & 0x04) !== 0) { sp = (sp - 1) & 0xffff; this.wr(sp, this.b); }
    if ((mask & 0x02) !== 0) { sp = (sp - 1) & 0xffff; this.wr(sp, this.a); }
    if ((mask & 0x01) !== 0) { sp = (sp - 1) & 0xffff; this.wr(sp, this.cc); }
    return sp;
  }

  /** Pull per PULS mask order: CC, A, B, DP, X, Y, U/S, PC (+1 dead cycle). */
  private pullRegs(sp: number, mask: number, intoS: boolean): number {
    if ((mask & 0x01) !== 0) { this.cc = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if ((mask & 0x02) !== 0) { this.a = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if ((mask & 0x04) !== 0) { this.b = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if ((mask & 0x08) !== 0) { this.dp = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if ((mask & 0x10) !== 0) {
      this.x = this.rd(sp) << 8; sp = (sp + 1) & 0xffff;
      this.x |= this.rd(sp); sp = (sp + 1) & 0xffff;
    }
    if ((mask & 0x20) !== 0) {
      this.y = this.rd(sp) << 8; sp = (sp + 1) & 0xffff;
      this.y |= this.rd(sp); sp = (sp + 1) & 0xffff;
    }
    if ((mask & 0x40) !== 0) {
      let v = this.rd(sp) << 8; sp = (sp + 1) & 0xffff;
      v |= this.rd(sp); sp = (sp + 1) & 0xffff;
      if (intoS) this.u = v;
      else this.s = v;
    }
    if ((mask & 0x80) !== 0) {
      this.pc = this.rd(sp) << 8; sp = (sp + 1) & 0xffff;
      this.pc |= this.rd(sp); sp = (sp + 1) & 0xffff;
    }
    this.idle(1); // trailing dead read
    return sp;
  }

  private intVector(vec: number): void {
    this.idle(1);
    this.pc = (this.rd(vec) << 8) | this.rd(vec + 1);
    this.idle(1);
  }

  private pendingVector(): number {
    if (this.nmiPending) return VEC_NMI;
    if ((this.cc & CC_F) === 0 && this.firqLine) return VEC_FIRQ;
    if ((this.cc & CC_I) === 0 && this.irqLine) return VEC_IRQ;
    return 0;
  }

  /** CWAI already pushed the entire state; only mask + vector remain. */
  private cwaiDispatch(vec: number): void {
    this.cwaiWait = false;
    this.halted = false;
    if (vec === VEC_NMI) this.nmiPending = false;
    this.cc |= CC_I | (vec !== VEC_IRQ ? CC_F : 0);
    this.intVector(vec);
  }

  // ---------------------------------------------------------------- dispatch

  private exec(op: number): void {
    switch (op >> 4) {
      case 0x0: this.amDirect(); this.rmw(op & 0x0f); return;
      case 0x1: this.exec1x(op); return;
      case 0x2: this.branch(this.cond(op & 0x0f)); return;
      case 0x3: this.exec3x(op); return;
      case 0x4: this.mode = MODE_A; this.rmw(op & 0x0f); return;
      case 0x5: this.mode = MODE_B; this.rmw(op & 0x0f); return;
      case 0x6: this.amIndexed(); this.rmw(op & 0x0f); return;
      case 0x7: this.amExtended(); this.rmw(op & 0x0f); return;
      default: this.colOp(op); return;
    }
  }

  private exec1x(op: number): void {
    switch (op) {
      case 0x10: this.execPage2(); return;
      case 0x11: this.execPage3(); return;
      case 0x12: // NOP
      case 0x1b: // NOP alias (as MAME)
        this.idle(1);
        return;
      case 0x13: // SYNC
        this.idle(1);
        this.syncWait = true;
        this.halted = true;
        return;
      case 0x16: this.lbranch(true); return; // LBRA
      case 0x17: { // LBSR
        const d = this.fetchArg16();
        const t = this.pc + d;
        this.idle(4);
        this.gosub(t);
        return;
      }
      case 0x19: this.daa(); return;
      case 0x1a: // ORCC #
        this.cc |= this.fetchArg();
        this.idle(1);
        return;
      case 0x1c: // ANDCC #
        this.cc &= this.fetchArg();
        this.idle(1);
        return;
      case 0x1d: // SEX
        this.setD(this.flags16(CC_NZ, 0, 0, sx8(this.b) & 0xffff));
        this.idle(1);
        return;
      case 0x1e: this.exg(); return;
      case 0x1f: this.tfr(); return;
      default: // 0x14/0x15/0x18: undocumented, not implemented
        return;
    }
  }

  private exec3x(op: number): void {
    switch (op) {
      case 0x30: // LEAX
        this.amIndexed();
        this.x = this.ea;
        this.cc = (this.cc & ~CC_Z) | (this.ea === 0 ? CC_Z : 0);
        this.idle(1);
        return;
      case 0x31: // LEAY
        this.amIndexed();
        this.y = this.ea;
        this.cc = (this.cc & ~CC_Z) | (this.ea === 0 ? CC_Z : 0);
        this.idle(1);
        return;
      case 0x32: // LEAS (no flags; arms NMI)
        this.amIndexed();
        this.s = this.ea;
        this.ldsEncountered = true;
        this.idle(1);
        return;
      case 0x33: // LEAU (no flags)
        this.amIndexed();
        this.u = this.ea;
        this.idle(1);
        return;
      case 0x34: { // PSHS
        const mask = this.fetchArg();
        this.idle(3);
        this.s = this.pushRegs(this.s, mask, this.u);
        return;
      }
      case 0x35: { // PULS
        const mask = this.fetchArg();
        this.idle(2);
        this.s = this.pullRegs(this.s, mask, true);
        return;
      }
      case 0x36: { // PSHU
        const mask = this.fetchArg();
        this.idle(3);
        this.u = this.pushRegs(this.u, mask, this.s);
        return;
      }
      case 0x37: { // PULU
        const mask = this.fetchArg();
        this.idle(2);
        this.u = this.pullRegs(this.u, mask, false);
        return;
      }
      case 0x39: // RTS = PULS PC
        this.idle(1);
        this.s = this.pullRegs(this.s, 0x80, true);
        return;
      case 0x3a: // ABX (unsigned)
        this.x = (this.x + this.b) & 0xffff;
        this.idle(2);
        return;
      case 0x3b: { // RTI
        this.idle(1);
        this.cc = this.rd(this.s);
        this.s = (this.s + 1) & 0xffff;
        const mask = ((this.cc & CC_E) !== 0 ? 0xff : 0x81) & ~0x01;
        this.s = this.pullRegs(this.s, mask, true);
        return;
      }
      case 0x3c: { // CWAI: CC &= imm, push entire state, wait
        this.cc &= this.fetchArg();
        this.idle(2);
        this.cc |= CC_E;
        this.s = this.pushRegs(this.s, 0xff, this.u);
        const vec = this.pendingVector();
        if (vec !== 0) this.cwaiDispatch(vec); // fast dispatch, no wait
        else {
          this.cwaiWait = true;
          this.halted = true;
        }
        return;
      }
      case 0x3d: { // MUL: D = A*B; Z from D, C = bit 7 of low byte; N/V untouched
        const r = this.a * this.b;
        this.cc = (this.cc & ~(CC_Z | CC_C)) | (r === 0 ? CC_Z : 0) | ((r & 0x80) !== 0 ? CC_C : 0);
        this.setD(r);
        this.idle(10);
        return;
      }
      case 0x3f: // SWI: entire push, sets I+F
        this.idle(2);
        this.cc |= CC_E;
        this.s = this.pushRegs(this.s, 0xff, this.u);
        this.cc |= CC_I | CC_F;
        this.intVector(VEC_SWI);
        return;
      default: // 0x38 / 0x3e: undocumented, not implemented
        return;
    }
  }

  /** Page-2 ($10-prefixed) opcodes. Both the prefix and this byte were
   *  fetched via fetchOp (opcode transform applied to both). */
  private execPage2(): void {
    let op = this.fetchOp();
    while (op === 0x10 || op === 0x11) op = this.fetchOp(); // stay in page 2 (MAME DISPATCH10)
    if (op >= 0x20 && op <= 0x2f) {
      this.lbranch(this.cond(op & 0x0f));
      return;
    }
    switch (op) {
      case 0x3f: // SWI2: entire push, does NOT touch I/F
        this.idle(2);
        this.cc |= CC_E;
        this.s = this.pushRegs(this.s, 0xff, this.u);
        this.intVector(VEC_SWI2);
        return;
      case 0x83: case 0x93: case 0xa3: case 0xb3: // CMPD
        this.amCol(op);
        this.cmp16(this.getD());
        return;
      case 0x8c: case 0x9c: case 0xac: case 0xbc: // CMPY
        this.amCol(op);
        this.cmp16(this.y);
        return;
      case 0x8e: case 0x9e: case 0xae: case 0xbe: // LDY
        this.amCol(op);
        this.y = this.nz16v0(this.readOperand16());
        return;
      case 0x9f: case 0xaf: case 0xbf: // STY
        this.amCol(op);
        this.st16(this.y);
        return;
      case 0xce: case 0xde: case 0xee: case 0xfe: // LDS (arms NMI)
        this.amCol(op);
        this.s = this.nz16v0(this.readOperand16());
        this.ldsEncountered = true;
        return;
      case 0xdf: case 0xef: case 0xff: // STS
        this.amCol(op);
        this.st16(this.s);
        return;
      default: // unknown page-2 opcode: execute as page 1 (no refetch)
        this.exec(op);
        return;
    }
  }

  /** Page-3 ($11-prefixed) opcodes. */
  private execPage3(): void {
    let op = this.fetchOp();
    while (op === 0x10 || op === 0x11) op = this.fetchOp(); // stay in page 3 (MAME DISPATCH11)
    switch (op) {
      case 0x3f: // SWI3: entire push, does NOT touch I/F
        this.idle(2);
        this.cc |= CC_E;
        this.s = this.pushRegs(this.s, 0xff, this.u);
        this.intVector(VEC_SWI3);
        return;
      case 0x83: case 0x93: case 0xa3: case 0xb3: // CMPU
        this.amCol(op);
        this.cmp16(this.u);
        return;
      case 0x8c: case 0x9c: case 0xac: case 0xbc: // CMPS
        this.amCol(op);
        this.cmp16(this.s);
        return;
      default: // unknown page-3 opcode: execute as page 1 (no refetch)
        this.exec(op);
        return;
    }
  }

  // ---------------------------------------------------------------- RMW group ($00-$0F rows)

  /** Read-modify-write ops (low nibble of rows $0x/$4x/$5x/$6x/$7x);
   *  addressing mode (EA or register A/B) already established. */
  private rmw(sub: number): void {
    switch (sub) {
      case 0x0: case 0x1: { // NEG
        const m = this.readOperand();
        const r = this.flags8(CC_NZVC, 0, m, -m);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0x3: { // COM: C set, V clear
        const m = this.readOperand();
        this.cc = (this.cc & ~CC_V) | CC_C;
        const r = this.flags8(CC_NZ, 0, 0, ~m & 0xff);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0x4: case 0x5: { // LSR: C = bit0, N cleared, V untouched
        const m = this.readOperand();
        this.cc = (this.cc & ~CC_C) | ((m & 1) !== 0 ? CC_C : 0);
        const r = this.flags8(CC_NZ, 0, 0, m >> 1);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0x6: { // ROR: rotate through carry; V untouched
        const m = this.readOperand();
        const r = (m >> 1) | ((this.cc & CC_C) !== 0 ? 0x80 : 0);
        this.cc = (this.cc & ~CC_C) | ((m & 1) !== 0 ? CC_C : 0);
        this.flags8(CC_NZ, 0, 0, r);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0x7: { // ASR: sign preserved, C = bit0, V untouched
        const m = this.readOperand();
        this.cc = (this.cc & ~CC_C) | ((m & 1) !== 0 ? CC_C : 0);
        const r = this.flags8(CC_NZ, 0, 0, (m >> 1) | (m & 0x80));
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0x8: { // ASL/LSL: V = b7^b6, C = old b7
        const m = this.readOperand();
        const r = this.flags8(CC_NZVC, m, m, m << 1);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0x9: { // ROL: through carry; V = b7^b6, C = old b7
        const m = this.readOperand();
        const rl = ((m << 1) | ((this.cc & CC_C) !== 0 ? 1 : 0)) & 0xff;
        this.cc = (this.cc & ~CC_C) | ((m & 0x80) !== 0 ? CC_C : 0);
        const r = this.flags8(CC_NZV, m, m, rl | ((m & 0x80) !== 0 ? 0x100 : 0));
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0xa: { // DEC: V at $80->$7F, C untouched
        const m = this.readOperand();
        const r = this.flags8(CC_NZV, m, 1, m - 1);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0xc: { // INC: V at $7F->$80, C untouched
        const m = this.readOperand();
        const r = this.flags8(CC_NZV, m, 1, m + 1);
        this.idle(1);
        this.writeOperand(r);
        return;
      }
      case 0xd: { // TST: N/Z, V cleared, C untouched
        const m = this.readOperand();
        this.nz8v0(m);
        this.idle(this.mode === MODE_EA ? 2 : 1);
        return;
      }
      case 0xe: // JMP (memory rows only)
        if (this.mode === MODE_EA) this.pc = this.ea;
        return;
      case 0xf: { // CLR: N/V/C cleared, Z set
        this.readOperand(); // dead read (real 6809 reads before clearing)
        this.cc = (this.cc & ~CC_NZVC) | CC_Z;
        this.idle(1);
        this.writeOperand(0);
        return;
      }
      default: // 0x2 / 0xb: undocumented, not implemented
        return;
    }
  }

  // ---------------------------------------------------------------- $80-$FF columns

  private colOp(op: number): void {
    // undocumented immediate stores / FREERUN: not implemented
    if (op === 0x87 || op === 0x8f || op === 0xc7 || op === 0xcd || op === 0xcf) return;
    if (op === 0x8d) { // BSR
      const d = sx8(this.fetchArg());
      const t = this.pc + d;
      this.idle(3);
      this.gosub(t);
      return;
    }
    const rowB = op >= 0xc0;
    const sub = op & 0x0f;
    switch (sub) {
      case 0x3: { // SUBD (rows 8-B) / ADDD (rows C-F)
        this.amCol(op);
        const m = this.readOperand16();
        const d0 = this.getD();
        this.setD(this.flags16(CC_NZVC, d0, m, rowB ? d0 + m : d0 - m));
        this.idle(1);
        return;
      }
      case 0x7: // STA/STB (EA modes only; imm handled above)
        this.amCol(op);
        this.wr(this.ea, this.nz8v0(rowB ? this.b : this.a));
        return;
      case 0xc:
        this.amCol(op);
        if (rowB) this.setD(this.nz16v0(this.readOperand16())); // LDD
        else this.cmp16(this.x); // CMPX
        return;
      case 0xd:
        this.amCol(op);
        if (rowB) this.st16(this.getD()); // STD
        else { // JSR
          this.idle(2);
          this.gosub(this.ea);
        }
        return;
      case 0xe: { // LDX / LDU
        this.amCol(op);
        const v = this.nz16v0(this.readOperand16());
        if (rowB) this.u = v;
        else this.x = v;
        return;
      }
      case 0xf: // STX / STU (imm forms handled above)
        this.amCol(op);
        this.st16(rowB ? this.u : this.x);
        return;
      default: { // 8-bit ALU on A (rows 8-B) or B (rows C-F)
        this.amCol(op);
        const reg = rowB ? this.b : this.a;
        const m = this.readOperand();
        let v = reg;
        switch (sub) {
          case 0x0: v = this.flags8(CC_NZVC, reg, m, reg - m); break; // SUB
          case 0x1: this.flags8(CC_NZVC, reg, m, reg - m); return; // CMP
          case 0x2: v = this.flags8(CC_NZVC, reg, m, reg - m - (this.cc & CC_C)); break; // SBC
          case 0x4: // AND
            this.cc &= ~CC_V;
            v = this.flags8(CC_NZ, 0, 0, reg & m);
            break;
          case 0x5: // BIT
            this.cc &= ~CC_V;
            this.flags8(CC_NZ, 0, 0, reg & m);
            return;
          case 0x6: v = this.nz8v0(m); break; // LD
          case 0x8: // EOR
            this.cc &= ~CC_V;
            v = this.flags8(CC_NZ, 0, 0, reg ^ m);
            break;
          case 0x9: v = this.flags8(CC_HNZVC, reg, m, reg + m + (this.cc & CC_C)); break; // ADC
          case 0xa: // OR
            this.cc &= ~CC_V;
            v = this.flags8(CC_NZ, 0, 0, reg | m);
            break;
          default: v = this.flags8(CC_HNZVC, reg, m, reg + m); break; // 0xb ADD
        }
        if (rowB) this.b = v;
        else this.a = v;
        return;
      }
    }
  }

  private cmp16(regv: number): void {
    const m = this.readOperand16();
    this.flags16(CC_NZVC, regv, m, regv - m);
    this.idle(1);
  }

  private st16(v: number): void {
    this.wr(this.ea, v >> 8);
    this.wr(this.ea + 1, v & 0xff);
    this.nz16v0(v);
  }

  // ---------------------------------------------------------------- control flow

  private branch(taken: boolean): void {
    const d = sx8(this.fetchArg());
    this.idle(1);
    if (taken) this.pc = (this.pc + d) & 0xffff;
  }

  private lbranch(taken: boolean): void {
    const d = this.fetchArg16();
    this.idle(1);
    if (taken) {
      this.pc = (this.pc + d) & 0xffff;
      this.idle(1);
    }
  }

  private gosub(target: number): void {
    this.s = (this.s - 1) & 0xffff;
    this.wr(this.s, this.pc & 0xff);
    this.s = (this.s - 1) & 0xffff;
    this.wr(this.s, this.pc >> 8);
    this.pc = target & 0xffff;
  }

  // ---------------------------------------------------------------- misc instructions

  private daa(): void {
    let cf = 0;
    const msn = this.a & 0xf0;
    const lsn = this.a & 0x0f;
    if (lsn > 0x09 || (this.cc & CC_H) !== 0) cf |= 0x06;
    if (msn > 0x80 && lsn > 0x09) cf |= 0x60;
    if (msn > 0x90 || (this.cc & CC_C) !== 0) cf |= 0x60;
    const t = this.a + cf;
    if ((t & 0x100) !== 0) this.cc |= CC_C; // C is set, never cleared (MAME/hardware)
    this.a = this.nz8v0(t); // N/Z from result, V cleared
    this.idle(1);
  }

  // TFR/EXG register coding: 0=D 1=X 2=Y 3=U 4=S 5=PC 8=A 9=B 10=CC 11=DP.
  // 8-bit sources read as $FF00|reg for TFR/EXG-with-8-bit-first; CC/DP read
  // as duplicated (reg<<8)|reg in the 8/16 flavor. Invalid codes read $FFFF.
  private readTfrExg816(code: number): number {
    switch (code & 0x0f) {
      case 0: return this.getD();
      case 1: return this.x;
      case 2: return this.y;
      case 3: return this.u;
      case 4: return this.s;
      case 5: return this.pc;
      case 8: return 0xff00 | this.a;
      case 9: return 0xff00 | this.b;
      case 10: return (this.cc << 8) | this.cc;
      case 11: return (this.dp << 8) | this.dp;
      default: return 0xffff;
    }
  }

  private readExg168(code: number): number {
    switch (code & 0x0f) {
      case 10: return 0xff00 | this.cc;
      case 11: return 0xff00 | this.dp;
      default: return this.readTfrExg816(code);
    }
  }

  private writeTfrExg(code: number, v: number): void {
    switch (code & 0x0f) {
      case 0: this.setD(v); break;
      case 1: this.x = v & 0xffff; break;
      case 2: this.y = v & 0xffff; break;
      case 3: this.u = v & 0xffff; break;
      case 4: this.s = v & 0xffff; break;
      case 5: this.pc = v & 0xffff; break;
      case 8: this.a = v & 0xff; break;
      case 9: this.b = v & 0xff; break;
      case 10: this.cc = v & 0xff; break;
      case 11: this.dp = v & 0xff; break;
    }
  }

  private tfr(): void {
    const param = this.fetchArg();
    const v = this.readTfrExg816(param >> 4);
    this.writeTfrExg(param & 0x0f, v);
    if ((param & 0x0f) === 4) this.ldsEncountered = true; // TFR ..,S arms NMI
    this.idle(4);
  }

  private exg(): void {
    const param = this.fetchArg();
    let v1: number;
    let v2: number;
    if ((param & 0x80) !== 0) {
      v1 = this.readTfrExg816(param >> 4);
      v2 = this.readTfrExg816(param & 0x0f);
    } else {
      v1 = this.readExg168(param >> 4);
      v2 = this.readExg168(param & 0x0f);
    }
    this.writeTfrExg(param & 0x0f, v1);
    this.writeTfrExg(param >> 4, v2);
    this.idle(6);
  }

  // ---------------------------------------------------------------- branch conditions

  private cond(idx: number): boolean {
    const cc = this.cc;
    switch (idx) {
      case 0x0: return true; // BRA
      case 0x1: return false; // BRN
      case 0x2: return (cc & (CC_Z | CC_C)) === 0; // BHI
      case 0x3: return (cc & (CC_Z | CC_C)) !== 0; // BLS
      case 0x4: return (cc & CC_C) === 0; // BCC/BHS
      case 0x5: return (cc & CC_C) !== 0; // BCS/BLO
      case 0x6: return (cc & CC_Z) === 0; // BNE
      case 0x7: return (cc & CC_Z) !== 0; // BEQ
      case 0x8: return (cc & CC_V) === 0; // BVC
      case 0x9: return (cc & CC_V) !== 0; // BVS
      case 0xa: return (cc & CC_N) === 0; // BPL
      case 0xb: return (cc & CC_N) !== 0; // BMI
      case 0xc: return ((cc & CC_N) !== 0) === ((cc & CC_V) !== 0); // BGE
      case 0xd: return ((cc & CC_N) !== 0) !== ((cc & CC_V) !== 0); // BLT
      case 0xe: // BGT
        return ((cc & CC_N) !== 0) === ((cc & CC_V) !== 0) && (cc & CC_Z) === 0;
      default: // BLE
        return ((cc & CC_N) !== 0) !== ((cc & CC_V) !== 0) || (cc & CC_Z) !== 0;
    }
  }
}
