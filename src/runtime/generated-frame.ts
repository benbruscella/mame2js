import type { VideoRenderer } from './types.ts';
import type {
  GeneratedFrameEvent,
  GeneratedMachine,
} from './generated-machine.ts';

export interface GeneratedFrameProcessor {
  tag: string;
  run(cycles: number): number;
  enabled?: () => boolean;
}

export interface GeneratedFrameRunnerOptions {
  machine: GeneratedMachine;
  processors: GeneratedFrameProcessor[];
  video?: VideoRenderer;
  eventPhase?: 'before-processors' | 'after-processors';
  onEvent?: (event: GeneratedFrameEvent) => void;
  onLine?: (
    line: number,
    phase: 'before-processors' | 'after-processors',
    framebuffer: Uint32Array,
  ) => void;
}

/**
 * Execute the frame schedule lowered from MAME CPU clocks, screen timing, and
 * callback configuration. Device cores remain reusable runtime primitives;
 * the generated machine owns when they run and when source callbacks fire.
 */
export class GeneratedFrameRunner {
  private readonly machine: GeneratedMachine;
  private readonly processors: {
    processor: GeneratedFrameProcessor;
    cyclesPerLine: number;
    carry: number;
  }[];
  private readonly video?: VideoRenderer;
  private readonly eventPhase: 'before-processors' | 'after-processors';
  private readonly onEvent?: (event: GeneratedFrameEvent) => void;
  private readonly onLine?: GeneratedFrameRunnerOptions['onLine'];
  private readonly eventsByLine = new Map<number, GeneratedFrameEvent[]>();
  private frames = 0;

  constructor(options: GeneratedFrameRunnerOptions) {
    this.machine = options.machine;
    this.video = options.video;
    this.eventPhase = options.eventPhase ?? 'after-processors';
    this.onEvent = options.onEvent;
    this.onLine = options.onLine;
    const clocks = new Map(
      options.machine.execution.cpus.map(cpu => [cpu.tag, cpu.cycleClock ?? cpu.clock]),
    );
    const denominator =
      options.machine.execution.screen.refresh * options.machine.execution.screen.vtotal;
    this.processors = options.processors.map(processor => {
      const clock = clocks.get(processor.tag);
      if (clock === undefined) {
        throw new Error(`generated frame plan has no CPU clock for "${processor.tag}"`);
      }
      return { processor, cyclesPerLine: clock / denominator, carry: 0 };
    });
    for (const event of options.machine.execution.frameEvents) {
      const lineEvents = this.eventsByLine.get(event.line) ?? [];
      lineEvents.push(event);
      this.eventsByLine.set(event.line, lineEvents);
    }
  }

  get frameCount(): number {
    return this.frames;
  }

  get currentCarry(): readonly number[] {
    return this.processors.map(processor => processor.carry);
  }

  reset(): void {
    for (const processor of this.processors) processor.carry = 0;
    this.frames = 0;
  }

  frame(framebuffer: Uint32Array): void {
    const screen = this.machine.execution.screen;
    for (let line = 0; line < screen.vtotal; line++) {
      this.onLine?.(line, 'before-processors', framebuffer);
      if (this.eventPhase === 'before-processors') this.dispatchLine(line);

      for (const scheduled of this.processors) {
        if (scheduled.processor.enabled && !scheduled.processor.enabled()) continue;
        scheduled.carry += scheduled.cyclesPerLine;
        const target = Math.floor(scheduled.carry);
        if (target > 0) scheduled.carry -= scheduled.processor.run(target);
      }

      this.onLine?.(line, 'after-processors', framebuffer);
      if (this.eventPhase === 'after-processors') this.dispatchLine(line);
    }
    this.frames++;
    this.video?.render(framebuffer);
  }

  private dispatchLine(line: number): void {
    for (const event of this.eventsByLine.get(line) ?? []) this.onEvent?.(event);
    if (line === this.machine.execution.screen.vbstart) this.video?.vblank();
  }
}
