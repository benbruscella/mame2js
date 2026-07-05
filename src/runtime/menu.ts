// Boot menu: a video-store wall of game boxes ("Blockbuster shelves") with
// live search. Browser-only (like shell.ts). Games come from /games.json
// (generated-game manifest served by src/serve.ts); box art is, in order of
// preference:
//   0. the classic promotional flyer (artwork/covers/<game>.png, user-
//      supplied — e.g. adb.arcadeitalia.net/media/mame.current/flyers/)
//   1. cabinet bezel (artwork zip via its default.lay) with a DETERMINISTIC
//      screenshot in the CRT window — the game's own board emulated for a
//      fixed frame count, so the cover is permanent across visits
//   2. the deterministic screenshot alone
//   3. tile art decoded from the game's own gfx ROM (the user's zip)
//   4. a stylized placeholder when no ROM is present
// Nothing here is game-specific: everything comes from the manifest, the
// generated config.json, the ROM bytes, and user-supplied art files.

import { readZip, crc32 } from './zip.ts';
import { decodeGfx, type GfxLayout } from './gfx.ts';
import { loadArtwork } from './artwork.ts';
import { createBoard } from './boards/index.ts';

interface GameEntry {
  game: string;
  title: string;
  fullname: string;
  year: string;
  manufacturer: string;
  family: string;
  hasRom: boolean;
  hasArt: boolean;
}

// Deterministic covers: emulate exactly COVER_FRAMES frames (deep into
// attract mode) and screenshot that frame. Cached forever in localStorage,
// keyed by frame count so changing it regenerates.
const COVER_FRAMES = 900; // ~15 s of attract
const COVER_KEY = (game: string) => `mame2js:cover:${game}:f${COVER_FRAMES}`;

export async function runMenu(): Promise<void> {
  document.title = 'mame2js — game shelf';
  const games: GameEntry[] = await fetch('/games.json').then(r => r.json());
  games.sort((a, b) => a.year.localeCompare(b.year) || a.game.localeCompare(b.game));

  const root = el('div', `min-height:100vh;box-sizing:border-box;margin:0;padding:0 0 60px;
    background:linear-gradient(#06070f, #0b0d1d 30%, #10142a);color:#eee;
    font:14px ui-sans-serif,system-ui`);
  document.body.style.margin = '0';
  document.body.style.background = '#06070f';
  document.body.appendChild(root);

  // --- marquee header ---------------------------------------------------------
  const header = el('div', `display:flex;align-items:center;gap:24px;flex-wrap:wrap;
    padding:26px 36px 18px;border-bottom:4px solid #f2c200;
    background:linear-gradient(#141838,#0c0f24);box-shadow:0 6px 30px rgba(242,194,0,.15)`);
  const marquee = el('div', 'display:flex;flex-direction:column;gap:2px');
  const title = el('div', `font-size:34px;font-weight:800;letter-spacing:3px;
    color:#f2c200;text-shadow:0 0 18px rgba(242,194,0,.55), 0 2px 0 #7a5c00;font-family:ui-monospace,monospace`);
  title.textContent = 'MAME2JS';
  const sub = el('div', 'color:#7f8ac9;letter-spacing:6px;font-size:11px;font-weight:600');
  sub.textContent = 'VIDEO · ARCADE · RENTAL';
  marquee.append(title, sub);

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search titles, makers, years…';
  search.style.cssText = `margin-left:auto;min-width:260px;padding:10px 14px;border-radius:20px;
    border:2px solid #2a3160;background:#0a0c1c;color:#eee;font:14px ui-sans-serif,system-ui;outline:none`;
  search.addEventListener('focus', () => { search.style.borderColor = '#f2c200'; });
  search.addEventListener('blur', () => { search.style.borderColor = '#2a3160'; });
  header.append(marquee, search);
  root.appendChild(header);

  // --- shelves ------------------------------------------------------------------
  const wall = el('div', `display:flex;flex-wrap:wrap;gap:34px 26px;justify-content:center;
    padding:44px 36px 0;max-width:1280px;margin:0 auto`);
  root.appendChild(wall);

  const empty = el('div', 'text-align:center;color:#7f8ac9;padding:60px;display:none;width:100%');
  empty.textContent = 'Nothing on the shelf matches — try another search.';
  wall.appendChild(empty);

  const hint = el('div', 'text-align:center;color:#4b5384;padding:28px;font-size:12px');
  hint.textContent = '↑↓←→ browse · Enter play · type to search · in-game: Esc returns here';
  root.appendChild(hint);

  interface BoxRef { entry: GameEntry; box: HTMLElement; visible: boolean }
  const boxes: BoxRef[] = [];
  let selected = 0;

  for (const entry of games) {
    const box = buildBox(entry);
    boxes.push({ entry, box, visible: true });
    wall.insertBefore(box, empty);
    void paintCover(entry, box.querySelector('canvas')!);
  }
  if (games.length === 0) {
    empty.style.display = 'block';
    empty.textContent = 'No games generated yet — run: mame2js <game> (e.g. mame2js galaga)';
  }

  const select = (i: number) => {
    const vis = boxes.filter(b => b.visible);
    if (!vis.length) return;
    selected = ((i % vis.length) + vis.length) % vis.length;
    boxes.forEach(b => { b.box.style.outline = 'none'; b.box.style.transform = ''; });
    const b = vis[selected];
    b.box.style.outline = '3px solid #f2c200';
    b.box.style.transform = 'translateY(-12px) scale(1.03)';
    b.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const applyFilter = () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const b of boxes) {
      const hay = `${b.entry.title} ${b.entry.manufacturer} ${b.entry.year} ${b.entry.game}`.toLowerCase();
      b.visible = !q || hay.includes(q);
      b.box.style.display = b.visible ? '' : 'none';
      any ||= b.visible;
    }
    empty.style.display = any || games.length === 0 ? 'none' : 'block';
    select(0);
  };
  search.addEventListener('input', applyFilter);

  const launch = () => {
    const vis = boxes.filter(b => b.visible);
    if (vis[selected]) location.href = `?g=${encodeURIComponent(vis[selected].entry.game)}`;
  };

  addEventListener('keydown', ev => {
    if (ev.target === search && ev.key !== 'Enter' && ev.key !== 'ArrowDown') return;
    const perRow = Math.max(1, Math.floor((wall.clientWidth - 72) / 350));
    switch (ev.key) {
      case 'ArrowRight': select(selected + 1); ev.preventDefault(); break;
      case 'ArrowLeft': select(selected - 1); ev.preventDefault(); break;
      case 'ArrowDown': select(selected + perRow); ev.preventDefault(); (ev.target as HTMLElement).blur?.(); break;
      case 'ArrowUp': select(selected - perRow); ev.preventDefault(); break;
      case 'Enter': launch(); break;
      default:
        // start typing anywhere -> search
        if (ev.target !== search && ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) search.focus();
    }
  });
  select(0);

  // --- box construction --------------------------------------------------------

  function buildBox(entry: GameEntry): HTMLElement {
    const item = el('div', 'display:flex;flex-direction:column;align-items:center;cursor:pointer');

    // Netflix-scale tile: big cover, slim label
    const box = el('div', `position:relative;width:320px;height:480px;border-radius:8px 12px 12px 8px;
      background:linear-gradient(105deg,#1b2148,#242c63 55%,#1b2148);
      box-shadow:inset 6px 0 10px -6px #000, inset -2px 0 6px -3px rgba(255,255,255,.25), 0 14px 30px rgba(0,0,0,.6);
      transition:transform .18s ease, box-shadow .18s ease;overflow:hidden`);
    // spine highlight (VHS box left edge)
    box.appendChild(el('div', `position:absolute;left:0;top:0;bottom:0;width:12px;
      background:linear-gradient(90deg, rgba(255,255,255,.22), rgba(0,0,0,.4));pointer-events:none;z-index:3`));

    const cover = document.createElement('canvas');
    cover.width = 600; cover.height = 800; // 2x backing for crisp flyer art
    cover.style.cssText = 'display:block;width:300px;height:400px;margin:10px auto 0;background:#000;border:2px solid #0006';
    box.appendChild(cover);

    const label = el('div', `position:absolute;left:12px;right:0;bottom:0;height:66px;padding:9px 14px 0;
      background:linear-gradient(#f7f3e8,#e8e0c8);color:#1b1b1b;border-top:3px solid #c9b98b`);
    const name = el('div', 'font-weight:800;font-size:17px;line-height:1.15;overflow:hidden;max-height:36px');
    name.textContent = entry.fullname.replace(/\s*\(.*\)$/, ''); // shelf label: drop the set/licence suffix
    const meta = el('div', 'font-size:12px;color:#6b6045;margin-top:4px;letter-spacing:.4px');
    meta.textContent = `${entry.manufacturer} · ${entry.year}`;
    label.append(name, meta);
    box.appendChild(label);

    if (!entry.hasRom) {
      const ribbon = el('div', `position:absolute;top:14px;right:-34px;transform:rotate(38deg);z-index:4;
        background:#c22;color:#fff;font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 38px;
        box-shadow:0 2px 6px rgba(0,0,0,.5)`);
      ribbon.textContent = 'INSERT ROM';
      box.appendChild(ribbon);
    }

    box.addEventListener('mouseenter', () => { box.style.transform = 'translateY(-12px) scale(1.04)'; });
    box.addEventListener('mouseleave', () => { box.style.transform = ''; box.style.outline = 'none'; });
    box.addEventListener('click', () => { location.href = `?g=${encodeURIComponent(entry.game)}`; });

    // shelf plank under each box — planks in a row join into one shelf
    const plank = el('div', `width:350px;height:16px;margin-top:0;border-radius:2px;
      background:linear-gradient(#7a4a1f,#5b3413 60%,#3c2008);
      box-shadow:0 6px 8px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.18)`);

    item.append(box, plank);
    return item;
  }

  // --- cover art -----------------------------------------------------------------

  async function paintCover(entry: GameEntry, canvas: HTMLCanvasElement): Promise<void> {
    const ctx = canvas.getContext('2d')!;
    // 0. the classic promotional flyer (artwork/covers/<game>.png,
    //    user-supplied) — real box art beats anything synthesized
    const flyer = await imageFrom(`/artwork/covers/${encodeURIComponent(entry.game)}.png`);
    if (flyer) {
      const s = Math.max(canvas.width / flyer.width, canvas.height / flyer.height);
      const w = flyer.width * s, h = flyer.height * s;
      ctx.drawImage(flyer, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      return;
    }
    // 1. cabinet artwork frame (drawn immediately; the deterministic
    //    screenshot fills the CRT window when it's ready)
    if (entry.hasArt && await paintArtwork(entry, canvas, ctx)) return;
    // 2. deterministic emulated screenshot alone
    const shot = await coverShot(entry);
    if (shot) {
      const s = Math.min(canvas.width / shot.width, canvas.height / shot.height);
      const w = shot.width * s, h = shot.height * s;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(shot, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      return;
    }
    // 3. tile art from the game's own gfx ROM
    if (entry.hasRom && await paintTileArt(entry, canvas, ctx)) return;
    // 4. placeholder
    paintPlaceholder(entry, canvas, ctx);
  }

  /**
   * Cover from the MAME artwork zip (see artwork.ts): the bezel is drawn
   * right away, and the deterministic screenshot lands in its CRT window
   * once emulated (instant on later visits — it's cached).
   */
  async function paintArtwork(entry: GameEntry, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<boolean> {
    try {
      const art = await loadArtwork(entry.game, 'marquee');
      if (!art) return false;
      const { bmp, window: win } = art;

      // cover-crop transform bezel -> box
      const s = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
      const dx = (canvas.width - bmp.width * s) / 2, dy = (canvas.height - bmp.height * s) / 2;

      const paint = (screen: HTMLImageElement | HTMLCanvasElement | null) => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (win && screen) {
          const wx = dx + win.x * s, wy = dy + win.y * s, ww = win.w * s, wh = win.h * s;
          const fs = Math.min(ww / screen.width, wh / screen.height);
          const fw = screen.width * fs, fh = screen.height * fs;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(screen, wx + (ww - fw) / 2, wy + (wh - fh) / 2, fw, fh);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bmp, dx, dy, bmp.width * s, bmp.height * s);
      };

      paint(null);
      if (win && entry.hasRom) void coverShot(entry).then(shot => { if (shot) paint(shot); });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The permanent cover screenshot: run the game's own board for exactly
   * COVER_FRAMES frames (chunked so the shelf stays responsive), rotate per
   * the config, cache as a data URL. Same ROMs -> same frame, every visit.
   */
  const coverRuns = new Map<string, Promise<HTMLImageElement | null>>();
  function coverShot(entry: GameEntry): Promise<HTMLImageElement | null> {
    let run = coverRuns.get(entry.game);
    if (!run) { run = makeCoverShot(entry); coverRuns.set(entry.game, run); }
    return run;
  }

  async function makeCoverShot(entry: GameEntry): Promise<HTMLImageElement | null> {
    const cached = localStorage.getItem(COVER_KEY(entry.game));
    if (cached) return imageFrom(cached);
    if (!entry.hasRom) return null;
    try {
      const cfg = await fetch(`/${encodeURIComponent(entry.game)}/config.json`).then(r => r.json()) as ShellCfg;
      const regions = await loadRegions(cfg);
      if (!regions) return null;
      const ports = Object.fromEntries(cfg.ports.map(p => [p.tag, p.init]));
      const board = createBoard(cfg.board, regions, { read: t => ports[t] ?? 0xff }, { soundWrite: () => { /* silent */ } });
      const fb = new Uint32Array(board.fbWidth * board.fbHeight);
      for (let f = 0; f < COVER_FRAMES; f += 30) {
        for (let i = 0; i < 30; i++) board.frame(fb);
        await new Promise(r => setTimeout(r)); // yield to keep the shelf responsive
      }
      const native = document.createElement('canvas');
      native.width = board.fbWidth; native.height = board.fbHeight;
      native.getContext('2d')!.putImageData(
        new ImageData(new Uint8ClampedArray(fb.buffer), board.fbWidth, board.fbHeight), 0, 0);
      const rotate = cfg.board.screen.rotate;
      const rot = rotate === 90 || rotate === 270;
      const shot = document.createElement('canvas');
      shot.width = rot ? native.height : native.width;
      shot.height = rot ? native.width : native.height;
      const sctx = shot.getContext('2d')!;
      if (rotate === 90) { sctx.translate(shot.width, 0); sctx.rotate(Math.PI / 2); }
      else if (rotate === 270) { sctx.translate(0, shot.height); sctx.rotate(-Math.PI / 2); }
      else if (rotate === 180) { sctx.translate(shot.width, shot.height); sctx.rotate(Math.PI); }
      sctx.drawImage(native, 0, 0);
      const url = shot.toDataURL('image/png');
      try { localStorage.setItem(COVER_KEY(entry.game), url); } catch { /* storage full — regenerate next time */ }
      return imageFrom(url);
    } catch (err) {
      console.warn(`cover emulation failed for ${entry.game}:`, err);
      return null;
    }
  }

  function imageFrom(url: string): Promise<HTMLImageElement | null> {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });
  }

  interface ShellCfg {
    board: Parameters<typeof createBoard>[0];
    ports: { tag: string; init: number }[];
    romUrl: string;
    roms: { region: string; size: number; loads: { file: string; size: number; offset: number; crc: string }[] }[];
  }

  /** Assemble all ROM regions from the game's zip (name / dash-swap / CRC match). */
  async function loadRegions(cfg: ShellCfg): Promise<Record<string, Uint8Array> | null> {
    const res = await fetch(cfg.romUrl);
    if (!res.ok) return null;
    const files = await readZip(new Uint8Array(await res.arrayBuffer()));
    const byCrc = new Map<number, Uint8Array>();
    for (const b of files.values()) byCrc.set(crc32(b), b);
    const regions: Record<string, Uint8Array> = {};
    for (const spec of cfg.roms) {
      const bytes = new Uint8Array(spec.size);
      for (const load of spec.loads) {
        const f = files.get(load.file.toLowerCase())
          ?? files.get(load.file.toLowerCase().replace(/_/g, '-'))
          ?? byCrc.get(parseInt(load.crc, 16) >>> 0);
        if (f) bytes.set(f.subarray(0, load.size), load.offset);
      }
      regions[spec.region] = bytes;
    }
    return regions;
  }

  async function paintTileArt(entry: GameEntry, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<boolean> {
    try {
      const cfg = await fetch(`/${encodeURIComponent(entry.game)}/config.json`).then(r => r.json());
      const gfxSpec = (cfg.roms as { region: string; size: number; loads: { file: string; size: number; offset: number; crc: string }[] }[])
        .find(r => r.region === 'gfx1');
      if (!gfxSpec) return false;
      const zipBytes = new Uint8Array(await (await fetch(cfg.romUrl)).arrayBuffer());
      const files = await readZip(zipBytes);
      const byCrc = new Map<number, Uint8Array>();
      for (const b of files.values()) byCrc.set(crc32(b), b);
      const region = new Uint8Array(gfxSpec.size);
      for (const load of gfxSpec.loads) {
        const f = files.get(load.file.toLowerCase())
          ?? files.get(load.file.toLowerCase().replace(/_/g, '-'))
          ?? byCrc.get(parseInt(load.crc, 16) >>> 0);
        if (f) region.set(f.subarray(0, load.size), load.offset);
      }
      // decode as generic 2bpp 8x8 tiles (the classic-era common denominator —
      // this is cover art, not emulation)
      const layout: GfxLayout = {
        width: 8, height: 8, total: Math.floor(region.length / 16), planes: 2,
        planeOffsets: [0, 4], xOffsets: [8 * 8 + 0, 8 * 8 + 1, 8 * 8 + 2, 8 * 8 + 3, 0, 1, 2, 3],
        yOffsets: [0 * 8, 1 * 8, 2 * 8, 3 * 8, 4 * 8, 5 * 8, 6 * 8, 7 * 8],
        charIncrement: 16 * 8,
      };
      const set = decodeGfx(layout, region);
      // per-game hue so every box looks distinct
      let hash = 0;
      for (const ch of entry.game) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      const hue = hash % 360;
      const palette = new Uint32Array([
        0xff000000, hsl(hue, 90, 55), hsl((hue + 45) % 360, 90, 70), hsl((hue + 90) % 360, 85, 85),
      ]);
      const cols = Math.floor(canvas.width / 8);
      const rows = Math.floor(canvas.height / 8);
      const img = ctx.createImageData(canvas.width, canvas.height);
      const px = new Uint32Array(img.data.buffer);
      for (let t = 0; t < cols * rows; t++) {
        const tile = t % set.count;
        const ox = (t % cols) * 8, oy = Math.floor(t / cols) * 8;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            px[(oy + y) * canvas.width + ox + x] = palette[set.pixels[tile * 64 + y * 8 + x]];
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      return true;
    } catch {
      return false;
    }
  }

  function paintPlaceholder(entry: GameEntry, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    let hash = 0;
    for (const ch of entry.game) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, `hsl(${hue} 70% 22%)`);
    grad.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 12%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // scanlines
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    for (let y = 0; y < canvas.height; y += 3) ctx.fillRect(0, y, canvas.width, 1);
    ctx.fillStyle = `hsl(${hue} 90% 65%)`;
    ctx.font = '900 84px ui-monospace,monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(entry.game[0].toUpperCase(), canvas.width / 2, canvas.height / 2 + 4);
  }

  function hsl(h: number, s: number, l: number): number {
    // hsl -> packed 0xAABBGGRR for the ImageData Uint32 view
    const a = s * Math.min(l, 100 - l) / 100;
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) / 100) * 255);
    };
    return (0xff << 24 | f(4) << 16 | f(8) << 8 | f(0)) >>> 0;
  }

  function el(tag: string, css: string): HTMLElement {
    const e = document.createElement(tag);
    e.style.cssText = css;
    return e;
  }
}
