import { pacman } from './pacman.ts';
import { pooyan } from './pooyan.ts';
import { timeplt } from './timeplt.ts';
import { invaders } from './invaders.ts';
import { galaxian } from './galaxian.ts';
import { galaga } from './galaga.ts';
import { digdug } from './digdug.ts';
import { mpatrol } from './mpatrol.ts';
import { rocnrope } from './rocnrope.ts';
import { junofrst } from './junofrst.ts';
import { gyruss } from './gyruss.ts';

export const supportedGameContracts = [
  pacman,
  pooyan,
  timeplt,
  invaders,
  galaxian,
  galaga,
  digdug,
  mpatrol,
  rocnrope,
  junofrst,
  gyruss,
] as const;
