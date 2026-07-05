// Keyboard -> input port state. Ports are active low (bit set = released),
// matching the raw hardware values the 51xx / DSW handlers expect.

import type { InputPorts } from './types.ts';
import type { RangeSpec, ReadHandler } from './bus.ts';

/**
 * Build read handlers for the generated "port.<TAG>" keys (from .portr()
 * entries in the address map): each returns the live active-low port byte.
 */
export function portHandlers(ranges: RangeSpec[], inputs: InputPorts): Record<string, ReadHandler> {
  const out: Record<string, ReadHandler> = {};
  for (const r of ranges) {
    if (r.read?.startsWith('port.')) {
      const tag = r.read.slice('port.'.length);
      out[r.read] = () => inputs.read(tag);
    }
  }
  return out;
}

export interface FieldBinding {
  port: string;   // "IN0", "IN1", ...
  mask: number;
  /** DOM KeyboardEvent.code values that activate this field */
  keys: string[];
  label: string;
}

export interface DipDefault { port: string; mask: number; value: number; name: string }

export class KeyboardInput implements InputPorts {
  private state: Record<string, number> = {};
  private dips: Record<string, number> = {};
  private byKey = new Map<string, { port: string; mask: number }[]>();

  constructor(bindings: FieldBinding[], dipDefaults: DipDefault[], ports: string[]) {
    for (const p of ports) { this.state[p] = 0xff; this.dips[p] = 0; }
    for (const d of dipDefaults) {
      this.dips[d.port] = ((this.dips[d.port] ?? 0) & ~d.mask) | (d.value & d.mask);
    }
    for (const b of bindings) {
      for (const key of b.keys) {
        let list = this.byKey.get(key);
        if (!list) { list = []; this.byKey.set(key, list); }
        list.push({ port: b.port, mask: b.mask });
      }
    }
  }

  attach(target: EventTarget): void {
    target.addEventListener('keydown', ev => this.onKey(ev as KeyboardEvent, true));
    target.addEventListener('keyup', ev => this.onKey(ev as KeyboardEvent, false));
    // keyup events are lost when focus leaves (OS shortcuts — notably
    // Ctrl+Arrow on macOS — tab switches, screenshots): release everything
    // or keys stay latched ("sticky" input)
    target.addEventListener('blur', () => this.releaseAll());
    target.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }

  /** release every non-DIP input (active low ⇒ all bits set) */
  releaseAll(): void {
    for (const port of Object.keys(this.state)) this.state[port] = 0xff;
  }

  private onKey(ev: KeyboardEvent, down: boolean): void {
    const hits = this.byKey.get(ev.code);
    if (!hits) return;
    ev.preventDefault();
    for (const h of hits) {
      // active low: pressed = bit cleared
      if (down) this.state[h.port] &= ~h.mask;
      else this.state[h.port] |= h.mask;
    }
  }

  /** DIP switch ports return configured values; others live key state */
  read(tag: string): number {
    if (tag in this.dips && tag.startsWith('DSW')) return this.dips[tag];
    return this.state[tag] ?? 0xff;
  }

  setDip(port: string, mask: number, value: number): void {
    this.dips[port] = (this.dips[port] & ~mask) | (value & mask);
  }
}
