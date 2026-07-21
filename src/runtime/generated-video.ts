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
    const xOffset = this.machine.execution.screen.xOffset ?? 0;
    const yOffset = this.machine.execution.screen.yOffset ?? 0;
    this.renderRegion(frame, yOffset, yOffset + this.height - 1);
  }

  renderLine(frame: Uint32Array, line: number): void {
    const yOffset = this.machine.execution.screen.yOffset ?? 0;
    if (line < yOffset || line >= yOffset + this.height) return;
    this.renderRegion(frame, line, line);
  }

  private renderRegion(frame: Uint32Array, minY: number, maxY: number): void {
    const xOffset = this.machine.execution.screen.xOffset ?? 0;
    const yOffset = this.machine.execution.screen.yOffset ?? 0;
    const cliprect = {
      min_x: xOffset,
      max_x: xOffset + this.width - 1,
      min_y: minY,
      max_y: maxY,
    };
    const bitmap = {
      fill: (color: number) => {
        const packed = color >>> 0;
        for (let y = minY; y <= maxY; y++) {
          const start = (y - yOffset) * this.width;
          frame.fill(packed, start, start + this.width);
        }
      },
      'pix=': (y: number, x: number, color: number) => {
        const visibleX = x - xOffset;
        const visibleY = y - yOffset;
        if (
          visibleX >= 0 && visibleX < this.width &&
          visibleY >= 0 && visibleY < this.height
        ) {
          frame[visibleY * this.width + visibleX] = color >>> 0;
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

export function createGeneratedTileInfoTarget(tile: TileInfo): {
  category: number;
  set(gfx: number, code: number, color: number, flags: number): void;
} {
  return {
    get category(): number {
      return tile.category;
    },
    set category(value: number) {
      tile.category = Number(value) & 0x0f;
    },
    set(gfx: number, code: number, color: number, flags: number): void {
      Object.assign(tile, { gfx, code, color, flags });
    },
  };
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

  constructor(plan: GeneratedPromPalettePlan, regions: Regions) {
    const prom = regions[plan.region];
    if (!prom) throw new Error(`generated palette: missing ROM region "${plan.region}"`);
    const weights = computeWeights(plan);
    const core = new Uint32Array(plan.colorCount);
    for (let index = 0; index < core.length; index++) {
      const rgb = { r: 0, g: 0, b: 0 };
      for (const channel of plan.channels) {
        const values = weights[channel.channel];
        let value = 0;
        for (let bit = 0; bit < channel.bits.length; bit++) {
          const source = prom[index + (channel.offsets?.[bit] ?? 0)] ?? 0;
          value += values[bit]! * ((source >> channel.bits[bit]!) & 1);
        }
        rgb[channel.channel] = Math.floor(value + 0.5);
      }
      core[index] = packRgb(rgb.r, rgb.g, rgb.b);
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

  transpen_mask(gfx: GeneratedGfxElement, color: number, transparent: number): number {
    let mask = 0;
    const base = gfx.entry.colorBase + color * gfx.granularity;
    for (let pen = 0; pen < gfx.granularity; pen++) {
      if (this.indirect[base + pen] === transparent) mask |= 1 << pen;
    }
    return mask;
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
  private readonly tiles: Array<TileInfo | undefined> = [];
  private readonly dirty: number[] = [];
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

  mark_tile_dirty(index: number): void {
    if (Number.isInteger(index) && index >= 0) this.dirty[index] = 1;
  }

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
    const members = this.bindings().members ?? {};
    const globalFlip = Number(members.__flip_screen ?? 0) ? 3 : 0;
    const mapFlip = this.flip | globalFlip;
    const flipX = Boolean(mapFlip & 1);
    const flipY = Boolean(mapFlip & 2);
    const firstOutputRow = Math.max(0, Math.floor(clip.min_y / this.plan.tileHeight));
    const lastOutputRow = Math.min(
      this.plan.rows - 1,
      Math.floor(clip.max_y / this.plan.tileHeight),
    );
    const firstOutputColumn = Math.max(0, Math.floor(clip.min_x / this.plan.tileWidth));
    const lastOutputColumn = Math.min(
      this.plan.columns - 1,
      Math.floor(clip.max_x / this.plan.tileWidth),
    );
    for (let outputRow = firstOutputRow; outputRow <= lastOutputRow; outputRow++) {
      const row = flipY ? this.plan.rows - 1 - outputRow : outputRow;
      for (
        let outputColumn = firstOutputColumn;
        outputColumn <= lastOutputColumn;
        outputColumn++
      ) {
        const column = flipX ? this.plan.columns - 1 - outputColumn : outputColumn;
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
        const tileIndex = generatedTileMemoryIndex(mapped);
        let tile = this.tiles[tileIndex];
        const needsUpdate = !tile || this.dirty[tileIndex] === 1;
        if (!tile) {
          tile = { gfx: 0, code: 0, color: 0, flags: 0, category: 0 };
          this.tiles[tileIndex] = tile;
        }
        if (needsUpdate) {
          Object.assign(tile, { gfx: 0, code: 0, color: 0, flags: 0, category: 0 });
          const tileinfo = createGeneratedTileInfoTarget(tile);
          executeGeneratedMachineProgram(
            this.machine,
            this.tileInfo,
            this.bindings(),
            { tilemap: this, tileinfo, tile_index: tileIndex },
          );
          this.dirty[tileIndex] = 0;
        }
        if (tile.category !== (_flags & 0xff)) continue;
        const gfx = this.gfx[tile.gfx];
        if (!gfx) continue;
        const tileFlipX = Boolean(tile.flags & 1) !== flipX;
        const tileFlipY = Boolean(tile.flags & 2) !== flipY;
        const x = outputColumn * this.plan.tileWidth;
        const y = outputRow * this.plan.tileHeight;
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

export function generatedTileMemoryIndex(mapped: unknown): number {
  const index = Number(mapped);
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`generated tile mapper returned invalid memory index ${String(mapped)}`);
  }
  return index;
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
    this.palette = new GeneratedPalette(machine.video.palette, regions);
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

  render(_frame: Uint32Array): void {}

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
      raw[channel.channel] = [...channel.weights];
      maximum = Math.max(
        maximum,
        channel.weights.reduce((sum, value) => sum + value, 0),
      );
      continue;
    }
    const values = channel.resistances.map((_, selected) => {
      let r0 = channel.pulldown ? 1 / channel.pulldown : 1 / 1e12;
      let r1 = channel.pullup ? 1 / channel.pullup : 1 / 1e12;
      for (let index = 0; index < channel.resistances.length; index++) {
        const resistance = channel.resistances[index]!;
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
  const scale = plan.scaler < 0 ? plan.max / maximum : plan.scaler;
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
