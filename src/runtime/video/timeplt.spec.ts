// Structural self-test for the Time Pilot video renderer.
// Run with: node src/runtime/video/timeplt.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.
//
// Ground truth: src/mame/konami/timeplt.cpp (palette, get_tile_info,
// draw_sprites, screen_update, charlayout/spritelayout, screen visarea).
// No real ROMs — all fixtures are synthetic.

import { readFileSync } from 'node:fs';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout } from '../gfx.ts';
import {
  buildTimepltPalette,
  TimepltVideo,
  TIMEPLT_CHAR_LAYOUT,
  TIMEPLT_SPRITE_LAYOUT,
} from './timeplt.ts';

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
// (a) layouts against the knowledge graph (dist/timeplt/graph.json is the
//     generated source of truth; skip gracefully if absent)
{
  interface GraphNode { id: string; label: string; props: Record<string, unknown>; }
  const layoutKey = (l: {
    width: number; height: number; total: number | string; planes: number;
    planeOffsets: unknown[]; xOffsets: unknown[]; yOffsets: unknown[]; charIncrement: number;
  }): string => JSON.stringify(
    [l.width, l.height, l.total, l.planes, l.planeOffsets, l.xOffsets, l.yOffsets, l.charIncrement]);

  try {
    const graph = JSON.parse(
      readFileSync(new URL('../../../dist/timeplt/graph.json', import.meta.url), 'utf8'),
    ) as { nodes: GraphNode[] };
    const node = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);

    const charNode = node('gfxlayout:charlayout');
    const sprNode = node('gfxlayout:spritelayout');
    check('graph charlayout matches TIMEPLT_CHAR_LAYOUT',
      !!charNode && layoutKey(charNode.props as never) === layoutKey(TIMEPLT_CHAR_LAYOUT as never),
      charNode ? layoutKey(charNode.props as never) : 'node missing');
    check('graph spritelayout matches TIMEPLT_SPRITE_LAYOUT',
      !!sprNode && layoutKey(sprNode.props as never) === layoutKey(TIMEPLT_SPRITE_LAYOUT as never),
      sprNode ? layoutKey(sprNode.props as never) : 'node missing');

    const e0 = node('gfxdecode:gfx_timeplt/e0');
    const e1 = node('gfxdecode:gfx_timeplt/e1');
    check('graph decode entries: tiles at color base 0 (32 colors), sprites at 32*4 (64)',
      !!e0 && !!e1 &&
      e0.props.region === 'tiles' && e0.props.layout === 'charlayout' &&
      e0.props.colorBase === 0 && e0.props.colorCount === 32 &&
      e1.props.region === 'sprites' && e1.props.layout === 'spritelayout' &&
      e1.props.colorBase === 128 && e1.props.colorCount === 64,
      `bases=${String(e0?.props.colorBase)},${String(e1?.props.colorBase)}`);
  } catch {
    console.log('SKIP  graph cross-check (dist/timeplt/graph.json not found)');
  }
}

// ---------------------------------------------------------------------------
// (b) char decode through the real layout, hand-computed patterns.
// charlayout: 2bpp, planes { 4, 0 } (nibble-interleaved), 16 bytes/char over
// the whole 0x2000 region (RGN_FRAC(1,1) -> 512 chars).
{
  const rom = new Uint8Array(0x2000);
  // char 0 pixel (0,0): plane0 (MSB) -> bit offset 4 -> byte 0 mask 0x08;
  // plane1 -> bit offset 0 -> byte 0 mask 0x80  => set both: pen 0b11 = 3
  rom[0] = 0x88;
  // char 0 pixel (4,0): xOffset 64 -> byte 8; plane1 mask 0x80 => pen 1
  rom[8] = 0x80;
  // char 0 pixel (0,3): yOffset 24 -> byte 3; plane0 mask 0x08 => pen 2
  rom[3] = 0x08;
  // char 1 (16 bytes later) pixel (0,0): plane1 -> byte 16 mask 0x80 => pen 1
  rom[16] = 0x80;

  const set = decodeGfx(TIMEPLT_CHAR_LAYOUT, rom);
  const px = (e: number, x: number, y: number): number => set.pixels[e * 64 + y * 8 + x]!;
  check('char decode: 512 8x8 elements from 0x2000 region (RGN_FRAC(1,1), 2bpp)',
    set.count === 512 && set.width === 8 && set.height === 8, `count=${set.count}`);
  check('char nibble planes { 4, 0 }: (0,0) = pen 3', px(0, 0, 0) === 3, `pen=${px(0, 0, 0)}`);
  check('char xOffset 64 -> byte 8: (4,0) = pen 1', px(0, 4, 0) === 1);
  check('char yOffset 24 -> byte base+3: (0,3) = pen 2 (plane 0 = MSB)', px(0, 0, 3) === 2);
  check('char increment 16 bytes: char 1 (0,0) = pen 1, char 0 untouched elsewhere',
    px(1, 0, 0) === 1 && px(0, 1, 0) === 0);
}

// (b2) sprite decode: 16x16 2bpp, 64 bytes per sprite, 0x4000 region -> 256.
{
  const rom = new Uint8Array(0x4000);
  rom[0] = 0x88;   // sprite 0 (0,0) pen 3
  rom[16] = 0x80;  // sprite 0 (8,0): xOffset 128 -> byte 16, plane1 => pen 1
  rom[32] = 0x80;  // sprite 0 (0,8): yOffset 256 -> byte 32, plane1 => pen 1
  rom[64] = 0x80;  // sprite 1 (0,0) pen 1

  const set = decodeGfx(TIMEPLT_SPRITE_LAYOUT, rom);
  const px = (e: number, x: number, y: number): number => set.pixels[e * 256 + y * 16 + x]!;
  check('sprite decode: 256 16x16 elements from 0x4000 region',
    set.count === 256 && set.width === 16 && set.height === 16, `count=${set.count}`);
  check('sprite nibble planes: (0,0) = pen 3', px(0, 0, 0) === 3);
  check('sprite xOffset 128 -> byte 16: (8,0) = pen 1', px(0, 8, 0) === 1);
  check('sprite yOffset 256 -> byte 32: (0,8) = pen 1', px(0, 0, 8) === 1);
  check('sprite increment 64 bytes: sprite 1 (0,0) = pen 1', px(1, 0, 0) === 1);
}

// ---------------------------------------------------------------------------
// (c) palette decode on synthetic PROMs (timeplt.cpp:202-247).
// 5 bits/channel with weights 0x19/0x24/0x35/0x40/0x4d (sum 255), split:
//   byte1 (0x20+i): bit1-5 = R bits 0-4, bit6-7 = G bits 0-1
//   byte0 (i):      bit0-2 = G bits 2-4, bit3-7 = B bits 0-4
{
  const proms = new Uint8Array(0x240);
  proms[0x20 + 0] = 0x3e; // R bits 1-5 all set -> R = 255
  proms[0x20 + 1] = 0xc0; // G bits 0-1 -> 0x19 + 0x24 = 0x3d
  proms[1] = 0x07;        //  + G bits 2-4 -> total 255
  proms[2] = 0xf8;        // B bits 0-4 all set -> B = 255
  proms[0x20 + 3] = 0x02; // R bit 0 only -> R = 0x19
  const pal = buildTimepltPalette(proms);

  const r = (v: number): number => v & 0xff;
  const g = (v: number): number => (v >>> 8) & 0xff;
  const b = (v: number): number => (v >>> 16) & 0xff;
  const a = (v: number): number => (v >>> 24) & 0xff;

  check('weights 0x19+0x24+0x35+0x40+0x4d sum to 255',
    0x19 + 0x24 + 0x35 + 0x40 + 0x4d === 255);
  check('R from byte1 bits 1-5: full red 255',
    r(pal.core[0]!) === 255 && g(pal.core[0]!) === 0 && b(pal.core[0]!) === 0,
    hex(pal.core[0]!));
  check('G split across byte1 bits 6-7 + byte0 bits 0-2: full green 255',
    g(pal.core[1]!) === 255 && r(pal.core[1]!) === 0 && b(pal.core[1]!) === 0);
  check('B from byte0 bits 3-7: full blue 255',
    b(pal.core[2]!) === 255 && r(pal.core[2]!) === 0);
  check('single R bit 0 -> 0x19', r(pal.core[3]!) === 0x19, `${r(pal.core[3]!)}`);
  check('palette alpha always 0xff', a(pal.core[0]!) === 0xff && a(pal.core[31]!) === 0xff);

  // lut halves: sprites -> LOWER 16, chars -> UPPER 16
  proms[0x30 + 1] = 0xf8; // core[0x11] = blue (upper half, for chars)
  proms[0x040 + 6] = 0xf0; // sprite lut entry 6: & 0x0f = 0 -> core[0]
  proms[0x040 + 7] = 0x02; // sprite lut entry 7 -> core[2] blue
  proms[0x140 + 6] = 0xf1; // char lut entry 6: (& 0x0f) + 0x10 -> core[0x11] blue
  const pal2 = buildTimepltPalette(proms);
  check('sprite lut @0x040 maps into the LOWER 16 palette entries',
    pal2.spriteColor[7] === pal2.core[2] && pal2.spriteColor[6] === pal2.core[0]);
  check('char lut @0x140 maps into the UPPER 16 palette entries ((lut & 0x0f) + 0x10)',
    pal2.charColor[6] === pal2.core[0x11], hex(pal2.charColor[6]!));
  check('lut tables sized 64x4 sprites / 32x4 chars',
    pal2.spriteColor.length === 256 && pal2.charColor.length === 128);
}

// ---------------------------------------------------------------------------
// (d) TimepltVideo end-to-end on synthetic fixtures.
{
  const tiles = new Uint8Array(0x2000);
  const sprites = new Uint8Array(0x4000);
  const proms = new Uint8Array(0x240);
  const regions: Record<string, Uint8Array> = { tiles, sprites, proms };

  // palette: lower half feeds sprites, upper half feeds chars
  const setCore = (i: number, rgb: 'red' | 'green' | 'blue' | 'white'): void => {
    if (rgb === 'red' || rgb === 'white') proms[0x20 + i] = proms[0x20 + i]! | 0x3e;
    if (rgb === 'green' || rgb === 'white') { proms[0x20 + i] = proms[0x20 + i]! | 0xc0; proms[i] = proms[i]! | 0x07; }
    if (rgb === 'blue' || rgb === 'white') proms[i] = proms[i]! | 0xf8;
  };
  setCore(1, 'red');     // core[1] RED    (sprites)
  setCore(2, 'green');   // core[2] GREEN  (sprites)
  setCore(3, 'blue');    // core[3] BLUE   (sprites)
  setCore(0x10, 'white'); // core[0x10] WHITE (chars: lut 0 -> +0x10)
  setCore(0x11, 'red');  // core[0x11] RED-upper (chars)
  setCore(0x12, 'green'); // core[0x12] GREEN-upper (chars)

  // char lut (0x140+, color*4 + pen)
  proms[0x140 + 0] = 0x00;          // color 0 pen 0 -> core[0x10] WHITE (opaque bg)
  proms[0x140 + 3] = 0x01;          // color 0 pen 3 -> core[0x11] RED-upper
  proms[0x140 + 1 * 4 + 3] = 0x02;  // color 1 pen 3 -> core[0x12] GREEN-upper
  proms[0x140 + 0x10 * 4 + 3] = 0x01; // color 0x10 pen 3 -> REDU (attr bit 4 is
  proms[0x140 + 0x10 * 4 + 0] = 0x00; // BOTH the category flag AND color bit 4)
  // sprite lut (0x040+, color*4 + pen)
  proms[0x040 + 1] = 0x02;          // color 0 pen 1 -> GREEN
  proms[0x040 + 2] = 0x03;          // color 0 pen 2 -> BLUE
  proms[0x040 + 2 * 4 + 1] = 0x01;  // color 2 pen 1 -> RED
  proms[0x040 + 63 * 4 + 1] = 0x01; // color 63 pen 1 -> RED (full 6-bit color range)

  const pal = buildTimepltPalette(proms);
  const RED = pal.core[1]! >>> 0;
  const GREEN = pal.core[2]! >>> 0;
  const BLUE = pal.core[3]! >>> 0;
  const WHITE = pal.core[0x10]! >>> 0;
  const REDU = pal.core[0x11]! >>> 0;
  const GREENU = pal.core[0x12]! >>> 0;
  const BLACK = 0xff000000 >>> 0;
  check('fixture colors are pairwise distinct',
    new Set([RED, GREEN, BLUE, WHITE, BLACK]).size === 5);

  // Inverse of decodeGfx's bit addressing (numeric offsets only here).
  function poke(rom: Uint8Array, layout: GfxLayout, elem: number, x: number, y: number,
    pen: number): void {
    for (let p = 0; p < layout.planes; p++) {
      if (((pen >> (layout.planes - 1 - p)) & 1) === 0) continue;
      const off = elem * layout.charIncrement +
        (layout.planeOffsets[p] as number) + (layout.yOffsets[y] as number) + (layout.xOffsets[x] as number);
      rom[off >> 3] = rom[off >> 3]! | (0x80 >> (off & 7));
    }
  }

  // char 1: solid pen 3.  char 2: single pixel (0,0) pen 3.
  // char 0x101 (= 1 + 8*0x20, the attr-bit-5 bank): single pixel (7,0) pen 3.
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) poke(tiles, TIMEPLT_CHAR_LAYOUT, 1, x, y, 3);
  poke(tiles, TIMEPLT_CHAR_LAYOUT, 2, 0, 0, 3);
  poke(tiles, TIMEPLT_CHAR_LAYOUT, 0x101, 7, 0, 3);

  // sprite 1: column x=0 pen 2, except (0,0) pen 0 (hole); everything else pen 1.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const pen = x === 0 ? (y === 0 ? 0 : 2) : 1;
      if (pen) poke(sprites, TIMEPLT_SPRITE_LAYOUT, 1, x, y, pen);
    }
  }

  const videoram = new Uint8Array(0x400);
  const colorram = new Uint8Array(0x400);
  const spriteram0 = new Uint8Array(0x100);
  const spriteram1 = new Uint8Array(0x100);

  const video = new TimepltVideo({ regions, videoram, colorram, spriteram0, spriteram1 });
  check('TimepltVideo native size 256x224 (pre-rotation; game is ROT90)',
    video.width === 256 && video.height === 224);

  let threw = false;
  try {
    void new TimepltVideo({ regions: { tiles, sprites }, videoram, colorram, spriteram0, spriteram1 });
  } catch {
    threw = true;
  }
  check('missing region throws', threw);

  const fb = new Uint32Array(256 * 224);
  const at = (x: number, y: number): number => fb[y * 256 + x]! >>> 0;
  const render = (): void => { video.vblank(); video.render(fb); };

  // spriteram encoder (timeplt.cpp:347-365): slots live at offs 0x10-0x3e.
  //   sr0[offs] = sx           sr0[offs+1] = code
  //   sr1[offs] = color | (fx ? 0 : 0x40) | (fy ? 0x80 : 0)   <- bit 6 INVERTED
  //   sr1[offs+1] = 241 - (sy + 16)  (sy in fb coords; bitmap y = sy + 16)
  function setSprite(slot: number, o: { x: number; y: number; code: number;
    color?: number; fx?: boolean; fy?: boolean }): void {
    const offs = 0x10 + slot * 2;
    spriteram0[offs] = o.x & 0xff;
    spriteram0[offs + 1] = o.code;
    spriteram1[offs] = (o.color ?? 0) | (o.fx ? 0 : 0x40) | (o.fy ? 0x80 : 0);
    spriteram1[offs + 1] = (241 - (o.y + 16)) & 0xff;
  }

  // --- (d0) video enable gate (mainlatch Q4) ---
  videoram[2 * 32 + 3] = 1;
  render();
  check('video_enable clear -> screen stays black (boot state)',
    at(24, 0) === BLACK && at(200, 100) === BLACK);
  video.setVideoEnable(true);
  render();
  check('video_enable set -> tilemap renders', at(24, 0) === REDU && at(0, 0) === WHITE);

  // --- (d1) tilemap addressing, bank bit, color, flips, clipping ---
  videoram[2 * 32 + 5] = 1; colorram[2 * 32 + 5] = 0x20;  // attr bit 5 -> char +0x100
  videoram[2 * 32 + 6] = 1; colorram[2 * 32 + 6] = 0x01;  // color 1 -> GREEN-upper
  videoram[2 * 32 + 7] = 2; colorram[2 * 32 + 7] = 0x40;  // tile flip x
  videoram[2 * 32 + 8] = 2; colorram[2 * 32 + 8] = 0x80;  // tile flip y
  videoram[29 * 32 + 31] = 1;                             // bottom-right corner
  videoram[0 * 32 + 10] = 1;                              // rows outside the
  videoram[31 * 32 + 10] = 1;                             // visible window
  render();

  check('background = char 0 pen 0 drawn OPAQUE through the char lut (not black)',
    at(0, 0) === WHITE && at(200, 100) === WHITE, hex(at(0, 0)));
  check('TILEMAP_SCAN_ROWS: tile (row 2, col 3) -> fb (24..31, 0..7)',
    at(24, 0) === REDU && at(31, 7) === REDU && at(24, 8) === WHITE);
  check('tile (row 29, col 31) reaches the bottom-right corner',
    at(248, 216) === REDU && at(255, 223) === REDU);
  check('tile code = videoram + 8*(attr & 0x20): bit 5 selects char + 0x100',
    at(40 + 7, 0) === REDU && at(40, 0) === WHITE);
  check('tile color = attr & 0x1f through the char lut',
    at(48, 0) === GREENU && at(48 + 7, 7) === GREENU);
  check('tile flip x (attr bit 6)', at(56 + 7, 0) === REDU && at(56, 0) === WHITE);
  check('tile flip y (attr bit 7)', at(64, 7) === REDU && at(64, 0) === WHITE);
  {
    let strays = 0;
    for (let y = 0; y < 224; y++) {
      for (let x = 80; x < 88; x++) if (at(x, y) !== WHITE) strays++;
    }
    check('tilemap rows 0,31 are outside the visible window', strays === 0,
      `strays=${strays}`);
  }

  // --- (d2) sprites ---
  videoram.fill(0); colorram.fill(0); spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1 });
  render();
  check('sprite placement: 16x16 at (sr0[offs], 241 - sr1[offs+1] - 16)',
    at(101, 60) === GREEN && at(115, 75) === GREEN && at(100, 61) === BLUE,
    hex(at(101, 60)));
  check('sprite RAW pen 0 is transparent (transpen, no LUT rule)', at(100, 60) === WHITE);
  check('sprite horizontal bounds', at(99, 60) === WHITE && at(116, 60) === WHITE);
  check('sprite vertical bounds', at(101, 59) === WHITE && at(101, 76) === WHITE);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, fx: true }); // bit 6 CLEAR = flipped
  render();
  check('sprite flip x when sr1 bit 6 is CLEAR (inverted sense)',
    at(115, 61) === BLUE && at(100, 61) === GREEN && at(115, 60) === WHITE);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, fy: true });
  render();
  check('sprite flip y (sr1 bit 7 SET)',
    at(100, 60) === BLUE && at(100, 75) === WHITE && at(101, 75) === GREEN);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, color: 2 });
  render();
  check('sprite color = sr1[offs] & 0x3f through the sprite lut', at(101, 60) === RED);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, color: 63 });
  render();
  check('sprite color range is 6-bit (color 63 valid)', at(101, 60) === RED);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1, color: 2 }); // color 2: pen 1 RED
  setSprite(1, { x: 100, y: 60, code: 1 });           // color 0: pen 1 GREEN
  render();
  check('sprite priority: LOWER spriteram offsets draw on top (descending loop)',
    at(101, 60) === RED);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(23, { x: 200, y: 100, code: 1 }); // offs 0x3e, the last slot
  render();
  check('all 24 sprite slots drawn (offs 0x3e)', at(201, 100) === GREEN);

  // --- (d3) tile priority: category-1 tiles (attr bit 4) draw OVER sprites ---
  videoram.fill(0); colorram.fill(0); spriteram0.fill(0); spriteram1.fill(0);
  videoram[9 * 32 + 12] = 1; colorram[9 * 32 + 12] = 0x10; // cat 1, covers (96..103, 56..63)
  setSprite(0, { x: 100, y: 60, code: 1 });                 // sprite under it
  render();
  check('category-1 tile draws over the sprite',
    at(101, 60) === REDU, hex(at(101, 60)));
  check('sprite still visible outside the cat-1 tile',
    at(104, 60) === GREEN && at(101, 70) === GREEN);
  check('cat-1 cells are skipped in the bg pass, cat-0 background intact elsewhere',
    at(0, 0) === WHITE);

  // --- (d4) screen flip (mainlatch Q1, inverted; board passes the state) ---
  videoram.fill(0); colorram.fill(0); spriteram0.fill(0); spriteram1.fill(0);
  videoram[2 * 32 + 3] = 2; // pixel (0,0) of tile (2,3)
  setSprite(0, { x: 100, y: 60, code: 1 });
  video.setFlip(true);
  render();
  check('screen flip mirrors the tilemap and inverts per-tile flips',
    at(231, 223) === REDU && at(24, 0) === WHITE, hex(at(231, 223)));
  check('screen flip does NOT touch sprites (game flips them in software)',
    at(101, 60) === GREEN && at(100, 61) === BLUE);
  video.setFlip(false);
  render();
  check('flip restored: tile back at (24, 0)', at(24, 0) === REDU);

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
