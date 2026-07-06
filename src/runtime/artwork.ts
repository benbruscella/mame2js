// MAME cabinet artwork loading (browser-only). Artwork zips live in the
// user's gitignored artwork/ dir (same copyright treatment as roms/) and are
// served at /artwork/<game>.zip. Bezel PNGs carry a transparent window where
// the CRT sits — findWindow() locates it so the menu can composite covers
// and the shell can play the game inside the real cabinet art.

import { readZip } from './zip.ts';

export interface ArtWindow { x: number; y: number; w: number; h: number }
/** bmp is pre-rotated per the lay's <orientation> (canvas when rotated) */
export interface Artwork { bmp: ImageBitmap | HTMLCanvasElement; window: ArtWindow | null }

/**
 * Load a game's artwork. The zip's MAME `default.lay` layout is the source
 * of truth when present (which PNG is the bezel + the exact screen bounds,
 * same data MAME renders from); the filename heuristic + alpha flood fill
 * are only the fallback for lay-less zips.
 */
export async function loadArtwork(game: string, prefer: 'marquee' | 'bezel'): Promise<Artwork | null> {
  try {
    const res = await fetch(`/artwork/${encodeURIComponent(game)}.zip`);
    if (!res.ok) return null;
    const files = await readZip(new Uint8Array(await res.arrayBuffer()));

    const fromLay = await layArtwork(files);
    if (fromLay) return fromLay;

    const pngs = [...files.entries()].filter(([n]) => n.endsWith('.png'));
    if (!pngs.length) return null;
    const score = (n: string) => {
      const bezel = n.includes('bezel') ? (n.includes('upright') ? 3 : 2) : 0;
      const marquee = n.includes('marquee') ? 4 : 0;
      return prefer === 'marquee' ? Math.max(marquee, bezel) : (bezel ? bezel + 2 : marquee ? 1 : 0);
    };
    pngs.sort((a, b) => score(b[0]) - score(a[0]) || b[1].length - a[1].length);
    const bmp = await createImageBitmap(new Blob([pngs[0][1].slice().buffer], { type: 'image/png' }));
    return { bmp, window: findWindow(bmp) };
  } catch {
    return null;
  }
}

/** Parse MAME default.lay: pick the upright view, resolve its art PNG + screen bounds. */
async function layArtwork(files: Map<string, Uint8Array>): Promise<Artwork | null> {
  const layBytes = files.get('default.lay');
  if (!layBytes) return null;
  const lay = new TextDecoder().decode(layBytes).replace(/<!--[\s\S]*?-->/g, '');

  // element name -> image file
  const images = new Map<string, string>();
  for (const m of lay.matchAll(/<element name="([^"]+)"[^>]*>\s*<image file="([^"]+)"/g)) {
    images.set(m[1], m[2]);
  }

  const bounds = (tag: string) => {
    const b = /<bounds\s+([^/]*)\/>/.exec(tag);
    if (!b) return null;
    const attrs: Record<string, number> = {};
    for (const a of b[1].matchAll(/(\w+)="([\d.]+)"/g)) attrs[a[1]] = Number(a[2]);
    return { x: attrs.x ?? 0, y: attrs.y ?? 0, w: attrs.width, h: attrs.height };
  };

  interface View { name: string; screen: NonNullable<ReturnType<typeof bounds>>; art: NonNullable<ReturnType<typeof bounds>>; file: string; rotate: number }
  const views: View[] = [];
  for (const v of lay.matchAll(/<view name="([^"]+)">([\s\S]*?)<\/view>/g)) {
    const body = v[2];
    const sm = /<screen[^>]*>[\s\S]*?<\/screen>|<screen[^>]*>\s*<bounds[^/]*\/>/.exec(body);
    const am = /<(?:bezel|backdrop|overlay)\s+element="([^"]+)"[^>]*>[\s\S]*?<\/(?:bezel|backdrop|overlay)>/.exec(body);
    if (!sm || !am) continue;
    const screen = bounds(sm[0]);
    const art = bounds(am[0]);
    const file = images.get(am[1]);
    const rotate = Number(/<orientation\s+rotate="(\d+)"/.exec(am[0])?.[1] ?? 0);
    if (screen && art && art.w && art.h && file) views.push({ name: v[1], screen, art, file, rotate });
  }
  if (!views.length) return null;
  // prefer the real cabinet view
  views.sort((a, b) => Number(/upright/i.test(b.name)) - Number(/upright/i.test(a.name)));
  const view = views[0];

  const findFile = (name: string) => files.get(name) ?? files.get(name.toLowerCase());
  const png = findFile(view.file);
  if (!png) return null;
  let bmp: ImageBitmap | HTMLCanvasElement = await createImageBitmap(new Blob([png.slice().buffer], { type: 'image/png' }));
  // honor <orientation rotate="180"> (gyruss ships its bezel upside down):
  // view coords assume the rotated image, so rotate the pixels to match
  if (view.rotate === 180) {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d')!;
    cx.translate(c.width, c.height);
    cx.rotate(Math.PI);
    cx.drawImage(bmp, 0, 0);
    bmp = c;
  }
  // screen bounds are in view coordinates; map into bitmap pixels
  const sx = bmp.width / view.art.w, sy = bmp.height / view.art.h;
  return {
    bmp,
    window: {
      x: (view.screen.x - view.art.x) * sx,
      y: (view.screen.y - view.art.y) * sy,
      w: view.screen.w * sx,
      h: view.screen.h * sy,
    },
  };
}

/** Bounding box of the transparent CRT cut-out, found by flood fill from the center. */
export function findWindow(bmp: ImageBitmap): ArtWindow | null {
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
