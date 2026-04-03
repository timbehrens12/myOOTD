import type { BuilderItem, SavedFit } from "../components/fits/types";

/** Stable demo looks for Library carousel + calendar (dev only). */
export const DEV_FAKE_SAVED_FITS: SavedFit[] = [
  {
    id: "dev-fit-coffee",
    name: "Coffee run",
    occasion: "casual",
    planned_date: null,
    image_url: "https://picsum.photos/seed/myootd-coffee/720/1080",
    created_at: new Date().toISOString(),
    item_ids: [],
    worn_on: isoDateDaysAgo(0),
  },
  {
    id: "dev-fit-work",
    name: "Desk day",
    occasion: "work",
    planned_date: null,
    image_url: "https://picsum.photos/seed/myootd-work/720/1080",
    created_at: new Date().toISOString(),
    item_ids: [],
    worn_on: isoDateDaysAgo(1),
  },
  {
    id: "dev-fit-brunch",
    name: "Sunday brunch",
    occasion: "social",
    planned_date: null,
    image_url: "https://picsum.photos/seed/myootd-brunch/720/1080",
    created_at: new Date().toISOString(),
    item_ids: [],
    worn_on: isoDateDaysAgo(3),
  },
  {
    id: "dev-fit-gym",
    name: "Studio class",
    occasion: "active",
    planned_date: null,
    image_url: "https://picsum.photos/seed/myootd-active/720/1080",
    created_at: new Date().toISOString(),
    item_ids: [],
    worn_on: isoDateDaysAgo(5),
  },
];

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0]!;
}

/** Placeholder pieces for Builder canvas (no DB ids — save uses these UUID strings only in dev). */
export const DEV_DEMO_BUILDER_ITEMS: BuilderItem[] = [
  {
    id: "dev-piece-oxford",
    name: "Oxford shirt",
    category: "Tops",
    color: "White",
    image_url: "https://picsum.photos/seed/devshirt/200/200",
    slot: 0,
  },
  {
    id: "dev-piece-denim",
    name: "Straight jeans",
    category: "Bottoms",
    color: "Indigo",
    image_url: "https://picsum.photos/seed/devjeans/200/200",
    slot: 1,
  },
  {
    id: "dev-piece-sneaker",
    name: "Canvas sneakers",
    category: "Shoes",
    color: "Cream",
    image_url: "https://picsum.photos/seed/devshoe/200/200",
    slot: 2,
  },
];
