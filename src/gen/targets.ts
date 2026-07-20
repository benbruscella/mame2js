export const REQUIRED_TARGETS = [
  'galaga',
  'digdug',
  'pacman',
  'galaxian',
  'gyruss',
  'invaders',
  'mpatrol',
  'gng',
  'junofrst',
  'rocnrope',
  'pooyan',
  'timeplt',
  'nes',
] as const;

/**
 * A target joins this list only after its generated ROM/input/video/audio
 * acceptance contract passes. Other required targets must remain explicitly
 * blocked until their complete executable closure exists.
 */
export const PLAYABLE_TARGETS = [
  'pacman',
  'gyruss',
  'junofrst',
  'rocnrope',
  'pooyan',
  'timeplt',
] as const;
