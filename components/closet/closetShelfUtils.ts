/** Single source for category → shelf grouping (matches main Closet tab). */

export const CLOSET_SHELF_CATEGORIES = [
  { id: "top", label: "Tops" },
  { id: "bottom", label: "Bottoms" },
  { id: "full body", label: "Full Body" },
  { id: "outerwear", label: "Outerwear" },
  { id: "shoes", label: "Shoes" },
  { id: "bag", label: "Bags" },
  { id: "accessory", label: "Accessories" },
] as const;

export const KNOWN_CLOSET_SHELF_IDS = new Set<string>(
  CLOSET_SHELF_CATEGORIES.map((c) => c.id),
);

export function closetItemShelfKey(item: {
  category?: string | null;
}): string {
  const c = (item.category || "other").toLowerCase().trim();
  if (KNOWN_CLOSET_SHELF_IDS.has(c)) return c;
  return "other";
}

export type ClosetShelfSection<T> = { id: string; label: string; data: T[] };

export function buildClosetShelfSections<T extends { category?: string | null }>(
  items: T[],
  otherLabel = "Other",
): ClosetShelfSection<T>[] {
  const sections: ClosetShelfSection<T>[] = [];
  for (const cat of CLOSET_SHELF_CATEGORIES) {
    const data = items.filter((it) => closetItemShelfKey(it) === cat.id);
    if (data.length > 0) sections.push({ id: cat.id, label: cat.label, data });
  }
  const other = items.filter((it) => closetItemShelfKey(it) === "other");
  if (other.length > 0) {
    sections.push({ id: "other", label: otherLabel, data: other });
  }
  return sections;
}

export function shelfLabelForCategoryId(categoryId: string): string {
  const found = CLOSET_SHELF_CATEGORIES.find((c) => c.id === categoryId);
  if (found) return found.label;
  return categoryId === "other" ? "Other" : categoryId;
}
