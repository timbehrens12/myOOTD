import { OCCASION_GROUPS } from "../../constants/occasions";

export type ClosetSortMode =
  | "recent"
  | "oldestAdded"
  | "alpha"
  | "alphaDesc"
  | "mostWorn"
  | "leastWorn";

export const CLOSET_SORT_META: Record<
  ClosetSortMode,
  { label: string; short: string }
> = {
  recent: { label: "Recently added", short: "Recent" },
  oldestAdded: { label: "Oldest added", short: "Oldest" },
  alpha: { label: "A–Z", short: "A–Z" },
  alphaDesc: { label: "Z–A", short: "Z–A" },
  mostWorn: { label: "Most worn", short: "Most worn" },
  leastWorn: { label: "Least worn", short: "Least worn" },
};

export const CLOSET_SORT_ORDER: ClosetSortMode[] = [
  "recent",
  "oldestAdded",
  "alpha",
  "alphaDesc",
  "mostWorn",
  "leastWorn",
];

/** Normalize occasion ids for filtering (empty → casual). */
export function itemOccasionIds(it: { occasions?: unknown }): string[] {
  const o = it?.occasions;
  if (Array.isArray(o) && o.length)
    return o.map((x: string) => String(x).toLowerCase());
  return ["casual"];
}

export function itemMatchesOccasionFilter(
  it: { occasions?: unknown },
  activeOccasion: string,
): boolean {
  if (activeOccasion === "all") return true;
  const group = OCCASION_GROUPS.find((g) => g.id === activeOccasion);
  if (!group) return true;
  const groupOccasionIds = group.occasions.map((o) => o.id);
  return itemOccasionIds(it).some((id) => groupOccasionIds.includes(id));
}

export function sortKeyForItem(it: {
  name?: string | null;
  type?: string | null;
  brand?: string | null;
}): string {
  return (
    (it?.name || it?.type || it?.brand || "").toString().trim() || "\uFFFF"
  );
}

export function filterClosetItems<
  T extends { color?: string | null; occasions?: unknown },
>(
  items: T[],
  opts: {
    search: string;
    activeOccasion: string;
    activeColor: string;
    /** When true, item `category` field matches search too. */
    searchCategory?: boolean;
  },
): T[] {
  const q = opts.search.toLowerCase();
  const searchCategory = opts.searchCategory === true;
  return items.filter((it) => {
    const occMatch = itemMatchesOccasionFilter(it, opts.activeOccasion);
    const colorMatch =
      opts.activeColor === "all" ||
      (it.color || "")
        .toLowerCase()
        .includes(opts.activeColor.toLowerCase());
    const any = it as {
      name?: string | null;
      type?: string | null;
      brand?: string | null;
      category?: string | null;
    };
    const searchMatch =
      !q ||
      (any.name || any.type || "").toLowerCase().includes(q) ||
      (any.brand || "").toLowerCase().includes(q) ||
      (searchCategory && !!(any.category || "").toLowerCase().includes(q));
    return occMatch && colorMatch && searchMatch;
  });
}

export function sortClosetItems<
  T extends {
    created_at?: string | null;
    wear_count?: number | null;
    name?: string | null;
    type?: string | null;
    brand?: string | null;
  },
>(items: T[], sortBy: ClosetSortMode): T[] {
  const out = [...items];
  const cmpName = (a: T, b: T) =>
    sortKeyForItem(a).localeCompare(sortKeyForItem(b), undefined, {
      sensitivity: "base",
    });

  switch (sortBy) {
    case "recent":
      out.sort(
        (a, b) =>
          new Date(b?.created_at || 0).getTime() -
          new Date(a?.created_at || 0).getTime(),
      );
      break;
    case "oldestAdded":
      out.sort(
        (a, b) =>
          new Date(a?.created_at || 0).getTime() -
          new Date(b?.created_at || 0).getTime(),
      );
      break;
    case "alpha":
      out.sort((a, b) => cmpName(a, b));
      break;
    case "alphaDesc":
      out.sort((a, b) => cmpName(b, a));
      break;
    case "mostWorn":
      out.sort((a, b) => {
        const d = (b?.wear_count || 0) - (a?.wear_count || 0);
        return d !== 0 ? d : cmpName(a, b);
      });
      break;
    case "leastWorn":
      out.sort((a, b) => {
        const d = (a?.wear_count || 0) - (b?.wear_count || 0);
        return d !== 0 ? d : cmpName(a, b);
      });
      break;
  }
  return out;
}

export const CLOSET_BROWSE_OCCASION_TABS = [
  { id: "all", label: "All" },
  ...OCCASION_GROUPS.map((g) => ({ id: g.id, label: g.label })),
];
