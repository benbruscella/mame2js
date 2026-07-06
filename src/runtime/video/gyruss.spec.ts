// Structural self-test for the Gyruss video renderer.
// Run with: node src/runtime/video/gyruss.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.
//
// Ground truth: src/mame/konami/gyruss.cpp (palette, get_tile_info,
// draw_sprites, screen_update) cross-checked against classic MAME 0.121
// src/mame/video/gyruss.c (git 7b77f121862 in the MAME checkout).

import { readFileSync } from 'node:fs';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout } from '../gfx.ts';
import {
  buildGyrussPalette,
  GyrussVideo,
  GYRUSS_CHAR_LAYOUT,
  GYRUSS_SPRITE_LAYOUT,
  GYRUSS_SPRITE_BANK_OFFSETS,
} from './gyruss.ts';

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
// (a) layouts against the knowledge graph (out/gyruss/graph.json is the
//     source of truth; skip gracefully if the generated output is absent)
{
  interface GraphNode { id: string; label: string; props: Record<string, unknown>; }
  const layoutKey = (l: {
    width: number; height: number; total: number | string; planes: number;
    planeOffsets: unknown[]; xOffsets: unknown[]; yOffsets: unknown[]; charIncrement: number;
  }): string => JSON.stringify(
    [l.width, l.height, l.total, l.planes, l.planeOffsets, l.xOffsets, l.yOffsets, l.charIncrement]);

  try {
    const graph = JSON.parse(
      readFileSync(new URL('../../../out/gyruss/graph.json', import.meta.url), 'utf8'),
    ) as { nodes: GraphNode[] };
    const node = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);

    const charNode = node('gfxlayout:charlayout');
    const sprNode = node('gfxlayout:spritelayout');
    check('graph charlayout matches GYRUSS_CHAR_LAYOUT',
      !!charNode && layoutKey(charNode.props as never) === layoutKey(GYRUSS_CHAR_LAYOUT as never),
      charNode ? layoutKey(charNode.props as never) : 'node missing');
    check('graph spritelayout matches GYRUSS_SPRITE_LAYOUT',
      !!sprNode && layoutKey(sprNode.props as never) === layoutKey(GYRUSS_SPRITE_LAYOUT as never),
      sprNode ? layoutKey(sprNode.props as never) : 'node missing');

    const e0 = node('gfxdecode:gfx_gyruss/e0');
    const e1 = node('gfxdecode:gfx_gyruss/e1');
    const e2 = node('gfxdecode:gfx_gyruss/e2');
    check('graph sprite decode entries: region + bank offsets 0/0x10',
      !!e0 && !!e1 &&
      e0.props.region === 'sprites' && e1.props.region === 'sprites' &&
      e0.props.offset === GYRUSS_SPRITE_BANK_OFFSETS[0] &&
      e1.props.offset === GYRUSS_SPRITE_BANK_OFFSETS[1],
      `offsets=${String(e0?.props.offset)},${String(e1?.props.offset)}`);
    check('graph char decode entry: tiles region, charlayout, offset 0',
      !!e2 && e2.props.region === 'tiles' && e2.props.layout === 'charlayout' && e2.props.offset === 0);
  } catch {
    console.log('SKIP  graph cross-check (out/gyruss/graph.json not found)');
  }
}

// ---------------------------------------------------------------------------
// (b) char decode through the real extracted layout, hand-computed patterns.
// charlayout: planes {4,0} (plane 0 = MSB at bit offset 4), x 0-3 then
// byte 8 for x 4-7, one byte per row, 16 bytes per char.
{
  const rom = new Uint8Array(0x2000);
  // char 1 (bytes 16..31), row 0 left half: 0b10100101
  //   bits 0..3 (masks 0x80..0x10) = plane 1 (LSB) of x0..x3 -> 1,0,1,0
  //   bits 4..7 (masks 0x08..0x01) = plane 0 (MSB) of x0..x3 -> 0,1,0,1
  //   pixels x0..x3 = 1,2,1,2
  rom[16] = 0b10100101;
  // char 1 row 0 right half comes from byte 16+8: 0xf0 -> LSB=1111, MSB=0000
  rom[24] = 0xf0;
  // char 1 row 3 (yOffset 24 -> byte 16+3): 0x0f -> LSB=0000, MSB=1111 -> pen 2
  rom[19] = 0x0f;

  const set = decodeGfx(GYRUSS_CHAR_LAYOUT, rom);
  check('char decode: 512 8x8 elements from 0x2000 region',
    set.count === 512 && set.width === 8 && set.height === 8, `count=${set.count}`);
  const px = (e: number, x: number, y: number): number => set.pixels[e * 64 + y * 8 + x]!;
  check('char plane order {4,0}: row0 x0..3 = 1,2,1,2',
    px(1, 0, 0) === 1 && px(1, 1, 0) === 2 && px(1, 2, 0) === 1 && px(1, 3, 0) === 2,
    `${px(1, 0, 0)},${px(1, 1, 0)},${px(1, 2, 0)},${px(1, 3, 0)}`);
  check('char x4..7 come from byte 8+y',
    px(1, 4, 0) === 1 && px(1, 5, 0) === 1 && px(1, 6, 0) === 1 && px(1, 7, 0) === 1 && px(1, 4, 1) === 0);
  check('char yOffsets: row 3 from byte base+3',
    px(1, 0, 3) === 2 && px(1, 3, 3) === 2 && px(1, 0, 2) === 0);
}

// (b2) sprite decode: 4bpp split across the two 0x4000 ROM halves.
// planes {0x4000*8+4, 0x4000*8+0, 4, 0}, 64 bytes per 8x16 element.
{
  const rom = new Uint8Array(0x8000);
  // element 0, pixel (0,0): plane0 -> byte 0x4000 mask 0x08 (pixel bit 3),
  // plane2 -> byte 0 mask 0x08 (pixel bit 1)  => pen 0b1010 = 10
  rom[0x4000] = 0x08;
  rom[0x0000] = 0x08;
  // element 0, pixel (4,0): xOffset 64 -> byte 8; plane3 mask 0x80 => pen 1
  rom[8] = 0x80;
  // element 0, pixel (0,8): yOffset 256 -> byte 32; plane3 mask 0x80 => pen 1
  rom[32] = 0x80;

  const setA = decodeGfx(GYRUSS_SPRITE_LAYOUT, rom);
  const px = (s: typeof setA, e: number, x: number, y: number): number => s.pixels[e * 128 + y * 8 + x]!;
  check('sprite decode: 256 8x16 elements per bank',
    setA.count === 256 && setA.width === 8 && setA.height === 16, `count=${setA.count}`);
  check('sprite planes split across 0x4000 halves: (0,0) = pen 10',
    px(setA, 0, 0, 0) === 10, `pen=${px(setA, 0, 0, 0)}`);
  check('sprite xOffset 64 -> byte 8: (4,0) = pen 1', px(setA, 0, 4, 0) === 1);
  check('sprite yOffset 256 -> byte 32: (0,8) = pen 1', px(setA, 0, 0, 8) === 1);

  // bank B = GFXDECODE_ENTRY offset 0x10: same pattern shifted 16 bytes
  const rom2 = new Uint8Array(0x8000);
  rom2[0x10] = 0x88; // plane3 mask 0x80 (bit0) + plane2 mask 0x08 (bit1) => pen 3
  const setB = decodeGfx(GYRUSS_SPRITE_LAYOUT, rom2.subarray(0x10));
  const setA2 = decodeGfx(GYRUSS_SPRITE_LAYOUT, rom2);
  check('sprite bank B (offset 0x10) decodes independently',
    px(setB, 0, 0, 0) === 3 && px(setA2, 0, 0, 0) === 0,
    `bankB=${px(setB, 0, 0, 0)} bankA=${px(setA2, 0, 0, 0)}`);
}

// ---------------------------------------------------------------------------
// (c) palette decode on a synthetic PROM.  Gyruss nets (gyruss.cpp:186-222):
// R/G = 1k/470/220 with a 470 Ohm pulldown, B = 470/220 with a 470 Ohm
// pulldown, autoscaled.  PROM region: palette @0, SPRITE lut @0x20 (lower 16
// indirect entries), CHAR lut @0x120 ((lut & 0x0f) | 0x10, upper 16).
{
  const proms = new Uint8Array(0x220);
  for (let i = 0; i < 8; i++) proms[i] = 1 << i; // one PROM bit per entry
  proms[8] = 0x07;  // full red
  proms[9] = 0x38;  // full green
  proms[10] = 0xc0; // full blue
  proms[11] = 0xff; // white
  proms[0x20 + 5] = 0xf1;  // sprite lut masks to & 0x0f -> core[1]
  proms[0x120 + 5] = 0xe2; // char lut masks and maps | 0x10 -> core[0x12]
  const pal = buildGyrussPalette(proms);

  const r = (v: number): number => v & 0xff;
  const g = (v: number): number => (v >>> 8) & 0xff;
  const b = (v: number): number => (v >>> 16) & 0xff;
  const a = (v: number): number => (v >>> 24) & 0xff;

  // Independent expectation: parallel-resistor voltage dividers with the
  // 470 Ohm pulldown folded into R0, autoscaled by the larger channel sum.
  const par = (...rs: number[]): number => 1 / rs.reduce((acc, x) => acc + 1 / x, 0);
  const div = (r0: number, r1: number): number => 255 * (r0 / (r0 + r1));
  const rgRaw = [
    div(par(470, 220, 470), 1000),
    div(par(1000, 220, 470), 470),
    div(par(1000, 470, 470), 220),
  ];
  const bRaw = [div(par(220, 470), 470), div(par(470, 470), 220)];
  const sum = (xs: number[]): number => xs.reduce((x, y) => x + y, 0);
  const scale = 255 / Math.max(sum(rgRaw), sum(bRaw));
  const rnd = (x: number): number => Math.floor(x * scale + 0.5);

  check('rg weights (470 pulldown) scale to 33/71/151',
    rnd(rgRaw[0]!) === 33 && rnd(rgRaw[1]!) === 71 && rnd(rgRaw[2]!) === 151,
    `${rnd(rgRaw[0]!)},${rnd(rgRaw[1]!)},${rnd(rgRaw[2]!)}`);
  check('b weights (470 pulldown) scale to 79/168',
    rnd(bRaw[0]!) === 79 && rnd(bRaw[1]!) === 168, `${rnd(bRaw[0]!)},${rnd(bRaw[1]!)}`);

  check('palette red bits 0/1/2',
    r(pal.core[0]!) === rnd(rgRaw[0]!) && r(pal.core[1]!) === rnd(rgRaw[1]!) && r(pal.core[2]!) === rnd(rgRaw[2]!),
    `${r(pal.core[0]!)},${r(pal.core[1]!)},${r(pal.core[2]!)}`);
  check('palette green bits 3/4/5 use the same rg weights',
    g(pal.core[3]!) === rnd(rgRaw[0]!) && g(pal.core[4]!) === rnd(rgRaw[1]!) && g(pal.core[5]!) === rnd(rgRaw[2]!) &&
    r(pal.core[3]!) === 0 && b(pal.core[3]!) === 0);
  check('palette blue bits 6/7',
    b(pal.core[6]!) === rnd(bRaw[0]!) && b(pal.core[7]!) === rnd(bRaw[1]!),
    `${b(pal.core[6]!)},${b(pal.core[7]!)}`);
  check('prom 0x07 -> pure red 255', r(pal.core[8]!) === 255 && g(pal.core[8]!) === 0 && b(pal.core[8]!) === 0);
  check('prom 0x38 -> pure green 255', g(pal.core[9]!) === 255 && r(pal.core[9]!) === 0);
  check('prom 0xc0 -> blue 247 (b net sums below the rg reference)',
    b(pal.core[10]!) === 247 && b(pal.core[10]!) === Math.floor(sum(bRaw) * scale + 0.5),
    `b=${b(pal.core[10]!)}`);
  check('prom 0xff -> 255,255,247',
    r(pal.core[11]!) === 255 && g(pal.core[11]!) === 255 && b(pal.core[11]!) === 247);
  check('palette alpha always 0xff', a(pal.core[0]!) === 0xff && a(pal.core[31]!) === 0xff);

  check('sprite lut @0x20 masks & 0x0f into lower 16 entries',
    pal.spriteColor[5] === pal.core[1] && pal.spriteColor[0] === pal.core[0],
    hex(pal.spriteColor[5]!));
  check('char lut @0x120 maps (lut & 0x0f) | 0x10 into upper 16 entries',
    pal.charColor[5] === pal.core[0x12] && pal.charColor[0] === pal.core[0x10],
    hex(pal.charColor[5]!));
}

// ---------------------------------------------------------------------------
// (d) GyrussVideo end-to-end.  Fixture: distinct colors for background char
// pen 0 (WHITE), char pen 3 (CYAN / MAGENTA per color), sprite pens
// (RED/GREEN/BLUE).
{
  const tiles = new Uint8Array(0x2000);
  const sprites = new Uint8Array(0x8000);
  const proms = new Uint8Array(0x220);
  const regions: Record<string, Uint8Array> = { tiles, sprites, proms };

  // palette PROM
  proms[0] = 0x00; // core[0]    black
  proms[1] = 0x07; // core[1]    RED
  proms[2] = 0x38; // core[2]    GREEN
  proms[3] = 0xc0; // core[3]    BLUE
  proms[0x10] = 0xff; // core[0x10] WHITE
  proms[0x11] = 0xf8; // core[0x11] CYAN
  proms[0x12] = 0xc7; // core[0x12] MAGENTA
  // sprite lookup (0x20..0x11f): color*16 + pen
  proms[0x20 + 1] = 0x01;        // color 0 pen 1 -> RED
  proms[0x20 + 2] = 0x02;        // color 0 pen 2 -> GREEN
  proms[0x20 + 2 * 16 + 1] = 0x03; // color 2 pen 1 -> BLUE
  // char lookup (0x120..0x15f): color*4 + pen
  proms[0x120 + 0] = 0x00;       // color 0 pen 0 -> WHITE (0x00 | 0x10)
  proms[0x120 + 3] = 0x01;       // color 0 pen 3 -> CYAN
  proms[0x120 + 4 + 3] = 0x02;   // color 1 pen 3 -> MAGENTA

  const pal = buildGyrussPalette(proms);
  const WHITE = pal.core[0x10]! >>> 0;
  const CYAN = pal.core[0x11]! >>> 0;
  const MAGENTA = pal.core[0x12]! >>> 0;
  const RED = pal.core[1]! >>> 0;
  const GREEN = pal.core[2]! >>> 0;
  const BLUE = pal.core[3]! >>> 0;
  check('fixture colors are pairwise distinct',
    new Set([WHITE, CYAN, MAGENTA, RED, GREEN, BLUE]).size === 6);

  // Inverse of decodeGfx's bit addressing, driven by the extracted layouts.
  function poke(rom: Uint8Array, layout: GfxLayout, elem: number, x: number, y: number,
    pen: number, byteBase: number = 0): void {
    for (let p = 0; p < layout.planes; p++) {
      if (((pen >> (layout.planes - 1 - p)) & 1) === 0) continue;
      const off = byteBase * 8 + elem * layout.charIncrement +
        (layout.planeOffsets[p] as number) + (layout.yOffsets[y] as number) + (layout.xOffsets[x] as number);
      rom[off >> 3] = rom[off >> 3]! | (0x80 >> (off & 7));
    }
  }

  // char 1: solid pen 3.  char 2: single pixel (0,0) pen 3.  char 258
  // (bank bit): single pixel (7,0) pen 3.
  tiles.fill(0xff, 16, 32);
  poke(tiles, GYRUSS_CHAR_LAYOUT, 2, 0, 0, 3);
  poke(tiles, GYRUSS_CHAR_LAYOUT, 258, 7, 0, 3);

  // sprite bank A element 1: column x=0 pen 2, except (0,0) pen 0 (hole);
  // all other pixels pen 1.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 8; x++) {
      const pen = x === 0 ? (y === 0 ? 0 : 2) : 1;
      if (pen) poke(sprites, GYRUSS_SPRITE_LAYOUT, 1, x, y, pen);
    }
  }
  // sprite bank A element 0x81: pixel (0,0) pen 1 (code-bit-0x20 test)
  poke(sprites, GYRUSS_SPRITE_LAYOUT, 0x81, 0, 0, 1);
  // sprite bank B element 1: pixel (3,2) pen 1
  poke(sprites, GYRUSS_SPRITE_LAYOUT, 1, 3, 2, 1, 0x10);

  const videoram = new Uint8Array(0x400);
  const colorram = new Uint8Array(0x400);
  const spriteram = new Uint8Array(0xc0);

  const video = new GyrussVideo({ regions, videoram, colorram, spriteram });
  check('GyrussVideo native size 256x224 (landscape, pre-ROT90)',
    video.width === 256 && video.height === 224);

  let threw = false;
  try {
    void new GyrussVideo({ regions: { tiles, sprites }, videoram, colorram, spriteram });
  } catch {
    threw = true;
  }
  check('missing region throws', threw);

  const fb = new Uint32Array(256 * 224);
  const at = (x: number, y: number): number => fb[y * 256 + x]! >>> 0;
  const render = (): void => { video.vblank(); video.render(fb); };

  // spriteram entry encoder (gyruss.cpp:287-302):
  //   sr[0]=x  sr[3]=241-y(bitmap)  sr[1]=code<<1|bank
  //   sr[2]=color | codebit8<<?0x20 | (flipx? bit6 CLEAR) | flipy 0x80
  // y here is framebuffer y (bitmap y - 16), so sr[3] = 225 - y.
  function setSprite(slot: number, o: { x: number; y: number; code: number;
    bank?: number; color?: number; fx?: boolean; fy?: boolean }): void {
    const offs = slot * 4;
    spriteram[offs] = o.x;
    spriteram[offs + 3] = 225 - o.y;
    spriteram[offs + 1] = ((o.code & 0x7f) << 1) | (o.bank ?? 0);
    spriteram[offs + 2] = (o.color ?? 0) | ((o.code & 0x80) ? 0x20 : 0) |
      (o.fx ? 0 : 0x40) | (o.fy ? 0x80 : 0);
  }

  // --- (d1) tilemap addressing, opaque pen 0, bank/color/flip attributes ---
  videoram[2 * 32 + 3] = 1;                            // solid CYAN tile
  videoram[2 * 32 + 4] = 2;                            // pixel (0,0)
  videoram[2 * 32 + 5] = 2; colorram[2 * 32 + 5] = 0x20; // bank bit -> char 258
  videoram[2 * 32 + 6] = 1; colorram[2 * 32 + 6] = 0x01; // color 1 -> MAGENTA
  videoram[2 * 32 + 7] = 2; colorram[2 * 32 + 7] = 0x40; // tile flip x
  videoram[2 * 32 + 8] = 2; colorram[2 * 32 + 8] = 0x80; // tile flip y
  videoram[29 * 32 + 31] = 1;                          // bottom-right corner
  videoram[0 * 32 + 10] = 1;                           // rows outside the
  videoram[1 * 32 + 10] = 1;                           // visible window
  videoram[30 * 32 + 10] = 1;                          // (y 16..239) must be
  videoram[31 * 32 + 10] = 1;                          // clipped
  render();

  check('background = char 0 pen 0 drawn OPAQUE through the char lut (not black)',
    at(0, 0) === WHITE && at(200, 100) === WHITE, hex(at(0, 0)));
  check('TILEMAP_SCAN_ROWS: tile (row 2, col 3) -> fb (24..31, 0..7)',
    at(24, 0) === CYAN && at(31, 7) === CYAN && at(24, 8) === WHITE && at(32 + 1, 0) === WHITE);
  check('tile (row 29, col 31) reaches the bottom-right corner',
    at(248, 216) === CYAN && at(255, 223) === CYAN);
  check('char code bit: colorram 0x20 selects char | 0x100',
    at(32, 0) === CYAN && at(40 + 7, 0) === CYAN && at(40, 0) === WHITE);
  check('char color = colorram & 0x0f through the char lut',
    at(48, 0) === MAGENTA && at(48 + 7, 7) === MAGENTA);
  check('tile flip x (colorram bit 6)', at(56 + 7, 0) === CYAN && at(56, 0) === WHITE);
  check('tile flip y (colorram bit 7)', at(64, 7) === CYAN && at(64, 0) === WHITE);
  {
    let strays = 0;
    for (let y = 0; y < 224; y++) {
      for (let x = 80; x < 88; x++) if (at(x, y) !== WHITE) strays++;
    }
    check('tilemap rows 0,1,30,31 are outside the visible window', strays === 0,
      `strays=${strays}`);
  }

  // --- (d2) sprites ---
  videoram.fill(0); colorram.fill(0); spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1 });
  render();
  check('sprite placement: 8x16 at (x, 225 - sr[3])',
    at(101, 60) === RED && at(107, 75) === RED && at(100, 61) === GREEN);
  check('sprite pen 0 is transparent (raw pen, not lut)', at(100, 60) === WHITE);
  check('sprite horizontal bounds', at(99, 60) === WHITE && at(108, 60) === WHITE);
  check('sprite vertical bounds', at(101, 59) === WHITE && at(101, 76) === WHITE);

  spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, fx: true }); // bit 6 CLEAR = flipped
  render();
  check('sprite flip x when sr[2] bit 6 is CLEAR',
    at(107, 61) === GREEN && at(100, 61) === RED && at(107, 60) === WHITE);

  spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, fy: true });
  render();
  check('sprite flip y (sr[2] bit 7)',
    at(100, 60) === GREEN && at(100, 75) === WHITE && at(101, 75) === RED);

  spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, bank: 1 });
  render();
  check('gfx bank (sr[1] bit 0) selects the offset-0x10 sprite set',
    at(103, 62) === RED && at(100, 61) === WHITE && at(101, 60) === WHITE);

  spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 0x81 });
  render();
  check('sprite code bit 8 from sr[2] bit 0x20',
    at(100, 60) === RED && at(101, 60) === WHITE);

  spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, color: 2 });
  render();
  check('sprite color = sr[2] & 0x0f through the sprite lut',
    at(101, 60) === BLUE);

  spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1 });          // color 0: pen 1 RED
  setSprite(1, { x: 100, y: 60, code: 1, color: 2 }); // color 2: pen 1 BLUE
  render();
  check('sprite priority: lower spriteram offsets draw on top',
    at(101, 60) === RED);

  spriteram.fill(0);
  setSprite(47, { x: 200, y: 100, code: 1 }); // offs 0xbc, the last slot
  render();
  check('all 48 sprite slots drawn (offs 0xbc)', at(201, 100) === RED);

  // --- (d3) tile-over-sprite priority (colorram bit 0x10) ---
  videoram.fill(0); colorram.fill(0); spriteram.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1 });
  videoram[9 * 32 + 12] = 1; // solid CYAN tile at fb (96..103, 56..63)
  render();
  check('non-priority tile drawn behind sprites',
    at(101, 61) === RED && at(97, 57) === CYAN);
  colorram[9 * 32 + 12] = 0x10;
  render();
  check('priority tile (colorram bit 0x10) redrawn opaque over sprites',
    at(101, 61) === CYAN && at(103, 63) === CYAN);
  videoram[9 * 32 + 12] = 0; // char 0 = all pen 0, still priority
  render();
  check('priority tile covers sprites even with pen 0 (transmask 0x00)',
    at(101, 61) === WHITE && at(102, 62) === WHITE);

  // --- (d4) screen flip (mainlatch Q5) ---
  videoram.fill(0); colorram.fill(0); spriteram.fill(0);
  videoram[2 * 32 + 3] = 2; // pixel (0,0) of tile (2,3)
  setSprite(0, { x: 100, y: 60, code: 1 });
  video.setFlip(true);
  render();
  check('screen flip mirrors the tilemap and inverts per-tile flips',
    at(231, 223) === CYAN && at(24, 0) === WHITE, hex(at(231, 223)));
  check('screen flip does NOT touch sprites (game flips them in software)',
    at(101, 60) === RED && at(100, 61) === GREEN);
  video.setFlip(false);
  render();
  check('flip restored: tile back at (24, 0)', at(24, 0) === CYAN);

  // --- (d5) smoke: alpha + determinism ---
  videoram[5 * 32 + 5] = 1; colorram[7 * 32 + 7] = 0x51;
  setSprite(3, { x: 30, y: 30, code: 1, color: 2, fx: true, fy: true });
  render();
  let opaque = true;
  for (const v of fb) if (((v >>> 24) & 0xff) !== 0xff) { opaque = false; break; }
  check('alpha always 0xff', opaque);

  const fb2 = new Uint32Array(256 * 224);
  video.vblank();
  video.render(fb2);
  let same = true;
  for (let i = 0; i < fb.length; i++) if (fb[i] !== fb2[i]) { same = false; break; }
  check('render is deterministic', same);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exitCode = 1;
}
