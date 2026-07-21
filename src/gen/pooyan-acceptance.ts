import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KeyboardInput } from '../runtime/input.ts';
import {
  assembleRegions,
  checkRomSet,
  type ShellConfig,
} from '../runtime/shell.ts';
import type { Board, BoardSnapshot, Regions } from '../runtime/types.ts';
import { crc32, readZip } from '../runtime/zip.ts';
import { gameOutputDir } from './output-layout.ts';

interface AyCore {
  readonly nativeRate: number;
  write(register: number, data: number): void;
  sample(): number;
}

interface SoundWrite {
  offset: number;
  data: number;
}

interface FrameCheckpoint {
  video: string;
  mainPc: number;
  soundPc: number;
  mainCycles: number;
  soundCycles: number;
  mainLatch: number;
}

export async function verifyPooyanAcceptance(
  projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
): Promise<void> {
  const outRoot = join(projectRoot, 'dist');
  const gameDir = gameOutputDir(outRoot, 'arcade', 'pooyan');
  const romPath = process.env.MAMEKIT_POOYAN_ROM
    ? resolve(process.env.MAMEKIT_POOYAN_ROM)
    : join(projectRoot, 'roms/arcade/pooyan.zip');
  assert.ok(existsSync(romPath), `Pooyan acceptance ROM is missing: ${romPath}`);

  const config = JSON.parse(
    readFileSync(join(gameDir, 'config.json'), 'utf8'),
  ) as ShellConfig;
  const files = await readZip(new Uint8Array(readFileSync(romPath)));
  const critical = new Set(config.board.cpus.map(cpu => cpu.region));
  const romCheck = checkRomSet(config.roms, files, critical);
  assert.deepEqual(romCheck.missingCritical, []);
  assert.deepEqual(romCheck.missingOther, []);
  assert.deepEqual(romCheck.crcMismatch, []);
  const regions = assembleRegions(config.roms, files, () => {}, critical);

  const registry = await import(
    moduleUrl(join(outRoot, 'app/registry.js'))
  ) as { registerGeneratedMachines(): void };
  registry.registerGeneratedMachines();
  const generatedRuntime = await import(
    moduleUrl(join(outRoot, 'runtime/core/generated-board.js'))
  ) as {
    createBoard(
      boardConfig: ShellConfig['board'],
      regions: Regions,
      inputs: KeyboardInput,
      sinks: { soundWrite(offset: number, data: number): void },
    ): Board;
  };

  const globals = globalThis as Record<string, unknown>;
  globals.AudioWorkletProcessor = class {};
  globals.sampleRate = 48_000;
  globals.registerProcessor = () => {};
  const ayModule = await import(
    moduleUrl(join(outRoot, 'runtime/generated/audio/ay8910-worklet.js'))
  ) as {
    GeneratedAy8910Core: new (clock: number) => AyCore;
  };
  const ayCores = Array.from(
    { length: config.sound.chips ?? 2 },
    () => new ayModule.GeneratedAy8910Core(config.sound.clock ?? 1_789_772),
  );

  const eventTarget = new EventTarget();
  const input = new KeyboardInput(config.bindings, config.dipDefaults, config.ports);
  input.attach(eventTarget);
  assert.equal(input.read('IN0'), 0xff);
  key(eventTarget, 'keydown', 'Digit5');
  assert.equal(input.read('IN0'), 0xfe);
  key(eventTarget, 'keyup', 'Digit5');
  key(eventTarget, 'keydown', 'Digit1');
  assert.equal(input.read('IN0'), 0xf7);
  key(eventTarget, 'keyup', 'Digit1');

  let pendingWrites: SoundWrite[] = [];
  const allWrites: SoundWrite[] = [];
  const board = generatedRuntime.createBoard(
    { ...config.board, game: config.game },
    regions,
    input,
    {
      soundWrite: (offset, data) => {
        const write = { offset, data };
        pendingWrites.push(write);
        allWrites.push(write);
      },
    },
  );
  assert.equal(board.fbWidth, 256);
  assert.equal(board.fbHeight, 224);

  const framebuffer = new Uint32Array(board.fbWidth * board.fbHeight);
  const checkpoints: Record<string, FrameCheckpoint> = {};
  const pcm: number[] = [];
  let sampleCarry = 0;
  let ayPhase = 0;
  const runFrame = (): void => {
    pendingWrites = [];
    board.frame(framebuffer);
    for (const write of pendingWrites) {
      if (write.offset < 0) continue;
      ayCores[write.offset >> 4]?.write(write.offset & 0x0f, write.data);
    }
    sampleCarry += 48_000 / config.board.screen.refresh;
    const samples = Math.floor(sampleCarry);
    sampleCarry -= samples;
    for (let index = 0; index < samples; index++) {
      ayPhase += ayCores[0]!.nativeRate / 48_000;
      let mixed = 0;
      while (ayPhase >= 1) {
        ayPhase -= 1;
        mixed = ayCores.reduce((sum, core) => sum + core.sample(), 0) / ayCores.length;
      }
      if (board.snapshot().frame >= 120) pcm.push(mixed);
    }
    const frame = board.snapshot().frame;
    if ([1, 60, 180, 300, 420, 600].includes(frame)) {
      checkpoints[String(frame)] = checkpoint(board.snapshot(), framebuffer);
    }
  };

  while (board.snapshot().frame < 300) runFrame();
  pulse(eventTarget, 'Digit5', runFrame, 10, 20);
  pulse(eventTarget, 'Digit1', runFrame, 10, 20);
  while (board.snapshot().frame < 600) runFrame();

  const videoHashes = new Set(Object.values(checkpoints).map(frame => frame.video));
  const rms = Math.sqrt(
    pcm.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, pcm.length),
  );
  const result = {
    roms: Object.fromEntries(
      Object.entries(regions).map(([name, bytes]) => [name, hash(bytes)]),
    ),
    checkpoints,
    audio: {
      writes: allWrites.length,
      nonzeroWrites: allWrites.filter(write => write.offset >= 0 && write.data !== 0).length,
      writeHash: hash(new TextEncoder().encode(JSON.stringify(allWrites))),
      rms: Math.round(rms * 1_000_000) / 1_000_000,
      trace: allWrites.slice(0, 64),
    },
  };
  if (process.env.MAMEKIT_UPDATE_GOLDENS === '1') {
    console.log(JSON.stringify(result, null, 2));
  }
  assert.equal(Object.keys(checkpoints).length, 6);
  assert.ok(videoHashes.size >= 3, 'Pooyan video must progress across real-ROM checkpoints');
  assert.ok(checkpoints['600']!.mainCycles > 25_000_000);
  assert.ok(checkpoints['600']!.soundCycles > 10_000_000);
  assert.ok(result.audio.writes > 0, 'Pooyan sound CPU must write generated AY registers');
  assert.ok(result.audio.rms > 0.001, 'Pooyan generated AY output must be audible');
}

function checkpoint(snapshot: BoardSnapshot, framebuffer: Uint32Array): FrameCheckpoint {
  const main = snapshot.cpus.find(cpu => cpu.tag === 'maincpu');
  const sound = snapshot.cpus.find(cpu => cpu.tag === 'tpsound');
  assert.ok(main);
  assert.ok(sound);
  return {
    video: hash(new Uint8Array(framebuffer.buffer)),
    mainPc: main.pc,
    soundPc: sound.pc,
    mainCycles: main.cycles ?? 0,
    soundCycles: sound.cycles ?? 0,
    mainLatch: Number(
      (snapshot.generatedDevices as Record<string, number> | undefined)?.mainlatch,
    ) || 0,
  };
}

function pulse(
  target: EventTarget,
  code: string,
  frame: () => void,
  heldFrames: number,
  releasedFrames: number,
): void {
  key(target, 'keydown', code);
  for (let index = 0; index < heldFrames; index++) frame();
  key(target, 'keyup', code);
  for (let index = 0; index < releasedFrames; index++) frame();
}

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string): void {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: false },
  });
  target.dispatchEvent(event);
}

function hash(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}

function moduleUrl(path: string): string {
  return pathToFileURL(path).href;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyPooyanAcceptance();
  console.log('pooyan-acceptance: ROM/input/video/audio/timing contract passed');
}
