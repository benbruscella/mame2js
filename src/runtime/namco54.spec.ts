// Self-test for the Namco 54xx noise HLE. Run with: node src/runtime/namco54.spec.ts
// (plain Node, no DOM). Exit code 0 = all PASS.
//
// The command sequences below are the REAL galaga traffic, captured from
// this repo's headless board harness (roms/galaga.zip -> GalagaBoard,
// logging 06xx slot-3 writes):
//   boot init (~frame 713):        30 40 00 02 df  40 30 30 03 df  10 20
//   player death (attract + game): 10 10 20 20
// Per the protocol (MAME src/devices/audio/namco54.cpp): 3x/4x = set params
// type A/B (+4 bytes each), 1x/2x = play type A/B, 5x = play C,
// 6x = params C (+5 bytes), 7x = volume C, 0x/8x-Fx = nop.

import { Namco54 } from './namco54.ts';

const RATE = 96000; // same native rate as the WSG on galaga

let failures = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    failures++;
  }
}

function maxAbs(buf: Float32Array): number {
  let m = 0;
  for (const s of buf) m = Math.max(m, Math.abs(s));
  return m;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (const s of buf) sum += s * s;
  return Math.sqrt(sum / buf.length);
}

/** galaga boot parameter block (no play commands) */
const BOOT_PARAMS = [0x30, 0x40, 0x00, 0x02, 0xdf, 0x40, 0x30, 0x30, 0x03, 0xdf];
/** galaga player-death burst (as written through the 06xx, twice each) */
const EXPLOSION = [0x10, 0x10, 0x20, 0x20];

function makeBootstrapped(): Namco54 {
  const n = new Namco54(RATE);
  for (const b of BOOT_PARAMS) n.write(b);
  return n;
}

// ---------------------------------------------------------------------------
// (a) bit-exact silence before any trigger
{
  const n = new Namco54(RATE);
  const out = new Float32Array(RATE).fill(0.5); // ensure render() overwrites
  n.render(out);
  check('silence before any trigger', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (b) housekeeping stays silent: galaga's boot parameter block (3x/4x with
// their parameter bytes) and nops (0x, 8x-Fx) produce no sound
{
  const n = makeBootstrapped();
  n.write(0x00);
  n.write(0x8f);
  n.write(0xf3);
  const out = new Float32Array(RATE);
  n.render(out);
  check('boot params + nops stay silent', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (c) parameter bytes are consumed raw: the 0x10/0x40 bytes INSIDE a 3x
// parameter block must not retrigger/re-dispatch as commands
{
  const n = new Namco54(RATE);
  for (const b of [0x30, 0x10, 0x10, 0x40, 0x20]) n.write(b); // all params of 3x
  const out = new Float32Array(RATE);
  n.render(out);
  check('param bytes not parsed as commands', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (d) the captured galaga explosion sequence produces a burst that decays
// to silence (type A params 40 00 02 df -> ~1.2 s; B 30 30 03 df -> ~0.9 s)
{
  const n = makeBootstrapped();
  for (const b of EXPLOSION) n.write(b);
  const buf = new Float32Array(RATE * 3);
  n.render(buf);
  const head = buf.subarray(0, RATE / 5);              // first 200 ms
  const tail = buf.subarray(RATE * 2, RATE * 3);       // 2.0 s .. 3.0 s
  check('explosion bursts', rms(head) > 0.05 && maxAbs(head) > 0.2,
    `headRms=${rms(head).toFixed(4)} headPeak=${maxAbs(head).toFixed(3)}`);
  check('explosion decays to silence', rms(tail) < 1e-3, `tailRms=${rms(tail).toExponential(2)}`);
  // monotonic-ish decay: quarter-second RMS windows never grow much
  let decaying = true;
  let prev = Infinity;
  for (let w = 0; w < 8; w++) {
    const r = rms(buf.subarray(w * RATE / 4, (w + 1) * RATE / 4));
    if (r > 1e-4 && r > prev * 1.25) decaying = false; // ignore noise-floor jitter
    prev = r;
  }
  check('explosion envelope decays', decaying);
}

// ---------------------------------------------------------------------------
// (e) retriggerable: a second explosion after the first has died away
{
  const n = makeBootstrapped();
  for (const b of EXPLOSION) n.write(b);
  const first = new Float32Array(RATE * 2);
  n.render(first); // 2 s: burst + full decay
  const quiet = new Float32Array(RATE / 2);
  n.render(quiet);
  for (const b of EXPLOSION) n.write(b);
  const second = new Float32Array(RATE / 2);
  n.render(second);
  check('silent between explosions', rms(quiet) < 1e-3, `rms=${rms(quiet).toExponential(2)}`);
  check('retrigger bursts again', rms(second) > 0.05, `rms=${rms(second).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (f) deterministic: two cores fed the same bytes render identical samples
{
  const a = makeBootstrapped();
  const b = makeBootstrapped();
  for (const c of EXPLOSION) { a.write(c); b.write(c); }
  const bufA = new Float32Array(RATE);
  const bufB = new Float32Array(RATE);
  a.render(bufA);
  b.render(bufB);
  let same = true;
  for (let i = 0; i < bufA.length; i++) if (bufA[i] !== bufB[i]) { same = false; break; }
  check('deterministic output', same);
}

// ---------------------------------------------------------------------------
// (g) output bounded in [-1, 1] even with all three channels at full tilt
{
  const n = makeBootstrapped();
  n.write(0x7f);                    // type C volume 15
  for (const b of [0x10, 0x20, 0x50]) n.write(b);
  const out = new Float32Array(RATE * 2);
  n.render(out);
  check('output stays in [-1, 1]', maxAbs(out) <= 1, `maxAbs=${maxAbs(out).toFixed(4)}`);
  check('all-channel burst is nonzero', rms(out.subarray(0, RATE / 4)) > 0.05);
}

// ---------------------------------------------------------------------------
// (h) type C volume command: volume 0 mutes a type-C trigger (galaga never
// uses type C; bosco/polepos do — 7x per namco54.cpp)
{
  const n = new Namco54(RATE);
  n.write(0x70);  // volume C = 0
  n.write(0x50);  // play C
  const out = new Float32Array(RATE);
  n.render(out);
  check('type C at volume 0 is silent', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);

  const loud = new Namco54(RATE);
  loud.write(0x7f); // volume C = 15
  loud.write(0x50); // play C
  const out2 = new Float32Array(RATE);
  loud.render(out2);
  check('type C at volume 15 sounds', rms(out2.subarray(0, RATE / 4)) > 0.01,
    `rms=${rms(out2.subarray(0, RATE / 4)).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\nAll Namco54 tests passed.' : `\n${failures} Namco54 test(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
