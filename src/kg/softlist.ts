// MAME software-list (hash/*.xml) extractor. Zero-dep, purpose-built scanner
// in the same spirit as the history.xml extractor in gen/generate.ts: the
// lists are machine-written, highly regular XML — targeted regex + block
// slicing extracts them with full fidelity, no DOM needed.
//
// The output is the generated cart catalog (dist/<machine>/softlist.json):
// the browser identifies user-dropped cartridge files by CRC32 against it.

export interface SoftRom {
  /** chip size in bytes */
  size: number;
  /** crc32, lowercase 8-hex */
  crc: string;
  /** load offset within the dataarea (hex in the XML) */
  offset: number;
}

export interface SoftArea {
  /** total dataarea size in bytes */
  size: number;
  /** real dumped chips only: fill/reload directives and nodumps are skipped */
  roms: SoftRom[];
}

export interface SoftEntry {
  name: string;
  description: string;
  year: string;
  publisher: string;
  cloneof?: string;
  /** MAME slot-device option — the mapper/PCB selector ("nrom", "txrom", ...) */
  slot: string;
  /** human board name ("NES-NROM-256") */
  pcb?: string;
  mirroring?: string;
  prg: SoftArea;
  chr?: SoftArea;
  /** RAM sizes in bytes, when declared */
  vram?: number;
  wram?: number;
  bwram?: number;
}

export interface SoftCatalog {
  /** list short-name ("nes") */
  list: string;
  /** list description ("Nintendo Entertainment System cartridges") */
  description: string;
  /** part interface ("nes_cart") */
  interface: string;
  entries: SoftEntry[];
  /** crc of an entry's FIRST prg rom -> entry indices (clones share dumps) */
  crcIndex: Record<string, number[]>;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, m => ENTITIES[m]);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/** Sizes appear as decimal ("32768") or hex ("0x80000"); offsets are hex. */
function parseSize(v: string | undefined): number {
  if (!v) return 0;
  return /^0x/i.test(v) ? parseInt(v.slice(2), 16) : parseInt(v, 10);
}

function parseOffset(v: string | undefined): number {
  if (!v) return 0;
  return parseInt(v.replace(/^0x/i, ''), 16);
}

function element(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? unescapeXml(m[1].trim()) : undefined;
}

export interface ParsedSoftwareList {
  name: string;
  description: string;
  interface: string;
  entries: (SoftEntry & { compatibility?: string })[];
}

export function parseSoftwareList(xml: string): ParsedSoftwareList {
  const head = /<softwarelist\b[^>]*>/.exec(xml);
  const headAttrs = head ? attrs(head[0]) : {};
  const out: ParsedSoftwareList = {
    name: headAttrs.name ?? '',
    description: headAttrs.description ?? '',
    interface: '',
    entries: [],
  };

  const swRe = /<software\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = swRe.exec(xml)) !== null) {
    const end = xml.indexOf('</software>', m.index);
    if (end < 0) continue;
    const block = xml.slice(m.index, end);
    swRe.lastIndex = end;
    const swAttrs = attrs(m[0]);

    const partM = /<part\b[^>]*>/.exec(block);
    if (!partM) continue;
    const partAttrs = attrs(partM[0]);
    if (!out.interface && partAttrs.interface) out.interface = partAttrs.interface;

    const entry: SoftEntry & { compatibility?: string } = {
      name: swAttrs.name ?? '',
      description: element(block, 'description') ?? '',
      year: element(block, 'year') ?? '',
      publisher: element(block, 'publisher') ?? '',
      slot: '',
      prg: { size: 0, roms: [] },
    };
    if (swAttrs.cloneof) entry.cloneof = swAttrs.cloneof;

    for (const fm of block.matchAll(/<feature\s+name="(slot|pcb|mirroring)"\s+value="([^"]*)"/g)) {
      if (fm[1] === 'slot') entry.slot = fm[2];
      else if (fm[1] === 'pcb') entry.pcb = fm[2];
      else entry.mirroring = fm[2];
    }
    const shared = /<sharedfeat\s+name="compatibility"\s+value="([^"]*)"/.exec(block);
    if (shared) entry.compatibility = shared[1];

    const areaRe = /<dataarea\b[^>]*>/g;
    let am: RegExpExecArray | null;
    while ((am = areaRe.exec(block)) !== null) {
      const selfClosing = am[0].endsWith('/>');
      let areaBlock = '';
      if (!selfClosing) {
        const areaEnd = block.indexOf('</dataarea>', am.index);
        if (areaEnd < 0) continue;
        areaBlock = block.slice(am.index, areaEnd);
        areaRe.lastIndex = areaEnd;
      }
      const aAttrs = attrs(am[0]);
      const size = parseSize(aAttrs.size);
      const areaName = aAttrs.name;
      if (areaName === 'vram') { entry.vram = size; continue; }
      if (areaName === 'wram') { entry.wram = size; continue; }
      if (areaName === 'bwram') { entry.bwram = size; continue; }
      if (areaName !== 'prg' && areaName !== 'chr') continue;
      const area: SoftArea = { size, roms: [] };
      for (const rm of areaBlock.matchAll(/<rom\b[^>]*\/>/g)) {
        const rAttrs = attrs(rm[0]);
        // fill/reload/continue are load directives, not chips; nodumps have
        // no crc to match against. baddumps keep their crc — still the bytes
        // a real cart dump will carry.
        if (rAttrs.loadflag) continue;
        if (rAttrs.status === 'nodump') continue;
        if (!rAttrs.crc) continue;
        area.roms.push({
          size: parseSize(rAttrs.size),
          crc: rAttrs.crc.toLowerCase(),
          offset: parseOffset(rAttrs.offset),
        });
      }
      if (areaName === 'prg') entry.prg = area;
      else entry.chr = area;
    }

    out.entries.push(entry);
  }
  return out;
}

/**
 * Apply a SOFTWARE_LIST set_filter expression and build the CRC index.
 * Filter semantics (softlist_dev.cpp): "!X" excludes entries whose
 * compatibility sharedfeat contains X; bare "X" keeps only those that do.
 * Entries without the sharedfeat always pass a "!X" filter and never pass
 * a bare "X" one.
 */
export function buildCatalog(parsed: ParsedSoftwareList, filter?: string): SoftCatalog {
  let entries = parsed.entries;
  if (filter) {
    const negate = filter.startsWith('!');
    const token = negate ? filter.slice(1) : filter;
    entries = entries.filter(e => {
      const has = (e.compatibility ?? '').split(',').map(s => s.trim()).includes(token);
      return negate ? !has : has;
    });
  }
  const clean: SoftEntry[] = entries.map(({ compatibility: _drop, ...rest }) => rest);
  const crcIndex: Record<string, number[]> = {};
  clean.forEach((e, i) => {
    const first = e.prg.roms[0];
    if (!first) return;
    (crcIndex[first.crc] ??= []).push(i);
  });
  return {
    list: parsed.name,
    description: parsed.description,
    interface: parsed.interface,
    entries: clean,
    crcIndex,
  };
}
