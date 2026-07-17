import { apiClient } from "../constants/api-client";
import {
  isLowConfidenceClassification,
  normalizeFormality,
  normalizePattern,
  normalizeStyleTags,
  primaryStyleFromTags,
} from "./stylistGuards";
import { supabase } from "./supabase";

/**
 * Post-purchase classification. Onboarding seeds items as UNCLASSIFIED
 * (name = null). This is the ONLY place pre-app classification runs — and it
 * runs after payment, so we never pay the API bill for a non-paying user.
 *
 * Finds the user's pending items, classifies each isolated cutout, and writes
 * back name/category/color/occasions. This flow is non-interactive (no user is
 * watching to confirm), so a low-confidence result is NOT silently committed —
 * the item is left pending (name = null) so it surfaces as an un-named cutout
 * the user reviews and edits by hand, exactly as a hard classify failure does.
 */
async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.includes(",") ? s.split(",")[1] : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function classifyPendingItems(
  userId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const { data: pending } = await supabase
    .from("clothing_items")
    .select("id, image_url")
    .eq("user_id", userId)
    .is("name", null);

  if (!pending?.length) return 0;

  let done = 0;
  for (const row of pending as { id: string; image_url: string }[]) {
    try {
      const b64 = await urlToBase64(row.image_url);
      const { metadata } = await apiClient.classify(
        b64,
        "auto",
        "single",
        undefined,
        true,
      );
      // classify() has already rejected non-wardrobe objects and normalized
      // style_tags/pattern/formality — persist ALL of it, same as the
      // interactive add-items path, so onboarding items aren't second-class.
      const m = metadata?.[0];
      // Missing/low confidence → leave pending for manual review instead of
      // committing a guess nobody confirmed. Treated as if it never resolved.
      if (m && !isLowConfidenceClassification(m)) {
        const styleTags = normalizeStyleTags(m.style_tags);
        await supabase
          .from("clothing_items")
          .update({
            name: m.name ?? "Item",
            category: m.category ?? "other",
            sub_category: m.sub_category ?? null,
            color: m.color ?? null,
            occasions: Array.isArray(m.occasions) ? m.occasions : null,
            style: primaryStyleFromTags(styleTags),
            style_tags: styleTags.length ? styleTags : null,
            pattern: normalizePattern(m.pattern),
            formality: normalizeFormality(m.formality),
          })
          .eq("id", row.id);
      }
    } catch {
      // leave this item pending; closet still shows its cutout thumbnail
    }
    done += 1;
    onProgress?.(done, pending.length);
  }
  return done;
}
