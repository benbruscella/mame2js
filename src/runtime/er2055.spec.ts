// Self-test for the ER2055 EAROM. Run with: node src/runtime/er2055.spec.ts
// Ground truth: MAME er2055.cpp (update_state / set_clk). Exercised through the
// exact Dig Dug control wiring (galaga.cpp earom_control_w):
//   set_control(BIT(d,3), 1, !BIT(d,1), BIT(d,2)); set_clk(BIT(d,0))

import { ER2055 } from './er2055.ts';

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

// Drive the earom exactly as the Dig Dug board does from a 0xb840 write.
function control(chip: ER2055, byte: number): void {
  chip.setControl((byte >> 3) & 1, 1, (byte >> 1) & 1 ? 0 : 1, (byte >> 2) & 1);
  chip.setClk(byte & 1);
}
const ERASE = 0x0e; // CS1=1, C2=1 (bit1=1 -> C1=0)  -> erase mode
const WRITE = 0x0a; // CS1=1, C2=0 (bit1=1 -> C1=0)  -> write mode
const READ0 = 0x08; // CS1=1, C1=1 (bit1=0), CK=0
const READ1 = 0x09; // same, CK=1

// store value V at address A: address+data latched via the data bus, then
// erase (-> 0xff) then write (AND) as real EAROM code must.
function store(chip: ER2055, addr: number, value: number): void {
  chip.setAddress(addr);
  chip.setData(value);
  control(chip, ERASE);
  control(chip, WRITE);
}
// read address A: latch on the falling CK edge in read mode, then data()
function load(chip: ER2055, addr: number): number {
  chip.setAddress(addr);
  control(chip, READ1);
  control(chip, READ0);
  return chip.read();
}

section('defaults to all-0xff');
{
  const chip = new ER2055();
  eq('byte 0', chip.data[0]!, 0xff);
  eq('byte 63', chip.data[0x3f]!, 0xff);
  eq('size', chip.data.length, 0x40);
}

section('erase-then-write stores a byte');
{
  const chip = new ER2055();
  store(chip, 0x05, 0x42);
  eq('data[5] stored', chip.data[0x05]!, 0x42);
  eq('read back latches rom[5]', load(chip, 0x05), 0x42);
  eq('untouched byte still 0xff', chip.data[0x06]!, 0xff);
}

section('write is an AND (erase required first)');
{
  const chip = new ER2055();
  // write 0x0f WITHOUT erasing (starts 0xff): 0xff & 0x0f = 0x0f
  chip.setAddress(0x10); chip.setData(0x0f); control(chip, WRITE);
  eq('first write 0xff & 0x0f', chip.data[0x10]!, 0x0f);
  // write 0xf0 without erase: 0x0f & 0xf0 = 0x00 (demonstrates AND behaviour).
  // A real second write deselects between ops so the control lines transition.
  control(chip, 0x00); // deselect (CS1 low): no-op, just clears the select
  chip.setAddress(0x10); chip.setData(0xf0); control(chip, WRITE);
  eq('second write ANDs to 0x00', chip.data[0x10]!, 0x00);
}

section('erase resets a byte to 0xff');
{
  const chip = new ER2055();
  store(chip, 0x20, 0x33);
  chip.setAddress(0x20); control(chip, ERASE);
  eq('erased byte', chip.data[0x20]!, 0xff);
}

section('onStore fires on write/erase only');
{
  const chip = new ER2055();
  let stores = 0;
  chip.onStore = () => { stores++; };
  load(chip, 0x00);            // read: no store
  eq('read does not store', stores, 0);
  store(chip, 0x01, 0x77);     // erase + write = 2 stores
  eq('erase+write = 2 stores', stores, 2);
}

section('data survives reset (non-volatile)');
{
  const chip = new ER2055();
  store(chip, 0x0a, 0x5a);
  chip.reset();
  eq('data kept after reset', chip.data[0x0a]!, 0x5a);
  eq('read still works post-reset', load(chip, 0x0a), 0x5a);
}

endSection();
if (totalFail === 0) {
  console.log(`ALL PASS: ${totalPass} checks`);
} else {
  console.log(`${totalFail} FAILURES out of ${totalPass + totalFail} checks`);
  process.exitCode = 1;
}
