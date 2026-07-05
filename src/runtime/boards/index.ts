// Board registry: maps a driver family (from the knowledge graph) to its
// hand-transpiled board module. Adding a game family = adding one entry here.

import type { Board, BoardConfig, BoardSinks, InputPorts, Regions } from '../types.ts';
import { GalagaBoard } from './galaga.ts';
import { PacmanBoard } from './pacman.ts';
import { GalaxianBoard } from './galaxian.ts';

type BoardCtor = new (config: BoardConfig, regions: Regions, inputs: InputPorts, sinks: BoardSinks) => Board;

const FAMILIES: Record<string, BoardCtor> = {
  galaga: GalagaBoard,
  pacman: PacmanBoard,
  galaxian: GalaxianBoard,
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
