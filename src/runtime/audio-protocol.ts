/** Register-space extension used between generated boards and AY worklets. */
export const AY_FILTER_CONTROL_BASE = 0x100;
export const AY_FILTER_CONTROL_STRIDE = 5;

/** Source-derived DAC/filter network mixed alongside a primary sound core. */
export interface GeneratedDacFilterPlan {
  type: 'DAC_FILTER';
  channels: {
    input: number;
    frequency: number;
    q: number;
    gain: number;
  }[];
  outputGain: number;
  source: { file: string; line: number; netlist: string };
}
