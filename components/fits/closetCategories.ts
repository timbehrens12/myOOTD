import type { ClosetItem } from "./types";

/** Chip labels: same order everywhere (picker modal, Build it strip, expanded panel). */
export const CLOSET_CATEGORY_CHIPS = [
  "All",
  "Tops",
  "Bottoms",
  "Full Body",
  "Outerwear",
  "Shoes",
  "Bags",
  "Accessories",
] as const;

export const PICKER_CATEGORY_MATCH: Record<string, string[]> = {
  Tops: [
    "top",
    "shirt",
    "tee",
    "blouse",
    "sweater",
    "knit",
    "tank",
    "polo",
    "henley",
    "cardigan",
    "crop",
  ],
  Bottoms: [
    "bottom",
    "pant",
    "jean",
    "denim",
    "short",
    "skirt",
    "trouser",
    "legging",
    "chino",
    "cargo",
  ],
  "Full Body": [
    "dress",
    "gown",
    "jumpsuit",
    "romper",
    "playsuit",
    "bodysuit",
    "overall",
    "overalls",
    "one-piece",
    "onepiece",
    "coverall",
    "catsuit",
  ],
  Outerwear: [
    "outerwear",
    "jacket",
    "coat",
    "blazer",
    "parka",
    "windbreaker",
    "anorak",
    "vest",
    "puffer",
    "bomber",
  ],
  Shoes: [
    "shoe",
    "sneaker",
    "boot",
    "heel",
    "sandal",
    "loafer",
    "slipper",
    "oxford",
    "flat",
    "mule",
    "clog",
  ],
  Bags: [
    "bag",
    "backpack",
    "tote",
    "purse",
    "clutch",
    "crossbody",
    "satchel",
    "duffel",
    "briefcase",
    "fanny",
    "belt bag",
  ],
  Accessories: [
    "accessor",
    "jewelry",
    "jewellery",
    "necklace",
    "earring",
    "bracelet",
    "ring",
    "watch",
    "hat",
    "cap",
    "beanie",
    "belt",
    "scarf",
    "tie",
    "bow",
    "sunglass",
    "glasses",
    "pin",
    "brooch",
    "headband",
    "glove",
    "sock",
    "tight",
    "umbrella",
  ],
};

export function pickerHaystack(it: ClosetItem): string {
  const raw = `${it.category ?? ""} ${it.name ?? ""} ${it.type ?? ""}`
    .toLowerCase()
    .replace(/-/g, " ");
  return ` ${raw.replace(/[^a-z0-9]+/g, " ")} `;
}

/** Search + chip filter for outfit pickers (shelves); browse uses full items + category slice. */
export function filterClosetPickerItems(
  items: ClosetItem[],
  search: string,
  categoryChip: string,
): ClosetItem[] {
  const q = search.toLowerCase();
  return items.filter((it) => {
    const matchSearch =
      !q ||
      (it.name || it.category || "").toLowerCase().includes(q) ||
      (it.type || "").toLowerCase().includes(q) ||
      (it.brand || "").toLowerCase().includes(q);
    const matchCat = itemMatchesPickerCategory(it, categoryChip);
    return matchSearch && matchCat;
  });
}

export function itemMatchesPickerCategory(
  it: ClosetItem,
  chip: string,
): boolean {
  if (chip === "All") return true;
  const keys = PICKER_CATEGORY_MATCH[chip];
  const h = pickerHaystack(it);
  if (keys?.length) {
    return keys.some((k) => {
      const parts = k.toLowerCase().replace(/-/g, " ").trim().split(/\s+/);
      return parts.every((p) => p.length > 0 && h.includes(` ${p} `));
    });
  }
  return h.includes(` ${chip.toLowerCase()} `);
}

export function isDressLike(item: ClosetItem): boolean {
  return itemMatchesPickerCategory(item, "Full Body");
}

export function isTopLike(item: ClosetItem): boolean {
  return itemMatchesPickerCategory(item, "Tops");
}

export function isBottomLike(item: ClosetItem): boolean {
  return itemMatchesPickerCategory(item, "Bottoms");
}

export function isShoeItem(item: ClosetItem): boolean {
  return itemMatchesPickerCategory(item, "Shoes");
}

export function isOuterItem(item: ClosetItem): boolean {
  return itemMatchesPickerCategory(item, "Outerwear");
}

export function isBagItem(item: ClosetItem): boolean {
  return itemMatchesPickerCategory(item, "Bags");
}
