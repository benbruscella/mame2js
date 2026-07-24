/** Register-space extension used between generated boards and AY worklets. */
export const AY_FILTER_CONTROL_BASE = 0x100;
export const AY_FILTER_CONTROL_STRIDE = 5;

/** MAME's default post-mix speaker effect, extracted during generation. */
export interface GeneratedSpeakerFilterPlan {
  type: 'highpass';
  frequency: number;
  q: number;
  source: {
    file: string;
    line: number;
  };
}

/** Source-derived DAC/filter network mixed alongside a primary sound core. */
export interface GeneratedDacFilterPlan {
  type: 'DAC_FILTER';
  levels: number[];
  channels: {
    input: number;
    frequency: number;
    q: number;
    gain: number;
  }[];
  outputGain: number;
  source: { file: string; line: number; netlist: string };
}

/** Executable subset of a MAME DISCRETE_SOUND_START signal graph. */
export interface GeneratedDiscreteMixerPlan {
  schemaVersion: 1;
  type: 'DISCRETE_MIXER';
  streamInputs: {
    node: number;
    input: number;
    gain: number;
    offset: number;
  }[];
  dataInputs: {
    node: number;
    gain: number;
    offset: number;
  }[];
  controlInputs: number[];
  filters: {
    node: number;
    input: number;
    control: number;
    resistance: number;
    capacitors: number[];
  }[];
  adders: {
    node: number;
    inputs: number[];
  }[];
  mixers: {
    node: number;
    inputs: number[];
    resistances: number[];
  }[];
  outputs: {
    node: number;
    gain: number;
  }[];
  source: { file: string; line: number; netlist: string };
}

/** A non-primary sound stream routed into the generated browser mixer. */
export interface GeneratedAuxiliaryAudioDevice {
  type: string;
  deviceTag: string;
  member?: string;
  clock: number;
  initialMode?: string;
  gain: number;
  target: string;
  targetInput?: number;
  writeMethods: string[];
}
