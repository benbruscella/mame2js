// Zilog Z80 CPU emulator core for mamekit.
//
// Self-contained ES module: zero imports, zero runtime dependencies, no DOM.
// Flag/cycle behavior follows the MAME Z80 core (src/devices/cpu/z80),
// including undocumented opcodes (SLL, DD/FD IXH/IXL/IYH/IYL, DDCB/FDCB
// register-copy forms, ED duplicates), undocumented X/Y flags, and WZ/MEMPTR
// where it affects BIT n,(HL) / BIT n,(IX+d).
//
// Deliberate simplifications vs. latest MAME:
//  - SCF/CCF use the classic NMOS behavior (X/Y from A) without modeling the
//    Q register.
//  - INIR/OTIR/INDR/OTDR interrupted-repeat flag adjustments are not modeled
//    beyond X/Y <- PCH on repeat.

export interface Z80Bus {
  read(addr: number): number; // memory read, addr 0..0xffff, returns 0..0xff
  write(addr: number, data: number): void;
  in(port: number): number; // io read, 16-bit port address on the bus
  out(port: number, data: number): void;
}

// Flag bits
const CF = 0x01;
const NF = 0x02;
const PF = 0x04; // parity
const VF = 0x04; // overflow (same bit)
const XF = 0x08; // undocumented bit 3
const HF = 0x10;
const YF = 0x20; // undocumented bit 5
const ZF = 0x40;
const SF = 0x80;

// Precomputed flag tables (built once at module load)
const SZ = new Uint8Array(256); // S, Z, X, Y
const SZ_BIT = new Uint8Array(256); // as SZ but Z also sets P (for BIT)
const SZP = new Uint8Array(256); // SZ plus parity
const SZHV_INC = new Uint8Array(256); // INC r flags (except C)
const SZHV_DEC = new Uint8Array(256); // DEC r flags (except C)

for (let i = 0; i < 256; i++) {
  let p = i;
  p ^= p >> 4;
  p ^= p >> 2;
  p ^= p >> 1;
  const parityEven = (p & 1) === 0;
  SZ[i] = (i !== 0 ? i & SF : ZF) | (i & (YF | XF));
  SZ_BIT[i] = (i !== 0 ? i & SF : ZF | PF) | (i & (YF | XF));
  SZP[i] = SZ[i] | (parityEven ? PF : 0);
  let f = SZ[i];
  if (i === 0x80) f |= VF;
  if ((i & 0x0f) === 0x00) f |= HF;
  SZHV_INC[i] = f;
  f = SZ[i] | NF;
  if (i === 0x7f) f |= VF;
  if ((i & 0x0f) === 0x0f) f |= HF;
  SZHV_DEC[i] = f;
}

export class Z80 {
  // main register set (8-bit unless noted)
  a = 0xff;
  f = 0xff;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  // shadow register set
  a2 = 0;
  f2 = 0;
  b2 = 0;
  c2 = 0;
  d2 = 0;
  e2 = 0;
  h2 = 0;
  l2 = 0;
  // 16-bit registers
  ix = 0xffff;
  iy = 0xffff;
  sp = 0xffff;
  pc = 0;
  wz = 0; // MEMPTR
  // special
  i = 0;
  r = 0;
  iff1 = 0;
  iff2 = 0;
  im = 0;
  halted = false;

  private bus: Z80Bus;
  private irqLine = false;
  private irqData = 0xff;
  private nmiPending = false;
  private afterEI = false;

  constructor(bus: Z80Bus) {
    this.bus = bus;
    this.reset();
  }

  reset(): void {
    this.pc = 0;
    this.wz = 0;
    this.i = 0;
    this.r = 0;
    this.im = 0;
    this.iff1 = 0;
    this.iff2 = 0;
    this.halted = false;
    this.nmiPending = false;
    this.afterEI = false;
    this.a = 0xff;
    this.f = 0xff;
    this.sp = 0xffff;
    this.ix = 0xffff;
    this.iy = 0xffff;
  }

  /** Level-triggered maskable INT. dataBus is the byte placed on the bus
   *  during interrupt acknowledge (IM0 opcode / IM2 vector). For IM0 CALL,
   *  the 16-bit operand may be packed into bits 8..23 (0xcd | lo<<8 | hi<<16). */
  setIrqLine(active: boolean, dataBus = 0xff): void {
    this.irqLine = active;
    if (active) this.irqData = dataBus;
  }

  /** Edge-triggered NMI pulse. */
  nmi(): void {
    this.nmiPending = true;
  }

  /** Execute one instruction (or accept a pending interrupt).
   *  Returns T-states consumed. */
  step(): number {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.halted = false;
      this.iff1 = 0;
      this.incR();
      this.push16(this.pc);
      this.pc = 0x0066;
      this.wz = 0x0066;
      return 11;
    }
    if (this.afterEI) {
      // interrupts are not accepted until after the instruction following EI
      this.afterEI = false;
    } else if (this.irqLine && this.iff1) {
      return this.takeIrq();
    }
    if (this.halted) {
      this.incR();
      return 4;
    }
    this.incR();
    const op = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return this.execBase(op);
  }

  /** step() until at least `tstates` are consumed; returns actual total. */
  run(tstates: number): number {
    let total = 0;
    while (total < tstates) total += this.step();
    return total;
  }

  // ------------------------------------------------------------------ helpers

  private incR(): void {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
  }

  private rd(addr: number): number {
    return this.bus.read(addr & 0xffff) & 0xff;
  }

  private wr(addr: number, data: number): void {
    this.bus.write(addr & 0xffff, data & 0xff);
  }

  private rd16(addr: number): number {
    return this.rd(addr) | (this.rd(addr + 1) << 8);
  }

  private wr16(addr: number, v: number): void {
    this.wr(addr, v & 0xff);
    this.wr(addr + 1, (v >> 8) & 0xff);
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
  private setBC(v: number): void {
    this.b = (v >> 8) & 0xff;
    this.c = v & 0xff;
  }
  private setDE(v: number): void {
    this.d = (v >> 8) & 0xff;
    this.e = v & 0xff;
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
      default: return 0; // idx 6 handled by callers
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

  // DD/FD register file: H/L replaced by IXH/IXL or IYH/IYL
  private getRX(idx: number, useIX: boolean): number {
    if (idx === 4) return (useIX ? this.ix : this.iy) >> 8;
    if (idx === 5) return (useIX ? this.ix : this.iy) & 0xff;
    return this.getR8(idx);
  }

  private setRX(idx: number, v: number, useIX: boolean): void {
    v &= 0xff;
    if (idx === 4) {
      if (useIX) this.ix = (this.ix & 0x00ff) | (v << 8);
      else this.iy = (this.iy & 0x00ff) | (v << 8);
    } else if (idx === 5) {
      if (useIX) this.ix = (this.ix & 0xff00) | v;
      else this.iy = (this.iy & 0xff00) | v;
    } else {
      this.setR8(idx, v);
    }
  }

  private cond(idx: number): boolean {
    switch (idx) {
      case 0: return (this.f & ZF) === 0; // NZ
      case 1: return (this.f & ZF) !== 0; // Z
      case 2: return (this.f & CF) === 0; // NC
      case 3: return (this.f & CF) !== 0; // C
      case 4: return (this.f & PF) === 0; // PO
      case 5: return (this.f & PF) !== 0; // PE
      case 6: return (this.f & SF) === 0; // P
      default: return (this.f & SF) !== 0; // M
    }
  }

  // ------------------------------------------------------------------ 8-bit ALU

  private addA(v: number): void {
    const a = this.a;
    const res = a + v;
    this.f =
      SZ[res & 0xff] |
      ((res >> 8) & CF) |
      ((a ^ res ^ v) & HF) |
      (((v ^ a ^ 0x80) & (v ^ res) & 0x80) >> 5);
    this.a = res & 0xff;
  }

  private adcA(v: number): void {
    const a = this.a;
    const res = a + v + (this.f & CF);
    this.f =
      SZ[res & 0xff] |
      ((res >> 8) & CF) |
      ((a ^ res ^ v) & HF) |
      (((v ^ a ^ 0x80) & (v ^ res) & 0x80) >> 5);
    this.a = res & 0xff;
  }

  private subA(v: number): void {
    const a = this.a;
    const res = a - v;
    this.f =
      SZ[res & 0xff] |
      NF |
      ((res >> 8) & CF) |
      ((a ^ res ^ v) & HF) |
      (((v ^ a) & (a ^ res) & 0x80) >> 5);
    this.a = res & 0xff;
  }

  private sbcA(v: number): void {
    const a = this.a;
    const res = a - v - (this.f & CF);
    this.f =
      SZ[res & 0xff] |
      NF |
      ((res >> 8) & CF) |
      ((a ^ res ^ v) & HF) |
      (((v ^ a) & (a ^ res) & 0x80) >> 5);
    this.a = res & 0xff;
  }

  private andA(v: number): void {
    this.a = this.a & v & 0xff;
    this.f = SZP[this.a] | HF;
  }

  private xorA(v: number): void {
    this.a = (this.a ^ v) & 0xff;
    this.f = SZP[this.a];
  }

  private orA(v: number): void {
    this.a = (this.a | v) & 0xff;
    this.f = SZP[this.a];
  }

  private cpA(v: number): void {
    const a = this.a;
    const res = a - v;
    // X/Y flags come from the operand, not the result
    this.f =
      (SZ[res & 0xff] & ~(YF | XF)) |
      (v & (YF | XF)) |
      NF |
      ((res >> 8) & CF) |
      ((a ^ res ^ v) & HF) |
      (((v ^ a) & (a ^ res) & 0x80) >> 5);
  }

  private alu8(idx: number, v: number): void {
    switch (idx) {
      case 0: this.addA(v); break;
      case 1: this.adcA(v); break;
      case 2: this.subA(v); break;
      case 3: this.sbcA(v); break;
      case 4: this.andA(v); break;
      case 5: this.xorA(v); break;
      case 6: this.orA(v); break;
      default: this.cpA(v); break;
    }
  }

  private inc8(v: number): number {
    const res = (v + 1) & 0xff;
    this.f = (this.f & CF) | SZHV_INC[res];
    return res;
  }

  private dec8(v: number): number {
    const res = (v - 1) & 0xff;
    this.f = (this.f & CF) | SZHV_DEC[res];
    return res;
  }

  // ------------------------------------------------------------------ 16-bit ALU

  private add16(dst: number, src: number): number {
    this.wz = (dst + 1) & 0xffff;
    const res = dst + src;
    this.f =
      (this.f & (SF | ZF | VF)) |
      (((dst ^ res ^ src) >> 8) & HF) |
      ((res >> 16) & CF) |
      ((res >> 8) & (YF | XF));
    return res & 0xffff;
  }

  private adcHL(v: number): void {
    const hl = this.hl();
    this.wz = (hl + 1) & 0xffff;
    const res = hl + v + (this.f & CF);
    this.f =
      (((hl ^ res ^ v) >> 8) & HF) |
      ((res >> 16) & CF) |
      ((res >> 8) & (SF | YF | XF)) |
      ((res & 0xffff) !== 0 ? 0 : ZF) |
      (((v ^ hl ^ 0x8000) & (v ^ res) & 0x8000) >> 13);
    this.setHL(res & 0xffff);
  }

  private sbcHL(v: number): void {
    const hl = this.hl();
    this.wz = (hl + 1) & 0xffff;
    const res = hl - v - (this.f & CF);
    this.f =
      (((hl ^ res ^ v) >> 8) & HF) |
      NF |
      ((res >> 16) & CF) |
      ((res >> 8) & (SF | YF | XF)) |
      ((res & 0xffff) !== 0 ? 0 : ZF) |
      (((v ^ hl) & (hl ^ res) & 0x8000) >> 13);
    this.setHL(res & 0xffff);
  }

  // ------------------------------------------------------------------ rotates/shifts (CB)

  private rot8(idx: number, v: number): number {
    let c: number;
    let res: number;
    switch (idx) {
      case 0: // RLC
        c = v >> 7;
        res = ((v << 1) | c) & 0xff;
        break;
      case 1: // RRC
        c = v & 1;
        res = ((v >> 1) | (c << 7)) & 0xff;
        break;
      case 2: // RL
        c = v >> 7;
        res = ((v << 1) | (this.f & CF)) & 0xff;
        break;
      case 3: // RR
        c = v & 1;
        res = ((v >> 1) | ((this.f & CF) << 7)) & 0xff;
        break;
      case 4: // SLA
        c = v >> 7;
        res = (v << 1) & 0xff;
        break;
      case 5: // SRA
        c = v & 1;
        res = ((v >> 1) | (v & 0x80)) & 0xff;
        break;
      case 6: // SLL (undocumented)
        c = v >> 7;
        res = ((v << 1) | 0x01) & 0xff;
        break;
      default: // SRL
        c = v & 1;
        res = v >> 1;
        break;
    }
    this.f = SZP[res] | c;
    return res;
  }

  // ------------------------------------------------------------------ misc ops

  private daa(): void {
    const a = this.a;
    let res = a;
    if (this.f & NF) {
      if ((this.f & HF) !== 0 || (a & 0x0f) > 9) res -= 6;
      if ((this.f & CF) !== 0 || a > 0x99) res -= 0x60;
    } else {
      if ((this.f & HF) !== 0 || (a & 0x0f) > 9) res += 6;
      if ((this.f & CF) !== 0 || a > 0x99) res += 0x60;
    }
    res &= 0xff;
    this.f =
      (this.f & (CF | NF)) | (a > 0x99 ? CF : 0) | ((a ^ res) & HF) | SZP[res];
    this.a = res;
  }

  private rrd(): void {
    const hl = this.hl();
    const t = this.rd(hl);
    this.wz = (hl + 1) & 0xffff;
    this.wr(hl, ((t >> 4) | (this.a << 4)) & 0xff);
    this.a = (this.a & 0xf0) | (t & 0x0f);
    this.f = (this.f & CF) | SZP[this.a];
  }

  private rld(): void {
    const hl = this.hl();
    const t = this.rd(hl);
    this.wz = (hl + 1) & 0xffff;
    this.wr(hl, ((t << 4) | (this.a & 0x0f)) & 0xff);
    this.a = (this.a & 0xf0) | (t >> 4);
    this.f = (this.f & CF) | SZP[this.a];
  }

  // ------------------------------------------------------------------ interrupts

  private takeIrq(): number {
    this.halted = false;
    this.iff1 = 0;
    this.iff2 = 0;
    this.incR();
    const v = this.irqData;
    if (this.im === 2) {
      this.push16(this.pc);
      const addr = ((this.i << 8) | (v & 0xff)) & 0xffff; // vector used as-is (MAME convention)
      this.pc = this.rd16(addr);
      this.wz = this.pc;
      return 19;
    }
    if (this.im === 1) {
      this.push16(this.pc);
      this.pc = 0x0038;
      this.wz = 0x0038;
      return 13;
    }
    // IM 0: execute the byte on the data bus. RST xx and CALL nn supported;
    // CALL operands may be packed into irqData bits 8..23.
    const op = v & 0xff;
    if (op === 0xcd) {
      this.push16(this.pc);
      this.pc = ((v >> 8) & 0xffff) & 0xffff;
      this.wz = this.pc;
      return 19; // CALL (17) + 2 for interrupt acknowledge
    }
    if ((op & 0xc7) === 0xc7) {
      this.push16(this.pc);
      this.pc = op & 0x38;
      this.wz = this.pc;
      return 13; // RST (11) + 2
    }
    // fallback: execute the byte as a regular instruction (+2 T)
    return 2 + this.execBase(op);
  }

  // ------------------------------------------------------------------ base opcodes

  private execBase(op: number): number {
    if (op >= 0x40 && op < 0x80) {
      // LD r,r' block (0x76 = HALT)
      if (op === 0x76) {
        this.halted = true;
        return 4;
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
      return 4;
    }
    if (op >= 0x80 && op < 0xc0) {
      // ALU A,r block
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
        return 4;
      case 0x01: // LD BC,nn
        this.c = this.fetch();
        this.b = this.fetch();
        return 10;
      case 0x02: { // LD (BC),A
        const addr = this.bc();
        this.wr(addr, this.a);
        this.wz = ((addr + 1) & 0xff) | (this.a << 8);
        return 7;
      }
      case 0x03: { // INC BC
        const v = (this.bc() + 1) & 0xffff;
        this.setBC(v);
        return 6;
      }
      case 0x04:
        this.b = this.inc8(this.b);
        return 4;
      case 0x05:
        this.b = this.dec8(this.b);
        return 4;
      case 0x06:
        this.b = this.fetch();
        return 7;
      case 0x07: { // RLCA
        this.a = ((this.a << 1) | (this.a >> 7)) & 0xff;
        this.f = (this.f & (SF | ZF | PF)) | (this.a & (CF | YF | XF));
        return 4;
      }
      case 0x08: { // EX AF,AF'
        let t = this.a;
        this.a = this.a2;
        this.a2 = t;
        t = this.f;
        this.f = this.f2;
        this.f2 = t;
        return 4;
      }
      case 0x09:
        this.setHL(this.add16(this.hl(), this.bc()));
        return 11;
      case 0x0a: { // LD A,(BC)
        const addr = this.bc();
        this.a = this.rd(addr);
        this.wz = (addr + 1) & 0xffff;
        return 7;
      }
      case 0x0b:
        this.setBC((this.bc() - 1) & 0xffff);
        return 6;
      case 0x0c:
        this.c = this.inc8(this.c);
        return 4;
      case 0x0d:
        this.c = this.dec8(this.c);
        return 4;
      case 0x0e:
        this.c = this.fetch();
        return 7;
      case 0x0f: { // RRCA
        const cy = this.a & 1;
        this.a = ((this.a >> 1) | (cy << 7)) & 0xff;
        this.f = (this.f & (SF | ZF | PF)) | cy | (this.a & (YF | XF));
        return 4;
      }
      case 0x10: { // DJNZ d
        const d = this.fetchSigned();
        this.b = (this.b - 1) & 0xff;
        if (this.b !== 0) {
          this.pc = (this.pc + d) & 0xffff;
          this.wz = this.pc;
          return 13;
        }
        return 8;
      }
      case 0x11:
        this.e = this.fetch();
        this.d = this.fetch();
        return 10;
      case 0x12: { // LD (DE),A
        const addr = this.de();
        this.wr(addr, this.a);
        this.wz = ((addr + 1) & 0xff) | (this.a << 8);
        return 7;
      }
      case 0x13:
        this.setDE((this.de() + 1) & 0xffff);
        return 6;
      case 0x14:
        this.d = this.inc8(this.d);
        return 4;
      case 0x15:
        this.d = this.dec8(this.d);
        return 4;
      case 0x16:
        this.d = this.fetch();
        return 7;
      case 0x17: { // RLA
        const cy = this.a >> 7;
        this.a = ((this.a << 1) | (this.f & CF)) & 0xff;
        this.f = (this.f & (SF | ZF | PF)) | cy | (this.a & (YF | XF));
        return 4;
      }
      case 0x18: { // JR d
        const d = this.fetchSigned();
        this.pc = (this.pc + d) & 0xffff;
        this.wz = this.pc;
        return 12;
      }
      case 0x19:
        this.setHL(this.add16(this.hl(), this.de()));
        return 11;
      case 0x1a: { // LD A,(DE)
        const addr = this.de();
        this.a = this.rd(addr);
        this.wz = (addr + 1) & 0xffff;
        return 7;
      }
      case 0x1b:
        this.setDE((this.de() - 1) & 0xffff);
        return 6;
      case 0x1c:
        this.e = this.inc8(this.e);
        return 4;
      case 0x1d:
        this.e = this.dec8(this.e);
        return 4;
      case 0x1e:
        this.e = this.fetch();
        return 7;
      case 0x1f: { // RRA
        const cy = this.a & 1;
        this.a = ((this.a >> 1) | ((this.f & CF) << 7)) & 0xff;
        this.f = (this.f & (SF | ZF | PF)) | cy | (this.a & (YF | XF));
        return 4;
      }
      case 0x20: // JR NZ,d
      case 0x28: // JR Z,d
      case 0x30: // JR NC,d
      case 0x38: { // JR C,d
        const d = this.fetchSigned();
        if (this.cond((op >> 3) & 3)) {
          this.pc = (this.pc + d) & 0xffff;
          this.wz = this.pc;
          return 12;
        }
        return 7;
      }
      case 0x21:
        this.l = this.fetch();
        this.h = this.fetch();
        return 10;
      case 0x22: { // LD (nn),HL
        const addr = this.fetch16();
        this.wr16(addr, this.hl());
        this.wz = (addr + 1) & 0xffff;
        return 16;
      }
      case 0x23:
        this.setHL((this.hl() + 1) & 0xffff);
        return 6;
      case 0x24:
        this.h = this.inc8(this.h);
        return 4;
      case 0x25:
        this.h = this.dec8(this.h);
        return 4;
      case 0x26:
        this.h = this.fetch();
        return 7;
      case 0x27:
        this.daa();
        return 4;
      case 0x29: {
        const hl = this.hl();
        this.setHL(this.add16(hl, hl));
        return 11;
      }
      case 0x2a: { // LD HL,(nn)
        const addr = this.fetch16();
        this.setHL(this.rd16(addr));
        this.wz = (addr + 1) & 0xffff;
        return 16;
      }
      case 0x2b:
        this.setHL((this.hl() - 1) & 0xffff);
        return 6;
      case 0x2c:
        this.l = this.inc8(this.l);
        return 4;
      case 0x2d:
        this.l = this.dec8(this.l);
        return 4;
      case 0x2e:
        this.l = this.fetch();
        return 7;
      case 0x2f: // CPL
        this.a = this.a ^ 0xff;
        this.f =
          (this.f & (SF | ZF | PF | CF)) | HF | NF | (this.a & (YF | XF));
        return 4;
      case 0x31:
        this.sp = this.fetch16();
        return 10;
      case 0x32: { // LD (nn),A
        const addr = this.fetch16();
        this.wr(addr, this.a);
        this.wz = ((addr + 1) & 0xff) | (this.a << 8);
        return 13;
      }
      case 0x33:
        this.sp = (this.sp + 1) & 0xffff;
        return 6;
      case 0x34: { // INC (HL)
        const addr = this.hl();
        this.wr(addr, this.inc8(this.rd(addr)));
        return 11;
      }
      case 0x35: { // DEC (HL)
        const addr = this.hl();
        this.wr(addr, this.dec8(this.rd(addr)));
        return 11;
      }
      case 0x36: // LD (HL),n
        this.wr(this.hl(), this.fetch());
        return 10;
      case 0x37: // SCF (NMOS: X/Y from A)
        this.f = (this.f & (SF | ZF | PF)) | CF | (this.a & (YF | XF));
        return 4;
      case 0x39:
        this.setHL(this.add16(this.hl(), this.sp));
        return 11;
      case 0x3a: { // LD A,(nn)
        const addr = this.fetch16();
        this.a = this.rd(addr);
        this.wz = (addr + 1) & 0xffff;
        return 13;
      }
      case 0x3b:
        this.sp = (this.sp - 1) & 0xffff;
        return 6;
      case 0x3c:
        this.a = this.inc8(this.a);
        return 4;
      case 0x3d:
        this.a = this.dec8(this.a);
        return 4;
      case 0x3e:
        this.a = this.fetch();
        return 7;
      case 0x3f: // CCF
        this.f =
          ((this.f & (SF | ZF | PF | CF)) |
            ((this.f & CF) << 4) |
            (this.a & (YF | XF))) ^
          CF;
        return 4;

      // ---- 0xc0-0xff
      case 0xc0:
      case 0xc8:
      case 0xd0:
      case 0xd8:
      case 0xe0:
      case 0xe8:
      case 0xf0:
      case 0xf8: // RET cc
        if (this.cond((op >> 3) & 7)) {
          this.pc = this.pop16();
          this.wz = this.pc;
          return 11;
        }
        return 5;
      case 0xc1:
        this.setBC(this.pop16());
        return 10;
      case 0xc2:
      case 0xca:
      case 0xd2:
      case 0xda:
      case 0xe2:
      case 0xea:
      case 0xf2:
      case 0xfa: { // JP cc,nn
        const addr = this.fetch16();
        this.wz = addr;
        if (this.cond((op >> 3) & 7)) this.pc = addr;
        return 10;
      }
      case 0xc3: // JP nn
        this.pc = this.fetch16();
        this.wz = this.pc;
        return 10;
      case 0xc4:
      case 0xcc:
      case 0xd4:
      case 0xdc:
      case 0xe4:
      case 0xec:
      case 0xf4:
      case 0xfc: { // CALL cc,nn
        const addr = this.fetch16();
        this.wz = addr;
        if (this.cond((op >> 3) & 7)) {
          this.push16(this.pc);
          this.pc = addr;
          return 17;
        }
        return 10;
      }
      case 0xc5:
        this.push16(this.bc());
        return 11;
      case 0xc6:
        this.addA(this.fetch());
        return 7;
      case 0xc7:
      case 0xcf:
      case 0xd7:
      case 0xdf:
      case 0xe7:
      case 0xef:
      case 0xf7:
      case 0xff: // RST p
        this.push16(this.pc);
        this.pc = op & 0x38;
        this.wz = this.pc;
        return 11;
      case 0xc9: // RET
        this.pc = this.pop16();
        this.wz = this.pc;
        return 10;
      case 0xcb:
        return this.execCB();
      case 0xcd: { // CALL nn
        const addr = this.fetch16();
        this.wz = addr;
        this.push16(this.pc);
        this.pc = addr;
        return 17;
      }
      case 0xce:
        this.adcA(this.fetch());
        return 7;
      case 0xd1:
        this.setDE(this.pop16());
        return 10;
      case 0xd3: { // OUT (n),A
        const port = this.fetch() | (this.a << 8);
        this.bus.out(port, this.a);
        this.wz = ((port + 1) & 0xff) | (this.a << 8);
        return 11;
      }
      case 0xd5:
        this.push16(this.de());
        return 11;
      case 0xd6:
        this.subA(this.fetch());
        return 7;
      case 0xd9: { // EXX
        let t = this.b;
        this.b = this.b2;
        this.b2 = t;
        t = this.c;
        this.c = this.c2;
        this.c2 = t;
        t = this.d;
        this.d = this.d2;
        this.d2 = t;
        t = this.e;
        this.e = this.e2;
        this.e2 = t;
        t = this.h;
        this.h = this.h2;
        this.h2 = t;
        t = this.l;
        this.l = this.l2;
        this.l2 = t;
        return 4;
      }
      case 0xdb: { // IN A,(n)
        const port = this.fetch() | (this.a << 8);
        this.a = this.bus.in(port) & 0xff;
        this.wz = (port + 1) & 0xffff;
        return 11;
      }
      case 0xdd:
        return this.execXY(true);
      case 0xde:
        this.sbcA(this.fetch());
        return 7;
      case 0xe1:
        this.setHL(this.pop16());
        return 10;
      case 0xe3: { // EX (SP),HL
        const t = this.rd16(this.sp);
        this.wr16(this.sp, this.hl());
        this.setHL(t);
        this.wz = t;
        return 19;
      }
      case 0xe5:
        this.push16(this.hl());
        return 11;
      case 0xe6:
        this.andA(this.fetch());
        return 7;
      case 0xe9: // JP (HL)
        this.pc = this.hl();
        return 4;
      case 0xeb: { // EX DE,HL
        let t = this.d;
        this.d = this.h;
        this.h = t;
        t = this.e;
        this.e = this.l;
        this.l = t;
        return 4;
      }
      case 0xed:
        return this.execED();
      case 0xee:
        this.xorA(this.fetch());
        return 7;
      case 0xf1: { // POP AF
        const v = this.pop16();
        this.a = (v >> 8) & 0xff;
        this.f = v & 0xff;
        return 10;
      }
      case 0xf3: // DI
        this.iff1 = 0;
        this.iff2 = 0;
        return 4;
      case 0xf5:
        this.push16((this.a << 8) | this.f);
        return 11;
      case 0xf6:
        this.orA(this.fetch());
        return 7;
      case 0xf9: // LD SP,HL
        this.sp = this.hl();
        return 6;
      case 0xfb: // EI
        this.iff1 = 1;
        this.iff2 = 1;
        this.afterEI = true;
        return 4;
      case 0xfd:
        return this.execXY(false);
      case 0xfe:
        this.cpA(this.fetch());
        return 7;
      default:
        // unreachable (all 256 opcodes covered)
        return 4;
    }
  }

  private fetchSigned(): number {
    const v = this.fetch();
    return (v & 0x80) !== 0 ? v - 256 : v;
  }

  // ------------------------------------------------------------------ CB prefix

  private execCB(): number {
    this.incR();
    const op = this.fetch();
    const grp = op >> 6;
    const bitn = (op >> 3) & 7;
    const src = op & 7;
    if (grp === 1) {
      // BIT b,r / BIT b,(HL)
      if (src === 6) {
        const v = this.rd(this.hl());
        const res = v & (1 << bitn);
        this.f =
          (this.f & CF) |
          HF |
          (SZ_BIT[res] & ~(YF | XF)) |
          ((this.wz >> 8) & (YF | XF));
        return 12;
      }
      const v = this.getR8(src);
      const res = v & (1 << bitn);
      this.f =
        (this.f & CF) | HF | (SZ_BIT[res] & ~(YF | XF)) | (v & (YF | XF));
      return 8;
    }
    if (src === 6) {
      const addr = this.hl();
      let v = this.rd(addr);
      if (grp === 0) v = this.rot8(bitn, v);
      else if (grp === 2) v &= ~(1 << bitn) & 0xff;
      else v |= 1 << bitn;
      this.wr(addr, v);
      return 15;
    }
    let v = this.getR8(src);
    if (grp === 0) v = this.rot8(bitn, v);
    else if (grp === 2) v &= ~(1 << bitn) & 0xff;
    else v |= 1 << bitn;
    this.setR8(src, v);
    return 8;
  }

  // ------------------------------------------------------------------ ED prefix

  private execED(): number {
    this.incR();
    const op = this.fetch();
    if (op >= 0x40 && op < 0x80) {
      const y = (op >> 3) & 7;
      switch (op & 7) {
        case 0: { // IN r,(C) — ED70 sets flags only
          const bc = this.bc();
          const v = this.bus.in(bc) & 0xff;
          this.wz = (bc + 1) & 0xffff;
          this.f = (this.f & CF) | SZP[v];
          if (y !== 6) this.setR8(y, v);
          return 12;
        }
        case 1: { // OUT (C),r — ED71 outputs 0 (NMOS)
          const bc = this.bc();
          this.wz = (bc + 1) & 0xffff;
          this.bus.out(bc, y === 6 ? 0 : this.getR8(y));
          return 12;
        }
        case 2: { // SBC/ADC HL,rr
          const v = this.rp(y >> 1);
          if (y & 1) this.adcHL(v);
          else this.sbcHL(v);
          return 15;
        }
        case 3: { // LD (nn),rr / LD rr,(nn)
          const addr = this.fetch16();
          this.wz = (addr + 1) & 0xffff;
          if (y & 1) this.setRP(y >> 1, this.rd16(addr));
          else this.wr16(addr, this.rp(y >> 1));
          return 20;
        }
        case 4: { // NEG (all 8 duplicates)
          const v = this.a;
          this.a = 0;
          this.subA(v);
          return 8;
        }
        case 5: // RETN / RETI (ED4D) and duplicates: all copy IFF2 -> IFF1
          this.pc = this.pop16();
          this.wz = this.pc;
          this.iff1 = this.iff2;
          return 14;
        case 6: // IM 0/1/2 (incl. undocumented duplicates)
          this.im = (y & 3) === 3 ? 2 : (y & 3) === 2 ? 1 : 0;
          return 8;
        default: // 7
          switch (y) {
            case 0: // LD I,A
              this.i = this.a;
              return 9;
            case 1: // LD R,A
              this.r = this.a;
              return 9;
            case 2: // LD A,I
              this.a = this.i;
              this.f =
                (this.f & CF) | SZ[this.a] | (this.iff2 !== 0 ? VF : 0);
              return 9;
            case 3: // LD A,R
              this.a = this.r;
              this.f =
                (this.f & CF) | SZ[this.a] | (this.iff2 !== 0 ? VF : 0);
              return 9;
            case 4:
              this.rrd();
              return 18;
            case 5:
              this.rld();
              return 18;
            default: // ED77 / ED7F: nop
              return 8;
          }
      }
    }
    switch (op) {
      case 0xa0:
        this.ldx(1);
        return 16;
      case 0xa8:
        this.ldx(-1);
        return 16;
      case 0xb0: // LDIR
        this.ldx(1);
        return this.blockRepeat(this.bc() !== 0);
      case 0xb8: // LDDR
        this.ldx(-1);
        return this.blockRepeat(this.bc() !== 0);
      case 0xa1:
        this.cpx(1);
        return 16;
      case 0xa9:
        this.cpx(-1);
        return 16;
      case 0xb1: // CPIR
        this.cpx(1);
        return this.blockRepeat(this.bc() !== 0 && (this.f & ZF) === 0);
      case 0xb9: // CPDR
        this.cpx(-1);
        return this.blockRepeat(this.bc() !== 0 && (this.f & ZF) === 0);
      case 0xa2:
        this.inx(1);
        return 16;
      case 0xaa:
        this.inx(-1);
        return 16;
      case 0xb2: // INIR
        this.inx(1);
        return this.blockRepeat(this.b !== 0);
      case 0xba: // INDR
        this.inx(-1);
        return this.blockRepeat(this.b !== 0);
      case 0xa3:
        this.outx(1);
        return 16;
      case 0xab:
        this.outx(-1);
        return 16;
      case 0xb3: // OTIR
        this.outx(1);
        return this.blockRepeat(this.b !== 0);
      case 0xbb: // OTDR
        this.outx(-1);
        return this.blockRepeat(this.b !== 0);
      default:
        // every other ED opcode is a two-byte nop
        return 8;
    }
  }

  private rp(idx: number): number {
    switch (idx) {
      case 0: return this.bc();
      case 1: return this.de();
      case 2: return this.hl();
      default: return this.sp;
    }
  }

  private setRP(idx: number, v: number): void {
    switch (idx) {
      case 0: this.setBC(v); break;
      case 1: this.setDE(v); break;
      case 2: this.setHL(v); break;
      default: this.sp = v & 0xffff; break;
    }
  }

  private blockRepeat(repeat: boolean): number {
    if (repeat) {
      this.pc = (this.pc - 2) & 0xffff;
      this.wz = (this.pc + 1) & 0xffff;
      // undocumented: X/Y from high byte of PC while repeating
      this.f = (this.f & ~(YF | XF)) | ((this.pc >> 8) & (YF | XF));
      return 21;
    }
    return 16;
  }

  private ldx(dir: number): void {
    const hl = this.hl();
    const de = this.de();
    const t = this.rd(hl);
    this.wr(de, t);
    this.setHL((hl + dir) & 0xffff);
    this.setDE((de + dir) & 0xffff);
    const bc = (this.bc() - 1) & 0xffff;
    this.setBC(bc);
    const n = (t + this.a) & 0xff;
    this.f =
      (this.f & (SF | ZF | CF)) |
      (bc !== 0 ? VF : 0) |
      (n & XF) |
      ((n & 0x02) !== 0 ? YF : 0);
  }

  private cpx(dir: number): void {
    const hl = this.hl();
    const t = this.rd(hl);
    this.wz = (this.wz + dir) & 0xffff;
    this.setHL((hl + dir) & 0xffff);
    const bc = (this.bc() - 1) & 0xffff;
    this.setBC(bc);
    const res = (this.a - t) & 0xff;
    const hc = (this.a ^ t ^ res) & HF;
    const n = (res - (hc !== 0 ? 1 : 0)) & 0xff;
    this.f =
      (this.f & CF) |
      NF |
      hc |
      (res !== 0 ? res & SF : ZF) |
      (bc !== 0 ? VF : 0) |
      (n & XF) |
      ((n & 0x02) !== 0 ? YF : 0);
  }

  private inx(dir: number): void {
    const bc = this.bc();
    const t = this.bus.in(bc) & 0xff;
    this.wz = (bc + dir) & 0xffff;
    this.b = (this.b - 1) & 0xff;
    const hl = this.hl();
    this.wr(hl, t);
    this.setHL((hl + dir) & 0xffff);
    const k = ((this.c + dir) & 0xff) + t;
    this.f =
      SZ[this.b] |
      ((t & 0x80) !== 0 ? NF : 0) |
      (k > 0xff ? HF | CF : 0) |
      (SZP[(k & 7) ^ this.b] & PF);
  }

  private outx(dir: number): void {
    const hl = this.hl();
    const t = this.rd(hl);
    this.b = (this.b - 1) & 0xff;
    const bc = this.bc(); // after B decrement
    this.wz = (bc + dir) & 0xffff;
    this.bus.out(bc, t);
    this.setHL((hl + dir) & 0xffff);
    const k = ((hl + dir) & 0xff) + t; // L after inc/dec
    this.f =
      SZ[this.b] |
      ((t & 0x80) !== 0 ? NF : 0) |
      (k > 0xff ? HF | CF : 0) |
      (SZP[(k & 7) ^ this.b] & PF);
  }

  // ------------------------------------------------------------------ DD/FD prefix

  private xy(useIX: boolean): number {
    return useIX ? this.ix : this.iy;
  }

  private setXY(useIX: boolean, v: number): void {
    if (useIX) this.ix = v & 0xffff;
    else this.iy = v & 0xffff;
  }

  private eaXY(useIX: boolean): number {
    const d = this.fetchSigned();
    const ea = (this.xy(useIX) + d) & 0xffff;
    this.wz = ea;
    return ea;
  }

  private execXY(useIX: boolean): number {
    this.incR();
    const op = this.fetch();
    if (op >= 0x40 && op < 0x80 && op !== 0x76) {
      const dst = (op >> 3) & 7;
      const src = op & 7;
      if (src === 6) {
        // LD r,(IX+d) — uses the real register set for r
        this.setR8(dst, this.rd(this.eaXY(useIX)));
        return 19;
      }
      if (dst === 6) {
        // LD (IX+d),r
        const ea = this.eaXY(useIX);
        this.wr(ea, this.getR8(src));
        return 19;
      }
      // register-to-register with IXH/IXL substituted for H/L
      this.setRX(dst, this.getRX(src, useIX), useIX);
      return 8;
    }
    if (op >= 0x80 && op < 0xc0) {
      const src = op & 7;
      if (src === 6) {
        this.alu8((op >> 3) & 7, this.rd(this.eaXY(useIX)));
        return 19;
      }
      this.alu8((op >> 3) & 7, this.getRX(src, useIX));
      return 8;
    }
    switch (op) {
      case 0x09:
        this.setXY(useIX, this.add16(this.xy(useIX), this.bc()));
        return 15;
      case 0x19:
        this.setXY(useIX, this.add16(this.xy(useIX), this.de()));
        return 15;
      case 0x29: {
        const v = this.xy(useIX);
        this.setXY(useIX, this.add16(v, v));
        return 15;
      }
      case 0x39:
        this.setXY(useIX, this.add16(this.xy(useIX), this.sp));
        return 15;
      case 0x21:
        this.setXY(useIX, this.fetch16());
        return 14;
      case 0x22: { // LD (nn),IX
        const addr = this.fetch16();
        this.wr16(addr, this.xy(useIX));
        this.wz = (addr + 1) & 0xffff;
        return 20;
      }
      case 0x2a: { // LD IX,(nn)
        const addr = this.fetch16();
        this.setXY(useIX, this.rd16(addr));
        this.wz = (addr + 1) & 0xffff;
        return 20;
      }
      case 0x23:
        this.setXY(useIX, (this.xy(useIX) + 1) & 0xffff);
        return 10;
      case 0x2b:
        this.setXY(useIX, (this.xy(useIX) - 1) & 0xffff);
        return 10;
      case 0x24: // INC IXH
        this.setRX(4, this.inc8(this.getRX(4, useIX)), useIX);
        return 8;
      case 0x25: // DEC IXH
        this.setRX(4, this.dec8(this.getRX(4, useIX)), useIX);
        return 8;
      case 0x26: // LD IXH,n
        this.setRX(4, this.fetch(), useIX);
        return 11;
      case 0x2c: // INC IXL
        this.setRX(5, this.inc8(this.getRX(5, useIX)), useIX);
        return 8;
      case 0x2d: // DEC IXL
        this.setRX(5, this.dec8(this.getRX(5, useIX)), useIX);
        return 8;
      case 0x2e: // LD IXL,n
        this.setRX(5, this.fetch(), useIX);
        return 11;
      case 0x34: { // INC (IX+d)
        const ea = this.eaXY(useIX);
        this.wr(ea, this.inc8(this.rd(ea)));
        return 23;
      }
      case 0x35: { // DEC (IX+d)
        const ea = this.eaXY(useIX);
        this.wr(ea, this.dec8(this.rd(ea)));
        return 23;
      }
      case 0x36: { // LD (IX+d),n
        const ea = this.eaXY(useIX);
        this.wr(ea, this.fetch());
        return 19;
      }
      case 0xcb:
        return this.execXYCB(useIX);
      case 0xe1:
        this.setXY(useIX, this.pop16());
        return 14;
      case 0xe3: { // EX (SP),IX
        const t = this.rd16(this.sp);
        this.wr16(this.sp, this.xy(useIX));
        this.setXY(useIX, t);
        this.wz = t;
        return 23;
      }
      case 0xe5:
        this.push16(this.xy(useIX));
        return 15;
      case 0xe9: // JP (IX)
        this.pc = this.xy(useIX);
        return 8;
      case 0xf9: // LD SP,IX
        this.sp = this.xy(useIX);
        return 10;
      case 0xdd:
        return 4 + this.execXY(true);
      case 0xfd:
        return 4 + this.execXY(false);
      case 0xed:
        return 4 + this.execED();
      default:
        // any other opcode: the DD/FD prefix acts as a 4T nop
        return 4 + this.execBase(op);
    }
  }

  private execXYCB(useIX: boolean): number {
    // DDCB/FDCB: displacement and final opcode are fetched without R increment
    const d = this.fetchSigned();
    const ea = (this.xy(useIX) + d) & 0xffff;
    this.wz = ea;
    const op = this.fetch();
    const grp = op >> 6;
    const bitn = (op >> 3) & 7;
    const src = op & 7;
    const v = this.rd(ea);
    if (grp === 1) {
      // BIT b,(IX+d) — X/Y from high byte of effective address
      const res = v & (1 << bitn);
      this.f =
        (this.f & CF) |
        HF |
        (SZ_BIT[res] & ~(YF | XF)) |
        ((ea >> 8) & (YF | XF));
      return 20;
    }
    let res: number;
    if (grp === 0) res = this.rot8(bitn, v);
    else if (grp === 2) res = v & (~(1 << bitn) & 0xff);
    else res = v | (1 << bitn);
    this.wr(ea, res);
    // undocumented: result also copied to register (except src == 6)
    if (src !== 6) this.setR8(src, res);
    return 23;
  }
}
