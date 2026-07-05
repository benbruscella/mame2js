// Domain parsers for the MAME macro DSLs. These are deliberately NOT a C++ AST:
// the machine description lives in highly regular declarative macros
// (ROM_START, address_map, INPUT_PORTS_START, gfx_layout, machine_config,
// GAME) that targeted parsers extract with full fidelity.

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Strip // and /* *​/ comments while preserving string literals. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const end = findStringEnd(src, i);
      out += src.slice(i, end + 1);
      i = end + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function findStringEnd(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '"') return i;
  }
  return src.length - 1;
}

/** Split on top-level commas (ignoring commas inside (), {}, "" ). */
export function splitArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      const end = findStringEnd(s, i);
      cur += s.slice(i, end + 1);
      i = end;
    } else if (c === '(' || c === '{' || c === '[') {
      depth++;
      cur += c;
    } else if (c === ')' || c === '}' || c === ']') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Find the matching close paren for the open paren at src[open]. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') i = findStringEnd(src, i);
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract the body of `void cls::name(argtype &x) { ... }`. */
function extractFunctionBody(src: string, headerRe: RegExp): { cls: string; name: string; body: string }[] {
  const results: { cls: string; name: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(src)) !== null) {
    const braceStart = src.indexOf('{', m.index + m[0].length - 1);
    if (braceStart < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < src.length; i++) {
      const c = src[i];
      if (c === '"') i = findStringEnd(src, i);
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    results.push({ cls: m[1], name: m[2], body: src.slice(braceStart + 1, end) });
  }
  return results;
}

/**
 * Evaluate a MAME clock/size arithmetic expression to a number.
 * Handles: hex/dec literals, digit separators (18'432'000), XTAL(n),
 * named constants supplied by the caller, + - * / and parens.
 * Returns null if the expression contains anything else.
 */
export function evalExpr(expr: string, consts: Record<string, number> = {}): number | null {
  let s = expr.replace(/'/g, '');
  // frequency user-defined literals: 18.432_MHz_XTAL, 32.768_kHz_XTAL, 100_Hz_XTAL
  s = s.replace(/([0-9]+(?:\.[0-9]+)?)_MHz_XTAL/g, (_, n) => String(Math.round(Number(n) * 1e6)));
  s = s.replace(/([0-9]+(?:\.[0-9]+)?)_kHz_XTAL/g, (_, n) => String(Math.round(Number(n) * 1e3)));
  s = s.replace(/([0-9]+(?:\.[0-9]+)?)_Hz_XTAL/g, (_, n) => String(Math.round(Number(n))));
  s = s.replace(/XTAL\s*\(\s*([0-9]+)\s*\)/g, '$1');
  for (const [name, val] of Object.entries(consts)) {
    s = s.replace(new RegExp(`\\b${name}\\b`, 'g'), String(val));
  }
  if (!/^[\s0-9a-fA-FxX+\-*/().]*$/.test(s)) return null;
  // recursive-descent evaluation, no eval()
  let pos = 0;
  const peek = () => { while (pos < s.length && /\s/.test(s[pos])) pos++; return s[pos]; };
  function parsePrimary(): number | null {
    const c = peek();
    if (c === '(') {
      pos++;
      const v = parseAddSub();
      if (peek() !== ')') return null;
      pos++;
      return v;
    }
    if (c === '-') { pos++; const v = parsePrimary(); return v === null ? null : -v; }
    const m = /^(0[xX][0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?)/.exec(s.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return Number(m[0]);
  }
  function parseMulDiv(): number | null {
    let v = parsePrimary();
    if (v === null) return null;
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') {
        pos++;
        const r = parsePrimary();
        if (r === null) return null;
        v = c === '*' ? v * r : v / r;
      } else return v;
    }
  }
  function parseAddSub(): number | null {
    let v = parseMulDiv();
    if (v === null) return null;
    for (;;) {
      const c = peek();
      if (c === '+' || c === '-') {
        pos++;
        const r = parseMulDiv();
        if (r === null) return null;
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  }
  const v = parseAddSub();
  peek();
  return pos >= s.length && v !== null && Number.isFinite(v) ? v : null;
}

/**
 * Collect numeric constants: `#define NAME (expr)` plus the modern
 * `static constexpr XTAL NAME(expr);` / `static constexpr int NAME = expr;`
 * forms (the galaxian driver uses the latter exclusively).
 */
export function parseDefines(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /^#define\s+(\w+)\s+(.+)$|(?:static\s+)?constexpr\s+(?:XTAL|int|unsigned|double|u?int\d+_t)\s+(\w+)\s*(?:\(([^;]*)\)|=\s*([^;]*))\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] ?? m[3];
    const expr = (m[2] ?? m[4] ?? m[5] ?? '').trim();
    if (!name || !expr) continue;
    const v = evalExpr(expr, out);
    if (v !== null) out[name] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GAME( year, name, parent, machine, input, class, init, monitor, company, fullname, flags )
// ---------------------------------------------------------------------------

export interface GameDef {
  year: string; name: string; parent: string; machine: string; input: string;
  cls: string; init: string; monitor: string; company: string; fullname: string; flags: string;
}

export function parseGames(src: string): GameDef[] {
  const out: GameDef[] = [];
  const re = /^\s*GAME[XL]?\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index);
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = splitArgs(src.slice(open + 1, close)).map(unquote);
    if (args.length < 10) continue;
    out.push({
      year: args[0], name: args[1], parent: args[2], machine: args[3], input: args[4],
      cls: args[5], init: args[6], monitor: args[7], company: args[8], fullname: args[9],
      flags: args.slice(10).join(', '),
    });
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

// ---------------------------------------------------------------------------
// ROM_START(name) ... ROM_END
// ---------------------------------------------------------------------------

export interface RomLoad {
  file: string; offset: number; size: number; crc: string; sha1: string; reloadOffsets: number[];
}
export interface RomRegionDef {
  tag: string; size: number; flags: string; loads: RomLoad[];
}
export interface RomSetDef { name: string; regions: RomRegionDef[]; }

export function parseRomSets(src: string): RomSetDef[] {
  const out: RomSetDef[] = [];
  const re = /ROM_START\(\s*(\w+)\s*\)([\s\S]*?)ROM_END/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const set: RomSetDef = { name: m[1], regions: [] };
    const body = m[2];
    const stmtRe = /(ROM_REGION|ROM_LOAD|ROM_RELOAD|ROM_CONTINUE|ROM_FILL)\s*\(/g;
    let sm: RegExpExecArray | null;
    let region: RomRegionDef | null = null;
    let lastLoad: RomLoad | null = null;
    while ((sm = stmtRe.exec(body)) !== null) {
      const open = body.indexOf('(', sm.index + sm[1].length - 1);
      const close = matchParen(body, open);
      if (close < 0) continue;
      const args = splitArgs(body.slice(open + 1, close));
      switch (sm[1]) {
        case 'ROM_REGION': {
          region = {
            size: evalExpr(args[0]) ?? 0,
            tag: unquote(args[1]),
            flags: args[2] ?? '',
            loads: [],
          };
          set.regions.push(region);
          break;
        }
        case 'ROM_LOAD': {
          if (!region) break;
          const crc = /CRC\(([0-9a-fA-F]+)\)/.exec(args[3] ?? '');
          const sha1 = /SHA1\(([0-9a-fA-F]+)\)/.exec(args[3] ?? '');
          lastLoad = {
            file: unquote(args[0]),
            offset: evalExpr(args[1]) ?? 0,
            size: evalExpr(args[2]) ?? 0,
            crc: crc ? crc[1] : '',
            sha1: sha1 ? sha1[1] : '',
            reloadOffsets: [],
          };
          region.loads.push(lastLoad);
          break;
        }
        case 'ROM_RELOAD': {
          if (lastLoad) lastLoad.reloadOffsets.push(evalExpr(args[0]) ?? 0);
          break;
        }
        default:
          break; // ROM_CONTINUE / ROM_FILL not needed for the galaga family yet
      }
    }
    out.push(set);
  }
  return out;
}

// ---------------------------------------------------------------------------
// address maps: void cls::name(address_map &map) { map(a,b).ram().w(FUNC(x))...; }
// ---------------------------------------------------------------------------

export interface HandlerRef {
  /** driver-state method, or device method */
  method: string;
  /** device class (e.g. namco_06xx_device) when the handler lives on a device */
  deviceClass?: string;
  /** device reference: member (m_foo) or "tag" it was attached to in the map */
  deviceRef?: string;
}

export interface AddressRangeDef {
  start: number; end: number; mirror?: number;
  rom?: boolean; ram?: boolean; writeonly?: boolean; nopw?: boolean; nopr?: boolean;
  read?: HandlerRef; write?: HandlerRef;
  /** input-port tag from .portr("IN0") / .portw(...) */
  portRead?: string; portWrite?: string;
  share?: string;
  raw: string;
}

export interface AddressMapDef {
  cls: string; name: string; ranges: AddressRangeDef[];
  /** helper maps composed in via `other_map(map);` calls, in statement order */
  calls: string[];
  globalMask?: number;
  unmapHigh?: boolean;
}

export function parseAddressMaps(src: string): AddressMapDef[] {
  const fns = extractFunctionBody(src, /void\s+(\w+)::(\w+)\(address_map\s*&\s*map\)/g);
  return fns.map(({ cls, name, body }) => {
    const ranges: AddressRangeDef[] = [];
    const calls: string[] = [];
    let globalMask: number | undefined;
    let unmapHigh: boolean | undefined;
    for (const stmt of splitStatements(body)) {
      const s = stmt.trim();
      // composition: galaxian_map(address_map &map) { galaxian_map_base(map); ... }
      const call = /^(\w+)\(\s*map\s*\)$/.exec(s);
      if (call) { calls.push(call[1]); continue; }
      const mapProp = /^map\.(\w+)\s*\(([^)]*)\)$/.exec(s);
      if (mapProp) {
        if (mapProp[1] === 'global_mask') globalMask = evalExpr(mapProp[2]) ?? undefined;
        if (mapProp[1] === 'unmap_value_high') unmapHigh = true;
        continue;
      }
      if (!s.startsWith('map(')) continue;
      const open = 3;
      const close = matchParen(s, open);
      const [startS, endS] = splitArgs(s.slice(open + 1, close));
      const range: AddressRangeDef = {
        start: evalExpr(startS) ?? 0,
        end: evalExpr(endS) ?? 0,
        raw: s,
      };
      for (const { method, args } of parseChain(s.slice(close + 1))) {
        switch (method) {
          case 'rom': range.rom = true; break;
          case 'ram': range.ram = true; break;
          case 'writeonly': range.writeonly = true; break;
          case 'nopw': range.nopw = true; break;
          case 'nopr': range.nopr = true; break;
          case 'mirror': range.mirror = evalExpr(args[0]) ?? undefined; break;
          case 'share': range.share = unquote(args[0]); break;
          case 'portr': range.portRead = unquote(args[0]); break;
          case 'portw': range.portWrite = unquote(args[0]); break;
          case 'r': range.read = parseHandlerArgs(args); break;
          case 'w': range.write = parseHandlerArgs(args); break;
          case 'rw': {
            // rw(readFunc, writeFunc) or rw(dev, readFunc, writeFunc)
            if (args.length === 2) {
              range.read = parseHandlerArgs([args[0]]);
              range.write = parseHandlerArgs([args[1]]);
            } else {
              range.read = parseHandlerArgs([args[0], args[1]]);
              range.write = parseHandlerArgs([args[0], args[2]]);
            }
            break;
          }
          default: break;
        }
      }
      ranges.push(range);
    }
    return { cls, name, ranges, calls, globalMask, unmapHigh };
  });
}

function splitStatements(body: string): string[] {
  const stmts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      const end = findStringEnd(body, i);
      cur += body.slice(i, end + 1);
      i = end;
    } else if (c === '(') { depth++; cur += c; }
    else if (c === ')') { depth--; cur += c; }
    else if (c === ';' && depth === 0) { stmts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

/** Parse a `.m1(args).m2(args)...` chain. */
function parseChain(s: string): { method: string; args: string[] }[] {
  const out: { method: string; args: string[] }[] = [];
  let i = 0;
  while (i < s.length) {
    const m = /^\s*\.\s*(\w+)\s*\(/.exec(s.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const close = matchParen(s, open);
    if (close < 0) break;
    const inner = s.slice(open + 1, close);
    out.push({ method: m[1], args: inner.trim() ? splitArgs(inner) : [] });
    i = close + 1;
  }
  return out;
}

/** args like [FUNC(cls::meth)] or [m_dev, FUNC(dev_class::meth)] or ["tag", FUNC(...)] */
function parseHandlerArgs(args: string[]): HandlerRef | undefined {
  const funcArg = args.find(a => a.includes('FUNC('));
  if (!funcArg) return undefined;
  const fm = /FUNC\(\s*(?:(\w+)::)?(\w+)\s*\)/.exec(funcArg);
  if (!fm) return undefined;
  const ref: HandlerRef = { method: fm[2] };
  if (fm[1]) ref.deviceClass = fm[1];
  const devArg = args.find(a => !a.includes('FUNC('));
  if (devArg) ref.deviceRef = unquote(devArg.trim());
  return ref;
}

// ---------------------------------------------------------------------------
// machine_config functions
// ---------------------------------------------------------------------------

export interface DeviceDef {
  /** device macro type: Z80, LS259, NAMCO_51XX, SCREEN, PALETTE, ... */
  type: string;
  /** resolved tag ("maincpu", "misclatch", ...) */
  tag: string;
  clock: number | null;
  clockExpr?: string;
  /** AS_PROGRAM etc -> address map function name */
  addrMaps: Record<string, string>;
  /** screen raw params if this is a screen with set_raw */
  screenRaw?: { pixclock: number; htotal: number; hbend: number; hbstart: number; vtotal: number; vbend: number; vbstart: number };
  /** every raw config statement that mentioned this device (for the generator + human) */
  config: string[];
  /** GFXDECODE(config, ..., gfx_name) reference */
  gfxDecodeName?: string;
  /** name of local C++ variable that aliases this device inside the config fn */
  localVar?: string;
}

export interface MachineConfigDef {
  cls: string; name: string;
  devices: DeviceDef[];
  /** calls to other config helpers on the same class, e.g. galagab() calls galaga() */
  calls: string[];
  raw: string;
}

/** Parse `m_foo(*this, "tag")` from state-class constructor initializer lists. */
export function parseMemberTags(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /m_(\w+)\(\*this,\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out[`m_${m[1]}`] = m[2];
  return out;
}

const DEVICE_MACRO_RE = /^(?:[\w]+\s+)?(?:&?\s*(\w+)\s*\(\s*)?([A-Z][A-Z0-9_]{1,})\s*\(\s*config\s*,\s*([^,)]+)\s*(?:,\s*([^;]+?))?\)\s*\)?/;

export function parseMachineConfigs(
  src: string,
  memberTags: Record<string, string>,
  consts: Record<string, number>,
): MachineConfigDef[] {
  const fns = extractFunctionBody(src, /void\s+(\w+)::(\w+)\(machine_config\s*&\s*config\)/g);
  return fns.map(({ cls, name, body }) => {
    const cfg: MachineConfigDef = { cls, name, devices: [], calls: [], raw: body.trim() };
    const byRef = new Map<string, DeviceDef>(); // m_member, "tag", or localVar -> device
    const resolveTag = (ref: string): string => {
      const r = ref.trim();
      if (r.startsWith('"')) return unquote(r);
      return memberTags[r] ?? r.replace(/^m_/, '');
    };

    for (const stmt of splitStatements(body)) {
      const s = stmt.trim();
      if (!s) continue;

      // helper call: galaga(config);
      const call = /^(\w+)\(\s*config\s*\)$/.exec(s);
      if (call) { cfg.calls.push(call[1]); continue; }

      // device instantiation, possibly wrapped: type_device &var(TYPE(config, ref[, clock]));
      const dm = DEVICE_MACRO_RE.exec(s);
      if (dm && dm[2] !== 'FUNC' && dm[2] !== 'AS_PROGRAM') {
        const [, localVar, type, refRaw, clockRaw] = dm;
        const ref = refRaw.trim();
        const dev: DeviceDef = {
          type,
          tag: resolveTag(ref),
          clock: clockRaw ? evalExpr(clockRaw, consts) : null,
          addrMaps: {},
          config: [s],
        };
        if (clockRaw && dev.clock === null) dev.clockExpr = clockRaw.trim();
        if (localVar) { dev.localVar = localVar; byRef.set(localVar, dev); }
        byRef.set(ref, dev);
        byRef.set(dev.tag, dev);
        if (ref.startsWith('"')) byRef.set(unquote(ref), dev);
        // GFXDECODE(config, m_gfxdecode, m_palette, gfx_galaga)
        if (type === 'GFXDECODE' && clockRaw) {
          const parts = splitArgs(clockRaw);
          dev.gfxDecodeName = parts[parts.length - 1]?.trim();
        }
        cfg.devices.push(dev);
        continue;
      }

      // member/local/tag method calls: m_x->..., var.set_raw(...), subdevice
      const mc = /^([\w."<>]+?)\s*(?:->|\.)\s*(\w+)(<\d+>)?\s*\(/.exec(s);
      if (mc) {
        const [, refRaw, method] = mc;
        const dev = byRef.get(refRaw) ?? byRef.get(resolveTag(refRaw));
        if (dev) {
          dev.config.push(s);
          if (method === 'set_addrmap') {
            const open = s.indexOf('(', s.indexOf(method));
            const close = matchParen(s, open);
            const [space, mapRef] = splitArgs(s.slice(open + 1, close));
            const mm = /&\s*\w+::(\w+)/.exec(mapRef ?? '');
            if (mm) dev.addrMaps[space.trim()] = mm[1];
          } else if (method === 'set_raw') {
            const open = s.indexOf('(', s.indexOf(method));
            const close = matchParen(s, open);
            const a = splitArgs(s.slice(open + 1, close)).map(x => evalExpr(x, consts) ?? 0);
            if (a.length >= 7) {
              dev.screenRaw = { pixclock: a[0], htotal: a[1], hbend: a[2], hbstart: a[3], vtotal: a[4], vbend: a[5], vbstart: a[6] };
            }
          }
          continue;
        }
      }

      // anything else that mentions a known device ref: attach as raw config
      let attached = false;
      for (const [ref, dev] of byRef) {
        if (ref && s.includes(ref)) { dev.config.push(s); attached = true; break; }
      }
      if (!attached && cfg.devices.length) {
        // keep orphan statements on the config itself via a pseudo entry later if needed
      }
    }
    return cfg;
  });
}

// ---------------------------------------------------------------------------
// input ports
// ---------------------------------------------------------------------------

export interface PortFieldDef {
  kind: 'bit' | 'dip' | 'service';
  mask: number;
  activeLow?: boolean;
  type?: string;             // IPT_JOYSTICK_LEFT, ...
  modifiers?: string[];      // PORT_2WAY, PORT_COCKTAIL, ...
  name?: string;             // dip switch name
  defaultValue?: number;     // dip default
  location?: string;
  settings?: { value: number; name: string; condition?: string }[];
}
export interface PortDef { tag: string; modify?: boolean; fields: PortFieldDef[]; }
export interface InputPortsDef { name: string; include?: string; ports: PortDef[]; }

export function parseInputPorts(src: string): InputPortsDef[] {
  const out: InputPortsDef[] = [];
  const re = /INPUT_PORTS_START\(\s*(\w+)\s*\)([\s\S]*?)INPUT_PORTS_END/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const def: InputPortsDef = { name: m[1], ports: [] };
    const body = m[2];
    let port: PortDef | null = null;
    let dip: PortFieldDef | null = null;
    const tokRe = /(PORT_START|PORT_MODIFY|PORT_INCLUDE|PORT_BIT|PORT_DIPNAME|PORT_DIPSETTING|PORT_SERVICE|PORT_DIPLOCATION|PORT_DIPUNUSED_DIPLOC|PORT_CONDITION|PORT_CONFNAME|PORT_CONFSETTING)\s*\(/g;
    let tm: RegExpExecArray | null;
    while ((tm = tokRe.exec(body)) !== null) {
      const open = body.indexOf('(', tm.index + tm[1].length - 1);
      const close = matchParen(body, open);
      if (close < 0) continue;
      const args = splitArgs(body.slice(open + 1, close));
      const trailing = body.slice(close + 1, body.indexOf('\n', close) === -1 ? body.length : body.indexOf('\n', close));
      switch (tm[1]) {
        case 'PORT_INCLUDE': def.include = args[0].trim(); break;
        case 'PORT_START': port = { tag: unquote(args[0]), fields: [] }; def.ports.push(port); dip = null; break;
        case 'PORT_MODIFY': port = { tag: unquote(args[0]), modify: true, fields: [] }; def.ports.push(port); dip = null; break;
        case 'PORT_BIT': {
          if (!port) break;
          const mods = [...trailing.matchAll(/PORT_\w+(?:\([^)]*\))?/g)].map(x => x[0]);
          port.fields.push({
            kind: 'bit',
            mask: evalExpr(args[0]) ?? 0,
            activeLow: args[1].includes('LOW'),
            type: args[2].trim(),
            modifiers: mods.length ? mods : undefined,
          });
          dip = null;
          break;
        }
        case 'PORT_SERVICE': {
          if (!port) break;
          port.fields.push({ kind: 'service', mask: evalExpr(args[0]) ?? 0, activeLow: args[1].includes('LOW') });
          dip = null;
          break;
        }
        case 'PORT_CONFNAME': // configuration switches are dip-identical in semantics
        case 'PORT_DIPNAME': {
          if (!port) break;
          dip = {
            kind: 'dip',
            mask: evalExpr(args[0]) ?? 0,
            defaultValue: evalExpr(args[1]) ?? 0,
            name: defStr(args[2]),
            settings: [],
          };
          port.fields.push(dip);
          break;
        }
        case 'PORT_DIPUNUSED_DIPLOC': {
          if (!port) break;
          port.fields.push({ kind: 'dip', mask: evalExpr(args[0]) ?? 0, name: 'Unused', settings: [] });
          dip = null;
          break;
        }
        case 'PORT_CONFSETTING':
        case 'PORT_DIPSETTING': {
          if (!dip?.settings) break;
          const cond = /PORT_CONDITION\(([^)]*)\)/.exec(trailing);
          dip.settings.push({
            value: evalExpr(args[0]) ?? 0,
            name: defStr(args[1]),
            condition: cond ? cond[1] : undefined,
          });
          break;
        }
        case 'PORT_DIPLOCATION': {
          if (dip) dip.location = unquote(args[0]);
          break;
        }
        default: break;
      }
    }
    out.push(def);
  }
  return out;
}

function defStr(s: string): string {
  const m = /DEF_STR\(\s*(\w+)\s*\)/.exec(s);
  if (m) return m[1].replace(/_/g, ' ');
  return unquote(s);
}

// ---------------------------------------------------------------------------
// gfx layouts + GFXDECODE
// ---------------------------------------------------------------------------

export interface GfxLayoutDef {
  name: string;
  width: number; height: number;
  /** number of elements, or symbolic "RGN_FRAC(a,b)" */
  total: number | string;
  planes: number;
  /** offsets in bits; symbolic strings preserved where RGN_FRAC appears */
  planeOffsets: (number | string)[];
  xOffsets: (number | string)[];
  yOffsets: (number | string)[];
  charIncrement: number;
}

export function parseGfxLayouts(src: string): GfxLayoutDef[] {
  const out: GfxLayoutDef[] = [];
  const re = /static\s+const\s+gfx_layout\s+(\w+)\s*=\s*\{([\s\S]*?)\};/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const fields = splitArgs(m[2]);
    if (fields.length < 8) continue;
    out.push({
      name: m[1],
      width: evalExpr(fields[0]) ?? 0,
      height: evalExpr(fields[1]) ?? 0,
      total: evalExpr(fields[2]) ?? fields[2].trim(),
      planes: evalExpr(fields[3]) ?? 0,
      planeOffsets: parseOffsetList(fields[4]),
      xOffsets: parseOffsetList(fields[5]),
      yOffsets: parseOffsetList(fields[6]),
      charIncrement: evalExpr(fields[7]) ?? 0,
    });
  }
  return out;
}

/** Parse `{ a, b, STEP4(x,y), ... }` into a flat offset list, expanding STEPn. */
function parseOffsetList(s: string): (number | string)[] {
  const inner = s.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out: (number | string)[] = [];
  for (const part of splitArgs(inner)) {
    const step = /^STEP(\d+)\(\s*([^,]+),\s*([^)]+)\)$/.exec(part.trim());
    if (step) {
      const n = Number(step[1]);
      const start = evalExpr(step[2]);
      const inc = evalExpr(step[3]);
      if (start !== null && inc !== null) {
        for (let i = 0; i < n; i++) out.push(start + i * inc);
        continue;
      }
    }
    const v = evalExpr(part);
    out.push(v !== null ? v : part.trim());
  }
  return out;
}

export interface GfxDecodeEntryDef {
  region: string; offset: number; layout: string; colorBase: number; colorCount: number;
  /** GFXDECODE_SCALE render scale (galaxian renders 3x wide); 1 for plain entries */
  xscale: number; yscale: number;
}
export interface GfxDecodeDef { name: string; entries: GfxDecodeEntryDef[]; }

export function parseGfxDecodes(src: string, consts: Record<string, number> = {}): GfxDecodeDef[] {
  const out: GfxDecodeDef[] = [];
  const re = /GFXDECODE_START\(\s*(\w+)\s*\)([\s\S]*?)GFXDECODE_END/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const entries: GfxDecodeEntryDef[] = [];
    const em = m[2].matchAll(/GFXDECODE_(ENTRY|SCALE)\(\s*([^)]*)\)/g);
    for (const e of em) {
      const args = splitArgs(e[2]);
      entries.push({
        region: unquote(args[0]),
        offset: evalExpr(args[1], consts) ?? 0,
        layout: args[2].trim(),
        colorBase: evalExpr(args[3], consts) ?? 0,
        colorCount: evalExpr(args[4], consts) ?? 0,
        xscale: e[1] === 'SCALE' ? (evalExpr(args[5], consts) ?? 1) : 1,
        yscale: e[1] === 'SCALE' ? (evalExpr(args[6], consts) ?? 1) : 1,
      });
    }
    out.push({ name: m[1], entries });
  }
  return out;
}

// ---------------------------------------------------------------------------
// includes
// ---------------------------------------------------------------------------

export function parseIncludes(src: string): string[] {
  return [...src.matchAll(/^#include\s+"([^"]+)"/gm)].map(m => m[1]);
}
