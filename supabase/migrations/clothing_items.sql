-- ╔══════════════════════════════════════════════════════════╗
-- ║           CLOTHING ITEMS MIGRATION                       ║
-- ║  Run this in the Supabase SQL Editor for project:        ║
-- ║  lrjsfwrwylluufylgovn                                    ║
-- ╚══════════════════════════════════════════════════════════╝

-- NOTE: user_id stores Clerk user IDs (e.g. "user_abc123")
-- RLS policies use auth.uid() which matches Clerk JWT subject
-- when Supabase is configured as a Clerk JWT template.
-- For now, also create a permissive dev policy as fallback.

CREATE TABLE IF NOT EXISTS clothing_items (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text    NOT NULL,
  name         text,
  image_url    text    NOT NULL,
  type         text,
  category     text    NOT NULL DEFAULT 'other',
  sub_category text,
  color        text,
  material     text,
  fit          text,
  weight       text,
  pattern      text    DEFAULT 'solid',
  style        text    DEFAULT 'casual',
  seasons      text[]  DEFAULT '{all}',
  occasions    text[]  DEFAULT '{casual}',
  formality    text,
  brand        text,
  notes        text,
  box_2d       jsonb,
  is_digitized boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clothing_items_user_id ON clothing_items(user_id);
CREATE INDEX IF NOT EXISTS idx_clothing_items_category ON clothing_items(category);

-- ── Row Level Security ──
ALTER TABLE clothing_items ENABLE ROW LEVEL SECURITY;

-- With Clerk JWT: auth.uid() returns the Clerk user ID
CREATE POLICY "Users view own items"
  ON clothing_items FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users insert own items"
  ON clothing_items FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users update own items"
  ON clothing_items FOR UPDATE
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users delete own items"
  ON clothing_items FOR DELETE
  USING (auth.uid()::text = user_id);

-- ── updated_at trigger (reuses function from autogen_schedules migration) ──
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS set_clothing_items_updated_at ON clothing_items;
CREATE TRIGGER set_clothing_items_updated_at
  BEFORE UPDATE ON clothing_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Storage bucket (run separately or via Supabase dashboard) ──
-- INSERT INTO storage.buckets (id, name, public) VALUES ('clothing-images', 'clothing-images', true)
-- ON CONFLICT (id) DO NOTHING;
--
-- CREATE POLICY "Public read clothing images"
--   ON storage.objects FOR SELECT USING (bucket_id = 'clothing-images');
--
-- CREATE POLICY "Users upload clothing images"
--   ON storage.objects FOR INSERT
--   WITH CHECK (bucket_id = 'clothing-images' AND auth.uid()::text = (storage.foldername(name))[1]);
