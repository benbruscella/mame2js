// Intel 8080 CPU emulator core for mamekit.
//
// Self-contained ES module: zero imports, zero runtime dependencies, no DOM.
// Flag/cycle behavior follows the MAME i8085 core in 8080 mode
// (src/devices/cpu/i8085/i8085.cpp, is_8085() == false), including:
//
//  - 8080 flag register layout: S Z 0 AC 0 P 1 C — bit 1 is always set,
//    bits 3 and 5 always clear (the physical register has no storage for
//    them; MAME normalizes on PUSH PSW, we keep F normalized at all times).
//  - P is PARITY of the result on every ALU op (the 8080 has no overflow
//    flag — this is the big difference from the Z80's V-on-arithmetic).
//  - AC (half-carry, bit 4) semantics per op: additions use the usual
//    carry-out of bit 3; SUB/SBB/CMP use the 8080's inverted borrow
//    convention (~(a ^ res ^ v) & 0x10 — AC set means NO borrow from bit 4);
//    ANA sets AC from the OR of bit 3 of the two operands (op_ana);
//    ORA/XRA clear it; INR/DCR compute it from the nibble; rotates,
//    STC/CMC/DAD touch only C; CMA touches nothing.
//  - DAA always ADDS the correction (no N flag on the 8080, unlike the Z80
//    which subtracts after SUB), and carry is sticky: C_out = C_in | (A > 0x99).
//  - Cycle counts from lut_cycles_8080 plus the taken deltas: conditional
//    CALL 11/17, conditional RET 5/11, conditional JMP always 10, XTHL 18.
//  - Undocumented opcodes behave as their documented aliases:
//    0x08/0x10/0x18/0x20/0x28/0x30/0x38 = NOP, 0xCB = JMP, 0xD9 = RET,
//    0xDD/0xED/0xFD = CALL.
//  - EI shadow: interrupts are accepted only after the instruction that
//    follows EI (m_after_ei); INTA jams the dataBus instruction (usually a
//    RST — Space Invaders uses RST 1 / RST 2); a packed 3-byte CALL is also
//    supported via dataBus = 0xcd | lo<<8 | hi<<16 (same convention as
//    z80.ts IM0).
//
// Deliberate deviations from MAME (documented, harmless):
//  - While halted, MAME re-executes the HLT opcode each loop (PC is
//    decremented onto it); we leave PC past the HLT and just consume the
//    same 7 cycles per idle step. The pushed return address on interrupt
//    wake-up is identical (the instruction after HLT).
//  - A jammed INTA instruction other than RST/packed-CALL executes with any
//    operand bytes fetched from memory at PC (MAME reads further INTA bytes
//    from the interrupt controller). Single-byte opcodes are exact.

export interface I8080Bus {
  read(addr: number): number; // memory read, addr 0..0xffff, returns 0..0xff
  write(addr: number, data: number): void;
  in(port: number): number; // io read, 8-bit port
  out(port: number, data: number): void;
}

// Flag bits (8080 layout)
const CF = 0x01;
const BIT1 = 0x02; // always set on the 8080
const PF = 0x04; // parity
const HF = 0x10; // aux carry
const ZF = 0x40;
const SF = 0x80;

// Bits with physical storage; everything else is forced to the fixed pattern.
const FMASK = SF | ZF | HF | PF | CF; // 0xd5
const FKEEP = SF | ZF | HF | PF; // preserved by rotates/STC/CMC

// Precomputed S/Z/P table (built once at module load) — MAME lut_zsp
const ZSP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = i;
  p ^= p >> 4;
  p ^= p >> 2;
  p ^= p >> 1;
  ZSP[i] =
    (i === 0 ? ZF : 0) | (i & SF) | ((p & 1) === 0 ? PF : 0);
}

export class I8080 {
  a = 0;
  f = BIT1;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  sp = 0;
  pc = 0;
  halted = false;
  inte = false; // interrupt enable flip-flop

  private bus: I8080Bus;
  private irqLine = false;
  private irqData = 0xff;
  private afterEI = false;

  constructor(bus: I8080Bus) {
    this.bus = bus;
    this.reset();
  }

  reset(): void {
    this.pc = 0;
    this.inte = false;
    this.halted = false;
    this.afterEI = false;
    // real RESET only forces PC and INTE; clear the rest for determinism
    this.a = 0;
    this.f = BIT1;
    this.b = 0;
    this.c = 0;
    this.d = 0;
    this.e = 0;
    this.h = 0;
    this.l = 0;
    this.sp = 0;
  }

  /** Level-triggered INT. dataBus is the instruction jammed on the bus
   *  during INTA — usually a RST opcode (Space Invaders: RST 1 / RST 2).
   *  A 3-byte CALL may be packed as 0xcd | lo<<8 | hi<<16. */
  setIrqLine(active: boolean, dataBus = 0xff): void {
    this.irqLine = active;
    if (active) this.irqData = dataBus;
  }

  /** Execute one instruction (or accept a pending interrupt).
   *  Returns clock cycles consumed. */
  step(): number {
    if (this.afterEI) {
      // the instruction after EI does not take an interrupt
      this.afterEI = false;
    } else if (this.irqLine && this.inte) {
      return this.takeIrq();
    }
    if (this.halted) return 7; // MAME re-executes HLT: 7 cycles per idle
    const op = this.bus.read(this.pc) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return this.exec(op);
  }

  /** step() until at least `cycles` are consumed; returns actual total. */
  run(cycles: number): number {
    let total = 0;
    while (total < cycles) total += this.step();
    return total;
  }

  // ------------------------------------------------------------------ helpers

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

  private push16(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v & 0xff);
  }

  private pop16(): number {
    const lo = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private bc(): number {
    return (this.b << 8) | this.c;
  }
  private de(): number {
    return (this.d << 8) | this.e;
  }
  private hl(): number {
    return (this.h << 8) | this.l;
  }
  private setHL(v: number): void {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }

  private getR8(idx: number): number {
    switch (idx) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 7: return this.a;
      default: return 0; // idx 6 (M) handled by callers
    }
  }

  private setR8(idx: number, v: number): void {
    v &= 0xff;
    switch (idx) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 7: this.a = v; break;
    }
  }

  private cond(idx: number): boolean {
    switch (idx) {
      case 0: return (this.f & ZF) === 0; // NZ
      case 1: return (this.f & ZF) !== 0; // Z
      case 2: return (this.f & CF) === 0; // NC
      case 3: return (this.f & CF) !== 0; // C
      case 4: return (this.f & PF) === 0; // PO (parity odd)
      case 5: return (this.f & PF) !== 0; // PE (parity even)
      case 6: return (this.f & SF) === 0; // P (plus)
      default: return (this.f & SF) !== 0; // M (minus)
    }
  }

  // ------------------------------------------------------------------ ALU (op_* in MAME)

  private addA(v: number): void {
    const a = this.a;
    const q = a + v;
    this.f = ZSP[q & 0xff] | ((q >> 8) & CF) | ((a ^ q ^ v) & HF) | BIT1;
    this.a = q & 0xff;
  }

  private adcA(v: number): void {
    const a = this.a;
    const q = a + v + (this.f & CF);
    this.f = ZSP[q & 0xff] | ((q >> 8) & CF) | ((a ^ q ^ v) & HF) | BIT1;
    this.a = q & 0xff;
  }

  private subA(v: number): void {
    const a = this.a;
    const q = a - v;
    // 8080 subtract AC convention: set = NO borrow out of bit 3
    this.f = ZSP[q & 0xff] | ((q >> 8) & CF) | (~(a ^ q ^ v) & HF) | BIT1;
    this.a = q & 0xff;
  }

  private sbbA(v: number): void {
    const a = this.a;
    const q = a - v - (this.f & CF);
    this.f = ZSP[q & 0xff] | ((q >> 8) & CF) | (~(a ^ q ^ v) & HF) | BIT1;
    this.a = q & 0xff;
  }

  private cmpA(v: number): void {
    const a = this.a;
    const q = a - v;
    this.f = ZSP[q & 0xff] | ((q >> 8) & CF) | (~(a ^ q ^ v) & HF) | BIT1;
  }

  private anaA(v: number): void {
    // 8080 ANA: AC = OR of bit 3 of the two operands (8085 always sets it)
    const hc = ((this.a | v) << 1) & HF;
    this.a = this.a & v & 0xff;
    this.f = ZSP[this.a] | hc | BIT1;
  }

  private xraA(v: number): void {
    this.a = (this.a ^ v) & 0xff;
    this.f = ZSP[this.a] | BIT1;
  }

  private oraA(v: number): void {
    this.a = (this.a | v) & 0xff;
    this.f = ZSP[this.a] | BIT1;
  }

  private alu8(idx: number, v: number): void {
    switch (idx) {
      case 0: this.addA(v); break;
      case 1: this.adcA(v); break;
      case 2: this.subA(v); break;
      case 3: this.sbbA(v); break;
      case 4: this.anaA(v); break;
      case 5: this.xraA(v); break;
      case 6: this.oraA(v); break;
      default: this.cmpA(v); break;
    }
  }

  private inr(v: number): number {
    const hc = (v & 0x0f) === 0x0f ? HF : 0;
    v = (v + 1) & 0xff;
    this.f = (this.f & CF) | ZSP[v] | hc | BIT1;
    return v;
  }

  private dcr(v: number): number {
    const hc = (v & 0x0f) !== 0 ? HF : 0; // no borrow from low nibble
    v = (v - 1) & 0xff;
    this.f = (this.f & CF) | ZSP[v] | hc | BIT1;
    return v;
  }

  private dad(v: number): void {
    const q = this.hl() + v;
    this.f = (this.f & FKEEP) | ((q >> 16) & CF) | BIT1;
    this.setHL(q & 0xffff);
  }

  private daa(): void {
    const a = this.a;
    let res = a;
    if ((this.f & HF) !== 0 || (a & 0x0f) > 9) res += 0x06;
    if ((this.f & CF) !== 0 || a > 0x99) res += 0x60;
    res &= 0xff;
    // carry is sticky: preserved C ORed with the >0x99 condition
    this.f =
      ((this.f & CF) | (a > 0x99 ? CF : 0)) |
      ((a ^ res) & HF) |
      ZSP[res] |
      BIT1;
    this.a = res;
  }

  // ------------------------------------------------------------------ control flow

  private jmp(taken: boolean): number {
    const addr = this.fetch16();
    if (taken) this.pc = addr;
    return 10; // 8080: jumps cost 10 taken or not (jmp_taken() == 0)
  }

  private call(taken: boolean): number {
    const addr = this.fetch16();
    if (taken) {
      this.push16(this.pc);
      this.pc = addr;
      return 17; // 11 + call_taken() (6)
    }
    return 11;
  }

  private retCc(taken: boolean): number {
    if (taken) {
      this.pc = this.pop16();
      return 11; // 5 + ret_taken() (6)
    }
    return 5;
  }

  private rst(n: number): number {
    this.push16(this.pc);
    this.pc = n << 3;
    return 11;
  }

  // ------------------------------------------------------------------ interrupts

  private takeIrq(): number {
    this.inte = false;
    this.halted = false; // PC already points past the HLT
    const v = this.irqData;
    const op = v & 0xff;
    if (op === 0xcd) {
      // packed CALL nn (operands in dataBus bits 8..23)
      this.push16(this.pc);
      this.pc = (v >> 8) & 0xffff;
      return 17;
    }
    // execute the jammed instruction (RST n is the normal case: 11 cycles)
    return this.exec(op);
  }

  // ------------------------------------------------------------------ dispatch

  private exec(op: number): number {
    if (op >= 0x40 && op < 0x80) {
      // MOV block (0x76 = HLT)
      if (op === 0x76) {
        this.halted = true;
        return 7;
      }
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (src === 6) {
        this.setR8(dst, this.rd(this.hl()));
        return 7;
      }
      if (dst === 6) {
        this.wr(this.hl(), this.getR8(src));
        return 7;
      }
      this.setR8(dst, this.getR8(src));
      return 5;
    }
    if (op >= 0x80 && op < 0xc0) {
      // ADD/ADC/SUB/SBB/ANA/XRA/ORA/CMP block
      const src = op & 7;
      if (src === 6) {
        this.alu8((op >> 3) & 7, this.rd(this.hl()));
        return 7;
      }
      this.alu8((op >> 3) & 7, this.getR8(src));
      return 4;
    }

    switch (op) {
      // ---- 0x00-0x3f
      case 0x00: // NOP
      case 0x08: // undocumented NOP aliases
      case 0x10:
      case 0x18:
      case 0x20:
      case 0x28:
      case 0x30:
      case 0x38:
        return 4;
      case 0x01: // LXI B,nnnn
        this.c = this.fetch();
        this.b = this.fetch();
        return 10;
      case 0x02: // STAX B
        this.wr(this.bc(), this.a);
        return 7;
      case 0x03: { // INX B (no flags on the 8080)
        const v = (this.bc() + 1) & 0xffff;
        this.b = v >> 8;
        this.c = v & 0xff;
        return 5;
      }
      case 0x04:
        this.b = this.inr(this.b);
        return 5;
      case 0x05:
        this.b = this.dcr(this.b);
        return 5;
      case 0x06:
        this.b = this.fetch();
        return 7;
      case 0x07: // RLC
        this.a = ((this.a << 1) | (this.a >> 7)) & 0xff;
        this.f = (this.f & FKEEP) | (this.a & CF) | BIT1;
        return 4;
      case 0x09: // DAD B
        this.dad(this.bc());
        return 10;
      case 0x0a: // LDAX B
        this.a = this.rd(this.bc());
        return 7;
      case 0x0b: { // DCX B
        const v = (this.bc() - 1) & 0xffff;
        this.b = v >> 8;
        this.c = v & 0xff;
        return 5;
      }
      case 0x0c:
        this.c = this.inr(this.c);
        return 5;
      case 0x0d:
        this.c = this.dcr(this.c);
        return 5;
      case 0x0e:
        this.c = this.fetch();
        return 7;
      case 0x0f: { // RRC
        const cy = this.a & 1;
        this.a = ((this.a >> 1) | (cy << 7)) & 0xff;
        this.f = (this.f & FKEEP) | cy | BIT1;
        return 4;
      }
      case 0x11:
        this.e = this.fetch();
        this.d = this.fetch();
        return 10;
      case 0x12: // STAX D
        this.wr(this.de(), this.a);
        return 7;
      case 0x13: { // INX D
        const v = (this.de() + 1) & 0xffff;
        this.d = v >> 8;
        this.e = v & 0xff;
        return 5;
      }
      case 0x14:
        this.d = this.inr(this.d);
        return 5;
      case 0x15:
        this.d = this.dcr(this.d);
        return 5;
      case 0x16:
        this.d = this.fetch();
        return 7;
      case 0x17: { // RAL
        const cy = this.a >> 7;
        this.a = ((this.a << 1) | (this.f & CF)) & 0xff;
        this.f = (this.f & FKEEP) | cy | BIT1;
        return 4;
      }
      case 0x19: // DAD D
        this.dad(this.de());
        return 10;
      case 0x1a: // LDAX D
        this.a = this.rd(this.de());
        return 7;
      case 0x1b: { // DCX D
        const v = (this.de() - 1) & 0xffff;
        this.d = v >> 8;
        this.e = v & 0xff;
        return 5;
      }
      case 0x1c:
        this.e = this.inr(this.e);
        return 5;
      case 0x1d:
        this.e = this.dcr(this.e);
        return 5;
      case 0x1e:
        this.e = this.fetch();
        return 7;
      case 0x1f: { // RAR
        const cy = this.a & 1;
        this.a = ((this.a >> 1) | ((this.f & CF) << 7)) & 0xff;
        this.f = (this.f & FKEEP) | cy | BIT1;
        return 4;
      }
      case 0x21:
        this.l = this.fetch();
        this.h = this.fetch();
        return 10;
      case 0x22: { // SHLD nnnn
        const addr = this.fetch16();
        this.wr(addr, this.l);
        this.wr(addr + 1, this.h);
        return 16;
      }
      case 0x23:
        this.setHL((this.hl() + 1) & 0xffff);
        return 5;
      case 0x24:
        this.h = this.inr(this.h);
        return 5;
      case 0x25:
        this.h = this.dcr(this.h);
        return 5;
      case 0x26:
        this.h = this.fetch();
        return 7;
      case 0x27: // DAA
        this.daa();
        return 4;
      case 0x29: { // DAD H
        this.dad(this.hl());
        return 10;
      }
      case 0x2a: { // LHLD nnnn
        const addr = this.fetch16();
        this.l = this.rd(addr);
        this.h = this.rd(addr + 1);
        return 16;
      }
      case 0x2b:
        this.setHL((this.hl() - 1) & 0xffff);
        return 5;
      case 0x2c:
        this.l = this.inr(this.l);
        return 5;
      case 0x2d:
        this.l = this.dcr(this.l);
        return 5;
      case 0x2e:
        this.l = this.fetch();
        return 7;
      case 0x2f: // CMA (no flags on the 8080)
        this.a = this.a ^ 0xff;
        return 4;
      case 0x31:
        this.sp = this.fetch16();
        return 10;
      case 0x32: { // STA nnnn
        const addr = this.fetch16();
        this.wr(addr, this.a);
        return 13;
      }
      case 0x33:
        this.sp = (this.sp + 1) & 0xffff;
        return 5;
      case 0x34: { // INR M
        const addr = this.hl();
        this.wr(addr, this.inr(this.rd(addr)));
        return 10;
      }
      case 0x35: { // DCR M
        const addr = this.hl();
        this.wr(addr, this.dcr(this.rd(addr)));
        return 10;
      }
      case 0x36: // MVI M,nn
        this.wr(this.hl(), this.fetch());
        return 10;
      case 0x37: // STC
        this.f = (this.f & FKEEP) | CF | BIT1;
        return 4;
      case 0x39: // DAD SP
        this.dad(this.sp);
        return 10;
      case 0x3a: { // LDA nnnn
        const addr = this.fetch16();
        this.a = this.rd(addr);
        return 13;
      }
      case 0x3b:
        this.sp = (this.sp - 1) & 0xffff;
        return 5;
      case 0x3c:
        this.a = this.inr(this.a);
        return 5;
      case 0x3d:
        this.a = this.dcr(this.a);
        return 5;
      case 0x3e:
        this.a = this.fetch();
        return 7;
      case 0x3f: // CMC
        this.f = (this.f & FKEEP) | (~this.f & CF) | BIT1;
        return 4;

      // ---- 0xc0-0xff
      case 0xc0: // RNZ
      case 0xc8: // RZ
      case 0xd0: // RNC
      case 0xd8: // RC
      case 0xe0: // RPO
      case 0xe8: // RPE
      case 0xf0: // RP
      case 0xf8: // RM
        return this.retCc(this.cond((op >> 3) & 7));
      case 0xc1: { // POP B
        const v = this.pop16();
        this.b = v >> 8;
        this.c = v & 0xff;
        return 10;
      }
      case 0xc2: // Jcc nnnn
      case 0xca:
      case 0xd2:
      case 0xda:
      case 0xe2:
      case 0xea:
      case 0xf2:
      case 0xfa:
        return this.jmp(this.cond((op >> 3) & 7));
      case 0xc3: // JMP nnnn
      case 0xcb: // undocumented JMP alias
        return this.jmp(true);
      case 0xc4: // Ccc nnnn
      case 0xcc:
      case 0xd4:
      case 0xdc:
      case 0xe4:
      case 0xec:
      case 0xf4:
      case 0xfc:
        return this.call(this.cond((op >> 3) & 7));
      case 0xc5: // PUSH B
        this.push16(this.bc());
        return 11;
      case 0xc6: // ADI nn
        this.addA(this.fetch());
        return 7;
      case 0xc7: // RST 0..7
      case 0xcf:
      case 0xd7:
      case 0xdf:
      case 0xe7:
      case 0xef:
      case 0xf7:
      case 0xff:
        return this.rst((op >> 3) & 7);
      case 0xc9: // RET
      case 0xd9: // undocumented RET alias
        this.pc = this.pop16();
        return 10;
      case 0xcd: // CALL nnnn
      case 0xdd: // undocumented CALL aliases
      case 0xed:
      case 0xfd:
        return this.call(true);
      case 0xce: // ACI nn
        this.adcA(this.fetch());
        return 7;
      case 0xd1: { // POP D
        const v = this.pop16();
        this.d = v >> 8;
        this.e = v & 0xff;
        return 10;
      }
      case 0xd3: // OUT nn
        this.bus.out(this.fetch(), this.a);
        return 10;
      case 0xd5: // PUSH D
        this.push16(this.de());
        return 11;
      case 0xd6: // SUI nn
        this.subA(this.fetch());
        return 7;
      case 0xdb: // IN nn
        this.a = this.bus.in(this.fetch()) & 0xff;
        return 10;
      case 0xde: // SBI nn
        this.sbbA(this.fetch());
        return 7;
      case 0xe1: // POP H
        this.setHL(this.pop16());
        return 10;
      case 0xe3: { // XTHL
        const t = this.rd(this.sp) | (this.rd(this.sp + 1) << 8);
        this.wr(this.sp, this.l);
        this.wr(this.sp + 1, this.h);
        this.setHL(t);
        return 18;
      }
      case 0xe5: // PUSH H
        this.push16(this.hl());
        return 11;
      case 0xe6: // ANI nn
        this.anaA(this.fetch());
        return 7;
      case 0xe9: // PCHL
        this.pc = this.hl();
        return 5;
      case 0xeb: { // XCHG
        let t = this.d;
        this.d = this.h;
        this.h = t;
        t = this.e;
        this.e = this.l;
        this.l = t;
        return 4;
      }
      case 0xee: // XRI nn
        this.xraA(this.fetch());
        return 7;
      case 0xf1: { // POP PSW (only the 5 real flag bits have storage)
        const v = this.pop16();
        this.a = (v >> 8) & 0xff;
        this.f = (v & FMASK) | BIT1;
        return 10;
      }
      case 0xf3: // DI
        this.inte = false;
        return 4;
      case 0xf5: // PUSH PSW (F pushed with bit1 set, bits 3/5 clear)
        this.f = (this.f & FMASK) | BIT1;
        this.push16((this.a << 8) | this.f);
        return 11;
      case 0xf6: // ORI nn
        this.oraA(this.fetch());
        return 7;
      case 0xf9: // SPHL
        this.sp = this.hl();
        return 5;
      case 0xfb: // EI (interrupts enabled after the NEXT instruction)
        this.inte = true;
        this.afterEI = true;
        return 4;
      case 0xfe: // CPI nn
        this.cmpA(this.fetch());
        return 7;
      default:
        // unreachable: all 256 opcodes covered
        return 4;
    }
  }
}
