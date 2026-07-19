import type { VideoRenderer } from './types.ts';
import type { GeneratedMachine } from './generated-machine.ts';
import {
  executeGeneratedCallbackHandler,
  type GeneratedHandlerBindings,
} from './generated-handler.ts';

export interface GeneratedVideoPrimitives extends VideoRenderer {
  generatedVideoBindings(frame: Uint32Array): GeneratedHandlerBindings;
  generatedVideoArgs?(frame: Uint32Array): Record<string, unknown>;
}

/**
 * Compose reusable renderer primitives by executing the screen-update method
 * compiled from the selected MAME driver.
 */
export class GeneratedVideoRenderer implements VideoRenderer {
  readonly width: number;
  readonly height: number;

  private readonly machine: GeneratedMachine;
  private readonly primitives: GeneratedVideoPrimitives;
  private readonly screenUpdate: NonNullable<GeneratedMachine['callbacks']>[number];

  constructor(machine: GeneratedMachine, primitives: GeneratedVideoPrimitives) {
    const screenUpdate = machine.callbacks.find(callback =>
      callback.signal === 'set_screen_update');
    if (!screenUpdate) {
      throw new Error(`generated machine "${machine.game}" has no screen-update callback`);
    }
    this.machine = machine;
    this.primitives = primitives;
    this.screenUpdate = screenUpdate;
    this.width = primitives.width;
    this.height = primitives.height;
  }

  vblank(): void {
    this.primitives.vblank();
  }

  render(frame: Uint32Array): void {
    const cliprect = {
      min_x: 0,
      max_x: this.width - 1,
      min_y: 0,
      max_y: this.height - 1,
    };
    const bitmap = {
      fill: (color: number) => frame.fill(color >>> 0),
      'pix=': (y: number, x: number, color: number) => {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          frame[y * this.width + x] = color >>> 0;
        }
      },
    };
    const screen = { visible_area: () => cliprect };
    const result = executeGeneratedCallbackHandler(
      this.machine,
      this.screenUpdate,
      this.primitives.generatedVideoBindings(frame),
      {
        screen,
        bitmap,
        cliprect,
        ...this.primitives.generatedVideoArgs?.(frame),
      },
    );
    if (result === undefined) {
      const key = `${this.screenUpdate.targetClass}.${this.screenUpdate.targetMethod}`;
      throw new Error(`generated screen-update handler "${key}" is not executable`);
    }
  }
}
