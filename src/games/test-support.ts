import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildGraph, gameSubgraph } from '../kg/build.ts';
import type { KnowledgeGraph } from '../kg/types.ts';
import type { GameTestContract } from './types.ts';

export function mameSourceRoot(): string {
  return resolve(process.env.MAME_SRC ?? '../mame');
}

export function gameSourceGraph(contract: GameTestContract): KnowledgeGraph {
  const mameSrc = mameSourceRoot();
  const driver = join(mameSrc, contract.driver);
  assert.ok(existsSync(driver), `${contract.game}: MAME driver is missing: ${driver}`);
  const graph = gameSubgraph(buildGraph(mameSrc, driver), contract.game);
  const game = graph.nodes.find(node =>
    node.label === 'Game' && node.props.name === contract.game);
  assert.ok(game, `${contract.game}: source graph has no Game node`);
  const machine = graph.nodes.find(node =>
    node.label === 'MachineConfig' &&
    node.props.cls === contract.machine.className &&
    node.props.name === contract.machine.name);
  assert.ok(machine, `${contract.game}: source graph has no selected MachineConfig`);
  assert.equal(graph.meta.driverFile, contract.driver);
  return graph;
}

export function assertGameContract(contract: GameTestContract): void {
  assert.match(contract.game, /^[a-z0-9_]+$/);
  assert.ok(contract.checkpoints.length > 0);
  assert.ok(contract.minimumFps > 0);
  assert.equal(contract.checkpoints.at(-1), contract.frames);
  assert.equal(new Set(contract.checkpoints).size, contract.checkpoints.length);
  assert.ok(contract.golden, `${contract.game}: supported game has no recorded golden`);
  assert.deepEqual(
    Object.keys(contract.golden.checkpoints).map(Number),
    contract.checkpoints,
    `${contract.game}: golden checkpoints do not match its schedule`,
  );
  assert.ok(Object.keys(contract.golden.regions).length > 0);
  assert.ok(contract.golden.audio.writes > 0);
  let previousEnd = 0;
  for (const action of contract.actions) {
    assert.ok(action.atFrame >= previousEnd, `${contract.game}: input actions overlap`);
    assert.ok(action.atFrame + action.heldFrames + action.releasedFrames <= contract.frames);
    previousEnd = action.atFrame + action.heldFrames + action.releasedFrames;
  }
}
