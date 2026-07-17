import { OCCASIONS_FLAT } from "../../constants/occasions";
import { STYLE_ME_WHEEL_OCCASIONS } from "../../constants/styleMeWheelOccasions";

export interface SavedFit {
  id: string;
  name: string | null;
  occasion: string | null;
  planned_date: string | null;
  /** Future plan dates from outfit_schedule (sorted ascending). */
  planned_dates?: string[];
  image_url: string | null;
  created_at: string;
  /** Closet clothing_item UUIDs saved with the outfit (DB column often named `items`). */
  item_ids?: string[];
  /** When this outfit was logged as worn (if your project has this column). */
  worn_on?: string | null;
  /** Virtual try-on render (builder / automation), if saved. */
  try_on_image_url?: string | null;
  /** Raw `preview_image_url` from DB (uploaded photo or canvas hero). */
  preview_image_url?: string | null;
  /** Raw `image_url` from DB when distinct from preview. */
  source_image_url?: string | null;
  /** True when try_on_image_url is older than the current piece list. */
  try_on_stale?: boolean;
  is_favorite?: boolean;
  source?: "ai" | "manual";
  occasion_label?: string | null;
  /** False = Recent-only until user saves to library. */
  saved_to_library?: boolean;
}

export interface ClosetItem {
  id: string;
  name: string | null;
  category: string | null;
  color: string | null;
  image_url: string | null;
  /** Small JPEG for grids — reduces egress when present. */
  thumbnail_url?: string | null;
  brand?: string | null;
  type?: string | null;
  style?: string | null;
  /** Classifier style vocabulary (street/office/evening/…): richer than `style`. */
  style_tags?: string[] | null;
  pattern?: string | null;
  formality?: string | null;
  occasions?: string[] | null;
  /** ["spring","summer"] | ["fall","winter"] | ["all"] — derived from classify warmth. */
  seasons?: string[] | null;
  wear_count?: number | null;
}

export interface BuilderItem extends ClosetItem {
  slot: number;
}

/** Max garments on the Fits builder canvas / strips. */
export const MAX_FIT_BUILDER_PIECES = 12;

export const OCC_LABEL: Record<string, string> = {};
OCCASIONS_FLAT.forEach((o) => {
  OCC_LABEL[o.id] = o.label;
});
STYLE_ME_WHEEL_OCCASIONS.forEach((o) => {
  OCC_LABEL[o.key] = o.label;
});
