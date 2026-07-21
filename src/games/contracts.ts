import { pacman } from './pacman.ts';
import { pooyan } from './pooyan.ts';
import { timeplt } from './timeplt.ts';
import { invaders } from './invaders.ts';

export const supportedGameContracts = [pacman, pooyan, timeplt, invaders] as const;
