import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GeneratedMachine } from '../runtime/generated-machine.ts';
import { REQUIRED_TARGETS } from './targets.ts';

export { REQUIRED_TARGETS } from './targets.ts';

export interface GeneratedAudit {
  targets: number;
  familyAdapters: number;
  callbacks: number;
  frameEvents: number;
  screenUpdates: number;
  sourceMapHandlers: number;
  executableHardware: number;
  failures: string[];
}

export function auditGenerated(outRoot: string): GeneratedAudit {
  const failures: string[] = [];
  let callbacks = 0;
  let frameEvents = 0;
  let screenUpdates = 0;
  let sourceMapHandlers = 0;
  let familyAdapters = 0;
  const registryPath = join(outRoot, 'app/modules/generated/registry.js');
  const registry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';
  if (!registry) failures.push('unified generated registry is missing');
  else if (!registry.includes('registerGeneratedBoard')) {
    failures.push('unified generated registry does not register board factories');
  }

  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const forbiddenHardwareCopies = [
    'ay8910', 'er2055', 'galaxian-sound', 'i8080', 'invaders-sound', 'konami1',
    'ls259', 'm6502', 'm6803', 'm6809', 'mb14241', 'mcs48', 'msm5205',
    'namco06', 'namco51', 'namco53', 'namco54', 'nes-apu', 'nes-cart',
    'starfield05xx', 'timeplt-audio', 'wsg', 'ym2203', 'z80',
  ];
  for (const name of forbiddenHardwareCopies) {
    if (existsSync(join(projectRoot, `src/runtime/${name}.ts`))) {
      failures.push(`handwritten MAME hardware copy remains: src/runtime/${name}.ts`);
    }
  }
  if (existsSync(join(projectRoot, 'src/runtime/capabilities.ts'))) {
    failures.push('handwritten runtime hardware capability table remains');
  }

  let executableHardware = 0;
  let hardwareEntries: {
    type: string;
    status: string;
    executable?: boolean;
    uses?: { game: string }[];
  }[] = [];
  const manifestPath = join(outRoot, 'runtime/generated/hardware-manifest.json');
  if (!existsSync(manifestPath)) {
    failures.push('generated hardware manifest is missing');
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      hardware?: {
        type: string;
        status: string;
        executable?: boolean;
        executableKind?: 'cpu' | 'device' | 'audio';
        executableArtifact?: string;
        uses?: { game: string }[];
      }[];
    };
    hardwareEntries = manifest.hardware ?? [];
    executableHardware = manifest.hardware?.filter(hardware => hardware.executable).length ?? 0;
    const z80 = manifest.hardware?.find(hardware => hardware.type === 'Z80');
    if (!z80?.executable || !z80.executableArtifact) {
      failures.push('Z80 is not emitted as executable source-derived hardware');
    } else {
      const definitionPath = join(outRoot, 'runtime/generated', z80.executableArtifact);
      if (!existsSync(definitionPath)) {
        failures.push(`Z80 executable artifact is missing: ${z80.executableArtifact}`);
      } else {
        const definition = JSON.parse(readFileSync(definitionPath, 'utf8')) as {
          summary?: { opcodes?: number; compiledOpcodes?: number; diagnostics?: number };
        };
        if (definition.summary?.opcodes !== 1536 ||
            definition.summary.compiledOpcodes !== definition.summary.opcodes ||
            definition.summary.diagnostics !== 0) {
          failures.push('Z80 executable artifact is incomplete or has compiler diagnostics');
        }
      }
    }
    const ls259 = manifest.hardware?.find(hardware => hardware.type === 'LS259');
    if (!ls259?.executable ||
        ls259.executableKind !== 'device' ||
        !ls259.executableArtifact) {
      failures.push('LS259 is not emitted as an executable source-derived device');
    } else {
      const definitionPath = join(outRoot, 'runtime/generated', ls259.executableArtifact);
      if (!existsSync(definitionPath)) {
        failures.push(`LS259 executable artifact is missing: ${ls259.executableArtifact}`);
      } else {
        const definition = JSON.parse(readFileSync(definitionPath, 'utf8')) as {
          hierarchy?: string[];
          summary?: { methods?: number; compiledMethods?: number; diagnostics?: number };
        };
        if (!definition.hierarchy?.includes('addressable_latch_device') ||
            definition.summary?.methods !== definition.summary?.compiledMethods ||
            definition.summary?.diagnostics !== 0) {
          failures.push('LS259 executable artifact is incomplete or has compiler diagnostics');
        }
      }
    }
  }

  for (const target of REQUIRED_TARGETS) {
    const dir = join(outRoot, target);
    const required = [
      'config.json',
      'graph.json',
      'machine.ir.json',
      'runtime-report.json',
      'generated/board.ts',
      'generated/machine.ts',
      'generated/handlers.ts',
      'generated/video.ts',
      'generated/provenance.json',
    ];
    for (const file of required) {
      if (!existsSync(join(dir, file))) failures.push(`${target}: missing ${file}`);
    }
    if (!existsSync(join(dir, 'machine.ir.json'))) continue;
    const boardSource = readFileSync(join(dir, 'generated/board.ts'), 'utf8');
    if (!boardSource.includes('createBoard:')) {
      failures.push(`${target}: generated board module has no createBoard factory`);
    }
    if (boardSource.includes('import BoardAdapter')) familyAdapters++;
    if (boardSource.includes('import BoardAdapter')) {
      failures.push(`${target}: generated board imports a handwritten adapter`);
    }

    const reportPath = join(dir, 'runtime-report.json');
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        schemaVersion?: number;
        boardMode?: string;
        generationGaps?: string[];
        requirements?: {
          composition?: { status: string }[];
        };
      };
      if (report.schemaVersion !== 2 || report.boardMode !== 'generated') {
        failures.push(`${target}: generation report does not describe generated composition`);
      }
      if (report.requirements?.composition?.some(item => item.status !== 'generated')) {
        failures.push(`${target}: generation report retains non-generated board composition`);
      }
      const expectedGaps = hardwareEntries
        .filter(entry => entry.uses?.some(use => use.game === target))
        .filter(entry => entry.status !== 'declarative-host' && !entry.executable)
        .map(entry => entry.type)
        .sort();
      const actualGapTypes = (report.generationGaps ?? [])
        .map(gap => gap.slice(gap.indexOf(':') + 1))
        .sort();
      for (const gap of expectedGaps) {
        if (!actualGapTypes.includes(gap)) {
          failures.push(`${target}: generation report omits hardware gap ${gap}`);
        }
      }
    }

    const machine = JSON.parse(
      readFileSync(join(dir, 'machine.ir.json'), 'utf8'),
    ) as GeneratedMachine;
    if (machine.game !== target) failures.push(`${target}: machine key is ${machine.game}`);
    if (machine.schemaVersion !== 2) failures.push(`${target}: machine schema is not version 2`);
    if (!machine.callbacks.length) failures.push(`${target}: no generated callbacks`);
    if (!machine.execution?.cpus.length) failures.push(`${target}: no generated CPU execution plan`);
    if (!machine.execution?.screen.vtotal) failures.push(`${target}: no generated screen timing`);
    const callbackIds = new Set(machine.callbacks.map(callback => callback.id));
    if (callbackIds.size !== machine.callbacks.length) failures.push(`${target}: duplicate callback IDs`);
    callbacks += machine.callbacks.length;
    frameEvents += machine.execution?.frameEvents.length ?? 0;

    const handlers = new Map(
      (machine.handlers ?? []).map(handler => [`${handler.ownerClass}.${handler.method}`, handler]),
    );
    const used = new Set(
      (machine.maps ?? []).flatMap(map =>
        map.ranges.flatMap(range => [range.read, range.write].filter(Boolean) as string[]),
      ),
    );
    for (const key of used) {
      const handler = handlers.get(key);
      if (!handler?.body) continue;
      sourceMapHandlers++;
      if (!handler.program) failures.push(`${target}: ${key} has source but no program`);
      else if (handler.program.diagnostics.length) {
        failures.push(`${target}: ${key}: ${handler.program.diagnostics.join('; ')}`);
      }
    }
    const screenUpdate = machine.execution?.screenUpdate;
    if (!screenUpdate) {
      failures.push(`${target}: no generated screen-update plan`);
    } else {
      const handler = handlers.get(screenUpdate.handler);
      if (!handler?.program) failures.push(`${target}: screen update ${screenUpdate.handler} has no program`);
      else if (handler.program.diagnostics.length) {
        failures.push(
          `${target}: screen update ${screenUpdate.handler}: ${handler.program.diagnostics.join('; ')}`,
        );
      } else {
        screenUpdates++;
      }
    }
    for (const event of machine.execution?.frameEvents ?? []) {
      if (!callbackIds.has(event.callbackId)) {
        failures.push(`${target}: frame event references missing ${event.callbackId}`);
      }
      if (event.line < 0 || event.line >= machine.execution.screen.vtotal) {
        failures.push(`${target}: frame event ${event.callbackId} has invalid line ${event.line}`);
      }
    }

    if (!registry.includes(`./${target}/board.js`)) {
      failures.push(`${target}: missing from unified generated registry`);
    }
  }
  const appDir = join(outRoot, 'app');
  if (existsSync(join(appDir, '.build'))) {
    failures.push('compiled app retains its temporary source build directory');
  }
  const modulesDir = join(appDir, 'modules');
  if (existsSync(modulesDir)) {
    for (const file of recursiveFiles(modulesDir).filter(path => path.endsWith('.js'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1]!;
        if (specifier.startsWith('/') || /(^|\/)src(\/|$)/.test(specifier)) {
          failures.push(
            `compiled app has non-self-contained import ${specifier} in ${file.slice(appDir.length + 1)}`,
          );
        }
      }
    }
  }
  return {
    targets: REQUIRED_TARGETS.length,
    familyAdapters,
    callbacks,
    frameEvents,
    screenUpdates,
    sourceMapHandlers,
    executableHardware,
    failures,
  };
}

function recursiveFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files;
}

function main(): void {
  const outRoot = process.argv[2] ?? 'dist';
  const audit = auditGenerated(outRoot);
  if (audit.failures.length) {
    console.error(`generated audit failed (${audit.failures.length})`);
    for (const failure of audit.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `generated audit passed: ${audit.targets} targets, ` +
    `${audit.callbacks} callbacks, ${audit.frameEvents} frame events, ` +
    `${audit.screenUpdates} screen updates, ${audit.sourceMapHandlers} source map handlers, ` +
    `${audit.executableHardware} executable hardware cores, ` +
    `${audit.familyAdapters} family adapters remain`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
