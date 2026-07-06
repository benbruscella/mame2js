// Self-test for the Space Invaders sound-board HLE.
// Run with: node src/runtime/invaders-sound.spec.ts
// (plain Node, no DOM). Exit code 0 = all PASS.
//
// Port map under test (MAME 0.121 audio/mw8080bw.c):
//   write(0x51, d): D0 UFO on, D1 shot, D2 explosion, D3 invader hit,
//                   D4 bonus base, D5 amp enable      (invaders_audio_1_w)
//   write(0x52, d): D0-D3 fleet thump, D4 saucer hit  (invaders_audio_2_w)

import { InvadersSound } from './invaders-sound.ts';

const RATE = 48000; // fixed native rate of the core

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

const sec = (s: number): number => Math.floor(s * RATE);

// ---------------------------------------------------------------------------
// (a) construction + silence at rest
{
  const snd = new InvadersSound();
  check('native sampleRate is 48000', snd.sampleRate === RATE, `rate=${snd.sampleRate}`);
  const out = new Float32Array(8192).fill(0.5); // ensure render() overwrites
  snd.render(out);
  check('silence when nothing enabled', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (b) UFO: continuous while D0 held, warbling, stops when cleared
{
  const snd = new InvadersSound();
  snd.write(0x51, 0x21); // amp + UFO on
  const out = new Float32Array(sec(2));
  snd.render(out);
  check('UFO sounds while bit held', rms(out, sec(0.1), sec(0.5)) > 0.05,
    `rms=${rms(out, sec(0.1), sec(0.5)).toFixed(4)}`);
  check('UFO is continuous (still sounding after 2 s)',
    rms(out, sec(1.8), sec(2.0)) > 0.05, `lateRms=${rms(out, sec(1.8), sec(2.0)).toFixed(4)}`);
  // SLF triangle starts low and peaks at ~94 ms: pitch must rise (period shrink)
  const pLow = risingPeriod(out, sec(0.005), sec(0.04));
  const pHigh = risingPeriod(out, sec(0.07), sec(0.093));
  check('UFO warbles (frequency sweeps upward into the SLF peak)',
    Number.isFinite(pLow) && Number.isFinite(pHigh) && pHigh < pLow * 0.7,
    `pLow=${pLow.toFixed(1)}, pHigh=${pHigh.toFixed(1)}`);

  snd.write(0x51, 0x20); // UFO off, amp still on
  const off = new Float32Array(sec(0.5));
  snd.render(off);
  check('UFO stops when bit cleared', maxAbs(off, sec(0.3)) < 1e-3,
    `tail=${maxAbs(off, sec(0.3)).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// (c) shot (D1): energy on trigger, decays to silence, edge-retriggered
{
  const snd = new InvadersSound();
  snd.write(0x51, 0x22); // amp + shot rising edge
  const out = new Float32Array(sec(1.2));
  snd.render(out);
  const attack = maxAbs(out, 0, sec(0.1));
  const tail = maxAbs(out, sec(1.1));
  check('shot produces a transient', attack > 0.05, `attack=${attack.toFixed(4)}`);
  check('shot decays to silence', tail < 1e-3, `tail=${tail.toExponential(2)}`);

  snd.write(0x51, 0x22); // still high: no edge
  const held = new Float32Array(sec(0.2));
  snd.render(held);
  check('holding shot bit does not retrigger', maxAbs(held) < 1e-3,
    `maxAbs=${maxAbs(held).toExponential(2)}`);
  snd.write(0x51, 0x20);
  snd.write(0x51, 0x22); // 0 -> 1 edge
  const retrig = new Float32Array(sec(0.2));
  snd.render(retrig);
  check('shot edge retriggers', maxAbs(retrig) > 0.05, `maxAbs=${maxAbs(retrig).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (d) explosion (D2): noise burst with a LONGER decay than the invader hit
{
  const explosion = new InvadersSound();
  explosion.write(0x51, 0x24);
  const eOut = new Float32Array(sec(2.5));
  explosion.render(eOut);
  check('explosion produces energy', rms(eOut, 0, sec(0.2)) > 0.02,
    `rms=${rms(eOut, 0, sec(0.2)).toFixed(4)}`);
  check('explosion decays to silence', maxAbs(eOut, sec(2.3)) < 1e-3,
    `tail=${maxAbs(eOut, sec(2.3)).toExponential(2)}`);

  const invhit = new InvadersSound();
  invhit.write(0x51, 0x28);
  const hOut = new Float32Array(sec(2.5));
  invhit.render(hOut);
  check('invader hit produces energy', rms(hOut, 0, sec(0.1)) > 0.02,
    `rms=${rms(hOut, 0, sec(0.1)).toFixed(4)}`);
  check('invader hit decays to silence', maxAbs(hOut, sec(1.0)) < 1e-3,
    `tail=${maxAbs(hOut, sec(1.0)).toExponential(2)}`);
  // explosion (C24 2.2u one-shot) rings much longer than invader hit (C18 0.1u)
  const eAt400 = rms(eOut, sec(0.4), sec(0.5));
  const hAt400 = rms(hOut, sec(0.4), sec(0.5));
  check('explosion outlasts invader hit', eAt400 > hAt400 * 3,
    `explosion@0.4s=${eAt400.toFixed(4)}, invhit@0.4s=${hAt400.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (e) bonus base (D4): gated beeping while held, silent when cleared
{
  const snd = new InvadersSound();
  snd.write(0x51, 0x30); // amp + bonus
  const out = new Float32Array(sec(1));
  snd.render(out);
  check('bonus base sounds while held', rms(out, sec(0.5)) > 0.02,
    `rms=${rms(out, sec(0.5)).toFixed(4)}`);
  // the 7.42 Hz 555 gates the 480 Hz tone: some 10 ms windows on, some off
  let quiet = 0;
  let loud = 0;
  for (let w = sec(0.1); w + sec(0.01) <= out.length; w += sec(0.01)) {
    if (maxAbs(out, w, w + sec(0.01)) < 1e-3) quiet++;
    else loud++;
  }
  check('bonus tone is on/off gated (beep-beep)', quiet > 3 && loud > 3,
    `quietWins=${quiet}, loudWins=${loud}`);
  snd.write(0x51, 0x20);
  const off = new Float32Array(sec(0.1));
  snd.render(off);
  check('bonus stops when cleared', maxAbs(off, sec(0.05)) < 1e-3,
    `tail=${maxAbs(off, sec(0.05)).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// (f) fleet thump: four bits -> four DIFFERENT dominant periods (555 math:
// 75.8 / 66.1 / 62.1 / 57.6 Hz for bits 0..3), decays when released
{
  const expected = [75.8, 66.1, 62.1, 57.6];
  const periods: number[] = [];
  for (let bit = 0; bit < 4; bit++) {
    const snd = new InvadersSound();
    snd.write(0x52, 1 << bit);
    const out = new Float32Array(sec(1.2));
    snd.render(out);
    const p = risingPeriod(out, sec(0.3), out.length);
    periods.push(p);
    const hz = RATE / p;
    check(`fleet bit ${bit} thumps at ~${expected[bit]} Hz`,
      Number.isFinite(p) && Math.abs(hz - expected[bit]) / expected[bit] < 0.05,
      `measured=${hz.toFixed(1)} Hz`);
  }
  let distinct = true;
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      if (!(Math.abs(periods[a] - periods[b]) / periods[a] > 0.03)) distinct = false;
    }
  }
  check('four fleet bits give four distinct periods', distinct,
    `periods=[${periods.map(p => p.toFixed(0)).join(', ')}]`);

  const snd = new InvadersSound();
  snd.write(0x52, 0x01);
  const on = new Float32Array(sec(0.1));
  snd.render(on);
  check('fleet thump has energy while held', rms(on, sec(0.02)) > 0.05,
    `rms=${rms(on, sec(0.02)).toFixed(4)}`);
  snd.write(0x52, 0x00);
  const off = new Float32Array(sec(0.5));
  snd.render(off);
  check('fleet thump decays after release', maxAbs(off, sec(0.4)) < 1e-3,
    `tail=${maxAbs(off, sec(0.4)).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// (g) saucer hit (port 2 D4): sounds while held, stops after clear
{
  const snd = new InvadersSound();
  snd.write(0x52, 0x10);
  const out = new Float32Array(sec(1));
  snd.render(out);
  check('saucer hit sounds while held', rms(out, sec(0.1)) > 0.05,
    `rms=${rms(out, sec(0.1)).toFixed(4)}`);
  // descending drift: pitch near the start is higher than after 0.8 s
  const pEarly = risingPeriod(out, sec(0.05), sec(0.1));
  const pLate = risingPeriod(out, sec(0.85), sec(0.95));
  check('saucer hit pitch descends while held',
    Number.isFinite(pEarly) && Number.isFinite(pLate) && pLate > pEarly * 1.2,
    `pEarly=${pEarly.toFixed(1)}, pLate=${pLate.toFixed(1)}`);
  snd.write(0x52, 0x00);
  const off = new Float32Array(sec(0.6));
  snd.render(off);
  check('saucer hit stops when cleared', maxAbs(off, sec(0.45)) < 1e-3,
    `tail=${maxAbs(off, sec(0.45)).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// (h) amp gate (port 1 D5 = sound_global_enable): mutes everything
{
  const snd = new InvadersSound();
  snd.write(0x51, 0x02); // shot trigger with amp DISABLED
  snd.write(0x52, 0x01); // fleet held too
  const out = new Float32Array(sec(0.5));
  snd.render(out);
  // ignore the first 50 ms (the ~2 ms anti-click gate ramp)
  check('amp gate mutes all voices', maxAbs(out, sec(0.05)) < 1e-3,
    `maxAbs=${maxAbs(out, sec(0.05)).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// (i) full mix stays within [-1, 1] and actually sums channels
{
  const snd = new InvadersSound();
  snd.write(0x51, 0x3f); // UFO + shot + explosion + invader hit + bonus + amp
  snd.write(0x52, 0x1f); // all fleet bits + saucer hit
  const out = new Float32Array(sec(1));
  snd.render(out);
  check('full mix stays within [-1, 1]', maxAbs(out) <= 1, `maxAbs=${maxAbs(out).toFixed(4)}`);
  check('full mix actually sums channels', maxAbs(out) > 0.3, `maxAbs=${maxAbs(out).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (j) render() is deterministic for the same register sequence
{
  const run = (): Float32Array => {
    const snd = new InvadersSound();
    const out = new Float32Array(3 * 8192);
    snd.write(0x51, 0x21); // UFO
    snd.render(out.subarray(0, 8192));
    snd.write(0x51, 0x23); // + shot
    snd.write(0x52, 0x02); // fleet step 2
    snd.render(out.subarray(8192, 2 * 8192));
    snd.write(0x51, 0x24); // UFO off, explosion
    snd.write(0x52, 0x10); // saucer hit
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
console.log(failures === 0 ? '\nAll Invaders sound tests passed.' : `\n${failures} Invaders sound test(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
