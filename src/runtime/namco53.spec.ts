// Self-test for the Namco 53xx I/O HLE. Run with: node src/runtime/namco53.spec.ts
// Ground truth: MAME 0.121 namcoio_53XX_digdug_read — successive reads return
// READ_PORT(0)|READ_PORT(1)<<4 then READ_PORT(2)|READ_PORT(3)<<4, i.e. the two
// DIP-switch bytes (DSWA, DSWB) reassembled from their nibble callbacks.

import { Namco53 } from './namco53.ts';

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
    else { console.log(`FAIL  ${sectionName} (${sectionFail} failing checks)`); failedSections.push(sectionName); }
  }
  sectionName = '';
}
function eq(label: string, actual: number, expected: number): void {
  if (actual === expected) totalPass++;
  else { totalFail++; sectionFail++; console.log(`  FAIL ${sectionName}: ${label}: got ${actual}, want ${expected}`); }
}

// DSWA = 0x35 (lo 0x5, hi 0x3), DSWB = 0xc2 (lo 0x2, hi 0xc)
let dswa = 0x35;
let dswb = 0xc2;
const chip = new Namco53({
  in: [() => dswa & 0x0f, () => (dswa >> 4) & 0x0f, () => dswb & 0x0f, () => (dswb >> 4) & 0x0f],
});

section('alternates DSWA / DSWB on successive reads');
{
  eq('read 0 -> DSWA', chip.read(), 0x35);
  eq('read 1 -> DSWB', chip.read(), 0xc2);
  eq('read 2 -> DSWA again', chip.read(), 0x35);
  eq('read 3 -> DSWB again', chip.read(), 0xc2);
}

section('reflects live input values');
{
  dswa = 0x80;
  dswb = 0x0f;
  // counter is at an even index (4 reads done) -> next read is DSWA
  eq('read -> new DSWA', chip.read(), 0x80);
  eq('read -> new DSWB', chip.read(), 0x0f);
}

section('reset realigns to DSWA');
{
  chip.read(); // advance to odd phase
  chip.reset();
  dswa = 0x11;
  dswb = 0x22;
  eq('after reset, read 0 -> DSWA', chip.read(), 0x11);
  eq('read 1 -> DSWB', chip.read(), 0x22);
}

section('masks callback nibbles to 4 bits');
{
  chip.reset();
  const noisy = new Namco53({ in: [() => 0xf5, () => 0xf3, () => 0x00, () => 0x00] });
  eq('high bits of callbacks ignored', noisy.read(), 0x35);
}

endSection();
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`${totalFail} FAILURES out of ${totalPass + totalFail} checks`);
  process.exitCode = 1;
}
