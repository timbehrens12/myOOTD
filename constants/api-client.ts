/**
 * AI API client:
 * - OpenAI `gpt-5-nano` for closet item classification (vision) and outfit selection (JSON).
 * - Google Gemini `gemini-2.5-flash-lite` for outfit render (image only); falls back to
 *   `gemini-2.0-flash` if the lite model cannot return an image.
 *
 * Keys: EXPO_PUBLIC_OPENAI_API_KEY, EXPO_PUBLIC_GOOGLE_AI_API_KEY
 */

import { Colors } from "./AppTheme";

const OPENAI_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
const GEMINI_KEY = process.env.EXPO_PUBLIC_GOOGLE_AI_API_KEY;

const GEMINI_DEFAULT = "gemini-2.0-flash";
const GEMINI_RENDER_PRIMARY = "gemini-2.5-flash-lite";

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

async function callGemini(
  parts: { text?: string; inline_data?: { mime_type: string; data: string } }[],
  model = GEMINI_DEFAULT,
): Promise<string> {
  const res = await fetch(geminiUrl(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 2048 },
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

async function callGeminiWithImage(
  model: string,
  parts: any[],
  responseModalities = ["TEXT"],
): Promise<any> {
  const res = await fetch(geminiUrl(model), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        maxOutputTokens: 1024,
        responseModalities,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini HTTP ${res.status}`);
  }

  return res.json();
}

function extractInlineImage(response: any): string | null {
  const imageData = response?.candidates?.[0]?.content?.parts?.find((p: any) =>
    p.inline_data?.mime_type?.includes("image"),
  );
  if (imageData?.inline_data?.data) {
    return `data:${imageData.inline_data.mime_type};base64,${imageData.inline_data.data}`;
  }
  return null;
}

async function callOpenAIJson(prompt: string): Promise<string> {
  if (!OPENAI_KEY) {
    throw new Error("Missing EXPO_PUBLIC_OPENAI_API_KEY");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 2048,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI HTTP ${res.status}`);
  }

  const data = await res.json();
  let raw = data.choices?.[0]?.message?.content || "{}";
  raw = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return raw;
}

async function callOpenAIClassifyVision(
  prompt: string,
  imageBase64: string,
): Promise<string> {
  if (!OPENAI_KEY) {
    throw new Error("Missing EXPO_PUBLIC_OPENAI_API_KEY");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_completion_tokens: CLASSIFY_VISION_MAX_COMPLETION_TOKENS,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI HTTP ${res.status}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const msg = choice?.message;
  let raw = msg?.content;

  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    const refusal = typeof msg?.refusal === "string" ? msg.refusal.trim() : "";
    if (refusal) {
      throw new Error(`Model refused: ${refusal}`);
    }
    const fr = choice?.finish_reason ?? "unknown";
    const lengthHint =
      fr === "length"
        ? " Output hit the token limit (truncated). Try a simpler photo or fewer items in frame."
        : "";
    throw new Error(
      `Empty response from item analyzer (finish_reason: ${fr}).${lengthHint} Try again or switch Fit check / Flat lay.`,
    );
  }

  if (typeof raw !== "string") {
    raw = String(raw);
  }
  raw = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return raw;
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

export const apiClient = {
  /**
   * Classify one or many clothing items from an image (OpenAI gpt-5-nano + vision).
   * Same stack as camera / snap flows — does not call Google Gemini.
   */
  async classify(
    imageBase64: string,
    _categoryHint: string,
    _mode: "single" | "multi" = "single",
  ) {
    const prompt = `Identify every clothing item, shoe, bag, accessory, and jewelry in this photo.
Return one JSON array only. Each object: {"name":"≤6 words","category":"top|bottom|outerwear|full body|shoes|accessory|bag","sub_category":"short","color":"one word (metals:gold/silver)","warmth":"warm|cold|both","occasions":["max 5 ids, most relevant only"],"style_tags":["max 3 ids, vibe/aesthetic"],"box_2d":[ymin,xmin,ymax,xmax]}
Allowed occasion ids (pick ≤5 per item): casual,gym,sport,beach,ski,hiking,brunch,date-night,night-out,festival,wedding,work,school,travel,lounge,errands,cocktail,black-tie
Allowed style_tags ids (pick ≤3 that best match the item): casual,office,street,evening,sporty,preppy,minimalist,romantic,edgy
warmth: warm/cold/both by fabric weight. box_2d: 0-1000 tight crop. No markdown.`;

    let json = "";
    let lastVisionErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        json = await callOpenAIClassifyVision(prompt, imageBase64);
        lastVisionErr = undefined;
        break;
      } catch (e) {
        lastVisionErr = e;
        const m = e instanceof Error ? e.message : String(e);
        if (attempt === 0 && m.includes("Empty response from item analyzer")) {
          continue;
        }
        throw e;
      }
    }
    if (!json.trim() && lastVisionErr) throw lastVisionErr;

    const parsed = parseClassifyJsonPayload(json);
    const normalized = normalizeClassifyItems(parsed);
    const usable = filterUsableItemMeta(normalized);
    if (usable.length === 0) {
      throw new Error(
        normalized.length > 0
          ? "AI response had no usable item fields (need name, category, or type)"
          : "AI returned no clothing items for this image",
      );
    }
    return { metadata: attachSanitizedBox2d(usable) };
  },

  /**
   * Pick outfit item IDs from the closet using OpenAI gpt-5-nano.
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

    const json = await callOpenAIJson(prompt);
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

      for (const model of [GEMINI_RENDER_PRIMARY, GEMINI_DEFAULT]) {
        try {
          const response = await callGeminiWithImage(model, parts, ["IMAGE"]);
          const uri = extractInlineImage(response);
          if (uri) return uri;
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
   * Isolated garment / accessory on a flat backdrop (Gemini image), for add-closet "enhance" step.
   * Returns a data: URI or null if keys missing / models fail.
   */
  async enhanceClothingItemCutout(params: {
    imageBase64: string;
    name?: string;
    color?: string;
    category?: string;
    backdropHex?: string;
  }): Promise<string | null> {
    try {
      if (!GEMINI_KEY) return null;
      const bg = sanitizeOutfitBackdropHex(params.backdropHex);
      const hint = [params.color, params.name, params.category]
        .filter(Boolean)
        .join(" · ");
      const prompt = `Create a premium catalog / e-commerce hero shot of the main clothing item or accessory from the reference photo.

REQUIREMENTS:
- Show ONLY that one fashion item, centered, with generous empty space around it.
- Background must be a single flat solid color exactly ${bg} everywhere — no gradient, texture, floor, wall, hanger, mannequin, hands, face, or environment from the original photo.
- Remove all clutter; preserve accurate colors, patterns, and fabric weave from the reference.
- If several garments appear, feature the single most prominent piece${hint ? ` matching: ${hint}` : ""}.
- Studio polish: slightly confident contrast and saturation (subtle, not HDR), crisp silhouette edges, no muddy shadows on the backdrop.
- Eliminate any noise, JPEG blocks, dust, or leftover background specks — the backdrop must be perfectly clean ${bg}.
- Soft contact shadow under the garment only is fine; the backdrop stays pure ${bg}.`;

      const parts: any[] = [
        { text: prompt },
        {
          inline_data: {
            mime_type: "image/jpeg",
            data: params.imageBase64,
          },
        },
      ];

      for (const model of [GEMINI_RENDER_PRIMARY, GEMINI_DEFAULT]) {
        try {
          const response = await callGeminiWithImage(model, parts, ["IMAGE"]);
          const uri = extractInlineImage(response);
          if (uri) return uri;
        } catch (e) {
          console.warn(`[api-client] enhanceClothingItemCutout ${model} failed`, e);
        }
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

      for (const model of [GEMINI_RENDER_PRIMARY, GEMINI_DEFAULT]) {
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
