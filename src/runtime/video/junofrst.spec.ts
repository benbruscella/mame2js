// Spec for the Konami Juno First bitmap renderer. Plain node script.
//
// Ground truth: tutankhm_state::screen_update_scramble (tutankhm_v.cpp:97-124)
// with junofrst's config (junofrst.cpp:413-417) — no scroll share, stars
// never enabled, 16-entry BBGGGRRR palette RAM via raw_to_rgb_func.
import { JunofrstVideo, rawToRgb } from './junofrst.ts';
import type { JunofrstVideoDeps } from './junofrst.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

// ---------------------------------------------------------------------------
// harness: board-owned shares + latches, handed over as live getters

let vram = new Uint8Array(0x8000);
const pal = new Uint8Array(16);
let flipX = false;
let flipY = false;

const deps: JunofrstVideoDeps = {
  videoram: () => vram,
  paletteRam: () => pal,
  flipX: () => flipX,
  flipY: () => flipY,
};
const video = new JunofrstVideo(deps);
const fb = new Uint32Array(video.width * video.height);

const px = (x: number, y: number) => fb[y * video.width + x];
/** set one 4-bit pixel in VRAM coordinates (vx 0..255, vy 0..255) */
function setVramPixel(vx: number, vy: number, pen: number): void {
  const i = vy * 128 + (vx >> 1);
  vram[i] = (vx & 1) ? (vram[i] & 0x0f) | (pen << 4) : (vram[i] & 0xf0) | (pen & 0x0f);
}

// ---------------------------------------------------------------------------
// geometry

check('native width 256', video.width === 256);
check('native height 224 (galaxian vbend 16 .. vbstart 240)', video.height === 224);

// ---------------------------------------------------------------------------
// baseline: blank VRAM + zero palette = opaque black everywhere

video.render(fb);
check('blank vram renders all opaque black', fb.every(v => v === 0xff000000));

// ---------------------------------------------------------------------------
// BBGGGRRR palette decode (raw_to_rgb_func, tutankhm_v.cpp:147-208):
// R = bits 0-2 and G = bits 3-5 through 1k/470/220 nets, B = bits 6-7
// through 470/220, all with a 470 Ohm pulldown, autoscaled to max 224.
// Expected values verified against MAME's compute_resistor_weights.

const PAL_RAW = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
                 0x08, 0x10, 0x20, 0x38, 0x40, 0x80, 0xc0, 0xff];
const PAL_EXPECT = [
  0xff000000, // 0x00 black
  0xff00001d, // 0x01 r=29  (1k bit alone)
  0xff00003e, // 0x02 r=62  (470)
  0xff00005b, // 0x03 r=91  (1k+470)
  0xff000085, // 0x04 r=133 (220)
  0xff0000a2, // 0x05 r=162
  0xff0000c3, // 0x06 r=195
  0xff0000e0, // 0x07 r=224 pure red = RGB_MAXIMUM
  0xff001d00, // 0x08 g=29
  0xff003e00, // 0x10 g=62
  0xff008500, // 0x20 g=133
  0xff00e000, // 0x38 g=224 pure green
  0xff450000, // 0x40 b=69  (470)
  0xff940000, // 0x80 b=148 (220)
  0xffd90000, // 0xc0 b=217 pure blue (2-resistor net sums below 224)
  0xffd9e0e0, // 0xff white (224,224,217)
];
for (let i = 0; i < 16; i++) pal[i] = PAL_RAW[i];

// paint pens 0..15 as the first 16 pixels of VRAM row 16 (first visible line)
for (let p = 0; p < 16; p++) setVramPixel(p, 16, p);
video.render(fb);
for (let p = 0; p < 16; p++) {
  const hex = '0x' + PAL_RAW[p].toString(16).padStart(2, '0');
  check(`palette raw ${hex} -> 0x${PAL_EXPECT[p].toString(16)}`, px(p, 0) === PAL_EXPECT[p]);
}
check('all rendered pixels have alpha 0xff', fb.every(v => (v >>> 24) === 0xff));

// palette RAM is live, not latched: rewriting an entry recolors next frame
pal[1] = 0x38; // pen 1: red 29 -> pure green
video.render(fb);
check('palette RAM change takes effect next render', px(1, 0) === 0xff00e000);
pal[1] = 0x01;

// ---------------------------------------------------------------------------
// nibble order: LOW nibble = EVEN x, HIGH nibble = ODD x
// (shifted = vrambyte >> (4 * (effx & 1)), tutankhm_v.cpp:114; the blitter
// writes the same way, junofrst.cpp:196-199)

vram.fill(0);
vram[16 * 128] = 0x27; // pen 7 (red) even pixel, pen 2 (r=62) odd pixel
video.render(fb);
check('byte low nibble -> even x pixel (0,0)', px(0, 0) === 0xff0000e0);
check('byte high nibble -> odd x pixel (1,0)', px(1, 0) === 0xff00003e);
check('pixel (2,0) untouched by byte 0', px(2, 0) === 0xff000000);

vram[16 * 128] = 0xf0; // pen 0 even, pen 15 (white) odd
video.render(fb);
check('0xf0: even pixel is pen 0', px(0, 0) === 0xff000000);
check('0xf0: odd pixel is pen 15', px(1, 0) === 0xffd9e0e0);

// byte n of a row covers x = 2n, 2n+1
vram.fill(0);
vram[16 * 128 + 5] = 0x77;
video.render(fb);
check('row byte 5 -> pixels (10,0) and (11,0)', px(10, 0) === 0xff0000e0 && px(11, 0) === 0xff0000e0);
check('row byte 5 does not touch (9,0)/(12,0)', px(9, 0) === 0xff000000 && px(12, 0) === 0xff000000);

// last byte of a row -> rightmost pixel pair
vram.fill(0);
vram[16 * 128 + 127] = 0x70; // high nibble = odd x = 255
video.render(fb);
check('row byte 127 high nibble -> pixel (255,0)', px(255, 0) === 0xff0000e0);
check('row byte 127 low nibble stays black at (254,0)', px(254, 0) === 0xff000000);

// ---------------------------------------------------------------------------
// visible window: VRAM is indexed by the bitmap scanline (16..239), so
// framebuffer row 0 = VRAM row 16 and fb row 223 = VRAM row 239; VRAM rows
// 0-15 and 240-255 are outside the visible window in either flip state.

function countPen7(): number {
  let n = 0;
  for (const v of fb) if (v === 0xff0000e0) n++;
  return n;
}

vram.fill(0);
setVramPixel(40, 16, 7);
video.render(fb);
check('vram row 16 -> fb row 0', px(40, 0) === 0xff0000e0);
check('vram row 16 marker appears exactly once', countPen7() === 1);

vram.fill(0);
setVramPixel(40, 239, 7);
video.render(fb);
check('vram row 239 -> fb row 223', px(40, 223) === 0xff0000e0);

vram.fill(0);
for (let x = 0; x < 256; x++) { setVramPixel(x, 15, 7); setVramPixel(x, 240, 7); }
video.render(fb);
check('vram rows 15/240 invisible (no flip)', countPen7() === 0);
flipX = true; flipY = true;
video.render(fb);
check('vram rows 15/240 invisible (flipped)', countPen7() === 0);
flipX = false; flipY = false;

vram.fill(0);
for (let x = 0; x < 256; x++) { setVramPixel(x, 0, 7); setVramPixel(x, 255, 7); }
video.render(fb);
check('vram rows 0/255 invisible (no flip)', countPen7() === 0);
flipY = true;
video.render(fb);
check('vram rows 0/255 invisible (flip y)', countPen7() === 0);
flipY = false;

// ---------------------------------------------------------------------------
// flip latches (mainlatch Q4 = flip x "HFF", Q5 = flip y): effx = x ^ 255,
// effy = y ^ 255 — independent axes, applied to the FULL bitmap coordinate
// (so flip y maps vram row 16 to bitmap line 239 = fb row 223).

vram.fill(0);
setVramPixel(0, 16, 7); // marker at vram top-left of the visible window
video.render(fb);
check('no flip: marker at fb (0,0)', px(0, 0) === 0xff0000e0);
check('no flip: fb (255,223) black', px(255, 223) === 0xff000000);

flipX = true;
video.render(fb);
check('flip x: marker at fb (255,0)', px(255, 0) === 0xff0000e0);
check('flip x: fb (0,0) black', px(0, 0) === 0xff000000);
check('flip x: marker appears exactly once', countPen7() === 1);

flipX = false; flipY = true;
video.render(fb);
check('flip y: marker at fb (0,223)', px(0, 223) === 0xff0000e0);
check('flip y: fb (0,0) black', px(0, 0) === 0xff000000);

flipX = true;
video.render(fb);
check('flip x+y: marker at fb (255,223)', px(255, 223) === 0xff0000e0);
check('flip x+y: fb (0,0) and (255,0) black', px(0, 0) === 0xff000000 && px(255, 0) === 0xff000000);
flipX = false; flipY = false;

// flip x keeps the nibble pairing: fb x=255 reads effx=0 (low nibble of
// byte 0), fb x=254 reads effx=1 (high nibble)
vram.fill(0);
vram[16 * 128] = 0x27;
flipX = true;
video.render(fb);
check('flip x: low nibble (even effx) lands at fb x=255', px(255, 0) === 0xff0000e0);
check('flip x: high nibble (odd effx) lands at fb x=254', px(254, 0) === 0xff00003e);
flipX = false;

// flip y: fb row 0 reads vram row 239 (effy = 16 ^ 255)
vram.fill(0);
setVramPixel(40, 239, 7);
flipY = true;
video.render(fb);
check('flip y: vram row 239 -> fb row 0', px(40, 0) === 0xff0000e0);
flipY = false;

// ---------------------------------------------------------------------------
// live getters: the renderer must re-fetch shares every frame (board may
// swap or repopulate the backing arrays)

const otherVram = new Uint8Array(0x8000);
otherVram[16 * 128 + 60] = 0x07; // pen 7 at (120, row 16)
vram = otherVram;
video.render(fb);
check('videoram getter is re-read each frame', px(120, 0) === 0xff0000e0);
check('old vram content is gone', px(40, 0) === 0xff000000);

// ---------------------------------------------------------------------------
// whole-frame content + determinism

vram.fill(0x27); // every byte: pen 7 even pixels, pen 2 odd pixels
video.render(fb);
let pen7 = 0, pen2 = 0;
for (const v of fb) { if (v === 0xff0000e0) pen7++; else if (v === 0xff00003e) pen2++; }
check('0x27 fill: even pixels all pen 7', pen7 === 224 * 128);
check('0x27 fill: odd pixels all pen 2', pen2 === 224 * 128);

const a = fb.slice();
video.render(fb);
check('render deterministic', fb.every((v, i) => v === a[i]));

video.vblank(); // no latched per-frame state; must not disturb output
video.render(fb);
check('vblank() is a no-op for rendering', fb.every((v, i) => v === a[i]));

// ---------------------------------------------------------------------------
// rawToRgb export + constructor validation

check('rawToRgb(0x07) pure red 224', rawToRgb(0x07) === 0xff0000e0);
check('rawToRgb(0x38) pure green 224', rawToRgb(0x38) === 0xff00e000);
check('rawToRgb(0xc0) pure blue 217', rawToRgb(0xc0) === 0xffd90000);
check('rawToRgb alpha always 0xff', (rawToRgb(0x00) >>> 24) === 0xff && (rawToRgb(0xff) >>> 24) === 0xff);

let threw = false;
try {
  new JunofrstVideo({ videoram: () => new Uint8Array(0x4000), paletteRam: () => pal, flipX: () => false, flipY: () => false });
} catch { threw = true; }
check('constructor rejects short videoram', threw);

threw = false;
try {
  new JunofrstVideo({ videoram: () => new Uint8Array(0x8000), paletteRam: () => new Uint8Array(8), flipX: () => false, flipY: () => false });
} catch { threw = true; }
check('constructor rejects short palette RAM', threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
