// Intel MCS-48 CPU emulator core for mamekit — I8039 variant (the Konami
// Juno First / Gyruss sound-board DAC sample player).
//
// Self-contained ES module: zero imports, zero runtime dependencies, no DOM.
// Instruction semantics, flag behavior, cycle counts, the timer/counter and
// the interrupt logic are hand-ported from MAME's MCS-48 family core
// (src/devices/cpu/mcs48/mcs48.cpp — the s_mcs48_opcodes table and its
// OPHANDLERs, check_irqs and burn_cycles).
//
// Variant: I8039 = standard MCS-48 with NO internal ROM (every program fetch
// goes to the external 12-bit program space via Mcs48Bus.readProgram) and
// 128 bytes of internal RAM. The exec() dispatch below mirrors MAME's
// s_mcs48_opcodes table 1:1, so the other standard-set parts differ only by
// the `ramSize` constructor option (8035: 64, 8039: 128, 8040: 256). The
// 8021/8022 reduced-set and UPI-41 parts use *different opcode tables* in
// MAME (s_i8021_opcodes / s_upi41_opcodes); adding them would mean a second
// dispatch plus feature flags — structured for, but not implemented.
//
// Cycle accounting (DECISION — read this before wiring a board):
//   step() and run() are denominated in CLOCK cycles (XTAL T-states).
//   One MCS-48 machine cycle = 15 clocks (MAME's execute_clocks_to_cycles);
//   every opcode takes 1 or 2 machine cycles = 15 or 30 clocks; accepting an
//   external or timer interrupt adds 2 machine cycles (30 clocks) to the
//   step that vectors. Boards budget with raw XTAL numbers, e.g.
//   `mcu.run(8_000_000 / 60 / 264)` per scanline on an 8 MHz part. The
//   timer prescaler counts MACHINE cycles (divide-by-32), exactly like
//   MAME's burn_cycles, so a timer tick = 32*15 = 480 clocks.
//
// Covered:
//  - the full documented MCS-48 instruction set: ADD/ADDC (C + AC flags),
//    ANL/ORL/XRL, INC/DEC, CLR/CPL (A, C, F0, F1), DA A, RL/RLC/RR/RRC,
//    SWAP, all MOV forms including MOV A,PSW (bit 3 reads 1) and MOV PSW,A
//    (bit 3 ignored, bank + stack pointer take effect), MOVP/MOVP3, MOVX
//    (external data space via readIo/writeIo), XCH/XCHD, JMP/JMPP/CALL/
//    RET/RETR, all conditional jumps (JC/JNC/JZ/JNZ/JT0/JNT0/JT1/JNT1/
//    JF0/JF1/JTF/JNI/JB0-JB7), DJNZ, EN I/DIS I, EN TCNTI/DIS TCNTI,
//    STRT T/STRT CNT/STOP TCNT, SEL RB0/RB1, SEL MB0/MB1,
//    INS A,BUS / OUTL BUS,A / ORL BUS,# / ANL BUS,# (optional bus callbacks).
//  - PSW = C(0x80) AC(0x40) F0(0x20) BS(0x10) 1(0x08) SP(0x07); the 8-level
//    stack lives in internal RAM 0x08-0x17 (2 bytes per level: PC low, then
//    PC high nibble | PSW high nibble).
//  - program counter arithmetic: sequential fetch wraps within the 2K page
//    ((pc+1) & 0x7ff, A11 preserved); JMP/CALL apply the SEL MB latch as
//    A11 except while an interrupt is in progress (A11 forced 0, and RET/
//    RETR pull masks to 0x7ff while in progress, per MAME).
//  - timer: /32 machine-cycle prescaler (reset by STRT T), timer flag on
//    0xFF->0x00 overflow (cleared by JTF), timer interrupt to vector 0x007
//    when EN TCNTI; an overflow with the timer IRQ disabled sets only the
//    flag, not the pending-interrupt flip-flop (MAME/docs behavior).
//    DIS TCNTI also clears a pending timer interrupt.
//  - event counter: STRT CNT samples T1 once per machine cycle and counts
//    1->0 transitions (MAME's t1_history & 3 == 2).
//  - external interrupt: level-sensitive INT line (setIrqLine), vector
//    0x003, 2-cycle acceptance, blocked while irqInProgress, re-enabled by
//    RETR; includes MAME's JNI-poll hack (an interrupt arriving right after
//    a not-taken JNI forces the JNI branch before vectoring).
//
// Deliberate simplifications (documented deviations):
//  - MOVD/ANLD/ORLD Pp (8243 port-expander opcodes 0C-0F/3C-3F/8C-8F/9C-9F)
//    consume their 2 machine cycles but do nothing (no PROG pin / expander
//    on the target boards; MOVD A,Pp leaves A unchanged).
//  - ENT0 CLK (0x75) consumes 1 cycle and does nothing (no T0 clock output
//    consumer; MAME only forwards it to a clock callback).
//  - The EA pin is not modeled: an 8039 has no internal ROM, so program
//    fetches are always external.

export interface Mcs48Bus {
  /** External program fetch (i8039 has no internal ROM), addr 0..0xfff. */
  readProgram(addr: number): number;
  /** MOVX A,@R external data read, addr 0..0xff (R0/R1 drive BUS+P2 low). */
  readIo(addr: number): number;
  /** MOVX @R,A external data write, addr 0..0xff. */
  writeIo(addr: number, data: number): void;
  /** IN A,Pp input, ANDed with the port output latch (quasi-bidirectional). */
  readPort(port: 1 | 2): number;
  /** P1/P2 output latch changes (OUTL/ANL/ORL Pp and the 0xff reset write). */
  writePort(port: 1 | 2, data: number): void;
  /** T0/T1 pin state for JT0/JNT0/JT1/JNT1 and the event counter; missing = low. */
  testLine?(line: 0 | 1): boolean;
  /** INS A,BUS / ORL BUS,# / ANL BUS,# read; missing callback reads 0xff. */
  readBus?(): number;
  /** OUTL BUS,A / ORL BUS,# / ANL BUS,# write (also fired with 0xff at reset). */
  writeBus?(data: number): void;
}

// PSW flag bits
const C_FLAG = 0x80;
const A_FLAG = 0x40; // auxiliary carry
const F_FLAG = 0x20; // F0
const B_FLAG = 0x10; // register bank select

// timecountEnabled bits
const TIMER_ENABLED = 0x01;
const COUNTER_ENABLED = 0x02;

export class Mcs48 {
  // ---- public architectural state (contract for boards + specs) ----
  pc = 0;
  prevPc = 0;
  a = 0;
  psw = 0; // C AC F0 BS 1 SP2 SP1 SP0 (bit 3 stored as 0, read as 1 by MOV A,PSW)
  f1 = false;
  a11 = 0; // SEL MB latch: 0x000 or 0x800
  p1 = 0xff; // port 1 output latch
  p2 = 0xff; // port 2 output latch
  timer = 0;
  prescaler = 0; // 5-bit machine-cycle prescaler
  ram: Uint8Array; // internal RAM: r0-r7 at 0/24 (bank 0/1), stack 0x08-0x17

  irqInProgress = false;
  timerFlag = false; // sampled + cleared by JTF
  timerOverflow = false; // pending timer interrupt (cleared when taken / DIS TCNTI)
  tirqEnabled = false;
  xirqEnabled = false;
  timecountEnabled = 0; // TIMER_ENABLED | COUNTER_ENABLED (mutually exclusive)

  private bus: Mcs48Bus;
  private ramMask: number;
  private irqState = false; // level of the INT line
  private irqPolled = false; // last instruction was a not-taken JNI
  private t1History = 0;
  private mc = 0; // machine cycles consumed by the current step()

  constructor(bus: Mcs48Bus, opts?: { ramSize?: 64 | 128 | 256 }) {
    this.bus = bus;
    const ramSize = opts?.ramSize ?? 128; // i8039 default
    this.ram = new Uint8Array(ramSize);
    this.ramMask = ramSize - 1;
    this.reset();
  }

  /** Hardware reset, per MAME device_reset: PC=0, SP=0, bank 0, MB0, both
   *  interrupt enables off, timer stopped, ports latched high (fires
   *  writePort(1/2, 0xff) and writeBus(0xff)); A/timer/RAM are NOT cleared. */
  reset(): void {
    this.pc = 0;
    this.psw = this.psw & (C_FLAG | A_FLAG); // C/AC survive reset (MAME)
    this.f1 = false;
    this.a11 = 0;
    this.tirqEnabled = false;
    this.xirqEnabled = false;
    this.timecountEnabled = 0;
    this.timerFlag = false;
    this.irqInProgress = false;
    this.timerOverflow = false;
    this.irqPolled = false;
    this.bus.writeBus?.(0xff); // BUS floats high (EA=1 on an 8039)
    this.p1 = 0xff;
    this.p2 = 0xff;
    this.bus.writePort(1, 0xff);
    this.bus.writePort(2, 0xff);
  }

  /** Level-sensitive INT pin (active = asserted). The board clears it
   *  (junofrst: P2 write with bit 7 low; gyruss: any P2 write). */
  setIrqLine(active: boolean): void {
    this.irqState = active;
  }

  /** Register bank accessors (r0-r7 in the bank selected by PSW.BS). */
  reg(n: number): number {
    return this.ram[((this.psw & B_FLAG) !== 0 ? 24 : 0) + (n & 7)];
  }
  setReg(n: number, v: number): void {
    this.ram[((this.psw & B_FLAG) !== 0 ? 24 : 0) + (n & 7)] = v & 0xff;
  }

  /** Execute one instruction (vectoring into a pending interrupt first).
   *  Returns CLOCK cycles consumed (machine cycles * 15). */
  step(): number {
    this.mc = 0;
    this.checkIrqs();
    this.irqPolled = false;
    this.prevPc = this.pc;
    this.exec(this.fetch());
    return this.mc * 15;
  }

  /** step() until at least `clocks` CLOCK cycles are consumed; returns the
   *  actual total (may overshoot by up to one instruction + irq entry). */
  run(clocks: number): number {
    let total = 0;
    while (total < clocks) total += this.step();
    return total;
  }

  // ------------------------------------------------------------ interrupts

  /** Port of MAME check_irqs: external INT beats timer; nothing nests. */
  private checkIrqs(): void {
    if (this.irqInProgress) return;
    if (this.irqState && this.xirqEnabled) {
      this.burn(2);
      this.irqInProgress = true;
      // MAME's JNI hack: if the last instruction was a not-taken JNI, force
      // the branch to be taken before vectoring (WY-100 quirk).
      if (this.irqPolled) {
        this.pc = ((this.prevPc + 1) & 0x7ff) | (this.prevPc & 0x800);
        this.jcc(true);
      }
      this.call(0x003);
    } else if (this.timerOverflow && this.tirqEnabled) {
      this.burn(2);
      this.irqInProgress = true;
      this.call(0x007);
      this.timerOverflow = false; // flip-flop reset once taken
    }
  }

  // ------------------------------------------------------------ helpers

  /** Fetch one program byte; sequential PC wraps within the 2K page. */
  private fetch(): number {
    const address = this.pc;
    this.pc = ((this.pc + 1) & 0x7ff) | (this.pc & 0x800);
    return this.bus.readProgram(address & 0xfff) & 0xff;
  }

  /** Burn `count` MACHINE cycles, advancing the timer/counter (MAME burn_cycles). */
  private burn(count: number): void {
    if (this.timecountEnabled !== 0) {
      let timerover = false;
      if ((this.timecountEnabled & TIMER_ENABLED) !== 0) {
        const oldtimer = this.timer;
        this.prescaler += count;
        this.timer = (this.timer + (this.prescaler >> 5)) & 0xff;
        this.prescaler &= 0x1f;
        timerover = this.timer < oldtimer;
      } else if ((this.timecountEnabled & COUNTER_ENABLED) !== 0) {
        // poll T1 once per machine cycle; count 1->0 transitions
        for (let i = 0; i < count; i++) {
          this.t1History = ((this.t1History << 1) | this.test(1)) & 0xff;
          if ((this.t1History & 3) === 2) {
            this.timer = (this.timer + 1) & 0xff;
            if (this.timer === 0) timerover = true;
          }
        }
      }
      if (timerover) {
        this.timerFlag = true;
        // an overflow with the timer IRQ disabled is not stored as pending
        if (this.tirqEnabled) this.timerOverflow = true;
      }
    }
    this.mc += count;
  }

  private test(line: 0 | 1): number {
    return this.bus.testLine?.(line) ? 1 : 0;
  }

  private ramR(addr: number): number {
    return this.ram[addr & this.ramMask];
  }
  private ramW(addr: number, v: number): void {
    this.ram[addr & this.ramMask] = v & 0xff;
  }

  /** push PC and PSW-high onto the 8-level stack (RAM 0x08-0x17). */
  private pushPcPsw(): void {
    const sp = this.psw & 0x07;
    this.ramW(8 + 2 * sp, this.pc);
    this.ramW(9 + 2 * sp, ((this.pc >> 8) & 0x0f) | (this.psw & 0xf0));
    this.psw = (this.psw & 0xf0) | ((sp + 1) & 0x07);
  }

  /** RETR: pull PC and PSW-high (bank select takes effect immediately). */
  private pullPcPsw(): void {
    const sp = (this.psw - 1) & 0x07;
    this.pc = this.ramR(8 + 2 * sp) | (this.ramR(9 + 2 * sp) << 8);
    this.psw = ((this.pc >> 8) & 0xf0) | sp;
    this.pc &= this.irqInProgress ? 0x7ff : 0xfff;
  }

  /** RET: pull PC only, PSW flags untouched. */
  private pullPc(): void {
    const sp = (this.psw - 1) & 0x07;
    this.pc = this.ramR(8 + 2 * sp) | (this.ramR(9 + 2 * sp) << 8);
    this.pc &= this.irqInProgress ? 0x7ff : 0xfff;
    this.psw = (this.psw & 0xf0) | sp;
  }

  private add(dat: number): void {
    const temp = this.a + dat;
    const temp4 = (this.a & 0x0f) + (dat & 0x0f);
    this.psw &= ~(C_FLAG | A_FLAG);
    this.psw |= (temp4 << 2) & A_FLAG;
    this.psw |= (temp >> 1) & C_FLAG;
    this.a = temp & 0xff;
  }

  private addc(dat: number): void {
    const carryin = (this.psw & C_FLAG) >> 7;
    const temp = this.a + dat + carryin;
    const temp4 = (this.a & 0x0f) + (dat & 0x0f) + carryin;
    this.psw &= ~(C_FLAG | A_FLAG);
    this.psw |= (temp4 << 2) & A_FLAG;
    this.psw |= (temp >> 1) & C_FLAG;
    this.a = temp & 0xff;
  }

  /** JMP target: SEL MB latch supplies A11 unless an IRQ is in progress. */
  private jmp(address: number): void {
    const a11 = this.irqInProgress ? 0 : this.a11;
    this.pc = (address | a11) & 0xfff;
  }

  private call(address: number): void {
    this.pushPcPsw();
    this.jmp(address);
  }

  /** Conditional jump: page taken from the ARGUMENT byte's address. */
  private jcc(taken: boolean): void {
    const pch = this.pc & 0xf00;
    const offset = this.fetch();
    if (taken) this.pc = pch | offset;
  }

  // ------------------------------------------------------------ dispatch
  // Mirrors MAME's s_mcs48_opcodes table; burn() first, like the OPHANDLERs.

  private exec(op: number): void {
    const r = op & 7;
    switch (op) {
      case 0x00: this.burn(1); break; // NOP
      case 0x02: this.burn(2); this.bus.writeBus?.(this.a); break; // OUTL BUS,A
      case 0x03: this.burn(2); this.add(this.fetch()); break; // ADD A,#n
      case 0x04: case 0x24: case 0x44: case 0x64: // JMP page 0-7
      case 0x84: case 0xa4: case 0xc4: case 0xe4:
        this.burn(2); this.jmp(this.fetch() | ((op & 0xe0) << 3)); break;
      case 0x05: this.burn(1); this.xirqEnabled = true; break; // EN I
      case 0x07: this.burn(1); this.a = (this.a - 1) & 0xff; break; // DEC A
      case 0x08: this.burn(2); this.a = (this.bus.readBus?.() ?? 0xff) & 0xff; break; // INS A,BUS
      case 0x09: this.burn(2); this.a = this.bus.readPort(1) & this.p1; break; // IN A,P1
      case 0x0a: this.burn(2); this.a = this.bus.readPort(2) & this.p2; break; // IN A,P2
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: this.burn(2); break; // MOVD A,Pp (8243 — unimplemented)

      case 0x10: case 0x11: { // INC @Rr
        const ad = this.reg(r);
        this.burn(1); this.ramW(ad, this.ramR(ad) + 1); break;
      }
      case 0x12: case 0x32: case 0x52: case 0x72: // JBb
      case 0x92: case 0xb2: case 0xd2: case 0xf2:
        this.burn(2); this.jcc(((this.a >> ((op >> 5) & 7)) & 1) !== 0); break;
      case 0x13: this.burn(2); this.addc(this.fetch()); break; // ADC A,#n
      case 0x14: case 0x34: case 0x54: case 0x74: // CALL page 0-7
      case 0x94: case 0xb4: case 0xd4: case 0xf4:
        this.burn(2); this.call(this.fetch() | ((op & 0xe0) << 3)); break;
      case 0x15: this.burn(1); this.xirqEnabled = false; break; // DIS I
      case 0x16: this.burn(2); this.jcc(this.timerFlag); this.timerFlag = false; break; // JTF
      case 0x17: this.burn(1); this.a = (this.a + 1) & 0xff; break; // INC A

      case 0x20: case 0x21: { // XCH A,@Rr
        const ad = this.reg(r);
        this.burn(1);
        const tmp = this.a; this.a = this.ramR(ad); this.ramW(ad, tmp); break;
      }
      case 0x23: this.burn(2); this.a = this.fetch(); break; // MOV A,#n
      case 0x25: this.burn(1); this.tirqEnabled = true; break; // EN TCNTI
      case 0x26: this.burn(2); this.jcc(this.test(0) === 0); break; // JNT0
      case 0x27: this.burn(1); this.a = 0; break; // CLR A

      case 0x30: case 0x31: { // XCHD A,@Rr
        const ad = this.reg(r);
        this.burn(1);
        const oldram = this.ramR(ad);
        this.ramW(ad, (oldram & 0xf0) | (this.a & 0x0f));
        this.a = (this.a & 0xf0) | (oldram & 0x0f); break;
      }
      case 0x35: this.burn(1); this.tirqEnabled = false; this.timerOverflow = false; break; // DIS TCNTI
      case 0x36: this.burn(2); this.jcc(this.test(0) !== 0); break; // JT0
      case 0x37: this.burn(1); this.a ^= 0xff; break; // CPL A
      case 0x39: this.burn(2); this.bus.writePort(1, this.p1 = this.a); break; // OUTL P1,A
      case 0x3a: this.burn(2); this.bus.writePort(2, this.p2 = this.a); break; // OUTL P2,A
      case 0x3c: case 0x3d: case 0x3e: case 0x3f: this.burn(2); break; // MOVD Pp,A (unimplemented)

      case 0x40: case 0x41: this.burn(1); this.a |= this.ramR(this.reg(r)); break; // ORL A,@Rr
      case 0x42: this.burn(1); this.a = this.timer; break; // MOV A,T
      case 0x43: this.burn(2); this.a |= this.fetch(); break; // ORL A,#n
      case 0x45: // STRT CNT
        this.burn(1);
        if ((this.timecountEnabled & COUNTER_ENABLED) === 0) this.t1History = this.test(1);
        this.timecountEnabled = COUNTER_ENABLED; break;
      case 0x46: this.burn(2); this.jcc(this.test(1) === 0); break; // JNT1
      case 0x47: this.burn(1); this.a = ((this.a << 4) | (this.a >> 4)) & 0xff; break; // SWAP A

      case 0x50: case 0x51: this.burn(1); this.a &= this.ramR(this.reg(r)); break; // ANL A,@Rr
      case 0x53: this.burn(2); this.a &= this.fetch(); break; // ANL A,#n
      case 0x55: this.burn(1); this.timecountEnabled = TIMER_ENABLED; this.prescaler = 0; break; // STRT T
      case 0x56: this.burn(2); this.jcc(this.test(1) !== 0); break; // JT1
      case 0x57: // DA A
        this.burn(1);
        if ((this.a & 0x0f) > 0x09 || (this.psw & A_FLAG) !== 0) {
          if (this.a > 0xf9) this.psw |= C_FLAG;
          this.a = (this.a + 0x06) & 0xff;
        }
        if ((this.a & 0xf0) > 0x90 || (this.psw & C_FLAG) !== 0) {
          this.a = (this.a + 0x60) & 0xff;
          this.psw |= C_FLAG;
        }
        break;

      case 0x60: case 0x61: this.burn(1); this.add(this.ramR(this.reg(r))); break; // ADD A,@Rr
      case 0x62: this.burn(1); this.timer = this.a; break; // MOV T,A
      case 0x65: this.burn(1); this.timecountEnabled = 0; break; // STOP TCNT
      case 0x67: { // RRC A
        this.burn(1);
        const newc = (this.a << 7) & C_FLAG;
        this.a = (this.a >> 1) | (this.psw & C_FLAG);
        this.psw = (this.psw & ~C_FLAG) | newc; break;
      }

      case 0x70: case 0x71: this.burn(1); this.addc(this.ramR(this.reg(r))); break; // ADC A,@Rr
      case 0x75: this.burn(1); break; // ENT0 CLK (unimplemented — no T0 clock consumer)
      case 0x76: this.burn(2); this.jcc(this.f1); break; // JF1
      case 0x77: this.burn(1); this.a = ((this.a >> 1) | (this.a << 7)) & 0xff; break; // RR A

      case 0x80: case 0x81: this.burn(2); this.a = this.bus.readIo(this.reg(r)) & 0xff; break; // MOVX A,@Rr
      case 0x83: this.burn(2); this.pullPc(); break; // RET
      case 0x85: this.burn(1); this.psw &= ~F_FLAG; break; // CLR F0
      case 0x86: this.burn(2); this.irqPolled = !this.irqState; this.jcc(this.irqState); break; // JNI
      case 0x88: this.burn(2); this.bus.writeBus?.((this.bus.readBus?.() ?? 0xff) | this.fetch()); break; // ORL BUS,#n
      case 0x89: this.burn(2); this.bus.writePort(1, this.p1 |= this.fetch()); break; // ORL P1,#n
      case 0x8a: this.burn(2); this.bus.writePort(2, this.p2 |= this.fetch()); break; // ORL P2,#n
      case 0x8c: case 0x8d: case 0x8e: case 0x8f: this.burn(2); break; // ORLD Pp,A (unimplemented)

      case 0x90: case 0x91: this.burn(2); this.bus.writeIo(this.reg(r), this.a); break; // MOVX @Rr,A
      case 0x93: this.burn(2); this.irqInProgress = false; this.pullPcPsw(); break; // RETR
      case 0x95: this.burn(1); this.psw ^= F_FLAG; break; // CPL F0
      case 0x96: this.burn(2); this.jcc(this.a !== 0); break; // JNZ
      case 0x97: this.burn(1); this.psw &= ~C_FLAG; break; // CLR C
      case 0x98: this.burn(2); this.bus.writeBus?.((this.bus.readBus?.() ?? 0xff) & this.fetch()); break; // ANL BUS,#n
      case 0x99: this.burn(2); this.bus.writePort(1, this.p1 &= this.fetch()); break; // ANL P1,#n
      case 0x9a: this.burn(2); this.bus.writePort(2, this.p2 &= this.fetch()); break; // ANL P2,#n
      case 0x9c: case 0x9d: case 0x9e: case 0x9f: this.burn(2); break; // ANLD Pp,A (unimplemented)

      case 0xa0: case 0xa1: this.burn(1); this.ramW(this.reg(r), this.a); break; // MOV @Rr,A
      case 0xa3: this.burn(2); this.a = this.bus.readProgram(((this.pc & 0xf00) | this.a) & 0xfff) & 0xff; break; // MOVP A,@A
      case 0xa5: this.burn(1); this.f1 = false; break; // CLR F1
      case 0xa7: this.burn(1); this.psw ^= C_FLAG; break; // CPL C

      case 0xb0: case 0xb1: { // MOV @Rr,#n
        const ad = this.reg(r);
        this.burn(2); this.ramW(ad, this.fetch()); break;
      }
      case 0xb3: // JMPP @A
        this.burn(2);
        this.pc = (this.pc & 0xf00) | (this.bus.readProgram(((this.pc & 0xf00) | this.a) & 0xfff) & 0xff);
        break;
      case 0xb5: this.burn(1); this.f1 = !this.f1; break; // CPL F1
      case 0xb6: this.burn(2); this.jcc((this.psw & F_FLAG) !== 0); break; // JF0

      case 0xc5: this.burn(1); this.psw &= ~B_FLAG; break; // SEL RB0
      case 0xc6: this.burn(2); this.jcc(this.a === 0); break; // JZ
      case 0xc7: this.burn(1); this.a = this.psw | 0x08; break; // MOV A,PSW

      case 0xd0: case 0xd1: this.burn(1); this.a ^= this.ramR(this.reg(r)); break; // XRL A,@Rr
      case 0xd3: this.burn(2); this.a ^= this.fetch(); break; // XRL A,#n
      case 0xd5: this.burn(1); this.psw |= B_FLAG; break; // SEL RB1
      case 0xd7: this.burn(1); this.psw = this.a & ~0x08; break; // MOV PSW,A

      case 0xe3: this.burn(2); this.a = this.bus.readProgram(0x300 | this.a) & 0xff; break; // MOVP3 A,@A
      case 0xe5: this.burn(1); this.a11 = 0x000; break; // SEL MB0
      case 0xe6: this.burn(2); this.jcc((this.psw & C_FLAG) === 0); break; // JNC
      case 0xe7: this.burn(1); this.a = ((this.a << 1) | (this.a >> 7)) & 0xff; break; // RL A

      case 0xf0: case 0xf1: this.burn(1); this.a = this.ramR(this.reg(r)); break; // MOV A,@Rr
      case 0xf5: this.burn(1); this.a11 = 0x800; break; // SEL MB1
      case 0xf6: this.burn(2); this.jcc((this.psw & C_FLAG) !== 0); break; // JC
      case 0xf7: { // RLC A
        this.burn(1);
        const newc = this.a & C_FLAG;
        this.a = ((this.a << 1) | (this.psw >> 7)) & 0xff;
        this.psw = (this.psw & ~C_FLAG) | newc; break;
      }

      default:
        // register-operand families (0xX8-0xXF) and illegal opcodes
        switch (op & 0xf8) {
          case 0x18: this.burn(1); this.setReg(r, this.reg(r) + 1); break; // INC Rr
          case 0x28: { // XCH A,Rr
            this.burn(1);
            const tmp = this.a; this.a = this.reg(r); this.setReg(r, tmp); break;
          }
          case 0x48: this.burn(1); this.a |= this.reg(r); break; // ORL A,Rr
          case 0x58: this.burn(1); this.a &= this.reg(r); break; // ANL A,Rr
          case 0x68: this.burn(1); this.add(this.reg(r)); break; // ADD A,Rr
          case 0x78: this.burn(1); this.addc(this.reg(r)); break; // ADC A,Rr
          case 0xa8: this.burn(1); this.setReg(r, this.a); break; // MOV Rr,A
          case 0xb8: this.burn(2); this.setReg(r, this.fetch()); break; // MOV Rr,#n
          case 0xc8: this.burn(1); this.setReg(r, this.reg(r) - 1); break; // DEC Rr
          case 0xd8: this.burn(1); this.a ^= this.reg(r); break; // XRL A,Rr
          case 0xe8: { // DJNZ Rr
            this.burn(2);
            const nv = (this.reg(r) - 1) & 0xff;
            this.setReg(r, nv);
            this.jcc(nv !== 0); break;
          }
          case 0xf8: this.burn(1); this.a = this.reg(r); break; // MOV A,Rr
          default: this.burn(1); break; // illegal: 1 cycle, no effect (MAME logs only)
        }
        break;
    }
  }
}
