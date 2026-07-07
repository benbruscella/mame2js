// Self-test for the NES PPU (2C02). Run with: node src/runtime/video/nes-ppu.spec.ts
// Behavior reference: MAME src/devices/video/ppu2c0x.cpp and the nesdev
// "PPU scrolling" loopy register worked examples.

import { NesPpu, NES_PALETTE } from './nes-ppu.ts';
import type { PpuHost } from './nes-ppu.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: number, expected: number): void {
  if (actual === expected) {
    totalPass++;
  } else {
    totalFail++;
    console.log(
      `  FAIL ${label}: got 0x${actual.toString(16)}, want 0x${expected.toString(16)}`
    );
  }
}

interface Rig {
  ppu: NesPpu;
  chr: Uint8Array;
  nt: Uint8Array;
  ticks(): number;
}

function makeRig(): Rig {
  const chr = new Uint8Array(0x2000);
  const nt = new Uint8Array(0x1000);
  let ticks = 0;
  const host: PpuHost = {
    chrRead: (a) => chr[a & 0x1fff],
    chrWrite: (a, d) => { chr[a & 0x1fff] = d; },
    ntRead: (a) => nt[a & 0x0fff],
    ntWrite: (a, d) => { nt[a & 0x0fff] = d; },
    scanlineTick: () => { ticks++; },
  };
  const ppu = new NesPpu(host);
  ppu.reset();
  return { ppu, chr, nt, ticks: () => ticks };
}

interface Snap { v: number; t: number; x: number; ctrl: number; mask: number; status: number }
function snap(ppu: NesPpu): Snap {
  return ppu.snapshot() as unknown as Snap;
}

function setAddr(ppu: NesPpu, a: number): void {
  ppu.writeReg(0x2006, a >> 8);
  ppu.writeReg(0x2006, a & 0xff);
}

function writeVram(ppu: NesPpu, a: number, d: number): void {
  setAddr(ppu, a);
  ppu.writeReg(0x2007, d);
}

function setSprite(ppu: NesPpu, i: number, y: number, tile: number, attr: number, x: number): void {
  ppu.writeReg(0x2003, i * 4);
  ppu.writeOam(y); ppu.writeOam(tile); ppu.writeOam(attr); ppu.writeOam(x);
}

function clearOam(ppu: NesPpu): void {
  ppu.writeReg(0x2003, 0);
  for (let i = 0; i < 256; i++) ppu.writeOam(0xf0); // y=0xf0: offscreen
}

const col = (idx: number, emph = 0): number => NES_PALETTE[emph * 64 + idx];
const fb = new Uint32Array(256 * 240);
const px = (line: number, x: number): number => fb[line * 256 + x];

// ---------------------------------------------------------------------------
// loopy v/t/x/w: the nesdev worked example
{
  const { ppu } = makeRig();
  ppu.writeReg(0x2000, 0x03);
  eq('$2000 write sets t nametable bits', snap(ppu).t, 0x0c00);
  ppu.writeReg(0x2000, 0x00);
  eq('$2000 write clears t nametable bits', snap(ppu).t, 0x0000);
  ppu.readReg(0x2002);
  ppu.writeReg(0x2005, 0x7d);
  eq('$2005 first write: t coarse X', snap(ppu).t, 0x000f);
  eq('$2005 first write: fine x', snap(ppu).x, 5);
  ppu.writeReg(0x2005, 0x5e);
  eq('$2005 second write: t fine/coarse Y', snap(ppu).t, 0x616f);
  ppu.writeReg(0x2006, 0x3d);
  eq('$2006 first write: t high byte (bit 14 clear)', snap(ppu).t, 0x3d6f);
  ppu.writeReg(0x2006, 0xf0);
  eq('$2006 second write: t low byte', snap(ppu).t, 0x3df0);
  eq('$2006 second write: v = t', snap(ppu).v, 0x3df0);
}

// $2006 pair alone; register mirroring; $2002 clears w
{
  const { ppu } = makeRig();
  ppu.writeReg(0x2006, 0x21);
  ppu.writeReg(0x2006, 0x08);
  eq('$2006=$21,$08 -> v=$2108', snap(ppu).v, 0x2108);

  ppu.writeReg(0x3ffd, 0x0f); // 0x3ffd & 7 = 5: PPUSCROLL via mirror
  eq('write mirror $3FFD hits $2005 (fine x)', snap(ppu).x, 7);
  ppu.writeReg(0x2005, 0); // finish the pair

  ppu.writeReg(0x2005, 0x7d); // w -> 1
  ppu.readReg(0x2002);        // clears w
  ppu.writeReg(0x2006, 0x21);
  ppu.writeReg(0x2006, 0x08);
  eq('$2002 read clears the w toggle', snap(ppu).v, 0x2108);

  ppu.startVblank();
  eq('read mirror $3FFA hits $2002', ppu.readReg(0x3ffa) & 0x80, 0x80);
  eq('$2002 read cleared vblank flag', ppu.readReg(0x2002) & 0x80, 0x00);
}

// ---------------------------------------------------------------------------
// $2007 buffered reads, increment 1/32, write routing
{
  const { ppu, chr, nt } = makeRig();
  nt[0x000] = 0x11; nt[0x001] = 0x22; nt[0x020] = 0x33;
  chr[0x123] = 0x77;

  setAddr(ppu, 0x2000);
  eq('$2007 first read returns stale buffer', ppu.readReg(0x2007), 0x00);
  eq('$2007 second read returns nt[0]', ppu.readReg(0x2007), 0x11);
  eq('$2007 third read returns nt[1] (inc 1)', ppu.readReg(0x2007), 0x22);
  eq('v post-incremented by 1', snap(ppu).v, 0x2003);

  ppu.writeReg(0x2000, 0x04); // increment 32
  setAddr(ppu, 0x2000);
  ppu.readReg(0x2007); // prime buffer with nt[0]
  eq('v post-incremented by 32', snap(ppu).v, 0x2020);
  eq('buffered value from before the +32 step', ppu.readReg(0x2007), 0x11);
  eq('next buffered value is nt[0x20]', ppu.readReg(0x2007), 0x33);
  ppu.writeReg(0x2000, 0x00);

  setAddr(ppu, 0x0123);
  ppu.readReg(0x2007);
  eq('$2007 buffered read from CHR space', ppu.readReg(0x2007), 0x77);

  setAddr(ppu, 0x0500);
  ppu.writeReg(0x2007, 0xab);
  eq('$2007 write routes to CHR below $2000', chr[0x0500], 0xab);
  setAddr(ppu, 0x2345);
  ppu.writeReg(0x2007, 0xcd);
  eq('$2007 write routes to nametables (masked)', nt[0x345], 0xcd);
  eq('$2007 write post-increments v', snap(ppu).v, 0x2346);
}

// palette RAM: direct reads, mirroring, 6-bit store, buffer-underneath
{
  const { ppu, nt } = makeRig();
  writeVram(ppu, 0x3f10, 0x2a);
  setAddr(ppu, 0x3f00);
  eq('$3F10 write mirrors to $3F00', ppu.readReg(0x2007), 0x2a);
  writeVram(ppu, 0x3f04, 0x11);
  setAddr(ppu, 0x3f14);
  eq('$3F14 read mirrors $3F04', ppu.readReg(0x2007), 0x11);
  writeVram(ppu, 0x3f01, 0xff);
  setAddr(ppu, 0x3f01);
  eq('palette entries store 6 bits', ppu.readReg(0x2007), 0x3f);
  writeVram(ppu, 0x3f11, 0x05);
  setAddr(ppu, 0x3f01);
  eq('$3F11 is not a mirror of $3F01', ppu.readReg(0x2007), 0x3f);

  writeVram(ppu, 0x3f05, 0x2c);
  nt[0xf05] = 0x5a;
  setAddr(ppu, 0x3f05);
  eq('palette read is direct (no buffer delay)', ppu.readReg(0x2007), 0x2c);
  setAddr(ppu, 0x2000);
  eq('palette read loaded buffer from nt underneath', ppu.readReg(0x2007), 0x5a);
}

// ---------------------------------------------------------------------------
// background rendering
{
  const { ppu, chr, nt } = makeRig();
  for (let r = 0; r < 8; r++) chr[0x10 + r] = 0xaa;                    // tile 1: checker, pen 1 on even px
  for (let r = 0; r < 4; r++) { chr[0x20 + r] = 0xff; chr[0x28 + r] = 0xff; } // tile 2: rows 0-3 pen 3
  nt[0] = 1; nt[1] = 1; nt[2] = 1;
  nt[0x3c0] = 0x04; // attribute: top-right quadrant -> palette 1
  writeVram(ppu, 0x3f00, 0x0f);
  writeVram(ppu, 0x3f01, 0x30);
  writeVram(ppu, 0x3f03, 0x21);
  writeVram(ppu, 0x3f05, 0x16);
  const BD = col(0x0f);

  ppu.writeReg(0x2000, 0x00); // clear NN bits left in t by the $2006 palette writes
  ppu.writeReg(0x2001, 0x0a); // bg on + show left 8
  eq('renderingEnabled with bg on', Number(ppu.renderingEnabled()), 1);
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0);
  ppu.preRender();

  ppu.renderLine(0, fb);
  eq('bg pixel 0: tile 1 pen 1', px(0, 0), col(0x30));
  eq('bg pixel 1: pen 0 -> backdrop', px(0, 1), BD);
  eq('bg attribute quadrant: tile at coarse x=2 uses palette 1', px(0, 16), col(0x16));
  eq('bg attribute quadrant: pixel 17 backdrop', px(0, 17), BD);
  eq('bg blank tile -> backdrop', px(0, 24), BD);

  // fine-x scroll
  ppu.writeReg(0x2005, 3); ppu.writeReg(0x2005, 0);
  ppu.preRender();
  ppu.renderLine(1, fb);
  eq('fine-x=3: pixel 0 shows tile pixel 3 (pen 0)', px(1, 0), BD);
  eq('fine-x=3: pixel 1 shows tile pixel 4 (pen 1)', px(1, 1), col(0x30));

  // left-8 background clip (mask bit 1 clear)
  ppu.writeReg(0x2001, 0x08);
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0);
  ppu.preRender();
  ppu.renderLine(2, fb);
  eq('bg left-8 clip hides pixel 0', px(2, 0), BD);
  eq('bg left-8 clip: pixel 8 visible', px(2, 8), col(0x30));
  ppu.writeReg(0x2001, 0x0a);

  // vertical scroll (fine Y) + per-line Y increment
  nt[0] = 2;
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 2); // fine Y = 2
  ppu.preRender();
  ppu.renderLine(0, fb);
  eq('fine-y=2: tile 2 row 2 is pen 3', px(0, 0), col(0x21));
  ppu.renderLine(1, fb);
  eq('next line: row 3 still pen 3', px(1, 0), col(0x21));
  ppu.renderLine(2, fb);
  eq('next line: row 4 is transparent', px(2, 0), BD);

  // loopy Y-increment quirks (observed through snapshot after one line)
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0xef); // fineY=7, coarseY=29
  ppu.preRender();
  ppu.renderLine(0, fb);
  eq('coarse Y 29 -> 0 with vertical-nametable flip', snap(ppu).v, 0x0800);
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0xff); // fineY=7, coarseY=31
  ppu.preRender();
  ppu.renderLine(0, fb);
  eq('coarse Y 31 -> 0 without flip', snap(ppu).v, 0x0000);
  ppu.writeReg(0x2005, 16); ppu.writeReg(0x2005, 0);   // coarse X = 2
  ppu.preRender();
  ppu.renderLine(0, fb);
  eq('fine Y increments; dot-257 copy restores coarse X from t', snap(ppu).v, 0x1002);
}

// ---------------------------------------------------------------------------
// sprites
{
  const { ppu, chr, nt } = makeRig();
  for (let r = 0; r < 8; r++) chr[0x10 + r] = 0xaa; // tile 1: bg checker
  for (let r = 0; r < 8; r++) chr[0x30 + r] = 0xf0; // tile 3: left 4 px pen 1
  for (let r = 0; r < 4; r++) chr[0x40 + r] = 0xff; // tile 4: rows 0-3 pen 1
  for (let r = 0; r < 8; r++) chr[0x50 + r] = 0xff; // tile 5: solid pen 1
  writeVram(ppu, 0x3f00, 0x0f);
  writeVram(ppu, 0x3f01, 0x30);
  writeVram(ppu, 0x3f11, 0x27);
  writeVram(ppu, 0x3f15, 0x2a);
  const BD = col(0x0f), BG = col(0x30), S0 = col(0x27), S1 = col(0x2a);

  ppu.writeReg(0x2000, 0x00); // clear NN left in t by the $2006 palette writes
  ppu.writeReg(0x2001, 0x1e); // bg + sprites + both left-8
  clearOam(ppu);

  // position: OAM y=9 covers lines 10..17
  setSprite(ppu, 0, 9, 3, 0x00, 100);
  ppu.renderLine(9, fb);
  eq('sprite not on line y (OAM stores Y-1)', px(9, 100), BD);
  ppu.renderLine(10, fb);
  eq('sprite first line: leftmost pixel', px(10, 100), S0);
  eq('sprite first line: pixel 103 (tile 3 pen 1)', px(10, 103), S0);
  eq('sprite first line: pixel 104 transparent', px(10, 104), BD);
  eq('sprite first line: pixel 99 untouched', px(10, 99), BD);
  ppu.renderLine(17, fb);
  eq('sprite last line (y+8)', px(17, 100), S0);
  ppu.renderLine(18, fb);
  eq('sprite gone below last line', px(18, 100), BD);

  // horizontal flip
  setSprite(ppu, 0, 9, 3, 0x40, 100);
  ppu.renderLine(10, fb);
  eq('flip-h: left pixels now transparent', px(10, 100), BD);
  eq('flip-h: pixel 104 opaque', px(10, 104), S0);
  eq('flip-h: pixel 107 opaque', px(10, 107), S0);

  // vertical flip
  setSprite(ppu, 0, 9, 4, 0x80, 100);
  ppu.renderLine(10, fb);
  eq('flip-v: row 0 shows tile row 7 (blank)', px(10, 100), BD);
  ppu.renderLine(14, fb);
  eq('flip-v: row 4 shows tile row 3 (pen 1)', px(14, 100), S0);

  // priority behind background
  nt[12] = 1; // bg checker over px 96..103
  setSprite(ppu, 0, 9, 3, 0x20, 100);
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0);
  ppu.preRender();
  ppu.renderLine(10, fb);
  eq('behind-bg sprite loses to opaque bg', px(10, 100), BG);
  eq('behind-bg sprite shows through bg pen 0', px(10, 101), S0);

  // sprite palette select
  setSprite(ppu, 0, 9, 3, 0x01, 100);
  ppu.renderLine(11, fb);
  eq('sprite palette bits select palette 1', px(11, 100), S1);

  // inter-sprite priority: lower OAM index wins
  setSprite(ppu, 0, 9, 3, 0x00, 100);
  setSprite(ppu, 1, 9, 3, 0x01, 102);
  ppu.renderLine(12, fb);
  eq('overlap: sprite 0 wins', px(12, 102), S0);
  eq('non-overlap: sprite 1 visible', px(12, 104), S1);
  setSprite(ppu, 1, 0xf0, 0, 0, 0);

  // left-8 sprite clip (mask bit 2 clear)
  ppu.writeReg(0x2001, 0x1a);
  setSprite(ppu, 0, 9, 5, 0x00, 4);
  ppu.renderLine(13, fb);
  eq('sprite left-8 clip hides pixel 7', px(13, 7), BD);
  eq('sprite left-8 clip: pixel 8 visible', px(13, 8), S0);
  ppu.writeReg(0x2001, 0x1e);

  // sprite 0 hit
  setSprite(ppu, 0, 9, 5, 0x00, 96); // solid sprite over the checker tile
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0);
  ppu.preRender(); // clears status
  ppu.renderLine(9, fb);
  eq('no sprite-0 hit before overlap line', ppu.readReg(0x2002) & 0x40, 0x00);
  ppu.renderLine(10, fb);
  eq('sprite-0 hit on overlap line', ppu.readReg(0x2002) & 0x40, 0x40);
  ppu.preRender();
  eq('preRender clears sprite-0 hit', ppu.readReg(0x2002) & 0x40, 0x00);

  // no hit at x=255
  setSprite(ppu, 0, 9, 5, 0x00, 255);
  nt[31] = 5; // opaque bg at px 248..255
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0);
  ppu.preRender();
  ppu.renderLine(10, fb);
  eq('no sprite-0 hit at x=255', ppu.readReg(0x2002) & 0x40, 0x00);

  // no hit when the background layer is disabled
  ppu.writeReg(0x2001, 0x16);
  setSprite(ppu, 0, 9, 5, 0x00, 96);
  ppu.preRender();
  ppu.renderLine(10, fb);
  eq('no sprite-0 hit with bg disabled', ppu.readReg(0x2002) & 0x40, 0x00);
  ppu.writeReg(0x2001, 0x1e);

  // sprite overflow: 9 in range sets bit 5, 8 does not
  clearOam(ppu);
  for (let i = 0; i < 9; i++) setSprite(ppu, i, 20, 5, 0x00, i * 10);
  ppu.preRender();
  ppu.renderLine(21, fb);
  eq('9 sprites on a line set overflow', ppu.readReg(0x2002) & 0x20, 0x20);
  ppu.preRender();
  setSprite(ppu, 8, 0xf0, 0, 0, 0);
  ppu.renderLine(21, fb);
  eq('8 sprites on a line: no overflow', ppu.readReg(0x2002) & 0x20, 0x00);
}

// 8x16 sprites
{
  const { ppu, chr } = makeRig();
  for (let r = 0; r < 8; r++) chr[0x1020 + r] = 0xff; // tile 2 @ $1000: solid pen 1
  for (let r = 0; r < 8; r++) chr[0x0028 + r] = 0xff; // tile 2 @ $0000: solid pen 2 (hi plane)
  writeVram(ppu, 0x3f00, 0x0f);
  writeVram(ppu, 0x3f11, 0x27);
  writeVram(ppu, 0x3f12, 0x2a);
  const BD = col(0x0f);

  ppu.writeReg(0x2000, 0x20); // 8x16 sprites
  ppu.writeReg(0x2001, 0x1e);
  clearOam(ppu);

  setSprite(ppu, 0, 49, 0x03, 0x00, 50); // tile bit 0 -> table $1000, tiles 2/3
  ppu.renderLine(50, fb);
  eq('8x16 top half from tile & $FE', px(50, 50), col(0x27));
  eq('8x16 top half: pixel 57', px(50, 57), col(0x27));
  eq('8x16: pixel 58 outside sprite', px(50, 58), BD);
  ppu.renderLine(58, fb);
  eq('8x16 bottom half from tile | 1 (blank)', px(58, 50), BD);

  setSprite(ppu, 0, 49, 0x03, 0x80, 50); // flip-v swaps halves
  ppu.renderLine(50, fb);
  eq('8x16 flip-v: top shows bottom tile (blank)', px(50, 50), BD);
  ppu.renderLine(58, fb);
  eq('8x16 flip-v: bottom shows top tile', px(58, 50), col(0x27));

  setSprite(ppu, 0, 49, 0x02, 0x00, 50); // tile bit 0 clear -> table $0000
  ppu.renderLine(50, fb);
  eq('8x16 pattern table from tile bit 0', px(50, 50), col(0x2a));
}

// ---------------------------------------------------------------------------
// NMI
{
  const { ppu } = makeRig();
  ppu.writeReg(0x2000, 0x80);
  ppu.startVblank();
  eq('startVblank + NMI enabled -> pending', Number(ppu.takeNmi()), 1);
  eq('takeNmi clears the pending flag', Number(ppu.takeNmi()), 0);

  ppu.readReg(0x2002); // clears vblank flag
  ppu.writeReg(0x2000, 0x00);
  ppu.writeReg(0x2000, 0x80);
  eq('enable after $2002 read: flag gone, no NMI', Number(ppu.takeNmi()), 0);

  ppu.preRender();
  ppu.writeReg(0x2000, 0x00);
  ppu.startVblank();
  eq('startVblank with NMI disabled: none', Number(ppu.takeNmi()), 0);
  ppu.writeReg(0x2000, 0x80);
  eq('enabling NMI during vblank retriggers', Number(ppu.takeNmi()), 1);
  ppu.writeReg(0x2000, 0x80);
  eq('rewriting bit 7 without an edge: no retrigger', Number(ppu.takeNmi()), 0);
}

// preRender flag clearing, vertical scroll reload, scanlineTick gating
{
  const { ppu, ticks } = makeRig();
  eq('renderingEnabled false at reset', Number(ppu.renderingEnabled()), 0);
  ppu.renderLine(0, fb);
  ppu.preRender();
  eq('no scanlineTick while rendering disabled', ticks(), 0);

  ppu.writeReg(0x2001, 0x08);
  ppu.renderLine(0, fb);
  eq('renderLine ticks with bg enabled', ticks(), 1);
  ppu.preRender();
  eq('preRender ticks with rendering enabled', ticks(), 2);
  ppu.writeReg(0x2001, 0x10);
  eq('renderingEnabled with sprites only', Number(ppu.renderingEnabled()), 1);
  ppu.renderLine(0, fb);
  eq('renderLine ticks with sprites-only', ticks(), 3);

  ppu.startVblank();
  ppu.preRender();
  eq('preRender clears all status bits', ppu.readReg(0x2002), 0x00);

  // vertical reload: scroll set mid-frame takes effect after preRender
  ppu.writeReg(0x2001, 0x08);
  ppu.writeReg(0x2005, 0);
  ppu.writeReg(0x2005, 0x0b); // fineY=3, coarseY=1
  ppu.preRender();
  eq('preRender reloads scroll from t', snap(ppu).v, 0x3020);
}

// rendering disabled: backdrop fill, palette hack, grayscale, emphasis
{
  const { ppu } = makeRig();
  writeVram(ppu, 0x3f00, 0x21);
  writeVram(ppu, 0x3f04, 0x16);
  setAddr(ppu, 0x2000);
  ppu.renderLine(0, fb);
  eq('disabled: line filled with backdrop (x=0)', px(0, 0), col(0x21));
  eq('disabled: line filled with backdrop (x=255)', px(0, 255), col(0x21));

  setAddr(ppu, 0x3f14); // palette hack, via the $3F14 -> $3F04 mirror
  ppu.renderLine(1, fb);
  eq('disabled with v in palette range shows that entry', px(1, 0), col(0x16));

  ppu.writeReg(0x2001, 0x01); // grayscale
  setAddr(ppu, 0x2000);
  ppu.renderLine(2, fb);
  eq('grayscale masks palette index to & $30', px(2, 0), col(0x20));

  ppu.writeReg(0x2001, 0x20); // emphasize red
  setAddr(ppu, 0x2000);
  ppu.renderLine(3, fb);
  eq('emphasis bits select the pre-expanded variant', px(3, 0), col(0x21, 1));
  const base = col(0x21), emph = col(0x21, 1);
  eq('red emphasis keeps the red channel', emph & 0xff, base & 0xff);
  eq('red emphasis attenuates green', Number(((emph >> 8) & 0xff) < ((base >> 8) & 0xff)), 1);
  eq('red emphasis attenuates blue', Number(((emph >> 16) & 0xff) < ((base >> 16) & 0xff)), 1);
  eq('packed alpha is 0xff', emph >>> 24, 0xff);
}

// grayscale during rendering
{
  const { ppu, chr, nt } = makeRig();
  for (let r = 0; r < 8; r++) chr[0x10 + r] = 0xaa;
  nt[0] = 1;
  writeVram(ppu, 0x3f00, 0x0f);
  writeVram(ppu, 0x3f01, 0x16);
  ppu.writeReg(0x2000, 0x00); // clear NN left in t by the $2006 palette writes
  ppu.writeReg(0x2001, 0x0b); // bg + left + grayscale
  ppu.writeReg(0x2005, 0); ppu.writeReg(0x2005, 0);
  ppu.preRender();
  ppu.renderLine(0, fb);
  eq('grayscale applies to rendered pixels', px(0, 0), col(0x10));
}

// OAM address / data
{
  const { ppu } = makeRig();
  ppu.writeReg(0x2003, 0xfe);
  ppu.writeOam(0x11);
  ppu.writeOam(0x22);
  ppu.writeOam(0x33); // wraps to 0
  ppu.writeReg(0x2003, 0xfe);
  eq('OAM DMA path lands at oamAddr', ppu.readReg(0x2004), 0x11);
  eq('$2004 read does not increment', ppu.readReg(0x2004), 0x11);
  ppu.writeReg(0x2003, 0xff);
  eq('second DMA byte', ppu.readReg(0x2004), 0x22);
  ppu.writeReg(0x2003, 0x00);
  eq('oamAddr wraps at $FF', ppu.readReg(0x2004), 0x33);
  ppu.writeReg(0x2004, 0x44); // $2004 write increments
  ppu.writeReg(0x2003, 0x00);
  eq('$2004 write stores at oamAddr', ppu.readReg(0x2004), 0x44);
}

console.log('');
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`FAILURES: ${totalFail} of ${totalPass + totalFail} checks failed`);
  process.exitCode = 1;
}
