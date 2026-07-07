#!/usr/bin/env node
// A/B audio comparison: our render vs a reference recording (real MAME).
//
//   node tools/compare-audio.mjs <ours.wav> <reference.wav> [outdir=.]
//
// Emits stacked spectrograms (ours-vs-ref.png) and prints a numeric diff:
// per-octave-band energy, RMS, and a coarse onset-rate (tempo proxy), so an
// agent without ears can see EXACTLY how the mix differs from hardware.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const [oursPath, refPath, outArg] = process.argv.slice(2);
if (!oursPath || !refPath) {
  console.error('usage: node tools/compare-audio.mjs <ours.wav> <reference.wav> [outdir]');
  process.exit(1);
}
const outDir = resolve(outArg ?? '.');

function readWav(path) {
  const b = readFileSync(resolve(path));
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: not a WAV`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { codec: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data`);
  if (fmt.codec !== 1 || fmt.bits !== 16) throw new Error(`${path}: need PCM16 (got codec ${fmt.codec}, ${fmt.bits} bits)`);
  const n = Math.floor(data.length / 2 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2);
    out[i] = s / fmt.ch / 32768;
  }
  return { rate: fmt.rate, samples: out };
}

const N = 1024;
function spectroRows(sig, rate, seconds) {
  // resample-free: analyze at native rate, report bins in Hz
  const hop = Math.floor(rate / 93.75); // ~93.75 fps -> aligns 48k hop 512
  const frames = Math.min(Math.floor((sig.length - N) / hop), Math.floor(seconds * 93.75));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float32Array(N), im = new Float32Array(N);
  const fft = () => {
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        const ur = re[i + k], ui = im[i + k];
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  };
  const rows = [];
  for (let t = 0; t < frames; t++) {
    for (let i = 0; i < N; i++) { re[i] = sig[t * hop + i] * win[i]; im[i] = 0; }
    fft();
    const mags = new Float32Array(N / 2);
    for (let b = 0; b < N / 2; b++) mags[b] = Math.hypot(re[b], im[b]);
    rows.push(mags);
  }
  return { rows, binHz: rate / N };
}

const ours = readWav(oursPath);
const ref = readWav(refPath);
const seconds = Math.min(ours.samples.length / ours.rate, ref.samples.length / ref.rate);
console.log(`ours: ${ours.rate} Hz ${(ours.samples.length / ours.rate).toFixed(1)} s | ref: ${ref.rate} Hz ${(ref.samples.length / ref.rate).toFixed(1)} s | comparing ${seconds.toFixed(1)} s`);

const A = spectroRows(ours.samples, ours.rate, seconds);
const B = spectroRows(ref.samples, ref.rate, seconds);

// per-octave band energy (125 Hz .. 8 kHz)
const bands = [125, 250, 500, 1000, 2000, 4000, 8000];
const bandEnergy = (S) => {
  const e = new Array(bands.length).fill(0);
  for (const row of S.rows) {
    for (let b = 0; b < row.length; b++) {
      const hz = b * S.binHz;
      for (let k = 0; k < bands.length; k++) {
        if (hz >= (bands[k - 1] ?? 60) && hz < bands[k]) { e[k] += row[b] ** 2; break; }
      }
    }
  }
  const total = e.reduce((a, x) => a + x, 0) || 1;
  return e.map(x => x / total);
};
const ea = bandEnergy(A), eb = bandEnergy(B);
console.log('\nband      ours    ref     diff(dB)');
bands.forEach((hz, k) => {
  const d = 10 * Math.log10((ea[k] + 1e-9) / (eb[k] + 1e-9));
  console.log(`<${String(hz).padStart(4)}Hz  ${ea[k].toFixed(3)}  ${eb[k].toFixed(3)}  ${d >= 0 ? '+' : ''}${d.toFixed(1)}`);
});

// onset rate (tempo proxy): spectral-flux peaks per second
const onsets = (S) => {
  let count = 0, prev = 0;
  const flux = S.rows.map(r => r.reduce((a, x) => a + x, 0));
  const mean = flux.reduce((a, x) => a + x, 0) / flux.length;
  for (const f of flux) { if (f > mean * 1.4 && prev <= mean * 1.4) count++; prev = f; }
  return count / (S.rows.length / 93.75);
};
console.log(`\nonsets/s: ours ${onsets(A).toFixed(2)} vs ref ${onsets(B).toFixed(2)} (tempo proxy — should match closely)`);

// stacked spectrogram image (ours on top, ref below, same 0-8kHz scale)
const H = 170, W = Math.min(A.rows.length, B.rows.length);
const img = new Uint8Array((H * 2 + 4) * W * 3).fill(24);
const paint = (S, yOff) => {
  for (let t = 0; t < W; t++) {
    for (let y = 0; y < H; y++) {
      const hz = ((H - 1 - y) * 8000) / H;
      const b = Math.min(S.rows[t].length - 1, Math.round(hz / S.binHz));
      const db = 20 * Math.log10(S.rows[t][b] + 1e-6);
      const v = Math.max(0, Math.min(255, Math.round(((db + 90) / 90) * 255)));
      const p = ((y + yOff) * W + t) * 3;
      img[p] = v; img[p + 1] = Math.max(0, v - 60); img[p + 2] = Math.min(255, v + 30);
    }
  }
};
paint(A, 0);
paint(B, H + 4);
const ppmPath = join(outDir, 'ours-vs-ref.ppm');
writeFileSync(ppmPath, Buffer.concat([Buffer.from(`P6\n${W} ${H * 2 + 4}\n255\n`), Buffer.from(img)]));
try {
  execFileSync('sips', ['-s', 'format', 'png', ppmPath, '--out', join(outDir, 'ours-vs-ref.png')], { stdio: 'ignore' });
  console.log(`\nwrote ${join(outDir, 'ours-vs-ref.png')} (top = ours, bottom = reference)`);
} catch { console.log(`\nwrote ${ppmPath}`); }
