/**
 * AI API client — OpenAI (classify) + Google Gemini (image gen + enhance + text fallback).
 * - OpenAI gpt-5-nano: PRIMARY vision classify with reasoning_effort=minimal.
 * - Gemini 2.5 Flash Lite: classify FALLBACK + text-only outfit selection.
 * - Gemini 2.5 Flash Image: outfit renders + enhance cutouts (catalog/add-items).
 *
 * Keys: EXPO_PUBLIC_OPENAI_API_KEY (classify primary), EXPO_PUBLIC_GOOGLE_AI_API_KEY
 */

import { segmentItems } from "../modules/clothing-isolator/src/index";
import { aiGatewayEnabled, postViaGateway } from "../lib/aiGateway";
import {
  describeWeatherForStylist,
  weatherHardRules,
  STYLIST_COMPOSITION_RULES,
  STYLIST_FAIRNESS_RULE,
  userDirectionBlock,
  filterClosetByOccasion,
  userStyleMatchIds,
  userStyleMatchRule,
  enforceUserStyleMatch,
  outfitHonorsUserStyle,
  sanitizeOutfitSelection,
  outfitStyleConflicts,
  dropNearDuplicateOutfits,
  recentlySuggestedIds,
  rotationSortForPrompt,
  isLikelyNonWardrobeObject,
  normalizeStyleTags,
  normalizePattern,
  normalizeFormality,
  primaryStyleFromTags,
  spendCallBudget,
  type StylistItem,
  type StylistCallBudget,
} from "../lib/stylistGuards";
import { Colors } from "./AppTheme";

// Re-exported so existing imports (add-items review UI, save paths) keep
// working while the definitions live in the shared guards module.
export {
  isLowConfidenceClassification,
  LOW_CLASSIFY_CONFIDENCE,
  normalizeStyleTags,
  normalizePattern,
  normalizeFormality,
  primaryStyleFromTags,
  StylistCallBudgetExhausted,
} from "../lib/stylistGuards";
export type { StylistCallBudget } from "../lib/stylistGuards";

const GEMINI_KEY = process.env.EXPO_PUBLIC_GOOGLE_AI_API_KEY;
const OPENAI_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;

// EXPERIMENT (flagged 2026-07-04): lite is ~14% cheaper/image but is
// documented as not optimized for multi-reference-image compositing — the
// exact thing try-on/outfit generation does (body photo + multiple garment
// refs). Watch multi-item try-on renders closely; revert PRIMARY to
// "gemini-2.5-flash-image" (swap with FALLBACK below) if quality regresses.
const GEMINI_IMAGE_ENHANCE = "gemini-3.1-flash-lite-image";
const GEMINI_IMAGE_PRIMARY = "gemini-3.1-flash-lite-image";
const GEMINI_IMAGE_FALLBACK = "gemini-2.5-flash-image";
// Primary classify model — ~2.5x faster time-to-first-token and ~64% higher
// output throughput than 2.5 Flash-Lite (Google's own benchmarks), and it's
// the model Google specifically points at high-volume classification/
// extraction workloads. Already proven in this file for image gen (see
// GEMINI_IMAGE_PRIMARY), so no new auth/plumbing risk.
const GEMINI_CLASSIFY = "gemini-3.1-flash-lite";
const OPENAI_CLASSIFY = "gpt-5-nano"; // fallback — reasoning_effort=minimal for speed

/** Vision classify returns one JSON object per item; keep high enough to avoid finish_reason:length truncation. */
export const CLASSIFY_VISION_MAX_COMPLETION_TOKENS = 8192;

/** Must match Fits builder hero (`OutfitCanvas`) so renders blend edge-to-edge. */
function sanitizeOutfitBackdropHex(raw?: string): string {
  const fallback = Colors.fitsBuilderCanvas;
  const t = (raw ?? fallback).trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(t)) return t;
  if (/^[0-9A-Fa-f]{6}$/.test(t)) return `#${t}`;
  return fallback;
}

/** Coarse body region for try-on prompts when a customer photo may already show a full outfit. */
function classifyTryOnPlacement(item: {
  category?: string;
  type?: string;
  name?: string;
}): string {
  const hay =
    `${item.category ?? ""} ${item.type ?? ""} ${item.name ?? ""}`.toLowerCase();
  if (
    /\b(dress|jumpsuit|romper|bodysuit|overall|gown|full[-\s]?body|one[-\s]?piece|playsuit)\b/.test(
      hay,
    )
  ) {
    return "full-body garment (may replace a one-piece look)";
  }
  if (
    /\b(shoe|boot|sneaker|sandal|heel|loafer|oxford|footwear|trainer|clog|slide|mule|slipper)\b/.test(
      hay,
    ) ||
    /\b(sock|hosiery|tight)\b/.test(hay)
  ) {
    return "footwear / feet only";
  }
  if (
    /\b(pant|jean|denim|short|skirt|cargo|chino|khaki|trouser|legging|skort|culotte|culottes)\b/.test(
      hay,
    )
  ) {
    return "lower body (waist-down)";
  }
  if (
    /\b(coat|jacket|blazer|outerwear|parka|bomber|anorak|windbreaker|cape|shacket|overshirt|cardigan)\b/.test(
      hay,
    )
  ) {
    return "outerwear / third layer";
  }
  if (/\b(bag|crossbody|tote|rucksack|backpack|purse|clutch)\b/.test(hay)) {
    return "bag / handheld";
  }
  if (
    /\b(necklace|belt|jewelry|jewellery|earring|watch|bracelet|ring|accessor|spectacle|glass|beanie|hat|scarf)\b/.test(
      hay,
    )
  ) {
    return "accessories";
  }
  if (
    /\b(tee|polo|shirt|top|knitwear|knit|blouse|hoodie|sweater|tank|cami|vest|longsleeve|turtleneck)\b/.test(
      hay,
    )
  ) {
    return "upper body / torso";
  }
  return "wardrobe piece";
}

function bulletLineForTryOn(item: {
  brand?: string;
  color?: string;
  name?: string;
  type?: string;
  category?: string;
  style?: string;
}): string {
  const title = [
    item.brand,
    item.color,
    item.name || item.type || item.category || "item",
    item.style,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return `- ${title} (${classifyTryOnPlacement(item)})`;
}

function geminiUrl(model: string) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

// ── AI transport ─────────────────────────────────────────────────────────────
// When the gateway is configured, every provider call routes through the server
// (keys stay server-side, the daily cap is enforced). Otherwise we fall back to
// the legacy direct call. Both return the provider's JSON verbatim, so all the
// downstream parsing below is unchanged.
async function geminiPost(
  model: string,
  requestBody: unknown,
  meta?: { onboardingFree?: boolean; action?: "enhance" },
): Promise<any> {
  if (aiGatewayEnabled()) {
    return postViaGateway({ provider: "gemini", model, payload: requestBody, meta });
  }
  if (!GEMINI_KEY) throw new Error("Missing EXPO_PUBLIC_GOOGLE_AI_API_KEY");
  const res = await fetch(geminiUrl(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }
  return res.json();
}

async function openaiPost(
  requestBody: { model?: string; [key: string]: unknown },
): Promise<any> {
  if (aiGatewayEnabled()) {
    return postViaGateway({
      provider: "openai",
      model: requestBody.model ?? OPENAI_CLASSIFY,
      payload: requestBody,
    });
  }
  if (!OPENAI_KEY) throw new Error("Missing EXPO_PUBLIC_OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI HTTP ${res.status}`);
  }
  return res.json();
}

// gemini-3.1-* image models added a real "thinking"/compositional-planning
// step before rendering, controlled via thinkingConfig.thinkingLevel
// ("MINIMAL" | "HIGH"). gemini-2.5-* image models predate this entirely —
// they don't support any thinking parameter, and sending thinkingLevel to
// them errors (they only ever recognized the older thinkingBudget field,
// which itself isn't valid on image models either). So this has to be
// model-conditional, not blanket.
type ImageThinkingLevel = "MINIMAL" | "HIGH";
function thinkingLevelFor(
  model: string,
  desired: ImageThinkingLevel,
): ImageThinkingLevel | null {
  return model.startsWith("gemini-3.1") ? desired : null;
}

async function callGeminiWithImage(
  model: string,
  parts: any[],
  responseModalities = ["TEXT"],
  // NOTE: gemini-2.5-flash-image only supports "1K" | "2K" | "4K" — "512"
  // isn't a valid size on it, and community reports show Gemini image
  // models can silently ignore imageSize anyway (always returning ~1K).
  // Flash Image also bills flat per image regardless of size, so this knob
  // doesn't reduce cost — kept only for models where it may apply.
  imageResolution?: "1K" | "2K" | "4K",
  temperature = 0.7,
  meta?: { onboardingFree?: boolean; action?: "enhance" },
  // MINIMAL = fastest (default, used for enhance and everything else). HIGH
  // gives the model more compositional-reasoning budget — worth it for the
  // hardest task (multi-garment try-on onto a real body while preserving the
  // customer's face), at the cost of slower generation. 3.1 models only.
  imageThinking: ImageThinkingLevel = "MINIMAL",
): Promise<any> {
  const wantsImage = responseModalities.includes("IMAGE");
  const modalities = wantsImage ? ["TEXT", "IMAGE"] : responseModalities;
  const maxOutputTokens = wantsImage ? 4096 : 1024;
  const thinkingLevel = wantsImage
    ? thinkingLevelFor(model, imageThinking)
    : null;
  return geminiPost(
    model,
    {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature,
        topP: temperature <= 0.4 ? 0.85 : 0.95,
        maxOutputTokens,
        responseModalities: modalities,
        ...(imageResolution
          ? { imageConfig: { imageSize: imageResolution } }
          : {}),
        // Image thinking (3.1 models only, via thinkingLevel); text always
        // gets minimal thinking via the legacy thinkingBudget field.
        ...(wantsImage
          ? thinkingLevel
            ? { thinkingConfig: { thinkingLevel } }
            : {}
          : { thinkingConfig: { thinkingBudget: 0 } }),
      },
    },
    meta,
  );
}

/** Normalize a content part that may use REST snake_case or JSON camelCase. */
function inlineImageFromPart(p: any): { mime: string; data: string } | null {
  const snake = p?.inline_data;
  if (snake?.data) {
    const mime = String(snake.mime_type || "image/png");
    return { mime, data: snake.data };
  }
  const camel = p?.inlineData;
  if (camel?.data) {
    const mime = String(camel.mimeType || "image/png");
    return { mime, data: camel.data };
  }
  return null;
}

function extractInlineImage(response: any): string | null {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const blob = inlineImageFromPart(p);
    if (blob?.data && /^image\//i.test(blob.mime)) {
      return `data:${blob.mime};base64,${blob.data}`;
    }
  }
  return null;
}

function summarizeGeminiImageFailure(response: any): string {
  const pf = response?.promptFeedback;
  if (pf?.blockReason) return `blocked: ${pf.blockReason}`;
  const c0 = response?.candidates?.[0];
  if (!c0) return "no candidates";
  const fr = c0.finishReason || c0.finish_reason;
  if (fr) return `finish: ${fr}`;
  const parts = c0?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "empty parts";
  const kinds = parts
    .map((p: any) =>
      p?.text != null ? "text" : inlineImageFromPart(p) ? "image" : "other",
    )
    .join(",");
  return `parts: ${kinds}`;
}

function geminiSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Transient overload / quota — safe to retry after a short delay. */
export function isRetryableGeminiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("high demand") ||
    msg.includes("try again later") ||
    msg.includes("rate limit") ||
    msg.includes("resource exhausted") ||
    msg.includes("overloaded") ||
    msg.includes("temporarily unavailable") ||
    /\b429\b/.test(msg) ||
    /\b503\b/.test(msg)
  );
}

export function formatGeminiUserMessage(err: unknown): string {
  // Gateway limit errors already carry a user-friendly message.
  if (err instanceof Error && err.name === "DailyLimitError") return err.message;
  if (err instanceof Error && err.name === "FreeGenerationUsedError") {
    return err.message;
  }
  if (isRetryableGeminiError(err)) {
    return "The AI stylist is busy right now. Wait a moment and tap Generate again.";
  }
  return err instanceof Error ? err.message : String(err);
}

/** Text-only Gemini call — used for outfit selection (no image input). */
async function callGeminiJson(prompt: string): Promise<string> {
  const maxAttempts = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const data = await geminiPost(GEMINI_CLASSIFY, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
      });
      if (data.error) throw new Error(data.error.message);
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && isRetryableGeminiError(err)) {
        await geminiSleep(700 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Fast classification via Gemini vision (GEMINI_CLASSIFY).
 * Returns the raw JSON string from the model.
 */
async function callGeminiClassifyVision(
  prompt: string,
  imageBase64: string,
): Promise<string> {
  // thinkingBudget (numeric, 0 = off) is the Gemini 2.5 field. 3.1 models
  // replaced it with thinkingLevel ("MINIMAL"|"HIGH") — sending BOTH errors,
  // and thinkingBudget on a 3.x model only works via undocumented backwards
  // compat, per Google's own docs ("not recommended"). Model-conditional,
  // same pattern as thinkingLevelFor() above for image gen.
  const thinkingConfig = GEMINI_CLASSIFY.startsWith("gemini-3.1")
    ? { thinkingLevel: "MINIMAL" as const }
    : { thinkingBudget: 0 };

  const data = await geminiPost(GEMINI_CLASSIFY, {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.9,
      maxOutputTokens: 800,
      responseMimeType: "application/json",
      // MINIMAL is Flash-Lite's own default (lowest available level, as
      // close to zero-thinking as the 3.x API allows) — this just makes it
      // explicit rather than relying on the field being silently ignored.
      thinkingConfig,
    },
  });
  if (data.error) throw new Error(data.error.message);

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Fast classification via OpenAI gpt-5-nano vision.
 * `reasoning_effort: "minimal"` disables gpt-5's internal deliberation pass;
 * for classify this is the biggest latency lever (saves 1–3s per call).
 * `verbosity: "low"` tells the model to keep JSON terse.
 */
async function callOpenAIClassifyVision(
  prompt: string,
  imageBase64: string,
): Promise<string> {
  const data = await openaiPost({
    model: OPENAI_CLASSIFY,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            // response_format=json_object requires a top-level object. Our
            // downstream parser (normalizeClassifyItems) already unwraps
            // {items:[…]} into the array shape the rest of the code expects.
            text: `${prompt}\n\nReturn JSON as {"items": [ ...items... ]} (wrap the array under the "items" key).`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`,
              detail: "high", // "high" for accurate box_2d; slower but prevents cropping regressions
            },
          },
        ],
      },
    ],
    max_completion_tokens: 1200,
    response_format: { type: "json_object" },
    reasoning_effort: "minimal",
    verbosity: "low",
  });
  const raw = data.choices?.[0]?.message?.content || "";
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Parse model output when it wraps JSON in prose or truncates; prefer top-level array or object. */
function parseClassifyJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty response from item analyzer");

  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(trimmed);
  if (parsed !== null) return parsed;

  const start = trimmed.indexOf("[");
  if (start >= 0) {
    let depth = 0;
    for (let j = start; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          parsed = tryParse(trimmed.slice(start, j + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }

  const objStart = trimmed.indexOf("{");
  if (objStart >= 0) {
    let depth = 0;
    for (let j = objStart; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          parsed = tryParse(trimmed.slice(objStart, j + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }

  throw new Error(
    "Item analyzer returned invalid JSON (could not parse array or object)",
  );
}

function normalizeClassifyItems(parsed: unknown): Record<string, unknown>[] {
  if (parsed == null) return [];
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (x) => x && typeof x === "object" && !Array.isArray(x),
    ) as Record<string, unknown>[];
  }
  if (typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const k of [
      "items",
      "wardrobe",
      "clothing",
      "pieces",
      "results",
      "outfit",
    ]) {
      const inner = o[k];
      if (Array.isArray(inner)) return normalizeClassifyItems(inner);
    }
    if (o.name || o.category || o.type || o.sub_category) {
      return [o as Record<string, unknown>];
    }
  }
  return [];
}

function filterUsableItemMeta(items: Record<string, unknown>[]) {
  return items.filter(
    (m) => !!(m.name || m.category || m.type || m.sub_category),
  );
}

function filterWardrobeOnlyItems(items: Record<string, unknown>[]) {
  return items.filter((m) => !isLikelyNonWardrobeObject(m));
}

/** Whitelist the model's style/pattern/formality output so garbage values
 * never reach the DB — and so `style` stops being hardcoded "casual". */
function normalizeStyleMeta(
  items: Record<string, unknown>[],
): Record<string, unknown>[] {
  return items.map((m) => {
    const tags = normalizeStyleTags(m.style_tags);
    return {
      ...m,
      style_tags: tags,
      style: primaryStyleFromTags(tags),
      pattern: normalizePattern(m.pattern),
      formality: normalizeFormality(m.formality),
    };
  });
}

/** Google-style box [ymin, xmin, ymax, xmax] in 0–1000; drop invalid. */
function sanitizeBox2d(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const n = raw.map((v) => Number(v));
  if (n.some((x) => !Number.isFinite(x))) return undefined;
  const [ymin, xmin, ymax, xmax] = n;
  if (xmax <= xmin || ymax <= ymin) return undefined;
  return n;
}

function attachSanitizedBox2d(items: Record<string, unknown>[]) {
  return items.map((m) => {
    const box = sanitizeBox2d(m.box_2d);
    const next = { ...m };
    if (box) next.box_2d = box;
    else delete next.box_2d;
    return next;
  });
}

/** Clamp the model's self-reported confidence to [0,1]; drop non-numeric. */
function sanitizeConfidence(items: Record<string, unknown>[]) {
  return items.map((m) => {
    const raw = Number(m.confidence);
    const next = { ...m };
    if (Number.isFinite(raw)) {
      next.confidence = Math.max(0, Math.min(1, raw));
    } else {
      delete next.confidence;
    }
    return next;
  });
}

/** Fix obvious warmth mistakes (e.g. sports bra → cold → fall/winter in UI). */
function reconcileWarmth(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const w = String(meta.warmth ?? "")
    .trim()
    .toLowerCase();
  if (w !== "cold") return meta;
  const hay =
    `${meta.name ?? ""} ${meta.sub_category ?? ""} ${meta.category ?? ""} ${meta.type ?? ""}`.toLowerCase();
  const looksWarmGarment =
    /\b(bra|bras|bikini|swim|tank|cami|crop|sleeveless|shorts?|sandal|slide|legging|biker short|athletic short|running short|gym short|spandex|leotard)\b/.test(
      hay,
    );
  const looksColdGarment =
    /\b(coat|jacket|puffer|parka|sweater|hoodie|fleece|cardigan|boot|wool|scarf|glove|turtleneck|down)\b/.test(
      hay,
    );
  if (looksWarmGarment && !looksColdGarment) {
    return { ...meta, warmth: "warm" };
  }
  return meta;
}

// Stylist guard logic lives in ../lib/stylistGuards (shared with the
// run-automations edge function so the two paths can never drift).
type StylistWardrobeItem = StylistItem;

/** Wardrobe payload for stylist prompts: rotation-sorted (never-suggested +
 * least-worn first), with per-item flags the hard rules key off. */
function stylistPromptPayload(
  items: StylistWardrobeItem[],
  matchIds: Set<string> | null,
  recentIds: Set<string>,
) {
  return rotationSortForPrompt(items, recentIds).map((it) => ({
    id: it.id,
    name: it.name || `${it.color || ""} ${it.type || it.category}`.trim(),
    type: it.type ?? undefined,
    sub_category: it.sub_category ?? undefined,
    category: it.category,
    color: it.color ?? undefined,
    style: it.style ?? undefined,
    style_tags: it.style_tags?.length ? it.style_tags : undefined,
    pattern: it.pattern ?? undefined,
    formality: it.formality ?? undefined,
    occasions: it.occasions || [],
    seasons: it.seasons ?? undefined,
    wear_count: typeof it.wear_count === "number" ? it.wear_count : undefined,
    recently_suggested: recentIds.has(it.id) ? true : undefined,
    matches_user_request: matchIds?.has(it.id) ? true : undefined,
  }));
}

const STYLE_RETRY_ESCALATION = `\nPREVIOUS ATTEMPT REJECTED: your last answer ignored the USER-REQUEST MATCHING constraint. This attempt MUST build every outfit around the items marked "matches_user_request": true — an answer without them will be discarded.\n`;

function countStyleMatches(ids: string[], matchIds: Set<string>): number {
  let n = 0;
  for (const id of ids) if (matchIds.has(id)) n += 1;
  return n;
}

/** Escalation note for the ONE bounded regeneration when the deterministic
 * validators find a core-garment clash they can't repair by trimming. */
function conflictEscalation(conflicts: string[]): string {
  return `\nPREVIOUS ATTEMPT REJECTED for style incoherence:\n${conflicts
    .map((c) => `- ${c}`)
    .join("\n")}\nFix these in this attempt — swap the clashing pieces, do not just re-send the same selection.\n`;
}

/** Conflicts for a picked id list, resolved against the candidate pool. */
function conflictsForIds(
  ids: string[],
  byId: Map<string, StylistItem>,
): string[] {
  const picked = ids
    .map((id) => byId.get(id))
    .filter((i): i is StylistItem => !!i);
  return picked.length ? outfitStyleConflicts(picked) : [];
}


export const apiClient = {
  /**
   * Classify clothing items from an image.
   * Primary: Gemini 2.0 Flash (fast, ~1-3s). Fallback: OpenAI gpt-5-nano.
   *
   * isIsolated=true → image is already a single clean segmented item on white;
   * uses a minimal single-item prompt (no box_2d, no scene prefix, smaller output).
   */
  async classify(
    imageBase64: string,
    _categoryHint: string,
    _mode: "single" | "multi" = "single",
    photoLayout?: "flat_lay" | "fit_check",
    isIsolated = false,
  ) {
    // Compact prompt for already-isolated items (single garment on white bg)
    const scopeRules = `ONLY include wearable fashion: apparel (tops, bottoms, dresses, outerwear), footwear, handbags/totes/backpacks worn or held as part of the outfit, and fashion accessories (jewelry, watches, glasses/sunglasses, belts, hats, beanies, headbands, scarves, hair accessories, gloves).
NEVER include: phones, tablets, laptops, water bottles, drink cups/mugs, keys, books, chargers, headphones, earbuds, headsets, AirPods, audio devices, gym equipment, or other props — even if visible on the person, in ears, or around the neck.
NEVER include living things or scenery: people themselves, animals, pets, birds, plants, flowers, food, drinks. NEVER include home goods: furniture, lamps, pillows, blankets, bedding, towels, curtains, rugs, décor, toys, vehicles. If an animal or object is wearing/near clothing, classify only the garment, never the animal/object.
OCCLUSION RULE: Skip any item that is less than ~60% visible. If only a corner/strip/sliver of an item is showing (e.g. a graphic tee peeking through an unzipped jacket, a bag strap at the frame edge, half a shoe behind a pant leg), DO NOT list it — the visible portion is insufficient to capture design/print/shape. Only classify items that are mostly in-frame and mostly unoccluded.
CONTENT SAFETY: If the image contains nudity, sexual content, violence, weapons, drug use, hate symbols, or any inappropriate content, return an empty JSON array [] with no other output.
If nothing in the frame is wardrobe-related, return an empty JSON array [].`;

    const isolatedPrompt = `This image shows one item on a white background — it should be clothing, shoes, a bag, or a fashion accessory (glasses, jewelry, belt, hat, etc.).
If the subject is NOT wardrobe (e.g. phone, bottle, headphones, earbuds, electronics, an animal/bird/pet, a plant, food, furniture, a pillow/blanket/towel, a toy, or any other non-fashion object), return exactly: {}
If the image contains nudity, sexual content, violence, weapons, drug use, or inappropriate content, return exactly: {}
If the item is heavily cut off / less than ~60% visible in frame, return exactly: {}
Otherwise return a JSON object (not array) with exactly these fields:
{"name":"≤5 words","category":"top|bottom|outerwear|full body|shoes|accessory|bag","sub_category":"1-2 words","color":"one word","warmth":"warm|cold|both","occasions":["≤3 from: casual,active,going-out,work,travel,lounge,formal"],"style_tags":["≤2 from: casual,office,street,evening,sporty,preppy,minimalist,romantic,edgy"],"pattern":"one of: solid,striped,plaid,checked,floral,graphic,print,polka-dot,animal,camo,colorblock","formality":"one of: athletic,casual,smart-casual,business,formal","confidence":0.95}
confidence: your honest 0.0-1.0 certainty that this is a wardrobe item AND the fields are correct. Use below 0.6 when the subject is blurry, partially visible, ambiguous, or might not be clothing at all.
warmth: cold ONLY for coats, jackets, puffers, sweaters, hoodies, fleece, boots, scarves, gloves. warm for sports bras, bras, crop tops, tanks, sleeveless tops, shorts, swimwear, sandals, gym leggings. both for regular tees, jeans, sneakers, bags, jewelry. NEVER label sports bras, tanks, or shorts as cold. No extra text.`;

    const fitCheckExclusion =
      photoLayout === "fit_check"
        ? `\nFIT-CHECK EXCLUSIONS — do NOT list any jewelry, fine, or hard-to-crop items even if visible: necklaces, chains, pendants, watches, bracelets, bangles, cuffs, rings, earrings, studs, anklets, brooches, glasses, sunglasses, belts, scarves, ties, gloves, socks, and any tiny accessory that occupies <5% of the image. These are too small/fine to crop cleanly off a body; the user will photograph them individually. DO INCLUDE only clothing, shoes, bags/backpacks, and head accessories: hats, caps, beanies, headbands, hairbands. If in doubt about whether an accessory is large enough — skip it.\n`
        : "";

    const scenePrefix =
      photoLayout === "flat_lay"
        ? `Scene: flat-lay — one entry per distinct wardrobe piece only.\n${scopeRules}\n\n`
        : photoLayout === "fit_check"
          ? `Scene: person in an outfit — list only what they are wearing or carrying as fashion (clothes, shoes, bag, large accessories).\n${scopeRules}${fitCheckExclusion}\n\n`
          : `${scopeRules}\n\n`;
    const multiPrompt = `${scenePrefix}List every qualifying item from the ALLOW list above. Do not list phones, bottles, cups, headphones, earbuds, headsets, or other electronics.
Return a JSON array. Each object: {"name":"≤5 words","category":"top|bottom|outerwear|full body|shoes|accessory|bag","sub_category":"1-2 words","color":"one word","warmth":"warm|cold|both","occasions":["≤3 from: casual,active,going-out,work,travel,lounge,formal"],"style_tags":["≤2 from: casual,office,street,evening,sporty,preppy,minimalist,romantic,edgy"],"pattern":"one of: solid,striped,plaid,checked,floral,graphic,print,polka-dot,animal,camo,colorblock","formality":"one of: athletic,casual,smart-casual,business,formal","confidence":0.95,"box_2d":[ymin,xmin,ymax,xmax]}
confidence: your honest 0.0-1.0 certainty that this entry is a wardrobe item AND its fields are correct. Use below 0.6 for blurry, heavily occluded, or ambiguous detections that might not be clothing.
box_2d: [ymin,xmin,ymax,xmax] only — normalized 0–1000, origin at TOP-LEFT of the image (ymin smaller = higher on screen). Each box must FULLY contain that garment with comfortable margin. For normal garments, span at least 100 units in BOTH width and height.
ACCESSORY BOXING: For hats/caps/beanies/headbands/glasses/sunglasses, box ONLY the actual accessory. Do NOT include hands, arms, phones, background, shoulders, or the whole head/face unless a tiny bit is unavoidable for context. If a raised hand is near a hat, exclude the hand completely. For necklaces/chains, box the visible jewelry/chain path, not the jacket/neck/chest around it.
EYEWEAR: Glasses/sunglasses must be boxed at the eyes/face location only. Never place an eyewear box on the shirt, jacket, pants, or left/right edge crop.
NECK JEWELRY: Necklaces/chains should be a tight box around the visible metal/cord on the neck and upper chest. Do not box the whole hoodie/jacket panel.
WRIST ACCESSORIES: Watches/bracelets must be boxed at the visible wrist only. Include just enough wrist/hand context to show the item; never box the torso, sleeve, full arm, chest, or background.
Do NOT box mirror reflections, background clutter, or razor-thin strips at the left/right edge — box the actual item on the person.
warmth: cold ONLY for coats, jackets, puffers, sweaters, hoodies, fleece, boots, scarves, gloves. warm for sports bras, bras, crop tops, tanks, sleeveless tops, shorts, swimwear, sandals, gym leggings. both for regular tees, jeans, sneakers, bags, jewelry, hats, sunglasses. NEVER use cold for sports bras, tanks, or shorts. Outerwear category is always cold. No markdown.`;

    const prompt = isIsolated ? isolatedPrompt : multiPrompt;

    // Gemini 2.5 Flash Lite (primary, retried once).
    let json = "";
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
        json = await callGeminiClassifyVision(prompt, imageBase64);
        if (json.trim()) break;
      } catch (e) {
        lastErr = e;
        console.warn(`[classify] Gemini attempt ${attempt + 1} failed:`, e);
      }
    }
    if (!json.trim() && (aiGatewayEnabled() || OPENAI_KEY)) {
      try {
        json = await callOpenAIClassifyVision(prompt, imageBase64);
      } catch (e) {
        lastErr = e;
        console.warn("[classify] OpenAI fallback failed too:", e);
      }
    }
    if (!json.trim()) {
      throw lastErr ?? new Error("Classification returned empty response");
    }

    // For Gemini isolated items the model returns a single item OBJECT that
    // needs wrapping. OpenAI always returns a wrapper like {"items":[…]} under
    // response_format=json_object — `normalizeClassifyItems` unwraps that on
    // its own, so we must NOT re-wrap it in brackets here.
    const trimmedJson = json.trim();
    const looksLikeContainerObject =
      trimmedJson.startsWith("{") &&
      /"(items|wardrobe|clothing|pieces|results|outfit)"\s*:/.test(trimmedJson);
    const rawForParse =
      isIsolated && trimmedJson.startsWith("{") && !looksLikeContainerObject
        ? `[${trimmedJson}]`
        : trimmedJson;

    const parsed = parseClassifyJsonPayload(rawForParse);
    const normalized = normalizeClassifyItems(parsed);
    const usable = filterUsableItemMeta(normalized);
    if (usable.length === 0) {
      const compact = json.replace(/\s/g, "");
      if (
        isIsolated &&
        (compact === "{}" || compact === "[{}]" || compact === "[]")
      ) {
        throw new Error(
          "This crop does not look like clothing or a fashion accessory.",
        );
      }
      throw new Error(
        normalized.length > 0
          ? "AI response had no usable item fields (need name, category, or type)"
          : "AI returned no clothing items for this image",
      );
    }
    const wardrobeOnly = filterWardrobeOnlyItems(usable);
    if (wardrobeOnly.length === 0) {
      throw new Error(
        usable.length > 0
          ? "Only non-closet items were detected (e.g. phone or bottle). Add a photo focused on clothes."
          : "AI returned no clothing items for this image",
      );
    }
    const withBoxes = attachSanitizedBox2d(wardrobeOnly);
    return {
      metadata: normalizeStyleMeta(
        sanitizeConfidence(withBoxes).map(reconcileWarmth),
      ),
    };
  },

  /**
   * Pick outfit item IDs from the closet using Gemini Flash Lite (text-only JSON).
   */
  async generateOutfits(preferences: {
    occasion: string;
    weather?: any;
    items: StylistWardrobeItem[];
    anchorItemIds?: string[];
    extraInstructions?: string;
    /** Item-id arrays of the user's recent generated outfits (newest first);
     * pieces in them get down-ranked so the whole closet rotates. */
    recentOutfitItemIds?: string[][];
    /** Shared request-level Gemini-call cap; see StylistCallBudget. */
    callBudget?: StylistCallBudget;
  }) {
    const {
      occasion,
      weather,
      items,
      anchorItemIds = [],
      extraInstructions,
      recentOutfitItemIds = [],
      callBudget,
    } = preferences;

    if (!items || items.length === 0) {
      throw new Error("Your closet is empty. Add some items first.");
    }

    const w = describeWeatherForStylist(weather);
    const weatherContext = w ? `Current weather: ${w.line}. ` : "";
    const weatherRules = w ? `\n${weatherHardRules(w)}\n` : "";

    const anchorNote =
      anchorItemIds.length > 0
        ? `\nYou MUST include these anchor item IDs: ${anchorItemIds.join(", ")}`
        : "";

    // Occasion becomes the candidate pool (not just a suggestion) whenever the
    // matching subset can still cover a full outfit.
    const { items: candidates, applied: occasionFiltered } =
      filterClosetByOccasion(items, occasion, anchorItemIds);
    const occasionNote = occasionFiltered
      ? `\nThe wardrobe list has been PRE-FILTERED to pieces tagged for this occasion — everything below is fair game.`
      : "";

    const matchIds = userStyleMatchIds(candidates, extraInstructions);
    const matchRule = matchIds ? `\n${userStyleMatchRule(matchIds.size)}\n` : "";
    const recentIds = recentlySuggestedIds(recentOutfitItemIds);

    const itemList = stylistPromptPayload(candidates, matchIds, recentIds);

    const buildPrompt = (
      escalation = "",
    ) => `You are an expert fashion stylist. ${weatherContext}Create a complete, cohesive outfit for the occasion: "${occasion}".${anchorNote}
${userDirectionBlock(extraInstructions)}${weatherRules}${matchRule}${escalation}
${STYLIST_COMPOSITION_RULES}

SELECTION RULES:
- Core slots to fill: (top OR "full body") + (bottom if no "full body") + shoes + optional outerwear + optional accessory + optional bag
- All items must work together aesthetically and be appropriate for "${occasion}" and the weather
- Prefer items whose occasions array overlaps the vibe of "${occasion}"${occasionNote}
- Only use IDs from the list below

${STYLIST_FAIRNESS_RULE}

AVAILABLE WARDROBE:
${JSON.stringify(itemList, null, 2)}

Return ONLY a valid JSON object:
{ "item_ids": ["id1", "id2", ...], "title": "short catchy outfit name", "reasoning": "one sentence explaining the choices" }
No markdown, no explanation outside the JSON.`;

    const attempt = async (escalation = "") => {
      spendCallBudget(callBudget);
      const json = await callGeminiJson(buildPrompt(escalation));
      const parsed = JSON.parse(json) as {
        item_ids: string[];
        title: string;
        reasoning: string;
      };
      parsed.item_ids = sanitizeOutfitSelection(
        parsed.item_ids,
        candidates,
        anchorItemIds,
        w?.tempF,
      );
      return parsed;
    };

    let parsed = await attempt();

    // ONE bounded retry, shared between the two rejection reasons:
    //  - the user asked for a specific style and the model ignored it
    //  - the deterministic validators found a core-garment clash they couldn't
    //    repair by trimming accessories (formality/color/pattern)
    // Keep whichever attempt is better: fewer conflicts first, then more
    // style matches (never silently accept less when more was possible).
    const candidateById = new Map<string, StylistItem>(
      candidates.map((c) => [c.id, c]),
    );
    const styleIgnored =
      !!matchIds &&
      parsed.item_ids.length > 0 &&
      !outfitHonorsUserStyle(parsed.item_ids, matchIds);
    const firstConflicts = conflictsForIds(parsed.item_ids, candidateById);
    if (styleIgnored || firstConflicts.length > 0) {
      try {
        const retry = await attempt(
          (styleIgnored ? STYLE_RETRY_ESCALATION : "") +
            (firstConflicts.length > 0
              ? conflictEscalation(firstConflicts)
              : ""),
        );
        if (retry.item_ids.length > 0) {
          const retryConflicts = conflictsForIds(retry.item_ids, candidateById);
          const better =
            retryConflicts.length < firstConflicts.length ||
            (retryConflicts.length === firstConflicts.length &&
              styleIgnored &&
              countStyleMatches(retry.item_ids, matchIds!) >
                countStyleMatches(parsed.item_ids, matchIds!));
          if (better) parsed = retry;
        }
      } catch {
        // keep the first attempt — a weaker outfit beats no outfit
      }
    }

    if (parsed.item_ids.length === 0) {
      throw new Error("Stylist returned no usable items for this outfit");
    }
    return parsed;
  },

  /**
   * Generate N distinct outfits in ONE Gemini call.
   * Replaces 5 sequential calls (~15–40s) with a single ~3–8s round-trip.
   * Falls back to `generateOutfits` per-outfit when the bulk path returns nothing.
   */
  async generateOutfitBatch(preferences: {
    occasion: string;
    count: number;
    weather?: any;
    items: StylistWardrobeItem[];
    anchorItemIds?: string[];
    extraInstructions?: string;
    /** Item-id arrays of the user's recent generated outfits (newest first);
     * pieces in them get down-ranked so the whole closet rotates. */
    recentOutfitItemIds?: string[][];
    /** Shared request-level Gemini-call cap; see StylistCallBudget. */
    callBudget?: StylistCallBudget;
  }): Promise<{ item_ids: string[]; title: string; reasoning: string }[]> {
    const {
      occasion,
      count,
      weather,
      items,
      anchorItemIds = [],
      extraInstructions,
      recentOutfitItemIds = [],
      callBudget,
    } = preferences;

    if (!items || items.length === 0) {
      throw new Error("Your closet is empty. Add some items first.");
    }
    const N = Math.max(1, Math.min(8, count));

    const w = describeWeatherForStylist(weather);
    const weatherContext = w ? `Current weather: ${w.line}. ` : "";
    const weatherRules = w ? `\n${weatherHardRules(w)}\n` : "";

    const anchorNote =
      anchorItemIds.length > 0
        ? `\nEvery returned outfit MUST include these anchor item IDs: ${anchorItemIds.join(", ")}`
        : "";

    // Occasion becomes the candidate pool (not just a suggestion) whenever the
    // matching subset can still cover a full outfit.
    const { items: candidates, applied: occasionFiltered } =
      filterClosetByOccasion(items, occasion, anchorItemIds);
    const occasionNote = occasionFiltered
      ? `\nThe wardrobe list has been PRE-FILTERED to pieces tagged for this occasion — everything below is fair game.`
      : "";

    const matchIds = userStyleMatchIds(candidates, extraInstructions);
    const matchRule = matchIds ? `\n${userStyleMatchRule(matchIds.size)}\n` : "";
    const recentIds = recentlySuggestedIds(recentOutfitItemIds);

    const itemList = stylistPromptPayload(candidates, matchIds, recentIds);

    // Scale how much overlap adjacent looks may share with closet size —
    // small closets can't avoid reuse, big closets have no excuse for it.
    const maxShared = candidates.length >= 25 ? 1 : 2;

    const buildPrompt = (
      escalation = "",
    ) => `You are an expert fashion stylist. ${weatherContext}Generate ${N} DISTINCT outfits for the occasion: "${occasion}".${anchorNote}
${userDirectionBlock(extraInstructions)}${weatherRules}${matchRule}${escalation}
${STYLIST_COMPOSITION_RULES}

PER-OUTFIT SELECTION RULES:
- Core slots to fill: (top OR "full body") + (bottom if no "full body") + shoes + optional outerwear + optional accessory + optional bag
- All items must work together aesthetically and be appropriate for "${occasion}" and the weather
- Prefer items whose occasions array overlaps the vibe of "${occasion}"${occasionNote}
- Only use IDs from the wardrobe list

DIVERSITY RULES (hard constraints across all ${N} outfits):
- No two outfits may share more than ${maxShared} non-anchor item(s).
- Never repeat the same top+bottom or top+shoes pairing across outfits.
- Spread usage across the WHOLE closet: no single non-anchor item may appear in more than ${Math.max(2, Math.ceil(N / 2))} of the ${N} outfits.
- Each outfit must also differ in at least one of: dominant color palette, silhouette, formality, or layering.
- Vary titles — each should have its own personality.

${STYLIST_FAIRNESS_RULE}

AVAILABLE WARDROBE:
${JSON.stringify(itemList, null, 2)}

Return ONLY a valid JSON object with this exact shape:
{ "outfits": [
  { "item_ids": ["id1", "id2", ...], "title": "short catchy outfit name", "reasoning": "one sentence explaining the choices" }
] }
Include exactly ${N} entries in the "outfits" array. No markdown, no explanation outside the JSON.`;

    const attempt = async (
      escalation = "",
    ): Promise<{ item_ids: string[]; title: string; reasoning: string }[]> => {
      spendCallBudget(callBudget);
      const json = await callGeminiJson(buildPrompt(escalation));
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error("Stylist returned invalid JSON");
      }

      const arr = Array.isArray(parsed?.outfits)
        ? parsed.outfits
        : Array.isArray(parsed?.looks)
          ? parsed.looks
          : Array.isArray(parsed)
            ? parsed
            : null;
      if (!arr || arr.length === 0) return [];

      return arr
        .filter(
          (o: any) =>
            o &&
            Array.isArray(o.item_ids) &&
            o.item_ids.length > 0 &&
            o.item_ids.every((s: unknown) => typeof s === "string"),
        )
        .map(
          (
            o: any,
            i: number,
          ): { item_ids: string[]; title: string; reasoning: string } => ({
            item_ids: sanitizeOutfitSelection(
              o.item_ids,
              candidates,
              anchorItemIds,
              w?.tempF,
            ),
            title:
              typeof o.title === "string" && o.title.trim()
                ? o.title.trim()
                : `Look ${i + 1}`,
            reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
          }),
        )
        .filter(
          (o: { item_ids: string[]; title: string; reasoning: string }) =>
            o.item_ids.length > 0,
        );
    };

    let cleaned = await attempt();

    // Deterministic coherence pass: outfits whose core garments clash
    // (formality/color/pattern) are dropped — downstream refill logic tops the
    // batch back up. ONE bounded regeneration only when EVERY look clashed;
    // that same single-retry budget is shared with the style-match retry below
    // so a generation never costs more than two Gemini text calls.
    const candidateById = new Map<string, StylistItem>(
      candidates.map((c) => [c.id, c]),
    );
    const splitByConflict = (
      list: { item_ids: string[]; title: string; reasoning: string }[],
    ) => ({
      clean: list.filter(
        (o) => conflictsForIds(o.item_ids, candidateById).length === 0,
      ),
      firstConflicts:
        list.length > 0 ? conflictsForIds(list[0].item_ids, candidateById) : [],
    });
    let retryUsed = false;
    {
      const { clean, firstConflicts } = splitByConflict(cleaned);
      if (cleaned.length > 0 && clean.length === 0) {
        retryUsed = true;
        try {
          const retry = await attempt(conflictEscalation(firstConflicts));
          const retryClean = splitByConflict(retry).clean;
          if (retryClean.length > 0) cleaned = retryClean;
          // else: keep the conflicted first batch — a clashing outfit still
          // beats an empty screen, and the guards already trimmed what they
          // safely could.
        } catch {
          // keep the first attempt
        }
      } else if (clean.length > 0) {
        cleaned = clean;
      }
    }

    // Explicit style request enforcement (strict — the required match count is
    // the same one the prompt stated). When the whole batch ignored the ask,
    // retry once with a rejection notice instead of quietly returning the
    // wrong aesthetic; only then relax to ≥1 match as a last resort.
    if (matchIds) {
      let honoring = enforceUserStyleMatch(cleaned, matchIds);
      if (honoring.length === 0 && !retryUsed) {
        try {
          const retry = await attempt(STYLE_RETRY_ESCALATION);
          if (retry.length > 0) {
            // Prefer retry looks that are also conflict-free.
            const retryPool = (() => {
              const clean = splitByConflict(retry).clean;
              return clean.length > 0 ? clean : retry;
            })();
            const retryHonoring = enforceUserStyleMatch(retryPool, matchIds);
            if (retryHonoring.length > 0) {
              honoring = retryHonoring;
            } else {
              const relaxed = retryPool.filter((o) =>
                o.item_ids.some((id) => matchIds.has(id)),
              );
              honoring = relaxed.length > 0 ? relaxed : [];
            }
          }
        } catch {
          // fall through to the relaxed pass on the first attempt
        }
      }
      if (honoring.length === 0) {
        const relaxed = cleaned.filter((o) =>
          o.item_ids.some((id) => matchIds.has(id)),
        );
        honoring = relaxed;
      }
      if (honoring.length === 0) {
        throw new Error(
          "The stylist couldn't build looks matching your request from this closet. Try rewording it or adding matching pieces.",
        );
      }
      cleaned = honoring;
    }

    if (cleaned.length === 0) {
      throw new Error("Stylist returned no outfits");
    }

    return dropNearDuplicateOutfits(cleaned, anchorItemIds).slice(0, N);
  },

  /**
   * Composite outfit render via Gemini image generation.
   * Tries gemini-2.5-flash-lite first, then gemini-2.0-flash (image-capable fallback).
   */
  async generateOutfitImage(params: {
    outfitItems: {
      id?: string;
      brand?: string;
      name?: string;
      type?: string;
      color?: string;
      category?: string;
      style?: string;
    }[];
    occasion: string;
    bodyPhotoBase64?: string;
    /** Up to 2 refs when a body photo is sent (3 images total); up to 3 on mannequin. Product shots — model should match them exactly. */
    garmentReferenceImages?: {
      base64: string;
      mime_type: string;
      label: string;
    }[];
    /** Defaults to app Fits canvas color (`Colors.fitsBuilderCanvas`) */
    backdropHex?: string;
    /** When true (no body photo), render a catalog mannequin on the supplied matte. */
    mannequinStudioWhite?: boolean;
    /** Presentation gender for the mannequin/generic model when there's no
     * body photo. Ignored when bodyPhotoBase64 is set (that's the customer's
     * own body). Defaults to "female" — see resolveMannequinGender. */
    mannequinGender?: "male" | "female";
  }): Promise<string | null> {
    try {
      const {
        outfitItems,
        occasion,
        bodyPhotoBase64,
        garmentReferenceImages = [],
        backdropHex,
        mannequinStudioWhite,
        mannequinGender = "female",
      } = params;
      const bg = sanitizeOutfitBackdropHex(backdropHex);

      const maxGarmentRefs = bodyPhotoBase64 ? 2 : 3;
      const garmentRefs = garmentReferenceImages.slice(0, maxGarmentRefs);

      const outfitIntro = bodyPhotoBase64
        ? "Pieces to apply from the saved wardrobe (partial try-on — obey rules below):"
        : "The outfit consists of:";

      const itemDescriptions = bodyPhotoBase64
        ? outfitItems.map((item) => bulletLineForTryOn(item)).join("\n")
        : outfitItems
            .map((item) =>
              `- ${item.color || ""} ${item.name || item.type || "item"}`.trim(),
            )
            .join("\n");

      const backdropRulesBody = `BACKGROUND: The entire frame behind the subject must be ONE flat, solid color only: exactly ${bg}. No gradients, no paper texture, no studio floor, no horizon, no walls, no furniture, no props. No edge vignette. Every pixel outside the person (and outside their clothing/shoes) must be ${bg}.

MATTE CLEANLINESS (required): Do not add a floor, grounding plane, cast shadow, contact shadow, reflection, glow, halo, or colored spill anywhere around or beneath the subject. The solid ${bg} matte must continue unchanged between the legs, between limbs, around accessories, and directly beneath both feet.

LIGHTING: Professional and even on the subject only. Keep the matte completely unchanged everywhere, including directly beneath the feet.

FRAMING: Full-length head-to-toe — never crop below the knees; feet and ankles must stay in frame. Keep the customer's pose, proportions, and crop from their reference photo wherever possible. Do not invent a tighter waist-up crop unless Image 1 is already cropped that way.`;

      const backdropRulesNoBody = `BACKGROUND: The entire frame behind the subject must be ONE flat, solid color only: exactly ${bg}. No gradients, no paper texture, no studio floor, no horizon, no walls, no furniture, no props. No edge vignette. Every pixel outside the person (and outside their clothing/shoes) must be ${bg}.

MATTE CLEANLINESS (required): Do not add a floor, grounding plane, cast shadow, contact shadow, reflection, glow, halo, or colored spill anywhere around or beneath the subject. The solid ${bg} matte must continue unchanged between the legs, between limbs, around accessories, and directly beneath both feet.

LIGHTING: Professional and even on the subject only. Keep the matte completely unchanged everywhere, including directly beneath the feet.

SHOT: Full-body fashion editorial, standing naturally, pleasant expression. Head to toe visible — do not crop legs or feet.`;

      const backdropRules = bodyPhotoBase64
        ? backdropRulesBody
        : backdropRulesNoBody;

      const refLines =
        garmentRefs.length === 0
          ? ""
          : bodyPhotoBase64
            ? `\n\nMULTI-IMAGE ORDER (critical):\n- Image 1 (first image after this text): the CUSTOMER'S photo. It may be full-length with an existing outfit, or tighter framing. Preserve identity: same person, face, hair, skin tone, and body.

PARTIAL TRY-ON (mandatory):\n- The bullet list above lists ONLY the wardrobe pieces to virtual-try-on. Replace ONLY those placements (use each line's parenthetical as the body region — e.g. if the list is footwear-only, swap shoes and leave pants, top, jacket, bag, jewelry, and skin unchanged).\n- Preserve any clothing visible in Image 1 that does NOT correspond to a listed piece: same folds, hem lines, and colors unless that exact garment is being replaced.\n- Product images after Image 1 win over text for those slots: match color, silhouette, pattern, logos, typography, and material exactly; do not substitute a different item.\n- For a line with no product image, follow the text alone for that placement — use plain neutral fabric if details are unspecified; never invent logos or illegible garment text.\n- Remove/replace the entire original background behind the subject with flat ${bg} only — no old room, floor, or horizon.

${garmentRefs
  .map(
    (g, i) =>
      `- Image ${i + 2}: product reference for "${g.label}". Use only for its matching placement line above.\n`,
  )
  .join("")}`
            : `\n\nMULTI-IMAGE ORDER (critical):\nThe images after this text are PRODUCT REFERENCES for the listed outfit. The generated full-body figure must wear these EXACT items — match each reference's colors, pattern, silhouette, logos, typography, and details; do not swap in lookalikes.\n${garmentRefs
                .map((g, i) => `- Image ${i + 1}: ${g.label}\n`)
                .join("")}`;

      const refLabelsLower = new Set(
        garmentRefs.map((g) => g.label.trim().toLowerCase()),
      );
      const itemsWithoutRef = outfitItems.filter((item) => {
        const line = bulletLineForTryOn(item);
        const title = line.replace(/^-\s*/, "").split(" (")[0]?.trim().toLowerCase();
        return !Array.from(refLabelsLower).some(
          (label) => label.includes(title) || title.includes(label),
        );
      });
      const noRefBlock =
        itemsWithoutRef.length > 0 && garmentRefs.length > 0
          ? `\n\nITEMS WITHOUT PRODUCT PHOTOS (text only — do NOT invent logos, graphics, or illegible text on these):\n${itemsWithoutRef.map((item) => bulletLineForTryOn(item)).join("\n")}`
          : "";

      const fidelityBlock =
        garmentRefs.length > 0
          ? `\n\nGARMENT FIDELITY (mandatory):
- For every item with a product reference image, reproduce EXACTLY what appears in that photo: colors, patterns, logos, typography, fabric texture, silhouette, and proportions. Do NOT simplify, stylize, or replace graphics/text on garments.
- Do not blend or swap designs between reference images — each reference maps to one placement only.
- Product reference images may show the item worn by a model or mannequin. Extract and use ONLY the garment/accessory itself. NEVER copy a face, head, hair, skin, or body from a reference image into the output — those belong only to the person being dressed.
- If an item has no reference photo, use ONLY its written description; keep unspecified areas plain and neutral.`
          : "";

      const basePrompt = `Create a clean, professional fashion photo for a ${occasion} occasion.
${outfitIntro}
${itemDescriptions}
${refLines}
${noRefBlock}
${fidelityBlock}

${backdropRules}`;

      const mannequinStudio = params.mannequinStudioWhite && !bodyPhotoBase64;
      const tryOnTemperature = 0.35;

      const prompt = bodyPhotoBase64
        ? `${basePrompt}

CRITICAL INSTRUCTION: Start from Image 1 (the customer). You MUST apply EVERY SINGLE ITEM listed above to the person simultaneously in the final image. If there are multiple items, the person must wear ALL of them. DO NOT pick just one reference. For any listed item that lacks a product image, you MUST still generate it based on its text description.
FACE LOCK: Preserve the customer's EXACT face, head, hair, and skin tone from Image 1, completely unchanged. The final person must be unmistakably the same individual as in Image 1. Product reference images (hats, tops, etc.) may contain a different model's face — IGNORE those faces entirely; take only the garment from them. Never replace, blend, or alter the customer's face with any face from a reference image.
Replace ONLY those placements. Do not re-dress regions of the body that are not covered by those placements. Finally, set the backdrop to solid ${bg} with no trace of the prior environment and no shadow beneath the feet.`
        : mannequinStudio
          ? `${basePrompt}

CRITICAL INSTRUCTION: You MUST dress the mannequin in EVERY SINGLE ITEM listed above simultaneously. If there are multiple items, the mannequin must wear ALL of them in the final image. DO NOT pick just one reference. For any listed item that lacks a product image, you MUST still generate it based on its text description.
Use a matte featureless fashion mannequin with a ${mannequinGender} body silhouette, in a clearly mid-dark neutral grey (charcoal / graphite tone). Classic smooth full-body display form only: no facial features, no hair, no skin texture. Keep editorial catalog lighting on the mannequin only. The neutral ${bg} matte must remain perfectly flat and untouched everywhere outside the silhouette, including directly beneath the feet. Do not tint, rim-light, reflect, or color-spill the matte onto the mannequin, garments, shoes, or accessories.`
          : `${basePrompt}

CRITICAL INSTRUCTION: You MUST dress the generic model in EVERY SINGLE ITEM listed above simultaneously. If there are multiple items, the model must wear ALL of them in the final image. DO NOT pick just one reference. For any listed item that lacks a product image, you MUST still generate it based on its text description.
Use a generic full-body ${mannequinGender} fashion model (appropriate for the outfit) standing in a natural confident pose. Keep the ${bg} matte perfectly flat with no shadow beneath the model.`;

      const parts: any[] = [{ text: prompt }];

      if (bodyPhotoBase64) {
        parts.push({
          inline_data: { mime_type: "image/jpeg", data: bodyPhotoBase64 },
        });
      }

      for (const g of garmentRefs) {
        parts.push({
          inline_data: { mime_type: g.mime_type, data: g.base64 },
        });
      }

      for (const model of [GEMINI_IMAGE_PRIMARY, GEMINI_IMAGE_FALLBACK]) {
        try {
          const response = await callGeminiWithImage(
            model,
            parts,
            ["IMAGE"],
            undefined,
            tryOnTemperature,
            undefined,
            // MINIMAL thinking: fastest generation. Face-preservation and
            // garment-fidelity are now enforced via the prompt itself (explicit
            // instructions to extract only the garment from references, never
            // copy a face, and lock the customer's exact face when present).
            "MINIMAL",
          );
          const uri = extractInlineImage(response);
          if (uri) return uri;
          console.warn(
            `[api-client] outfit image ${model} no image (${summarizeGeminiImageFailure(response)})`,
          );
        } catch (e) {
          // Hitting the daily cap (or used-up free gen) won't be fixed by trying
          // another model — surface it so the UI can show the limit message.
          if (
            e instanceof Error &&
            (e.name === "DailyLimitError" || e.name === "FreeGenerationUsedError")
          ) {
            throw e;
          }
          console.warn(`[api-client] outfit image model ${model} failed`, e);
        }
      }

      return null;
    } catch (e) {
      if (
        e instanceof Error &&
        (e.name === "DailyLimitError" || e.name === "FreeGenerationUsedError")
      ) {
        throw e; // propagate to the caller's catch for a friendly message
      }
      console.error("Outfit image generation failed:", e);
      return null;
    }
  },

  /**
   * Isolated garment / accessory on a flat backdrop (default app canvas color) via Gemini 2.5 Flash Image only.
   * Returns a data: URI or null if the model fails or the API key is missing.
   */
  async enhanceClothingItemCutout(params: {
    imageBase64: string;
    name?: string;
    color?: string;
    category?: string;
    backdropHex?: string;
  }): Promise<string | null> {
    try {
      const bg = sanitizeOutfitBackdropHex(params.backdropHex);
      const hint = [params.color, params.name, params.category]
        .filter(Boolean)
        .join(" · ");
      // Ask Gemini to isolate and faithfully re-render ONLY the target item on white — Vision removes bg next.
      const itemLabel = hint || "clothing item";
      const prompt = `You are a fashion product photographer. Look carefully at this image. Identify the ${itemLabel} and reproduce it EXACTLY as it appears — same colors, same fabric, same design, same fit, same details. Do NOT stylize, change, or invent anything. Exclude all other clothing, accessories, jewelry, people, and background. Render ONLY the ${itemLabel} centered on a perfectly flat solid ${bg} background with soft even studio lighting. No shadows, no added items, ~80% frame fill.`;

      if (!aiGatewayEnabled() && !GEMINI_KEY) return null;

      try {
        console.log(
          `[api-client] enhance: calling Gemini ${GEMINI_IMAGE_ENHANCE}…`,
        );

        const response = await callGeminiWithImage(
          GEMINI_IMAGE_ENHANCE,
          [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: params.imageBase64,
              },
            },
          ],
          ["TEXT", "IMAGE"],
          "1K",
          0.7,
          { action: "enhance" },
        );

        const imgDataUri = extractInlineImage(response);
        if (!imgDataUri) {
          console.warn(`[api-client] enhance: Gemini response had no image`);
          return null;
        }

        console.log(
          `[api-client] enhance: got image from Gemini, running Vision bg removal…`,
        );

        // Strip prefix to get raw base64 for the native module
        const b64 = imgDataUri.replace(/^data:[^;]+;base64,/, "");
        try {
          const segments = await segmentItems(b64);
          if (segments.length > 0) {
            console.log(
              `[api-client] enhance: Vision removed bg (${segments.length} segment(s))`,
            );
            return segments[0]; // transparent PNG data URI
          }
          console.warn(
            `[api-client] enhance: Vision returned no segments, using Gemini output as-is`,
          );
        } catch (visionErr) {
          console.warn(
            `[api-client] enhance: Vision bg removal failed`,
            visionErr,
          );
        }

        // Fallback: return Gemini's white-bg output without transparency
        return imgDataUri;
      } catch (e) {
        console.warn(`[api-client] enhance Gemini error`, e);
        return null;
      }
    } catch (e) {
      console.error("enhanceClothingItemCutout failed:", e);
      return null;
    }
  },

  /**
   * Optional second pass: refine an already-isolated cutout (data URI) for cleaner backdrop + catalog pop.
   * Returns a new data URI or null on failure / missing key.
   */
  async polishClothingCutoutPreview(params: {
    imageDataUri: string;
    backdropHex?: string;
  }): Promise<string | null> {
    try {
      if (!aiGatewayEnabled() && !GEMINI_KEY) return null;
      const m = /^data:([^;]+);base64,(.+)$/i.exec(params.imageDataUri.trim());
      if (!m) return null;
      const mime = m[1] || "image/png";
      const b64 = m[2] ?? "";
      if (!b64) return null;
      const bg = sanitizeOutfitBackdropHex(params.backdropHex);
      const prompt = `You are given a product cutout on a solid background. Output ONE refined image of the same garment only.

KEEP: Same item, same pose/orientation, same framing, same true colors and patterns.
POLISH ONLY: Slightly richer contrast and saturation (+5–12%, natural), micro-sharper fabric edges, no halos. Remove any dust, speckles, or noise on the backdrop.
BACKGROUND: Must stay a perfectly flat, uniform ${bg} — zero gradient, texture, or artifacts.

Do not add props, people, hangers, or new garments.`;

      const parts: any[] = [
        { text: prompt },
        {
          inline_data: {
            mime_type: mime.includes("png") ? "image/png" : "image/jpeg",
            data: b64,
          },
        },
      ];

      for (const model of [GEMINI_IMAGE_PRIMARY, GEMINI_IMAGE_FALLBACK]) {
        try {
          const response = await callGeminiWithImage(model, parts, ["IMAGE"]);
          const uri = extractInlineImage(response);
          if (uri) return uri;
        } catch (e) {
          console.warn(
            `[api-client] polishClothingCutoutPreview ${model} failed`,
            e,
          );
        }
      }
      return null;
    } catch (e) {
      console.error("polishClothingCutoutPreview failed:", e);
      return null;
    }
  },
};
