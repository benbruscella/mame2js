// Irem M52 (Moon Patrol) board video renderer.
//
// Hand-transpiled from MAME ground truth (all video code is inline in
// src/mame/irem/m52.cpp — there is no m52_v.cpp in the modern tree):
//   - init_palette (m52.cpp:164-224): tx/bg resistor nets 1k/470/220 (R,G)
//     and 470/220 (B), no pulldown, autoscaled to 255; bg pen->indirect map
//     (:210-221).  init_sprite_palette (:226-255): same resistances but WITH
//     a 470 Ohm pulldown per net, reusing the tx autoscale factor, and the
//     R/B bit assignments swapped (R = PROM bits 6,7 through the 2-resistor
//     net; G = bits 3,4,5; B = bits 0,1,2); spr_clut PROM (256 entries) maps
//     sprite pens to the 32 indirect colors.
//   - get_tile_info (:264-285): code = videoram | (colorram&0x80)<<1, color =
//     colorram & 0x7f, tile rows 0..6 are TILE_FORCE_LAYER0 (opaque).
//   - video_start (:295-312): 32x32 tx tilemap of 8x8 chars, transparent
//     pen 0, scrolldx(127,127), scrolldy(16,16), scroll_rows(4);
//     m_spritelimit = 0x100-4; m_do_bg_fills = true.
//   - scroll_w (:336-349): one hardware x-scroll register gated by V64/V128 —
//     rowscroll quarters 0-2 = 255 (pull-ups), quarter 3 = -(data+1).
//   - draw_background (:460-514): 256x128 strip drawn twice (xpos and
//     xpos-256) with transparent pen 0 at xpos = bgxpos+124, ypos = bgypos+16
//     (flip: xpos = 264-bgxpos, ypos = 264-bgypos-128 first), plus a solid
//     pen-3 fill covering ypos+128..ypos+255 (flip: ypos-128..ypos-1).
//   - draw_sprites (:524-569): entry = [y, color|flips, code, x]; sy =
//     257-y, sx = x+129 (flip: sx = 238-x, sy = 282-sy, flips inverted);
//     transmask via sp palette transpen_mask(color, 0) = pens whose CLUT
//     value is 0 are transparent.  SPLIT_SPRITES is never defined, so the
//     upper/lower half clip is dead code (clip = cliprect, :559-563).
//   - screen_update (:579-606): fill with sprite pen 0 -> if !(bgcontrol &
//     0x20): mountains strip (bg0, x/y regs #1) unless bgcontrol&0x10, then
//     hills (bg1) unless bgcontrol&0x02 else city (bg2) unless
//     bgcontrol&0x04, both from x/y regs #0 -> tx tilemap -> sprite groups
//     0x00-0x3f, 0x40-0x7f, 0x80-0xbf, 0xc0-0xff (within a group offsets
//     descend, so LOWER offsets are drawn LAST and win).
//   - gfx layouts: spritelayout (:863-872, 16x16x3 planar, third plane region
//     is 0x00-filled so real pens are 0..3), bgcharlayout (:874-910, one
//     256x128 2bpp image, planes packed 4/0 in each byte, rows banked
//     0x4000 bits apart; bytes 0x1000+ are 0xff-filled = pen 3), tx chars =
//     gfx_8x8x2_planar (src/emu/video/generic.cpp:30-39, plane 0 = MSB =
//     second region half).
//   - screen raw params (m52.cpp:964): 18.432MHz/3, htotal 384 visible
//     136..375 (240 wide), vtotal 282 visible 22..273 (252 high), ROT0.
//   - tilemap scroll semantics (src/emu/tilemap.cpp:27-46,55-73,1070-1140):
//     effective rowscroll = dx - rowscroll[quarter] wrapped into [0,256)
//     (flip: xextent-256-(dx_flipped-rowscroll[3-quarter]), xextent =
//     visarea.left+right+1 = 512); source column = (screen_x - eff) & 255;
//     effective colscroll = dy = 16 (flip: yextent-256-dy_flipped = 24);
//     instances repeat every 256 px both ways (the bottom 2 visible lines
//     wrap back to tile row 0).
//   - drawgfx color wrapping (src/emu/drawgfx.cpp:489-516): color %= colors()
//     (16 for sprites), code %= elements() (128).
//
// Native (pre-rotation) resolution 240x252 = screen 136..375 x 22..273.
// Output pixels are packed 0xAABBGGRR (canvas ImageData order), alpha 0xff.
//
// Board contract (M52VideoDeps): the board owns the write latches and hands
// live getters to the renderer, GalagaVideo-style:
//   videoram  0x8000-0x83ff share (0x400)      colorram 0x8400-0x87ff (0x400)
//   spriteram 0xc800-0xcbff share (>= 0x100 used)
//   scroll()    last byte written to io 0x00 (m52_state::scroll_w)
//   bgxpos0/bgypos0()  io 0x40 / 0x60 (bgxpos_w<0> / bgypos_w<0> — hills/city)
//   bgxpos1/bgypos1()  io 0x80 / 0xa0 (bgxpos_w<1> / bgypos_w<1> — mountains)
//   bgcontrol() io 0xc0 (m52_state::bgcontrol_w)
//   flip?()     flip_screen state = (0xd001 data & 1) ^ (~DSW2 & 1)
//               (m52_state::flipscreen_w, :438-445); omitted = never flipped
// All latches reset to 0 (machine_reset, m52.cpp:936-943).

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';

export interface M52VideoDeps {
  regions: Regions;       // tx 0x2000, sp 0x3000, bg0/bg1/bg2 0x2000,
                          // tx_pal 0x200, bg_pal 0x20, spr_pal 0x20, spr_clut 0x100
  videoram: Uint8Array;   // 0x400: 32x32 tile codes, TILEMAP_SCAN_ROWS
  colorram: Uint8Array;   // 0x400: bit7 = code bit 8, bits 0-6 = color
  spriteram: Uint8Array;  // >= 0x100 (4 groups x 16 sprites x 4 bytes)
  scroll: () => number;
  bgxpos0: () => number;
  bgypos0: () => number;
  bgxpos1: () => number;
  bgypos1: () => number;
  bgcontrol: () => number;
  flip?: () => boolean;
}

// ---------------------------------------------------------------------------
// gfx layouts

/** gfx_8x8x2_planar (src/emu/video/generic.cpp:30-39): plane 0 (MSB) is the
 *  SECOND half of the tx region. */
export const TX_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,2)',
  planes: 2,
  planeOffsets: ['RGN_FRAC(1,2)', 'RGN_FRAC(0,2)'],
  xOffsets: [0, 1, 2, 3, 4, 5, 6, 7],
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
  charIncrement: 8 * 8,
};

/** spritelayout (m52.cpp:863-872): 16x16, 3 planes at region thirds 2/0/1
 *  (plane 0 = MSB = third 2, which mpatrol leaves 0x00-filled). */
export const SPRITE_LAYOUT: GfxLayout = {
  width: 16,
  height: 16,
  total: 'RGN_FRAC(1,3)',
  planes: 3,
  planeOffsets: ['RGN_FRAC(2,3)', 'RGN_FRAC(0,3)', 'RGN_FRAC(1,3)'],
  // { STEP8(0,1), STEP8(16*8,1) }
  xOffsets: [0, 1, 2, 3, 4, 5, 6, 7, 128, 129, 130, 131, 132, 133, 134, 135],
  // { STEP16(0,8) }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120],
  charIncrement: 32 * 8,
};

/** bgcharlayout (m52.cpp:874-910): one 256x128 2bpp image; the two planes
 *  for 4 pixels are packed into one byte (upper nibble = LSBs, lower nibble
 *  = MSBs); rows are banked in four 32-row groups 0x4000 bits apart. */
export function buildBgLayout(): GfxLayout {
  const xOffsets: number[] = [];
  for (let x = 0; x < 256; x++) xOffsets.push((x >> 2) * 8 + (x & 3)); // STEP4(0x000,1), STEP4(0x008,1), ...
  const yOffsets: number[] = [];
  for (let y = 0; y < 128; y++) yOffsets.push((y >> 5) * 0x4000 + (y & 31) * 0x200); // STEP32(0,0x200) x4 banks
  return {
    width: 256,
    height: 128,
    total: 1,
    planes: 2,
    planeOffsets: [4, 0],
    xOffsets,
    yOffsets,
    charIncrement: 0x8000,
  };
}

// ---------------------------------------------------------------------------
// resnet.cpp port (same faithful subset as video/galaxian.ts, extended to
// also return the autoscale factor, which init_sprite_palette reuses).

interface ResNetwork {
  resistances: number[];
  pulldown: number; // Ohms, 0 = none
  pullup: number;   // Ohms, 0 = none
}

/** Port of compute_resistor_weights() (resnet.cpp), autoscale when scaler < 0. */
export function computeResistorWeights(
  minval: number,
  maxval: number,
  scaler: number,
  nets: ResNetwork[],
): { weights: number[][]; scale: number } {
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

  return { weights: w.map((ww) => ww.map((v) => v * scale)), scale };
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

// ---------------------------------------------------------------------------
// Palettes — port of m52_state::init_palette + init_sprite_palette
// (m52.cpp:164-255).  Three independent palettes:
//   tx: 512 direct pens from the 0x200 tx_pal PROM
//   bg: 12 pens (3 strips x 4) indirected into the 32-color bg_pal PROM
//   sp: 256 pens indirected through the 0x100 spr_clut PROM into the
//       32-color spr_pal PROM (CLUT value 0 = transparent, per transpen_mask)

/** bg pen -> indirect color, m52.cpp:210-221 (xbb00 mountains / 0xxbb hills
 *  / 1xxbb city rows of the 32x8 PROM). */
export const BG_PEN_MAP: readonly number[] = [
  0, 4, 8, 12,        // strip 0: mountains
  0, 1, 2, 3,         // strip 1: hills
  0, 16 + 1, 16 + 2, 16 + 3, // strip 2: city
];

export interface M52Palette {
  txPens: Uint32Array;     // 512, packed 0xAABBGGRR
  bgIndirect: Uint32Array; // 32
  bgPens: Uint32Array;     // 12 = 3 strips x 4 pens (via BG_PEN_MAP)
  spIndirect: Uint32Array; // 32
  spPens: Uint32Array;     // 256 sprite pens resolved through spr_clut
  spClut: Uint8Array;      // raw spr_clut values (0 = transparent pen)
}

export function buildM52Palette(regions: Regions): M52Palette {
  const txPal = regions['tx_pal'];
  const bgPal = regions['bg_pal'];
  const sprPal = regions['spr_pal'];
  const sprClut = regions['spr_clut'];
  if (!txPal || !bgPal || !sprPal || !sprClut) {
    throw new Error('m52 video: missing tx_pal/bg_pal/spr_pal/spr_clut region');
  }
  if (txPal.length < 0x200 || bgPal.length < 0x20 || sprPal.length < 0x20 || sprClut.length < 0x100) {
    throw new Error('m52 video: palette PROM region too small');
  }

  const resistances3 = [1000, 470, 220];
  const resistances2 = [470, 220];

  // characters / backgrounds (m52.cpp:171-174): no pulldown, autoscale to 255
  const txNets = computeResistorWeights(0, 255, -1.0, [
    { resistances: resistances3, pulldown: 0, pullup: 0 }, // R
    { resistances: resistances3, pulldown: 0, pullup: 0 }, // G
    { resistances: resistances2, pulldown: 0, pullup: 0 }, // B
  ]);
  const [wr, wg, wb] = txNets.weights;

  // character palette (m52.cpp:177-186): R bits 0-2, G bits 3-5, B bits 6-7
  const txPens = new Uint32Array(512);
  for (let i = 0; i < 512; i++) {
    const v = txPal[i];
    txPens[i] = packRGB(
      combineWeights(wr, v & 1, (v >> 1) & 1, (v >> 2) & 1),
      combineWeights(wg, (v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1),
      combineWeights(wb, (v >> 6) & 1, (v >> 7) & 1),
    );
  }

  // background indirect colors (m52.cpp:189-198): same weights/bit order
  const bgIndirect = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const v = bgPal[i];
    bgIndirect[i] = packRGB(
      combineWeights(wr, v & 1, (v >> 1) & 1, (v >> 2) & 1),
      combineWeights(wg, (v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1),
      combineWeights(wb, (v >> 6) & 1, (v >> 7) & 1),
    );
  }
  const bgPens = new Uint32Array(12);
  for (let i = 0; i < 12; i++) bgPens[i] = bgIndirect[BG_PEN_MAP[i]];

  // sprites (m52.cpp:233-244): 470 Ohm pulldown per net, tx autoscale factor
  // reused, and R uses the 2-resistor net on PROM bits 6,7 (B on bits 0-2)
  const spNets = computeResistorWeights(0, 255, txNets.scale, [
    { resistances: resistances2, pulldown: 470, pullup: 0 }, // R
    { resistances: resistances3, pulldown: 470, pullup: 0 }, // G
    { resistances: resistances3, pulldown: 470, pullup: 0 }, // B
  ]);
  const [swr, swg, swb] = spNets.weights;

  const spIndirect = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const v = sprPal[i];
    spIndirect[i] = packRGB(
      combineWeights(swr, (v >> 6) & 1, (v >> 7) & 1),
      combineWeights(swg, (v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1),
      combineWeights(swb, v & 1, (v >> 1) & 1, (v >> 2) & 1),
    );
  }

  // sprite lookup table (m52.cpp:250-254)
  const spClut = new Uint8Array(0x100);
  const spPens = new Uint32Array(0x100);
  for (let i = 0; i < 0x100; i++) {
    spClut[i] = sprClut[i];
    spPens[i] = spIndirect[sprClut[i] & 0x1f]; // 32 indirect colors
  }

  return { txPens, bgIndirect, bgPens, spIndirect, spPens, spClut };
}

// ---------------------------------------------------------------------------
// screen geometry (m52.cpp:964 set_raw): visible x 136..375, y 22..273

const HBEND = 136;
const VBEND = 22;
const NATIVE_W = 240;
const NATIVE_H = 252;

// tilemap constants (video_start, m52.cpp:295-302)
const TX_DX = 127;          // set_scrolldx(127, 127)
const TX_DY = 16;           // set_scrolldy(16, 16)
const XEXTENT = 375 + 136 + 1; // tilemap.cpp:1013 (flip pivot), = 512
const YEXTENT = 273 + 22 + 1;  // = 296

const BGHEIGHT = 128;

// ---------------------------------------------------------------------------

export class M52Video implements VideoRenderer {
  readonly width: number = NATIVE_W;
  readonly height: number = NATIVE_H;

  private readonly deps: M52VideoDeps;
  private readonly videoram: Uint8Array;
  private readonly colorram: Uint8Array;
  private readonly spriteram: Uint8Array;
  private readonly charGfx: GfxSet;
  private readonly spriteGfx: GfxSet;
  private readonly bgGfx: GfxSet[];
  private readonly pal: M52Palette;

  constructor(deps: M52VideoDeps) {
    const tx = deps.regions['tx'];
    const sp = deps.regions['sp'];
    const bg0 = deps.regions['bg0'];
    const bg1 = deps.regions['bg1'];
    const bg2 = deps.regions['bg2'];
    if (!tx || !sp || !bg0 || !bg1 || !bg2) {
      throw new Error('m52 video: missing tx/sp/bg0/bg1/bg2 region');
    }
    if (tx.length < 0x2000 || sp.length < 0x3000 || bg0.length < 0x2000 ||
        bg1.length < 0x2000 || bg2.length < 0x2000) {
      throw new Error('m52 video: gfx region too small');
    }
    if (deps.videoram.length < 0x400 || deps.colorram.length < 0x400) {
      throw new Error('m52 video: videoram/colorram must be 0x400 bytes');
    }
    if (deps.spriteram.length < 0x100) {
      throw new Error('m52 video: spriteram must be >= 0x100 bytes');
    }

    this.deps = deps;
    this.videoram = deps.videoram;
    this.colorram = deps.colorram;
    this.spriteram = deps.spriteram;
    this.charGfx = decodeGfx(TX_LAYOUT, tx);          // 512 8x8 2bpp chars
    this.spriteGfx = decodeGfx(SPRITE_LAYOUT, sp);    // 128 16x16 "3bpp" sprites
    const bgLayout = buildBgLayout();
    this.bgGfx = [decodeGfx(bgLayout, bg0), decodeGfx(bgLayout, bg1), decodeGfx(bgLayout, bg2)];
    this.pal = buildM52Palette(deps.regions);
  }

  /** All per-frame state is read live from the board latches. */
  vblank(): void {}

  /** Port of m52_state::screen_update (m52.cpp:579-606). */
  render(frame: Uint32Array): void {
    const flip = this.deps.flip ? this.deps.flip() : false;

    frame.fill(this.pal.spPens[0]); // bitmap.fill(sp pen 0)

    const bgcontrol = this.deps.bgcontrol() & 0xff;
    if (!(bgcontrol & 0x20)) {
      if (!(bgcontrol & 0x10)) {
        this.drawBackground(frame, this.deps.bgxpos1() & 0xff, this.deps.bgypos1() & 0xff, 0, flip); // distant mountains
      }
      // only one of these is drawn at once (they share the same scroll register)
      if (!(bgcontrol & 0x02)) {
        this.drawBackground(frame, this.deps.bgxpos0() & 0xff, this.deps.bgypos0() & 0xff, 1, flip); // hills
      } else if (!(bgcontrol & 0x04)) {
        this.drawBackground(frame, this.deps.bgxpos0() & 0xff, this.deps.bgypos0() & 0xff, 2, flip); // cityscape
      }
    }

    this.drawTx(frame, flip);
    this.drawSprites(frame, flip);
  }

  /**
   * One 256x128 parallax strip (draw_background, m52.cpp:460-514): the image
   * is drawn twice (xpos and xpos-256, which fully tiles the 240 visible
   * columns for every register value — equivalent to a mod-256 wrap) with
   * pen 0 transparent, at a fixed y; the 128 rows below it are filled solid
   * with pen 3 (m_do_bg_fills = true for mpatrol).  Strip pens are
   * bgPens[image*4 + pen] (gfxdecode color bases 0/4/8, m52.cpp:921-925).
   */
  private drawBackground(frame: Uint32Array, bgx: number, bgy: number, image: number, flip: boolean): void {
    const pix = this.bgGfx[image].pixels;
    const pens = this.pal.bgPens;
    const base = image * 4;
    const fillColor = pens[base + 3];

    let xpos = bgx;
    let ypos = bgy;
    if (flip) {
      xpos = 264 - xpos;
      ypos = 264 - ypos - BGHEIGHT;
    }
    xpos += 124;
    ypos += 16; // "this may not be correct" per MAME, ported as-is

    for (let fby = 0; fby < NATIVE_H; fby++) {
      const rel = fby + VBEND - ypos;
      const dstRow = fby * NATIVE_W;
      if (rel >= 0 && rel < BGHEIGHT) {
        const srcRow = (flip ? BGHEIGHT - 1 - rel : rel) << 8;
        for (let fbx = 0; fbx < NATIVE_W; fbx++) {
          const sc = (((fbx + HBEND - xpos) % 256) + 256) % 256;
          const pen = pix[srcRow + (flip ? sc ^ 0xff : sc)];
          if (pen !== 0) frame[dstRow + fbx] = pens[base + pen]; // transpen 0
        }
      } else if (flip ? rel >= -BGHEIGHT && rel < 0 : rel >= BGHEIGHT && rel < 2 * BGHEIGHT) {
        // solid fill below (above, when flipped) the strip, m52.cpp:495-513
        for (let fbx = 0; fbx < NATIVE_W; fbx++) frame[dstRow + fbx] = fillColor;
      }
    }
  }

  /**
   * tx tilemap: 32x32 grid of 8x8 chars, TILEMAP_SCAN_ROWS, transparent
   * pen 0 except tile rows 0..6 (TILE_FORCE_LAYER0, get_tile_info
   * m52.cpp:279-282).  Rowscroll in 4 quarters (only tile rows 24-31
   * scroll): rows 0-2 hold 255, row 3 holds -(data+1) (scroll_w,
   * m52.cpp:336-349).  Effective scroll per tilemap.cpp:27-46: dx=127 ->
   * static quarters land at (screen_x - 128) & 255, the scrolled quarter at
   * (screen_x - 128 - data) & 255.  dy=16 (24 flipped); the visible bottom
   * two lines wrap back to tile row 0.
   */
  private drawTx(frame: Uint32Array, flip: boolean): void {
    const vram = this.videoram;
    const cram = this.colorram;
    const pix = this.charGfx.pixels;
    const pens = this.pal.txPens;
    const scrollData = this.deps.scroll() & 0xff;

    for (let fby = 0; fby < NATIVE_H; fby++) {
      const sy = fby + VBEND;
      // effective colscroll (tilemap.cpp:55-73): dy, or yextent-height-dy_flipped
      const srcYf = (sy - (flip ? YEXTENT - 256 - TX_DY : TX_DY)) & 0xff;
      // rowscroll quarter in draw space; FLIPY reads m_rowscroll[3 - q]
      const q = flip ? 3 - (srcYf >> 6) : srcYf >> 6;
      const rowscroll = q < 3 ? 255 : -(scrollData + 1);
      // effective rowscroll (tilemap.cpp:27-46), wrapped into [0, 256)
      const raw = flip ? XEXTENT - 256 - (TX_DX - rowscroll) : TX_DX - rowscroll;
      const eff = ((raw % 256) + 256) % 256;

      const srcY = flip ? srcYf ^ 0xff : srcYf;
      const rowBase = (srcY >> 3) << 5;
      const py = srcY & 7;
      const opaqueRow = srcY >> 3 <= 6; // TILE_FORCE_LAYER0 rows 0..6
      const dstRow = fby * NATIVE_W;

      for (let fbx = 0; fbx < NATIVE_W; fbx++) {
        const srcXf = (fbx + HBEND - eff) & 0xff;
        const srcX = flip ? srcXf ^ 0xff : srcXf;
        const idx = rowBase | (srcX >> 3);
        const attr = cram[idx];
        const code = vram[idx] | ((attr & 0x80) << 1);
        const pen = pix[(code << 6) | (py << 3) | (srcX & 7)];
        if (pen === 0 && !opaqueRow) continue; // transparent_pen(0)
        frame[dstRow + fbx] = pens[((attr & 0x7f) << 2) | pen];
      }
    }
  }

  /**
   * Sprites (draw_sprites + screen_update, m52.cpp:524-569, 601-604):
   * 4 groups of 16 entries; groups drawn in ascending order (later groups
   * win), offsets within a group drawn descending (LOWER offsets win).
   * Entry [y, color|flipx<<6|flipy<<7, code, x]; sy = 257 - y, sx = x + 129;
   * flip screen: sx = 238 - x, sy = 282 - sy, flips inverted.  Pen p of
   * color c is transparent iff spr_clut[(c % 16)*8 + p] == 0 (transmask with
   * transpen_mask(color, 0)); code wraps % 128 (drawgfx.cpp:489-516).
   */
  private drawSprites(frame: Uint32Array, flip: boolean): void {
    const ram = this.spriteram;
    const pix = this.spriteGfx.pixels;
    const count = this.spriteGfx.count;
    const pens = this.pal.spPens;
    const clut = this.pal.spClut;

    // m_spritelimit = 0x100 - 4 = 0xfc (video_start, m52.cpp:310)
    for (let initoffs = 0x3c; initoffs <= 0xfc; initoffs += 0x40) {
      for (let offs = initoffs; offs >= (initoffs & 0xc0); offs -= 4) {
        let sy = 257 - ram[offs];
        const color = ram[offs + 1] & 0x3f;
        let flipx = (ram[offs + 1] & 0x40) !== 0;
        let flipy = (ram[offs + 1] & 0x80) !== 0;
        const code = ram[offs + 2] % count;
        let sx = ram[offs + 3];

        if (flip) {
          flipx = !flipx;
          flipy = !flipy;
          sx = 238 - sx;
          sy = 282 - sy;
        }
        sx += 129;

        const penBase = (color % 16) << 3; // color % colors(16), granularity 8
        const srcBase = code << 8;
        for (let py = 0; py < 16; py++) {
          const fby = sy + py - VBEND;
          if (fby < 0 || fby >= NATIVE_H) continue;
          const srcRow = srcBase + ((flipy ? 15 - py : py) << 4);
          const dstRow = fby * NATIVE_W;
          for (let px = 0; px < 16; px++) {
            const fbx = sx + px - HBEND;
            if (fbx < 0 || fbx >= NATIVE_W) continue;
            const pen = pix[srcRow + (flipx ? 15 - px : px)];
            const penIdx = penBase | pen;
            if (clut[penIdx] === 0) continue; // transpen_mask(color, 0)
            frame[dstRow + fbx] = pens[penIdx];
          }
        }
      }
    }
  }
}
