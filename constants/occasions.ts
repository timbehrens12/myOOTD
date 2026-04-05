export interface Occasion {
  id: string;
  label: string;
}

export interface OccasionGroup {
  id: string;
  label: string;
  occasions: Occasion[];
}

/**
 * Broad, general-purpose occasions.
 * Groups kept for backwards compat but each group now holds a single occasion.
 */
export const OCCASION_GROUPS: OccasionGroup[] = [
  {
    id: 'everyday',
    label: 'Everyday',
    occasions: [{ id: 'casual', label: 'Casual' }],
  },
  {
    id: 'active',
    label: 'Active',
    occasions: [{ id: 'active', label: 'Active' }],
  },
  {
    id: 'social',
    label: 'Social',
    occasions: [{ id: 'going-out', label: 'Going Out' }],
  },
  {
    id: 'work',
    label: 'Work',
    occasions: [{ id: 'work', label: 'Work' }],
  },
  {
    id: 'travel',
    label: 'Travel',
    occasions: [{ id: 'travel', label: 'Travel' }],
  },
  {
    id: 'lounge',
    label: 'Lounge',
    occasions: [{ id: 'lounge', label: 'Lounge' }],
  },
  {
    id: 'formal',
    label: 'Formal',
    occasions: [{ id: 'formal', label: 'Formal' }],
  },
];

/** Flat list of all occasions */
export const OCCASIONS_FLAT: Occasion[] = OCCASION_GROUPS.flatMap(g => g.occasions);

/** Get the group that contains a given occasion id */
export function getGroupForOccasion(occasionId: string): OccasionGroup | undefined {
  return OCCASION_GROUPS.find(g => g.occasions.some(o => o.id === occasionId));
}

/** Get all occasion ids that belong to a group */
export function getOccasionIdsForGroup(groupId: string): string[] {
  return OCCASION_GROUPS.find(g => g.id === groupId)?.occasions.map(o => o.id) ?? [];
}

/**
 * Map legacy granular occasion ids to the new broad ones.
 * Used when loading items that were classified with the old set.
 */
const LEGACY_MAP: Record<string, string> = {
  gym: 'active',
  sport: 'active',
  beach: 'active',
  ski: 'active',
  hiking: 'active',
  brunch: 'casual',
  'date-night': 'going-out',
  'night-out': 'going-out',
  festival: 'going-out',
  wedding: 'formal',
  school: 'work',
  errands: 'casual',
  cocktail: 'formal',
  'black-tie': 'formal',
};

/** Normalise an occasion id — returns the broad id for legacy values, passthrough for current ones. */
export function normalizeOccasion(id: string): string {
  return LEGACY_MAP[id] ?? id;
}

/** De-dup & normalise an array of occasion ids. */
export function normalizeOccasions(ids: string[]): string[] {
  return [...new Set(ids.map(normalizeOccasion))];
}
