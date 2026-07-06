// Structural self-test for the Irem M52 (Moon Patrol) video renderer.
// Run with: node src/runtime/video/m52.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.
//
// Expectations are derived independently from MAME src/mame/irem/m52.cpp:
// palette math from the resistor networks (init_palette :164-224,
// init_sprite_palette :226-255), layouts from the driver/graph
// (spritelayout :863-872, bgcharlayout :874-910, gfx_8x8x2_planar), geometry
// from screen_update/draw_background/draw_sprites/scroll_w and the tilemap
// core semantics (dx=127/dy=16, rowscroll quarters, visible 136..375 x
// 22..273 -> native 240x252).

import type { Regions } from '../types.ts';
import { decodeGfx } from '../gfx.ts';
import {
  M52Video,
  buildM52Palette,
  buildBgLayout,
  TX_LAYOUT,
  SPRITE_LAYOUT,
  BG_PEN_MAP,
} from './m52.ts';
import type { M52VideoDeps } from './m52.ts';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  checks++;
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    failures++;
  }
}

const hex = (v: number): string => '0x' + (v >>> 0).toString(16);
const BLACK = 0xff000000;
const W = 240;
const H = 252;

const cr = (v: number): number => v & 0xff;
const cg = (v: number): number => (v >>> 8) & 0xff;
const cb = (v: number): number => (v >>> 16) & 0xff;
const ca = (v: number): number => (v >>> 24) & 0xff;
const rgb = (r: number, g: number, b: number): number =>
  (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

function makeRegions(): Regions {
  const regions: Regions = {
    tx: new Uint8Array(0x2000),
    sp: new Uint8Array(0x3000),
    bg0: new Uint8Array(0x2000),
    bg1: new Uint8Array(0x2000),
    bg2: new Uint8Array(0x2000),
    tx_pal: new Uint8Array(0x200),
    bg_pal: new Uint8Array(0x20),
    spr_pal: new Uint8Array(0x20),
    spr_clut: new Uint8Array(0x100),
  };
  // ROMREGION_ERASEFF upper half of each bg strip region (m52.cpp:1008-1016)
  regions['bg0'].fill(0xff, 0x1000);
  regions['bg1'].fill(0xff, 0x1000);
  regions['bg2'].fill(0xff, 0x1000);
  return regions;
}

interface TestState {
  scroll: number;
  bgx0: number; bgy0: number;
  bgx1: number; bgy1: number;
  bgc: number;
  flip: boolean;
}

function makeState(): TestState {
  // bgcontrol 0xff = bit 0x20 set = all background strips disabled
  return { scroll: 0, bgx0: 0, bgy0: 0, bgx1: 0, bgy1: 0, bgc: 0xff, flip: false };
}

interface Rig {
  video: M52Video;
  videoram: Uint8Array;
  colorram: Uint8Array;
  spriteram: Uint8Array;
  fb: Uint32Array;
  px: (x: number, y: number) => number;
  render: () => void;
}

function makeRig(regions: Regions, st: TestState): Rig {
  const videoram = new Uint8Array(0x400);
  const colorram = new Uint8Array(0x400);
  const spriteram = new Uint8Array(0x100);
  const deps: M52VideoDeps = {
    regions, videoram, colorram, spriteram,
    scroll: () => st.scroll,
    bgxpos0: () => st.bgx0,
    bgypos0: () => st.bgy0,
    bgxpos1: () => st.bgx1,
    bgypos1: () => st.bgy1,
    bgcontrol: () => st.bgc,
    flip: () => st.flip,
  };
  const video = new M52Video(deps);
  const fb = new Uint32Array(W * H);
  return {
    video, videoram, colorram, spriteram, fb,
    px: (x, y) => fb[y * W + x],
    render: () => video.render(fb),
  };
}

// ---------------------------------------------------------------------------
// (A) palettes — expectations computed independently from the resistor
// networks of init_palette / init_sprite_palette (m52.cpp:164-255).
{
  const regions = makeRegions();
  const txp = regions['tx_pal'];
  txp[1] = 0x01; txp[2] = 0x02; txp[3] = 0x04; txp[4] = 0x07; txp[5] = 0x38;
  txp[6] = 0x40; txp[7] = 0x80; txp[8] = 0xc0; txp[9] = 0xff;
  const bgp = regions['bg_pal'];
  bgp[0] = 0x01; bgp[1] = 0x02; bgp[2] = 0x04; bgp[3] = 0x07; bgp[4] = 0x07;
  bgp[8] = 0x38; bgp[12] = 0xc0; bgp[17] = 0x38; bgp[18] = 0xc0; bgp[19] = 0xff;
  const spp = regions['spr_pal'];
  spp[1] = 0x40; spp[2] = 0x80; spp[3] = 0xc0; spp[4] = 0x38; spp[5] = 0x07;
  const clut = regions['spr_clut'];
  for (let i = 0; i < 0x100; i++) clut[i] = (i * 7 + 3) & 0x1f;

  const pal = buildM52Palette(regions);

  // resistor math: R/G = 1k/470/220, B = 470/220, no pulldown, autoscale 255
  const par = (...rs: number[]): number => 1 / rs.reduce((s, x) => s + 1 / x, 0);
  const t1k = 255 * (par(470, 220) / (par(470, 220) + 1000));
  const t470 = 255 * (par(1000, 220) / (par(1000, 220) + 470));
  const t220 = 255 * (par(1000, 470) / (par(1000, 470) + 220));
  const tb470 = 255 * (220 / (220 + 470));
  const tb220 = 255 * (470 / (470 + 220));
  const scale = 255 / Math.max(t1k + t470 + t220, tb470 + tb220);
  const f = (v: number): number => Math.floor(v * scale + 0.5);

  check('A1 tx weights match resnet (1k/470/220 = 33/71/151)',
    f(t1k) === 33 && f(t470) === 71 && f(t220) === 151,
    `${f(t1k)},${f(t470)},${f(t220)}`);
  check('A2 tx PROM bit0/1/2 -> red weights',
    cr(pal.txPens[1]) === f(t1k) && cr(pal.txPens[2]) === f(t470) && cr(pal.txPens[3]) === f(t220),
    `${cr(pal.txPens[1])},${cr(pal.txPens[2])},${cr(pal.txPens[3])}`);
  check('A3 tx PROM 0x07 -> full red 255, no g/b',
    pal.txPens[4] === rgb(255, 0, 0), hex(pal.txPens[4]));
  check('A4 tx PROM 0x38 -> full green 255', pal.txPens[5] === rgb(0, 255, 0), hex(pal.txPens[5]));
  check('A5 tx PROM blue bits 6/7 -> 81/174, full 255',
    cb(pal.txPens[6]) === 81 && cb(pal.txPens[7]) === 174 && cb(pal.txPens[8]) === 255,
    `${cb(pal.txPens[6])},${cb(pal.txPens[7])},${cb(pal.txPens[8])}`);
  check('A6 tx PROM 0xff -> white', pal.txPens[9] === 0xffffffff, hex(pal.txPens[9]));
  check('A7 tx palette has 512 pens, alpha 0xff',
    pal.txPens.length === 512 && ca(pal.txPens[0]) === 0xff && ca(pal.txPens[9]) === 0xff);

  // bg pens are indirected through the hard-wired map (m52.cpp:210-221)
  let bgMapOk = true;
  for (let i = 0; i < 12; i++) {
    if (pal.bgPens[i] !== pal.bgIndirect[BG_PEN_MAP[i]]) bgMapOk = false;
  }
  check('A8 bg pen->indirect map [0,4,8,12|0,1,2,3|0,17,18,19]', bgMapOk);
  check('A9 bg strip palettes independent (mountains pen3=blue, hills pen1=r71, city pen1=green)',
    pal.bgPens[3] === rgb(0, 0, 255) && cr(pal.bgPens[5]) === 71 && pal.bgPens[9] === rgb(0, 255, 0),
    `${hex(pal.bgPens[3])},${hex(pal.bgPens[5])},${hex(pal.bgPens[9])}`);

  // sprite nets: 470 Ohm pulldown, R = bits 6,7 via the 2-resistor net,
  // B = bits 0-2 via the 3-resistor net, tx autoscale factor reused
  const s470 = 255 * (par(220, 470) / (par(220, 470) + 470));
  const s220 = 255 * (par(470, 470) / (par(470, 470) + 220));
  const sg1k = 255 * (par(470, 220, 470) / (par(470, 220, 470) + 1000));
  const sg470 = 255 * (par(1000, 220, 470) / (par(1000, 220, 470) + 470));
  const sg220 = 255 * (par(1000, 470, 470) / (par(1000, 470, 470) + 220));
  check('A10 sprite red bits 6/7 -> 62/132/193 (2-resistor net + pulldown)',
    cr(pal.spIndirect[1]) === f(s470) && cr(pal.spIndirect[2]) === f(s220) &&
    cr(pal.spIndirect[3]) === Math.floor((s470 + s220) * scale + 0.5) &&
    f(s470) === 62 && f(s220) === 132,
    `${cr(pal.spIndirect[1])},${cr(pal.spIndirect[2])},${cr(pal.spIndirect[3])}`);
  check('A11 sprite green 0x38 / blue 0x07 -> 200 (pulled-down net, tx scale reused)',
    cg(pal.spIndirect[4]) === Math.floor((sg1k + sg470 + sg220) * scale + 0.5) &&
    cg(pal.spIndirect[4]) === 200 && cb(pal.spIndirect[5]) === 200,
    `g=${cg(pal.spIndirect[4])} b=${cb(pal.spIndirect[5])}`);
  let clutOk = true;
  for (let i = 0; i < 0x100; i += 17) {
    if (pal.spPens[i] !== pal.spIndirect[clut[i] & 0x1f]) clutOk = false;
  }
  check('A12 sprite pens resolve through spr_clut into the 32 indirect colors', clutOk);
}

// ---------------------------------------------------------------------------
// (B) gfx decode via the graph layouts
{
  const regions = makeRegions();
  const tx = regions['tx'];
  // char 1 row 0: LSB plane (first half) 0xf0, MSB plane (second half,
  // gfx_8x8x2_planar plane 0 = RGN_FRAC(1,2)) 0x0f -> pixels 1,1,1,1,2,2,2,2
  tx[8] = 0xf0;
  tx[0x1000 + 8] = 0x0f;
  const chars = decodeGfx(TX_LAYOUT, tx);
  check('B1 tx decode: 512 8x8 chars', chars.count === 512 && chars.width === 8,
    `count=${chars.count}`);
  const row0 = Array.from(chars.pixels.slice(64, 72)).join(',');
  check('B2 tx planes: MSB from second region half', row0 === '1,1,1,1,2,2,2,2', row0);

  const sp = regions['sp'];
  // sprite 2 row 0: bit1 plane (RGN_FRAC(0,3)) 0xff, bit0 plane
  // (RGN_FRAC(1,3)) 0x0f, bit2 plane (RGN_FRAC(2,3)) 0x80
  sp[64] = 0xff;
  sp[0x1000 + 64] = 0x0f;
  sp[0x2000 + 64] = 0x80;
  sp[64 + 16] = 0x80; // right half (x offsets 128..135): pixel (8,0) = pen 2
  const sprites = decodeGfx(SPRITE_LAYOUT, sp);
  check('B3 sprite decode: 128 16x16 elements (RGN_FRAC(1,3))',
    sprites.count === 128 && sprites.width === 16, `count=${sprites.count}`);
  const srow = Array.from(sprites.pixels.slice(2 * 256, 2 * 256 + 8)).join(',');
  check('B4 sprite plane order 2/0/1 (third region = pixel bit 2)',
    srow === '6,2,2,2,3,3,3,3', srow);
  check('B5 sprite right half from bit offset 128 (byte +16)',
    sprites.pixels[2 * 256 + 8] === 2, `${sprites.pixels[2 * 256 + 8]}`);

  const bg = regions['bg0'];
  bg[0] = 0x88;     // pixel (0,0): LSB bit7, MSB bit3 -> pen 3
  bg[1] = 0x44;     // pixel (5,0): pen 3 (next 4-pixel byte)
  bg[0x800] = 0x88; // row 32 lives 0x4000 bits in (STEP32 banks)
  const bgGfx = decodeGfx(buildBgLayout(), bg);
  check('B6 bg strip: one 256x128 image',
    bgGfx.count === 1 && bgGfx.width === 256 && bgGfx.height === 128);
  check('B7 bg nibble packing (upper=LSBs, lower=MSBs)',
    bgGfx.pixels[0] === 3 && bgGfx.pixels[1] === 0 && bgGfx.pixels[5] === 3,
    `${bgGfx.pixels[0]},${bgGfx.pixels[1]},${bgGfx.pixels[5]}`);
  check('B8 bg row banking: row 32 from byte 0x800', bgGfx.pixels[32 * 256] === 3);
  check('B9 bg rows 64..127 = pen 3 (0xff ERASEFF fill)',
    bgGfx.pixels[64 * 256] === 3 && bgGfx.pixels[127 * 256 + 255] === 3);
}

// ---------------------------------------------------------------------------
// (C) tx tilemap addressing, scroll quarters, wrap
// Geometry: static quarters land at srcX = (fbx+8)&255, srcY = (fby+6)&255
// (dx=127 vs rowscroll 255 -> effective 128; dy=16; visible origin 136,22).
// Tile (row,col) pixel(0,0) -> fb (col*8-8, row*8-6).
{
  const regions = makeRegions();
  regions['tx'][8] = 0x80; // char 1 pixel (0,0) = pen 1
  regions['tx'][0x800] = 0x80; // char 0x100 pixel (0,0) = pen 1
  const RED = rgb(255, 0, 0);
  const GREEN = rgb(0, 255, 0);
  regions['tx_pal'][1] = 0x07;      // color 0 pen 1 -> red
  regions['tx_pal'][13] = 0x38;     // color 3 pen 1 -> green
  const st = makeState();
  const rig = makeRig(regions, st);

  rig.videoram[10 * 32 + 5] = 1;             // tile (10,5) char 1
  rig.videoram[14 * 32 + 6] = 1;             // tile (14,6) char 1, color 3
  rig.colorram[14 * 32 + 6] = 3;
  rig.colorram[12 * 32 + 8] = 0x80;          // tile (12,8): code bit 8 only
  rig.videoram[24 * 32 + 5] = 1;             // tile (24,5): scrolled quarter
  rig.videoram[24 * 32 + 29] = 1;            // tile (24,29): scroll wrap
  rig.render();

  check('C1 tile (10,5) pixel(0,0) at fb (32,74) [scrolldx 127 / scrolldy 16]',
    rig.px(32, 74) === RED, hex(rig.px(32, 74)));
  check('C2 neighbours transparent (pen 0)', rig.px(33, 74) === BLACK && rig.px(32, 75) === BLACK);
  check('C3 colorram bit7 = tile code bit 8', rig.px(56, 90) === RED, hex(rig.px(56, 90)));
  check('C4 colorram bits 0-6 select the 4-pen color group',
    rig.px(40, 106) === GREEN, hex(rig.px(40, 106)));
  check('C5 bottom quarter unscrolled matches static quarters (scroll=0)',
    rig.px(32, 186) === RED, hex(rig.px(32, 186)));

  st.scroll = 5;
  rig.render();
  check('C6 scroll_w shifts ONLY tile rows 24-31 (row 3 of 4 quarters)',
    rig.px(37, 186) === RED && rig.px(32, 186) === BLACK && rig.px(32, 74) === RED,
    hex(rig.px(37, 186)));

  st.scroll = 40;
  rig.render();
  check('C7 scrolled quarter wraps mod 256 (col 29 + 40px -> fbx 8)',
    rig.px(8, 186) === RED, hex(rig.px(8, 186)));

  st.scroll = 0;
  rig.render();
  // TILE_FORCE_LAYER0: tile rows 0..6 are opaque (srcY<=55 -> fby<=49)
  check('C8 tile rows 0-6 opaque: pen 0 drawn as txPens[0]',
    rig.px(100, 45) === BLACK && rig.px(100, 49) === BLACK); // txPens[0] = black here
  // bottom two visible lines wrap back to tile row 0 (vtotal instance at 272)
  rig.videoram[0 * 32 + 5] = 1; // tile (0,5) pixel(0,0): srcY 0 -> sy 272 -> fby 250
  rig.render();
  check('C9 vertical wrap: tile row 0 reappears at fby 250',
    rig.px(32, 250) === RED, hex(rig.px(32, 250)));
}

// distinguishing opaque rows from the fill needs a non-black fill color
{
  const regions = makeRegions();
  regions['spr_clut'][0] = 1;
  regions['spr_pal'][1] = 0x38; // fill = sp pen 0 = indirect 1 = green 200
  const FILL = rgb(0, 200, 0);
  const st = makeState();
  const rig = makeRig(regions, st);
  rig.render();
  check('C10 screen base fill = sprite pen 0 (spIndirect[clut[0]])',
    rig.px(100, 60) === FILL && rig.px(0, 249) === FILL, hex(rig.px(100, 60)));
  check('C11 opaque tx rows cover the fill only for tile rows 0-6',
    rig.px(100, 49) === BLACK && rig.px(100, 50) === FILL,
    `${hex(rig.px(100, 49))},${hex(rig.px(100, 50))}`);
  check('C12 wrapped tile row 0 opaque at the bottom two lines',
    rig.px(100, 250) === BLACK && rig.px(100, 251) === BLACK && rig.px(100, 249) === FILL);
}

// ---------------------------------------------------------------------------
// (D) background strips: position, control bits, wrap, fills
// Geometry: strip pixel (c,r) -> fb (bgx + c - 12, bgy + r - 6) (xpos =
// bgx+124, ypos = bgy+16, visible origin 136,22).
{
  const regions = makeRegions();
  regions['bg0'][0] = 0x88;  // mountains pixel (0,0) pen 3
  regions['bg0'][7] = 0x22;  // mountains pixel (30,0) pen 3
  regions['bg1'][0] = 0x80;  // hills pixel (0,0) pen 1
  regions['bg2'][0] = 0x08;  // city pixel (0,0) pen 2
  regions['bg_pal'][12] = 0x07; // mountains pen 3 -> red    (map 0*4+3 -> 12)
  regions['bg_pal'][1] = 0x38;  // hills pen 1 -> green      (map 1*4+1 -> 1)
  regions['bg_pal'][18] = 0xc0; // city pen 2 -> blue        (map 2*4+2 -> 16+2)
  const RED = rgb(255, 0, 0);
  const GREEN = rgb(0, 255, 0);
  const BLUE = rgb(0, 0, 255);
  const st = makeState();
  st.bgx1 = 20; st.bgy1 = 60;  // mountains regs (#1): pixel(0,0) at (8,54)
  st.bgx0 = 40; st.bgy0 = 80;  // hills/city regs (#0): pixel(0,0) at (28,74)
  const rig = makeRig(regions, st);

  st.bgc = 0x00;
  rig.render();
  check('D1 mountains (bg0) at bgxpos1/bgypos1: pixel(0,0) -> fb (8,54)',
    rig.px(8, 54) === RED, hex(rig.px(8, 54)));
  check('D2 hills (bg1) at bgxpos0/bgypos0: pixel(0,0) -> fb (28,74)',
    rig.px(28, 74) === GREEN, hex(rig.px(28, 74)));
  check('D3 bg pen 0 transparent (fill shows through next to strip pixels)',
    rig.px(9, 54) === BLACK, hex(rig.px(9, 54)));

  st.bgc = 0x10;
  rig.render();
  check('D4 bgcontrol bit4 disables the mountains only',
    rig.px(8, 54) === BLACK && rig.px(28, 74) === GREEN);

  st.bgc = 0x02;
  rig.render();
  check('D5 bgcontrol bit1 swaps hills for the cityscape (bg2)',
    rig.px(28, 74) === BLUE, hex(rig.px(28, 74)));

  st.bgc = 0x02 | 0x04;
  rig.render();
  check('D6 bgcontrol bits 1+2 disable both hills and city',
    rig.px(28, 74) === BLACK, hex(rig.px(28, 74)));

  st.bgc = 0x20;
  rig.render();
  check('D7 bgcontrol bit5 disables all strips',
    rig.px(8, 54) === BLACK && rig.px(28, 74) === BLACK);

  st.bgc = 0x06; // mountains only
  rig.render();
  check('D8 0xff-filled strip rows 64-127 render as solid pen 3',
    rig.px(100, 150) === RED, hex(rig.px(100, 150))); // row 96 of the image
  check('D9 solid pen-3 fill continues 128 rows below the strip (do_bg_fills)',
    rig.px(100, 200) === RED && rig.px(5, 245) === RED, hex(rig.px(100, 200)));
  check('D10 nothing above the strip', rig.px(100, 52) === BLACK, hex(rig.px(100, 52)));

  st.bgx1 = 250;
  rig.render();
  check('D11 strip wraps horizontally mod 256 (drawn at xpos and xpos-256)',
    rig.px(238, 54) === RED && rig.px(12, 54) === RED,
    `${hex(rig.px(238, 54))},${hex(rig.px(12, 54))}`);
}

// ROMREGION_ERASEFF normalization: a loader that zero-fills the unloaded
// upper half of a bg region (instead of MAME's 0xff erase fill) must still
// produce the solid pen-3 lower strip half (this was the real-ROM bug:
// strip bottoms rendered transparent).
{
  const regions = makeRegions();
  regions['bg0'].fill(0, 0x1000); // zero-filled loader behaviour
  regions['bg_pal'][12] = 0x07;   // mountains pen 3 -> red
  const RED = rgb(255, 0, 0);
  const st = makeState();
  st.bgc = 0x06; st.bgx1 = 20; st.bgy1 = 60; // mountains only; image rows at fby 54..181
  const rig = makeRig(regions, st);
  rig.render();
  check('D12 zero-filled bg upper half restored to 0xff (image rows 64-127 = pen 3)',
    rig.px(100, 120) === RED && rig.px(100, 150) === RED,
    `${hex(rig.px(100, 120))},${hex(rig.px(100, 150))}`);
  check('D13 normalization decodes a copy (caller region not mutated)',
    regions['bg0'][0x1800] === 0);
}

// gameplay-shaped integration: Moon Patrol's ground = tx tiles in rows
// 27-31 (colorram 4) drawn in the rowscroll-quarter-3 band (fby 186..249)
// ON TOP of the bg strip pen-3 fill; the crater surface row scrolls with
// scroll_w.
{
  const regions = makeRegions();
  // char 0xf3 = solid pen 1 (the real ROM's ground-mass tile is solid too)
  regions['tx'].fill(0xff, 0xf3 * 8, 0xf3 * 8 + 8);
  // char 0xe9: surface tile with a single pen-1 pixel at (0,0)
  regions['tx'][0xe9 * 8] = 0x80;
  regions['tx_pal'][4 * 4 + 1] = 0x07;  // color 4 pen 1 -> red (ground)
  regions['bg_pal'][12] = 0x38;         // mountains pen 3 -> green fill
  const RED = rgb(255, 0, 0);
  const GREEN = rgb(0, 255, 0);
  const st = makeState();
  st.bgc = 0x06; st.bgx1 = 0; st.bgy1 = 40; // strip + fill reach the bottom band
  const rig = makeRig(regions, st);
  for (let c = 0; c < 32; c++) {
    rig.videoram[27 * 32 + c] = 0xe9;   // surface row (craters)
    rig.colorram[27 * 32 + c] = 0x04;
    for (let r = 28; r < 32; r++) {
      rig.videoram[r * 32 + c] = 0xf3;  // solid ground mass
      rig.colorram[r * 32 + c] = 0x04;
    }
  }
  rig.render();
  check('C13 ground mass (tile rows 28-31) covers the bg fill at fby 218..249',
    rig.px(0, 218) === RED && rig.px(120, 230) === RED && rig.px(239, 249) === RED,
    hex(rig.px(120, 230)));
  check('C14 crater surface row (tile row 27) renders over the strip fill at fby 210',
    rig.px(32, 210) === RED && rig.px(33, 210) === GREEN,
    `${hex(rig.px(32, 210))},${hex(rig.px(33, 210))}`);
  st.scroll = 13;
  rig.render();
  check('C15 crater surface scrolls with scroll_w (quarter 3 only)',
    rig.px(45, 210) === RED && rig.px(32, 210) === GREEN && rig.px(120, 230) === RED,
    hex(rig.px(45, 210)));
}

// ---------------------------------------------------------------------------
// (E) sprites: position, CLUT, flips, wrapping, priority
// Geometry: sy = 257 - Y, sx = X + 129 -> fb (X - 7, 235 - Y).
{
  const regions = makeRegions();
  const sp = regions['sp'];
  sp[2 * 32] = 0x80;      // sprite 2 pixel (0,0) = pen 2
  sp[2 * 32 + 15] = 0xff; // sprite 2 row 15, x 0-7 = pen 2
  sp[2 * 32 + 31] = 0xff; // sprite 2 row 15, x 8-15 = pen 2
  sp[3 * 32] = 0x80;      // sprite 3 pixel (0,0) = pen 2 (for flip tests)
  const clut = regions['spr_clut'];
  const spp = regions['spr_pal'];
  clut[0] = 1; spp[1] = 0x38;    // fill green 200
  clut[10] = 11; spp[11] = 0x07; // color 1 pen 2 -> blue 200
  clut[18] = 0;                  // color 2 pen 2 -> CLUT 0 = transparent
  clut[26] = 5; spp[5] = 0x00;   // color 3 pen 2 -> opaque black
  clut[34] = 12; spp[12] = 0x40; // color 4 pen 2 -> red 62
  clut[42] = 13; spp[13] = 0x80; // color 5 pen 2 -> red 132
  const FILL = rgb(0, 200, 0);
  const BLUE = rgb(0, 0, 200);
  const RED62 = rgb(62, 0, 0);
  const RED132 = rgb(132, 0, 0);
  const st = makeState();
  const rig = makeRig(regions, st);
  const ram = rig.spriteram;

  ram.set([100, 0x01, 2, 50], 0); // Y=100 color=1 code=2 X=50
  rig.render();
  check('E1 sprite pixel(0,0) at fb (X-7, 235-Y) = (43,135)',
    rig.px(43, 135) === BLUE, hex(rig.px(43, 135)));
  check('E2 sprite pens with CLUT value != 0 but pen 0 gfx stay transparent',
    rig.px(44, 135) === FILL, hex(rig.px(44, 135)));

  ram[1] = 0x02; // color 2: clut[18] == 0
  rig.render();
  check('E3 CLUT value 0 = transparent pen (transpen_mask semantics)',
    rig.px(43, 135) === FILL, hex(rig.px(43, 135)));

  ram[1] = 0x03; // color 3: clut 5 -> palette black, still opaque
  rig.render();
  check('E4 CLUT value != 0 mapping to black is still drawn',
    rig.px(43, 135) === BLACK, hex(rig.px(43, 135)));

  ram.set([100, 0x41, 3, 50], 0); // flipx, sprite 3 (only pixel 0,0 set)
  rig.render();
  check('E5 flipx mirrors within the 16px cell', rig.px(58, 135) === BLUE, hex(rig.px(58, 135)));
  ram[1] = 0x81; // flipy
  rig.render();
  check('E6 flipy mirrors within the 16px cell', rig.px(43, 150) === BLUE, hex(rig.px(43, 150)));

  ram.set([100, 0x01, 130, 50], 0); // code 130 -> % 128 -> sprite 2
  rig.render();
  check('E7 sprite code wraps % 128 elements', rig.px(43, 135) === BLUE, hex(rig.px(43, 135)));

  ram.set([100, 0x11, 2, 50], 0); // color 17 -> % 16 colors -> color 1
  rig.render();
  check('E8 sprite color wraps % 16 color groups', rig.px(43, 135) === BLUE, hex(rig.px(43, 135)));

  // in-group priority: offsets are drawn descending, so LOWER offsets win
  ram.fill(0);
  ram.set([100, 0x04, 2, 50], 4); // offs 4: color 4 (red62)
  rig.render();
  check('E9 sanity: offs 4 sprite alone renders red62', rig.px(43, 135) === RED62,
    hex(rig.px(43, 135)));
  ram.set([100, 0x01, 2, 50], 0); // offs 0: color 1 (blue), same position
  rig.render();
  check('E10 within a group the lower offset is drawn last and wins',
    rig.px(43, 135) === BLUE, hex(rig.px(43, 135)));

  // cross-group: groups 0x00/0x40/0x80/0xc0 drawn in order, later wins
  ram.fill(0);
  ram.set([60, 0x01, 2, 100], 0x08);  // group 0
  ram.set([60, 0x05, 2, 100], 0xc0);  // group 3, same position (93,175)
  rig.render();
  check('E11 later sprite group (0xc0-0xff) draws on top of group 0',
    rig.px(93, 175) === RED132, hex(rig.px(93, 175)));

  // sprite vs tx priority: sprites are drawn after the tilemap (fresh rig
  // whose char 1 has a 2x2 pen-1 block)
  ram.fill(0);
  const regions2 = makeRegions();
  regions2['sp'].set(sp);
  regions2['spr_clut'].set(clut);
  regions2['spr_pal'].set(spp);
  regions2['tx'][8] = 0xc0;  // char 1 pixels (0,0),(1,0)
  regions2['tx'][9] = 0xc0;  // char 1 pixels (0,1),(1,1)
  regions2['tx_pal'][1] = 0x07; // color 0 pen 1 -> red
  const st2 = makeState();
  const rig2 = makeRig(regions2, st2);
  rig2.videoram[16 * 32 + 10] = 1;        // tile (16,10) -> fb (72..73,122..123)
  rig2.spriteram.set([112, 0x01, 2, 80], 0); // sprite pixel(0,0) -> fb (73,123)
  rig2.render();
  check('E12 sprites draw over the tx layer',
    rig2.px(73, 123) === BLUE && rig2.px(72, 122) === rgb(255, 0, 0),
    `${hex(rig2.px(73, 123))},${hex(rig2.px(72, 122))}`);

  // clipping at the frame edges (sy can start above the visible area)
  ram.fill(0);
  rig.videoram.fill(0);
  ram.set([250, 0x01, 2, 0], 0); // sy = 7: only row 15 visible at fby 0; sx = 129 -> fbx -7
  rig.render();
  check('E13 sprite clipped at top/left edges without wrap',
    rig.px(0, 0) === BLUE && rig.px(8, 0) === BLUE && rig.px(9, 0) === BLACK,
    `${hex(rig.px(0, 0))},${hex(rig.px(9, 0))}`);
}

// ---------------------------------------------------------------------------
// (F) flip screen (cocktail): ported offsets from m52.cpp draw paths
{
  const regions = makeRegions();
  regions['tx'][8] = 0x80;       // char 1 pixel (0,0) pen 1
  regions['tx_pal'][1] = 0x07;   // red
  regions['sp'][2 * 32 + 31] = 0x01; // sprite 2 pixel (15,15) pen 2
  regions['spr_clut'][10] = 11;
  regions['spr_pal'][11] = 0x07; // blue 200
  regions['bg0'][0] = 0x88;      // mountains pixel (0,0) pen 3
  regions['bg_pal'][12] = 0x07;  // red
  const RED = rgb(255, 0, 0);
  const BLUE = rgb(0, 0, 200);
  const st = makeState();
  st.flip = true;
  const rig = makeRig(regions, st);

  rig.videoram[10 * 32 + 5] = 1;
  rig.spriteram.set([100, 0x01, 2, 50], 0);
  rig.render();
  check('F1 flipped tilemap: tile (10,5) pixel(0,0) -> fb (207,177)',
    rig.px(207, 177) === RED, hex(rig.px(207, 177)));
  check('F2 flipped sprite: sx=238-x, sy=282-sy, flips inverted -> fb (181,103)',
    rig.px(181, 103) === BLUE, hex(rig.px(181, 103)));

  st.bgc = 0x06; st.bgx1 = 20; st.bgy1 = 60;
  rig.render();
  check('F3 flipped mountains: xpos=264-x, ypos=264-y-128, mirrored -> fb (231,197)',
    rig.px(231, 197) === RED, hex(rig.px(231, 197)));
  check('F4 flipped strip fill sits ABOVE the image', rig.px(100, 30) === RED,
    hex(rig.px(100, 30)));
}

// ---------------------------------------------------------------------------
// (G) smoke: dimensions, determinism, alpha, constructor guards
{
  const regions = makeRegions();
  let seed = 0x1234;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) & 0xff;
  };
  for (const tag of ['tx', 'sp', 'bg0', 'bg1', 'bg2', 'tx_pal', 'bg_pal', 'spr_pal', 'spr_clut']) {
    const r = regions[tag];
    for (let i = 0; i < r.length; i++) r[i] = rnd();
  }
  const st = makeState();
  st.scroll = 77; st.bgx0 = 31; st.bgy0 = 90; st.bgx1 = 200; st.bgy1 = 44; st.bgc = 0;
  const rig = makeRig(regions, st);
  for (let i = 0; i < rig.videoram.length; i++) rig.videoram[i] = rnd();
  for (let i = 0; i < rig.colorram.length; i++) rig.colorram[i] = rnd();
  for (let i = 0; i < rig.spriteram.length; i++) rig.spriteram[i] = rnd();

  check('G1 native landscape 240x252 (ROT0, visible 136..375 x 22..273)',
    rig.video.width === 240 && rig.video.height === 252);

  rig.render();
  const first = rig.fb.slice();
  rig.video.vblank(); // no per-frame latching; must not disturb anything
  rig.render();
  let same = true;
  for (let i = 0; i < first.length; i++) {
    if (first[i] !== rig.fb[i]) { same = false; break; }
  }
  check('G2 render is deterministic (and vblank is state-free)', same);

  let alphaOk = true;
  let painted = 0;
  for (let i = 0; i < first.length; i++) {
    if ((first[i] >>> 24) !== 0xff) alphaOk = false;
    if ((first[i] & 0xffffff) !== 0) painted++;
  }
  check('G3 every pixel opaque alpha (0xAABBGGRR packing)', alphaOk);
  check('G4 random-content smoke render paints pixels', painted > 1000, `${painted}`);

  let threw = false;
  try {
    const bad = makeRegions();
    delete bad['bg1'];
    makeRig(bad, makeState());
  } catch { threw = true; }
  check('G5 constructor rejects missing regions', threw);

  threw = false;
  try {
    const r2 = makeRegions();
    const deps: M52VideoDeps = {
      regions: r2,
      videoram: new Uint8Array(0x400),
      colorram: new Uint8Array(0x400),
      spriteram: new Uint8Array(0x80), // too small
      scroll: () => 0, bgxpos0: () => 0, bgypos0: () => 0,
      bgxpos1: () => 0, bgypos1: () => 0, bgcontrol: () => 0,
    };
    new M52Video(deps);
  } catch { threw = true; }
  check('G6 constructor rejects undersized spriteram', threw);
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
