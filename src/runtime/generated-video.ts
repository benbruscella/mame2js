import type { VideoRenderer } from './types.ts';
import type { Regions, VideoRenderer as Renderer } from './types.ts';
import type {
  GeneratedGfxEntry,
  GeneratedHandler,
  GeneratedMachine,
  GeneratedPromPalettePlan,
  GeneratedTilemapPlan,
} from './generated-machine.ts';
import {
  executeGeneratedCallbackHandler,
  executeGeneratedMachineProgram,
  type GeneratedHandlerBindings,
} from './generated-handler.ts';
import { decodeGfx, type GfxSet } from './gfx.ts';

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
  private readonly visibleMinX: number;
  private readonly visibleMinY: number;

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
    this.visibleMinX = machine.execution.screen.visibleMinX ?? 0;
    this.visibleMinY = machine.execution.screen.visibleMinY ?? 0;
  }

  vblank(): void {
    this.primitives.vblank();
  }

  render(frame: Uint32Array): void {
    if (this.machine.video?.bitmap) {
      this.primitives.render(frame);
      return;
    }
    const cliprect = {
      min_x: this.visibleMinX,
      max_x: this.visibleMinX + this.width - 1,
      min_y: this.visibleMinY,
      max_y: this.visibleMinY + this.height - 1,
    };
    const bitmap = {
      fill: (color: number) => frame.fill(color >>> 0),
      'pix=': (y: number, x: number, color: number) => {
        const targetX = x - this.visibleMinX;
        const targetY = y - this.visibleMinY;
        if (targetX >= 0 && targetX < this.width && targetY >= 0 && targetY < this.height) {
          frame[targetY * this.width + targetX] = color >>> 0;
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

interface BitmapTarget {
  fill(color: number): void;
  'pix='(y: number, x: number, color: number): void;
}

interface TileInfo {
  gfx: number;
  code: number;
  color: number;
  flags: number;
  category: number;
}

class GeneratedRectangle {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;

  constructor(minX: number, maxX: number, minY: number, maxY: number) {
    this.min_x = minX;
    this.max_x = maxX;
    this.min_y = minY;
    this.max_y = maxY;
  }

  intersect(other: unknown): void {
    if (!other || typeof other !== 'object') return;
    const rectangle = other as GeneratedRectangle;
    this.min_x = Math.max(this.min_x, Number(rectangle.min_x));
    this.max_x = Math.min(this.max_x, Number(rectangle.max_x));
    this.min_y = Math.max(this.min_y, Number(rectangle.min_y));
    this.max_y = Math.min(this.max_y, Number(rectangle.max_y));
  }
}

class GeneratedPalette {
  readonly colors: Uint32Array;
  readonly indirect: Uint16Array;
  private readonly transparentIndirect: number;
  private readonly plan: GeneratedPromPalettePlan;
  private readonly weights: ReturnType<typeof computeWeights>;
  private readonly ram?: Uint8Array;

  constructor(
    plan: GeneratedPromPalettePlan,
    regions: Regions,
    state: Record<string, unknown>,
  ) {
    this.plan = plan;
    this.weights = computeWeights(plan);
    if (plan.kind === 'fixed') {
      this.colors = Uint32Array.from(plan.colors ?? []);
      this.indirect = Uint16Array.from(
        Array.from({ length: this.colors.length }, (_, index) => index),
      );
      this.transparentIndirect = plan.transparentIndirect;
      return;
    }
    if (plan.kind === 'ram') {
      const share = plan.share ?? 'palette';
      this.ram = state[`m_${share}`] as Uint8Array | undefined;
      if (!this.ram) throw new Error(`generated palette: missing RAM share "${share}"`);
      this.colors = new Uint32Array(plan.colorCount);
      this.indirect = new Uint16Array(plan.colorCount);
      for (let index = 0; index < plan.colorCount; index++) this.indirect[index] = index;
      this.transparentIndirect = plan.transparentIndirect;
      return;
    }
    const region = plan.region;
    const prom = region ? regions[region] : undefined;
    if (!prom) throw new Error(`generated palette: missing ROM region "${region ?? ''}"`);
    const core = new Uint32Array(plan.colorCount);
    for (let index = 0; index < core.length; index++) {
      core[index] = this.color(index, prom);
    }
    const penCount = Math.max(
      1,
      ...plan.banks.map(bank => bank.penOffset + (bank.lookupCount ?? plan.lookupCount)),
    );
    this.colors = new Uint32Array(penCount);
    this.indirect = new Uint16Array(penCount);
    for (const bank of plan.banks) {
      const lookupOffset = bank.lookupOffset ?? plan.lookupOffset;
      const lookupCount = bank.lookupCount ?? plan.lookupCount;
      for (let index = 0; index < lookupCount; index++) {
        const indirect = bank.colorOr |
          ((prom[lookupOffset + index] ?? 0) & plan.lookupMask);
        const pen = bank.penOffset + index;
        this.indirect[pen] = indirect;
        this.colors[pen] = core[indirect] ?? 0xff000000;
      }
    }
    this.transparentIndirect = plan.transparentIndirect;
  }

  pen_color(index: number): number {
    if (this.ram) return this.color(index, this.ram);
    return this.colors[index] ?? 0xff000000;
  }

  transpen_mask(gfx: GeneratedGfxElement, color: number, transparent: number): number {
    let mask = 0;
    const base = gfx.entry.colorBase + color * gfx.granularity;
    for (let pen = 0; pen < gfx.granularity; pen++) {
      if (this.indirect[base + pen] === transparent) mask |= 1 << pen;
    }
    return mask;
  }

  private color(index: number, bytes: Uint8Array): number {
    const rgb = { r: 0, g: 0, b: 0 };
    for (const channel of this.plan.channels) {
      const values = this.weights[channel.channel];
      let value = 0;
      for (let bit = 0; bit < channel.bits.length; bit++) {
        const offset = channel.offsets?.[bit] ?? 0;
        value += values[bit]! * ((bytes[index + offset]! >> channel.bits[bit]!) & 1);
      }
      rgb[channel.channel] = Math.floor(value + 0.5);
    }
    return packRgb(rgb.r, rgb.g, rgb.b);
  }
}

class GeneratedGfxElement {
  readonly entry: GeneratedGfxEntry;
  readonly decoded: GfxSet;
  readonly granularity: number;
  private readonly palette: GeneratedPalette;

  constructor(entry: GeneratedGfxEntry, decoded: GfxSet, palette: GeneratedPalette) {
    this.entry = entry;
    this.decoded = decoded;
    this.granularity = 1 << entry.layout.planes;
    this.palette = palette;
  }

  transmask(
    bitmap: BitmapTarget,
    clip: GeneratedRectangle,
    code: number,
    color: number,
    flipX: number,
    flipY: number,
    sx: number,
    sy: number,
    transparentMask: number,
  ): void {
    this.draw(bitmap, clip, code, color, flipX, flipY, sx, sy, transparentMask);
  }

  transpen(
    bitmap: BitmapTarget,
    clip: GeneratedRectangle,
    code: number,
    color: number,
    flipX: number,
    flipY: number,
    sx: number,
    sy: number,
    transparentPen: number,
  ): void {
    this.draw(bitmap, clip, code, color, flipX, flipY, sx, sy, 1 << transparentPen);
  }

  draw(
    bitmap: BitmapTarget,
    clip: GeneratedRectangle,
    code: number,
    color: number,
    flipX: number,
    flipY: number,
    sx: number,
    sy: number,
    transparentMask = 0,
  ): void {
    const gfx = this.decoded;
    const element = modulo(code, gfx.count);
    const base = element * gfx.width * gfx.height;
    const colorBase = this.entry.colorBase + color * this.granularity;
    for (let py = 0; py < gfx.height; py++) {
      const y = sy + py * this.entry.yscale;
      if (y < clip.min_y || y > clip.max_y) continue;
      const sourceY = flipY ? gfx.height - 1 - py : py;
      for (let px = 0; px < gfx.width; px++) {
        const x = sx + px * this.entry.xscale;
        if (x < clip.min_x || x > clip.max_x) continue;
        const sourceX = flipX ? gfx.width - 1 - px : px;
        const pen = gfx.pixels[base + sourceY * gfx.width + sourceX]!;
        if (transparentMask & (1 << pen)) continue;
        const packed = this.palette.colors[colorBase + pen] ?? 0xff000000;
        for (let yy = 0; yy < this.entry.yscale; yy++) {
          for (let xx = 0; xx < this.entry.xscale; xx++) {
            bitmap['pix='](y + yy, x + xx, packed);
          }
        }
      }
    }
  }
}

class GeneratedTilemap {
  private readonly plan: GeneratedTilemapPlan;
  private readonly mapper?: GeneratedHandler;
  private readonly tileInfo: GeneratedHandler;
  private readonly machine: GeneratedMachine;
  private readonly bindings: () => GeneratedHandlerBindings;
  private readonly gfx: GeneratedGfxElement[];
  private flip = 0;

  constructor(
    plan: GeneratedTilemapPlan,
    machine: GeneratedMachine,
    bindings: () => GeneratedHandlerBindings,
    gfx: GeneratedGfxElement[],
  ) {
    this.plan = plan;
    this.machine = machine;
    this.bindings = bindings;
    this.gfx = gfx;
    this.mapper = standardMapper(plan.mapper)
      ? undefined
      : requiredHandler(machine, plan.mapper);
    this.tileInfo = requiredHandler(machine, plan.tileInfo);
  }

  mark_tile_dirty(_index: number): void {}

  set_flip(flags: number): void {
    this.flip = flags;
  }

  draw(
    _screen: unknown,
    bitmap: BitmapTarget,
    clip: GeneratedRectangle,
    _flags: number,
    _priority: number,
  ): void {
    for (let row = 0; row < this.plan.rows; row++) {
      for (let column = 0; column < this.plan.columns; column++) {
        const mapped = this.mapper
          ? executeGeneratedMachineProgram(
              this.machine,
              this.mapper,
              this.bindings(),
              {
                col: column,
                row,
                num_cols: this.plan.columns,
                num_rows: this.plan.rows,
              },
            ).value
          : mapStandardTile(this.plan.mapper, column, row, this.plan.columns, this.plan.rows);
        const tile: TileInfo = { gfx: 0, code: 0, color: 0, flags: 0, category: 0 };
        const tileinfo = {
          set: (gfx: number, code: number, color: number, flags: number) => {
            Object.assign(tile, { gfx, code, color, flags });
          },
          get category() {
            return tile.category;
          },
          set category(value: number) {
            tile.category = value;
          },
        };
        executeGeneratedMachineProgram(
          this.machine,
          this.tileInfo,
          this.bindings(),
          { tilemap: this, tileinfo, tile_index: Number(mapped) || 0 },
        );
        if (tile.category !== (_flags & 0xff)) continue;
        const gfx = this.gfx[tile.gfx];
        if (!gfx) continue;
        const members = this.bindings().members ?? {};
        const globalFlip = Number(members.__flip_screen ?? 0)
          ? 3
          : Number(members.__flip_screen_x ?? 0) |
            (Number(members.__flip_screen_y ?? 0) << 1);
        const mapFlip = this.flip | globalFlip;
        const flipX = Boolean(mapFlip & 1);
        const flipY = Boolean(mapFlip & 2);
        const tileFlipX = Boolean(tile.flags & 1) !== flipX;
        const tileFlipY = Boolean(tile.flags & 2) !== flipY;
        const x = (flipX ? this.plan.columns - 1 - column : column) * this.plan.tileWidth;
        const y = (flipY ? this.plan.rows - 1 - row : row) * this.plan.tileHeight;
        gfx.draw(
          bitmap,
          clip,
          tile.code,
          tile.color,
          Number(tileFlipX),
          Number(tileFlipY),
          x,
          y,
        );
      }
    }
  }
}

/**
 * Hardware-neutral MAME video services. All layouts, palette wiring,
 * tile callbacks, sprite loops and initial state come from generated IR.
 */
export class GeneratedMameVideoPrimitives implements GeneratedVideoPrimitives, Renderer {
  readonly width: number;
  readonly height: number;
  private readonly machine: GeneratedMachine;
  private readonly state: Record<string, unknown>;
  private readonly gfx: GeneratedGfxElement[];
  private readonly palette: GeneratedPalette;
  private readonly bindings: GeneratedHandlerBindings;

  constructor(
    machine: GeneratedMachine,
    regions: Regions,
    state: Record<string, unknown>,
    bindings: GeneratedHandlerBindings,
  ) {
    if (!machine.video) throw new Error(`${machine.game}: generated video plan is missing`);
    this.machine = machine;
    this.state = state;
    this.width = machine.execution.screen.width;
    this.height = machine.execution.screen.height;
    for (const [member, value] of Object.entries(machine.video.initialState)) {
      if (!Object.hasOwn(state, member)) state[member] = value;
    }
    this.palette = new GeneratedPalette(machine.video.palette, regions, state);
    this.gfx = machine.video.gfx.map(entry => {
      const region = regions[entry.region];
      if (!region) throw new Error(`${machine.game}: missing gfx region "${entry.region}"`);
      return new GeneratedGfxElement(
        entry,
        decodeGfx(entry.layout, region, entry.offset),
        this.palette,
      );
    });
    const referenceCalls: NonNullable<GeneratedHandlerBindings['referenceCalls']> = {
      ...bindings.referenceCalls,
      rectangle: (...args) => new GeneratedRectangle(
        Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]),
      ),
    };
    this.bindings = {
      ...bindings,
      calls: {
        ...bindings.calls,
        flip_screen: () => Number(state.__flip_screen ?? 0),
        flip_screen_set: value => {
          state.__flip_screen = value ? 1 : 0;
        },
        flip_screen_x_set: value => {
          state.__flip_screen_x = value ? 1 : 0;
        },
        flip_screen_y_set: value => {
          state.__flip_screen_y = value ? 1 : 0;
        },
      },
      members: state,
      referenceCalls,
    };
    state.m_gfxdecode = { gfx: (index: number) => this.gfx[index] };
    state.m_palette = this.palette;
    for (const plan of machine.video.tilemaps) {
      state[plan.member] = new GeneratedTilemap(
        plan,
        machine,
        () => this.bindings,
        this.gfx,
      );
    }
  }

  generatedVideoBindings(_frame: Uint32Array): GeneratedHandlerBindings {
    return this.bindings;
  }

  render(frame: Uint32Array): void {
    const plan = this.machine.video?.bitmap;
    if (!plan) return;
    const video = this.state[`m_${plan.share}`] as Uint8Array | undefined;
    if (!video) throw new Error(`${this.machine.game}: missing bitmap share "${plan.share}"`);
    frame.fill(0xff000000);
    const visibleMinX = this.machine.execution.screen.visibleMinX ?? 0;
    const visibleMinY = this.machine.execution.screen.visibleMinY ?? 0;
    const flipX = Number(this.state[plan.flipXMember ?? ''] ?? 0) ? 0xff : 0;
    const flipY = Number(this.state[plan.flipYMember ?? ''] ?? 0) ? 0xff : 0;
    const scroll = plan.scrollMember
      ? this.state[plan.scrollMember] as Uint8Array | number | undefined
      : undefined;
    const scrollValue = typeof scroll === 'number' ? scroll : scroll?.[0] ?? 0;
    for (let targetY = 0; targetY < this.height; targetY++) {
      const y = targetY + visibleMinY;
      for (let logicalX = 0; logicalX < plan.logicalWidth; logicalX++) {
        const dataX = logicalX - (plan.dataXOffset ?? 0);
        const effectiveX = dataX < 0 ? -1 : (dataX ^ flipX) & 0xff;
        const yscroll = effectiveX < (plan.scrollColumns ?? 0) ? scrollValue : 0;
        const effectiveY = (((y + (plan.dataYOffset ?? 0)) ^ flipY) + yscroll) & 0xff;
        const packed = effectiveX < 0
          ? 0
          : video[effectiveY * plan.bytesPerRow +
            Math.floor(effectiveX / plan.pixelsPerByte)] ?? 0;
        const pixelInByte = effectiveX < 0 ? 0 : effectiveX % plan.pixelsPerByte;
        const shift = plan.lowPixelFirst
          ? pixelInByte * plan.bitsPerPixel
          : (plan.pixelsPerByte - 1 - pixelInByte) * plan.bitsPerPixel;
        const pen = effectiveX < 0
          ? 0
          : (packed >>> shift) & ((1 << plan.bitsPerPixel) - 1);
        const color = this.palette.pen_color(pen);
        const physicalX = logicalX * plan.xscale - visibleMinX;
        for (let repeat = 0; repeat < plan.xscale; repeat++) {
          const targetX = physicalX + repeat;
          if (targetX >= 0 && targetX < this.width) {
            frame[targetY * this.width + targetX] = color;
          }
        }
      }
    }
  }

  vblank(): void {}
}

function requiredHandler(machine: GeneratedMachine, key: string): GeneratedHandler {
  const handler = machine.handlers?.find(candidate =>
    `${candidate.ownerClass}.${candidate.method}` === key &&
    candidate.program &&
    candidate.program.diagnostics.length === 0);
  if (!handler) throw new Error(`${machine.game}: generated video handler "${key}" is not executable`);
  return handler;
}

function standardMapper(key: string): boolean {
  return key === 'TILEMAP_SCAN_ROWS' || key === 'TILEMAP_SCAN_COLS';
}

function mapStandardTile(
  key: string,
  column: number,
  row: number,
  columns: number,
  rows: number,
): number {
  if (key === 'TILEMAP_SCAN_ROWS') return row * columns + column;
  if (key === 'TILEMAP_SCAN_COLS') return column * rows + row;
  return 0;
}

function computeWeights(
  plan: GeneratedPromPalettePlan,
): Record<'r' | 'g' | 'b', number[]> {
  const raw: Record<'r' | 'g' | 'b', number[]> = { r: [], g: [], b: [] };
  let maximum = 0;
  for (const channel of plan.channels) {
    if (channel.weights) {
      raw[channel.channel] = channel.weights;
      maximum = Math.max(
        maximum,
        channel.weights.reduce((sum, value) => sum + value, 0),
      );
      continue;
    }
    const resistances = channel.resistances ?? [];
    const values = resistances.map((_, selected) => {
      let r0 = channel.pulldown ? 1 / channel.pulldown : 1 / 1e12;
      let r1 = channel.pullup ? 1 / channel.pullup : 1 / 1e12;
      for (let index = 0; index < resistances.length; index++) {
        const resistance = resistances[index]!;
        if (!resistance) continue;
        if (index === selected) r1 += 1 / resistance;
        else r0 += 1 / resistance;
      }
      r0 = 1 / r0;
      r1 = 1 / r1;
      return Math.min(
        plan.max,
        Math.max(plan.min, (plan.max - plan.min) * r0 / (r1 + r0) + plan.min),
      );
    });
    raw[channel.channel] = values;
    maximum = Math.max(maximum, values.reduce((sum, value) => sum + value, 0));
  }
  const scale = plan.scaler < 0 && maximum ? plan.max / maximum : plan.scaler;
  for (const channel of ['r', 'g', 'b'] as const) {
    raw[channel] = raw[channel].map(value => value * scale);
  }
  return raw;
}

function packRgb(red: number, green: number, blue: number): number {
  return (0xff000000 | (blue << 16) | (green << 8) | red) >>> 0;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
