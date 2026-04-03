-- ╔══════════════════════════════════════════════════════════╗
-- ║           AUTO-GEN SCHEDULES MIGRATION                  ║
-- ║  Run this in the Supabase SQL Editor for project:       ║
-- ║  lrjsfwrwylluufylgovn                                   ║
-- ╚══════════════════════════════════════════════════════════╝

-- 1. Create the schedules table
CREATE TABLE IF NOT EXISTS autogen_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'My Fit',
  occasion text NOT NULL DEFAULT 'casual',
  time_hour integer NOT NULL DEFAULT 8 CHECK (time_hour >= 0 AND time_hour <= 23),
  time_minute integer NOT NULL DEFAULT 0 CHECK (time_minute >= 0 AND time_minute <= 59),
  days_of_week integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  anchor_item_ids uuid[] DEFAULT '{}',
  -- References clothing_items.id (not FK enforced since it's array)
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Index for fast per-user lookups
CREATE INDEX IF NOT EXISTS idx_autogen_schedules_user_id
  ON autogen_schedules(user_id);

-- 3. Enable Row Level Security
ALTER TABLE autogen_schedules ENABLE ROW LEVEL SECURITY;

-- 4. Policies (only the owner can see/modify their own schedules)
CREATE POLICY "Users can view their own schedules"
  ON autogen_schedules FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own schedules"
  ON autogen_schedules FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own schedules"
  ON autogen_schedules FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own schedules"
  ON autogen_schedules FOR DELETE
  USING (auth.uid() = user_id);

-- 5. Optional: updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS set_autogen_updated_at ON autogen_schedules;
CREATE TRIGGER set_autogen_updated_at
  BEFORE UPDATE ON autogen_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
