import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gameOutputDir } from '../gen/output-layout.ts';
import { KeyboardInput } from '../runtime/input.ts';
import {
  assembleRegions,
  checkRomSet,
  type ShellConfig,
} from '../runtime/shell.ts';
import type { Board, BoardSnapshot, Regions } from '../runtime/types.ts';
import { crc32, readZip } from '../runtime/zip.ts';
import type {
  GameAcceptanceGolden,
  GameTestContract,
} from './types.ts';

interface SoundWrite {
  offset: number;
  data: number;
  frac?: number;
  method?: string;
}

interface AudioProbe {
  render(writes: readonly SoundWrite[], capture: boolean): void;
  finish(writes: SoundWrite[]): GameAcceptanceGolden['audio'];
}

interface AyMixer {
  write(offset: number, data: number): void;
  sample(): number;
}

interface AyFrameRenderer {
  render(writes: readonly SoundWrite[]): Float32Array;
}

interface WsgCore {
  readonly sampleRate: number;
}

interface WsgFrameRenderer {
  render(writes: readonly SoundWrite[]): Float32Array;
}

interface DiscreteAudioCore {
  write(offset: number, data: number): void;
  sample(): number;
}

interface DiscreteAudioFrameRenderer {
  render(writes: readonly SoundWrite[]): Float32Array;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function runGameAcceptance(
  contract: GameTestContract,
  root = projectRoot,
): Promise<GameAcceptanceGolden> {
  const outRoot = join(root, 'dist');
  const gameDir = gameOutputDir(outRoot, contract.category, contract.game);
  const romPath = resolve(
    process.env[contract.romEnvironment]
      ?? join(root, `roms/${contract.category}/${contract.game}.zip`),
  );
  assert.ok(existsSync(gameDir), `${contract.game}: generated output is missing: ${gameDir}`);
  assert.ok(existsSync(romPath), `${contract.game}: acceptance ROM is missing: ${romPath}`);

  const config = JSON.parse(
    readFileSync(join(gameDir, 'config.json'), 'utf8'),
  ) as ShellConfig;
  assert.equal(config.game, contract.game);
  assert.equal(config.sound.kind, contract.soundKind);

  const files = await readZip(new Uint8Array(readFileSync(romPath)));
  const critical = new Set(config.board.cpus.map(cpu => cpu.region));
  const romCheck = checkRomSet(config.roms, files, critical);
  assert.deepEqual(romCheck.missingCritical, []);
  assert.deepEqual(romCheck.missingOther, []);
  assert.deepEqual(romCheck.crcMismatch, []);
  const regions = assembleRegions(config.roms, files, () => {}, critical);
  for (const patch of config.romPatches ?? []) {
    const region = regions[patch.region];
    if (region && patch.offset < region.length) region[patch.offset] = patch.value;
  }

  const registry = await import(moduleUrl(join(outRoot, 'app/registry.js'))) as {
    registerGeneratedMachines(): void;
  };
  registry.registerGeneratedMachines();
  const generatedRuntime = await import(
    moduleUrl(join(outRoot, 'runtime/core/generated-board.js'))
  ) as {
    createBoard(
      boardConfig: ShellConfig['board'],
      regions: Regions,
      inputs: KeyboardInput,
      sinks: { soundWrite(offset: number, data: number, frac?: number, method?: string): void },
    ): Board;
  };

  const eventTarget = new EventTarget();
  const input = new KeyboardInput(config.bindings, config.dipDefaults, config.ports);
  input.attach(eventTarget);
  verifyInputBindings(contract, config, input, eventTarget);

  const pendingWrites: SoundWrite[] = [];
  const allWrites: SoundWrite[] = [];
  const requiredAudioCounts = new Map<string, number>();
  const board = generatedRuntime.createBoard(
    { ...config.board, game: config.game },
    regions,
    input,
    {
      soundWrite: (offset, data, frac, method) => {
        const write = { offset, data, frac, method };
        pendingWrites.push(write);
        allWrites.push(write);
      },
    },
  );
  assert.equal(board.fbWidth, contract.screen.width);
  assert.equal(board.fbHeight, contract.screen.height);

  const audio = await createAudioProbe(config, regions, outRoot);
  const framebuffer = new Uint32Array(board.fbWidth * board.fbHeight);
  const checkpoints: GameAcceptanceGolden['checkpoints'] = {};
  const checkpointFrames = new Set(contract.checkpoints);
  const startedAt = performance.now();
  const runFrame = (): void => {
    pendingWrites.length = 0;
    board.frame(framebuffer);
    const snapshot = board.snapshot();
    for (const requirement of contract.audioRequirements ?? []) {
      if (snapshot.frame < requirement.fromFrame) continue;
      const count = pendingWrites.filter(write =>
        write.method === requirement.method && write.data !== 0).length;
      requiredAudioCounts.set(
        requirement.method,
        (requiredAudioCounts.get(requirement.method) ?? 0) + count,
      );
    }
    audio.render(pendingWrites, snapshot.frame >= 120);
    if (checkpointFrames.has(snapshot.frame)) {
      checkpoints[String(snapshot.frame)] = {
        video: hash(new Uint8Array(framebuffer.buffer)),
        state: stateHash(snapshot),
      };
    }
  };

  for (const action of contract.actions) {
    while (board.snapshot().frame < action.atFrame) runFrame();
    pulse(
      eventTarget,
      action.code,
      runFrame,
      action.heldFrames,
      action.releasedFrames,
    );
  }
  while (board.snapshot().frame < contract.frames) runFrame();
  const finalSnapshot = board.snapshot();
  if (process.env.MAMEKIT_CAPTURE_FRAME) {
    writeFramePpm(
      process.env.MAMEKIT_CAPTURE_FRAME,
      framebuffer,
      board.fbWidth,
      board.fbHeight,
    );
  }
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const emulatedFps = contract.frames / elapsedSeconds;

  const result: GameAcceptanceGolden = {
    regions: Object.fromEntries(
      Object.entries(regions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, bytes]) => [name, hash(bytes)]),
    ),
    checkpoints,
    audio: audio.finish(allWrites),
  };
  assert.equal(Object.keys(checkpoints).length, contract.checkpoints.length);
  assert.ok(new Set(Object.values(checkpoints).map(value => value.video)).size >= 3);
  assert.ok(
    result.audio.writes > 0,
    `${contract.game}: generated sound has no writes (${JSON.stringify(result.audio)})`,
  );
  assert.ok(
    result.audio.rms > 0.001,
    `${contract.game}: generated sound is silent ` +
      `(${JSON.stringify({ audio: result.audio, snapshot: finalSnapshot })})`,
  );
  for (const requirement of contract.audioRequirements ?? []) {
    const actual = requiredAudioCounts.get(requirement.method) ?? 0;
    assert.ok(
      actual >= requirement.minimumNonzeroWrites,
      `${contract.game}: ${requirement.method} audio emitted ${actual} nonzero writes ` +
        `after frame ${requirement.fromFrame} (minimum ${requirement.minimumNonzeroWrites})`,
    );
  }
  assert.ok(
    emulatedFps >= contract.minimumFps,
    `${contract.game}: ${emulatedFps.toFixed(1)} fps is below the ` +
      `${contract.minimumFps} fps acceptance floor`,
  );
  console.log(
    `${contract.game}: ${emulatedFps.toFixed(1)} emulated fps ` +
      `(minimum ${contract.minimumFps})`,
  );

  if (process.env.MAMEKIT_UPDATE_GOLDENS === '1') {
    console.log(`${contract.game}:\n${JSON.stringify(result, null, 2)}`);
  } else {
    assert.ok(contract.golden, `${contract.game}: no acceptance golden is recorded`);
    assert.deepEqual(result, contract.golden, `${contract.game}: generated behavior changed`);
  }
  return result;
}

function verifyInputBindings(
  contract: GameTestContract,
  config: ShellConfig,
  input: KeyboardInput,
  target: EventTarget,
): void {
  for (const code of new Set(contract.actions.map(action => action.code))) {
    const binding = config.bindings.find(candidate => candidate.keys.includes(code));
    assert.ok(binding, `${contract.game}: ${code} has no generated input binding`);
    const released = input.read(binding.port);
    key(target, 'keydown', code);
    const pressed = input.read(binding.port);
    const expected = binding.activeLow
      ? released & ~binding.mask
      : released | binding.mask;
    assert.equal(pressed, expected, `${contract.game}: ${code} did not reach ${binding.port}`);
    key(target, 'keyup', code);
    assert.equal(input.read(binding.port), released);
  }
}

async function createAudioProbe(
  config: ShellConfig,
  regions: Regions,
  outRoot: string,
): Promise<AudioProbe> {
  installWorkletGlobals();
  if (config.sound.kind === 'ay8910') {
    const generated = await import(
      moduleUrl(join(outRoot, 'runtime/generated/audio/ay8910-worklet.js'))
    ) as {
      GeneratedAy8910Mixer: new (
        clock: number,
        chips: number,
        outputRate: number,
        routes?: NonNullable<ShellConfig['sound']['routes']>,
        chipGains?: number[],
      ) => AyMixer;
      GeneratedAy8910FrameRenderer: new (
        mixer: AyMixer,
        outputRate: number,
        refresh: number,
      ) => AyFrameRenderer;
    };
    const outputRate = 48_000;
    const mixer = new generated.GeneratedAy8910Mixer(
      config.sound.clock ?? 1_789_772,
      config.sound.chips ?? 1,
      outputRate,
      config.sound.routes,
      config.sound.chipGains,
    );
    const renderer = new generated.GeneratedAy8910FrameRenderer(
      mixer,
      outputRate,
      config.board.screen.refresh,
    );
    const chunks: Float32Array[] = [];
    return {
      render(writes, capture) {
        const samples = renderer.render(writes);
        if (capture) chunks.push(samples);
      },
      finish(writes) {
        return audioResult(writes, chunks);
      },
    };
  }
  if (config.sound.kind === 'wsg') {
    const generated = await import(
      moduleUrl(join(outRoot, 'runtime/generated/audio/wsg-worklet.js'))
    ) as {
      GeneratedNamcoWsgCore: new (
        waveRom: Uint8Array,
        clock: number,
        auxiliary?: ShellConfig['sound']['auxiliary'],
      ) => WsgCore;
      GeneratedNamcoWsgFrameRenderer: new (
        core: WsgCore,
        refresh: number,
      ) => WsgFrameRenderer;
    };
    const waveRom = regions[config.sound.waveRegion ?? 'namco'];
    assert.ok(waveRom, `${config.game}: WSG wave ROM is missing`);
    const core = new generated.GeneratedNamcoWsgCore(
      waveRom,
      config.sound.clock ?? 96_000,
      config.sound.auxiliary,
    );
    const chunks: Float32Array[] = [];
    const renderer = new generated.GeneratedNamcoWsgFrameRenderer(
      core,
      config.board.screen.refresh,
    );
    return {
      render(writes, capture) {
        const samples = renderer.render(writes);
        if (capture) chunks.push(samples);
      },
      finish(writes) {
        return audioResult(writes, chunks);
      },
    };
  }
  if (config.sound.kind === 'discrete') {
    assert.ok(config.sound.worklet, `${config.game}: discrete audio worklet is missing`);
    const generated = await import(
      moduleUrl(join(
        outRoot,
        `runtime/generated/audio/${config.sound.worklet}-worklet.js`,
      ))
    ) as {
      GeneratedDiscreteAudioCore: new (
        outputRate: number,
        clock?: number,
      ) => DiscreteAudioCore;
      GeneratedDiscreteAudioFrameRenderer: new (
        core: DiscreteAudioCore,
        outputRate: number,
        refresh: number,
      ) => DiscreteAudioFrameRenderer;
    };
    const outputRate = 48_000;
    const core = new generated.GeneratedDiscreteAudioCore(
      outputRate,
      config.sound.clock,
    );
    const renderer = new generated.GeneratedDiscreteAudioFrameRenderer(
      core,
      outputRate,
      config.board.screen.refresh,
    );
    const chunks: Float32Array[] = [];
    return {
      render(writes, capture) {
        const samples = renderer.render(writes);
        if (capture) chunks.push(samples);
      },
      finish(writes) {
        return audioResult(writes, chunks);
      },
    };
  }
  throw new Error(`${config.game}: unsupported acceptance sound kind ${config.sound.kind}`);
}

function audioResult(
  writes: SoundWrite[],
  chunks: Float32Array[],
): GameAcceptanceGolden['audio'] {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Float32Array(sampleCount);
  let offset = 0;
  let squares = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
    for (const sample of chunk) squares += sample * sample;
  }
  return {
    writes: writes.length,
    nonzeroWrites: writes.filter(write => write.offset >= 0 && write.data !== 0).length,
    writeHash: hash(new TextEncoder().encode(JSON.stringify(writes))),
    pcmHash: hash(new Uint8Array(pcm.buffer)),
    rms: Math.round(Math.sqrt(squares / Math.max(1, sampleCount)) * 1_000_000) / 1_000_000,
  };
}

function stateHash(snapshot: BoardSnapshot): string {
  return hash(new TextEncoder().encode(stableJson({
    cpus: snapshot.cpus,
    credits: snapshot.credits ?? null,
    generatedDevices: snapshot.generatedDevices ?? null,
  })));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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

function installWorkletGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.AudioWorkletProcessor ??= class {};
  globals.sampleRate ??= 48_000;
  globals.registerProcessor ??= () => {};
}

function hash(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}

function moduleUrl(path: string): string {
  return pathToFileURL(path).href;
}

function writeFramePpm(
  path: string,
  frame: Uint32Array,
  width: number,
  height: number,
): void {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let index = 0; index < frame.length; index++) {
    const pixel = frame[index]!;
    rgb[index * 3] = pixel & 0xff;
    rgb[index * 3 + 1] = (pixel >>> 8) & 0xff;
    rgb[index * 3 + 2] = (pixel >>> 16) & 0xff;
  }
  writeFileSync(path, Buffer.concat([header, rgb]));
}
