/**
 * AI API client — OpenAI (classify) + Google Gemini (image gen + text fallback).
 * - OpenAI gpt-5-nano: PRIMARY vision classify with reasoning_effort=minimal.
 * - Gemini 2.5 Flash Lite: classify FALLBACK + text-only outfit selection.
 * - Gemini 2.5 Flash Image: outfit renders + closet/add-items enhance (catalog cutout).
 *
 * Keys: EXPO_PUBLIC_OPENAI_API_KEY (primary), EXPO_PUBLIC_GOOGLE_AI_API_KEY
 */

import { Colors } from "./AppTheme";

const GEMINI_KEY = process.env.EXPO_PUBLIC_GOOGLE_AI_API_KEY;
const OPENAI_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;

/** Image model for closet/add-items enhance (GPT Image is not used). */
const GEMINI_IMAGE_ENHANCE = "gemini-2.5-flash-image";
const GEMINI_IMAGE_PRIMARY = "gemini-2.5-flash-image";
const GEMINI_IMAGE_FALLBACK = "gemini-3.1-flash-image-preview";
const GEMINI_CLASSIFY = "gemini-2.5-flash-lite"; // fallback for classification
const OPENAI_CLASSIFY = "gpt-5-nano"; // primary — reasoning_effort=minimal for speed

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

function geminiUrl(model: string) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

async function callGeminiWithImage(
  model: string,
  parts: any[],
  responseModalities = ["TEXT"],
  /** Pass "512" for enhance/thumbnail calls — cheaper + faster on Gemini 3.1 Flash Image. */
  imageResolution?: "512" | "1K" | "2K" | "4K",
): Promise<any> {
  const wantsImage = responseModalities.includes("IMAGE");
  const modalities = wantsImage ? ["TEXT", "IMAGE"] : responseModalities;
  // 512 output needs far fewer tokens than the default 1K; 2048 is plenty for thumbnails.
  const maxOutputTokens = wantsImage ? (imageResolution === "512" ? 2048 : 4096) : 1024;
  const res = await fetch(geminiUrl(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        maxOutputTokens,
        responseModalities: modalities,
        ...(imageResolution ? { imageConfig: { imageSize: imageResolution } } : {}),
        // thinkingConfig is text-only — omit for image generation requests
        ...(wantsImage ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }

  return res.json();
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
      p?.text != null
        ? "text"
        : inlineImageFromPart(p)
          ? "image"
          : "other",
    )
    .join(",");
  return `parts: ${kinds}`;
}

/** Text-only Gemini call — used for outfit selection (no image input). */
async function callGeminiJson(prompt: string): Promise<string> {
  if (!GEMINI_KEY) throw new Error("Missing EXPO_PUBLIC_GOOGLE_AI_API_KEY");
  const res = await fetch(geminiUrl(GEMINI_CLASSIFY), {
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
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Fast classification via Gemini 2.0 Flash vision.
 * Returns the raw JSON string from the model.
 */
async function callGeminiClassifyVision(
  prompt: string,
  imageBase64: string,
): Promise<string> {
  if (!GEMINI_KEY) throw new Error("Missing EXPO_PUBLIC_GOOGLE_AI_API_KEY");

  const res = await fetch(geminiUrl(GEMINI_CLASSIFY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 800,
        responseMimeType: "application/json",
        // Disable Gemini 2.5's internal reasoning pass — Flash-Lite is fast
        // enough without it for classification and cuts latency 300–800 ms.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini classify HTTP ${res.status}`);
  }

  const data = await res.json();
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
  if (!OPENAI_KEY) throw new Error("Missing EXPO_PUBLIC_OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
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
                detail: "low", // "low" = 85 tokens, ~3× faster than "high"; plenty for garment ID
              },
            },
          ],
        },
      ],
      max_completion_tokens: 1200,
      response_format: { type: "json_object" },
      reasoning_effort: "minimal",
      verbosity: "low",
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI classify HTTP ${res.status}`);
  }

  const data = await res.json();
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

/** Vision models often box phones, bottles, etc.; drop those after classify. */
const FASHION_ACCESSORY_HINT =
  /\b(glasses|sunglasses|eyewear|jewelry|necklace|bracelet|earrings?|ring|watch|belt|hair\s*clip|scrunchie|tie|bow\s*tie|gloves?|mittens?|headband|bandana|wallet\s*chain|chain\s*wallet)\b/i;

function isLikelyNonWardrobeObject(meta: Record<string, unknown>): boolean {
  const text = `${meta.name ?? ""} ${meta.sub_category ?? ""} ${meta.category ?? ""} ${meta.type ?? ""}`;
  if (FASHION_ACCESSORY_HINT.test(text)) return false;
  const t = text.toLowerCase();
  const nonWardrobe =
    /\b(phones?|smartphones?|iphones?|android)\b/.test(t) ||
    /\b(water\s*bottle|sports\s*bottle|drink(?:ing)?\s*bottle|thermos|tumbler|hydro\s*flask|nalgene|stanley\s+cup|\byeti\b|hydration)\b/.test(
      t,
    ) ||
    /\b(laptops?|macbooks?|ipads?|tablets?|kindles?)\b/.test(t) ||
    /\b(coffee\s*cup|paper\s*cup|disposable\s*cup|to-?go\s*cup|reusable\s*cup)\b/.test(
      t,
    ) ||
    /\b(airpods?(\s+(max|pro|case))?|earbuds?|headphones?|earphones?|headsets?|gaming\s*headset|bone\s*conduction|wireless\s*headphones|over-?ear|on-?ear)\b/.test(
      t,
    ) ||
    /\b(chargers?|charging\s*case|power\s*bank)\b/.test(t) ||
    /\b(dumbbells?|kettlebells?|yoga\s*mats?|foam\s*roller)\b/.test(t) ||
    /\b(keys?|key\s*fob|car\s*keys)\b/.test(t) ||
    /\b(spiral\s*notebook|composition\s*book)\b/.test(t) ||
    (/\bbottle\b/.test(t) &&
      /\b(water|sport|drink|plastic|metal)\b/.test(t) &&
      !/\b(perfume|fragrance|cologne|nail)\b/.test(t));
  return nonWardrobe;
}

function filterWardrobeOnlyItems(items: Record<string, unknown>[]) {
  return items.filter((m) => !isLikelyNonWardrobeObject(m));
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

/** Fix obvious warmth mistakes (e.g. sports bra → cold → fall/winter in UI). */
function reconcileWarmth(meta: Record<string, unknown>): Record<string, unknown> {
  const w = String(meta.warmth ?? "")
    .trim()
    .toLowerCase();
  if (w !== "cold") return meta;
  const hay = `${meta.name ?? ""} ${meta.sub_category ?? ""} ${meta.category ?? ""} ${meta.type ?? ""}`.toLowerCase();
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
    const scopeRules = `ONLY include wearable fashion: apparel (tops, bottoms, dresses, outerwear), footwear, handbags/totes/backpacks worn or held as part of the outfit, and fashion accessories (jewelry, watches, glasses/sunglasses, belts, hats, scarves, hair accessories).
NEVER include: phones, tablets, laptops, water bottles, drink cups/mugs, keys, books, chargers, headphones, earbuds, headsets, AirPods, audio devices, gym equipment, or other props — even if visible on the person, in ears, or around the neck.
OCCLUSION RULE: Skip any item that is less than ~60% visible. If only a corner/strip/sliver of an item is showing (e.g. a graphic tee peeking through an unzipped jacket, a bag strap at the frame edge, half a shoe behind a pant leg), DO NOT list it — the visible portion is insufficient to capture design/print/shape. Only classify items that are mostly in-frame and mostly unoccluded.
CONTENT SAFETY: If the image contains nudity, sexual content, violence, weapons, drug use, hate symbols, or any inappropriate content, return an empty JSON array [] with no other output.
If nothing in the frame is wardrobe-related, return an empty JSON array [].`;

    const isolatedPrompt =
      `This image shows one item on a white background — it should be clothing, shoes, a bag, or a fashion accessory (glasses, jewelry, belt, hat, etc.).
If the subject is NOT wardrobe (e.g. phone, bottle, headphones, earbuds, electronics), return exactly: {}
If the image contains nudity, sexual content, violence, weapons, drug use, or inappropriate content, return exactly: {}
If the item is heavily cut off / less than ~60% visible in frame, return exactly: {}
Otherwise return a JSON object (not array) with exactly these fields:
{"name":"≤5 words","category":"top|bottom|outerwear|full body|shoes|accessory|bag","sub_category":"1-2 words","color":"one word","warmth":"warm|cold|both","occasions":["≤3 from: casual,active,going-out,work,travel,lounge,formal"],"style_tags":["≤2 from: casual,office,street,evening,sporty,preppy,minimalist,romantic,edgy"]}
warmth: cold ONLY for coats, jackets, puffers, sweaters, hoodies, fleece, boots, scarves, gloves. warm for sports bras, bras, crop tops, tanks, sleeveless tops, shorts, swimwear, sandals, gym leggings. both for regular tees, jeans, sneakers, bags, jewelry. NEVER label sports bras, tanks, or shorts as cold. No extra text.`;

    const fitCheckExclusion =
      photoLayout === "fit_check"
        ? `\nFIT-CHECK EXCLUSIONS — do NOT list these even if visible: socks, earrings, rings, bracelets, anklets, hair ties, scrunchies, hair clips, small pendants, or any tiny accessory that occupies <5% of the image. Only include accessories that are LARGE and OBVIOUS at this distance: necklaces with clear chain visible, watches, sunglasses, hats, belts, scarves, ties, visible-strap bags. If in doubt about whether an accessory is large enough — skip it. The user will photograph small items individually.\n`
        : "";

    const scenePrefix =
      photoLayout === "flat_lay"
        ? `Scene: flat-lay — one entry per distinct wardrobe piece only.\n${scopeRules}\n\n`
        : photoLayout === "fit_check"
          ? `Scene: person in an outfit — list only what they are wearing or carrying as fashion (clothes, shoes, bag, large accessories).\n${scopeRules}${fitCheckExclusion}\n\n`
          : `${scopeRules}\n\n`;
    const multiPrompt = `${scenePrefix}List every qualifying item from the ALLOW list above. Do not list phones, bottles, cups, headphones, earbuds, headsets, or other electronics.
Return a JSON array. Each object: {"name":"≤5 words","category":"top|bottom|outerwear|full body|shoes|accessory|bag","sub_category":"1-2 words","color":"one word","warmth":"warm|cold|both","occasions":["≤3 from: casual,active,going-out,work,travel,lounge,formal"],"style_tags":["≤2 from: casual,office,street,evening,sporty,preppy,minimalist,romantic,edgy"],"box_2d":[ymin,xmin,ymax,xmax]}
box_2d: [ymin,xmin,ymax,xmax] only — normalized 0–1000, origin at TOP-LEFT of the image (ymin smaller = higher on screen). Each box must FULLY contain that garment with comfortable margin. For normal garments, span at least 100 units in BOTH width and height.
Do NOT box mirror reflections, background clutter, or razor-thin strips at the left/right edge — box the actual item on the person.
warmth: cold ONLY for coats, jackets, puffers, sweaters, hoodies, fleece, boots, scarves, gloves. warm for sports bras, bras, crop tops, tanks, sleeveless tops, shorts, swimwear, sandals, gym leggings. both for regular tees, jeans, sneakers, bags, jewelry, hats, sunglasses. NEVER use cold for sports bras, tanks, or shorts. Outerwear category is always cold. No markdown.`;

    const prompt = isIsolated ? isolatedPrompt : multiPrompt;

    // Primary: Gemini 2.5 Flash Lite (retried once). OpenAI gpt-5-nano is kept
    // as a fallback behind the scenes — but NOT as primary, because at
    // `detail: "low"` it returns imprecise box_2d coordinates that wreck the
    // per-item crop step, and `detail: "high"` erases the speed advantage.
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
    if (!json.trim() && OPENAI_KEY) {
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
    return { metadata: withBoxes.map(reconcileWarmth) };
  },

  /**
   * Pick outfit item IDs from the closet using Gemini Flash Lite (text-only JSON).
   */
  async generateOutfits(preferences: {
    occasion: string;
    weather?: any;
    items: {
      id: string;
      name?: string;
      type?: string;
      category: string;
      color?: string;
      style?: string;
      occasions?: string[];
    }[];
    anchorItemIds?: string[];
    extraInstructions?: string;
  }) {
    const {
      occasion,
      weather,
      items,
      anchorItemIds = [],
      extraInstructions,
    } = preferences;

    if (!items || items.length === 0) {
      throw new Error("Your closet is empty. Add some items first.");
    }

    const weatherContext = weather?.current_weather
      ? `Current weather: ${Math.round(weather.current_weather.temperature)}°, code ${weather.current_weather.weathercode}. `
      : "";

    const anchorNote =
      anchorItemIds.length > 0
        ? `\nYou MUST include these anchor item IDs: ${anchorItemIds.join(", ")}`
        : "";

    const extra = extraInstructions?.trim()
      ? `\nAdditional instructions from the user: ${extraInstructions.trim()}`
      : "";

    const itemList = items.map((it) => ({
      id: it.id,
      name: it.name || `${it.color || ""} ${it.type || it.category}`.trim(),
      type: it.type,
      category: it.category,
      color: it.color,
      style: it.style,
      occasions: it.occasions || [],
    }));

    const prompt = `You are an expert fashion stylist. ${weatherContext}Create a complete, cohesive outfit for the occasion: "${occasion}".${anchorNote}${extra}

RULES:
- Select ONE item per category slot: (top OR "full body") + (bottom if no "full body") + shoes + optional outerwear + optional accessory + optional bag
- All items must work together aesthetically and be appropriate for "${occasion}" and the weather
- Prefer items whose occasions array overlaps the vibe of "${occasion}"
- Only use IDs from the list below

AVAILABLE WARDROBE:
${JSON.stringify(itemList, null, 2)}

Return ONLY a valid JSON object:
{ "item_ids": ["id1", "id2", ...], "title": "short catchy outfit name", "reasoning": "one sentence explaining the choices" }
No markdown, no explanation outside the JSON.`;

    const json = await callGeminiJson(prompt);
    return JSON.parse(json) as {
      item_ids: string[];
      title: string;
      reasoning: string;
    };
  },

  /**
   * Composite outfit render via Gemini image generation.
   * Tries gemini-2.5-flash-lite first, then gemini-2.0-flash (image-capable fallback).
   */
  async generateOutfitImage(params: {
    outfitItems: {
      id?: string;
      name?: string;
      type?: string;
      color?: string;
      category?: string;
    }[];
    occasion: string;
    bodyPhotoBase64?: string;
    /** Defaults to app Fits canvas color (`Colors.fitsBuilderCanvas`) */
    backdropHex?: string;
  }): Promise<string | null> {
    try {
      const { outfitItems, occasion, bodyPhotoBase64, backdropHex } = params;
      const bg = sanitizeOutfitBackdropHex(backdropHex);

      const itemDescriptions = outfitItems
        .map((item) =>
          `- ${item.color || ""} ${item.name || item.type || "item"}`.trim(),
        )
        .join("\n");

      const backdropRules = `BACKGROUND (required): The entire frame behind the subject must be ONE flat, solid color only: exactly ${bg}. No gradients, no paper texture, no studio floor, no horizon, no walls, no furniture, no props. No edge vignette. Every pixel outside the person (and outside their clothing/shoes) must be ${bg} so the image can sit flush in an app that uses the same solid fill.

LIGHTING: Professional and even. The subject may have normal soft shading on their body; do not paint large colored shadows onto the backdrop that would change ${bg}.

SHOT: Full-body fashion editorial, standing naturally, pleasant expression.`;

      const basePrompt = `Create a clean, professional fashion photo for a ${occasion} occasion.
The outfit consists of:
${itemDescriptions}

${backdropRules}`;

      const prompt = bodyPhotoBase64
        ? `${basePrompt}

Use the reference photo for the person's identity, body shape, pose preference, and skin tone. Dress them in the outfit described above. Remove/replace the entire original background with the solid ${bg} backdrop only — no trace of the old environment.`
        : `${basePrompt}

Use a generic full-body fashion model or mannequin-like figure (appropriate for the outfit) to display the clothing.`;

      const parts: any[] = [{ text: prompt }];

      if (bodyPhotoBase64) {
        parts.push({
          inline_data: { mime_type: "image/jpeg", data: bodyPhotoBase64 },
        });
      }

      for (const model of [GEMINI_IMAGE_PRIMARY, GEMINI_IMAGE_FALLBACK]) {
        try {
          const response = await callGeminiWithImage(model, parts, ["IMAGE"]);
          const uri = extractInlineImage(response);
          if (uri) return uri;
          console.warn(
            `[api-client] outfit image ${model} no image (${summarizeGeminiImageFailure(response)})`,
          );
        } catch (e) {
          console.warn(`[api-client] outfit image model ${model} failed`, e);
        }
      }

      return null;
    } catch (e) {
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
      const prompt = `You are a professional product photographer. Edit this photo to create a clean e-commerce catalog image of the clothing item${hint ? ` (${hint})` : ""}.

Remove the person wearing it and any background. Show ONLY the garment itself, laid flat or as if on an invisible mannequin. The item should fill most of the frame, centered, with even padding on all sides.

Background: flat solid color ${bg} everywhere. No shadows, no gradients, no floor, no texture.

Preserve the garment's exact colors, patterns, and fabric texture. Crisp clean edges.`;

      if (!GEMINI_KEY) return null;

      const parts: any[] = [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: params.imageBase64 } },
      ];

      const enhanceModel = GEMINI_IMAGE_ENHANCE;
      try {
        console.log(`[api-client] enhance: calling Gemini ${enhanceModel}…`);
        const response = await callGeminiWithImage(
          enhanceModel,
          parts,
          ["IMAGE"],
          "1K",
        );
        const uri = extractInlineImage(response);
        if (uri) {
          console.log(`[api-client] enhance: ${enhanceModel} returned image`);
          return uri;
        }
        console.warn(
          `[api-client] enhance: ${enhanceModel} no image (${summarizeGeminiImageFailure(response)})`,
        );
      } catch (e) {
        console.warn(`[api-client] enhance: ${enhanceModel} failed`, e);
      }

      return null;
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
      if (!GEMINI_KEY) return null;
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
        { inline_data: { mime_type: mime.includes("png") ? "image/png" : "image/jpeg", data: b64 } },
      ];

      for (const model of [GEMINI_IMAGE_PRIMARY, GEMINI_IMAGE_FALLBACK]) {
        try {
          const response = await callGeminiWithImage(model, parts, ["IMAGE"]);
          const uri = extractInlineImage(response);
          if (uri) return uri;
        } catch (e) {
          console.warn(`[api-client] polishClothingCutoutPreview ${model} failed`, e);
        }
      }
      return null;
    } catch (e) {
      console.error("polishClothingCutoutPreview failed:", e);
      return null;
    }
  },
};
