// Structural self-test for the Pooyan video renderer.
// Run with: node src/runtime/video/pooyan.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.
//
// Ground truth: src/mame/konami/pooyan.cpp (palette, get_bg_tile_info,
// draw_sprites, screen_update, charlayout/spritelayout, screen visarea).
// No real ROMs — all fixtures are synthetic.

import { readFileSync } from 'node:fs';
import { decodeGfx } from '../gfx.ts';
import type { GfxLayout } from '../gfx.ts';
import {
  buildPooyanPalette,
  PooyanVideo,
  POOYAN_CHAR_LAYOUT,
  POOYAN_SPRITE_LAYOUT,
} from './pooyan.ts';

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
// (a) layouts against the knowledge graph (dist/pooyan/graph.json is the
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
      readFileSync(new URL('../../../dist/pooyan/graph.json', import.meta.url), 'utf8'),
    ) as { nodes: GraphNode[] };
    const node = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);

    const charNode = node('gfxlayout:charlayout');
    const sprNode = node('gfxlayout:spritelayout');
    check('graph charlayout matches POOYAN_CHAR_LAYOUT',
      !!charNode && layoutKey(charNode.props as never) === layoutKey(POOYAN_CHAR_LAYOUT as never),
      charNode ? layoutKey(charNode.props as never) : 'node missing');
    check('graph spritelayout matches POOYAN_SPRITE_LAYOUT',
      !!sprNode && layoutKey(sprNode.props as never) === layoutKey(POOYAN_SPRITE_LAYOUT as never),
      sprNode ? layoutKey(sprNode.props as never) : 'node missing');

    const e0 = node('gfxdecode:gfx_pooyan/e0');
    const e1 = node('gfxdecode:gfx_pooyan/e1');
    check('graph decode entries: tiles at color base 0, sprites at 16*16',
      !!e0 && !!e1 &&
      e0.props.region === 'tiles' && e0.props.layout === 'charlayout' && e0.props.colorBase === 0 &&
      e1.props.region === 'sprites' && e1.props.layout === 'spritelayout' && e1.props.colorBase === 256,
      `bases=${String(e0?.props.colorBase)},${String(e1?.props.colorBase)}`);
  } catch {
    console.log('SKIP  graph cross-check (dist/pooyan/graph.json not found)');
  }
}

// ---------------------------------------------------------------------------
// (b) char decode through the real layout, hand-computed patterns.
// charlayout: 4bpp, planes { RGN_FRAC(1,2)+4, RGN_FRAC(1,2)+0, 4, 0 } over a
// 0x2000 region (RGN_FRAC(1,2) = bit 0x8000 = byte 0x1000), 16 bytes/char.
{
  const rom = new Uint8Array(0x2000);
  // char 0 pixel (0,0): plane0 -> byte 0x1000 mask 0x08 (pixel bit 3),
  // plane2 -> byte 0 mask 0x08 (pixel bit 1)  => pen 0b1010 = 10
  rom[0x1000] = 0x08;
  rom[0x0000] = 0x08;
  // char 0 pixel (4,0): xOffset 64 -> byte 8; plane3 mask 0x80 => pen 1
  rom[8] = 0x80;
  // char 0 pixel (0,3): yOffset 24 -> byte 3; plane1 -> byte 0x1003 mask 0x80 => pen 4
  rom[0x1003] = 0x80;
  // char 1 (16 bytes later) pixel (0,0): plane3 -> byte 16 mask 0x80 => pen 1
  rom[16] = 0x80;

  const set = decodeGfx(POOYAN_CHAR_LAYOUT, rom);
  const px = (e: number, x: number, y: number): number => set.pixels[e * 64 + y * 8 + x]!;
  check('char decode: 256 8x8 elements from 0x2000 region (RGN_FRAC(1,2))',
    set.count === 256 && set.width === 8 && set.height === 8, `count=${set.count}`);
  check('char planes split across 0x1000 halves: (0,0) = pen 10',
    px(0, 0, 0) === 10, `pen=${px(0, 0, 0)}`);
  check('char xOffset 64 -> byte 8: (4,0) = pen 1', px(0, 4, 0) === 1);
  check('char yOffset 24 -> byte base+3: (0,3) = pen 4 (plane 1)', px(0, 0, 3) === 4);
  check('char increment 16 bytes: char 1 (0,0) = pen 1, char 0 untouched elsewhere',
    px(1, 0, 0) === 1 && px(0, 1, 0) === 0);
}

// (b2) sprite decode: 16x16, planes { RGN_FRAC(1,2)+4, RGN_FRAC(1,2)+0, 4, 0 }
// over a 0x2000 region, 64 bytes per sprite.
{
  const rom = new Uint8Array(0x2000);
  // sprite 0 pixel (0,0): plane0 -> byte 0x1000 mask 0x08, plane2 -> byte 0
  // mask 0x08 => pen 10
  rom[0x1000] = 0x08;
  rom[0x0000] = 0x08;
  // sprite 0 pixel (8,0): xOffset 128 -> byte 16; plane3 mask 0x80 => pen 1
  rom[16] = 0x80;
  // sprite 0 pixel (0,8): yOffset 256 -> byte 32; plane3 mask 0x80 => pen 1
  rom[32] = 0x80;
  // sprite 1 (64 bytes later) pixel (0,0): plane3 -> byte 64 mask 0x80 => pen 1
  rom[64] = 0x80;

  const set = decodeGfx(POOYAN_SPRITE_LAYOUT, rom);
  const px = (e: number, x: number, y: number): number => set.pixels[e * 256 + y * 16 + x]!;
  check('sprite decode: 64 16x16 elements from 0x2000 region',
    set.count === 64 && set.width === 16 && set.height === 16, `count=${set.count}`);
  check('sprite planes split across 0x1000 halves: (0,0) = pen 10',
    px(0, 0, 0) === 10, `pen=${px(0, 0, 0)}`);
  check('sprite xOffset 128 -> byte 16: (8,0) = pen 1', px(0, 8, 0) === 1);
  check('sprite yOffset 256 -> byte 32: (0,8) = pen 1', px(0, 0, 8) === 1);
  check('sprite increment 64 bytes: sprite 1 (0,0) = pen 1', px(1, 0, 0) === 1);
}

// ---------------------------------------------------------------------------
// (c) palette decode on a synthetic PROM.  Nets (pooyan.cpp:109-116) are the
// same as rocnrope: R/G = 1k/470/220 with a 1 kOhm load, B = 470/220 with a
// 1 kOhm load, autoscaled.  PROM region: palette @0, CHAR lut @0x20 (upper 16
// colors), SPRITE lut @0x120 (lower 16), both masked & 0x0f.
{
  const proms = new Uint8Array(0x220);
  for (let i = 0; i < 8; i++) proms[i] = 1 << i; // one PROM bit per entry
  proms[8] = 0x07;         // core[8] full red
  proms[0x10 + 1] = 0x07;  // core[0x11] RED (upper half, for the char lut)
  proms[0x10 + 2] = 0x38;  // core[0x12] GREEN (upper half)
  const pal = buildPooyanPalette(proms);

  const r = (v: number): number => v & 0xff;
  const g = (v: number): number => (v >>> 8) & 0xff;
  const b = (v: number): number => (v >>> 16) & 0xff;
  const a = (v: number): number => (v >>> 24) & 0xff;

  // Independent expectation: parallel-resistor voltage dividers with the
  // 1 kOhm load folded in, autoscaled by the larger channel sum (identical
  // math to the rocnrope spec — the networks are the same).
  const par = (...rs: number[]): number => 1 / rs.reduce((acc, x) => acc + 1 / x, 0);
  const div = (r0: number, r1: number): number => 255 * (r0 / (r0 + r1));
  const rgRaw = [
    div(par(470, 220, 1000), 1000),
    div(par(1000, 220, 1000), 470),
    div(par(1000, 470, 1000), 220),
  ];
  const bRaw = [div(par(220, 1000), 470), div(par(470, 1000), 220)];
  const sum = (xs: number[]): number => xs.reduce((x, y) => x + y, 0);
  const scale = 255 / Math.max(sum(rgRaw), sum(bRaw));
  const rnd = (x: number): number => Math.floor(x * scale + 0.5);

  check('rg weights (1k load) scale to 33/71/151',
    rnd(rgRaw[0]!) === 33 && rnd(rgRaw[1]!) === 71 && rnd(rgRaw[2]!) === 151,
    `${rnd(rgRaw[0]!)},${rnd(rgRaw[1]!)},${rnd(rgRaw[2]!)}`);
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
  check('palette alpha always 0xff', a(pal.core[0]!) === 0xff && a(pal.core[31]!) === 0xff);

  // the LUT role swap vs rocnrope: chars -> UPPER 16, sprites -> lower 16
  proms.fill(0, 0x20);
  proms[0x20 + 5] = 0xf1;  // char lut: (0xf1 & 0x0f) | 0x10 -> core[0x11] RED
  proms[0x120 + 5] = 0xe8; // sprite lut: 0xe8 & 0x0f -> core[8] red
  const pal2 = buildPooyanPalette(proms);
  check('char lut @0x20 maps into the UPPER 16 indirect colors ((lut & 0x0f) | 0x10)',
    pal2.charColor[5] === pal2.core[0x11] && r(pal2.charColor[5]!) === 255,
    hex(pal2.charColor[5]!));
  check('sprite lut @0x120 maps into the lower 16 indirect colors (lut & 0x0f)',
    pal2.spriteColor[5] === pal2.core[8],
    hex(pal2.spriteColor[5]!));
  check('spriteTransparent = 1 exactly when lut & 0x0f == 0 (0xe8 -> opaque)',
    pal2.spriteTransparent[5] === 0 && pal2.spriteTransparent[0] === 1 && pal2.spriteTransparent[6] === 1);
}

// ---------------------------------------------------------------------------
// (d) PooyanVideo end-to-end on synthetic fixtures.
{
  const tiles = new Uint8Array(0x2000);
  const sprites = new Uint8Array(0x2000);
  const proms = new Uint8Array(0x220);
  const regions: Record<string, Uint8Array> = { tiles, sprites, proms };

  // indirect palette: lower half feeds sprites, upper half feeds chars
  proms[0] = 0x00;        // core[0] black (sprite transparency reference)
  proms[1] = 0x07;        // core[1] RED
  proms[2] = 0x38;        // core[2] GREEN
  proms[3] = 0xc0;        // core[3] BLUE
  proms[0x10 + 0] = 0xff; // core[0x10] WHITE  (char lut entry 0 lands here)
  proms[0x10 + 1] = 0x3f; // core[0x11] YELLOW
  proms[0x10 + 2] = 0xc7; // core[0x12] MAGENTA
  // char lookup (0x20..0x11f): color*16 + pen -> (lut & 0x0f) | 0x10
  proms[0x20 + 0] = 0x00;            // color 0 pen 0 -> core[0x10] WHITE (opaque bg)
  proms[0x20 + 3] = 0x01;            // color 0 pen 3 -> core[0x11] YELLOW
  proms[0x20 + 1 * 16 + 3] = 0x02;   // color 1 pen 3 -> core[0x12] MAGENTA
  // sprite lookup (0x120..0x21f): color*16 + pen -> lut & 0x0f
  proms[0x120 + 1] = 0x02;           // color 0 pen 1 -> GREEN
  proms[0x120 + 2] = 0x03;           // color 0 pen 2 -> BLUE
  proms[0x120 + 5] = 0x10;           // color 0 pen 5 -> & 0x0f = 0: TRANSPARENT
  proms[0x120 + 2 * 16 + 1] = 0x01;  // color 2 pen 1 -> RED
  proms[0x120 + 3 * 16 + 0] = 0x02;  // color 3 pen 0 -> GREEN (pen 0 OPAQUE!)

  const pal = buildPooyanPalette(proms);
  const RED = pal.core[1]! >>> 0;
  const GREEN = pal.core[2]! >>> 0;
  const BLUE = pal.core[3]! >>> 0;
  const WHITE = pal.core[0x10]! >>> 0;
  const YELLOW = pal.core[0x11]! >>> 0;
  const MAGENTA = pal.core[0x12]! >>> 0;
  check('fixture colors are pairwise distinct',
    new Set([RED, GREEN, BLUE, WHITE, YELLOW, MAGENTA]).size === 6);

  // Inverse of decodeGfx's bit addressing, driven by the extracted layouts.
  const regionBits = 0x2000 * 8;
  const resolve = (v: number | string): number => {
    if (typeof v === 'number') return v;
    const m = /^RGN_FRAC\((\d+),(\d+)\)(?:\+(\d+))?$/.exec(v)!;
    return Math.floor((regionBits * Number(m[1])) / Number(m[2])) + (m[3] ? Number(m[3]) : 0);
  };
  function poke(rom: Uint8Array, layout: GfxLayout, elem: number, x: number, y: number,
    pen: number): void {
    for (let p = 0; p < layout.planes; p++) {
      if (((pen >> (layout.planes - 1 - p)) & 1) === 0) continue;
      const off = elem * layout.charIncrement +
        resolve(layout.planeOffsets[p]!) + resolve(layout.yOffsets[y]!) + resolve(layout.xOffsets[x]!);
      rom[off >> 3] = rom[off >> 3]! | (0x80 >> (off & 7));
    }
  }

  // char 1: solid pen 3.  char 2: single pixel (0,0) pen 3.
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) poke(tiles, POOYAN_CHAR_LAYOUT, 1, x, y, 3);
  poke(tiles, POOYAN_CHAR_LAYOUT, 2, 0, 0, 3);

  // sprite 1: column x=0 pen 2, except (0,0) pen 0 (hole); everything else
  // pen 1.  sprite 2: (0,0) pen 5 (LUT-transparent), (1,0) pen 1.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const pen = x === 0 ? (y === 0 ? 0 : 2) : 1;
      if (pen) poke(sprites, POOYAN_SPRITE_LAYOUT, 1, x, y, pen);
    }
  }
  poke(sprites, POOYAN_SPRITE_LAYOUT, 2, 0, 0, 5);
  poke(sprites, POOYAN_SPRITE_LAYOUT, 2, 1, 0, 1);

  const videoram = new Uint8Array(0x400);
  const colorram = new Uint8Array(0x400);
  const spriteram0 = new Uint8Array(0x100);
  const spriteram1 = new Uint8Array(0x100);

  const video = new PooyanVideo({ regions, videoram, colorram, spriteram0, spriteram1 });
  check('PooyanVideo native size 256x224 (pre-rotation; game is ROT90)',
    video.width === 256 && video.height === 224);

  let threw = false;
  try {
    void new PooyanVideo({ regions: { tiles, sprites }, videoram, colorram, spriteram0, spriteram1 });
  } catch {
    threw = true;
  }
  check('missing region throws', threw);

  const fb = new Uint32Array(256 * 224);
  const at = (x: number, y: number): number => fb[y * 256 + x]! >>> 0;
  const render = (): void => { video.vblank(); video.render(fb); };

  // spriteram encoder (pooyan.cpp:221-241): slots live at offs 0x10-0x3e.
  //   sr0[offs] = sx           sr0[offs+1] = code
  //   sr1[offs] = color | (fx ? 0 : 0x40) | (fy ? 0x80 : 0)   <- bit 6 INVERTED
  //   sr1[offs+1] = 240 - (sy + 16)  (sy in fb coords; bitmap y = sy + 16)
  function setSprite(slot: number, o: { x: number; y: number; code: number;
    color?: number; fx?: boolean; fy?: boolean }): void {
    const offs = 0x10 + slot * 2;
    spriteram0[offs] = o.x & 0xff;
    spriteram0[offs + 1] = o.code;
    spriteram1[offs] = (o.color ?? 0) | (o.fx ? 0 : 0x40) | (o.fy ? 0x80 : 0);
    spriteram1[offs + 1] = (240 - (o.y + 16)) & 0xff;
  }

  // --- (d1) tilemap addressing, opaque pen 0, code/color/flip attributes ---
  videoram[2 * 32 + 3] = 1;                              // solid YELLOW tile
  videoram[2 * 32 + 6] = 1; colorram[2 * 32 + 6] = 0x01; // color 1 -> MAGENTA
  videoram[2 * 32 + 7] = 2; colorram[2 * 32 + 7] = 0x40; // tile flip x
  videoram[2 * 32 + 8] = 2; colorram[2 * 32 + 8] = 0x80; // tile flip y (bit 7!)
  videoram[29 * 32 + 31] = 1;                            // bottom-right corner
  videoram[0 * 32 + 10] = 1;                             // rows outside the
  videoram[1 * 32 + 10] = 1;                             // visible window
  videoram[30 * 32 + 10] = 1;                            // (y 16..239) must be
  videoram[31 * 32 + 10] = 1;                            // clipped
  render();

  check('background = char 0 pen 0 drawn OPAQUE through the char lut (not black)',
    at(0, 0) === WHITE && at(200, 100) === WHITE, hex(at(0, 0)));
  check('TILEMAP_SCAN_ROWS: tile (row 2, col 3) -> fb (24..31, 0..7)',
    at(24, 0) === YELLOW && at(31, 7) === YELLOW && at(24, 8) === WHITE && at(33, 0) === WHITE);
  check('tile (row 29, col 31) reaches the bottom-right corner',
    at(248, 216) === YELLOW && at(255, 223) === YELLOW);
  check('tile color = attr & 0x0f through the char lut',
    at(48, 0) === MAGENTA && at(48 + 7, 7) === MAGENTA);
  check('tile flip x (attr bit 6)', at(56 + 7, 0) === YELLOW && at(56, 0) === WHITE);
  check('tile flip y (attr bit 7)', at(64, 7) === YELLOW && at(64, 0) === WHITE);
  {
    let strays = 0;
    for (let y = 0; y < 224; y++) {
      for (let x = 80; x < 88; x++) if (at(x, y) !== WHITE) strays++;
    }
    check('tilemap rows 0,1,30,31 are outside the visible window', strays === 0,
      `strays=${strays}`);
  }

  // --- (d2) sprites ---
  videoram.fill(0); colorram.fill(0); spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1 });
  render();
  check('sprite placement: 16x16 at (sr0[offs], 240 - sr1[offs+1] - 16)',
    at(101, 60) === GREEN && at(115, 75) === GREEN && at(100, 61) === BLUE,
    hex(at(101, 60)));
  check('sprite pen 0 hole with lut[0] == 0 is transparent', at(100, 60) === WHITE);
  check('sprite horizontal bounds', at(99, 60) === WHITE && at(116, 60) === WHITE);
  check('sprite vertical bounds', at(101, 59) === WHITE && at(101, 76) === WHITE);
  check('sx is DIRECT (no 240- mirror): sr0[offs] = 100', spriteram0[0x10] === 100);

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
  check('sprite color = sr1[offs] & 0x0f through the sprite lut',
    at(101, 60) === RED);

  // transparency is the LUT value, not the raw pen
  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 2 });
  render();
  check('sprite pen 5 with lut & 0x0f == 0 is TRANSPARENT (LUT rule, not pen)',
    at(100, 60) === WHITE && at(101, 60) === GREEN);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 0, color: 3 }); // all-pen-0 sprite
  render();
  check('sprite pen 0 with lut & 0x0f != 0 is OPAQUE (transpen_mask(color, 0))',
    at(100, 60) === GREEN && at(115, 75) === GREEN && at(116, 60) === WHITE);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(0, { x: 100, y: 60, code: 1 });           // color 0: pen 1 GREEN
  setSprite(1, { x: 100, y: 60, code: 1, color: 2 }); // color 2: pen 1 RED
  render();
  check('sprite priority: HIGHER spriteram offsets draw on top (ascending loop)',
    at(101, 60) === RED);

  spriteram0.fill(0); spriteram1.fill(0);
  setSprite(23, { x: 200, y: 100, code: 1 }); // offs 0x3e, the last slot
  render();
  check('all 24 sprite slots drawn (offs 0x3e)', at(201, 100) === GREEN);

  // --- (d3) screen flip (mainlatch Q7, inverted; board passes the state) ---
  videoram.fill(0); colorram.fill(0); spriteram0.fill(0); spriteram1.fill(0);
  videoram[2 * 32 + 3] = 2; // pixel (0,0) of tile (2,3)
  setSprite(0, { x: 100, y: 60, code: 1 });
  video.setFlip(true);
  render();
  check('screen flip mirrors the tilemap and inverts per-tile flips',
    at(231, 223) === YELLOW && at(24, 0) === WHITE, hex(at(231, 223)));
  check('screen flip does NOT touch sprites (game flips them in software)',
    at(101, 60) === GREEN && at(100, 61) === BLUE);
  video.setFlip(false);
  render();
  check('flip restored: tile back at (24, 0)', at(24, 0) === YELLOW);

  // --- (d4) smoke: alpha + determinism ---
  videoram[5 * 32 + 5] = 1; colorram[7 * 32 + 7] = 0x41;
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
