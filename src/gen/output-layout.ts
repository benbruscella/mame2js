import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const GAME_CATEGORIES = ['arcade', 'consoles'] as const;
export type GameCategory = (typeof GAME_CATEGORIES)[number];

export function gameCategory(kind: unknown): GameCategory {
  return kind === 'arcade' ? 'arcade' : 'consoles';
}

export function gamesRoot(outRoot: string): string {
  return join(outRoot, 'games');
}

export function gameOutputDir(
  outRoot: string,
  category: GameCategory,
  game: string,
): string {
  return join(gamesRoot(outRoot), category, game);
}

export function existingGameOutputDir(
  outRoot: string,
  game: string,
): string | undefined {
  return GAME_CATEGORIES
    .map(category => gameOutputDir(outRoot, category, game))
    .find(candidate => existsSync(candidate));
}

export function gameDataPath(category: GameCategory, game: string): string {
  return `games/${category}/${game}`;
}

export interface GeneratedGameOutput {
  category: GameCategory;
  game: string;
  dir: string;
}

export function generatedGameOutputs(outRoot: string): GeneratedGameOutput[] {
  return GAME_CATEGORIES.flatMap(category => {
    const categoryDir = join(gamesRoot(outRoot), category);
    if (!existsSync(categoryDir)) return [];
    return readdirSync(categoryDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        category,
        game: entry.name,
        dir: gameOutputDir(outRoot, category, entry.name),
      }));
  }).sort((a, b) => a.game.localeCompare(b.game));
}
