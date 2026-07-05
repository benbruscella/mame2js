// Space Invaders sound board — SN76477 saucer + TI discrete voices (HLE).
// Hand-modeled from MAME 0.121 src/mame/audio/mw8080bw.c (classic discrete
// implementation, Apr 2007 D.R., schematic M051-00739-A005):
//   invaders_audio_1_w (line 3641): D0 -> SN76477 enable (saucer/UFO,
//     enable pin is active-low so D0=1 plays), D1 -> INVADERS_MISSILE_EN
//     (player shot), D2 -> INVADERS_EXPLOSION_EN (missile base hit),
//     D3 -> INVADERS_INVADER_HIT_EN, D4 -> INVADERS_BONUS_MISSLE_BASE_EN
//     (extended play), D5 -> sound_global_enable (amp gate on EVERYTHING),
//     D6/D7 n/c.
//   invaders_audio_2_w (line 3656): D0-D3 -> INVADERS_FLEET_DATA (the
//     four-step fleet-movement "thump"), D4 -> INVADERS_SAUCER_HIT_EN,
//     D5 flip screen (cocktail only, not audio), D6/D7 n/c.
//
// This is an honest HLE approximation, not a netlist solve. Each voice is a
// small synthesized model whose time constants / frequencies are derived
// from the MAME component values; the op-amp/Norton waveshaping is replaced
// with plausible envelopes. Synthesis notes per voice:
//
// - Noise: the board's single LFSR noise source, ported exactly from
//   midway_lfsr (17-bit, reset 0x1ffff, feedback = bit4 XOR bit16 shifted
//   into bit 0, output bit 12) clocked at the breadboard-measured 7515 Hz
//   (INVADERS_NOISE_GENERATOR). Shared by shot / explosion / invader hit.
// - UFO (SN76477, invaders_sn76477_interface): VCO f = 0.64/(R18 8.2k *
//   C17 0.1u) = 780 Hz, swept by the SLF triangle at 0.64/(R20 120k *
//   C21 1.0u) = 5.33 Hz -> square warbled over ~350..1100 Hz, continuous
//   while D0 is set (attack/decay caps are N/C -> effectively instant
//   gating; a 3 ms ramp here just avoids clicks).
// - Shot (INVADERS_MISSILE): op-amp one-shot (C12 1u) opens a VCO whose
//   modulation is one-shot envelope + coupled noise -> a descending,
//   noise-jittered "pew". Modeled as a square sweeping 1600->250 Hz
//   (tau 90 ms) with +/-20% noise FM under a 120 ms decay envelope.
// - Explosion / base hit (INVADERS_EXPLOSION): one-shot (C24 2.2u, the
//   longest on the board) gates the noise through a TVCA and RC low-passes
//   R84/C27 (fc = 1/(2pi*5.6k*0.1u) = 284 Hz) and (R84+R85)/C28 (128 Hz).
//   Modeled as LFSR noise -> those two one-pole low-passes under a 300 ms
//   decay envelope (~1 s audible rumble).
// - Invader hit (INVADERS_INVADER_HIT): same osc+VCO topology as the shot
//   but with the short C18 0.1u one-shot -> a brief "crunch". Modeled as a
//   square sweeping 1100->180 Hz (tau 50 ms) with noise FM plus a direct
//   noise component, 80 ms decay envelope.
// - Bonus base (INVADERS_BONUS_MISSLE_BASE): 555 astable F4 (R94 100k,
//   R95 47k, C34 1u -> 1.44/((100k+2*47k)*1u) = 7.42 Hz, ~76% duty) AND
//   a fixed 480 Hz square AND the enable -> gated beep-beep-beep while
//   D4 is held. Ported arithmetically.
// - Fleet thump (INVADERS_FLEET): the four data bits parallel resistors
//   R126+R127 40k / R128 68k / R129 82k / R130 100k (invaders_thump_
//   resistors, DISC_COMP_P_RESISTOR) as R1 of 555 astable F3 (R131 75k,
//   C29 0.1u): f = 1.44/((R1+150k)*0.1u) -> 75.8 / 66.1 / 62.1 / 57.6 Hz
//   for bits 0..3, then RC low-passes R132/C31 (339 Hz) and
//   (R132+R133)/C32 (80 Hz). Modeled as a gated square at the 555
//   frequency through those two one-pole low-passes with a fast attack
//   and ~35 ms release (the game pulses one bit per fleet step).
// - Saucer hit (INVADERS_SAUCER_HIT): Norton integrator (C23 1u) + osc
//   (C21 0.1u) + VCO — a descending warble held while D4 (port 2) is set.
//   Modeled as a square warbled at 6 Hz over 0.6..1.0 x a center that
//   drifts 1200->500 Hz (tau 0.5 s) while held, 30 ms release.
// - Amp gate: sound_global_enable(data & 0x20) mutes the whole board when
//   D5 of port 1 is low (smoothed over ~2 ms to avoid clicks). Triggers
//   still register while muted, exactly like MAME.
//
// Mix: MAME routes SN76477 at 0.5 and the discrete mixer at 0.5 into mono;
// per-voice gains here are hand-balanced against the invaders_mixer
// resistor ratios, MASTER_GAIN 0.5 baked in, output hard-clamped to [-1,1].
// Shell master volume stays 1.
//
// Board contract: boards/mw8080bw.ts forwards soundboard.p1_w..p4_w as
// write(0x51..0x54, data). Invaders uses only 0x51 (port 1) and 0x52
// (port 2); 0x53/0x54 are accepted and ignored. The CPU clock passed by
// the shell is irrelevant to this board (the SN76477/discrete side is
// RC-timed), so the core runs at a fixed internal 48 kHz.

import type { SoundCore } from './types.ts';

/** Internal render rate (Hz); resampled to context rate by the worklet. */
const RATE = 48000;
/** LFSR noise clock, breadboard-measured per MAME (mw8080bw.c line 3416). */
const NOISE_CLOCK = 7515;

// --- per-voice gains (pre-master), hand-balanced -----------------------------
const UFO_GAIN = 0.32;
const SHOT_GAIN = 0.38;
const EXPLOSION_GAIN = 0.85;
const INVHIT_GAIN = 0.42;
const BONUS_GAIN = 0.22;
const FLEET_GAIN = 0.9;
const SAUCER_HIT_GAIN = 0.32;
const MASTER_GAIN = 0.5;

// --- UFO (SN76477) -----------------------------------------------------------
const UFO_SLF_HZ = 0.64 / (120000 * 1e-6);      // 5.33 Hz (R20 120k, C21 1.0u)
const UFO_VCO_MAX = 0.64 / (8200 * 0.1e-6) * 1.4; // ~1092 Hz sweep top
const UFO_VCO_MIN = 350;                          // sweep bottom

// --- fleet thump ---------------------------------------------------------------
/** invaders_thump_resistors: R126+R127, R128, R129, R130 (ohms). */
const THUMP_R = [40000, 68000, 82000, 100000];
const THUMP_R2 = 75000;   // R131
const THUMP_C = 0.1e-6;   // C29
const FLEET_LP1_HZ = 1 / (2 * Math.PI * 100 * 4.7e-6);  // R132/C31, 339 Hz
const FLEET_LP2_HZ = 1 / (2 * Math.PI * 200 * 10e-6);   // (R132+R133)/C32, 80 Hz

// --- bonus base ---------------------------------------------------------------
const BONUS_555_HZ = 1.44 / ((100000 + 2 * 47000) * 1e-6); // 7.42 Hz
const BONUS_555_DUTY = (100000 + 47000) / (100000 + 2 * 47000); // 0.758
const BONUS_TONE_HZ = 480; // DISCRETE_SQUAREWFIX node 41

/** Per-sample multiplier for an exponential decay with time constant tau. */
function decayK(tau: number): number {
  return Math.exp(-1 / (tau * RATE));
}

/** One-pole low-pass coefficient for cutoff fc. */
function lpK(fc: number): number {
  return 1 - Math.exp((-2 * Math.PI * fc) / RATE);
}

export class InvadersSound implements SoundCore {
  readonly sampleRate: number = RATE;

  // --- latches --------------------------------------------------------------
  private port1: number = 0;
  private port2: number = 0;
  /** sound_global_enable — port 1 D5 (starts enabled like MAME). */
  private ampOn: boolean = true;
  private ampGain: number = 1;           // smoothed gate
  private readonly ampK: number = lpK(80); // ~2 ms gate ramp

  // --- shared LFSR noise (midway_lfsr @ 7515 Hz, sample-and-hold) ------------
  private lfsr: number = 0x1ffff;
  private noiseOut: number = 0;          // +/-1
  private noiseFrac: number = 0;
  private readonly noiseStep: number = NOISE_CLOCK / RATE;

  // --- UFO (continuous) -------------------------------------------------------
  private ufoOn: boolean = false;
  private ufoEnv: number = 0;            // click-avoidance ramp
  private ufoLfoPhase: number = 0;       // SLF triangle, cycles [0,1)
  private ufoPhase: number = 0;

  // --- shot (one-shot) --------------------------------------------------------
  private shotEnv: number = 0;
  private shotT: number = 0;             // seconds since trigger
  private shotPhase: number = 0;
  private readonly shotDecay: number = decayK(0.12);

  // --- explosion (one-shot noise rumble) --------------------------------------
  private explEnv: number = 0;
  private explLp1: number = 0;
  private explLp2: number = 0;
  private readonly explDecay: number = decayK(0.30);
  private readonly explLp1K: number = lpK(284);
  private readonly explLp2K: number = lpK(128);

  // --- invader hit (short one-shot) --------------------------------------------
  private invhitEnv: number = 0;
  private invhitT: number = 0;
  private invhitPhase: number = 0;
  private readonly invhitDecay: number = decayK(0.08);

  // --- bonus base (gated) -------------------------------------------------------
  private bonusOn: boolean = false;
  private bonus555Phase: number = 0;
  private bonusTonePhase: number = 0;

  // --- fleet thump (gated, pitch from data bits) --------------------------------
  private fleetHz: number = 0;           // 0 = no bits set
  private fleetEnv: number = 0;
  private fleetPhase: number = 0;
  private fleetLp1: number = 0;
  private fleetLp2: number = 0;
  private readonly fleetAttack: number = lpK(160);  // ~1 ms-scale thump attack
  private readonly fleetRelease: number = decayK(0.035);
  private readonly fleetLp1K: number = lpK(FLEET_LP1_HZ);
  private readonly fleetLp2K: number = lpK(FLEET_LP2_HZ);

  // --- saucer hit (gated descending warble) ---------------------------------------
  private saucerHitOn: boolean = false;
  private saucerHitEnv: number = 0;
  private saucerHitCenter: number = 1200;
  private saucerHitLfoPhase: number = 0;
  private saucerHitPhase: number = 0;
  private readonly saucerHitDrift: number = decayK(0.5); // 1200 -> 500 Hz drift
  private readonly saucerHitRelease: number = decayK(0.03);

  /** `clock` is accepted for the shared shell contract and ignored (RC board). */
  constructor(_clock: number = 1996800) {}

  /**
   * Board register write. 0x51 = sound port 1 (invaders_audio_1_w),
   * 0x52 = sound port 2 (invaders_audio_2_w); 0x53/0x54 ignored.
   */
  write(offset: number, data: number): void {
    data &= 0xff;
    if (offset === 0x51) {
      const prev = this.port1;
      this.port1 = data;
      // D0: SN76477 enable (active-low pin -> bit set = saucer sound on)
      this.ufoOn = (data & 0x01) !== 0;
      if (this.ufoOn && !(prev & 0x01)) this.ufoLfoPhase = 0; // SLF cap starts low
      // D1..D3: one-shots trigger on the rising edge (DISC_OP_AMP_ONESHOT)
      if (data & 0x02 && !(prev & 0x02)) { this.shotEnv = 1; this.shotT = 0; }
      if (data & 0x04 && !(prev & 0x04)) this.explEnv = 1;
      if (data & 0x08 && !(prev & 0x08)) { this.invhitEnv = 1; this.invhitT = 0; }
      // D4: bonus 555 is RESET-gated, not edge-triggered
      this.bonusOn = (data & 0x10) !== 0;
      // D5: sound_global_enable
      this.ampOn = (data & 0x20) !== 0;
    } else if (offset === 0x52) {
      const prev = this.port2;
      this.port2 = data;
      // D0-D3: fleet resistors in parallel -> 555 astable frequency
      const bits = data & 0x0f;
      if (bits) {
        let g = 0;
        for (let i = 0; i < 4; i++) if (bits & (1 << i)) g += 1 / THUMP_R[i];
        this.fleetHz = 1.44 / ((1 / g + 2 * THUMP_R2) * THUMP_C);
      } else {
        this.fleetHz = 0;
      }
      // D4: saucer hit (held for the duration of the hit)
      this.saucerHitOn = (data & 0x10) !== 0;
      if (this.saucerHitOn && !(prev & 0x10)) {
        this.saucerHitCenter = 1200;
        this.saucerHitLfoPhase = 0;
      }
    }
    // 0x53 / 0x54: ports 3/4 exist on other mw8080bw sound boards; n/c here.
  }

  /** Mix all voices into `out` (mono, [-1, 1]) at the native 48 kHz rate. */
  render(out: Float32Array): void {
    const n = out.length;
    const dt = 1 / RATE;

    for (let i = 0; i < n; i++) {
      // shared LFSR noise, sample-and-hold at 7515 Hz
      this.noiseFrac += this.noiseStep;
      while (this.noiseFrac >= 1) {
        this.noiseFrac -= 1;
        const fb = ((this.lfsr >> 4) ^ (this.lfsr >> 16)) & 1;
        this.lfsr = ((this.lfsr << 1) | fb) & 0x1ffff;
        this.noiseOut = (this.lfsr >> 12) & 1 ? 1 : -1;
      }
      const noise = this.noiseOut;

      let mix = 0;

      // --- UFO: SLF-triangle-warbled square, continuous while enabled ------
      this.ufoEnv += ((this.ufoOn ? 1 : 0) - this.ufoEnv) * 0.003; // ~3 ms
      if (this.ufoEnv > 1e-4) {
        this.ufoLfoPhase += UFO_SLF_HZ * dt;
        if (this.ufoLfoPhase >= 1) this.ufoLfoPhase -= 1;
        const tri = this.ufoLfoPhase < 0.5
          ? this.ufoLfoPhase * 2
          : 2 - this.ufoLfoPhase * 2;
        const f = UFO_VCO_MIN + (UFO_VCO_MAX - UFO_VCO_MIN) * tri;
        this.ufoPhase += f * dt;
        if (this.ufoPhase >= 1) this.ufoPhase -= 1;
        mix += (this.ufoPhase < 0.5 ? 1 : -1) * this.ufoEnv * UFO_GAIN;
      }

      // --- shot: descending noise-FM "pew" ---------------------------------
      if (this.shotEnv > 1e-3) {
        const f = (250 + 1350 * Math.exp(-this.shotT / 0.09)) * (1 + 0.2 * noise);
        this.shotPhase += f * dt;
        if (this.shotPhase >= 1) this.shotPhase -= 1;
        mix += (this.shotPhase < 0.5 ? 1 : -1) * this.shotEnv * SHOT_GAIN;
        this.shotEnv *= this.shotDecay;
        this.shotT += dt;
      }

      // --- explosion: low-passed noise rumble ------------------------------
      if (this.explEnv > 1e-3) {
        this.explLp1 += (noise * this.explEnv - this.explLp1) * this.explLp1K;
        this.explLp2 += (this.explLp1 - this.explLp2) * this.explLp2K;
        mix += this.explLp2 * EXPLOSION_GAIN;
        this.explEnv *= this.explDecay;
      } else if (this.explLp2 !== 0) {
        // let the filters ring down to true zero
        this.explLp1 += (0 - this.explLp1) * this.explLp1K;
        this.explLp2 += (this.explLp1 - this.explLp2) * this.explLp2K;
        if (Math.abs(this.explLp2) < 1e-6 && Math.abs(this.explLp1) < 1e-6) {
          this.explLp1 = 0;
          this.explLp2 = 0;
        }
        mix += this.explLp2 * EXPLOSION_GAIN;
      }

      // --- invader hit: short swept crunch + noise --------------------------
      if (this.invhitEnv > 1e-3) {
        const f = (180 + 920 * Math.exp(-this.invhitT / 0.05)) * (1 + 0.25 * noise);
        this.invhitPhase += f * dt;
        if (this.invhitPhase >= 1) this.invhitPhase -= 1;
        const sq = this.invhitPhase < 0.5 ? 1 : -1;
        mix += (0.7 * sq + 0.3 * noise) * this.invhitEnv * INVHIT_GAIN;
        this.invhitEnv *= this.invhitDecay;
        this.invhitT += dt;
      }

      // --- bonus base: 480 Hz beep gated by the 7.42 Hz 555 -----------------
      if (this.bonusOn) {
        this.bonus555Phase += BONUS_555_HZ * dt;
        if (this.bonus555Phase >= 1) this.bonus555Phase -= 1;
        this.bonusTonePhase += BONUS_TONE_HZ * dt;
        if (this.bonusTonePhase >= 1) this.bonusTonePhase -= 1;
        if (this.bonus555Phase < BONUS_555_DUTY) {
          mix += (this.bonusTonePhase < 0.5 ? 1 : -1) * BONUS_GAIN;
        }
      }

      // --- fleet thump: 555 square through the two RC low-passes ------------
      if (this.fleetHz > 0) {
        this.fleetEnv += (1 - this.fleetEnv) * this.fleetAttack;
        this.fleetPhase += this.fleetHz * dt;
        if (this.fleetPhase >= 1) this.fleetPhase -= 1;
      } else {
        this.fleetEnv *= this.fleetRelease;
        if (this.fleetEnv < 1e-4) this.fleetEnv = 0;
      }
      if (this.fleetEnv > 0 || this.fleetLp2 !== 0) {
        const sq = this.fleetPhase < 0.5 ? 1 : -1;
        this.fleetLp1 += (sq * this.fleetEnv - this.fleetLp1) * this.fleetLp1K;
        this.fleetLp2 += (this.fleetLp1 - this.fleetLp2) * this.fleetLp2K;
        if (this.fleetEnv === 0 && Math.abs(this.fleetLp2) < 1e-6 && Math.abs(this.fleetLp1) < 1e-6) {
          this.fleetLp1 = 0;
          this.fleetLp2 = 0;
        }
        mix += this.fleetLp2 * FLEET_GAIN;
      }

      // --- saucer hit: descending warble while held --------------------------
      if (this.saucerHitOn) {
        this.saucerHitEnv += (1 - this.saucerHitEnv) * 0.005; // ~4 ms attack
      } else {
        this.saucerHitEnv *= this.saucerHitRelease;
        if (this.saucerHitEnv < 1e-4) this.saucerHitEnv = 0;
      }
      if (this.saucerHitEnv > 0) {
        this.saucerHitCenter = 500 + (this.saucerHitCenter - 500) * this.saucerHitDrift;
        this.saucerHitLfoPhase += 6 * dt;
        if (this.saucerHitLfoPhase >= 1) this.saucerHitLfoPhase -= 1;
        const tri = this.saucerHitLfoPhase < 0.5
          ? this.saucerHitLfoPhase * 2
          : 2 - this.saucerHitLfoPhase * 2;
        const f = this.saucerHitCenter * (0.6 + 0.4 * tri);
        this.saucerHitPhase += f * dt;
        if (this.saucerHitPhase >= 1) this.saucerHitPhase -= 1;
        mix += (this.saucerHitPhase < 0.5 ? 1 : -1) * this.saucerHitEnv * SAUCER_HIT_GAIN;
      }

      // --- amp gate + master --------------------------------------------------
      this.ampGain += ((this.ampOn ? 1 : 0) - this.ampGain) * this.ampK;
      mix *= this.ampGain * MASTER_GAIN;
      out[i] = mix > 1 ? 1 : mix < -1 ? -1 : mix;
    }
  }
}
