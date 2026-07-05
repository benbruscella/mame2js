// Structural self-test for the Galaxian video renderer.
// Run with: node src/runtime/video/galaxian.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.

import { decodeGfx } from '../gfx.ts';
import {
  buildGalaxianPalette,
  buildGalaxianStarTable,
  STAR_RNG_PERIOD,
  CHAR_LAYOUT,
  SPRITE_LAYOUT,
  GalaxianVideo,
} from './galaxian.ts';

let failures = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    failures++;
  }
}

const hex = (v: number): string => '0x' + (v >>> 0).toString(16);
const BLACK = 0xff000000;

// ---------------------------------------------------------------------------
// (a) palette decode on a synthetic PROM — expectations computed
// independently from the resistor networks (1k/470/220 for R,G; 470/220 for
// B; 470 Ohm pulldown on each; normalized so the R/G net sums to 224).
{
  const proms = new Uint8Array(0x20);
  proms[0] = 0x01; // red bit 0 (1 kohm)
  proms[1] = 0x02; // red bit 1 (470 ohm)
  proms[2] = 0x04; // red bit 2 (220 ohm)
  proms[3] = 0x07; // full red
  proms[4] = 0x40; // blue bit 0 (470 ohm)
  proms[5] = 0x80; // blue bit 1 (220 ohm)
  proms[6] = 0xff; // everything
  const pal = buildGalaxianPalette(proms);

  const r = (v: number): number => v & 0xff;
  const g = (v: number): number => (v >>> 8) & 0xff;
  const b = (v: number): number => (v >>> 16) & 0xff;
  const a = (v: number): number => (v >>> 24) & 0xff;

  // parallel resistance of a set
  const par = (...rs: number[]): number => 1 / rs.reduce((s, x) => s + 1 / x, 0);
  // voltage-divider weight for resistor R against the rest of the net + 470 pd
  const RGB_MAX = 224;
  const w1k = RGB_MAX * (par(470, 220, 470) / (par(470, 220, 470) + 1000));
  const w470 = RGB_MAX * (par(1000, 220, 470) / (par(1000, 220, 470) + 470));
  const w220 = RGB_MAX * (par(1000, 470, 470) / (par(1000, 470, 470) + 220));
  const wb470 = RGB_MAX * (par(220, 470) / (par(220, 470) + 470));
  const wb220 = RGB_MAX * (par(470, 470) / (par(470, 470) + 220));
  // the R/G net has the larger sum -> it is the autoscale reference
  const scale = RGB_MAX / (w1k + w470 + w220);
  const e1k = Math.floor(w1k * scale + 0.5);
  const e470 = Math.floor(w470 * scale + 0.5);
  const e220 = Math.floor(w220 * scale + 0.5);
  const eb470 = Math.floor(wb470 * scale + 0.5);
  const eb220 = Math.floor(wb220 * scale + 0.5);

  check('palette R/G net sums to RGB_MAXIMUM 224', e1k + e470 + e220 === 224,
    `${e1k}+${e470}+${e220}`);
  check('palette prom 0x01 -> 1k red weight',
    r(pal.colors[0]) === e1k && g(pal.colors[0]) === 0 && b(pal.colors[0]) === 0,
    `r=${r(pal.colors[0])} expected ${e1k}`);
  check('palette prom 0x02 -> 470 red weight', r(pal.colors[1]) === e470,
    `r=${r(pal.colors[1])} expected ${e470}`);
  check('palette prom 0x04 -> 220 red weight', r(pal.colors[2]) === e220,
    `r=${r(pal.colors[2])} expected ${e220}`);
  check('palette prom 0x07 -> full red 224', r(pal.colors[3]) === 224, `r=${r(pal.colors[3])}`);
  check('palette blue weights', b(pal.colors[4]) === eb470 && b(pal.colors[5]) === eb220,
    `${b(pal.colors[4])},${b(pal.colors[5])} expected ${eb470},${eb220}`);
  check('palette prom 0xff -> (224,224,eb sum)',
    r(pal.colors[6]) === 224 && g(pal.colors[6]) === 224 && b(pal.colors[6]) === eb470 + eb220,
    hex(pal.colors[6]));
  check('palette alpha always 0xff', a(pal.colors[0]) === 0xff && a(pal.stars[0]) === 0xff);

  // star colors: starmap {0, 194, 214, 255} per galaxian_v.cpp:320-329
  // (minval=224*130/150=194, midval=291, maxval=485 -> mid star = 214)
  check('star color 0x00 is black', pal.stars[0] === BLACK, hex(pal.stars[0]));
  check('star color 0x3f is white', pal.stars[63] === 0xffffffff, hex(pal.stars[63]));
  check('star color bit5 -> red 150 Ohm = 194',
    r(pal.stars[0x20]) === 194 && g(pal.stars[0x20]) === 0 && b(pal.stars[0x20]) === 0,
    `r=${r(pal.stars[0x20])}`);
  check('star color bit4 -> red 100 Ohm = 214', r(pal.stars[0x10]) === 214,
    `r=${r(pal.stars[0x10])}`);
  check('star color bits1,0 -> blue 194/214',
    b(pal.stars[0x02]) === 194 && b(pal.stars[0x01]) === 214,
    `${b(pal.stars[0x02])},${b(pal.stars[0x01])}`);

  // bullets: 7 white shells + yellow missile
  check('bullet colors: shells white, missile yellow',
    pal.bullets[0] === 0xffffffff && pal.bullets[6] === 0xffffffff &&
    pal.bullets[7] === 0xff00ffff,
    `${hex(pal.bullets[0])},${hex(pal.bullets[7])}`);
}

// ---------------------------------------------------------------------------
// (b) char/sprite decode via decodeGfx + RGN_FRAC(1,2) two-plane split
{
  const gfx1 = new Uint8Array(0x1000);
  // char 1, row 0: plane 0 (first half, MSB of pixel) = 0xF0, plane 1
  // (second half at +0x800 bytes) = 0x0F -> pixels 2,2,2,2,1,1,1,1
  gfx1[8] = 0xf0;
  gfx1[0x800 + 8] = 0x0f;
  // char 1, row 1: both planes 0xC0 -> pixels 3,3,0,...
  gfx1[9] = 0xc0;
  gfx1[0x800 + 9] = 0xc0;
  const chars = decodeGfx(CHAR_LAYOUT, gfx1);
  check('char decode: 256 8x8 elements', chars.count === 256 && chars.width === 8,
    `count=${chars.count}`);
  const row0 = Array.from(chars.pixels.slice(64, 72));
  check('char 1 row 0 planes decode (plane0=MSB)',
    row0.join(',') === '2,2,2,2,1,1,1,1', row0.join(','));
  check('char 1 row 1 both planes -> pen 3',
    chars.pixels[72] === 3 && chars.pixels[73] === 3 && chars.pixels[74] === 0);

  // sprite 2, pixel (x=12, y=9): bit offset = 2*256 + yOff(136) + xOff(68)
  // = 716 -> plane0 byte 89 bit 4; plane1 at +16384 bits -> byte 2137 bit 4
  const gfx2 = new Uint8Array(0x1000);
  gfx2[89] = 0x08;
  const sprites1 = decodeGfx(SPRITE_LAYOUT, gfx2);
  check('sprite decode: 64 16x16 elements', sprites1.count === 64 && sprites1.width === 16,
    `count=${sprites1.count}`);
  check('sprite 2 (12,9) plane 0 only -> pen 2',
    sprites1.pixels[2 * 256 + 9 * 16 + 12] === 2,
    `${sprites1.pixels[2 * 256 + 9 * 16 + 12]}`);
  gfx2[2137] = 0x08;
  const sprites2 = decodeGfx(SPRITE_LAYOUT, gfx2);
  check('sprite 2 (12,9) both planes -> pen 3',
    sprites2.pixels[2 * 256 + 9 * 16 + 12] === 3);
  // no other pixel of sprite 2 is set
  let others = 0;
  for (let i = 2 * 256; i < 3 * 256; i++) {
    if (i !== 2 * 256 + 9 * 16 + 12 && sprites2.pixels[i] !== 0) others++;
  }
  check('sprite 2 decode touches exactly one pixel', others === 0, `${others}`);
}

// ---------------------------------------------------------------------------
// (c) tilemap addressing: char at videoram offset N with column scroll S
//     lands at the expected framebuffer coords (VRAM row = V + scroll,
//     visible window = screen lines 16..239)
{
  const regions: Record<string, Uint8Array> = {
    gfx1: new Uint8Array(0x1000),
    proms: new Uint8Array(0x20),
  };
  // char 1 = all pen 3
  regions.gfx1.fill(0xff, 8, 16);
  regions.gfx1.fill(0xff, 0x808, 0x810);
  // color 0 pen 3 -> full red; color 3 pen 3 -> full blue
  regions.proms[3] = 0x07;
  regions.proms[15] = 0xc0;
  const pal = buildGalaxianPalette(regions.proms);
  const red = pal.colors[3] >>> 0;
  const blue = pal.colors[15] >>> 0;

  const videoram = new Uint8Array(0x400);
  const objram = new Uint8Array(0x100);
  // tile A: row 10, col 4, column scroll 5, color 0.
  // Visible when (y + 5) >> 3 == 10 -> screen y 75..82 -> fb y 59..66, x 32..39.
  videoram[10 * 32 + 4] = 1;
  objram[4 * 2] = 5;
  objram[4 * 2 + 1] = 0;
  // tile B: row 0, col 20, scroll 200 (wraps), color 3.
  // (y + 200) & 0xff in [0,8) -> screen y 56..63 -> fb y 40..47, x 160..167.
  videoram[0 * 32 + 20] = 1;
  objram[20 * 2] = 200;
  objram[20 * 2 + 1] = 3;

  const video = new GalaxianVideo({ regions, videoram, objram });
  check('GalaxianVideo native size 256x224', video.width === 256 && video.height === 224);

  const frame = new Uint32Array(256 * 224);
  video.render(frame);
  const at = (x: number, y: number): number => frame[y * 256 + x] >>> 0;

  check('tile A top-left at (32,59)', at(32, 59) === red, `${hex(at(32, 59))} want ${hex(red)}`);
  check('tile A bottom-right at (39,66)', at(39, 66) === red, hex(at(39, 66)));
  check('tile A clipped above/below', at(32, 58) === BLACK && at(32, 67) === BLACK);
  check('tile A clipped left/right', at(31, 59) === BLACK && at(40, 59) === BLACK);
  check('tile B wraps scroll to (160,40) in color 3', at(160, 40) === blue && at(167, 47) === blue,
    `${hex(at(160, 40))} want ${hex(blue)}`);
  check('tile B clipped above', at(160, 39) === BLACK);
}

// ---------------------------------------------------------------------------
// (d) sprite + bullet render smoke
{
  const regions: Record<string, Uint8Array> = {
    gfx1: new Uint8Array(0x1000),
    proms: new Uint8Array(0x20),
  };
  // sprite code 5 = all pen 3 (plane bytes 160..191 in both halves)
  regions.gfx1.fill(0xff, 160, 192);
  regions.gfx1.fill(0xff, 0x800 + 160, 0x800 + 192);
  regions.proms[7] = 0x07; // color 1 pen 3 -> full red
  const pal = buildGalaxianPalette(regions.proms);
  const red = pal.colors[7] >>> 0;
  const white = 0xffffffff;
  const yellow = 0xff00ffff;

  const videoram = new Uint8Array(0x400);
  const objram = new Uint8Array(0x100);
  // sprite slot 0 (matches y-1): base0=141 -> sy = 240-(141-1) = 100 -> fb y 84..99;
  // x byte 119 -> sx = 120 (the +1 hardware offset) -> x 120..135
  objram[0x40] = 141;
  objram[0x41] = 5;
  objram[0x42] = 1;
  objram[0x43] = 119;
  // sprite slot 1 at sx=10: clipped to x >= 17 by the line buffer
  objram[0x44] = 141;
  objram[0x45] = 5;
  objram[0x46] = 1;
  objram[0x47] = 9;
  // bullet entry 4 (shell, matches y): y byte 155 -> screen y 100 -> fb 84;
  // x byte 51 -> run at 255-51-4 .. -1 = x 200..203, white
  objram[0x60 + 4 * 4 + 1] = 155;
  objram[0x60 + 4 * 4 + 3] = 51;
  // bullet entry 7 (missile, yellow): same line, x byte 151 -> x 100..103
  objram[0x60 + 7 * 4 + 1] = 155;
  objram[0x60 + 7 * 4 + 3] = 151;
  // bullet entry 0 (shell, matches y-1): y byte 155 -> screen y 101 -> fb 85;
  // x byte 11 -> x 240..243
  objram[0x60 + 0 * 4 + 1] = 155;
  objram[0x60 + 0 * 4 + 3] = 11;

  const video = new GalaxianVideo({ regions, videoram, objram });
  const frame = new Uint32Array(256 * 224);
  video.render(frame);
  const at = (x: number, y: number): number => frame[y * 256 + x] >>> 0;

  check('sprite 0 top-left at (120,84)', at(120, 84) === red, `${hex(at(120, 84))} want ${hex(red)}`);
  check('sprite 0 bottom-right at (135,99)', at(135, 99) === red, hex(at(135, 99)));
  check('sprite 0 bounded', at(119, 84) === BLACK && at(136, 84) === BLACK && at(120, 83) === BLACK && at(120, 100) === BLACK);
  check('sprite 1 clipped at line-buffer edge x=17',
    at(16, 90) === BLACK && at(17, 90) === red && at(25, 90) === red && at(26, 90) === BLACK,
    `${hex(at(16, 90))},${hex(at(17, 90))}`);
  check('shell (entry 4) white 4px run at (200..203,84)',
    at(200, 84) === white && at(203, 84) === white && at(199, 84) === BLACK && at(204, 84) === BLACK);
  check('missile (entry 7) yellow at (100..103,84)',
    at(100, 84) === yellow && at(103, 84) === yellow && at(104, 84) === BLACK);
  check('shell entry 0 matches y-1 (fb row 85, not 84)',
    at(240, 85) === white && at(240, 84) === BLACK,
    `${hex(at(240, 85))},${hex(at(240, 84))}`);

  let opaque = true;
  for (const v of frame) if (((v >>> 24) & 0xff) !== 0xff) { opaque = false; break; }
  check('alpha always 0xff', opaque);
}

// ---------------------------------------------------------------------------
// (e) star RNG table: period, hit count, no adjacent hits
{
  const table = buildGalaxianStarTable();
  check('star table covers the full RNG period', table.length === STAR_RNG_PERIOD && STAR_RNG_PERIOD === 131071);
  check('star table first entry: disabled, color 0x3f', table[0] === 0x3f, hex(table[0]));
  let enabled = 0;
  let adjacent = 0;
  for (let i = 0; i < STAR_RNG_PERIOD; i++) {
    if (table[i] & 0x80) {
      enabled++;
      if (table[(i + 1) % STAR_RNG_PERIOD] & 0x80) adjacent++;
    }
  }
  // 8 free bits under the (top-8-ones, low-zero) enable pattern -> 256 hits
  check('star table has exactly 256 enabled states', enabled === 256, `${enabled}`);
  check('no two consecutive RNG states enabled (safe 1x merge)', adjacent === 0, `${adjacent}`);
}

// (e2) starfield determinism + per-frame star count
{
  const regions: Record<string, Uint8Array> = {
    gfx1: new Uint8Array(0x1000),
    proms: new Uint8Array(0x20),
  };
  const videoram = new Uint8Array(0x400);
  const objram = new Uint8Array(0x100);
  const video = new GalaxianVideo({ regions, videoram, objram });

  // disabled -> no stars
  const f0 = new Uint32Array(256 * 224);
  video.render(f0);
  check('stars disabled -> all black', f0.every((v) => v === BLACK));

  video.setStarsEnable(1);
  const f1 = new Uint32Array(256 * 224);
  const f2 = new Uint32Array(256 * 224);
  video.render(f1);
  video.render(f2); // no vblank between renders -> same origin -> same pixels
  let same = true;
  for (let i = 0; i < f1.length; i++) if (f1[i] !== f2[i]) { same = false; break; }
  check('render is pure: identical frames at the same origin', same);

  let stars = 0;
  for (const v of f1) if (v !== BLACK) stars++;
  // ~112 expected: 224 rows consult ~114688/131071 of the 256 hits, halved
  // by the V1^H8 gate; two RNG clocks per pixel can merge a handful
  check('star count per frame within bounds', stars > 40 && stars < 220, `stars=${stars}`);

  video.vblank(); // scroll: origin advances by -1
  const f3 = new Uint32Array(256 * 224);
  video.render(f3);
  let diff = 0;
  for (let i = 0; i < f1.length; i++) if (f1[i] !== f3[i]) diff++;
  check('vblank scrolls the starfield (frames differ)', diff > 0, `diff=${diff}`);

  // re-enable rising edge resets the origin -> matches the first frame again
  video.setStarsEnable(0);
  video.setStarsEnable(1);
  const f4 = new Uint32Array(256 * 224);
  video.render(f4);
  let sameAgain = true;
  for (let i = 0; i < f1.length; i++) if (f1[i] !== f4[i]) { sameAgain = false; break; }
  check('stars enable rising edge resets the RNG origin', sameAgain);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
}
