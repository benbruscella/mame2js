// Self-test for the NES 2A03 APU core. Run with: node src/runtime/nes-apu.spec.ts
// (plain Node, no DOM). Exit code 0 = all PASS.
//
// References: MAME src/devices/sound/nes_apu.cpp and nesdev.org APU docs.
// See nes-apu.ts header for the deliberate deviations. The core renders at
// its native rate (clock/2 = one sample per APU cycle); these tests drive it
// directly with no resampling.

import {
  NesApu,
  Envelope,
  Noise,
  DUTY,
  NES_LENGTH_TABLE,
  NES_NOISE_PERIODS,
  NES_DMC_RATES,
  NES_PULSE_MIX,
  NES_TND_MIX,
} from './nes-apu.ts';

// NTSC 2A03: master 21.477270 MHz / 12 = 1.789773 MHz CPU clock. The core's
// `clock` is the CPU clock; sampleRate = clock/2 (APU cycle rate).
const CLOCK = 1789773;

let failures = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    failures++;
  }
}
function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}
/** Average spacing between rising zero crossings after `from`. */
function crossingSpacing(out: Float32Array, from: number): number {
  let prev = -1;
  let sum = 0;
  let n = 0;
  for (let i = Math.max(1, from); i < out.length; i++) {
    if (out[i - 1] <= 0 && out[i] > 0) {
      if (prev >= 0) {
        sum += i - prev;
        n++;
      }
      prev = i;
    }
  }
  return n > 0 ? sum / n : NaN;
}
/** Largest sample-to-sample jump after `from` — AC content, DC-offset immune. */
function acLevel(out: Float32Array, from = 50): number {
  let m = 0;
  for (let i = Math.max(1, from); i < out.length; i++) {
    m = Math.max(m, Math.abs(out[i] - out[i - 1]));
  }
  return m;
}
/** Smallest repeat period of a 0/1 sequence within the window, or 0. */
function findPeriod(bits: number[]): number {
  for (let p = 1; p <= bits.length >> 1; p++) {
    let ok = true;
    for (let i = 0; i + p < bits.length; i++) {
      if (bits[i] !== bits[i + p]) { ok = false; break; }
    }
    if (ok) return p;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// (a) mixer LUTs
{
  check('pulseTable[0] == 0', NES_PULSE_MIX[0] === 0);
  check('tndTable[0] == 0', NES_TND_MIX[0] === 0);
  check('pulseTable[1] spot', approx(NES_PULSE_MIX[1], 0.011609, 1e-5),
    NES_PULSE_MIX[1].toFixed(6));
  check('pulseTable[15] spot', approx(NES_PULSE_MIX[15], 0.148820, 1e-5),
    NES_PULSE_MIX[15].toFixed(6));
  check('pulseTable[30] spot', approx(NES_PULSE_MIX[30], 0.257513, 1e-5),
    NES_PULSE_MIX[30].toFixed(6));
  check('tndTable[1] spot', approx(NES_TND_MIX[1], 0.006700, 1e-5),
    NES_TND_MIX[1].toFixed(6));
  check('tndTable[202] spot', approx(NES_TND_MIX[202], 0.742470, 1e-5),
    NES_TND_MIX[202].toFixed(6));
  let mono = true;
  for (let i = 1; i < NES_PULSE_MIX.length; i++) if (NES_PULSE_MIX[i] <= NES_PULSE_MIX[i - 1]) mono = false;
  check('pulseTable monotonic increasing', mono);
}

// ---------------------------------------------------------------------------
// (b) length + rate tables
{
  check('length table has 32 entries', NES_LENGTH_TABLE.length === 32);
  check('length[0]=10 [1]=254 [3]=2 [31]=30',
    NES_LENGTH_TABLE[0] === 10 && NES_LENGTH_TABLE[1] === 254 &&
    NES_LENGTH_TABLE[3] === 2 && NES_LENGTH_TABLE[31] === 30);
  check('noise periods 16 entries, [0]=4 [15]=4068',
    NES_NOISE_PERIODS.length === 16 && NES_NOISE_PERIODS[0] === 4 &&
    NES_NOISE_PERIODS[15] === 4068);
  check('dmc rates 16 entries, [0]=428 [15]=54',
    NES_DMC_RATES.length === 16 && NES_DMC_RATES[0] === 428 &&
    NES_DMC_RATES[15] === 54);
}

// ---------------------------------------------------------------------------
// (c) pulse period -> output frequency (50% duty, sweep-safe period)
{
  const apu = new NesApu(CLOCK);
  const period = 200;
  apu.write(0x00, 0xbf);              // duty 50%, halt, const vol 15
  apu.write(0x15, 0x01);             // enable pulse1
  apu.write(0x02, period & 0xff);
  apu.write(0x03, (period >> 8) & 7); // high bits 0, length index 0
  const out = new Float32Array(48000);
  apu.render(out);
  const spacing = crossingSpacing(out, 20000);
  const expected = 8 * (period + 1); // 8 duty steps, timer reload = period+1
  check('pulse 50% waveform period in samples',
    approx(spacing, expected, expected * 0.02),
    `got ${spacing.toFixed(1)} expected ${expected}`);
}

// ---------------------------------------------------------------------------
// (d) duty patterns: 12.5/25/50/75% high-time and the 75% = inverted 25%
{
  const highCounts = DUTY.map((seq) => seq.reduce((a, b) => a + b, 0));
  check('duty high-step counts are 1,2,4,6', highCounts.join(',') === '1,2,4,6',
    highCounts.join(','));
  check('each duty sequence has 8 steps', DUTY.every((s) => s.length === 8));
  // 75% duty is the 25% pattern inverted (NES quirk)
  const inv = DUTY[1].map((b) => 1 - b);
  check('duty 3 (75%) == inverted duty 1 (25%)', inv.join('') === DUTY[3].join(''));
}

// ---------------------------------------------------------------------------
// (e) sweep muting: period < 8 and target > $7ff both silence the channel
{
  function renderPulse(period: number): number {
    const apu = new NesApu(CLOCK);
    apu.write(0x00, 0xbf);
    apu.write(0x15, 0x01);
    apu.write(0x02, period & 0xff);
    apu.write(0x03, (period >> 8) & 7);
    const out = new Float32Array(8000);
    apu.render(out);
    return acLevel(out); // AC content ignores the idle-triangle DC offset
  }
  check('pulse muted when period < 8', renderPulse(4) < 1e-4);
  check('pulse muted when target > $7ff', renderPulse(0x400) < 1e-4);
  check('pulse audible for normal period', renderPulse(200) > 1e-2);
}

// ---------------------------------------------------------------------------
// (f) envelope decay rate: one step every (V+1) quarter clocks
{
  const env = new Envelope();
  env.writeReg0(3);   // period 3 -> decrement every 4 quarters
  env.start = true;
  const vols: number[] = [];
  for (let i = 0; i < 20; i++) { env.quarter(); vols.push(env.volume()); }
  check('envelope holds 15 for first V+1 quarters',
    vols[0] === 15 && vols[3] === 15 && vols[4] === 14 && vols[8] === 13,
    vols.slice(0, 10).join(','));

  const cenv = new Envelope();
  cenv.writeReg0(0x1a); // const-volume flag + volume 10
  cenv.start = true;
  cenv.quarter();
  cenv.quarter();
  check('constant-volume envelope ignores decay', cenv.volume() === 10);
}

// ---------------------------------------------------------------------------
// (g) triangle linear-counter gating
{
  function renderTri(reg0: number): number {
    const apu = new NesApu(CLOCK);
    apu.write(0x15, 0x04);       // enable triangle
    apu.write(0x08, reg0);       // linear counter control/reload
    apu.write(0x0a, 0x40);       // period low
    apu.write(0x0b, 0x08);       // period high 0, length index 1
    const out = new Float32Array(16000);
    apu.render(out);
    return acLevel(out, 8000); // measure after the frame clock loads linear
  }
  check('triangle plays with linear counter loaded', renderTri(0xff) > 1e-3);
  check('triangle silent with linear counter 0', renderTri(0x00) < 1e-4);
}

// ---------------------------------------------------------------------------
// (h) noise LFSR mode periods (short mode = 93)
{
  function lfsrPeriod(mode: boolean): number {
    const noi = new Noise();
    noi.setEnabled(true);
    noi.writeReg(0, 0x1f);                 // const vol 15
    noi.writeReg(2, (mode ? 0x80 : 0) | 0); // mode bit + period index 0
    noi.writeReg(3, 0x08);                 // load length
    const bits: number[] = [];
    for (let s = 0; s < 400; s++) {
      noi.stepTimer();                     // period index 0 => shift every 2 calls
      noi.stepTimer();
      bits.push(noi.output() === 0 ? 1 : 0); // bit0 of the LFSR
    }
    return findPeriod(bits);
  }
  check('noise short mode period == 93', lfsrPeriod(true) === 93,
    `got ${lfsrPeriod(true)}`);
  check('noise long mode period != 93', lfsrPeriod(false) !== 93);
}

// ---------------------------------------------------------------------------
// (i) frame counter 4 vs 5 step cadence — length hits 0 later in 5-step
{
  function stepsUntilSilent(fiveStep: boolean): number {
    const apu = new NesApu(CLOCK);
    if (fiveStep) apu.write(0x17, 0x80); // 5-step (immediate clock, length=0 still)
    else apu.write(0x17, 0x00);          // 4-step, no immediate clock
    apu.write(0x00, 0x10);               // const vol, NOT halted -> length decrements
    apu.write(0x15, 0x01);               // enable pulse1
    apu.write(0x03, 0x18);               // length index 3 -> 2
    for (let c = 1; c <= 40000; c++) {
      apu.tick(1);
      if ((apu.read4015() & 0x01) === 0) return c;
    }
    return -1;
  }
  const four = stepsUntilSilent(false);
  const five = stepsUntilSilent(true);
  // length 2 -> zero on the 2nd half clock: 4-step @29829, 5-step @37281 CPU cyc
  check('4-step length clears near 29829', approx(four, 29829, 3), `got ${four}`);
  check('5-step length clears near 37281', approx(five, 37281, 3), `got ${five}`);
  check('5-step cadence is slower than 4-step', five > four);
}

// ---------------------------------------------------------------------------
// (j) $4015 read bits + frame-IRQ clear-on-read
{
  const apu = new NesApu(CLOCK);
  apu.write(0x00, 0x30); apu.write(0x04, 0x30); // halt so lengths persist
  apu.write(0x15, 0x03);                        // enable pulse1 + pulse2
  apu.write(0x03, 0x10); apu.write(0x07, 0x10); // load lengths
  const st = apu.read4015();
  check('$4015 reports length>0 on enabled channels', (st & 0x03) === 0x03,
    st.toString(2));

  // 4-step frame IRQ fires by 29829 CPU cycles
  apu.tick(30000);
  const withIrq = apu.read4015();
  check('$4015 bit6 set after frame IRQ', (withIrq & 0x40) !== 0);
  const afterRead = apu.read4015();
  check('frame IRQ cleared by reading $4015', (afterRead & 0x40) === 0);
}

// ---------------------------------------------------------------------------
// (k) $4017 inhibit clears the frame IRQ
{
  const apu = new NesApu(CLOCK);
  apu.write(0x17, 0x00);
  apu.tick(30000);
  check('frame IRQ asserted before inhibit', apu.irqAsserted());
  apu.write(0x17, 0x40); // set IRQ-inhibit bit
  check('$4017 inhibit clears frame IRQ', !apu.irqAsserted());
}

// ---------------------------------------------------------------------------
// (l) DMC: onDmcStart address/length, delta decode, IRQ, loop, stalls
{
  // onDmcStart args (shadow instance)
  const started: { addr: number; len: number }[] = [];
  const shadow = new NesApu(CLOCK, { onDmcStart: (addr, len) => { started.push({ addr, len }); } });
  shadow.write(0x12, 0x10); // A = 16 -> addr $C000 + 16*64 = $C400
  shadow.write(0x13, 0x05); // L = 5  -> len 5*16+1 = 81
  shadow.write(0x15, 0x10); // start DMC
  check('onDmcStart address = $C000 + A*64',
    started.length === 1 && started[0].addr === 0xc400,
    `addr ${started[0]?.addr?.toString(16)}`);
  check('onDmcStart length = L*16 + 1', started.length === 1 && started[0].len === 81);

  // delta decode: 0xFF byte ramps +2 per bit (worklet instance)
  const worklet = new NesApu(CLOCK);
  worklet.data(0, new Uint8Array([0xff]));
  worklet.write(0x10, 0x0f); // fastest rate, no IRQ/loop
  worklet.write(0x11, 0x00); // direct load: level 0
  worklet.write(0x12, 0x00);
  worklet.write(0x13, 0x00); // len = 1 byte
  worklet.write(0x15, 0x10); // start
  const dummy = new Float32Array(2000);
  worklet.render(dummy);
  check('DMC 0xFF byte ramps delta counter to +16', worklet.dmcLevel === 16,
    `level ${worklet.dmcLevel}`);

  // completion IRQ (shadow, IRQ enabled, no loop)
  const irqApu = new NesApu(CLOCK);
  irqApu.write(0x10, 0x8f); // IRQ enable, rate15, loop off
  irqApu.write(0x13, 0x00); // 1 byte
  irqApu.write(0x15, 0x10);
  irqApu.tick(2000);
  check('DMC completion sets IRQ (bit7)', (irqApu.read4015() & 0x80) !== 0);
  check('DMC IRQ asserted', irqApu.irqAsserted());

  // loop flag: keeps playing, never raises IRQ
  const loopApu = new NesApu(CLOCK);
  loopApu.write(0x10, 0xcf); // IRQ enable + loop + rate15
  loopApu.write(0x13, 0x00);
  loopApu.write(0x15, 0x10);
  loopApu.tick(20000);
  const ls = loopApu.read4015();
  check('DMC loop keeps bytes-remaining (bit4) set', (ls & 0x10) !== 0);
  check('DMC loop never fires IRQ (bit7 clear)', (ls & 0x80) === 0);

  // stall accrual: ~4 CPU cycles per fetched byte
  const stallApu = new NesApu(CLOCK);
  stallApu.write(0x10, 0x0f); // rate15, no IRQ/loop
  stallApu.write(0x13, 0x01); // len = 1*16+1 = 17 bytes
  stallApu.write(0x15, 0x10);
  stallApu.tick(30000);
  check('DMC stalls ~= 4 * bytes (17 bytes -> 68)',
    stallApu.consumeDmcStalls() === 68);
}

// ---------------------------------------------------------------------------
// (m) shadow/worklet write-stream equivalence: identical writes + equal time
//     produce equal $4015 state (frame IRQ + length bits)
{
  const a = new NesApu(CLOCK); // "worklet" advanced via render
  const b = new NesApu(CLOCK); // "shadow" advanced via tick
  for (const apu of [a, b]) {
    apu.write(0x17, 0x00); // 4-step
    apu.write(0x00, 0x30); // halt so length persists
    apu.write(0x15, 0x01);
    apu.write(0x03, 0x10); // length index 2 -> 20
  }
  const out = new Float32Array(15000);
  a.render(out);   // advances frame by 2 CPU cycles per sample = 30000
  b.tick(30000);
  check('render() and tick() reach identical $4015 state',
    a.read4015() === b.read4015(),
    `a=${a.read4015().toString(2)} b=${b.read4015().toString(2)}`);
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0 ? '\nAll NES APU tests passed.' : `\n${failures} NES APU test(s) FAILED.`,
);
process.exitCode = failures === 0 ? 0 : 1;
