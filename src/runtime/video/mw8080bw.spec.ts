// Spec for the Midway 8080 B&W bitmap renderer. Plain node script.
import { Mw8080bwVideo } from './mw8080bw.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const ram = new Uint8Array(0x2000);
const video = new Mw8080bwVideo({ mainRam: ram });
const fb = new Uint32Array(video.width * video.height);

const WHITE = 0xffffffff;
const px = (x: number, y: number) => fb[y * video.width + x];

// all-black baseline
video.render(fb);
check('blank ram renders all black', fb.every(v => v === 0xff000000));

// The shifter fetches ram[(y<<5)|(x>>3)] at x&7==4 and shifts LSB first, so
// byte at share offset 0x400 (address 0x2400, y-counter 0x20 = first row)
// bit0 appears at x=4 of screen line 0.
ram[0x400] = 0x01;
video.render(fb);
check('first ram byte bit0 -> pixel (4, 0)', px(4, 0) === WHITE);
check('pixel (5,0) stays black for bit0-only', px(5, 0) !== WHITE);

ram[0x400] = 0x80; // bit7 -> x = 4+7 = 11
video.render(fb);
check('bit7 -> pixel (11, 0)', px(11, 0) === WHITE && px(4, 0) !== WHITE);

// second byte of the row lands 8 pixels later
ram[0x400] = 0; ram[0x401] = 0x01;
video.render(fb);
check('second byte bit0 -> pixel (12, 0)', px(12, 0) === WHITE);

// row addressing: y screen line L reads offsets ((L+0x20)<<5)
ram.fill(0);
ram[((100 + 0x20) << 5) | 3] = 0x10; // bit4 of byte 3 -> x = 3*8+4+4 = 32
video.render(fb);
check('row 100 byte 3 bit4 -> pixel (32, 100)', px(32, 100) === WHITE);

// last byte of a line: bits 4-7 flush into the 4 extra pixels (256..259)
ram.fill(0);
ram[((0 + 0x20) << 5) | 31] = 0xf0;
video.render(fb);
check('line-end flush pixels 256-259 white', px(256, 0) === WHITE && px(259, 0) === WHITE);
check('flush does not wrap into next line', px(0, 1) !== WHITE);

// determinism
const a = fb.slice();
video.render(fb);
check('render deterministic', fb.every((v, i) => v === a[i]));

// full-screen smoke: alternating bytes produce equal white counts per line
ram.fill(0xaa);
video.render(fb);
let whites = 0;
for (const v of fb) if (v === WHITE) whites++;
// 32 bytes x 4 set bits per line = 128 (byte 31 splits its 4 whites between
// pixels 252-255 and the 4-pixel flush)
check('0xaa fill lights half the fetched pixels', whites === 224 * 128);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
