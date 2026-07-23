import { pathToFileURL } from 'node:url';
import { runGameAcceptance } from './acceptance-harness.ts';
import { supportedGameContracts } from './contracts.ts';

export async function verifySupportedGames(): Promise<void> {
  for (const contract of supportedGameContracts) {
    await runGameAcceptance(contract);
    console.log(`${contract.game}: ROM/input/video/audio/timing contract passed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifySupportedGames();
}

