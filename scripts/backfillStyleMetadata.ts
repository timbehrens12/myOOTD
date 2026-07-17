/**
 * Reusable, idempotent backfill for clothing_items rows that still carry the
 * historical hardcoded metadata defaults (style='casual', pattern='solid',
 * style_tags IS NULL, formality IS NULL) from before real style metadata was
 * persisted.
 *
 * It derives style_tags / pattern / formality from each row's EXISTING text
 * metadata (name/type/category/color/occasions) using a Gemini TEXT call in
 * batches — no per-item vision calls, no image fetches. Every value is passed
 * through the same whitelists the app uses (lib/stylistGuards), and each write
 * RE-ASSERTS the defaults filter so a row a user edited between read and write
 * is never overwritten. Only style/style_tags/pattern/formality are touched;
 * name/category/color/occasions are left exactly as-is.
 *
 * Safe to re-run: rows that already have real metadata no longer match the
 * defaults filter and are skipped.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GOOGLE_AI_API_KEY=... \
 *     npx tsx scripts/backfillStyleMetadata.ts [--dry-run] [--limit=N] [--batch=40]
 *
 * --dry-run  classify and report, but write nothing.
 * --limit    cap how many default rows to process this run.
 * --batch    rows per Gemini call (default 40).
 */
import { createClient } from "@supabase/supabase-js";

import {
  normalizeFormality,
  normalizePattern,
  normalizeStyleTags,
  primaryStyleFromTags,
} from "../lib/stylistGuards";

type Row = {
  id: string;
  name: string | null;
  type: string | null;
  category: string | null;
  sub_category: string | null;
  color: string | null;
  occasions: string[] | null;
};

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const GEMINI_KEY = requireEnv("GOOGLE_AI_API_KEY");
const MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-3.1-flash-lite";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = numArg("--limit");
const BATCH = numArg("--batch") ?? 40;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** The single source-of-truth definition of a "still on defaults" row. */
const DEFAULTS_FILTER = (q: any) =>
  q
    .is("style_tags", null)
    .is("formality", null)
    .or("style.is.null,style.eq.casual")
    .or("pattern.is.null,pattern.eq.solid");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function numArg(flag: string): number | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? Number(hit.split("=")[1]) : undefined;
}

async function classifyBatch(batch: Row[]): Promise<Map<string, any>> {
  const prompt = `You are a fashion metadata tagger. For each clothing item below (described by name/type/category/color/occasions), infer:
- "style_tags": 1-2 tags from EXACTLY this list: casual, office, street, evening, sporty, preppy, minimalist, romantic, edgy
- "pattern": one of: solid, striped, plaid, checked, floral, graphic, print, polka-dot, animal, camo, colorblock (use "solid" unless the name clearly indicates a pattern)
- "formality": one of: athletic, casual, smart-casual, business, formal

ITEMS:
${JSON.stringify(
    batch.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      category: r.category,
      sub_category: r.sub_category,
      color: r.color,
      occasions: r.occasions,
    })),
    null,
    1,
  )}

Return ONLY a JSON array: [{"id":"...","style_tags":["..."],"pattern":"...","formality":"..."}] with one entry per input id. No markdown.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  const arr = JSON.parse(text);
  const out = new Map<string, any>();
  if (Array.isArray(arr)) {
    for (const e of arr) if (e && typeof e.id === "string") out.set(e.id, e);
  }
  return out;
}

async function countDefaults(): Promise<number> {
  const { count, error } = await DEFAULTS_FILTER(
    admin.from("clothing_items").select("id", { count: "exact", head: true }),
  );
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  const before = await countDefaults();
  console.log(`default-metadata rows before: ${before}`);
  if (before === 0) {
    console.log("nothing to backfill.");
    return;
  }

  let query = DEFAULTS_FILTER(
    admin
      .from("clothing_items")
      .select("id,name,type,category,sub_category,color,occasions")
      .order("created_at", { ascending: true }),
  );
  if (LIMIT) query = query.limit(LIMIT);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  console.log(`processing ${rows.length} rows in batches of ${BATCH}${DRY_RUN ? " (dry run)" : ""}`);

  let updated = 0;
  const failures: string[] = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let result: Map<string, any>;
    try {
      result = await classifyBatch(batch);
    } catch (err) {
      failures.push(`batch ${i / BATCH + 1} FAILED: ${String(err).slice(0, 200)}`);
      continue;
    }
    for (const row of batch) {
      const m = result.get(row.id);
      if (!m) {
        failures.push(`${row.id} (${row.name}): no answer returned`);
        continue;
      }
      const tags = normalizeStyleTags(m.style_tags);
      const patch = {
        style: primaryStyleFromTags(tags),
        style_tags: tags.length ? tags : null,
        pattern: normalizePattern(m.pattern),
        formality: normalizeFormality(m.formality),
      };
      if (DRY_RUN) {
        updated += 1;
        continue;
      }
      // Re-assert the defaults filter at write time: a row edited between the
      // read above and now must NOT be clobbered.
      const { error: upErr, count } = await DEFAULTS_FILTER(
        admin
          .from("clothing_items")
          .update(patch, { count: "exact" })
          .eq("id", row.id),
      );
      if (upErr) failures.push(`${row.id}: ${upErr.message}`);
      else updated += count ?? 0;
    }
    console.log(`batch ${i / BATCH + 1}/${Math.ceil(rows.length / BATCH)} done (${updated} updated)`);
  }

  const after = DRY_RUN ? before : await countDefaults();
  console.log("\n── backfill summary ──");
  console.log(`rows ${DRY_RUN ? "would update" : "updated"}: ${updated}`);
  console.log(`failures: ${failures.length}`);
  console.log(`default-metadata rows ${DRY_RUN ? "(unchanged in dry run)" : "after"}: ${after}`);
  if (failures.length) console.log("\n" + failures.join("\n"));
  if (failures.length && !DRY_RUN) process.exitCode = 1;
}

void main();
