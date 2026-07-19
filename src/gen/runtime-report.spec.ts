import { buildRuntimeReport, runtimeReportMarkdown } from './runtime-report.ts';
import type { KnowledgeGraph } from '../kg/types.ts';

const graph: KnowledgeGraph = {
  meta: {
    tool: 'mamekit', version: 'test', mameSrc: '', driverFile: 'driver.cpp',
    generatedAt: '',
  },
  nodes: [
    { id: 'game:test', label: 'Game', props: { sourceFile: 'driver.cpp', sourceLine: 1 } },
    { id: 'device:test/maincpu', label: 'Device', props: { tag: 'maincpu', type: 'Z80' } },
    { id: 'device:test/latch', label: 'Device', props: { tag: 'latch', type: 'LS259' } },
    { id: 'map:test/range0', label: 'AddressRange', props: {
      raw: 'map(0xc300, 0xc30f).lw8(NAME([] {}))',
      sourceFile: 'driver.cpp',
      sourceLine: 20,
    } },
    { id: 'callback:test', label: 'Callback', props: {
      ownerTag: 'latch', signal: 'q_out_cb', slot: '0',
      targetClass: 'test_state', targetMethod: 'irq_w',
    } },
    { id: 'handler:test_state:read', label: 'Handler', props: {
      ownerClass: 'test_state',
      method: 'read',
      sourceBody: 'return 0xbf;',
      sourceFile: 'driver.cpp',
      sourceLine: 30,
    } },
  ],
  edges: [],
};

const report = buildRuntimeReport(graph, {
  game: 'test',
  family: 'pacman',
  board: {
    cpus: [{
      tag: 'maincpu',
      type: 'z80',
      ranges: [
        { kind: 'handler', read: 'port.IN0' },
        { kind: 'handler', write: 'latch.write_d0' },
        { kind: 'handler', write: 'test_state.video_w' },
        { kind: 'handler', read: 'test_state.read' },
      ],
    }],
    ranges: [],
  },
}, {
  hardware: [
    {
      type: 'Z80',
      status: 'source-resolved',
      executable: true,
      executableKind: 'cpu',
      executableArtifact: 'devices/z80.cpu.ir.json',
      definition: { sourceFile: 'src/devices/cpu/z80/z80.cpp', sourceLine: 1 },
    },
    {
      type: 'LS259',
      status: 'source-resolved',
      executable: true,
      executableKind: 'device',
      executableArtifact: 'devices/ls259.device.ir.json',
      definition: { sourceFile: 'src/devices/machine/74259.cpp', sourceLine: 1 },
    },
  ],
});

if (report.requirements.handlers.find(h => h.name === 'port.IN0')?.status !== 'generated') {
  throw new Error('port handler should be generated');
}
if (report.requirements.handlers.find(h => h.name === 'latch.write_d0')?.status !== 'executable') {
  throw new Error('LS259 handler should resolve to generated executable hardware');
}
if (report.requirements.handlers.find(h => h.name === 'test_state.video_w')?.status !== 'missing') {
  throw new Error('uncompiled driver-state handler should remain a generation gap');
}
if (report.requirements.handlers.find(h => h.name === 'test_state.read')?.status !== 'generated') {
  throw new Error('compiled driver-state handler should be generated');
}
if (report.handlerCompiler.usedCompiledHandlers !== 1) {
  throw new Error('compiled address-map handlers should be counted');
}
if (report.parserGaps[0]?.construct !== 'lw8') throw new Error('lw8 parser gap should be reported');
if (report.requirements.callbacks.length !== 1) throw new Error('callback wiring should be reported');
if (report.boardMode !== 'generated') {
  throw new Error('board composition should be generated');
}
if (report.requirements.composition[0]?.status !== 'generated') {
  throw new Error('board composition should not depend on family code');
}
const markdown = runtimeReportMarkdown(report);
if (markdown.includes('handwritten') || markdown.includes('Runtime primitives')) {
  throw new Error('report should only describe source-generation stages');
}

console.log('runtime-report.spec: 10 passed, 0 failed');
