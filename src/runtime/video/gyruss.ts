// Gyruss board video renderer.
//
// Hand-transpiled from MAME ground truth:
//   - src/mame/konami/gyruss.cpp (modern; video code lives in the driver file)
//       gyruss_state::palette        (gyruss.cpp:186-240)
//       gyruss_state::get_tile_info  (gyruss.cpp:251-260)
//       gyruss_state::video_start    (gyruss.cpp:263-270, transmask groups)
//       gyruss_state::draw_sprites   (gyruss.cpp:287-302)
//       gyruss_state::screen_update  (gyruss.cpp:305-318)
//       charlayout / spritelayout / gfx_gyruss (gyruss.cpp:553-581)
//       screen set_raw 396x256, visible 256x224 (y 16..239) (gyruss.cpp:699-736)
//   - classic MAME 0.121 src/mame/video/gyruss.c (git 7b77f121862) cross-checked
//     for the sprite byte layout, the priority-redraw rule and per-tile flips.
//   - src/emu/video/resnet.cpp (compute_resistor_weights / combine_weights).
//
// Native (pre-rotation) resolution 256x224 (landscape; the shell applies the
// ROT90 blit).  Output pixels are packed 0xAABBGGRR (little-endian RGBA for
// canvas ImageData), alpha always 0xff.
//
// Deliberate simplification: MAME 0.121 buffers spriteram per scanline
// (sprite multiplexing) and modern MAME does partial updates on spriteram_w;
// we render once per frame from the live spriteram share, like the other
// mame2js boards.

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';

export interface GyrussVideoDeps {
  /** ROM regions: 'tiles' (0x2000), 'sprites' (0x8000), 'proms' (0x220). */
  regions: Regions;
  /** m_videoram share view, 0x400 bytes (main cpu 0x8400-0x87ff): char codes. */
  videoram: Uint8Array;
  /** m_colorram share view, 0x400 bytes (main cpu 0x8000-0x83ff): attributes. */
  colorram: Uint8Array;
  /** m_spriteram share view, 0xc0 bytes (sub cpu 0x4040-0x40ff): 48 sprites x 4. */
  spriteram: Uint8Array;
}

// ---------------------------------------------------------------------------
// gfx layouts — gyruss.cpp:553-574; identical to the graph nodes
// gfxlayout:charlayout / gfxlayout:spritelayout in out/gyruss/graph.json.

export const GYRUSS_CHAR_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 512,
  planes: 2,
  planeOffsets: [4, 0],
  xOffsets: [0, 1, 2, 3, 64, 65, 66, 67],       // { 0..3, 8*8+0..3 }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],      // { 0*8..7*8 }
  charIncrement: 16 * 8,                          // every char takes 16 bytes
};

export const GYRUSS_SPRITE_LAYOUT: GfxLayout = {
  width: 8,
  height: 16,
  total: 256,
  planes: 4,
  // { 0x4000*8+4, 0x4000*8+0, 4, 0 } — 4bpp split across the two ROM halves
  planeOffsets: [0x4000 * 8 + 4, 0x4000 * 8 + 0, 4, 0],
  xOffsets: [0, 1, 2, 3, 64, 65, 66, 67],
  // { 0*8..7*8, 32*8..39*8 }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 256, 264, 272, 280, 288, 296, 304, 312],
  charIncrement: 64 * 8,                          // every sprite takes 64 bytes
};

/** GFXDECODE_ENTRY byte offsets for the two 8x16 sprite banks (gyruss.cpp:578-579). */
export const GYRUSS_SPRITE_BANK_OFFSETS: readonly number[] = [0x0000, 0x0010];

// ---------------------------------------------------------------------------
// resnet.cpp port (what gyruss_state::palette needs: pulldown supported,
// pullup passed but always 0 here; autoscale scaler).  Local port, same as
// the other video modules — deliberately not shared.

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

/** Port of combine_weights() (resnet.h): int(sum(tab[i]*w[i]) + 0.5). */
function combineWeights(tab: number[], ...bits: number[]): number {
  let sum = 0.0;
  for (let i = 0; i < bits.length; i++) sum += tab[i]! * bits[i]!;
  return Math.floor(sum + 0.5);
}

// ---------------------------------------------------------------------------
// Palette — port of gyruss_state::palette (gyruss.cpp:186-240).
//
// proms region layout (gyruss.cpp:833-836):
//   0x000-0x01f  32-byte palette PROM (gyrussk.pr3)
//   0x020-0x11f  256-byte SPRITE lookup PROM (gyrussk.pr1)
//   0x120-0x21f  256-byte CHARACTER lookup PROM (gyrussk.pr2; only the first
//                0x40 entries are used: 16 colors x 4 pens)
//
// Sprites map to the LOWER 16 indirect entries (lut & 0x0f), characters to
// the UPPER 16 ((lut & 0x0f) | 0x10).  Both resistor nets carry a 470 Ohm
// pulldown (the "470, 0" arguments to compute_resistor_weights).

export interface GyrussPalette {
  /** 32 core RGB entries (packed 0xAABBGGRR). */
  core: Uint32Array;
  /** 16 colors x 16 pens -> RGB for sprites (indirect lut & 0x0f). */
  spriteColor: Uint32Array;
  /** 16 colors x 4 pens -> RGB for characters (indirect (lut & 0x0f) | 0x10). */
  charColor: Uint32Array;
}

function packRGB(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function buildGyrussPalette(proms: Uint8Array): GyrussPalette {
  // compute_resistor_weights(0, 255, -1.0,
  //     3, { 1000, 470, 220 }, weights_rg, 470, 0,
  //     2, { 470, 220 },       weights_b,  470, 0, ...)
  const [rgweights, bweights] = computeResistorWeights(0, 255, -1.0, [
    { resistances: [1000, 470, 220], pulldown: 470, pullup: 0 },
    { resistances: [470, 220], pulldown: 470, pullup: 0 },
  ]) as [number[], number[]];

  // core palette (32 indirect colors); R and G share the same weights
  const core = new Uint32Array(32);
  for (let i = 0; i < 0x20; i++) {
    const v = proms[i]!;
    const r = combineWeights(rgweights, v & 1, (v >> 1) & 1, (v >> 2) & 1);
    const g = combineWeights(rgweights, (v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1);
    const b = combineWeights(bweights, (v >> 6) & 1, (v >> 7) & 1);
    core[i] = packRGB(r, g, b);
  }

  // sprites map to the lower 16 palette entries (pens 0x00-0xff)
  const spriteColor = new Uint32Array(16 * 16);
  for (let i = 0; i < 0x100; i++) {
    spriteColor[i] = core[proms[0x020 + i]! & 0x0f]!;
  }

  // characters map to the upper 16 palette entries (pens 0x100-0x13f)
  const charColor = new Uint32Array(16 * 4);
  for (let i = 0; i < 0x40; i++) {
    charColor[i] = core[(proms[0x120 + i]! & 0x0f) | 0x10]!;
  }

  return { core, spriteColor, charColor };
}

// ---------------------------------------------------------------------------

const BLACK = packRGB(0, 0, 0);

// set_raw(18.432MHz/3, 396, 0, 256, 256, 16, 240): the bitmap is 256 lines
// tall with visible y 16..239; our framebuffer holds the visible window only.
const VBEND = 16;

export class GyrussVideo implements VideoRenderer {
  readonly width: number = 256;
  readonly height: number = 224;

  private readonly videoram: Uint8Array;
  private readonly colorram: Uint8Array;
  private readonly spriteram: Uint8Array;

  private readonly charGfx: GfxSet;
  private readonly spriteGfx: [GfxSet, GfxSet]; // gfx(0)/gfx(1): the two 8x16 banks
  private readonly pal: GyrussPalette;

  private flip = false; // mainlatch Q5 -> flipscreen_w (gyruss.cpp:281-284, 732)

  constructor(deps: GyrussVideoDeps) {
    const tiles = deps.regions['tiles'];
    const sprites = deps.regions['sprites'];
    const proms = deps.regions['proms'];
    if (!tiles || !sprites || !proms) throw new Error('gyruss video: missing tiles/sprites/proms region');
    if (proms.length < 0x220) throw new Error('gyruss video: proms region too small');

    this.videoram = deps.videoram;
    this.colorram = deps.colorram;
    this.spriteram = deps.spriteram;

    // GFXDECODE_ENTRY("sprites", 0x0000, ...) / ("sprites", 0x0010, ...) /
    // ("tiles", 0x0000, charlayout, ...) — gyruss.cpp:577-581
    this.charGfx = decodeGfx(GYRUSS_CHAR_LAYOUT, tiles);           // 512 8x8 chars
    this.spriteGfx = [
      decodeGfx(GYRUSS_SPRITE_LAYOUT, sprites),                    // 256 8x16, "upper half"
      decodeGfx(GYRUSS_SPRITE_LAYOUT, sprites.subarray(0x10)),     // 256 8x16, "lower half"
    ];
    this.pal = buildGyrussPalette(proms);
  }

  /** mainlatch Q5 (gyruss.cpp:732) — the board wires this from ls259 Q5. */
  setFlip(state: boolean): void {
    this.flip = state;
  }

  /**
   * Port of screen_update (gyruss.cpp:305-318):
   *   tilemap draw OPAQUE -> sprites -> priority tiles redrawn opaque.
   * The priority rule (video_start + get_tile_info): tiles with colorram bit
   * 0x10 SET are group 0 = transmask 0x00 (fully opaque over sprites); tiles
   * with the bit clear are group 1 = transmask 0x0f (all 4 pens transparent
   * in the front pass, i.e. behind sprites).  Same as classic 0.121's
   * "redraw the characters which have priority over sprites" loop.
   */
  render(frame: Uint32Array): void {
    frame.fill(BLACK);
    this.drawTilemap(frame, false);
    this.drawSprites(frame);
    this.drawTilemap(frame, true);
  }

  /** No per-frame latching; flip is sampled during render like screen_update. */
  vblank(): void {}

  /**
   * Tilemap: TILEMAP_SCAN_ROWS 32x32 of 8x8 chars (gyruss.cpp:265).
   * get_tile_info (gyruss.cpp:251-260):
   *   code  = ((colorram & 0x20) << 3) | videoram   (512 chars)
   *   color = colorram & 0x0f
   *   flipx = colorram bit 6, flipy = colorram bit 7 (TILE_FLIPYX(attr >> 6))
   * Screen flip mirrors the whole 32x32 layer in X and Y and inverts the
   * per-tile flips (classic 0.121: sx=31-sx, sy=31-sy, flipx=!flipx, ...).
   * Rows 0-1 and 30-31 fall outside the visible window (y 16..239).
   */
  private drawTilemap(frame: Uint32Array, prioOnly: boolean): void {
    const vram = this.videoram;
    const cram = this.colorram;
    const gfx = this.charGfx;
    const src = gfx.pixels;
    const charColor = this.pal.charColor;
    const flip = this.flip;
    const w = this.width;
    const h = this.height;

    for (let row = 0; row < 32; row++) {
      for (let col = 0; col < 32; col++) {
        const offs = (row << 5) | col;
        const attr = cram[offs]!;
        if (prioOnly && !(attr & 0x10)) continue;

        const destY = (flip ? 31 - row : row) * 8 - VBEND;
        if (destY < 0 || destY >= h) continue;
        const destX = (flip ? 31 - col : col) * 8;

        const code = ((attr & 0x20) << 3) | vram[offs]!;
        const colorBase = (attr & 0x0f) * 4;
        let flipx = (attr >> 6) & 1;
        let flipy = (attr >> 7) & 1;
        if (flip) {
          flipx ^= 1;
          flipy ^= 1;
        }

        const base = (code % gfx.count) * 64;
        for (let py = 0; py < 8; py++) {
          const srcRow = base + (flipy ? 7 - py : py) * 8;
          const dstRow = (destY + py) * w + destX;
          for (let px = 0; px < 8; px++) {
            const pen = src[srcRow + (flipx ? 7 - px : px)]!;
            frame[dstRow + px] = charColor[colorBase + pen]!; // opaque, pen 0 included
          }
        }
      }
    }
  }

  /**
   * Port of draw_sprites (gyruss.cpp:287-302; classic 0.121 gyruss.c agrees):
   *   for offs = 0xbc down to 0 step 4 (48 sprites; lower offsets on top):
   *     x        = spriteram[offs]
   *     y        = 241 - spriteram[offs + 3]        (full-bitmap coords)
   *     gfx_bank = spriteram[offs + 1] & 0x01       (8x16 bank 0 or 1)
   *     code     = ((spriteram[offs+2] & 0x20) << 2) | (spriteram[offs+1] >> 1)
   *     color    = spriteram[offs + 2] & 0x0f
   *     flip_x   = ~spriteram[offs + 2] & 0x40      (bit 6 CLEAR = flipped)
   *     flip_y   =  spriteram[offs + 2] & 0x80
   *     transpen 0 (raw pen 0 transparent, not LUT-based)
   * Screen flip is NOT applied to sprites (the game software flips them).
   */
  private drawSprites(frame: Uint32Array): void {
    const sr = this.spriteram;
    const spriteColor = this.pal.spriteColor;
    const w = this.width;
    const h = this.height;

    for (let offs = 0xbc; offs >= 0; offs -= 4) {
      const sx = sr[offs]!;
      const sy = 241 - sr[offs + 3]! - VBEND;

      const gfx = this.spriteGfx[sr[offs + 1]! & 0x01]!;
      const code = (((sr[offs + 2]! & 0x20) << 2) | (sr[offs + 1]! >> 1)) % gfx.count;
      const colorBase = (sr[offs + 2]! & 0x0f) * 16;
      const flipx = (~sr[offs + 2]! & 0x40) !== 0;
      const flipy = (sr[offs + 2]! & 0x80) !== 0;

      const src = gfx.pixels;
      const base = code * 128; // 8x16 pixels per element

      for (let py = 0; py < 16; py++) {
        const dy = sy + py;
        if (dy < 0 || dy >= h) continue;
        const srcRow = base + (flipy ? 15 - py : py) * 8;
        const dstRow = dy * w;
        for (let px = 0; px < 8; px++) {
          const dx = sx + px;
          if (dx < 0 || dx >= w) continue;
          const pen = src[srcRow + (flipx ? 7 - px : px)]!;
          if (pen === 0) continue; // transpen 0
          frame[dstRow + dx] = spriteColor[colorBase + pen]!;
        }
      }
    }
  }
}
