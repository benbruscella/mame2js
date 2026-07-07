// Konami Juno First bitmap video renderer.
//
// Hand-transpiled from MAME ground truth. junofrst_state derives from
// tutankhm_state (src/mame/konami/junofrst.cpp:103) and installs
// screen_update_scramble directly (junofrst.cpp:417), so the renderer is:
//   - tutankhm_state::screen_update_scramble (tutankhm_v.cpp:97-124):
//     scramble_draw_background (black fill + stars) then the 4bpp bitmap.
//     effx = x ^ (flipX ? 255 : 0); effy = (y ^ (flipY ? 255 : 0)) + yscroll;
//     vrambyte = videoram[effy * 128 + effx / 2];
//     shifted = vrambyte >> (4 * (effx & 1)); pen = shifted & 0x0f.
//     So the LOW nibble is the EVEN x pixel and the HIGH nibble the ODD x
//     pixel — the junofrst blitter (junofrst.cpp:196-199) uses the same
//     nibble addressing (dest bit 0 set -> high nibble).
//   - Scroll: tutankhm's per-column scroll register (m_scroll, applied when
//     effx < 192 AND m_scroll.found()) is NOT mapped by junofrst's main_map
//     (junofrst.cpp:264-282 has no "scroll" share), so m_scroll.found() is
//     false and yscroll is always 0. Omitted here; if a tutankhm port ever
//     shares this module, add an optional scroll() dep.
//   - Stars: scramble_draw_background only draws stars when m_stars_enabled,
//     and junofrst never maps stars_enable_w (video_start leaves it 0), so
//     the background is a plain black fill. The pen-0 "preserve star pixel"
//     quirk in screen_update_scramble (only overwrite pen 0 when the
//     destination is still black) is therefore always true — a plain write
//     is behavior-identical.
//   - Palette: 16 bytes of RAM at $8000-$800f (share "palette",
//     junofrst.cpp:267), format BBGGGRRR (driver header comment,
//     junofrst.cpp:16), decoded per entry by tutankhm_state::raw_to_rgb_func
//     (tutankhm_v.cpp:147-208): resistor nets 1k/470/220 (R: bits 0-2,
//     G: bits 3-5) and 470/220 (B: bits 6-7), each with a 470 Ohm pulldown,
//     autoscaled to RGB_MAXIMUM = 224 (headroom for the stars junofrst
//     never draws). PALETTE(...).set_format(1, raw_to_rgb_func, 16)
//     (junofrst.cpp:415).
//   - Screen: set_raw with the GALAXIAN_* constants (tutankhm.h:13-25):
//     384*3 htotal, visible x 0..255 at native resolution (MAME stretches
//     x3 via GALAXIAN_XSCALE at the 18.432 MHz pixel clock; we render the
//     native 256 columns and let the canvas scale), vtotal 264, visible y
//     16..239 (VBEND 16, VBSTART 240) = 224 lines. VRAM is indexed by the
//     full bitmap scanline y (16..239), so framebuffer row 0 shows VRAM row
//     16 (VRAM rows 0-15 and 240-255 are never visible, flipped or not:
//     flip XORs y with 255 inside the same 16..239 window). ROT90 happens
//     at blit time, as everywhere else in this runtime.
//   - Flip: separate X/Y flip latches from mainlatch Q4 (HFF) / Q5 (VFLIP)
//     (junofrst.cpp:407-408), provided via deps getters.
//
// Native (pre-rotation) resolution 256x224. Output pixels are packed
// 0xAABBGGRR (canvas ImageData order), alpha 0xff.

import type { VideoRenderer } from '../types.ts';

// Board contract: the board owns VRAM/palette RAM/flip latches and hands
// live getters to the renderer (getter pattern like video/m52.ts deps).
export interface JunofrstVideoDeps {
  /** 0x8000-byte share "videoram" ($0000-$7fff): 256x256, 2 pixels/byte. */
  videoram(): Uint8Array;
  /** 16-byte share "palette" ($8000-$800f), BBGGGRRR per entry. */
  paletteRam(): Uint8Array;
  /** mainlatch Q4 (HFF). */
  flipX(): boolean;
  /** mainlatch Q5 (VFLIP). */
  flipY(): boolean;
}

// ---------------------------------------------------------------------------
// resnet.cpp port (same faithful subset as video/galaxian.ts: pulldown
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

// tutankhm_v.cpp:16 — normalize to 224 to leave headroom for stars.
const RGB_MAXIMUM = 224;

// The weight tables are hardware constants; compute them once at module load
// (raw_to_rgb_func recomputes per call, same values every time).
const [RWEIGHTS, GWEIGHTS, BWEIGHTS] = computeResistorWeights(0, RGB_MAXIMUM, -1.0, [
  { resistances: [1000, 470, 220], pulldown: 470, pullup: 0 }, // R, bits 0-2
  { resistances: [1000, 470, 220], pulldown: 470, pullup: 0 }, // G, bits 3-5
  { resistances: [470, 220], pulldown: 470, pullup: 0 },       // B, bits 6-7
]);

/** Port of tutankhm_state::raw_to_rgb_func (tutankhm_v.cpp:147-208):
 *  one BBGGGRRR palette-RAM byte -> packed 0xAABBGGRR. */
export function rawToRgb(raw: number): number {
  const r = combineWeights(RWEIGHTS, raw & 1, (raw >> 1) & 1, (raw >> 2) & 1);
  const g = combineWeights(GWEIGHTS, (raw >> 3) & 1, (raw >> 4) & 1, (raw >> 5) & 1);
  const b = combineWeights(BWEIGHTS, (raw >> 6) & 1, (raw >> 7) & 1);
  return packRGB(r, g, b);
}

// ---------------------------------------------------------------------------
// screen geometry (junofrst.cpp:414 set_raw + tutankhm.h:13-25): native
// 256 columns (GALAXIAN_H0START/HBSTART 0..256, the x3 XSCALE stretch is a
// pixel-clock artifact we skip), visible lines VBEND..VBSTART-1 = 16..239.

const VBEND = 16;      // GALAXIAN_VBEND
const NATIVE_W = 256;
const NATIVE_H = 224;  // GALAXIAN_VBSTART (240) - GALAXIAN_VBEND (16)

export class JunofrstVideo implements VideoRenderer {
  readonly width: number = NATIVE_W;
  readonly height: number = NATIVE_H;

  private readonly deps: JunofrstVideoDeps;
  private readonly pens = new Uint32Array(16);

  constructor(deps: JunofrstVideoDeps) {
    if (deps.videoram().length < 0x8000) {
      throw new Error('junofrst video: videoram share must be 0x8000 bytes');
    }
    if (deps.paletteRam().length < 16) {
      throw new Error('junofrst video: palette share must be 16 bytes');
    }
    this.deps = deps;
  }

  /** All per-frame state is read live from the board shares/latches. */
  vblank(): void {}

  /** Port of screen_update_scramble (tutankhm_v.cpp:97-124), yscroll = 0 and
   *  stars disabled (see header). */
  render(frame: Uint32Array): void {
    const vram = this.deps.videoram();
    const palRam = this.deps.paletteRam();
    const pens = this.pens;

    // Palette RAM is live ($8000-$800f writes land any time); 16 entries.
    for (let i = 0; i < 16; i++) pens[i] = rawToRgb(palRam[i]);

    const xorx = this.deps.flipX() ? 255 : 0;
    const xory = this.deps.flipY() ? 255 : 0;

    for (let fy = 0; fy < NATIVE_H; fy++) {
      const y = fy + VBEND;             // bitmap scanline 16..239 indexes VRAM
      const effy = (y ^ xory) & 0xff;   // + yscroll, always 0 for junofrst
      const rowBase = effy << 7;        // effy * 128
      const dst = fy * NATIVE_W;
      for (let x = 0; x < NATIVE_W; x++) {
        const effx = x ^ xorx;
        const vrambyte = vram[rowBase | (effx >> 1)];
        // low nibble = even effx, high nibble = odd effx
        const pen = (effx & 1) ? vrambyte >> 4 : vrambyte & 0x0f;
        frame[dst + x] = pens[pen];
      }
    }
  }
}
