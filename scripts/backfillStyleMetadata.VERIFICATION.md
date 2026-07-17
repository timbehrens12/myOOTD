# Style-metadata backfill — verification

One-off remediation run on **2026-07-16** to give existing `clothing_items`
real `style` / `style_tags` / `pattern` / `formality` values. Before this,
those fields were hardcoded at insert time (`style='casual'`, `pattern='solid'`,
`style_tags=NULL`, `formality=NULL`); only newly classified items got real
metadata. The reusable script is [`backfillStyleMetadata.ts`](./backfillStyleMetadata.ts).

The generated per-row `UPDATE` SQL is intentionally **not** committed — it holds
production-specific values and could be reapplied by mistake. Reproduce results
by re-running the script (idempotent) and the verification query below.

## Method

- Rows targeted: only those still on **all four** defaults (see filter below).
  User- or model-edited rows are excluded and never overwritten.
- Metadata derived from each row's existing **text** fields
  (name/type/category/color/occasions) via a Gemini text call in batches — no
  vision calls, no image fetches.
- Every value normalized through the app's own whitelists
  (`normalizeStyleTags` / `normalizePattern` / `normalizeFormality` /
  `primaryStyleFromTags` in `lib/stylistGuards.ts`).
- Each write **re-asserts the defaults filter**, so a row edited between read
  and write is left untouched.
- Only `style` / `style_tags` / `pattern` / `formality` are written;
  `name` / `category` / `color` / `occasions` are never modified.

## "Still on defaults" filter (source of truth)

```sql
style_tags IS NULL
AND formality IS NULL
AND COALESCE(style, 'casual')   = 'casual'
AND COALESCE(pattern, 'solid')  = 'solid'
```

## Result (aggregate — no per-item data)

| metric                                   | before | after |
|------------------------------------------|-------:|------:|
| total `clothing_items`                   |    339 |   339 |
| rows still on defaults (filter above)    |    330 |     0 |
| rows with real `style_tags`              |      0 |   330 |
| rows with a `formality` value            |      — |   331 |
| pre-existing edited rows (left untouched)|      9 |     9 |
| classify batches / failures              |    9 / 0 | — |

The 9 pre-existing edited rows were outside the filter and were not changed.
331 (not 330) rows carry `formality` because one edited row already had one.

## Reusable verification query

```sql
SELECT
  count(*)                                                        AS total,
  count(*) FILTER (
    WHERE style_tags IS NULL AND formality IS NULL
      AND COALESCE(style, 'casual')  = 'casual'
      AND COALESCE(pattern, 'solid') = 'solid'
  )                                                               AS rows_still_on_defaults,
  count(*) FILTER (WHERE style_tags IS NOT NULL)                  AS rows_with_style_tags,
  count(*) FILTER (WHERE formality IS NOT NULL)                   AS rows_with_formality
FROM clothing_items;
```

Expected post-backfill: `rows_still_on_defaults = 0`.
