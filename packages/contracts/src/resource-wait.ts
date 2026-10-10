/** Actual world block names that can supply these items; names are not stock proof. */
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  cobblestone: ['stone', 'cobblestone'], cobbled_deepslate: ['deepslate', 'cobbled_deepslate'],
  coal: ['coal_ore', 'deepslate_coal_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'], emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  quartz: ['nether_quartz_ore'], clay_ball: ['clay'], flint: ['gravel'],
  dirt: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'],
  wheat: ['wheat'], wheat_seeds: ['wheat', 'short_grass', 'tall_grass'],
  carrot: ['carrots'], potato: ['potatoes'], beetroot: ['beetroots'], beetroot_seeds: ['beetroots'],
};

/** Add known raw sources to legacy item-only waits, with a bounded stable order. */
export function resourceNamesFor(item: string, observedNames: readonly string[] = []): string[] {
  const raw = (name: string): readonly string[] => {
    if (SOURCES[name]) return SOURCES[name]!;
    const wood = /^([a-z_]+)_planks$/.exec(name)?.[1];
    if (wood) return wood === 'crimson' || wood === 'warped' ? [`${wood}_stem`] : wood === 'bamboo' ? ['bamboo', 'bamboo_block'] : [`${wood}_log`];
    return [name];
  };
  return [...new Set([...raw(item), ...observedNames.flatMap(raw), ...observedNames])].filter(name => name.length > 0).slice(0, 100);
}
