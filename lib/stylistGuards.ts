// ╔══════════════════════════════════════════════════════════╗
// ║                    STYLIST GUARDS                          ║
// ║                                                            ║
// ║  THE single source of truth for outfit-generation rules.   ║
// ║  Imported by BOTH:                                         ║
// ║    - constants/api-client.ts        (on-demand styling)    ║
// ║    - supabase/functions/run-automations  (Auto OOTD cron)  ║
// ║                                                            ║
// ║  Keep this file dependency-free (no react-native, no npm,  ║
// ║  no Deno APIs) so both runtimes can import it and the test ║
// ║  suite can exercise it directly. Covered by                ║
// ║  lib/stylistGuards.test.ts — run `npm run test:guards`.    ║
// ╚══════════════════════════════════════════════════════════╝

/** Structural shape shared by the client's ClosetItem and the server's row. */
export type StylistItem = {
  id: string;
  name?: string | null;
  type?: string | null;
  sub_category?: string | null;
  category?: string | null;
  color?: string | null;
  style?: string | null;
  style_tags?: string[] | null;
  pattern?: string | null;
  formality?: string | null;
  occasions?: string[] | null;
  seasons?: string[] | null;
  wear_count?: number | null;
};

export type StylistOutfit = {
  item_ids: string[];
  title: string;
  reasoning: string;
};

// ── Small utilities ──────────────────────────────────────────────────────────

export function normCategory(cat: unknown): string {
  return String(cat ?? "")
    .toLowerCase()
    .trim();
}

function itemHaystack(it: StylistItem): string {
  return `${it.name ?? ""} ${it.type ?? ""} ${it.sub_category ?? ""}`.toLowerCase();
}

/** Fisher–Yates. The closet is fetched newest-first everywhere; feeding that
 * order to the model is exactly why "every look uses my newest uploads". */
export function shuffleForPrompt<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Weather ──────────────────────────────────────────────────────────────────

export function weatherCodeToCondition(code: number): string {
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  return "thunderstorm";
}

export type StylistWeather = {
  line: string;
  tempF: number;
  wet: boolean;
  snowy: boolean;
};

/**
 * Normalize either open-meteo response shape into a stylist-readable line.
 * `current_weather=true` returns { current_weather: { temperature, weathercode } };
 * `current=temperature_2m,weather_code` returns { current: { temperature_2m, weather_code } }.
 * Reading only the first shape is why the client path silently generated with
 * NO weather context at all.
 */
export function describeWeatherForStylist(weather: any): StylistWeather | null {
  if (!weather) return null;
  const cw = weather.current_weather;
  const c = weather.current;
  const temp =
    typeof cw?.temperature === "number"
      ? cw.temperature
      : typeof c?.temperature_2m === "number"
        ? c.temperature_2m
        : undefined;
  const code =
    typeof cw?.weathercode === "number"
      ? cw.weathercode
      : typeof c?.weather_code === "number"
        ? c.weather_code
        : undefined;
  if (typeof temp !== "number") return null;

  const tempF = Math.round(temp);
  const condition = typeof code === "number" ? weatherCodeToCondition(code) : "";
  const high = weather?.daily?.temperature_2m_max?.[0];
  const low = weather?.daily?.temperature_2m_min?.[0];
  const precip = weather?.daily?.precipitation_probability_max?.[0];

  const parts = [`${tempF}°F${condition ? `, ${condition}` : ""}`];
  if (typeof high === "number" && typeof low === "number") {
    parts.push(`today ${Math.round(low)}–${Math.round(high)}°F`);
  }
  if (typeof precip === "number" && precip >= 30) {
    parts.push(`${Math.round(precip)}% chance of precipitation`);
  }

  const wet =
    /drizzle|rain|thunderstorm/.test(condition) ||
    (typeof precip === "number" && precip >= 60);
  const snowy = /snow/.test(condition);

  return { line: parts.join(" · "), tempF, wet, snowy };
}

/** Hard, non-negotiable weather constraints appended when weather is known. */
export function weatherHardRules(w: StylistWeather): string {
  const rules: string[] = [
    `WEATHER RULES (hard constraints — never violate these):`,
  ];
  if (w.tempF >= 75) {
    rules.push(
      `- It is HOT (${w.tempF}°F). NEVER pick sweaters, hoodies, fleece, puffers, coats, wool, boots, or scarves. Prefer breathable pieces (tees, tanks, shorts, dresses, sandals, sneakers). Items tagged seasons ["fall","winter"] are OFF-LIMITS.`,
    );
  } else if (w.tempF >= 60) {
    rules.push(
      `- Mild (${w.tempF}°F): light layers are fine; skip heavy winter pieces (puffers, wool coats, snow boots).`,
    );
  } else if (w.tempF >= 45) {
    rules.push(
      `- Cool (${w.tempF}°F): include at least one warm layer (jacket, sweater, or coat).`,
    );
  } else {
    rules.push(
      `- It is COLD (${w.tempF}°F). The outfit MUST include real outerwear (coat/puffer/jacket) or a heavy knit. NEVER pick shorts, tank tops, sandals, or items tagged seasons ["spring","summer"] as the main pieces.`,
    );
  }
  if (w.wet) {
    rules.push(
      `- Precipitation expected: prefer closed shoes and a weather-appropriate outer layer; avoid suede and delicate fabrics.`,
    );
  }
  if (w.snowy) {
    rules.push(
      `- Snow: boots or weatherproof shoes only; no canvas sneakers, sandals, or heels.`,
    );
  }
  return rules.join("\n");
}

// ── Shared prompt blocks ─────────────────────────────────────────────────────

export const STYLIST_COMPOSITION_RULES = `COMPOSITION RULES (hard constraints):
- Core slots: exactly ONE bottom OR one "full body" piece (never both), exactly ONE pair of shoes, at most ONE outerwear piece, at most one bag.
- Tops: one base top. A second top is allowed ONLY as a real layering move (e.g. tee under an open shirt or knit) — NEVER two sweaters, two hoodies, or two heavy knits together.
- LAYER ORDER must make physical sense: base layer (tank/tee/cami) → mid layer (shirt/knit/sweater/hoodie) → outer layer (coat/jacket/blazer). Outerwear is ALWAYS outermost; never put a heavy knit over a coat.
- FORMALITY COHERENCE: keep every piece within one formality step of the rest. Never pair formal/cocktail pieces (dresses, suits, dress shoes, heels) with athletic or loungewear (hoodies, sweatpants, gym shorts, running shoes, slides). Never pair gym clothes with dress shoes.

COLOR RULES:
- Build on 1–2 neutrals (black, white, cream, grey, navy, denim, tan/brown) plus at MOST two accent colors.
- Accents must work together — echo an accent from one piece in another when possible. Avoid clashing saturated colors on adjacent pieces unless the user explicitly asks for bold color-blocking.
- At most ONE statement/patterned piece per outfit; keep everything else quiet around it.`;

export const STYLIST_FAIRNESS_RULE = `FAIRNESS: The wardrobe list below is in RANDOM order. Do not favor items near the top of the list or recently added items — every item deserves equal consideration. When two picks are equally good, prefer the LESS-worn one (lower wear_count) so the whole closet gets rotated. Items marked "recently_suggested": true appeared in the user's last few generated outfits — AVOID them unless the outfit genuinely needs them.`;

/** Elevate the user's explicit ask above everything else in the prompt. */
export function userDirectionBlock(extraInstructions?: string): string {
  const text = extraInstructions?.trim();
  if (!text) return "";
  return `\nUSER DIRECTION (TOP PRIORITY): ${text}
The user's explicit request OVERRIDES saved style preferences and your default aesthetic. If they name an aesthetic, color, or piece, every outfit must visibly honor it. If the closet cannot fully satisfy the request, pick the closest matching pieces and say so in "reasoning" — NEVER silently ignore the request.\n`;
}

// ── Occasion filtering ───────────────────────────────────────────────────────

/** Map a free-form occasion phrase onto the closet's occasion tag vocabulary. */
export function occasionTagForPhrase(phrase: string): string | null {
  const p = phrase.toLowerCase();
  if (/\b(gym|workout|run(?:ning)?|train(?:ing)?|active|sport|pilates|yoga|hike)\b/.test(p))
    return "active";
  if (/\bwork(?:place|wear|day|ing)?\b|\b(office|meeting|interview|business|presentation)\b/.test(p))
    return "work";
  if (/\b(formal|wedding|cocktail|gala|black[-\s]?tie|ceremony)\b/.test(p))
    return "formal";
  if (/\b(travel|airport|flight|road\s*trip|vacation)\b/.test(p)) return "travel";
  if (/\b(lounge|loung(?:ing|e)|home|movie\s*night|cozy|comfy|chill|lazy)\b/.test(p))
    return "lounge";
  if (/\b(dinner|date|party|club|night\s*out|going[-\s]?out|drinks|bar|concert)\b/.test(p))
    return "going-out";
  if (/\b(casual|errands?|brunch|coffee|everyday|beach|park|walk)\b/.test(p))
    return "casual";
  return null;
}

/** schedule.occasion key → the closet's occasion tag vocabulary. */
export const OCCASION_KEY_TO_TAG: Record<string, string> = {
  casual: "casual",
  work: "work",
  date: "going-out",
  night: "going-out",
  active: "active",
  travel: "travel",
  formal: "formal",
};

/**
 * Adaptive occasion hard-filter: when the phrase maps to a known tag AND the
 * matching subset can still dress a person (enough items + all core slots
 * covered), only occasion-appropriate items are sent to the model at all —
 * the occasion stops being a suggestion and becomes the candidate pool.
 * Small closets fall through to the full list so users never get zero looks.
 */
export function filterClosetByOccasion<T extends StylistItem>(
  items: T[],
  occasion: string,
  anchorIds: string[],
  tagOverride?: string | null,
): { items: T[]; applied: boolean } {
  const tag = tagOverride ?? occasionTagForPhrase(occasion);
  if (!tag) return { items, applied: false };
  const anchors = new Set(anchorIds);
  const matches = items.filter(
    (it) =>
      anchors.has(it.id) ||
      (it.occasions ?? []).some((o) => String(o).toLowerCase().trim() === tag),
  );
  if (matches.length < 8) return { items, applied: false };
  const cats = new Set(matches.map((i) => normCategory(i.category)));
  const coversCore =
    cats.has("shoes") &&
    (cats.has("full body") || (cats.has("top") && cats.has("bottom")));
  if (!coversCore) return { items, applied: false };
  return { items: matches, applied: true };
}

// ── Explicit user style requests ─────────────────────────────────────────────

const USER_STYLE_STOPWORDS = new Set([
  "make", "build", "create", "give", "show", "want", "need", "please",
  "outfit", "outfits", "look", "looks", "fit", "fits", "wear", "wearing",
  "style", "styled", "styling", "aesthetic", "vibe", "vibes", "something",
  "with", "and", "the", "for", "that", "this", "like", "more", "less",
  "user", "direction", "today", "tonight", "day", "night",
]);

/**
 * Hard style matching for explicit user requests ("Y2K streetwear"): find the
 * closet items whose metadata actually matches the user's words. When enough
 * exist, they're flagged in the payload, the prompt REQUIRES using them, and
 * `enforceUserStyleMatch` drops outfits that ignored the request.
 */
export function userStyleMatchIds(
  items: StylistItem[],
  extraInstructions?: string,
): Set<string> | null {
  const raw = extraInstructions?.trim();
  if (!raw) return null;
  // Callers may bundle system notes with the user's text — only the segment
  // after "User direction:" is the user's own ask when that marker exists.
  const m = raw.match(/user direction:\s*([\s\S]+)$/i);
  const text = (m ? m[1] : raw).toLowerCase();
  const tokens = Array.from(
    new Set(
      text
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !USER_STYLE_STOPWORDS.has(t)),
    ),
  );
  if (tokens.length === 0) return null;
  const matched = new Set<string>();
  for (const it of items) {
    const hay =
      `${it.name ?? ""} ${it.type ?? ""} ${it.sub_category ?? ""} ${it.style ?? ""} ${(it.style_tags ?? []).join(" ")} ${it.color ?? ""} ${(it.occasions ?? []).join(" ")}`.toLowerCase();
    // Bidirectional: "streetwear" in the ask must match an item tagged
    // "street", and an ask for "minimal" must match "minimalist" items.
    const hayWords = hay.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    if (
      tokens.some((t) => hay.includes(t) || hayWords.some((w) => t.includes(w)))
    ) {
      matched.add(it.id);
    }
  }
  // Need a real signal: at least 3 matching items, and not "everything
  // matched" (generic words like "black" can light up the whole closet).
  if (matched.size < 3 || matched.size > items.length * 0.8) return null;
  return matched;
}

/** How many matching pieces each outfit must contain. Mirrored by the prompt
 * text AND by `enforceUserStyleMatch`, so the two can never disagree. */
export function requiredUserStyleMatches(matchCount: number): number {
  return matchCount >= 2 ? 2 : 1;
}

export function userStyleMatchRule(matchCount: number): string {
  const need = requiredUserStyleMatches(matchCount);
  return `USER-REQUEST MATCHING (hard constraint): Items marked "matches_user_request": true are the pieces that match the user's explicit request (${matchCount} available). Every outfit MUST include at least ${need} of them — build each look AROUND these pieces, then complete it with compatible basics.`;
}

/** True when an outfit actually honored the user's explicit style request. */
export function outfitHonorsUserStyle(
  itemIds: string[],
  matchIds: Set<string>,
): boolean {
  const need = requiredUserStyleMatches(matchIds.size);
  let hits = 0;
  for (const id of itemIds) if (matchIds.has(id)) hits += 1;
  return hits >= need;
}

/**
 * Drop outfits that ignored an explicit style request.
 *
 * Returns `[]` when NOTHING honored the request — deliberately. The old code
 * fell back to the unfiltered list in exactly that case, which meant the one
 * failure that matters ("I asked for Y2K streetwear and got a summer dress")
 * was the one case the filter did nothing about. Callers retry instead.
 */
export function enforceUserStyleMatch<T extends { item_ids: string[] }>(
  outfits: T[],
  matchIds: Set<string> | null,
): T[] {
  if (!matchIds) return outfits;
  return outfits.filter((o) => outfitHonorsUserStyle(o.item_ids, matchIds));
}

// ── Rotation (real generation history, not wear_count) ────────────────────────

/**
 * Items used in the user's recent generated outfits. `recentOutfits` is an
 * array of item-id arrays, newest first. Anything appearing in the most recent
 * `depth` outfits is flagged so the prompt can steer away from it.
 *
 * This is deliberately NOT wear_count: wear_count tracks what was actually
 * WORN, which says nothing about what the stylist keeps SUGGESTING. An item
 * suggested 5 times and never worn has wear_count 0 and would otherwise look
 * like a fresh pick forever.
 */
export function recentlySuggestedIds(
  recentOutfits: string[][],
  depth = 6,
): Set<string> {
  const out = new Set<string>();
  for (const ids of recentOutfits.slice(0, depth)) {
    for (const id of ids) out.add(id);
  }
  return out;
}

/**
 * Rank items for prompt ordering: never-suggested and least-worn first.
 * Combined with the shuffle this gives genuine closet coverage instead of the
 * model re-picking whatever it saw first.
 */
export function rotationSortForPrompt<T extends StylistItem>(
  items: T[],
  recentIds: Set<string>,
): T[] {
  // Shuffle first so ties don't fall back to insertion (newest-first) order.
  return shuffleForPrompt(items).sort((a, b) => {
    const aRecent = recentIds.has(a.id) ? 1 : 0;
    const bRecent = recentIds.has(b.id) ? 1 : 0;
    if (aRecent !== bRecent) return aRecent - bRecent;
    const aWorn = typeof a.wear_count === "number" ? a.wear_count : 0;
    const bWorn = typeof b.wear_count === "number" ? b.wear_count : 0;
    return aWorn - bWorn;
  });
}

// ── Formality ────────────────────────────────────────────────────────────────

const FORMALITY_RANK: Record<string, number> = {
  athletic: 0,
  active: 0,
  sport: 0,
  sporty: 0,
  lounge: 0,
  loungewear: 0,
  casual: 1,
  everyday: 1,
  "smart-casual": 2,
  smart_casual: 2,
  "smart casual": 2,
  business: 3,
  "business-casual": 3,
  work: 3,
  office: 3,
  formal: 4,
  cocktail: 4,
  evening: 4,
  "black-tie": 4,
};

const ATHLETIC_RE =
  /\b(gym|athletic|running|sweatpant|sweatshort|track\s*pant|jogger|legging|sports\s*bra|hoodie|sweatpants|basketball|soccer|yoga|workout|slide|flip[-\s]?flop)\b/i;
const FORMAL_RE =
  /\b(cocktail|gowns?|tuxedos?|suits?|blazers?|dress\s*shirts?|dress\s*shoes?|oxfords?|derby|derbies|loafers?|heels?|pumps?|stilettos?|slingbacks?|evening|ball\s*gowns?|ties?|bow\s*ties?)\b/i;

/** Item formality rank, from the stored column when present, else inferred. */
export function formalityRank(it: StylistItem): number | null {
  const f = String(it.formality ?? "").toLowerCase().trim();
  if (f && f in FORMALITY_RANK) return FORMALITY_RANK[f];
  const hay = itemHaystack(it);
  if (ATHLETIC_RE.test(hay)) return 0;
  if (FORMAL_RE.test(hay)) return 4;
  return null;
}

/** Core slots — the pieces whose formality actually defines the outfit. */
const CORE_CATS = new Set(["top", "bottom", "full body", "outerwear", "shoes"]);

/**
 * Reject items that clash in formality with the rest of the outfit.
 * Spread > 2 ranks = incoherent (cocktail dress[4] + hoodie[1] = 3; gym
 * shorts[0] + dress shoes[3] = 3). Anchors are never dropped, and core
 * garments are only dropped when a *majority* disagrees with them, so we can
 * never strip an outfit down to nothing.
 */
export function dropFormalityOutliers<T extends StylistItem>(
  picked: T[],
  anchors: Set<string>,
): T[] {
  const ranked = picked
    .filter((i) => CORE_CATS.has(normCategory(i.category)))
    .map((i) => ({ item: i, rank: formalityRank(i) }))
    .filter((r): r is { item: T; rank: number } => r.rank !== null);
  if (ranked.length < 2) return picked;

  const ranks = ranked.map((r) => r.rank).sort((a, b) => a - b);
  const spread = ranks[ranks.length - 1] - ranks[0];
  if (spread <= 2) return picked;

  // Majority formality wins; drop the pieces more than 2 steps away from it.
  const median = ranks[Math.floor(ranks.length / 2)];
  const drop = new Set(
    ranked
      .filter((r) => Math.abs(r.rank - median) > 2 && !anchors.has(r.item.id))
      .map((r) => r.item.id),
  );
  if (drop.size === 0) return picked;
  const kept = picked.filter((i) => !drop.has(i.id));
  // Never let the guard destroy the outfit's structure: the fix must keep a
  // base garment AND every shoe slot the outfit came with (removing the only
  // shoes "fixes" the clash by making the look unwearable). When the drop
  // would do that, keep the clash — outfitStyleConflicts still reports it, so
  // the caller can regenerate instead.
  const keptCats = new Set(kept.map((i) => normCategory(i.category)));
  const hadCats = new Set(picked.map((i) => normCategory(i.category)));
  const stillWearable =
    (keptCats.has("full body") ||
      keptCats.has("top") ||
      keptCats.has("bottom")) &&
    (!hadCats.has("shoes") || keptCats.has("shoes"));
  return stillWearable ? kept : picked;
}

/**
 * Deterministic conflict report for an already-sanitised outfit. Non-empty
 * means the validators saw a real core-garment clash they could not repair by
 * trimming accessories — the caller should regenerate ONCE with these notes
 * rather than ship the look.
 */
export function outfitStyleConflicts(picked: StylistItem[]): string[] {
  const conflicts: string[] = [];

  const ranked = picked
    .filter((i) => CORE_CATS.has(normCategory(i.category)))
    .map((i) => ({ item: i, rank: formalityRank(i) }))
    .filter((r): r is { item: StylistItem; rank: number } => r.rank !== null);
  if (ranked.length >= 2) {
    const sorted = [...ranked].sort((a, b) => a.rank - b.rank);
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    if (hi.rank - lo.rank > 2) {
      conflicts.push(
        `formality clash: "${lo.item.name ?? lo.item.id}" is too casual/athletic to pair with "${hi.item.name ?? hi.item.id}"`,
      );
    }
  }

  const families: string[] = [];
  for (const it of picked) {
    const fam = colorFamily(it.color);
    if (fam && !families.includes(fam)) families.push(fam);
  }
  if (families.length > 2) {
    conflicts.push(
      `color clash: ${families.length} competing accent colours (${families.join(", ")}) — keep at most two plus neutrals`,
    );
  }

  const patternedCore = picked.filter((it) => {
    const p = String(it.pattern ?? "").toLowerCase().trim();
    const patterned = !!p && p !== "solid" && p !== "plain" && p !== "none";
    return patterned && !TRIMMABLE.includes(normCategory(it.category));
  });
  if (patternedCore.length > 1) {
    conflicts.push(
      `pattern overload: ${patternedCore.length} patterned statement pieces (${patternedCore.map((i) => i.name ?? i.id).join(", ")}) — keep one`,
    );
  }

  return conflicts;
}

// ── Colour ───────────────────────────────────────────────────────────────────

const NEUTRALS = new Set([
  "black", "white", "cream", "ivory", "beige", "tan", "taupe", "grey", "gray",
  "charcoal", "navy", "denim", "brown", "khaki", "camel", "stone", "sand",
  "silver", "off-white", "offwhite", "nude", "chocolate", "espresso",
]);

/** Coarse hue family for accent-count logic. Neutrals return null. */
export function colorFamily(raw: unknown): string | null {
  const c = String(raw ?? "").toLowerCase().trim();
  if (!c) return null;
  const first = c.split(/[^a-z-]+/).filter(Boolean).pop() ?? c;
  if (NEUTRALS.has(c) || NEUTRALS.has(first)) return null;
  if (/\b(red|crimson|scarlet|cherry)\b/.test(c)) return "red";
  if (/\b(burgundy|maroon|wine|oxblood)\b/.test(c)) return "burgundy";
  if (/\b(pink|blush|rose|fuchsia|magenta)\b/.test(c)) return "pink";
  if (/\b(orange|rust|terracotta|apricot|coral|peach)\b/.test(c)) return "orange";
  if (/\b(yellow|mustard|gold|lemon|butter)\b/.test(c)) return "yellow";
  if (/\b(green|olive|sage|emerald|mint|lime|forest)\b/.test(c)) return "green";
  if (/\b(teal|turquoise|aqua|cyan)\b/.test(c)) return "teal";
  if (/\b(blue|cobalt|azure|sky|indigo|periwinkle)\b/.test(c)) return "blue";
  if (/\b(purple|violet|lavender|lilac|plum|mauve)\b/.test(c)) return "purple";
  return null;
}

/** Slots we may trim to fix colour overload — never core garments. */
const TRIMMABLE = ["accessory", "bag"];

/**
 * Enforce "1–2 neutrals + at most TWO accent colours".
 *
 * Only accessories/bags are ever dropped: trimming a third accent is a real
 * fix, but silently deleting someone's trousers to satisfy a colour rule would
 * be worse than the clash. Anchors are always kept.
 */
export function dropColorClashes<T extends StylistItem>(
  picked: T[],
  anchors: Set<string>,
  maxAccents = 2,
): T[] {
  const families: string[] = [];
  for (const it of picked) {
    const fam = colorFamily(it.color);
    if (fam && !families.includes(fam)) families.push(fam);
  }
  if (families.length <= maxAccents) return picked;

  const allowed = new Set(families.slice(0, maxAccents));
  const out: T[] = [];
  for (const it of picked) {
    const fam = colorFamily(it.color);
    const trimmable = TRIMMABLE.includes(normCategory(it.category));
    if (fam && !allowed.has(fam) && trimmable && !anchors.has(it.id)) continue;
    out.push(it);
  }
  return out;
}

/** At most ONE statement/patterned piece — trim extra patterned accessories. */
export function dropPatternOverload<T extends StylistItem>(
  picked: T[],
  anchors: Set<string>,
): T[] {
  const isPatterned = (it: StylistItem) => {
    const p = String(it.pattern ?? "").toLowerCase().trim();
    return !!p && p !== "solid" && p !== "plain" && p !== "none";
  };
  let seen = 0;
  const out: T[] = [];
  for (const it of picked) {
    if (isPatterned(it)) {
      seen += 1;
      if (
        seen > 1 &&
        TRIMMABLE.includes(normCategory(it.category)) &&
        !anchors.has(it.id)
      ) {
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

// ── Layering ─────────────────────────────────────────────────────────────────

const BASE_TOP_RE = /\b(tank|cami|camisole|bodysuit|undershirt|bralette|tube\s*top)\b/i;
const HEAVY_KNIT_RE =
  /\b(sweater|hoodie|knit|fleece|cardigan|pullover|jumper|turtleneck|sweatshirt|crewneck)\b/i;

/**
 * base → mid → outer, then bottoms, shoes, bag, accessories.
 * Feeds `outfit_items.layer_order` and the try-on render order, so the model's
 * arbitrary array order can't put a coat under a t-shirt.
 */
export function layerRank(it: StylistItem): number {
  const cat = normCategory(it.category);
  const hay = itemHaystack(it);
  if (cat === "outerwear") return 3;
  if (cat === "top") {
    if (BASE_TOP_RE.test(hay)) return 1;
    if (HEAVY_KNIT_RE.test(hay)) return 2.5;
    return 2;
  }
  if (cat === "full body") return 2;
  if (cat === "bottom") return 4;
  if (cat === "shoes") return 5;
  if (cat === "bag") return 6;
  return 7;
}

/** Order item ids base → mid → outer (stable within a rank). */
export function orderOutfitLayers<T extends StylistItem>(picked: T[]): T[] {
  return picked
    .map((item, i) => ({ item, i, rank: layerRank(item) }))
    .sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank))
    .map((x) => x.item);
}

// ── Outfit selection sanitiser ───────────────────────────────────────────────

const SLOT_CAPS: Record<string, number> = {
  top: 2,
  bottom: 1,
  shoes: 1,
  "full body": 1,
  outerwear: 1,
  bag: 1,
  accessory: 3,
};

/**
 * Validate + repair a model outfit selection:
 *  - drop hallucinated IDs (not in the wardrobe) and duplicates
 *  - force anchors in
 *  - enforce slot caps (1 bottom, 1 shoes, ≤2 tops, no double heavy knits,
 *    no bottom alongside a full-body piece)
 *  - drop season-impossible picks when the temperature is known
 *  - drop formality outliers, excess accent colours, pattern overload
 *  - return ids ordered base → mid → outer
 * Anchors bypass every guard — the user explicitly demanded them.
 */
export function sanitizeOutfitSelection(
  rawIds: unknown,
  items: StylistItem[],
  anchorIds: string[],
  tempF?: number,
): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const anchors = new Set(anchorIds.filter((a) => byId.has(a)));

  const ids = Array.isArray(rawIds)
    ? (rawIds.filter((s) => typeof s === "string") as string[])
    : [];
  const seen = new Set<string>();
  const picked: StylistItem[] = [];
  for (const id of ids) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    picked.push(byId.get(id)!);
  }
  for (const a of anchors) {
    if (!seen.has(a)) {
      seen.add(a);
      picked.unshift(byId.get(a)!);
    }
  }

  const seasonAllowed = (it: StylistItem) => {
    if (anchors.has(it.id) || typeof tempF !== "number") return true;
    const seasons = (it.seasons ?? []).map((s) => String(s).toLowerCase());
    if (seasons.length === 0 || seasons.includes("all")) return true;
    const coldOnly = seasons.every((s) => s === "fall" || s === "winter");
    const warmOnly = seasons.every((s) => s === "spring" || s === "summer");
    if (tempF >= 75 && coldOnly) return false;
    if (tempF <= 40 && warmOnly) return false;
    return true;
  };

  const counts: Record<string, number> = {};
  let filtered = picked.filter(seasonAllowed);
  const hasFullBody = filtered.some(
    (i) => normCategory(i.category) === "full body",
  );
  let knitTops = 0;
  const slotted: StylistItem[] = [];
  for (const it of filtered) {
    const isAnchor = anchors.has(it.id);
    const cat = normCategory(it.category) || "accessory";
    if (!isAnchor) {
      if (hasFullBody && cat === "bottom") continue;
      const cap = SLOT_CAPS[cat] ?? 2;
      if ((counts[cat] ?? 0) >= cap) continue;
      if (cat === "top" && HEAVY_KNIT_RE.test(itemHaystack(it))) {
        if (knitTops >= 1) continue;
        knitTops += 1;
      }
    }
    counts[cat] = (counts[cat] ?? 0) + 1;
    slotted.push(it);
  }

  const coherent = dropPatternOverload(
    dropColorClashes(dropFormalityOutliers(slotted, anchors), anchors),
    anchors,
  );
  return orderOutfitLayers(coherent).map((i) => i.id);
}

// ── Batch de-duplication ─────────────────────────────────────────────────────

/** Sorted-id fingerprint for exact-duplicate detection. */
export function outfitFingerprint(ids: string[]): string {
  return [...ids].sort().join("|");
}

/** Jaccard overlap of two outfits' non-anchor items. */
export function outfitOverlap(
  a: string[],
  b: string[],
  anchorIds: string[] = [],
): number {
  const anchors = new Set(anchorIds);
  const sa = new Set(a.filter((id) => !anchors.has(id)));
  const sb = new Set(b.filter((id) => !anchors.has(id)));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  sa.forEach((id) => {
    if (sb.has(id)) inter += 1;
  });
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

/** True when `candidate` is a near-duplicate of anything already kept. */
export function isNearDuplicateOutfit(
  candidate: string[],
  kept: string[][],
  anchorIds: string[] = [],
  threshold = 0.75,
): boolean {
  return kept.some((k) => outfitOverlap(candidate, k, anchorIds) >= threshold);
}

/** Drop batch outfits that are near-duplicates of an earlier one (≥75%
 * overlap on non-anchor items) — "10 looks" that are all the same outfit. */
export function dropNearDuplicateOutfits<T extends { item_ids: string[] }>(
  outfits: T[],
  anchorIds: string[],
): T[] {
  const kept: T[] = [];
  const keptIds: string[][] = [];
  for (const o of outfits) {
    if (isNearDuplicateOutfit(o.item_ids, keptIds, anchorIds)) continue;
    kept.push(o);
    keptIds.push(o.item_ids);
  }
  return kept;
}

// ── Classification guards ────────────────────────────────────────────────────

const FASHION_ACCESSORY_HINT =
  /\b(glasses|sunglasses|eyewear|jewelry|necklace|bracelet|earrings?|ring|watch|belt|hair\s*clip|scrunchie|tie|bow\s*tie|gloves?|mittens?|headband|bandana|wallet\s*chain|chain\s*wallet)\b/i;

/**
 * Vision models occasionally box a pet, plant, pillow, or snack that shares
 * the frame with clothing ("a bird was added to my closet"). These words also
 * legitimately appear IN garment names ("animal print blouse", "cat-eye
 * frames", "blanket scarf", "dog graphic tee"), so the block only fires when
 * nothing in the metadata reads like an actual garment or print reference.
 */
const GARMENT_CONTEXT_RE =
  /\b(print(?:ed)?|patterns?|graphic|motif|logo|embroider\w*|embellish\w*|appliqu\w*|eye|tee|t-?shirts?|shirts?|blouses?|tops?|hoodies?|sweaters?|sweatshirts?|cardigans?|dress(?:es)?|skirts?|pants?|jeans|shorts?|jackets?|coats?|socks?|scar(?:f|ves)|pajamas?|robes?|slippers?|costumes?)\b/;

function isLikelyLivingThingOrHomeGood(t: string): boolean {
  if (GARMENT_CONTEXT_RE.test(t)) return false;
  return (
    /\b(birds?|parrots?|parakeets?|cats?|kittens?|dogs?|pupp(?:y|ies)|pets?|hamsters?|rabbits?|bunn(?:y|ies)|fish|lizards?|turtles?|animals?)\b/.test(t) ||
    /\b(plants?|flowers?|bouquets?|succulents?|cact(?:us|i)|house\s*plant)\b/.test(t) ||
    /\b(foods?|fruits?|snacks?|sandwich(?:es)?|pizza|drinks?|beverages?|smoothie)\b/.test(t) ||
    /\b(pillows?|cushions?|blankets?|duvets?|comforters?|bedding|bedsheets?|towels?|curtains?|drapes?|rugs?|carpets?|lamps?|chairs?|sofas?|couch(?:es)?|tables?|mirrors?|picture\s*frames?|toys?|plush(?:ie)?s?|stuffed\s*animals?)\b/.test(t)
  );
}

/** Vision models often box phones, bottles, pets, etc.; drop those after classify. */
export function isLikelyNonWardrobeObject(
  meta: Record<string, unknown>,
): boolean {
  const text = `${meta.name ?? ""} ${meta.sub_category ?? ""} ${meta.category ?? ""} ${meta.type ?? ""}`;
  if (FASHION_ACCESSORY_HINT.test(text)) return false;
  const t = text.toLowerCase();
  return (
    /\b(phones?|smartphones?|iphones?|android)\b/.test(t) ||
    /\b(water\s*bottle|sports\s*bottle|drink(?:ing)?\s*bottle|thermos|tumbler|hydro\s*flask|nalgene|stanley\s+cup|\byeti\b|hydration)\b/.test(t) ||
    /\b(laptops?|macbooks?|ipads?|tablets?|kindles?)\b/.test(t) ||
    /\b(coffee\s*cup|paper\s*cup|disposable\s*cup|to-?go\s*cup|reusable\s*cup)\b/.test(t) ||
    /\b(airpods?(\s+(max|pro|case))?|earbuds?|headphones?|earphones?|headsets?|gaming\s*headset|bone\s*conduction|wireless\s*headphones|over-?ear|on-?ear)\b/.test(t) ||
    /\b(chargers?|charging\s*case|power\s*bank)\b/.test(t) ||
    /\b(dumbbells?|kettlebells?|yoga\s*mats?|foam\s*roller)\b/.test(t) ||
    /\b(keys?|key\s*fob|car\s*keys)\b/.test(t) ||
    /\b(spiral\s*notebook|composition\s*book)\b/.test(t) ||
    isLikelyLivingThingOrHomeGood(t)
  );
}

/** Threshold under which the review UI flags an item for a closer look. */
export const LOW_CLASSIFY_CONFIDENCE = 0.65;

/** True when the classifier itself wasn't sure this is a correctly-read
 * garment. A MISSING confidence value counts as low — an answer that didn't
 * report certainty is uncertain, not trustworthy. */
export function isLowConfidenceClassification(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  const c = Number(meta?.confidence);
  return !Number.isFinite(c) || c < LOW_CLASSIFY_CONFIDENCE;
}

// ── Classify metadata normalisation ──────────────────────────────────────────

const ALLOWED_STYLE_TAGS = new Set([
  "casual", "office", "street", "evening", "sporty", "preppy", "minimalist",
  "romantic", "edgy",
]);

const ALLOWED_PATTERNS = new Set([
  "solid", "striped", "plaid", "checked", "floral", "graphic", "print",
  "polka-dot", "animal", "camo", "colorblock",
]);

const ALLOWED_FORMALITY = new Set([
  "athletic", "casual", "smart-casual", "business", "formal",
]);

/** Whitelist the model's style_tags to the known vocabulary. */
export function normalizeStyleTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const s = String(v).toLowerCase().trim();
    if (ALLOWED_STYLE_TAGS.has(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 2);
}

export function normalizePattern(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase().trim();
  return ALLOWED_PATTERNS.has(s) ? s : "solid";
}

export function normalizeFormality(raw: unknown): string | null {
  const s = String(raw ?? "").toLowerCase().trim().replace(/\s+/g, "-");
  return ALLOWED_FORMALITY.has(s) ? s : null;
}

/**
 * The `style` column is a single value; style_tags is the richer list.
 * Historically this was hardcoded to "casual" for EVERY item ever saved, which
 * silently broke any feature that read it. Derive it from the model's tags.
 */
export function primaryStyleFromTags(
  tags: string[],
  fallback = "casual",
): string {
  return tags[0] ?? fallback;
}
