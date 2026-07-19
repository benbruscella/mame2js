// Board registry: maps a driver family (from the knowledge graph) to its
// hand-transpiled board module. Adding a game family = adding one entry here.

import type { Board, BoardConfig, BoardSinks, InputPorts, Regions } from '../types.ts';
import { GalagaBoard } from './galaga.ts';
import { DigdugBoard } from './digdug.ts';
import { PacmanBoard } from './pacman.ts';
import { GalaxianBoard } from './galaxian.ts';
import { GyrussBoard } from './gyruss.ts';
import { Mw8080bwBoard } from './mw8080bw.ts';
import { M52Board } from './m52.ts';
import { GngBoard } from './gng.ts';
import { JunofrstBoard } from './junofrst.ts';
import { RocnropeBoard } from './rocnrope.ts';
import { PooyanBoard } from './pooyan.ts';
import { TimepltBoard } from './timeplt.ts';
import { NesBoard } from './nes.ts';

type BoardCtor = new (config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) => Board;

const FAMILIES: Record<string, BoardCtor> = {
  galaga: GalagaBoard,
  digdug: DigdugBoard,
  pacman: PacmanBoard,
  galaxian: GalaxianBoard,
  gyruss: GyrussBoard,
  mw8080bw: Mw8080bwBoard,
  m52: M52Board,
  gng: GngBoard,
  junofrst: JunofrstBoard,
  rocnrope: RocnropeBoard,
  pooyan: PooyanBoard,
  timeplt: TimepltBoard,
  nes: NesBoard,
};

export function registerBoard(family: string, ctor: BoardCtor): void {
  FAMILIES[family] = ctor;
}

export function createBoard(config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks): Board {
  const ctor = FAMILIES[config.family];
  if (!ctor) throw new Error(`no board module for driver family "${config.family}" (have: ${Object.keys(FAMILIES).join(', ')})`);
  return new ctor(config, regions, inputs, sinks);
}

// NOTE: portHandlers lives in ../input.ts — board modules must import it from
// there, not from this registry, or they create an ES-module cycle (registry
// imports board imports registry) that hits the class TDZ at load time.
