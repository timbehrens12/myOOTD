/** Named colors used for filters and item metadata (substring match on `item.color`). */

export type AppNamedColorEntry = { id: string; label: string; swatch: string | null };

export const APP_FILTER_COLORS: AppNamedColorEntry[] = [
  { id: 'all', label: 'All', swatch: null },
  { id: 'White', label: 'White', swatch: '#FFFFFF' },
  { id: 'Black', label: 'Black', swatch: '#000000' },
  { id: 'Gray', label: 'Gray', swatch: '#8E8E93' },
  { id: 'Navy', label: 'Navy', swatch: '#003366' },
  { id: 'Beige', label: 'Beige', swatch: '#D2B48C' },
  { id: 'Blue', label: 'Blue', swatch: '#0A84FF' },
  { id: 'Brown', label: 'Brown', swatch: '#8B4513' },
  { id: 'Green', label: 'Green', swatch: '#32D74B' },
  { id: 'Red', label: 'Red', swatch: '#FF453A' },
  { id: 'Pink', label: 'Pink', swatch: '#FF375F' },
  { id: 'Purple', label: 'Purple', swatch: '#BF5AF2' },
  { id: 'Orange', label: 'Orange', swatch: '#FF9F0A' },
  { id: 'Yellow', label: 'Yellow', swatch: '#FFD60A' },
  { id: 'Gold', label: 'Gold', swatch: '#D4AF37' },
  { id: 'Silver', label: 'Silver', swatch: '#C0C0C0' },
  { id: 'Bronze', label: 'Bronze', swatch: '#CD7F32' },
  { id: 'Olive', label: 'Olive', swatch: '#808000' },
  { id: 'Cream', label: 'Cream', swatch: '#FFFDD0' },
];

export const APP_ITEM_NAMED_COLORS = APP_FILTER_COLORS.filter(
  (c): c is { id: string; label: string; swatch: string } => c.id !== 'all' && c.swatch != null,
);

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim();
  if (h.length === 6 && /^[0-9a-fA-F]+$/.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

export function nearestNamedFilterId(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'Blue';
  let bestId = 'Blue';
  let bestD = Infinity;
  for (const c of APP_ITEM_NAMED_COLORS) {
    const cr = hexToRgb(c.swatch);
    if (!cr) continue;
    const d =
      (rgb.r - cr.r) * (rgb.r - cr.r) +
      (rgb.g - cr.g) * (rgb.g - cr.g) +
      (rgb.b - cr.b) * (rgb.b - cr.b);
    if (d < bestD) {
      bestD = d;
      bestId = c.id;
    }
  }
  return bestId;
}

/** Match item editor string to a named id if possible. */
export function namedIdFromItemColorString(value: string): string | null {
  const t = (value || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  for (const c of APP_ITEM_NAMED_COLORS) {
    if (c.id.toLowerCase() === lower || c.label.toLowerCase() === lower) return c.id;
  }
  return null;
}
