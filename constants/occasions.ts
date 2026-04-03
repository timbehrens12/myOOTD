export interface Occasion {
  id: string;
  label: string;
}

export interface OccasionGroup {
  id: string;
  label: string;
  occasions: Occasion[];
}

export const OCCASION_GROUPS: OccasionGroup[] = [
  {
    id: 'active',
    label: 'Active',
    occasions: [
      { id: 'gym', label: 'Gym' },
      { id: 'sport', label: 'Sport' },
      { id: 'beach', label: 'Beach' },
      { id: 'ski', label: 'Ski' },
      { id: 'hiking', label: 'Hiking' },
    ],
  },
  {
    id: 'social',
    label: 'Social',
    occasions: [
      { id: 'casual', label: 'Casual' },
      { id: 'brunch', label: 'Brunch' },
      { id: 'date-night', label: 'Date Night' },
      { id: 'night-out', label: 'Night Out' },
      { id: 'festival', label: 'Festival' },
      { id: 'wedding', label: 'Wedding' },
    ],
  },
  {
    id: 'work',
    label: 'Work & School',
    occasions: [
      { id: 'work', label: 'Work' },
      { id: 'school', label: 'School' },
    ],
  },
  {
    id: 'everyday',
    label: 'Everyday',
    occasions: [
      { id: 'travel', label: 'Travel' },
      { id: 'lounge', label: 'Lounge' },
      { id: 'errands', label: 'Errands' },
    ],
  },
  {
    id: 'formal',
    label: 'Formal',
    occasions: [
      { id: 'cocktail', label: 'Cocktail' },
      { id: 'black-tie', label: 'Black Tie' },
    ],
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
