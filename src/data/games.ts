// The two games the site covers. Everything that differs per game (name,
// platform, colours, icon, patch data, bug-board filter) reads from here.

export type GameId = 'ds' | '3ds';

export interface Game {
  id: GameId;
  /** Short platform label used on tabs, badges and filters. */
  platform: 'DS' | '3DS';
  /** Title as printed on the game (Japanese). */
  titleJa: string;
  /** Romanised title. */
  titleRomaji: string;
  /** The game's own menu icon, extracted from its ROM (DS banner / 3DS SMDH). */
  icon: string;
  /** Accent colours: deep, mid, light (label gradient + badges). */
  accent: { deep: string; mid: string; light: string; ink: string };
  /** Cartridge plastic colour: DS cards are dark grey, 3DS cards white. */
  cart: { body: string; edge: string; ridge: string };
  /** Who makes this game's patch. */
  patchBy: string;
  /** Languages the patch ships in, in release order. */
  languages: string[];
  /** Short tag printed on the cartridge label. */
  cartTag: string;
}

export const GAMES: Record<GameId, Game> = {
  ds: {
    id: 'ds',
    platform: 'DS',
    titleJa: 'とんがりボウシとおしゃれなまほうつかい',
    titleRomaji: 'Tongari Boushi to Oshare na Mahou Tsukai',
    icon: '/images/carts/ds-icon.png',
    accent: { deep: '#9b3f9e', mid: '#e93f8e', light: '#ffd3e8', ink: '#5c1f52' },
    cart: { body: '#4a4a55', edge: '#2f2f38', ridge: '#5d5d6a' },
    patchBy: 'darkenedforest',
    languages: ['English'],
    cartTag: '✦ ENGLISH',
  },
  '3ds': {
    id: '3ds',
    platform: '3DS',
    titleJa: 'とんがりボウシと魔法の町',
    titleRomaji: 'Tongari Boushi to Mahou no Machi',
    icon: '/images/carts/3ds-icon.png',
    accent: { deep: '#2f5fb9', mid: '#5f8fee', light: '#d6e6ff', ink: '#1d3566' },
    cart: { body: '#f2f2f5', edge: '#c9c9d2', ridge: '#dcdce4' },
    patchBy: 'a collaborator',
    // Multi-language patch; Italian is the first language.
    languages: ['Italian'],
    cartTag: '✦ MULTI-LANG',
  },
};

export const GAME_LIST: Game[] = [GAMES.ds, GAMES['3ds']];
