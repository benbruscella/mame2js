// Dig Dug board video renderer.
//
// Hand-transpiled from MAME ground truth:
//   - src/mame/namco/digdug.cpp   (digdug_palette, tilemap_scan,
//     bg_get_tile_info, tx_get_tile_info, draw_sprites, screen_update_digdug)
//   - src/mame/namco/galaga.cpp   (charlayout_digdug, spritelayout_galaga,
//     charlayout_2bpp, gfx_digdug decode table, screen set_raw 288x224)
//   - src/emu/video/resnet.cpp    (compute_resistor_weights / combine_weights,
//     shared in video/resnet.ts)
//
// Three layers, bottom to top: paged "dirt" background tilemap (gfx3 tiles
// indexed through a background-map ROM in gfx4), transparent text/alpha
// tilemap (gfx1, 1bpp), then sprites (gfx2). Native resolution 288x224;
// output pixels are packed 0xAABBGGRR (canvas ImageData order), alpha 0xff.

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';
import { computeResistorWeights, combineWeights, packRGB } from './resnet.ts';

export interface DigdugVideoDeps {
  regions: Regions;         // gfx1 (chars) gfx2 (sprites) gfx3 (bg tiles) gfx4 (bg map) proms 0x220
  videoram: Uint8Array;     // 0x400: text/alpha tilemap codes
  objram: Uint8Array;       // 0x400: sprite number/color at 0x380..0x3ff
  posram: Uint8Array;       // 0x400: sprite x/y at 0x380..0x3ff
  flpram: Uint8Array;       // 0x400: sprite flip flags at 0x380..0x3ff
  videolatch: () => number; // LS259: Q0-1 bg_select, Q2 tx_color_mode, Q3 bg_disable, Q4-5 bg_color_bank, Q7 flip
}

// ---------------------------------------------------------------------------
// gfx layouts — galaga.cpp charlayout_digdug (1439), spritelayout_galaga
// (1472), charlayout_2bpp (used for bg tiles); STEP macros expanded.

// 8x8, 1bpp, { STEP8(7,-1) } x, { STEP8(0,8) } y, 8*8 increment
const CHAR_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,1)',
  planes: 1,
  planeOffsets: [0],
  xOffsets: [7, 6, 5, 4, 3, 2, 1, 0],
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
  charIncrement: 8 * 8,
};

// 16x16, 2bpp — identical to Galaga's spritelayout_galaga
const SPRITE_LAYOUT: GfxLayout = {
  width: 16,
  height: 16,
  total: 'RGN_FRAC(1,1)',
  planes: 2,
  planeOffsets: [0, 4],
  xOffsets: [0, 1, 2, 3, 64, 65, 66, 67, 128, 129, 130, 131, 192, 193, 194, 195],
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 256, 264, 272, 280, 288, 296, 304, 312],
  charIncrement: 64 * 8,
};

// 8x8, 2bpp — charlayout_2bpp (the bg tile shapes, gfx3)
const BG_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,1)',
  planes: 2,
  planeOffsets: [0, 4],
  xOffsets: [64, 65, 66, 67, 0, 1, 2, 3],
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
  charIncrement: 16 * 8,
};

// ---------------------------------------------------------------------------
// Palette — port of digdug_state::digdug_palette (digdug.cpp:29-81).
//
// proms region layout: 32-byte palette PROM @0x000, then two 256-byte lookup
// PROMs (sprites @0x020, background @0x120). Characters are direct-mapped in
// hardware and use no PROM.

export interface DigdugPalette {
  /** 32 core RGB entries (packed 0xAABBGGRR). */
  core: Uint32Array;
  /** 16 colors x 2 pens -> RGB for chars; pen 0 is always transparent. */
  charColor: Uint32Array;
  /** 64 colors x 4 pens -> RGB for sprites (indirect (lut&0x0f)|0x10). */
  spriteColor: Uint32Array;
  /** 1 where the sprite pen is transparent (indirect == 0x1f, i.e. lut nibble 0x0f). */
  spriteTrans: Uint8Array;
  /** 64 colors x 4 pens -> RGB for background (indirect lut&0x0f). */
  bgColor: Uint32Array;
}

export function buildDigdugPalette(proms: Uint8Array): DigdugPalette {
  const resistances = [1000, 470, 220];

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

  // characters — direct mapping: pen 0 transparent, pen 1 -> indirect color i
  const charColor = new Uint32Array(16 * 2);
  for (let i = 0; i < 16; i++) {
    charColor[i * 2 + 0] = 0;          // transparent (never sampled)
    charColor[i * 2 + 1] = core[i]!;   // set_pen_indirect((i<<1)|1, i)
  }

  // sprites — proms[0x020..0x11f]; indirect (lut & 0x0f) | 0x10; transparent
  // pen when indirect == 0x1f (transpen_mask(gfx1, color, 0x1f))
  const spriteColor = new Uint32Array(64 * 4);
  const spriteTrans = new Uint8Array(64 * 4);
  for (let i = 0; i < 64 * 4; i++) {
    const v = proms[0x020 + i]! & 0x0f;
    spriteColor[i] = core[v | 0x10]!;
    spriteTrans[i] = v === 0x0f ? 1 : 0;
  }

  // background — proms[0x120..0x21f]; indirect lut & 0x0f (opaque, bottom layer)
  const bgColor = new Uint32Array(64 * 4);
  for (let i = 0; i < 64 * 4; i++) {
    bgColor[i] = core[proms[0x120 + i]! & 0x0f]!;
  }

  return { core, charColor, spriteColor, spriteTrans, bgColor };
}

// ---------------------------------------------------------------------------
// Tilemap mapper — port of digdug_state::tilemap_scan (digdug.cpp:92-100),
// identical to Galaga's: converts 36x28 (col,row) to a 32x32-space offset.

export function tilemapScan(col: number, row: number): number {
  row += 2;
  col -= 2;
  if (col & 0x20) return row + ((col & 0x1f) << 5);
  return col + (row << 5);
}

// draw_sprites gfx_offs[2][2] = { {0,1}, {2,3} }, indexed [y][x]
const GFX_OFFS: readonly number[][] = [[0, 1], [2, 3]];

// ---------------------------------------------------------------------------

export class DigdugVideo implements VideoRenderer {
  // set_raw(MASTER_CLOCK/3, 384, 0, 288, 264, 0, 224) -> visible 288x224
  readonly width: number = 288;
  readonly height: number = 224;

  private readonly videoram: Uint8Array;
  private readonly objram: Uint8Array;
  private readonly posram: Uint8Array;
  private readonly flpram: Uint8Array;
  private readonly videolatch: () => number;

  private readonly charGfx: GfxSet;   // gfx1: 1bpp text/alpha
  private readonly spriteGfx: GfxSet; // gfx2: 16x16 sprites
  private readonly bgGfx: GfxSet;     // gfx3: 8x8 bg tile shapes
  private readonly bgMap: Uint8Array; // gfx4: bg tilemap code ROM (4 pages of 0x400)
  private readonly pal: DigdugPalette;

  constructor(deps: DigdugVideoDeps) {
    const gfx1 = deps.regions['gfx1'];
    const gfx2 = deps.regions['gfx2'];
    const gfx3 = deps.regions['gfx3'];
    const gfx4 = deps.regions['gfx4'];
    const proms = deps.regions['proms'];
    if (!gfx1 || !gfx2 || !gfx3 || !gfx4 || !proms) throw new Error('digdug video: missing gfx1-4/proms region');
    if (proms.length < 0x220) throw new Error('digdug video: proms region too small');

    this.videoram = deps.videoram;
    this.objram = deps.objram;
    this.posram = deps.posram;
    this.flpram = deps.flpram;
    this.videolatch = deps.videolatch;

    this.charGfx = decodeGfx(CHAR_LAYOUT, gfx1);
    this.spriteGfx = decodeGfx(SPRITE_LAYOUT, gfx2);
    this.bgGfx = decodeGfx(BG_LAYOUT, gfx3);
    this.bgMap = gfx4;
    this.pal = buildDigdugPalette(proms);
  }

  /** Port of screen_update_digdug (digdug.cpp:287-293): bg, then fg, then sprites. */
  render(frame: Uint32Array): void {
    const latch = this.videolatch();
    const flip = (latch >> 7) & 1;
    const bgSelect = latch & 0x03;
    const bgColorBank = latch & 0x30;
    const bgDisable = (latch >> 3) & 1;
    const txColorMode = (latch >> 2) & 1;

    this.drawBg(frame, flip, bgSelect, bgColorBank, bgDisable);
    this.drawFg(frame, flip, txColorMode);
    this.drawSprites(frame, flip);
  }

  /** no per-frame latching needed (no starfield); kept for the VideoRenderer contract */
  vblank(): void { /* nothing to latch */ }

  /** background "dirt" layer — bg_get_tile_info (digdug.cpp:103-118), opaque. */
  private drawBg(frame: Uint32Array, flip: number, bgSelect: number, bgColorBank: number, bgDisable: number): void {
    const w = this.width;
    const src = this.bgGfx.pixels;
    const count = this.bgGfx.count;
    const map = this.bgMap;
    const mapMask = map.length - 1;
    const bgColor = this.pal.bgColor;
    const page = bgSelect << 10;

    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const offs = tilemapScan(col, row);
        const code = map[(offs | page) & mapMask]!;
        const color = (bgDisable ? 0x0f : (code >> 4)) | bgColorBank; // 0..0x3f
        const colorBase = color * 4;
        const base = (code % count) * 64;

        const destX = (flip ? 35 - col : col) * 8;
        const destY = (flip ? 27 - row : row) * 8;
        for (let py = 0; py < 8; py++) {
          const srcRow = base + (flip ? 7 - py : py) * 8;
          const dstRow = (destY + py) * w + destX;
          for (let px = 0; px < 8; px++) {
            const pen = src[srcRow + (flip ? 7 - px : px)]!;
            frame[dstRow + px] = bgColor[colorBase + pen]!;
          }
        }
      }
    }
  }

  /**
   * text/alpha tilemap — tx_get_tile_info (digdug.cpp:120-144), pen 0
   * transparent. Like Galaga, the x-flipped second character set (code | 0x80)
   * is selected when the screen is flipped, so only a per-pixel y-flip is
   * applied here; x is read straight from the already-mirrored charset.
   */
  private drawFg(frame: Uint32Array, flip: number, txColorMode: number): void {
    const w = this.width;
    const vram = this.videoram;
    const src = this.charGfx.pixels;
    const count = this.charGfx.count;
    const charColor = this.pal.charColor;

    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const offs = tilemapScan(col, row);
        const raw = vram[offs]!;
        const code = (raw & 0x7f) | (flip ? 0x80 : 0);
        const color = txColorMode ? (raw & 0x0f) : (((raw >> 4) & 0x0e) | ((raw >> 3) & 2));
        const colorBase = color * 2;
        const base = (code % count) * 64;

        const destX = (flip ? 35 - col : col) * 8;
        const destY = (flip ? 27 - row : row) * 8;
        for (let py = 0; py < 8; py++) {
          const srcRow = base + (flip ? 7 - py : py) * 8;
          const dstRow = (destY + py) * w + destX;
          for (let px = 0; px < 8; px++) {
            const pen = src[srcRow + px]!; // 1bpp: 0 (transparent) or 1
            if (pen === 0) continue;
            frame[dstRow + px] = charColor[colorBase + pen]!;
          }
        }
      }
    }
  }

  /** Port of digdug_state::draw_sprites (digdug.cpp:225-284). */
  private drawSprites(frame: Uint32Array, flip: number): void {
    const obj = this.objram;
    const pos = this.posram;
    const flp = this.flpram;

    for (let offs = 0; offs < 0x80; offs += 2) {
      let sprite = obj[0x380 + offs]!;
      const color = obj[0x380 + offs + 1]! & 0x3f;
      const sx = pos[0x380 + offs + 1]! - 40 + 1;
      let sy = 256 - pos[0x380 + offs]! + 1; // sprites buffered/delayed one scanline
      let flipx = flp[0x380 + offs]! & 0x01;
      let flipy = (flp[0x380 + offs]! & 0x02) >> 1;
      const size = (sprite & 0x80) >> 7;

      if (size) sprite = (sprite & 0xc0) | ((sprite & ~0xc0) << 2);

      sy -= 16 * size;
      sy = (sy & 0xff) - 32; // fix wraparound

      if (flip) { flipx ^= 1; flipy ^= 1; }

      for (let y = 0; y <= size; y++) {
        for (let x = 0; x <= size; x++) {
          const code = sprite + GFX_OFFS[y ^ (size * flipy)]![x ^ (size * flipx)]!;
          const dx = (sx + 16 * x) & 0xff;
          this.drawSpriteTile(frame, code, color, flipx, flipy, dx, sy + 16 * y);
          this.drawSpriteTile(frame, code, color, flipx, flipy, dx + 0x100, sy + 16 * y);
        }
      }
    }
  }

  /**
   * gfx(1)->transmask 16x16 sprite tile with per-pen transparency, clipped to
   * the sprite visarea [2*8 .. 34*8-1] (columns 0-1 and 34-35 are the score /
   * status strips, masked from sprites in draw_sprites).
   */
  private drawSpriteTile(
    frame: Uint32Array,
    code: number,
    color: number,
    flipx: number,
    flipy: number,
    sx: number,
    sy: number,
  ): void {
    const src = this.spriteGfx.pixels;
    const base = (code % this.spriteGfx.count) * 256;
    const colorBase = color * 4;
    const spriteColor = this.pal.spriteColor;
    const spriteTrans = this.pal.spriteTrans;
    const w = this.width;
    const h = this.height;
    const clipMin = 2 * 8;
    const clipMax = 34 * 8 - 1;

    for (let py = 0; py < 16; py++) {
      const dy = sy + py;
      if (dy < 0 || dy >= h) continue;
      const srcRow = base + (flipy ? 15 - py : py) * 16;
      const dstRow = dy * w;
      for (let px = 0; px < 16; px++) {
        const dx = sx + px;
        if (dx < clipMin || dx > clipMax) continue;
        const pen = src[srcRow + (flipx ? 15 - px : px)]!;
        if (spriteTrans[colorBase + pen]!) continue;
        frame[dstRow + dx] = spriteColor[colorBase + pen]!;
      }
    }
  }
}
