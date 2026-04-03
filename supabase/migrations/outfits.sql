-- ╔══════════════════════════════════════════════════════════╗
-- ║              OUTFITS MIGRATION                           ║
-- ║  Run this in the Supabase SQL Editor for project:        ║
-- ║  lrjsfwrwylluufylgovn                                    ║
-- ╚══════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS outfits (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text    NOT NULL,
  title        text    NOT NULL DEFAULT 'My Look',
  occasion     text    NOT NULL DEFAULT 'casual',
  item_ids     uuid[]  NOT NULL DEFAULT '{}',
  is_favorite  boolean NOT NULL DEFAULT false,
  worn_on      date,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outfits_user_id  ON outfits(user_id);
CREATE INDEX IF NOT EXISTS idx_outfits_worn_on  ON outfits(worn_on);
CREATE INDEX IF NOT EXISTS idx_outfits_favorite ON outfits(user_id, is_favorite) WHERE is_favorite = true;

-- ── Row Level Security ──
ALTER TABLE outfits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own outfits"
  ON outfits FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users insert own outfits"
  ON outfits FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users update own outfits"
  ON outfits FOR UPDATE
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users delete own outfits"
  ON outfits FOR DELETE
  USING (auth.uid()::text = user_id);

DROP TRIGGER IF EXISTS set_outfits_updated_at ON outfits;
CREATE TRIGGER set_outfits_updated_at
  BEFORE UPDATE ON outfits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
