// Galaga board video renderer.
//
// Hand-transpiled from MAME ground truth:
//   - src/mame/namco/galaga_v.cpp   (galaga_palette, tilemap_scan,
//     get_tile_info, draw_sprites, screen_update_galaga,
//     screen_vblank_galaga)
//   - src/mame/namco/galaga.cpp     (charlayout_2bpp, spritelayout_galaga,
//     gfx_galaga decode table, screen set_raw 288x224, starfield config)
//   - src/emu/video/resnet.cpp      (compute_resistor_weights / combine_weights)
//
// Native (pre-rotation) resolution 288x224; output pixels are packed
// 0xAABBGGRR (little-endian RGBA for canvas ImageData), alpha always 0xff.

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';
import { Starfield05xx } from '../starfield05xx.ts';
import { computeResistorWeights, combineWeights, packRGB } from './resnet.ts';

export interface GalagaVideoDeps {
  regions: Regions;               // gfx1 0x1000, gfx2 0x2000, proms 0x220
  videoram: Uint8Array;           // 0x800: chars @0x000, color/attr @0x400
  ram1: Uint8Array;               // 0x400 (sprite num/color at 0x380..0x3ff)
  ram2: Uint8Array;               // 0x400 (sprite x/y at 0x380..0x3ff)
  ram3: Uint8Array;               // 0x400 (sprite flags at 0x380..0x3ff)
  videolatch: () => number;       // LS259 Q0..Q7 (Q0-5 starfield, Q7 flip)
}

// ---------------------------------------------------------------------------
// gfx layouts — galaga.cpp:1428-1437 (charlayout_2bpp) and 1472-1481
// (spritelayout_galaga); STEP macros expanded.

const CHAR_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,1)',
  planes: 2,
  planeOffsets: [0, 4],
  // { STEP4(8*8,1), STEP4(0*8,1) }
  xOffsets: [64, 65, 66, 67, 0, 1, 2, 3],
  // { STEP8(0*8,8) }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
  charIncrement: 16 * 8,
};

const SPRITE_LAYOUT: GfxLayout = {
  width: 16,
  height: 16,
  total: 'RGN_FRAC(1,1)',
  planes: 2,
  planeOffsets: [0, 4],
  // { STEP4(0*8,1), STEP4(8*8,1), STEP4(16*8,1), STEP4(24*8,1) }
  xOffsets: [0, 1, 2, 3, 64, 65, 66, 67, 128, 129, 130, 131, 192, 193, 194, 195],
  // { STEP8(0*8,8), STEP8(32*8,8) }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 256, 264, 272, 280, 288, 296, 304, 312],
  charIncrement: 64 * 8,
};

// ---------------------------------------------------------------------------
// Palette — port of galaga_state::galaga_palette (galaga_v.cpp:45-111).
//
// proms region layout: 32-byte palette PROM @0x000, 256-byte char lookup
// @0x020, 256-byte sprite lookup @0x120.

export interface GalagaPalette {
  /** 32 core RGB entries (packed 0xAABBGGRR). */
  core: Uint32Array;
  /** 64 starfield RGB entries. */
  stars: Uint32Array;
  /** 64 colors x 4 pens -> RGB for characters (indirect (lut&0x0f)|0x10). */
  charColor: Uint32Array;
  /** 1 where the char pen is transparent (indirect pen == 0x1f). */
  charTrans: Uint8Array;
  /** 64 colors x 4 pens -> RGB for sprites (indirect lut&0x0f). */
  spriteColor: Uint32Array;
  /** 1 where the sprite pen is transparent (indirect pen == 0x0f). */
  spriteTrans: Uint8Array;
}

export function buildGalagaPalette(proms: Uint8Array): GalagaPalette {
  const resistances = [1000, 470, 220];

  // compute the color output resistor weights
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

  // r/g low bit is n/c and effectively becomes a pulldown
  const [rsweights, gsweights, bsweights] = computeResistorWeights(0, 255, -1.0, [
    { resistances: [470, 220], pulldown: 1000, pullup: 0 },
    { resistances: [470, 220], pulldown: 1000, pullup: 0 },
    { resistances: [470, 220], pulldown: 0, pullup: 0 },
  ]) as [number[], number[], number[]];

  // palette for the stars (indirect colors 32..95 in MAME)
  const stars = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    const r = combineWeights(rsweights, i & 1, (i >> 1) & 1);
    const g = combineWeights(gsweights, (i >> 2) & 1, (i >> 3) & 1);
    const b = combineWeights(bsweights, (i >> 4) & 1, (i >> 5) & 1);
    stars[i] = packRGB(r, g, b);
  }

  // characters: pen i -> indirect (lut & 0x0f) | 0x10;
  // transparent group pen when indirect == 0x1f (configure_groups(gfx0, 0x1f))
  const charColor = new Uint32Array(64 * 4);
  const charTrans = new Uint8Array(64 * 4);
  for (let i = 0; i < 64 * 4; i++) {
    const v = proms[0x020 + i]! & 0x0f;
    charColor[i] = core[v | 0x10]!;
    charTrans[i] = v === 0x0f ? 1 : 0;
  }

  // sprites: pen i -> indirect lut & 0x0f;
  // transparent when indirect == 0x0f (transpen_mask(gfx1, color, 0x0f))
  const spriteColor = new Uint32Array(64 * 4);
  const spriteTrans = new Uint8Array(64 * 4);
  for (let i = 0; i < 64 * 4; i++) {
    const v = proms[0x120 + i]! & 0x0f;
    spriteColor[i] = core[v]!;
    spriteTrans[i] = v === 0x0f ? 1 : 0;
  }

  return { core, stars, charColor, charTrans, spriteColor, spriteTrans };
}

// ---------------------------------------------------------------------------
// Tilemap mapper — port of galaga_state::tilemap_scan (galaga_v.cpp:120-128).
// Converts logical (col,row) of the 36x28 layout to a videoram offset,
// including the wrap columns (cols 0,1 and 34,35 live in the last rows of
// the 32x32 address space).  JS bitwise ops reproduce the C uint underflow.

export function tilemapScan(col: number, row: number): number {
  row += 2;
  col -= 2;
  if (col & 0x20) return row + ((col & 0x1f) << 5);
  return col + (row << 5);
}

// gfx_offs[y][x] from draw_sprites, flattened to y*2+x
const GFX_OFFS: readonly number[] = [0, 1, 2, 3];

const BLACK = packRGB(0, 0, 0); // m_palette->black_pen() resolves to rgb 0,0,0

// ---------------------------------------------------------------------------

export class GalagaVideo implements VideoRenderer {
  // set_raw(MASTER_CLOCK/3, 384, 0, 288, 264, 0, 224) -> visible 288x224
  readonly width: number = 288;
  readonly height: number = 224;

  private readonly videoram: Uint8Array;
  private readonly ram1: Uint8Array;
  private readonly ram2: Uint8Array;
  private readonly ram3: Uint8Array;
  private readonly videolatch: () => number;

  private readonly charGfx: GfxSet;
  private readonly spriteGfx: GfxSet;
  private readonly pal: GalagaPalette;
  private readonly starfield: Starfield05xx;

  constructor(deps: GalagaVideoDeps) {
    const gfx1 = deps.regions['gfx1'];
    const gfx2 = deps.regions['gfx2'];
    const proms = deps.regions['proms'];
    if (!gfx1 || !gfx2 || !proms) throw new Error('galaga video: missing gfx1/gfx2/proms region');
    if (proms.length < 0x220) throw new Error('galaga video: proms region too small');

    this.videoram = deps.videoram;
    this.ram1 = deps.ram1;
    this.ram2 = deps.ram2;
    this.ram3 = deps.ram3;
    this.videolatch = deps.videolatch;

    this.charGfx = decodeGfx(CHAR_LAYOUT, gfx1);     // 256 8x8 chars (2nd half x-flipped set)
    this.spriteGfx = decodeGfx(SPRITE_LAYOUT, gfx2); // 128 16x16 sprites
    this.pal = buildGalagaPalette(proms);

    // STARFIELD_05XX + set_starfield_config(16, 0, 256+16) (galaga.cpp:1716-1717)
    this.starfield = new Starfield05xx(16, 0, 256 + 16);
    this.starfield.setColorTable(this.pal.stars);
  }

  /** Port of screen_update_galaga (galaga_v.cpp:241-248). */
  render(frame: Uint32Array): void {
    const flip = (this.videolatch() >> 7) & 1; // videolatch Q7 -> flip_screen_set

    frame.fill(BLACK);                          // bitmap.fill(black_pen)
    this.starfield.draw(frame, this.width, this.height);
    this.drawSprites(frame, flip);
    this.drawTilemap(frame, flip);
  }

  /** Port of screen_vblank_galaga (galaga_v.cpp:252-268), falling edge. */
  vblank(): void {
    this.starfield.setControl(this.videolatch() & 0x3f);
    this.starfield.vblank();
  }

  /** Port of galaga_state::draw_sprites (galaga_v.cpp:193-237). */
  private drawSprites(frame: Uint32Array, flip: number): void {
    const r1 = this.ram1;
    const r2 = this.ram2;
    const r3 = this.ram3;

    for (let offs = 0; offs < 0x80; offs += 2) {
      const sprite = r1[0x380 + offs]! & 0x7f;
      const color = r1[0x380 + offs + 1]! & 0x3f;
      const sx = r2[0x380 + offs + 1]! - 40 + 0x100 * (r3[0x380 + offs + 1]! & 3);
      let sy = 256 - r2[0x380 + offs]! + 1; // sprites are buffered and delayed by one scanline
      let flipx = r3[0x380 + offs]! & 0x01;
      let flipy = (r3[0x380 + offs]! & 0x02) >> 1;
      const sizex = (r3[0x380 + offs]! & 0x04) >> 2;
      const sizey = (r3[0x380 + offs]! & 0x08) >> 3;

      sy -= 16 * sizey;
      sy = (sy & 0xff) - 32; // fix wraparound

      if (flip) {
        flipx ^= 1;
        flipy ^= 1;
      }

      for (let y = 0; y <= sizey; y++) {
        for (let x = 0; x <= sizex; x++) {
          const code = sprite + GFX_OFFS[((y ^ (sizey * flipy)) << 1) | (x ^ (sizex * flipx))]!;
          this.drawSpriteTile(frame, code, color, flipx, flipy, sx + 16 * x, sy + 16 * y);
        }
      }
    }
  }

  /** gfx(1)->transmask(...): 16x16 tile with per-pen transparency + clipping. */
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
    const base = (code % gfx.count) * 256; // code % total_elements, per MAME drawgfx
    const colorBase = color * 4;
    const spriteColor = this.pal.spriteColor;
    const spriteTrans = this.pal.spriteTrans;
    const w = this.width;
    const h = this.height;

    for (let py = 0; py < 16; py++) {
      const dy = sy + py;
      if (dy < 0 || dy >= h) continue;
      const srcRow = base + (flipy ? 15 - py : py) * 16;
      const dstRow = dy * w;
      for (let px = 0; px < 16; px++) {
        const dx = sx + px;
        if (dx < 0 || dx >= w) continue;
        const pen = src[srcRow + (flipx ? 15 - px : px)]!;
        if (spriteTrans[colorBase + pen]!) continue;
        frame[dstRow + dx] = spriteColor[colorBase + pen]!;
      }
    }
  }

  /**
   * fg tilemap draw: 36x28 tiles of 8x8, mapper tilemap_scan, tile info per
   * get_tile_info (galaga_v.cpp:131-144).  With flip_screen set, MAME's
   * tilemap core flips the whole layer in X and Y; get_tile_info adds
   * TILE_FLIPX (cancelling the layer X flip, since the x-flipped second
   * character set at code|0x80 is used instead) so the net per-tile effect
   * is: mirrored position, y-flip only, x-flipped charset.
   * m_galaga_gfxbank is Gatsbee-only and always 0 on Galaga.
   */
  private drawTilemap(frame: Uint32Array, flip: number): void {
    const vram = this.videoram;
    const gfx = this.charGfx;
    const src = gfx.pixels;
    const charColor = this.pal.charColor;
    const charTrans = this.pal.charTrans;
    const w = this.width;

    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const offs = tilemapScan(col, row);
        const code = (vram[offs]! & 0x7f) | (flip ? 0x80 : 0);
        const color = vram[offs + 0x400]! & 0x3f;
        const colorBase = color * 4;
        const base = (code % gfx.count) * 64;

        const destX = (flip ? 35 - col : col) * 8;
        const destY = (flip ? 27 - row : row) * 8;

        for (let py = 0; py < 8; py++) {
          const srcRow = base + (flip ? 7 - py : py) * 8; // net y-flip when screen flipped
          const dstRow = (destY + py) * w + destX;
          for (let px = 0; px < 8; px++) {
            const pen = src[srcRow + px]!;
            if (charTrans[colorBase + pen]!) continue;
            frame[dstRow + px] = charColor[colorBase + pen]!;
          }
        }
      }
    }
  }
}
