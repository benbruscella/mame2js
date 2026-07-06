#!/usr/bin/env node
// Audio "ears" for mame2js development.
//
//   node tools/render-audio.mjs <game> <path/to/game.zip> [frames=2400] [outdir=.]
//
// Runs the game headless, captures the exact soundWrite stream the browser
// worklet would receive, renders it through a faithful replica of the
// worklet DSP at 48 kHz, and emits:
//   <game>-audio.wav          — for human ears
//   <game>-spectrogram.png    — for agent "ears" (0-8 kHz, log magnitude)
//   stdout                    — RMS/peak/DC, per-channel AY note timeline
//
// NOTE: the DSP here mirrors src/runtime/ay8910-worklet.ts by hand; if that
// worklet changes, update this replica (TODO: extract a shared pure module).
// ROMs: dev-time tool — reads the zip path YOU pass; the app itself never
// reads ROMs from anywhere.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [game, zipPath, framesArg, outArg] = process.argv.slice(2);
if (!game || !zipPath) {
  console.error('usage: node tools/render-audio.mjs <game> <game.zip> [frames] [outdir]');
  process.exit(1);
}
const FRAMES = Number(framesArg ?? 2400);
const outDir = resolve(outArg ?? '.');
const root = resolve(new URL('..', import.meta.url).pathname);
const rt = p => pathToFileURL(join(root, 'src/runtime', p)).href;

const { readZip, crc32 } = await import(rt('zip.ts'));
const { findRomBytes } = await import(rt('shell.ts'));
const { createBoard } = await import(rt('boards/index.ts'));
const { AY8910, konamiFilterCaps, lowpass3RCoeff, rcLowPass, KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3 } = await import(rt('ay8910.ts'));

const cfg = JSON.parse(readFileSync(join(root, 'dist', game, 'config.json'), 'utf8'));
const files = await readZip(new Uint8Array(readFileSync(resolve(zipPath))));
const byCrc = new Map();
for (const b of files.values()) byCrc.set(crc32(b), b);
const regions = {};
for (const spec of cfg.roms) {
  const bytes = new Uint8Array(spec.size);
  for (const load of spec.loads) {
    const { bytes: f } = findRomBytes(load, files, byCrc);
    if (f) {
      bytes.set(f.subarray(0, load.size), load.offset);
      for (const ro of load.reloadOffsets ?? []) bytes.set(f.subarray(0, load.size), ro);
    }
  }
  regions[spec.region] = bytes;
}

// --- capture ---------------------------------------------------------------
const init = Object.fromEntries(cfg.ports.map(p => [p.tag, p.init]));
let frame = 0;
const stream = [];
const board = createBoard(cfg.board, regions, { read: t => init[t] ?? 0xff },
  { soundWrite: (o, d) => stream.push([frame, o, d]) });
const fb = new Uint32Array(board.fbWidth * board.fbHeight);
for (frame = 0; frame < FRAMES; frame++) board.frame(fb);
console.log(`captured ${stream.length} writes over ${FRAMES} frames (${(FRAMES / 60).toFixed(0)} s)`);

// --- note timeline (AY register model) --------------------------------------
if (cfg.sound.kind === 'ay8910' || cfg.sound.kind === 'ym2203') {
  const state = new Uint8Array(16);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const note = p => {
    if (!p) return '--';
    const f = cfg.sound.clock / (16 * p);
    const n = Math.round(12 * Math.log2(f / 440) + 69);
    return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
  };
  let si = 0;
  console.log('\nAY ch A/B/C (note vol) every second:');
  for (let f = 0; f < FRAMES; f++) {
    while (si < stream.length && stream[si][0] <= f) { const [, o, d] = stream[si++]; if (o < 0x10) state[o] = d; }
    if (f % 60 === 0) {
      const pa = state[0] | ((state[1] & 0x0f) << 8), pb = state[2] | ((state[3] & 0x0f) << 8), pc = state[4] | ((state[5] & 0x0f) << 8);
      console.log(`${String(f / 60).padStart(3)}s  A:${note(pa).padEnd(4)}${(state[8] & 0x1f).toString(16).padStart(2)}  B:${note(pb).padEnd(4)}${(state[9] & 0x1f).toString(16).padStart(2)}  C:${note(pc).padEnd(4)}${(state[10] & 0x1f).toString(16).padStart(2)}  mix:${state[7].toString(2).padStart(8, '0')}`);
    }
  }
}

// --- render through the worklet-DSP replica ---------------------------------
const SR = 48000, FRAME_OUT = SR / 60;
const nChips = cfg.sound.chips ?? 1;
const chips = Array.from({ length: nChips }, () => new AY8910(cfg.sound.clock));
const step = chips[0].sampleRate / SR;
let frac = 0, boxAvg = 0;
// per-chip-channel Konami RC low-pass (mirrors ay8910-worklet renderBankFiltered)
const filterK = new Array(nChips * 3).fill(1);
const filterMem = new Array(nChips * 3).fill(0);
const setFilter = (chip, portB) => {
  const caps = konamiFilterCaps(portB);
  for (let ch = 0; ch < 3; ch++) {
    const k = caps[ch] === 0 ? 1
      : lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, caps[ch], chips[0].sampleRate);
    if (filterK[chip * 3 + ch] !== k) { filterK[chip * 3 + ch] = k; filterMem[chip * 3 + ch] = 0; }
  }
};
const native = new Float32Array(256);
const chA = new Float32Array(256), chB = new Float32Array(256), chC = new Float32Array(256);
let nPos = 256;
const nextNative = () => {
  if (nPos >= 256) {
    native.fill(0);
    for (let c = 0; c < nChips; c++) {
      chips[c].renderChannels(chA, chB, chC);
      const chans = [chA, chB, chC];
      for (let ch = 0; ch < 3; ch++) {
        const k = filterK[c * 3 + ch];
        if (k !== 1) filterMem[c * 3 + ch] = rcLowPass(chans[ch], k, filterMem[c * 3 + ch]);
        for (let i = 0; i < 256; i++) native[i] += chans[ch][i] / (3 * nChips);
      }
    }
    nPos = 0;
  }
  return native[nPos++];
};
let dacQ = [], dacLevel = 0, dacNext = 0, dacDc = 0, dacRate = 0, dacPrev = 0;
const out = new Float32Array(FRAMES * FRAME_OUT);
let oi = 0, si2 = 0;
for (let f = 0; f < FRAMES; f++) {
  while (si2 < stream.length && stream[si2][0] === f) {
    const [, o, d] = stream[si2++];
    if (o === 0x80) dacQ.push(((d & 0xff) - 128) / 128);
    else if (o >= 0x90 && o < 0x90 + nChips) setFilter(o - 0x90, d);
    else if (o < nChips * 16) { const c = chips[o >> 4]; if (c) c.writeReg(o & 0x0f, d); }
  }
  for (let b = 0; b < FRAME_OUT; b += 128) {
    const arrived = dacQ.length - dacPrev;
    if (arrived > 0) {
      const inst = arrived / Math.max(128, SR / 60);
      dacRate = dacRate ? dacRate * 0.9 + inst * 0.1 : inst;
    }
    const per = dacQ.length ? dacRate * (1 + dacQ.length / (SR / 10)) : 0;
    let pos = 0;
    for (let i = 0; i < 128 && oi < out.length; i++) {
      frac += step; let acc = 0, n = 0;
      while (frac >= 1) { frac -= 1; const s = nextNative(); acc += s; n++; }
      if (n) boxAvg = acc / n;
      pos += per;
      while (pos >= 1 && dacQ.length) { dacLevel = dacNext; dacNext = dacQ.shift(); pos -= 1; }
      let dacOut;
      if (per > 0) dacOut = dacLevel + (dacNext - dacLevel) * Math.min(1, pos);
      else { dacLevel += (dacDc - dacLevel) * 0.005; dacNext = dacLevel; dacOut = dacLevel; }
      dacDc += (dacOut - dacDc) * 0.0008;
      out[oi++] = boxAvg + (dacOut - dacDc) * 0.25;
    }
    dacPrev = dacQ.length;
  }
}
let clip = 0, sum = 0, sumSq = 0, peak = 0;
for (const v of out) { if (Math.abs(v) > 1) clip++; sum += v; sumSq += v * v; peak = Math.max(peak, Math.abs(v)); }
console.log(`\nrendered ${(out.length / SR).toFixed(1)} s | clip ${clip} | DC ${(sum / out.length).toFixed(4)} | RMS ${Math.sqrt(sumSq / out.length).toFixed(3)} | peak ${peak.toFixed(3)}`);

// --- WAV ---------------------------------------------------------------------
const wav = Buffer.alloc(44 + out.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + out.length * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(out.length * 2, 40);
for (let i = 0; i < out.length; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 28000))), 44 + i * 2);
const wavPath = join(outDir, `${game}-audio.wav`);
writeFileSync(wavPath, wav);

// --- spectrogram (agent ears): 1024-pt FFT, hop 512, 0-8 kHz, log mag -------
const N = 1024, HOP = 512;
const framesN = Math.floor((out.length - N) / HOP);
const H = 170; // bins below 8 kHz: 8000/(48000/1024) ≈ 170
const img = new Uint8Array(framesN * H * 3);
const re = new Float32Array(N), im = new Float32Array(N);
const win = new Float32Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
const fft = () => { // in-place radix-2
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
};
for (let t = 0; t < framesN; t++) {
  for (let i = 0; i < N; i++) { re[i] = out[t * HOP + i] * win[i]; im[i] = 0; }
  fft();
  for (let b = 0; b < H; b++) {
    const mag = Math.hypot(re[b], im[b]);
    const db = 20 * Math.log10(mag + 1e-6); // ~[-120, 40]
    const v = Math.max(0, Math.min(255, Math.round(((db + 90) / 90) * 255)));
    const y = H - 1 - b; // low freq at the bottom
    const p = (y * framesN + t) * 3;
    img[p] = v; img[p + 1] = Math.max(0, v - 60); img[p + 2] = Math.min(255, v + 30);
  }
}
const ppm = Buffer.concat([Buffer.from(`P6\n${framesN} ${H}\n255\n`), Buffer.from(img)]);
const ppmPath = join(outDir, `${game}-spectrogram.ppm`);
writeFileSync(ppmPath, ppm);
try {
  execFileSync('sips', ['-s', 'format', 'png', ppmPath, '--out', join(outDir, `${game}-spectrogram.png`)], { stdio: 'ignore' });
  console.log(`wrote ${wavPath} + ${join(outDir, `${game}-spectrogram.png`)}`);
} catch {
  console.log(`wrote ${wavPath} + ${ppmPath} (no sips — PPM left as-is)`);
}
