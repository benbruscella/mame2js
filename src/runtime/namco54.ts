// Namco 54xx noise generator — HLE (high-level emulation).
//
// The real chip is a Fujitsu MB8844 MCU (program 54xx.bin, CRC ee7357e0)
// whose three 4-bit outputs drive a discrete op-amp filter network on the
// Galaga board. A full MB88xx LLE is out of scope; this module models the
// device as (a) the documented command protocol, (b) three software noise
// generators with stepped amplitude envelopes, and (c) a faithful port of
// MAME's discrete filter network for the galaga board.
//
// -- Command protocol (MAME src/devices/audio/namco54.cpp header comment) --
//   0x: nop
//   1x: play sound type A
//   2x: play sound type B
//   3x: set parameters (type A) (followed by 4 bytes)
//   4x: set parameters (type B) (followed by 4 bytes)
//   5x: play sound type C
//   6x: set parameters (type C) (followed by 5 bytes)
//   7x: set volume for sound type C to x
//   8x-Fx: nop
// Parameter bytes are consumed raw (a 0x40 following a 0x3n command is a
// parameter, not a command). Real galaga traffic, captured from this
// repo's headless board harness (roms/galaga.zip through GalagaBoard):
//   boot init  : 30 40 00 02 df  40 30 30 03 df  10 20
//   player death (each): 10 10 20 20
// i.e. galaga programs type A = [40 00 02 df], type B = [30 30 03 df] once
// at boot, then every explosion is "play A + play B" (written twice).
//
// -- Output-to-discrete-channel mapping (namco54.cpp O_w / R1_w) --
//   type A -> O0-O3 (low nibble of port O)  -> NAMCO_54XX_0_DATA
//   type B -> O4-O7 (high nibble of port O) -> NAMCO_54XX_1_DATA
//   type C -> R1 port                       -> NAMCO_54XX_2_DATA
//
// -- Discrete network (MAME src/mame/namco/galaga_a.cpp, galaga_discrete) --
// Each output feeds a 4-bit R1 DAC ladder (47k/22k/10k/4.7k, vBit = 4V)
// into an op-amp multiple-feedback band-pass (DISC_OP_AMP_FILTER_IS_
// BAND_PASS_1M), all referenced to VREF = 5*2.2k/(3.3k+2.2k) = 2.0V:
//   54XX_0 -> CHANL3: rIn = DAC_R+150k, rShunt 22k, rF 470k, C 0.01u
//             -> fc ~ 167 Hz  (the deep explosion rumble)
//   54XX_1 -> CHANL2: rIn = DAC_R+47k,  rShunt 10k, rF 150k, C 0.01u
//             -> fc ~ 450 Hz  (the explosion body)
//   54XX_2 -> CHANL1: rIn = DAC_R+100k, rShunt 22k, rF 220k, C 0.001u
//             -> fc ~ 2.5 kHz (hiss; used by Bosconian shot, unused by galaga)
// The band-pass is implemented exactly as MAME disc_flt.hxx does it:
// bilinear-transformed (pre-warped) 2nd-order band-pass with
//   rTotal = rIn || rShunt
//   fc   = 1 / (2*pi*sqrt(rTotal*rF*c1*c2))
//   d    = (c1+c2) / sqrt(rF/rTotal * c1*c2)
//   gain = -rF/rTotal * c2/(c1+c2)
// and the output clipped to the op-amp rails [0, 5-1.5] volts
// (OP_AMP_VP_RAIL_OFFSET) with the clipped value fed back (that clipping
// IS the explosion distortion, per the MAME source comment).
// The three filters meet in an op-amp mixer (disc_mth.hxx, DISC_MIXER_IS_
// OP_AMP): i = sum((VREF - v_i)/r_i) with r = 33k/33k/10k (CHANL1/2/3),
// v = i*rF (rF = 3.3k), AC-coupled through cAmp = 0.1uF against 100k
// (tau 10 ms, per MAME's fixed RES_K(100) in the cAmp exponent), then
// scaled by the mixer gain 40800 and divided by MAME's discrete full-scale
// 32768. The final [-1,1] clamp honors the SoundCore contract (MAME can
// exceed full scale here too; it clamps in the stream layer).
//
// -- Approximations (the MCU-program side, not derivable without an LLE) --
// * Noise source: one 16-bit maximal-length Galois LFSR per channel
//   (taps 0xB400), gating the DAC nibble between the envelope amplitude
//   and 0. The real chip has independent RNGs for type A and B (they are
//   even pinned out, unconnected — namco54.cpp pins 21/22 note).
// * Output update rate: 12 kHz. The MB8844 runs ~250k instructions/s
//   (MAME 0.121 src/mame/audio/namco54.c: "The execution time of one
//   instruction is ~4us"); a plausible output loop is a couple dozen
//   instructions, and the band-pass filters dominate the spectrum anyway.
// * Envelope: stepped 4-bit countdown 15 -> 0 (16 levels), total duration
//   (params[0] >> 4) * 0.3 s — a heuristic anchored to the captured galaga
//   parameters: type A (0x40) -> 1.2 s deep boom, type B (0x30) -> 0.9 s.
//   The remaining parameter bytes are stored but not interpreted.
// * Type C volume (7x) scales the channel-2 nibble; it defaults to 15 so
//   a bare "5x" trigger is audible. Galaga never uses type C.
//
// Pure DSP: no DOM, deterministic (fixed LFSR seeds), zero dependencies.

/** number of output samples between MCU output updates (see header) */
const NOISE_RATE_HZ = 12000;

/** stepped-envelope duration per unit of params[0] high nibble, seconds */
const ENV_UNIT_SECONDS = 0.3;

// --- discrete network constants (galaga_a.cpp values, ohms/farads/volts) ---
const VREF = 5.0 * 2200 / (3300 + 2200);        // 2.0 V
const V_CLIP_HI = 5.0 - 1.5;                    // op-amp rail (vP - OP_AMP_VP_RAIL_OFFSET)
const V_CLIP_LO = 0.0;                          // vN
const DAC_LADDER = [47000, 22000, 10000, 4700]; // bit 0..3
const MIX_RF = 3300;                            // mixer feedback R
const MIX_GAIN = 40800 / 32768;                 // mixer gain / MAME discrete full-scale
const CAMP_TAU = 100000 * 0.1e-6;               // cAmp high-pass: 100k * 0.1uF = 10 ms

interface FilterSpec {
  rIn: number;     // DAC ladder R + series resistor into the op-amp
  rShunt: number;  // shunt resistor at the op-amp input
  rF: number;      // feedback resistor
  c: number;       // c1 = c2
  rMix: number;    // this channel's resistor into the final mixer
}

/** parallel resistance of the DAC ladder (source impedance seen by the filter) */
const DAC_R = 1 / DAC_LADDER.reduce((s, r) => s + 1 / r, 0); // ~2635 ohms

/** per-54xx-output filter chain, index = 54xx output 0/1/2 (see header mapping) */
const FILTERS: FilterSpec[] = [
  { rIn: DAC_R + 150000, rShunt: 22000, rF: 470000, c: 0.01e-6, rMix: 10000 },  // CHANL3
  { rIn: DAC_R + 47000, rShunt: 10000, rF: 150000, c: 0.01e-6, rMix: 33000 },   // CHANL2
  { rIn: DAC_R + 100000, rShunt: 22000, rF: 220000, c: 0.001e-6, rMix: 33000 }, // CHANL1
];

/** 4-bit DAC ladder output voltage per nibble value (exact R1 ladder math) */
const DAC_V: number[] = (() => {
  const v: number[] = [];
  for (let n = 0; n < 16; n++) {
    let i = 0;
    for (let b = 0; b < 4; b++) if (n & (1 << b)) i += 1 / DAC_LADDER[b];
    v.push(4.0 * i * DAC_R); // vBit = 4V ("4V - unmeasured" in galaga_a.cpp)
  }
  return v;
})();

/** one 54xx output channel: noise generator + envelope + band-pass state */
class Channel {
  // MFB band-pass biquad (b1 = 0 for a band-pass; b2 = -b0)
  a1 = 0; a2 = 0; b0 = 0; b2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  /** (rIn || rShunt) / rIn — input divider from DAC volts to filter volts */
  inScale = 0;
  rMix = 0;

  lfsr: number;
  /** current DAC nibble driven by the "MCU" */
  nibble = 0;
  /** envelope position in noise ticks; >= durTicks means idle */
  pos = 0;
  durTicks = 0;
  /** channel volume 0..15 (only type C has a volume command) */
  volume = 15;
  params = [0, 0, 0, 0, 0];

  constructor(seed: number) {
    this.lfsr = seed;
  }
}

export class Namco54 {
  readonly sampleRate: number;

  private channels: Channel[] = [];
  /** samples per MCU output update */
  private noisePeriod: number;
  private noiseCountdown = 0;
  /** mixer cAmp high-pass state + per-sample charge exponent */
  private capAmp = 0;
  private expAmp: number;

  // command protocol state: how many parameter bytes are still owed, and
  // which channel's parameter buffer they fill
  private pendingParams = 0;
  private paramTarget = 0;
  private paramIndex = 0;

  constructor(sampleRate: number = 96000) {
    this.sampleRate = sampleRate;
    this.noisePeriod = Math.max(1, Math.round(sampleRate / NOISE_RATE_HZ));
    this.expAmp = 1 - Math.exp(-1 / (sampleRate * CAMP_TAU));

    const seeds = [0x5a21, 0x1f35, 0x7c4b]; // fixed -> deterministic
    for (let c = 0; c < 3; c++) {
      const ch = new Channel(seeds[c]);
      const f = FILTERS[c];
      const rTotal = 1 / (1 / f.rIn + 1 / f.rShunt);
      ch.inScale = rTotal / f.rIn;
      ch.rMix = f.rMix;

      // MAME disc_flt.hxx DISC_OP_AMP_FILTER_IS_BAND_PASS_1M coefficients
      const fc = 1 / (2 * Math.PI * Math.sqrt(rTotal * f.rF * f.c * f.c));
      const d = (f.c + f.c) / Math.sqrt((f.rF / rTotal) * f.c * f.c);
      const gain = (-f.rF / rTotal) * (f.c / (f.c + f.c));

      // calculate_filter2_coefficients (bilinear transform, pre-warped)
      const twoOverT = 2 * sampleRate;
      const wc = sampleRate * 2 * Math.tan(Math.PI * fc / sampleRate);
      const den = twoOverT * twoOverT + d * wc * twoOverT + wc * wc;
      ch.a1 = 2 * (-twoOverT * twoOverT + wc * wc) / den;
      ch.a2 = (twoOverT * twoOverT - d * wc * twoOverT + wc * wc) / den;
      ch.b0 = gain * (d * wc * twoOverT / den);
      ch.b2 = -ch.b0;

      // steady-state init for a constant idle input: with x1 = x2 = v_dc
      // and y1 = y2 = 0 the band-pass output is exactly 0 (b2 = -b0), so
      // the core is bit-exactly silent until the first trigger.
      const idle = (DAC_V[0] - VREF) * ch.inScale;
      ch.x1 = idle;
      ch.x2 = idle;
      this.channels.push(ch);
    }
  }

  /** consume one byte of the 06xx slot-3 command stream */
  write(data: number): void {
    data &= 0xff;
    if (this.pendingParams > 0) {
      const ch = this.channels[this.paramTarget];
      ch.params[this.paramIndex++] = data;
      this.pendingParams--;
      return;
    }
    switch (data >> 4) {
      case 0x1: this.trigger(0); break;                       // play type A
      case 0x2: this.trigger(1); break;                       // play type B
      case 0x3: this.expectParams(0, 4); break;               // params type A
      case 0x4: this.expectParams(1, 4); break;               // params type B
      case 0x5: this.trigger(2); break;                       // play type C
      case 0x6: this.expectParams(2, 5); break;               // params type C
      case 0x7: this.channels[2].volume = data & 0x0f; break; // volume type C
      default: break;                                         // 0x, 8x-Fx: nop
    }
  }

  private expectParams(channel: number, count: number): void {
    this.pendingParams = count;
    this.paramTarget = channel;
    this.paramIndex = 0;
  }

  private trigger(channel: number): void {
    const ch = this.channels[channel];
    // duration heuristic from params[0] high nibble (see header); a channel
    // that was never parameterized gets the 2-unit (0.6 s) default
    const units = (ch.params[0] >> 4) || 2;
    ch.durTicks = Math.max(1, Math.round(units * ENV_UNIT_SECONDS * NOISE_RATE_HZ));
    ch.pos = 0;
  }

  /** fill `out` with mono samples in [-1, 1] */
  render(out: Float32Array): void {
    const chs = this.channels;
    for (let i = 0; i < out.length; i++) {
      // MCU output update at NOISE_RATE_HZ: advance LFSRs + envelopes
      if (this.noiseCountdown-- <= 0) {
        this.noiseCountdown = this.noisePeriod - 1;
        for (let c = 0; c < 3; c++) {
          const ch = chs[c];
          if (ch.pos < ch.durTicks) {
            // 16-bit maximal Galois LFSR
            ch.lfsr = (ch.lfsr >> 1) ^ (-(ch.lfsr & 1) & 0xb400);
            const amp = 15 - Math.floor((ch.pos * 16) / ch.durTicks);
            const scaled = c === 2 ? Math.round((amp * ch.volume) / 15) : amp;
            ch.nibble = ch.lfsr & 1 ? scaled : 0;
            ch.pos++;
          } else {
            ch.nibble = 0;
          }
        }
      }

      // discrete network: DAC -> band-pass (rail-clipped) -> op-amp mixer
      let iSum = 0;
      for (let c = 0; c < 3; c++) {
        const ch = chs[c];
        const vin = (DAC_V[ch.nibble] - VREF) * ch.inScale;
        const y = -ch.a1 * ch.y1 - ch.a2 * ch.y2 + ch.b0 * vin + ch.b2 * ch.x2;
        ch.x2 = ch.x1;
        ch.x1 = vin;
        ch.y2 = ch.y1;
        // clip to the op-amp rails and feed the clipped value back (MAME
        // disc_flt.hxx stores y1 = clipped v_out - vRef)
        let vout = y + VREF;
        if (vout > V_CLIP_HI) vout = V_CLIP_HI;
        else if (vout < V_CLIP_LO) vout = V_CLIP_LO;
        ch.y1 = vout - VREF;
        iSum += (VREF - vout) / ch.rMix;
      }
      let v = iSum * MIX_RF;
      this.capAmp += (v - this.capAmp) * this.expAmp;
      v = (v - this.capAmp) * MIX_GAIN;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
}
