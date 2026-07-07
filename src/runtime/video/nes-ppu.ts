// NES PPU (Ricoh 2C02) — scanline device for the nes board (issue #17).
//
// Behavior reference: MAME src/devices/video/ppu2c0x.cpp —
//   register file read/write (:1135-1214, :1227-1361), $2007 buffered read
//   (readbyte :297, the m_data_latch refill in read() case PPU_DATA),
//   draw_background (:643-719, incl. the L8 clip :708), draw_sprites
//   (:844-963: 8-sprite limit, sprite-0 hit, 8x16 pattern select),
//   render_scanline (:984-1008), scanline_tick / hblank_tick (:506-590 —
//   our host.scanlineTick() is the same per-scanline HLE MAME feeds the
//   MMC3), update_scanline loopy copy/increment (:1086-1133), palette +
//   emphasis tables (init_palette_tables :426, apply_color_emphasis :342).
// Loopy v/t/x/w register semantics follow the nesdev "PPU scrolling"
// reference bit layout: v = yyy NN YYYYY XXXXX.
//
// Deliberate deviations (all documented nesdev edge cases, none needed by
// the first-cut library):
// - Scanline granularity: renderLine() draws all 256 pixels from one
//   register snapshot; mid-scanline $2001/$2005 splits land on the next
//   line. (MAME's update_scanline() has the same per-line model.)
// - Odd-frame pre-render dot skip not modeled (frame is always 262 lines).
// - $2002 read/NMI race not modeled: reading $2002 on the vblank-set line
//   cannot suppress the NMI; startVblank() latches it atomically.
// - OAMADDR corruption during rendering (and the $2003 sprite-eval bug)
//   not modeled; OAM reads/writes are always clean.
// - Sprite overflow uses a correct in-order scan (flag on the 9th sprite
//   in range); the hardware's buggy diagonal OAM scan is not reproduced.
// - $2002/$2007 open-bus decay bits read as 0.
// - MMC3 A12 hook: host.scanlineTick() fires once at the end of every
//   rendered line (and at preRender) when rendering is enabled — the same
//   HLE as MAME's hblank IRQ callback, so mid-screen pattern-table swaps
//   can be one line off.

export interface PpuHost {
  /** $0000-$1FFF pattern fetch */
  chrRead(addr: number): number;
  chrWrite(addr: number, data: number): void;
  /** nametable space PRE-MASKED to $0000-$0FFF (cart owns CIRAM/mirroring) */
  ntRead(addr: number): number;
  ntWrite(addr: number, data: number): void;
  /** MMC3 scanline IRQ hook */
  scanlineTick(): void;
}

// ---------------------------------------------------------------------------
// Canonical 2C02 NTSC palette (the classic Nestopia/nesdev 64-entry table),
// pre-expanded at module load into 8 emphasis variants of 64 colors each,
// packed 0xAABBGGRR (canvas ImageData order), alpha 0xff.
// Index: (emphasisBits << 6) | color, emphasisBits = mask >> 5.

// prettier-ignore
const BASE_RGB: number[] = [
  84, 84, 84, 0, 30, 116, 8, 16, 144, 48, 0, 136, 68, 0, 100, 92, 0, 48, 84, 4, 0, 60, 24, 0,
  32, 42, 0, 8, 58, 0, 0, 64, 0, 0, 60, 0, 0, 50, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  152, 150, 152, 8, 76, 196, 48, 50, 236, 92, 30, 228, 136, 20, 176, 160, 20, 100, 152, 34, 32, 120, 60, 0,
  84, 90, 0, 40, 114, 0, 8, 124, 0, 0, 118, 40, 0, 102, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  236, 238, 236, 76, 154, 236, 120, 124, 236, 176, 98, 236, 228, 84, 236, 236, 88, 180, 236, 106, 100, 212, 136, 32,
  160, 170, 0, 116, 196, 0, 76, 208, 32, 56, 220, 108, 56, 180, 204, 60, 60, 60, 0, 0, 0, 0, 0, 0,
  236, 238, 236, 168, 204, 236, 188, 188, 236, 212, 178, 236, 236, 174, 236, 236, 174, 212, 236, 180, 176, 228, 196, 144,
  204, 210, 120, 180, 222, 120, 168, 226, 144, 152, 226, 180, 160, 214, 228, 160, 162, 160, 0, 0, 0, 0, 0, 0,
];

/** 512 packed colors: 8 emphasis variants x 64 palette entries. */
export const NES_PALETTE: Uint32Array = (() => {
  const out = new Uint32Array(512);
  const ATT = 0.746; // each set emphasis bit attenuates the other two guns
  for (let e = 0; e < 8; e++) {
    for (let c = 0; c < 64; c++) {
      let r = BASE_RGB[c * 3];
      let g = BASE_RGB[c * 3 + 1];
      let b = BASE_RGB[c * 3 + 2];
      if (e & 1) { g *= ATT; b *= ATT; } // emphasize red
      if (e & 2) { r *= ATT; b *= ATT; } // emphasize green
      if (e & 4) { r *= ATT; g *= ATT; } // emphasize blue
      out[e * 64 + c] =
        (0xff000000 | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------

/** $3F00-$3FFF -> 0..31 with $3F10/$14/$18/$1C mirrored onto $3F00/04/08/0C. */
function paletteIndex(addr: number): number {
  const i = addr & 0x1f;
  return (i & 0x13) === 0x10 ? i & 0x0f : i;
}

/** Loopy Y increment: fine y, coarse y with the 29->0+flip and 31->0 quirks. */
function incrementY(v: number): number {
  if ((v & 0x7000) !== 0x7000) return v + 0x1000;
  v &= ~0x7000;
  let y = (v >> 5) & 0x1f;
  if (y === 29) { y = 0; v ^= 0x0800; }
  else if (y === 31) y = 0;
  else y++;
  return (v & ~0x03e0) | (y << 5);
}

export class NesPpu {
  private readonly host: PpuHost;

  private ctrl = 0;    // $2000
  private mask = 0;    // $2001
  private status = 0;  // $2002 (bits 7/6/5 only)
  private oamAddr = 0; // $2003
  private readonly oam = new Uint8Array(256);
  private readonly palette = new Uint8Array(32);

  // loopy registers
  private v = 0; // current VRAM address (15 bits)
  private t = 0; // temporary VRAM address
  private x = 0; // fine X scroll (3 bits)
  private w = 0; // first/second write toggle

  private readBuffer = 0; // $2007 read latch
  private nmiPending = false;

  // scratch line buffers (bg: palette index 1..15, 0 = transparent;
  // sprite: 0x80 present | 0x40 behind-bg | pen 1..15)
  private readonly bgLine = new Uint8Array(256);
  private readonly sprLine = new Uint8Array(256);
  private readonly tileBuf = new Uint8Array(33 * 8);

  constructor(host: PpuHost) {
    this.host = host;
  }

  reset(): void {
    this.ctrl = 0;
    this.mask = 0;
    this.status = 0;
    this.oamAddr = 0;
    this.v = 0;
    this.t = 0;
    this.x = 0;
    this.w = 0;
    this.readBuffer = 0;
    this.nmiPending = false;
    this.oam.fill(0);
    this.palette.fill(0);
  }

  renderingEnabled(): boolean {
    return (this.mask & 0x18) !== 0;
  }

  // -------------------------------------------------------------------------
  // CPU register file ($2000-$3FFF mirrors every 8 bytes)

  readReg(addr: number): number {
    switch (addr & 7) {
      case 2: { // PPUSTATUS: read clears the vblank flag and the w toggle
        const result = this.status & 0xe0;
        this.status &= 0x7f;
        this.w = 0;
        return result;
      }
      case 4: // OAMDATA (no increment on read)
        return this.oam[this.oamAddr];
      case 7: { // PPUDATA: buffered below $3F00, direct for palette
        const a = this.v & 0x3fff;
        let result: number;
        if ((a & 0x3f00) === 0x3f00) {
          result = this.palette[paletteIndex(a)];
          this.readBuffer = this.host.ntRead(a & 0x0fff); // nametable underneath
        } else {
          result = this.readBuffer;
          this.readBuffer = a < 0x2000 ? this.host.chrRead(a) : this.host.ntRead(a & 0x0fff);
        }
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7fff;
        return result;
      }
      default: // write-only registers: open bus, not modeled
        return 0;
    }
  }

  writeReg(addr: number, data: number): void {
    data &= 0xff;
    switch (addr & 7) {
      case 0: { // PPUCTRL
        const prev = this.ctrl;
        this.ctrl = data;
        this.t = (this.t & ~0x0c00) | ((data & 0x03) << 10);
        // enabling NMI while the vblank flag is already set retriggers
        if ((data & 0x80) && !(prev & 0x80) && (this.status & 0x80)) this.nmiPending = true;
        break;
      }
      case 1: // PPUMASK
        this.mask = data;
        break;
      case 3: // OAMADDR
        this.oamAddr = data;
        break;
      case 4: // OAMDATA
        this.writeOam(data);
        break;
      case 5: // PPUSCROLL (x2)
        if (this.w === 0) {
          this.t = (this.t & ~0x001f) | (data >> 3);
          this.x = data & 0x07;
          this.w = 1;
        } else {
          this.t = (this.t & 0x0c1f) | ((data & 0x07) << 12) | ((data & 0xf8) << 2);
          this.w = 0;
        }
        break;
      case 6: // PPUADDR (x2)
        if (this.w === 0) {
          this.t = (this.t & 0x00ff) | ((data & 0x3f) << 8);
          this.w = 1;
        } else {
          this.t = (this.t & 0x7f00) | data;
          this.v = this.t;
          this.w = 0;
        }
        break;
      case 7: { // PPUDATA
        const a = this.v & 0x3fff;
        if ((a & 0x3f00) === 0x3f00) this.palette[paletteIndex(a)] = data & 0x3f;
        else if (a < 0x2000) this.host.chrWrite(a, data);
        else this.host.ntWrite(a & 0x0fff, data);
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7fff;
        break;
      }
    }
  }

  /** $4014 OAM DMA lands each byte here (OAMDATA path, increments oamAddr). */
  writeOam(data: number): void {
    this.oam[this.oamAddr] = data & 0xff;
    this.oamAddr = (this.oamAddr + 1) & 0xff;
  }

  // -------------------------------------------------------------------------
  // frame timing hooks (driven by the board)

  /** Board calls this at scanline 241. */
  startVblank(): void {
    this.status |= 0x80;
    if (this.ctrl & 0x80) this.nmiPending = true;
  }

  /**
   * Board calls this at scanline 261 (pre-render): clears vblank, sprite-0
   * and overflow; when rendering is enabled, reloads the scroll bits from t
   * (the hardware's dot-257 horizontal + dots-280-304 vertical copies both
   * land on the pre-render line, so this is a full t->v copy) and counts a
   * scanline for the MMC3 (line 261 fetches too).
   */
  preRender(): void {
    this.status &= 0x1f;
    if (this.renderingEnabled()) {
      this.v = this.t;
      this.host.scanlineTick();
    }
  }

  /** Returns-and-clears a pending NMI. */
  takeNmi(): boolean {
    const pending = this.nmiPending;
    this.nmiPending = false;
    return pending;
  }

  // -------------------------------------------------------------------------
  // scanline rendering (visible lines 0..239)

  renderLine(line: number, fb: Uint32Array): void {
    const out = line << 8;
    const emBase = (this.mask & 0xe0) << 1; // (mask >> 5) * 64
    const grayMask = (this.mask & 0x01) ? 0x30 : 0x3f;

    if (!this.renderingEnabled()) {
      // backdrop fill; the "palette hack": with v parked in $3F00-$3FFF the
      // PPU shows that entry instead of the universal background
      const a = this.v & 0x3fff;
      const ci = (a & 0x3f00) === 0x3f00 ? this.palette[paletteIndex(a)] : this.palette[0];
      const rgba = NES_PALETTE[emBase + (ci & grayMask)];
      for (let px = 0; px < 256; px++) fb[out + px] = rgba;
      return;
    }

    const bg = this.bgLine;
    bg.fill(0);
    if (this.mask & 0x08) {
      this.renderBackground(bg);
      if (!(this.mask & 0x02)) for (let px = 0; px < 8; px++) bg[px] = 0; // L8 bg clip
    }

    const spr = this.sprLine;
    spr.fill(0);
    this.evaluateSprites(line, bg, spr);

    const pal = this.palette;
    for (let px = 0; px < 256; px++) {
      const s = spr[px];
      const b = bg[px];
      const idx = (s & 0x80) && (b === 0 || !(s & 0x40)) ? 0x10 | (s & 0x0f) : b;
      fb[out + px] = NES_PALETTE[emBase + (pal[idx] & grayMask)];
    }

    // end-of-line scroll updates: Y increment, then the dot-257 horizontal
    // copy from t
    this.v = incrementY(this.v);
    this.v = (this.v & ~0x041f) | (this.t & 0x041f);
    this.host.scanlineTick(); // MMC3 A12-rise HLE (sprite-fetch phase)
  }

  /** 33 tile fetches from v + fine-x into a 264px strip, then window 256. */
  private renderBackground(bg: Uint8Array): void {
    let v = this.v;
    const fineY = (v >> 12) & 0x07;
    const table = (this.ctrl & 0x10) << 8; // bg pattern table: 0 or $1000
    const buf = this.tileBuf;
    const host = this.host;

    for (let tile = 0; tile < 33; tile++) {
      const nt = host.ntRead(v & 0x0fff);
      const attr = host.ntRead(0x03c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07));
      const shift = ((v >> 4) & 0x04) | (v & 0x02); // attribute quadrant
      const palBits = ((attr >> shift) & 0x03) << 2;
      const pa = table + (nt << 4) + fineY;
      const lo = host.chrRead(pa);
      const hi = host.chrRead(pa + 8);
      const o = tile << 3;
      for (let px = 0; px < 8; px++) {
        const bit = 7 - px;
        const pat = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        buf[o + px] = pat ? palBits | pat : 0;
      }
      // coarse X increment with horizontal-nametable flip
      if ((v & 0x001f) === 0x001f) v = (v & ~0x001f) ^ 0x0400;
      else v++;
    }

    const fineX = this.x;
    for (let px = 0; px < 256; px++) bg[px] = buf[px + fineX];
  }

  /**
   * In-order OAM scan for this line (8-sprite limit -> overflow on the 9th),
   * front-most sprite wins per pixel. OAM stores Y-1: a sprite with OAM y=Y
   * covers lines Y+1..Y+height.
   */
  private evaluateSprites(line: number, bg: Uint8Array, spr: Uint8Array): void {
    const height = (this.ctrl & 0x20) ? 16 : 8;
    const visible = (this.mask & 0x10) !== 0;
    const showLeft = (this.mask & 0x04) !== 0;
    const bothLayers = (this.mask & 0x18) === 0x18;
    const oam = this.oam;
    const host = this.host;
    let found = 0;

    for (let i = 0; i < 64; i++) {
      let row = line - 1 - oam[i << 2];
      if (row < 0 || row >= height) continue;
      if (found === 8) { this.status |= 0x20; break; } // sprite overflow
      found++;
      if (!visible) continue; // evaluation (overflow) still counts

      const tile = oam[(i << 2) | 1];
      const attr = oam[(i << 2) | 2];
      const sx = oam[(i << 2) | 3];
      if (attr & 0x80) row = height - 1 - row; // flip V
      let pa: number;
      if (height === 16) { // 8x16: pattern table from tile bit 0
        let tl = tile & 0xfe;
        if (row >= 8) { tl++; row -= 8; }
        pa = ((tile & 0x01) << 12) + (tl << 4) + row;
      } else {
        pa = ((this.ctrl & 0x08) << 9) + (tile << 4) + row;
      }
      const lo = host.chrRead(pa);
      const hi = host.chrRead(pa + 8);
      const flipH = (attr & 0x40) !== 0;
      const penBase = (attr & 0x03) << 2;
      const behind = (attr & 0x20) ? 0x40 : 0;

      for (let px = 0; px < 8; px++) {
        const xpos = sx + px;
        if (xpos > 255) break;
        if (xpos < 8 && !showLeft) continue; // L8 sprite clip
        const bit = flipH ? px : 7 - px;
        const pat = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
        if (pat === 0) continue;
        // sprite-0 hit: opaque sprite-0 pixel over opaque bg, x != 255
        if (i === 0 && bothLayers && bg[xpos] !== 0 && xpos !== 255) this.status |= 0x40;
        if (spr[xpos] & 0x80) continue; // a lower-index sprite already owns it
        spr[xpos] = 0x80 | behind | penBase | pat;
      }
    }
  }

  // -------------------------------------------------------------------------

  snapshot(): Record<string, unknown> {
    return {
      v: this.v, t: this.t, x: this.x,
      ctrl: this.ctrl, mask: this.mask, status: this.status,
    };
  }
}
