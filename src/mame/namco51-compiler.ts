import type { GeneratedDeviceDefinition } from './device-compiler.ts';
import { compileMameHandler } from './handler-ir.ts';
import { normalizeMameExecutionSource } from './cpu-compiler.ts';

const SOURCE_FILE = 'src/mame/machine/namcoio.c@adffaf795b6^';

/**
 * Lower MAME's historical 51XX high-level protocol into executable device IR.
 * Current MAME uses the dumped MB8843 firmware; this remains the source-backed
 * fallback when the separately distributed 51xx.bin device ROM is unavailable.
 */
export function compileNamco51Protocol(): GeneratedDeviceDefinition {
  const method = (name: string, parameters: string, source: string) => ({
    name,
    parameters,
    program: compileMameHandler(normalizeMameExecutionSource(source)),
    source: { file: SOURCE_FILE, line: 187 },
  });
  const methods = [
    method('device_reset', '', `
      m_mode = 0;
      m_coincred_mode = 0;
      m_remap_joy = 0;
      m_credits = 0;
      m_coins[0] = 0;
      m_coins[1] = 0;
      m_coins_per_cred[0] = 1;
      m_coins_per_cred[1] = 1;
      m_creds_per_coin[0] = 1;
      m_creds_per_coin[1] = 1;
      m_in_count = 0;
      m_lastcoins = 0;
      m_lastbuttons = 0;
    `),
    method('reset', 'int state', `if (!state) device_reset();`),
    method('vblank', 'int state', ''),
    method('rw', 'int state', ''),
    method('chip_select', 'int state', ''),
    method('write', 'uint8_t data', `
      data &= 0x07;
      if (m_coincred_mode) {
        switch (m_coincred_mode--) {
          case 4: m_coins_per_cred[0] = data; break;
          case 3: m_creds_per_coin[0] = data; break;
          case 2: m_coins_per_cred[1] = data; break;
          case 1: m_creds_per_coin[1] = data; break;
        }
      } else {
        switch (data) {
          case 1: m_coincred_mode = 4; m_credits = 0; break;
          case 2: m_mode = 1; m_in_count = 0; break;
          case 3: m_remap_joy = 0; break;
          case 4: m_remap_joy = 1; break;
          case 5: m_mode = 0; m_in_count = 0; break;
          default: break;
        }
      }
    `),
    method('switches', '', `
      return (m_input_callback[2]() & 0x0f) |
        ((m_input_callback[3]() & 0x0f) << 4);
    `),
    method('credit', '', `
      int in = ~switches() & 0xff;
      int toggle = in ^ m_lastcoins;
      m_lastcoins = in;
      if (m_coins_per_cred[0] > 0) {
        if (m_credits >= 99) {
          m_lockout_callback(1);
        } else {
          m_lockout_callback(0);
          if (toggle & in & 0x10) {
            m_coins[0]++;
            m_output_callback(0x04);
            m_output_callback(0x0c);
            if (m_coins[0] >= m_coins_per_cred[0]) {
              m_credits += m_creds_per_coin[0];
              m_coins[0] -= m_coins_per_cred[0];
            }
          }
          if (toggle & in & 0x20) {
            m_coins[1]++;
            m_output_callback(0x08);
            m_output_callback(0x0c);
            if (m_coins[1] >= m_coins_per_cred[1]) {
              m_credits += m_creds_per_coin[1];
              m_coins[1] -= m_coins_per_cred[1];
            }
          }
          if (toggle & in & 0x40) m_credits++;
        }
      } else {
        m_credits = 100;
      }
      if (m_mode == 1) {
        if (toggle & in & 0x04) {
          if (m_credits >= 1) { m_credits--; m_mode = 2; }
        } else if (toggle & in & 0x08) {
          if (m_credits >= 2) { m_credits -= 2; m_mode = 2; }
        }
      }
      if (in & 0x80) return 0xbb;
      return (m_credits / 10) * 16 + m_credits % 10;
    `),
    method('player', 'int player', `
      int joy = m_input_callback[player]() & 0x0f;
      int in = ~switches() & 0xff;
      int button = player == 0 ? 1 : 2;
      int toggle = in ^ m_lastbuttons;
      m_lastbuttons = (m_lastbuttons & ~button) | (in & button);
      if (m_remap_joy) joy = m_joy_map[joy];
      if (player == 0) {
        joy |= ((toggle & in & 0x01) ^ 1) << 4;
        joy |= ((in & 0x01) ^ 1) << 5;
      } else {
        joy |= ((toggle & in & 0x02) ^ 2) << 3;
        joy |= ((in & 0x02) ^ 2) << 4;
      }
      return joy;
    `),
    method('read', '', `
      int phase = m_in_count++ % 3;
      if (m_mode == 0) {
        if (phase == 0) return switches();
        if (phase == 1) return (m_input_callback[0]() & 0x0f) |
          ((m_input_callback[1]() & 0x0f) << 4);
        return 0;
      }
      if (phase == 0) return credit();
      if (phase == 1) return player(0);
      return player(1);
    `),
  ];
  const diagnostics = methods.reduce(
    (count, candidate) => count + candidate.program.diagnostics.length,
    0,
  );
  return {
    schemaVersion: 1,
    type: 'NAMCO_51XX',
    className: 'namco_51xx_device',
    hierarchy: ['namco_51xx_device'],
    sourceFiles: [SOURCE_FILE, 'src/mame/namco/namco51.cpp'],
    constants: {},
    members: [
      ...[
        'm_mode', 'm_coincred_mode', 'm_remap_joy', 'm_credits', 'm_in_count',
        'm_lastcoins', 'm_lastbuttons',
      ].map(name => ({ name, valueType: 'int', bits: 32 as const })),
      { name: 'm_coins', valueType: 'int[2]', bits: 32, values: [0, 0] },
      { name: 'm_coins_per_cred', valueType: 'int[2]', bits: 32, values: [1, 1] },
      { name: 'm_creds_per_coin', valueType: 'int[2]', bits: 32, values: [1, 1] },
      {
        name: 'm_joy_map',
        valueType: 'const int[16]',
        bits: 32,
        values: [0xf, 0xe, 0xd, 0x5, 0xc, 0x9, 0x7, 0x6, 0xb, 0x3, 0xa, 0x4, 1, 2, 0, 8],
      },
    ],
    callbacks: [
      { signal: 'input_callback', member: 'm_input_callback', slots: 4, initial: 0x0f },
      { signal: 'output_callback', member: 'm_output_callback', slots: 1, initial: 0 },
      { signal: 'lockout_callback', member: 'm_lockout_callback', slots: 1, initial: 0 },
    ],
    timers: [],
    methods,
    reset: 'device_reset',
    summary: {
      methods: methods.length,
      compiledMethods: methods.filter(candidate => !candidate.program.diagnostics.length).length,
      diagnostics,
    },
  };
}
