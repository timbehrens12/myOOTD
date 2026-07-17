// â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
// â•‘                   RUN AUTOMATIONS                           â•‘
// â•‘                                                              â•‘
// â•‘  Server-side cron target. Finds Auto OOTD schedules that are â•‘
// â•‘  due (per each schedule's own timezone), generates the fit   â•‘
// â•‘  (item selection + optional weather + optional try-on        â•‘
// â•‘  render), saves it, and pushes a real "ready" notification   â•‘
// â•‘  once the outfit truly exists. Never invoked by the client.  â•‘
// â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

import { createClient } from "npm:@supabase/supabase-js@2";

// Shared stylist guard logic — the SAME module the app bundles, so the
// on-demand and automation paths can never drift apart. Covered by
// lib/stylistGuards.test.ts.
import {
  describeWeatherForStylist,
  weatherHardRules,
  STYLIST_COMPOSITION_RULES,
  STYLIST_FAIRNESS_RULE,
  OCCASION_KEY_TO_TAG,
  filterClosetByOccasion,
  userStyleMatchIds,
  userStyleMatchRule,
  outfitHonorsUserStyle,
  sanitizeOutfitSelection,
  outfitStyleConflicts,
  recentlySuggestedIds,
  rotationSortForPrompt,
} from "../../../lib/stylistGuards.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY") ?? "";
const GEMINI_CLASSIFY = "gemini-3.1-flash-lite";
const GEMINI_IMAGE_PRIMARY = "gemini-3.1-flash-lite-image";
const GEMINI_IMAGE_FALLBACK = "gemini-2.5-flash-image";
const DAILY_CAP = Number(Deno.env.get("GENERATION_DAILY_CAP") ?? "15");
const BUCKET = "clothing-images";
// Start preparation this many minutes before the public release. The worker
// records the target release separately and pushes only at that time, or on
// actual completion when a short-notice run finishes late.
const AUTOMATION_LEAD_MINUTES = 10;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// â”€â”€ Occasion phrases (kept in sync with constants/styleMeWheelOccasions.ts) â”€â”€
const OCCASION_PHRASES: Record<string, string> = {
  casual: "Relaxed everyday comfort",
  work: "Polished workplace style",
  date: "Romantic & elevated look",
  night: "Bold & stylish for the evening",
  active: "Functional & athletic",
  travel: "Comfortable transit style",
  formal: "Elegant & sophisticated",
  surprise: "A creative fashion-forward mix",
  custom: "A look tailored to your notes",
};

type Schedule = {
  id: string;
  user_id: string;
  label: string | null;
  occasion: string | null;
  custom_instructions: string | null;
  time_hour: number | null;
  time_minute: number | null;
  days_of_week: number[] | null;
  is_active: boolean | null;
  anchor_item_ids: string[] | null;
  wardrobe_id: string | null;
  consider_weather: boolean | null;
  generate_try_on: boolean | null;
  try_on_photo_url: string | null;
  last_generated_at: string | null;
  last_generated_outfit_id: string | null;
  last_generated_release_at: string | null;
  last_notified_release_at: string | null;
  generation_started_at: string | null;
  generation_scheduled_for: string | null;
  timezone: string | null;
  created_at: string | null;
};

// â”€â”€ Due-ness (timezone aware) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function localPartsInTz(nowUtc: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(nowUtc).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    day: weekdayMap[parts.weekday] ?? nowUtc.getUTCDay(),
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

function localDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));
}

function sameMinute(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && Math.abs(aMs - bMs) < 60_000;
}

/**
 * Exact public release targeted by the current cron tick. The +/- day scan
 * makes the ten-minute lead work across midnight as well as for a schedule
 * created after its normal preparation time (9:57 for a 10:00 run).
 */
function dueReleaseAt(schedule: Schedule, nowUtc: Date): Date | null {
  if (!schedule.is_active) return null;
  const days = schedule.days_of_week ?? [];
  const tz = schedule.timezone || "UTC";
  let local;
  try {
    local = localPartsInTz(nowUtc, tz);
  } catch {
    local = localPartsInTz(nowUtc, "UTC");
  }

  const schedMins = (schedule.time_hour ?? 8) * 60 + (schedule.time_minute ?? 0);
  const nowMins = local.hour * 60 + local.minute;
  const candidates = [-1, 0, 1]
    .map((dayOffset) => ({
      targetDay: (local.day + dayOffset + 7) % 7,
      deltaMinutes: dayOffset * 1440 + schedMins - nowMins,
    }))
    .filter(
      ({ targetDay, deltaMinutes }) =>
        days.includes(targetDay) &&
        deltaMinutes <= AUTOMATION_LEAD_MINUTES &&
        deltaMinutes > -1440,
    )
    .sort((a, b) => b.deltaMinutes - a.deltaMinutes);

  const candidate = candidates[0];
  if (!candidate) return null;

  const releaseAt = new Date(nowUtc);
  releaseAt.setUTCSeconds(0, 0);
  releaseAt.setTime(releaseAt.getTime() + candidate.deltaMinutes * 60_000);

  // A newly created schedule never backfills an occurrence that had already
  // passed. A short-notice schedule remains due when its release is still in
  // the future (for example, created at 9:57 for a 10:00 release).
  const createdAtMs = schedule.created_at
    ? new Date(schedule.created_at).getTime()
    : Number.NaN;
  if (Number.isFinite(createdAtMs) && createdAtMs > releaseAt.getTime()) {
    return null;
  }

  if (sameMinute(schedule.last_generated_release_at, releaseAt.toISOString())) {
    return null;
  }

  const claimStartedMs = schedule.generation_started_at
    ? new Date(schedule.generation_started_at).getTime()
    : Number.NaN;
  const claimIsFresh =
    sameMinute(schedule.generation_scheduled_for, releaseAt.toISOString()) &&
    Number.isFinite(claimStartedMs) &&
    nowUtc.getTime() - claimStartedMs < 45 * 60_000;
  if (claimIsFresh) return null;

  // Backward-compatible duplicate guard for rows generated before the
  // explicit release timestamp existed.
  if (!schedule.last_generated_release_at && schedule.last_generated_at) {
    try {
      const genKey = localDateKey(schedule.last_generated_at, tz);
      const releaseKey = localDateKey(releaseAt.toISOString(), tz);
      if (genKey === releaseKey) return null;
    } catch {
      // Fall through and retry safely when timezone parsing fails.
    }
  }

  return releaseAt;
}
// â”€â”€ Weather (uses the last location the client resolved, saved to profiles) â”€
type OpenMeteoWeather = {
  current_weather?: { temperature: number; weathercode: number };
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
};

type AutomationProfile = {
  last_weather_lat?: number | null;
  last_weather_lon?: number | null;
  gender?: string | null;
  style_archetypes?: string[] | null;
};

async function fetchAutomationProfile(userId: string): Promise<AutomationProfile | undefined> {
  const { data: profile } = await admin
    .from("profiles")
    .select("last_weather_lat,last_weather_lon,gender,style_archetypes")
    .eq("user_id", userId)
    .maybeSingle();

  return (profile ?? undefined) as AutomationProfile | undefined;
}

async function assertAccountActive(userId: string): Promise<void> {
  const { data, error } = await admin
    .from("profiles")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Account is no longer active.");
}

async function fetchWeatherForProfile(profile?: AutomationProfile): Promise<OpenMeteoWeather | undefined> {
  const lat = profile?.last_weather_lat;
  const lon = profile?.last_weather_lon;
  if (typeof lat !== "number" || typeof lon !== "number") return undefined;

  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto`,
    );
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

function normalizeStyleArchetypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const cleaned = value.flatMap((raw) => {
    if (typeof raw !== "string") return [];
    const style = raw.trim();
    return style ? [style] : [];
  });

  // This onboarding option is exclusive in the UI. Treat it as an explicit
  // opt-out even if a legacy/malformed profile also contains named styles.
  if (cleaned.some((style) => style.toLocaleLowerCase() === "i wear it all")) {
    return [];
  }

  const seen = new Set<string>();
  return cleaned.flatMap((style) => {
    const key = style.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [style];
  });
}

function fitDirectionInstruction(value: unknown): string {
  if (value === "Menswear") {
    return "Use the user's saved menswear direction only as a gentle silhouette and styling preference.";
  }
  if (value === "Womenswear") {
    return "Use the user's saved womenswear direction only as a gentle silhouette and styling preference.";
  }
  if (value === "Both") {
    return "The user welcomes both menswear- and womenswear-leaning silhouettes; choose whichever best serves this look.";
  }
  return "";
}

function dailyHighLow(weather?: OpenMeteoWeather): { high: number; low: number } | null {
  const high = weather?.daily?.temperature_2m_max?.[0];
  const low = weather?.daily?.temperature_2m_min?.[0];
  if (typeof high !== "number" || typeof low !== "number") return null;
  return { high: Math.round(high), low: Math.round(low) };
}

// â”€â”€ Gemini item-selection (text-only, mirrors constants/api-client.ts) â”€â”€â”€â”€â”€â”€
async function callGeminiJson(prompt: string): Promise<string> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CLASSIFY}:generateContent?key=${GOOGLE_AI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              topP: 0.95,
              maxOutputTokens: 2048,
              responseMimeType: "application/json",
            },
          }),
        },
      );
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
      }
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

type ClosetItem = {
  id: string;
  name: string | null;
  type: string | null;
  category: string | null;
  color: string | null;
  style: string | null;
  style_tags: string[] | null;
  pattern: string | null;
  formality: string | null;
  occasions: string[] | null;
  seasons: string[] | null;
  wear_count: number | null;
  image_url: string | null;
  image_url_isolated: string | null;
};

function occasionPhrase(schedule: Schedule): string {
  const key = schedule.occasion || "casual";
  const label = (schedule.label || "").trim();
  if (key === "custom") return label || "A stylish outfit";
  return OCCASION_PHRASES[key] || "Stylish outfit â€” cohesive, wearable.";
}

// Stylist guard logic is imported from ../../../lib/stylistGuards.ts —
// the SAME module the app uses, so the two paths can never drift.

/**
 * Item-id arrays of the user's most recent GENERATED outfits (newest first) —
 * the real rotation signal. Server automations save to outfits/outfit_items;
 * on-demand generations write generation_history — read both so the cron
 * rotates against everything the stylist recently suggested, not just its
 * own output.
 */
async function fetchRecentGeneratedItemIds(
  userId: string,
  limit = 6,
): Promise<string[][]> {
  const out: string[][] = [];
  try {
    const { data: hist } = await admin
      .from("generation_history")
      .select("item_ids")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    for (const r of hist ?? []) {
      if (Array.isArray(r.item_ids)) {
        const ids = r.item_ids.filter((x: unknown): x is string => typeof x === "string");
        if (ids.length) out.push(ids);
      }
    }
  } catch {
    // rotation is an enhancement — never block generation on it
  }
  try {
    // Rotation-only table: every look the stylist generated, batch
    // alternatives included — NOT the user's whole outfits library (manually
    // built looks aren't "suggestions" and must not count against rotation).
    const { data: gen } = await admin
      .from("stylist_generation_items")
      .select("item_ids")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    for (const r of gen ?? []) {
      if (Array.isArray(r.item_ids)) {
        const ids = r.item_ids.filter((x: unknown): x is string => typeof x === "string");
        if (ids.length) out.push(ids);
      }
    }
  } catch {
    // same — best-effort
  }
  return out.slice(0, limit * 2);
}

/** Best-effort rotation bookkeeping for a cron-generated pick. */
async function recordStylistGeneration(
  userId: string,
  itemIds: string[],
): Promise<void> {
  if (!itemIds.length) return;
  try {
    await admin
      .from("stylist_generation_items")
      .insert({ user_id: userId, item_ids: itemIds, source: "automation" });
  } catch {
    // rotation bookkeeping must never fail an automation run
  }
}

async function generateOutfitPick(
  schedule: Schedule,
  closetItems: ClosetItem[],
  anchors: string[],
  weather: OpenMeteoWeather | undefined,
  styleArchetypes: string[],
  genderStylePref: string | null | undefined,
  recentOutfitItemIds: string[][] = [],
): Promise<{ item_ids: string[]; title: string; reasoning: string }> {
  const occasion = occasionPhrase(schedule);
  const trimmedInstructions = String(schedule.custom_instructions ?? "").trim();
  const anchorNote = anchors.length
    ? `\nYou MUST include these anchor item IDs: ${anchors.join(", ")}`
    : "";
  const w = describeWeatherForStylist(weather);
  const weatherContext = w ? `Current weather: ${w.line}. ` : "";
  const weatherRules = w ? `\n${weatherHardRules(w)}\n` : "";
  const userDirection =
    schedule.occasion !== "custom" && trimmedInstructions
      ? `\nUSER DIRECTION (TOP PRIORITY): ${trimmedInstructions}
The user's explicit request OVERRIDES saved style preferences and your default aesthetic. If they name an aesthetic, color, or piece, the outfit must visibly honor it. If the closet cannot fully satisfy the request, pick the closest matching pieces and say so in "reasoning"; NEVER silently ignore the request.\n`
      : "";
  const stylePreferenceNote = styleArchetypes.length
    ? `\nThe user's saved style preferences are ${JSON.stringify(styleArchetypes)}. Use these only as gentle inspiration and as a tie-breaker between otherwise equally suitable outfits. Do not force every style into the outfit and do not exclude a strong outfit merely because it is outside these preferences.`
    : "";
  const direction = fitDirectionInstruction(genderStylePref);
  const fitDirectionNote = direction
    ? `\n${direction} Explicit user instructions, occasion, weather, required pieces, and closet cohesion still take priority.`
    : "";

  // Occasion becomes the candidate pool (not just a suggestion) whenever the
  // matching subset can still cover a full outfit. schedule.occasion is a KEY
  // ("date"/"night"/…) so the tag comes from the key map, not phrase parsing.
  const { items: candidates, applied: occasionFiltered } =
    filterClosetByOccasion(
      closetItems,
      occasion,
      anchors,
      OCCASION_KEY_TO_TAG[String(schedule.occasion ?? "")] ?? null,
    );
  const occasionNote = occasionFiltered
    ? `\nThe wardrobe list has been PRE-FILTERED to pieces tagged for this occasion.`
    : "";

  const matchIds = trimmedInstructions
    ? userStyleMatchIds(candidates, trimmedInstructions)
    : null;
  const matchRule = matchIds ? `\n${userStyleMatchRule(matchIds.size)}\n` : "";
  const recentIds = recentlySuggestedIds(recentOutfitItemIds);

  // Rotation-sorted (never-suggested + least-worn first) so the model can't
  // fixate on recently added or recently suggested items.
  const itemList = rotationSortForPrompt(candidates, recentIds).map((it) => ({
    id: it.id,
    name: it.name || `${it.color || ""} ${it.type || it.category}`.trim(),
    type: it.type,
    category: it.category,
    color: it.color,
    style: it.style,
    style_tags: it.style_tags?.length ? it.style_tags : undefined,
    pattern: it.pattern ?? undefined,
    formality: it.formality ?? undefined,
    occasions: it.occasions || [],
    seasons: it.seasons ?? undefined,
    wear_count: typeof it.wear_count === "number" ? it.wear_count : undefined,
    recently_suggested: recentIds.has(it.id) ? true : undefined,
    matches_user_request: matchIds?.has(it.id) ? true : undefined,
  }));

  const buildPrompt = (
    escalation = "",
  ) => `You are an expert fashion stylist. ${weatherContext}Create a complete, cohesive outfit for the occasion: "${occasion}".${anchorNote}
${userDirection}${weatherRules}${matchRule}${escalation}${stylePreferenceNote}${fitDirectionNote}

${STYLIST_COMPOSITION_RULES}

SELECTION RULES:
- Core slots to fill: (top OR "full body") + (bottom if no "full body") + shoes + optional outerwear + optional accessory + optional bag
- All items must work together aesthetically and be appropriate for "${occasion}" and the weather
- Required anchor items, the occasion and user's instructions, weather suitability, and outfit cohesion always take priority over saved style preferences
- Prefer items whose occasions array overlaps the vibe of "${occasion}"${occasionNote}
- Only use IDs from the list below

${STYLIST_FAIRNESS_RULE}

AVAILABLE WARDROBE:
${JSON.stringify(itemList, null, 2)}

Return ONLY a valid JSON object:
{ "item_ids": ["id1", "id2", ...], "title": "short catchy outfit name", "reasoning": "one sentence explaining the choices" }
No markdown, no explanation outside the JSON.`;

  const attempt = async (escalation = "") => {
    const raw = await callGeminiJson(buildPrompt(escalation));
    const parsed = JSON.parse(raw) as {
      item_ids: string[];
      title: string;
      reasoning: string;
    };
    parsed.item_ids = sanitizeOutfitSelection(
      parsed.item_ids,
      candidates,
      anchors,
      w?.tempF,
    );
    return parsed;
  };

  let parsed = await attempt();

  // ONE bounded retry, shared between the two rejection reasons: the model
  // ignored the user's explicit style request, or the deterministic validators
  // found a core-garment clash (formality/color/pattern) they couldn't repair
  // by trimming. Keep whichever attempt is better (fewer conflicts, then more
  // style matches). Automations must still produce SOMETHING for the user's
  // morning, so the final fallback is best-effort, never a no-op.
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const conflictsOf = (ids: string[]) => {
    const picked = ids
      .map((id) => candidateById.get(id))
      .filter((i): i is ClosetItem => !!i);
    return picked.length ? outfitStyleConflicts(picked) : [];
  };
  const styleIgnored =
    !!matchIds &&
    parsed.item_ids.length > 0 &&
    !outfitHonorsUserStyle(parsed.item_ids, matchIds);
  const firstConflicts = conflictsOf(parsed.item_ids);
  if (styleIgnored || firstConflicts.length > 0) {
    try {
      const styleNote = styleIgnored
        ? `\nPREVIOUS ATTEMPT REJECTED: your last answer ignored the USER-REQUEST MATCHING constraint. This attempt MUST build the outfit around the items marked "matches_user_request": true — an answer without them will be discarded.\n`
        : "";
      const conflictNote = firstConflicts.length
        ? `\nPREVIOUS ATTEMPT REJECTED for style incoherence:\n${firstConflicts
            .map((c) => `- ${c}`)
            .join("\n")}\nFix these in this attempt — swap the clashing pieces, do not just re-send the same selection.\n`
        : "";
      const retry = await attempt(styleNote + conflictNote);
      const countMatches = (ids: string[]) => {
        if (!matchIds) return 0;
        let n = 0;
        for (const id of ids) if (matchIds.has(id)) n += 1;
        return n;
      };
      if (retry.item_ids.length > 0) {
        const retryConflicts = conflictsOf(retry.item_ids);
        const better =
          retryConflicts.length < firstConflicts.length ||
          (retryConflicts.length === firstConflicts.length &&
            styleIgnored &&
            countMatches(retry.item_ids) > countMatches(parsed.item_ids));
        if (better) parsed = retry;
      }
    } catch {
      // keep the first attempt — a weaker outfit beats no outfit for a cron run
    }
  }

  return parsed;
}

// â”€â”€ Try-on rendering (mirrors constants/api-client.ts generateOutfitImage) â”€â”€
function classifyTryOnPlacement(item: ClosetItem): string {
  const hay = `${item.category ?? ""} ${item.type ?? ""} ${item.name ?? ""}`.toLowerCase();
  if (/\b(dress|jumpsuit|romper|bodysuit|overall|gown|full[-\s]?body|one[-\s]?piece|playsuit)\b/.test(hay)) {
    return "full-body garment (may replace a one-piece look)";
  }
  if (/\b(shoe|boot|sneaker|sandal|heel|loafer|oxford|footwear|trainer|clog|slide|mule|slipper)\b/.test(hay) || /\b(sock|hosiery|tight)\b/.test(hay)) {
    return "footwear / feet only";
  }
  if (/\b(pant|jean|denim|short|skirt|cargo|chino|khaki|trouser|legging|skort|culotte|culottes)\b/.test(hay)) {
    return "lower body (waist-down)";
  }
  if (/\b(coat|jacket|blazer|outerwear|parka|bomber|anorak|windbreaker|cape|shacket|overshirt|cardigan)\b/.test(hay)) {
    return "outerwear / third layer";
  }
  if (/\b(bag|crossbody|tote|rucksack|backpack|purse|clutch)\b/.test(hay)) {
    return "bag / handheld";
  }
  if (/\b(necklace|belt|jewelry|jewellery|earring|watch|bracelet|ring|accessor|spectacle|glass|beanie|hat|scarf)\b/.test(hay)) {
    return "accessories";
  }
  if (/\b(tee|polo|shirt|top|knitwear|knit|blouse|hoodie|sweater|tank|cami|vest|longsleeve|turtleneck)\b/.test(hay)) {
    return "upper body / torso";
  }
  return "wardrobe piece";
}

function bulletLineForTryOn(item: ClosetItem): string {
  const title = [item.color, item.name || item.type || item.category].filter(Boolean).join(" ").trim();
  return `- ${title} (${classifyTryOnPlacement(item)})`;
}

function isMatch(item: ClosetItem, keys: string[]): boolean {
  const hay = `${item.category ?? ""} ${item.name ?? ""} ${item.type ?? ""}`.toLowerCase();
  return keys.some((k) => hay.includes(k));
}
const isDressLike = (it: ClosetItem) => isMatch(it, ["dress", "gown", "jumpsuit", "romper", "bodysuit", "overall", "one-piece", "onepiece"]);
const isTopLike = (it: ClosetItem) => isMatch(it, ["top", "shirt", "tee", "blouse", "sweater", "knit", "tank", "polo", "henley", "cardigan", "crop"]);
const isBottomLike = (it: ClosetItem) => isMatch(it, ["bottom", "pant", "jean", "denim", "short", "skirt", "trouser", "legging", "chino", "cargo"]);
const isOuterItem = (it: ClosetItem) => isMatch(it, ["outerwear", "jacket", "coat", "blazer", "parka", "windbreaker", "anorak", "vest", "puffer", "bomber"]);
const isShoeItem = (it: ClosetItem) => isMatch(it, ["shoe", "sneaker", "boot", "heel", "sandal", "loafer", "slipper", "oxford", "flat", "mule", "clog"]);
const isBagItem = (it: ClosetItem) => isMatch(it, ["bag", "backpack", "tote", "purse", "clutch", "crossbody", "satchel", "duffel", "briefcase"]);

function garmentImageUrl(it: ClosetItem): string | null {
  const u = it.image_url_isolated || it.image_url;
  return u?.trim() ? u.trim() : null;
}

function pickTryOnGarmentReferenceItems(items: ClosetItem[], maxGarments: number): ClosetItem[] {
  if (maxGarments <= 0) return [];
  const withImg = items.filter((it) => garmentImageUrl(it));
  if (withImg.length === 0) return [];
  const find = (pred: (it: ClosetItem) => boolean) => withImg.find(pred);
  const dress = find(isDressLike);
  const top = find(isTopLike);
  const bottom = find(isBottomLike);
  const outer = find(isOuterItem);
  const shoe = find(isShoeItem);
  const bag = find(isBagItem);
  const pickUnique = (picks: ClosetItem[], candidate: ClosetItem | undefined) => {
    if (!candidate || picks.length >= maxGarments) return picks;
    if (picks.some((p) => p.id === candidate.id)) return picks;
    return [...picks, candidate];
  };
  if (dress) {
    let picks: ClosetItem[] = [dress];
    picks = pickUnique(picks, shoe);
    for (const it of withImg) {
      if (picks.length >= maxGarments) break;
      picks = pickUnique(picks, it);
    }
    return picks.slice(0, maxGarments);
  }
  let picks: ClosetItem[] = [];
  picks = pickUnique(picks, top);
  picks = pickUnique(picks, bottom);
  picks = pickUnique(picks, shoe);
  picks = pickUnique(picks, outer);
  picks = pickUnique(picks, bag);
  for (const it of withImg) {
    if (picks.length >= maxGarments) break;
    picks = pickUnique(picks, it);
  }
  return picks.slice(0, maxGarments);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function urlToBase64(url: string): Promise<string | undefined> {
  try {
    if (url.trim().startsWith("data:image")) {
      const idx = url.indexOf("base64,");
      if (idx !== -1) return url.slice(idx + 7) || undefined;
    }
    const resp = await fetch(url);
    if (!resp.ok) return undefined;
    return arrayBufferToBase64(await resp.arrayBuffer());
  } catch {
    return undefined;
  }
}

function extractInlineImage(response: any): string | null {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const inline = p?.inlineData || p?.inline_data;
    if (inline?.data && /^image\//i.test(inline.mimeType || inline.mime_type || "")) {
      return `data:${inline.mimeType || inline.mime_type};base64,${inline.data}`;
    }
  }
  return null;
}

async function callGeminiImage(model: string, parts: any[]): Promise<any> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.35,
          topP: 0.85,
          maxOutputTokens: 4096,
          responseModalities: ["TEXT", "IMAGE"],
          ...(model.startsWith("gemini-3.1") ? { thinkingConfig: { thinkingLevel: "MINIMAL" } } : {}),
        },
      }),
    },
  );
  return res.json();
}

function sanitizeBackdropHex(raw: string): string {
  const t = raw.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(t) ? t : "#F2F3F6";
}

const TRY_ON_GENERATION_MATTE_HEX = "#E2DFDA";

/** Renders one hero image (mannequin, or on the schedule's saved selfie photo). Mirrors api-client.ts generateOutfitImage. */
async function renderTryOnImage(opts: {
  outfitItems: ClosetItem[];
  occasion: string;
  bodyPhotoBase64?: string;
  backdropHex: string;
  mannequinStudioWhite?: boolean;
  genderStylePref?: string | null;
}): Promise<string | null> {
  const bg = sanitizeBackdropHex(opts.backdropHex);
  const maxGarmentRefs = opts.bodyPhotoBase64 ? 2 : 3;
  const refItems = pickTryOnGarmentReferenceItems(opts.outfitItems, maxGarmentRefs);
  const garmentRefs: { base64: string; mime_type: string; label: string }[] = [];
  for (const it of refItems) {
    const u = garmentImageUrl(it);
    if (!u) continue;
    const b64 = await urlToBase64(u);
    if (!b64) continue;
    garmentRefs.push({
      base64: b64,
      mime_type: "image/jpeg",
      label: [it.color, it.name || it.category || it.type || "piece"].filter(Boolean).join(" ").trim(),
    });
  }

  const outfitIntro = opts.bodyPhotoBase64
    ? "Pieces to apply from the saved wardrobe (partial try-on â€” obey rules below):"
    : "The outfit consists of:";
  const itemDescriptions = opts.bodyPhotoBase64
    ? opts.outfitItems.map((item) => bulletLineForTryOn(item)).join("\n")
    : opts.outfitItems.map((item) => `- ${item.color || ""} ${item.name || item.type || "item"}`.trim()).join("\n");

  const backdropRulesBody = `BACKGROUND: The entire frame behind the subject must be ONE flat, solid color only: exactly ${bg}. No gradients, no paper texture, no studio floor, no horizon, no walls, no furniture, no props. No edge vignette. Every pixel outside the person (and outside their clothing/shoes) must be ${bg}.

MATTE CLEANLINESS (required): Do not add a floor, grounding plane, cast shadow, contact shadow, reflection, glow, halo, or colored spill anywhere around or beneath the subject. The solid ${bg} matte must continue unchanged between the legs, between limbs, around accessories, and directly beneath both feet.

LIGHTING: Professional and even on the subject only. Keep the matte completely unchanged everywhere, including directly beneath the feet.

FRAMING: Full-length head-to-toe â€” never crop below the knees; feet and ankles must stay in frame. Keep the customer's pose, proportions, and crop from their reference photo wherever possible. Do not invent a tighter waist-up crop unless Image 1 is already cropped that way.`;

  const backdropRulesNoBody = `BACKGROUND: The entire frame behind the subject must be ONE flat, solid color only: exactly ${bg}. No gradients, no paper texture, no studio floor, no horizon, no walls, no furniture, no props. No edge vignette. Every pixel outside the person (and outside their clothing/shoes) must be ${bg}.

MATTE CLEANLINESS (required): Do not add a floor, grounding plane, cast shadow, contact shadow, reflection, glow, halo, or colored spill anywhere around or beneath the subject. The solid ${bg} matte must continue unchanged between the legs, between limbs, around accessories, and directly beneath both feet.

LIGHTING: Professional and even on the subject only. Keep the matte completely unchanged everywhere, including directly beneath the feet.

SHOT: Full-body fashion editorial, standing naturally, pleasant expression. Head to toe visible â€” do not crop legs or feet.`;

  const backdropRules = opts.bodyPhotoBase64 ? backdropRulesBody : backdropRulesNoBody;
  const mannequinDirection = opts.bodyPhotoBase64
    ? ""
    : fitDirectionInstruction(opts.genderStylePref);

  const refLines = garmentRefs.length === 0
    ? ""
    : opts.bodyPhotoBase64
      ? `\n\nMULTI-IMAGE ORDER (critical):\n- Image 1 (first image after this text): the CUSTOMER'S photo. It may be full-length with an existing outfit, or tighter framing. Preserve identity: same person, face, hair, skin tone, and body.\n\nPARTIAL TRY-ON (mandatory):\n- The bullet list above lists ONLY the wardrobe pieces to virtual-try-on. Replace ONLY those placements (use each line's parenthetical as the body region â€” e.g. if the list is footwear-only, swap shoes and leave pants, top, jacket, bag, jewelry, and skin unchanged).\n- Preserve any clothing visible in Image 1 that does NOT correspond to a listed piece: same folds, hem lines, and colors unless that exact garment is being replaced.\n- Product images after Image 1 win over text for those slots: match color, silhouette, pattern, logos, typography, and material exactly; do not substitute a different item.\n- For a line with no product image, follow the text alone for that placement â€” use plain neutral fabric if details are unspecified; never invent logos or illegible garment text.\n- Remove/replace the entire original background behind the subject with flat ${bg} only â€” no old room, floor, or horizon.\n\n${garmentRefs.map((g, i) => `- Image ${i + 2}: product reference for "${g.label}". Use only for its matching placement line above.\n`).join("")}`
      : `\n\nMULTI-IMAGE ORDER (critical):\nThe images after this text are PRODUCT REFERENCES for the listed outfit. The generated full-body figure must wear these EXACT items â€” match each reference's colors, pattern, silhouette, logos, typography, and details; do not swap in lookalikes.\n${garmentRefs.map((g, i) => `- Image ${i + 1}: ${g.label}\n`).join("")}`;

  const basePrompt = `Create a clean, professional fashion photo for a ${opts.occasion} occasion.
${outfitIntro}
${itemDescriptions}
${mannequinDirection}
${refLines}

${backdropRules}`;

  const mannequinStudio = opts.mannequinStudioWhite && !opts.bodyPhotoBase64;

  const prompt = opts.bodyPhotoBase64
    ? `${basePrompt}

CRITICAL INSTRUCTION: Start from Image 1 (the customer). You MUST apply EVERY SINGLE ITEM listed above to the person simultaneously in the final image. FACE LOCK: Preserve the customer's EXACT face, head, hair, and skin tone from Image 1, completely unchanged. Replace ONLY those placements. Finally, set the backdrop to solid ${bg} with no trace of the prior environment and no shadow beneath the feet.`
    : mannequinStudio
      ? `${basePrompt}

CRITICAL INSTRUCTION: You MUST dress the mannequin in EVERY SINGLE ITEM listed above simultaneously. Use a matte featureless fashion mannequin in a clearly mid-dark neutral grey (charcoal / graphite tone). Classic smooth full-body display form only: no facial features, no hair, no skin texture. The neutral ${bg} matte must remain perfectly flat and untouched everywhere outside the silhouette, including directly beneath the feet. Do not tint, rim-light, reflect, or color-spill the matte onto the mannequin, garments, shoes, or accessories.`
      : `${basePrompt}

CRITICAL INSTRUCTION: You MUST dress the generic model in EVERY SINGLE ITEM listed above simultaneously. Use a generic full-body fashion model standing in a natural confident pose. Keep the ${bg} matte perfectly flat with no shadow beneath the model.`;

  const parts: any[] = [{ text: prompt }];
  if (opts.bodyPhotoBase64) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: opts.bodyPhotoBase64 } });
  }
  for (const g of garmentRefs) {
    parts.push({ inline_data: { mime_type: g.mime_type, data: g.base64 } });
  }

  for (const model of [GEMINI_IMAGE_PRIMARY, GEMINI_IMAGE_FALLBACK]) {
    try {
      const response = await callGeminiImage(model, parts);
      const uri = extractInlineImage(response);
      if (uri) return uri;
    } catch {
      // try next model
    }
  }
  return null;
}

async function uploadHeroImage(
  userId: string,
  dataUri: string,
): Promise<{ publicUrl: string; path: string } | null> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUri.trim());
  if (!m) return null;
  const contentType = m[1]!;
  const b64 = m[2]!;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeUserId}/previews/outfit_${Date.now()}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(fileName, bytes, {
    contentType,
    upsert: true,
  });
  if (error) return null;
  const { data } = admin.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl ? { publicUrl: data.publicUrl, path: fileName } : null;
}

// â”€â”€ Main per-schedule run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendReadyPush(schedule: Schedule): Promise<void> {
  const { data: tokens } = await admin
    .from("push_tokens")
    .select("token")
    .eq("user_id", schedule.user_id);
  if (!tokens?.length) return;

  const title = (schedule.label || "").trim() || "Auto OOTD";
  const messages = tokens.map(({ token }) => ({
    to: token as string,
    title: `✨ ${title}`,
    body: "Your scheduled look is ready — tap to view.",
    channelId: "automation",
    data: {
      kind: "automation_schedule",
      scheduleId: schedule.id,
      generated: true,
    },
  }));

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(messages),
  });
  if (!response.ok) {
    throw new Error(`Expo push failed (${response.status})`);
  }
}

async function markReleaseNotified(schedule: Schedule, releaseAt: Date): Promise<void> {
  await sendReadyPush(schedule);
  await admin
    .from("autogen_schedules")
    .update({ last_notified_release_at: releaseAt.toISOString() })
    .eq("id", schedule.id)
    .eq("user_id", schedule.user_id);
}

async function runOne(
  schedule: Schedule,
  releaseAt: Date,
): Promise<{ id: string; ok: boolean; error?: string; tryOn?: string }> {
  try {
    await assertAccountActive(schedule.user_id);
    const { data: closetRows } = await admin
      .from("clothing_items")
      .select("id,name,type,category,color,style,style_tags,pattern,formality,occasions,seasons,wear_count,image_url,image_url_isolated")
      .eq("user_id", schedule.user_id);

    let closetItems = (closetRows ?? []) as ClosetItem[];

    if (schedule.wardrobe_id) {
      const { data: memberRows } = await admin
        .from("wardrobe_items")
        .select("clothing_item_id")
        .eq("wardrobe_id", schedule.wardrobe_id);
      const ids = new Set((memberRows ?? []).map((r) => r.clothing_item_id as string));
      closetItems = closetItems.filter((it) => ids.has(it.id));
    }

    if (closetItems.length < 3) {
      throw new Error("Not enough closet items to generate.");
    }

    const anchors = Array.from(
      new Set((schedule.anchor_item_ids ?? []).filter(Boolean)),
    ).filter((id) => closetItems.some((c) => c.id === id));

    const profile = await fetchAutomationProfile(schedule.user_id);
    const styleArchetypes = normalizeStyleArchetypes(profile?.style_archetypes);
    const useWeather = schedule.consider_weather !== false;
    const weather = useWeather ? await fetchWeatherForProfile(profile) : undefined;
    const recentOutfitItemIds = await fetchRecentGeneratedItemIds(
      schedule.user_id,
    );

    const pick = await generateOutfitPick(
      schedule,
      closetItems,
      anchors,
      weather,
      styleArchetypes,
      profile?.gender,
      recentOutfitItemIds,
    );
    const itemIdsOrdered = (pick.item_ids ?? []).filter((id) =>
      closetItems.some((c) => c.id === id),
    );
    if (!itemIdsOrdered.length) {
      throw new Error("AI picked unknown items.");
    }
    await recordStylistGeneration(schedule.user_id, itemIdsOrdered);
    const pickedItems = itemIdsOrdered
      .map((id) => closetItems.find((c) => c.id === id))
      .filter((c): c is ClosetItem => !!c);

    const phrase = occasionPhrase(schedule);
    const trimmedInstructions = String(schedule.custom_instructions ?? "").trim();

    await assertAccountActive(schedule.user_id);
    const { data: outfit, error: outfitErr } = await admin
      .from("outfits")
      .insert({
        user_id: schedule.user_id,
        name: (schedule.label || "").trim().slice(0, 72) || "Automated fit",
        occasion: schedule.occasion || "casual",
        occasion_label:
          schedule.occasion !== "custom" && trimmedInstructions
            ? `${phrase} Â· ${trimmedInstructions}`.slice(0, 120)
            : phrase.slice(0, 120),
        source: "ai",
        saved_to_library: false,
      })
      .select("id")
      .single();
    if (outfitErr || !outfit?.id) throw outfitErr ?? new Error("Insert failed");

    const junctionRows = itemIdsOrdered.map((clothing_item_id: string, idx: number) => ({
      outfit_id: outfit.id,
      clothing_item_id,
      layer_order: idx,
    }));
    const { error: itemsErr } = await admin.from("outfit_items").insert(junctionRows);
    if (itemsErr) throw itemsErr;

    // â”€â”€ Try-on render (metered â€” costs 1 credit, same as manual generation) â”€â”€
    let tryOnNote: string | undefined;
    if (schedule.generate_try_on) {
      const { data: meterRow, error: meterErr } = await admin.rpc("consume_generation_credit", {
        p_user_id: schedule.user_id,
        p_daily_cap: DAILY_CAP,
        p_cost: 1,
      });
      const row = Array.isArray(meterRow) ? meterRow[0] : meterRow;
      if (meterErr || !row?.allowed) {
        tryOnNote = "Daily generation limit reached â€” outfit saved without a try-on render.";
      } else {
        await assertAccountActive(schedule.user_id);
        const refPhoto = schedule.try_on_photo_url?.trim();
        const selfieB64 = refPhoto ? await urlToBase64(refPhoto) : undefined;
        const renderUri = await renderTryOnImage({
          outfitItems: pickedItems,
          occasion: schedule.occasion || "casual",
          backdropHex: TRY_ON_GENERATION_MATTE_HEX,
          bodyPhotoBase64: selfieB64,
          mannequinStudioWhite: !selfieB64,
          genderStylePref: profile?.gender,
        });
        if (renderUri) {
          await assertAccountActive(schedule.user_id);
          const uploadedRender = await uploadHeroImage(schedule.user_id, renderUri);
          if (uploadedRender) {
            try {
              await assertAccountActive(schedule.user_id);
            } catch (error) {
              await admin.storage.from(BUCKET).remove([uploadedRender.path]);
              throw error;
            }
            await admin
              .from("outfits")
              .update({
                preview_image_url: uploadedRender.publicUrl,
                try_on_image_url: uploadedRender.publicUrl,
              })
              .eq("id", outfit.id)
              .eq("user_id", schedule.user_id);
          } else {
            tryOnNote = "Try-on render failed to upload â€” outfit saved without it.";
          }
        } else {
          tryOnNote = "Try-on render failed â€” outfit saved without it.";
        }
      }
    }

    const now = new Date().toISOString();
    const weatherUsed = useWeather && !!weather?.current_weather;
    const weatherRange = weatherUsed ? dailyHighLow(weather) : null;

    await assertAccountActive(schedule.user_id);
    await admin
      .from("autogen_schedules")
      .update({
        last_generated_at: now,
        last_generated_outfit_id: outfit.id,
        last_generated_release_at: releaseAt.toISOString(),
        last_generated_weather_used: weatherUsed,
        last_generated_temp_high: weatherRange?.high ?? null,
        last_generated_temp_low: weatherRange?.low ?? null,
        generation_started_at: null,
        generation_scheduled_for: null,
        updated_at: now,
      })
      .eq("id", schedule.id)
      .eq("user_id", schedule.user_id);

    // A late short-notice run notifies immediately on completion. An early
    // run is released by the next cron tick at the exact configured minute.
    if (Date.now() >= releaseAt.getTime()) {
      await markReleaseNotified(schedule, releaseAt);
    }
    return { id: schedule.id, ok: true, tryOn: tryOnNote };
  } catch (e) {
    await admin
      .from("autogen_schedules")
      .update({ generation_started_at: null, generation_scheduled_for: null })
      .eq("id", schedule.id)
      .eq("user_id", schedule.user_id);
    return { id: schedule.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleCronRequest(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const provided = req.headers.get("x-cron-secret") ?? "";
  const { data: verified, error: verifyErr } = await admin.rpc(
    "verify_cron_secret",
    { p_secret: provided },
  );
  if (verifyErr || verified !== true) {
    return json({ error: "unauthorized" }, 401);
  }

  const nowUtc = new Date();

  // Index-assisted prefilter (autogen_due_schedules RPC): returns only rows
  // that are either inside the prep lead window (next_release_at, maintained
  // by trigger) or awaiting their release push — instead of every active
  // schedule on every tick. The RPC is a deliberate SUPERSET; dueReleaseAt /
  // the notify checks below remain the correctness authority.
  const { data: schedules, error } = await admin.rpc("autogen_due_schedules", {
    p_now: nowUtc.toISOString(),
    p_lead_minutes: AUTOMATION_LEAD_MINUTES,
  });

  if (error) return json({ error: "query_failed", detail: error.message }, 500);

  const allSchedules = (schedules ?? []) as Schedule[];

  // Release prepared looks at the promised minute. This replaces the old
  // device-local "ready" notification, which could lie for short-notice runs.
  const released: string[] = [];
  for (const schedule of allSchedules) {
    const releaseAt = schedule.last_generated_release_at
      ? new Date(schedule.last_generated_release_at)
      : null;
    const shouldNotify =
      // The RPC's notify branch doesn't filter on is_active (the old query
      // did) — keep requiring it here so a schedule the user deactivated
      // after its look was prepared never sends a stale "ready" push.
      !!schedule.is_active &&
      !!schedule.last_generated_outfit_id &&
      !!releaseAt &&
      Number.isFinite(releaseAt.getTime()) &&
      releaseAt.getTime() <= nowUtc.getTime() &&
      !sameMinute(
        schedule.last_notified_release_at,
        schedule.last_generated_release_at,
      );
    if (!shouldNotify || !releaseAt) continue;

    try {
      await markReleaseNotified(schedule, releaseAt);
      released.push(schedule.id);
    } catch {
      // Keep it unmarked so the next one-minute cron tick retries delivery.
    }
  }

  const due = allSchedules
    .map((schedule) => ({
      schedule,
      releaseAt: dueReleaseAt(schedule, nowUtc),
    }))
    .filter(
      (entry): entry is { schedule: Schedule; releaseAt: Date } =>
        entry.releaseAt !== null,
    );

  const results = [];
  for (const { schedule, releaseAt } of due) {
    const claimAt = new Date().toISOString();
    const { error: claimError } = await admin
      .from("autogen_schedules")
      .update({
        generation_started_at: claimAt,
        generation_scheduled_for: releaseAt.toISOString(),
      })
      .eq("id", schedule.id)
      .eq("user_id", schedule.user_id);

    if (claimError) {
      results.push({ id: schedule.id, ok: false, error: claimError.message });
      continue;
    }
    results.push(await runOne(schedule, releaseAt));
  }

  return json({
    checked: allSchedules.length,
    due: due.length,
    released,
    results,
  });
}

Deno.serve(async (req) => {
  try {
    return await handleCronRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("run-automations request failed", error);
    return json({ error: "worker_failed", detail: message }, 500);
  }
});
