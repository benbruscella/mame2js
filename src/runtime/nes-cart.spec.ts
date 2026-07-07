// Self-test for the NES cart/mapper layer (nrom/uxrom/cnrom/sxrom/txrom).
// Run with: node src/runtime/nes-cart.spec.ts
// Behavior reference: MAME src/devices/bus/nes/{nxrom,mmc1,mmc3}.cpp.

import { createCart, type NesCartConfig, type Mirroring } from './nes-cart.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    totalPass++;
  } else {
    totalFail++;
    console.log(`  FAIL ${label}: got ${a}, want ${e}`);
  }
}

/** PRG where every byte encodes its own 8K bank number; CHR encodes 1K bank. */
function makeCart(opts: { prg16: number; chr8: number; mapper: number; mirroring?: Mirroring }): NesCartConfig {
  const prg = new Uint8Array(opts.prg16 * 0x4000);
  for (let i = 0; i < prg.length; i++) prg[i] = i >> 13;
  const chr = new Uint8Array(opts.chr8 * 0x2000);
  for (let i = 0; i < chr.length; i++) chr[i] = i >> 10;
  return { prg, chr, mapper: opts.mapper, mirroring: opts.mirroring ?? 'vertical' };
}

// MMC1 serial write helper: 5 LSB-first writes
function mmc1Write(cart: ReturnType<typeof createCart>, addr: number, value: number): void {
  for (let i = 0; i < 5; i++) cart.cpuWrite(addr, (value >> i) & 1);
}

// --- nrom ---------------------------------------------------------------------
{
  const c = createCart(makeCart({ prg16: 1, chr8: 1, mapper: 0 }));
  eq('nrom 16K: $8000 bank 0', c.cpuRead(0x8000), 0);
  eq('nrom 16K: $C000 mirrors bank 0', c.cpuRead(0xc000), 0);
  const c32 = createCart(makeCart({ prg16: 2, chr8: 1, mapper: 0 }));
  eq('nrom 32K: $C000 second half', c32.cpuRead(0xc000), 2);
  eq('nrom chr', [c.chrRead(0), c.chrRead(0x1c00)], [0, 7]);
  c.cpuWrite(0x6000, 0x5a);
  eq('wram readback', c.cpuRead(0x6000), 0x5a);
  eq('open bus low area', c.cpuRead(0x4020), 0xff);
  c.chrWrite(0, 0x99);
  eq('chr-rom not writable', c.chrRead(0), 0);
}

// --- chr-ram (chr size 0) -------------------------------------------------------
{
  const cfg = makeCart({ prg16: 1, chr8: 0, mapper: 0 });
  const c = createCart(cfg);
  c.chrWrite(0x0123, 0x42);
  eq('chr-ram writable', c.chrRead(0x0123), 0x42);
}

// --- mirroring ------------------------------------------------------------------
{
  const v = createCart(makeCart({ prg16: 1, chr8: 1, mapper: 0, mirroring: 'vertical' }));
  v.ntWrite(0x000, 1);   // NT0
  v.ntWrite(0x400, 2);   // NT1
  eq('vertical: NT2 mirrors NT0', v.ntRead(0x800), 1);
  eq('vertical: NT3 mirrors NT1', v.ntRead(0xc00), 2);
  const h = createCart(makeCart({ prg16: 1, chr8: 1, mapper: 0, mirroring: 'horizontal' }));
  h.ntWrite(0x000, 3);
  h.ntWrite(0x800, 4);
  eq('horizontal: NT1 mirrors NT0', h.ntRead(0x400), 3);
  eq('horizontal: NT3 mirrors NT2', h.ntRead(0xc00), 4);
  const f = createCart(makeCart({ prg16: 1, chr8: 1, mapper: 0, mirroring: 'four' }));
  f.ntWrite(0x000, 5); f.ntWrite(0x400, 6); f.ntWrite(0x800, 7); f.ntWrite(0xc00, 8);
  eq('four-screen distinct', [f.ntRead(0), f.ntRead(0x400), f.ntRead(0x800), f.ntRead(0xc00)], [5, 6, 7, 8]);
}

// --- uxrom -----------------------------------------------------------------------
{
  const c = createCart(makeCart({ prg16: 8, chr8: 0, mapper: 2 }));
  eq('uxrom boot: last bank fixed at $C000', c.cpuRead(0xc000), 14);
  c.cpuWrite(0x8000, 3);
  eq('uxrom bank 3 at $8000', c.cpuRead(0x8000), 6);
  eq('uxrom $C000 still last', c.cpuRead(0xc000), 14);
  c.cpuWrite(0xffff, 12); // wraps modulo 8 banks -> bank 4
  eq('uxrom bank wraps modulo count', c.cpuRead(0x8000), 8);
}

// --- cnrom ----------------------------------------------------------------------
{
  const c = createCart(makeCart({ prg16: 2, chr8: 4, mapper: 3 }));
  eq('cnrom boot chr bank 0', c.chrRead(0), 0);
  c.cpuWrite(0x8000, 2);
  eq('cnrom chr bank 2', c.chrRead(0), 16);
  eq('cnrom prg untouched', c.cpuRead(0x8000), 0);
}

// --- sxrom / MMC1 -----------------------------------------------------------------
{
  const c = createCart(makeCart({ prg16: 8, chr8: 4, mapper: 1 }));
  // power-on: control=0x0c -> prg mode 3 (switch $8000, fix last at $C000)
  eq('mmc1 boot: last 16K fixed', c.cpuRead(0xc000), 14);
  mmc1Write(c, 0xe000, 3); // prg reg = 3
  eq('mmc1 prg mode 3 bank 3', c.cpuRead(0x8000), 6);
  eq('mmc1 fixed high bank', c.cpuRead(0xc000), 14);
  // switch to prg mode 2 (fix FIRST at $8000, switch $C000)
  mmc1Write(c, 0x8000, 0x08); // control: mirroring 0(single0), prgMode 2, chr 8K
  mmc1Write(c, 0xe000, 5);
  eq('mmc1 prg mode 2: first fixed', c.cpuRead(0x8000), 0);
  eq('mmc1 prg mode 2: $C000 bank 5', c.cpuRead(0xc000), 10);
  // 32K mode
  mmc1Write(c, 0x8000, 0x00); // prgMode 0
  mmc1Write(c, 0xe000, 6);    // 32K bank 3 (6>>1)
  eq('mmc1 32K mode', [c.cpuRead(0x8000), c.cpuRead(0xc000)], [12, 14]);
  // chr 4K mode
  mmc1Write(c, 0x8000, 0x10); // chrMode 1 (4K), prgMode 0
  mmc1Write(c, 0xa000, 5);    // chr0 = 4K bank 5
  mmc1Write(c, 0xc000, 2);    // chr1 = 4K bank 2
  eq('mmc1 chr 4K banks', [c.chrRead(0), c.chrRead(0x1000)], [20, 8]);
  // reset bit clears shift + forces prg mode 3
  c.cpuWrite(0x8000, 0x80);
  mmc1Write(c, 0xe000, 1);
  eq('mmc1 reset -> mode 3', [c.cpuRead(0x8000), c.cpuRead(0xc000)], [2, 14]);
  // serial across different addresses: only the FIFTH write's address counts
  c.cpuWrite(0x8000, 1); c.cpuWrite(0x8000, 0); c.cpuWrite(0x8000, 0); c.cpuWrite(0x8000, 0);
  c.cpuWrite(0xe000, 0); // -> prg reg = 1
  eq('mmc1 fifth-write address selects reg', c.cpuRead(0x8000), 2);
  // mirroring via control
  mmc1Write(c, 0x8000, 0x0e); // mirroring 2 = vertical
  c.ntWrite(0x000, 9);
  eq('mmc1 vertical mirroring set', c.ntRead(0x800), 9);
  // wram disable
  c.cpuWrite(0x6000, 0x77);
  mmc1Write(c, 0xe000, 0x10); // bit4 = wram disabled
  eq('mmc1 wram disabled reads open', c.cpuRead(0x6000), 0xff);
}

// --- txrom / MMC3 ------------------------------------------------------------------
{
  const c = createCart(makeCart({ prg16: 8, chr8: 4, mapper: 4 })); // 16×8K prg, 32×1K chr
  // boot: prg mode 0 -> $C000 = second-last, $E000 = last
  eq('mmc3 boot fixed banks', [c.cpuRead(0xc000), c.cpuRead(0xe000)], [14, 15]);
  const setBank = (reg: number, val: number) => { c.cpuWrite(0x8000, reg); c.cpuWrite(0x8001, val); };
  setBank(6, 4);
  setBank(7, 9);
  eq('mmc3 prg mode 0 banks', [c.cpuRead(0x8000), c.cpuRead(0xa000)], [4, 9]);
  // prg mode 1: $8000 <-> $C000 swapped
  c.cpuWrite(0x8000, 0x46);
  c.cpuWrite(0x8001, 4);
  eq('mmc3 prg mode 1', [c.cpuRead(0x8000), c.cpuRead(0xc000), c.cpuRead(0xa000)], [14, 4, 9]);
  // chr banks, normal orientation: 2×2K at $0000 (regs 0,1), 4×1K at $1000 (regs 2-5)
  c.cpuWrite(0x8000, 0); c.cpuWrite(0x8001, 7);   // reg0: 2K bank -> 1K banks 6,7 at $0000 (bit0 forced even)
  c.cpuWrite(0x8000, 2); c.cpuWrite(0x8001, 20);  // reg2: 1K bank at $1000
  eq('mmc3 chr 2K forced-even', [c.chrRead(0x0000), c.chrRead(0x0400)], [6, 7]);
  eq('mmc3 chr 1K slot 4', c.chrRead(0x1000), 20);
  // chr inversion (bit7): halves swap
  c.cpuWrite(0x8000, 0x80 | 2); c.cpuWrite(0x8001, 20);
  eq('mmc3 chr inverted', [c.chrRead(0x0000), c.chrRead(0x1000), c.chrRead(0x1400)], [20, 6, 7]);
  // mirroring reg
  c.cpuWrite(0xa000, 1); // horizontal
  c.ntWrite(0x000, 3);
  eq('mmc3 mirroring horizontal', c.ntRead(0x400), 3);
  // IRQ counter: latch 3, reload, count down on scanlineTick, assert at 0
  c.cpuWrite(0xc000, 3);   // latch
  c.cpuWrite(0xc001, 0);   // reload flag
  c.cpuWrite(0xe001, 0);   // enable
  c.scanlineTick();        // reload -> 3
  eq('mmc3 irq not yet (3)', c.irqAsserted(), false);
  c.scanlineTick();        // 2
  c.scanlineTick();        // 1
  eq('mmc3 irq not yet (1)', c.irqAsserted(), false);
  c.scanlineTick();        // 0 -> assert
  eq('mmc3 irq asserted at 0', c.irqAsserted(), true);
  c.cpuWrite(0xe000, 0);   // disable + ack
  eq('mmc3 irq acked', c.irqAsserted(), false);
  c.scanlineTick();        // counter reloads (was 0) -> 3, no assert while disabled
  c.scanlineTick(); c.scanlineTick(); c.scanlineTick();
  eq('mmc3 irq stays off while disabled', c.irqAsserted(), false);
  // wram protect
  c.cpuWrite(0xa001, 0x80); // enabled, writable
  c.cpuWrite(0x6000, 0x11);
  c.cpuWrite(0xa001, 0xc0); // enabled, write-protected
  c.cpuWrite(0x6000, 0x22);
  eq('mmc3 wram write-protect', c.cpuRead(0x6000), 0x11);
}

// --- unsupported mapper ------------------------------------------------------------
{
  let threw = '';
  try { createCart(makeCart({ prg16: 1, chr8: 1, mapper: 66 })); }
  catch (e) { threw = String((e as Error).message); }
  eq('unsupported mapper throws', threw.includes('mapper 66'), true);
}

console.log(`\nnes-cart.spec: ${totalPass} passed, ${totalFail} failed`);
if (totalFail > 0) process.exitCode = 1;
