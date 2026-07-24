import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGameAcceptance } from './acceptance-harness.ts';
import { supportedGameContracts } from './contracts.ts';

export async function verifySupportedGames(): Promise<void> {
  for (const contract of supportedGameContracts) {
    await runIsolated(contract.game);
  }
}

async function verifyGame(game: string): Promise<void> {
  const contract = supportedGameContracts.find(candidate => candidate.game === game);
  if (!contract) throw new Error(`unknown supported game: ${game}`);
  await runGameAcceptance(contract);
  console.log(`${contract.game}: ROM/input/video/audio/timing contract passed`);
}

async function runIsolated(game: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), game], {
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${game}: isolated acceptance exited ${code ?? `from signal ${signal}`}`,
      ));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const game = process.argv[2];
  if (game) await verifyGame(game);
  else await verifySupportedGames();
}
