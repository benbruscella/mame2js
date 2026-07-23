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
  executeGeneratedMachineHandler,
  generatedHandlerRegistry,
  wireGeneratedDevice,
  type GeneratedHandlerBindings,
} from './generated-handler.ts';
import type { GeneratedMachine } from './generated-machine.ts';
import { portHandlers } from './input.ts';
import {
  AY_FILTER_CONTROL_BASE,
  AY_FILTER_CONTROL_STRIDE,
} from './audio-protocol.ts';
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
  private readonly cpuHeld = new Map<string, boolean>();
  private readonly devices = new Map<string, Device>();
  private readonly state: Record<string, unknown> = {};
  private readonly shares: Record<string, Uint8Array> = {};
  private readonly frameRunner: GeneratedFrameRunner;
  private readonly bindings: GeneratedHandlerBindings;
  private currentLine = 0;

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
        const device = createDevice(specification.type, { clock: specification.clock });
        // Machine-config chained setup calls (m_starfield->set_starfield_config(...))
        // lowered from the driver's constant arguments.
        for (const configuration of specification.configuration ?? []) {
          if (device.methodNames().includes(configuration.method)) {
            device.call(configuration.method, ...configuration.args);
          }
        }
        this.devices.set(specification.tag, device);
      }
    }

    const calls: NonNullable<GeneratedHandlerBindings['calls']> = {};
    this.bindings = { members: this.state, inputs, calls };
    for (const input of machine.execution.inputMembers ?? []) {
      const ports = input.tags.map(tag => ({ read: () => inputs.read(tag) }));
      this.state[input.member] = ports.length === 1 ? ports[0] : ports;
    }
    const screen = machine.devices?.find(device => device.type === 'SCREEN');
    for (const owner of [screen?.tag, screen?.member].filter(Boolean) as string[]) {
      calls[`${owner}.vpos`] = () => this.currentLine;
    }
    for (const [tag, device] of this.devices) {
      const specification = machine.devices?.find(candidate => candidate.tag === tag);
      for (const method of device.methodNames()) {
        const invoke = (...args: number[]) => device.call(method, ...args);
        calls[`${tag}.${method}`] = invoke;
        calls[`m_${tag}.${method}`] = invoke;
        if (specification?.member) calls[`${specification.member}.${method}`] = invoke;
      }
    }
    for (const device of this.devices.values()) {
      device.bindCall('machine().time', () => this.frameRunner?.frameCount /
        this.machine.execution.screen.refresh || 0);
    }
    const sourceHandlers = generatedHandlerRegistry(machine, this.bindings);
    const registry: HandlerRegistry = {
      read: { ...sourceHandlers.read },
      write: { ...sourceHandlers.write },
    };
    this.installDeviceHandlers(machine, registry);
    this.installGeneratedSoundHandlers(machine, sinks, registry);
    this.installDeclarativeHandlers(machine, config, inputs, registry);
    this.installInterruptVectorWriters(machine, registry);

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
        signal: (signal, state) => {
          dispatchGeneratedCallbacks(
            machine,
            specification.tag,
            signal,
            state,
            this.bindings,
            this.callbackEndpoints(sinks),
          );
        },
      });
      this.cpus.set(specification.tag, cpu);
      this.cpuCycles.set(specification.tag, 0);
      this.cpuHeld.set(specification.tag, false);
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
      calls[`m_${specification.tag}.set_input_line`] = (line, state) => {
        if (line < 0) {
          if (state !== 0) cpu.nmi();
          return;
        }
        cpu.setIrqLine(
          state !== 0,
          state !== 0 ? interruptVector : 0xff,
          state === 2,
        );
      };
      calls[`m_${specification.tag}.pulse_input_line`] = line => {
        if (line < 0) cpu.nmi();
        else {
          cpu.setIrqLine(true);
          cpu.setIrqLine(false);
        }
      };
      calls[`m_${specification.tag}.total_cycles`] = () =>
        this.cpuCycles.get(specification.tag) ?? 0;
      // Handlers reference CPUs by their state-member name (m_subcpu2) as
      // well as by tag; every CPU call gets both aliases uniformly.
      const member = machine.devices?.find(device =>
        device.tag === specification.tag)?.member;
      if (member) {
        for (const name of ['set_input_line', 'pulse_input_line', 'total_cycles']) {
          calls[`${member}.${name}`] = calls[`m_${specification.tag}.${name}`]!;
        }
      }
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
    for (const callback of machine.callbacks) {
      if (callback.signal !== 'q_out_cb' || callback.slot === undefined) continue;
      const source = this.devices.get(callback.ownerTag);
      if (!source) continue;
      dispatchGeneratedCallback(
        machine,
        callback,
        (source.get('m_q') >> callback.slot) & 1,
        this.bindings,
        callbackEndpoints,
      );
    }

    const hostedProcessors = (machine.devices ?? []).flatMap(specification => {
      if (!specification.hostTag) return [];
      const device = this.devices.get(specification.tag);
      const host = this.devices.get(specification.hostTag);
      const firmware = regions[specification.tag];
      if (
        !device || !host || !firmware ||
        !device.methodNames().includes('execute_run') ||
        !device.methodNames().includes('execute_set_input')
      ) return [];
      this.configureHostedProcessor(
        specification.tag,
        device,
        host,
        firmware,
        sinks,
      );
      return [{
        tag: specification.tag,
        clock: device.cycleClock(),
        run: (cycles: number) => {
          device.set('m_icount', cycles);
          device.call('execute_run');
          return cycles - device.get('m_icount');
        },
      }];
    });

    const video = machine.execution.screenUpdate
      ? new GeneratedVideoRenderer(
          machine,
          new GeneratedMameVideoPrimitives(machine, regions, this.state, this.bindings),
        )
      : undefined;
    this.frameRunner = new GeneratedFrameRunner({
      machine,
      processors: [...machine.execution.cpus.map(specification => ({
        tag: specification.tag,
        enabled: () => !this.cpuHeld.get(specification.tag),
        run: (cycles: number) => {
          const executed = this.cpus.get(specification.tag)!.run(cycles);
          this.cpuCycles.set(
            specification.tag,
            (this.cpuCycles.get(specification.tag) ?? 0) + executed,
          );
          return executed;
        },
      })), ...hostedProcessors],
      onEvent: event => {
        dispatchGeneratedCallback(
          machine,
          event.callbackId,
          event.state,
          this.bindings,
          callbackEndpoints,
        );
      },
      onLine: line => {
        this.currentLine = line;
        const seconds = 1 /
          (this.machine.execution.screen.refresh * this.machine.execution.screen.vtotal);
        for (const device of this.devices.values()) device.tick(seconds);
      },
      video,
    });
  }

  private configureHostedProcessor(
    tag: string,
    device: Device,
    host: Device,
    firmware: Uint8Array,
    sinks: BoardSinks,
  ): void {
    const dataBits = device.methodNames()
      .map(name => /^data_(\d+)bit$/.exec(name))
      .find((match): match is RegExpExecArray => Boolean(match));
    const ram = new Uint8Array(1 << Number(dataBits?.[1] ?? 7));
    device.bindCall('GETPC', () => (device.get('m_PA') << 6) + device.get('m_PC'));
    device.bindCall('GETEA', () => (device.get('m_X') << 4) + device.get('m_Y'));
    device.bindCall('INCPC', () => {
      const next = device.get('m_PC') + 1;
      if (next >= 0x40) {
        device.set('m_PC', 0);
        device.set('m_PA', device.get('m_PA') + 1);
      } else {
        device.set('m_PC', next);
      }
      return 0;
    });
    device.bindCall('READOP', address => firmware[address & (firmware.length - 1)] ?? 0);
    device.bindCall('RDMEM', address => ram[address & (ram.length - 1)]! & 0x0f);
    device.bindCall('WRMEM', (address, value) => {
      ram[address & (ram.length - 1)] = value & 0x0f;
      return 0;
    });
    for (const [name, member] of [
      ['TEST_ST', 'm_st'],
      ['TEST_ZF', 'm_zf'],
      ['TEST_CF', 'm_cf'],
      ['TEST_VF', 'm_vf'],
      ['TEST_SF', 'm_sf'],
      ['TEST_IF', 'm_if'],
    ]) {
      device.bindCall(name!, () => device.get(member!) & 1);
    }
    device.bindCall('UPDATE_ST_C', value => device.set('m_st', value & 0x10 ? 0 : 1));
    device.bindCall('UPDATE_ST_Z', value => device.set('m_st', value === 0 ? 0 : 1));
    device.bindCall('UPDATE_CF', value => device.set('m_cf', value & 0x10 ? 1 : 0));
    device.bindCall('UPDATE_ZF', value => device.set('m_zf', value !== 0 ? 0 : 1));
    device.bindCall('debugger_instruction_hook', () => 0);
    device.bindCall('standard_irq_callback', () => 0);
    device.bindCall('fatalerror', () => {
      throw new Error(`${tag}: generated hosted processor fatalerror`);
    });

    for (const callback of this.machine.callbacks.filter(candidate =>
      candidate.ownerTag === tag && candidate.targetMethod)) {
      if (!host.methodNames().includes(callback.targetMethod!)) continue;
      device.on(
        callback.signal,
        (...args) => host.call(callback.targetMethod!, ...args),
        callback.slot ?? 0,
      );
    }
    host.bindCall('m_cpu.set_input_line', (_line, state) =>
      device.call('execute_set_input', 0, state));
    host.bindCall('NAMCO_54XX_0_DATA', () => 0);
    host.bindCall('NAMCO_54XX_1_DATA', () => 1);
    host.bindCall('NAMCO_54XX_2_DATA', () => 2);
    host.bindCall('m_discrete.write', (channel, value) => {
      sinks.soundWrite(channel, value, this.soundFraction(), 'discrete');
      return 0;
    });
    if (host.signalNames().includes('irq')) {
      host.on('irq', state => {
        if (state) device.reset();
      });
    }
  }

  frame(framebuffer: Uint32Array): void {
    this.frameRunner.frame(framebuffer);
  }

  reset(): void {
    for (const device of this.devices.values()) device.reset();
    for (const cpu of this.cpus.values()) cpu.reset();
    for (const tag of this.cpuCycles.keys()) this.cpuCycles.set(tag, 0);
    this.frameRunner.reset();
    this.currentLine = 0;
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
          if (!key) continue;
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
    const customsByPort = new Map<string, NonNullable<BoardConfig['customs']>>();
    for (const custom of config.customs ?? []) {
      const entries = customsByPort.get(custom.port) ?? [];
      entries.push(custom);
      customsByPort.set(custom.port, entries);
    }
    for (const [port, customs] of customsByPort) {
      const key = `port.${port}`;
      const base = registry.read[key] ?? (() => inputs.read(port));
      registry.read[key] = (address, offset) => {
        let value = base(address, offset);
        for (const custom of customs) {
          const handler = machine.handlers?.find(candidate =>
            custom.handler
              ? `${candidate.ownerClass}.${candidate.method}` === custom.handler
              : candidate.method === custom.member);
          if (!handler?.program || handler.program.diagnostics.length) continue;
          const result = executeGeneratedMachineHandler(
            machine,
            handler,
            this.bindings,
            {},
          ) ?? 0;
          const shift = trailingZeroBits(custom.mask);
          value = (value & ~custom.mask) | ((result << shift) & custom.mask);
        }
        return value & 0xff;
      };
    }
    for (const key of usedHandlers(machine, 'write')) {
      if (registry.write[key]) continue;
      if (key.startsWith('watchdog.')) registry.write[key] = () => {};
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

  private installInterruptVectorWriters(
    machine: GeneratedMachine,
    registry: HandlerRegistry,
  ): void {
    const cpuTagsByWriter = new Map<string, string[]>();
    for (const cpu of machine.execution.cpus) {
      for (const writer of cpu.interruptVectorWriters ?? []) {
        const tags = cpuTagsByWriter.get(writer) ?? [];
        tags.push(cpu.tag);
        cpuTagsByWriter.set(writer, tags);
      }
    }
    for (const [writer, cpuTags] of cpuTagsByWriter) {
      const original = registry.write[writer];
      if (!original) continue;
      registry.write[writer] = (address, offset, data) => {
        original(address, offset, data);
        for (const cpuTag of cpuTags) {
          this.cpus.get(cpuTag)?.setIrqLine(false);
        }
      };
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
          sinks.soundWrite(chip * 16 + register, data, this.soundFraction());
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
      const filterRows: unknown[][] = [];
      for (const route of sound.routes ?? []) {
        if (!route.filter) continue;
        const { bank, channel, index } = route.filter;
        const row = (filterRows[bank] ??= []);
        if (row[channel]) continue;
        let previous: number[] | undefined;
        row[channel] = {
          filter_rc_set_RC: (type: number, r1: number, r2: number, r3: number, c: number) => {
            const values = [type, r1, r2, r3, c];
            if (previous?.every((value, position) => value === values[position])) return;
            previous = values;
            const base = AY_FILTER_CONTROL_BASE + index * AY_FILTER_CONTROL_STRIDE;
            values.forEach((value, parameter) =>
              sinks.soundWrite(base + parameter, value, this.soundFraction()));
          },
        };
      }
      if (filterRows.length) this.state.m_filter = filterRows;
      return;
    }
    for (const method of sound.writeMethods) {
      const key = `${sound.deviceTag}.${method}`;
      registry.write[key] = (_address, offset, data) => {
        // Raw register offset plus the method name: worklets route by name,
        // so no offset-numbering convention exists between the two sides.
        sinks.soundWrite(offset, data, this.soundFraction(), method);
      };
    }
  }

  private soundFraction(): number {
    return this.currentLine / this.machine.execution.screen.vtotal;
  }

  private callbackEndpoints(sinks: BoardSinks): Record<string, (state: number) => number | void> {
    const endpoints: Record<string, (state: number) => number | void> = {};
    for (const port of new Set(this.machine.callbacks.flatMap(callback =>
      callback.targetPort ? [callback.targetPort] : []))) {
      endpoints[`port.${port}`] = () => this.bindings.inputs?.read(port) ?? 0xff;
    }
    for (const callback of this.machine.callbacks) {
      if (!callback.targetTag) continue;
      const target = callback.inputLine
        ? `${callback.targetTag}.${callback.inputLine}`
        : callback.targetMethod
          ? `${callback.targetTag}.${callback.targetMethod}`
          : undefined;
      const device = this.devices.get(callback.targetTag);
      if (target && callback.targetMethod && device?.methodNames().includes(callback.targetMethod)) {
        endpoints[target] = state => device.call(callback.targetMethod!, state);
      }
      const cpu = this.cpus.get(callback.targetTag);
      if (cpu && callback.inputLine) {
        endpoints[target!] = state => {
          if (callback.inputLine === 'INPUT_LINE_NMI' && state) cpu.nmi();
          else if (callback.inputLine === 'INPUT_LINE_RESET') {
            this.cpuHeld.set(callback.targetTag!, Boolean(state));
            if (state) cpu.reset();
          } else {
            cpu.setIrqLine(state !== 0);
          }
        };
      }
      if (target && callback.targetTag === 'speaker') {
        endpoints[target!] = state =>
          sinks.soundWrite(callback.slot ?? 0, state, this.soundFraction());
      }
      const sound = this.machine.sound;
      if (
        sound &&
        callback.targetTag === sound.deviceTag &&
        callback.targetMethod &&
        sound.enableMethods.includes(callback.targetMethod)
      ) {
        endpoints[target!] = state =>
          sinks.soundWrite(sound.controlOffset, state, this.soundFraction());
      }
      if (
        sound &&
        callback.targetMethod === 'mute_w'
      ) {
        endpoints[target!] = state => sinks.soundWrite(-1, state, this.soundFraction());
      }
    }
    return endpoints;
  }
}

function trailingZeroBits(value: number): number {
  if (!value) return 0;
  let count = 0;
  while (((value >>> count) & 1) === 0) count++;
  return count;
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
