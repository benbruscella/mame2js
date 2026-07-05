// Structural self-test for the Pac-Man video renderer.
// Run with: node src/runtime/video/pacman.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.

import { decodeGfx } from '../gfx.ts';
import {
  buildPacmanPalette, pacmanScanRows, PacmanVideo, TILE_LAYOUT, SPRITE_LAYOUT,
} from './pacman.ts';

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

// ---------------------------------------------------------------------------
// (a) palette decode on a synthetic PROM (same resistor nets as galaga:
//     r/g = 1k/470/220, b = 470/220; classic MAME weights 0x21/0x47/0x97)
{
  const proms = new Uint8Array(0x120);
  proms[0] = 0x01; // red bit 0 (1 kohm)
  proms[1] = 0x02; // red bit 1 (470 ohm)
  proms[2] = 0x04; // red bit 2 (220 ohm)
  proms[3] = 0xff; // everything -> white
  proms[4] = 0x40; // blue bit 0 (470 ohm)
  proms[5] = 0x80; // blue bit 1 (220 ohm)
  proms[6] = 0x08; // green bit 0 (1 kohm)
  const pal = buildPacmanPalette(proms);

  const r = (v: number): number => v & 0xff;
  const g = (v: number): number => (v >>> 8) & 0xff;
  const b = (v: number): number => (v >>> 16) & 0xff;
  const a = (v: number): number => (v >>> 24) & 0xff;

  // Independently computed expectations (voltage dividers, autoscaled):
  //   Rn weight = 255 * (others||pd) / ((others||pd) + Rn), scale = 255/maxSum
  const par2 = (x: number, y: number): number => (x * y) / (x + y);
  const w1k = 255 * (par2(470, 220) / (par2(470, 220) + 1000));
  const w470 = 255 * (par2(1000, 220) / (par2(1000, 220) + 470));
  const w220 = 255 * (par2(1000, 470) / (par2(1000, 470) + 220));
  const scale = 255 / (w1k + w470 + w220); // R/G net has the largest sum
  const exp1k = Math.floor(w1k * scale + 0.5);
  const exp470 = Math.floor(w470 * scale + 0.5);
  const exp220 = Math.floor(w220 * scale + 0.5);
  const bLo = Math.floor(255 * (220 / 690) * scale + 0.5);
  const bHi = Math.floor(255 * (470 / 690) * scale + 0.5);

  // The classic MAME pacman weights: 0x21 / 0x47 / 0x97
  check('palette weights are 0x21/0x47/0x97',
    exp1k === 0x21 && exp470 === 0x47 && exp220 === 0x97,
    `${hex(exp1k)},${hex(exp470)},${hex(exp220)}`);
  check('palette prom 0x01 -> r=0x21',
    r(pal.core[0]!) === exp1k && g(pal.core[0]!) === 0 && b(pal.core[0]!) === 0,
    `r=${hex(r(pal.core[0]!))}`);
  check('palette prom 0x02 -> r=0x47', r(pal.core[1]!) === exp470, `r=${hex(r(pal.core[1]!))}`);
  check('palette prom 0x04 -> r=0x97', r(pal.core[2]!) === exp220, `r=${hex(r(pal.core[2]!))}`);
  check('palette prom 0x08 -> g=0x21', g(pal.core[6]!) === exp1k, `g=${hex(g(pal.core[6]!))}`);
  check('palette prom 0xff -> white',
    r(pal.core[3]!) === 255 && g(pal.core[3]!) === 255 && b(pal.core[3]!) === 255,
    hex(pal.core[3]!));
  check('palette blue weights', b(pal.core[4]!) === bLo && b(pal.core[5]!) === bHi,
    `${b(pal.core[4]!)},${b(pal.core[5]!)} expected ${bLo},${bHi}`);
  check('palette alpha always 0xff', a(pal.core[0]!) === 0xff && a(pal.core[31]!) === 0xff);

  // Sprite transparency: lookup PROM nibble 0 (indirect black) is transparent;
  // any non-zero nibble is opaque (transpen_mask(gfx(1), color, 0)).
  proms[0x020] = 0x00;
  proms[0x021] = 0x01;
  proms[0x022] = 0x10; // & 0x0f == 0 -> transparent
  const pal2 = buildPacmanPalette(proms);
  check('pen transparency from lut nibble 0',
    pal2.penTrans[0] === 1 && pal2.penTrans[1] === 0 && pal2.penTrans[2] === 1);
  check('pen color maps through core palette', pal2.penColor[1] === pal2.core[1]);
}

// ---------------------------------------------------------------------------
// (b) pacman_scan_rows mapper spot checks (pacman_v.cpp:172-179)
{
  // Main window: col 2..33 -> offset (col-2) + (row+2)*32
  check('pacman_scan_rows (2,0) -> 64', pacmanScanRows(2, 0) === 64, `${pacmanScanRows(2, 0)}`);
  check('pacman_scan_rows (33,27) -> 959', pacmanScanRows(33, 27) === 959, `${pacmanScanRows(33, 27)}`);
  // Left wrap columns (top rows on the rotated screen): col 0 -> (col-2)&0x1f = 30, col 1 -> 31
  check('pacman_scan_rows (0,0) -> 962', pacmanScanRows(0, 0) === 2 + (30 << 5), `${pacmanScanRows(0, 0)}`);
  check('pacman_scan_rows (1,27) -> 1021', pacmanScanRows(1, 27) === 29 + (31 << 5), `${pacmanScanRows(1, 27)}`);
  // Right wrap columns: col 34 -> 0, col 35 -> 1
  check('pacman_scan_rows (34,5) -> 7', pacmanScanRows(34, 5) === 7, `${pacmanScanRows(34, 5)}`);
  check('pacman_scan_rows (35,0) -> 34', pacmanScanRows(35, 0) === 34, `${pacmanScanRows(35, 0)}`);

  // Structural: all 36x28 cells map to unique offsets within 0..0x3ff
  const seen = new Set<number>();
  let inRange = true;
  for (let row = 0; row < 28; row++) {
    for (let col = 0; col < 36; col++) {
      const offs = pacmanScanRows(col, row);
      if (offs < 0 || offs > 0x3ff) inRange = false;
      seen.add(offs);
    }
  }
  check('pacman_scan_rows injective over 36x28', seen.size === 36 * 28 && inRange,
    `${seen.size} unique`);
}

// ---------------------------------------------------------------------------
// (c) tile/sprite decode of hand-made patterns through the pacman layouts
{
  // tilelayout: 0x1000 bytes -> 256 chars; byte n bits 0-3 = plane0, 4-7 =
  // plane1; bytes 0..7 cover x=4..7 (rows 0..7), bytes 8..15 cover x=0..3.
  const chars = new Uint8Array(0x1000);
  chars[0] = 0x80; // element 0: plane0 bit at offset 0 -> pixel (4,0) = 2
  chars[8] = 0x88; // offsets 64 (plane0) + 68 (plane1) -> pixel (0,0) = 3
  const charSet = decodeGfx(TILE_LAYOUT, chars);
  check('tilelayout decodes 256 chars', charSet.count === 256, `count=${charSet.count}`);
  check('tilelayout pixel positions',
    charSet.pixels[0 * 8 + 0] === 3 && charSet.pixels[0 * 8 + 4] === 2 &&
    charSet.pixels[0 * 8 + 1] === 0 && charSet.pixels[1 * 8 + 4] === 0,
    `(0,0)=${charSet.pixels[0]} (4,0)=${charSet.pixels[4]}`);

  // spritelayout: 0x1000 bytes -> 64 sprites; xOffsets place bit offset 0 at
  // x=12; yOffsets jump to bit 256 for the lower half (y=8..15).
  const sprites = new Uint8Array(0x1000);
  sprites[0] = 0x80;  // offset 0 -> pixel (12,0) = 2
  sprites[8] = 0x88;  // offsets 64/68 -> pixel (0,0) = 3
  sprites[32] = 0x80; // offset 256 -> pixel (12,8) = 2
  const spriteSet = decodeGfx(SPRITE_LAYOUT, sprites);
  check('spritelayout decodes 64 sprites', spriteSet.count === 64, `count=${spriteSet.count}`);
  check('spritelayout pixel positions',
    spriteSet.pixels[0 * 16 + 12] === 2 && spriteSet.pixels[0 * 16 + 0] === 3 &&
    spriteSet.pixels[8 * 16 + 12] === 2 && spriteSet.pixels[0 * 16 + 13] === 0,
    `(12,0)=${spriteSet.pixels[12]} (0,0)=${spriteSet.pixels[0]} (12,8)=${spriteSet.pixels[8 * 16 + 12]}`);
}

// ---------------------------------------------------------------------------
// (d) PacmanVideo end-to-end structural test
{
  const regions: Record<string, Uint8Array> = {
    gfx1: new Uint8Array(0x2000),
    proms: new Uint8Array(0x120),
  };
  // palette: entry 1 = red 255 (0x07); entry 0 stays black
  regions.proms![1] = 0x07;
  // lookup PROM color 0: pen 1 -> core 1 (red), pen 3 -> core 1 (red);
  // pens 0/2 stay 0 (black tiles / transparent sprite pens)
  regions.proms![0x21] = 0x01;
  regions.proms![0x23] = 0x01;
  // char 1: all pixels pen 1 (plane1 = low nibble of every byte)
  regions.gfx1!.fill(0x0f, 16, 32);
  // sprite 1: all pixels pen 3 (both planes; element 1 = bytes 64..127 of the sprite half)
  regions.gfx1!.fill(0xff, 0x1000 + 64, 0x1000 + 128);

  const videoram = new Uint8Array(0x400);
  const colorram = new Uint8Array(0x400);
  const spriteram = new Uint8Array(0x10);
  const spriteram2 = new Uint8Array(0x10);
  let latch = 0;

  const video = new PacmanVideo({
    regions, videoram, colorram, spriteram, spriteram2, mainlatch: () => latch,
  });
  check('PacmanVideo native size 288x224', video.width === 288 && video.height === 224);

  const frame = new Uint32Array(288 * 224);
  const at = (x: number, y: number): number => frame[y * 288 + x]! >>> 0;
  const pal = buildPacmanPalette(regions.proms!);
  const red = pal.core[1]! >>> 0;
  const black = pal.core[0]! >>> 0;
  check('synthetic palette: core 1 is full red', red === 0xff0000ff, hex(red));

  // --- tilemap: fill with char 1 -> whole frame red (opaque draw) ----------
  videoram.fill(1);
  video.vblank();
  video.render(frame);
  check('tilemap fills the frame (corners red)',
    at(0, 0) === red && at(287, 0) === red && at(0, 223) === red && at(287, 223) === red,
    hex(at(0, 0)));

  // sprite pen-0 transparency: sprite 0 (all pen 0) over the red field
  spriteram[14] = 0; spriteram[15] = 0;
  spriteram2[14] = 81; spriteram2[15] = 172; // sx=100, sy=50
  video.render(frame);
  check('sprite pens with lut==0 are transparent', at(100, 50) === red && at(107, 57) === red);

  // --- sprites over a black tilemap -----------------------------------------
  videoram.fill(0); // char 0 = all pen 0 -> lut 0 -> black (opaque)
  // slot 7 (offs 14, no position hack): sprite 1 at sx=272-172=100, sy=81-31=50
  spriteram[14] = 1 << 2; spriteram[15] = 0;
  spriteram2[14] = 81; spriteram2[15] = 172;
  // slot 0 (offs 0, m_xoffsethack): same sprite at sx=272-132=140, sy=50 -> drawn at 51
  spriteram[0] = 1 << 2; spriteram[1] = 0;
  spriteram2[0] = 81; spriteram2[1] = 132;
  // slot 5 (offs 10): wraparound: sx=272 (clipped), wrap draw at 16; sy=201-31=170
  spriteram[10] = 1 << 2; spriteram[11] = 0;
  spriteram2[10] = 201; spriteram2[11] = 0;
  // slot 4 (offs 8): left clip: sx=272-268=4 -> only x=16..19 visible; sy=131-31=100
  spriteram[8] = 1 << 2; spriteram[9] = 0;
  spriteram2[8] = 131; spriteram2[9] = 268;
  video.render(frame);

  check('sprite pixels at (100,50)..(115,65)', at(100, 50) === red && at(115, 65) === red);
  check('sprite bounded left/right', at(99, 50) === black && at(116, 50) === black);
  check('sprite bounded top/bottom', at(100, 49) === black && at(100, 66) === black);
  check('first-3-slots +1 position quirk (offs 0 draws at sy+1)',
    at(140, 50) === black && at(140, 51) === red && at(140, 66) === red,
    `at50=${hex(at(140, 50))} at51=${hex(at(140, 51))}`);
  check('sprite wraparound at sx-256', at(16, 170) === red && at(31, 185) === red);
  check('sprite clipped at right edge (x>271)', at(272, 170) === black && at(280, 170) === black);
  check('sprite clipped at left edge (x<16)',
    at(15, 100) === black && at(15, 105) === black && at(16, 105) === red && at(19, 105) === red && at(20, 105) === black);

  // --- flip screen (mainlatch Q3) -------------------------------------------
  spriteram.fill(0); spriteram2.fill(0); // park sprites (pen 0 / clipped)
  videoram.fill(0);
  videoram[pacmanScanRows(2, 0)] = 1;   // one red tile at logical (2,0)
  latch = 0;
  video.render(frame);
  check('flip=0: tile (2,0) at pixels (16..23, 0..7)',
    at(16, 0) === red && at(23, 7) === red && at(264, 216) === black);
  latch = 0x08; // Q3 = flipscreen
  video.render(frame);
  check('flip=1: tile mirrored to (264..271, 216..223)',
    at(16, 0) === black && at(264, 216) === red && at(271, 223) === red);

  let opaque = true;
  for (const v of frame) if (((v >>> 24) & 0xff) !== 0xff) { opaque = false; break; }
  check('alpha always 0xff', opaque);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
}
