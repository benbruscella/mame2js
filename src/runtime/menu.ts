// Boot menu: a video-store wall of game boxes ("Blockbuster shelves") with
// live search. Browser-only (like shell.ts). Games come from /games.json
// (generated-game manifest served by src/serve.ts); box art is, in order of
// preference:
//   1. a real attract-mode snapshot saved by the shell (localStorage)
//   2. tile art decoded from the game's own gfx ROM (the user's zip)
//   3. a stylized placeholder when no ROM is present
// Nothing here is game-specific: everything comes from the manifest, the
// generated config.json, and the ROM bytes.

import { readZip, crc32 } from './zip.ts';
import { decodeGfx, type GfxLayout } from './gfx.ts';

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

const SNAP_KEY = (game: string) => `mame2js:snap:${game}`;

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
    b.box.style.transform = 'translateY(-8px)';
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
    const perRow = Math.max(1, Math.floor((wall.clientWidth - 72) / 206));
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

    const box = el('div', `position:relative;width:180px;height:250px;border-radius:6px 10px 10px 6px;
      background:linear-gradient(105deg,#1b2148,#242c63 55%,#1b2148);
      box-shadow:inset 6px 0 10px -6px #000, inset -2px 0 6px -3px rgba(255,255,255,.25), 0 10px 22px rgba(0,0,0,.55);
      transition:transform .18s ease, box-shadow .18s ease;overflow:hidden`);
    // spine highlight (VHS box left edge)
    box.appendChild(el('div', `position:absolute;left:0;top:0;bottom:0;width:10px;
      background:linear-gradient(90deg, rgba(255,255,255,.22), rgba(0,0,0,.4));pointer-events:none;z-index:3`));

    const cover = document.createElement('canvas');
    cover.width = 160; cover.height = 168;
    cover.style.cssText = 'display:block;width:160px;height:168px;margin:10px auto 0;background:#000;border:2px solid #0006;image-rendering:pixelated';
    box.appendChild(cover);

    const label = el('div', `position:absolute;left:10px;right:0;bottom:0;height:60px;padding:7px 10px 0;
      background:linear-gradient(#f7f3e8,#e8e0c8);color:#1b1b1b;border-top:3px solid #c9b98b`);
    const name = el('div', 'font-weight:800;font-size:13px;line-height:1.15;overflow:hidden;max-height:30px');
    name.textContent = entry.fullname.replace(/\s*\(.*\)$/, ''); // shelf label: drop the set/licence suffix
    const meta = el('div', 'font-size:10px;color:#6b6045;margin-top:3px;letter-spacing:.4px');
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

    box.addEventListener('mouseenter', () => { box.style.transform = 'translateY(-8px) rotate(-1deg)'; });
    box.addEventListener('mouseleave', () => { box.style.transform = ''; box.style.outline = 'none'; });
    box.addEventListener('click', () => { location.href = `?g=${encodeURIComponent(entry.game)}`; });

    // shelf plank under each box — planks in a row join into one shelf
    const plank = el('div', `width:206px;height:14px;margin-top:0;border-radius:2px;
      background:linear-gradient(#7a4a1f,#5b3413 60%,#3c2008);
      box-shadow:0 6px 8px rgba(0,0,0,.6), inset 0 2px 2px rgba(255,255,255,.18)`);

    item.append(box, plank);
    return item;
  }

  // --- cover art -----------------------------------------------------------------

  async function paintCover(entry: GameEntry, canvas: HTMLCanvasElement): Promise<void> {
    const ctx = canvas.getContext('2d')!;
    // 1. real cabinet artwork (MAME artwork zip in <repo>/artwork/, user-supplied)
    if (entry.hasArt && await paintArtwork(entry, canvas, ctx)) return;
    // 2. attract-mode snapshot captured by the shell
    const snap = localStorage.getItem(SNAP_KEY(entry.game));
    if (snap) {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * s, h = img.height * s;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      };
      img.src = snap;
      return;
    }
    // 3. tile art from the game's own gfx ROM
    if (entry.hasRom && await paintTileArt(entry, canvas, ctx)) return;
    // 4. placeholder
    paintPlaceholder(entry, canvas, ctx);
  }

  /**
   * Cover from the MAME artwork zip: prefer marquee, then upright bezel, then
   * largest PNG. Bezels have a transparent window where the CRT sits — fill
   * it with the game's attract-mode snapshot (saved by the shell while
   * playing), falling back to decoded tile art, before drawing the bezel on top.
   */
  async function paintArtwork(entry: GameEntry, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<boolean> {
    try {
      const res = await fetch(`/artwork/${encodeURIComponent(entry.game)}.zip`);
      if (!res.ok) return false;
      const files = await readZip(new Uint8Array(await res.arrayBuffer()));
      const pngs = [...files.entries()].filter(([n]) => n.endsWith('.png'));
      if (!pngs.length) return false;
      const score = (n: string) =>
        n.includes('marquee') ? 4 : n.includes('bezel') && n.includes('upright') ? 3 : n.includes('bezel') ? 2 : 1;
      pngs.sort((a, b) => score(b[0]) - score(a[0]) || b[1].length - a[1].length);
      const bmp = await createImageBitmap(new Blob([pngs[0][1].slice().buffer], { type: 'image/png' }));

      // cover-crop transform bezel -> box
      const s = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
      const dx = (canvas.width - bmp.width * s) / 2, dy = (canvas.height - bmp.height * s) / 2;

      // find the CRT window: flood from the bezel center over transparent pixels
      const win = findWindow(bmp);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (win) {
        const wx = dx + win.x * s, wy = dy + win.y * s, ww = win.w * s, wh = win.h * s;
        const screen = await screenImage(entry);
        if (screen) {
          // contain-fit the screen inside the window
          const fs = Math.min(ww / screen.width, wh / screen.height);
          const fw = screen.width * fs, fh = screen.height * fs;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(screen, wx + (ww - fw) / 2, wy + (wh - fh) / 2, fw, fh);
        } else if (entry.hasRom) {
          // no snapshot yet — tile art peeks through the glass
          const sub = document.createElement('canvas');
          sub.width = Math.max(8, Math.round(ww)); sub.height = Math.max(8, Math.round(wh));
          const subCtx = sub.getContext('2d')!;
          if (await paintTileArt(entry, sub, subCtx)) ctx.drawImage(sub, wx, wy);
        }
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(bmp, dx, dy, bmp.width * s, bmp.height * s);
      return true;
    } catch {
      return false;
    }
  }

  /** The attract-mode snapshot the shell saves while a game runs, if any. */
  function screenImage(entry: GameEntry): Promise<HTMLImageElement | null> {
    const snap = localStorage.getItem(SNAP_KEY(entry.game));
    if (!snap) return Promise.resolve(null);
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = snap;
    });
  }

  /** Bounding box of the transparent CRT cut-out, found by flood fill from the center. */
  function findWindow(bmp: ImageBitmap): { x: number; y: number; w: number; h: number } | null {
    const scale = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;
    pctx.drawImage(bmp, 0, 0, w, h);
    const alpha = pctx.getImageData(0, 0, w, h).data;
    const clear = (x: number, y: number) => alpha[(y * w + x) * 4 + 3] < 16;
    const cx = w >> 1, cy = h >> 1;
    if (!clear(cx, cy)) return null; // center is painted — no window (marquee art etc.)
    const seen = new Uint8Array(w * h);
    const stack = [cy * w + cx];
    seen[stack[0]] = 1;
    let minX = cx, maxX = cx, minY = cy, maxY = cy;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (!seen[np] && clear(nx, ny)) { seen[np] = 1; stack.push(np); }
      }
    }
    return { x: minX / scale, y: minY / scale, w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale };
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
