// Pac-Man board video renderer.
//
// Hand-transpiled from MAME ground truth:
//   - src/mame/pacman/pacman_v.cpp  (pacman_palette, pacman_scan_rows,
//     pacman_get_tile_info, draw_sprites, screen_update_pacman)
//   - src/mame/pacman/pacman.cpp    (tilelayout/spritelayout, gfx_pacman
//     decode table, screen set_raw 288x224, mainlatch Q3 = flipscreen)
//   - src/mame/video/pacman.c at MAME 0.121 (git 7b77f121862) — identical
//     palette/scan/sprite math, used to cross-check the port.
//   - src/emu/video/resnet.cpp      (compute_resistor_weights / combine_weights)
//
// Native (pre-rotation) resolution 288x224 — same relationship as galaga:
// MAME's pacman also renders the 36x28 tilemap into a 288x224 landscape
// bitmap and applies ROT90 at blit time; our shell does the same rotation.
// Output pixels are packed 0xAABBGGRR (little-endian RGBA for canvas
// ImageData), alpha always 0xff.

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';

export interface PacmanVideoDeps {
  regions: Regions;               // gfx1 0x2000 (chars @0, sprites @0x1000), proms 0x120
  videoram: Uint8Array;           // 0x400 tile codes
  colorram: Uint8Array;           // 0x400 tile colors (low 5 bits)
  spriteram: Uint8Array;          // 0x10: 8 x (code<<2 | flipy<<1 | flipx, color)
  spriteram2: Uint8Array;         // 0x10: 8 x (y, x)
  mainlatch: () => number;        // LS259 Q0..Q7 (Q3 = flipscreen, pacman.cpp:3716)
}

// ---------------------------------------------------------------------------
// gfx layouts — pacman.cpp:3598-3631 (tilelayout / spritelayout); the
// GFXDECODE_ENTRY offsets (chars @0x0000, sprites @0x1000, pacman.cpp:3668-
// 3671) are handled by decoding each half of gfx1 separately, so the MAME
// RGN_FRAC(1,2) totals become RGN_FRAC(1,1) of the respective half.

export const TILE_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,1)',         // 256 chars in the 0x1000 half
  planes: 2,
  planeOffsets: [0, 4],           // two bitplanes packed 4 pixels per byte
  // { 8*8+0, 8*8+1, 8*8+2, 8*8+3, 0, 1, 2, 3 }
  xOffsets: [64, 65, 66, 67, 0, 1, 2, 3],
  // { 0*8, 1*8, ..., 7*8 }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
  charIncrement: 16 * 8,
};

export const SPRITE_LAYOUT: GfxLayout = {
  width: 16,
  height: 16,
  total: 'RGN_FRAC(1,1)',         // 64 sprites in the 0x1000 half
  planes: 2,
  planeOffsets: [0, 4],
  // { 8*8, 8*8+1..3, 16*8+0..3, 24*8+0..3, 0..3 }
  xOffsets: [64, 65, 66, 67, 128, 129, 130, 131, 192, 193, 194, 195, 0, 1, 2, 3],
  // { 0*8..7*8, 32*8..39*8 }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 256, 264, 272, 280, 288, 296, 304, 312],
  charIncrement: 64 * 8,
};

// ---------------------------------------------------------------------------
// resnet.cpp port (what pacman_palette needs; identical math to the copy in
// video/galaga.ts, which does not export it).

interface ResNetwork {
  resistances: number[];
  pulldown: number; // Ohms, 0 = none
  pullup: number;   // Ohms, 0 = none
}

/** Port of compute_resistor_weights() (resnet.cpp:55-227), autoscale when scaler < 0. */
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
          if (r[j] !== 0) R1 += 1.0 / r[j]!;
        } else if (r[j] !== 0) {
          R0 += 1.0 / r[j]!;
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

/** Port of combine_weights() (resnet.h:181): int(sum(tab[i]*w[i]) + 0.5). */
function combineWeights(tab: number[], ...bits: number[]): number {
  let sum = 0.0;
  for (let i = 0; i < bits.length; i++) sum += tab[i]! * bits[i]!;
  return Math.floor(sum + 0.5);
}

// ---------------------------------------------------------------------------
// Palette — port of pacman_state::pacman_palette (pacman_v.cpp:65-116).
//
// proms region layout: 32-byte palette PROM @0x000 (bit 0 = red 1k ... bit 7
// = blue 220), 256-byte 4-bit color lookup PROM @0x020.  Pac-Man only ever
// uses the first palette bank (m_palettebank == 0), so the "| 0x10" second
// bank is not materialized here.

export interface PacmanPalette {
  /** 32 core RGB entries (packed 0xAABBGGRR). */
  core: Uint32Array;
  /** 64 colors x 4 pens -> RGB (indirect lut & 0x0f, first bank). */
  penColor: Uint32Array;
  /** 1 where the pen is transparent for sprites (indirect pen == 0, i.e.
   *  transpen_mask(gfx(1), color, 0) — pacman_v.cpp:307).  The tilemap is
   *  drawn TILEMAP_DRAW_OPAQUE, so this only applies to sprites. */
  penTrans: Uint8Array;
}

function packRGB(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function buildPacmanPalette(proms: Uint8Array): PacmanPalette {
  const resistances = [1000, 470, 220];

  // compute the color output resistor weights (same nets as galaga)
  const [rweights, gweights, bweights] = computeResistorWeights(0, 255, -1.0, [
    { resistances, pulldown: 0, pullup: 0 },
    { resistances, pulldown: 0, pullup: 0 },
    { resistances: [470, 220], pulldown: 0, pullup: 0 },
  ]) as [number[], number[], number[]];

  // core palette (32 indirect colors)
  const core = new Uint32Array(32);
  for (let i = 0; i < 32; i++) {
    const v = proms[i]!;
    const r = combineWeights(rweights, v & 1, (v >> 1) & 1, (v >> 2) & 1);
    const g = combineWeights(gweights, (v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1);
    const b = combineWeights(bweights, (v >> 6) & 1, (v >> 7) & 1);
    core[i] = packRGB(r, g, b);
  }

  // color lookup PROM @0x020: pen i -> indirect (lut & 0x0f); sprites treat
  // pens mapping to indirect color 0 (black) as transparent
  const penColor = new Uint32Array(64 * 4);
  const penTrans = new Uint8Array(64 * 4);
  for (let i = 0; i < 64 * 4; i++) {
    const v = proms[0x020 + i]! & 0x0f;
    penColor[i] = core[v]!;
    penTrans[i] = v === 0 ? 1 : 0;
  }

  return { core, penColor, penTrans };
}

// ---------------------------------------------------------------------------
// Tilemap mapper — port of pacman_state::pacman_scan_rows (pacman_v.cpp:172-
// 179).  Converts logical (col,row) of the 36x28 layout to a videoram offset;
// the top/bottom two screen rows (cols 0,1 and 34,35 in the native-landscape
// frame) live at the ends of the 32x32 address space.  JS bitwise ops
// reproduce the C uint underflow for col < 2.

export function pacmanScanRows(col: number, row: number): number {
  row += 2;
  col -= 2;
  if (col & 0x20) return row + ((col & 0x1f) << 5);
  return col + (row << 5);
}

// sprite visible area — pacman_v.cpp:279 rectangle spriteclip(2*8, 34*8-1, 0*8, 28*8-1)
const SPRITE_CLIP_X0 = 16;
const SPRITE_CLIP_X1 = 34 * 8 - 1; // 271
const SPRITE_CLIP_Y0 = 0;
const SPRITE_CLIP_Y1 = 28 * 8 - 1; // 223

// ---------------------------------------------------------------------------

export class PacmanVideo implements VideoRenderer {
  // set_raw(18.432MHz/3, 384, 0, 288, 264, 0, 224) -> visible 288x224
  readonly width: number = 288;
  readonly height: number = 224;

  private readonly videoram: Uint8Array;
  private readonly colorram: Uint8Array;
  private readonly spriteram: Uint8Array;
  private readonly spriteram2: Uint8Array;
  private readonly mainlatch: () => number;

  private readonly charGfx: GfxSet;
  private readonly spriteGfx: GfxSet;
  private readonly pal: PacmanPalette;

  constructor(deps: PacmanVideoDeps) {
    const gfx1 = deps.regions['gfx1'];
    const proms = deps.regions['proms'];
    if (!gfx1 || !proms) throw new Error('pacman video: missing gfx1/proms region');
    if (gfx1.length < 0x2000) throw new Error('pacman video: gfx1 region too small');
    if (proms.length < 0x120) throw new Error('pacman video: proms region too small');

    this.videoram = deps.videoram;
    this.colorram = deps.colorram;
    this.spriteram = deps.spriteram;
    this.spriteram2 = deps.spriteram2;
    this.mainlatch = deps.mainlatch;

    this.charGfx = decodeGfx(TILE_LAYOUT, gfx1.subarray(0x0000, 0x1000));   // 256 8x8 chars
    this.spriteGfx = decodeGfx(SPRITE_LAYOUT, gfx1.subarray(0x1000, 0x2000)); // 64 16x16 sprites
    this.pal = buildPacmanPalette(proms);
  }

  /** Port of screen_update_pacman (pacman_v.cpp:362-377), m_bgpriority == 0. */
  render(frame: Uint32Array): void {
    const flip = (this.mainlatch() >> 3) & 1; // mainlatch Q3 -> flipscreen_w
    this.drawTilemap(frame, flip);            // TILEMAP_DRAW_OPAQUE
    this.drawSprites(frame);
  }

  /** No per-frame state to latch (no starfield on this board). */
  vblank(): void { /* nothing */ }

  /**
   * bg tilemap draw: 36x28 tiles of 8x8, mapper pacman_scan_rows, tile info
   * per pacman_get_tile_info (pacman_v.cpp:181-187): code = videoram[offs]
   * (charbank 0), attr = colorram[offs] & 0x1f (colortablebank/palettebank 0).
   * Drawn opaque; flip_screen sets TILEMAP_FLIPX|TILEMAP_FLIPY (pacman_v.cpp
   * flipscreen_w), i.e. mirrored position + per-tile x/y pixel flip.
   */
  private drawTilemap(frame: Uint32Array, flip: number): void {
    const vram = this.videoram;
    const cram = this.colorram;
    const gfx = this.charGfx;
    const src = gfx.pixels;
    const penColor = this.pal.penColor;
    const w = this.width;

    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const offs = pacmanScanRows(col, row);
        const code = vram[offs]!;
        const color = cram[offs]! & 0x1f;
        const colorBase = color * 4;
        const base = (code % gfx.count) * 64;

        const destX = (flip ? 35 - col : col) * 8;
        const destY = (flip ? 27 - row : row) * 8;

        for (let py = 0; py < 8; py++) {
          const srcRow = base + (flip ? 7 - py : py) * 8;
          const dstRow = (destY + py) * w + destX;
          for (let px = 0; px < 8; px++) {
            const pen = src[srcRow + (flip ? 7 - px : px)]!;
            frame[dstRow + px] = penColor[colorBase + pen]!;
          }
        }
      }
    }
  }

  /**
   * Port of pacman_state::draw_sprites (pacman_v.cpp:274-356), pacman
   * config: m_inv_spr = 0, m_spritebank/m_colortablebank/m_palettebank = 0,
   * m_xoffsethack = 1.  8 sprites; sprites 5..7 (offs 14..6) draw first,
   * then sprites 0..2 (offs 4..0) one pixel lower in native y — MAME's
   * "first two sprites must be offset one pixel" positioning quirk (the
   * code actually applies it to the first THREE slots).  Each sprite is
   * also plotted wrapped at sx-256 (tunnel wraparound).  Note draw_sprites
   * does not consult flipscreen — the game software flips sprite
   * coordinates itself in cocktail mode.
   */
  private drawSprites(frame: Uint32Array): void {
    const sr = this.spriteram;
    const sr2 = this.spriteram2;

    for (let offs = 0x10 - 2; offs > 2 * 2; offs -= 2) {
      this.drawOneSprite(frame, sr, sr2, offs, 0);
    }
    for (let offs = 2 * 2; offs >= 0; offs -= 2) {
      this.drawOneSprite(frame, sr, sr2, offs, 1); // + m_xoffsethack
    }
  }

  private drawOneSprite(
    frame: Uint32Array,
    sr: Uint8Array,
    sr2: Uint8Array,
    offs: number,
    yhack: number,
  ): void {
    const sx = 272 - sr2[offs + 1]!;
    const sy = sr2[offs]! - 31 + yhack;
    const fx = sr[offs]! & 1;
    const fy = (sr[offs]! & 2) >> 1;
    const code = sr[offs]! >> 2;             // | (m_spritebank << 6), bank 0
    const color = sr[offs + 1]! & 0x1f;      // | banks << 5/6, banks 0

    this.drawSpriteTile(frame, code, color, fx, fy, sx, sy);
    this.drawSpriteTile(frame, code, color, fx, fy, sx - 256, sy); // wraparound
  }

  /** gfx(1)->transmask(...): 16x16 tile, pens with lut==0 transparent, sprite clip rect. */
  private drawSpriteTile(
    frame: Uint32Array,
    code: number,
    color: number,
    flipx: number,
    flipy: number,
    sx: number,
    sy: number,
  ): void {
    const gfx = this.spriteGfx;
    const src = gfx.pixels;
    const base = (code % gfx.count) * 256;   // code % total_elements, per MAME drawgfx
    const colorBase = color * 4;
    const penColor = this.pal.penColor;
    const penTrans = this.pal.penTrans;
    const w = this.width;

    for (let py = 0; py < 16; py++) {
      const dy = sy + py;
      if (dy < SPRITE_CLIP_Y0 || dy > SPRITE_CLIP_Y1) continue;
      const srcRow = base + (flipy ? 15 - py : py) * 16;
      const dstRow = dy * w;
      for (let px = 0; px < 16; px++) {
        const dx = sx + px;
        if (dx < SPRITE_CLIP_X0 || dx > SPRITE_CLIP_X1) continue;
        const pen = src[srcRow + (flipx ? 15 - px : px)]!;
        if (penTrans[colorBase + pen]!) continue;
        frame[dstRow + dx] = penColor[colorBase + pen]!;
      }
    }
  }
}
