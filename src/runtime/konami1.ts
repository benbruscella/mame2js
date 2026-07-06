// KONAMI-1 CPU: an MC6809 with scrambled opcodes (Gyruss, Time Pilot,
// Roc'n Rope, ... sub/sprite CPUs).
//
// Ported from MAME src/mame/konami/konami1.cpp. The decryption applies to
// OPCODE FETCHES ONLY (mi_konami1::read_opcode, konami1.cpp lines 62-74);
// operands, data reads and vectors are NOT encrypted (they go through
// read/read_opcode_arg, which konami1.cpp does not override). Because
// MAME's m6809 core fetches the $10/$11 prefix bytes AND the opcode byte
// following them via read_opcode() (m6809.lst DISPATCH01/10/11), both
// bytes of a prefixed opcode are decrypted here too - M6809's opcodeFetch
// hook is called for exactly that set of bytes.
//
// The transform XORs the fetched byte based on address bits 1 and 3
// (konami1.cpp switch on `adr & 0xa`):
//   adr&0xa == 0x0 -> ^ 0x22
//   adr&0xa == 0x2 -> ^ 0x82
//   adr&0xa == 0x8 -> ^ 0x28
//   adr&0xa == 0xa -> ^ 0x88
// i.e. bit1 of the address moves the low-nibble XOR bit from 2 to 8's
// position in the high nibble, bit3 does the same for the low nibble.
// XOR is an involution, so the same function encrypts and decrypts.
//
// Fetches below the (rarely used) encryption boundary are passed through
// unchanged, matching konami1_device::set_encryption_boundary. Gyruss uses
// the default boundary of $0000 (everything encrypted).

import { M6809, type M6809Bus } from './m6809.ts';

/** The KONAMI-1 opcode transform (self-inverse: decrypts and encrypts). */
export function konami1Decrypt(addr: number, byte: number): number {
  switch (addr & 0x0a) {
    case 0x0: return byte ^ 0x22;
    case 0x2: return byte ^ 0x82;
    case 0x8: return byte ^ 0x28;
    default: return byte ^ 0x88; // 0xa
  }
}

export class Konami1 extends M6809 {
  constructor(bus: M6809Bus, encryptionBoundary = 0x0000) {
    super(bus, {
      opcodeFetch: (addr, byte) =>
        addr < encryptionBoundary ? byte : konami1Decrypt(addr, byte),
    });
  }
}
