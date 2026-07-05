// Self-test for the Galaxian discrete sound core.
// Run with: node src/runtime/galaxian-sound.spec.ts
// (plain Node, no DOM). Exit code 0 = all PASS.

import { GalaxianSound } from './galaxian-sound.ts';

const CLOCK = 3072000; // 18.432 MHz / 6 (pixel clock); core rate = /32 = 96 kHz
const RATE = CLOCK / 32;

let failures = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    failures++;
  }
}

function maxAbs(buf: Float32Array, start: number = 0, end: number = buf.length): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
}

function rms(buf: Float32Array, start: number = 0, end: number = buf.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / (end - start));
}

/** Mean distance between rising zero crossings inside [start, end). */
function risingPeriod(buf: Float32Array, start: number, end: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = start + 1; i < end; i++) {
    if (buf[i - 1] <= 0 && buf[i] > 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  return count > 1 ? (last - first) / (count - 1) : NaN;
}

/** Smallest exact repetition period of a deterministic stepped waveform. */
function exactPeriod(buf: Float32Array, start: number, window: number, maxP: number): number {
  for (let p = 2; p <= maxP; p++) {
    let ok = true;
    for (let i = 0; i < window; i++) {
      if (buf[start + i] !== buf[start + i + p]) { ok = false; break; }
    }
    if (ok) return p;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// (a) silence when nothing is enabled
{
  const snd = new GalaxianSound(CLOCK);
  const out = new Float32Array(8192).fill(0.5); // ensure render() overwrites
  snd.render(out);
  check('silence when nothing enabled', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (b) enabling a background voice produces a periodic square wave
// LFO not armed yet -> freq stays at MAXFREQ 185 -> voice 0 = 370 Hz.
{
  const snd = new GalaxianSound(CLOCK);
  snd.write(0x00, 1); // FS1 on
  const out = new Float32Array(RATE); // 1 s
  snd.render(out);
  const expected = RATE / (2 * 185); // ~259.46 samples
  const measured = risingPeriod(out, 0, out.length);
  const err = Math.abs(measured - expected) / expected;
  check(
    'background voice is periodic at the unswept LFO pitch (<2% error)',
    Number.isFinite(measured) && err < 0.02,
    `expected=${expected.toFixed(2)}, measured=${measured.toFixed(2)}`,
  );
  check('background voice has nonzero amplitude', maxAbs(out) > 0.01, `maxAbs=${maxAbs(out).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (c) LFO register write arms the sweep: hum pitch descends over time
// (freq sweeps MAXFREQ 185 -> MINFREQ 93, so the period grows)
{
  const snd = new GalaxianSound(CLOCK);
  snd.write(0x00, 1); // FS1 on
  snd.write(0x10, 1); // LFO bit 0 -> arms the sweep timer (~125 ms full sweep)
  const out = new Float32Array(Math.floor(0.125 * RATE));
  snd.render(out);
  const early = risingPeriod(out, 0, Math.floor(0.03 * RATE));
  const late = risingPeriod(out, Math.floor(0.08 * RATE), Math.floor(0.115 * RATE));
  check(
    'LFO write starts the sweep: period grows as freq descends',
    Number.isFinite(early) && Number.isFinite(late) && late > early * 1.15,
    `early=${early.toFixed(1)}, late=${late.toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------
// (d) pitch register sets the tone period: period = (256 - pitch) samples
// (16-step counter clocked at SOUND_CLOCK/(256-pitch), 16 inner steps/sample)
{
  const measureTonePeriod = (pitch: number): number => {
    const snd = new GalaxianSound(CLOCK);
    snd.write(0x06, 1); // VOL1
    snd.write(0x07, 1); // VOL2 -> vol 3, QD in the mix (full 16-step pattern)
    snd.write(0x20, pitch);
    const out = new Float32Array(8192);
    snd.render(out);
    return exactPeriod(out, 2048, 1024, 512);
  };
  const p80 = measureTonePeriod(0x80);
  const pC0 = measureTonePeriod(0xc0);
  check('tone period for pitch 0x80 is 128 samples', p80 === 128, `measured=${p80}`);
  check('tone period for pitch 0xc0 is 64 samples', pC0 === 64, `measured=${pC0}`);
  check('higher pitch value -> shorter period (monotonic)', pC0 < p80, `${pC0} < ${p80}`);

  // pitch 0xff = counter off = silence
  const snd = new GalaxianSound(CLOCK);
  snd.write(0x06, 1);
  snd.write(0x07, 1);
  snd.write(0x20, 0xff);
  const out = new Float32Array(4096);
  snd.render(out);
  check('pitch 0xff silences the tone', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (e) volume bits: setting either VOL bit raises the tone level
// (each bit gates an extra resistor into the mix -> bitwise monotone RMS)
{
  const toneRms = (vol1: number, vol2: number): number => {
    const snd = new GalaxianSound(CLOCK);
    snd.write(0x06, vol1);
    snd.write(0x07, vol2);
    snd.write(0x20, 0x40);
    const out = new Float32Array(RATE / 4);
    snd.render(out);
    return rms(out, 4096);
  };
  const r0 = toneRms(0, 0);
  const r1 = toneRms(1, 0);
  const r2 = toneRms(0, 1);
  const r3 = toneRms(1, 1);
  const detail = `rms=[${r0.toFixed(4)}, ${r1.toFixed(4)}, ${r2.toFixed(4)}, ${r3.toFixed(4)}]`;
  check('setting VOL1 raises tone level', r1 > r0 && r3 > r2, detail);
  check('setting VOL2 raises tone level', r2 > r0 && r3 > r1, detail);
}

// ---------------------------------------------------------------------------
// (f) fire trigger: transient that decays to silence; retrigger works
{
  const snd = new GalaxianSound(CLOCK);
  snd.write(0x05, 1); // FIRE rising edge
  const out = new Float32Array(Math.floor(2.2 * RATE));
  snd.render(out);
  const attack = maxAbs(out, 0, Math.floor(0.1 * RATE));
  const tail = maxAbs(out, Math.floor(1.9 * RATE), out.length);
  check('fire produces a transient', attack > 0.1, `attack=${attack.toFixed(4)}`);
  check('fire decays to silence', tail < 1e-3, `tail=${tail.toExponential(2)}`);

  // holding FIRE high must NOT retrigger; a 0->1 edge must
  snd.write(0x05, 1);
  const held = new Float32Array(4096);
  snd.render(held);
  check('holding fire does not retrigger', maxAbs(held) < 1e-3, `maxAbs=${maxAbs(held).toExponential(2)}`);
  snd.write(0x05, 0);
  snd.write(0x05, 1);
  const retrig = new Float32Array(4096);
  snd.render(retrig);
  check('fire edge retriggers the shoot', maxAbs(retrig) > 0.1, `maxAbs=${maxAbs(retrig).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (g) noise enable: broadband output; explosion envelope decays after disable
{
  const snd = new GalaxianSound(CLOCK);
  snd.write(0x03, 1); // HIT on
  const on = new Float32Array(Math.floor(0.5 * RATE));
  snd.render(on);
  const onRms = rms(on, 4096);
  check('noise enable produces output', onRms > 0.02, `rms=${onRms.toFixed(4)}`);
  // broadband: both polarities, not a fixed level
  let mn = 1, mx = -1;
  for (let i = 4096; i < on.length; i++) { mn = Math.min(mn, on[i]); mx = Math.max(mx, on[i]); }
  check('noise output is bipolar/broadband', mn < -0.05 && mx > 0.05, `min=${mn.toFixed(3)}, max=${mx.toFixed(3)}`);

  snd.write(0x03, 0); // HIT off -> integer decay every ~27 ms
  const off = new Float32Array(Math.floor(1.2 * RATE));
  snd.render(off);
  const tail = rms(off, off.length - Math.floor(0.2 * RATE));
  check('noise decays to silence after disable', tail < 1e-4, `tailRms=${tail.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// (h) everything at once stays within [-1, 1]
{
  const snd = new GalaxianSound(CLOCK);
  snd.write(0x00, 1);
  snd.write(0x01, 1);
  snd.write(0x02, 1);
  snd.write(0x03, 1); // noise
  snd.write(0x05, 1); // fire
  snd.write(0x06, 1);
  snd.write(0x07, 1);
  snd.write(0x20, 0x60); // tone on
  snd.write(0x10, 1);    // LFO sweeping
  const out = new Float32Array(RATE); // 1 s
  snd.render(out);
  check('full mix stays within [-1, 1]', maxAbs(out) <= 1, `maxAbs=${maxAbs(out).toFixed(4)}`);
  check('full mix actually sums channels', maxAbs(out) > 0.3, `maxAbs=${maxAbs(out).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (i) render() is deterministic for the same register sequence
{
  const run = (): Float32Array => {
    const snd = new GalaxianSound(CLOCK);
    const out = new Float32Array(3 * 8192);
    snd.write(0x00, 1);
    snd.write(0x10, 1);
    snd.write(0x20, 0x55);
    snd.write(0x06, 1);
    snd.render(out.subarray(0, 8192));
    snd.write(0x05, 1);
    snd.write(0x03, 1);
    snd.render(out.subarray(8192, 2 * 8192));
    snd.write(0x03, 0);
    snd.write(0x07, 1);
    snd.render(out.subarray(2 * 8192));
    return out;
  };
  const a = run();
  const b = run();
  let same = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { same = false; break; }
  }
  check('deterministic output for identical register sequences', same);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nAll Galaxian sound tests passed.' : `\n${failures} Galaxian sound test(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
