// Galaxian board video renderer.
//
// Hand-transpiled from MAME ground truth:
//   - src/mame/galaxian/galaxian_v.cpp (modern; primary reference):
//     galaxian_palette (:238-359), stars_init (:789-812),
//     stars_update_origin (:822-846), stars_draw_row (:869-915),
//     galaxian_draw_stars/background (:932-956), bg_get_tile_info (:487-500),
//     galaxian_objram_w scroll/color split (:514-544), sprites_clip /
//     sprites_draw (:554-619), bullets_draw (:629-660),
//     galaxian_draw_bullet (:1160-1173), screen_update_galaxian (:460-477).
//   - src/mame/galaxian/galaxian.cpp: galaxian_charlayout /
//     galaxian_spritelayout (:7391-7411), screen raw params (galaxian.h:
//     HTOTAL 384, visible H 0-255, VTOTAL 264, VBEND 16, VBSTART 240,
//     H0START 0).
//   - Cross-checked against classic MAME 0.121 src/mame/video/galaxian.c
//     (git show 7b77f121862): palette resistor description, sprite +1
//     x offset, sprites 0-2 y quirk, bullet layout, per-column scroll.
//   - src/emu/tilemap.cpp effective_colscroll (:55-74): per-column scrolly
//     is SUBTRACTED from the screen position (screen_y = tile_y - scroll),
//     i.e. the hardware adder VRAM row = V + scroll; with TILEMAP_FLIPY the
//     effective V is inverted first (matches bullets_draw's `y ^ 255`).
//
// The modern renderer prescales horizontally by GALAXIAN_XSCALE = 3 to model
// the 18 MHz star RNG clock (2 RNG clocks per 6 MHz pixel). We render at
// native 1x: both RNG entries of a pixel are evaluated and the second one
// (which covers 2 of the 3 subpixels) wins on overlap. Consecutive RNG
// states can never both be star-enabled (the feedback bit is forced 0 by
// the enable pattern), so no star is ever lost by the merge.
//
// Native (pre-rotation) resolution 256x224 = screen lines 16..239 of the
// 256-line frame (VBEND=16, VBSTART=240); ROT90 happens at blit time.
// Output pixels are packed 0xAABBGGRR (canvas ImageData order), alpha 0xff.

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';

export interface GalaxianVideoDeps {
  regions: Regions;      // gfx1 0x1000 (2bpp chars + sprites), proms 0x20
  videoram: Uint8Array;  // 0x400: 32x32 tilemap codes (row*32 + col)
  objram: Uint8Array;    // 0x100: 0x00-0x3f col scroll/color, 0x40-0x5f sprites, 0x60-0x7f bullets
}

// ---------------------------------------------------------------------------
// gfx layouts — galaxian.cpp:7391-7411, STEP macros expanded.

export const CHAR_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,2)',
  planes: 2,
  planeOffsets: ['RGN_FRAC(0,2)', 'RGN_FRAC(1,2)'],
  xOffsets: [0, 1, 2, 3, 4, 5, 6, 7],
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
  charIncrement: 8 * 8,
};

export const SPRITE_LAYOUT: GfxLayout = {
  width: 16,
  height: 16,
  total: 'RGN_FRAC(1,2)',
  planes: 2,
  planeOffsets: ['RGN_FRAC(0,2)', 'RGN_FRAC(1,2)'],
  // { STEP8(0,1), STEP8(8*8,1) }
  xOffsets: [0, 1, 2, 3, 4, 5, 6, 7, 64, 65, 66, 67, 68, 69, 70, 71],
  // { STEP8(0,8), STEP8(16*8,8) }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 128, 136, 144, 152, 160, 168, 176, 184],
  charIncrement: 16 * 16,
};

// ---------------------------------------------------------------------------
// resnet.cpp port (same faithful subset as video/galaga.ts: pulldown
// supported, pullup passed but always 0 here; autoscale scaler).

interface ResNetwork {
  resistances: number[];
  pulldown: number; // Ohms, 0 = none
  pullup: number;   // Ohms, 0 = none
}

/** Port of compute_resistor_weights() (resnet.cpp), autoscale when scaler < 0. */
function computeResistorWeights(
  minval: number,
  maxval: number,
  scaler: number,
  nets: ResNetwork[],
): number[][] {
  const w: number[][] = [];
  for (const net of nets) {
    const r = net.resistances;
    const count = r.length;
    const ww: number[] = new Array<number>(count);
    for (let n = 0; n < count; n++) {
      let R0 = net.pulldown === 0 ? 1.0 / 1e12 : 1.0 / net.pulldown;
      let R1 = net.pullup === 0 ? 1.0 / 1e12 : 1.0 / net.pullup;
      for (let j = 0; j < count; j++) {
        if (j === n) {
          if (r[j] !== 0) R1 += 1.0 / r[j];
        } else if (r[j] !== 0) {
          R0 += 1.0 / r[j];
        }
      }
      R0 = 1.0 / R0;
      R1 = 1.0 / R1;
      const vout = (maxval - minval) * (R0 / (R1 + R0)) + minval;
      ww[n] = Math.min(Math.max(vout, minval), maxval);
    }
    w.push(ww);
  }

  let scale: number;
  if (scaler < 0.0) {
    let max = 0.0;
    for (const ww of w) {
      let sum = 0.0;
      for (const v of ww) sum += v;
      if (sum > max) max = sum;
    }
    scale = maxval / max;
  } else {
    scale = scaler;
  }

  return w.map((ww) => ww.map((v) => v * scale));
}

/** Port of combine_weights() (resnet.h): int(sum(tab[i]*w[i]) + 0.5). */
function combineWeights(tab: number[], ...bits: number[]): number {
  let sum = 0.0;
  for (let i = 0; i < bits.length; i++) sum += tab[i] * bits[i];
  return Math.floor(sum + 0.5);
}

function packRGB(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

const BLACK = packRGB(0, 0, 0);

// ---------------------------------------------------------------------------
// Palette — port of galaxian_state::galaxian_palette (galaxian_v.cpp:238-359).
//
// 32-byte PROM = 8 colors x 4 pens, shared by chars and sprites (pen 0
// transparent in both). RGB nets 1k/470/220 (R,G) and 470/220 (B), each with
// a 470 Ohm pulldown, normalized to RGB_MAXIMUM = 224 to leave headroom for
// stars and bullets.

const RGB_MAXIMUM = 224;

export interface GalaxianPalette {
  /** 32 PROM entries (8 colors x 4 pens), packed 0xAABBGGRR. */
  colors: Uint32Array;
  /** 64 star colors from the 2-bit-per-gun 150/100 Ohm network. */
  stars: Uint32Array;
  /** 8 bullet colors: entries 0-6 white shells, entry 7 yellow missile. */
  bullets: Uint32Array;
}

export function buildGalaxianPalette(proms: Uint8Array): GalaxianPalette {
  const rgbResistances = [1000, 470, 220];
  const [rweights, gweights, bweights] = computeResistorWeights(0, RGB_MAXIMUM, -1.0, [
    { resistances: rgbResistances, pulldown: 470, pullup: 0 },
    { resistances: rgbResistances, pulldown: 470, pullup: 0 },
    { resistances: [470, 220], pulldown: 470, pullup: 0 },
  ]);

  const colors = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const v = proms[i];
    const r = combineWeights(rweights, v & 1, (v >> 1) & 1, (v >> 2) & 1);
    const g = combineWeights(gweights, (v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1);
    const b = combineWeights(bweights, (v >> 6) & 1, (v >> 7) & 1);
    colors[i] = packRGB(r, g, b);
  }

  // Star colors (galaxian_v.cpp:305-353): tilemap max ~130 Ohm was mapped to
  // RGB_MAXIMUM; the stars sit at 150/100/60 Ohm, compressed into 194..255.
  // Integer arithmetic preserved from the C code.
  const minval = Math.floor((RGB_MAXIMUM * 130) / 150); // 194
  const midval = Math.floor((RGB_MAXIMUM * 130) / 100); // 291
  const maxval = Math.floor((RGB_MAXIMUM * 130) / 60);  // 485
  const starmap = [
    0,
    minval,
    minval + Math.floor(((255 - minval) * (midval - minval)) / (maxval - minval)),
    255,
  ];

  const stars = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    // bit 5 = red @ 150 Ohm, bit 4 = red @ 100 Ohm (100 Ohm is the MSB)
    const r = starmap[(((i >> 4) & 1) << 1) | ((i >> 5) & 1)];
    const g = starmap[(((i >> 2) & 1) << 1) | ((i >> 3) & 1)];
    const b = starmap[((i & 1) << 1) | ((i >> 1) & 1)];
    stars[i] = packRGB(r, g, b);
  }

  // Bullets: 7 white "shells" + 1 yellow "missile" (galaxian_v.cpp:355-358).
  const bullets = new Uint32Array(8);
  for (let i = 0; i < 7; i++) bullets[i] = packRGB(0xff, 0xff, 0xff);
  bullets[7] = packRGB(0xff, 0xff, 0x00);

  return { colors, stars, bullets };
}

// ---------------------------------------------------------------------------
// Star generator — port of stars_init (galaxian_v.cpp:789-812).
//
// A 17-bit shift register clocked at 18 MHz (2 clocks per visible pixel);
// a star is emitted when the top 8 bits are 1 and the low bit is 0, with a
// 6-bit color from the bits below the top 8, further gated by V1 ^ H8.

export const STAR_RNG_PERIOD = (1 << 17) - 1;

/** Precompute the full RNG period: color in bits 0-5, enable in bit 7. */
export function buildGalaxianStarTable(): Uint8Array {
  const table = new Uint8Array(STAR_RNG_PERIOD);
  let shiftreg = 0;
  for (let i = 0; i < STAR_RNG_PERIOD; i++) {
    const enabled = (shiftreg & 0x1fe01) === 0x1fe00 ? 1 : 0;
    const color = (~shiftreg & 0x1f8) >> 3;
    table[i] = color | (enabled << 7);
    // feedback is the XOR of bit 12 and the inverse of bit 0
    shiftreg = ((shiftreg >> 1) | ((((shiftreg >> 12) ^ ~shiftreg) & 1) << 16)) & 0x1ffff;
  }
  return table;
}

// screen geometry (galaxian.h: VBEND 16, VBSTART 240, visible H 0..255)
const VBEND = 16;
const NATIVE_W = 256;
const NATIVE_H = 224;

// ---------------------------------------------------------------------------

export class GalaxianVideo implements VideoRenderer {
  readonly width: number = NATIVE_W;
  readonly height: number = NATIVE_H;

  private readonly videoram: Uint8Array;
  private readonly objram: Uint8Array;
  private readonly charGfx: GfxSet;
  private readonly spriteGfx: GfxSet;
  private readonly pal: GalaxianPalette;
  private readonly starTable: Uint8Array;

  private starsEnabled = 0;
  private starOrigin = 0;
  private flipX = 0;
  private flipY = 0;

  constructor(deps: GalaxianVideoDeps) {
    const gfx1 = deps.regions['gfx1'];
    const proms = deps.regions['proms'];
    if (!gfx1 || !proms) throw new Error('galaxian video: missing gfx1/proms region');
    if (proms.length < 0x20) throw new Error('galaxian video: proms region too small');

    this.videoram = deps.videoram;
    this.objram = deps.objram;
    this.charGfx = decodeGfx(CHAR_LAYOUT, gfx1);     // 256 8x8 chars
    this.spriteGfx = decodeGfx(SPRITE_LAYOUT, gfx1); // 64 16x16 sprites (same ROM)
    this.pal = buildGalaxianPalette(proms);
    this.starTable = buildGalaxianStarTable();
  }

  /** galaxian_stars_enable_w: rising edge releases CLR = resets the RNG origin. */
  setStarsEnable(data: number): void {
    const on = data & 1;
    // MAME resets the origin relative to the beam position; we render whole
    // frames, so a rising edge restarts the sequence at frame origin 0.
    if (!this.starsEnabled && on) this.starOrigin = 0;
    this.starsEnabled = on;
  }

  /** galaxian_flip_screen_x_w */
  setFlipX(data: number): void { this.flipX = data & 1; }

  /** galaxian_flip_screen_y_w */
  setFlipY(data: number): void { this.flipY = data & 1; }

  reset(): void {
    this.starsEnabled = 0;
    this.starOrigin = 0;
    this.flipX = 0;
    this.flipY = 0;
  }

  /**
   * Per-frame star scroll — stars_update_origin (galaxian_v.cpp:822-846):
   * the RNG runs 2^17-2 clocks per frame unflipped (one LESS than the
   * period) and 2^17 when x-flipped (one MORE), producing the horizontal
   * drift. render() itself is pure; only vblank() advances the origin.
   */
  vblank(): void {
    const delta = this.flipX ? 1 : -1;
    this.starOrigin = (this.starOrigin + delta + STAR_RNG_PERIOD) % STAR_RNG_PERIOD;
  }

  /** Port of screen_update_galaxian (galaxian_v.cpp:460-477). */
  render(frame: Uint32Array): void {
    frame.fill(BLACK);                       // galaxian_draw_background
    if (this.starsEnabled) this.drawStars(frame);
    this.drawTilemap(frame);
    this.drawSprites(frame);
    this.drawBullets(frame);
  }

  /** Port of galaxian_draw_stars + stars_draw_row (galaxian_v.cpp:869-946). */
  private drawStars(frame: Uint32Array): void {
    const table = this.starTable;
    const colors = this.pal.stars;
    for (let fy = 0; fy < NATIVE_H; fy++) {
      const y = fy + VBEND;                  // screen scanline 16..239
      let offs = (this.starOrigin + y * 512) % STAR_RNG_PERIOD;
      const row = fy * NATIVE_W;
      for (let x = 0; x < NATIVE_W; x++) {
        // stars are suppressed unless V1 ^ H8 == 1
        const enable = (y ^ (x >> 3)) & 1;
        // first RNG clock (1 of 3 subpixels), then second (2 of 3): the
        // second wins at native resolution; both can never be enabled.
        let star = table[offs];
        if (++offs >= STAR_RNG_PERIOD) offs = 0;
        if (enable && (star & 0x80)) frame[row + x] = colors[star & 0x3f];
        star = table[offs];
        if (++offs >= STAR_RNG_PERIOD) offs = 0;
        if (enable && (star & 0x80)) frame[row + x] = colors[star & 0x3f];
      }
    }
  }

  /**
   * Background tilemap: 32x32 grid of 8x8 chars, TILEMAP_SCAN_ROWS
   * (tile = videoram[row*32 + col]), individually scrolling columns with
   * per-column color from the objram attribute bytes (even = scroll,
   * odd = color & 7; galaxian_v.cpp:487-544). Scroll addressing follows the
   * hardware adder (VRAM row = V + scroll, tilemap.cpp effective_colscroll):
   * the fetched tile row for screen line y is (effV + scroll) >> 3 with
   * effV = flipY ? 255 - y : y; flips mirror the final coordinates.
   * Pen 0 is transparent (stars show through).
   */
  private drawTilemap(frame: Uint32Array): void {
    const vram = this.videoram;
    const objram = this.objram;
    const pix = this.charGfx.pixels;
    const colors = this.pal.colors;
    const flipX = this.flipX;
    const flipY = this.flipY;

    for (let fy = 0; fy < NATIVE_H; fy++) {
      const y = fy + VBEND;
      const effy = flipY ? y ^ 255 : y;
      const row = fy * NATIVE_W;
      for (let col = 0; col < 32; col++) {
        const scroll = objram[col << 1];
        const colorBase = (objram[(col << 1) | 1] & 7) << 2;
        const sum = (effy + scroll) & 0xff;
        const code = vram[((sum >> 3) << 5) | col];
        const srcRow = (code << 6) + ((sum & 7) << 3);
        for (let px = 0; px < 8; px++) {
          const pen = pix[srcRow + px];
          if (pen === 0) continue;           // transparent_pen(0)
          let nx = (col << 3) | px;
          if (flipX) nx ^= 255;              // TILEMAP_FLIPX mirrors the layer
          frame[row + nx] = colors[colorBase + pen];
        }
      }
    }
  }

  /**
   * Port of sprites_draw + sprites_clip (galaxian_v.cpp:554-619): 8 entries
   * at objram 0x40-0x5f (y, code|flips, color, x). Drawn 7..0 so lower
   * numbers win (line-buffer priority). Quirks: sprites 0-2 match y-1 (one
   * pixel lower); +1 x offset vs the tile layer; the first 16+1 pixels
   * (last, when x-flipped) are hard-clipped by the line buffer.
   */
  private drawSprites(frame: Uint32Array): void {
    const objram = this.objram;
    const pix = this.spriteGfx.pixels;
    const count = this.spriteGfx.count;
    const colors = this.pal.colors;
    const minX = this.flipX ? 0 : 16 + 1;
    const maxX = this.flipX ? 256 - (16 + 1) - 1 : 255;

    for (let sprnum = 7; sprnum >= 0; sprnum--) {
      const base = 0x40 + sprnum * 4;
      // the first three sprites match against y-1
      const sy0 = (240 - (objram[base] - (sprnum < 3 ? 1 : 0))) & 0xff;
      const code = objram[base + 1] & 0x3f;
      let flipx = objram[base + 1] & 0x40;
      let flipy = objram[base + 1] & 0x80;
      const colorBase = (objram[base + 2] & 7) << 2;
      // the +1 x offset (sprite vs tile layer) is supported by a LOT of games
      const sx0 = (objram[base + 3] + 1) & 0xff;

      let sx = sx0;
      let sy = sy0;
      if (this.flipX) { sx = (240 - sx) & 0xff; flipx = flipx ? 0 : 1; }
      if (this.flipY) { sy = (240 - sy) & 0xff; flipy = flipy ? 0 : 1; }

      const srcBase = (code % count) << 8;
      for (let py = 0; py < 16; py++) {
        const fy = sy + py - VBEND;
        if (fy < 0 || fy >= NATIVE_H) continue;
        const srcRow = srcBase + ((flipy ? 15 - py : py) << 4);
        const dstRow = fy * NATIVE_W;
        for (let px = 0; px < 16; px++) {
          const nx = sx + px;
          if (nx < minX || nx > maxX) continue;
          const pen = pix[srcRow + (flipx ? 15 - px : px)];
          if (pen === 0) continue;           // transpen(0)
          frame[dstRow + nx] = colors[colorBase + pen];
        }
      }
    }
  }

  /**
   * Port of bullets_draw + galaxian_draw_bullet (galaxian_v.cpp:629-660,
   * 1160-1173): 8 entries at objram 0x60-0x7f, 4 bytes each — byte 1 is the
   * y match value, byte 3 the x position. A scanline matches entry n when
   * (byte1 + effY) & 0xff == 0xff (entries 0-2 match y-1). One shell
   * (entries 0-6, white) and the missile (entry 7, yellow) can render per
   * line; each is a 4-pixel horizontal run ending at 254 - byte3.
   * Note MAME applies no flip-x correction to bullets.
   */
  private drawBullets(frame: Uint32Array): void {
    const objram = this.objram;
    const bullets = this.pal.bullets;
    const flipY = this.flipY;

    for (let fy = 0; fy < NATIVE_H; fy++) {
      const y = fy + VBEND;
      let shell = -1;
      let missile = -1;

      // the first 3 entries match Y-1
      let effy = flipY ? (y - 1) ^ 255 : y - 1;
      for (let which = 0; which < 3; which++) {
        if (((objram[0x60 + which * 4 + 1] + effy) & 0xff) === 0xff) shell = which;
      }
      // remaining entries match Y
      effy = flipY ? y ^ 255 : y;
      for (let which = 3; which < 8; which++) {
        if (((objram[0x60 + which * 4 + 1] + effy) & 0xff) === 0xff) {
          if (which !== 7) shell = which;
          else missile = which;
        }
      }

      if (shell >= 0) this.drawBullet(frame, fy, 255 - objram[0x60 + shell * 4 + 3], bullets[shell]);
      if (missile >= 0) this.drawBullet(frame, fy, 255 - objram[0x60 + 7 * 4 + 3], bullets[7]);
    }
  }

  /** 4-pixel run at x-4 .. x-1 (shots display while H counts 0xFC..0xFF). */
  private drawBullet(frame: Uint32Array, fy: number, x: number, color: number): void {
    const row = fy * NATIVE_W;
    x -= 4;
    for (let i = 0; i < 4; i++, x++) {
      if (x >= 0 && x < NATIVE_W) frame[row + x] = color;
    }
  }
}
