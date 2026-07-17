-- Rotation-only record of every outfit the stylist GENERATED (including batch
-- alternatives the user never applied). Deliberately separate from
-- generation_history, which feeds the Recents UI — this table is read only by
-- the rotation logic so suggestions stop repeating.
create table if not exists public.stylist_generation_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  item_ids text[] not null,
  source text not null default 'batch',
  created_at timestamptz not null default now()
);

create index if not exists stylist_generation_items_user_created_idx
  on public.stylist_generation_items (user_id, created_at desc);

alter table public.stylist_generation_items enable row level security;

create policy owner_select on public.stylist_generation_items
  for select using (user_id = (select (auth.jwt() ->> 'sub'::text)));
create policy owner_insert on public.stylist_generation_items
  for insert with check (user_id = (select (auth.jwt() ->> 'sub'::text)));
create policy owner_update on public.stylist_generation_items
  for update using (user_id = (select (auth.jwt() ->> 'sub'::text)))
  with check (user_id = (select (auth.jwt() ->> 'sub'::text)));
create policy owner_delete on public.stylist_generation_items
  for delete using (user_id = (select (auth.jwt() ->> 'sub'::text)));
