// Self-test for the AY-3-8910 PSG core. Run with: node src/runtime/ay8910.spec.ts
// (plain Node, no DOM). Exit code 0 = all PASS.
//
// References: MAME src/devices/sound/ay8910.cpp/.h (modern, AY type) and
// the classic MAME 0.121 ay8910.c volume table — see ay8910.ts header.

import {
  AY8910,
  AY8910_VOL_TABLE,
  renderBank,
  konamiFilterCaps,
  lowpass3RCoeff,
  rcLowPass,
  KONAMI_FILTER_R1,
  KONAMI_FILTER_R2,
  KONAMI_FILTER_R3,
} from './ay8910.ts';

// Gyruss: XTAL(14'318'181) / 8 ≈ 1.789772 MHz per chip (five chips).
const CLOCK = 1789772;

let failures = 0;
function check(name: string, cond: boolean, detail: string = ''): void {
  if (cond) {
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    failures++;
  }
}

/** Channel contribution for a gated-high level (see ay8910.ts mix scale). */
function levelOut(v: number): number {
  return AY8910_VOL_TABLE[v] / 3;
}

/** Recover the 4-bit DAC level from a single locked-high channel's output. */
function nearestLevel(sample: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let v = 0; v < 16; v++) {
    const d = Math.abs(sample - levelOut(v));
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

function setTonePeriod(chip: AY8910, ch: number, period: number): void {
  chip.writeReg(ch * 2, period & 0xff);
  chip.writeReg(ch * 2 + 1, (period >> 8) & 0xff);
}

/** Rising-edge period in samples, wsg.spec-style zero-crossing count. */
function measurePeriod(out: Float32Array): number {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1] <= 0 && out[i] > 0) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  }
  return crossings > 1 ? (last - first) / (crossings - 1) : NaN;
}

function maxAbs(out: Float32Array): number {
  let m = 0;
  for (const s of out) m = Math.max(m, Math.abs(s));
  return m;
}

// ---------------------------------------------------------------------------
// (a) basics: sample rate and silence after reset
{
  const chip = new AY8910(CLOCK);
  check('sampleRate = clock / 8', chip.sampleRate === CLOCK / 8, `${chip.sampleRate}`);

  const out = new Float32Array(4096).fill(0.5);
  chip.render(out);
  check('silence after reset (all levels 0)', maxAbs(out) === 0, `maxAbs=${maxAbs(out)}`);
}

// ---------------------------------------------------------------------------
// (b) volume table: MAME 0.121 build_mixer_table, 16-level view
// (VolTable[v*2+1], i.e. 3 dB = x1.412537545 per step, level 0 = off)
{
  const t = AY8910_VOL_TABLE;
  check('volTable[0] is exactly 0 (zero_is_off)', t[0] === 0);
  check('volTable[15] is exactly 1 (normalized MAX_OUTPUT)', t[15] === 1);

  let monotone = true;
  for (let v = 1; v < 16; v++) if (!(t[v] > t[v - 1])) monotone = false;
  check('volTable strictly monotone increasing', monotone);

  // classic table steps by 1.188502227 = 10^(1.5/20) per half-step; the
  // 16-level view steps by its square (3 dB) per level
  let ratioOk = true;
  const expect = 1.188502227 * 1.188502227;
  for (let v = 2; v < 16; v++) {
    if (Math.abs(t[v] / t[v - 1] - expect) > 1e-4) ratioOk = false;
  }
  check('volTable steps 3 dB per level', ratioOk, `ratio=${(t[15] / t[14]).toFixed(6)}`);
  check(
    'volTable[14] = -3 dB',
    Math.abs(t[14] - Math.pow(10, -3 / 20)) < 1e-5,
    `t[14]=${t[14].toFixed(6)}`,
  );
}

// ---------------------------------------------------------------------------
// (c) tone period accuracy: toggle every TP samples -> rising period 2*TP,
// i.e. tone frequency = clock / (16 * TP)
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x38); // noise disabled everywhere, tones enabled
  setTonePeriod(chip, 0, 100);
  chip.writeReg(8, 0x0f);
  const out = new Float32Array(200000);
  chip.render(out);
  const measured = measurePeriod(out);
  const err = Math.abs(measured - 200) / 200;
  check(
    'tone period TP=100 -> 200 samples (<0.01% error)',
    Number.isFinite(measured) && err < 1e-4,
    `measured=${measured.toFixed(3)}, err=${(err * 100).toFixed(4)}%`,
  );
}

// (d) 12-bit period (coarse register contributes bits 8-11)
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x38);
  setTonePeriod(chip, 0, 0x2ff); // 767
  chip.writeReg(8, 0x0f);
  const out = new Float32Array(0x2ff * 2 * 80);
  chip.render(out);
  const measured = measurePeriod(out);
  const err = Math.abs(measured - 0x2ff * 2) / (0x2ff * 2);
  check(
    'tone period TP=0x2ff (12-bit) accurate (<0.05% error)',
    Number.isFinite(measured) && err < 5e-4,
    `measured=${measured.toFixed(3)}, err=${(err * 100).toFixed(4)}%`,
  );
}

// (e) period 0 behaves as period 1 (std::max(1, period))
{
  const mk = (tp: number) => {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, 0x38);
    setTonePeriod(chip, 0, tp);
    chip.writeReg(8, 0x0f);
    const out = new Float32Array(2048);
    chip.render(out);
    return out;
  };
  const p0 = mk(0);
  const p1 = mk(1);
  let same = true;
  for (let i = 0; i < p0.length; i++) if (p0[i] !== p1[i]) same = false;
  check('tone period 0 == period 1', same);
}

// (f) coarse period register is masked to 4 bits
{
  const mk = (coarse: number) => {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, 0x38);
    chip.writeReg(0, 0x34);
    chip.writeReg(1, coarse);
    chip.writeReg(8, 0x0f);
    const out = new Float32Array(8192);
    chip.render(out);
    return out;
  };
  const a = mk(0x1f);
  const b = mk(0x0f);
  let same = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
  check('coarse register masked to 4 bits (0x1f == 0x0f)', same);
}

// (g) channels B and C have their own generators + enable/volume slots
{
  for (const [ch, enableMask, volReg] of [[1, 0x3d, 9], [2, 0x3b, 10]] as const) {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, enableMask); // only this channel's tone enabled
    setTonePeriod(chip, ch, 150);
    chip.writeReg(volReg, 0x0f);
    const out = new Float32Array(60000);
    chip.render(out);
    const measured = measurePeriod(out);
    const err = Math.abs(measured - 300) / 300;
    check(
      `channel ${'ABC'[ch]} tone via regs ${ch * 2}/${ch * 2 + 1}/${volReg}`,
      Number.isFinite(measured) && err < 1e-3,
      `measured=${measured.toFixed(3)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// (h) noise LFSR: 17-bit, input = bit0 ^ bit3, output = bit0
// (ay8910.h noise_rng_tick). With NP=1 the prescaler makes the LFSR shift
// every 2 samples (tick lands on odd sample indices, before mixing).
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x07); // tones disabled, noise enabled on all channels
  chip.writeReg(6, 1);    // NP = 1
  chip.writeReg(8, 0x0f); // only channel A audible
  const out = new Float32Array(200);
  chip.render(out);

  // hand-stepped reference of the same recurrence
  let rng = 1;
  const tick = () => {
    rng = ((rng >>> 1) | (((rng ^ (rng >>> 3)) & 1) << 16)) >>> 0;
  };
  let match = true;
  let firstBad = -1;
  for (let i = 0; i < out.length; i++) {
    if (i % 2 === 1) tick();
    const expectPositive = (rng & 1) === 1;
    if ((out[i] > 0) !== expectPositive) {
      match = false;
      if (firstBad < 0) firstBad = i;
      break;
    }
  }
  check('noise LFSR matches hand-stepped bit0^bit3 reference (200 samples)', match,
    firstBad < 0 ? '' : `first mismatch at sample ${firstBad}`);
}

// (i) noise is broadband and balanced
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x07);
  chip.writeReg(6, 1);
  chip.writeReg(8, 0x0f);
  const out = new Float32Array(40000);
  chip.render(out);
  let transitions = 0;
  let sum = 0;
  for (let i = 1; i < out.length; i++) {
    if ((out[i] > 0) !== (out[i - 1] > 0)) transitions++;
    sum += out[i];
  }
  const mean = sum / out.length;
  check('noise NP=1 is broadband (~1 transition per 4 samples)',
    transitions > 6000 && transitions < 14000, `transitions=${transitions}`);
  check('noise output is balanced (|mean| small)', Math.abs(mean) < 0.05,
    `mean=${mean.toFixed(4)}`);
}

// (j) noise period register scales the LFSR rate (reg 6, 5 bits)
{
  const measureTransitions = (np: number) => {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, 0x07);
    chip.writeReg(6, np);
    chip.writeReg(8, 0x0f);
    const out = new Float32Array(40000);
    chip.render(out);
    let n = 0;
    for (let i = 1; i < out.length; i++) if ((out[i] > 0) !== (out[i - 1] > 0)) n++;
    return n;
  };
  const t1 = measureTransitions(1);
  const t8 = measureTransitions(8);
  const ratio = t1 / t8;
  check('noise period NP=8 is ~8x slower than NP=1', ratio > 6 && ratio < 10,
    `ratio=${ratio.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// (k) mixer reg 7: tone+noise both disabled locks the gate HIGH — output is
// the DAC level itself, modulated by the volume register (MAME comment:
// "if both tone and noise are disabled, the output is 1, not 0")
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x3f);
  chip.writeReg(8, 0x0f);
  const out = new Float32Array(2048);
  chip.render(out);
  let constant = true;
  for (const s of out) if (Math.abs(s - levelOut(15)) > 1e-6) constant = false;
  check('gate locked high: constant +volTable[15]/3', constant,
    `out[0]=${out[0].toFixed(5)}`);

  chip.writeReg(8, 0x08); // volume-register DAC modulation
  chip.render(out);
  constant = true;
  for (const s of out) if (Math.abs(s - levelOut(8)) > 1e-6) constant = false;
  check('locked channel modulated by volume register', constant,
    `out[0]=${out[0].toFixed(5)}`);
}

// (l) mixer: noise enable actually gates the tone (tone AND noise)
{
  const mk = (enable: number) => {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, enable);
    chip.writeReg(6, 1);
    setTonePeriod(chip, 0, 100);
    chip.writeReg(8, 0x0f);
    const out = new Float32Array(8192);
    chip.render(out);
    return out;
  };
  const toneOnly = mk(0x3e);   // tone A on, all noise off
  const toneNoise = mk(0x36);  // tone A on, noise A on
  let differs = false;
  for (let i = 0; i < toneOnly.length; i++) if (toneOnly[i] !== toneNoise[i]) differs = true;
  check('tone AND noise gating differs from tone-only', differs);
  check('tone-only channel is a clean square (period 200)',
    Math.abs(measurePeriod(toneOnly) - 200) < 0.5,
    `measured=${measurePeriod(toneOnly).toFixed(2)}`);
}

// (m) volume 0 silences a channel regardless of gating
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x00); // everything enabled
  chip.writeReg(6, 1);
  setTonePeriod(chip, 0, 100);
  // all volumes stay 0
  const out = new Float32Array(4096);
  chip.render(out);
  check('volume 0 = silence with tone+noise running', maxAbs(out) === 0);
}

// ---------------------------------------------------------------------------
// (n) all 16 envelope shapes (CONT/ATT/ALT/HOLD), sampled through a locked
// channel in envelope mode. AY envelope = 16 steps; EP=4 -> one step every
// 8 samples; measured level at sample 8k+3 is step k of the pattern.
{
  /** Datasheet-shape reference: full 16-step ramps, then hold/alternate. */
  function refEnvelope(shape: number, steps: number): number[] {
    const cont = (shape & 8) !== 0;
    const att = (shape & 4) !== 0;
    let alt = (shape & 2) !== 0;
    let hold = (shape & 1) !== 0;
    if (!cont) {
      // CONT=0 maps to the equivalent CONT=1 shape (MAME set_shape)
      hold = true;
      alt = att;
    }
    const seq: number[] = [];
    let up = att;
    while (seq.length < steps) {
      for (let i = 0; i < 16 && seq.length < steps; i++) seq.push(up ? i : 15 - i);
      if (seq.length >= steps) break;
      if (hold) {
        const held = alt ? (up ? 0 : 15) : (up ? 15 : 0);
        while (seq.length < steps) seq.push(held);
        break;
      }
      if (alt) up = !up;
    }
    return seq;
  }

  const STEPS = 64;
  for (let shape = 0; shape < 16; shape++) {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, 0x3f);  // lock the gate high
    chip.writeReg(8, 0x10);  // channel A follows the envelope
    chip.writeReg(11, 4);    // EP = 4 -> env step every 8 samples
    chip.writeReg(12, 0);
    chip.writeReg(13, shape);
    const out = new Float32Array(STEPS * 8 + 8);
    chip.render(out);

    const expected = refEnvelope(shape, STEPS);
    let ok = true;
    let firstBad = -1;
    for (let k = 0; k < STEPS; k++) {
      if (nearestLevel(out[k * 8 + 3]) !== expected[k]) {
        ok = false;
        firstBad = k;
        break;
      }
    }
    check(`envelope shape 0x${shape.toString(16)} matches datasheet pattern`, ok,
      firstBad < 0 ? '' : `first mismatch at step ${firstBad}: got ` +
        `${nearestLevel(out[firstBad * 8 + 3])}, want ${expected[firstBad]}`);
  }
}

// (o) bit 4 of the level register selects envelope vs fixed level
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x3f);
  chip.writeReg(8, 0x0f); // FIXED level 15, envelope running underneath
  chip.writeReg(11, 4);
  chip.writeReg(13, 0);   // decaying envelope
  const out = new Float32Array(1024);
  chip.render(out);
  let constant = true;
  for (const s of out) if (Math.abs(s - levelOut(15)) > 1e-6) constant = false;
  check('fixed-level channel ignores the envelope', constant);
}

// (p) envelope period is 16 bits (reg 12 = coarse); AY step pace is 2*EP
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x3f);
  chip.writeReg(8, 0x10);
  chip.writeReg(11, 0);
  chip.writeReg(12, 1);   // EP = 256 -> step every 512 samples
  chip.writeReg(13, 0);   // \___
  const out = new Float32Array(1200);
  chip.render(out);
  check('envelope EP=256: level still 15 at sample 300',
    nearestLevel(out[300]) === 15, `level=${nearestLevel(out[300])}`);
  check('envelope EP=256: level 14 at sample 600',
    nearestLevel(out[600]) === 14, `level=${nearestLevel(out[600])}`);
}

// (q) envelope period 0 runs at HALF of period 1 (classic MAME comment:
// "this does NOT apply to the Envelope period. In that case, period = 0
// is half as period = 1")
{
  const mk = (ep: number) => {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, 0x3f);
    chip.writeReg(8, 0x10);
    chip.writeReg(11, ep);
    chip.writeReg(13, 0);
    const out = new Float32Array(64);
    chip.render(out);
    return out;
  };
  const ep0 = mk(0); // steps every sample: level 0 (held) by sample 14
  const ep1 = mk(1); // steps every 2 samples: level 5 at sample 20
  check('envelope EP=0 decays twice as fast as EP=1',
    nearestLevel(ep0[20]) === 0 && nearestLevel(ep1[20]) === 5,
    `ep0@20=${nearestLevel(ep0[20])}, ep1@20=${nearestLevel(ep1[20])}`);
  check('envelope EP=1 halfway point correct',
    nearestLevel(ep1[9]) === 15 - 5 + 0 || nearestLevel(ep1[9]) === 10,
    `ep1@9=${nearestLevel(ep1[9])}`);
}

// ---------------------------------------------------------------------------
// (r) reg 14/15 ports with reg 7 direction bits
{
  // input mode (direction bit clear) consults the read callback
  const chip = new AY8910(CLOCK);
  chip.portARead = () => 0x5a;
  chip.portBRead = () => 0xa5;
  check('port A input-mode read consults portARead', chip.readReg(14) === 0x5a);
  check('port B input-mode read consults portBRead', chip.readReg(15) === 0xa5);
}
{
  // input mode without a callback returns the latch; the write callback is
  // NOT fired for a latch write while in input mode
  const chip = new AY8910(CLOCK);
  const calls: number[] = [];
  chip.writeReg(7, 0x00);
  chip.portAWrite = (v) => calls.push(v);
  chip.writeReg(14, 0x77);
  check('port A input-mode write only latches (no callback)',
    calls.length === 0 && chip.readReg(14) === 0x77, `calls=${calls.length}`);
}
{
  // output mode pushes writes through the callback and reads back the latch
  // without consulting portARead
  const chip = new AY8910(CLOCK);
  const calls: number[] = [];
  chip.portAWrite = (v) => calls.push(v);
  let readCbCalled = false;
  chip.portARead = () => {
    readCbCalled = true;
    return 0xee;
  };
  chip.writeReg(7, 0x40);      // port A -> output; pushes the latch (0x00)
  chip.writeReg(14, 0x12);
  const readBack = chip.readReg(14);
  check('port A output-mode write reaches portAWrite',
    calls.length === 2 && calls[0] === 0x00 && calls[1] === 0x12,
    `calls=[${calls.join(',')}]`);
  check('port A output-mode read returns the latch (no portARead)',
    readBack === 0x12 && !readCbCalled, `read=0x${readBack.toString(16)}`);

  // turning the port around to input writes 0xff (pull-ups / hi-Z)
  chip.writeReg(7, 0x00);
  check('port A output->input transition writes 0xff',
    calls.length === 3 && calls[2] === 0xff, `calls=[${calls.join(',')}]`);
}
{
  // the FIRST reg 7 write always pushes both port latches (lastEnable = -1)
  const chip = new AY8910(CLOCK);
  const a: number[] = [];
  const b: number[] = [];
  chip.portAWrite = (v) => a.push(v);
  chip.portBWrite = (v) => b.push(v);
  chip.writeReg(7, 0xc0); // both output
  check('first reg 7 write forces both port-direction writes',
    a.length === 1 && a[0] === 0x00 && b.length === 1 && b[0] === 0x00,
    `a=[${a.join(',')}] b=[${b.join(',')}]`);
}

// (s) read-back masks: unused register bits read as 0 on a real AY-3-8910
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(1, 0xff);
  chip.writeReg(6, 0xff);
  chip.writeReg(8, 0xff);
  chip.writeReg(13, 0xff);
  check('readReg(1) masks coarse period to 4 bits', chip.readReg(1) === 0x0f);
  check('readReg(6) masks noise period to 5 bits', chip.readReg(6) === 0x1f);
  check('readReg(8) masks level register to 5 bits', chip.readReg(8) === 0x1f);
  check('readReg(13) masks shape to 4 bits', chip.readReg(13) === 0x0f);
}

// ---------------------------------------------------------------------------
// (t) determinism: identical programming -> bit-identical output
{
  const program = (chip: AY8910) => {
    chip.writeReg(7, 0x30);
    chip.writeReg(6, 3);
    setTonePeriod(chip, 0, 123);
    setTonePeriod(chip, 1, 217);
    setTonePeriod(chip, 2, 71);
    chip.writeReg(8, 0x0d);
    chip.writeReg(9, 0x10);
    chip.writeReg(10, 0x0a);
    chip.writeReg(11, 0x40);
    chip.writeReg(13, 0x0e);
  };
  const c1 = new AY8910(CLOCK);
  const c2 = new AY8910(CLOCK);
  program(c1);
  program(c2);
  const o1 = new Float32Array(8192);
  const o2 = new Float32Array(8192);
  c1.render(o1);
  c2.render(o2);
  let same = true;
  for (let i = 0; i < o1.length; i++) if (o1[i] !== o2[i]) same = false;
  check('deterministic: identical programs render identically', same);

  // streaming invariance: one 8192 render == 32 renders of 256
  const c3 = new AY8910(CLOCK);
  program(c3);
  const o3 = new Float32Array(8192);
  const seg = new Float32Array(256);
  for (let k = 0; k < 32; k++) {
    c3.render(seg);
    o3.set(seg, k * 256);
  }
  same = true;
  for (let i = 0; i < o1.length; i++) if (o1[i] !== o3[i]) same = false;
  check('streaming: chunked renders match one large render', same);
}

// (u) bounds: full blast stays inside [-1, 1]
{
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x3f); // all locked high
  chip.writeReg(8, 0x0f);
  chip.writeReg(9, 0x0f);
  chip.writeReg(10, 0x0f);
  const out = new Float32Array(1024);
  chip.render(out);
  check('3 channels locked at level 15 = exactly full scale',
    Math.abs(maxAbs(out) - 1) < 1e-6 && maxAbs(out) <= 1 + 1e-6,
    `maxAbs=${maxAbs(out).toFixed(6)}`);

  const chip2 = new AY8910(CLOCK);
  chip2.writeReg(7, 0x00); // everything enabled
  chip2.writeReg(6, 5);
  setTonePeriod(chip2, 0, 100);
  setTonePeriod(chip2, 1, 230);
  setTonePeriod(chip2, 2, 57);
  chip2.writeReg(8, 0x0f);
  chip2.writeReg(9, 0x0f);
  chip2.writeReg(10, 0x0f);
  const out2 = new Float32Array(50000);
  chip2.render(out2);
  check('full-volume tone+noise mix stays in [-1, 1]', maxAbs(out2) <= 1,
    `maxAbs=${maxAbs(out2).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// (v) bank of 5 chips (the gyruss configuration), worklet offset contract:
// offset = chip*16 + register, summed at 1/chips gain
{
  const chips: AY8910[] = [];
  for (let i = 0; i < 5; i++) chips.push(new AY8910(CLOCK));
  const bankWrite = (offset: number, data: number) => {
    const chip = chips[offset >> 4]; // worklet routing (ay8910-worklet.ts)
    if (chip) chip.writeReg(offset & 0x0f, data);
  };

  // all five at full blast: renderBank must stay within [-1, 1] (== 1)
  for (let c = 0; c < 5; c++) {
    bankWrite(c * 16 + 7, 0x3f);
    bankWrite(c * 16 + 8, 0x0f);
    bankWrite(c * 16 + 9, 0x0f);
    bankWrite(c * 16 + 10, 0x0f);
  }
  const out = new Float32Array(1024);
  const scratch = new Float32Array(1024);
  renderBank(chips, out, scratch);
  check('bank: 5 chips at full blast sum to exactly full scale',
    Math.abs(maxAbs(out) - 1) < 1e-6 && maxAbs(out) <= 1 + 1e-6,
    `maxAbs=${maxAbs(out).toFixed(6)}`);

  // addressing: silence everything, then wake only chip 2 via offsets
  const chips2: AY8910[] = [];
  for (let i = 0; i < 5; i++) chips2.push(new AY8910(CLOCK));
  const bankWrite2 = (offset: number, data: number) => {
    const chip = chips2[offset >> 4];
    if (chip) chip.writeReg(offset & 0x0f, data);
  };
  bankWrite2(0x27, 0x3f); // chip 2, reg 7
  bankWrite2(0x28, 0x0f); // chip 2, reg 8
  renderBank(chips2, out, scratch);
  let addressed = true;
  const expected = levelOut(15) / 5; // one channel, bank gain 1/5
  for (const s of out) if (Math.abs(s - expected) > 1e-6) addressed = false;
  check('bank: offset 0x27/0x28 reaches chip 2 reg 7/8 only', addressed,
    `out[0]=${out[0].toFixed(5)}, expected=${expected.toFixed(5)}`);

  // out-of-range offsets are ignored (worklet guards chips[offset >> 4])
  bankWrite2(0x57, 0x3f);
  bankWrite2(0x58, 0x0f);
  renderBank(chips2, out, scratch);
  let unchanged = true;
  for (const s of out) if (Math.abs(s - expected) > 1e-6) unchanged = false;
  check('bank: offsets beyond the last chip are ignored', unchanged);
}

// ---------------------------------------------------------------------------
// (w) renderChannels: per-channel rendering (worklet RC-filter path)
{
  // channel isolation: tone programmed on A only appears on channel 0
  const chip = new AY8910(CLOCK);
  chip.writeReg(7, 0x3e); // tone A enabled only, noise off everywhere
  setTonePeriod(chip, 0, 100);
  chip.writeReg(8, 0x0f);
  const o0 = new Float32Array(8192);
  const o1 = new Float32Array(8192);
  const o2 = new Float32Array(8192);
  chip.renderChannels(o0, o1, o2);
  check('renderChannels: tone on A appears on channel 0 (full scale square)',
    Math.abs(maxAbs(o0) - 1) < 1e-6 && Math.abs(measurePeriod(o0) - 200) < 0.5,
    `maxAbs=${maxAbs(o0).toFixed(6)}, period=${measurePeriod(o0).toFixed(2)}`);
  // B/C are gated high (tone+noise disabled) at volume 0 -> exactly 0
  check('renderChannels: channels 1/2 silent (volume 0)',
    maxAbs(o1) === 0 && maxAbs(o2) === 0,
    `maxAbs1=${maxAbs(o1)}, maxAbs2=${maxAbs(o2)}`);

  // same for B and C
  for (const [ch, enableMask, volReg] of [[1, 0x3d, 9], [2, 0x3b, 10]] as const) {
    const c = new AY8910(CLOCK);
    c.writeReg(7, enableMask);
    setTonePeriod(c, ch, 100);
    c.writeReg(volReg, 0x0f);
    const outs = [new Float32Array(8192), new Float32Array(8192), new Float32Array(8192)];
    c.renderChannels(outs[0], outs[1], outs[2]);
    const others = [0, 1, 2].filter(x => x !== ch);
    check(`renderChannels: tone on ${'ABC'[ch]} isolated to channel ${ch}`,
      Math.abs(measurePeriod(outs[ch]) - 200) < 0.5 &&
        maxAbs(outs[others[0]]) === 0 && maxAbs(outs[others[1]]) === 0,
      `period=${measurePeriod(outs[ch]).toFixed(2)}`);
  }
}

// (x) renderChannels sums to exactly what render() produces (bit-identical
// generator state advance; render() == (ch0 + ch1 + ch2) / 3)
{
  const program = (chip: AY8910) => {
    chip.writeReg(7, 0x30); // tones on, noise A on
    chip.writeReg(6, 3);
    setTonePeriod(chip, 0, 123);
    setTonePeriod(chip, 1, 217);
    setTonePeriod(chip, 2, 71);
    chip.writeReg(8, 0x0d);
    chip.writeReg(9, 0x10); // envelope mode
    chip.writeReg(10, 0x0a);
    chip.writeReg(11, 0x40);
    chip.writeReg(13, 0x0e);
  };
  const cMono = new AY8910(CLOCK);
  const cSplit = new AY8910(CLOCK);
  program(cMono);
  program(cSplit);
  const mono = new Float32Array(8192);
  cMono.render(mono);
  const s0 = new Float32Array(8192);
  const s1 = new Float32Array(8192);
  const s2 = new Float32Array(8192);
  cSplit.renderChannels(s0, s1, s2);
  let same = true;
  for (let i = 0; i < mono.length; i++) {
    if (Math.fround((s0[i] + s1[i] + s2[i]) * (1 / 3)) !== mono[i]) same = false;
  }
  check('renderChannels channels sum (1/3) bit-matches render()', same);
}

// ---------------------------------------------------------------------------
// (y) Konami RC filter select decode (junofrst.cpp portB_w: two bits per
// channel, bit0 = 47000 pF, bit1 = 220000 pF, summed)
{
  const eq = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
  check('filter caps 0x00 -> all bypass', eq(konamiFilterCaps(0x00), [0, 0, 0]));
  check('filter caps 0x15 -> 47000 pF on all channels',
    eq(konamiFilterCaps(0x15), [47000, 47000, 47000]));
  check('filter caps 0x2a -> 220000 pF on all channels',
    eq(konamiFilterCaps(0x2a), [220000, 220000, 220000]));
  check('filter caps 0x3f -> 267000 pF (both) on all channels',
    eq(konamiFilterCaps(0x3f), [267000, 267000, 267000]));
  check('filter caps 0x39 -> per-channel 47000/220000/267000',
    eq(konamiFilterCaps(0x39), [47000, 220000, 267000]),
    `[${konamiFilterCaps(0x39).join(',')}]`);
  check('filter caps ignore bits 6-7', eq(konamiFilterCaps(0xc0), [0, 0, 0]));
}

// (z) LOWPASS_3R coefficient (flt_rc.cpp recalc):
// Req = R1*(R2+R3)/(R1+R2+R3); k = 1 - exp(-1/(Req*C)/rate); C=0 -> 1
{
  const rate = CLOCK / 8;
  check('lowpass3RCoeff C=0 is exactly 1 (bypass)',
    lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, 0, rate) === 1);

  const req = (1000 * (2200 + 200)) / (1000 + 2200 + 200); // 705.882... ohm
  for (const pf of [47000, 220000, 267000]) {
    const expect = 1 - Math.exp(-1 / (req * pf * 1e-12) / rate);
    const got = lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, pf, rate);
    check(`lowpass3RCoeff ${pf} pF matches flt_rc formula`,
      Math.abs(got - expect) < 1e-12 && got > 0 && got < 1,
      `k=${got.toFixed(6)}`);
  }
  const k47 = lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, 47000, rate);
  const k220 = lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, 220000, rate);
  check('bigger cap -> smaller k (lower cutoff)', k220 < k47,
    `k47=${k47.toFixed(4)}, k220=${k220.toFixed(4)}`);
}

// (aa) filter attenuation, end to end on a chip channel: a high-frequency
// square through the 0.22 uF selection loses measurably more amplitude than
// through 0.047 uF; bypass is bit-identical to the unfiltered channel
{
  const rate = CLOCK / 8;
  const renderTone = () => {
    const chip = new AY8910(CLOCK);
    chip.writeReg(7, 0x3e);
    setTonePeriod(chip, 0, 5); // clock/(16*5) ~ 22.4 kHz square
    chip.writeReg(8, 0x0f);
    const o0 = new Float32Array(16384);
    const o1 = new Float32Array(16384);
    const o2 = new Float32Array(16384);
    chip.renderChannels(o0, o1, o2);
    return o0;
  };
  const settledAmp = (buf: Float32Array) => {
    let m = 0;
    for (let i = buf.length >> 1; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  };

  const raw = renderTone();

  const via = (pf: number) => {
    const buf = renderTone();
    const k = lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, pf, rate);
    rcLowPass(buf, k, 0);
    return buf;
  };
  const f47 = via(47000);   // cutoff ~4.8 kHz
  const f220 = via(220000); // cutoff ~1.0 kHz

  const a0 = settledAmp(raw);
  const a47 = settledAmp(f47);
  const a220 = settledAmp(f220);
  check('0.047 uF attenuates a 22 kHz square', a47 < a0 * 0.5,
    `raw=${a0.toFixed(3)}, 47nF=${a47.toFixed(3)}`);
  check('0.22 uF attenuates much more than 0.047 uF', a220 < a47 * 0.5,
    `47nF=${a47.toFixed(3)}, 220nF=${a220.toFixed(3)}`);

  // bypass (C=0 -> k=1, filter skipped) leaves the channel bit-identical
  const bypass = renderTone();
  const kBypass = lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, 0, rate);
  if (kBypass < 1) rcLowPass(bypass, kBypass, 0); // worklet path: k=1 skips
  let identical = true;
  for (let i = 0; i < raw.length; i++) if (bypass[i] !== raw[i]) identical = false;
  check('bypass (C=0) leaves the channel bit-identical', identical);
}

// (ab) rcLowPass streaming: memory carried across blocks == one long block
{
  const rate = CLOCK / 8;
  const k = lowpass3RCoeff(KONAMI_FILTER_R1, KONAMI_FILTER_R2, KONAMI_FILTER_R3, 220000, rate);
  const src = new Float32Array(4096);
  for (let i = 0; i < src.length; i++) src[i] = ((i >> 6) & 1) ? 1 : -1;

  const whole = src.slice();
  rcLowPass(whole, k, 0);

  const chunked = src.slice();
  let mem = 0;
  for (let off = 0; off < chunked.length; off += 256) {
    mem = rcLowPass(chunked.subarray(off, off + 256), k, mem);
  }
  let same = true;
  for (let i = 0; i < whole.length; i++) if (whole[i] !== chunked[i]) same = false;
  check('rcLowPass chunked blocks match one long block', same);
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0 ? '\nAll AY8910 tests passed.' : `\n${failures} AY8910 test(s) FAILED.`,
);
process.exitCode = failures === 0 ? 0 : 1;
