'use strict';

/**
 * The cosmetics that ship with Astra.
 *
 * Every entry is a real file under assets/. New capes are added with
 * tools/make_cape.js, which crops a clip to cape proportions and registers it here and
 * in the server catalogue at the same time - the two must not drift apart.
 */

// Ship-with-the-app cosmetics. `asset` is relative to the app's assets/ folder.
const BUILT_IN = [
  { id: 'cape_shattered_sky', name: 'Shattered Sky', kind: 'video', slot: 'cape',
    asset: 'capes/shattered_sky.mp4', rarity: 'legendary', price: 0, free: true,
    description: 'Free for everyone. Welcome to Astra.' },
  { id: 'cape_companion', name: 'Companion', kind: 'video', slot: 'cape',
    asset: 'capes/companion.mp4', rarity: 'rare', price: 600,
    description: 'Someone who waited for you.' },
  { id: 'cape_snowy_campfire', name: 'Snowy Campfire', kind: 'video', slot: 'cape',
    asset: 'capes/snowy_campfire.mp4', rarity: 'rare', price: 800,
    description: 'Warmth in the middle of the cold.' },
  { id: 'cape_holiday_hearth', name: 'Holiday Hearth', kind: 'video', slot: 'cape',
    asset: 'capes/holiday_hearth.mp4', rarity: 'epic', price: 900,
    description: 'A fire that never goes out.' },
  { id: 'cape_aquarium', name: 'Aquarium', kind: 'video', slot: 'cape',
    asset: 'capes/aquarium.mp4', rarity: 'epic', price: 900,
    description: 'The deep, lit and drifting.' },
  { id: 'cape_sakura', name: 'Sakura', kind: 'video', slot: 'cape',
    asset: 'capes/sakura.mp4', rarity: 'legendary', price: 1200,
    description: 'Pink blossom drifting through a quiet forest.' },
  { id: 'cape_aurora_live', name: 'Aurora', kind: 'video', slot: 'cape',
    asset: 'capes/aurora.mp4', rarity: 'legendary', price: 1200,
    description: 'A living northern-lights sky, moving on your back.' }
];

/** October and December, matching the shop's seasonal gating. */
function activeSeason(date = new Date()) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month === 10) return 'halloween';
  if (month === 12 || (month === 1 && day <= 5)) return 'christmas';
  return null;
}

/** Everything the launcher can show. */
function list() {
  return { builtIn: BUILT_IN, custom: [] };
}

module.exports = { list, activeSeason, BUILT_IN };
