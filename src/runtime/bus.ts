// Generic Z80 memory bus built from generated address-range descriptors.
// Dispatch is a flat 64k handler-id table + handler arrays — one indexed load
// and one call per access, fast enough for ~10M accesses/sec with headroom.

export interface RangeSpec {
  start: number;
  end: number;
  mirror?: number;
  kind: 'rom' | 'ram' | 'handler' | 'nop';
  /** handler registry keys, e.g. "galaga_state.bosco_dsw_r" */
  read?: string;
  write?: string;
  /** shared RAM tag; ranges with the same share alias the same bytes */
  share?: string;
}

export type ReadHandler = (addr: number, offset: number) => number;
export type WriteHandler = (addr: number, offset: number, data: number) => void;

export interface HandlerRegistry {
  read: Record<string, ReadHandler>;
  write: Record<string, WriteHandler>;
}

const OPEN_BUS = 0xff;

export class Bus {
  private readId = new Uint8Array(0x10000);
  private writeId = new Uint8Array(0x10000);
  private readFns: ReadHandler[] = [() => OPEN_BUS];
  private writeFns: WriteHandler[] = [() => { /* open bus */ }];
  private base = new Uint32Array(0x10000);  // range base addr per address (for offset calc)
  /** shared RAM blocks by tag, so the machine/video can alias them */
  shares: Record<string, Uint8Array>;

  constructor(ranges: RangeSpec[], rom: Uint8Array, registry: HandlerRegistry, shares: Record<string, Uint8Array> = {}) {
    this.shares = shares;
    for (const r of ranges) {
      const size = r.end - r.start + 1;
      let read: ReadHandler | null = null;
      let write: WriteHandler | null = null;

      if (r.kind === 'rom') {
        // offset-based so mirror images read the same region bytes
        read = (_a, off) => rom[r.start + off];
      } else if (r.kind === 'ram') {
        const bytes = r.share
          ? (this.shares[r.share] ??= new Uint8Array(size))
          : new Uint8Array(size);
        read = (_a, off) => bytes[off];
        write = (_a, off, d) => { bytes[off] = d; };
        // a RAM range may still have a write handler override (e.g. videoram_w)
        if (r.write) {
          const h = registry.write[r.write];
          if (!h) throw new Error(`missing write handler: ${r.write}`);
          write = (a, off, d) => { bytes[off] = d; h(a, off, d); };
        }
      }
      if (r.kind === 'handler' || (r.kind !== 'ram' && (r.read || r.write))) {
        if (r.read) {
          const h = registry.read[r.read];
          if (!h) throw new Error(`missing read handler: ${r.read}`);
          read = h;
        }
        if (r.write) {
          const h = registry.write[r.write];
          if (!h) throw new Error(`missing write handler: ${r.write}`);
          write = h;
        }
      }

      const readIdx = read ? this.readFns.push(read) - 1 : 0;
      const writeIdx = write ? this.writeFns.push(write) - 1 : 0;
      if (readIdx > 255 || writeIdx > 255) throw new Error('too many bus handlers');

      const mirror = r.mirror ?? 0;
      // apply the range at each mirror image; the stored base includes the
      // mirror bits so handler offsets are always relative to the range start
      for (let m = 0; ; m = (m - mirror) & mirror) {
        const base = (r.start | m) & 0xffff;
        for (let a = r.start; a <= r.end; a++) {
          const ea = (a | m) & 0xffff;
          if (read) { this.readId[ea] = readIdx; this.base[ea] = (this.base[ea] & 0xffff0000) | base; }
          if (write) { this.writeId[ea] = writeIdx; this.base[ea] = (this.base[ea] & 0x0000ffff) | (base << 16); }
        }
        if (mirror === 0 || m === mirror) break;
      }
    }
  }

  read = (addr: number): number => {
    addr &= 0xffff;
    return this.readFns[this.readId[addr]](addr, addr - (this.base[addr] & 0xffff)) & 0xff;
  };

  write = (addr: number, data: number): void => {
    addr &= 0xffff;
    this.writeFns[this.writeId[addr]](addr, addr - (this.base[addr] >>> 16), data & 0xff);
  };

  /** io space: unused on this board family */
  in = (_port: number): number => OPEN_BUS;
  out = (_port: number, _data: number): void => { /* unused */ };
}
