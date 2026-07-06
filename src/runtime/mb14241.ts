// MB14241 data shifter (Space Invaders et al.) for mame2js.
//
// Faithful port of MAME src/devices/machine/mb14241.cpp. The chip holds a
// 15-bit shift register; each data write pushes a new byte in on top
// (data = data>>8 | new<<7, so two consecutive writes A then B leave
// ((B<<8 | A) >> 1) in the register), and the result read returns
// ((B<<8 | A) >> (8 - n)) & 0xff for a written shift count n (the count
// port stores ~n & 7). MAME method names write_d0-style camelCased per
// repo convention: shift_count_w -> shiftCountW, etc.

export class MB14241 {
  private shiftData = 0; // 15-bit shift register
  private shiftCount = 0; // 0..7

  reset(): void {
    this.shiftData = 0;
    this.shiftCount = 0;
  }

  /** shift_count_w: latch the shift amount (low 3 bits, stored inverted). */
  shiftCountW(data: number): void {
    this.shiftCount = ~data & 0x07;
  }

  /** shift_data_w: push a byte into the 15-bit shift register. */
  shiftDataW(data: number): void {
    this.shiftData = ((this.shiftData >> 8) | ((data & 0xff) << 7)) & 0x7fff;
  }

  /** shift_result_r: read the window selected by the shift count. */
  shiftResultR(): number {
    return (this.shiftData >> this.shiftCount) & 0xff;
  }
}
