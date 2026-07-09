// Namco 53xx I/O custom chip (Fujitsu MB8843 MCU) — high-level emulation.
// Used by Dig Dug (and Pole Position) to multiplex DIP-switch inputs onto the
// 06xx bus. Hand-transpiled from the classic MAME HLE that shipped before the
// MCU dump (MAME 0.121 src/mame/machine/namcoio.c, namcoio_53XX_digdug_read):
//
//   switch ((in_count++) % 2) {
//     case 0: return READ_PORT(0) | (READ_PORT(1) << 4);
//     case 1: return READ_PORT(2) | (READ_PORT(3) << 4);
//   }
//
// The four input callbacks are wired exactly as the modern machine config
// (galaga.cpp digdug): in0 = DSWA&0x0f, in1 = DSWA>>4, in2 = DSWB&0x0f,
// in3 = DSWB>>4 — so successive reads return DSWA, DSWB, DSWA, ... The chip is
// polled read-only through 06xx chip-select 1; MOD/K wiring (which selects the
// MCU's mode) has no effect on this HLE, which only reproduces Dig Dug's mode.

export interface Namco53Inputs {
  /** four nibble callbacks (DSWA lo, DSWA hi, DSWB lo, DSWB hi), active low */
  in: [() => number, () => number, () => number, () => number];
}

export class Namco53 {
  private inCount = 0;
  private inputs: Namco53Inputs;

  constructor(inputs: Namco53Inputs) {
    this.inputs = inputs;
  }

  reset(): void {
    this.inCount = 0;
  }

  read(): number {
    switch (this.inCount++ % 2) {
      default:
      case 0: return (this.inputs.in[0]() & 0x0f) | ((this.inputs.in[1]() & 0x0f) << 4);
      case 1: return (this.inputs.in[2]() & 0x0f) | ((this.inputs.in[3]() & 0x0f) << 4);
    }
  }

  /** debug snapshot for the live viewer */
  snapshot() {
    return { inCount: this.inCount };
  }
}
