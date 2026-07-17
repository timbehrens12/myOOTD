import type { BuilderItem, ClosetItem } from "../components/fits/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatGeminiUserMessage } from "../constants/api-client";
import { OCCASIONS_FLAT } from "../constants/occasions";
import { STYLE_ME_WHEEL_OCCASIONS } from "../constants/styleMeWheelOccasions";
import {
  fetchRecentGeneratedItemIds,
  generateAutoOutfitBatch,
  recordStylistGeneration,
} from "./autoOutfitBatch";
import { resolveMannequinGender } from "./mannequinGender";
import { renderOutfitTryOnPreview } from "./renderOutfitTryOnPreview";
import { dailyHighLowFromOpenMeteo, fetchOptionalOpenMeteo } from "./weatherSnapshot";
import { attachHeroToOutfit, saveOutfit } from "./saveOutfit";
import { scopeClosetItemsForSchedule, pruneAnchorIdsToPool } from "./wardrobes/scopeClosetItems";

export type AutogenScheduleRow = {
  id: string;
  label?: string | null;
  occasion?: string | null;
  custom_instructions?: string | null;
  anchor_item_ids?: string[] | null;
  wardrobe_id?: string | null;
  consider_weather?: boolean | null;
  generate_try_on?: boolean | null;
  try_on_photo_url?: string | null;
};

function idsToOrderedBuilderItems(
  ids: string[],
  closetItems: ClosetItem[],
): BuilderItem[] {
  const out: BuilderItem[] = [];
  let slot = 0;
  for (const id of ids) {
    const it = closetItems.find((c) => c.id === id);
    if (it) out.push({ ...it, slot });
    slot++;
  }
  return out;
}

function occasionPhrase(schedule: AutogenScheduleRow): string {
  const key = schedule.occasion || "casual";
  const trimmedTitle = (schedule.label || "").trim();
  if (key === "custom") {
    return trimmedTitle || "A stylish outfit";
  }
  const wheel = STYLE_ME_WHEEL_OCCASIONS.find((o) => o.key === key);
  if (wheel?.phrase?.trim()) {
    return wheel.phrase.trim();
  }
  const row = OCCASIONS_FLAT.find((o) => o.id === key);
  const label = row?.label ?? "Stylish";
  return `${label} outfit — cohesive, weather-appropriate, wearable.`;
}

export type RunAutomationResult = {
  outfitId: string;
  previewImageUrl: string | null;
  tryOnImageUrl: string | null;
};

/**
 * Build one AI outfit from a saved automation slot, optionally weather-aware + on-body try-on.
 */
export async function runHomeAutomationGeneration(opts: {
  supabase: SupabaseClient;
  userId: string;
  schedule: AutogenScheduleRow;
  /** Public release represented by this run; manual runs default to now. */
  releaseAt?: Date | string | null;
}): Promise<RunAutomationResult> {
  const { supabase, userId, schedule } = opts;

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("gender, style_archetypes")
    .eq("user_id", userId)
    .maybeSingle();
  const genderStylePref = profileRow?.gender ?? null;
  const styleArchetypes = Array.isArray(profileRow?.style_archetypes)
    ? profileRow.style_archetypes.filter(
        (value: unknown): value is string => typeof value === "string",
      )
    : [];

  const previewsDesired = !!schedule.generate_try_on;
  const useWeather =
    schedule.consider_weather !== undefined && schedule.consider_weather !== null
      ? schedule.consider_weather
      : true;

  const { data: closetRows } = await supabase
    .from("clothing_items")
    .select("*")
    .eq("user_id", userId);

  const allClosetItems = (closetRows ?? []) as ClosetItem[];
  const closetItems = await scopeClosetItemsForSchedule(
    allClosetItems,
    schedule.wardrobe_id,
  );
  if (closetItems.length < 3) {
    throw new Error(
      schedule.wardrobe_id
        ? "This wardrobe needs at least a few pieces before generating."
        : "Need at least a few closet items before generating.",
    );
  }

  const weather = useWeather
    ? await fetchOptionalOpenMeteo().catch(() => undefined)
    : undefined;

  const anchors = pruneAnchorIdsToPool(
    Array.from(new Set(schedule.anchor_item_ids ?? [])).filter(Boolean) as string[],
    closetItems,
  );

  const phrase = occasionPhrase(schedule);
  const trimmedInstructions = String(schedule.custom_instructions ?? "").trim();
  const extraParts: string[] = [];
  if (useWeather && weather) {
    extraParts.push("Pick layers that suit today's forecast.");
  }
  if (schedule.occasion !== "custom" && trimmedInstructions) {
    extraParts.push(trimmedInstructions);
  }
  const extraUserText = extraParts.length ? extraParts.join(" ") : undefined;

  const recentOutfitItemIds = await fetchRecentGeneratedItemIds(
    supabase,
    userId,
  );

  let plans;
  try {
    plans = await generateAutoOutfitBatch({
      count: 1,
      occasionPhrase: phrase,
      closetItems,
      weather,
      anchorItemIds: anchors,
      colorHarmony: true,
      onlyCloset: true,
      extraUserText,
      genderStylePref,
      styleArchetypes,
      recentOutfitItemIds,
    });
  } catch (err) {
    throw new Error(formatGeminiUserMessage(err));
  }

  if (!plans.length) {
    throw new Error(
      "Couldn't create a look — the stylist may be busy. Try again in a moment.",
    );
  }

  // Rotation bookkeeping so this pick counts against future suggestions.
  void recordStylistGeneration(
    supabase,
    userId,
    plans.map((p) => p.item_ids),
    "single",
  );

  const itemIdsOrdered = [...plans[0]!.item_ids];
  const builderItems = idsToOrderedBuilderItems(itemIdsOrdered, closetItems);
  if (!builderItems.length) {
    throw new Error("AI picked unknown items — try regenerating.");
  }

  let mannequinUri: string | null = null;
  let tryOnUri: string | null = null;

  if (previewsDesired) {
    const mannequinGender = resolveMannequinGender(genderStylePref);
    const refPhoto = schedule.try_on_photo_url?.trim();

    // Render only the final requested hero. A saved selfie used to trigger a
    // mannequin call followed by a selfie call for the same Auto OOTD run.
    mannequinUri = await renderOutfitTryOnPreview({
      items: builderItems,
      occasion: schedule.occasion || "casual",
      mode: refPhoto ? "selfie" : "mannequin",
      selfiePhotoUrl: refPhoto,
      mannequinGender,
    }).catch(() => null);

    if (!mannequinUri) {
      throw new Error("Could not render outfit preview.");
    }

    tryOnUri = mannequinUri;
  }

  const { outfitId, previewImageUrl } = await saveOutfit({
    supabase,
    userId,
    itemIds: itemIdsOrdered.filter((id) =>
      closetItems.some((c) => c.id === id),
    ),
    name: (schedule.label || "").trim().slice(0, 72) || "Automated fit",
    occasion: schedule.occasion || "casual",
    occasionLabel:
      schedule.occasion !== "custom" && trimmedInstructions
        ? `${phrase} · ${trimmedInstructions}`.slice(0, 120)
        : phrase.slice(0, 120),
    source: "ai",
    heroImageUri: mannequinUri,
    markAsWornToday: false,
    savedToLibrary: false,
  });

  let resolvedPreviewUrl = previewImageUrl ?? null;
  if (mannequinUri && !mannequinUri.startsWith("http")) {
    resolvedPreviewUrl =
      (await attachHeroToOutfit(
        supabase,
        userId,
        outfitId,
        mannequinUri,
        false,
      )) ?? resolvedPreviewUrl;
  }

  if (previewsDesired && tryOnUri) {
    if (tryOnUri.startsWith("http")) {
      await supabase
        .from("outfits")
        .update({ try_on_image_url: tryOnUri })
        .eq("id", outfitId)
        .eq("user_id", userId);
    } else {
      await attachHeroToOutfit(supabase, userId, outfitId, tryOnUri, true);
    }
  }

  const now = new Date().toISOString();
  const releaseAt = opts.releaseAt
    ? new Date(opts.releaseAt).toISOString()
    : now;
  const weatherUsed = useWeather && !!weather;
  const weatherRange = weatherUsed ? dailyHighLowFromOpenMeteo(weather) : null;

  const scheduleUpdate = {
    last_generated_at: now,
    last_generated_outfit_id: outfitId,
    last_generated_release_at: releaseAt,
    last_generated_weather_used: weatherUsed,
    last_generated_temp_high: weatherRange?.high ?? null,
    last_generated_temp_low: weatherRange?.low ?? null,
    updated_at: now,
  };
  const { error: releaseColumnError } = await supabase
    .from("autogen_schedules")
    .update(scheduleUpdate)
    .eq("id", schedule.id)
    .eq("user_id", userId);

  // Keep current installs working until the release-contract migration is
  // applied; PostgREST reports an unknown-column error on the first update.
  if (releaseColumnError) {
    const { last_generated_release_at: _releaseAt, ...legacyUpdate } =
      scheduleUpdate;
    await supabase
      .from("autogen_schedules")
      .update(legacyUpdate)
      .eq("id", schedule.id)
      .eq("user_id", userId);
  }

  return {
    outfitId,
    previewImageUrl: resolvedPreviewUrl ?? mannequinUri,
    tryOnImageUrl: tryOnUri,
  };
}
