// GI ER2055 EAROM (64x8 electrically-alterable ROM). Non-volatile high-score
// storage in Dig Dug. Hand-transpiled from MAME src/devices/machine/er2055.cpp.
//
// The five control lines are packed into one state byte (same bit assignments
// as MAME's header). Writes and erases happen when CS1&CS2 are asserted and a
// control/select transition occurs; reads latch rom[address] on the falling
// edge of CLK. The 64 data bytes are non-volatile — reset() keeps them (the
// board seeds/persists them via localStorage).

const CK = 0x01;
const C1 = 0x02;
const C2 = 0x04;
const CS1 = 0x08;
const CS2 = 0x10;
const SEL = CS1 | CS2;

export const ER2055_SIZE = 0x40;

export class ER2055 {
  /** 64 non-volatile data bytes (default all-0xff, as MAME nvram_default). */
  readonly data = new Uint8Array(ER2055_SIZE).fill(0xff);
  /** invoked after a write/erase mutates `data` (board persists to localStorage). */
  onStore?: () => void;

  private control = 0;
  private address = 0;
  private latch = 0; // m_data: last value written by the CPU or latched by a read

  reset(): void {
    // device_start clears the control state; the data array is non-volatile.
    this.control = 0;
    this.address = 0;
    this.latch = 0;
  }

  /** ER2055 data() — the byte the CPU reads back (write latch or read result). */
  read(): number {
    return this.latch;
  }

  setAddress(addr: number): void {
    this.address = addr & 0x3f;
  }

  setData(data: number): void {
    this.latch = data & 0xff;
  }

  /** set_control(cs1, cs2, c1, c2) — reacts to select/mode transitions. */
  setControl(cs1: number, cs2: number, c1: number, c2: number): void {
    const oldstate = this.control;
    let s = oldstate & CK;
    if (c1) s |= C1;
    if (c2) s |= C2;
    if (cs1) s |= CS1;
    if (cs2) s |= CS2;
    this.control = s;
    // not selected, or nothing changed -> done
    if ((s & SEL) !== SEL || s === oldstate) return;
    this.updateState();
  }

  /** set_clk(state) — reads/writes execute on the falling edge while selected. */
  setClk(state: number): void {
    const oldstate = this.control;
    if (state) this.control |= CK;
    else this.control &= ~CK;

    if ((this.control & SEL) === SEL && this.control !== oldstate && !state) {
      // read mode (C2 is "don't care")
      if ((this.control & C1) === C1) {
        this.latch = this.data[this.address]!;
      }
      this.updateState();
    }
  }

  private updateState(): void {
    switch (this.control & (C1 | C2)) {
      case 0: // write mode: AND against previous (erase is required first)
        this.data[this.address] = this.data[this.address]! & this.latch;
        this.onStore?.();
        break;
      case C2: // erase mode
        this.data[this.address] = 0xff;
        this.onStore?.();
        break;
    }
  }

  snapshot() {
    return { address: this.address, control: this.control };
  }
}
