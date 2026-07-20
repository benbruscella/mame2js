import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KeyboardInput } from '../runtime/input.ts';
import {
  assembleRegions,
  checkRomSet,
  type ShellConfig,
} from '../runtime/shell.ts';
import type { Board, Regions } from '../runtime/types.ts';
import { crc32, readZip } from '../runtime/zip.ts';

export interface ArcadeSmokeResult {
  game: string;
  frames: number;
  framebufferHashes: string[];
  checkpoints: {
    frame: number;
    framebuffer: string;
    pcs: Record<string, number>;
  }[];
  cpuCycles: Record<string, number>;
  soundWrites: number;
}

export async function smokeGeneratedArcade(
  game: string,
  frames = 300,
  projectRoot = resolve('.'),
): Promise<ArcadeSmokeResult> {
  const outRoot = join(projectRoot, 'dist');
  const config = JSON.parse(
    readFileSync(join(outRoot, game, 'config.json'), 'utf8'),
  ) as ShellConfig;
  assert.notEqual(config.kind, 'console', `${game}: use the console acceptance path`);
  const romPath = join(projectRoot, 'roms/arcade', `${game}.zip`);
  assert.ok(existsSync(romPath), `${game}: ROM is missing: ${romPath}`);
  const files = await readZip(new Uint8Array(readFileSync(romPath)));
  const critical = new Set(config.board.cpus.map(cpu => cpu.region));
  const check = checkRomSet(config.roms, files, critical);
  assert.deepEqual(check.missingCritical, [], `${game}: CPU ROMs must be complete`);
  assert.deepEqual(check.missingOther, [], `${game}: media ROMs must be complete`);
  assert.deepEqual(check.crcMismatch, [], `${game}: ROM CRCs must match MAME`);
  const regions = assembleRegions(config.roms, files, () => {}, critical);

  const registry = await import(
    moduleUrl(join(outRoot, 'app/modules/generated/registry.js'))
  ) as { registerGeneratedMachines(): void };
  registry.registerGeneratedMachines();
  const generatedRuntime = await import(
    moduleUrl(join(outRoot, 'app/modules/runtime/generated-board.js'))
  ) as {
    createBoard(
      boardConfig: ShellConfig['board'],
      regions: Regions,
      inputs: KeyboardInput,
      sinks: { soundWrite(offset: number, data: number, frac?: number): void },
    ): Board;
  };
  const input = new KeyboardInput(config.bindings, config.dipDefaults, config.ports);
  let soundWrites = 0;
  const board = generatedRuntime.createBoard(
    { ...config.board, game },
    regions,
    input,
    { soundWrite: () => { soundWrites++; } },
  );
  const framebuffer = new Uint32Array(board.fbWidth * board.fbHeight);
  const hashes = new Set<string>();
  const checkpoints: ArcadeSmokeResult['checkpoints'] = [];
  for (let frame = 0; frame < frames; frame++) {
    board.frame(framebuffer);
    if (frame === 0 || (frame + 1) % 60 === 0 || frame === frames - 1) {
      const framebufferHash = hash(new Uint8Array(framebuffer.buffer));
      hashes.add(framebufferHash);
      checkpoints.push({
        frame: frame + 1,
        framebuffer: framebufferHash,
        pcs: Object.fromEntries(board.snapshot().cpus.map(cpu => [cpu.tag, cpu.pc])),
      });
    }
  }
  const snapshot = board.snapshot();
  assert.equal(snapshot.frame, frames);
  for (const cpu of snapshot.cpus) {
    assert.ok((cpu.cycles ?? 0) > 0, `${game}:${cpu.tag} did not execute`);
  }
  assert.ok(hashes.size > 1, `${game}: generated video did not change across smoke frames`);
  if (config.sound.kind !== 'none') {
    assert.ok(soundWrites > 0, `${game}: generated sound handlers produced no writes`);
  }
  return {
    game,
    frames,
    framebufferHashes: [...hashes],
    checkpoints,
    cpuCycles: Object.fromEntries(snapshot.cpus.map(cpu => [cpu.tag, cpu.cycles ?? 0])),
    soundWrites,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const games = process.argv.slice(2);
  assert.ok(games.length, 'usage: node src/gen/arcade-smoke.ts <game> [...]');
  for (const game of games) {
    console.log(JSON.stringify(await smokeGeneratedArcade(game)));
  }
}

function hash(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}

function moduleUrl(path: string): string {
  return pathToFileURL(path).href;
}
