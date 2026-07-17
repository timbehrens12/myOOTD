import type { SupabaseClient } from "@supabase/supabase-js";

import type { BuilderItem, ClosetItem } from "../components/fits/types";
import { apiClient, isRetryableGeminiError } from "../constants/api-client";
import {
  isNearDuplicateOutfit,
  outfitFingerprint,
} from "./stylistGuards";

/**
 * Item-id arrays of the user's most recent GENERATED outfits (newest first) —
 * the real rotation signal. wear_count only tracks what was actually worn;
 * an item the stylist suggested five times but was never worn would otherwise
 * look like a fresh pick forever.
 */
export async function fetchRecentGeneratedItemIds(
  supabase: SupabaseClient,
  userId: string,
  limit = 6,
): Promise<string[][]> {
  const rowsToIdArrays = (rows: { item_ids: unknown }[] | null) =>
    (rows ?? [])
      .map((r) =>
        Array.isArray(r.item_ids)
          ? r.item_ids.filter((x): x is string => typeof x === "string")
          : [],
      )
      .filter((a: string[]) => a.length > 0);
  const out: string[][] = [];
  // stylist_generation_items holds EVERY generated look, including batch
  // alternatives the user never applied — the primary rotation signal.
  try {
    const { data } = await supabase
      .from("stylist_generation_items")
      .select("item_ids")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    out.push(...rowsToIdArrays(data));
  } catch {
    // best-effort — rotation must never block generation
  }
  // generation_history covers applied looks (and everything generated before
  // the rotation table existed).
  try {
    const { data } = await supabase
      .from("generation_history")
      .select("item_ids")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    out.push(...rowsToIdArrays(data));
  } catch {
    // same
  }
  return out.slice(0, limit * 2);
}

/**
 * Best-effort record of generated looks into the rotation-only table
 * (NOT generation_history — that feeds the Recents UI). Call it with the whole
 * batch, unselected alternatives included, so they can't repeat next batch.
 */
export async function recordStylistGeneration(
  supabase: SupabaseClient,
  userId: string,
  outfitsItemIds: string[][],
  source: "batch" | "single" | "automation" = "batch",
): Promise<void> {
  const rows = outfitsItemIds
    .filter((ids) => Array.isArray(ids) && ids.length > 0)
    .map((ids) => ({ user_id: userId, item_ids: ids, source }));
  if (rows.length === 0) return;
  try {
    await supabase.from("stylist_generation_items").insert(rows);
  } catch {
    // rotation bookkeeping must never fail a generation
  }
}

const VARIATION_HINTS = [
  "Lean minimal — focus on fewer, stronger pieces.",
  "Add polish with one bold accessory or texture.",
  "Relaxed silhouette and easy layers.",
  "Sharper tailoring and cleaner lines.",
  "Playful mix — subtle pattern or contrast shoes.",
];

export type AutoOutfitPlanRaw = {
  title: string;
  reasoning: string;
  item_ids: string[];
};

/** Raw onboarding/profile styling preference — see app/onboarding.tsx GENDERS. */
export type GenderStylePref =
  | "Womenswear"
  | "Menswear"
  | "Both"
  | "No preference"
  | string
  | null
  | undefined;

/** Style moods selected during onboarding (profiles.style_archetypes). */
export type StyleArchetypePrefs = readonly string[] | null | undefined;

/** Turns the user's styling preference into a stylist instruction. Returns
 * undefined for "No preference"/unset so the prompt stays unchanged for
 * users who never opted into a direction. */
function genderStyleInstruction(pref: GenderStylePref): string | undefined {
  if (pref === "Menswear")
    return "Style this outfit with a masculine, menswear-leaning silhouette and pieces.";
  if (pref === "Womenswear")
    return "Style this outfit with a feminine, womenswear-leaning silhouette and pieces.";
  if (pref === "Both")
    return "Freely mix masculine and feminine silhouettes and pieces — no single direction required.";
  return undefined;
}

/**
 * Clean the onboarding selections before they enter an AI prompt. "I wear it
 * all" is the explicit no-preference option, so it must not become a style
 * constraint even if an older profile happens to contain other values too.
 */
export function normalizeStyleArchetypes(
  prefs: StyleArchetypePrefs,
): string[] {
  if (!Array.isArray(prefs)) return [];

  const cleaned = prefs
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  if (cleaned.some((value) => value.toLowerCase() === "i wear it all")) {
    return [];
  }

  const seen = new Set<string>();
  return cleaned.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function styleArchetypeInstruction(
  prefs: StyleArchetypePrefs,
): string | undefined {
  const styles = normalizeStyleArchetypes(prefs);
  if (!styles.length) return undefined;

  return `Treat the user's onboarding style preferences (${styles.join(
    ", ",
  )}) as a gentle influence only. Use them as a tie-breaker among looks that already satisfy the occasion, weather, required anchor pieces, explicit user direction, and closet cohesion. Explicit user direction always overrides these profile preferences. Do not hard-filter closet items or force every listed style into the outfit.`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function closetPayload(items: ClosetItem[]) {
  return items.map((it) => ({
    id: it.id,
    name: it.name ?? undefined,
    type: it.type ?? undefined,
    category: it.category ?? "unknown",
    color: it.color ?? undefined,
    style: it.style ?? undefined,
    style_tags: it.style_tags ?? undefined,
    pattern: it.pattern ?? undefined,
    formality: it.formality ?? undefined,
    occasions: it.occasions ?? [],
    // Season + wear data power the stylist's weather guardrails and closet
    // rotation ("stop reusing the same 6 pieces / my newest uploads").
    seasons: it.seasons ?? undefined,
    wear_count: typeof it.wear_count === "number" ? it.wear_count : undefined,
  }));
}

/**
 * Stylist picks for the auto outfit builder.
 *
 * Strategy:
 *  1. Try ONE bulk Gemini call returning all N outfits at once (~3–8s).
 *  2. If that fails or returns nothing, fall back to the legacy per-outfit
 *     loop with variation hints (slower but more resilient).
 */
export async function generateAutoOutfitBatch(params: {
  count: number;
  occasionPhrase: string;
  closetItems: ClosetItem[];
  weather?: unknown;
  anchorItemIds: string[];
  colorHarmony: boolean;
  /** When false, stylist still uses closet only — flag reserved for future. */
  onlyCloset?: boolean;
  extraUserText?: string;
  /** User's styling direction (profiles.gender) — e.g. a gay man who wants
   * feminine fits picks "Womenswear" here regardless of his own presentation. */
  genderStylePref?: GenderStylePref;
  /** Onboarding style moods. These softly influence ranking, never filter. */
  styleArchetypes?: StyleArchetypePrefs;
  /** Item-id arrays of the user's recent generated outfits (newest first) —
   * real rotation input so the same pieces stop headlining every batch. */
  recentOutfitItemIds?: string[][];
}): Promise<AutoOutfitPlanRaw[]> {
  const {
    count,
    occasionPhrase,
    closetItems,
    weather,
    anchorItemIds,
    colorHarmony,
    extraUserText,
    genderStylePref,
    styleArchetypes,
    recentOutfitItemIds = [],
  } = params;

  const items = closetPayload(closetItems);

  const baseExtraParts: string[] = [];
  if (colorHarmony)
    baseExtraParts.push("Prioritize tonal color harmony across pieces.");
  const styleInstruction = genderStyleInstruction(genderStylePref);
  if (styleInstruction) baseExtraParts.push(styleInstruction);
  const archetypeInstruction = styleArchetypeInstruction(styleArchetypes);
  if (archetypeInstruction) baseExtraParts.push(archetypeInstruction);
  if (extraUserText?.trim())
    baseExtraParts.push(`User direction: ${extraUserText.trim()}`);
  const baseExtraText = baseExtraParts.join(" ");

  const outcomes: AutoOutfitPlanRaw[] = [];
  const seen = new Set<string>();
  const keptIdArrays: string[][] = [];

  const acceptOutfit = (o: {
    item_ids: string[];
    title?: string;
    reasoning?: string;
  }): boolean => {
    if (!Array.isArray(o.item_ids) || o.item_ids.length === 0) return false;
    const fp = outfitFingerprint(o.item_ids);
    if (seen.has(fp)) return false;
    if (isNearDuplicateOutfit(o.item_ids, keptIdArrays, anchorItemIds)) {
      return false;
    }
    seen.add(fp);
    keptIdArrays.push(o.item_ids);
    outcomes.push({
      title: o.title?.trim() || `Look ${outcomes.length + 1}`,
      reasoning: o.reasoning ?? "",
      item_ids: o.item_ids,
    });
    return true;
  };

  // ── Bulk path (preferred): one round-trip for all outfits ──────────────
  try {
    const bulk = await apiClient.generateOutfitBatch({
      occasion: occasionPhrase,
      count,
      weather,
      items,
      anchorItemIds,
      extraInstructions: baseExtraText,
      recentOutfitItemIds,
    });
    for (const o of bulk) {
      acceptOutfit(o);
      if (outcomes.length >= count) break;
    }
  } catch (err) {
    if (__DEV__ && isRetryableGeminiError(err)) {
      console.warn(
        "[autoOutfitBatch] bulk stylist busy — using single-outfit fallback",
      );
    } else if (__DEV__) {
      console.warn("[autoOutfitBatch] bulk path failed, falling back:", err);
    }
  }

  // ── Per-outfit loop: fallback when bulk failed AND refill when dedupe or
  //    a short bulk answer left us under the requested count ───────────────
  let safety = 0;
  let retryStreak = 0;
  while (outcomes.length < count && safety < count + 6) {
    safety += 1;
    const i = outcomes.length;
    const hints = `${VARIATION_HINTS[i % VARIATION_HINTS.length]} This is variation ${i + 1}.`;
    const avoid =
      outcomes.length > 0
        ? `\nAvoid duplicating almost the exact same combo as earlier answers: ${outcomes
            .map((o) => o.item_ids.join(","))
            .slice(-4)
            .join(" | ")}`
        : "";

    const extra = `${hints}${avoid}${baseExtraText ? `\n${baseExtraText}` : ""}`;

    try {
      const raw = await apiClient.generateOutfits({
        occasion: occasionPhrase,
        weather,
        items,
        anchorItemIds,
        extraInstructions: extra,
        recentOutfitItemIds,
      });

      acceptOutfit(raw);
      retryStreak = 0;
    } catch (err) {
      if (isRetryableGeminiError(err) && retryStreak < 3) {
        retryStreak += 1;
        safety -= 1;
        await sleep(900 * retryStreak);
        continue;
      }
      if (outcomes.length === 0 && isRetryableGeminiError(err)) {
        throw err;
      }
      break;
    }
  }

  return outcomes;
}

export function idsToBuilderItems(
  ids: string[],
  closetItems: ClosetItem[],
): BuilderItem[] {
  const byId = new Map(closetItems.map((c) => [c.id, c]));
  const items: ClosetItem[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const c = byId.get(id);
    if (c) {
      seen.add(id);
      items.push(c);
    }
  }
  return items.map((c, slot) => ({ ...c, slot }));
}

export function heuristicHarmonyScore(
  closetUsed: ClosetItem[],
  emphasizeHarmony: boolean,
): number {
  if (!closetUsed.length) return 76;
  const colors = closetUsed
    .map((c) => (c.color ?? "").toLowerCase().trim())
    .filter((x) => x.length > 1);
  const distinctColors = new Set(colors).size;
  const hueSpreadPenalty = emphasizeHarmony
    ? distinctColors * 5
    : distinctColors * 2;
  const base = emphasizeHarmony ? 90 : 80;
  const lenBoost = Math.min(closetUsed.length * 4, 16);
  const hash =
    closetUsed.reduce((acc, x) => acc + x.id.charCodeAt(0) + x.id.length, 0) %
    11;
  const score = Math.round(base - hueSpreadPenalty + lenBoost * 0.4 + hash);
  return Math.max(61, Math.min(99, score));
}
