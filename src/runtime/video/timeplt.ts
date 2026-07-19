// Time Pilot (Konami 1982) video renderer.
//
// Hand-transpiled from MAME ground truth (video code lives in the driver):
//   - src/mame/konami/timeplt.cpp
//       timeplt_state::palette          (timeplt.cpp:202-247)
//       timeplt_state::get_tile_info    (timeplt.cpp:256-266)
//       timeplt_state::video_start      (timeplt.cpp:284-290)
//       timeplt_state::video_enable_w   (timeplt.cpp:330-333)
//       timeplt_state::draw_sprites     (timeplt.cpp:347-365)
//       timeplt_state::screen_update    (timeplt.cpp:374-383)
//       charlayout / spritelayout / gfx_timeplt (timeplt.cpp:683-709)
//       screen set_raw: 384x264? -> config; visarea x 0..255, y 16..239
//
// Differences from the pooyan/rocnrope pattern worth noting:
//   - 2bpp gfx (4 pens per color), 32 char colors + 64 sprite colors
//   - the 32-entry palette is 5 BITS PER CHANNEL across TWO PROM bytes with
//     hand-measured weights 0x19/0x24/0x35/0x40/0x4d (no resnet math)
//   - pens are DIRECT (set_pen_color): char pens map through the char lut to
//     the UPPER 16 palette entries, sprite pens to the lower 16
//   - sprite transparency is RAW PEN 0 (transpen), not LUT-based
//   - the tilemap has a priority category (attr bit 4): category-1 tiles
//     draw OVER sprites (clouds/scores); category-0 under
//   - a video-enable latch (mainlatch Q4) blanks the whole screen when clear
//
// Native (pre-rotation) resolution 256x224 (the game is ROT90; the shell
// applies the rotation at blit time). Output pixels are packed 0xAABBGGRR
// (canvas ImageData order), alpha 0xff.
//
// Deliberate simplification: modern MAME marks tiles dirty on videoram_w /
// colorram_w and redraws incrementally; we render the whole frame from the
// live shares once per frame, like the other mamekit boards.

import type { Regions, VideoRenderer } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout, GfxSet } from '../gfx.ts';
import { packRGB } from './resnet.ts';

export interface TimepltVideoDeps {
  /** ROM regions: 'tiles' (0x2000), 'sprites' (0x4000), 'proms' (0x240). */
  regions: Regions;
  /** m_videoram share view, 0x400 bytes: char codes (TILEMAP_SCAN_ROWS 32x32). */
  videoram: Uint8Array;
  /** m_colorram share view, 0x400 bytes: tile attributes. */
  colorram: Uint8Array;
  /** m_spriteram[0] share view: x positions + sprite codes (offs 0x10-0x3f used). */
  spriteram0: Uint8Array;
  /** m_spriteram[1] share view: attributes + y positions. */
  spriteram1: Uint8Array;
}

// ---------------------------------------------------------------------------
// gfx layouts — timeplt.cpp:683-703 (RGN_FRAC forms, as extracted to the graph).

export const TIMEPLT_CHAR_LAYOUT: GfxLayout = {
  width: 8,
  height: 8,
  total: 'RGN_FRAC(1,1)',
  planes: 2,
  planeOffsets: [4, 0],                            // 2bpp, nibbles interleaved
  xOffsets: [0, 1, 2, 3, 64, 65, 66, 67],          // { STEP4(0,1), STEP4(8*8,1) }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],        // { STEP8(0,8) }
  charIncrement: 16 * 8,                            // every char takes 16 bytes
};

export const TIMEPLT_SPRITE_LAYOUT: GfxLayout = {
  width: 16,
  height: 16,
  total: 'RGN_FRAC(1,1)',
  planes: 2,
  planeOffsets: [4, 0],
  // { STEP4(0,1), STEP4(8*8,1), STEP4(16*8,1), STEP4(24*8,1) }
  xOffsets: [0, 1, 2, 3, 64, 65, 66, 67, 128, 129, 130, 131, 192, 193, 194, 195],
  // { STEP8(0,8), STEP8(32*8,8) }
  yOffsets: [0, 8, 16, 24, 32, 40, 48, 56, 256, 264, 272, 280, 288, 296, 304, 312],
  charIncrement: 64 * 8,                            // every sprite takes 64 bytes
};

// ---------------------------------------------------------------------------
// Palette — port of timeplt_state::palette (timeplt.cpp:202-247).
//
// proms region layout (0x240 bytes):
//   0x000-0x01f  palette PROM byte 0 (timeplt.b4: G bits 2-4 + B bits 0-4)
//   0x020-0x03f  palette PROM byte 1 (timeplt.b5: R bits 0-4 + G bits 0-1)
//   0x040-0x13f  256-byte SPRITE lookup PROM (timeplt.e9)
//   0x140-0x23f  256-byte CHAR lookup PROM (timeplt.e12; only 128 used)
//
// Each channel is 5 bits with weights 0x19+0x24+0x35+0x40+0x4d = 255
// (390/470/560/820/1.2k Ohm ladders, pre-computed in the MAME driver).
// Sprite lut entries map to the LOWER 16 palette entries (lut & 0x0f);
// char lut entries to the upper 16 ((lut & 0x0f) + 0x10).

const WEIGHTS = [0x19, 0x24, 0x35, 0x40, 0x4d];

export interface TimepltPalette {
  /** 32 core RGB entries (packed 0xAABBGGRR). */
  core: Uint32Array;
  /** 64 colors x 4 pens -> RGB for sprites (core[proms[0x040+i] & 0x0f]). */
  spriteColor: Uint32Array;
  /** 32 colors x 4 pens -> RGB for characters (core[(proms[0x140+i] & 0x0f) + 0x10]). */
  charColor: Uint32Array;
}

export function buildTimepltPalette(proms: Uint8Array): TimepltPalette {
  const five = (bits: number[]): number =>
    bits.reduce((acc, b, i) => acc + (b ? WEIGHTS[i]! : 0), 0);

  const core = new Uint32Array(32);
  for (let i = 0; i < 0x20; i++) {
    const b0 = proms[i]!;         // color_prom[i + 0*32]
    const b1 = proms[0x20 + i]!;  // color_prom[i + 1*32]
    const r = five([(b1 >> 1) & 1, (b1 >> 2) & 1, (b1 >> 3) & 1, (b1 >> 4) & 1, (b1 >> 5) & 1]);
    const g = five([(b1 >> 6) & 1, (b1 >> 7) & 1, b0 & 1, (b0 >> 1) & 1, (b0 >> 2) & 1]);
    const b = five([(b0 >> 3) & 1, (b0 >> 4) & 1, (b0 >> 5) & 1, (b0 >> 6) & 1, (b0 >> 7) & 1]);
    core[i] = packRGB(r, g, b);
  }

  const spriteColor = new Uint32Array(64 * 4);
  for (let i = 0; i < 64 * 4; i++) {
    spriteColor[i] = core[proms[0x040 + i]! & 0x0f]!;
  }

  const charColor = new Uint32Array(32 * 4);
  for (let i = 0; i < 32 * 4; i++) {
    charColor[i] = core[(proms[0x140 + i]! & 0x0f) + 0x10]!;
  }

  return { core, spriteColor, charColor };
}

// ---------------------------------------------------------------------------

const BLACK = packRGB(0, 0, 0);

// visarea y 16..239: the bitmap is 256 lines with visible y 16..239; our
// framebuffer holds the visible window only.
const VBEND = 16;

export class TimepltVideo implements VideoRenderer {
  readonly width: number = 256;
  readonly height: number = 224;

  private readonly videoram: Uint8Array;
  private readonly colorram: Uint8Array;
  private readonly spriteram0: Uint8Array;
  private readonly spriteram1: Uint8Array;

  private readonly charGfx: GfxSet;
  private readonly spriteGfx: GfxSet;
  private readonly pal: TimepltPalette;

  private flip = false;         // mainlatch Q1 -> flip_screen_set (inverted; board resolves)
  private videoEnable = false;  // mainlatch Q4 -> video_enable_w

  constructor(deps: TimepltVideoDeps) {
    const tiles = deps.regions['tiles'];
    const sprites = deps.regions['sprites'];
    const proms = deps.regions['proms'];
    if (!tiles || !sprites || !proms) throw new Error('timeplt video: missing tiles/sprites/proms region');
    if (proms.length < 0x240) throw new Error('timeplt video: proms region too small');

    this.videoram = deps.videoram;
    this.colorram = deps.colorram;
    this.spriteram0 = deps.spriteram0;
    this.spriteram1 = deps.spriteram1;

    // GFXDECODE_ENTRY("tiles", 0, charlayout, 0, 32) /
    // ("sprites", 0, spritelayout, 32*4, 64) — timeplt.cpp:706-709
    this.charGfx = decodeGfx(TIMEPLT_CHAR_LAYOUT, tiles);      // 512 8x8 chars
    this.spriteGfx = decodeGfx(TIMEPLT_SPRITE_LAYOUT, sprites); // 256 16x16 sprites
    this.pal = buildTimepltPalette(proms);
  }

  /**
   * mainlatch Q1 (timeplt.cpp:748: q_out_cb<1>().set(flip_screen_set).invert()).
   * The board passes the already-inverted flip state (true = render flipped).
   */
  setFlip(state: boolean): void {
    this.flip = state;
  }

  /** mainlatch Q4 -> video_enable_w (timeplt.cpp:751, 330-333). */
  setVideoEnable(state: boolean): void {
    this.videoEnable = state;
  }

  /**
   * Port of screen_update (timeplt.cpp:374-383): when video_enable is clear
   * the screen stays blank; otherwise category-0 tiles, sprites, then
   * category-1 tiles on top (the cloud/score priority trick).
   */
  render(frame: Uint32Array): void {
    frame.fill(BLACK);
    if (!this.videoEnable) return;
    this.drawTilemap(frame, 0);
    this.drawSprites(frame);
    this.drawTilemap(frame, 1);
  }

  /** No per-frame latching; state is sampled during render like screen_update. */
  vblank(): void {}

  /**
   * Tilemap: TILEMAP_SCAN_ROWS 32x32 of 8x8 chars (timeplt.cpp:284-290).
   * get_tile_info (timeplt.cpp:256-266):
   *   code     = videoram + 8 * (attr & 0x20)   (attr bit 5 -> +0x100, 512 chars)
   *   color    = attr & 0x1f
   *   flags    = TILE_FLIPYX(attr >> 6): flipx = attr bit 6, flipy = attr bit 7
   *   category = (attr & 0x10) >> 4  (1 = drawn over sprites)
   * Only tiles whose category matches `category` are drawn in this pass;
   * both passes draw opaque (pen 0 through the LUT), exactly like MAME's
   * per-category tilemap draw.
   */
  private drawTilemap(frame: Uint32Array, category: number): void {
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
        if (((attr >> 4) & 1) !== category) continue;

        const destY = (flip ? 31 - row : row) * 8 - VBEND;
        if (destY < 0 || destY >= h) continue;
        const destX = (flip ? 31 - col : col) * 8;

        const code = (vram[offs]! + 8 * (attr & 0x20)) % gfx.count;
        const colorBase = (attr & 0x1f) * 4;
        let flipx = (attr >> 6) & 1;
        let flipy = (attr >> 7) & 1;
        if (flip) {
          flipx ^= 1;
          flipy ^= 1;
        }

        const base = code * 64;
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
   * Port of draw_sprites (timeplt.cpp:347-365):
   *   for offs = 0x3e down to 0x10 step 2 (24 sprites; LOWER offsets on top):
   *     sx     = spriteram0[offs]
   *     sy     = 241 - spriteram1[offs + 1]  (full-bitmap coords, y 16..239 visible)
   *     code   = spriteram0[offs + 1]
   *     color  = spriteram1[offs] & 0x3f
   *     flip_x = ~spriteram1[offs] & 0x40    (bit 6 CLEAR = flipped!)
   *     flip_y = spriteram1[offs] & 0x80
   *   transpen 0: RAW pen 0 is transparent (direct pens — no LUT rule here).
   * Screen flip is NOT applied to sprites (draw_sprites never reads
   * flip_screen(); the game flips them in software), same as video/rocnrope.ts.
   */
  private drawSprites(frame: Uint32Array): void {
    const sr0 = this.spriteram0;
    const sr1 = this.spriteram1;
    const gfx = this.spriteGfx;
    const src = gfx.pixels;
    const spriteColor = this.pal.spriteColor;
    const w = this.width;
    const h = this.height;

    for (let offs = 0x3e; offs >= 0x10; offs -= 2) {
      const attr = sr1[offs]!;
      const colorBase = (attr & 0x3f) * 4;
      const code = sr0[offs + 1]! % gfx.count;
      const flipx = (attr & 0x40) === 0; // inverted sense
      const flipy = (attr & 0x80) !== 0;
      const sx = sr0[offs]!;
      const sy = 241 - sr1[offs + 1]! - VBEND;

      const base = code * 256; // 16x16 pixels per element

      for (let py = 0; py < 16; py++) {
        const dy = sy + py;
        if (dy < 0 || dy >= h) continue;
        const srcRow = base + (flipy ? 15 - py : py) * 16;
        const dstRow = dy * w;
        for (let px = 0; px < 16; px++) {
          const dx = sx + px;
          if (dx < 0 || dx >= w) continue;
          const pen = src[srcRow + (flipx ? 15 - px : px)]!;
          if (pen === 0) continue; // transpen 0 (raw pen)
          frame[dstRow + dx] = spriteColor[colorBase + pen]!;
        }
      }
    }
  }
}
