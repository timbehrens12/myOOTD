import { OCCASIONS_FLAT } from '../../constants/occasions';

export interface SavedFit {
  id: string;
  name: string | null;
  occasion: string | null;
  planned_date: string | null;
  image_url: string | null;
  created_at: string;
  /** Closet clothing_item UUIDs saved with the outfit (DB column often named `items`). */
  item_ids?: string[];
  /** When this outfit was logged as worn (if your project has this column). */
  worn_on?: string | null;
}

export interface ClosetItem {
  id: string;
  name: string | null;
  category: string | null;
  color: string | null;
  image_url: string | null;
  brand?: string | null;
  type?: string | null;
  style?: string | null;
  occasions?: string[] | null;
}

export interface BuilderItem extends ClosetItem {
  slot: number;
}

export const OCC_LABEL: Record<string, string> = {};
OCCASIONS_FLAT.forEach((o) => {
  OCC_LABEL[o.id] = o.label;
});
