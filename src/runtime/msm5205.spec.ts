// Self-test for the MSM5205 ADPCM decoder. Run with: node src/runtime/msm5205.spec.ts
// Hand-computed expectations from MAME msm5205.cpp's compute_tables():
//   step 0: stepval=16, diff(nibble 2)=8+2=10, diff(4)=16+2=18
//   step 2: stepval=19, diff(15)=-(19+9+4+2)=-34
//   index_shift = [-1,-1,-1,-1, 2,4,6,8]

import { MSM5205 } from './msm5205.ts';

let sectionName = '';
let sectionFail = 0;
let totalPass = 0;
let totalFail = 0;
const failedSections: string[] = [];

function section(name: string): void {
  endSection();
  sectionName = name;
  sectionFail = 0;
}

function endSection(): void {
  if (sectionName !== '') {
    if (sectionFail === 0) console.log(`PASS  ${sectionName}`);
    else {
      console.log(`FAIL  ${sectionName} (${sectionFail} failing checks)`);
      failedSections.push(sectionName);
    }
  }
  sectionName = '';
}

function eq(label: string, actual: number | boolean, expected: number | boolean): void {
  if (actual === expected) {
    totalPass++;
  } else {
    totalFail++;
    sectionFail++;
    console.log(`  FAIL ${sectionName}: ${label}: got ${actual}, want ${expected}`);
  }
}

const CLOCK = 384000;

// ================================================================ decode against hand-computed table

section('step-table decode (tick-driven, S96_4B)');
{
  const chip = new MSM5205(CLOCK);
  chip.setPrescaler(4); // /96, 4-bit
  const edges: number[] = [];
  chip.vckCallback = (s) => edges.push(s);
  chip.dataW(2);
  chip.tick(96); // rise @48, fall @96 -> decode nibble 2
  eq('nibble 2 at step 0: signal +10', chip.signal, 10);
  eq('step index clamps at 0 (shift -1)', chip.step, 0);
  chip.dataW(4);
  chip.tick(96);
  eq('nibble 4: signal 10+18=28', chip.signal, 28);
  eq('step index += 2', chip.step, 2);
  chip.dataW(15);
  chip.tick(96);
  eq('nibble 15 at step 2: signal 28-34=-6', chip.signal, -6);
  eq('step index 2+8=10', chip.step, 10);
  eq('vck edges fired (3 cycles = 6 edges)', edges.length, 6);
  eq('edge pattern ends on fall', edges[edges.length - 1], 0);
  eq('edge pattern starts with rise', edges[0], 1);
  // externally clocked: render is a zero-order hold of the DAC level
  const out = new Float32Array(4);
  chip.render(out);
  eq('render holds DAC level (-6 & ~3 = -8)', out[0], -8 / 4096);
  eq('render hold is constant', out[3], out[0]);
}

// ================================================================ reset behavior

section('reset pin');
{
  const chip = new MSM5205(CLOCK);
  chip.setPrescaler(4);
  chip.dataW(7);
  chip.tick(96);
  eq('pre-reset signal', chip.signal, 30); // 16+8+4+2
  chip.resetW(1);
  chip.dataW(7);
  chip.tick(96); // capture while reset -> zeroed
  eq('reset zeroes signal', chip.signal, 0);
  eq('reset zeroes step', chip.step, 0);
  chip.tick(96);
  eq('held reset stays zero', chip.signal, 0);
  chip.resetW(0);
  chip.dataW(2);
  chip.tick(96);
  eq('decode resumes from step 0 after reset', chip.signal, 10);
}

// ================================================================ prescaler rates

section('prescaler selectors');
{
  const falls = (sel: number): number => {
    const chip = new MSM5205(CLOCK);
    chip.setPrescaler(sel);
    let n = 0;
    chip.vckCallback = (s) => {
      if (s === 0) n++;
    };
    chip.tick(CLOCK); // one second of master clock
    return n;
  };
  eq('S96_4B -> 4000 Hz VCK', falls(4), 4000);
  eq('S48_4B -> 8000 Hz VCK', falls(5), 8000);
  eq('S64_4B -> 6000 Hz VCK', falls(6), 6000);
  eq('SEX_4B (slave) -> no self-clock', falls(7), 0);
}

// ================================================================ 3-bit + slave mode

section('3-bit mode and slave vclkW');
{
  const chip = new MSM5205(CLOCK);
  chip.setPrescaler(0); // S96_3B
  chip.dataW(0x07); // 3-bit: latched as nibble (7<<1)=14 -> diff -(16+8+2) = -26
  chip.tick(96);
  eq('3-bit data decodes as nibble<<1', chip.signal, -26);
}
{
  const chip = new MSM5205(CLOCK);
  chip.setPrescaler(7); // slave, 4-bit
  chip.dataW(5); // diff(5) = 16+4+2 = 22
  chip.vclkW(1);
  chip.vclkW(0); // falling edge decodes
  eq('slave mode decodes on vclkW fall', chip.signal, 22);
  chip.vclkW(1);
  eq('no decode on rise', chip.signal, 22);
}

// ================================================================ render self-clocking (FIFO mode)

section('render self-clocking at master-clock sample rate');
{
  const chip = new MSM5205(CLOCK); // default S96_4B equivalent, never tick()ed
  eq('sampleRate is the master clock', chip.sampleRate, CLOCK);
  chip.write(0, 2); // SoundCore shim -> dataW(2)
  chip.dataW(4);
  const out = new Float32Array(288); // 3 VCK periods
  chip.render(out);
  eq('silent before first VCK fall', out[0], 0);
  eq('first nibble decoded after 1 period', out[100], 8 / 4096); // 10 & ~3
  eq('second nibble after 2 periods', out[200], 28 / 4096);
  const hold = new Float32Array(96);
  chip.render(hold); // FIFO empty -> hold
  eq('FIFO underrun holds level', hold[95], 28 / 4096);
  eq('underrun does not drift the decoder', chip.signal, 28);
}

// ================================================================ bounds + determinism

section('output bounds and determinism');
{
  const feed = (chip: MSM5205): void => {
    chip.setPrescaler(4);
    let seed = 12345;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      chip.dataW((seed >> 16) & 15);
      chip.tick(96);
    }
  };
  const a = new MSM5205(CLOCK);
  const b = new MSM5205(CLOCK);
  feed(a);
  feed(b);
  eq('identical input -> identical signal', a.signal, b.signal);
  eq('identical input -> identical step', a.step, b.step);
  eq('signal stays in 12-bit range', a.signal <= 2047 && a.signal >= -2048, true);
  const out = new Float32Array(16);
  a.render(out);
  let maxAbs = 0;
  for (const v of out) maxAbs = Math.max(maxAbs, Math.abs(v));
  eq('render bounded to +/-0.5', maxAbs <= 0.5, true);
}
{
  const chip = new MSM5205(CLOCK);
  chip.setPrescaler(4);
  for (let i = 0; i < 60; i++) {
    chip.dataW(7); // max positive delta every cycle
    chip.tick(96);
  }
  eq('signal clamps at +2047', chip.signal, 2047);
  eq('step clamps at 48', chip.step, 48);
}

// ================================================================ summary

endSection();
console.log('');
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`${totalFail} FAILURES out of ${totalPass + totalFail} checks`);
  console.log('Failing sections: ' + failedSections.join(', '));
  process.exitCode = 1;
}
