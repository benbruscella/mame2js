// Browser shell: ROM loading, canvas presentation (with screen rotation),
// keyboard input, audio bring-up, and the fixed-timestep run loop.
// Pure DOM — no libraries.

import { createBoard } from './boards/index.ts';
import { loadArtwork, type ArtWindow } from './artwork.ts';
import { KeyboardInput, type FieldBinding, type DipDefault, type PortSpec } from './input.ts';
import { AudioOutput } from './audio.ts';
import { readZip, crc32 } from './zip.ts';
import type { Regions, BoardConfig } from './types.ts';

export interface RomLoad {
  file: string; offset: number; size: number; crc: string;
  /** same-slot chips from sibling sets (other revisions of the same game) */
  alt?: { file: string; crc: string }[];
  reloadOffsets?: number[];
}
export interface RomRegionSpec { region: string; size: number; loads: RomLoad[] }

export interface SoundSpec {
  /** SoundCore/worklet kind: 'wsg' | 'galaxian' | 'ay8910' | 'none' */
  kind: string;
  clock?: number;
  /** rom region holding the wavetable (wsg only) */
  waveRegion?: string;
  /** number of sound chips (ay8910: gyruss has 5) */
  chips?: number;
}

/** the ROM drop target's visual states (built by buildDom().dropZone) */
export interface DropZone {
  el: HTMLElement;
  /** a file is hovering over the window */
  armed: () => void;
  idle: () => void;
  busy: (name: string) => void;
  error: (msg: string) => void;
  /** per-chip validation result: colors the manifest + summary line */
  verdict: (check: RomCheck) => void;
}

/** result of checking an uploaded zip against the knowledge-graph manifest */
export interface RomCheck {
  perFile: { region: string; file: string; critical: boolean; status: 'ok' | 'crc' | 'missing' }[];
  missingCritical: string[];
  missingOther: string[];
  crcMismatch: string[];
}

/**
 * Find the zip entry satisfying one manifest slot: the primary chip by
 * name / dash-underscore-swapped name / CRC, else any clone-revision
 * alternate (same slot in a sibling set) by CRC or name.
 */
export function findRomBytes(
  load: RomLoad,
  files: Map<string, Uint8Array>,
  byCrc: Map<number, Uint8Array>,
): { bytes: Uint8Array | null; exact: boolean } {
  const expected = parseInt(load.crc, 16) >>> 0;
  const primary = files.get(load.file.toLowerCase())
    ?? files.get(load.file.toLowerCase().replace(/_/g, '-'))
    ?? byCrc.get(expected);
  if (primary && crc32(primary) === expected) return { bytes: primary, exact: true };
  for (const alt of load.alt ?? []) {
    const altCrc = parseInt(alt.crc, 16) >>> 0;
    const f = byCrc.get(altCrc) ?? files.get(alt.file.toLowerCase());
    if (f && crc32(f) === altCrc) return { bytes: f, exact: true };
  }
  // name matched but unknown bytes: usable, flagged as a CRC difference
  return { bytes: primary ?? null, exact: false };
}

/** Match a zip's contents against the romset manifest without assembling. */
export function checkRomSet(
  specs: RomRegionSpec[],
  files: Map<string, Uint8Array>,
  critical: Set<string>,
): RomCheck {
  const byCrc = new Map<number, Uint8Array>();
  for (const bytes of files.values()) byCrc.set(crc32(bytes), bytes);
  const check: RomCheck = { perFile: [], missingCritical: [], missingOther: [], crcMismatch: [] };
  for (const spec of specs) {
    for (const load of spec.loads) {
      const isCrit = critical.has(spec.region);
      const { bytes, exact } = findRomBytes(load, files, byCrc);
      let status: 'ok' | 'crc' | 'missing';
      if (!bytes) {
        status = 'missing';
        (isCrit ? check.missingCritical : check.missingOther).push(load.file);
      } else if (!exact) {
        status = 'crc';
        check.crcMismatch.push(load.file);
      } else {
        status = 'ok';
      }
      check.perFile.push({ region: spec.region, file: load.file, critical: isCrit, status });
    }
  }
  return check;
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
  // always works, at any stage of loading)
  addEventListener('keydown', ev => {
    if (ev.code !== 'Escape') return;
    ev.preventDefault();
    location.href = cfg.menuUrl ?? './';
  }, { capture: true });

  // --- ROM acquisition -------------------------------------------------------
  // ROMs are NEVER fetched, NEVER stored, NEVER cached — anywhere (hard user
  // directive). The one and only source is a drag-drop in this page load;
  // the bytes live in this page's memory and die with it. Only CPU code
  // regions are boot-critical; other regions warn and zero-fill.
  const critical = new Set(cfg.board.cpus.map(c => c.region));
  const zone = ui.dropZone(cfg.game);
  ui.status(`ROMs are not distributed with mamekit — drop your own ${cfg.game}.zip (never stored).`);
  const files = await waitForZip(ui, zone, cfg.roms, critical);

  const regions = assembleRegions(cfg.roms, files, ui.status, critical);

  // --- machine ----------------------------------------------------------------
  const input = new KeyboardInput(cfg.bindings, cfg.dipDefaults, cfg.ports);
  input.debug = new URLSearchParams(location.search).has('debug');
  input.attach(window);
  if (input.debug) console.log('[input] debug on — bindings:', cfg.bindings, 'ports:', cfg.ports);

  const audio = new AudioOutput();
  const board = createBoard(cfg.board, regions, input, {
    soundWrite: (offset, data, frac) => audio.write(offset, data, frac),
  });
  ui.setNative(board.fbWidth, board.fbHeight); // the board owns true geometry

  const fb = new Uint32Array(board.fbWidth * board.fbHeight);
  const image = new ImageData(
    new Uint8ClampedArray(fb.buffer), board.fbWidth, board.fbHeight);

  // debug/testing handle (also the hook for the future live KG-viewer overlay)
  (window as unknown as Record<string, unknown>).mamekit = { board, input, config: cfg, audio };

  // Start immediately — the menu click that navigated here counts as the
  // user gesture in same-origin sessions. Audio starts in parallel; if the
  // browser still holds the AudioContext suspended, the first real input
  // resumes it without ever blocking gameplay.
  if (cfg.sound.kind !== 'none') {
    const clock = cfg.sound.clock ?? 96000;
    void audio.start(
      {
        sampleRate: clock,
        clock,
        waveRom: cfg.sound.waveRegion ? regions[cfg.sound.waveRegion] : undefined,
        chips: cfg.sound.chips,
      },
      `${cfg.runtimeUrl}${cfg.sound.kind}-worklet.js`,
      cfg.sound.kind,
    ).then(() => {
      // per-core master gains: wsg = MAME route gain 0.90*10/16; the AY bank
      // runs hot against the others — tamed to sit level with them
      const VOLUMES: Record<string, number> = { wsg: 0.5625, ay8910: 0.7 };
      audio.setVolume(VOLUMES[cfg.sound.kind] ?? 1);
    }).catch(err => console.warn('audio unavailable:', err));
    const resumeAudio = () => audio.resume();
    addEventListener('pointerdown', resumeAudio, { once: true });
    addEventListener('keydown', resumeAudio, { once: true });
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
  critical: Set<string> = new Set(),
): Regions {
  // index by CRC too: romset file names drift across MAME versions
  // (gg1-1b.3p vs gg1_1b.3p), but the bytes are the identity
  const byCrc = new Map<number, Uint8Array>();
  for (const bytes of files.values()) byCrc.set(crc32(bytes), bytes);

  const regions: Regions = {};
  const missingCritical: string[] = [];
  const missingOther: string[] = [];
  for (const spec of specs) {
    const bytes = new Uint8Array(spec.size);
    for (const load of spec.loads) {
      // primary chip by name/swapped-name/CRC, else a clone-revision
      // alternate from the same slot (see findRomBytes)
      const { bytes: f, exact } = findRomBytes(load, files, byCrc);
      if (!f) {
        (critical.has(spec.region) ? missingCritical : missingOther).push(load.file);
        continue;
      }
      if (!exact) {
        console.warn(`CRC mismatch for ${load.file} (got ${crc32(f).toString(16)}, want ${load.crc}) — continuing`);
      }
      bytes.set(f.subarray(0, load.size), load.offset);
      for (const ro of load.reloadOffsets ?? []) bytes.set(f.subarray(0, load.size), ro);
    }
    regions[spec.region] = bytes;
  }
  if (missingOther.length) {
    console.warn(`missing non-critical ROM files (zero-filled): ${missingOther.join(', ')}`);
  }
  if (missingCritical.length) {
    status(`Missing ROM files: ${missingCritical.join(', ')}`);
    throw new Error(`missing rom files: ${missingCritical.join(', ')}`);
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

  // cabinet column: screen inside cropped bezel art — no banner/marquee or
  // control panel, the screen is the star
  const cab = document.createElement('div');
  cab.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:0';
  root.appendChild(cab);

  // native frame is rendered landscape; the cabinet monitor is rotated (ROT90).
  // `let` because the BOARD owns the true native size (setNative below):
  // bitmap hardware like junofrst has no GFXDECODE, so the config's raw
  // screen params carry the ×3 pixel-clock width (768) — trusting them
  // squeezed the real 256-wide frame into a corner ("postage stamp").
  const rotated = cfg.board.screen.rotate === 90 || cfg.board.screen.rotate === 270;
  let w = cfg.board.screen.width, h = cfg.board.screen.height;
  let dispW = rotated ? h : w, dispH = rotated ? w : h;

  const holder = document.createElement('div');
  holder.style.cssText = 'position:relative';
  const canvas = document.createElement('canvas');
  canvas.width = dispW; canvas.height = dispH;
  canvas.style.cssText = 'image-rendering:pixelated;background:#000';

  // optional cabinet bezel: the game canvas sits inside its transparent
  // CRT window, the artwork drawn on top (pointer-events off)
  let bezel: { w: number; h: number; win: ArtWindow } | null = null;
  const bezelCanvas = document.createElement('canvas');
  bezelCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';

  const fit = () => {
    const availH = innerHeight - 150;
    if (bezel) {
      const { w, h, win } = bezel;
      const s = Math.min((innerWidth - 40) / w, availH / h);
      holder.style.width = bezelCanvas.style.width = `${w * s}px`;
      holder.style.height = bezelCanvas.style.height = `${h * s}px`;
      const winW = win.w * s, winH = win.h * s;
      const gs = Math.min(winW / dispW, winH / dispH);
      canvas.style.position = 'absolute';
      canvas.style.left = `${win.x * s + (winW - dispW * gs) / 2}px`;
      canvas.style.top = `${win.y * s + (winH - dispH * gs) / 2}px`;
      canvas.style.width = `${dispW * gs}px`;
      canvas.style.height = `${dispH * gs}px`;
    } else {
      const displayScale = Math.max(1, Math.floor(availH / dispH));
      canvas.style.width = `${dispW * displayScale}px`;
      canvas.style.height = `${dispH * displayScale}px`;
    }
  };
  fit();
  addEventListener('resize', fit);
  holder.appendChild(canvas);
  cab.appendChild(holder);

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
    status: (text: string) => { statusEl.textContent = text; if (overlay.style.display !== 'none' && !overlay.querySelector('[data-dropzone]')) overlay.textContent = text; },
    overlayHide: () => { overlay.style.display = 'none'; },
    /** adopt the board's real framebuffer size when it differs from config */
    setNative: (nw: number, nh: number) => {
      if (nw === w && nh === h) return;
      w = nw; h = nh;
      dispW = rotated ? h : w; dispH = rotated ? w : h;
      canvas.width = dispW; canvas.height = dispH;
      off.width = w; off.height = h;
      ctx.imageSmoothingEnabled = false;
      fit();
    },
    // ROM missing: turn the dark CRT into an inviting drop target
    dropZone: (game: string): DropZone => {
      overlay.textContent = '';
      const zone = document.createElement('div');
      zone.dataset.dropzone = '1';
      zone.style.cssText = `border:3px dashed rgba(242,194,0,.65);border-radius:16px;
        padding:34px 40px;max-width:min(440px,84%);background:rgba(8,10,26,.9);
        display:flex;flex-direction:column;align-items:center;gap:8px;
        box-shadow:0 0 0 rgba(242,194,0,0);
        transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease,background .15s ease`;
      const icon = document.createElement('div');
      icon.style.cssText = 'font-size:46px;line-height:1;filter:drop-shadow(0 4px 12px rgba(242,194,0,.35));animation:m2j-bob 2.2s ease-in-out infinite';
      icon.textContent = '🕹️';
      const big = document.createElement('div');
      big.style.cssText = 'font-size:21px;font-weight:800;color:#f2c200';
      big.textContent = `Drop ${game}.zip here`;
      const small = document.createElement('div');
      small.style.cssText = 'color:#9fb0ff';
      small.textContent = 'or click anywhere on the screen to choose the file';
      const note = document.createElement('div');
      note.style.cssText = 'color:#667;font-size:12px;margin-top:6px;max-width:320px';
      note.textContent = 'ROMs are copyrighted and not distributed with mamekit — bring your own dump.';
      const style = document.createElement('style');
      style.textContent = `@keyframes m2j-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        @keyframes m2j-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`;

      // exactly which chips the zip must contain (straight from the knowledge
      // graph); ★ marks CPU code regions the game cannot boot without
      const critical = new Set(cfg.board.cpus.map(c => c.region));
      const manifest = document.createElement('details');
      manifest.style.cssText = 'align-self:stretch;margin-top:8px;text-align:left';
      const sum = document.createElement('summary');
      const nFiles = cfg.roms.reduce((n, r) => n + r.loads.length, 0);
      sum.textContent = `What's inside ${game}.zip? (${nFiles} files)`;
      sum.style.cssText = 'cursor:pointer;color:#9fb0ff;font-size:12px;text-align:center;user-select:none';
      const list = document.createElement('div');
      list.style.cssText = `font:11px/1.7 ui-monospace,monospace;color:#8b93c4;max-height:150px;
        overflow:auto;margin-top:6px;padding:8px 12px;background:rgba(0,0,0,.4);border-radius:8px`;
      const rows = new Map<string, { name: HTMLSpanElement; meta: HTMLSpanElement }>();
      for (const r of cfg.roms) {
        for (const l of r.loads) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:12px';
          const name = document.createElement('span');
          name.textContent = `${critical.has(r.region) ? '★ ' : '  '}${l.file}`;
          if (critical.has(r.region)) name.style.color = '#f2c200';
          const meta = document.createElement('span');
          meta.textContent = `${(l.size / 1024).toFixed(l.size % 1024 ? 1 : 0)} KB · crc ${l.crc}`;
          row.append(name, meta);
          list.appendChild(row);
          rows.set(`${r.region}/${l.file}`, { name, meta });
        }
      }
      const legend = document.createElement('div');
      legend.style.cssText = 'color:#667;font-size:10px;margin-top:4px';
      legend.textContent = '★ CPU code — required to boot · others fall back to zero-fill with a warning';
      list.appendChild(legend);
      manifest.append(sum, list);
      manifest.addEventListener('click', ev => ev.stopPropagation()); // don't open the file picker

      zone.append(style, icon, big, small, note, manifest);
      overlay.appendChild(zone);
      const idle = () => {
        zone.style.transform = '';
        zone.style.borderColor = 'rgba(242,194,0,.65)';
        zone.style.boxShadow = '0 0 0 rgba(242,194,0,0)';
        zone.style.background = 'rgba(8,10,26,.9)';
      };
      return {
        el: zone,
        armed: () => { // file is hovering — light the cabinet up
          zone.style.transform = 'scale(1.045)';
          zone.style.borderColor = '#fff';
          zone.style.boxShadow = '0 0 44px rgba(242,194,0,.55)';
          zone.style.background = 'rgba(20,24,56,.95)';
          big.textContent = 'Release to insert the ROM!';
          icon.textContent = '⚡';
        },
        idle: () => { idle(); big.textContent = `Drop ${game}.zip here`; icon.textContent = '🕹️'; },
        busy: (name: string) => { idle(); icon.textContent = '⏳'; big.textContent = `Reading ${name}…`; small.textContent = ''; },
        error: (msg: string) => {
          idle();
          icon.textContent = '🚫';
          big.textContent = 'That zip didn’t work';
          small.textContent = msg;
          zone.style.borderColor = '#e0504d';
          zone.style.animation = 'm2j-shake .4s';
          setTimeout(() => { zone.style.animation = ''; }, 450);
        },
        verdict: (check: RomCheck) => {
          idle();
          // paint the manifest chip-by-chip: ✓ verified / ≈ crc differs / ✗ absent
          for (const p of check.perFile) {
            const r = rows.get(`${p.region}/${p.file}`);
            if (!r) continue;
            const mark = p.status === 'ok' ? '✓' : p.status === 'crc' ? '≈' : '✗';
            r.name.textContent = `${mark} ${p.file}`;
            r.name.style.color = p.status === 'ok' ? '#5ecf7a' : p.status === 'crc' ? '#e8b64c' : p.critical ? '#e0504d' : '#a06a68';
          }
          if (check.missingCritical.length) {
            manifest.open = true;
            icon.textContent = '🚫';
            big.textContent = 'Wrong romset for this game';
            small.textContent = `${check.missingCritical.length} required CPU chip${check.missingCritical.length > 1 ? 's' : ''} missing — ` +
              `try the "${game}" set. Drop another zip to retry.`;
            zone.style.borderColor = '#e0504d';
            zone.style.animation = 'm2j-shake .4s';
            setTimeout(() => { zone.style.animation = ''; }, 450);
          } else if (check.missingOther.length || check.crcMismatch.length) {
            manifest.open = true;
            icon.textContent = '⚠️';
            big.textContent = 'ROMs accepted — starting…';
            small.textContent = check.missingOther.length
              ? `${check.missingOther.length} non-critical chip${check.missingOther.length > 1 ? 's' : ''} missing (zero-filled)`
              : `${check.crcMismatch.length} chip${check.crcMismatch.length > 1 ? 's' : ''} differ from the reference dump`;
            zone.style.borderColor = '#e8b64c';
            zone.style.boxShadow = '0 0 34px rgba(232,182,76,.4)';
          } else {
            icon.textContent = '✅';
            big.textContent = 'ROM set verified — starting!';
            small.textContent = `All ${check.perFile.length} chips match the reference dump.`;
            zone.style.borderColor = '#5ecf7a';
            zone.style.boxShadow = '0 0 34px rgba(94,207,122,.45)';
          }
        },
      };
    },
    setBezel: (bmp: ImageBitmap | HTMLCanvasElement, win: ArtWindow) => {
      bezelCanvas.width = bmp.width; bezelCanvas.height = bmp.height;
      bezelCanvas.getContext('2d')!.drawImage(bmp, 0, 0);
      holder.insertBefore(bezelCanvas, overlay); // above the game, below the overlay
      bezel = { w: bmp.width, h: bmp.height, win };
      fit();
    },
    blit: (image: ImageData) => {
      offCtx.putImageData(image, 0, 0);
      ctx.save();
      if (cfg.board.screen.rotate === 90) {
        // rotate the native landscape frame clockwise onto the portrait canvas
        ctx.translate(dispW, 0);
        ctx.rotate(Math.PI / 2);
      } else if (cfg.board.screen.rotate === 270) {
        // counter-clockwise (Space Invaders cabinets)
        ctx.translate(0, dispH);
        ctx.rotate(-Math.PI / 2);
      } else if (cfg.board.screen.rotate === 180) {
        ctx.translate(dispW, dispH);
        ctx.rotate(Math.PI);
      }
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    },
  };
}

function waitForZip(
  ui: ReturnType<typeof buildDom>,
  zone: DropZone,
  specs: RomRegionSpec[],
  critical: Set<string>,
): Promise<Map<string, Uint8Array>> {
  return new Promise(resolve => {
    const pick = document.createElement('input');
    pick.type = 'file';
    pick.accept = '.zip';
    let accepted = false;
    const handle = async (file: File) => {
      if (accepted) return;
      zone.busy(file.name);
      const raw = new Uint8Array(await file.arrayBuffer());
      let files: Map<string, Uint8Array>;
      try { files = await readZip(raw); }
      catch { zone.error(`${file.name} isn’t a readable zip — try the original romset.`); return; }
      // grade the set against the manifest BEFORE booting: ticks in the
      // list, and a wrong set bounces back here instead of hanging
      const check = checkRomSet(specs, files, critical);
      zone.verdict(check);
      if (check.missingCritical.length) return; // stay in the loop for a retry
      accepted = true;
      setTimeout(() => resolve(files), 1100); // let the verdict land before the screen lights up
    };
    pick.addEventListener('change', () => { if (pick.files?.[0]) void handle(pick.files[0]); });
    ui.overlay.addEventListener('click', () => pick.click());
    // dragenter/leave fire on every child crossed — depth-count to know when
    // the file has truly left the window
    let depth = 0;
    addEventListener('dragover', ev => ev.preventDefault());
    addEventListener('dragenter', ev => { ev.preventDefault(); if (++depth === 1) zone.armed(); });
    addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.idle(); } });
    addEventListener('drop', ev => {
      ev.preventDefault();
      depth = 0;
      const f = ev.dataTransfer?.files?.[0];
      if (f) void handle(f);
      else zone.idle();
    });
  });
}

