import {
  MameAstIndex,
  maskComments,
  parseMameAst,
  parseMameSource,
} from './ast.ts';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

const source = `// license:BSD-3-Clause
/* preserve
   these lines */
void timeplt_state::timeplt(machine_config &config)
{
  Z80(config, m_maincpu, MASTER_CLOCK / 3 / 2);
  m_mainlatch->q_out_cb<0>().set(FUNC(timeplt_state::nmi_enable_w));
  m_mainlatch->q_out_cb<1>().set(FUNC(timeplt_state::flip_screen_set)).invert();
  m_screen->screen_vblank().append("51xx", FUNC(namco_51xx_device::vblank));
}

ROM_START( timeplt )
  ROM_REGION( 0x10000, "maincpu", 0 )
ROM_END

GAME( 1982, timeplt, 0, timeplt, timeplt, timeplt_state, empty_init, ROT90,
      "Konami", "Time Pilot", MACHINE_SUPPORTS_SAVE )
`;

const masked = maskComments(source);
check('comment masking preserves length', masked.length, source.length);
check('comment masking preserves line count', masked.split('\n').length, source.split('\n').length);
check('comments are removed', masked.includes('preserve'), false);

const unit = parseMameSource('src/mame/konami/timeplt.cpp', source);
check('function count', unit.functions.length, 1);
check('function identity', [unit.functions[0].className, unit.functions[0].name],
  ['timeplt_state', 'timeplt']);
check('statement count', unit.functions[0].statements.length, 4);
check('callback chain', unit.functions[0].statements[2].calls.map(c => [
  c.name, c.templateArgs, c.args,
]), [
  ['q_out_cb', ['1'], []],
  ['set', [], ['FUNC(timeplt_state::flip_screen_set)']],
  ['invert', [], []],
]);
check('statement source line', unit.functions[0].statements[1].span.line, 7);

const index = new MameAstIndex(parseMameAst([{ file: unit.file, source }]));
check('find game macro', index.findAnyMacro(['GAME', 'CONS'], 1, 'timeplt')?.span.line, 16);
check('find rom macro', index.findMacro('ROM_START', 0, 'timeplt')?.span.line, 12);
check('find function', index.findFunction('timeplt_state', 'timeplt')?.span.line, 4);
check('find normalized statement',
  index.findStatement('m_mainlatch -> q_out_cb<0>() . set(FUNC(timeplt_state::nmi_enable_w))')?.span.line,
  7);

const hierarchy = new MameAstIndex(parseMameAst([
  {
    file: 'base.cpp',
    source: 'void base_state::bankselect_w(uint8_t data) { m_bank = data; }',
  },
  {
    file: 'derived.cpp',
    source: 'class derived_state : public base_state { };',
  },
]));
check('class base parsed', hierarchy.ast.units[1].classes[0]?.bases, ['base_state']);
check('inherited function resolved',
  hierarchy.findFunctionInHierarchy('derived_state', 'bankselect_w')?.className,
  'base_state');

const memberMacros = parseMameSource('timer.cpp', `
TIMER_CALLBACK_MEMBER(test_state::scanline_tick)
{
  int scanline = param;
  m_timer->adjust(m_screen->time_until_pos(scanline), scanline);
}
IRQ_CALLBACK_MEMBER(test_state::interrupt_vector)
{
  return 0xcf;
}
`);
check('timer callback member parsed',
  [memberMacros.functions[0]?.className, memberMacros.functions[0]?.name, memberMacros.functions[0]?.parameters],
  ['test_state', 'scanline_tick', 'int param']);
check('IRQ callback member parsed', memberMacros.functions[1]?.name, 'interrupt_vector');

console.log(`ast.spec: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
