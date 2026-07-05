// Galaxian discrete sound board — background hum, tone, shoot and explosion.
// Hand-ported from MAME 0.121 src/mame/audio/galaxian.c (classic pre-discrete
// implementation: tone_update, galaxian_sh_start noise/shoot synthesis,
// galaxian_lfo_freq_w, noise_timer_cb), with register semantics cross-checked
// against the modern discrete simulation in
// src/mame/galaxian/galaxian_a.cpp (galaxian_sound_device::sound_w and the
// galaxian_mixerpre_desc VOL1/VOL2 resistor gating).
//
// Register contract (the board maps MAME device offsets onto write()):
//   0x00-0x02 : background_enable_w — FS1/FS2/FS3 555 tone enables (bit 0)
//   0x03      : noise_enable_w      — HIT (explosion noise, bit 0)
//   0x04      : n/c
//   0x05      : fire_enable_w       — FIRE (shoot, rising edge of bit 0)
//   0x06-0x07 : vol_w               — VOL1/VOL2 tone volume bits
//   0x10-0x13 : lfo_freq_w          — background LFO frequency bits 0-3
//   0x20      : pitch_w             — 8-bit tone pitch (0xff = off)
//
// Clock: the board passes the 3.072 MHz pixel clock (18.432 MHz / 6).
//   SOUND_CLOCK = clock / 2   (1.536 MHz — tone counter clock)
//   sampleRate  = clock / 32  (96 kHz — SOUND_CLOCK / 16 inner steps)
//   NOISE_RATE  = clock / 384 (8 kHz — RNG bit 17 latched every 2V)
//   RNG_RATE    = clock * 2   (6.144 MHz — XTAL/3)
//
// Fidelity notes (deliberate deviations from the 0.121 code):
// - The 2-bit volume: 0.121 models the tone DAC as an unloaded resistor
//   divider (and inverts one term in its table #3), which makes the four
//   waveform tables non-monotone in energy. The modern discrete sim instead
//   gates extra resistors into the mix (VOL1 adds R49 10k on QC, VOL2 adds
//   R52 15k on QD), so each volume bit adds signal. We follow the modern
//   topology: weighted sum of counter bits QA (R51 33k), QC (R50 22k +
//   VOL1*R49 10k), QD (VOL2*R52 15k), DC-removed. Setting either volume bit
//   raises the output level monotonically.
// - The background 555 pitches follow the hardware comment (FS1 lowest,
//   f ∝ 1/(Ra+2Rb): 139/190/267 Hz ratios); the 0.121 code applies the
//   ratio inverted, which contradicts its own schematic comment.
// - The explosion noise gets a one-pole ~400 Hz low-pass approximating the
//   modern sim's RCDISC5 + band-pass (R35/R36/C21-C23) "boom" voicing; the
//   amplitude envelope (100 → -10%-1 every ~27 ms after HIT clears) is the
//   classic noise_timer_cb integer decay, ported exactly.
// Everything else — tone counter, LFO 555 period math and 93..185 sweep,
// LFSR noise generation, and the NE555/C28/C29 shoot synthesis — is a
// direct port of the 0.121 code.

import type { SoundCore } from './types.ts';

/** Inner tone-counter steps per output sample (SOUND_CLOCK / sampleRate). */
const STEPS = 16;
/** Background hum LFO sweep bounds (audio/galaxian.c MINFREQ/MAXFREQ). */
const MINFREQ = 139 - Math.trunc(139 / 3); // 93
const MAXFREQ = 139 + Math.trunc(139 / 3); // 185
/** LFO frequency-select resistors R18/R17/R16/R15 (bits 0..3). */
const LFO_R = [1000000, 470000, 220000, 100000];
/** Background voice frequency ratios: f ∝ 1/(Ra+2Rb), Rb = 470k/330k/220k. */
const BG_MULT = [1, 1040 / 760, 1040 / 540];

// Mix levels (classic gains: TOOTHSAW_VOLUME 36, LFO_VOLUME 0.06,
// SHOOT_VOLUME 0.50, noise amplitude 70*256/32768 at envelope volume /100).
const TONE_GAIN = 0.36;
const BG_AMP = 0.5 * 0.06;
const SHOOT_GAIN = 0.5;
const NOISE_AMP = (70 * 256) / 32768;
const MASTER_GAIN = 0.75;

/** Explosion voicing low-pass cutoff (approximates galaxian_a.cpp band-pass). */
const NOISE_LP_HZ = 400;

export class GalaxianSound implements SoundCore {
  /** Native output rate == clock / 32 (96000 for the 3.072 MHz clock). */
  readonly sampleRate: number;

  // --- tone generator (IC 9J counter + resistor DAC) -----------------------
  /** 4 volume variants x 16 counter steps, DC-removed, in [-0.5, 0.5]. */
  private readonly toneWave: Float32Array;
  private pitch: number;        // 8-bit pitch latch; 0xff = silent
  private vol: number;          // VOL1 | VOL2<<1
  private toneCounter: number;  // 4-bit 74393 counter
  private toneCountdown: number;

  // --- background hum (3x 555 VCO swept by the LFO) -------------------------
  private readonly bgEnable: boolean[];
  private readonly bgPhase: Float64Array;  // cycles, [0, 1)
  private readonly bgInc: Float64Array;    // cycles per sample
  private freq: number;                    // LFO sweep value, MINFREQ..MAXFREQ
  private readonly lfoBits: number[];
  private lfoStepSamples: number;          // 0 = LFO timer not armed yet
  private lfoCounter: number;

  // --- noise / explosion ----------------------------------------------------
  private readonly noiseWave: Float32Array; // 4 s LFSR loop at NOISE_RATE, ±1
  private readonly noiseStep: number;       // noise samples per output sample
  private noisePos: number;
  private noiseFrac: number;
  private noiseEnable: boolean;
  private noiseVol: number;                 // 0..100 integer envelope
  private readonly decayPeriod: number;     // samples between envelope steps
  private decayCounter: number;
  private noiseLp: number;                  // one-pole low-pass state
  private readonly noiseLpK: number;

  // --- shoot ("pew") ---------------------------------------------------------
  private readonly shootWave: Float32Array; // 2 s one-shot, 0..1
  private shootPos: number;                 // >= length: not playing
  private lastFire: number;

  constructor(clock: number = 3072000) {
    this.sampleRate = Math.round(clock / 32);
    const noiseRate = clock / 384;   // 8000
    const rngRate = clock * 2;       // XTAL/3

    // -- tone DAC tables (modern mixerpre topology, see header) --------------
    const gA = 1 / 33000;            // R51, counter QA
    const gC = 1 / 22000;            // R50, counter QC
    const gCvol1 = 1 / 10000;        // R49, QC when VOL1
    const gDvol2 = 1 / 15000;        // R52, QD when VOL2
    const norm = gA + gC + gCvol1 + gDvol2;
    this.toneWave = new Float32Array(4 * 16);
    for (let vol = 0; vol < 4; vol++) {
      const wC = gC + ((vol & 1) ? gCvol1 : 0);
      const wD = (vol & 2) ? gDvol2 : 0;
      const mean = (gA + wC + wD) / 2; // each bit is high half the cycle
      for (let i = 0; i < 16; i++) {
        const raw = ((i & 1) ? gA : 0) + ((i & 4) ? wC : 0) + ((i & 8) ? wD : 0);
        this.toneWave[vol * 16 + i] = (raw - mean) / norm;
      }
    }
    this.pitch = 0xff;
    this.vol = 0;
    this.toneCounter = 0;
    this.toneCountdown = 0;

    // -- background hum -------------------------------------------------------
    this.bgEnable = [false, false, false];
    this.bgPhase = new Float64Array(3);
    this.bgInc = new Float64Array(3);
    this.freq = MAXFREQ;
    this.lfoBits = [0, 0, 0, 0];
    this.lfoStepSamples = 0;
    this.lfoCounter = 0;
    this.updateBgIncrements();

    // -- noise: 17-bit RNG clocked at RNG_RATE, bit 17 latched every 2V ------
    // (galaxian_sh_start; four-second loop exactly as the classic code)
    const noiseLen = noiseRate * 4;
    this.noiseWave = new Float32Array(noiseLen);
    {
      let generator = 0;
      let countdown = noiseRate / 2;
      for (let i = 0; i < noiseLen; i++) {
        countdown -= rngRate;
        while (countdown < 0) {
          generator <<= 1;
          const bit1 = (~generator >> 17) & 1;
          const bit2 = (generator >> 5) & 1;
          if (bit1 ^ bit2) generator |= 1;
          countdown += noiseRate;
        }
        this.noiseWave[i] = ((generator >> 17) & 1) ? 1 : -1;
      }
    }
    this.noiseStep = noiseRate / this.sampleRate;
    this.noisePos = 0;
    this.noiseFrac = 0;
    this.noiseEnable = false;
    this.noiseVol = 0;
    // noise_timer_cb period: (155000+22000)/100 * 693 * 22 ns ≈ 26.985 ms
    this.decayPeriod = Math.round(this.sampleRate * (((155000 + 22000) / 100) * 693 * 22) * 1e-9);
    this.decayCounter = this.decayPeriod;
    this.noiseLp = 0;
    this.noiseLpK = 1 - Math.exp((-2 * Math.PI * NOISE_LP_HZ) / this.sampleRate);

    // -- shoot: NE555 VCO frequency-modulated by the C28/C29 network ---------
    // (galaxian_sh_start shoot synthesis, ported verbatim at our rate)
    const rate = this.sampleRate;
    const shootLen = 2 * rate; // SHOOT_SEC = 2
    this.shootWave = new Float32Array(shootLen);
    {
      const IC8L3_L = 0.2, IC8L3_H = 4.5;   // 7400 output levels
      const NOISE_L = 0.2, NOISE_H = 4.5;   // 7474 output levels
      let v = 5.0;                                          // C25 voltage
      const vK = Math.exp(-1 / (100000 * 0.000001) / rate); // R41 * C25
      let ic8l3 = IC8L3_L;                                  // key on
      let ic8lCnt = Math.floor(0.1 * rate);                 // key off after 100 ms
      // C28: 8L-3 - R47(2.2k) - C28(47u) - R48(2.2k) - C29
      let c28v = IC8L3_H - (IC8L3_H - (NOISE_H + NOISE_L) / 2) / (10000 + 2200 + 2200) * 2200;
      const c28K = Math.exp(-1 / (22000 * 0.000047) / rate);
      // C29: NOISE - R46(10k) - C29(0.01u) - R48(2.2k) - C28
      let c29v = IC8L3_H - (IC8L3_H - (NOISE_H + NOISE_L) / 2) / (10000 + 2200 + 2200) * (2200 + 2200);
      const c29K1 = Math.exp(-1 / (22000 * 0.00000001) / rate);
      const c29K2 = Math.exp(-1 / (100000 * 0.00000001) / rate);
      // NE555: Ra=10k, Rb=22k, C=0.01u, FM via C29
      let ne555cnt = 0;
      const ne555step = (1.44 / ((10000 + 22000 * 2) * 0.00000001)) / rate;
      const ne555duty = (10000 + 22000) / (10000 + 22000 * 2);
      let ncnt = 0;
      const nstep = noiseRate / rate;

      for (let i = 0; i < shootLen; i++) {
        const noiseSh2 = this.noiseWave[Math.floor(ncnt) % noiseLen] > 0 ? NOISE_H : NOISE_L;
        ncnt += nstep;
        // NE555 threshold level from the FM input (0.80 adjust rate)
        const ne555sr = (c29v * 0.8) / ((5.0 * 2) / 3);
        ne555cnt += ne555step;
        if (ne555cnt >= ne555sr) ne555cnt -= ne555sr;
        if (ne555cnt < ne555sr * ne555duty) {
          this.shootWave[i] = v / 5;
          if (ic8l3 === IC8L3_H) v *= vK; // discharge after key off
        }
        c28v += (ic8l3 - c28v) * (1 - c28K); // from R47
        c28v += (c29v - c28v) * (1 - c28K);  // from R48
        c29v += (c28v - c29v) * (1 - c29K1); // from R48
        c29v += (noiseSh2 - c29v) * (1 - c29K2); // from R46
        if (ic8l3 === IC8L3_L && --ic8lCnt === 0) ic8l3 = IC8L3_H;
      }
    }
    this.shootPos = shootLen;
    this.lastFire = 0;
  }

  /** See the register contract in the header comment. */
  write(offset: number, data: number): void {
    if (offset >= 0x00 && offset <= 0x07) {
      const bit = data & 1;
      switch (offset) {
        case 0: case 1: case 2: // FS1/FS2/FS3
          this.bgEnable[offset] = bit !== 0;
          break;
        case 3: // HIT
          this.noiseEnable = bit !== 0;
          if (this.noiseEnable) this.noiseVol = 100;
          break;
        case 5: // FIRE — trigger on rising edge (galaxian_shoot_enable_w)
          if (bit && !this.lastFire) this.shootPos = 0;
          this.lastFire = bit;
          break;
        case 6: case 7: // VOL1/VOL2
          this.vol = (this.vol & ~(1 << (offset - 6))) | (bit << (offset - 6));
          break;
      }
    } else if (offset >= 0x10 && offset <= 0x13) {
      this.lfoFreqWrite(offset - 0x10, data);
    } else if (offset === 0x20) {
      this.pitch = data & 0xff;
    }
  }

  /**
   * galaxian_lfo_freq_w (classic non-NEW_LFO path): the four bits switch
   * R18/R17/R16/R15 between +5V and ground around the NE555 at 9R; the
   * resulting Ra sets the sweep-step period 639e-9 * rx / (MAX-MIN) seconds.
   */
  private lfoFreqWrite(bit: number, data: number): void {
    const val = data & 1;
    if (this.lfoBits[bit] === val) return;
    this.lfoBits[bit] = val;

    let g0 = 1 / 330000; // R19 330k to ground
    let g1 = 1 / 1e12;   // "open is a very high value really"
    for (let i = 0; i < 4; i++) {
      if (this.lfoBits[i]) g1 += 1 / LFO_R[i];
      else g0 += 1 / LFO_R[i];
    }
    const r0 = 1 / g0;
    const r1 = 1 / g1;
    const rx = 100000 + (2000000 * r0) / (r0 + r1);
    this.lfoStepSamples = Math.max(1, Math.round((this.sampleRate * 639e-9 * rx) / (MAXFREQ - MINFREQ)));
    this.lfoCounter = this.lfoStepSamples;
  }

  /** galaxian_sh_update: voice i tone = 2 * freq * BG_MULT[i] Hz. */
  private updateBgIncrements(): void {
    for (let i = 0; i < 3; i++) {
      this.bgInc[i] = (2 * this.freq * BG_MULT[i]) / this.sampleRate;
    }
  }

  /** Mix all channels into `out` (mono, [-1, 1]) at the native rate. */
  render(out: Float32Array): void {
    const n = out.length;
    const toneOn = this.pitch !== 0xff;
    const toneBase = this.vol * 16;
    const toneWave = this.toneWave;
    const pitch = this.pitch;
    const shootWave = this.shootWave;
    const noiseWave = this.noiseWave;
    const noiseLen = noiseWave.length;

    for (let i = 0; i < n; i++) {
      // LFO sweep timer (lfo_timer_cb: MAXFREQ -> MINFREQ sawtooth)
      if (this.lfoStepSamples > 0 && --this.lfoCounter <= 0) {
        this.lfoCounter = this.lfoStepSamples;
        this.freq = this.freq > MINFREQ ? this.freq - 1 : MAXFREQ;
        this.updateBgIncrements();
      }
      // explosion envelope timer (noise_timer_cb integer decay)
      if (--this.decayCounter <= 0) {
        this.decayCounter = this.decayPeriod;
        if (!this.noiseEnable && this.noiseVol > 0) {
          this.noiseVol -= Math.trunc(this.noiseVol / 10) + 1;
          if (this.noiseVol < 0) this.noiseVol = 0;
        }
      }

      let mix = 0;

      // tone (tone_update: 16 inner counter steps per output sample)
      if (toneOn) {
        let acc = 0;
        for (let j = 0; j < STEPS; j++) {
          if (this.toneCountdown >= 256) {
            this.toneCounter = (this.toneCounter + 1) & 15;
            this.toneCountdown = pitch;
          }
          this.toneCountdown++;
          acc += toneWave[toneBase + this.toneCounter];
        }
        mix += (acc / STEPS) * TONE_GAIN;
      }

      // background hum voices (square, free-running like the looped samples)
      for (let v = 0; v < 3; v++) {
        if (this.bgEnable[v]) mix += this.bgPhase[v] < 0.5 ? BG_AMP : -BG_AMP;
        this.bgPhase[v] += this.bgInc[v];
        if (this.bgPhase[v] >= 1) this.bgPhase[v] -= 1;
      }

      // shoot one-shot
      if (this.shootPos < shootWave.length) {
        mix += shootWave[this.shootPos++] * SHOOT_GAIN;
      }

      // explosion noise through envelope + voicing low-pass
      const target = this.noiseVol > 0
        ? noiseWave[this.noisePos] * (this.noiseVol / 100) * NOISE_AMP
        : 0;
      this.noiseLp += (target - this.noiseLp) * this.noiseLpK;
      mix += this.noiseLp;
      this.noiseFrac += this.noiseStep;
      while (this.noiseFrac >= 1) {
        this.noiseFrac -= 1;
        this.noisePos = (this.noisePos + 1) % noiseLen;
      }

      mix *= MASTER_GAIN;
      out[i] = mix > 1 ? 1 : mix < -1 ? -1 : mix;
    }
  }
}
