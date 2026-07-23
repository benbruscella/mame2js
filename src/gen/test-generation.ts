import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditGenerated } from './audit-generated.ts';
import { REQUIRED_TARGETS } from './targets.ts';
import { gamesManifest } from '../serve.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mameSource = resolve(process.env.MAME_SRC ?? join(projectRoot, '../mame'));
const outRoot = join(projectRoot, 'dist');
const cli = join(projectRoot, 'bin/mamekit.js');

assert.ok(
  existsSync(join(mameSource, 'src/mame')),
  `generation test requires sibling MAME source at ${mameSource}`,
);

rmSync(outRoot, { recursive: true, force: true });

for (const target of REQUIRED_TARGETS) {
  run([target, '--mame-src', mameSource, '--out', outRoot, '--skip-app']);
}
run(['--build-runtime', '--build-app', '--mame-src', mameSource, '--out', outRoot]);

const audit = auditGenerated(outRoot);
assert.deepEqual(audit.failures, [], audit.failures.join('\n'));
assert.equal(audit.targets, REQUIRED_TARGETS.length);
assert.equal(audit.familyAdapters, 0);
assert.ok(audit.executableHardware >= 2);

const registry = readFileSync(
  join(outRoot, 'app/registry.js'),
  'utf8',
);
assert.ok(registry.includes('registerGeneratedCpu'));
assert.ok(registry.includes('registerGeneratedDevice'));
assert.ok(!registry.includes('/src/'));
assert.ok(!existsSync(join(outRoot, 'app/modules')));
assert.ok(existsSync(join(outRoot, 'runtime/core/generated-board.js')));

const games = JSON.parse(
  await gamesManifest(outRoot, join(projectRoot, 'artwork')),
) as {
  game: string;
  supported: boolean;
  generationGaps: string[];
}[];
const blocked = games
  .filter(game => !game.supported)
  .map(game => `${game.game}: ${game.generationGaps.join(', ')}`)
  .sort();
assert.deepEqual(
  blocked,
  [],
  `generated machines are not playable:\n${blocked.join('\n')}`,
);

console.log(
  `clean-generation: ${audit.targets} targets generated from ../mame; ` +
  `${audit.executableHardware} executable hardware definitions; self-contained app passed`,
);

function run(args: string[]): void {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `mamekit ${args.join(' ')} exited with ${result.status}`,
  );
}
