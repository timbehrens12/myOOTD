---
description: Print the full myOOTD Supabase schema so Claude always has accurate table/column info before writing queries
---

# myOOTD Supabase Schema

**Project ref:** `lrjsfwrwylluufylgovn`
**Auth:** Clerk user IDs stored as `user_id TEXT` in all tables. RLS policies use `auth.uid()::text = user_id`.

---

## Tables

### `clothing_items`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | gen_random_uuid() |
| user_id | text | Clerk user ID |
| name | text | nullable |
| image_url | text | Supabase Storage public URL |
| type | text | e.g. "Slim-fit Chinos" |
| category | text | top \| bottom \| outerwear \| full body \| shoes \| accessory \| bag |
| sub_category | text | nullable |
| color | text | dominant color word |
| material | text | nullable |
| fit | text | nullable |
| weight | text | light \| mid \| heavy |
| pattern | text | default 'solid' |
| style | text | default 'casual' |
| seasons | text[] | e.g. ['spring','summer'] |
| occasions | text[] | casual \| work \| school \| gym \| night-out \| travel \| formal |
| formality | text | nullable |
| brand | text | nullable |
| notes | text | nullable |
| box_2d | jsonb | nullable, AI bounding box |
| is_digitized | boolean | default true |
| wear_count | int | default 0 |
| last_worn_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

### `outfits`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | text | Clerk user ID |
| name | text | outfit title |
| occasion | text | default 'casual' |
| is_favorite | boolean | default false |
| worn_on | date | nullable |
| source | text | 'ai' \| 'manual', default 'manual' |
| created_at | timestamptz | |

### `outfit_items` (junction — outfits ↔ clothing_items)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| outfit_id | uuid FK → outfits.id | |
| clothing_item_id | uuid FK → clothing_items.id | |
| layer_order | int | default 0, used for display ordering |

### `outfit_schedule`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | text | |
| outfit_id | uuid FK → outfits.id | |
| scheduled_date | date | |
| created_at | timestamptz | |

### `wear_history`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | text | |
| clothing_item_id | uuid FK → clothing_items.id | nullable |
| outfit_id | uuid FK → outfits.id | nullable |
| worn_at | timestamptz | default now() |

### `autogen_schedules`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → auth.users.id | |
| label | text | default 'My Fit' |
| occasion | text | default 'casual' |
| time_hour | int | 0–23 |
| time_minute | int | 0–59 |
| days_of_week | int[] | 0=Sun … 6=Sat |
| anchor_item_ids | uuid[] | references clothing_items |
| is_active | boolean | default true |
| last_generated_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | |

### `profiles`
| Column | Type |
|---|---|
| user_id | text UNIQUE |
| full_name | text |
| gender | text |
| age_range | text |
| style_archetypes | text[] |
| color_palettes | text[] |
| wardrobe_goal | text |
| body_silhouette | text |
| acquisition_source | text |
| style_inspiration_urls | text[] |

### `trips`
| Column | Type |
|---|---|
| user_id | text |
| destination | text |
| start_date | date |
| end_date | date |

---

## Key query patterns

**Save a generated outfit:**
```ts
// 1. Insert outfit
const { data: outfit } = await supabase
  .from('outfits')
  .insert({ user_id, name, occasion, worn_on, source: 'ai' })
  .select('id').single();

// 2. Insert junction rows
await supabase.from('outfit_items').insert(
  item_ids.map((id, idx) => ({ outfit_id: outfit.id, clothing_item_id: id, layer_order: idx }))
);
```

**Load outfits with items:**
```ts
const { data } = await supabase
  .from('outfits')
  .select(`
    id, name, occasion, is_favorite, worn_on, created_at,
    outfit_items ( layer_order, clothing_items:clothing_item_id ( id, name, type, category, color, image_url ) )
  `)
  .order('created_at', { ascending: false });
```

**Storage bucket:** `clothing-images` (public)
