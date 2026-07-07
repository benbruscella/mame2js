// Console room (issue #17): the living-room shelf behind a console tile on
// the boot menu. Same video-store aesthetic as menu.ts (palette copied, NOT
// imported — game pages must not pull the whole menu in), plus the console's
// own accent color for the marquee (NES front-loader red).
//
// The room owns cartridge UX end-to-end: drop/pick .nes or .zip files,
// identify them against the generated softlist catalog (nes-ines.ts), shelve
// them as inline-SVG cartridge tiles persisted in the visitor's own browser
// (cartstore.ts, by explicit user approval 2026-07-07), and boot a cart by
// handing runShell() preloaded {prg, chr?} regions with the cart facts injected
// into a CLONE of cfg.board. Nothing here is game-specific: titles, mappers,
// capability lists all come from config.json + softlist.json + games.json.
//
// Shelf model (redesigned): every verified title (cfg.cart.games) is shown as a
// DARK PLACEHOLDER SLOT that LIGHTS UP when the visitor drops its matching ROM
// dump. Any other cart on a supported board is playable as EXPERIMENTAL; carts
// on unimplemented mappers show why they can't run. See docs for the tiers.

import { runShell, type ShellConfig } from './shell.ts';
import { openCartStore, type CartRecord } from './cartstore.ts';
import { parseINes, identify, type ResolvedCart, type SoftCatalog, type SoftEntry } from './nes-ines.ts';
import { readZip, crc32 } from './zip.ts';
import type { Regions } from './types.ts';

const GOLD = '#f2c200';
const ACCENT = '#e60012'; // NES front-loader stripe red
const MAX_CART = 8 * 1024 * 1024; // no real cartridge is bigger than 8 MiB

// --- artwork tunables (named so the orchestrator can screenshot-iterate) -------
const CART_W = 200;
const CART_H = 250;
const CART_BODY_TOP = '#d3d0c6';   // warm light grey, plastic top
const CART_BODY_BOT = '#b4b1a6';   // darker plastic bottom
const CART_LABEL_BG = '#f4f1e7';   // classic off-white label
const CART_LABEL_FRAME = '#141414'; // black-bordered NES label frame
const STRIPE_TESTED = '#2f6bd8';       // blue label stripe — verified
const STRIPE_EXPERIMENTAL = '#e6a02a'; // amber label stripe — experimental
const STRIPE_UNSUPPORTED = '#8f8f8f';  // grey label stripe — can't run
const STRIPE_PLACEHOLDER = '#5b6079';  // muted stripe — empty slot
const SEAL_GREEN = '#37a24b';
// friendly PCB names for the compatibility strip (slot family -> mapper board)
const SLOT_PCB: Record<string, string> = {
  nrom: 'NROM', uxrom: 'UxROM', cnrom: 'CNROM', sxrom: 'MMC1', txrom: 'MMC3',
  pxrom: 'MMC2', fxrom: 'MMC4', gxrom: 'GxROM', axrom: 'AxROM', bnrom: 'BNROM',
};

type CartState = 'placeholder' | 'lit' | 'experimental' | 'unsupported';

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

const hex8 = (n: number) => n.toString(16).padStart(8, '0');
const esc = (s: string) => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const stripSet = (s: string) => s.replace(/\s*\(.*\)$/, ''); // drop the "(Europe, rev. A)" region suffix

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  return e;
}

/** greedy word-wrap into at most 2 lines, ellipsizing overflow */
function wrapTitle(s: string, max = 17): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines = ['', ''];
  let li = 0;
  for (const w of words) {
    const t = lines[li] ? `${lines[li]} ${w}` : w;
    if (t.length <= max) { lines[li] = t; continue; }
    if (li === 0 && !lines[1]) { li = 1; lines[1] = w; continue; }
    lines[1] = lines[1].slice(0, max - 1).replace(/\s+$/, '') + '…';
    break;
  }
  return (lines[1] ? lines : [lines[0]]).map(l => (l.length > max ? l.slice(0, max - 1) + '…' : l));
}

// --- inline-SVG cartridge artwork ----------------------------------------------
// The iconic NES grey cart: plastic body + grip ridges + black-framed label with
// a colored top-stripe. State drives palette/marks; text is crisp <text>.
function cartSvg(o: { title: string; sub: string; state: CartState }): string {
  const stripe = o.state === 'lit' ? STRIPE_TESTED
    : o.state === 'experimental' ? STRIPE_EXPERIMENTAL
      : o.state === 'unsupported' ? STRIPE_UNSUPPORTED
        : STRIPE_PLACEHOLDER;
  const dim = o.state === 'placeholder' || o.state === 'unsupported';
  const dashed = o.state === 'placeholder';
  const titleColor = dim ? '#8b8b86' : '#181818';
  const subColor = dim ? '#7a7a75' : '#6b6045';
  const lines = wrapTitle(o.title);

  let ridges = '';
  for (let i = 0; i < 5; i++) {
    const y = 26 + i * 7;
    ridges += `<rect x="16" y="${y}" width="168" height="3" fill="rgba(0,0,0,.17)"/>`
      + `<rect x="16" y="${y + 3}" width="168" height="2" fill="rgba(255,255,255,.4)"/>`;
  }

  const titleSvg = lines.map((l, i) =>
    `<text x="34" y="${112 + i * 20}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="15" font-weight="800" fill="${titleColor}">${esc(l)}</text>`).join('');

  // state marks (drawn on top of the label)
  let mark = '';
  if (o.state === 'lit') {
    mark = `<circle cx="171" cy="24" r="15" fill="${SEAL_GREEN}" stroke="#fff" stroke-width="2"/>`
      + `<text x="171" y="30" text-anchor="middle" font-family="ui-sans-serif,sans-serif" font-size="17" font-weight="900" fill="#fff">✓</text>`;
  } else if (o.state === 'experimental') {
    mark = `<rect x="146" y="12" width="44" height="17" rx="3" fill="${STRIPE_EXPERIMENTAL}"/>`
      + `<text x="168" y="24.5" text-anchor="middle" font-family="ui-monospace,monospace" font-size="10" font-weight="800" fill="#221a05" letter-spacing="1">EXP</text>`;
  } else if (o.state === 'unsupported') {
    mark = `<text x="100" y="205" text-anchor="middle" font-family="ui-sans-serif,sans-serif" font-size="30" font-weight="900" fill="#e0504d" opacity=".85">✕</text>`;
  }
  const chip = o.state === 'placeholder'
    ? `<rect x="40" y="176" width="120" height="26" rx="13" fill="rgba(6,8,20,.55)" stroke="${STRIPE_PLACEHOLDER}" stroke-width="1.5" stroke-dasharray="4 3"/>`
      + `<text x="100" y="193" text-anchor="middle" font-family="ui-monospace,monospace" font-size="10.5" font-weight="800" fill="#c6cdec" letter-spacing=".5">◍ INSERT DUMP</text>`
    : '';

  return `<svg viewBox="0 0 ${CART_W} ${CART_H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" role="img">
    <defs>
      <linearGradient id="cb" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${CART_BODY_TOP}"/><stop offset="1" stop-color="${CART_BODY_BOT}"/>
      </linearGradient>
    </defs>
    <rect x="6" y="4" width="188" height="242" rx="11" fill="url(#cb)"/>
    <rect x="10" y="6" width="180" height="3" rx="1.5" fill="rgba(255,255,255,.5)"/>
    <rect x="10" y="239" width="180" height="5" rx="2" fill="rgba(0,0,0,.28)"/>
    ${ridges}
    <rect x="22" y="72" width="156" height="150" rx="5" fill="none" stroke="${CART_LABEL_FRAME}" stroke-width="3"${dashed ? ' stroke-dasharray="7 5"' : ''}/>
    <rect x="25.5" y="75.5" width="149" height="143" rx="3" fill="${CART_LABEL_BG}"/>
    <rect x="25.5" y="75.5" width="149" height="10" fill="${stripe}"/>
    ${titleSvg}
    <text x="34" y="154" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10.5" font-weight="600" fill="${subColor}">${esc(o.sub)}</text>
    <rect x="34" y="228" width="132" height="5" rx="2" fill="rgba(0,0,0,.4)"/>
    ${dim ? `<rect x="6" y="4" width="188" height="242" rx="11" fill="rgba(6,7,15,.5)"/>` : ''}
    ${chip}${mark}
  </svg>`;
}

// --- inline-SVG NES front-loader (room-header hero) ----------------------------
// Trademark-free: neutral "CONTROL DECK" wordmark, classic dark stripes + red
// power LED + a darker inset cartridge flap across the lower ~42%.
function consoleArt(W: number, H: number): string {
  const cw = W * 0.82, cx = (W - cw) / 2, ch = cw * 0.6, cy = (H - ch) / 2 - H * 0.03;
  const n = (x: number) => x.toFixed(1);
  const stripeX = cx + cw * 0.08, stripeW = cw * 0.84;
  const ledX = cx + cw * 0.13, ledY = cy + ch * 0.33, ledR = cw * 0.017;
  const wmX = cx + cw * 0.3, wmY = cy + ch * 0.4, wmW = cw * 0.4, wmH = ch * 0.17;
  const flapX = cx + cw * 0.06, flapY = cy + ch * 0.63, flapW = cw * 0.88, flapH = ch * 0.3;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" role="img">
    <defs>
      <linearGradient id="cd" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e0dcd2"/><stop offset="1" stop-color="#c6c2b7"/>
      </linearGradient>
      <radialGradient id="led" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#ff5a63"/><stop offset="0.55" stop-color="${ACCENT}"/><stop offset="1" stop-color="rgba(230,0,18,0)"/>
      </radialGradient>
    </defs>
    <ellipse cx="${n(cx + cw / 2)}" cy="${n(cy + ch + 8)}" rx="${n(cw * 0.52)}" ry="${n(ch * 0.09)}" fill="rgba(0,0,0,.45)"/>
    <rect x="${n(cx)}" y="${n(cy)}" width="${n(cw)}" height="${n(ch)}" rx="${n(cw * 0.05)}" fill="url(#cd)"/>
    <rect x="${n(cx)}" y="${n(cy)}" width="${n(cw)}" height="3" rx="1.5" fill="rgba(255,255,255,.6)"/>
    <rect x="${n(stripeX)}" y="${n(cy + ch * 0.14)}" width="${n(stripeW)}" height="${n(ch * 0.03)}" fill="#17150f"/>
    <rect x="${n(stripeX)}" y="${n(cy + ch * 0.2)}" width="${n(stripeW)}" height="${n(ch * 0.03)}" fill="#17150f"/>
    <circle cx="${n(ledX)}" cy="${n(ledY)}" r="${n(ledR * 2.6)}" fill="url(#led)"/>
    <circle cx="${n(ledX)}" cy="${n(ledY)}" r="${n(ledR)}" fill="${ACCENT}"/>
    <rect x="${n(cx + cw * 0.78)}" y="${n(cy + ch * 0.29)}" width="${n(cw * 0.05)}" height="${n(ch * 0.06)}" rx="1" fill="#2c2a27"/>
    <rect x="${n(cx + cw * 0.86)}" y="${n(cy + ch * 0.29)}" width="${n(cw * 0.05)}" height="${n(ch * 0.06)}" rx="1" fill="#2c2a27"/>
    <rect x="${n(wmX)}" y="${n(wmY)}" width="${n(wmW)}" height="${n(wmH)}" rx="2" fill="#cbc7bc" stroke="rgba(0,0,0,.25)"/>
    <text x="${n(wmX + wmW / 2)}" y="${n(wmY + wmH * 0.68)}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="${n(wmH * 0.55)}" font-weight="700" letter-spacing="1.5" fill="#6a655b">CONTROL DECK</text>
    <rect x="${n(cx + cw * 0.45)}" y="${n(flapY - ch * 0.04)}" width="${n(cw * 0.1)}" height="${n(ch * 0.05)}" rx="2" fill="#8f8b82"/>
    <rect x="${n(flapX)}" y="${n(flapY)}" width="${n(flapW)}" height="${n(flapH)}" rx="4" fill="#a7a39a"/>
    <rect x="${n(flapX)}" y="${n(flapY)}" width="${n(flapW)}" height="2" fill="rgba(255,255,255,.25)"/>
    <rect x="${n(flapX + flapW * 0.04)}" y="${n(flapY + flapH * 0.5)}" width="${n(flapW * 0.92)}" height="1.5" fill="rgba(0,0,0,.3)"/>
  </svg>`;
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

/** unified navigable shelf entry (placeholder slot OR a dropped "other" cart) */
interface Card {
  item: HTMLElement;
  canPlay: () => boolean;
  play: () => void;
  info: () => void;
  eject: () => void;
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

  // play-enable now keys off .playable (tested OR experimental), gated by the core
  const playable = (r: ResolvedCart | null): r is ResolvedCart => r !== null && r.playable && coreSupported;

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

  const bootCart = (rec: CartRecord, resolved: ResolvedCart | null): void => {
    if (!playable(resolved)) return;
    history.pushState(null, '', '?cart=' + encodeURIComponent(rec.id));
    boot(rec, resolved);
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
    padding:22px 36px 18px;border-bottom:4px solid ${ACCENT};
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
  // the front-loader hero (inline SVG, crisp at any DPR)
  const hero = el('div', 'width:230px;height:132px;flex:0 0 auto;filter:drop-shadow(0 8px 18px rgba(0,0,0,.5))');
  hero.setAttribute('data-console-hero', '');
  hero.innerHTML = consoleArt(230, 132);
  const aboutBtn = document.createElement('button');
  aboutBtn.textContent = 'About this console';
  aboutBtn.setAttribute('data-about', '');
  aboutBtn.style.cssText = `margin-left:auto;padding:9px 18px;border-radius:8px;font-weight:700;cursor:pointer;
    border:2px solid #2a3160;color:#9fb0ff;background:transparent;font:inherit;font-weight:700`;
  aboutBtn.addEventListener('click', openAboutModal);
  header.append(back, marquee, hero, aboutBtn);
  root.appendChild(header);

  const banner = (text: string, attr: string, color: string): void => {
    const b = el('div', `box-sizing:border-box;padding:10px 18px;border:1px solid ${color};border-radius:10px;color:${color};
      background:rgba(0,0,0,.35);font-size:13px;text-align:center;margin-top:18px`);
    b.setAttribute(attr, '');
    b.textContent = text;
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

  // --- compatibility clarity strip (always visible) ------------------------------
  const testedTitles = support.games.map(name => stripSet(catalog?.entries.find(e => e.name === name)?.description ?? name));
  const boardNames = support.slots.map(s => SLOT_PCB[s] ?? s.toUpperCase());
  const stripText = `Tested & verified: ${testedTitles.join(', ') || '—'} · Also playable (experimental): any cart on ${boardNames.join(', ') || 'no'} boards.`;
  const compat = el('div', `max-width:1280px;box-sizing:border-box;margin:12px auto 0;padding:0 36px;
    color:#8b95cf;font-size:12px;text-align:center;line-height:1.6`);
  compat.setAttribute('data-compat-strip', '');
  const cLabel = el('span', `color:${GOLD};font-weight:700`);
  cLabel.textContent = 'Compatibility · ';
  const cText = el('span', '');
  cText.textContent = stripText;
  compat.append(cLabel, cText);
  root.appendChild(compat);

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

  // --- the shelf: verified placeholder row + a divider + "your other cartridges" -
  const board = el('div', 'max-width:1280px;margin:0 auto;padding:0 36px;box-sizing:border-box');
  root.appendChild(board);

  const rowHead = (text: string): HTMLElement => {
    const h = el('div', `display:flex;align-items:center;gap:14px;color:#7f8ac9;font-size:11px;
      font-weight:700;letter-spacing:2px;margin:38px 0 4px`);
    const lab = el('span', 'flex:0 0 auto');
    lab.textContent = text;
    const rule = el('span', 'flex:1;height:1px;background:linear-gradient(90deg,#2a3160,transparent)');
    h.append(lab, rule);
    return h;
  };

  const verifiedHead = rowHead('VERIFIED CARTRIDGE SLOTS');
  board.appendChild(verifiedHead);
  const placeholderRow = el('div', 'display:flex;flex-wrap:wrap;gap:30px 26px;justify-content:center;padding:8px 0 0');
  placeholderRow.setAttribute('data-placeholder-shelf', '');
  board.appendChild(placeholderRow);

  const otherHead = rowHead('YOUR OTHER CARTRIDGES');
  otherHead.style.display = 'none';
  board.appendChild(otherHead);
  const otherRow = el('div', 'display:flex;flex-wrap:wrap;gap:30px 26px;justify-content:center;padding:8px 0 0');
  otherRow.setAttribute('data-cart-shelf', '');
  board.appendChild(otherRow);

  const hint = el('div', 'text-align:center;color:#4b5384;padding:34px 28px 8px;font-size:12px');
  hint.textContent = '↑↓←→ browse · Enter: play · i: info · E: eject · Esc: all systems · in-game: Esc returns here';
  root.appendChild(hint);

  // --- shared button + inline-eject helpers --------------------------------------
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

  // two-step inline eject confirm — no window.confirm, ever
  const armEject = (buttons: HTMLElement, rebuild: () => void, onConfirm: () => void): void => {
    if (buttons.dataset.confirm) return;
    buttons.dataset.confirm = '1';
    buttons.textContent = '';
    const q = el('span', 'font-size:12px;color:#e8b64c;font-weight:700;letter-spacing:.5px');
    q.textContent = 'Eject?';
    const yes = mkBtn('✔', 'data-eject-confirm', false, true);
    yes.style.borderColor = '#e0504d';
    yes.style.color = '#e0504d';
    const no = mkBtn('✕', 'data-eject-cancel', false, true);
    let t: ReturnType<typeof setTimeout>;
    const done = (): void => { clearTimeout(t); delete buttons.dataset.confirm; };
    yes.addEventListener('click', ev => { ev.stopPropagation(); done(); onConfirm(); });
    no.addEventListener('click', ev => { ev.stopPropagation(); done(); rebuild(); });
    buttons.append(q, yes, no);
    t = setTimeout(() => { done(); rebuild(); }, 4000);
  };

  const coverEl = (svg: string, glow: boolean, dim: boolean): HTMLElement => {
    const c = el('div', `width:${CART_W}px;height:${CART_H}px;border-radius:12px;cursor:pointer;
      transition:transform .15s ease, box-shadow .2s ease;
      box-shadow:${glow ? `0 0 34px rgba(90,150,255,.5), 0 12px 24px rgba(0,0,0,.5)` : '0 12px 22px rgba(0,0,0,.45)'};
      ${dim ? 'opacity:.9' : ''}`);
    c.innerHTML = svg;
    return c;
  };

  // --- placeholder slots (one per verified title) --------------------------------
  interface Slot extends Card {
    name: string;
    litRec: CartRecord | null;
    litResolved: ResolvedCart | null;
    light: (rec: CartRecord, resolved: ResolvedCart) => void;
    darken: () => void;
  }
  const slots: Slot[] = [];

  function buildSlot(name: string): Slot {
    const catEntry = catalog?.entries.find(e => e.name === name);
    const targetTitle = stripSet(catEntry?.description ?? name.toUpperCase());
    const targetSub = catEntry ? [catEntry.publisher, catEntry.year].filter(Boolean).join(' · ') : '';

    const item = el('div', `display:flex;flex-direction:column;align-items:center;gap:7px;width:${CART_W}px`);
    item.setAttribute('data-placeholder', name);
    const coverHost = el('div', '');
    const status = el('div', `font-size:10px;font-weight:700;letter-spacing:.8px;text-align:center;min-height:13px;
      max-width:${CART_W}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    status.setAttribute('data-status', '');
    const buttons = el('div', 'display:flex;gap:8px;align-items:center;justify-content:center;min-height:30px');
    item.append(coverHost, status, buttons);

    const slot: Slot = {
      name, item, litRec: null, litResolved: null,
      canPlay: () => slot.litResolved !== null && playable(slot.litResolved),
      play: () => { if (slot.litRec) bootCart(slot.litRec, slot.litResolved); },
      info: () => { if (slot.litRec) openInfoModal(slot.litRec, slot.litResolved, ejectSlotFn(slot)); else openTargetModal(catEntry, name); },
      eject: () => { if (slot.litRec) armEject(buttons, render, () => void ejectSlot(slot)); },
      light: (rec, resolved) => { slot.litRec = rec; slot.litResolved = resolved; render(); },
      darken: () => { slot.litRec = null; slot.litResolved = null; render(); },
    };

    function render(): void {
      const lit = slot.litRec !== null;
      const dumpTitle = lit ? stripSet(slot.litResolved?.meta?.description ?? slot.litRec!.name.replace(/\.[a-z0-9]+$/i, '')) : targetTitle;
      const dumpSub = lit
        ? (slot.litResolved?.meta ? [slot.litResolved.meta.publisher, slot.litResolved.meta.year].filter(Boolean).join(' · ') : `${(slot.litRec!.size / 1024).toFixed(0)} KB`)
        : targetSub;
      item.dataset.state = lit ? 'lit' : 'empty';
      coverHost.innerHTML = '';
      coverHost.appendChild(coverEl(cartSvg({ title: dumpTitle, sub: dumpSub, state: lit ? 'lit' : 'placeholder' }), lit, !lit));
      const cover = coverHost.firstElementChild as HTMLElement;
      cover.onclick = lit ? () => slot.info() : () => picker.click();

      status.style.color = lit ? '#5ecf7a' : '#8b93c4';
      status.textContent = lit ? '✓ VERIFIED' : '◍ DROP DUMP TO PLAY';
      status.title = lit ? `Verified — ${dumpTitle}` : `Drop the ${targetTitle} ROM dump to light this slot`;

      buttons.textContent = '';
      delete buttons.dataset.confirm;
      if (lit) {
        const p = mkBtn('▶ Play', 'data-play', true, slot.canPlay());
        p.addEventListener('click', ev => { ev.stopPropagation(); slot.play(); });
        const i = mkBtn('i', 'data-info', false, true);
        i.addEventListener('click', ev => { ev.stopPropagation(); slot.info(); });
        const e = mkBtn('⏏', 'data-eject', false, true);
        e.addEventListener('click', ev => { ev.stopPropagation(); slot.eject(); });
        buttons.append(p, i, e);
      } else {
        const i = mkBtn('i', 'data-info', false, true);
        i.addEventListener('click', ev => { ev.stopPropagation(); slot.info(); });
        buttons.append(i);
      }
    }

    const ejectSlotFn = (s: Slot) => () => void ejectSlot(s);
    async function ejectSlot(s: Slot): Promise<void> {
      if (s.litRec) { try { await store.remove(s.litRec.id); } catch { /* in-memory / gone */ } }
      s.darken();
      fixSelection();
    }

    render();
    return slot;
  }

  // --- "other" tiles (experimental / unsupported / unreadable dumps) --------------
  interface Other extends Card {
    rec: CartRecord;
    resolved: ResolvedCart | null;
  }
  const others: Other[] = [];

  function buildOther(rec: CartRecord, resolved: ResolvedCart | null): Other {
    const state: CartState = resolved?.tier === 'experimental' ? 'experimental' : 'unsupported';
    const title = stripSet(resolved?.meta?.description ?? rec.name.replace(/\.[a-z0-9]+$/i, ''));
    const dumpSub = resolved?.meta ? [resolved.meta.publisher, resolved.meta.year].filter(Boolean).join(' · ') : `${(rec.size / 1024).toFixed(0)} KB`;
    const canPlay = playable(resolved);

    const item = el('div', `display:flex;flex-direction:column;align-items:center;gap:7px;width:${CART_W}px`);
    item.setAttribute('data-cart-tile', rec.id);
    item.dataset.tier = resolved ? resolved.tier : 'unreadable';

    const cover = coverEl(cartSvg({ title, sub: dumpSub, state }), false, state !== 'experimental');
    cover.onclick = () => other.info();

    const status = el('div', `font-size:10px;font-weight:700;letter-spacing:.8px;text-align:center;min-height:13px;
      max-width:${CART_W}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    status.setAttribute('data-status', '');
    if (!resolved) { status.style.color = '#e0504d'; status.textContent = 'CANNOT READ — EJECT'; }
    else if (resolved.tier === 'experimental') { status.style.color = '#e8b64c'; status.textContent = 'EXPERIMENTAL — UNTESTED'; }
    else { status.style.color = '#8b93c4'; status.textContent = (resolved.reason ?? 'MAPPER NOT SUPPORTED').toUpperCase(); }
    status.title = status.textContent;

    const buttons = el('div', 'display:flex;gap:8px;align-items:center;justify-content:center;min-height:30px');
    const other: Other = {
      rec, resolved, item,
      canPlay: () => canPlay,
      play: () => bootCart(rec, resolved),
      info: () => openInfoModal(rec, resolved, () => void removeOther(other)),
      eject: () => armEject(buttons, rebuild, () => void removeOther(other)),
    };
    function rebuild(): void {
      buttons.textContent = '';
      delete buttons.dataset.confirm;
      const p = mkBtn(state === 'experimental' ? '▶ Play (experimental)' : '▶ Play', 'data-play', true, canPlay);
      p.addEventListener('click', ev => { ev.stopPropagation(); other.play(); });
      const i = mkBtn('i', 'data-info', false, true);
      i.addEventListener('click', ev => { ev.stopPropagation(); other.info(); });
      const e = mkBtn('⏏', 'data-eject', false, true);
      e.addEventListener('click', ev => { ev.stopPropagation(); other.eject(); });
      buttons.append(p, i, e);
    }
    rebuild();
    item.append(cover, status, buttons);
    return other;
  }

  async function removeOther(o: Other): Promise<void> {
    try { await store.remove(o.rec.id); } catch { /* in-memory / gone */ }
    const i = others.indexOf(o);
    if (i >= 0) others.splice(i, 1);
    o.item.remove();
    otherHead.style.display = others.length ? '' : 'none';
    fixSelection();
  }

  // --- navigation ----------------------------------------------------------------
  const cards = (): Card[] => [...slots, ...others];
  let selected = -1;

  const select = (i: number): void => {
    const list = cards();
    if (!list.length) { selected = -1; return; }
    selected = ((i % list.length) + list.length) % list.length;
    list.forEach(c => { c.item.style.outline = 'none'; });
    const c = list[selected];
    c.item.style.outline = `3px solid ${GOLD}`;
    c.item.style.outlineOffset = '3px';
    c.item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const fixSelection = (): void => {
    const list = cards();
    if (!list.length) { selected = -1; return; }
    if (selected >= list.length) selected = list.length - 1;
    if (selected >= 0) select(selected);
  };
  const flash = (item: HTMLElement): void => {
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    item.style.outline = `3px solid ${GOLD}`;
    item.style.outlineOffset = '3px';
    const list = cards();
    setTimeout(() => { if (list[selected]?.item !== item) item.style.outline = 'none'; }, 1400);
  };

  // --- routing a resolved cart to the right shelf --------------------------------
  function route(rec: CartRecord, resolved: ResolvedCart | null, announce: boolean): void {
    if (resolved?.tier === 'tested') {
      const s = slots.find(sl => resolved.meta && (resolved.meta.name === sl.name || resolved.meta.cloneof === sl.name));
      if (s) {
        if (s.litRec && s.litRec.id !== rec.id) { if (announce) flash(s.item); return; } // slot already lit by another dump
        s.light(rec, resolved);
        if (announce) flash(s.item);
        return;
      }
    }
    const o = buildOther(rec, resolved);
    others.push(o);
    otherRow.appendChild(o.item);
    otherHead.style.display = '';
    if (announce) flash(o.item);
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

  // status descriptor for the info-modal subheader
  const badge = (resolved: ResolvedCart | null): { text: string; color: string } => {
    if (!resolved) return { text: 'CANNOT READ — EJECT', color: '#e0504d' };
    if (resolved.tier === 'tested') return { text: `✓ VERIFIED · ${stripSet(resolved.meta?.description ?? '').toUpperCase()}`, color: '#5ecf7a' };
    if (resolved.tier === 'experimental') return { text: 'EXPERIMENTAL — UNTESTED', color: '#e8b64c' };
    return { text: (resolved.reason ?? 'MAPPER NOT SUPPORTED').toUpperCase(), color: '#8b93c4' };
  };

  // info for a physical cart (lit slot OR an "other" tile)
  function openInfoModal(rec: CartRecord, resolved: ResolvedCart | null, onEject: () => void): void {
    const meta = resolved?.meta;
    const b = badge(resolved);
    openModal((scroller, footer, close) => {
      const inner = el('div', 'padding:22px 30px 20px');
      scroller.appendChild(inner);
      const h = el('div', `font-size:24px;font-weight:800;color:${GOLD};line-height:1.2;margin-bottom:2px`);
      h.textContent = meta?.description ?? rec.name;
      const subh = el('div', `font-size:12px;font-weight:700;letter-spacing:.8px;color:${b.color};margin-bottom:14px`);
      subh.textContent = b.text + (resolved?.approx ? ' · PRG match, CHR differs' : '');
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

      const p = footerBtn(resolved?.tier === 'experimental' ? '▶ Play (experimental)' : '▶ Play', true, playable(resolved));
      p.setAttribute('data-play', '');
      p.addEventListener('click', () => { close(); bootCart(rec, resolved); });
      const e = footerBtn('⏏ Eject', false);
      e.setAttribute('data-eject', '');
      e.addEventListener('click', () => { close(); onEject(); });
      const c = footerBtn('Close', false);
      c.addEventListener('click', close);
      footer.append(p, e, c);
      p.focus();
    });
  }

  // info for an EMPTY verified slot — describes the target dump to hunt for
  function openTargetModal(catEntry: SoftEntry | undefined, name: string): void {
    openModal((scroller, footer, close) => {
      const inner = el('div', 'padding:22px 30px 20px');
      scroller.appendChild(inner);
      const h = el('div', `font-size:24px;font-weight:800;color:${GOLD};line-height:1.2;margin-bottom:2px`);
      h.textContent = stripSet(catEntry?.description ?? name.toUpperCase());
      const subh = el('div', 'font-size:12px;font-weight:700;letter-spacing:.8px;color:#8b93c4;margin-bottom:14px');
      subh.textContent = '◍ VERIFIED SLOT — DROP THIS DUMP TO PLAY';
      inner.append(h, subh);

      if (catEntry) {
        const cat = section(inner, 'The verified dump to drop in');
        row(cat, 'Title', catEntry.description);
        if (catEntry.year) row(cat, 'Year', catEntry.year);
        if (catEntry.publisher) row(cat, 'Publisher', catEntry.publisher);
        if (catEntry.pcb) row(cat, 'PCB', catEntry.pcb);
        if (catEntry.prg?.roms[0]) row(cat, 'PRG CRC', catEntry.prg.roms[0].crc);
        if (catEntry.chr?.roms[0]) row(cat, 'CHR CRC', catEntry.chr.roms[0].crc);
        row(cat, 'Softlist name', catEntry.name);
      }
      const note = el('div', 'color:#7f8ac9;font-size:13px;line-height:1.6');
      note.textContent = 'Bring your own legally obtained ROM dump. Drop the .nes (or a .zip containing it) into the slot above and this cartridge lights up — verified and ready to play.';
      inner.appendChild(note);

      const pick = footerBtn('◍ Insert a dump…', true);
      pick.addEventListener('click', () => { close(); picker.click(); });
      const c = footerBtn('Close', false);
      c.addEventListener('click', close);
      footer.append(pick, c);
      pick.focus();
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
    // dedupe against a lit slot or an existing "other" tile
    const litSlot = slots.find(s => s.litRec?.id === id);
    if (litSlot) { flash(litSlot.item); return; }
    const existing = others.find(o => o.rec.id === id);
    if (existing) { flash(existing.item); return; }
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
    route(rec, resolved, true);
    if (selected < 0) select(0);
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
    const perRow = Math.max(1, Math.floor((board.clientWidth) / (CART_W + 26)));
    const list = cards();
    switch (ev.key) {
      case 'ArrowRight': select(selected + 1); ev.preventDefault(); break;
      case 'ArrowLeft': select(selected - 1); ev.preventDefault(); break;
      case 'ArrowDown': select(selected < 0 ? 0 : selected + perRow); ev.preventDefault(); break;
      case 'ArrowUp': select(selected < 0 ? 0 : selected - perRow); ev.preventDefault(); break;
      case 'Enter': if (list[selected]) list[selected].play(); break;
      case 'i': case 'I': if (list[selected]) list[selected].info(); break;
      case 'e': case 'E': if (list[selected]) list[selected].eject(); break;
      case 'Escape': location.href = './?tab=consoles'; break;
    }
  });

  // --- build the verified placeholder row, then load the store --------------------------
  for (const name of support.games) {
    const s = buildSlot(name);
    slots.push(s);
    placeholderRow.appendChild(s.item);
  }
  const recs = await store.list(cfg.game);
  for (const rec of recs) route(rec, resolveRec(rec, catalog, support), false);
  select(0);
}
