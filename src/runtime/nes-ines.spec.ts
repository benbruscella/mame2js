// Self-test for iNES header parsing + softlist-catalog identification.
// Run with: node src/runtime/nes-ines.spec.ts

import { parseINes, identify, type SoftCatalog, type SoftEntry } from './nes-ines.ts';
import { crc32 } from './zip.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    totalPass++;
  } else {
    totalFail++;
    console.log(`  FAIL ${label}: got ${a}, want ${e}`);
  }
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

/** build a synthetic .nes file */
function makeINes(opts: {
  prgBanks: number; chrBanks: number; flags6?: number; flags7?: number;
  byte8?: number; dirtyTail?: boolean; trainer?: boolean;
  prgFill?: (i: number) => number; chrFill?: (i: number) => number;
}): Uint8Array {
  const prgSize = opts.prgBanks * 0x4000;
  const chrSize = opts.chrBanks * 0x2000;
  const trainerSize = opts.trainer ? 512 : 0;
  const out = new Uint8Array(16 + trainerSize + prgSize + chrSize);
  out.set([0x4e, 0x45, 0x53, 0x1a]);
  out[4] = opts.prgBanks;
  out[5] = opts.chrBanks;
  out[6] = (opts.flags6 ?? 0) | (opts.trainer ? 0x04 : 0);
  out[7] = opts.flags7 ?? 0;
  out[8] = opts.byte8 ?? 0;
  if (opts.dirtyTail) out.set([0x44, 0x75, 0x64, 0x65], 12); // "Dude"
  for (let i = 0; i < prgSize; i++) out[16 + trainerSize + i] = opts.prgFill ? opts.prgFill(i) : (i * 7) & 0xff;
  for (let i = 0; i < chrSize; i++) out[16 + trainerSize + prgSize + i] = opts.chrFill ? opts.chrFill(i) : (i * 13) & 0xff;
  return out;
}

// --- header parsing ---------------------------------------------------------
{
  const f = makeINes({ prgBanks: 2, chrBanks: 1, flags6: 0x01 });
  const p = parseINes(f)!;
  eq('nrom parse ok', p !== null, true);
  eq('prg size', p.prgSize, 0x8000);
  eq('chr size', p.chrSize, 0x2000);
  eq('mapper 0', p.mapper, 0);
  eq('vertical mirroring', p.mirroring, 'vertical');
  eq('no battery', p.battery, false);
  eq('prg slice', [p.prg.length, p.prg[0], p.prg[1]], [0x8000, 0, 7]);
  eq('chr slice', [p.chr!.length, p.chr![0], p.chr![1]], [0x2000, 0, 13]);
}
{
  const p = parseINes(makeINes({ prgBanks: 1, chrBanks: 0, flags6: 0x42 | (4 << 4), flags7: 0x40 }))!;
  eq('mapper high nibble from byte 7', p.mapper, 68);
  eq('battery flag', p.battery, true);
  eq('chr-ram cart has null chr', p.chr, null);
  eq('horizontal mirroring', p.mirroring, 'horizontal');
}
{
  const p = parseINes(makeINes({ prgBanks: 1, chrBanks: 0, flags6: 4 << 4, flags7: 0x40, dirtyTail: true }))!;
  eq('dirty header: byte 7 ignored', p.mapper, 4);
}
{
  const p = parseINes(makeINes({ prgBanks: 1, chrBanks: 0, flags6: 0, flags7: 0x08 | 0x10, byte8: 0x02 }))!;
  eq('nes2 detected', p.nes2, true);
  eq('nes2 12-bit mapper', p.mapper, 0x210); // byte7 hi nibble 0x10 | byte8 low nibble 2 << 8
}
{
  const p = parseINes(makeINes({ prgBanks: 1, chrBanks: 1, flags6: 0x08 }))!;
  eq('four-screen flag wins', p.mirroring, 'four');
}
{
  const withTrainer = makeINes({ prgBanks: 1, chrBanks: 0, trainer: true, prgFill: () => 0xab });
  const p = parseINes(withTrainer)!;
  eq('trainer skipped', p.prg[0], 0xab);
  eq('trainer flag', p.trainer, true);
}
{
  eq('wrong magic -> null', parseINes(new Uint8Array(32).fill(0x4e)), null);
  eq('truncated -> null', parseINes(makeINes({ prgBanks: 2, chrBanks: 1 }).subarray(0, 100)), null);
  const trailing = makeINes({ prgBanks: 1, chrBanks: 1 });
  const padded = new Uint8Array(trailing.length + 128);
  padded.set(trailing);
  eq('trailing bytes tolerated', parseINes(padded) !== null, true);
}

// --- identification -----------------------------------------------------------
{
  const smbFile = makeINes({ prgBanks: 2, chrBanks: 1, flags6: 0x01 });
  const smbParsed = parseINes(smbFile)!;
  const smbPrgCrc = hex8(crc32(smbParsed.prg));
  const smbChrCrc = hex8(crc32(smbParsed.chr!));

  // multi-chip entry: two 16K prg chips whose concatenation = our prg slice
  const half0 = hex8(crc32(smbParsed.prg.subarray(0, 0x4000)));
  const half1 = hex8(crc32(smbParsed.prg.subarray(0x4000)));

  const entries: SoftEntry[] = [
    { name: 'smb', description: 'Super Mario Bros.', year: '1985', publisher: 'Nintendo', slot: 'nrom',
      prg: { size: 0x8000, roms: [{ size: 0x8000, crc: smbPrgCrc, offset: 0 }] },
      chr: { size: 0x2000, roms: [{ size: 0x2000, crc: smbChrCrc, offset: 0 }] } },
    { name: 'smbc', cloneof: 'smb', description: 'SMB (multichip rev)', year: '1985', publisher: 'Nintendo', slot: 'nrom',
      prg: { size: 0x8000, roms: [{ size: 0x4000, crc: half0, offset: 0 }, { size: 0x4000, crc: half1, offset: 0x4000 }] },
      chr: { size: 0x2000, roms: [{ size: 0x2000, crc: smbChrCrc, offset: 0 }] } },
    { name: 'mmc3game', description: 'Some MMC3 Game', year: '1990', publisher: 'X', slot: 'txrom',
      prg: { size: 0x4000, roms: [{ size: 0x4000, crc: half0, offset: 0 }] } },
  ];
  const crcIndex: Record<string, number[]> = {};
  entries.forEach((e, i) => { (crcIndex[e.prg.roms[0].crc] ??= []).push(i); });
  const catalog: SoftCatalog = { list: 'nes', description: 'test', interface: 'nes_cart', entries, crcIndex };
  const support = { slots: ['nrom', 'uxrom', 'cnrom', 'sxrom', 'txrom'], games: ['smb'] };

  const r = identify(smbParsed, catalog, support);
  eq('exact match found', r.meta?.name, 'smb');
  eq('exact not approx', r.approx, false);
  eq('slot from catalog', r.slot, 'nrom');
  eq('allowlisted title tested', r.tier, 'tested');
  eq('allowlisted title supported', r.supported, true);
  eq('tested is playable', r.playable, true);
  eq('prg crc exposed', r.prgCrc, smbPrgCrc);

  // clone matching via the multi-chip entry: remove the single-chip entry's
  // index so the multichip one is the only candidate
  const cat2: SoftCatalog = { ...catalog, entries: entries.slice(1), crcIndex: (() => {
    const ix: Record<string, number[]> = {};
    entries.slice(1).forEach((e, i) => { (ix[e.prg.roms[0].crc] ??= []).push(i); });
    return ix;
  })() };
  const r2 = identify(smbParsed, cat2, support);
  eq('multi-chip sub-slice match', r2.meta?.name, 'smbc');
  eq('clone of allowlisted parent supported', r2.supported, true);

  // chr mismatch -> approx prg-only match
  const otherChr = makeINes({ prgBanks: 2, chrBanks: 1, flags6: 0x01, chrFill: i => (i * 31) & 0xff });
  const r3 = identify(parseINes(otherChr)!, catalog, support);
  eq('prg-only match approx', [r3.meta?.name, r3.approx], ['smb', true]);

  // unknown dump on a SUPPORTED mapper (0=nrom): experimental, playable
  const unknown = makeINes({ prgBanks: 1, chrBanks: 0, prgFill: i => (i * 3 + 1) & 0xff });
  const r4 = identify(parseINes(unknown)!, catalog, support);
  eq('unknown dump unmatched', r4.identified, false);
  eq('unknown-but-supported-mapper -> experimental', r4.tier, 'experimental');
  eq('experimental is playable', r4.playable, true);
  eq('experimental not "supported" badge', r4.supported, false);

  // known (catalog) but not allowlisted, supported mapper -> experimental
  const mmc3File = makeINes({ prgBanks: 1, chrBanks: 0, flags6: 4 << 4, prgFill: i => (i * 7) & 0xff });
  const r5 = identify(parseINes(mmc3File)!, catalog, support);
  eq('known title matched', r5.meta?.name, 'mmc3game');
  eq('identified + supported mapper -> experimental', r5.tier, 'experimental');
  eq('experimental reason', r5.reason, 'runs on a supported board — not yet verified');

  // unsupported mapper number (66 = gxrom, not in MAPPER_SLOTS), no catalog
  const m66 = parseINes(makeINes({ prgBanks: 1, chrBanks: 0, flags6: 2 << 4, flags7: 0x40 }))!;
  const r6 = identify(m66, null, support);
  eq('mapper 66 number', r6.mapper, 66);
  eq('no catalog: unknown mapper -> null slot', r6.slot, null);
  eq('mapper 66 unsupported', r6.tier, 'unsupported');
  eq('unsupported not playable', r6.playable, false);
  eq('mapper reason', r6.reason, 'unrecognized dump — mapper 66 not supported');
}

console.log(`\nnes-ines.spec: ${totalPass} passed, ${totalFail} failed`);
if (totalFail > 0) process.exitCode = 1;
