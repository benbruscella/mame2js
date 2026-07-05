// Browser shell: ROM loading, canvas presentation (with screen rotation),
// keyboard input, audio bring-up, and the fixed-timestep run loop.
// Pure DOM — no libraries.

import { createBoard } from './boards/index.ts';
import { loadArtwork, type ArtWindow } from './artwork.ts';
import { KeyboardInput, type FieldBinding, type DipDefault, type PortSpec } from './input.ts';
import { AudioOutput } from './audio.ts';
import { readZip, crc32 } from './zip.ts';
import type { Regions, BoardConfig } from './types.ts';

export interface RomLoad { file: string; offset: number; size: number; crc: string; reloadOffsets?: number[] }
export interface RomRegionSpec { region: string; size: number; loads: RomLoad[] }

export interface SoundSpec {
  /** SoundCore/worklet kind: 'wsg' | 'galaxian' | 'none' */
  kind: string;
  clock?: number;
  /** rom region holding the wavetable (wsg only) */
  waveRegion?: string;
}

export interface ShellConfig {
  game: string;
  title: string;
  family: string;
  board: BoardConfig;
  sound: SoundSpec;
  roms: RomRegionSpec[];
  bindings: FieldBinding[];
  dipDefaults: DipDefault[];
  ports: PortSpec[];
  /** url of the zip to try first (e.g. "/roms/galaga.zip") */
  romUrl: string;
  /** base url of the compiled runtime dir (for worklet modules) */
  runtimeUrl: string;
  /** where Esc returns to (the boot menu) */
  menuUrl?: string;
}

export async function runShell(cfg: ShellConfig): Promise<void> {
  const ui = buildDom(cfg);

  // cabinet bezel surround: play inside the real artwork's CRT window
  void loadArtwork(cfg.game, 'bezel').then(art => {
    if (art?.window) ui.setBezel(art.bmp, art.window);
  });

  // Esc: back to the boot menu (registered first + capture so a single press
  // always works, at any stage of loading), saving a box-art snapshot
  addEventListener('keydown', ev => {
    if (ev.code !== 'Escape') return;
    ev.preventDefault();
    ui.saveSnapshot(cfg.game);
    location.href = cfg.menuUrl ?? './';
  }, { capture: true });

  // --- ROM acquisition -------------------------------------------------------
  let files: Map<string, Uint8Array> | null = null;
  try {
    const res = await fetch(cfg.romUrl);
    if (res.ok) files = await readZip(new Uint8Array(await res.arrayBuffer()));
  } catch { /* fall through to manual load */ }

  if (!files) {
    ui.status(`Drop ${cfg.game}.zip here (or click to pick). ROMs are not distributed with mame2js.`);
    files = await waitForZip(ui);
  }

  const regions = assembleRegions(cfg.roms, files, ui.status);

  // --- machine ----------------------------------------------------------------
  const input = new KeyboardInput(cfg.bindings, cfg.dipDefaults, cfg.ports);
  input.debug = new URLSearchParams(location.search).has('debug');
  input.attach(window);
  if (input.debug) console.log('[input] debug on — bindings:', cfg.bindings, 'ports:', cfg.ports);

  const audio = new AudioOutput();
  const board = createBoard(cfg.board, regions, input, {
    soundWrite: (offset, data) => audio.write(offset, data),
  });

  const fb = new Uint32Array(board.fbWidth * board.fbHeight);
  const image = new ImageData(
    new Uint8ClampedArray(fb.buffer), board.fbWidth, board.fbHeight);

  // debug/testing handle (also the hook for the future live KG-viewer overlay)
  (window as unknown as Record<string, unknown>).mame2js = { board, input, config: cfg };

  ui.status('Ready — click or press any key to start');
  await userGesture(ui);
  if (cfg.sound.kind !== 'none') {
    try {
      const clock = cfg.sound.clock ?? 96000;
      await audio.start(
        {
          sampleRate: clock,
          clock,
          waveRom: cfg.sound.waveRegion ? regions[cfg.sound.waveRegion] : undefined,
        },
        `${cfg.runtimeUrl}${cfg.sound.kind}-worklet.js`,
        cfg.sound.kind,
      );
      // wsg: MAME route gain 0.90 * 10/16; other cores bake their own scale
      audio.setVolume(cfg.sound.kind === 'wsg' ? 0.5625 : 1);
    } catch (err) {
      console.warn('audio unavailable:', err);
    }
  }
  ui.overlayHide();

  // --- run loop: fixed timestep at the board's refresh rate --------------------
  const refresh = cfg.board.screen.refresh;
  const frameMs = 1000 / refresh;
  let acc = 0;
  let last = performance.now();
  let frames = 0;
  let fpsWindowStart = last;

  const tick = (now: number) => {
    if (input.debug && now - last > 50) {
      console.log(`[stall] ${Math.round(now - last)}ms between frames at ${Math.round(now)}`);
    }
    acc += now - last;
    last = now;
    if (acc > 5 * frameMs) acc = 5 * frameMs; // don't spiral after a tab pause
    let ran = false;
    while (acc >= frameMs) {
      board.frame(fb);
      acc -= frameMs;
      ran = true;
      frames++;
    }
    if (ran) ui.blit(image);
    if (now - fpsWindowStart >= 1000) {
      const snap = board.snapshot();
      const parts = [`${frames} fps`, `pc=${hex4(snap.cpus[0].pc)}`];
      if (snap.cpus.length > 1) parts.push(`sub=${snap.cpus[1].held ? 'held' : hex4(snap.cpus[1].pc)}`);
      if (snap.credits !== undefined) parts.push(`credits=${snap.credits}`);
      if (input.debug) parts.push(input.dump());
      ui.status(`${cfg.title} — ${parts.join(' · ')}`);
      frames = 0;
      fpsWindowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // NOTE: box-art snapshots are saved only on Esc — toDataURL+localStorage
  // are synchronous and a periodic save visibly hitches the run loop.
}

function hex4(v: number): string { return v.toString(16).padStart(4, '0'); }

// ---------------------------------------------------------------------------

function assembleRegions(
  specs: RomRegionSpec[],
  files: Map<string, Uint8Array>,
  status: (s: string) => void,
): Regions {
  // index by CRC too: romset file names drift across MAME versions
  // (gg1-1b.3p vs gg1_1b.3p), but the bytes are the identity
  const byCrc = new Map<number, Uint8Array>();
  for (const bytes of files.values()) byCrc.set(crc32(bytes), bytes);

  const regions: Regions = {};
  const missing: string[] = [];
  for (const spec of specs) {
    const bytes = new Uint8Array(spec.size);
    for (const load of spec.loads) {
      const expected = parseInt(load.crc, 16) >>> 0;
      // exact name, then name with -/_ swapped, then CRC match
      const f = files.get(load.file.toLowerCase())
        ?? files.get(load.file.toLowerCase().replace(/_/g, '-'))
        ?? byCrc.get(expected);
      if (!f) { missing.push(load.file); continue; }
      if (crc32(f) !== expected) {
        console.warn(`CRC mismatch for ${load.file} (got ${crc32(f).toString(16)}, want ${load.crc}) — continuing`);
      }
      bytes.set(f.subarray(0, load.size), load.offset);
      for (const ro of load.reloadOffsets ?? []) bytes.set(f.subarray(0, load.size), ro);
    }
    regions[spec.region] = bytes;
  }
  if (missing.length) {
    status(`Missing ROM files: ${missing.join(', ')}`);
    throw new Error(`missing rom files: ${missing.join(', ')}`);
  }
  return regions;
}

// ---------------------------------------------------------------------------

function buildDom(cfg: ShellConfig) {
  document.title = cfg.title;
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;min-height:100vh;box-sizing:border-box;background:#111;color:#ddd;font:13px ui-sans-serif,system-ui';
  document.body.style.margin = '0';
  document.body.appendChild(root);

  const h1 = document.createElement('h1');
  h1.textContent = cfg.title;
  h1.style.cssText = 'font-size:15px;font-weight:600;margin:0';
  root.appendChild(h1);

  // native frame is rendered landscape; the cabinet monitor is rotated (ROT90)
  const rotated = cfg.board.screen.rotate === 90 || cfg.board.screen.rotate === 270;
  const w = cfg.board.screen.width, h = cfg.board.screen.height;
  const dispW = rotated ? h : w, dispH = rotated ? w : h;

  const holder = document.createElement('div');
  holder.style.cssText = 'position:relative';
  const canvas = document.createElement('canvas');
  canvas.width = dispW; canvas.height = dispH;
  canvas.style.cssText = 'image-rendering:pixelated;background:#000';

  // optional cabinet bezel: the game canvas sits inside its transparent
  // CRT window, the artwork drawn on top (pointer-events off)
  let bezel: { bmp: ImageBitmap; win: ArtWindow } | null = null;
  const bezelCanvas = document.createElement('canvas');
  bezelCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';

  const fit = () => {
    if (bezel) {
      const { bmp, win } = bezel;
      const s = Math.min((innerHeight - 140) / bmp.height, (innerWidth - 40) / bmp.width);
      holder.style.width = bezelCanvas.style.width = `${bmp.width * s}px`;
      holder.style.height = bezelCanvas.style.height = `${bmp.height * s}px`;
      const winW = win.w * s, winH = win.h * s;
      const gs = Math.min(winW / dispW, winH / dispH);
      canvas.style.position = 'absolute';
      canvas.style.left = `${win.x * s + (winW - dispW * gs) / 2}px`;
      canvas.style.top = `${win.y * s + (winH - dispH * gs) / 2}px`;
      canvas.style.width = `${dispW * gs}px`;
      canvas.style.height = `${dispH * gs}px`;
    } else {
      const displayScale = Math.max(1, Math.floor((innerHeight - 120) / dispH));
      canvas.style.width = `${dispW * displayScale}px`;
      canvas.style.height = `${dispH * displayScale}px`;
    }
  };
  fit();
  addEventListener('resize', fit);
  holder.appendChild(canvas);
  root.appendChild(holder);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;background:rgba(0,0,0,.75);color:#fff;cursor:pointer;padding:20px';
  overlay.textContent = 'Loading…';
  holder.appendChild(overlay);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'color:#999;min-height:1.4em;max-width:640px;text-align:center';
  statusEl.textContent = 'Loading…';
  root.appendChild(statusEl);

  const help = document.createElement('div');
  help.style.cssText = 'color:#666';
  help.textContent = 'Arrows: move · Space or X: fire · 5: coin · 1: start 1P · 2: start 2P · Esc: menu';
  root.appendChild(help);

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const offCtx = off.getContext('2d')!;

  return {
    overlay,
    status: (text: string) => { statusEl.textContent = text; if (overlay.style.display !== 'none') overlay.textContent = text; },
    overlayHide: () => { overlay.style.display = 'none'; },
    setBezel: (bmp: ImageBitmap, win: ArtWindow) => {
      bezelCanvas.width = bmp.width; bezelCanvas.height = bmp.height;
      bezelCanvas.getContext('2d')!.drawImage(bmp, 0, 0);
      holder.insertBefore(bezelCanvas, overlay); // above the game, below the overlay
      bezel = { bmp, win };
      fit();
    },
    blit: (image: ImageData) => {
      offCtx.putImageData(image, 0, 0);
      ctx.save();
      if (rotated) {
        // ROT90: rotate the native landscape frame clockwise onto the portrait canvas
        ctx.translate(dispW, 0);
        ctx.rotate(Math.PI / 2);
      }
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    },
    /** persist the current (rotated) frame as menu box art */
    saveSnapshot: (game: string) => {
      try { localStorage.setItem(`mame2js:snap:${game}`, canvas.toDataURL('image/png')); }
      catch { /* storage full/disabled — menu falls back to tile art */ }
    },
  };
}

function waitForZip(ui: ReturnType<typeof buildDom>): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const pick = document.createElement('input');
    pick.type = 'file';
    pick.accept = '.zip';
    const handle = async (file: File) => {
      try { resolve(await readZip(new Uint8Array(await file.arrayBuffer()))); }
      catch (err) { reject(err); }
    };
    pick.addEventListener('change', () => { if (pick.files?.[0]) void handle(pick.files[0]); });
    ui.overlay.addEventListener('click', () => pick.click());
    addEventListener('dragover', ev => ev.preventDefault());
    addEventListener('drop', ev => {
      ev.preventDefault();
      const f = ev.dataTransfer?.files?.[0];
      if (f) void handle(f);
    });
  });
}

function userGesture(ui: ReturnType<typeof buildDom>): Promise<void> {
  return new Promise(resolve => {
    const done = () => { removeEventListener('keydown', done); ui.overlay.removeEventListener('click', done); resolve(); };
    ui.overlay.addEventListener('click', done);
    addEventListener('keydown', done);
  });
}
