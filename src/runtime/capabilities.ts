/**
 * Browser runtime capabilities consumed by the MAME compiler's gap report.
 *
 * These names are MAME device types, not a second machine description. The
 * table says which reusable execution primitives exist in src/runtime.
 */

export const RUNTIME_CPU_TYPES = new Set([
  'z80', 'konami1', 'i8039', 'i8080', 'm6803', 'mc6809', 'mc6809e', 'rp2a03',
]);

export const RUNTIME_DEVICE_TYPES = new Set([
  'AY8910',
  'ER2055',
  'GALAXIAN_SOUND',
  'INVADERS_AUDIO',
  'LS259',
  'MB14241',
  'MSM5205',
  'NAMCO',
  'NAMCO_06XX',
  'NAMCO_51XX',
  'NAMCO_53XX',
  'NAMCO_54XX',
  'NAMCO_WSG',
  'NES_CART_SLOT',
  'NES_PPU',
  'RP2A03',
  'RP2A03G',
  'STARFIELD_05XX',
  'YM2203',
]);

export const DECLARATIVE_DEVICE_TYPES = new Set([
  'DISCRETE',
  'GENERIC_LATCH_8',
  'GFXDECODE',
  'PALETTE',
  'SCREEN',
  'SOFTWARE_LIST',
  'SPEAKER',
  'WATCHDOG_TIMER',
]);

export const GENERIC_HANDLER_PREFIXES = ['port.', 'bank.', 'watchdog.'];
