// NES cartridge identification: iNES/NES2.0 header parsing + CRC32 matching
// against the generated softlist catalog (dist/nes/softlist.json, extracted
// from MAME hash/nes.xml). Pure functions — no DOM — so the whole module is
// Node-testable.
//
// A .nes file is header + [trainer] + PRG + CHR concatenated, while softlist
// CRCs are per-CHIP (prg/chr dataareas, possibly multiple chips per area) —
// so matching CRCs the prg/chr slices separately, sub-slicing multi-chip
// dataareas at each chip's declared size.

import { crc32 } from './zip.ts';
import { MAPPER_SLOTS, type Mirroring } from './nes-cart.ts';

export interface INesInfo {
  mapper: number;
  prgSize: number;
  chrSize: number;
  mirroring: Mirroring;
  battery: boolean;
  trainer: boolean;
  nes2: boolean;
  /** subarrays of the input — no copies */
  prg: Uint8Array;
  chr: Uint8Array | null;
}

/** Parse a 16-byte-header iNES / NES 2.0 file. Returns null when it isn't one. */
export function parseINes(bytes: Uint8Array): INesInfo | null {
  if (bytes.length < 16) return null;
  if (bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) return null;
  const prgSize = bytes[4] * 0x4000;
  const chrSize = bytes[5] * 0x2000;
  if (prgSize === 0) return null;
  const nes2 = (bytes[7] & 0x0c) === 0x08;
  // dirty-header guard: pre-NES2.0 dumps often carry "DiskDude!" garbage in
  // bytes 7-15 — when any of bytes 12-15 are nonzero, trust only the low nibble
  const dirty = !nes2 && (bytes[12] | bytes[13] | bytes[14] | bytes[15]) !== 0;
  let mapper = bytes[6] >> 4;
  if (!dirty) mapper |= bytes[7] & 0xf0;
  if (nes2) mapper |= (bytes[8] & 0x0f) << 8;
  const trainer = (bytes[6] & 0x04) !== 0;
  const dataStart = 16 + (trainer ? 512 : 0);
  if (dataStart + prgSize + chrSize > bytes.length) return null;
  const fourScreen = (bytes[6] & 0x08) !== 0;
  return {
    mapper,
    prgSize,
    chrSize,
    mirroring: fourScreen ? 'four' : bytes[6] & 0x01 ? 'vertical' : 'horizontal',
    battery: (bytes[6] & 0x02) !== 0,
    trainer,
    nes2,
    prg: bytes.subarray(dataStart, dataStart + prgSize),
    chr: chrSize ? bytes.subarray(dataStart + prgSize, dataStart + prgSize + chrSize) : null,
  };
}

// --- softlist catalog matching -------------------------------------------------

export interface SoftRom { size: number; crc: string; offset: number }
export interface SoftArea { size: number; roms: SoftRom[] }
export interface SoftEntry {
  name: string; description: string; year: string; publisher: string;
  cloneof?: string; slot: string; pcb?: string; mirroring?: string;
  prg: SoftArea; chr?: SoftArea; vram?: number; wram?: number; bwram?: number;
}
export interface SoftCatalog {
  list: string; description: string; interface: string;
  entries: SoftEntry[];
  crcIndex: Record<string, number[]>;
}

/**
 * Support tier for a resolved cart:
 * - 'tested'       — mapper implemented AND title on the verified allowlist -> plays with a VERIFIED badge
 * - 'experimental' — mapper implemented but the title isn't verified yet     -> plays, clearly flagged experimental
 * - 'unsupported'  — the cart's mapper isn't implemented                     -> cannot play
 */
export type CartTier = 'tested' | 'experimental' | 'unsupported';

export interface ResolvedCart {
  ines: INesInfo;
  /** matched softlist entry (undefined when the dump isn't catalogued) */
  meta?: SoftEntry;
  /** true when a catalog entry was matched */
  identified: boolean;
  /** slot/mapper family name; null when the mapper number has no known slot */
  slot: string | null;
  mapper: number;
  /** exact: every chip crc verified; prg-only matches are flagged approx */
  approx: boolean;
  tier: CartTier;
  /** playable at all (tested or experimental) */
  playable: boolean;
  /** true only for the verified allowlist tier (green badge / lit placeholder) */
  supported: boolean;
  reason?: string;
  prgCrc: string;
  chrCrc: string | null;
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/** distinct first-prg-chip sizes in a catalog, cached per catalog object */
const sizesCache = new WeakMap<SoftCatalog, number[]>();
function firstChipSizes(catalog: SoftCatalog): number[] {
  let sizes = sizesCache.get(catalog);
  if (!sizes) {
    const set = new Set<number>();
    for (const e of catalog.entries) if (e.prg.roms[0]) set.add(e.prg.roms[0].size);
    sizes = [...set];
    sizesCache.set(catalog, sizes);
  }
  return sizes;
}

/** CRC an area's chips against a byte slice: each chip at its declared size, in order. */
function areaMatches(area: SoftArea, bytes: Uint8Array): boolean {
  if (!area.roms.length) return false;
  let off = 0;
  for (const rom of area.roms) {
    if (off + rom.size > bytes.length) return false;
    if (hex8(crc32(bytes.subarray(off, off + rom.size))) !== rom.crc) return false;
    off += rom.size;
  }
  return off === bytes.length;
}

/**
 * Identify a parsed cart against the catalog + the machine's capability lists
 * (config.cart.slots = implemented mappers, config.cart.games = explicitly
 * verified titles; an entry counts when its name OR its parent is listed).
 */
export function identify(
  ines: INesInfo,
  catalog: SoftCatalog | null,
  support: { slots: string[]; games: string[] },
): ResolvedCart {
  const prgCrc = hex8(crc32(ines.prg));
  const chrCrc = ines.chr ? hex8(crc32(ines.chr)) : null;

  let meta: SoftEntry | undefined;
  let approx = false;
  if (catalog) {
    // candidates via the first-chip index: CRC the prg PREFIX at each distinct
    // first-chip size in the catalog (a handful: 16K/32K/128K/...), look each
    // prefix crc up, then verify every remaining chip slice
    const candidates = new Set<number>();
    for (const size of firstChipSizes(catalog)) {
      if (size > ines.prg.length) continue;
      const prefixCrc = size === ines.prg.length ? prgCrc : hex8(crc32(ines.prg.subarray(0, size)));
      for (const idx of catalog.crcIndex[prefixCrc] ?? []) {
        if (catalog.entries[idx].prg.roms[0]?.size === size) candidates.add(idx);
      }
    }
    let best: { entry: SoftEntry; exact: boolean } | undefined;
    for (const idx of candidates) {
      const entry = catalog.entries[idx];
      if (!areaMatches(entry.prg, ines.prg)) continue;
      const chrOk = entry.chr && entry.chr.roms.length
        ? ines.chr !== null && areaMatches(entry.chr, ines.chr)
        : ines.chr === null || !entry.chr;
      if (chrOk) { best = { entry, exact: true }; break; }
      best ??= { entry, exact: false }; // prg matches, chr differs — approx
    }
    if (best) { meta = best.entry; approx = !best.exact; }
  }

  const slot = meta?.slot ?? MAPPER_SLOTS[ines.mapper] ?? null;
  const slotOk = slot !== null && support.slots.includes(slot);
  const gameOk = meta !== undefined &&
    (support.games.includes(meta.name) || (meta.cloneof !== undefined && support.games.includes(meta.cloneof)));

  const tier: CartTier = !slotOk ? 'unsupported' : gameOk ? 'tested' : 'experimental';
  const playable = tier !== 'unsupported';
  const supported = tier === 'tested';
  let reason: string | undefined;
  if (tier === 'unsupported') {
    reason = !meta ? `unrecognized dump — mapper ${ines.mapper} not supported`
      : `mapper ${ines.mapper}${slot ? ` (${slot})` : ''} not yet supported`;
  } else if (tier === 'experimental') {
    reason = meta ? 'runs on a supported board — not yet verified' : 'unrecognized dump on a supported board — untested';
  }
  return { ines, meta, identified: meta !== undefined, slot, mapper: ines.mapper, approx, tier, playable, supported, reason, prgCrc, chrCrc };
}
