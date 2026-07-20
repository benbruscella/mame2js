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
  dispatchGeneratedCallbacks,
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
  private readonly cpuCycles = new Map<string, number>();
  private readonly devices = new Map<string, Device>();
  private readonly bankEntries = new Map<string, number>();
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
      const specification = machine.devices?.find(candidate => candidate.tag === tag);
      for (const method of device.methodNames()) {
        const invoke = (...args: number[]) => device.call(method, ...args);
        calls[`${tag}.${method}`] = invoke;
        calls[`m_${tag}.${method}`] = invoke;
        if (specification?.member) calls[`${specification.member}.${method}`] = invoke;
      }
    }
    for (const bank of machine.execution.banks ?? []) {
      this.bankEntries.set(bank.tag, bank.firstEntry);
      const select = (entry: number): void => {
        const last = bank.firstEntry + bank.entries - 1;
        this.bankEntries.set(bank.tag, Math.max(bank.firstEntry, Math.min(last, entry)));
      };
      calls[`m_${bank.tag}.set_entry`] = select;
      calls[`${bank.tag}.set_entry`] = select;
    }
    const sourceHandlers = generatedHandlerRegistry(machine, this.bindings);
    const registry: HandlerRegistry = {
      read: { ...sourceHandlers.read },
      write: { ...sourceHandlers.write },
    };
    for (const bank of machine.execution.banks ?? []) {
      registry.read[`bank.${bank.tag}`] = (_address, offset) => {
        const region = regions[bank.region];
        if (!region) return 0xff;
        const entry = this.bankEntries.get(bank.tag) ?? bank.firstEntry;
        const address = bank.offset + (entry - bank.firstEntry) * bank.stride + offset;
        return region[address] ?? 0xff;
      };
    }
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
      const rom = regions[specification.region] ??
        regions[Object.keys(regions).find(name =>
          name.endsWith(`:${specification.region}`)) ?? ''];
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
        readSignal: (signal, index) => {
          const callback = machine.callbacks.find(candidate =>
            candidate.ownerTag === specification.tag &&
            candidate.signal === cpuPinSignal(signal, index, 'in'));
          if (!callback) return signal === 'test' ? 0 : 0xff;
          if (callback.targetTag && callback.targetMethod) {
            const device = this.devices.get(callback.targetTag);
            if (device?.methodNames().includes(callback.targetMethod)) {
              return device.call(callback.targetMethod);
            }
          }
          return executeGeneratedCallbackHandler(
            machine,
            callback,
            this.bindings,
          ) ?? 0xff;
        },
        writeSignal: (signal, value, index) => {
          dispatchGeneratedCallbacks(
            machine,
            specification.tag,
            cpuPinSignal(signal, index, 'out'),
            value,
            this.bindings,
            this.callbackEndpoints(sinks),
          );
        },
      });
      this.cpus.set(specification.tag, cpu);
      this.cpuCycles.set(specification.tag, 0);
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
      const setInputLine = (line: number, state: number): void => {
        if (line < 0) {
          if (state !== 0) cpu.nmi();
          return;
        }
        cpu.setIrqLine(state !== 0, interruptVector);
      };
      calls[`m_${specification.tag}.set_input_line`] = setInputLine;
      if (deviceByTag(machine, specification.tag)?.member) {
        const member = deviceByTag(machine, specification.tag)!.member!;
        calls[`${member}.set_input_line`] = setInputLine;
        calls[`${member}.pulse_input_line`] = line => {
          if (line < 0) cpu.nmi();
          else {
            cpu.setIrqLine(true);
            cpu.setIrqLine(false);
          }
        };
        calls[`${member}.total_cycles`] = () => this.cpuCycles.get(specification.tag) ?? 0;
      }
      calls[`m_${specification.tag}.pulse_input_line`] = line => {
        if (line < 0) cpu.nmi();
        else {
          cpu.setIrqLine(true);
          cpu.setIrqLine(false);
        }
      };
    }
    for (const [tag, bytes] of Object.entries(this.shares)) {
      bindGeneratedShareState(this.state, tag, bytes);
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
        run: cycles => {
          const executed = this.cpus.get(specification.tag)!.run(cycles);
          this.cpuCycles.set(
            specification.tag,
            (this.cpuCycles.get(specification.tag) ?? 0) + executed,
          );
          return executed;
        },
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
    for (const tag of this.cpuCycles.keys()) this.cpuCycles.set(tag, 0);
    for (const bank of this.machine.execution.banks ?? []) {
      this.bankEntries.set(bank.tag, bank.firstEntry);
    }
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
          cycles: this.cpuCycles.get(specification.tag) ?? 0,
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
            registry.read[key] = (_address, offset) =>
              device.arity(method) ? device.call(method, offset) : device.call(method);
          } else {
            registry.write[key] = (_address, offset, data) => {
              if (device.arity(method) <= 1) device.call(method, data);
              else device.call(method, offset, data);
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
      else if (key.startsWith('palette.')) registry.write[key] = () => {};
    }
    for (const key of usedHandlers(machine, 'read')) {
      if (registry.read[key]) continue;
      if (key.startsWith('watchdog.')) {
        registry.read[key] = () => 0xff;
        continue;
      }
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
    if (sound.kind === 'ay8910') {
      const tags = sound.deviceTags ?? [sound.deviceTag];
      const addresses = new Map(tags.map(tag => [tag, 0]));
      const registers = new Map(tags.map(tag => [tag, new Uint8Array(16)]));
      tags.forEach((tag, chip) => {
        registry.write[`${tag}.address_w`] = (_address, _offset, data) => {
          addresses.set(tag, data & 0x0f);
        };
        registry.write[`${tag}.data_w`] = (_address, _offset, data) => {
          const register = addresses.get(tag) ?? 0;
          registers.get(tag)![register] = data;
          sinks.soundWrite(chip * 16 + register, data);
          if (register === 14 || register === 15) {
            dispatchGeneratedCallbacks(
              machine,
              tag,
              register === 14 ? 'port_a_write_callback' : 'port_b_write_callback',
              data,
              this.bindings,
              this.callbackEndpoints(sinks),
            );
          }
        };
        registry.read[`${tag}.data_r`] = () => {
          const register = addresses.get(tag) ?? 0;
          const callback = machine.callbacks.find(candidate =>
            candidate.ownerTag === tag &&
            candidate.signal === (register === 14
              ? 'port_a_read_callback'
              : register === 15
                ? 'port_b_read_callback'
                : ''));
          if (callback?.targetTag && callback.targetMethod) {
            const device = this.devices.get(callback.targetTag);
            if (device?.methodNames().includes(callback.targetMethod)) {
              return device.call(callback.targetMethod);
            }
          }
          if (callback?.targetClass && callback.targetMethod) {
            return executeGeneratedCallbackHandler(
              machine,
              callback,
              this.bindings,
            ) ?? 0xff;
          }
          return registers.get(tag)![register] ?? 0xff;
        };
      });
      return;
    }
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
      if (!callback.targetMethod) continue;
      const target = callback.targetTag
        ? `${callback.targetTag}.${callback.targetMethod}`
        : callback.targetClass
          ? `${callback.targetClass}.${callback.targetMethod}`
          : callback.targetMethod;
      if (callback.targetMethod === 'flip_screen_set') {
        endpoints[target] = state => {
          this.state.__flip_screen = state ? 1 : 0;
        };
      } else if (callback.targetMethod === 'flip_screen_x_set') {
        endpoints[target] = state => {
          this.state.__flip_screen_x = state ? 1 : 0;
        };
      } else if (callback.targetMethod === 'flip_screen_y_set') {
        endpoints[target] = state => {
          this.state.__flip_screen_y = state ? 1 : 0;
        };
      }
      if (!callback.targetTag) continue;
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
      const targetType = deviceByTag(this.machine, callback.targetTag)?.type;
      if (targetType?.startsWith('DAC_')) {
        endpoints[target] = state => sinks.soundWrite(0x80, state);
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

export function bindGeneratedShareState(
  state: Record<string, unknown>,
  tag: string,
  bytes: Uint8Array,
): void {
  Object.defineProperty(bytes, 'bytes', {
    value: () => bytes.length,
    configurable: true,
  });
  state[`m_${tag}`] = bytes;
  const indexed = /^(.+)\[(\d+)\]$/.exec(tag);
  if (!indexed) return;
  const member = `m_${indexed[1]}`;
  const values = Array.isArray(state[member]) ? state[member] as unknown[] : [];
  values[Number(indexed[2])] = bytes;
  state[member] = values;
}

function usedHandlers(
  machine: GeneratedMachine,
  kind: 'read' | 'write',
): string[] {
  return (machine.maps ?? []).flatMap(map =>
    map.ranges.flatMap(range => range[kind] ? [range[kind]!] : []));
}

function deviceByTag(machine: GeneratedMachine, tag: string) {
  return machine.devices?.find(device => device.tag === tag);
}

function cpuPinSignal(
  signal: string,
  index: number | undefined,
  direction: 'in' | 'out',
): string {
  if (signal === 'port') return `p${index ?? 0}_${direction}_cb`;
  if (signal === 'test') return `t${index ?? 0}_${direction}_cb`;
  return `${signal}_${direction}_cb`;
}
