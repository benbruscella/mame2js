import { Bus, type HandlerRegistry } from './bus.ts';
import { createCpu, hasGeneratedCpu, type Cpu } from './generated-cpu.ts';
import {
  createDevice,
  hasGeneratedDevice,
  type Device,
} from './generated-device.ts';
import { GeneratedFrameRunner } from './generated-frame.ts';
import {
  GeneratedMameVideoPrimitives,
  GeneratedVideoRenderer,
} from './generated-video.ts';
import {
  dispatchGeneratedCallback,
  executeGeneratedCallbackHandler,
  generatedHandlerRegistry,
  wireGeneratedDevice,
  type GeneratedHandlerBindings,
} from './generated-handler.ts';
import type { GeneratedMachine } from './generated-machine.ts';
import { portHandlers } from './input.ts';
import type {
  Board,
  BoardConfig,
  BoardSinks,
  BoardSnapshot,
  InputPorts,
  Regions,
} from './types.ts';

export type BoardFactory = (
  config: BoardConfig,
  regions: Regions,
  inputs: InputPorts,
  sinks: BoardSinks,
) => Board;

const GENERATED_BOARDS = new Map<string, BoardFactory>();

export function registerGeneratedBoard(game: string, factory: BoardFactory): void {
  GENERATED_BOARDS.set(game, factory);
}

export function createBoard(
  config: BoardConfig,
  regions: Regions,
  inputs: InputPorts,
  sinks: BoardSinks,
): Board {
  if (!config.game) throw new Error('generated board creation requires a machine game key');
  const factory = GENERATED_BOARDS.get(config.game);
  if (!factory) {
    throw new Error(
      `generated board "${config.game}" is not registered ` +
      `(have: ${[...GENERATED_BOARDS.keys()].sort().join(', ')})`,
    );
  }
  return factory(config, regions, inputs, sinks);
}

/**
 * Hardware-neutral composition host for generated machine, CPU and device IR.
 * Missing generated hardware is an error; composition only executes emitted
 * CPU, device, handler, callback and scheduling definitions.
 */
export function createGeneratedBoard(
  machine: GeneratedMachine,
  config: BoardConfig,
  regions: Regions,
  inputs: InputPorts,
  sinks: BoardSinks,
): Board {
  return new IrBoard(machine, config, regions, inputs, sinks);
}

class IrBoard implements Board {
  readonly fbWidth: number;
  readonly fbHeight: number;

  private readonly machine: GeneratedMachine;
  private readonly cpus = new Map<string, Cpu>();
  private readonly devices = new Map<string, Device>();
  private readonly state: Record<string, unknown> = {};
  private readonly shares: Record<string, Uint8Array> = {};
  private readonly frameRunner: GeneratedFrameRunner;
  private readonly bindings: GeneratedHandlerBindings;

  constructor(
    machine: GeneratedMachine,
    config: BoardConfig,
    regions: Regions,
    inputs: InputPorts,
    sinks: BoardSinks,
  ) {
    this.machine = machine;
    this.fbWidth = machine.execution.screen.width;
    this.fbHeight = machine.execution.screen.height;

    for (const specification of machine.devices ?? []) {
      if (hasGeneratedDevice(specification.type)) {
        this.devices.set(specification.tag, createDevice(specification.type));
      }
    }

    const calls: NonNullable<GeneratedHandlerBindings['calls']> = {};
    this.bindings = { members: this.state, inputs, calls };
    for (const [tag, device] of this.devices) {
      for (const method of device.methodNames()) {
        const invoke = (...args: number[]) => device.call(method, ...args);
        calls[`${tag}.${method}`] = invoke;
        calls[`m_${tag}.${method}`] = invoke;
      }
    }
    const sourceHandlers = generatedHandlerRegistry(machine, this.bindings);
    const registry: HandlerRegistry = {
      read: { ...sourceHandlers.read },
      write: { ...sourceHandlers.write },
    };
    this.installDeviceHandlers(machine, registry);
    this.installGeneratedSoundHandlers(machine, sinks, registry);
    this.installDeclarativeHandlers(machine, config, inputs, registry);

    for (const specification of machine.execution.cpus) {
      const type = specification.type ?? 'Z80';
      if (!hasGeneratedCpu(type)) {
        throw new Error(
          `${machine.game}: CPU ${specification.tag}:${type} has no generated executable definition`,
        );
      }
      const rom = regions[specification.region];
      if (!rom) throw new Error(`${machine.game}: missing ROM region ${specification.region}`);
      const bus = new Bus(
        specification.ranges ?? [],
        rom,
        registry,
        this.shares,
      );
      if (specification.io) {
        const ioBus = new Bus(specification.io.ranges, new Uint8Array(0), registry, this.shares);
        const mask = specification.io.globalMask ?? 0xffff;
        bus.in = port => ioBus.read(port & mask);
        bus.out = (port, data) => ioBus.write(port & mask, data);
      }
      const mask = specification.mask ?? 0xffff;
      const cpu = createCpu(type, {
        read: address => bus.read(address & mask),
        write: (address, data) => bus.write(address & mask, data),
        in: bus.in,
        out: bus.out,
      });
      this.cpus.set(specification.tag, cpu);
      const acknowledge = machine.callbacks.find(callback =>
        callback.ownerTag === specification.tag &&
        callback.signal === 'set_irq_acknowledge_callback');
      const interruptVector = (): number =>
        acknowledge
          ? executeGeneratedCallbackHandler(
              machine,
              acknowledge,
              this.bindings,
            ) ?? 0xff
          : 0xff;
      calls[`m_${specification.tag}.set_input_line`] = (_line, state) =>
        cpu.setIrqLine(state !== 0, interruptVector());
      calls[`m_${specification.tag}.pulse_input_line`] = line => {
        if (line < 0) cpu.nmi();
        else {
          cpu.setIrqLine(true);
          cpu.setIrqLine(false);
        }
      };
    }
    for (const [tag, bytes] of Object.entries(this.shares)) {
      this.state[`m_${tag}`] = bytes;
      Object.defineProperty(bytes, 'bytes', {
        value: () => bytes.length,
        configurable: true,
      });
    }

    const callbackEndpoints = this.callbackEndpoints(sinks);
    for (const [tag, device] of this.devices) {
      for (const signal of device.signalNames()) {
        wireGeneratedDevice(
          device,
          machine,
          tag,
          signal,
          this.bindings,
          callbackEndpoints,
        );
      }
    }

    const video = machine.video
      ? new GeneratedVideoRenderer(
          machine,
          new GeneratedMameVideoPrimitives(machine, regions, this.state, this.bindings),
        )
      : undefined;
    this.frameRunner = new GeneratedFrameRunner({
      machine,
      processors: machine.execution.cpus.map(specification => ({
        tag: specification.tag,
        run: cycles => this.cpus.get(specification.tag)!.run(cycles),
      })),
      onEvent: event => {
        dispatchGeneratedCallback(
          machine,
          event.callbackId,
          event.state,
          this.bindings,
          callbackEndpoints,
        );
      },
      video,
    });
  }

  frame(framebuffer: Uint32Array): void {
    this.frameRunner.frame(framebuffer);
  }

  reset(): void {
    for (const device of this.devices.values()) device.reset();
    for (const cpu of this.cpus.values()) cpu.reset();
    this.frameRunner.reset();
  }

  snapshot(): BoardSnapshot {
    return {
      frame: this.frameRunner.frameCount,
      cpus: this.machine.execution.cpus.map(specification => {
        const cpu = this.cpus.get(specification.tag)!;
        return {
          tag: specification.tag,
          pc: cpu.get('PC') || cpu.get('m_pc'),
          sp: cpu.get('SP') || cpu.get('m_s') || cpu.get('m_SP'),
          halted: Boolean(cpu.get('m_halt')),
        };
      }),
      generatedDevices: Object.fromEntries(
        [...this.devices].map(([tag, device]) => [tag, device.get('m_q')]),
      ),
    };
  }

  private installDeviceHandlers(
    machine: GeneratedMachine,
    registry: HandlerRegistry,
  ): void {
    for (const map of machine.maps ?? []) {
      for (const range of map.ranges) {
        for (const [kind, key] of [['read', range.read], ['write', range.write]] as const) {
          if (!key || registry[kind][key]) continue;
          const split = key.indexOf('.');
          if (split < 0) continue;
          const tag = key.slice(0, split);
          const method = key.slice(split + 1);
          const device = this.devices.get(tag);
          if (!device || !device.methodNames().includes(method)) continue;
          if (kind === 'read') {
            registry.read[key] = (_address, offset) => device.call(method, offset);
          } else {
            registry.write[key] = (_address, offset, data) => {
              device.call(method, offset, data);
            };
          }
        }
      }
    }
  }

  private installDeclarativeHandlers(
    machine: GeneratedMachine,
    config: BoardConfig,
    inputs: InputPorts,
    registry: HandlerRegistry,
  ): void {
    for (const cpu of machine.execution.cpus) {
      Object.assign(registry.read, portHandlers(cpu.ranges ?? [], inputs));
      Object.assign(registry.read, portHandlers(cpu.io?.ranges ?? [], inputs));
    }
    for (const key of usedHandlers(machine, 'write')) {
      if (registry.write[key]) continue;
      if (key.startsWith('watchdog.')) registry.write[key] = () => {};
    }
    for (const key of usedHandlers(machine, 'read')) {
      if (registry.read[key]) continue;
      const custom = config.customs?.find(candidate => candidate.member === key.split('.').at(-1));
      if (custom) registry.read[key] = () => inputs.read(custom.port) & custom.mask;
    }
    const missing = [
      ...usedHandlers(machine, 'read').filter(key => !registry.read[key]),
      ...usedHandlers(machine, 'write').filter(key => !registry.write[key]),
    ];
    if (missing.length) {
      throw new Error(
        `${machine.game}: generated composition has unresolved handlers: ` +
        [...new Set(missing)].sort().join(', '),
      );
    }
  }

  private installGeneratedSoundHandlers(
    machine: GeneratedMachine,
    sinks: BoardSinks,
    registry: HandlerRegistry,
  ): void {
    const sound = machine.sound;
    if (!sound) return;
    for (const method of sound.writeMethods) {
      const key = `${sound.deviceTag}.${method}`;
      registry.write[key] = (_address, offset, data) => {
        sinks.soundWrite(offset, data);
      };
    }
  }

  private callbackEndpoints(sinks: BoardSinks): Record<string, (state: number) => void> {
    const endpoints: Record<string, (state: number) => void> = {};
    for (const callback of this.machine.callbacks) {
      if (!callback.targetTag || !callback.targetMethod) continue;
      const target = `${callback.targetTag}.${callback.targetMethod}`;
      const device = this.devices.get(callback.targetTag);
      if (device?.methodNames().includes(callback.targetMethod)) {
        endpoints[target] = state => {
          device.call(callback.targetMethod!, state);
        };
      }
      const cpu = this.cpus.get(callback.targetTag);
      if (cpu && callback.inputLine) {
        endpoints[`${callback.targetTag}.${callback.inputLine}`] = state => {
          if (callback.inputLine === 'INPUT_LINE_NMI' && state) cpu.nmi();
          else if (callback.inputLine === 'INPUT_LINE_RESET') {
            if (!state) cpu.reset();
          } else {
            cpu.setIrqLine(state !== 0);
          }
        };
      }
      if (callback.targetTag === 'speaker') {
        endpoints[target] = state => sinks.soundWrite(callback.slot ?? 0, state);
      }
      const sound = this.machine.sound;
      if (
        sound &&
        callback.targetTag === sound.deviceTag &&
        callback.targetMethod &&
        sound.enableMethods.includes(callback.targetMethod)
      ) {
        endpoints[target] = state => sinks.soundWrite(sound.controlOffset, state);
      }
    }
    return endpoints;
  }
}

function usedHandlers(
  machine: GeneratedMachine,
  kind: 'read' | 'write',
): string[] {
  return (machine.maps ?? []).flatMap(map =>
    map.ranges.flatMap(range => range[kind] ? [range[kind]!] : []));
}
