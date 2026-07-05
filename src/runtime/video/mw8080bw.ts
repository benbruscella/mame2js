// Midway 8080 black & white video (Space Invaders hardware): no tiles, no
// PROMs — the screen is a 1bpp bitmap shifted straight out of work RAM.
// Faithful port of mw8080bw_state::screen_update_mw8080bw
// (src/mame/midw8080/mw8080bw_v.cpp): the video shifter fetches a RAM byte
// every 8 pixels starting at pixel 4 (so each line opens with a 4-pixel
// flush of the previous byte, and the visible line is 256+4 = 260 wide),
// bits shifted out LSB first, white on black.
//
// Native landscape 260×224; the cabinet monitor is ROT270 (shell rotates).

import type { VideoRenderer } from '../types.ts';

// vertical counter starts here outside vblank (mw8080bw.h
// MW8080BW_VCOUNTER_START_NO_VBLANK); RAM offset = (y << 5) | (x >> 3),
// so the first visible row reads share offset 0x400 (= address 0x2400)
const VCOUNTER_START = 0x20;

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

export interface Mw8080bwVideoDeps {
  /** the main_ram share (0x2000 bytes at 0x2000-0x3fff) */
  mainRam: Uint8Array;
}

export class Mw8080bwVideo implements VideoRenderer {
  readonly width = 260;
  readonly height = 224;
  private ram: Uint8Array;

  constructor(deps: Mw8080bwVideoDeps) {
    this.ram = deps.mainRam;
  }

  vblank(): void { /* no per-frame latched state */ }

  render(fb: Uint32Array): void {
    // beam-faithful loop from screen_update_mw8080bw
    let x = 0;
    let y = VCOUNTER_START;
    let videoData = 0;
    for (;;) {
      fb[(y - VCOUNTER_START) * this.width + x] = (videoData & 0x01) ? WHITE : BLACK;
      videoData >>= 1;
      x = (x + 1) & 0xff;
      if (x === 0) {
        // end of line: flush the remaining 4 bits of the shift register
        for (let i = 0; i < 4; i++) {
          fb[(y - VCOUNTER_START) * this.width + 256 + i] = (videoData & 0x01) ? WHITE : BLACK;
          videoData >>= 1;
        }
        y = (y + 1) & 0xff;
        if (y === 0) break;
      } else if ((x & 0x07) === 0x04) {
        // the video RAM is read every 8 pixels starting with pixel 4
        videoData = this.ram[((y << 5) | (x >> 3)) & 0x1fff];
      }
    }
  }
}
