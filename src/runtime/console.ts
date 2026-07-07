// Console room (issue #17): the living-room shelf behind a console tile on
// the boot menu. Same video-store aesthetic as menu.ts (palette copied, NOT
// imported — game pages must not pull the whole menu in), plus the console's
// own accent color for the marquee (NES front-loader red).
//
// The room owns cartridge UX end-to-end: drop/pick .nes or .zip files,
// identify them against the generated softlist catalog (nes-ines.ts), shelve
// them as CSS cartridge tiles persisted in the visitor's own browser
// (cartstore.ts, by explicit user approval 2026-07-07), and boot a verified
// cart by handing runShell() preloaded {prg, chr?} regions with the cart
// facts injected into a CLONE of cfg.board. Nothing here is game-specific:
// titles, mappers, capability lists all come from config.json + softlist.json
// + games.json.

import { runShell, type ShellConfig } from './shell.ts';
import { openCartStore, type CartRecord } from './cartstore.ts';
import { parseINes, identify, type ResolvedCart, type SoftCatalog } from './nes-ines.ts';
import { readZip, crc32 } from './zip.ts';
import type { Regions } from './types.ts';

const GOLD = '#f2c200';
const ACCENT = '#e60012'; // NES front-loader stripe red
const MAX_CART = 8 * 1024 * 1024; // no real cartridge is bigger than 8 MiB

/** games.json manifest entry (the fields the room shows in About) */
interface MenuEntry {
  game: string;
  title: string;
  fullname: string;
  year: string;
  manufacturer: string;
  supported?: boolean;
  hasHistory?: boolean;
  driverFile?: string;
  license?: string;
  copyrightHolders?: string;
  gitHistory?: { firstCommit: string; lastCommit: string; commits: number; contributors: number; topAuthors: string[] };
}

interface Tile {
  rec: CartRecord;
  /** null => stored bytes no longer parse (should never happen; eject-only) */
  resolved: ResolvedCart | null;
  item: HTMLElement;
  armEject: () => void;
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

function hueOf(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

async function fetchCatalog(cfg: ShellConfig): Promise<SoftCatalog | null> {
  // catalogUrl is relative to config.json, which lives at ../<game>/config.json
  try {
    const r = await fetch(`../${encodeURIComponent(cfg.game)}/${cfg.cart?.catalogUrl ?? 'softlist.json'}`);
    return r.ok ? await r.json() as SoftCatalog : null;
  } catch { return null; }
}

async function fetchOwnEntry(cfg: ShellConfig): Promise<MenuEntry | null> {
  try {
    const games = await fetch('../games.json').then(r => r.json()) as MenuEntry[];
    return games.find(g => g.game === cfg.game) ?? null;
  } catch { return null; }
}

/** parse + identify a stored record against this visit's catalog */
function resolveRec(rec: CartRecord, catalog: SoftCatalog | null, support: { slots: string[]; games: string[] }): ResolvedCart | null {
  const ines = parseINes(new Uint8Array(rec.bytes));
  return ines ? identify(ines, catalog, support) : null;
}

export async function runConsole(cfg: ShellConfig): Promise<void> {
  document.title = cfg.title;
  // a deep-linked cart boot replaces the room DOM entirely — Back must
  // rebuild it, so a reload is the honest implementation
  addEventListener('popstate', () => location.reload());

  const support = { slots: cfg.cart?.slots ?? [], games: cfg.cart?.games ?? [] };
  const [store, catalog, entry] = await Promise.all([openCartStore(), fetchCatalog(cfg), fetchOwnEntry(cfg)]);
  // stale-bundle guard: generated before the board compiled -> shelve-only
  const coreSupported = entry?.supported !== false;
  let inRoom = true; // gates every window-level listener once a cart boots
  let modalDepth = 0;

  const playable = (r: ResolvedCart | null): r is ResolvedCart => r !== null && r.supported && coreSupported;

  const boot = (rec: CartRecord, resolved: ResolvedCart): void => {
    inRoom = false;
    document.body.textContent = '';
    const regions: Regions = { prg: resolved.ines.prg };
    if (resolved.ines.chr) regions.chr = resolved.ines.chr; // omitted => CHR-RAM cart
    const cfg2: ShellConfig = {
      ...cfg,
      title: resolved.meta?.description ?? rec.name.replace(/\.[a-z0-9]+$/i, ''),
      menuUrl: `g/${encodeURIComponent(cfg.game)}/`, // Esc: back to this room
      board: {
        ...cfg.board, // CLONE — never mutate the fetched config
        cart: { mapper: resolved.mapper, mirroring: resolved.ines.mirroring, battery: resolved.ines.battery },
      },
    };
    void runShell(cfg2, regions);
  };

  // --- deep link: ?cart=<id> boots straight into the game ---------------------
  const cartParam = new URLSearchParams(location.search).get('cart');
  if (cartParam) {
    const rec = await store.get(cartParam);
    const resolved = rec ? resolveRec(rec, catalog, support) : null;
    if (rec && playable(resolved)) { boot(rec, resolved); return; }
    history.replaceState(null, '', location.pathname); // unknown/unplayable id — show the room
  }

  // --- room chrome -------------------------------------------------------------
  const root = el('div', `min-height:100vh;box-sizing:border-box;margin:0;padding:0 0 60px;
    background:linear-gradient(#06070f, #0b0d1d 30%, #10142a);color:#eee;
    font:14px ui-sans-serif,system-ui`);
  root.setAttribute('data-console-room', cfg.game);
  document.body.style.margin = '0';
  document.body.style.background = '#06070f';
  document.body.appendChild(root);

  const header = el('div', `display:flex;align-items:center;gap:24px;flex-wrap:wrap;
    padding:26px 36px 18px;border-bottom:4px solid ${ACCENT};
    background:linear-gradient(#141838,#0c0f24);box-shadow:0 6px 30px rgba(230,0,18,.18)`);
  const back = document.createElement('a');
  back.href = './?tab=consoles'; // <base href="../../"> -> app/?tab=consoles
  back.textContent = '‹ ALL SYSTEMS';
  back.setAttribute('data-back', '');
  back.style.cssText = `color:#9fb0ff;text-decoration:none;font-weight:700;letter-spacing:1.5px;
    font-size:12px;padding:8px 14px;border:2px solid #2a3160;border-radius:8px;flex-shrink:0`;
  const marquee = el('div', 'display:flex;flex-direction:column;gap:2px');
  const title = el('div', `font-size:30px;font-weight:800;letter-spacing:2px;
    color:${GOLD};text-shadow:0 0 18px rgba(242,194,0,.55), 0 2px 0 #7a5c00;font-family:ui-monospace,monospace`);
  title.textContent = (entry?.fullname ?? cfg.title).replace(/\s*\(.*\)$/, '');
  const sub = el('div', 'color:#7f8ac9;letter-spacing:6px;font-size:11px;font-weight:600');
  sub.textContent = ['CONSOLE', entry?.manufacturer, entry?.year].filter(Boolean).join(' · ');
  marquee.append(title, sub);
  const aboutBtn = document.createElement('button');
  aboutBtn.textContent = 'About this console';
  aboutBtn.setAttribute('data-about', '');
  aboutBtn.style.cssText = `margin-left:auto;padding:9px 18px;border-radius:8px;font-weight:700;cursor:pointer;
    border:2px solid #2a3160;color:#9fb0ff;background:transparent;font:inherit;font-weight:700`;
  aboutBtn.addEventListener('click', openAboutModal);
  header.append(back, marquee, aboutBtn);
  root.appendChild(header);

  const banner = (text: string, attr: string, color: string): void => {
    const b = el('div', `max-width:1208px;margin:18px auto 0;box-sizing:border-box;
      padding:10px 18px;border:1px solid ${color};border-radius:10px;color:${color};
      background:rgba(0,0,0,.35);font-size:13px;text-align:center`);
    b.setAttribute(attr, '');
    b.textContent = text;
    // margins inside the page gutter
    b.style.marginLeft = 'max(36px, calc(50% - 604px))';
    b.style.marginRight = 'max(36px, calc(50% - 604px))';
    root.appendChild(b);
  };
  if (!store.persistent) banner('Private browsing — carts last only this session', 'data-banner-private', '#e8b64c');
  if (!coreSupported) banner('Console core still compiling — carts can be shelved but not played', 'data-banner-core', '#8b93c4');

  // --- the cart slot (drop zone) -------------------------------------------------
  const slotWrap = el('div', 'max-width:1280px;margin:26px auto 0;padding:0 36px;box-sizing:border-box');
  const slot = el('div', `border:3px dashed rgba(242,194,0,.65);border-radius:14px;cursor:pointer;
    background:linear-gradient(#10142a,#0a0c1c);padding:24px 30px 20px;
    display:flex;flex-direction:column;align-items:center;gap:8px;
    transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease,background .15s ease`);
  slot.setAttribute('data-drop-slot', '');
  // the front-loader mouth: dark slot with the thin red stripe under it
  const mouth = el('div', `width:min(420px,84%);height:16px;border-radius:3px;
    background:linear-gradient(#05060a,#1a1c26);box-shadow:inset 0 4px 8px #000;
    border-bottom:3px solid ${ACCENT}`);
  const slotBig = el('div', `font-size:19px;font-weight:800;color:${GOLD};letter-spacing:2px;margin-top:4px`);
  const slotSmall = el('div', 'color:#9fb0ff;font-size:13px');
  const slotNote = el('div', 'color:#5a6188;font-size:11px;margin-top:2px');
  slotNote.textContent = 'Carts are stored only in this browser · Eject deletes';
  const toastEl = el('div', `display:none;color:#e0504d;font-size:12px;font-weight:700;margin-top:4px`);
  toastEl.setAttribute('data-toast', '');
  slot.append(mouth, slotBig, slotSmall, slotNote, toastEl);
  slotWrap.appendChild(slot);
  root.appendChild(slotWrap);

  const slotIdle = (): void => {
    slot.style.transform = '';
    slot.style.borderColor = 'rgba(242,194,0,.65)';
    slot.style.boxShadow = 'none';
    slot.style.background = 'linear-gradient(#10142a,#0a0c1c)';
    slotBig.textContent = 'INSERT CARTRIDGE';
    slotSmall.textContent = 'drop .nes or .zip files, or click to choose';
  };
  const slotArmed = (): void => {
    slot.style.transform = 'scale(1.01)';
    slot.style.borderColor = '#fff';
    slot.style.boxShadow = '0 0 44px rgba(242,194,0,.45)';
    slot.style.background = 'linear-gradient(#181d42,#0c0f24)';
    slotBig.textContent = 'RELEASE TO INSERT';
  };
  const slotBusy = (name: string): void => {
    slotBig.textContent = `READING ${name.toUpperCase()}…`;
    slotSmall.textContent = '';
  };
  slotIdle();

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const toast = (msg: string): void => {
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 4500);
  };

  // --- the shelf -----------------------------------------------------------------
  const shelf = el('div', `display:flex;flex-wrap:wrap;gap:30px 26px;justify-content:center;
    padding:40px 36px 0;max-width:1280px;margin:0 auto;box-sizing:border-box`);
  shelf.setAttribute('data-cart-shelf', '');
  root.appendChild(shelf);
  const emptyMsg = el('div', 'text-align:center;color:#7f8ac9;padding:30px;width:100%');
  emptyMsg.setAttribute('data-shelf-empty', '');
  emptyMsg.textContent = 'No carts on the shelf yet — insert one above.';
  shelf.appendChild(emptyMsg);

  const hint = el('div', 'text-align:center;color:#4b5384;padding:28px 28px 8px;font-size:12px');
  hint.textContent = '↑↓←→ browse · Enter: play · i: info · E: eject · Esc: all systems · in-game: Esc returns here';
  root.appendChild(hint);

  const tiles: Tile[] = [];
  let selected = -1;

  const updateEmpty = (): void => { emptyMsg.style.display = tiles.length ? 'none' : 'block'; };

  const select = (i: number): void => {
    if (!tiles.length) { selected = -1; return; }
    selected = ((i % tiles.length) + tiles.length) % tiles.length;
    tiles.forEach(t => { t.item.style.outline = 'none'; });
    const t = tiles[selected];
    t.item.style.outline = `3px solid ${GOLD}`;
    t.item.style.outlineOffset = '3px';
    t.item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const flash = (tile: Tile): void => {
    tile.item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    tile.item.style.outline = `3px solid ${GOLD}`;
    tile.item.style.outlineOffset = '3px';
    setTimeout(() => { if (tiles[selected] !== tile) tile.item.style.outline = 'none'; }, 1400);
  };

  const play = (tile: Tile): void => {
    if (!playable(tile.resolved)) return;
    history.pushState(null, '', '?cart=' + encodeURIComponent(tile.rec.id));
    boot(tile.rec, tile.resolved);
  };

  // --- tile state text ------------------------------------------------------------
  const stateOf = (resolved: ResolvedCart | null): { text: string; color: string; canPlay: boolean } => {
    if (!resolved) return { text: 'CANNOT READ — EJECT', color: '#e0504d', canPlay: false };
    if (resolved.supported)
      return { text: `✓ VERIFIED · ${(resolved.meta?.description ?? '').toUpperCase()}`, color: '#5ecf7a', canPlay: coreSupported };
    if (!resolved.meta)
      return { text: `UNKNOWN CART · MAPPER ${resolved.mapper}`, color: '#e8b64c', canPlay: false };
    if (resolved.slot === null || !support.slots.includes(resolved.slot))
      return { text: `MAPPER ${resolved.mapper} NOT YET SUPPORTED`, color: '#8b93c4', canPlay: false };
    return { text: 'NOT YET VERIFIED — COMING SOON', color: '#8b93c4', canPlay: false };
  };

  // --- cartridge tile ---------------------------------------------------------------
  function addTile(rec: CartRecord, resolved: ResolvedCart | null): Tile {
    const displayName = resolved?.meta?.description ?? rec.name.replace(/\.[a-z0-9]+$/i, '');
    const state = stateOf(resolved);

    const item = el('div', 'display:flex;flex-direction:column;align-items:center;gap:7px;width:190px');
    item.setAttribute('data-cart-tile', rec.id);

    // grey plastic shell with grip ridges and a hue-hashed label panel
    const body = el('div', `position:relative;width:190px;height:230px;cursor:pointer;
      border-radius:8px 8px 5px 5px;
      background:linear-gradient(#c6c1ba,#9b968f 62%,#87827b);
      box-shadow:inset 0 2px 2px rgba(255,255,255,.55), inset 0 -4px 8px rgba(0,0,0,.35), 0 12px 24px rgba(0,0,0,.55)`);
    body.appendChild(el('div', `position:absolute;left:0;right:0;top:0;height:44px;border-radius:8px 8px 0 0;
      background:repeating-linear-gradient(180deg, rgba(0,0,0,.16) 0 3px, rgba(255,255,255,.10) 3px 5px, transparent 5px 9px)`));
    const hue = hueOf(rec.id);
    const label = el('div', `position:absolute;left:20px;right:20px;top:56px;bottom:40px;border-radius:4px;
      background:linear-gradient(160deg, hsl(${hue} 55% 34%), hsl(${(hue + 40) % 360} 60% 18%));
      border:2px solid rgba(0,0,0,.35);box-shadow:inset 0 0 14px rgba(0,0,0,.45);
      padding:10px;color:#fff;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;box-sizing:border-box`);
    const tname = el('div', 'font-weight:800;font-size:13px;line-height:1.2;max-height:47px;overflow:hidden;text-shadow:0 1px 2px rgba(0,0,0,.6)');
    tname.textContent = displayName;
    const tmeta = el('div', 'font-size:10px;opacity:.85;margin-top:4px;letter-spacing:.4px');
    tmeta.textContent = resolved?.meta
      ? [resolved.meta.publisher, resolved.meta.year].filter(Boolean).join(' · ')
      : `${(rec.size / 1024).toFixed(0)} KB`;
    label.append(tname, tmeta);
    body.appendChild(label);

    const status = el('div', `font-size:10px;font-weight:700;letter-spacing:.8px;text-align:center;min-height:13px;
      color:${state.color};max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    status.setAttribute('data-status', '');
    status.title = state.text + (resolved?.reason ? ` — ${resolved.reason}` : '');
    status.textContent = state.text;

    const buttons = el('div', 'display:flex;gap:8px;align-items:center;justify-content:center;min-height:30px');

    const mkBtn = (text: string, attr: string, solid: boolean, enabled: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = text;
      b.setAttribute(attr, '');
      b.disabled = !enabled;
      b.style.cssText = `padding:5px 12px;border-radius:7px;font:inherit;font-size:12px;font-weight:700;
        cursor:${enabled ? 'pointer' : 'default'};
        ${solid && enabled ? `background:${GOLD};color:#1b1b1b;border:2px solid ${GOLD}`
          : `background:transparent;border:2px solid #2a3160;color:${enabled ? '#9fb0ff' : '#555c86'}`}
        ${enabled ? '' : ';opacity:.55'}`;
      return b;
    };
    const playBtn = mkBtn('▶ Play', 'data-play', true, state.canPlay);
    const infoBtn = mkBtn('i', 'data-info', false, true);
    const ejectBtn = mkBtn('⏏', 'data-eject', false, true);

    const tile: Tile = { rec, resolved, item, armEject };
    playBtn.addEventListener('click', ev => { ev.stopPropagation(); play(tile); });
    infoBtn.addEventListener('click', ev => { ev.stopPropagation(); openInfoModal(tile); });
    ejectBtn.addEventListener('click', ev => { ev.stopPropagation(); armEject(); });
    body.addEventListener('click', () => openInfoModal(tile));
    buttons.append(playBtn, infoBtn, ejectBtn);

    // two-step inline eject confirm — no window.confirm, ever
    let ejectTimer: ReturnType<typeof setTimeout> | undefined;
    function disarm(): void {
      clearTimeout(ejectTimer);
      delete buttons.dataset.confirm;
      buttons.textContent = '';
      buttons.append(playBtn, infoBtn, ejectBtn);
    }
    function armEject(): void {
      if (buttons.dataset.confirm) return;
      buttons.dataset.confirm = '1';
      buttons.textContent = '';
      const q = el('span', 'font-size:12px;color:#e8b64c;font-weight:700;letter-spacing:.5px');
      q.textContent = 'Eject?';
      const yes = mkBtn('✔', 'data-eject-confirm', false, true);
      yes.style.borderColor = '#e0504d';
      yes.style.color = '#e0504d';
      const no = mkBtn('✕', 'data-eject-cancel', false, true);
      yes.addEventListener('click', ev => { ev.stopPropagation(); void doEject(); });
      no.addEventListener('click', ev => { ev.stopPropagation(); disarm(); });
      buttons.append(q, yes, no);
      ejectTimer = setTimeout(disarm, 4000);
    }
    async function doEject(): Promise<void> {
      clearTimeout(ejectTimer);
      try { await store.remove(rec.id); } catch { /* in-memory / already gone */ }
      const idx = tiles.indexOf(tile);
      if (idx >= 0) tiles.splice(idx, 1);
      item.remove();
      updateEmpty();
      if (selected >= tiles.length) selected = tiles.length - 1;
      if (selected >= 0) select(selected);
    }

    item.append(body, status, buttons);
    shelf.insertBefore(item, emptyMsg);
    tiles.push(tile);
    return tile;
  }

  // --- modals -----------------------------------------------------------------------
  function openModal(build: (scroller: HTMLElement, footer: HTMLElement, close: () => void) => void): void {
    modalDepth++;
    const backdrop = el('div', `position:fixed;inset:0;z-index:50;background:rgba(3,4,10,.86);
      display:flex;align-items:center;justify-content:center;padding:24px`);
    backdrop.setAttribute('data-modal', '');
    const card = el('div', `max-width:720px;width:100%;max-height:92vh;border-radius:12px;
      background:linear-gradient(#141838,#0c0f24);border:2px solid ${GOLD};
      box-shadow:0 24px 80px rgba(0,0,0,.8);font-size:14px;line-height:1.55;
      display:flex;flex-direction:column;overflow:hidden`);
    const scroller = el('div', 'overflow:auto;flex:1;min-height:0');
    const footer = el('div', `display:flex;gap:12px;flex-wrap:wrap;align-items:center;flex-shrink:0;
      padding:14px 30px;border-top:1px solid #232a58;background:rgba(10,12,30,.92);
      border-radius:0 0 10px 10px;box-shadow:0 -8px 24px rgba(0,0,0,.35)`);
    card.append(scroller, footer);
    backdrop.appendChild(card);
    const close = (): void => { backdrop.remove(); removeEventListener('keydown', onKey, true); modalDepth--; };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); } };
    backdrop.addEventListener('click', ev => { if (ev.target === backdrop) close(); });
    addEventListener('keydown', onKey, true);
    build(scroller, footer, close);
    document.body.appendChild(backdrop);
  }

  const section = (host: HTMLElement, name: string): HTMLElement => {
    const s = el('div', 'margin-bottom:14px');
    const t = el('div', `font-weight:700;color:#9fb0ff;letter-spacing:1.5px;font-size:11px;
      margin-bottom:6px;border-bottom:1px solid #232a58;padding-bottom:4px`);
    t.textContent = name.toUpperCase();
    s.appendChild(t);
    host.appendChild(s);
    return s;
  };
  const row = (parent: HTMLElement, name: string, value: string): void => {
    const r = el('div', 'display:flex;gap:10px;margin:2px 0');
    const l = el('span', 'color:#6b76b8;min-width:120px;flex-shrink:0');
    l.textContent = name;
    const v = el('span', 'color:#e8eaf6');
    v.textContent = value;
    r.append(l, v);
    parent.appendChild(r);
  };
  const footerBtn = (text: string, solid: boolean, enabled = true): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = text;
    b.disabled = !enabled;
    b.style.cssText = `padding:9px 18px;border-radius:8px;font:inherit;font-weight:700;cursor:${enabled ? 'pointer' : 'default'};
      ${solid && enabled ? `background:${GOLD};color:#1b1b1b;border:2px solid ${GOLD}`
        : `background:transparent;border:2px solid #2a3160;color:${enabled ? '#9fb0ff' : '#555c86'}`}`;
    return b;
  };

  function openInfoModal(tile: Tile): void {
    const { rec, resolved } = tile;
    const meta = resolved?.meta;
    const state = stateOf(resolved);
    openModal((scroller, footer, close) => {
      const inner = el('div', 'padding:22px 30px 20px');
      scroller.appendChild(inner);
      const h = el('div', `font-size:24px;font-weight:800;color:${GOLD};line-height:1.2;margin-bottom:2px`);
      h.textContent = meta?.description ?? rec.name;
      const subh = el('div', `font-size:12px;font-weight:700;letter-spacing:.8px;color:${state.color};margin-bottom:14px`);
      subh.textContent = state.text + (resolved?.approx ? ' · PRG match, CHR differs' : '');
      inner.append(h, subh);

      if (meta) {
        const cat = section(inner, 'From the software list (MAME hash/nes.xml)');
        row(cat, 'Title', meta.description);
        if (meta.year) row(cat, 'Year', meta.year);
        if (meta.publisher) row(cat, 'Publisher', meta.publisher);
        if (meta.pcb) row(cat, 'PCB', meta.pcb);
        if (meta.mirroring) row(cat, 'Mirroring', meta.mirroring);
        row(cat, 'Softlist name', meta.name + (meta.cloneof ? ` (clone of ${meta.cloneof})` : ''));
      }

      const tech = section(inner, 'The cartridge');
      row(tech, 'File', `${rec.name} · ${(rec.size / 1024).toFixed(0)} KB`);
      row(tech, 'PRG ROM', `${(rec.ines.prgSize / 1024).toFixed(0)} KB · crc ${rec.prgCrc}`);
      row(tech, 'CHR', rec.ines.chrSize ? `${(rec.ines.chrSize / 1024).toFixed(0)} KB ROM · crc ${rec.chrCrc}` : 'CHR RAM');
      row(tech, 'Mapper', `${rec.ines.mapper}${resolved?.slot ? ` (${resolved.slot})` : ''}`);
      row(tech, 'Mirroring (header)', rec.ines.mirroring);
      row(tech, 'Battery', rec.ines.battery ? 'yes' : 'no');
      if (resolved?.reason) row(tech, 'Status', resolved.reason);

      const p = footerBtn('▶ Play', true, state.canPlay);
      p.setAttribute('data-play', '');
      p.addEventListener('click', () => { close(); play(tile); });
      const e = footerBtn('⏏ Eject', false);
      e.setAttribute('data-eject', '');
      e.addEventListener('click', () => { close(); tile.armEject(); });
      const c = footerBtn('Close', false);
      c.addEventListener('click', close);
      footer.append(p, e, c);
      p.focus();
    });
  }

  function openAboutModal(): void {
    openModal((scroller, footer, close) => {
      const inner = el('div', 'padding:22px 30px 20px');
      scroller.appendChild(inner);
      const h = el('div', `font-size:26px;font-weight:800;color:${GOLD};line-height:1.2;margin-bottom:2px`);
      h.textContent = (entry?.fullname ?? cfg.title).replace(/\s*\(.*\)$/, '');
      const subh = el('div', 'color:#7f8ac9;font-size:14px;margin-bottom:14px');
      subh.textContent = [entry?.manufacturer, entry?.year].filter(Boolean).join(' · ');
      inner.append(h, subh);

      // machine facts straight from the generated config (the knowledge graph)
      const hw = section(inner, 'The machine (extracted from the MAME driver)');
      for (const cpu of cfg.board.cpus) {
        row(hw, cpu === cfg.board.cpus[0] ? 'Processors' : '',
          `${(cpu.type ?? 'z80').toUpperCase()} "${cpu.tag}" @ ${(cpu.clock / 1e6).toFixed(3)} MHz`);
      }
      if (cfg.sound && cfg.sound.kind !== 'none') row(hw, 'Sound', cfg.sound.kind + (cfg.sound.clock ? ` @ ${(cfg.sound.clock / 1e6).toFixed(3)} MHz` : ''));
      const sc = cfg.board.screen;
      row(hw, 'Screen', `${sc.width}×${sc.height} @ ${sc.refresh.toFixed(2)} Hz`);
      if (cfg.cart) {
        row(hw, 'Cartridge slot', `${cfg.cart.interface} · mappers: ${cfg.cart.slots.join(', ') || 'none yet'}`);
        row(hw, 'Verified titles', cfg.cart.games.join(', ') || 'none yet');
      }

      const ppl = section(inner, 'The MAME driver — the people who reverse-engineered it');
      if (entry?.driverFile) row(ppl, 'Driver source', entry.driverFile);
      if (entry?.copyrightHolders) row(ppl, 'Written by', entry.copyrightHolders);
      if (entry?.license) row(ppl, 'License', entry.license);
      if (entry?.gitHistory) {
        const gh = entry.gitHistory;
        row(ppl, 'History', `${gh.commits} commits by ${gh.contributors} contributors, ${gh.firstCommit.slice(0, 4)}–${gh.lastCommit.slice(0, 4)}`);
        row(ppl, 'Top contributors', gh.topAuthors.join(', '));
      }

      // the console's story — same "- CHAPTER -" split as the menu's modal
      if (entry?.hasHistory) {
        const story = section(inner, 'The story');
        void fetch(`../${encodeURIComponent(cfg.game)}/history.txt`).then(r => r.ok ? r.text() : '').then(t => {
          if (!t) { story.remove(); return; }
          const parts = t.split(/^- ([A-Z][A-Z0-9 .&''/-]{2,}) -\s*$/m);
          const intro = el('div', 'white-space:pre-wrap;color:#c9cde8;font-size:14.5px');
          intro.textContent = parts[0].trim();
          story.appendChild(intro);
          for (let i = 1; i < parts.length; i += 2) {
            const name = parts[i].trim();
            const text = (parts[i + 1] ?? '').trim();
            if (!text) continue;
            const chap = el('details', 'margin-top:10px;border:1px solid #232a58;border-radius:8px;overflow:hidden');
            const sum2 = document.createElement('summary');
            sum2.style.cssText = `cursor:pointer;padding:8px 14px;font-weight:700;letter-spacing:1.5px;
              font-size:11px;color:${GOLD};background:#171c40;list-style:none;user-select:none`;
            sum2.textContent = `◆ ${name}`;
            const bd = el('div', 'white-space:pre-wrap;color:#c9cde8;padding:10px 14px');
            bd.textContent = text;
            chap.append(sum2, bd);
            story.appendChild(chap);
          }
          const attr = el('div', 'color:#4b5384;font-size:11px;margin-top:8px');
          attr.textContent = 'Story courtesy of Gaming History (arcade-history.com)';
          story.appendChild(attr);
        });
      }

      const c = footerBtn('Close', true);
      c.addEventListener('click', close);
      footer.append(c);
      c.focus();
    });
  }

  // --- cart ingestion ------------------------------------------------------------------
  async function shelve(name: string, bytes: Uint8Array): Promise<void> {
    const ines = parseINes(bytes);
    if (!ines) return; // callers pre-check; belt and braces
    const resolved = identify(ines, catalog, support);
    const id = `${cfg.game}:${hex8(crc32(bytes))}`;
    const existing = tiles.find(t => t.rec.id === id);
    if (existing) { flash(existing); return; }
    const rec: CartRecord = {
      id,
      console: cfg.game,
      name,
      bytes: bytes.slice().buffer,
      size: bytes.length,
      addedAt: Date.now(),
      ines: { mapper: ines.mapper, prgSize: ines.prgSize, chrSize: ines.chrSize, mirroring: ines.mirroring, battery: ines.battery },
      prgCrc: resolved.prgCrc,
      chrCrc: resolved.chrCrc,
    };
    try {
      await store.add(rec);
    } catch {
      // quota / IDB write failure: keep it on the shelf in memory only
      toast(`${name}: not saved — playable this session`);
    }
    const tile = addTile(rec, resolved);
    updateEmpty();
    flash(tile);
    if (selected < 0) select(tiles.indexOf(tile));
  }

  async function handleFiles(files: File[]): Promise<void> {
    for (const f of files) {
      if (f.size > MAX_CART) { toast(`${f.name}: bigger than 8 MiB — not a cartridge`); continue; }
      slotBusy(f.name);
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await f.arrayBuffer()); }
      catch { toast(`${f.name}: could not read the file`); continue; }
      if (f.name.toLowerCase().endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
        let zentries: Map<string, Uint8Array>;
        try { zentries = await readZip(bytes); }
        catch { toast(`${f.name} isn't a readable zip`); continue; }
        let shelved = 0;
        for (const [zname, data] of zentries) {
          if (data.length > MAX_CART) continue;
          if (parseINes(data)) { await shelve(zname.split('/').pop() ?? zname, data); shelved++; }
        }
        if (!shelved) toast(`${f.name}: no iNES cartridges inside`);
      } else if (parseINes(bytes)) {
        await shelve(f.name, bytes);
      } else {
        toast(`${f.name} isn't an iNES cartridge (.nes)`);
      }
    }
    slotIdle();
  }

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.nes,.zip';
  picker.multiple = true;
  picker.addEventListener('change', () => {
    const fs = [...(picker.files ?? [])];
    picker.value = '';
    if (fs.length) void handleFiles(fs);
  });
  slot.addEventListener('click', () => picker.click());

  // dragenter/leave fire on every child crossed — depth-count (shell.ts pattern)
  let depth = 0;
  addEventListener('dragover', ev => { if (inRoom) ev.preventDefault(); });
  addEventListener('dragenter', ev => { if (!inRoom) return; ev.preventDefault(); if (++depth === 1) slotArmed(); });
  addEventListener('dragleave', () => { if (!inRoom) return; if (--depth <= 0) { depth = 0; slotIdle(); } });
  addEventListener('drop', ev => {
    if (!inRoom) return;
    ev.preventDefault();
    depth = 0;
    slotIdle();
    const fs = [...(ev.dataTransfer?.files ?? [])];
    if (fs.length) void handleFiles(fs);
  });

  // --- keyboard -----------------------------------------------------------------------
  addEventListener('keydown', ev => {
    if (!inRoom || modalDepth > 0) return;
    const perRow = Math.max(1, Math.floor((shelf.clientWidth - 72) / 216));
    switch (ev.key) {
      case 'ArrowRight': select(selected + 1); ev.preventDefault(); break;
      case 'ArrowLeft': select(selected - 1); ev.preventDefault(); break;
      case 'ArrowDown': select(selected < 0 ? 0 : selected + perRow); ev.preventDefault(); break;
      case 'ArrowUp': select(selected < 0 ? 0 : selected - perRow); ev.preventDefault(); break;
      case 'Enter': if (tiles[selected]) play(tiles[selected]); break;
      case 'i': case 'I': if (tiles[selected]) openInfoModal(tiles[selected]); break;
      case 'e': case 'E': if (tiles[selected]) tiles[selected].armEject(); break;
      case 'Escape': location.href = './?tab=consoles'; break;
    }
  });

  // --- load the shelf from the store ----------------------------------------------------
  const recs = await store.list(cfg.game);
  for (const rec of recs) addTile(rec, resolveRec(rec, catalog, support));
  updateEmpty();
  if (tiles.length) select(0);
}
