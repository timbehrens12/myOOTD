import { DeviceEventEmitter } from "react-native";
import type { SupabaseClient } from "@supabase/supabase-js";

import { attachClothingItemsToOutfit } from "./linkItemsToOutfit";
import {
  normalizeFormality,
  normalizePattern,
  normalizeStyleTags,
  primaryStyleFromTags,
} from "./stylistGuards";
import {
  clearUploadRecoverySession,
  persistUploadReviewSession,
  type UploadRecoverySession,
} from "./uploadRecoverySession";
import { saveUploadSessionToCloset } from "./uploadRecoveryQueue";

function americanizeFashionText(input: string): string {
  return input
    .replace(/\bthongs\b/gi, "flip-flops")
    .replace(/\bthong\b/gi, "flip-flop")
    .replace(/\btrainers\b/gi, "sneakers")
    .replace(/\btrainer\b/gi, "sneaker");
}

function warmthToSeasons(w: string | undefined): string[] {
  if (w === "warm") return ["spring", "summer"];
  if (w === "cold") return ["fall", "winter"];
  return ["all"];
}

function normalizedSeasonsForMeta(meta: Record<string, unknown>): string[] | null {
  const raw = Array.isArray(meta.seasons)
    ? (meta.seasons as unknown[])
        .map((s) => String(s).toLowerCase().trim())
        .filter(Boolean)
    : [];
  return raw.length ? raw : null;
}

function buildClothingItemRow(
  meta: Record<string, unknown>,
  imageUrl: string,
  userId: string,
  thumbnailUrl?: string | null,
) {
  const cleanName = americanizeFashionText(String(meta?.name || "New Piece"));
  const cleanSub = meta?.sub_category
    ? americanizeFashionText(String(meta.sub_category))
    : null;
  const cleanCategory = meta?.category
    ? americanizeFashionText(String(meta.category))
    : "other";
  const cleanType = americanizeFashionText(
    String(meta?.sub_category || meta?.category || "Piece"),
  );
  // Real classifier metadata — these used to be hardcoded ("casual"/"solid"/
  // null) for every item ever saved, which silently broke style matching.
  const styleTags = normalizeStyleTags(meta?.style_tags);
  return {
    user_id: userId,
    name: cleanName,
    image_url: imageUrl,
    type: cleanType,
    category: cleanCategory,
    sub_category: cleanSub,
    color: meta?.color || "Unknown",
    material: null,
    fit: null,
    weight: null,
    pattern: normalizePattern(meta?.pattern),
    style: primaryStyleFromTags(styleTags),
    style_tags: styleTags.length ? styleTags : null,
    seasons:
      normalizedSeasonsForMeta(meta) ||
      warmthToSeasons(
        typeof meta?.warmth === "string" ? meta.warmth : undefined,
      ),
    occasions: meta?.occasions || ["casual"],
    formality: normalizeFormality(meta?.formality),
    box_2d: meta?.box_2d || null,
    notes: null,
    is_digitized: true,
    image_url_original: meta?.image_url_original ?? null,
    image_url_isolated: meta?.image_url_isolated ?? null,
    thumbnail_url: thumbnailUrl ?? null,
  };
}

export type SaveFitExtractInput = {
  userId: string;
  outfitId: string;
  imageUri: string;
  items: Record<string, unknown>[];
  supabase: SupabaseClient;
  existingSession?: UploadRecoverySession | null;
};

export type SaveFitExtractResult = {
  insertedIds: string[];
  session: UploadRecoverySession | null;
};

export async function saveFitExtractItems(
  input: SaveFitExtractInput,
): Promise<SaveFitExtractResult> {
  const { userId, outfitId, imageUri, items, supabase, existingSession } =
    input;
  const ready = items.filter((it) => !(it._classifying || it._scanning));
  if (ready.length === 0) {
    return { insertedIds: [], session: existingSession ?? null };
  }

  const session = await persistUploadReviewSession({
    userId,
    aiMetaList: ready,
    imageUri,
    linkOutfitId: outfitId,
    existingSession: existingSession ?? null,
  });
  if (!session) {
    throw new Error("Could not prepare upload session.");
  }

  const { session: updatedSession, insertedIds, allSaved } =
    await saveUploadSessionToCloset(
      session,
      supabase,
      userId,
      buildClothingItemRow,
    );

  if (insertedIds.length === 0) {
    throw new Error("Could not save pieces to your closet.");
  }

  await attachClothingItemsToOutfit(supabase, outfitId, insertedIds);
  DeviceEventEmitter.emit("closetItemsSaved");
  DeviceEventEmitter.emit("outfitItemsExtracted", {
    outfitId,
    itemIds: insertedIds,
  });

  if (allSaved) {
    await clearUploadRecoverySession(userId);
    return { insertedIds, session: null };
  }

  return { insertedIds, session: updatedSession };
}
