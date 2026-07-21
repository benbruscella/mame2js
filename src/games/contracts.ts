import { pacman } from './pacman.ts';
import { pooyan } from './pooyan.ts';
import { timeplt } from './timeplt.ts';

export const supportedGameContracts = [pacman, pooyan, timeplt] as const;
