// NES / Famicom board (family "nes", issue #17) — the project's first console.
// Wiring per MAME src/mame/nintendo/nes.cpp: RP2A03 (6502 core, no BCD) at
// 1.789773 MHz, PPU 2C02, APU on the CPU die, cartridge slot on $4020-$FFFF.
//
// The cart arrives at runtime: the console room identifies a user-dropped
// iNES file and hands the board regions.prg / regions.chr plus
// config.cart = { mapper, mirroring, battery } — nothing cart-specific is in
// the generated config.json.
//
// Frame loop: 262 scanlines/frame; the CPU runs 1789772.67 / (60.0988*262) ≈
// 113.667 cycles per line (fractional accumulator carries the remainder).
// The PPU renders each visible line BEFORE the CPU runs that line's budget —
// scanline granularity, same HLE level as the MMC3 IRQ hook.
//
// Sound: the worklet hosts the rendering NesApu; this board runs a "shadow"
// NesApu fed the identical writes for $4015 reads, frame/DMC IRQs and DMC
// stall accounting. DMC sample bytes are snapshotted from cart PRG at trigger
// time and pushed to the worklet via sinks.soundData (the worklet cannot
// read CPU memory).

import { M6502 } from '../m6502.ts';
import { NesPpu } from '../video/nes-ppu.ts';
import { NesApu } from '../nes-apu.ts';
import { createCart, type NesCart } from '../nes-cart.ts';
import type { Board, BoardConfig, BoardSinks, BoardSnapshot, InputPorts, Regions } from '../types.ts';

const P1 = 'ctrl1:JOYPAD';
const P2 = 'ctrl2:JOYPAD';

export class NesBoard implements Board {
  readonly fbWidth = 256;
  readonly fbHeight = 240;

  private cpu: M6502;
  private ppu: NesPpu;
  private apu: NesApu;
  private cart: NesCart;
  private ram = new Uint8Array(0x800);
  private inputs: InputPorts;
  private sinks: BoardSinks;

  private frameCount = 0;
  private totalCycles = 0;
  private cycleCarry = 0;      // fractional cycles-per-line accumulator
  private pendingStall = 0;    // OAM-DMA + DMC steals, drained from the next budget
  private line = 0;            // current scanline (for soundWrite frac)
  private readonly cyclesPerLine: number;
  private readonly vtotal: number;

  private strobe = 0;
  private pad1 = 0;            // shift registers
  private pad2 = 0;

  constructor(config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) {
    if (!config.cart) throw new Error('nes board needs config.cart (inserted by the console room)');
    if (!regions.prg?.length) throw new Error('nes board needs regions.prg (cart program data)');
    this.inputs = inputs;
    this.sinks = sinks;

    this.cart = createCart({
      prg: regions.prg,
      chr: regions.chr ?? new Uint8Array(0),
      mapper: config.cart.mapper,
      mirroring: config.cart.mirroring,
      battery: config.cart.battery,
    });
    this.ppu = new NesPpu(this.cart);

    const clock = config.cpus[0]?.clock || 1789773;
    this.vtotal = config.screen.vtotal || 262;
    this.cyclesPerLine = clock / (config.screen.refresh * this.vtotal);

    this.apu = new NesApu(clock, {
      onDmcStart: (addr, len) => {
        // snapshot the sample from cart PRG, wrapping $FFFF -> $8000
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          let a = addr + i;
          if (a > 0xffff) a = 0x8000 + ((a - 0x8000) & 0x7fff);
          bytes[i] = this.cart.cpuRead(a);
        }
        this.sinks.soundData?.(0, bytes);
      },
    });

    this.cpu = new M6502({
      read: addr => this.cpuRead(addr),
      write: (addr, data) => this.cpuWrite(addr, data),
    }, { bcd: false }); // RP2A03: decimal mode absent
    this.cpu.reset();
  }

  private cpuRead(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff];
    if (addr < 0x4000) return this.ppu.readReg(addr);
    if (addr === 0x4015) return this.apu.read4015();
    if (addr === 0x4016 || addr === 0x4017) {
      const tag = addr === 0x4016 ? P1 : P2;
      if (this.strobe & 1) return (this.inputs.read(tag) & 1) | 0x40;
      const reg = addr === 0x4016 ? this.pad1 : this.pad2;
      const bit = reg & 1;
      const next = (reg >> 1) | 0x80; // after 8 reads official pads return 1s
      if (addr === 0x4016) this.pad1 = next; else this.pad2 = next;
      return bit | 0x40; // open-bus high bits as MAME returns them
    }
    if (addr < 0x4020) return 0;
    return this.cart.cpuRead(addr);
  }

  private cpuWrite(addr: number, data: number): void {
    if (addr < 0x2000) { this.ram[addr & 0x7ff] = data; return; }
    if (addr < 0x4000) { this.ppu.writeReg(addr, data); return; }
    if (addr === 0x4014) {
      // OAM DMA: 256 bytes from page data<<8; CPU stalls 513/514 cycles
      const base = (data & 0xff) << 8;
      for (let i = 0; i < 256; i++) this.ppu.writeOam(this.cpuRead(base + i));
      this.pendingStall += 513 + (this.totalCycles & 1);
      return;
    }
    if (addr === 0x4016) {
      this.strobe = data & 1;
      if (!this.strobe) { // latch on strobe fall
        this.pad1 = this.inputs.read(P1) & 0xff;
        this.pad2 = this.inputs.read(P2) & 0xff;
      }
      return;
    }
    if (addr < 0x4018) {
      // APU registers ($4000-$4013, $4015, $4017) — shadow + worklet
      const offset = addr - 0x4000;
      this.apu.write(offset, data);
      this.sinks.soundWrite(offset, data, this.line / this.vtotal);
      return;
    }
    if (addr >= 0x4020) this.cart.cpuWrite(addr, data);
  }

  frame(fb: Uint32Array): void {
    for (let line = 0; line < this.vtotal; line++) {
      this.line = line;
      if (line < 240) this.ppu.renderLine(line, fb);
      else if (line === 241) this.ppu.startVblank();
      else if (line === this.vtotal - 1) this.ppu.preRender();

      if (this.ppu.takeNmi()) this.cpu.nmi();

      this.apu.tick(this.cyclesPerLine);
      this.cpu.setIrqLine(this.cart.irqAsserted() || this.apu.irqAsserted());

      this.cycleCarry += this.cyclesPerLine;
      this.pendingStall += this.apu.consumeDmcStalls();
      // stall cycles (OAM DMA, DMC fetches) consume budget as elapsed time
      const drained = Math.min(this.pendingStall, Math.max(0, Math.floor(this.cycleCarry)));
      this.pendingStall -= drained;
      this.cycleCarry -= drained;
      this.totalCycles += drained;
      const budget = Math.floor(this.cycleCarry);
      if (budget > 0) {
        // run() may overshoot by the tail of the last instruction; the carry
        // goes slightly negative and self-corrects on the next line
        const ran = this.cpu.run(budget);
        this.totalCycles += ran;
        this.cycleCarry -= ran;
      }
    }
    this.frameCount++;
  }

  reset(): void {
    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.cart.reset();
    this.strobe = 0;
    this.pad1 = 0;
    this.pad2 = 0;
    this.pendingStall = 0;
    this.cycleCarry = 0;
  }

  snapshot(): BoardSnapshot {
    return {
      frame: this.frameCount,
      cpus: [{ tag: 'maincpu', pc: this.cpu.pc, sp: 0x100 | this.cpu.s, halted: this.cpu.halted }],
      ppu: this.ppu.snapshot(),
      cart: this.cart.snapshot(),
    };
  }
}
