// Self-test for the console-aware parser extensions. Run with:
//   node src/kg/parse.spec.ts
// Covers: CONS/SYST/COMP game rows (the SYST macro family has a COMPAT field
// and no MONITOR), SOFTWARE_LIST config declarations, the console screen
// setter trio (set_refresh_hz/set_size/set_visarea), and slot-device default
// option capture — plus a GAME-row regression so the arcade path can't drift.

import { parseGames, parseMachineConfigs, parseDefines, parseAddressMaps } from './parse.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    totalPass++;
  } else {
    totalFail++;
    console.log(`  FAIL ${label}: got ${a}, want ${e}`);
  }
}

// --- CONS row (nes.cpp:775) --------------------------------------------------
{
  const src = `
CONS( 1985, nes, 0, 0, nes, nes, nes_state, empty_init, "Nintendo", "Nintendo Entertainment System / Famicom (NTSC)", MACHINE_IMPERFECT_GRAPHICS | MACHINE_SUPPORTS_SAVE )
CONS( 1983, famicom, 0, nes, famicom, famicom, nes_state, init_famicom, "Nintendo", "Famicom", MACHINE_IMPERFECT_GRAPHICS | MACHINE_SUPPORTS_SAVE )
`;
  const games = parseGames(src);
  eq('cons count', games.length, 2);
  const nes = games[0];
  eq('cons kind', nes.kind, 'console');
  eq('cons name', nes.name, 'nes');
  eq('cons parent', nes.parent, '0');
  eq('cons compat', nes.compat, '0');
  eq('cons machine', nes.machine, 'nes');
  eq('cons input', nes.input, 'nes');
  eq('cons cls', nes.cls, 'nes_state');
  eq('cons init', nes.init, 'empty_init');
  eq('cons monitor implied ROT0', nes.monitor, 'ROT0');
  eq('cons company', nes.company, 'Nintendo');
  eq('cons flags', nes.flags, 'MACHINE_IMPERFECT_GRAPHICS | MACHINE_SUPPORTS_SAVE');
  const fam = games[1];
  eq('famicom compat group', fam.compat, 'nes');
  eq('famicom machine', fam.machine, 'famicom');
  eq('famicom init', fam.init, 'init_famicom');
}

// --- "19??" year rows parse (question-mark years occur in console lists) -----
{
  const games = parseGames(`CONS( 198?, mysys, 0, 0, mysys, mysys, my_state, empty_init, "Acme", "Mystery", 0 )`);
  eq('?-year row parses', games.length, 1);
  eq('?-year value', games[0]?.year, '198?');
}

// --- GAME row regression (galaga.cpp shape must not drift) --------------------
{
  const src = `GAME( 1981, galaga, 0, galaga, galaga, galaga_state, init_galaga, ROT90, "Namco", "Galaga (Namco rev. B)", MACHINE_SUPPORTS_SAVE )`;
  const [gm] = parseGames(src);
  eq('game kind', gm.kind, 'arcade');
  eq('game compat', gm.compat, '0');
  eq('game monitor', gm.monitor, 'ROT90');
  eq('game machine', gm.machine, 'galaga');
  eq('game company', gm.company, 'Namco');
}

// --- machine config: SOFTWARE_LIST + screen setters + slot defaults ----------
{
  const body = `
void nes_state::nes(machine_config &config)
{
	rp2a03_device &maincpu(RP2A03G(config, m_maincpu, NTSC_APU_CLOCK));
	maincpu.set_addrmap(AS_PROGRAM, &nes_state::nes_map);
	maincpu.add_route(0, "mono", 0.60);

	SCREEN(config, m_screen, SCREEN_TYPE_RASTER);
	m_screen->set_video_attributes(VIDEO_UPDATE_SCANLINE);
	m_screen->set_refresh_hz(60.0988);
	m_screen->set_size(32*8, 262);
	m_screen->set_visarea(0*8, 32*8-1, 0*8, 30*8-1);

	NES_CONTROL_PORT(config, m_ctrl1, nes_control_port1_devices, "joypad").set_screen_tag(m_screen);
	NES_CONTROL_PORT(config, m_special, nes_control_special_devices, nullptr).set_screen_tag(m_screen);
	NES_CART_SLOT(config, m_cartslot, NTSC_APU_CLOCK, nes_cart, nullptr).set_must_be_loaded(true);

	SOFTWARE_LIST(config, "cart_list").set_original("nes").set_filter("!EXP");
	SOFTWARE_LIST(config, "famibox_list").set_compatible("famibox");
}
`;
  const memberTags = {
    m_maincpu: 'maincpu', m_screen: 'screen', m_ctrl1: 'ctrl1',
    m_special: 'special', m_cartslot: 'nes_slot',
  };
  const consts = parseDefines('#define NTSC_APU_CLOCK (XTAL(21\'477\'272)/12)');
  const [cfg] = parseMachineConfigs(body, memberTags, consts);

  eq('softlist count', cfg.softwareLists.length, 2);
  eq('softlist original', cfg.softwareLists[0],
    { tag: 'cart_list', name: 'nes', status: 'original', filter: '!EXP' });
  eq('softlist compatible', cfg.softwareLists[1],
    { tag: 'famibox_list', name: 'famibox', status: 'compatible' });
  eq('softlist not a device', cfg.devices.some(d => d.type === 'SOFTWARE_LIST'), false);

  const cpu = cfg.devices.find(d => d.tag === 'maincpu')!;
  eq('cpu clock from external define', Math.round(cpu.clock!), Math.round(21477272 / 12));
  eq('audio route', cpu.audioRoutes, [{
    output: '0', target: 'mono', gain: 0.6, raw: 'maincpu.add_route(0, "mono", 0.60)',
  }]);

  const screen = cfg.devices.find(d => d.tag === 'screen')!;
  eq('screen refresh hz', screen.screenRefreshHz, 60.0988);
  eq('screen size (32*8 arithmetic)', screen.screenSize, { w: 256, h: 262 });
  eq('screen visarea', screen.screenVisarea, { x0: 0, x1: 255, y0: 0, y1: 239 });
  eq('screen video attributes', screen.screenVideoAttributes, ['VIDEO_UPDATE_SCANLINE']);

  const ctrl1 = cfg.devices.find(d => d.tag === 'ctrl1')!;
  eq('slot options table', ctrl1.slotOptions, 'nes_control_port1_devices');
  eq('slot default option', ctrl1.slotDefault, 'joypad');
  const special = cfg.devices.find(d => d.tag === 'special')!;
  eq('nullptr default not captured', special.slotDefault, undefined);
  const cart = cfg.devices.find(d => d.tag === 'nes_slot')!;
  eq('cart slot not mistaken for options slot', cart.slotOptions, undefined);
}

// --- parseDefines seeding (externals first, local wins) ----------------------
{
  const seeded = parseDefines('#define LOCAL (BASE*2)\n#define BASE 7', { BASE: 3 });
  eq('seeded constant resolves', seeded.LOCAL, 6);   // uses seed BASE=3 at eval time
  eq('local redefinition wins', seeded.BASE, 7);
}

// --- MAME inline address-map lambdas become named generated handlers ---------
{
  const [map] = parseAddressMaps(`
void timeplt_state::main_map(address_map &map)
{
  map(0xc300, 0xc30f).lw8(NAME([this](offs_t offset, u8 data) {
    m_mainlatch->write_d0(offset >> 1, data);
  }));
}
`);
  const handler = map.ranges[0]?.write;
  eq('lw8 inline handler name', handler?.method, '__inline_main_map_c300_lw8');
  eq('lw8 inline parameters', handler?.inlineParameters, 'offs_t offset, u8 data');
  eq('lw8 inline body', handler?.inlineBody, 'm_mainlatch->write_d0(offset >> 1, data);');
}

console.log(`\nparse.spec: ${totalPass} passed, ${totalFail} failed`);
if (totalFail > 0) process.exitCode = 1;
