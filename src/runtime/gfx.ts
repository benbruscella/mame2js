// Generic MAME gfx element decoder.
//
// Faithful port of the decode semantics of src/emu/drawgfx.cpp
// (gfx_element::decode): each element occupies `charIncrement` BITS in the
// source region starting at element*charIncrement.  For every pixel (x,y)
// and plane p, the source bit sits at
//     element*charIncrement + planeOffsets[p] + yOffsets[y] + xOffsets[x]
// (all in bits), read MSB-first within each byte (0x80 >> (off & 7)).
// Plane 0 contributes the MOST significant bit of the decoded pixel value
// (planebit = 1 << (planes - 1 - p)), exactly as MAME does.
//
// RGN_FRAC(a,b) offsets (as used in gfx_layout tables) resolve against the
// size of the source region: floor(regionBits * a / b), with an optional
// "+n" / "-n" bit adjustment suffix (e.g. "RGN_FRAC(1,2)+4").
// A `total` of "RGN_FRAC(a,b)" means floor(regionBits*a/b) / charIncrement
// elements (so "RGN_FRAC(1,1)" = regionBytes*8/charIncrement).

export interface GfxLayout {
  width: number;
  height: number;
  total: number | string;           // element count, or "RGN_FRAC(a,b)"
  planes: number;
  planeOffsets: (number | string)[]; // bit offsets (may be "RGN_FRAC(a,b)+n")
  xOffsets: (number | string)[];     // bit offsets per column
  yOffsets: (number | string)[];     // bit offsets per row
  charIncrement: number;             // bits per element
}

export interface GfxSet {
  count: number;
  width: number;
  height: number;
  /** count*width*height pixel indices, each 0..(1<<planes)-1, row-major per element. */
  pixels: Uint8Array;
}

const RGN_FRAC_RE = /^RGN_FRAC\((\d+),(\d+)\)(?:\s*([+-])\s*(\d+))?$/;

/** Resolve a layout offset (number, or "RGN_FRAC(a,b)" with optional "+n"/"-n") to bits. */
function resolveOffset(value: number | string, regionBits: number): number {
  if (typeof value === 'number') return value;
  const m = RGN_FRAC_RE.exec(value.trim());
  if (!m) throw new Error(`gfx: cannot parse offset "${value}"`);
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (den === 0) throw new Error(`gfx: RGN_FRAC denominator is 0 in "${value}"`);
  let bits = Math.floor((regionBits * num) / den);
  if (m[3] !== undefined) {
    const adj = Number(m[4]);
    bits += m[3] === '-' ? -adj : adj;
  }
  return bits;
}

export function decodeGfx(layout: GfxLayout, rom: Uint8Array, byteOffset = 0): GfxSet {
  const regionBits = rom.length * 8;
  const { width, height, planes, charIncrement } = layout;

  const count = typeof layout.total === 'string'
    ? Math.floor(resolveOffset(layout.total, regionBits) / charIncrement)
    : layout.total;

  if (layout.xOffsets.length < width) throw new Error('gfx: xOffsets shorter than width');
  if (layout.yOffsets.length < height) throw new Error('gfx: yOffsets shorter than height');
  if (layout.planeOffsets.length < planes) throw new Error('gfx: planeOffsets shorter than planes');

  const planeOffs = new Int32Array(planes);
  for (let p = 0; p < planes; p++) planeOffs[p] = resolveOffset(layout.planeOffsets[p]!, regionBits);
  const xOffs = new Int32Array(width);
  for (let x = 0; x < width; x++) xOffs[x] = resolveOffset(layout.xOffsets[x]!, regionBits);
  const yOffs = new Int32Array(height);
  for (let y = 0; y < height; y++) yOffs[y] = resolveOffset(layout.yOffsets[y]!, regionBits);

  const pixels = new Uint8Array(count * width * height);

  for (let elem = 0; elem < count; elem++) {
    const base = byteOffset * 8 + elem * charIncrement;
    const dstBase = elem * width * height;
    for (let p = 0; p < planes; p++) {
      const planebit = 1 << (planes - 1 - p);       // plane 0 = MSB, per MAME
      const po = base + planeOffs[p]!;
      for (let y = 0; y < height; y++) {
        const yo = po + yOffs[y]!;
        const dstRow = dstBase + y * width;
        for (let x = 0; x < width; x++) {
          const off = yo + xOffs[x]!;
          if (rom[off >> 3]! & (0x80 >> (off & 7))) pixels[dstRow + x] = pixels[dstRow + x]! | planebit;
        }
      }
    }
  }

  return { count, width, height, pixels };
}
