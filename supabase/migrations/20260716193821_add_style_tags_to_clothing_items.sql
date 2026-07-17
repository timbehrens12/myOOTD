-- Rich style metadata from the classifier. `style` (single value) stays for
-- backward compatibility but is now derived from these tags instead of being
-- hardcoded 'casual' for every item. (Applied to prod 2026-07-16.)
ALTER TABLE clothing_items ADD COLUMN IF NOT EXISTS style_tags text[] DEFAULT NULL;
