// Structural self-test for the Dig Dug video renderer.
// Run with: node src/runtime/video/digdug.spec.ts   (plain Node, no DOM)
// Exit code 0 = all PASS.

import { decodeGfx } from '../gfx.ts';
import type { GfxLayout } from '../gfx.ts';
import { buildDigdugPalette, tilemapScan, DigdugVideo } from './digdug.ts';

let failures = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  if (cond) console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  else { console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); failures++; }
}
const hex = (v: number): string => '0x' + (v >>> 0).toString(16);

// ---------------------------------------------------------------------------
// (a) 1bpp char layout decodes: byte 0xff -> all pen 1, 0x00 -> all pen 0
{
  const layout: GfxLayout = {
    width: 8, height: 8, total: 'RGN_FRAC(1,1)', planes: 1,
    planeOffsets: [0], xOffsets: [7, 6, 5, 4, 3, 2, 1, 0], yOffsets: [0, 8, 16, 24, 32, 40, 48, 56],
    charIncrement: 64,
  };
  const rom = new Uint8Array(16); // 2 chars of 8 bytes
  rom.fill(0xff, 0, 8); // char 0 all-set
  const set = decodeGfx(layout, rom);
  check('char layout: 2 chars', set.count === 2, `count=${set.count}`);
  check('char 0 all pen 1', Array.from(set.pixels.slice(0, 64)).every(p => p === 1));
  check('char 1 all pen 0', Array.from(set.pixels.slice(64, 128)).every(p => p === 0));
}

// ---------------------------------------------------------------------------
// (b) palette decode on a synthetic PROM
{
  const proms = new Uint8Array(0x220);
  proms[0] = 0xc0;  // core[0] blue
  proms[2] = 0x07;  // core[2] red
  proms[6] = 0xff;  // core[6] white
  proms[0x16] = 0x38; // core[0x16] green
  // char color 2 -> pen 1 = core[2]
  // sprite lut: entry 3 -> (0x06)|0x10 = core[0x16]; entry 4 -> nibble 0x0f transparent
  proms[0x020 + 3] = 0x06;
  proms[0x020 + 4] = 0x0f;
  // bg lut: entry 3 -> core[proms&0x0f]; set to 2 (red)
  proms[0x120 + 3] = 0x02;
  const pal = buildDigdugPalette(proms);

  check('core has 32 entries', pal.core.length === 32);
  check('char pen 0 transparent slot unused', pal.charColor[2 * 2 + 0] === 0);
  check('char pen 1 -> core[color] direct', pal.charColor[2 * 2 + 1] === pal.core[2],
    hex(pal.charColor[2 * 2 + 1]!));
  check('sprite lut -> core[(nibble)|0x10]', pal.spriteColor[3] === pal.core[0x16],
    hex(pal.spriteColor[3]!));
  check('sprite transparent when nibble 0x0f',
    pal.spriteTrans[3] === 0 && pal.spriteTrans[4] === 1);
  check('bg lut -> core[nibble] (opaque)', pal.bgColor[3] === pal.core[2], hex(pal.bgColor[3]!));
}

// ---------------------------------------------------------------------------
// (c) tilemap_scan mapper (identical to Galaga's) — spot checks + injectivity
{
  check('tilemap_scan (2,0) -> 64', tilemapScan(2, 0) === 64);
  check('tilemap_scan (33,27) -> 959', tilemapScan(33, 27) === 959);
  check('tilemap_scan (0,0) left wrap', tilemapScan(0, 0) === 2 + (30 << 5));
  check('tilemap_scan (34,5) right wrap', tilemapScan(34, 5) === 7);
  const seen = new Set<number>();
  let inRange = true;
  for (let row = 0; row < 28; row++) for (let col = 0; col < 36; col++) {
    const o = tilemapScan(col, row);
    if (o < 0 || o > 0x3ff) inRange = false;
    seen.add(o);
  }
  check('tilemap_scan injective over 36x28', seen.size === 36 * 28 && inRange, `${seen.size}`);
}

// ---------------------------------------------------------------------------
// (d) DigdugVideo end-to-end: bg fill, bg_disable, bg_select paging, fg over
//     bg with transparency, and a clipped sprite.
{
  const regions: Record<string, Uint8Array> = {
    gfx1: new Uint8Array(0x1000), // chars (1bpp) — tile 0 stays all-0 (transparent)
    gfx2: new Uint8Array(0x4000), // sprites (2bpp)
    gfx3: new Uint8Array(0x1000), // bg tiles (2bpp)
    gfx4: new Uint8Array(0x1000), // bg map ROM (4 pages of 0x400)
    proms: new Uint8Array(0x220),
  };
  const proms = regions.proms!;
  proms[0] = 0xc0;    // core[0] blue  (fg char color 0)
  proms[2] = 0x07;    // core[2] red   (bg)
  proms[6] = 0xff;    // core[6] white (bg_disable)
  proms[0x16] = 0x38; // core[0x16] green (sprite)
  proms[0x120 + 3] = 0x02;    // bg color 0, pen 3 -> core[2] red
  proms[0x120 + 60 + 3] = 0x06; // bg color 0xf, pen 3 -> core[6] white (bg_disable)
  proms[0x120 + 12 + 3] = 0x02; // bg color 3, pen 3 -> core[2] red (used by paging tile)
  proms[0x020 + 3] = 0x06;    // sprite color 0, pen 3 -> core[0x16] green

  // bg tile 0 = all pen 3 (16 bytes both planes set); gfx4 all-0 -> code 0 everywhere
  regions.gfx3!.fill(0xff, 0, 16);
  // a distinct bg tile 0x30 (high nibble 3 -> bg color 3) also all pen 3
  regions.gfx3!.fill(0xff, 0x30 * 16, 0x30 * 16 + 16);
  // paging: page 1 puts tile 0x30 at the (2,0) cell
  const cell = tilemapScan(2, 0);
  regions.gfx4![(1 << 10) | cell] = 0x30;

  const videoram = new Uint8Array(0x400);
  const objram = new Uint8Array(0x400);
  const posram = new Uint8Array(0x400);
  const flpram = new Uint8Array(0x400);
  let latch = 0;

  // fg char at (col=4,row=1): code 1 (all pen 1), color 0 -> core[0] blue.
  // 1bpp char = 8 bytes/tile, so tile 1 = bytes 8..15.
  regions.gfx1!.fill(0xff, 8, 16);
  videoram[tilemapScan(4, 1)] = 1;

  // sprite slot 0: tile 1 all pen 3 (green), at sx=100, sy=50
  regions.gfx2!.fill(0xff, 64, 128); // sprite element 1
  objram[0x380] = 1;   // sprite number 1 (size 0)
  objram[0x381] = 0;   // color 0
  posram[0x380] = 175; // sy: (256-175+1 & 0xff)-32 = 50
  posram[0x381] = 139; // sx: 139-40+1 = 100

  const video = new DigdugVideo({ regions, videoram, objram, posram, flpram, videolatch: () => latch });
  check('DigdugVideo native size 288x224', video.width === 288 && video.height === 224);

  const frame = new Uint32Array(288 * 224);
  const at = (x: number, y: number): number => frame[y * 288 + x]! >>> 0;
  const pal = buildDigdugPalette(proms);
  const red = pal.core[2]! >>> 0;
  const blue = pal.core[0]! >>> 0;
  const green = pal.core[0x16]! >>> 0;
  const white = pal.core[6]! >>> 0;

  // --- bg fill ---
  video.render(frame);
  check('bg fills screen (red)', at(200, 100) === red, hex(at(200, 100)));
  check('bg fills corners', at(0, 0) === red && at(287, 223) === red);
  check('alpha always 0xff', frame.every(v => ((v >>> 24) & 0xff) === 0xff));

  // --- fg char over bg, with transparency ---
  check('fg char pixel is blue', at(4 * 8, 1 * 8) === blue, hex(at(4 * 8, 1 * 8)));
  check('transparent fg leaves bg red', at(200, 100) === red);

  // --- sprite (green), clipped to [16,271] ---
  check('sprite pixel (100,50) green', at(100, 50) === green, hex(at(100, 50)));
  check('sprite pixel (115,65) green', at(115, 65) === green);
  check('no sprite left of it (99,50) is bg', at(99, 50) === red);

  // --- bg_disable (latch Q3) forces color 0xf -> white ---
  latch = 0x08;
  video.render(frame);
  check('bg_disable makes bg white', at(200, 100) === white, hex(at(200, 100)));

  // --- bg_select (latch Q0) pages the map: cell (2,0) now tile 0x30 (still red
  //     via bg color 3), while default page had tile 0 (also red) — verify the
  //     paged code is actually read by making page-1 tile a DISTINCT color. ---
  latch = 0x01;
  proms[0x120 + 12 + 3] = 0x06; // bg color 3 pen 3 -> white now
  const video2 = new DigdugVideo({ regions, videoram, objram, posram, flpram, videolatch: () => latch });
  const frame2 = new Uint32Array(288 * 224);
  video2.render(frame2);
  const at2 = (x: number, y: number): number => frame2[y * 288 + x]! >>> 0;
  check('bg_select pages the map ROM (cell 2,0 -> white)', at2(2 * 8 + 3, 3) === white,
    hex(at2(2 * 8 + 3, 3)));
  check('bg_select leaves other cells page 0 (red)', at2(200, 100) === red, hex(at2(200, 100)));
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) console.log('ALL PASS');
else { console.error(`${failures} FAILURE(S)`); process.exitCode = 1; }
