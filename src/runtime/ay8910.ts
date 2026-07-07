// AY-3-8910 PSG — 3 tone generators + noise + envelope, mono output.
// Hand-ported from MAME src/devices/sound/ay8910.cpp / ay8910.h
// (ay8910_device, PSG_TYPE_AY, non-expanded mode), with the normalized
// logarithmic volume table taken from the classic implementation
// (MAME 0.121, `git show 7b77f121862:src/emu/sound/ay8910.c`,
// build_mixer_table lines 592-610). Gyruss drives FIVE of these at
// 14.31818 MHz / 8; the worklet (ay8910-worklet.ts) hosts the bank.
//
// Timing (all MAME-exact, sampleRate = clock / 8, device_start:
// "m_channel = stream_alloc(0, m_streams, master_clock / 8)"):
// - Tone: 12-bit period TP, output toggles every TP samples (half-period
//   squarewave semantics, ay8910.cpp sound_stream_update ~1073-1083)
//   -> tone frequency = clock / (16 * TP); period 0 behaves as period 1
//   (std::max<int>(1, tone->period)).
// - Noise: 5-bit period NP; a prescaler flip-flop halves the rate so the
//   17-bit LFSR shifts every 2*NP samples (ay8910.cpp ~1085-1104)
//   -> LFSR shift rate = clock / (16 * NP); NP 0 == NP 1.
// - Envelope (AY type: m_env_step_mask = 0x0f, m_step = 2, set_type
//   ay8910.cpp ~1598-1618): 16 levels, one step every 2*EP samples
//   -> full 32-step cycle frequency = clock / (256 * EP); EP 0 steps
//   every sample (half of EP 1), as the classic code documents
//   ("period = 0 is half as period = 1" for the envelope only).
//
// LFSR (ay8910.h noise_rng_tick ~263-272): 17-bit shift register, input =
// bit0 XOR bit3, output = bit0 ("verified on AY-3-8910 and YM2149 chips").
//
// Mixer (ay8910.cpp ~1060-1111): per channel,
//   gate = (toneOutput | toneDisable) & (noiseOutput | noiseDisable)
// where reg 7 bits 0-2 disable tone A/B/C and bits 3-5 disable noise
// (active low enables). Both disabled -> gate locked at 1, so the output
// is the DAC level itself and can be modulated via the volume register.
//
// Volume DAC: the AY has 16 logarithmic levels at 3 dB per step, level 0
// fully off ("zero_is_off"). The classic build_mixer_table constructs a
// 32-entry table stepping 1.5 dB (out /= 1.188502227 = 10^(1.5/20)) with
// VolTable[0] = 0, and fixed 4-bit levels index it as VolTable[v*2+1]
// (ay8910.c 0.121 lines 140-153) — the net 16-entry view implemented here:
//   volTable[v] = 1.188502227^(2*(v-15))  (v >= 1),  volTable[0] = 0,
// normalized so level 15 = 1.0. Envelope levels (16 steps in AY mode)
// index the same table, as modern MAME does for PSG_TYPE_AY
// (m_par_env = &ay8910_param, set_type ay8910.cpp ~1604-1609).
//
// Deliberate deviations from MAME:
// - Output is DC-centered per channel: the physical channel swings
//   {0, +level}; we emit (gate ? +1 : -1) * volTable[level] / 3 so a full
//   blast 3-channel chip spans exactly [-1, 1] (MAME emits the unipolar
//   levels and relies on downstream DC filtering).
// - readReg on port A/B consults portARead/portBRead only in INPUT mode
//   (direction bit clear); output mode returns the latch. (Modern MAME
//   consults the callback in both modes for the kidniki open-collector
//   case; the agreed mamekit board contract is input-mode-only.)

/** AY-3-8910 register indices (ay8910.cpp AY_AFINE..AY_PORTB). */
const AY_ENABLE = 7;
const AY_PORTA = 14;
const AY_PORTB = 15;

/**
 * Read-back masks: on a real AY-3-8910 the unused register bits read as 0
 * (ay8910.cpp ay8910_read_ym ~1440-1444, "Tested and confirmed on
 * hardware").
 */
const READ_MASK: readonly number[] = [
  0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff,
  0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff,
];

/**
 * Normalized 16-level DAC table (see header). volTable[0] = 0,
 * volTable[15] = 1, 3 dB (x1.412537...) per step in between —
 * MAME 0.121 build_mixer_table values normalized to 1.0.
 */
export const AY8910_VOL_TABLE: Float32Array = (() => {
  const t = new Float32Array(16);
  for (let v = 1; v < 16; v++) t[v] = Math.pow(1.188502227, 2 * (v - 15));
  return t;
})();

interface Tone {
  /** 12-bit period (fine | coarse<<8), in samples per half-cycle. */
  period: number;
  /** sample counter toward the next half-cycle */
  count: number;
  /** 5-bit down counter; bit 0 is the square-wave output (modern MAME) */
  dutyCycle: number;
  /** current square-wave output bit */
  output: number;
  /** fixed 4-bit level (reg 8/9/10 low nibble) */
  volume: number;
  /** bit 4 of the level register: channel follows the envelope */
  envMode: boolean;
}

export class AY8910 {
  /** Native output rate == clock / 8 (MAME ay8910_device stream rate). */
  readonly sampleRate: number;
  /** The normalized 16-level DAC table (exposed for specs/tools). */
  readonly volTable: Float32Array = AY8910_VOL_TABLE;

  /** io port callbacks (reg 14/15 reads when the port is in input mode) */
  portARead?: () => number;
  portBRead?: () => number;
  portAWrite?: (v: number) => void;
  portBWrite?: (v: number) => void;

  private readonly regs = new Uint8Array(16);
  /** last reg 7 value, -1 = force the initial port-direction write */
  private lastEnable = -1;

  private readonly tones: Tone[];

  // noise generator (17-bit LFSR + halving prescaler)
  private rng = 1;
  private countNoise = 0;
  private prescaleNoise = 0;

  // envelope generator (single, shared by the three channels)
  private envPeriod = 0;   // 16-bit (reg 11 | reg 12 << 8)
  private envCount = 0;
  private envStep = 0;     // counts 15 -> 0 each ramp
  private envAttack = 0;   // 0x00 or 0x0f, XORed into the step
  private envHold = 0;
  private envAlternate = 0;
  private envHolding = 0;

  constructor(clock: number) {
    this.sampleRate = clock / 8;
    this.tones = [];
    for (let i = 0; i < 3; i++) {
      this.tones.push({
        period: 0, count: 0, dutyCycle: 0, output: 0, volume: 0, envMode: false,
      });
    }
    // ay8910_reset_ym state: rng = 1, regs = 0 (silence: reg 7 = 0 enables
    // everything but all levels are 0), register latch owned by the board.
  }

  /** Direct register write, reg 0-15 (ay8910_write_reg). */
  writeReg(reg: number, value: number): void {
    reg &= 0x0f;
    value &= 0xff;
    this.regs[reg] = value;

    switch (reg) {
      case 0: // AY_AFINE
      case 1: // AY_ACOARSE (4 significant bits)
        this.tones[0].period = this.regs[0] | ((this.regs[1] & 0x0f) << 8);
        break;
      case 2:
      case 3:
        this.tones[1].period = this.regs[2] | ((this.regs[3] & 0x0f) << 8);
        break;
      case 4:
      case 5:
        this.tones[2].period = this.regs[4] | ((this.regs[5] & 0x0f) << 8);
        break;

      case 6: // AY_NOISEPER — masked to 5 bits at use
        break;

      case AY_ENABLE: {
        // Port direction changes push the latch (or 0xff pull-ups when the
        // port turns around to input) out through the write callback
        // (ay8910.cpp AY_ENABLE case ~1004-1017).
        const last = this.lastEnable;
        if (last < 0 || ((last ^ value) & 0x40)) {
          this.portAWrite?.((value & 0x40) ? this.regs[AY_PORTA] : 0xff);
        }
        if (last < 0 || ((last ^ value) & 0x80)) {
          this.portBWrite?.((value & 0x80) ? this.regs[AY_PORTB] : 0xff);
        }
        this.lastEnable = value;
        break;
      }

      case 8:
      case 9:
      case 10: {
        const tone = this.tones[reg - 8];
        tone.volume = value & 0x0f;
        tone.envMode = (value & 0x10) !== 0;
        break;
      }

      case 11: // AY_EFINE
      case 12: // AY_ECOARSE
        this.envPeriod = this.regs[11] | (this.regs[12] << 8);
        break;

      case 13: { // AY_ESHAPE (envelope_t::set_shape, ay8910.h ~242-259)
        const shape = value & 0x0f;
        this.envAttack = (shape & 0x04) ? 0x0f : 0x00;
        if ((shape & 0x08) === 0) {
          // if Continue = 0, map to the equivalent shape with Continue = 1
          this.envHold = 1;
          this.envAlternate = this.envAttack;
        } else {
          this.envHold = shape & 0x01;
          this.envAlternate = shape & 0x02;
        }
        this.envStep = 0x0f;
        this.envHolding = 0;
        break;
      }

      case AY_PORTA: // write reaches the pins only in output mode
        if (this.regs[AY_ENABLE] & 0x40) this.portAWrite?.(value);
        break;
      case AY_PORTB:
        if (this.regs[AY_ENABLE] & 0x80) this.portBWrite?.(value);
        break;
    }
  }

  /**
   * Register read with hardware read-back masks. Port A/B reads consult
   * portARead/portBRead when the port direction is INPUT (reg 7 bit 6/7
   * clear); output mode returns the latch (see header for the deviation).
   */
  readReg(reg: number): number {
    reg &= 0x0f;
    if (reg === AY_PORTA && (this.regs[AY_ENABLE] & 0x40) === 0 && this.portARead) {
      this.regs[AY_PORTA] = this.portARead() & 0xff;
    } else if (reg === AY_PORTB && (this.regs[AY_ENABLE] & 0x80) === 0 && this.portBRead) {
      this.regs[AY_PORTB] = this.portBRead() & 0xff;
    }
    return this.regs[reg] & READ_MASK[reg];
  }

  // per-sample channel outputs produced by tick() (±volTable[level] each)
  private ch0 = 0;
  private ch1 = 0;
  private ch2 = 0;

  /**
   * Advance all generators by one native sample and latch the three
   * channel outputs (±volTable[level] each, full per-channel scale) into
   * ch0/ch1/ch2. Direct port of ay8910_device::sound_stream_update
   * (ay8910.cpp ~1057-1200), non-expanded AY path, with the per-channel
   * DC centering described in the header.
   */
  private tick(): void {
    const tones = this.tones;
    const table = AY8910_VOL_TABLE;
    const enable = this.regs[AY_ENABLE];
    const noisePeriod = this.regs[6] & 0x1f;

    // --- tone generators (half-period toggle via 5-bit duty counter) ---
    for (let ch = 0; ch < 3; ch++) {
      const tone = tones[ch];
      const period = tone.period < 1 ? 1 : tone.period; // period 0 == 1
      tone.count++;
      while (tone.count >= period) {
        tone.dutyCycle = (tone.dutyCycle - 1) & 0x1f;
        tone.output = tone.dutyCycle & 1;
        tone.count -= period;
      }
    }

    // --- noise: prescaler halves the rate, then the 17-bit LFSR shifts ---
    if (++this.countNoise >= noisePeriod) {
      this.countNoise = 0;
      this.prescaleNoise ^= 1;
      if (!this.prescaleNoise) {
        // noise_rng_tick: input = bit0 ^ bit3, shifted in at bit 16
        const r = this.rng;
        this.rng = (r >>> 1) | (((r ^ (r >>> 3)) & 1) << 16);
      }
    }
    const noiseBit = this.rng & 1;

    // --- envelope (AY: 16 steps, period counted x2 via m_step = 2) ---
    if (!this.envHolding) {
      if (++this.envCount >= this.envPeriod * 2) {
        this.envCount = 0;
        this.envStep--;
        if (this.envStep < 0) {
          if (this.envHold) {
            if (this.envAlternate) this.envAttack ^= 0x0f;
            this.envHolding = 1;
            this.envStep = 0;
          } else {
            // looped an odd number of times: invert the output
            if (this.envAlternate && (this.envStep & 0x10)) this.envAttack ^= 0x0f;
            this.envStep &= 0x0f;
          }
        }
      }
    }
    const envVolume = this.envStep ^ this.envAttack;

    // --- mix: gate = (tone | toneDisable) & (noise | noiseDisable) ---
    for (let ch = 0; ch < 3; ch++) {
      const tone = tones[ch];
      const gate =
        (tone.output | ((enable >> ch) & 1)) &
        (noiseBit | ((enable >> (3 + ch)) & 1));
      const level = tone.envMode ? envVolume : tone.volume;
      const v = gate ? table[level] : -table[level];
      if (ch === 0) this.ch0 = v;
      else if (ch === 1) this.ch1 = v;
      else this.ch2 = v;
    }
  }

  /**
   * Fill `out` with the next out.length mono samples in [-1, 1] at the
   * native rate (the three channels summed at 1/3 gain).
   */
  render(out: Float32Array): void {
    const n = out.length;
    for (let i = 0; i < n; i++) {
      this.tick();
      out[i] = (this.ch0 + this.ch1 + this.ch2) * (1 / 3);
    }
  }

  /**
   * Per-channel variant of render(): fills the three buffers (equal
   * lengths) with the raw channel outputs, each spanning [-1, 1]
   * (±volTable[level], NO 1/3 mix gain). Advances the same generator
   * state as render() — use one or the other per chip, not both.
   * Downstream mixers (ay8910-worklet.ts per-channel RC filters) apply
   * the 1/3 sum themselves: render() == (ch0 + ch1 + ch2) / 3.
   */
  renderChannels(out0: Float32Array, out1: Float32Array, out2: Float32Array): void {
    const n = out0.length;
    for (let i = 0; i < n; i++) {
      this.tick();
      out0[i] = this.ch0;
      out1[i] = this.ch1;
      out2[i] = this.ch2;
    }
  }
}

// --------------------------------------------------------------------------
// Konami switchable RC low-pass (junofrst/gyruss AY port B filter select).
//
// Hardware: each AY channel feeds a resistor network with two MCU-switchable
// capacitors to ground. MAME junofrst.cpp portB_w decodes two bits per
// channel (bit0 -> 47000 pF, bit1 -> 220000 pF, summed) and programs
// filter_rc_device LOWPASS_3R with R1=1000, R2=2200, R3=200
// (src/devices/sound/flt_rc.cpp recalc):
//   Req = R1*(R2+R3) / (R1+R2+R3)
//   k   = 1 - exp(-1 / (Req*C) / sampleRate)      (C = 0 -> bypass, k = 1)
// applied as the one-pole  y += (x - y) * k  per native sample.
// gyruss.cpp routes the same cap pairs through its discrete net
// (DISCRETE_RCFILTER_SW); we approximate both boards with the LOWPASS_3R
// form above.

/** LOWPASS_3R resistor network on the Konami boards (ohms). */
export const KONAMI_FILTER_R1 = 1000;
export const KONAMI_FILTER_R2 = 2200;
export const KONAMI_FILTER_R3 = 200;

/**
 * Decode an AY port-B filter-select byte (junofrst_state::portB_w /
 * gyruss_state::filter_w): two bits per channel, bit0 = 47000 pF,
 * bit1 = 220000 pF, summed. Returns [chA, chB, chC] in picofarads
 * (0 / 47000 / 220000 / 267000).
 */
export function konamiFilterCaps(data: number): [number, number, number] {
  const caps: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let c = 0;
    if (data & 1) c += 47000;   // 47000 pF = 0.047 uF
    if (data & 2) c += 220000;  // 220000 pF = 0.22 uF
    data >>= 2;
    caps[i] = c;
  }
  return caps;
}

/**
 * One-pole coefficient for MAME filter_rc LOWPASS_3R (flt_rc.cpp recalc).
 * `capPf` in picofarads; returns k for  y += (x - y) * k  at `sampleRate`.
 * capPf = 0 disables the filter (returns exactly 1 — callers should treat
 * k === 1 as bypass and skip the filter to stay bit-transparent).
 */
export function lowpass3RCoeff(
  r1: number, r2: number, r3: number, capPf: number, sampleRate: number,
): number {
  if (capPf === 0) return 1;
  const req = (r1 * (r2 + r3)) / (r1 + r2 + r3);
  return 1 - Math.exp(-1 / (req * capPf * 1e-12) / sampleRate);
}

/**
 * Apply the one-pole low-pass in place (flt_rc.cpp stream update,
 * LOWPASS_3R/LOWPASS branch): memory += (x - memory) * k. Returns the
 * updated memory (feed it back in on the next block).
 */
export function rcLowPass(buf: Float32Array, k: number, memory: number): number {
  for (let i = 0; i < buf.length; i++) {
    memory += (buf[i] - memory) * k;
    buf[i] = memory;
  }
  return memory;
}

/**
 * Sum a bank of chips into `out`, scaled by 1/chips so N chips at full
 * blast stay within [-1, 1] (gyruss runs five). `scratch` must have the
 * same length as `out`; both are fully overwritten. Used by
 * ay8910-worklet.ts and node specs.
 */
export function renderBank(
  chips: readonly AY8910[],
  out: Float32Array,
  scratch: Float32Array,
): void {
  out.fill(0);
  if (chips.length === 0) return;
  const gain = 1 / chips.length;
  for (const chip of chips) {
    chip.render(scratch);
    for (let i = 0; i < out.length; i++) out[i] += scratch[i] * gain;
  }
}
