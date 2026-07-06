// Self-test for the MB14241 shifter. Run with: node src/runtime/mb14241.spec.ts
// Behavior reference: MAME src/devices/machine/mb14241.cpp.
// After writes A then B, shift_result(n) = ((B<<8 | A) >> (8 - n)) & 0xff
// where n is the written count (stored internally as ~n & 7).

import { MB14241 } from './mb14241.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: number, expected: number): void {
  if (actual === expected) {
    totalPass++;
  } else {
    totalFail++;
    console.log(
      `  FAIL ${label}: got 0x${actual.toString(16)}, want 0x${expected.toString(16)}`
    );
  }
}

// fresh chip reads zero
{
  const s = new MB14241();
  eq('fresh result', s.shiftResultR(), 0x00);
}

// single write, count 0 returns the byte just written
{
  const s = new MB14241();
  s.shiftDataW(0xaa);
  s.shiftCountW(0);
  eq('single write, n=0', s.shiftResultR(), 0xaa);
}

// all 8 shift positions over the packed word (B<<8 | A)
{
  const s = new MB14241();
  s.shiftDataW(0xaa); // A (older)
  s.shiftDataW(0x55); // B (newer)
  for (let n = 0; n < 8; n++) {
    s.shiftCountW(n);
    eq(`shift n=${n}`, s.shiftResultR(), (0x55aa >> (8 - n)) & 0xff);
  }
}

// data pipeline: a third write pushes the oldest byte out
{
  const s = new MB14241();
  s.shiftDataW(0xaa);
  s.shiftDataW(0x55);
  s.shiftDataW(0xff); // word is now (0xff << 8) | 0x55
  s.shiftCountW(0);
  eq('pipeline n=0 (newest)', s.shiftResultR(), 0xff);
  s.shiftCountW(1);
  eq('pipeline n=1', s.shiftResultR(), (0xff55 >> 7) & 0xff);
  s.shiftCountW(7);
  eq('pipeline n=7', s.shiftResultR(), (0xff55 >> 1) & 0xff);
}

// count register masks to 3 bits (high bits of the write are ignored)
{
  const s = new MB14241();
  s.shiftDataW(0x12);
  s.shiftDataW(0x34);
  s.shiftCountW(0x05);
  const want = s.shiftResultR();
  s.shiftCountW(0xfd); // same low 3 bits
  eq('count masking (fd == 05)', s.shiftResultR(), want);
  s.shiftCountW(0xf8); // low bits 0
  s.shiftCountW(0x00);
  eq('count masking (f8 == 00)', s.shiftResultR(), (0x3412 >> 8) & 0xff);
}

// reset clears data and count
{
  const s = new MB14241();
  s.shiftDataW(0xff);
  s.shiftDataW(0xff);
  s.shiftCountW(7);
  s.reset();
  eq('reset result', s.shiftResultR(), 0x00);
  s.shiftDataW(0x80);
  s.shiftCountW(0);
  eq('post-reset behaves fresh', s.shiftResultR(), 0x80);
}

console.log('');
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`FAILURES: ${totalFail} of ${totalPass + totalFail} checks failed`);
  process.exitCode = 1;
}
