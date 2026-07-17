import { useUser } from "@clerk/clerk-expo";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import {
    ArrowRightLeft,
    Box,
    Calendar,
    Check,
    ChevronDown,
    ChevronUp,
    CircleAlert,
    CloudSun,
    Delete,
    Info,
    Mic,
    MoveUp,
    Pencil,
    Plus,
    RotateCcw,
    Shirt,
    Sparkles,
    User,
    X,
} from "lucide-react-native";

import {
    forwardRef,
    memo,
    useCallback,
    useDeferredValue,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import {
    FlatList,
    Alert,
    DeviceEventEmitter,
    Keyboard,
    KeyboardAvoidingView,
    LayoutChangeEvent,
    Linking,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    useWindowDimensions,
    View,
    type StyleProp,
    type ViewStyle,
} from "react-native";
import {
    Gesture,
    GestureDetector,
    ScrollView,
} from "react-native-gesture-handler";
import Animated, {
    Easing,
    Extrapolation,
    FadeIn,
    FadeInUp,
    FadeOut,
    interpolate,
    LinearTransition,
    runOnJS,
    runOnUI,
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSpring,
    withTiming,
    type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiClient, formatGeminiUserMessage } from "../../constants/api-client";
import {
    Colors,
    Editorial,
    EditorialStyles,
    Radii,
    Typography,
} from "../../constants/AppTheme";
import {
    FIT_STUDIO_BG,
    FIT_STUDIO_BG_CLIP_STYLE,
} from "../../constants/fitStudioBackground";
import {
    fetchRecentGeneratedItemIds,
    generateAutoOutfitBatch,
    idsToBuilderItems,
    recordStylistGeneration,
} from "../../lib/autoOutfitBatch";
import { uriToBase64 } from "../../app/add-items";
import { isoDayIsStrictlyFuture } from "../../lib/dayOutfitLog";
import { playKeyClickSound } from "../../lib/getStyledKeyboardSound";
import {
    ExpoSpeechRecognitionModule,
    isSpeechRecognitionAvailable,
    useSpeechRecognitionEvent,
} from "../../lib/speechRecognitionSafe";
import { resolveFitTitle } from "../../lib/fitTitle";
import { resolveMannequinGender } from "../../lib/mannequinGender";
import { persistHeroImageUrl, saveOutfit, updateOutfit } from "../../lib/saveOutfit";
import { dedupeOrderedIds, outfitItemSignature } from "../../lib/fitTryOnStale";
import { shareHeroImage } from "../../lib/shareHeroImage";
import { setTryOnRenderNavigationGuard } from "../../lib/tryOnRenderNavigationGuard";
import { supabase } from "../../lib/supabase";
import { PROFILE_PREFERENCES_UPDATED_EVENT } from "../../lib/profilePreferencesEvents";
import {
    garmentImageUrl,
    pickTryOnGarmentReferenceItems,
    tryOnGarmentRefLabel,
} from "../../lib/tryOnGarmentRefs";
import {
    loadStoredSelfies,
    mergeSelfieUrls,
    persistSelfies,
    removeSelfiePhotoFromLibrary,
} from "../../lib/tryOnSelfieLibrary";
import { getTryOnReadiness } from "../../lib/tryOnValidation";
import { tryGetCaptureRef } from "../../lib/viewShotCapture";
import { TRY_ON_GENERATION_MATTE_HEX } from "../../constants/tryOnSegmentation";
import { removeGeneratedTryOnBackgroundFromJpeg } from "../../lib/removeGeneratedTryOnBackground";
import { prepareTryOnImageUri } from "../../lib/usePreparedTryOnImage";
import { fetchOptionalOpenMeteo } from "../../lib/weatherSnapshot";
import { sortClosetItems } from "../closet/closetItemFilters";
import { ClosetItemImage } from "../closet/ClosetItemImage";
import {
    closetItemShelfKey,
    shelfIdForCategoryChip,
    shelfLabelForCategoryId,
} from "../closet/closetShelfUtils";
import { FrostedPlate } from "../ui/FrostedPlate";
import AutoOutfitBuilderPanel, {
    LOOK_BATCH_COUNT,
    type ApplyOutfitPayload,
    type AutoLooksSummaryPayload,
    type AutoOutfitBuilderPanelRef,
    type BuilderFormSeed,
} from "./AutoOutfitBuilderPanel";
import CalendarSheet from "./CalendarSheet";
import ClosetPickerPanel, { CategoryChipRow } from "./ClosetPickerPanel";
import ClosetCategoryBrowse from "../closet/ClosetCategoryBrowse";
import WardrobeStrip from "../closet/WardrobeStrip";
import { scopeClosetWithMaps } from "../../lib/wardrobes/scopeClosetItems";
import type {
  Wardrobe,
  WardrobeMembershipMaps,
} from "../../lib/wardrobes/types";
import {
  ClosetToolbarSearchToggle,
  ClosetToolbarWardrobeToggle,
} from "../closet/ClosetSearchSortFilterBar";
import FitShareCaptureView, {
  FIT_SHARE_CAPTURE_FORMAT,
  FIT_SHARE_CAPTURE_MIME,
  FIT_SHARE_CAPTURE_OUT_H,
  FIT_SHARE_CAPTURE_OUT_W,
  FIT_SHARE_CAPTURE_QUALITY,
} from "./FitShareCaptureView";
import LooksTray, { type LooksTrayHandle } from "./LooksTray";
import StyleMeGeneratingStrip from "./StyleMeGeneratingStrip";
import OutfitCanvas, {
    type AutoCanvasLook,
    type GenerationPhase,
    type OutfitCanvasHandle,
} from "./OutfitCanvas";
import TryOnModelCarousel, { type TryOnTarget } from "./TryOnModelCarousel";
import ThisFitExpandedPanel from "./ThisFitExpandedPanel";
import {
    MAX_FIT_BUILDER_PIECES,
    OCC_LABEL,
    type BuilderItem,
    type ClosetItem,
    type SavedFit,
} from "./types";

/** Manual strip tiles — keep in sync with `s.manualItem`. */
const MANUAL_STRIP_TILE = { w: 92, h: 110 };
const MANUAL_STRIP_TILE_STEP = MANUAL_STRIP_TILE.w + 10;
/** Category chips + item tiles — same hairline inset from the left edge. */
const MANUAL_STRIP_EDGE_INSET = 4;
/** Pre–onLayout guess for collapsed strip (handle + hint + chips + row); real value comes from layout. */
const STRIP_BODY_FIXED_H = 152;
/** Get Styled look tiles — fill strip body; bottom inset matches closet item row clearance. */
const STYLE_ME_STRIP_BOTTOM_INSET = 8;
const STYLE_ME_STRIP_TILE = {
  w: Math.round(
    (120 / 146) * (STRIP_BODY_FIXED_H - STYLE_ME_STRIP_BOTTOM_INSET),
  ),
  h: STRIP_BODY_FIXED_H - STYLE_ME_STRIP_BOTTOM_INSET,
};
/**
 * Try-on tiles — no category chips so tiles fill the full strip body.
 * Same aspect ratio as MANUAL_STRIP_TILE, height = strip - 2px inset.
 */
const TRY_ON_STRIP_TILE_INSET = 12;
const TRY_ON_STRIP_BOTTOM_INSET = TRY_ON_STRIP_TILE_INSET;
const TRY_ON_STRIP_TILE = {
  h: STRIP_BODY_FIXED_H - TRY_ON_STRIP_TILE_INSET * 2,
  w: Math.round(
    (MANUAL_STRIP_TILE.w / MANUAL_STRIP_TILE.h) *
      (STRIP_BODY_FIXED_H - TRY_ON_STRIP_TILE_INSET * 2),
  ),
};
/**
 * Kept defined (must stay **false**) so stale Hermes/fast-refresh bundles don’t throw
 * `ReferenceError: Property 'DEBUG_HIDE_COLLAPSED_DRAWER_BODY' doesn't exist`.
 */
const DEBUG_HIDE_COLLAPSED_DRAWER_BODY = false;
/** Temp: hide collapsed closet carousel so tab bar samples page bg like Home */
const DEBUG_HIDE_COLLAPSED_CAROUSEL = false;
const STRIP_SHEET_INNER_FALLBACK_PX = 36 + STRIP_BODY_FIXED_H;
/** Keep glass action pill fully above the closet sheet — overlap reads as a white seam. */
const ACTION_ISLAND_SHEET_GAP = 6;
/** Matches `s.actionIslandBlur.minHeight` — hero ends above this pill. */
const ACTION_ISLAND_HEIGHT = 50;
/** Soft morph for the Get Styled island instead of a hard pill -> composer jump. */
const PREMIUM_ISLAND_LAYOUT = LinearTransition.springify()
  .damping(25)
  .stiffness(170)
  .mass(0.9);
const PREMIUM_FADE_IN = FadeIn.duration(190).easing(Easing.out(Easing.cubic));
const PREMIUM_FADE_OUT = FadeOut.duration(120).easing(Easing.in(Easing.cubic));
const GET_STYLED_PROMPT_EXAMPLES = [
  // Kept SHORT so they never wrap in the composer. Mix of general looks and
  // pin-relative "this / these" phrasing (reads like what you type after
  // pinning a piece via the shirt button).
  "Dinner outfit with this top",
  "Casual Friday with these jeans",
  "Build a look around this jacket",
  "Date night with this dress",
  "Style these sneakers up",
  "Make this skirt dressier",
  "Weekend fit with these boots",
  "Brunch look, easy layers",
  "Rainy day but still cute",
  "Coffee run, camera-ready",
  "Work fit, relaxed confidence",
  "First date, effortless",
  "Airport layers that travel well",
  "Cozy night in with friends",
  "Office look with personality",
  "Warm-weather dinner",
  "Elevated basics",
  "Gym to lunch, no changing",
  "Make this hoodie intentional",
  "Style around this bag",
  "Smart casual with denim",
  "Errands but polished",
  "Concert with these boots",
  "City walk, light jacket",
  "Low effort, expensive-looking",
];
/** Placeholder typewriter cycles straight through the examples — no
 * interstitial line between them. */
const GET_STYLED_PLACEHOLDER_SEQUENCE: string[] = GET_STYLED_PROMPT_EXAMPLES;
/** `fits.tsx` float bar: `top: insets.top + 8` + Build · Library pill (~44px). */
const FITS_TOP_PILL_BOTTOM_FROM_SAFE = 56;
/** Try-on hero feet sit this close above the action island (regulated every time). */
const TRY_ON_HERO_FOOT_GAP = 4;
/** Inline save panel min height as a fraction of the builder stage (when measured). */
const SAVE_SHEET_STAGE_RATIO = 0.42;
/** Breathing room between expanded closet top and Create/Library row. */
const FITS_CLOSET_UNDER_HEADER_GAP = 2;
/**
 * Auto outfit builder uses full stage height to match the closet slide up,
 * giving plenty of room for the vertical configuration cards.
 */
const AUTO_BUILDER_SHEET_MAX_RATIO = 1.0;

/** Bottom inset for empty “your next OOTD” — include island reserve to center relative to the pill. */
const FIT_EMPTY_HINT_BOTTOM_RESERVE = STRIP_SHEET_INNER_FALLBACK_PX + 124;

/** Layer stacks before the swap sheet — accessories ignore these (see `isAccessoryLike`). */
const MAX_TOP_LAYERS = 2;
const MAX_BOTTOM_LAYERS = 2;
const MAX_OUTER_LAYERS = 2;

/** Manual-strip chip that filters to the pieces currently in the build. */
const IN_FIT_CHIP = "OOTD";
const THIS_FIT_PULL_HINT = "Pull up for OOTD breakdown";

function categoryChipForItem(item: { category?: string | null }): string {
  const shelfKey = closetItemShelfKey(item);
  if (shelfKey === "other") return "All";
  return shelfLabelForCategoryId(shelfKey);
}

function getStyledAttachmentLabel(item: ClosetItem | BuilderItem): string {
  const core = (item.name || item.type || item.category || "piece").trim();
  const color = item.color?.trim();
  if (color && !core.toLowerCase().includes(color.toLowerCase())) {
    return `${color} ${core}`.trim();
  }
  return core;
}

function stripItemsForCategoryChip(
  chip: string,
  closetItems: ClosetItem[],
  builderItems: BuilderItem[],
): ClosetItem[] | BuilderItem[] {
  if (chip === IN_FIT_CHIP) {
    return [...builderItems].sort((a, b) => a.slot - b.slot);
  }
  const shelfId = shelfIdForCategoryChip(chip);
  const subset =
    shelfId === null
      ? closetItems
      : closetItems.filter((i) => closetItemShelfKey(i) === shelfId);
  return sortClosetItems(subset, "recent");
}
/** Gray strip placeholders when the fit is empty — same footprint as real tiles. */
const THIS_FIT_PLACEHOLDER_COUNT = 4;
const THIS_FIT_PLACEHOLDER_GAP = 10;

function ootdPlaceholderStripLayout(trackWidth: number) {
  const baseInset = MANUAL_STRIP_EDGE_INSET;
  const count = THIS_FIT_PLACEHOLDER_COUNT;
  const gap = THIS_FIT_PLACEHOLDER_GAP;
  if (trackWidth <= 0) {
    return {
      paddingLeft: baseInset,
      paddingRight: baseInset,
      gap,
      count,
      tileW: MANUAL_STRIP_TILE.w,
    };
  }

  const maxContentW =
    count * MANUAL_STRIP_TILE.w + gap * (count - 1);
  let tileW = MANUAL_STRIP_TILE.w;
  if (trackWidth < maxContentW + baseInset * 2) {
    const inner = Math.max(0, trackWidth - baseInset * 2);
    tileW = Math.max(0, (inner - gap * (count - 1)) / count);
  }

  const contentW = count * tileW + gap * (count - 1);
  const slack = Math.max(0, trackWidth - contentW);
  const paddingLeft = slack / 2;
  const paddingRight = slack / 2;

  return { paddingLeft, paddingRight, gap, count, tileW };
}

/**
 * Reliable garment classification for builder caps. Uses the closet's canonical
 * `category` shelf (same source as the closet tab + manual strip filtering) instead
 * of brittle keyword matching, so caps never silently leak on oddly-named items.
 */
type FitKind =
  | "top"
  | "bottom"
  | "full body"
  | "outerwear"
  | "shoes"
  | "bag"
  | "accessory"
  | "other";
const fitKindOf = (item: { category?: string | null }): FitKind =>
  closetItemShelfKey(item) as FitKind;
const isDressLike = (i: { category?: string | null }) =>
  fitKindOf(i) === "full body";
const isTopLike = (i: { category?: string | null }) => fitKindOf(i) === "top";
const isBottomLike = (i: { category?: string | null }) =>
  fitKindOf(i) === "bottom";
const isShoeItem = (i: { category?: string | null }) => fitKindOf(i) === "shoes";
const isOuterItem = (i: { category?: string | null }) =>
  fitKindOf(i) === "outerwear";
const isBagItem = (i: { category?: string | null }) => fitKindOf(i) === "bag";
const isAccessoryLike = (i: { category?: string | null }) => {
  const k = fitKindOf(i);
  return k === "accessory" || k === "other";
};

type FitsSheetSnapExpandMode = "full" | "autoCapped";

type AutoGenSession = {
  occasionPhrase: string;
  anchorItemIds: string[];
  colorHarmony: boolean;
  extraUserText?: string;
  builderPrompt: string;
  builderOccasionKey: string;
};

function anchorsForCategorySwap(
  items: BuilderItem[],
  categoryChip: string,
  sessionAnchors: string[],
): string[] {
  const shelfId = shelfIdForCategoryChip(categoryChip);
  if (!shelfId) {
    return [...new Set([...items.map((i) => i.id), ...sessionAnchors])];
  }
  const loosen = new Set(
    items.filter((it) => closetItemShelfKey(it) === shelfId).map((it) => it.id),
  );
  const locked = items.filter((it) => !loosen.has(it.id)).map((it) => it.id);
  return [...new Set([...locked, ...sessionAnchors])];
}

const SESSION_SWAP_CATEGORY_CHIPS = [
  "Tops",
  "Bottoms",
  "Shoes",
  "Outerwear",
  "Bags",
] as const;

/** Expand target height for the Fits sheet (JS thread — safe before React commits toggles like auto builder). */
function computeSheetExpandMaxPx(
  stageHeight: number,
  expandMode: FitsSheetSnapExpandMode,
  fallbackHeight: number,
): number {
  const baseMax =
    stageHeight > 0
      ? stageHeight - FITS_CLOSET_UNDER_HEADER_GAP
      : fallbackHeight * 0.85;
  if (expandMode === "autoCapped" && stageHeight > 0) {
    return Math.min(
      baseMax,
      Math.round(stageHeight * AUTO_BUILDER_SHEET_MAX_RATIO),
    );
  }
  return baseMax;
}

/** Sheet height animations — spring for expand feels smoother; ease-out for collapse. */
const SHEET_EASE = Easing.out(Easing.cubic);
const SHEET_SPRING_EXPAND = {
  damping: 22,
  stiffness: 200,
  mass: 0.88,
  overshootClamping: true,
};
const sheetTimingCollapse = { duration: 340, easing: SHEET_EASE };
/** Get Styled dismiss — sheet slides down; panel fades as it nears the strip. */
const sheetTimingStyleMeDismiss = { duration: 260, easing: SHEET_EASE };
const sheetTimingSnap = { duration: 300, easing: SHEET_EASE };
const TRY_ON_SPRING = {
  damping: 24,
  stiffness: 220,
  mass: 0.9,
  overshootClamping: true,
};
const TRY_ON_TIMING = {
  duration: 300,
  easing: Easing.out(Easing.cubic),
};
const TRY_ON_TRANSITION_CONFIG = TRY_ON_TIMING; // Keep for legacy usage if any
const TRY_ON_DISMISS_TRANSLATE_PX = 80;

/** Bottom chrome visibility while Fits tab crossfades (Build ↔ Library). */
function fitsTabChromeMotion(blend: number) {
  "worklet";
  const fade = interpolate(
    blend,
    [0, 0.1, 0.3],
    [1, 0.5, 0],
    Extrapolation.CLAMP,
  );
  const lift = interpolate(blend, [0, 0.3], [0, 20], Extrapolation.CLAMP);
  const scale = interpolate(blend, [0, 0.3], [1, 0.94], Extrapolation.CLAMP);
  return { fade, lift, scale };
}

function parseOutfitDataUri(
  dataUri: string,
): { buffer: ArrayBuffer; contentType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUri.trim());
  if (!m) return null;
  const contentType = m[1] ?? "image/png";
  const b64 = m[2] ?? "";
  const binary = globalThis.atob?.(b64);
  if (!binary) return null;
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return { buffer: bytes.buffer, contentType };
}

/** RN-safe base64 (chunked — avoids huge `apply` payloads). Hermes choke on Blob+FileReader is common post-layout. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    binary += String.fromCharCode(...bytes.subarray(i, end));
  }
  const encoder = globalThis.btoa;
  if (!encoder) throw new Error("btoa unavailable");
  return encoder(binary);
}

export type BuilderPanelHandle = {
  /** Collapse the full-screen closet drawer back to its compact strip. */
  collapseCloset: () => void;
  /** Removes every piece from the outfit, clears anchors, and resets try-on / conflict UI. */
  clearOutfit: () => void;
  /** Reverts the last manual action or canvas mutation. */
  undoOutfit: () => void;
  /** Re-applies the last undone change. */
  redoOutfit: () => void;
  /** Remix an entire outfit by loading its items and metadata. */
  remixFit: (
    itemIds: string[],
    name?: string,
    occasion?: string,
    outfitId?: string,
  ) => void;
  /** Edit a saved try-on exactly like tapping Edit pieces on a fresh render. */
  editSavedTryOn: (
    itemIds: string[],
    heroUri: string,
    name?: string,
    occasion?: string,
    outfitId?: string,
  ) => void;
  /** Re-open a try-on / Get Styled generation in the builder. */
  loadGeneratedLook: (
    itemIds: string[],
    preview?: {
      tryOnSourceUri?: string | null;
      flatImageUri?: string | null;
      sourceId?: string | null;
    },
  ) => void;
  /** Leave Get Styled (config, generating, or results) and return to manual build. */
  exitStyleMeToManualBuild: () => void;
  /** Leave try-on picker and return to the closet strip. */
  closeTryOnPicker: () => void;
  /** Back from try-on session — prompts to save when a render exists. */
  exitTryOnSession: () => void;
  /** Leave try-on without save prompt (e.g. after save + open Library). */
  exitTryOnSessionQuiet: () => void;
};

interface Props {
  closetItems: ClosetItem[];
  onSavedFit: () => void | Promise<void>;
  /** Immediate local patch after updating an existing look (before refetch). */
  onFitUpdated?: (fitId: string, patch: Partial<SavedFit>) => void;
  /** Switch to Library and open the saved look. */
  onViewInLibrary?: (outfitId: string) => void | Promise<void>;
  /** Switch to Plan, focused on the given day. */
  onViewInPlan?: (isoDay: string) => void | Promise<void>;
  userId: string | undefined;
  /** Opens full item detail (same as Closet tab tap). */
  onStripItemLongPress?: (item: ClosetItem) => void;
  /** Fires when the manual closet sheet is expanded or collapsed (for tab bar layering). */
  onManualExpandedChange?: (expanded: boolean) => void;
  /** Written on the UI thread from sheet height — smooth nav chrome without JS churn. */
  fitsChromeExpandSv?: SharedValue<number>;
  /** 0 = Build tab, 1 = Library — hides strip + action pill during tab slide. */
  fitsTabBlendSv?: SharedValue<number>;
  /** Springs in after Build pane settles (staggered reveal). */
  fitsChromeRevealSv?: SharedValue<number>;
  /** Seed the board + open Get Styled with this closet item ID as an anchor. */
  initialAnchorId?: string;
  /** Per-navigation nonce so re-tapping "Fit" on the SAME item re-triggers
   * the anchor seed (otherwise the seed-once guard blocks the repeat). */
  initialAnchorNonce?: string;
  /** Remix an entire outfit with these item IDs. */
  remixItemIds?: string;
  /** When set, save updates this outfit instead of creating a new one. */
  editOutfitId?: string;
  /** True when `editOutfitId` points at a draft the user never saved to their
   * library (Auto OOTD landing) — Save still updates it in place, but the
   * "Update saved look / Save as new" UI fork must not show for it. */
  editTargetUnsaved?: boolean;
  /** Initial metadata for the outfit. */
  initialName?: string;
  initialOccasion?: string;
  /** yyyy-mm-dd to prefill the planned date when saving. */
  plannedDateIso?: string;
  /** yyyy-mm-dd to mark the outfit worn on save (past/today logging from Home). */
  wornOnIso?: string;
  /** Reserve canvas space under Fits screen overlays (Library / Clear). */
  fitsCanvasInset?: { left?: number; top?: number };
  /** Fires when Get Styled chrome replaces Build · Library. */
  onStyleMeModeChange?: (active: boolean) => void;
  /** Fires when Try On chrome replaces Build · Library. */
  onTryOnModeChange?: (active: boolean) => void;
  /** Lets the Fits shell block navigation while a try-on is rendering. */
  onTryOnRenderingChange?: (active: boolean) => void;
  /** Fires when undo/redo availability changes (for canvas tool buttons). */
  onCanvasHistoryChange?: (state: {
    canUndo: boolean;
    canRedo: boolean;
  }) => void;
  /** Fires after the user chooses a Get Styled look to build (refreshes Library Recent). */
  onStyleMeLookChosen?: () => void;
  /**
   * HTTPS URL of the latest try-on hero (e.g. automation). After remix seed, shows
   * the same swipe compare as in-app try-on: try-on vs collage.
   */
  landingHeroTryOnUri?: string;
  /** When the landed hero is a mannequin/flat-backdrop render, the backdrop
   * hex to chroma-key out — deterministic, avoids person-segmentation punching
   * holes through the synthetic figure. Omitted for real-selfie try-on heroes
   * (those keep person segmentation). */
  landingHeroChromaKeyHex?: string;
  wardrobes?: Wardrobe[];
  activeWardrobeId?: string | null;
  onActiveWardrobeChange?: (wardrobeId: string | null) => void;
  wardrobeMembershipMaps?: WardrobeMembershipMaps;
  onManageWardrobes?: () => void;
}

// ── Get Styled draft: external store ─────────────────────────────────────────
// The draft lives OUTSIDE BuilderPanel's React state on purpose. Typing on the
// custom keyboard used to call setState on this 7000-line component per key,
// re-rendering the whole tree each keystroke (plus the placeholder typewriter
// + caret blink were BuilderPanel state too, firing setState ~100x/sec). That
// was the lag. Now keystrokes mutate this module store and only the tiny
// subscriber component below re-renders — BuilderPanel stays still.
let getStyledDraftValue = "";
const getStyledDraftSubs = new Set<() => void>();
function setGetStyledDraft(next: string) {
  if (next === getStyledDraftValue) return;
  getStyledDraftValue = next;
  getStyledDraftSubs.forEach((fn) => fn());
}
function editGetStyledDraft(fn: (prev: string) => string) {
  setGetStyledDraft(fn(getStyledDraftValue));
}
function useGetStyledDraft() {
  return useSyncExternalStore(
    (cb) => {
      getStyledDraftSubs.add(cb);
      return () => getStyledDraftSubs.delete(cb);
    },
    () => getStyledDraftValue,
  );
}

/** Crisp keyboard tap — matches the iOS/ChatGPT feel (light impact, not the
 * softer selection tick) plus a short click tone that respects the ringer/
 * silent switch. Fire-and-forget so neither ever blocks the keypress. */
function keyTapHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  playKeyClickSound();
}

/**
 * Voice input for the composer — real dictation via expo-speech-recognition,
 * not a placeholder. Appends the recognized transcript to whatever was
 * already in the draft when recognition started (so tapping mic mid-sentence
 * doesn't clobber typed text). Self-contained: owns its own listening state,
 * writes straight to the external draft store like the keyboard does.
 */
function GetStyledMicButton() {
  const [listening, setListening] = useState(false);
  const draftAnchorRef = useRef("");

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    const anchor = draftAnchorRef.current;
    setGetStyledDraft(anchor + (anchor && transcript ? " " : "") + transcript);
  });
  useSpeechRecognitionEvent("error", (event) => {
    console.warn("[GetStyledMicButton] speech recognition error", event.error, event.message);
  });

  const toggle = async () => {
    Haptics.selectionAsync();
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    if (!isSpeechRecognitionAvailable) {
      Alert.alert(
        "Voice input unavailable",
        "Voice dictation isn't available on this build yet. You can still type your look.",
      );
      return;
    }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Microphone access needed",
        "Enable microphone (and speech recognition) access for myOOTD to describe your look by voice.",
        perm.canAskAgain
          ? [{ text: "OK" }]
          : [
              { text: "Not now", style: "cancel" },
              { text: "Open Settings", onPress: () => void Linking.openSettings() },
            ],
      );
      return;
    }
    draftAnchorRef.current = getStyledDraftValue;
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
    });
  };

  return (
    <TouchableOpacity
      style={[
        s.getStyledComposerIconGhost,
        listening && s.getStyledComposerMicActive,
      ]}
      activeOpacity={0.7}
      onPress={() => void toggle()}
      accessibilityRole="button"
      accessibilityLabel={listening ? "Stop dictation" : "Describe your look by voice"}
    >
      <Mic
        size={16}
        color={listening ? "#fff" : Colors.text}
        strokeWidth={2}
      />
    </TouchableOpacity>
  );
}

function GetStyledAttachButton({
  active,
  onPress,
}: {
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        s.getStyledComposerIconBtn,
        s.getStyledComposerAttachBtn,
        active && s.getStyledComposerIconBtnActive,
      ]}
      activeOpacity={0.72}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Attach closet item to prompt"
    >
      <Shirt
        size={16}
        color={active ? Colors.white : Colors.text}
        strokeWidth={2}
      />
      <Text
        style={[
          s.getStyledComposerAttachText,
          active && s.getStyledComposerAttachTextActive,
        ]}
        numberOfLines={1}
      >
        Attach Item(s)
      </Text>
    </TouchableOpacity>
  );
}

function GetStyledWeatherButton({
  enabled,
  onPress,
}: {
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        s.getStyledComposerIconBtn,
        enabled && s.getStyledComposerIconBtnActive,
      ]}
      activeOpacity={0.72}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Build fits based on current weather ${
        enabled ? "on" : "off"
      }`}
    >
      <CloudSun
        size={16}
        color={enabled ? Colors.white : Colors.text}
        strokeWidth={2}
      />
    </TouchableOpacity>
  );
}

/**
 * Real editable composer input — a native TextInput, so it gets proper
 * typing, auto-capitalization, autocorrect, cursor/tap-to-select and text
 * selection for free (the custom key grid never could). Reads/writes the
 * shared draft store so the mic can also feed it. The animated "typewriter"
 * example placeholder is retained (only shows while empty).
 */
function GetStyledPromptInput({
  attachMode,
  onExitAttachMode,
}: {
  attachMode: boolean;
  onExitAttachMode?: () => void;
}) {
  const draft = useGetStyledDraft();
  const [placeholder, setPlaceholder] = useState("");
  const [caretOn, setCaretOn] = useState(true);
  const idxRef = useRef(0);
  const lenRef = useRef(0);
  const deletingRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const leaveAttachForTyping = useCallback(() => {
    if (!attachMode) return;
    onExitAttachMode?.();
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [attachMode, onExitAttachMode]);

  const [caretX, setCaretX] = useState(0);
  // Matches the placeholder-generation effect's own emptiness check below
  // (trim, not raw length) so both agree on when "real" content starts —
  // otherwise a whitespace-only draft could show the fake caret AND the
  // real native cursor at the same time.
  const showFakeCaret = draft.trim().length === 0;

  // The real native cursor sits fixed at position 0 while the field is
  // empty — it doesn't trail the animated placeholder text as it "types
  // itself out", and a text glyph ("|") is much thinner/shorter than an
  // actual cursor bar. Render a real blinking View instead, positioned at
  // the measured width of the placeholder text so far — this is the ONLY
  // cursor visible while empty (the native one is hidden via caretHidden
  // below); the moment there's real draft text, this disappears and the
  // real native cursor takes over.
  useEffect(() => {
    if (!showFakeCaret) {
      setCaretOn(false);
      return;
    }
    setCaretOn(true);
    const t = setInterval(() => setCaretOn((on) => !on), 480);
    return () => clearInterval(t);
  }, [showFakeCaret]);

  // Pin/attach mode shows a closet picker down in the strip — which the
  // native keyboard would otherwise cover. Dismiss the keyboard while
  // attaching so the picker is visible; refocus (keyboard back) when done.
  useEffect(() => {
    if (attachMode) {
      inputRef.current?.blur();
      return;
    }
    // A single 60ms attempt reliably lost the race when this mounts as part
    // of a heavier transition (e.g. landing here from closet "Fit" — canvas
    // reset + haptics + sheet expand + this fade-in all firing together):
    // the native view can accept a .focus() call before the surrounding
    // sheet/keyboard-lift animation has settled, and the OS silently drops
    // it. Retry a few times over ~500ms — a no-op once already focused, so
    // it's harmless on the fast path where the first attempt just works.
    const delays = [60, 180, 350, 550];
    const timers = delays.map((ms) =>
      setTimeout(() => inputRef.current?.focus(), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [attachMode]);

  useEffect(() => {
    if (draft.trim().length > 0) {
      setPlaceholder("");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const full =
        GET_STYLED_PLACEHOLDER_SEQUENCE[
          idxRef.current % GET_STYLED_PLACEHOLDER_SEQUENCE.length
        ];
      if (!deletingRef.current) {
        lenRef.current = Math.min(
          full.length,
          lenRef.current + 2 + Math.round(Math.random() * 2),
        );
        setPlaceholder(full.slice(0, lenRef.current));
        if (lenRef.current >= full.length) {
          deletingRef.current = true;
          timer = setTimeout(tick, 900);
          return;
        }
        timer = setTimeout(tick, 34 + Math.round(Math.random() * 26));
        return;
      }
      lenRef.current = Math.max(
        0,
        lenRef.current - 5 - Math.round(Math.random() * 5),
      );
      setPlaceholder(full.slice(0, lenRef.current));
      if (lenRef.current <= 0) {
        deletingRef.current = false;
        idxRef.current =
          (idxRef.current + 1) % GET_STYLED_PLACEHOLDER_SEQUENCE.length;
        setPlaceholder("");
        timer = setTimeout(tick, 260);
        return;
      }
      timer = setTimeout(tick, 18 + Math.round(Math.random() * 12));
    };
    timer = setTimeout(tick, lenRef.current > 0 ? 40 : 60);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [draft]);

  return (
    <View style={s.getStyledComposerInputWrap}>
      {showFakeCaret ? (
        <>
          <Text
            style={[
              s.getStyledComposerText,
              s.getStyledComposerPlaceholder,
              s.getStyledComposerPlaceholderOverlay,
            ]}
            pointerEvents="none"
          >
            {placeholder}
          </Text>
          {/* Invisible — exists only to measure where the visible placeholder
              text ends, so the real cursor bar below can be positioned right
              after it. */}
          <Text
            style={[s.getStyledComposerText, s.getStyledComposerCaretMeasure]}
            onLayout={(e) => setCaretX(e.nativeEvent.layout.width)}
          >
            {placeholder}
          </Text>
        </>
      ) : null}
      <TextInput
        ref={inputRef}
        value={draft}
        onChangeText={setGetStyledDraft}
        onPressIn={leaveAttachForTyping}
        onFocus={leaveAttachForTyping}
        autoFocus
        multiline
        autoCapitalize="sentences"
        // Bare keyboard: autoCorrect + spellCheck off removes the QuickType
        // suggestion/autocorrect strip above the keys on iOS. autoCapitalize
        // stays — it's independent of these and just capitalizes sentence
        // starts (no UI bar). autoComplete/importantForAutofill quiet
        // Android's suggestion row without forcing the monospace font that
        // keyboardType="visible-password" would. (The emoji/globe key is a
        // system keyboard element and can't be removed by app code.)
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        keyboardAppearance="light"
        // Hide the real native cursor while showing the animated example —
        // it was showing at position 0 THE WHOLE TIME behind/alongside the
        // fake one before. It only appears once there's real draft text.
        caretHidden={showFakeCaret}
        placeholder=""
        placeholderTextColor="rgba(95,82,71,0.42)"
        selectionColor={Colors.accent}
        textAlignVertical="top"
        style={[s.getStyledComposerText, s.getStyledComposerInput]}
      />
      {showFakeCaret && caretOn ? (
        <View
          style={[s.getStyledComposerCaret, { left: caretX }]}
          pointerEvents="none"
        />
      ) : null}
    </View>
  );
}

// EXPERIMENT: custom on-screen keyboard for "Get styled" — replaces the item
// carousel in place (not the native OS keyboard sliding up from off-screen).
// Sized to fit the existing fixed strip height (STRIP_BODY_FIXED_H).
const GET_STYLED_KB_ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
] as const;
const GET_STYLED_SYMBOL_ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""],
  [".", ",", "?", "!", "'", "#", "%"],
] as const;

/**
 * One keyboard key. Uses RAW touch events (onTouchStart), NOT Pressable:
 * Pressable rides RN's responder system, which grants only ONE responder at
 * a time — during fast "rolling" typing (next finger lands before the last
 * lifts) the second press never became responder and was silently dropped.
 * Raw touch events fire per-view per-finger with no exclusivity, so every
 * landing finger registers. The outer cell carries the flex weight plus
 * 2px padding so the visual gutters between keys are still tappable
 * (they were dead zones before).
 */
function KbKey({
  flex = 1,
  onPress,
  active = false,
  visualStyle,
  children,
}: {
  flex?: number;
  onPress: () => void;
  active?: boolean;
  visualStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <View
      style={[s.getStyledKbCell, { flex }]}
      onTouchStart={() => {
        setPressed(true);
        onPress();
      }}
      onTouchEnd={() => setPressed(false)}
      onTouchCancel={() => setPressed(false)}
    >
      <View
        style={[
          s.getStyledKbKey,
          visualStyle,
          active && s.getStyledKbUtilityKeyActive,
          pressed && s.getStyledKbKeyPressed,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const GetStyledKeyboard = memo(function GetStyledKeyboard({
  onDone,
}: {
  onDone: () => void;
}) {
  const [shiftMode, setShiftMode] = useState<"off" | "shift" | "caps">(
    "shift",
  );
  const [keyboardMode, setKeyboardMode] = useState<"letters" | "symbols">(
    "letters",
  );
  const shifted = shiftMode !== "off";
  const pressKey = (ch: string) => {
    keyTapHaptic();
    const nextChar =
      keyboardMode === "letters" && shifted ? ch.toUpperCase() : ch;
    editGetStyledDraft((prev) => `${prev}${nextChar}`);
    if (keyboardMode === "letters" && shiftMode === "shift") {
      setShiftMode("off");
    }
    if (ch === "." || ch === "?" || ch === "!") setShiftMode("shift");
  };
  const pressShift = () => {
    keyTapHaptic();
    setShiftMode((mode) =>
      mode === "off" ? "shift" : mode === "shift" ? "caps" : "off",
    );
  };
  const backspace = () => {
    keyTapHaptic();
    // Read the live store value (no subscription/re-render needed here).
    if (getStyledDraftValue.length <= 1) setShiftMode("shift");
    editGetStyledDraft((prev) => prev.slice(0, -1));
  };

  const renderLetterKey = (ch: string) => (
    <KbKey key={ch} onPress={() => pressKey(ch)}>
      <Text style={s.getStyledKbKeyText}>
        {shifted ? ch.toUpperCase() : ch}
      </Text>
    </KbKey>
  );

  const renderSymbolKey = (ch: string) => (
    <KbKey key={ch} onPress={() => pressKey(ch)}>
      <Text style={s.getStyledKbKeyText}>{ch}</Text>
    </KbKey>
  );

  return (
    <View style={s.getStyledKb}>
      {keyboardMode === "letters" ? (
        <>
          <View style={s.getStyledKbRow}>
            {GET_STYLED_KB_ROWS[0].map(renderLetterKey)}
          </View>
          <View style={s.getStyledKbRow}>
            <View style={s.getStyledKbRowInset} />
            {GET_STYLED_KB_ROWS[1].map(renderLetterKey)}
            <View style={s.getStyledKbRowInset} />
          </View>
          <View style={s.getStyledKbRow}>
            <KbKey flex={1.35} onPress={pressShift} active={shifted}>
              <ChevronUp
                size={16}
                color={shifted ? Colors.white : Colors.text}
                strokeWidth={2.4}
              />
            </KbKey>
            {GET_STYLED_KB_ROWS[2].map(renderLetterKey)}
            <KbKey flex={1.35} onPress={backspace}>
              <Delete size={16} color={Colors.text} strokeWidth={2} />
            </KbKey>
          </View>
        </>
      ) : (
        <>
          {GET_STYLED_SYMBOL_ROWS.map((row, i) => (
            <View key={`symbol-${i}`} style={s.getStyledKbRow}>
              {i === 2 ? <View style={s.getStyledKbRowInset} /> : null}
              {row.map(renderSymbolKey)}
              {i === 2 ? (
                <KbKey flex={1.35} onPress={backspace}>
                  <Delete size={16} color={Colors.text} strokeWidth={2} />
                </KbKey>
              ) : null}
            </View>
          ))}
        </>
      )}
      <View style={s.getStyledKbRow}>
        <KbKey
          flex={1.18}
          onPress={() => {
            keyTapHaptic();
            setKeyboardMode((mode) =>
              mode === "letters" ? "symbols" : "letters",
            );
          }}
        >
          <Text style={s.getStyledKbKeyText}>
            {keyboardMode === "letters" ? "123" : "ABC"}
          </Text>
        </KbKey>
        {keyboardMode === "letters" ? (
          <KbKey flex={0.82} onPress={() => pressKey(",")}>
            <Text style={s.getStyledKbKeyText}>,</Text>
          </KbKey>
        ) : null}
        <KbKey flex={4} onPress={() => pressKey(" ")}>
          <Text style={s.getStyledKbKeyText} numberOfLines={1}>
            space
          </Text>
        </KbKey>
        {keyboardMode === "letters" ? (
          <KbKey flex={0.82} onPress={() => pressKey(".")}>
            <Text style={s.getStyledKbKeyText}>.</Text>
          </KbKey>
        ) : null}
        <KbKey flex={1.4} onPress={onDone} visualStyle={s.getStyledKbDone}>
          <Text style={s.getStyledKbDoneText}>Done</Text>
        </KbKey>
      </View>
    </View>
  );
});

const BuilderPanelComponent = (props: Props, ref: any) => {
  const {
    closetItems,
    onSavedFit,
    onFitUpdated,
    onViewInLibrary,
    onViewInPlan,
    userId,
    onStripItemLongPress,
    onManualExpandedChange,
    fitsChromeExpandSv,
    initialAnchorId,
    initialAnchorNonce,
    remixItemIds,
    editOutfitId,
    editTargetUnsaved,
    initialName,
    initialOccasion,
    plannedDateIso,
    wornOnIso,
    fitsCanvasInset,
    landingHeroTryOnUri,
    landingHeroChromaKeyHex,
    onStyleMeModeChange,
    onTryOnModeChange,
    onTryOnRenderingChange,
    onCanvasHistoryChange,
    onStyleMeLookChosen,
    fitsTabBlendSv,
    fitsChromeRevealSv,
    wardrobes = [],
    activeWardrobeId = null,
    onActiveWardrobeChange,
    wardrobeMembershipMaps = { byWardrobe: {}, byItem: {} },
    onManageWardrobes,
  } = props;

  const { user } = useUser();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const tabBarH = useBottomTabBarHeight();
  /** Live target so rotation and iPad multitasking never leave the composer at
   * a position calculated for an old viewport. */
  const getStyledComposerTargetBottom = Math.round(
    screenHeight * (Platform.OS === "ios" ? 0.372 : 0.342),
  );
  /** Tab bar height without extra gap — used to extend the sheet when the bar is hidden. */
  const tabBarBlockHeight =
    tabBarH > 0 ? tabBarH : 52 + Math.max(insets.bottom, 10);
  const bottomChromePad =
    tabBarH > 0 ? tabBarH : 52 + Math.max(insets.bottom, 10);

  /**
   * Auto builder sits in an absolute-fill overlay; the Generate CTA can still sit where the
   * frosted tab bar samples (~half to full tab-band). Sheet already reserves `bottomChromePad`;
   * this nudges overlay content up (~¾ tab block + constant, capped — not a duplicate full pad).
   */
  const autoBuilderOverlayNavFudgePx = Math.round(
    Math.min(82, Math.max(54, tabBarBlockHeight * 0.75 + 16)),
  );

  /** Floating island (Generate outfits / Try on / Save) clearance above collage. */
  const canvasIslandReserve = 68;

  /** Replace closet strip with model carousel until dismissed or generation completes. */
  const [tryOnPickerActive, setTryOnPickerActive] = useState(false);
  /** Full try-on experience: picker → render → result (Back pill stays until exit). */
  const [tryOnSessionActive, setTryOnSessionActive] = useState(false);
  const [tryOnExitModalVisible, setTryOnExitModalVisible] = useState(false);
  /** Sparse outfit (accessories-only) — in-app confirm instead of system Alert. */
  const [tryOnSparseModalVisible, setTryOnSparseModalVisible] = useState(false);
  const [tryOnSelfieUrls, setTryOnSelfieUrls] = useState<string[]>([]);
  const [tryOnTarget, setTryOnTarget] = useState<TryOnTarget>("mannequin");
  const [selfieToDelete, setSelfieToDelete] = useState<string | null>(null);
  /** True only between picker-return and local-preview-shown — covers the
   * resize/normalize wait with a loading tile in the selfie row. */
  const [uploadingSelfie, setUploadingSelfie] = useState(false);

  const [builderItems, setBuilderItems] = useState<BuilderItem[]>([]);
  const [historyStack, setHistoryStack] = useState<BuilderItem[][]>([]);
  const [redoStack, setRedoStack] = useState<BuilderItem[][]>([]);
  const [sessionLooks, setSessionLooks] = useState<BuilderItem[][]>([]);

  const applyBuilderItemsFromHistory = useCallback((items: BuilderItem[]) => {
    setBuilderItems(items);
    setManualReadyToSave(items.length > 0);
  }, []);

  const pushHistory = useCallback((current: BuilderItem[]) => {
    setRedoStack([]);
    setHistoryStack((prev) => {
      if (
        prev.length > 0 &&
        JSON.stringify(prev[prev.length - 1]) === JSON.stringify(current)
      ) {
        return prev;
      }
      return [...prev, current];
    });
  }, []);

  const handleUndo = useCallback(() => {
    setHistoryStack((prevStack) => {
      if (prevStack.length === 0) return prevStack;
      Haptics.selectionAsync();
      const nextStack = [...prevStack];
      const previousState = nextStack.pop();
      if (previousState !== undefined) {
        const current = builderItemsRef.current;
        setRedoStack((prevRedo) => [...prevRedo, current]);
        applyBuilderItemsFromHistory(previousState);
      }
      return nextStack;
    });
  }, [applyBuilderItemsFromHistory]);

  const handleRedo = useCallback(() => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      Haptics.selectionAsync();
      const nextRedo = [...prevRedo];
      const nextState = nextRedo.pop();
      if (nextState !== undefined) {
        const current = builderItemsRef.current;
        setHistoryStack((prevHistory) => [...prevHistory, current]);
        applyBuilderItemsFromHistory(nextState);
      }
      return nextRedo;
    });
  }, [applyBuilderItemsFromHistory]);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [selectedOccasionId, setSelectedOccasionId] = useState<string | null>(
    null,
  );
  const [generationPhase, setGenerationPhase] =
    useState<GenerationPhase>("idle");
  const tryOnRendering = generationPhase === "rendering";
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** Try-on hero saved — drives in-pill Saved / Mark worn UI (keeps look on canvas). */
  const [savedToLibrary, setSavedToLibrary] = useState<{
    outfitId: string;
    itemIds: string[];
  } | null>(null);
  /** Existing outfit row being edited — save updates in place. */
  const [editingOutfitId, setEditingOutfitId] = useState<string | null>(null);
  /** True only when `editingOutfitId` points at a look the user has actually
   * saved to their library before (Library "Edit" / plan "Edit in studio").
   * An Auto OOTD landing also sets editingOutfitId so Save updates its row in
   * place instead of creating a duplicate. This flag mirrors that row's
   * durable saved_to_library state and is restored on every Home → Fits open. */
  const [editTargetWasUnsaved, setEditTargetWasUnsaved] = useState(false);
  /** Piece IDs when edit/remix started — drives reliable "(edited)" stale marking. */
  const editBaselineItemIdsRef = useRef<string[] | null>(null);
  /** Invalidates in-flight try-on renders / landed-hero cutouts. Bumped by
   * resetBuilderState and at the start of every new render, so a generation
   * that finishes after the user landed a different look (e.g. pressed "Open
   * in Fits" on Home mid-render) can never clobber the new session's state. */
  const tryOnGenTokenRef = useRef(0);
  // Only session state decides the edit target. The `editOutfitId` route param
  // sticks around after resetBuilderState/clearOutfit (expo-router params never
  // clear), and falling back to it made a brand-new fit built after a reset ask
  // "update saved look?". The seed effect copies it into editingOutfitId.
  const activeEditId = editingOutfitId;
  /** Gates the "Update saved look / Save as new" UI fork — see editTargetWasUnsaved. */
  const editingPreviouslySavedLook = !!activeEditId && !editTargetWasUnsaved;
  /** In-pill confirmation (e.g. check + "Saved" + View in library) on the action island. */
  const [pillNotice, setPillNotice] = useState<{
    msg: string;
    variant: "hint" | "success" | "error";
    actionLabel?: string;
  } | null>(null);
  const pillNoticeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pillNoticeActionRef = useRef<(() => void | Promise<void>) | null>(
    null,
  );
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [plannedDate, setPlannedDate] = useState<Date | null>(null);
  useEffect(() => {
    const iso = (plannedDateIso ?? wornOnIso)?.trim();
    if (!iso) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return;
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      12,
      0,
      0,
      0,
    );
    if (!Number.isNaN(d.getTime())) setPlannedDate(d);
  }, [plannedDateIso, wornOnIso]);
  // Arriving here from a Plan day (plannedDateIso/wornOnIso) used to be
  // completely invisible — the date silently rode along and only surfaced
  // once you tapped Save, so this screen looked identical to a plain manual
  // build with no sense you were attaching to a day at all. This banner
  // makes that context visible, and lets you back out of it (build a normal
  // untethered look instead) without leaving the screen.
  const [dayContextDismissed, setDayContextDismissed] = useState(false);
  useEffect(() => {
    setDayContextDismissed(false);
  }, [plannedDateIso, wornOnIso]);
  const isLoggingPastWear = !!(
    wornOnIso?.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(wornOnIso.trim()) &&
    !isoDayIsStrictlyFuture(wornOnIso.trim())
  );
  const dayContextBanner =
    !dayContextDismissed && plannedDate
      ? {
          label: isLoggingPastWear ? "Logging for" : "Planning for",
          dateText: plannedDate.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
        }
      : null;
  /** Day this save will land on, so the post-save toast can offer "View on
   * [day]" instead of the generic library toast — closes the loop so a
   * build/try-on you attached to a day actually shows you it landed there. */
  const dayContextTargetIso = dayContextBanner
    ? (plannedDateIso ?? wornOnIso)?.trim() || null
    : null;
  const [fitName, setFitName] = useState("");
  const [manualCategory, setManualCategory] = useState("All");
  const [thisFitPulseToken, setThisFitPulseToken] = useState(0);
  const manualCategoryRef = useRef(manualCategory);
  manualCategoryRef.current = manualCategory;
  const [manualSearch, setManualSearch] = useState("");
  const [closetToolbarExpanded, setClosetToolbarExpanded] = useState(false);
  const [expandedWardrobesVisible, setExpandedWardrobesVisible] = useState(false);
  const [manualExpanded, setManualExpanded] = useState(false);
  /** When set, expanded closet opens ClosetCategoryBrowse for this shelf id. */
  const [closetBrowseCategory, setClosetBrowseCategory] = useState<
    string | null
  >(null);
  const manualStripRef = useRef<FlatList<ClosetItem | BuilderItem>>(null);
  const stripFocusRequestRef = useRef<{ itemId: string; chip: string } | null>(
    null,
  );
  /** Piece being replaced when user taps Swap in fit breakdown, then picks from closet. */
  const pendingSwapItemIdRef = useRef<string | null>(null);
  /** For snapping island visible immediately when dismissing try-on (avoid slow fade-in). */
  const tryOnPickerWasActiveRef = useRef(false);
  const [heroImageUri, setHeroImageUri] = useState<string | null>(null);
  const outfitCanvasRef = useRef<OutfitCanvasHandle | null>(null);
  const exportViewRef = useRef<View>(null);
  const fitShareHeroDecodedRef = useRef<(() => void) | null>(null);
  const preparedExportKeyRef = useRef<string | null>(null);
  const exportShareItems = useMemo(
    () =>
      builderItems.map((item) => ({
        id: item.id,
        name: item.name,
        color: item.color,
        imageUri: garmentImageUrl(item),
      })),
    [builderItems],
  );
  const exportShareKey = useMemo(
    () =>
      [
        heroImageUri ?? "",
        ...exportShareItems.map((item) => `${item.id}:${item.imageUri ?? ""}`),
      ].join("|"),
    [exportShareItems, heroImageUri],
  );
  const onFitShareHeroDecoded = useCallback(() => {
    preparedExportKeyRef.current = exportShareKey;
    fitShareHeroDecodedRef.current?.();
  }, [exportShareKey]);
  /** Editing the pieces of a finished try-on without discarding the render. */
  const [editingTryOnLook, setEditingTryOnLook] = useState(false);
  const tryOnResultViewLocked =
    tryOnSessionActive && !!heroImageUri && !editingTryOnLook;
  const editingWithFreshTryOn = !!(
    activeEditId && tryOnSessionActive && heroImageUri
  );
  const persistLookVerb = "Save";
  const persistLookDone =
    editingWithFreshTryOn || !editingPreviouslySavedLook ? "Saved" : "Updated";
  const pausedHeroRef = useRef<string | null>(null);
  const pausedBuilderItemsRef = useRef<BuilderItem[] | null>(null);
  const [layoutVariant, setLayoutVariant] = useState(0);
  /** "Get styled" swaps the item carousel for a text prompt — this is the
   * only Style Me entry point now. The old Auto Outfit Builder config sheet
   * (openAutoBuilder / openAutoBuilderForEdit) was removed; nothing calls
   * setAutoBuilderSheetActive(true) anymore, so that legacy slide-up never
   * opens (its render is now unreachable dead code). */
  const [getStyledPromptMode, setGetStyledPromptMode] = useState(false);
  const [getStyledAttachMode, setGetStyledAttachMode] = useState(false);
  const [getStyledUseWeather, setGetStyledUseWeather] = useState(true);
  const [getStyledWeatherToast, setGetStyledWeatherToast] = useState<
    string | null
  >(null);
  const getStyledWeatherToastTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  /** UI-thread mirror of getStyledPromptMode — gates the keyboard-lift in
   * islandAnimatedStyle so only composer mode rides the keyboard. */
  const getStyledPromptModeSv = useSharedValue(false);
  const getStyledAttachModeSv = useSharedValue(false);
  const getStyledKeyboardGuardSv = useSharedValue(0);
  /** Time-of-day greeting + first name for the Get Styled canvas empty state. */
  const getStyledGreetingTitle = useMemo(() => {
    const h = new Date().getHours();
    const partOfDay =
      h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const name = user?.firstName?.trim();
    return name
      ? `Good ${partOfDay}, ${name}`
      : `Good ${partOfDay}`;
  }, [user?.firstName]);
  const getStyledGreetingSubtitle =
    "Describe the look you want and I'll style it from your closet. Tap the shirt to pin pieces you want included.";
  const [getStyledAttachedItemIds, setGetStyledAttachedItemIds] = useState<
    string[]
  >([]);
  // Draft text + its placeholder-typewriter + caret now live outside this
  // component (external store + <GetStyledPromptText>) so typing doesn't
  // re-render all of BuilderPanel. Reset the store whenever the composer
  // opens/closes so a fresh session starts empty. Pre-warm the click-sound
  // player pool on open so the very first keypress isn't late.
  useEffect(() => {
    getStyledPromptModeSv.value = getStyledPromptMode;
    getStyledAttachModeSv.value = getStyledAttachMode;
    getStyledKeyboardGuardSv.value =
      getStyledPromptMode && !getStyledAttachMode
        ? withTiming(1, { duration: 90, easing: Easing.out(Easing.cubic) })
        : withTiming(0, { duration: 130, easing: Easing.in(Easing.cubic) });
    if (!getStyledPromptMode) {
      setGetStyledDraft("");
      setGetStyledAttachMode(false);
      setGetStyledWeatherToast(null);
      if (getStyledWeatherToastTimerRef.current) {
        clearTimeout(getStyledWeatherToastTimerRef.current);
        getStyledWeatherToastTimerRef.current = null;
      }
    }
  }, [
    getStyledAttachMode,
    getStyledAttachModeSv,
    getStyledKeyboardGuardSv,
    getStyledPromptMode,
    getStyledPromptModeSv,
  ]);

  useEffect(
    () => () => {
      if (getStyledWeatherToastTimerRef.current) {
        clearTimeout(getStyledWeatherToastTimerRef.current);
      }
    },
    [],
  );

  /** Auto Outfit Builder rides the manual closet sheet (embedded panel + collapsed carousel). */
  const [autoBuilderSheetActive, setAutoBuilderSheetActive] = useState(false);
  const [autoBuilderDismissing, setAutoBuilderDismissing] = useState(false);
  const autoBuilderDismissingRef = useRef(false);
  const finalizeAutoBuilderExitRef = useRef<() => void>(() => {});
  const styleMeDismissCollapseRef = useRef(false);
  const [autoBuilderSeedIds, setAutoBuilderSeedIds] = useState<string[]>([]);
  const autoBuildPanelRef = useRef<AutoOutfitBuilderPanelRef>(null);
  /** When true, ignore in-flight Get Styled callbacks (user confirmed back). */
  const styleMeDiscardedRef = useRef(false);
  const styleMeGenTokenRef = useRef(0);
  const [autoLooksSummary, setAutoLooksSummary] =
    useState<AutoLooksSummaryPayload>({
      looks: [],
      generating: false,
    });
  const [autoLookIndex, setAutoLookIndex] = useState(0);
  const [currentGenerationId, setCurrentGenerationId] = useState<string | null>(
    null,
  );

  const autoGenSessionRef = useRef<AutoGenSession | null>(null);
  const autoOutfitSessionActiveRef = useRef(false);
  const [autoOutfitSessionActive, setAutoOutfitSessionActive] = useState(false);
  /** User is in Get Styled chrome (back pill, results island). Cleared on Back, not on Restart. */
  const [styleMeScreenActive, setStyleMeScreenActive] = useState(false);
  /** More looks sub-menu on the action pill (same setup / new setup / never mind). */
  const [moreLooksMenuOpen, setMoreLooksMenuOpen] = useState(false);
  const looksTrayRef = useRef<LooksTrayHandle>(null);
  /** Index of the look currently being tweaked in-place (lock-and-edit). null = not editing. */
  const [editingLookIndex, setEditingLookIndex] = useState<number | null>(null);
  const editingLookSnapshotRef = useRef<BuilderItem[] | null>(null);
  const [autoBuilderFormSeed, setAutoBuilderFormSeed] =
    useState<BuilderFormSeed | null>(null);
  const [anchoredCanvasItemIds, setAnchoredCanvasItemIds] = useState<string[]>(
    [],
  );
  /** Prevents re-seeding / re-expanding when `snapSheet` identity changes. */
  const initialAnchorSeededKeyRef = useRef<string | null>(null);
  const externalAutoBuilderSeededKeyRef = useRef<string | null>(null);
  /** After "Try On" generation completes, show inline save controls. */
  const [manualReadyToSave, setManualReadyToSave] = useState(false);
  /** Manual canvas before Get Styled — restored when exiting without selecting a look. */
  type PreStyleMeCanvasSnapshot = {
    items: BuilderItem[];
    heroImageUri: string | null;
    anchoredCanvasItemIds: string[];
    fitName: string;
    selectedOccasionId: string | null;
    manualReadyToSave: boolean;
  };
  const preStyleMeCanvasSnapshotRef = useRef<PreStyleMeCanvasSnapshot | null>(
    null,
  );
  const builderItemsRef = useRef(builderItems);
  const heroImageUriRef = useRef(heroImageUri);
  const anchoredCanvasItemIdsRef = useRef(anchoredCanvasItemIds);
  const fitNameRef = useRef(fitName);
  const selectedOccasionIdRef = useRef(selectedOccasionId);
  const manualReadyToSaveRef = useRef(manualReadyToSave);
  useEffect(() => {
    builderItemsRef.current = builderItems;
    heroImageUriRef.current = heroImageUri;
    anchoredCanvasItemIdsRef.current = anchoredCanvasItemIds;
    fitNameRef.current = fitName;
    selectedOccasionIdRef.current = selectedOccasionId;
    manualReadyToSaveRef.current = manualReadyToSave;
  }, [
    builderItems,
    heroImageUri,
    anchoredCanvasItemIds,
    fitName,
    selectedOccasionId,
    manualReadyToSave,
  ]);
  /**
   * When the user taps an item that would conflict with an existing one,
   * we pause and ask: Replace or Cancel.
   */
  const [pendingConflict, setPendingConflict] = useState<{
    incoming: ClosetItem;
    /** Existing pieces shown in the swap sheet (context / thumbnails). */
    conflicting: BuilderItem[];
    headline: string;
    body: string;
    /** Fit-breakdown swap: always remove this piece when the pick confirms. */
    swapOutId?: string;
    /** When only some conflicting IDs should be removed on confirm (e.g. outer top only). */
    replaceEvictIds?: string[];
    /** Partial swap hint copy (outer-layer replacement). */
    layerStackKind?: "top" | "bottom" | "outer";
    /** Allow stacking past the normal slot rule without evicting first (rare / editorial). */
    allowAddAnyway?: boolean;
  } | null>(null);
  /** Cached body photo URL from profiles table. */
  const [bodyPhotoUrl, setBodyPhotoUrl] = useState<string | null>(null);
  /** Cached gender preference from profiles table — drives mannequin/model
   * presentation when generating without a body photo (see mannequinGender). */
  const [genderPref, setGenderPref] = useState<string | null>(null);
  /** Onboarding style moods, used as a soft preference by the AI stylist. */
  const [styleArchetypes, setStyleArchetypes] = useState<string[]>([]);
  /** Builder area below Create/Library — sheet overlays this, max height = full stage. */
  const [stageHeight, setStageHeight] = useState(0);
  /** Collapsed closet strip header (handle + short hint). Kept apart from try-on collapsed so switching modes does not recycle a mismatched fixed height (causes gaps). */
  const [
    measuredClosetCollapsedPullHeaderH,
    setMeasuredClosetCollapsedPullHeaderH,
  ] = useState(0);
  /** Collapsed try-on strip header (instructional copy above carousel). */
  const [
    measuredTryOnCollapsedPullHeaderH,
    setMeasuredTryOnCollapsedPullHeaderH,
  ] = useState(0);
  /** Expanded sheet header (“Drag to resize” + grabber). */
  const [measuredExpandedPullHeaderH, setMeasuredExpandedPullHeaderH] =
    useState(0);

  const onStageLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setStageHeight(Math.round(h));
  }, []);

  const builderItemIds = useMemo(
    () => new Set(builderItems.map((i) => i.id)),
    [builderItems],
  );
  const hasItems = builderItems.length > 0;
  const scopedClosetItems = useMemo(
    () =>
      scopeClosetWithMaps(
        closetItems,
        activeWardrobeId,
        wardrobeMembershipMaps,
      ),
    [closetItems, activeWardrobeId, wardrobeMembershipMaps],
  );
  const wardrobeCountsById = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const w of wardrobes) {
      counts[w.id] = wardrobeMembershipMaps.byWardrobe[w.id]?.size ?? 0;
    }
    return counts;
  }, [wardrobes, wardrobeMembershipMaps.byWardrobe]);
  /** Same category buckets + “recent” order as Closet tab / expanded picker (DB `category` → shelf), not keyword heuristics. */
  const sortedClosetRecent = useMemo(
    () => sortClosetItems(scopedClosetItems, "recent"),
    [scopedClosetItems],
  );
  const deferredManualCategory = useDeferredValue(manualCategory);
  const filteredManualItems = useMemo(() => {
    if (deferredManualCategory === IN_FIT_CHIP) {
      return [...builderItems].sort((a, b) => a.slot - b.slot);
    }
    const shelfId = shelfIdForCategoryChip(deferredManualCategory);
    if (shelfId === null) {
      return sortedClosetRecent;
    }
    return sortedClosetRecent.filter(
      (i) => closetItemShelfKey(i) === shelfId,
    );
  }, [sortedClosetRecent, deferredManualCategory, builderItems]);
  const getStyledAttachedItems = useMemo(
    () =>
      getStyledAttachedItemIds
        .map((id) => closetItems.find((item) => item.id === id))
        .filter((item): item is ClosetItem => !!item),
    [closetItems, getStyledAttachedItemIds],
  );
  const getStyledAttachedIdSet = useMemo(
    () => new Set(getStyledAttachedItemIds),
    [getStyledAttachedItemIds],
  );
  const getStyledAttachCarouselItems = useMemo(() => {
    if (deferredManualCategory === IN_FIT_CHIP) return sortedClosetRecent;
    return filteredManualItems;
  }, [deferredManualCategory, filteredManualItems, sortedClosetRecent]);
  const effectiveManualCategory =
    getStyledAttachMode && manualCategory === IN_FIT_CHIP
      ? "All"
      : manualCategory;

  const showInlineSave = manualReadyToSave && !heroImageUri;

  const standardDragHeaderH =
    measuredClosetCollapsedPullHeaderH > 0
      ? measuredClosetCollapsedPullHeaderH
      : 38;

  /**
   * Effective drag-header height for layout + collapsed sheet math.
   * Try-on copy lives in the same header band as closet — one collapsed footprint.
   */
  const measuredDragHeaderH = useMemo(() => {
    if (manualExpanded) {
      return measuredExpandedPullHeaderH > 0 ? measuredExpandedPullHeaderH : 42;
    }
    return standardDragHeaderH;
  }, [manualExpanded, measuredExpandedPullHeaderH, standardDragHeaderH]);

  const collapsedStripBodyH = STRIP_BODY_FIXED_H;

  /** Strip body height for sheet min math — same band as closet / Get Styled (+ wardrobe row). */
  const collapsedStripBodyForMinPx = collapsedStripBodyH;

  /** Collapsed strip overlay: hidden entirely when try-on + expanded overlay.
   * Get Styled's keyboard borrows the drag-header's space too (that header
   * chrome is hidden in keyboard mode — see showCollapsedPullHintLayer — so this
   * fills the gap it leaves instead of showing empty space above the keys).
   * Attach mode uses the normal manual closet strip height because it shows
   * the manual pull chrome + category rail.
   * compactMinPx/stableCompactMinPx already reserve this same total for the
   * collapsed sheet, so the overall sheet height is unaffected — this just
   * redraws the line between "header zone" and "strip zone". */
  const stripOverlayBodyH =
    manualExpanded && tryOnPickerActive
      ? 0
      : getStyledPromptMode && !getStyledAttachMode
        ? collapsedStripBodyH + standardDragHeaderH
        : collapsedStripBodyH;

  const compactMinPx = measuredDragHeaderH + collapsedStripBodyForMinPx;

  /** Stable during AOB / try-on — closet header + strip (try-on matches this). */
  const stableCompactMinPx = standardDragHeaderH + collapsedStripBodyForMinPx;
  const collapsedSheetMinPx = stableCompactMinPx;
  /** Sheet + tab bar — total bottom chrome for canvas / hero insets. */
  const collapsedTotalChromePx = bottomChromePad + stableCompactMinPx;
  /**
   * Canvas layout always reserves collapsed strip + action island space.
   * Expanded closet slides over the canvas — never shrink/reflow items on open.
   */
  const canvasSafeBottomArea =
    collapsedTotalChromePx + canvasIslandReserve + 10;
  /** Max sheet height before extending into the hidden tab bar strip. */
  const baseStageMaxPx = useMemo(() => {
    // Stage height minus the gap required to show the Create / Library toggle row
    return stageHeight > 0
      ? stageHeight - FITS_CLOSET_UNDER_HEADER_GAP
      : screenHeight * 0.85;
  }, [screenHeight, stageHeight]);

  /** When closet is expanded the sheet reaches the top of the canvas (leaving header gap). */
  const stageMaxPx =
    stageHeight > 0 && manualExpanded ? baseStageMaxPx : baseStageMaxPx;
  const saveMinPx =
    stageHeight > 0
      ? Math.min(
          stageMaxPx - 12,
          Math.max(
            compactMinPx + 20,
            Math.round(stageHeight * SAVE_SHEET_STAGE_RATIO),
          ),
        )
      : Math.max(compactMinPx + 40, Math.round(screenHeight * 0.38));
  const minSheetPx = heroImageUri ? 0 : compactMinPx;
  const maxSheetPx = useMemo(
    () =>
      computeSheetExpandMaxPx(
        stageHeight,
        autoBuilderSheetActive || autoBuilderDismissing ? "autoCapped" : "full",
        screenHeight,
      ),
    [autoBuilderSheetActive, autoBuilderDismissing, screenHeight, stageHeight],
  );
  const clampedMinPx = Math.min(minSheetPx, Math.max(80, maxSheetPx - 8));

  const minSheet = useSharedValue(compactMinPx);
  const maxSheet = useSharedValue(stageMaxPx);
  const sheetH = useSharedValue(compactMinPx);
  const startSheetH = useSharedValue(0);
  const islandOpacity = useSharedValue(1);
  const pillNoticeProgress = useSharedValue(0);
  /** UI-thread mirror — auto builder keeps the pill visible while the sheet is expanded. */
  const autoBuilderSheetActiveSv = useSharedValue(false);
  const tryOnDismissOpacity = useSharedValue(1);
  const tryOnDismissTranslateY = useSharedValue(0);
  const tryOnEntryOpacity = useSharedValue(1);
  const tryOnEntryTranslateY = useSharedValue(0);
  const tryOnRailOpacity = useSharedValue(0);
  const closetCrossfadeOpacity = useSharedValue(1);

  const autoBuilderOpacity = useSharedValue(1);
  const autoBuilderTranslateY = useSharedValue(0);
  const autoBuilderDismissingSv = useSharedValue(0);
  useEffect(() => {
    autoBuilderSheetActiveSv.value = autoBuilderSheetActive;
  }, [autoBuilderSheetActive, autoBuilderSheetActiveSv]);
  useEffect(() => {
    autoBuilderDismissingSv.value = autoBuilderDismissing ? 1 : 0;
  }, [autoBuilderDismissing, autoBuilderDismissingSv]);
  const autoBuilderAnimatedStyle = useAnimatedStyle(() => {
    let opacity = autoBuilderOpacity.value;
    if (autoBuilderDismissingSv.value > 0.5) {
      const min = minSheet.value;
      const max = maxSheet.value;
      const span = Math.max(1, max - min);
      opacity =
        opacity *
        interpolate(
          sheetH.value,
          [min, min + span * 0.2],
          [0, 1],
          Extrapolation.CLAMP,
        );
    }
    return {
      opacity,
      transform: [{ translateY: autoBuilderTranslateY.value }],
    };
  });
  const tryOnClosingRef = useRef(false);
  /** Resolves the Promise from `animateTryOnDismiss` (ref avoids non-worklet captures in runOnJS). */
  const tryOnDismissResolveRef = useRef<(() => void) | null>(null);

  /**
   * Drive canvas safe-area from the *current* bottom sheet height. Using only
   * `compactMinPx` caused layout to assume a shorter overlay after the user
   * dragged the sheet up — pieces scaled too big and sat under the action pill.
   */
  const [liveSheetH, setLiveSheetH] = useState(() => Math.round(compactMinPx));
  const lastLiveH = useSharedValue(Math.round(compactMinPx));
  useAnimatedReaction(
    () => Math.round(sheetH.value),
    (h, prev) => {
      "worklet";
      if (h === prev) return;
      const mini = Math.round(minSheet.value);
      const maxi = Math.round(maxSheet.value);
      const atEndpoint = h === mini || h === maxi;
      // Smaller steps than before so collage reserve tracks the sheet more evenly;
      // always sync at fully collapsed / expanded so nothing “snaps” after the spring.
      if (Math.abs(h - lastLiveH.value) > 18 || atEndpoint) {
        lastLiveH.value = h;
        runOnJS(setLiveSheetH)(h);
      }
    },
  );

  useEffect(() => {
    const maxS = maxSheetPx;
    maxSheet.value = maxS;

    if (manualExpanded) {
      minSheet.value = clampedMinPx;
      return;
    }

    // Collapsed strip (closet / Get Styled / try-on) — mode-aware header + strip height.
    const collapsedMin = collapsedSheetMinPx;
    minSheet.value = collapsedMin;

    // Only force-collapse here. Expand is driven by expandManualCloset / pan / toggle
    // so we never snap sheetH back to minS on the same frame as opening (that was
    // cancelling “pull up for closet” before it reached the Create/Library edge).
    // Skip while try-on or Get Styled dismiss drives `sheetH` on the UI thread.
    if (tryOnClosingRef.current) {
      minSheet.value = collapsedMin;
      sheetH.value = collapsedMin;
      return;
    }
    if (!autoBuilderDismissingRef.current) {
      sheetH.value = withTiming(collapsedMin, sheetTimingCollapse);
    }
  }, [
    manualExpanded,
    clampedMinPx,
    collapsedSheetMinPx,
    maxSheetPx,
    minSheet,
    maxSheet,
    sheetH,
  ]);

  /** While expanded, if the stage is measured/rotated, clamp sheet to new max (without adding tab bar height). */
  useEffect(() => {
    if (!manualExpanded || stageHeight <= 0) return;
    const cap = maxSheetPx;
    maxSheet.value = cap;
    runOnUI((c: number) => {
      "worklet";
      if (sheetH.value > c) {
        sheetH.value = withTiming(c, sheetTimingSnap);
      }
    })(cap);
  }, [stageHeight, manualExpanded, maxSheetPx, maxSheet, sheetH]);

  // Island opacity is now managed directly in snapSheet and panGesture for snappiness.

  const tryOnDismissAnimatedStyle = useAnimatedStyle(() => ({
    opacity: tryOnDismissOpacity.value,
  }));

  const tryOnEntryAnimatedStyle = useAnimatedStyle(() => ({
    opacity: tryOnEntryOpacity.value,
  }));

  const tryOnRailAnimatedStyle = useAnimatedStyle(() => ({
    opacity: tryOnRailOpacity.value,
  }));

  const closetCrossfadeAnimatedStyle = useAnimatedStyle(() => ({
    opacity: closetCrossfadeOpacity.value,
  }));

  useEffect(() => {
    if (builderItems.length === 0) setManualReadyToSave(false);
  }, [builderItems.length]);

  useEffect(() => {
    if (!manualExpanded) setManualSearch("");
  }, [manualExpanded]);

  const refreshProfilePreferences = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("body_photo_url, gender, style_archetypes")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;

      const primaryPhoto = data?.body_photo_url ?? null;
      setBodyPhotoUrl(primaryPhoto);
      setGenderPref(data?.gender ?? null);
      setStyleArchetypes(
        Array.isArray(data?.style_archetypes)
          ? data.style_archetypes.filter(
              (value: unknown): value is string => typeof value === "string",
            )
          : [],
      );

      const stored = await loadStoredSelfies(user.id);
      setTryOnSelfieUrls(mergeSelfieUrls(primaryPhoto, stored));
    } catch {
      /* profile may not exist or may be temporarily unavailable */
    }
  }, [user?.id]);

  useEffect(() => {
    void refreshProfilePreferences();
  }, [refreshProfilePreferences]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(
      PROFILE_PREFERENCES_UPDATED_EVENT,
      () => void refreshProfilePreferences(),
    );
    return () => subscription.remove();
  }, [refreshProfilePreferences]);

  /**
   * Expanded sheet reserve at the inner bottom — must clear the tab bar visually (floating bar
   * draws above content). Matches tab-bar-aware `bottomChromePad`, not bare safe-area only.
   */
  const sheetExpandedPadBottom = bottomChromePad;

  const sheetAnimatedStyle = useAnimatedStyle(() => {
    const min = minSheet.value;
    const max = maxSheet.value;
    if (max <= min) {
      return {
        height: sheetH.value,
        bottom: bottomChromePad,
        paddingBottom: 0,
      };
    }
    const bottom = interpolate(
      sheetH.value,
      [min, max],
      [bottomChromePad, -tabBarBlockHeight],
      "clamp",
    );
    const paddingBottom = interpolate(
      sheetH.value,
      [min, max],
      [0, sheetExpandedPadBottom],
      "clamp",
    );
    const tabMotion = fitsTabBlendSv
      ? fitsTabChromeMotion(fitsTabBlendSv.value)
      : { fade: 1, lift: 0, scale: 1 };
    const chromePop = fitsChromeRevealSv?.value ?? 1;
    const tabReveal = tabMotion.fade * chromePop;
    const popLift = interpolate(chromePop, [0, 1], [14, 0], Extrapolation.CLAMP);
    return {
      height: sheetH.value,
      bottom,
      paddingBottom,
      opacity: tabReveal,
      transform: [{ translateY: tabMotion.lift + popLift }],
    };
  });

  const islandAnimatedStyle = useAnimatedStyle(() => {
    const min = minSheet.value;
    const max = maxSheet.value;
    let b = 0;
    if (max > min) {
      b = interpolate(
        sheetH.value,
        [min, max],
        [0, -tabBarBlockHeight],
        Extrapolation.CLAMP,
      );
    }
    const span = Math.max(1, max - min);
    const expandProgress = interpolate(
      sheetH.value,
      [min, max],
      [0, 1],
      Extrapolation.CLAMP,
    );
    /** Track sheet drag/spring — pill fades out as closet rises (not a separate timing). */
    const sheetDrivenFade = interpolate(
      sheetH.value,
      [min + span * 0.03, min + span * 0.45],
      [1, 0],
      Extrapolation.CLAMP,
    );
    const liftOpacity = autoBuilderSheetActiveSv.value ? 1 : sheetDrivenFade;
    const opacity = liftOpacity * islandOpacity.value;
    const translateY = autoBuilderSheetActiveSv.value
      ? 0
      : interpolate(expandProgress, [0, 1], [0, 12], Extrapolation.CLAMP);
    const scale = autoBuilderSheetActiveSv.value
      ? 1
      : interpolate(
          expandProgress,
          [0, 0.35, 1],
          [1, 0.98, 0.93],
          Extrapolation.CLAMP,
        );
    const tabMotion = fitsTabBlendSv
      ? fitsTabChromeMotion(fitsTabBlendSv.value)
      : { fade: 1, lift: 0, scale: 1 };
    const chromePop = fitsChromeRevealSv?.value ?? 1;
    const tabReveal = tabMotion.fade * chromePop;
    const popScale = interpolate(chromePop, [0, 1], [0.93, 1], Extrapolation.CLAMP);
    const popLift = interpolate(chromePop, [0, 1], [16, 0], Extrapolation.CLAMP);
    const normalBottom =
      sheetH.value + b + bottomChromePad + ACTION_ISLAND_SHEET_GAP;
    // Composer mode animates to a fixed target immediately. Do not track
    // kb.height here; that made the card feel like the keyboard was shoving it.
    const promptOpeningFloor =
      collapsedSheetMinPx + b + bottomChromePad + ACTION_ISLAND_SHEET_GAP;
    const promptTargetBottom = getStyledAttachModeSv.value
      ? promptOpeningFloor
      : interpolate(
          getStyledKeyboardGuardSv.value,
          [0, 1],
          [promptOpeningFloor, getStyledComposerTargetBottom],
          Extrapolation.CLAMP,
        );
    const bottom = getStyledPromptModeSv.value
      ? Math.max(promptOpeningFloor, promptTargetBottom)
      : normalBottom;
    return {
      opacity: opacity * tabReveal,
      transform: [
        { translateY: translateY + tabMotion.lift + popLift },
        { scale: scale * tabMotion.scale * popScale },
      ],
      bottom,
    };
  });

  /** Island content dips down + fades while an in-pill notice rises into view. */
  const pillContentNoticeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      pillNoticeProgress.value,
      [0, 0.45],
      [1, 0],
      Extrapolation.CLAMP,
    ),
    transform: [
      {
        translateY: interpolate(
          pillNoticeProgress.value,
          [0, 1],
          [0, 16],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const pillNoticeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      pillNoticeProgress.value,
      [0.45, 1],
      [0, 1],
      Extrapolation.CLAMP,
    ),
    transform: [
      {
        translateY: interpolate(
          pillNoticeProgress.value,
          [0, 1],
          [-16, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const showPillNotice = useCallback(
    (
      msg: string,
      variant: "hint" | "success" | "error" = "success",
      durationMs = variant === "hint" ? 2800 : variant === "error" ? 2400 : 1500,
      action?: { label: string; onPress: () => void | Promise<void> },
    ) => {
      pillNoticeTimers.current.forEach(clearTimeout);
      pillNoticeTimers.current = [];
      pillNoticeActionRef.current = action?.onPress ?? null;
      setPillNotice({
        msg,
        variant,
        actionLabel: action?.label,
      });
      pillNoticeProgress.value = withTiming(1, {
        duration: 320,
        easing: Easing.out(Easing.cubic),
      });
      pillNoticeTimers.current.push(
        setTimeout(() => {
          pillNoticeProgress.value = withTiming(0, {
            duration: 300,
            easing: Easing.in(Easing.cubic),
          });
          pillNoticeTimers.current.push(
            setTimeout(() => {
              pillNoticeActionRef.current = null;
              setPillNotice(null);
            }, 320),
          );
        }, durationMs),
      );
    },
    [pillNoticeProgress],
  );

  const showSavedToLibraryNotice = useCallback(
    (outfitId: string, doneLabel = persistLookDone) => {
      // When this save landed on a day (dayContextTargetIso), offer "View on
      // [day]" so the loop closes visibly — otherwise you'd have no proof
      // the build/try-on actually attached anywhere. Falls back to the
      // regular library toast for untethered builds.
      const dayAction =
        dayContextTargetIso && onViewInPlan
          ? {
              label: `View on ${dayContextBanner?.dateText ?? "day"}`,
              onPress: () => {
                void onViewInPlan(dayContextTargetIso);
              },
            }
          : undefined;
      showPillNotice(
        doneLabel,
        "success",
        4500,
        dayAction ??
          (onViewInLibrary
            ? {
                label: "View in library",
                onPress: () => {
                  void onViewInLibrary(outfitId);
                },
              }
            : undefined),
      );
    },
    [
      showPillNotice,
      onViewInLibrary,
      onViewInPlan,
      persistLookDone,
      dayContextTargetIso,
      dayContextBanner,
    ],
  );

  useEffect(
    () => () => {
      pillNoticeTimers.current.forEach(clearTimeout);
    },
    [],
  );

  /**
   * Crossfade strip ↔ expanded content from actual sheet height so opacity stays
   * locked to the spring / drag (avoids a separate 160ms timing fighting the sheet).
   */
  const stripAnimatedStyle = useAnimatedStyle(() => {
    if (DEBUG_HIDE_COLLAPSED_DRAWER_BODY) {
      return { opacity: 0 };
    }
    const min = minSheet.value;
    const max = maxSheet.value;
    const span = Math.max(1, max - min);
    /** Pop in only when nearly collapsed — avoids carousel sliding up mid-dismiss. */
    return {
      opacity: interpolate(
        sheetH.value,
        [min, min + span * 0.06],
        [1, 0],
        "clamp",
      ),
    };
  });

  const expandedAnimatedStyle = useAnimatedStyle(() => {
    if (autoBuilderDismissingSv.value > 0.5) {
      return { opacity: 1 };
    }
    const min = minSheet.value;
    const max = maxSheet.value;
    const span = Math.max(1, max - min);
    return {
      opacity: interpolate(
        sheetH.value,
        [min + span * 0.1, min + span * 0.52],
        [0, 1],
        "clamp",
      ),
    };
  });

  const headerHintAnimatedStyle = useAnimatedStyle(() => {
    const min = minSheet.value;
    const max = maxSheet.value;
    const span = Math.max(1, max - min);
    /** Hidden mid-collapse — hints snap in only at fully collapsed or expanded. */
    return {
      opacity: interpolate(
        sheetH.value,
        [min, min + span * 0.06, max - span * 0.06, max],
        [1, 0, 0, 1],
        "clamp",
      ),
    };
  });

  /** Collapsed “Pull up for closet” — pinned above strip, fades in at rest only. */
  const collapsedPullHintOpacity = useAnimatedStyle(() => {
    const min = minSheet.value;
    const max = maxSheet.value;
    const span = Math.max(1, max - min);
    return {
      opacity: interpolate(
        sheetH.value,
        [min, min + span * 0.06],
        [1, 0],
        "clamp",
      ),
    };
  });

  /** Expanded “Swipe down to close” — top header, fades out before sheet finishes closing. */
  const expandedPullHintOpacity = useAnimatedStyle(() => {
    const min = minSheet.value;
    const max = maxSheet.value;
    const span = Math.max(1, max - min);
    return {
      opacity: interpolate(
        sheetH.value,
        [max - span * 0.06, max],
        [0, 1],
        "clamp",
      ),
    };
  });

  /** Keeps Fits chrome (library fade) on the UI thread — no per-frame React state. */
  useAnimatedReaction(
    () => {
      const min = minSheet.value;
      const max = maxSheet.value;
      const span = Math.max(1, max - min);
      const ratio = (sheetH.value - min) / span;
      // Hide top chrome while sheet is more than ~10% open so carets don't bleed in mid-swipe.
      if (ratio > 0.1) return 1;
      return interpolate(ratio, [0, 0.1], [0, 1], "clamp");
    },
    (p) => {
      if (fitsChromeExpandSv) {
        fitsChromeExpandSv.value = p;
      }
    },
  );

  const syncClosetBrowseForChip = useCallback((chip: string) => {
    if (chip === IN_FIT_CHIP) {
      setClosetBrowseCategory(null);
      return;
    }
    setClosetBrowseCategory(
      chip === "All" ? null : shelfIdForCategoryChip(chip),
    );
  }, []);

  const collapseClosetSheet = useCallback(() => {
    const wasStyleMeDismiss = autoBuilderDismissingRef.current;
    if (wasStyleMeDismiss) {
      finalizeAutoBuilderExitRef.current();
    }
    setManualExpanded(false);
    setClosetBrowseCategory(null);
    pendingSwapItemIdRef.current = null;
    closetCrossfadeOpacity.value = 1;
    if (wasStyleMeDismiss) {
      const headerH =
        measuredClosetCollapsedPullHeaderH > 0
          ? measuredClosetCollapsedPullHeaderH
          : 38;
      const targetMin = headerH + collapsedStripBodyForMinPx;
      runOnUI((minVal: number) => {
        "worklet";
        minSheet.value = minVal;
        sheetH.value = minVal;
      })(targetMin);
    }
  }, [
    closetCrossfadeOpacity,
    measuredClosetCollapsedPullHeaderH,
    collapsedStripBodyForMinPx,
    minSheet,
    sheetH,
  ]);

  const snapSheet = useCallback(
    (expand: boolean, expandMode: FitsSheetSnapExpandMode = "full") => {
      if (!expand) {
        // Calculate the actual target height for the collapsed closet strip
        const targetMin = measuredDragHeaderH + collapsedStripBodyForMinPx;

        runOnUI((minVal: number, styleMeDismiss: boolean) => {
          "worklet";
          const timing = styleMeDismiss
            ? sheetTimingStyleMeDismiss
            : sheetTimingCollapse;
          minSheet.value = minVal;
          sheetH.value = withTiming(minVal, timing, (finished) => {
            if (finished) {
              runOnJS(collapseClosetSheet)();
            }
          });
        })(targetMin, styleMeDismissCollapseRef.current);
        return;
      }
      if (expandMode === "full") {
        syncClosetBrowseForChip(manualCategory);
      }
      setManualExpanded(true);
      const maxTarget = computeSheetExpandMaxPx(
        stageHeight,
        expandMode,
        screenHeight,
      );
      const minTarget = Math.min(minSheetPx, Math.max(80, maxTarget - 8));
      runOnUI((maxT: number, minT: number) => {
        "worklet";
        maxSheet.value = maxT;
        minSheet.value = minT;
        sheetH.value = withSpring(maxT, SHEET_SPRING_EXPAND);
      })(maxTarget, minTarget);
    },
    [
      sheetH,
      minSheet,
      maxSheet,
      stageHeight,
      screenHeight,
      minSheetPx,
      manualCategory,
      syncClosetBrowseForChip,
      collapseClosetSheet,
      bottomChromePad,
      measuredDragHeaderH,
      collapsedStripBodyForMinPx,
      islandOpacity,
    ],
  );

  const animateTryOnDismiss = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      if (tryOnClosingRef.current) {
        resolve();
        return;
      }
      tryOnClosingRef.current = true;

      runOnUI((target: number) => {
        "worklet";
        minSheet.value = target;
        sheetH.value = target;
        tryOnRailOpacity.value = 0;
        tryOnEntryOpacity.value = 1;
        tryOnDismissOpacity.value = 1;
        closetCrossfadeOpacity.value = 1;
        islandOpacity.value = 1;
      })(stableCompactMinPx);

      setTryOnPickerActive(false);
      tryOnClosingRef.current = false;
      resolve();
    });
  }, [
    closetCrossfadeOpacity,
    islandOpacity,
    minSheet,
    sheetH,
    stableCompactMinPx,
    tryOnDismissOpacity,
    tryOnEntryOpacity,
    tryOnRailOpacity,
  ]);

  const endTryOnSessionInternal = useCallback(() => {
    if (tryOnPickerActive && !tryOnClosingRef.current) {
      void animateTryOnDismiss();
    } else {
      closetCrossfadeOpacity.value = 1;
      tryOnRailOpacity.value = 0;
      tryOnEntryOpacity.value = 1;
      tryOnDismissOpacity.value = 1;
      setTryOnPickerActive(false);
      tryOnClosingRef.current = false;
    }
    setTryOnSessionActive(false);
    setTryOnExitModalVisible(false);
    setEditingTryOnLook(false);
    pausedHeroRef.current = null;
    pausedBuilderItemsRef.current = null;
  }, [
    animateTryOnDismiss,
    closetCrossfadeOpacity,
    tryOnDismissOpacity,
    tryOnEntryOpacity,
    tryOnPickerActive,
    tryOnRailOpacity,
  ]);

  /** Done after save — drop try-on chrome, keep pieces on the board. */
  const completeTryOnExitAfterSave = useCallback(
    (itemCount: number) => {
      setHeroImageUri(null);
      setSavedToLibrary(null);
      setManualReadyToSave(itemCount > 0);
      endTryOnSessionInternal();
    },
    [endTryOnSessionInternal],
  );

  const recordTryOnForLatest = useCallback(
    async (heroUri: string, itemIds: string[]) => {
      if (!userId) return;
      // Persist local render URIs (data:/file://) to storage first — a
      // device-local path recorded here dies on restart/reinstall and shows
      // as a broken image in the generations strip.
      const persistedUrl = heroUri.startsWith("http")
        ? heroUri
        : await persistHeroImageUrl(supabase, userId, heroUri);
      if (!persistedUrl) return;
      const payload = {
        item_ids: itemIds,
        try_on_image_url: persistedUrl,
      };
      if (currentGenerationId) {
        await supabase
          .from("generation_history")
          .update(payload)
          .eq("id", currentGenerationId);
      } else {
        await supabase.from("generation_history").insert({
          user_id: userId,
          image_url: null,
          ...payload,
        });
      }
    },
    [userId, currentGenerationId],
  );

  const guardTryOnResultEdit = useCallback(() => {
    if (!tryOnResultViewLocked) return false;
    void Haptics.selectionAsync();
    showPillNotice("Tap Edit pieces to change this look", "hint");
    return true;
  }, [tryOnResultViewLocked, showPillNotice]);

  const exitTryOnSession = useCallback(() => {
    if (!tryOnSessionActive) {
      if (tryOnPickerActive && !tryOnClosingRef.current) {
        void Haptics.selectionAsync();
        void animateTryOnDismiss();
      }
      return;
    }
    if (tryOnRendering) {
      showPillNotice("Still rendering your look…", "hint");
      return;
    }
    if (editingTryOnLook) {
      void Haptics.selectionAsync();
      setEditingTryOnLook(false);
      if (pausedBuilderItemsRef.current) {
        setBuilderItems(pausedBuilderItemsRef.current);
      }
      if (pausedHeroRef.current) setHeroImageUri(pausedHeroRef.current);
      pausedBuilderItemsRef.current = null;
      pausedHeroRef.current = null;
      return;
    }
    const hasResult = !!(heroImageUri || pausedHeroRef.current);
    // Landed automation looks get the SAME Done contract as a try-on the user
    // generated here: unsaved result → ask "Save look? / Don't save", then
    // exit and clear. (The old "already saved, leave quietly" special case
    // predates saved_to_library — automation rows aren't in the library until
    // the user saves, so silently keeping/dropping the render read as broken.)
    if (hasResult && !savedToLibrary) {
      void Haptics.selectionAsync();
      setTryOnExitModalVisible(true);
      return;
    }
    if (hasResult && savedToLibrary) {
      void Haptics.selectionAsync();
      completeTryOnExitAfterSave(builderItems.length);
      return;
    }
    void Haptics.selectionAsync();
    endTryOnSessionInternal();
  }, [
    tryOnSessionActive,
    tryOnRendering,
    editingTryOnLook,
    heroImageUri,
    tryOnPickerActive,
    animateTryOnDismiss,
    endTryOnSessionInternal,
    showPillNotice,
    savedToLibrary,
    builderItems,
    completeTryOnExitAfterSave,
  ]);

  const exitTryOnSessionQuiet = useCallback(() => {
    endTryOnSessionInternal();
  }, [endTryOnSessionInternal]);

  const closeTryOnPicker = useCallback(() => {
    if (!tryOnPickerActive || tryOnClosingRef.current) return;
    void Haptics.selectionAsync();
    endTryOnSessionInternal();
  }, [tryOnPickerActive, endTryOnSessionInternal]);

  const handleSheetExpandIntention = useCallback(() => {
    if (autoOutfitSessionActive || autoLooksSummary.generating) {
      return;
    }
    syncClosetBrowseForChip(manualCategory);
    setManualExpanded(true);
  }, [
    autoLooksSummary.generating,
    autoOutfitSessionActive,
    manualCategory,
    syncClosetBrowseForChip,
  ]);

  /** When expanded, swipe down on the drag header collapses the closet sheet. */
  const onExpandedSheetDragUpdate = useCallback(
    (translationY: number) => {
      "worklet";
      if (translationY <= 0) return;
      const min = minSheet.value;
      const max = maxSheet.value;
      sheetH.value = Math.max(min, max - translationY);
    },
    [sheetH, minSheet, maxSheet],
  );

  const onExpandedSheetDragEnd = useCallback(
    (translationY: number, velocityY: number) => {
      "worklet";
      if (translationY > 80 || velocityY > 450) {
        runOnJS(snapSheet)(false);
      } else if (translationY > 10) {
        sheetH.value = withSpring(maxSheet.value, SHEET_SPRING_EXPAND);
      }
    },
    [snapSheet, sheetH, maxSheet],
  );

  const handleClosetBrowseChange = useCallback(
    (id: string | null) => {
      setClosetBrowseCategory(id);
      if (id === null) {
        setManualCategory((cat) => (cat === IN_FIT_CHIP ? IN_FIT_CHIP : "All"));
      } else {
        setManualCategory(shelfLabelForCategoryId(id));
      }
      if (id !== null || !manualExpanded) return;
      runOnUI(() => {
        "worklet";
        sheetH.value = maxSheet.value;
      })();
    },
    [manualExpanded, sheetH, maxSheet],
  );

  const openClosetBrowseForChip = useCallback(
    (chip: string) => {
      if (manualExpanded) {
        setManualCategory(chip);
        syncClosetBrowseForChip(chip);
        return;
      }
      const shelfId = shelfIdForCategoryChip(chip);
      if (shelfId) setClosetBrowseCategory(shelfId);
    },
    [manualExpanded, syncClosetBrowseForChip],
  );

  const expandedHeaderPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(10)
        .failOffsetX([-48, 48])
        .onUpdate((e) => {
          "worklet";
          if (e.translationY <= 0) return;
          onExpandedSheetDragUpdate(e.translationY);
        })
        .onEnd((e) => {
          "worklet";
          onExpandedSheetDragEnd(e.translationY, e.velocityY);
        }),
    [onExpandedSheetDragUpdate, onExpandedSheetDragEnd],
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        /** Model picker strip — no closet pull until generation finishes.
         * Also disabled while the Get Styled keyboard occupies this strip —
         * pulling up would fight with typing/key taps in that spot. */
        .enabled(
          !tryOnPickerActive &&
            !manualExpanded &&
            !autoOutfitSessionActive &&
            !autoLooksSummary.generating &&
            (!getStyledPromptMode || getStyledAttachMode) &&
            editingLookIndex === null,
        )
        /** Swipe up only — taps on "Pull up for closet" must not expand. */
        .activeOffsetY(-14)
        .failOffsetX([-32, 32])
        .onBegin(() => {
          startSheetH.value = sheetH.value;
        })
        .onUpdate((e) => {
          const next = startSheetH.value - e.translationY;
          const min = minSheet.value;
          const max = maxSheet.value;
          sheetH.value = Math.min(max, Math.max(min, next));
        })
        .onEnd((e) => {
          "worklet";
          const mid = (minSheet.value + maxSheet.value) / 2;
          if (e.velocityY < -500) {
            sheetH.value = withSpring(maxSheet.value, SHEET_SPRING_EXPAND);
            runOnJS(handleSheetExpandIntention)();
          } else if (e.velocityY > 500) {
            sheetH.value = withTiming(minSheet.value, sheetTimingCollapse, (finished) => {
              if (finished) runOnJS(collapseClosetSheet)();
            });
          } else {
            const draggedUpEnough = e.translationY < -36;
            const expand = draggedUpEnough && sheetH.value >= mid;
            if (expand) {
              sheetH.value = withSpring(maxSheet.value, SHEET_SPRING_EXPAND);
              runOnJS(handleSheetExpandIntention)();
            } else {
              sheetH.value = withTiming(minSheet.value, sheetTimingCollapse, (finished) => {
                if (finished) runOnJS(collapseClosetSheet)();
              });
            }
          }
        }),
    [
      tryOnPickerActive,
      manualExpanded,
      autoOutfitSessionActive,
      autoLooksSummary.generating,
      getStyledPromptMode,
      getStyledAttachMode,
      editingLookIndex,
      islandOpacity,
      sheetH,
      minSheet,
      maxSheet,
      startSheetH,
      handleSheetExpandIntention,
      collapseClosetSheet,
    ],
  );

  const occasionForSave = useCallback(() => {
    if (selectedOccasionId) return selectedOccasionId;
    return null;
  }, [selectedOccasionId]);

  const clearRender = () => setHeroImageUri(null);
  /**
   * Editing pieces while a try-on result is showing must NOT destroy the render.
   * Stash the hero + the exact pieces and drop into edit mode so Cancel restores
   * everything and Re-render rebuilds from the edits. No-op when there's no render
   * (normal manual building) or we're already editing.
   */
  const stashHeroForEdit = useCallback(() => {
    if (!heroImageUri || editingTryOnLook) return;
    pausedHeroRef.current = heroImageUri;
    pausedBuilderItemsRef.current = builderItemsRef.current.map((i) => ({
      ...i,
    }));
    setEditingTryOnLook(true);
    setHeroImageUri(null);
  }, [heroImageUri, editingTryOnLook]);
  const formatLocalDateIso = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const resetBuilderState = useCallback(() => {
    tryOnGenTokenRef.current += 1;
    setSavedToLibrary(null);
    pushHistory(builderItems);
    setPendingConflict(null);
    setGenerationPhase("idle");
    pillNoticeTimers.current.forEach(clearTimeout);
    pillNoticeTimers.current = [];
    setPillNotice(null);
    pillNoticeProgress.value = 0;
    setTryOnPickerActive(false);
    tryOnClosingRef.current = false;
    tryOnDismissResolveRef.current = null;
    closetCrossfadeOpacity.value = 1;
    tryOnEntryOpacity.value = 1;
    tryOnEntryTranslateY.value = 0;
    tryOnRailOpacity.value = 0;
    tryOnDismissOpacity.value = 1;
    tryOnDismissTranslateY.value = 0;
    setTryOnSparseModalVisible(false);
    setAutoBuilderSheetActive(false);
    setTryOnSessionActive(false);
    setTryOnExitModalVisible(false);
    setAutoBuilderDismissing(false);
    setAutoBuilderSeedIds([]);
    setAutoLooksSummary({ looks: [], generating: false });
    autoOutfitSessionActiveRef.current = false;
    setAutoOutfitSessionActive(false);
    autoGenSessionRef.current = null;
    setAutoBuilderFormSeed(null);
    setAnchoredCanvasItemIds([]);
    setCurrentGenerationId(null);
    setEditingLookIndex(null);
    editingLookSnapshotRef.current = null;
    setEditingOutfitId(null);
    setEditTargetWasUnsaved(false);
    editBaselineItemIdsRef.current = null;
    preStyleMeCanvasSnapshotRef.current = null;
    setEditingTryOnLook(false);
    pausedHeroRef.current = null;
    pausedBuilderItemsRef.current = null;
    clearRender();
    setManualReadyToSave(false);
    setBuilderItems([]);
    setSessionLooks([]);
    setHistoryStack([]);
    setRedoStack([]);
  }, [builderItems, pushHistory]);

  const handleRemoveItem = (slot: number) => {
    if (tryOnRendering) return;
    if (guardTryOnResultEdit()) return;
    pushHistory(builderItems);
    if (!editingTryOnLook) {
      stashHeroForEdit();
    }
    setManualReadyToSave(false);
    let removedId: string | undefined;
    setBuilderItems((prev) => {
      removedId = prev.find((p) => p.slot === slot)?.id;
      return prev
        .filter((p) => p.slot !== slot)
        .map((p, i) => ({ ...p, slot: i }));
    });
    if (removedId) {
      setAnchoredCanvasItemIds((ids) => ids.filter((id) => id !== removedId));
    }
  };

  /**
   * Returns conflicting builder pieces and copy for the Replace sheet.
   * Accessories stack freely (no conflict); layered tops/bottoms/outer allow 2 before prompting.
   */
  const detectConflict = useCallback(
    (incoming: ClosetItem, prev: BuilderItem[]) => {
      if (prev.find((p) => p.id === incoming.id)) return null; // toggle-off, no conflict
      if (prev.length >= MAX_FIT_BUILDER_PIECES) return null; // cap — handled in handlePickItemManual

      if (isAccessoryLike(incoming)) return null;

      const isDress = isDressLike(incoming);
      const isShoe = isShoeItem(incoming);
      const isBag = isBagItem(incoming);
      const isBottom = isBottomLike(incoming);
      const isTop = isTopLike(incoming);
      const isOuter = isOuterItem(incoming);

      if (isDress) {
        const conflicts = prev.filter(
          (p) => isDressLike(p) || isTopLike(p) || isBottomLike(p),
        );
        if (conflicts.length > 0)
          return {
            conflicting: conflicts,
            headline: "Dress covers top & bottom",
            body: "Adding this dress swaps out separates that overlap with it.",
            allowAddAnyway: false,
          };
      } else if (isShoe) {
        const conflicts = prev.filter((p) => isShoeItem(p));
        if (conflicts.length >= 1)
          return {
            conflicting: conflicts,
            headline: "One pair of shoes",
            body: "Usually one pair — swap, or add anyway if you want two pairs on the board.",
            allowAddAnyway: true,
          };
      } else if (isBag) {
        const conflicts = prev.filter((p) => isBagItem(p));
        if (conflicts.length > 0)
          return {
            conflicting: conflicts,
            headline: "One bag",
            body: "Swap your bag, or add anyway to keep both.",
            allowAddAnyway: true,
          };
      } else if (isBottom) {
        const dress = prev.find((p) => isDressLike(p));
        if (dress)
          return {
            conflicting: [dress],
            headline: "Dress covers bottoms",
            body: "Adding bottoms swaps out your dress.",
            allowAddAnyway: false,
          };
        const bottoms = prev
          .filter((p) => isBottomLike(p))
          .sort((a, b) => a.slot - b.slot);
        if (bottoms.length >= MAX_BOTTOM_LAYERS) {
          const outer = bottoms[bottoms.length - 1]!;
          return {
            conflicting: bottoms,
            headline: "Third bottom",
            body: "You already layered two bottoms (e.g. tights + shorts). This swaps the outer layer.",
            replaceEvictIds: [outer.id],
            layerStackKind: "bottom" as const,
            allowAddAnyway: true,
          };
        }
      } else if (isTop) {
        const dress = prev.find((p) => isDressLike(p));
        if (dress)
          return {
            conflicting: [dress],
            headline: "Dress covers your top",
            body: "Adding a top swaps out your dress.",
            allowAddAnyway: false,
          };
        const tops = prev
          .filter((p) => isTopLike(p))
          .sort((a, b) => a.slot - b.slot);
        if (tops.length >= MAX_TOP_LAYERS) {
          const outer = tops[tops.length - 1]!;
          return {
            conflicting: tops,
            headline: "Third top",
            body: "You already layered two tops (e.g. tee + hoodie). This swaps your outer layer — the base stays.",
            replaceEvictIds: [outer.id],
            layerStackKind: "top" as const,
            allowAddAnyway: true,
          };
        }
      } else if (isOuter) {
        const outers = prev
          .filter((p) => isOuterItem(p))
          .sort((a, b) => a.slot - b.slot);
        if (outers.length >= MAX_OUTER_LAYERS) {
          const outer = outers[outers.length - 1]!;
          return {
            conflicting: outers,
            headline: "Third jacket layer",
            body: "You already have two outer layers (e.g. vest + coat). This swaps the outermost piece.",
            replaceEvictIds: [outer.id],
            layerStackKind: "outer" as const,
            allowAddAnyway: true,
          };
        }
      }
      return null;
    },
    [],
  );

  /** Finalize adding an item, optionally evicting `evictIds` first. */
  const commitItemAdd = useCallback(
    (
      incoming: ClosetItem,
      evictIds: string[] = [],
      opts?: { bypassSlotGuards?: boolean },
    ) => {
      if (tryOnRendering) return;
      if (guardTryOnResultEdit()) return;
      pushHistory(builderItems);
      if (!editingTryOnLook) {
        stashHeroForEdit();
      }
      setManualReadyToSave(false);
      const bypass = opts?.bypassSlotGuards === true;
      setBuilderItems((prev) => {
        let next =
          evictIds.length > 0
            ? prev.filter((p) => !evictIds.includes(p.id))
            : [...prev];
        // Guard against duplicate item inserts from rapid repeated actions.
        if (next.some((p) => p.id === incoming.id)) {
          Haptics.selectionAsync();
          return next.map((p, i) => ({ ...p, slot: i }));
        }
        if (next.length >= MAX_FIT_BUILDER_PIECES) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return prev;
        }
        if (!bypass) {
          if (isShoeItem(incoming)) {
            const shoesLeft = next.filter((p) => isShoeItem(p)).length;
            if (shoesLeft >= 1) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
          }
          if (isOuterItem(incoming)) {
            const outersLeft = next.filter((p) => isOuterItem(p)).length;
            if (outersLeft >= MAX_OUTER_LAYERS) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
          }
          if (isDressLike(incoming)) {
            const layerOverlap = next.some(
              (p) => isDressLike(p) || isTopLike(p) || isBottomLike(p),
            );
            if (layerOverlap) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
          }
          if (isBagItem(incoming)) {
            const bagsLeft = next.filter((p) => isBagItem(p)).length;
            if (bagsLeft >= 1) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
          }
          if (isBottomLike(incoming)) {
            if (next.some((p) => isDressLike(p))) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
            const bottomsLeft = next.filter((p) => isBottomLike(p)).length;
            if (bottomsLeft >= MAX_BOTTOM_LAYERS) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
          }
          if (isTopLike(incoming)) {
            if (next.some((p) => isDressLike(p))) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
            const topsLeft = next.filter((p) => isTopLike(p)).length;
            if (topsLeft >= MAX_TOP_LAYERS) {
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              );
              return prev;
            }
          }
        }
        const merged = [...next, { ...incoming, slot: next.length }];
        const seen = new Set<string>();
        return merged
          .filter((p) => {
            if (seen.has(p.id)) return false;
            seen.add(p.id);
            return true;
          })
          .map((p, i) => ({ ...p, slot: i }));
      });
      if (manualCategoryRef.current !== IN_FIT_CHIP) {
        setThisFitPulseToken((t) => t + 1);
      }
    },
    [builderItems, pushHistory, tryOnRendering, stashHeroForEdit, guardTryOnResultEdit, editingTryOnLook],
  );

  /** Replace one builder piece with another, keeping canvas order. */
  const commitItemSwap = useCallback(
    (swapOutId: string, incoming: ClosetItem) => {
      if (tryOnRendering) return;
      if (guardTryOnResultEdit()) return;
      pushHistory(builderItems);
      if (!editingTryOnLook) {
        stashHeroForEdit();
      }
      setManualReadyToSave(false);
      setBuilderItems((prev) => {
        const swapIdx = prev.findIndex((p) => p.id === swapOutId);
        if (swapIdx < 0) return prev;
        const without = prev.filter(
          (p) => p.id !== swapOutId && p.id !== incoming.id,
        );
        const insertAt = Math.min(swapIdx, without.length);
        const next = [...without];
        next.splice(insertAt, 0, { ...incoming, slot: insertAt });
        return next.map((p, i) => ({ ...p, slot: i }));
      });
      if (manualCategoryRef.current !== IN_FIT_CHIP) {
        setThisFitPulseToken((t) => t + 1);
      }
      setManualCategory(IN_FIT_CHIP);
      setClosetBrowseCategory(null);
    },
    [builderItems, pushHistory, tryOnRendering, stashHeroForEdit, guardTryOnResultEdit, editingTryOnLook],
  );

  const handlePickItemManual = (id: string) => {
    if (autoLooksSummary.generating) return;
    if (tryOnRendering) return;
    if (guardTryOnResultEdit()) return;

    const swapOutId = pendingSwapItemIdRef.current;
    if (swapOutId) {
      const item = closetItems.find((c) => c.id === id);
      if (!item) return;
      if (id === swapOutId) {
        pendingSwapItemIdRef.current = null;
        return;
      }
      pendingSwapItemIdRef.current = null;
      const roster = builderItems.filter((p) => p.id !== swapOutId);
      if (roster.some((p) => p.id === id)) {
        pushHistory(builderItems);
        if (!editingTryOnLook) {
          stashHeroForEdit();
        }
        setManualReadyToSave(false);
        setBuilderItems((prev) =>
          prev
            .filter((p) => p.id !== swapOutId)
            .map((p, i) => ({ ...p, slot: i })),
        );
        setManualCategory(IN_FIT_CHIP);
        setClosetBrowseCategory(null);
        return;
      }
      const conflict = detectConflict(item, roster);
      if (conflict) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setPendingConflict({ incoming: item, swapOutId, ...conflict });
        return;
      }
      Haptics.selectionAsync();
      commitItemSwap(swapOutId, item);
      return;
    }

    const item = closetItems.find((c) => c.id === id);
    // Toggle off
    if (!item || builderItems.find((p) => p.id === id)) {
      pushHistory(builderItems);
      if (!editingTryOnLook) {
        stashHeroForEdit();
      }
      setManualReadyToSave(false);
      setBuilderItems((prev) =>
        prev.find((p) => p.id === id)
          ? prev.filter((p) => p.id !== id).map((p, i) => ({ ...p, slot: i }))
          : prev,
      );
      return;
    }
    // Cap
    if (builderItems.length >= MAX_FIT_BUILDER_PIECES) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    const conflict = detectConflict(item, builderItems);
    if (conflict) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setPendingConflict({ incoming: item, ...conflict });
      return;
    }
    commitItemAdd(item);
  };

  /** Scroll collapsed strip carousel so `itemId` is centered under `chip`. */
  const scrollStripToFocusedItem = useCallback(
    (animated: boolean) => {
      const req = stripFocusRequestRef.current;
      if (!req) return false;
      const stripItems = stripItemsForCategoryChip(
        req.chip,
        scopedClosetItems,
        builderItems,
      );
      const idx = stripItems.findIndex((it) => it.id === req.itemId);
      if (idx < 0) return false;
      const tileStep = MANUAL_STRIP_TILE.w + 10;
      const targetX = Math.max(
        0,
        MANUAL_STRIP_EDGE_INSET +
          idx * tileStep -
          (screenWidth - MANUAL_STRIP_TILE.w) / 2,
      );
      manualStripRef.current?.scrollToOffset({
        offset: targetX,
        animated,
      });
      return true;
    },
    [scopedClosetItems, builderItems, screenWidth],
  );

  const focusItemInCategoryStrip = useCallback(
    (itemId: string, chip: string) => {
      stripFocusRequestRef.current = { itemId, chip };
      [0, 80, 200, 450, 650].forEach((delayMs) => {
        setTimeout(() => {
          if (scrollStripToFocusedItem(delayMs >= 80)) {
            stripFocusRequestRef.current = null;
          }
        }, delayMs);
      });
    },
    [scrollStripToFocusedItem],
  );

  useEffect(() => {
    const req = stripFocusRequestRef.current;
    if (!req || manualCategory !== req.chip) return;
    if (!scrollStripToFocusedItem(false)) return;
    stripFocusRequestRef.current = null;
  }, [manualCategory, filteredManualItems, scrollStripToFocusedItem]);

  const handleSelectSlotFromCanvas = useCallback(
    (itemId: string) => {
      if (tryOnRendering) return;
      if (guardTryOnResultEdit()) return;
      Haptics.selectionAsync();

      const item =
        builderItems.find((it) => it.id === itemId) ??
        closetItems.find((it) => it.id === itemId);
      if (!item) return;

      const targetChip = categoryChipForItem(item);
      const wasExpanded = manualExpanded;

      setManualCategory(targetChip);
      setClosetBrowseCategory(null);

      if (wasExpanded) {
        snapSheet(false);
      }

      focusItemInCategoryStrip(itemId, targetChip);
    },
    [
      builderItems,
      closetItems,
      manualExpanded,
      focusItemInCategoryStrip,
      snapSheet,
      tryOnRendering,
      guardTryOnResultEdit,
    ],
  );

  const beginItemSwap = useCallback(
    (item: BuilderItem) => {
      pendingSwapItemIdRef.current = item.id;
      const chip = categoryChipForItem(item);
      openClosetBrowseForChip(chip);
      focusItemInCategoryStrip(item.id, chip);
    },
    [openClosetBrowseForChip, focusItemInCategoryStrip],
  );

  const [exporting, setExporting] = useState(false);

  const handleExportHero = async () => {
    if (!heroImageUri || exporting) return;
    setExporting(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const captureRefFn = tryGetCaptureRef();

    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (!captureRefFn) {
        await shareHeroImage(heroImageUri, {
          dialogTitle: "Share your look",
        });
        return;
      }

      if (preparedExportKeyRef.current !== exportShareKey) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            fitShareHeroDecodedRef.current = null;
            reject(new Error("Branded card: hero image timed out."));
          }, 14000);
          fitShareHeroDecodedRef.current = () => {
            clearTimeout(t);
            fitShareHeroDecodedRef.current = null;
            resolve();
          };
        });
      }

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      if (!exportViewRef.current) {
        throw new Error("Share card not ready");
      }

      const tmpUri = await captureRefFn(exportViewRef, {
        format: FIT_SHARE_CAPTURE_FORMAT,
        quality: FIT_SHARE_CAPTURE_QUALITY,
        result: "tmpfile",
        width: FIT_SHARE_CAPTURE_OUT_W,
        height: FIT_SHARE_CAPTURE_OUT_H,
        ...(Platform.OS === "android"
          ? {
              fileName: `myootd-share-${Date.now()}`,
              handleGLSurfaceViewOnAndroid: true,
            }
          : { useRenderInContext: true }),
      });

      await shareHeroImage(tmpUri, {
        dialogTitle: "Share your look",
        mimeType: FIT_SHARE_CAPTURE_MIME,
      });
    } catch (e) {
      console.error("[export] branded share failed", e);
      try {
        await shareHeroImage(heroImageUri, {
          dialogTitle: "My myOOTD Fit",
        });
      } catch {
        Alert.alert("Share failed", "Could not prepare or share your image.");
      }
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    onManualExpandedChange?.(manualExpanded);
  }, [manualExpanded, onManualExpandedChange]);

  useEffect(() => {
    if (!manualExpanded) setClosetToolbarExpanded(false);
  }, [manualExpanded]);

  /** Convert a remote or local image URL to base64. */
  const urlToBase64 = async (url: string): Promise<string | undefined> => {
    try {
      if (url.trim().startsWith("data:image")) {
        const idx = url.indexOf("base64,");
        if (idx !== -1) return url.slice(idx + 7) || undefined;
      }
      const resp = await fetch(url);
      if (!resp.ok) return undefined;
      const buf = await resp.arrayBuffer();
      return arrayBufferToBase64(buf);
    } catch {
      return undefined;
    }
  };

  const proceedTryOnPicker = useCallback(() => {
    tryOnDismissResolveRef.current = null;
    tryOnClosingRef.current = false;

    runOnUI((stripMin: number) => {
      "worklet";
      closetCrossfadeOpacity.value = 0;
      tryOnRailOpacity.value = 1;
      tryOnEntryOpacity.value = 1;
      tryOnDismissOpacity.value = 1;
      islandOpacity.value = 1;
      minSheet.value = stripMin;
      sheetH.value = stripMin;
    })(stableCompactMinPx);

    setTryOnSessionActive(true);
    setTryOnPickerActive(true);
    setTryOnTarget("mannequin");
  }, [
    stableCompactMinPx,
    minSheet,
    sheetH,
    islandOpacity,
    tryOnEntryOpacity,
    tryOnRailOpacity,
    tryOnDismissOpacity,
    closetCrossfadeOpacity,
  ]);

  const runTryOnGeneration = useCallback(
    async (opts: {
      mode: "mannequin" | "selfie";
      selfieUrl?: string | null;
    }) => {
      if (builderItems.length === 0) return;
      const outfitForRender = builderItems.map((item) => ({ ...item }));
      // A reset/landing mid-render bumps the token; every await below must
      // re-check it before touching state (stale render must die silently —
      // resetBuilderState already restored generationPhase etc.).
      const genToken = ++tryOnGenTokenRef.current;
      const isStale = () => tryOnGenTokenRef.current !== genToken;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setGenerationPhase("rendering");
      setManualCategory(IN_FIT_CHIP);
      await animateTryOnDismiss();
      requestAnimationFrame(() => {
        manualStripRef.current?.scrollToOffset({ offset: 0, animated: true });
      });

      let tryOnGenId: string | null = null;
      if (userId) {
        const { data } = await supabase
          .from("generation_history")
          .insert({
            user_id: userId,
            item_ids: outfitForRender.map((i) => i.id),
            image_url: null,
          })
          .select("id")
          .single();
        if (isStale()) return;
        tryOnGenId = data?.id ?? null;
        if (tryOnGenId) setCurrentGenerationId(tryOnGenId);
      }

      try {
        let base64: string | undefined;
        if (opts.mode === "selfie") {
          const url = opts.selfieUrl ?? bodyPhotoUrl;
          if (url) base64 = await urlToBase64(url);
        }

        const maxRefs = base64 ? 2 : 3;
        const refItems = pickTryOnGarmentReferenceItems(outfitForRender, maxRefs);
        const garmentReferenceImages: {
          base64: string;
          mime_type: string;
          label: string;
        }[] = [];
        for (const it of refItems) {
          const u = garmentImageUrl(it);
          if (!u) continue;
          const b64 = await urlToBase64(u);
          if (!b64) continue;
          garmentReferenceImages.push({
            base64: b64,
            mime_type: "image/jpeg",
            label: tryOnGarmentRefLabel(it) || "piece",
          });
        }

        const occ =
          OCC_LABEL[selectedOccasionId ?? ""] ?? selectedOccasionId ?? "casual";
        const tryOnBackdropHex =
          opts.mode === "mannequin"
            ? TRY_ON_GENERATION_MATTE_HEX
            : Colors.fitsBuilderCanvas;
        const renderUri = await apiClient.generateOutfitImage({
          occasion: occ,
          backdropHex: tryOnBackdropHex,
          bodyPhotoBase64: base64,
          mannequinStudioWhite: opts.mode === "mannequin",
          mannequinGender: resolveMannequinGender(genderPref),
          garmentReferenceImages,
          outfitItems: outfitForRender.map((m) => ({
            id: m.id,
            brand: m.brand ?? undefined,
            name: m.name ?? undefined,
            color: m.color ?? undefined,
            category: m.category ?? undefined,
            type: m.type ?? undefined,
            style: m.style ?? undefined,
          })),
        });
        if (isStale()) return;

        if (!renderUri) {
          throw new Error("Could not render the try-on. Please try again.");
        }
        {
          // Full-body cutout (Fits pipeline) — NOT segmentItems (garment blobs clip legs).
          // Mannequin renders use the known flat backdrop color (deterministic
          // chroma key) instead of person-segmentation ML, which can punch
          // holes through a synthetic figure it doesn't recognize as human.
          let cutoutUri: string | null = null;
          try {
            const dataUriForSegment = renderUri.startsWith("data:")
              ? renderUri
              : null;
            if (dataUriForSegment) {
              const b64 = dataUriForSegment.replace(
                /^data:image\/\w+;base64,/,
                "",
              );
              const matteCutout =
                await removeGeneratedTryOnBackgroundFromJpeg(
                  b64,
                  tryOnBackdropHex,
                );
              cutoutUri = matteCutout;
            }
          } catch (segErr) {
            console.warn(
              "[runTryOnGeneration] segmentation failed",
              segErr,
            );
          }

          if (isStale()) return;
          if (!cutoutUri) {
            throw new Error(
              "Could not remove the try-on background. Please try again.",
            );
          }
          const resultUri = cutoutUri;
          setHeroImageUri(resultUri);

          // Update the generation history with the try-on result. Upload the
          // local cutout to storage first — recording the raw file:// path
          // leaves a dead image in the generations strip after restart.
          if (userId && tryOnGenId && resultUri) {
            void (async () => {
              const persistedUrl = resultUri.startsWith("http")
                ? resultUri
                : await persistHeroImageUrl(supabase, userId, resultUri);
              if (!persistedUrl) return;
              await supabase
                .from("generation_history")
                .update({ try_on_image_url: persistedUrl })
                .eq("id", tryOnGenId);
            })();
          }

          snapSheet(false);
        }
        setGenerationPhase("idle");
        setManualReadyToSave(true);
        setFitName(
          resolveFitTitle(outfitForRender, fitNameRef.current, {
            occasion: selectedOccasionId,
            occasionLabel: autoGenSessionRef.current?.occasionPhrase ?? null,
          }),
        );
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e: unknown) {
        if (isStale()) return;
        setGenerationPhase("idle");
        showPillNotice(formatGeminiUserMessage(e), "error");
      }
    },
    [
      animateTryOnDismiss,
      builderItems,
      bodyPhotoUrl,
      genderPref,
      selectedOccasionId,
      snapSheet,
      userId,
      showPillNotice,
    ],
  );

  const uploadTryOnSelfie = useCallback(async () => {
    try {
      /** No crop UI — use the photo as chosen; try-on uses this image + canvas outfit at Generate. */
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 1,
        // base64 dropped here — only the manipulated (resized) output below
        // is actually used for upload; requesting it on the full-res
        // original just wasted time before the loading tile could show.
      });
      if (result.canceled) return;
      const img = result.assets[0]!;

      setUploadingSelfie(true); // loading tile shows in the row immediately

      /** iOS often returns ph:// / HEIC URIs that `fetch` cannot read — normalize to JPEG on disk first. */
      let readUri = img.uri;
      let finalBase64: string | undefined;
      try {
        const normalized = await ImageManipulator.manipulateAsync(
          readUri,
          [{ resize: { width: 1024 } }],
          {
            compress: 0.88,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );
        readUri = normalized.uri;
        finalBase64 = normalized.base64 ?? undefined;
      } catch (normErr) {
        console.warn(
          "[uploadTryOnSelfie] normalize failed — trying original URI",
          normErr,
        );
        readUri = img.uri;
        try {
          finalBase64 = await uriToBase64(img.uri);
        } catch (readErr) {
          console.warn("[uploadTryOnSelfie] raw read failed too", readErr);
        }
      }

      // Show local image immediately so the user doesn't see a white box while uploading
      setTryOnSelfieUrls((prev) => mergeSelfieUrls(readUri, prev));
      setTryOnTarget({ kind: "selfie", url: readUri });
      setUploadingSelfie(false);

      let bufferToUpload: ArrayBuffer | null = null;
      let contentType = "image/jpeg";
      let extGuess = "jpg";

      if (finalBase64) {
        const mime = img.mimeType?.startsWith("image/")
          ? img.mimeType
          : "image/jpeg";
        // If the original image was PNG and not manipulated, respect the mime type
        extGuess = mime.includes("png")
          ? "png"
          : mime.includes("webp")
            ? "webp"
            : "jpg";
        const parsed = parseOutfitDataUri(`data:${mime};base64,${finalBase64}`);
        if (parsed) {
          bufferToUpload = parsed.buffer;
          contentType = parsed.contentType;
        }
      }

      if (!bufferToUpload) {
        showPillNotice("Could not read that photo.", "error");
        return;
      }

      const fileName = `${user?.id ?? "anon"}/body_${Date.now()}.${extGuess}`;
      const { error: storageError } = await supabase.storage
        .from("clothing-images")
        .upload(fileName, bufferToUpload, {
          contentType,
          upsert: true,
        });
      if (storageError) {
        console.warn("[uploadTryOnSelfie] storage", storageError);
        showPillNotice(
          storageError.message?.includes("JWT") ||
            storageError.message?.toLowerCase().includes("policy")
            ? "Sign in to upload photos."
            : "Could not upload that photo. Try again.",
          "error",
        );
        return;
      }
      const {
        data: { publicUrl },
      } = supabase.storage.from("clothing-images").getPublicUrl(fileName);

      // Prefetch the new public URL so it's already in the cache when we swap the state
      await Image.prefetch(publicUrl);

      setTryOnSelfieUrls((prev) => {
        const replaced = prev.map((u) => (u === readUri ? publicUrl : u));
        const merged = mergeSelfieUrls(null, replaced);
        void persistSelfies(user?.id, merged);
        return merged;
      });
      setTryOnTarget({ kind: "selfie", url: publicUrl });

      if (user?.id) {
        await supabase.from("profiles").upsert(
          {
            user_id: user.id,
            body_photo_url: publicUrl,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
        setBodyPhotoUrl(publicUrl);
      }
    } catch (e) {
      console.warn("[uploadTryOnSelfie]", e);
      setUploadingSelfie(false);
      showPillNotice(
        e instanceof Error && e.message.length < 140
          ? e.message
          : "Could not use that photo.",
        "error",
      );
    }
  }, [user?.id, showPillNotice]);

  const handleSelfieLongMenu = useCallback((url: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelfieToDelete(url);
  }, []);

  const handleConfirmDeleteSelfie = useCallback(async () => {
    if (!selfieToDelete || !user?.id) return;
    const url = selfieToDelete;
    try {
      const result = await removeSelfiePhotoFromLibrary(
        supabase,
        user.id,
        url,
        tryOnSelfieUrls,
      );
      setTryOnSelfieUrls(result.nextUrls);
      setBodyPhotoUrl(result.nextUrls[0] ?? null);
      setTryOnTarget((target) =>
        target !== "mannequin" && target.kind === "selfie" && target.url === url
          ? "mannequin"
          : target,
      );
      DeviceEventEmitter.emit(PROFILE_PREFERENCES_UPDATED_EVENT);
      setSelfieToDelete(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.warn("[BuilderPanel] try-on photo removal failed", error);
      showPillNotice("Could not remove that photo. Try again.", "error");
    }
  }, [selfieToDelete, showPillNotice, tryOnSelfieUrls, user?.id]);

  const handleGenerateTryOn = useCallback(() => {
    if (generationPhase !== "idle") return;
    setSavedToLibrary(null);
    if (tryOnTarget === "mannequin") {
      void runTryOnGeneration({ mode: "mannequin" });
    } else {
      void runTryOnGeneration({
        mode: "selfie",
        selfieUrl: tryOnTarget.url,
      });
    }
  }, [generationPhase, tryOnTarget, runTryOnGeneration]);

  /** Edit a finished try-on: reveal the editable builder, keep the render stashed. */
  const beginEditTryOnLook = useCallback(() => {
    if (tryOnRendering) return;
    Haptics.selectionAsync();
    setSavedToLibrary(null);
    pausedHeroRef.current = heroImageUri;
    pausedBuilderItemsRef.current = builderItems.map((item) => ({ ...item }));
    setEditingTryOnLook(true);
    setHeroImageUri(null);
    setManualCategory(IN_FIT_CHIP);
    requestAnimationFrame(() => {
      manualStripRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
  }, [builderItems, heroImageUri, tryOnRendering]);

  /** Discard edits and snap back to the render we stashed. */
  const cancelEditTryOnLook = useCallback(() => {
    if (tryOnRendering) return;
    Haptics.selectionAsync();
    setEditingTryOnLook(false);
    if (pausedBuilderItemsRef.current) {
      setBuilderItems(pausedBuilderItemsRef.current);
    }
    if (pausedHeroRef.current) setHeroImageUri(pausedHeroRef.current);
    pausedBuilderItemsRef.current = null;
    pausedHeroRef.current = null;
  }, [tryOnRendering]);

  /** Re-run try-on on the edited pieces (reuses the last chosen model/selfie). */
  const rerenderTryOnLook = useCallback(() => {
    if (tryOnRendering) return;
    pausedHeroRef.current = null;
    pausedBuilderItemsRef.current = null;
    setEditingTryOnLook(false);
    void handleGenerateTryOn();
  }, [handleGenerateTryOn, tryOnRendering]);

  const tryOnCarouselProps = useMemo(
    () => ({
      compactStripHeight: STRIP_BODY_FIXED_H,
      compactTileHeight: TRY_ON_STRIP_TILE.h,
      compactTileWidth: TRY_ON_STRIP_TILE.w,
      compactBottomInset: TRY_ON_STRIP_BOTTOM_INSET,
      compactBackgroundColor: "transparent",
      selfieUrls: tryOnSelfieUrls,
      pendingSelfie: uploadingSelfie,
      selected: tryOnTarget,
      onClose: () => {
        if (tryOnRendering) return;
        exitTryOnSession();
      },
      onSelectMannequin: () => {
        if (tryOnRendering) return;
        setTryOnTarget("mannequin");
        void Haptics.selectionAsync();
      },
      onSelectSelfie: (url: string) => {
        if (tryOnRendering) return;
        setTryOnTarget({ kind: "selfie", url });
        void Haptics.selectionAsync();
      },
      onAddSelfie: () => {
        if (tryOnRendering) return;
        void uploadTryOnSelfie();
      },
      onSelfieLongMenu: (url: string) => {
        if (tryOnRendering) return;
        handleSelfieLongMenu(url);
      },
      onGenerate: handleGenerateTryOn,
      generating: generationPhase !== "idle",
    }),
    [
      tryOnSelfieUrls,
      uploadingSelfie,
      tryOnTarget,
      uploadTryOnSelfie,
      handleSelfieLongMenu,
      handleGenerateTryOn,
      generationPhase,
      tryOnRendering,
      exitTryOnSession,
    ],
  );

  const handleTryOn = useCallback(() => {
    if (tryOnRendering) return;
    if (autoBuilderSheetActive) {
      // Close config panel but preserve any existing looks
      setAutoBuilderSheetActive(false);
    }
    if (builderItems.length === 0) return;
    const readiness = getTryOnReadiness(builderItems);
    if (!readiness.ok) {
      if (readiness.reason === "accessories_only") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setTryOnSparseModalVisible(true);
        return;
      }
      return;
    }
    proceedTryOnPicker();
  }, [builderItems, proceedTryOnPicker, autoBuilderSheetActive, tryOnRendering]);

  const uploadHeroForOutfit = async (
    uri: string | null,
  ): Promise<string | null> => {
    if (!uri || !userId) return null;
    if (uri.startsWith("http")) return uri;
    if (!uri.startsWith("data:")) return null;
    const parts = parseOutfitDataUri(uri);
    if (!parts) return null;
    const ext = parts.contentType.includes("png") ? "png" : "jpg";
    const fileName = `${userId}/outfit_${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("clothing-images")
      .upload(fileName, parts.buffer, {
        contentType: parts.contentType,
        upsert: true,
      });
    if (error) return null;
    const {
      data: { publicUrl },
    } = supabase.storage.from("clothing-images").getPublicUrl(fileName);
    return publicUrl;
  };

  const resetAfterSave = () => {
    setBuilderItems([]);
    setSelectedOccasionId(null);
    setPlannedDate(null);
    setFitName("");
    setManualReadyToSave(false);
    setLayoutVariant(0);
    setAutoBuilderSheetActive(false);
    setAutoBuilderSeedIds([]);
    setAutoLooksSummary({ looks: [], generating: false });
    autoOutfitSessionActiveRef.current = false;
    setAutoOutfitSessionActive(false);
    autoGenSessionRef.current = null;
    setAutoBuilderFormSeed(null);
    setAnchoredCanvasItemIds([]);
    setEditingLookIndex(null);
    editingLookSnapshotRef.current = null;
    setEditingOutfitId(null);
    setEditTargetWasUnsaved(false);
    clearRender();
  };

  const handleSave = async (overrides?: {
    items?: BuilderItem[];
    hero?: string | null;
    /** Save from Done warning — animate save, then return to manual builder. */
    completeTryOnExit?: boolean;
    /** Editing an existing look: create a separate saved copy instead. */
    saveAsNew?: boolean;
  }) => {
    const items = overrides?.items ?? builderItems;
    const hero = overrides?.hero !== undefined ? overrides.hero : heroImageUri;
    const editTargetId = overrides?.saveAsNew ? null : activeEditId;
    if (savingRef.current) return;
    if (!userId) {
      showPillNotice("Sign in to save looks", "error");
      return;
    }
    if (items.length === 0) {
      showPillNotice("Add pieces before saving", "hint");
      return;
    }
    if (items.some((i) => i.id.startsWith("dev-"))) {
      showPillNotice("Swap demo pieces for real closet items to save", "hint");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    savingRef.current = true;
    setSaving(true);
    try {
      const occ = occasionForSave();
      const occasionLabel = autoGenSessionRef.current?.occasionPhrase ?? null;
      const itemIds = dedupeOrderedIds(items.map((i) => i.id));
      // Every hero this builder ever shows is a try-on style render (generated,
      // Style Me, or landed from an automation). Keying this off
      // tryOnSessionActive let a save AFTER Done skip the cutout upload and
      // leave the raw flat-backdrop automation render as the library image.
      const isTryOnSave = !!hero;
      const refreshTryOnHero = isTryOnSave;
      const baseline = editBaselineItemIdsRef.current;
      const piecesChanged =
        baseline != null &&
        outfitItemSignature(baseline) !== outfitItemSignature(itemIds);
      const piecesChangedHint =
        baseline != null ? piecesChanged : undefined;
      const persistHero = editTargetId && !isTryOnSave ? null : hero;

      // Replace the old opaque automation URL in the mounted Library state
      // immediately. The durable save below waits for this local transparent
      // PNG to upload before exposing the row, but this also prevents a cached
      // tile/detail screen behind the builder from holding the raw render.
      if (editTargetId && persistHero?.startsWith("file:")) {
        onFitUpdated?.(editTargetId, {
          try_on_image_url: persistHero,
          image_url: persistHero,
          try_on_stale: false,
        });
      }

      const wearLogIso = wornOnIso?.trim();
      const logWearOnSave =
        !dayContextDismissed &&
        !editTargetId &&
        wearLogIso &&
        /^\d{4}-\d{2}-\d{2}$/.test(wearLogIso) &&
        !isoDayIsStrictlyFuture(wearLogIso);

      const saveTitle = resolveFitTitle(items, fitName, {
        occasion: occ,
        occasionLabel,
      });

      let outfitId: string;
      let tryOnStale: boolean | undefined;

      if (editTargetId) {
        const updated = await updateOutfit({
          supabase,
          userId,
          outfitId: editTargetId,
          itemIds,
          name: saveTitle,
          occasion: occ,
          occasionLabel,
          heroImageUri: persistHero,
          isTryOnResult: refreshTryOnHero,
          piecesChanged: piecesChangedHint,
          refreshTryOnHero,
          savedToLibrary: true,
          onHeroAttached: (url: string | null) => {
            if (url) {
              onFitUpdated?.(editTargetId, {
                try_on_image_url: url,
                image_url: url,
                try_on_stale: false,
              });
            }
            void onSavedFit();
          },
        });
        outfitId = updated.outfitId;
        tryOnStale = updated.tryOnStale;
        editBaselineItemIdsRef.current = itemIds;
      } else {
        const created = await saveOutfit({
          supabase,
          userId,
          itemIds,
          name: saveTitle,
          occasion: occ,
          occasionLabel,
          source: autoOutfitSessionActive ? "ai" : "manual",
          heroImageUri: hero,
          isTryOnResult: isTryOnSave,
          markAsWornToday: false,
          wornOnIso: logWearOnSave ? wearLogIso : null,
          plannedDateIso: logWearOnSave || dayContextDismissed
            ? null
            : plannedDate
              ? formatLocalDateIso(plannedDate)
              : null,
          onHeroAttached: () => {
            void onSavedFit();
          },
        });
        outfitId = created.outfitId;
      }

      if (editTargetId) {
        onFitUpdated?.(outfitId, {
          item_ids: itemIds,
          try_on_stale: refreshTryOnHero ? false : !!tryOnStale,
          ...(refreshTryOnHero && persistHero?.startsWith("http")
            ? {
                try_on_image_url: persistHero,
                image_url: persistHero,
              }
            : {}),
        });
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (isTryOnSave) {
        if (overrides?.completeTryOnExit) {
          await onSavedFit();
          completeTryOnExitAfterSave(items.length);
        } else {
          setSavedToLibrary({ outfitId, itemIds });
          showSavedToLibraryNotice(
            outfitId,
            overrides?.saveAsNew ? "Saved" : persistLookDone,
          );
          if (editTargetId) {
            void onSavedFit();
          } else {
            await onSavedFit();
          }
        }
      } else {
        showSavedToLibraryNotice(
          outfitId,
          overrides?.saveAsNew ? "Saved" : persistLookDone,
        );
        if (!editTargetId) {
          resetAfterSave();
          endTryOnSessionInternal();
          await onSavedFit();
        } else {
          void onSavedFit();
        }
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" &&
              err &&
              "message" in err &&
              typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : "";
      console.warn("[handleSave] save failed:", message || err);
      showPillNotice(message || "Could not save. Try again.", "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const requestSave = () => {
    if (!editingPreviouslySavedLook) {
      void handleSave();
      return;
    }
    Alert.alert(
      "Save this look",
      "Do you want to update the saved look or keep the original and save these changes as a new look?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save as new look",
          onPress: () => void handleSave({ saveAsNew: true }),
        },
        {
          text: "Update saved look",
          onPress: () => void handleSave(),
        },
      ],
    );
  };

  const handleTryOnExitSave = useCallback(async (saveAsNew = false) => {
    setTryOnExitModalVisible(false);
    const hero = heroImageUri ?? pausedHeroRef.current;
    const items =
      editingTryOnLook && pausedBuilderItemsRef.current
        ? pausedBuilderItemsRef.current
        : builderItems;
    setEditingTryOnLook(false);
    pausedHeroRef.current = null;
    pausedBuilderItemsRef.current = null;
    await handleSave({
      items,
      hero,
      completeTryOnExit: true,
      saveAsNew,
    });
  }, [editingTryOnLook, builderItems, heroImageUri, handleSave]);

  const handleTryOnExitSkip = useCallback(async () => {
    setTryOnExitModalVisible(false);
    const hero = heroImageUri ?? pausedHeroRef.current;
    const items =
      editingTryOnLook && pausedBuilderItemsRef.current
        ? pausedBuilderItemsRef.current
        : builderItems;
    if (hero) {
      await recordTryOnForLatest(
        hero,
        items.map((i) => i.id),
      );
      setBuilderItems(items.map((item, slot) => ({ ...item, slot })));
    }
    clearRender();
    setEditingTryOnLook(false);
    pausedHeroRef.current = null;
    pausedBuilderItemsRef.current = null;
    setManualReadyToSave(items.length > 0);
    endTryOnSessionInternal();
  }, [
    heroImageUri,
    editingTryOnLook,
    builderItems,
    recordTryOnForLatest,
    endTryOnSessionInternal,
  ]);

  /** Scroll padding so last closet row clears tab bar + glass bar (uses same chrome budget as canvas). */
  const sheetBottomPad = !manualExpanded ? 0 : bottomChromePad + 28;

  // The old AutoOutfitBuilder slide-up entry points (openAutoBuilder /
  // openAutoBuilderForEdit) were removed — Get Styled (openGetStyledComposer)
  // is the single entry point now, and nothing calls setAutoBuilderSheetActive
  // (true) anymore, so the legacy sheet never opens.

  /** Opens the NEW composer (prompt box) instead of the old AutoOutfitBuilder
   * config sheet — this is the "Get Styled" entry point now for every flow
   * that used to call openAutoBuilder/openAutoBuilderForEdit. Optionally
   * prefills the prompt + pinned pieces (Restart clears; Edit vibe/New setup
   * carry the current session's prompt+anchors over for tweaking). */
  const openGetStyledComposer = useCallback(
    (opts?: { prefillPrompt?: string; prefillAnchors?: string[] }) => {
      setGetStyledDraft(opts?.prefillPrompt?.trim() ?? "");
      setGetStyledAttachedItemIds(opts?.prefillAnchors ?? []);
      setGetStyledAttachMode(false);
      // Same sync UI-thread flip the real "Get styled" button does — keeps
      // the keyboard-lift math ready the instant the keyboard starts rising.
      getStyledPromptModeSv.value = true;
      getStyledKeyboardGuardSv.value = 1;
      setGetStyledPromptMode(true);
    },
    [getStyledPromptModeSv, getStyledKeyboardGuardSv],
  );

  const finalizeAutoBuilderExit = useCallback(() => {
    styleMeDismissCollapseRef.current = false;
    autoBuilderDismissingRef.current = false;
    setAutoBuilderDismissing(false);
    setAutoBuilderSheetActive(false);
    closetCrossfadeOpacity.value = 1;
    autoBuilderOpacity.value = 0;
    autoBuilderTranslateY.value = 0;
  }, [autoBuilderOpacity, autoBuilderTranslateY, closetCrossfadeOpacity]);

  finalizeAutoBuilderExitRef.current = finalizeAutoBuilderExit;

  useEffect(() => {
    autoBuilderDismissingRef.current = autoBuilderDismissing;
  }, [autoBuilderDismissing]);

  const closeAutoBuilder = useCallback(
    (keepGenerated = false) => {
      if (!keepGenerated) {
      clearRender();
      if (!autoOutfitSessionActiveRef.current) {
        setAutoLooksSummary({ looks: [], generating: false });
        setAutoLookIndex(0);
        setEditingLookIndex(null);
        editingLookSnapshotRef.current = null;
        setStyleMeScreenActive(false);
      }
      }

      if (autoBuilderDismissingRef.current) return;

      styleMeDismissCollapseRef.current = true;
      autoBuilderDismissingRef.current = true;
      closetCrossfadeOpacity.value = 1;
      setAutoBuilderDismissing(true);
      setAutoBuilderSheetActive(false);

      autoBuilderOpacity.value = 1;
      autoBuilderTranslateY.value = 0;

      const headerH =
        measuredClosetCollapsedPullHeaderH > 0
          ? measuredClosetCollapsedPullHeaderH
          : 38;
      const targetMin = headerH + collapsedStripBodyForMinPx;
      runOnUI((minVal: number) => {
        "worklet";
        minSheet.value = minVal;
        sheetH.value = withTiming(
          minVal,
          sheetTimingStyleMeDismiss,
          (finished) => {
            if (finished) runOnJS(collapseClosetSheet)();
          },
        );
      })(targetMin);

      requestAnimationFrame(() => Keyboard.dismiss());
    },
    [
      closetCrossfadeOpacity,
      clearRender,
      measuredClosetCollapsedPullHeaderH,
      collapsedStripBodyForMinPx,
      minSheet,
      sheetH,
      collapseClosetSheet,
    ],
  );

  const handleApplyAutoOutfit = useCallback(
    (p: ApplyOutfitPayload) => {
      if (styleMeDiscardedRef.current) return;
      clearRender();
      setBuilderItems((p.items || []).map((it, slot) => ({ ...it, slot })));
      setHeroImageUri(p.heroImageUri);
      setManualReadyToSave(!!p.heroImageUri);
      const name = (p.title || "").trim().slice(0, 72);
      setFitName(name || "My fit");
      setSelectedOccasionId(p.occasionId || "casual");
      setAnchoredCanvasItemIds(p.anchorItemIds ?? []);
      if (p.openCalendar) setCalendarOpen(true);
      if (p.fromAutoBuilder) {
        autoOutfitSessionActiveRef.current = true;
        setAutoOutfitSessionActive(true);
        setStyleMeScreenActive(true);
        autoGenSessionRef.current = {
          occasionPhrase: p.occasionLabelForTryOn,
          anchorItemIds: p.anchorItemIds ?? [],
          colorHarmony: p.colorHarmony ?? true,
          extraUserText: p.extraUserText,
          builderPrompt: p.builderPrompt ?? "",
          builderOccasionKey: p.builderOccasionKey ?? "daily",
        };
      }
      // Always close the builder after apply — no post-apply mini, LooksTray handles results.
      closeAutoBuilder(true);
    },
    [clearRender, closeAutoBuilder],
  );

  const dismissAutoBuilderKeepOutfit = useCallback(() => {
    closeAutoBuilder(true);
  }, [closeAutoBuilder]);

  const handleAutoLooksSummaryChange = useCallback(
    (payload: AutoLooksSummaryPayload) => {
      if (styleMeDiscardedRef.current) return;
      setAutoLooksSummary(payload);
      if (payload.generating) {
        if (!preStyleMeCanvasSnapshotRef.current) {
          preStyleMeCanvasSnapshotRef.current = {
            items: builderItemsRef.current.map((it, slot) => ({ ...it, slot })),
            heroImageUri: heroImageUriRef.current,
            anchoredCanvasItemIds: [...anchoredCanvasItemIdsRef.current],
            fitName: fitNameRef.current,
            selectedOccasionId: selectedOccasionIdRef.current,
            manualReadyToSave: manualReadyToSaveRef.current,
          };
        }
        setAutoLookIndex(0);
        setEditingLookIndex(null);
        setManualExpanded(false);
        closetCrossfadeOpacity.value = 1;
        setStyleMeScreenActive(true);
        const targetMin = stableCompactMinPx;
        runOnUI((minVal: number) => {
          "worklet";
          minSheet.value = minVal;
          sheetH.value = withTiming(minVal, sheetTimingCollapse);
        })(targetMin);
      }
    },
    [closetCrossfadeOpacity, stableCompactMinPx, minSheet, sheetH],
  );

  const clearStyleMeSession = useCallback(
    (opts?: { keepCanvas?: boolean; restorePreStyleMe?: boolean }) => {
      const keepCanvas = opts?.keepCanvas ?? false;
      const restorePreStyleMe = opts?.restorePreStyleMe ?? false;
      const snap = preStyleMeCanvasSnapshotRef.current;

      autoOutfitSessionActiveRef.current = false;
      autoGenSessionRef.current = null;
      editingLookSnapshotRef.current = null;
      setStyleMeScreenActive(false);
      setAutoOutfitSessionActive(false);
      setAutoBuilderSheetActive(false);
      setAutoBuilderDismissing(false);
      setAutoBuilderSeedIds([]);
      setAutoBuilderFormSeed(null);
      setAutoLooksSummary({ looks: [], generating: false });
      setAutoLookIndex(0);
      setEditingLookIndex(null);
      setSessionLooks([]);
      preStyleMeCanvasSnapshotRef.current = null;

      if (restorePreStyleMe && snap) {
        setBuilderItems(snap.items);
        setHeroImageUri(snap.heroImageUri);
        setAnchoredCanvasItemIds(snap.anchoredCanvasItemIds);
        setFitName(snap.fitName);
        setSelectedOccasionId(snap.selectedOccasionId);
        setManualReadyToSave(snap.manualReadyToSave);
      } else if (!keepCanvas) {
        setAnchoredCanvasItemIds([]);
        clearRender();
        setBuilderItems([]);
        setFitName("");
        setSelectedOccasionId(null);
        setManualReadyToSave(false);
      }

      snapSheet(false);
    },
    [clearRender, snapSheet],
  );

  const restartStyleMeSession = useCallback(() => {
    clearStyleMeSession();
    // Clean composer, not the old config sheet — a genuine blank slate.
    requestAnimationFrame(() => openGetStyledComposer());
  }, [clearStyleMeSession, openGetStyledComposer]);

  const discardStyleMeAndExit = useCallback(() => {
    void Haptics.selectionAsync();
    styleMeDiscardedRef.current = true;
    styleMeGenTokenRef.current += 1;
    autoBuildPanelRef.current?.cancelGeneration();

    const hasPreStyleMeSnap = !!preStyleMeCanvasSnapshotRef.current;
    clearStyleMeSession({
      restorePreStyleMe: hasPreStyleMeSnap,
      keepCanvas: !hasPreStyleMeSnap,
    });
  }, [clearStyleMeSession]);

  const exitStyleMeToManualBuild = useCallback(() => {
    if (autoLooksSummary.generating) {
      Alert.alert(
        "Still generating",
        "Get Styled is still running. Are you sure you want to go back?",
        [
          { text: "Keep going", style: "cancel" },
          {
            text: "Go back",
            style: "destructive",
            onPress: discardStyleMeAndExit,
          },
        ],
        { cancelable: true },
      );
      return;
    }

    if (styleMeScreenActive && autoLooksSummary.looks.length > 0) {
      Alert.alert(
        "Leave without choosing?",
        "Are you sure? If you don't choose a look, they'll all be lost.",
        [
          { text: "Stay", style: "cancel" },
          {
            text: "Go back",
            style: "destructive",
            onPress: discardStyleMeAndExit,
          },
        ],
        { cancelable: true },
      );
      return;
    }

    discardStyleMeAndExit();
  }, [
    autoLooksSummary.generating,
    autoLooksSummary.looks.length,
    discardStyleMeAndExit,
    styleMeScreenActive,
  ]);

  /** After loading pieces onto the canvas — show OOTD strip, not a stale category. */
  const focusClosetOnLoadedFit = useCallback(() => {
    setManualCategory(IN_FIT_CHIP);
    setManualSearch("");
    setClosetToolbarExpanded(false);
    setClosetBrowseCategory(null);
    snapSheet(false);
    requestAnimationFrame(() => {
      manualStripRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, [snapSheet]);

  /** Close the Get Styled composer (the X). Any pieces pinned to the prompt
   * are laid onto the manual canvas (merged with what's already there, no
   * duplicates) so they carry over instead of being discarded. */
  const handleCloseGetStyledComposer = useCallback(() => {
    void Haptics.selectionAsync();
    const attachedIds = [...getStyledAttachedItemIds];
    setGetStyledAttachMode(false);
    setGetStyledPromptMode(false);
    setGetStyledAttachedItemIds([]);
    setGetStyledDraft("");
    if (attachedIds.length === 0) return;

    setBuilderItems((prev) => {
      const existing = new Set(prev.map((it) => it.id));
      const additions = attachedIds
        .filter((id) => !existing.has(id))
        .map((id) => closetItems.find((it) => it.id === id))
        .filter((it): it is ClosetItem => !!it);
      if (additions.length === 0) return prev;
      return [...prev, ...additions].map((it, idx) => ({ ...it, slot: idx }));
    });
    setAnchoredCanvasItemIds((prev) => {
      const next = new Set(prev);
      attachedIds.forEach((id) => next.add(id));
      return [...next];
    });
    setManualReadyToSave(true);
    focusClosetOnLoadedFit();
  }, [getStyledAttachedItemIds, closetItems, focusClosetOnLoadedFit]);

  useImperativeHandle(
    ref,
    () => ({
      collapseCloset: () => {
        snapSheet(false);
      },
      clearOutfit: () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        resetBuilderState();
      },
      undoOutfit: () => {
        handleUndo();
      },
      redoOutfit: () => {
        handleRedo();
      },
      remixFit: (
        itemIds: string[],
        name?: string,
        occasion?: string,
        outfitId?: string,
      ) => {
        resetBuilderState();
        if (outfitId) setEditingOutfitId(outfitId);
        const items = itemIds
          .map((id) => closetItems.find((it) => it.id === id))
          .filter((it): it is ClosetItem => !!it);

        if (items.length > 0) {
          editBaselineItemIdsRef.current = items.map((it) => it.id);
          setBuilderItems(items.map((it, idx) => ({ ...it, slot: idx })));
          setAnchoredCanvasItemIds(items.map((it) => it.id));
          if (name) setFitName(name);
          if (occasion) setSelectedOccasionId(occasion);
          setManualReadyToSave(true);
          focusClosetOnLoadedFit();
        }
      },
      editSavedTryOn: (
        itemIds: string[],
        heroUri: string,
        name?: string,
        occasion?: string,
        outfitId?: string,
      ) => {
        resetBuilderState();
        const items = itemIds
          .map((id) => closetItems.find((it) => it.id === id))
          .filter((it): it is ClosetItem => !!it)
          .map((item, slot) => ({ ...item, slot }));

        if (outfitId) setEditingOutfitId(outfitId);
        setEditTargetWasUnsaved(false);
        editBaselineItemIdsRef.current = items.map((item) => item.id);
        setBuilderItems(items);
        setAnchoredCanvasItemIds(items.map((item) => item.id));
        if (name) setFitName(name);
        if (occasion) setSelectedOccasionId(occasion);
        setManualReadyToSave(items.length > 0);

        // This is the same state produced by beginEditTryOnLook: the render is
        // held off-canvas while pieces are editable, and Cancel restores both.
        pausedHeroRef.current = null;
        pausedBuilderItemsRef.current = items.map((item) => ({ ...item }));
        setHeroImageUri(null);
        setTryOnSessionActive(true);
        setEditingTryOnLook(true);
        setManualCategory(IN_FIT_CHIP);
        focusClosetOnLoadedFit();
        const prepToken = ++tryOnGenTokenRef.current;
        void prepareTryOnImageUri(heroUri, outfitId).then((preparedUri) => {
          if (tryOnGenTokenRef.current !== prepToken || !preparedUri) return;
          pausedHeroRef.current = preparedUri;
        });
      },
      loadGeneratedLook: (
        itemIds: string[],
        preview?: {
          tryOnSourceUri?: string | null;
          flatImageUri?: string | null;
          sourceId?: string | null;
        },
      ) => {
        resetBuilderState();
        const items = itemIds
          .map((id) => closetItems.find((it) => it.id === id))
          .filter((it): it is ClosetItem => !!it);

        if (items.length > 0) {
          setBuilderItems(items.map((it, idx) => ({ ...it, slot: idx })));
          setAnchoredCanvasItemIds(items.map((it) => it.id));
          focusClosetOnLoadedFit();
        }
        const flatImageUri = preview?.flatImageUri?.trim() || null;
        const tryOnSourceUri = preview?.tryOnSourceUri?.trim() || null;
        if (flatImageUri && !tryOnSourceUri) setHeroImageUri(flatImageUri);
        if (items.length > 0 || flatImageUri) setManualReadyToSave(true);
        if (tryOnSourceUri) {
          const prepToken = ++tryOnGenTokenRef.current;
          void prepareTryOnImageUri(
            tryOnSourceUri,
            preview?.sourceId,
          ).then((preparedUri) => {
            if (tryOnGenTokenRef.current !== prepToken || !preparedUri) return;
            setHeroImageUri(preparedUri);
            setManualReadyToSave(true);
          });
        }
      },
      exitStyleMeToManualBuild,
      closeTryOnPicker,
      exitTryOnSession,
      exitTryOnSessionQuiet,
    }),
    [
      snapSheet,
      resetBuilderState,
      handleUndo,
      handleRedo,
      closetItems,
      focusClosetOnLoadedFit,
      exitStyleMeToManualBuild,
      closeTryOnPicker,
      exitTryOnSession,
      exitTryOnSessionQuiet,
    ],
  );

  const consumeAutoBuilderFormSeed = useCallback(
    () => setAutoBuilderFormSeed(null),
    [],
  );

  const regenerateAutoOutfitSession = useCallback(
    async (opts?: { swapCategoryChip?: string; freshSession?: boolean }) => {
      if (styleMeDiscardedRef.current) return;
      const genToken = styleMeGenTokenRef.current;

      const sess = autoGenSessionRef.current;
      if (!sess || scopedClosetItems.length < 3) return;

      const replacingForSwap = !!opts?.swapCategoryChip;
      // freshSession (composer submit / Restart / New setup) always treats
      // this as a brand-new session, even if the closure's own
      // autoLooksSummary.looks is still stale from a session that hasn't
      // re-rendered away yet — otherwise this fell through to the
      // "appending" branch below, which never resets autoLookIndex/canvas,
      // leaving the carousel on whatever slide the OLD session left off on.
      const hadExistingLooks = opts?.freshSession
        ? false
        : autoLooksSummary.looks.length > 0;
      setManualExpanded(false);
      setStyleMeScreenActive(true);
      setAutoLooksSummary((prev) => ({ ...prev, generating: true }));
      runOnUI((minVal: number) => {
        "worklet";
        minSheet.value = minVal;
        sheetH.value = withTiming(minVal, sheetTimingCollapse);
      })(stableCompactMinPx);
      if (hadExistingLooks) {
        requestAnimationFrame(() => {
          looksTrayRef.current?.scrollToEnd(true);
        });
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        const swapChip = opts?.swapCategoryChip;
        const anchorIds = swapChip
          ? anchorsForCategorySwap(builderItems, swapChip, sess.anchorItemIds)
          : [...sess.anchorItemIds];
        const swapNote = swapChip
          ? `Replace only the ${swapChip} piece with a fresh pick from the closet; keep everything else cohesive.`
          : "";
        const extraMerged = [sess.extraUserText, swapNote]
          .filter(Boolean)
          .join(" ");
        const extraUserText = extraMerged || undefined;

        const weather = await fetchOptionalOpenMeteo();
        if (
          styleMeDiscardedRef.current ||
          styleMeGenTokenRef.current !== genToken
        ) {
          return;
        }
        const recentOutfitItemIds = userId
          ? await fetchRecentGeneratedItemIds(supabase, userId)
          : [];
        const raw = await generateAutoOutfitBatch({
          count: LOOK_BATCH_COUNT,
          occasionPhrase: sess.occasionPhrase,
          closetItems: scopedClosetItems,
          weather,
          anchorItemIds: anchorIds,
          colorHarmony: sess.colorHarmony,
          onlyCloset: true,
          extraUserText,
          genderStylePref: genderPref,
          styleArchetypes,
          recentOutfitItemIds,
        });
        if (
          styleMeDiscardedRef.current ||
          styleMeGenTokenRef.current !== genToken
        ) {
          return;
        }
        if (!raw.length) throw new Error("Couldn't create a look — try again.");
        // Rotation bookkeeping: record EVERY generated look (including the
        // alternatives the user never applies) so they can't repeat next batch.
        if (userId) {
          void recordStylistGeneration(
            supabase,
            userId,
            raw.map((o) => o.item_ids),
            "batch",
          );
        }
        const plans = raw.slice(0, LOOK_BATCH_COUNT);
        const summaries: {
          key: string;
          heroUri: string | null;
          title: string;
          reasoning?: string;
          itemIds: string[];
        }[] = [];

        const batchKey = Date.now();
        for (let i = 0; i < plans.length; i++) {
          const plan = plans[i]!;
          summaries.push({
            key: `look-${batchKey}-${i}`,
            heroUri: null,
            title:
              plan.title?.trim() ||
              `Look ${autoLooksSummary.looks.length + i + 1}`,
            reasoning: plan.reasoning,
            itemIds: plan.item_ids,
          });
        }

        const firstPlan = plans[0]!;
        const firstItems = idsToBuilderItems(firstPlan.item_ids, closetItems);
        const firstSummary = summaries[0]!;

        if (
          styleMeDiscardedRef.current ||
          styleMeGenTokenRef.current !== genToken
        ) {
          return;
        }

        if (!hadExistingLooks || replacingForSwap) {
          clearRender();
          setBuilderItems(firstItems.map((it, slot) => ({ ...it, slot })));
          setHeroImageUri(null);
          setManualReadyToSave(false);
          setFitName((firstSummary.title || "My fit").slice(0, 72));
          setAnchoredCanvasItemIds(sess.anchorItemIds);
          setAutoLookIndex(0);
        }

        setAutoLooksSummary((prev) => ({
          looks: replacingForSwap ? summaries : [...prev.looks, ...summaries],
          generating: false,
        }));

        if (!replacingForSwap && hadExistingLooks) {
          requestAnimationFrame(() => {
            looksTrayRef.current?.scrollToEnd(true);
          });
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        if (
          styleMeDiscardedRef.current ||
          styleMeGenTokenRef.current !== genToken
        ) {
          return;
        }
        const msg = formatGeminiUserMessage(e);
        setAutoLooksSummary((prev) => ({ ...prev, generating: false }));
        Alert.alert("Regenerate failed", msg);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      }
    },
    [
      autoLooksSummary.looks.length,
      builderItems,
      closetItems,
      scopedClosetItems,
      clearRender,
      genderPref,
      styleArchetypes,
      stableCompactMinPx,
      minSheet,
      sheetH,
    ],
  );

  const onAutoSessionSwapCategory = useCallback(
    (categoryChip: string) => {
      void regenerateAutoOutfitSession({ swapCategoryChip: categoryChip });
    },
    [regenerateAutoOutfitSession],
  );

  /** Composer "send" — turns the prompt (+ any pinned pieces) into a Get
   * Styled session and fires the same batch generator the old flow used, so
   * the LooksTray carousel + More/Edit pill machinery takes over unchanged.
   * Weather is folded in automatically (regenerateAutoOutfitSession fetches
   * it). */
  const handleGetStyledSubmit = useCallback(() => {
    if (autoLooksSummary.generating) return;
    const prompt = getStyledDraftValue.trim();
    const pinned = [...getStyledAttachedItemIds];
    if (!prompt && pinned.length === 0) {
      showPillNotice("Describe a look or pin a piece first", "hint");
      return;
    }
    if (scopedClosetItems.length < 3) {
      showPillNotice("Add a few more closet pieces to style", "hint");
      return;
    }

    // Snapshot the current canvas so exiting the session can restore it —
    // regenerateAutoOutfitSession replaces the board with the first look and
    // (unlike the panel flow) doesn't route through handleAutoLooksSummaryChange
    // where this snapshot normally happens.
    if (!preStyleMeCanvasSnapshotRef.current) {
      preStyleMeCanvasSnapshotRef.current = {
        items: builderItemsRef.current.map((it, slot) => ({ ...it, slot })),
        heroImageUri: heroImageUriRef.current,
        anchoredCanvasItemIds: [...anchoredCanvasItemIdsRef.current],
        fitName: fitNameRef.current,
        selectedOccasionId: selectedOccasionIdRef.current,
        manualReadyToSave: manualReadyToSaveRef.current,
      };
    }

    styleMeDiscardedRef.current = false;
    styleMeGenTokenRef.current += 1;
    autoOutfitSessionActiveRef.current = true;
    setAutoOutfitSessionActive(true);
    setStyleMeScreenActive(true);
    // Force a clean "initial generating" pill (styleMeInitialGenerating =
    // generating && looks.length === 0) regardless of any looks left over
    // from a prior session — otherwise this could fall through to the
    // results pill showing stale looks while the new batch is still coming.
    setAutoLooksSummary({ looks: [], generating: true });
    autoGenSessionRef.current = {
      occasionPhrase: prompt || "an everyday look",
      anchorItemIds: pinned,
      colorHarmony: true,
      extraUserText: prompt || undefined,
      builderPrompt: prompt,
      builderOccasionKey: "daily",
    };

    // Close the composer + keyboard; clear the draft/pins for next time.
    setGetStyledAttachMode(false);
    setGetStyledPromptMode(false);
    getStyledPromptModeSv.value = false;
    Keyboard.dismiss();
    setGetStyledDraft("");
    setGetStyledAttachedItemIds([]);

    void regenerateAutoOutfitSession({ freshSession: true });
  }, [
    autoLooksSummary.generating,
    getStyledAttachedItemIds,
    scopedClosetItems.length,
    showPillNotice,
    getStyledPromptModeSv,
    regenerateAutoOutfitSession,
  ]);

  const autoCarouselMode = useMemo((): "builder" | "session" => {
    if (autoOutfitSessionActive && !autoBuilderSheetActive) return "session";
    return "builder";
  }, [autoOutfitSessionActive, autoBuilderSheetActive]);

  const styleMeInitialGenerating =
    autoLooksSummary.generating && autoLooksSummary.looks.length === 0;
  const styleMeAppendingLooks =
    autoLooksSummary.generating && autoLooksSummary.looks.length > 0;

  useEffect(() => {
    onStyleMeModeChange?.(styleMeScreenActive);
  }, [styleMeScreenActive, onStyleMeModeChange]);

  useEffect(() => {
    onTryOnModeChange?.(tryOnSessionActive);
  }, [tryOnSessionActive, onTryOnModeChange]);

  useEffect(() => {
    const showRenderingNotice = () => {
      showPillNotice("Still rendering your look…", "hint");
    };
    setTryOnRenderNavigationGuard(tryOnRendering, showRenderingNotice);
    onTryOnRenderingChange?.(tryOnRendering);
    return () => {
      setTryOnRenderNavigationGuard(false);
      onTryOnRenderingChange?.(false);
    };
  }, [onTryOnRenderingChange, showPillNotice, tryOnRendering]);

  useEffect(() => {
    onCanvasHistoryChange?.({
      canUndo: historyStack.length > 0,
      canRedo: redoStack.length > 0,
    });
  }, [historyStack.length, redoStack.length, onCanvasHistoryChange]);

  useEffect(() => {
    if (
      !styleMeScreenActive ||
      !autoOutfitSessionActive ||
      autoBuilderSheetActive
    ) {
      setMoreLooksMenuOpen(false);
    }
  }, [styleMeScreenActive, autoOutfitSessionActive, autoBuilderSheetActive]);

  /** Drives which child renders in the strip slot. */
  type LooksMode = "closet" | "generating" | "results" | "editing";
  const looksMode = useMemo((): LooksMode => {
    if (editingLookIndex !== null) return "editing";
    if (!styleMeScreenActive) return "closet";
    if (styleMeInitialGenerating) return "generating";
    if (
      (autoOutfitSessionActive ||
        autoBuilderSheetActive ||
        autoBuilderDismissing ||
        styleMeAppendingLooks) &&
      autoLooksSummary.looks.length > 0
    )
      return "results";
    return "closet";
  }, [
    styleMeScreenActive,
    styleMeInitialGenerating,
    styleMeAppendingLooks,
    autoLooksSummary.looks.length,
    editingLookIndex,
    autoOutfitSessionActive,
    autoBuilderSheetActive,
    autoBuilderDismissing,
  ]);

  /** Collapsed strip UI — hide until sheet fully collapsed (prevents color flash on dismiss). */
  const stripCollapsedUi =
    !manualExpanded && !autoBuilderDismissing;

  const showClosetStrip =
    (looksMode === "closet" || looksMode === "editing" || editingTryOnLook) &&
    stripCollapsedUi &&
    !autoLooksSummary.generating;
  /** Skeleton strip while the first Get Styled batch loads — closet stays disabled. */
  const showGeneratingStrip =
    looksMode === "generating" && stripCollapsedUi;
  const showLooksStrip = looksMode === "results" && stripCollapsedUi;

  const autoCanvasLooks = useMemo<AutoCanvasLook[]>(() => {
    if (styleMeInitialGenerating) return [];
    return autoLooksSummary.looks
      .map((look) => ({
        key: look.key,
        title: look.title,
        items: idsToBuilderItems(look.itemIds ?? [], closetItems),
      }))
      .filter((look) => look.items.length > 0);
  }, [styleMeInitialGenerating, autoLooksSummary.looks, closetItems]);

  // Reset sessionLooks on every new batch (key changes) so stale edits never leak.
  const autoLooksKey = autoLooksSummary.looks.map((l) => l.key).join(",");
  useEffect(() => {
    if (autoCanvasLooks.length > 0) {
      setSessionLooks(
        autoCanvasLooks.map((l) =>
          l.items.map((it, slot) => ({ ...it, slot })),
        ),
      );
    } else {
      setSessionLooks([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLooksKey]);

  // Keep track of active look edits in sessionLooks
  useEffect(() => {
    if (
      autoOutfitSessionActive &&
      autoLookIndex >= 0 &&
      autoLookIndex < sessionLooks.length
    ) {
      const currentItems = sessionLooks[autoLookIndex];
      if (
        currentItems &&
        JSON.stringify(currentItems) !== JSON.stringify(builderItems)
      ) {
        setSessionLooks((prev) => {
          const next = [...prev];
          next[autoLookIndex] = builderItems;
          return next;
        });
      }
    }
  }, [builderItems, autoOutfitSessionActive, autoLookIndex, sessionLooks]);

  useEffect(() => {
    if (looksMode !== "results") return;
    looksTrayRef.current?.scrollToLookIndex(autoLookIndex, true);
  }, [autoLookIndex, looksMode]);

  const applyAutoLookAtIndex = useCallback(
    (index: number) => {
      const look = autoCanvasLooks[index];
      if (!look) return;
      setAutoLookIndex(index);
      clearRender();

      const cached = sessionLooks[index];
      if (cached && cached.length > 0) {
        setBuilderItems(cached);
      } else {
        setBuilderItems(look.items.map((it, slot) => ({ ...it, slot })));
      }

      setHeroImageUri(null);
      setManualReadyToSave(false);
      setFitName((look.title || "My fit").trim().slice(0, 72));
    },
    [autoCanvasLooks, sessionLooks, clearRender],
  );

  const onAutoCarouselRegenerate = useCallback(() => {
    if (autoGenSessionRef.current && autoLooksSummary.looks.length > 0) {
      setAutoBuilderSheetActive(false);
      setAutoBuilderDismissing(false);
      void regenerateAutoOutfitSession();
    } else if (autoBuilderSheetActive) {
      autoBuildPanelRef.current?.regenerate();
    } else if (autoOutfitSessionActive) {
      void regenerateAutoOutfitSession();
    }
  }, [
    autoLooksSummary.looks.length,
    autoBuilderSheetActive,
    autoOutfitSessionActive,
    regenerateAutoOutfitSession,
  ]);

  const dismissMoreLooksMenu = useCallback(() => {
    void Haptics.selectionAsync();
    setMoreLooksMenuOpen(false);
  }, []);

  const handleMoreLooksSameSetup = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMoreLooksMenuOpen(false);
    setAutoBuilderSheetActive(false);
    setAutoBuilderDismissing(false);
    void regenerateAutoOutfitSession();
  }, [regenerateAutoOutfitSession]);

  const handleMoreLooksNewSetup = useCallback(() => {
    void Haptics.selectionAsync();
    setMoreLooksMenuOpen(false);
    // Composer, prefilled with the current prompt/pins so it reads as
    // "tweak this setup" rather than the old config-sheet form.
    const sess = autoGenSessionRef.current;
    openGetStyledComposer({
      prefillPrompt: sess?.builderPrompt,
      prefillAnchors: sess?.anchorItemIds,
    });
  }, [openGetStyledComposer]);

  const onAutoCarouselEditVibe = useCallback(() => {
    if (autoOutfitSessionActive && !autoBuilderSheetActive) {
      const sess = autoGenSessionRef.current;
      openGetStyledComposer({
        prefillPrompt: sess?.builderPrompt,
        prefillAnchors: sess?.anchorItemIds,
      });
    } else {
      snapSheet(true, "autoCapped");
    }
  }, [autoOutfitSessionActive, autoBuilderSheetActive, openGetStyledComposer, snapSheet]);

  const onAutoCarouselApplyLook = useCallback(
    (key: string) => {
      const index = autoCanvasLooks.findIndex((l) => l.key === key);
      if (index < 0) return;
      void Haptics.selectionAsync();
      applyAutoLookAtIndex(index);
    },
    [applyAutoLookAtIndex, autoCanvasLooks],
  );

  const handleSelectLook = useCallback(
    (index: number) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const look = autoCanvasLooks[index];
      if (!look) return;

      applyAutoLookAtIndex(index);
      setAnchoredCanvasItemIds(look.items.map((it) => it.id));
      clearStyleMeSession({ keepCanvas: true });
      focusClosetOnLoadedFit();

      if (userId) {
        void supabase
          .from("generation_history")
          .insert({
            user_id: userId,
            item_ids: look.items.map((it) => it.id),
            image_url: null,
          })
          .select("id")
          .then(({ data }) => {
            if (data?.[0]) setCurrentGenerationId(data[0].id);
            onStyleMeLookChosen?.();
          });
      }
    },
    [
      applyAutoLookAtIndex,
      autoCanvasLooks,
      clearStyleMeSession,
      focusClosetOnLoadedFit,
      onStyleMeLookChosen,
      userId,
    ],
  );

  const handleDoneEditing = useCallback(() => {
    if (editingLookIndex === null) return;
    const idx = editingLookIndex;
    const updatedItems = [...builderItems];
    setSessionLooks((prev) => {
      const next = [...prev];
      next[idx] = updatedItems;
      return next;
    });
    setAutoLooksSummary((prev) => ({
      ...prev,
      looks: prev.looks.map((look, i) =>
        i === idx
          ? { ...look, itemIds: updatedItems.map((it) => it.id) }
          : look,
      ),
    }));
    setEditingLookIndex(null);
    editingLookSnapshotRef.current = null;
    if (autoLooksSummary.looks.length > 0) {
      autoOutfitSessionActiveRef.current = true;
      setAutoOutfitSessionActive(true);
      setStyleMeScreenActive(true);
    }
    snapSheet(false);
  }, [editingLookIndex, builderItems, autoLooksSummary.looks.length, snapSheet]);

  const handleCancelEditing = useCallback(() => {
    if (editingLookIndex === null) return;
    const snapshot = editingLookSnapshotRef.current;
    if (snapshot) {
      setBuilderItems(snapshot);
      setSessionLooks((prev) => {
        const next = [...prev];
        next[editingLookIndex] = snapshot;
        return next;
      });
    }
    setEditingLookIndex(null);
    editingLookSnapshotRef.current = null;
    if (autoLooksSummary.looks.length > 0) {
      autoOutfitSessionActiveRef.current = true;
      setAutoOutfitSessionActive(true);
      setStyleMeScreenActive(true);
    }
    snapSheet(false);
  }, [editingLookIndex, autoLooksSummary.looks.length, snapSheet]);

  // ─── Manual mode elements ────────────────────────────────────────────────────

  const onManualCategoryChange = useCallback(
    (c: string) => {
      Haptics.selectionAsync();
      if (c === IN_FIT_CHIP) {
        pendingSwapItemIdRef.current = null;
      }
      if (manualCategory === c && !manualExpanded) {
        snapSheet(true, "full");
        return;
      }
      setManualCategory(c);
      if (manualExpanded) {
        syncClosetBrowseForChip(c);
      } else {
        setClosetBrowseCategory(null);
      }
    },
    [manualCategory, manualExpanded, snapSheet, syncClosetBrowseForChip],
  );

  const manualCategoryChipBadges = useMemo(
    () =>
      builderItems.length > 0
        ? { [IN_FIT_CHIP]: builderItems.length }
        : undefined,
    [builderItems.length],
  );

  useEffect(() => {
    if (manualCategory !== "All") return;
    manualStripRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [manualCategory]);

  const renderWardrobeStrip = () => {
    if (
      !manualExpanded ||
      !expandedWardrobesVisible ||
      !wardrobes.length ||
      !onActiveWardrobeChange
    ) {
      return null;
    }
    const selectWardrobe = onActiveWardrobeChange;
    return (
      <Animated.View
        entering={FadeInUp.duration(190)}
        exiting={FadeOut.duration(140)}
        layout={LinearTransition.duration(190)}
        style={s.wardrobeStripWrap}
      >
        <WardrobeStrip
          wardrobes={wardrobes}
          activeWardrobeId={activeWardrobeId}
          countsByWardrobe={wardrobeCountsById}
          totalCount={closetItems.length}
          onSelect={selectWardrobe}
          onManage={() => {
            onManageWardrobes?.();
          }}
          onLongPressWardrobe={() => {
            onManageWardrobes?.();
          }}
        />
      </Animated.View>
    );
  };

  const renderManualCategoryTabs = (
    contentContainerStyle: StyleProp<ViewStyle>,
    opts?: { includeThisFit?: boolean; pinAll?: boolean },
  ) => {
    const includeThisFit = opts?.includeThisFit !== false;
    const leadingChips = [
      ...(includeThisFit ? [IN_FIT_CHIP] : []),
      ...(opts?.pinAll ? ["All"] : []),
    ];
    const category =
      !includeThisFit && manualCategory === IN_FIT_CHIP ? "All" : manualCategory;
    const categoryItemsReady = getStyledAttachMode
      ? getStyledAttachCarouselItems.length > 0
      : category === IN_FIT_CHIP
        ? builderItems.length > 0
        : filteredManualItems.length > 0;
    const categoryNudgeKey = [
      getStyledAttachMode ? "attach" : manualExpanded ? "expanded" : "collapsed",
      category,
      categoryItemsReady ? "ready" : "waiting",
      getStyledAttachMode
        ? getStyledAttachCarouselItems.length
        : category === IN_FIT_CHIP
          ? builderItems.length
          : filteredManualItems.length,
    ].join(":");
    return (
    <CategoryChipRow
      category={category}
      leadingChips={leadingChips}
      chipBadges={includeThisFit ? manualCategoryChipBadges : undefined}
      pulseChip={includeThisFit ? IN_FIT_CHIP : undefined}
      pulseToken={thisFitPulseToken}
      onCategoryChange={onManualCategoryChange}
      style={!includeThisFit ? s.manualTabsClosetOnlyTrack : undefined}
      contentContainerStyle={contentContainerStyle}
      nudgeReady={categoryItemsReady}
      nudgeKey={categoryNudgeKey}
    />
    );
  };

  const handleAttachItemToGetStyledPrompt = useCallback(
    (item: ClosetItem | BuilderItem) => {
      Haptics.selectionAsync();
      setGetStyledAttachedItemIds((ids) =>
        ids.includes(item.id) ? ids : [...ids, item.id],
      );
    },
    [],
  );

  const handleAttachItemIdToGetStyledPrompt = useCallback(
    (id: string) => {
      const item = closetItems.find((candidate) => candidate.id === id);
      if (item) handleAttachItemToGetStyledPrompt(item);
    },
    [closetItems, handleAttachItemToGetStyledPrompt],
  );

  const renderGetStyledAttachTile = useCallback(
    ({ item }: { item: ClosetItem | BuilderItem }) => {
      const attached = getStyledAttachedItemIds.includes(item.id);
      return (
        <TouchableOpacity
          onPress={() => handleAttachItemToGetStyledPrompt(item)}
          onLongPress={() => {
            if (!onStripItemLongPress) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onStripItemLongPress(item);
          }}
          delayLongPress={380}
          style={[
            s.manualItem,
            attached && s.getStyledAttachItemActive,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Attach ${getStyledAttachmentLabel(item)} to prompt`}
        >
          {item.image_url ? (
            <ClosetItemImage
              uri={item.image_url}
              backgroundColor="transparent"
              style={s.manualItemImg}
            />
          ) : (
            <Box size={28} color={Colors.textMuted} strokeWidth={1.5} />
          )}
          {attached ? (
            <View style={s.getStyledAttachCheck}>
              <Check size={10} color="#fff" strokeWidth={3} />
            </View>
          ) : null}
        </TouchableOpacity>
      );
    },
    [
      getStyledAttachedItemIds,
      handleAttachItemToGetStyledPrompt,
      onStripItemLongPress,
    ],
  );

  const renderManualStripTile = useCallback(
    ({ item }: { item: ClosetItem | BuilderItem }) => {
      const isSelected = builderItemIds.has(item.id);
      return (
        <TouchableOpacity
          onPress={() => {
            Haptics.selectionAsync();
            handlePickItemManual(item.id);
          }}
          onLongPress={() => {
            if (!onStripItemLongPress) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onStripItemLongPress(item);
          }}
          delayLongPress={380}
          style={[s.manualItem, isSelected && s.manualItemActive]}
        >
          {item.image_url ? (
            <ClosetItemImage
              uri={item.image_url}
              backgroundColor="transparent"
              style={s.manualItemImg}
            />
          ) : (
            <Box size={28} color={Colors.textMuted} strokeWidth={1.5} />
          )}
          {isSelected ? (
            <View style={s.manualItemCheck}>
              <Check size={10} color="#fff" strokeWidth={3} />
            </View>
          ) : null}
        </TouchableOpacity>
      );
    },
    [
      builderItemIds,
      handlePickItemManual,
      onStripItemLongPress,
    ],
  );

  const manualStripTileLayout = useCallback(
    (_: ArrayLike<ClosetItem | BuilderItem> | null | undefined, index: number) => ({
      length: MANUAL_STRIP_TILE_STEP,
      offset: MANUAL_STRIP_TILE_STEP * index,
      index,
    }),
    [],
  );

  const [placeholderTrackW, setPlaceholderTrackW] = useState(0);
  const ootdPlaceholderLayout = useMemo(
    () =>
      ootdPlaceholderStripLayout(
        placeholderTrackW > 0 ? placeholderTrackW : screenWidth,
      ),
    [placeholderTrackW, screenWidth],
  );

  const manualHorizontalStripEl = getStyledPromptMode && !getStyledAttachMode ? (
    // Composer uses the real native keyboard now (slides up over this area),
    // so the strip renders nothing here. The custom GetStyledKeyboard is kept
    // in the file (unused) rather than deleted, per earlier request.
    <View key="get-styled-native" style={s.manualStripMorph} />
  ) : getStyledAttachMode ? (
    <Animated.View
      key="get-styled-attach-strip"
      entering={PREMIUM_FADE_IN}
      exiting={PREMIUM_FADE_OUT}
      layout={PREMIUM_ISLAND_LAYOUT}
      style={s.manualStripMorph}
    >
      <FlatList
        ref={manualStripRef}
        horizontal
        data={getStyledAttachCarouselItems}
        keyExtractor={(item) => item.id}
        renderItem={renderGetStyledAttachTile}
        getItemLayout={manualStripTileLayout}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={5}
        extraData={getStyledAttachedItemIds}
        showsHorizontalScrollIndicator={false}
        style={s.manualStripScroll}
        contentContainerStyle={s.manualItems}
        bounces={false}
      />
    </Animated.View>
  ) : manualCategory === IN_FIT_CHIP && builderItems.length === 0 ? (
    <Animated.View
      key="this-fit-placeholder"
      entering={PREMIUM_FADE_IN}
      exiting={PREMIUM_FADE_OUT}
      layout={PREMIUM_ISLAND_LAYOUT}
      style={s.manualStripMorph}
    >
      <View
        style={[
          s.thisFitPlaceholderRow,
          {
            paddingLeft: ootdPlaceholderLayout.paddingLeft,
            paddingRight: ootdPlaceholderLayout.paddingRight,
            gap: ootdPlaceholderLayout.gap,
          },
        ]}
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          if (w > 0 && w !== placeholderTrackW) setPlaceholderTrackW(w);
        }}
        pointerEvents="none"
      >
        {Array.from({ length: ootdPlaceholderLayout.count }, (_, i) => (
          <View
            key={i}
            style={[
              s.thisFitPlaceholderTile,
              { width: ootdPlaceholderLayout.tileW },
            ]}
          />
        ))}
      </View>
    </Animated.View>
    ) : (
      <Animated.View
        key="manual-strip"
        entering={PREMIUM_FADE_IN}
        exiting={PREMIUM_FADE_OUT}
        layout={PREMIUM_ISLAND_LAYOUT}
        style={s.manualStripMorph}
      >
      <FlatList
        ref={manualStripRef}
        horizontal
        data={filteredManualItems}
        keyExtractor={(item) => item.id}
        renderItem={renderManualStripTile}
        getItemLayout={manualStripTileLayout}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={5}
        extraData={builderItemIds}
        showsHorizontalScrollIndicator={false}
        style={s.manualStripScroll}
        contentContainerStyle={s.manualItems}
        bounces={false}
      />
    </Animated.View>
    );

  /** Landing from closet “Make Fit” — seed canvas and open Auto Outfit Builder (around-item tab). */
  /** Landing from closet “Make Fit” or Library “Remix” — seed canvas. */
  useEffect(() => {
    const hasAnchor = !!initialAnchorId;
    const hasRemix = !!remixItemIds;
    if ((!hasAnchor && !hasRemix) || scopedClosetItems.length === 0) return;

    // The nav nonce (fitsNavAt) makes every "Open in Fits" press re-seed —
    // without it, resetting the builder and opening the SAME automation again
    // matched the old key and silently did nothing.
    const seedKey = hasRemix
      ? `remix-${initialAnchorNonce ?? ""}-${editOutfitId ?? ""}-${remixItemIds}-${initialName}-${initialOccasion}-${landingHeroTryOnUri ?? ""}`
      : `anchor-${initialAnchorId}-${initialAnchorNonce ?? ""}`;
    if (initialAnchorSeededKeyRef.current === seedKey) return;
    initialAnchorSeededKeyRef.current = seedKey;

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Clear and reset before seeding
    resetBuilderState();

    if (hasRemix) {
      if (editOutfitId) {
        setEditingOutfitId(editOutfitId);
        setEditTargetWasUnsaved(!!editTargetUnsaved);
      }
      const ids = remixItemIds.split(",").filter(Boolean);
      const items = ids
        .map((id) => closetItems.find((it) => it.id === id))
        .filter((it): it is ClosetItem => !!it);

      if (items.length > 0) {
        if (editOutfitId) {
          // Library membership survives app restarts. Home resolves the
          // persisted saved_to_library flag before navigation; restore the
          // Saved state here instead of treating every automation landing as
          // a brand-new unsaved result.
          setSavedToLibrary(
            editTargetUnsaved
              ? null
              : { outfitId: editOutfitId, itemIds: ids },
          );
        }
        setBuilderItems(items.map((it, idx) => ({ ...it, slot: idx })));
        setAnchoredCanvasItemIds(items.map((it) => it.id));
        editBaselineItemIdsRef.current = items.map((it) => it.id);
        if (initialName) setFitName(initialName);
        if (initialOccasion) setSelectedOccasionId(initialOccasion);
        setManualReadyToSave(true);
        focusClosetOnLoadedFit();

        const tryUri = landingHeroTryOnUri?.trim();
        if (tryUri) {
          // Enter a real try-on result session so the landed render behaves
          // exactly like one the user generated here: locked result view,
          // Edit-pieces / Try-again pills, and save-as-try-on semantics
          // (handleSave keys isTryOnSave off the hero).
          setTryOnSessionActive(true);
          if (tryUri.startsWith("file:")) {
            // Home's widget already cut this render out — show it instantly.
            const genToken = ++tryOnGenTokenRef.current;
            setGenerationPhase("rendering");
            requestAnimationFrame(() => {
              void prepareTryOnImageUri(tryUri, editOutfitId).then(
                (toDisplay) => {
                  if (tryOnGenTokenRef.current !== genToken) return;
                  setGenerationPhase("idle");
                  if (toDisplay) {
                    setHeroImageUri(toDisplay);
                  } else {
                    setHeroImageUri(null);
                    setTryOnSessionActive(false);
                    showPillNotice(
                      "Could not prepare the try-on cutout. Re-run it to try again.",
                      "error",
                    );
                  }
                },
              );
            });
          } else {
            // Remote render: cut it out under the standard "Rendering look"
            // state instead of flashing the raw backdropped image (or the
            // flat item collage) while the fetch + background removal run.
            const genToken = ++tryOnGenTokenRef.current;
            setGenerationPhase("rendering");
            requestAnimationFrame(async () => {
              let toDisplay: string | null = null;
              try {
                let b64 = tryUri;
                if (tryUri.startsWith("data:image")) {
                  b64 = tryUri.replace(/^data:image\/\w+;base64,/, "");
                } else if (tryUri.startsWith("http")) {
                  const res = await fetch(tryUri);
                  const blob = await res.blob();
                  b64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      const dataUrl = reader.result as string;
                      const i = dataUrl.indexOf(",");
                      resolve(i >= 0 ? dataUrl.slice(i + 1) : dataUrl);
                    };
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(blob);
                  });
                }
                if (b64) {
                  // Mannequin/flat-backdrop heroes get a deterministic chroma
                  // key on the known backdrop color; only real-selfie heroes
                  // use person segmentation (person-seg on a mannequin
                  // punches holes).
                  const matteCutout =
                    await removeGeneratedTryOnBackgroundFromJpeg(
                      b64,
                      landingHeroChromaKeyHex,
                    );
                  const cutout = matteCutout;
                  if (cutout) toDisplay = cutout;
                }
              } catch (e) {
                console.warn("Landed try-on segment error:", e);
              }
              // A newer render or landing owns the canvas now — drop this.
              if (tryOnGenTokenRef.current !== genToken) return;
              setGenerationPhase("idle");
              if (toDisplay) {
                setHeroImageUri(toDisplay);
              } else {
                setHeroImageUri(null);
                setTryOnSessionActive(false);
                showPillNotice(
                  "Could not prepare the try-on cutout. Re-run it to try again.",
                  "error",
                );
              }
            });
          }
        }
      }
    } else if (hasAnchor) {
      const anchor = closetItems.find((it) => it.id === initialAnchorId);
      if (anchor) {
        // External Closet → Fit navigation must never inherit a previously
        // expanded manual closet drawer from the still-mounted Fits tab.
        snapSheet(false);
        // Closet "Fit" now lands in the NEW Get Styled composer with the
        // piece pinned as an attachment, instead of the old AutoOutfitBuilder
        // slide-up sheet. (openGetStyledComposer is the single Get Styled
        // entry point that replaced openAutoBuilder / openAutoBuilderForEdit.)
        openGetStyledComposer({ prefillAnchors: [anchor.id] });
      }
    }
  }, [
    initialAnchorId,
    initialAnchorNonce,
    remixItemIds,
    editOutfitId,
    editTargetUnsaved,
    initialName,
    initialOccasion,
    closetItems,
    scopedClosetItems.length,
    snapSheet,
    resetBuilderState,
    focusClosetOnLoadedFit,
    landingHeroTryOnUri,
    landingHeroChromaKeyHex,
    openGetStyledComposer,
    showPillNotice,
  ]);

  /** Expanded Auto Builder or Get Styled strip — no closet pull handle. */
  const hideExpandedAutoPullChrome =
    autoBuilderDismissing ||
    (manualExpanded && autoBuilderSheetActive && !tryOnPickerActive);

  const styleMeStripActive =
    !manualExpanded &&
    !tryOnPickerActive &&
    !autoBuilderDismissing &&
    (looksMode === "generating" || looksMode === "results");

  const showClosetPullChrome =
    !manualExpanded &&
    !tryOnPickerActive &&
    !autoBuilderDismissing &&
    (looksMode === "closet" || looksMode === "editing");

  /** Bottom-pinned pull hint — closet carousel after try-on / manual build.
   * NOTE: this also gates whether the separate `sheetDragHeader` block
   * (further down) collapses to height:0 — don't fold getStyledPromptMode
   * in here, or that header stops collapsing and shows through instead. Get
   * Styled hides the floating pull-chrome at its own render site instead. */
  const showCollapsedPullHintLayer =
    !tryOnPickerActive &&
    !autoBuilderDismissing &&
    (looksMode === "closet" ||
      looksMode === "editing" ||
      looksMode === "generating" ||
      editingTryOnLook);

  const collapsedStripHint = useMemo(():
    | { kind: "pull"; label: string; direction: "up" | "down" }
    | { kind: "text"; label: string }
    | null => {
    // Pull-up-to-expand is disabled while the Get Styled keyboard occupies
    // the strip (see panGesture above) — showing this hint here would be
    // misleading since it wouldn't do anything.
    if (getStyledPromptMode && !getStyledAttachMode) return null;
    if (editingTryOnLook) {
      if (manualCategory === IN_FIT_CHIP)
        return { kind: "pull", label: THIS_FIT_PULL_HINT, direction: "up" };
      return { kind: "pull", label: "Pull up for closet", direction: "up" };
    }
    if (looksMode === "editing")
      return {
        kind: "text",
        label: `Editing Look ${(editingLookIndex ?? 0) + 1}`,
      };
    if (looksMode === "results")
      return {
        kind: "text",
        label: styleMeAppendingLooks
          ? "Adding more Get Styled OOTD's…"
          : "Tap to preview · Choose to build/save this look",
      };
    if (looksMode === "generating")
      return { kind: "text", label: "Creating Get Styled OOTD's" };
    if (autoBuilderSheetActive)
      return {
        kind: "pull",
        label: "Pull up for Get Styled configurator",
        direction: "up",
      };
    if (looksMode === "closet") {
      if (getStyledAttachMode)
        return { kind: "pull", label: "Pull up for closet", direction: "up" };
      if (manualCategory === IN_FIT_CHIP)
        return { kind: "pull", label: THIS_FIT_PULL_HINT, direction: "up" };
      return { kind: "pull", label: "Pull up for closet", direction: "up" };
    }
    return null;
  }, [
    getStyledPromptMode,
    getStyledAttachMode,
    editingTryOnLook,
    manualCategory,
    looksMode,
    editingLookIndex,
    styleMeAppendingLooks,
    autoBuilderSheetActive,
  ]);

  /** Try-on / hero render band — between Build · Library and bottom action island. */
  const heroDisplayFrame = useMemo(() => {
    if (!heroImageUri) return null;
    // Anchor the render to the collapsed strip — expanded closet slides over it.
    const heroAnchorSheetH = stableCompactMinPx;
    return {
      top: insets.top + FITS_TOP_PILL_BOTTOM_FROM_SAFE,
      bottom:
        heroAnchorSheetH +
        bottomChromePad +
        ACTION_ISLAND_SHEET_GAP +
        ACTION_ISLAND_HEIGHT +
        TRY_ON_HERO_FOOT_GAP,
    };
  }, [heroImageUri, insets.top, stableCompactMinPx, bottomChromePad]);

  /** ↑…↑ or ↓…↓ — only for real pull / swipe gestures. */
  const renderSheetPullHint = useCallback(
    (label: string, pullDirection: "up" | "down") => {
      const Icon = pullDirection === "down" ? ChevronDown : ChevronUp;
      return (
        <View style={s.expandHintCenter}>
          <View style={s.expandHintChevron}>
            <Icon size={14} color={Colors.textMuted} strokeWidth={2} />
          </View>
          <Text
            style={[s.expandHintText, s.expandHintTextInRow]}
            numberOfLines={2}
          >
            {label}
          </Text>
          <View style={s.expandHintChevron}>
            <Icon size={14} color={Colors.textMuted} strokeWidth={2} />
          </View>
        </View>
      );
    },
    [],
  );

  const renderStripHint = useCallback(
    (
      hint: NonNullable<typeof collapsedStripHint>,
      options?: { textStyle?: object; animatedTextStyle?: object },
    ) => {
      if (hint.kind === "pull") {
        return renderSheetPullHint(hint.label, hint.direction);
      }
      const textStyle = [
        s.expandHintText,
        s.expandHintTextCentered,
        options?.textStyle,
        options?.animatedTextStyle,
      ];
      if (options?.animatedTextStyle) {
        return (
          <Animated.Text style={textStyle} numberOfLines={2}>
            {hint.label}
          </Animated.Text>
        );
      }
      return (
        <Text style={textStyle} numberOfLines={2}>
          {hint.label}
        </Text>
      );
    },
    [renderSheetPullHint],
  );

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={s.wrap}>
      <View
        pointerEvents="none"
        style={[
          s.pageBackdrop,
          { marginBottom: -insets.bottom, paddingBottom: insets.bottom },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          s.stageStudioFill,
          { marginBottom: -insets.bottom, paddingBottom: insets.bottom },
        ]}
      >
        <View
          style={[
            FIT_STUDIO_BG_CLIP_STYLE,
            { backgroundColor: Colors.homeHeroBackdrop },
          ]}
        >
          <Image
            source={FIT_STUDIO_BG}
            style={StyleSheet.absoluteFillObject}
            contentFit="cover"
            contentPosition="bottom center"
            transition={0}
            cachePolicy="memory-disk"
          />
        </View>
      </View>
      <View style={s.stageLayer}>
        <View style={s.stage} onLayout={onStageLayout}>
          <View style={s.previewFill} pointerEvents="box-none">
            {dayContextBanner ? (
              // +56 clears the floating Build/Library/Plan mode pill that
              // fits.tsx overlays at insets.top + 8 — same slot, was
              // stacking one pill on top of the other.
              <View
                style={[s.dayContextBanner, { top: insets.top + 56 }]}
                pointerEvents="box-none"
              >
                <View style={s.dayContextBannerPill}>
                  <Calendar size={13} color={Colors.accent} strokeWidth={2.4} />
                  <Text style={s.dayContextBannerText} numberOfLines={1}>
                    {dayContextBanner.label} {dayContextBanner.dateText}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setDayContextDismissed(true);
                    }}
                    hitSlop={10}
                    style={s.dayContextBannerClose}
                    accessibilityRole="button"
                    accessibilityLabel="Build a normal look instead of attaching to this day"
                  >
                    <X size={13} color={Colors.textMuted} strokeWidth={2.4} />
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
            <View style={s.canvasStack}>
              <OutfitCanvas
                ref={outfitCanvasRef}
                items={builderItems}
                generationPhase={generationPhase}
                onRemoveItem={handleRemoveItem}
                onShuffle={undefined}
                canShuffle={false}
                heroImageUri={heroImageUri}
                onClearHero={() => {
                  Haptics.selectionAsync();
                  if (tryOnResultViewLocked) {
                    beginEditTryOnLook();
                    return;
                  }
                  setManualReadyToSave(false);
                  stashHeroForEdit();
                }}
                manualModeHint
                manualGridCollage
                moodBoardSurface
                layoutVariant={layoutVariant}
                showManualAddPlaceholder={false}
                tryOnVisible={false}
                onTryOn={handleTryOn}
                manualEditVisible={false}
                onManualEditOutfit={() => {
                  Haptics.selectionAsync();
                  if (tryOnResultViewLocked) {
                    beginEditTryOnLook();
                    return;
                  }
                  setManualReadyToSave(false);
                  stashHeroForEdit();
                }}
                renderActionsOutside
                safeBottomArea={canvasSafeBottomArea}
                heroBottomInset={
                  bottomChromePad +
                  (measuredClosetCollapsedPullHeaderH > 0
                    ? measuredClosetCollapsedPullHeaderH
                    : 38) +
                  STRIP_BODY_FIXED_H +
                  canvasIslandReserve +
                  40
                }
                heroFrameTop={heroDisplayFrame?.top}
                heroFrameBottom={heroDisplayFrame?.bottom}
                heroFootPad={2}
                emptyStateBottomInset={FIT_EMPTY_HINT_BOTTOM_RESERVE}
                onSelectRequest={handleSelectSlotFromCanvas}
                anchoredItemIds={anchoredCanvasItemIds}
                itemsInteractionLocked={tryOnResultViewLocked}
                autoStylingActive={styleMeInitialGenerating}
                autoStylingProgress={autoLooksSummary.progress ?? 0}
                autoStylingText={autoLooksSummary.statusText}
                getStyledActive={getStyledPromptMode}
                getStyledTitle={getStyledGreetingTitle}
                getStyledSubtitle={getStyledGreetingSubtitle}
                autoCanvasLooks={autoCanvasLooks}
                autoCanvasLookIndex={autoLookIndex}
                onAutoCanvasLookChange={applyAutoLookAtIndex}
                canvasInset={fitsCanvasInset}
                onExportHero={handleExportHero}
                exportLoading={exporting}
              />
            </View>
          </View>

          {/* Keep the current branded card decoded so Share only has to capture it. */}
          {heroImageUri ? (
            <FitShareCaptureView
              key={exportShareKey}
              ref={exportViewRef}
              imageUri={heroImageUri}
              mode="tryon"
              lookTitle={fitName}
              items={exportShareItems}
              onHeroDecoded={onFitShareHeroDecoded}
            />
          ) : null}

          {/* Floating Action Island (The Hump) physically tracks the top border mathematically */}
          {!(DEBUG_HIDE_COLLAPSED_CAROUSEL && !manualExpanded) ? (
            <Animated.View
              style={[s.actionIslandContainer, islandAnimatedStyle]}
              pointerEvents={manualExpanded ? "none" : "box-none"}
            >
              <Animated.View layout={PREMIUM_ISLAND_LAYOUT}>
                <Animated.View
                  style={[
                    s.actionIslandBlur,
                    EditorialStyles.floatPillPlate,
                    {
                      shadowOffset: { width: 0, height: -4 },
                      shadowOpacity: 0.08,
                      shadowRadius: 10,
                      elevation: 5,
                    },
                    getStyledPromptMode && s.actionIslandComposerShape,
                    s.actionIslandClip,
                    (getStyledAttachedItems.length > 0 ||
                      !!getStyledWeatherToast) &&
                      s.actionIslandClipWithAttachment,
                  ]}
                  layout={PREMIUM_ISLAND_LAYOUT}
                >
                  <Animated.View
                    style={[s.actionIslandContentRow, pillContentNoticeStyle]}
                    layout={PREMIUM_ISLAND_LAYOUT}
                  >
                  {/* ── State 0: Try-on is RENDERING ─────────────────────── */}
                  {tryOnRendering ? (
                    <Animated.View
                      key="tryon-rendering-pill"
                      entering={FadeIn.duration(180)}
                      exiting={FadeOut.duration(180)}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <View style={[s.islandBtn, { paddingHorizontal: 14 }]}>
                        <Text style={s.islandBtnText}>Rendering look</Text>
                      </View>
                    </Animated.View>
                  ) : /* ── EXPERIMENT: Get Styled PROMPT COMPOSER ───────────── */
                  getStyledPromptMode ? (
                    <Animated.View
                      key="get-styled-composer"
                      entering={PREMIUM_FADE_IN}
                      exiting={PREMIUM_FADE_OUT}
                      layout={PREMIUM_ISLAND_LAYOUT}
                      style={[
                        s.getStyledComposer,
                        { width: screenWidth - 48 },
                      ]}
                    >
                      {getStyledWeatherToast ? (
                        <Animated.View
                          entering={FadeInUp.duration(150)}
                          exiting={FadeOut.duration(120)}
                          style={s.getStyledWeatherToast}
                          pointerEvents="none"
                        >
                          <CloudSun
                            size={14}
                            color={Colors.text}
                            strokeWidth={2.1}
                          />
                          <Text
                            style={s.getStyledWeatherToastText}
                            numberOfLines={1}
                          >
                            {getStyledWeatherToast}
                          </Text>
                        </Animated.View>
                      ) : null}
                      {getStyledAttachedItems.length > 0 ? (
                        <View style={s.getStyledAttachmentRow}>
                          {getStyledAttachedItems.map((item) => (
                            <View
                              key={item.id}
                              style={s.getStyledAttachmentThumbWrap}
                            >
                              {item.image_url ? (
                                <ClosetItemImage
                                  uri={item.image_url}
                                  backgroundColor="transparent"
                                  style={s.getStyledAttachmentThumb}
                                />
                              ) : (
                                <View style={s.getStyledAttachmentThumbFallback}>
                                  <Box
                                    size={24}
                                    color={Colors.textMuted}
                                    strokeWidth={1.5}
                                  />
                                </View>
                              )}
                              <TouchableOpacity
                                style={s.getStyledAttachmentRemove}
                                activeOpacity={0.75}
                                onPress={() => {
                                  Haptics.selectionAsync();
                                  setGetStyledAttachedItemIds((ids) =>
                                    ids.filter((id) => id !== item.id),
                                  );
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove ${getStyledAttachmentLabel(item)} attachment`}
                              >
                                <X
                                  size={13}
                                  color={Colors.text}
                                  strokeWidth={2.6}
                                />
                              </TouchableOpacity>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      <GetStyledPromptInput
                        attachMode={getStyledAttachMode}
                        onExitAttachMode={() => setGetStyledAttachMode(false)}
                      />
                      <View style={s.getStyledComposerRow}>
                        <TouchableOpacity
                          style={s.getStyledComposerIconBtn}
                          activeOpacity={0.72}
                          onPress={handleCloseGetStyledComposer}
                          accessibilityRole="button"
                          accessibilityLabel="Close Get Styled prompt"
                        >
                          <X
                            size={16}
                            color={Colors.text}
                            strokeWidth={2.4}
                          />
                        </TouchableOpacity>
                        <GetStyledWeatherButton
                          enabled={getStyledUseWeather}
                          onPress={() => {
                            Haptics.selectionAsync();
                            setGetStyledUseWeather((enabled) => {
                              const next = !enabled;
                              setGetStyledWeatherToast(
                                next
                                  ? "Will style for current weather"
                                  : "Weather styling off",
                              );
                              if (getStyledWeatherToastTimerRef.current) {
                                clearTimeout(
                                  getStyledWeatherToastTimerRef.current,
                                );
                              }
                              getStyledWeatherToastTimerRef.current =
                                setTimeout(() => {
                                  setGetStyledWeatherToast(null);
                                  getStyledWeatherToastTimerRef.current = null;
                                }, 2000);
                              return next;
                            });
                          }}
                        />
                        <GetStyledAttachButton
                          active={getStyledAttachMode}
                          onPress={() => {
                            Haptics.selectionAsync();
                            setGetStyledAttachMode((active) => {
                              const next = !active;
                              if (next && manualCategoryRef.current === IN_FIT_CHIP) {
                                setManualCategory("All");
                              }
                              return next;
                            });
                          }}
                        />
                        <View style={s.getStyledComposerSpacer} />
                        <TouchableOpacity
                          style={s.getStyledComposerSend}
                          activeOpacity={0.75}
                          onPress={() => {
                            Haptics.selectionAsync();
                            handleGetStyledSubmit();
                          }}
                          accessibilityRole="button"
                          accessibilityLabel="Send style prompt"
                        >
                          <MoveUp size={15} color="#fff" strokeWidth={2.4} />
                        </TouchableOpacity>
                      </View>
                    </Animated.View>
                  ) : /* ── State 1: Get Styled is GENERATING ─────────────────── */
                  styleMeInitialGenerating && styleMeScreenActive ? (
                    // Grayed-out, non-interactive clone of the results pill
                    // (Choose / More looks / Restart) — NOT the Get
                    // styled/Try on/Save default pill (that was the bug:
                    // this used to be an accidental copy of the default
                    // pill, so during the very first generation it looked
                    // like nothing was happening/still showed "Get styled").
                    <Animated.View
                      key="styleme-loading"
                      entering={FadeIn.duration(180)}
                      exiting={FadeOut.duration(180)}
                      style={[
                        { flexDirection: "row", alignItems: "center" },
                        s.islandPillDimmed,
                      ]}
                      pointerEvents="none"
                    >
                      <View style={[s.islandBtn, s.islandBtnPrimary]}>
                        <Check size={14} color="#fff" strokeWidth={2.8} />
                        <Text style={[s.islandBtnText, { color: "#fff" }]}>
                          Choose
                        </Text>
                      </View>

                      <View style={s.islandDivider} />

                      <View style={s.islandBtn}>
                        <Plus size={14} color={Colors.text} strokeWidth={2.4} />
                        <Text style={s.islandBtnText}>More looks</Text>
                      </View>

                      <View style={s.islandDivider} />

                      <View style={s.islandBtn}>
                        <RotateCcw
                          size={14}
                          color={Colors.text}
                          strokeWidth={2.2}
                        />
                        <Text style={s.islandBtnText}>Restart</Text>
                      </View>
                    </Animated.View>
                  ) : /* ── State 2: Get Styled SESSION RESULTS (sheet collapsed) ─ */
                  styleMeScreenActive &&
                  autoOutfitSessionActive &&
                  !autoBuilderSheetActive ? (
                    moreLooksMenuOpen ? (
                      <Animated.View
                        key="styleme-more-menu"
                        entering={FadeIn.duration(180)}
                        exiting={FadeOut.duration(180)}
                        style={s.islandMenuStack}
                      >
                        <Text style={s.islandMenuQuestion}>Add more looks?</Text>
                        <View style={s.islandMenuRow}>
                          <TouchableOpacity
                            style={s.islandBtn}
                            onPress={handleMoreLooksSameSetup}
                            activeOpacity={0.7}
                          >
                            <Text style={s.islandBtnText}>Same setup</Text>
                          </TouchableOpacity>

                          <View style={s.islandDivider} />

                          <TouchableOpacity
                            style={s.islandBtn}
                            onPress={handleMoreLooksNewSetup}
                            activeOpacity={0.7}
                          >
                            <Text style={s.islandBtnText}>New setup</Text>
                          </TouchableOpacity>

                          <View style={s.islandDivider} />

                          <TouchableOpacity
                            style={s.islandBtn}
                            onPress={dismissMoreLooksMenu}
                            activeOpacity={0.7}
                          >
                            <Text style={s.islandBtnAccentText}>Never mind</Text>
                          </TouchableOpacity>
                        </View>
                      </Animated.View>
                    ) : (
                    <Animated.View
                      key="styleme-results"
                      entering={FadeIn.duration(180)}
                      exiting={FadeOut.duration(180)}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <TouchableOpacity
                        style={[s.islandBtn, s.islandBtnPrimary]}
                        onPress={() => handleSelectLook(autoLookIndex)}
                        activeOpacity={0.7}
                      >
                        <Check size={14} color="#fff" strokeWidth={2.8} />
                        <Text style={[s.islandBtnText, { color: "#fff" }]}>
                          Choose
                        </Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={() => {
                          if (styleMeAppendingLooks) return;
                          void Haptics.selectionAsync();
                          setMoreLooksMenuOpen(true);
                        }}
                        activeOpacity={styleMeAppendingLooks ? 1 : 0.7}
                        disabled={styleMeAppendingLooks}
                      >
                        <Plus
                          size={14}
                          color={Colors.text}
                          strokeWidth={2.4}
                        />
                        <Text style={s.islandBtnText}>More looks</Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={restartStyleMeSession}
                        activeOpacity={0.7}
                      >
                        <RotateCcw
                          size={14}
                          color={Colors.text}
                          strokeWidth={2.2}
                        />
                        <Text style={s.islandBtnText}>Restart</Text>
                      </TouchableOpacity>
                    </Animated.View>
                    )
                  ) : /* ── State 3: GET STYLED BUILDER sheet open (generating/config) */
                  autoBuilderSheetActive ? (
                    <Animated.View
                      key="aob-pill"
                      entering={FadeIn.duration(200)}
                      exiting={FadeOut.duration(200)}
                      style={[
                        s.islandTryOnSidesRoot,
                        tryOnDismissAnimatedStyle,
                      ]}
                    >
                      <Pressable
                        style={s.islandTryOnSideBackdropLeft}
                        onPress={() => closeAutoBuilder()}
                        accessibilityRole="button"
                        accessibilityLabel="Exit auto builder"
                      />
                      <Pressable
                        style={s.islandTryOnSideBackdropRight}
                        onPress={() => autoBuildPanelRef.current?.regenerate()}
                        accessibilityRole="button"
                        accessibilityLabel="Regenerate look"
                      />
                      <View
                        pointerEvents="none"
                        style={s.islandTryOnSidesForeground}
                      >
                        <View style={s.islandBtn}>
                          <X size={15} color={Colors.text} strokeWidth={2.4} />
                          <Text style={s.islandBtnText}>Close</Text>
                        </View>
                        <View style={s.islandDivider} />
                        <View style={s.islandGroup}>
                          <View style={s.islandBtn}>
                            <View style={s.islandActivePill}>
                              <RotateCcw
                                size={14}
                                color="#fff"
                                strokeWidth={2}
                              />
                              <Text
                                style={[s.islandBtnText, { color: "#fff" }]}
                              >
                                Regenerate
                              </Text>
                            </View>
                          </View>
                        </View>
                      </View>
                    </Animated.View>
                  ) : /* ── State 4: TRY-ON PICKER ──────────────────────────── */
                  tryOnPickerActive ? (
                    <Animated.View
                      key="tryon-pill"
                      style={[
                        s.islandTryOnSidesRoot,
                        tryOnDismissAnimatedStyle,
                      ]}
                    >
                      <Pressable
                        style={s.islandTryOnSideBackdropLeft}
                        onPress={() => {
                          closeTryOnPicker();
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                      />
                      <Pressable
                        style={s.islandTryOnSideBackdropRight}
                        onPress={() => {
                          void handleGenerateTryOn();
                        }}
                        disabled={generationPhase !== "idle"}
                        accessibilityRole="button"
                        accessibilityLabel="Generate"
                      />
                      <View
                        pointerEvents="none"
                        style={s.islandTryOnSidesForeground}
                      >
                        <View style={s.islandBtn}>
                          <X size={15} color={Colors.text} strokeWidth={2.4} />
                          <Text style={s.islandBtnText}>Cancel</Text>
                        </View>
                        <View style={s.islandDivider} />
                        <View style={s.islandGroup}>
                          <View style={[s.islandBtn, s.islandBtnPrimary]}>
                            <View
                              style={{
                                opacity: generationPhase !== "idle" ? 0.7 : 1,
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              {generationPhase === "idle" ? (
                                <Check size={14} color="#fff" strokeWidth={3} />
                              ) : null}
                              <Text
                                style={[s.islandBtnText, { color: "#fff" }]}
                              >
                                {generationPhase !== "idle"
                                  ? "Generating..."
                                  : "Generate Now"}
                              </Text>
                            </View>
                          </View>
                        </View>
                      </View>
                    </Animated.View>
                  ) : /* ── State 5: EDITING a Get Styled look (collapsed closet) ─ */
                  editingLookIndex !== null ? (
                    <Animated.View
                      key="editing-look"
                      entering={FadeIn.duration(180)}
                      exiting={FadeOut.duration(180)}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={handleCancelEditing}
                        activeOpacity={0.7}
                      >
                        <X size={14} color={Colors.text} strokeWidth={2.4} />
                        <Text style={s.islandBtnText}>Cancel</Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      <View style={s.islandGroup}>
                        <Text
                          style={[
                            s.islandBtnText,
                            {
                              color: Colors.textMuted,
                              paddingHorizontal: 8,
                            },
                          ]}
                          numberOfLines={1}
                        >
                          Look {(editingLookIndex ?? 0) + 1}
                        </Text>

                        <View style={s.islandDivider} />

                        <TouchableOpacity
                          style={[s.islandBtn, s.islandBtnPrimary]}
                          onPress={handleDoneEditing}
                          activeOpacity={0.7}
                        >
                          <Check size={14} color="#fff" strokeWidth={3} />
                          <Text style={[s.islandBtnText, { color: "#fff" }]}>
                            Done
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </Animated.View>
                  ) : /* ── State 5b: EDITING try-on pieces (render stashed) ──── */
                  editingTryOnLook ? (
                    <Animated.View
                      key="tryon-edit-pill"
                      entering={FadeIn.duration(180)}
                      exiting={FadeOut.duration(180)}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={cancelEditTryOnLook}
                        activeOpacity={0.7}
                      >
                        <X size={14} color={Colors.text} strokeWidth={2.4} />
                        <Text style={s.islandBtnText}>Cancel</Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={rerenderTryOnLook}
                        activeOpacity={0.7}
                        disabled={builderItems.length === 0}
                      >
                        <View
                          style={[
                            s.islandActivePill,
                            builderItems.length === 0 && { opacity: 0.5 },
                          ]}
                        >
                          <Text style={[s.islandBtnText, { color: "#fff" }]}>
                            Re-render
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </Animated.View>
                  ) : /* ── State 6: HERO (Try-On result) ────────────────────── */
                  heroImageUri && !autoBuilderDismissing ? (
                    saving ? (
                      <Animated.View
                        key="hero-saving-pill"
                        entering={FadeIn.duration(160)}
                        exiting={FadeOut.duration(160)}
                        style={{ flexDirection: "row", alignItems: "center" }}
                      >
                        <View style={[s.islandBtn, { paddingHorizontal: 16 }]}>
                          <Text style={s.islandBtnText}>Saving…</Text>
                        </View>
                      </Animated.View>
                    ) : (
                    <Animated.View
                      key="hero-pill"
                      entering={FadeIn.duration(200)}
                      exiting={FadeOut.duration(200)}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={() => {
                          Haptics.selectionAsync();
                          void handleGenerateTryOn();
                        }}
                        activeOpacity={0.7}
                        disabled={generationPhase !== "idle"}
                      >
                        <RotateCcw
                          size={14}
                          color={Colors.text}
                          strokeWidth={2}
                        />
                        <Text style={s.islandBtnText}>Try again</Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={beginEditTryOnLook}
                        activeOpacity={0.7}
                      >
                        <Pencil size={14} color={Colors.text} strokeWidth={2.2} />
                        <Text style={s.islandBtnText}>Edit pieces</Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      {savedToLibrary ? (
                        <TouchableOpacity
                          style={[s.islandBtn, s.islandSavedBtn]}
                          onPress={() => {
                            Haptics.selectionAsync();
                            void onViewInLibrary?.(savedToLibrary.outfitId);
                          }}
                          activeOpacity={0.7}
                          accessibilityRole="link"
                          accessibilityLabel="View saved look in library"
                        >
                          <Check
                            size={14}
                            color={Colors.accentDark}
                            strokeWidth={2.6}
                          />
                          <Text style={[s.islandSavedText, s.islandSavedLink]}>
                            {persistLookDone}
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={s.islandBtn}
                          onPress={requestSave}
                          activeOpacity={0.7}
                          disabled={saving}
                          accessibilityLabel="Save look"
                        >
                          <View style={s.islandActivePill}>
                            <Calendar size={13} color="#fff" strokeWidth={2} />
                            <Text style={[s.islandBtnText, { color: "#fff" }]}>
                              {persistLookVerb}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      )}
                    </Animated.View>
                    )
                  ) : (
                    /* ── State 7: DEFAULT (manual builder) ───────────────── */
                    <Animated.View
                      key="regular-pill"
                      entering={PREMIUM_FADE_IN}
                      exiting={PREMIUM_FADE_OUT}
                      layout={PREMIUM_ISLAND_LAYOUT}
                      style={{ flexDirection: "row", alignItems: "center" }}
                    >
                      <TouchableOpacity
                        style={s.islandBtn}
                        onPress={() => {
                          Haptics.selectionAsync();
                          // Whatever's already sitting on the manual canvas
                          // counts as pinned — opening Get Styled shouldn't
                          // silently drop pieces you just placed there.
                          openGetStyledComposer({
                            prefillAnchors: builderItems.map((it) => it.id),
                          });
                        }}
                        activeOpacity={0.7}
                      >
                        <Text style={s.islandBtnAccentText}>Get styled</Text>
                      </TouchableOpacity>

                      <View style={s.islandDivider} />

                      <View style={s.islandGroup}>
                        {!hasItems || generationPhase !== "idle" ? (
                          <Text style={s.islandEmptyHint}>
                            Add items to start
                          </Text>
                        ) : (
                          <>
                            <TouchableOpacity
                              style={s.islandBtn}
                              onPress={handleTryOn}
                              activeOpacity={0.7}
                            >
                              <User
                                size={15}
                                color={Colors.text}
                                strokeWidth={2.2}
                              />
                              <Text style={s.islandBtnText}>Try on</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                              style={[s.islandBtn, s.islandBtnPrimary]}
                              onPress={requestSave}
                              activeOpacity={0.7}
                              disabled={saving}
                              accessibilityLabel="Save look"
                            >
                              <Calendar
                                size={13}
                                color="#fff"
                                strokeWidth={2}
                              />
                              <Text
                                style={[s.islandBtnText, { color: "#fff" }]}
                              >
                                {persistLookVerb}
                              </Text>
                            </TouchableOpacity>
                          </>
                        )}
                      </View>
                    </Animated.View>
                  )}
                  </Animated.View>

                  {pillNotice ? (
                    <Animated.View
                      style={[s.pillNotice, pillNoticeStyle]}
                      pointerEvents={
                        pillNotice.actionLabel ? "box-none" : "none"
                      }
                    >
                      {pillNotice.variant === "success" ? (
                        <Check
                          size={15}
                          color={Colors.accentDark}
                          strokeWidth={2.6}
                        />
                      ) : pillNotice.variant === "error" ? (
                        <CircleAlert
                          size={15}
                          color={Colors.red}
                          strokeWidth={2.3}
                        />
                      ) : (
                        <Info
                          size={15}
                          color={Colors.textMuted}
                          strokeWidth={2.3}
                        />
                      )}
                      <Text
                        style={[
                          s.pillNoticeText,
                          pillNotice.variant === "hint" && s.pillNoticeTextHint,
                          pillNotice.variant === "error" && s.pillNoticeTextError,
                        ]}
                        numberOfLines={2}
                      >
                        {pillNotice.msg}
                      </Text>
                      {pillNotice.actionLabel ? (
                        <TouchableOpacity
                          onPress={() => {
                            pillNoticeTimers.current.forEach(clearTimeout);
                            pillNoticeTimers.current = [];
                            pillNoticeProgress.value = withTiming(0, {
                              duration: 200,
                              easing: Easing.in(Easing.cubic),
                            });
                            const run = pillNoticeActionRef.current;
                            pillNoticeActionRef.current = null;
                            setPillNotice(null);
                            void run?.();
                          }}
                          hitSlop={8}
                          activeOpacity={0.72}
                        >
                          <Text style={s.pillNoticeAction}>
                            {pillNotice.actionLabel} →
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </Animated.View>
                  ) : null}
                </Animated.View>
              </Animated.View>
            </Animated.View>
          ) : null}

          {!(DEBUG_HIDE_COLLAPSED_CAROUSEL && !manualExpanded) ? (
            <Animated.View
              style={[
                s.sheet,
                s.sheetOverlay,
                sheetAnimatedStyle,
                DEBUG_HIDE_COLLAPSED_DRAWER_BODY &&
                  !manualExpanded && {
                    backgroundColor: "transparent",
                    borderTopWidth: 0,
                    shadowOpacity: 0,
                    elevation: 0,
                  },
              ]}
            >
              <FrostedPlate
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <View style={s.sheetExpandedInnerFill}>
                <Animated.View
                  style={[
                    tryOnDismissAnimatedStyle,
                    { flex: 1, minHeight: 0, alignSelf: "stretch" },
                  ]}
                >
                  {hideExpandedAutoPullChrome ? (
                    <View
                      style={[s.sheetDragHeader, s.sheetDragHeaderHidden]}
                      pointerEvents="none"
                    />
                  ) : (
                    <GestureDetector
                      gesture={
                        manualExpanded && !tryOnPickerActive
                          ? expandedHeaderPan
                          : showCollapsedPullHintLayer && !manualExpanded
                            ? Gesture.Pan().enabled(false)
                            : panGesture
                      }
                    >
                        <View
                          style={[
                            s.sheetDragHeader,
                            tryOnPickerActive &&
                              !manualExpanded &&
                              s.sheetDragHeaderTryOnBare,
                            showCollapsedPullHintLayer &&
                              !manualExpanded &&
                              !tryOnPickerActive &&
                              s.sheetDragHeaderHidden,
                          ]}
                          onLayout={(e) => {
                            const h = Math.ceil(e.nativeEvent.layout.height);
                            if (h <= 0) return;
                            if (manualExpanded) {
                              setMeasuredExpandedPullHeaderH((p) =>
                                Math.abs(p - h) < 2 ? p : h,
                              );
                            } else if (tryOnPickerActive) {
                              setMeasuredTryOnCollapsedPullHeaderH((p) =>
                                Math.abs(p - h) < 2 ? p : h,
                              );
                            } else {
                              setMeasuredClosetCollapsedPullHeaderH((p) =>
                                Math.abs(p - h) < 2 ? p : h,
                              );
                            }
                          }}
                        >
                          {tryOnPickerActive && !manualExpanded ? (
                            <View style={s.handleWrap}>
                              <View style={s.handleSpacer} />
                            </View>
                          ) : !tryOnPickerActive &&
                            (showClosetPullChrome ||
                              styleMeStripActive ||
                              manualExpanded) ? (
                            <View style={s.handleWrap}>
                              {showClosetPullChrome ? (
                                <View style={s.handle} />
                              ) : (
                                <View style={s.handleSpacer} />
                              )}
                            </View>
                          ) : null}
                          <View
                            style={[
                              s.expandHintRow,
                              tryOnPickerActive &&
                                ({
                                  flexDirection: "column",
                                  paddingTop: 0,
                                  minHeight: 0,
                                  paddingBottom: 0,
                                } as const),
                            ]}
                          >
                            <Animated.View
                              style={[
                                tryOnPickerActive || styleMeStripActive
                                  ? headerHintAnimatedStyle
                                  : expandedPullHintOpacity,
                              ]}
                            >
                              {manualExpanded && !tryOnPickerActive
                                ? renderSheetPullHint("Swipe down to close", "down")
                                : styleMeStripActive &&
                                    !manualExpanded &&
                                    collapsedStripHint
                                  ? renderStripHint(collapsedStripHint)
                                  : null}

                              {tryOnPickerActive && (
                                <Animated.Text
                                  style={[
                                    s.expandHintText,
                                    s.expandHintTextCentered,
                                    tryOnEntryAnimatedStyle,
                                    {
                                      paddingHorizontal: 14,
                                    },
                                    !manualExpanded && s.expandHintTextTryOn,
                                  ]}
                                  numberOfLines={2}
                                >
                                  Upload or select a photo of yourself. If you
                                  don’t select one, the try-on will be generated
                                  on a mannequin.
                                </Animated.Text>
                              )}
                            </Animated.View>
                          </View>
                        </View>
                      </GestureDetector>
                    )}

                    <KeyboardAvoidingView
                      style={s.sheetBody}
                      behavior={Platform.OS === "ios" ? "padding" : undefined}
                      keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
                    >
                      <View style={s.bodyCrossfadeRoot}>
                        {/* Expanded content — always mounted, opacity crossfades with sheet height */}
                        <Animated.View
                          style={[
                            s.bodyCrossfadeExpanded,
                            expandedAnimatedStyle,
                          ]}
                          pointerEvents={manualExpanded ? "auto" : "none"}
                        >
                          <View style={s.manualExpandedPanel}>
                            <View style={s.manualExpandedPanelStack}>
                              {autoBuilderSheetActive ||
                              autoBuilderDismissing ? (
                                <Animated.View
                                  style={[
                                    s.tryOnExpandedOverlay,
                                    autoBuilderAnimatedStyle,
                                    {
                                      paddingBottom:
                                        autoBuilderOverlayNavFudgePx,
                                    },
                                  ]}
                                >
                                  <AutoOutfitBuilderPanel
                                    ref={autoBuildPanelRef}
                                    presentation="sheet"
                                    active
                                    onClose={() => closeAutoBuilder(false)}
                                    formSeed={autoBuilderFormSeed}
                                    onConsumeFormSeed={
                                      consumeAutoBuilderFormSeed
                                    }
                                    closetItems={scopedClosetItems}
                                    bodyPhotoUrl={bodyPhotoUrl}
                                    genderPref={genderPref}
                                    styleArchetypes={styleArchetypes}
                                    seedBuildAroundItemIds={
                                      autoBuilderSeedIds.length
                                        ? autoBuilderSeedIds
                                        : undefined
                                    }
                                    onConsumeBuildAroundSeed={() =>
                                      setAutoBuilderSeedIds([])
                                    }
                                    onApplyOutfit={handleApplyAutoOutfit}
                                    onLooksSummaryChange={
                                      handleAutoLooksSummaryChange
                                    }
                                  />
                                </Animated.View>
                              ) : null}
                              {tryOnPickerActive && manualExpanded ? (
                                <View
                                  style={s.tryOnExpandedOverlay}
                                  pointerEvents="auto"
                                >
                                  <TryOnModelCarousel
                                    variant="expanded"
                                    {...tryOnCarouselProps}
                                  />
                                </View>
                              ) : null}
                              <View
                                style={[
                                  s.manualExpandedClosetLayer,
                                  (!manualExpanded ||
                                    tryOnPickerActive ||
                                    autoBuilderSheetActive ||
                                    autoBuilderDismissing) &&
                                    s.manualExpandedClosetHidden,
                                ]}
                                pointerEvents={
                                  tryOnPickerActive && manualExpanded
                                    ? "none"
                                    : autoBuilderSheetActive
                                      ? "none"
                                      : "auto"
                                }
                              >
                                {editingLookIndex !== null ? (
                                  <View style={s.editLookBanner}>
                                    <Text style={s.editLookBannerLabel}>
                                      Editing Look {editingLookIndex + 1}
                                    </Text>
                                    <TouchableOpacity
                                      style={s.editLookCancelBtn}
                                      onPress={handleCancelEditing}
                                    >
                                      <Text style={s.editLookCancelTxt}>
                                        Cancel
                                      </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                      style={s.editLookDoneBtn}
                                      onPress={handleDoneEditing}
                                    >
                                      <Text style={s.editLookDoneTxt}>
                                        Done
                                      </Text>
                                    </TouchableOpacity>
                                  </View>
                                ) : (
                                  <View style={s.expandedClosetShell}>
                                    {renderWardrobeStrip()}
                                    {renderManualCategoryTabs(s.manualTabsExpanded, {
                                      includeThisFit: !getStyledAttachMode,
                                      pinAll: true,
                                    })}
                                    {closetBrowseCategory ||
                                    (!getStyledAttachMode &&
                                      manualCategory === IN_FIT_CHIP) ? null : (
                                      <>
                                        <View style={s.closetGridTopRow}>
                                          <Text
                                            style={s.closetGridTopTitle}
                                            numberOfLines={1}
                                          >
                                            {effectiveManualCategory === "All"
                                              ? "All closet"
                                              : effectiveManualCategory}
                                          </Text>
                                          <View style={s.closetGridChromeActions}>
                                            <ClosetToolbarSearchToggle
                                              expanded={closetToolbarExpanded}
                                              onPress={() =>
                                                setClosetToolbarExpanded(
                                                  (prev) => !prev,
                                                )
                                              }
                                              variant="ghost"
                                              style={s.headerCloseBtn}
                                            />
                                            {wardrobes.length ? (
                                              <ClosetToolbarWardrobeToggle
                                                expanded={expandedWardrobesVisible}
                                                onPress={() =>
                                                  setExpandedWardrobesVisible(
                                                    (prev) => !prev,
                                                  )
                                                }
                                                variant="ghost"
                                                style={s.headerCloseBtn}
                                              />
                                            ) : null}
                                            <TouchableOpacity
                                              style={s.headerCloseBtn}
                                              onPress={() => snapSheet(false)}
                                              hitSlop={6}
                                              activeOpacity={0.75}
                                              accessibilityLabel="Close closet"
                                            >
                                              <X
                                                size={15}
                                                color={Colors.text}
                                                strokeWidth={2.5}
                                              />
                                            </TouchableOpacity>
                                          </View>
                                        </View>
                                        <Text style={s.closetPickerHint}>
                                          {getStyledAttachMode
                                            ? "Tap an item to attach it to your Get Styled prompt."
                                            : "Tap an item to add it to the outfit. Tap it again on the canvas or strip to remove."}
                                        </Text>
                                      </>
                                    )}
                                    <View style={s.expandedClosetBody}>
                                      {closetBrowseCategory ? (
                                        <ClosetCategoryBrowse
                                          presentation="inline"
                                          visible
                                          categoryId={closetBrowseCategory}
                                          sourceItems={scopedClosetItems}
                                          onClose={() =>
                                            handleClosetBrowseChange(null)
                                          }
                                          backLabel="All"
                                          selectedIds={
                                            getStyledAttachMode
                                              ? getStyledAttachedIdSet
                                              : builderItemIds
                                          }
                                          onToggleId={
                                            getStyledAttachMode
                                              ? handleAttachItemIdToGetStyledPrompt
                                              : handlePickItemManual
                                          }
                                          onItemLongPress={
                                            onStripItemLongPress
                                              ? (item) =>
                                                  onStripItemLongPress(
                                                    item as ClosetItem,
                                                  )
                                              : undefined
                                          }
                                          tileBackgroundColor="transparent"
                                          pageBackgroundColor="transparent"
                                          contentBottomPad={sheetBottomPad}
                                          onSwipeDismissDrag={{
                                            onUpdate: onExpandedSheetDragUpdate,
                                            onEnd: onExpandedSheetDragEnd,
                                          }}
                                          onDismiss={() => snapSheet(false)}
                                          showCloseButton
                                          toolbarExpanded={closetToolbarExpanded}
                                          onToolbarExpandedChange={
                                            setClosetToolbarExpanded
                                          }
                                          headerExtraAction={
                                            wardrobes.length ? (
                                              <ClosetToolbarWardrobeToggle
                                                expanded={expandedWardrobesVisible}
                                                onPress={() =>
                                                  setExpandedWardrobesVisible(
                                                    (prev) => !prev,
                                                  )
                                                }
                                                variant="ghost"
                                              />
                                            ) : undefined
                                          }
                                        />
                                      ) : !getStyledAttachMode &&
                                        manualCategory === IN_FIT_CHIP ? (
                                        <ThisFitExpandedPanel
                                          items={builderItems}
                                          contentBottomPad={sheetBottomPad}
                                          readOnly={tryOnResultViewLocked}
                                          onRemove={handlePickItemManual}
                                          onSwap={beginItemSwap}
                                          onItemLongPress={
                                            onStripItemLongPress
                                              ? (item) =>
                                                  onStripItemLongPress(item)
                                              : undefined
                                          }
                                        />
                                      ) : (
                                        <ClosetPickerPanel
                                          variant="embedded"
                                          showHeader={false}
                                          items={scopedClosetItems}
                                          selected={
                                            getStyledAttachMode
                                              ? getStyledAttachedIdSet
                                              : builderItemIds
                                          }
                                          onToggle={
                                            getStyledAttachMode
                                              ? handleAttachItemIdToGetStyledPrompt
                                              : handlePickItemManual
                                          }
                                          mode="manual"
                                          category={effectiveManualCategory}
                                          onCategoryChange={
                                            onManualCategoryChange
                                          }
                                          search={manualSearch}
                                          onSearchChange={setManualSearch}
                                          contentBottomPad={sheetBottomPad}
                                          onItemLongPress={
                                            onStripItemLongPress
                                          }
                                          tileBackgroundColor="transparent"
                                          externalBrowse={{
                                            category: null,
                                            onChange:
                                              handleClosetBrowseChange,
                                            pageBackgroundColor: "transparent",
                                            hideBackHeader: true,
                                            backLabel: "All",
                                            onSwipeDismissDrag: {
                                              onUpdate:
                                                onExpandedSheetDragUpdate,
                                              onEnd: onExpandedSheetDragEnd,
                                            },
                                            onDismiss: () => snapSheet(false),
                                            showCloseButton: true,
                                          }}
                                          toolbarExpanded={closetToolbarExpanded}
                                          onToolbarExpandedChange={
                                            setClosetToolbarExpanded
                                          }
                                        />
                                      )}
                                    </View>
                                  </View>
                                )}
                              </View>
                            </View>
                          </View>
                        </Animated.View>

                        {/* Collapsed strip — pinned to sheet bottom, fades in once dismiss settles */}
                        <Animated.View
                          style={[
                            s.bodyCrossfadeStrip,
                            { height: stripOverlayBodyH },
                            stripAnimatedStyle,
                          ]}
                          pointerEvents={
                            manualExpanded
                              ? "none"
                              : DEBUG_HIDE_COLLAPSED_DRAWER_BODY
                                ? "none"
                                : "auto"
                          }
                        >
                          {(tryOnPickerActive || autoBuilderSheetActive) &&
                          manualExpanded ? null : (
                            <View style={s.sheetStripStack}>
                              <View
                                style={[
                                  s.sheetStripFrame,
                                  { height: stripOverlayBodyH },
                                ]}
                              >
                                {showClosetStrip ? (
                                  <Animated.View
                                    style={[
                                      s.manualBuilder,
                                      s.manualBuilderCollapsed,
                                      // manualBuilderCollapsed hardcodes the
                                      // old fixed strip height — override it
                                      // so the keyboard actually gets the
                                      // extra room stripOverlayBodyH grew by,
                                      // instead of staying capped underneath.
                                      getStyledPromptMode
                                        ? { height: stripOverlayBodyH }
                                        : null,
                                      closetCrossfadeAnimatedStyle,
                                    ]}
                                    pointerEvents={
                                      tryOnPickerActive ||
                                      autoLooksSummary.generating
                                        ? "none"
                                        : "auto"
                                    }
                                  >
                                    {getStyledPromptMode && !getStyledAttachMode
                                      ? null
                                      : renderManualCategoryTabs(s.manualTabs, {
                                          includeThisFit: !getStyledAttachMode,
                                        })}
                                    {manualHorizontalStripEl}
                                  </Animated.View>
                                ) : null}

                                {tryOnPickerActive && !manualExpanded ? (
                                  <Animated.View
                                    style={[
                                      s.sheetStripTryOnOverlay,
                                      tryOnRailAnimatedStyle,
                                      tryOnEntryAnimatedStyle,
                                    ]}
                                    pointerEvents="box-none"
                                  >
                                    <View
                                      style={[
                                        s.manualBuilder,
                                        s.tryOnBuilderCollapsed,
                                      ]}
                                    >
                                      <TryOnModelCarousel
                                        variant="compact"
                                        {...tryOnCarouselProps}
                                      />
                                    </View>
                                  </Animated.View>
                                ) : null}

                                {showGeneratingStrip ? (
                                  <View
                                    style={[
                                      s.manualBuilder,
                                      s.manualBuilderCollapsed,
                                      s.manualBuilderGenerating,
                                    ]}
                                  >
                                    <StyleMeGeneratingStrip
                                      stripHeight={STRIP_BODY_FIXED_H}
                                      bottomInset={STYLE_ME_STRIP_BOTTOM_INSET}
                                      tileWidth={STYLE_ME_STRIP_TILE.w}
                                      tileHeight={STYLE_ME_STRIP_TILE.h}
                                      placeholderCount={LOOK_BATCH_COUNT}
                                    />
                                  </View>
                                ) : null}

                                {showLooksStrip ? (
                                  <View
                                    style={[s.manualBuilder, s.manualBuilderCollapsed]}
                                  >
                                    <LooksTray
                                      ref={looksTrayRef}
                                      looks={autoLooksSummary.looks}
                                      closetItems={closetItems}
                                      activeLookIndex={autoLookIndex}
                                      editingLookIndex={editingLookIndex}
                                      stripHeight={STRIP_BODY_FIXED_H}
                                      bottomInset={STYLE_ME_STRIP_BOTTOM_INSET}
                                      tileWidth={STYLE_ME_STRIP_TILE.w}
                                      tileHeight={STYLE_ME_STRIP_TILE.h}
                                      appending={styleMeAppendingLooks}
                                      trailingSkeletonCount={LOOK_BATCH_COUNT}
                                      saving={saving}
                                      onFocusLook={applyAutoLookAtIndex}
                                      onTweakLook={handleSelectLook}
                                      onDoneEditing={handleDoneEditing}
                                      onCancelEditing={handleCancelEditing}
                                      onSave={requestSave}
                                      onPlan={() => setCalendarOpen(true)}
                                      onTryOn={handleTryOn}
                                      onRegenerateAll={onAutoCarouselRegenerate}
                                      onClear={() => clearStyleMeSession()}
                                    />
                                  </View>
                                ) : null}
                              </View>
                            </View>
                          )}
                        </Animated.View>
                      </View>
                    </KeyboardAvoidingView>
                  </Animated.View>
                  {showCollapsedPullHintLayer &&
                  (!getStyledPromptMode || getStyledAttachMode) ? (
                    <GestureDetector gesture={panGesture}>
                      <Animated.View
                        style={[
                          s.collapsedPullChrome,
                          { bottom: STRIP_BODY_FIXED_H },
                          collapsedPullHintOpacity,
                        ]}
                        pointerEvents="box-none"
                        onLayout={(e) => {
                          const h = Math.ceil(e.nativeEvent.layout.height);
                          if (h <= 0) return;
                          setMeasuredClosetCollapsedPullHeaderH((p) =>
                            Math.abs(p - h) < 2 ? p : h,
                          );
                        }}
                      >
                        <View style={s.handleWrap}>
                          <View style={s.handle} />
                        </View>
                        <View style={s.expandHintRow}>
                          {collapsedStripHint
                            ? renderStripHint(collapsedStripHint)
                            : null}
                        </View>
                      </Animated.View>
                    </GestureDetector>
                  ) : null}
                </View>
            </Animated.View>
          ) : null}

        </View>

        <Modal
          visible={tryOnSparseModalVisible}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setTryOnSparseModalVisible(false)}
        >
          <View style={s.conflictModalRoot} pointerEvents="box-none">
            <Pressable
              style={s.conflictModalBackdrop}
              onPress={() => {
                Haptics.selectionAsync();
                setTryOnSparseModalVisible(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
            />
            <Animated.View
              entering={FadeInUp.duration(300)}
              style={[
                s.conflictSheet,
                s.tryOnSparseSheet,
                { paddingBottom: Math.max(insets.bottom, 14) + 10 },
              ]}
            >
              <View style={s.conflictSheetGrabber} />
              <View style={s.conflictSheetHeader}>
                <View style={s.conflictSheetTitleBlock}>
                  <Text style={s.conflictSheetKicker}>Just checking</Text>
                  <Text style={s.conflictSheetSubtitle}>
                    Are you sure you want to try this on by itself? It usually
                    looks best with a full outfit, but feel free to continue if
                    you’re just testing out specific pieces.
                  </Text>
                </View>
                <TouchableOpacity
                  style={s.conflictSheetCloseHit}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setTryOnSparseModalVisible(false);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss"
                >
                  <X size={22} color={Colors.textMuted} strokeWidth={2.2} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[s.conflictPrimaryBtn, { marginTop: 16 }]}
                activeOpacity={0.88}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setTryOnSparseModalVisible(false);
                  // Start the transition immediately but with a tiny delay for the state sync
                  requestAnimationFrame(() => {
                    proceedTryOnPicker();
                  });
                }}
                accessibilityRole="button"
                accessibilityLabel="Continue to try-on"
              >
                <Text style={s.conflictPrimaryBtnText}>Continue</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.conflictGhostBtn}
                activeOpacity={0.75}
                onPress={() => {
                  Haptics.selectionAsync();
                  setTryOnSparseModalVisible(false);
                }}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <Text style={s.conflictGhostBtnText}>Add more items</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </Modal>

        <Modal
          visible={tryOnExitModalVisible}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setTryOnExitModalVisible(false)}
        >
          <View style={s.conflictModalRoot} pointerEvents="box-none">
            <Pressable
              style={s.conflictModalBackdrop}
              onPress={() => {
                Haptics.selectionAsync();
                setTryOnExitModalVisible(false);
              }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
            />
            <Animated.View
              entering={FadeInUp.duration(300)}
              style={[
                s.conflictSheet,
                s.tryOnSparseSheet,
                { paddingBottom: Math.max(insets.bottom, 14) + 10 },
              ]}
            >
              <View style={s.conflictSheetGrabber} />
              <View style={s.conflictSheetHeader}>
                <View style={s.conflictSheetTitleBlock}>
                  <Text style={s.conflictSheetKicker}>
                    Save this look?
                  </Text>
                  <Text style={s.conflictSheetSubtitle}>
                    {editingPreviouslySavedLook
                      ? "Update the saved look or keep the original and save a new copy."
                      : "Save to add it to your Library."}
                  </Text>
                </View>
                <TouchableOpacity
                  style={s.conflictSheetCloseHit}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setTryOnExitModalVisible(false);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss"
                >
                  <X size={22} color={Colors.textMuted} strokeWidth={2.2} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[s.conflictPrimaryBtn, { marginTop: 16 }]}
                activeOpacity={0.88}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  void handleTryOnExitSave();
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  editingPreviouslySavedLook ? "Update saved look" : "Save to Library"
                }
              >
                <Text style={s.conflictPrimaryBtnText}>
                  {editingPreviouslySavedLook ? "Update saved look" : "Save to Library"}
                </Text>
              </TouchableOpacity>
              {editingPreviouslySavedLook ? (
                <TouchableOpacity
                  style={s.conflictGhostBtn}
                  activeOpacity={0.75}
                  onPress={() => {
                    Haptics.selectionAsync();
                    void handleTryOnExitSave(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Save as new look"
                >
                  <Text style={s.conflictGhostBtnText}>Save as new look</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={s.conflictGhostBtn}
                activeOpacity={0.75}
                onPress={() => {
                  Haptics.selectionAsync();
                  void handleTryOnExitSkip();
                }}
                accessibilityRole="button"
                accessibilityLabel="Leave without saving"
              >
                <Text style={s.conflictGhostBtnText}>Don’t save</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </Modal>

        <Modal
          visible={!!selfieToDelete}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setSelfieToDelete(null)}
        >
          <View style={s.conflictModalRoot} pointerEvents="box-none">
            <Pressable
              style={s.conflictModalBackdrop}
              onPress={() => {
                Haptics.selectionAsync();
                setSelfieToDelete(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
            />
            <Animated.View
              entering={FadeInUp.duration(300)}
              style={[
                s.conflictSheet,
                { paddingBottom: Math.max(insets.bottom, 14) + 10 },
              ]}
            >
              <View style={s.conflictSheetGrabber} />
              <View style={s.deleteConfirmRow}>
                <View style={s.deleteConfirmTextCol}>
                  <Text style={s.conflictSheetKicker}>Remove photo</Text>
                  <Text style={s.conflictSheetSubtitle}>
                    This try-on photo will be removed. You can always upload it
                    again later.
                  </Text>
                </View>
                {selfieToDelete && (
                  <View style={s.deleteConfirmThumbWrapCompact}>
                    <Image
                      source={{ uri: selfieToDelete }}
                      style={s.deleteConfirmThumb}
                      contentFit="contain"
                    />
                  </View>
                )}
                <TouchableOpacity
                  style={s.deleteConfirmCloseAbsolute}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSelfieToDelete(null);
                  }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                >
                  <X size={20} color={Colors.textMuted} strokeWidth={2.2} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[s.conflictPrimaryBtn, { backgroundColor: "#ff3b30" }]}
                activeOpacity={0.88}
                onPress={handleConfirmDeleteSelfie}
                accessibilityRole="button"
                accessibilityLabel="Confirm removal"
              >
                <Text style={s.conflictPrimaryBtnText}>Remove photo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.conflictGhostBtn}
                activeOpacity={0.75}
                onPress={() => {
                  Haptics.selectionAsync();
                  setSelfieToDelete(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Cancel removal"
              >
                <Text style={s.conflictGhostBtnText}>Keep it</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </Modal>

        <Modal
          visible={!!pendingConflict}
          transparent
          animationType="fade"
          statusBarTranslucent
          onRequestClose={() => setPendingConflict(null)}
        >
          <View style={s.conflictModalRoot} pointerEvents="box-none">
            <Pressable
              style={s.conflictModalBackdrop}
              onPress={() => {
                Haptics.selectionAsync();
                setPendingConflict(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            />
            {pendingConflict ? (
              <Animated.View
                entering={FadeInUp.duration(300)}
                style={[
                  s.conflictSheet,
                  { paddingBottom: Math.max(insets.bottom, 14) + 10 },
                ]}
              >
                <View style={s.conflictSheetGrabber} />
                <ScrollView
                  style={s.conflictSheetScroll}
                  contentContainerStyle={s.conflictSheetScrollContent}
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                >
                <View style={s.conflictSheetHeader}>
                  <View style={s.conflictSheetTitleBlock}>
                    <Text style={s.conflictSheetKicker}>Swap pieces</Text>
                    <Text style={s.conflictSheetSubtitle} numberOfLines={3}>
                      {pendingConflict.body}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={s.conflictSheetCloseHit}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setPendingConflict(null);
                    }}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss"
                  >
                    <X size={22} color={Colors.textMuted} strokeWidth={2.2} />
                  </TouchableOpacity>
                </View>

                <View style={s.conflictSwapRow}>
                  <View style={s.conflictSwapCol}>
                    <Text style={s.conflictSwapColLabel}>On outfit</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={s.conflictThumbScroll}
                    >
                      {pendingConflict.conflicting.map((c) => (
                        <View key={c.id} style={s.conflictThumbCell}>
                          <View style={s.conflictThumb}>
                            {c.image_url ? (
                              <ClosetItemImage
                                uri={c.image_url}
                                style={s.conflictThumbImg}
                                contentFit="contain"
                              />
                            ) : (
                              <View style={s.conflictThumbEmpty}>
                                <Box
                                  size={26}
                                  color={Colors.textMuted}
                                  strokeWidth={2}
                                />
                              </View>
                            )}
                          </View>
                          <Text
                            style={s.conflictThumbCaption}
                            numberOfLines={2}
                          >
                            {c.name ?? "Item"}
                          </Text>
                        </View>
                      ))}
                    </ScrollView>
                  </View>

                  <View style={s.conflictSwapDivider}>
                    <ArrowRightLeft
                      size={22}
                      color={Colors.textLight}
                      strokeWidth={2.2}
                    />
                  </View>

                  <View style={s.conflictSwapCol}>
                    <Text style={s.conflictSwapColLabel}>Adding</Text>
                    <View style={s.conflictThumbCellSingle}>
                      <View style={s.conflictThumb}>
                        {pendingConflict.incoming.image_url ? (
                          <ClosetItemImage
                            uri={pendingConflict.incoming.image_url}
                            style={s.conflictThumbImg}
                            contentFit="contain"
                          />
                        ) : (
                          <View style={s.conflictThumbEmpty}>
                            <Plus
                              size={26}
                              color={Colors.textMuted}
                              strokeWidth={2}
                            />
                          </View>
                        )}
                      </View>
                      <Text style={s.conflictThumbCaption} numberOfLines={2}>
                        {pendingConflict.incoming.name ?? "Item"}
                      </Text>
                    </View>
                  </View>
                </View>

                {pendingConflict.replaceEvictIds &&
                pendingConflict.replaceEvictIds.length <
                  pendingConflict.conflicting.length &&
                pendingConflict.layerStackKind ? (
                  <Text style={s.conflictSwapPartialHint}>
                    {pendingConflict.layerStackKind === "top"
                      ? "Only the outer top is swapped — your base layer stays."
                      : pendingConflict.layerStackKind === "bottom"
                        ? "Only the outer bottom is swapped — the layer underneath stays."
                        : "Only the outer jacket is swapped — the inner layer stays."}
                  </Text>
                ) : null}

                <TouchableOpacity
                  style={s.conflictPrimaryBtn}
                  activeOpacity={0.88}
                  onPress={() => {
                    Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Success,
                    );
                    const evictIds = [
                      ...(pendingConflict.replaceEvictIds ??
                        pendingConflict.conflicting.map((c) => c.id)),
                      ...(pendingConflict.swapOutId
                        ? [pendingConflict.swapOutId]
                        : []),
                    ].filter(
                      (evictId, idx, arr) => arr.indexOf(evictId) === idx,
                    );
                    commitItemAdd(pendingConflict.incoming, evictIds);
                    if (pendingConflict.swapOutId) {
                      setManualCategory(IN_FIT_CHIP);
                      setClosetBrowseCategory(null);
                    }
                    pendingSwapItemIdRef.current = null;
                    setPendingConflict(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Apply swap and add item"
                >
                  <Text style={s.conflictPrimaryBtnText}>Apply swap</Text>
                </TouchableOpacity>
                {pendingConflict.allowAddAnyway !== false ? (
                  <TouchableOpacity
                    style={s.conflictAddAnywayBtn}
                    activeOpacity={0.82}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      const evictIds = pendingConflict.swapOutId
                        ? [pendingConflict.swapOutId]
                        : [];
                      commitItemAdd(pendingConflict.incoming, evictIds, {
                        bypassSlotGuards: true,
                      });
                      if (pendingConflict.swapOutId) {
                        setManualCategory(IN_FIT_CHIP);
                        setClosetBrowseCategory(null);
                      }
                      pendingSwapItemIdRef.current = null;
                      setPendingConflict(null);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Add item without swapping — bypass slot rules"
                  >
                    <Text style={s.conflictAddAnywayBtnText}>Add anyway</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  style={s.conflictGhostBtn}
                  activeOpacity={0.75}
                  onPress={() => {
                    Haptics.selectionAsync();
                    pendingSwapItemIdRef.current = null;
                    setPendingConflict(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel swap"
                >
                  <Text style={s.conflictGhostBtnText}>Not now</Text>
                </TouchableOpacity>
                </ScrollView>
              </Animated.View>
            ) : null}
          </View>
        </Modal>

        <CalendarSheet
          visible={calendarOpen}
          onClose={() => setCalendarOpen(false)}
          onSelectDate={(d) => {
            setPlannedDate(d);
            setCalendarOpen(false);
          }}
        />
      </View>
    </View>
  );
};

const BuilderPanel = forwardRef<BuilderPanelHandle, Props>(
  BuilderPanelComponent,
);

export default BuilderPanel;

BuilderPanel.displayName = "BuilderPanel";

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap: { flex: 1, position: "relative" },
  /** Full-screen warm base — must reach physical bottom so tab bar blur matches Home */
  pageBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.homeHeroBackdrop,
    zIndex: 0,
  },
  stageLayer: {
    flex: 1,
    position: "relative",
    zIndex: 1,
  },
  /** Full-bleed studio plate — floor pinned to physical bottom (incl. home indicator). */
  stageStudioFill: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
    zIndex: 0,
  },
  /** Narrow try-on hint sheet — same chrome as swap conflict, smaller max height. */
  tryOnSparseSheet: {
    maxHeight: "64%",
    paddingBottom: 24,
  },
  stage: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    width: "100%",
    zIndex: 1,
  },
  /** Full builder area — stays full size; closet sheet slides over it. */
  previewFill: {
    ...StyleSheet.absoluteFillObject,
    /** Let collage scroll + slight transforms paint without clipping (sheet still covers bottom). */
    overflow: "visible",
    flexDirection: "column",
  },
  canvasStack: {
    flex: 1,
    minHeight: 0,
  },
  dayContextBanner: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 5,
  },
  dayContextBannerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 7,
    borderRadius: Radii.full,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
    shadowColor: "#3D3530",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
    maxWidth: "84%",
  },
  dayContextBannerText: {
    fontWeight: Typography.weights.semibold,
    fontSize: 13,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  dayContextBannerClose: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.homeHeroBackdrop,
    marginLeft: 2,
  },
  /** Above the bottom sheet so the Island stays visible + tappable. */
  actionIslandContainer: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 80,
    alignItems: "center",
    elevation: 24,
  },
  stripRenderingDimmed: {
    opacity: 0.4,
  },
  actionIslandBlur: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    minHeight: 50,
  },
  actionIslandClip: {
    overflow: "hidden",
    position: "relative",
  },
  actionIslandComposerShape: {
    borderRadius: Radii.lg,
  },
  actionIslandClipWithAttachment: {
    overflow: "visible",
  },
  actionIslandContentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  pillNotice: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: 18,
  },
  pillNoticeText: {
    ...EditorialStyles.floatPillActionText,
    fontSize: 14,
    flexShrink: 1,
    textAlign: "center",
  },
  pillNoticeTextHint: {
    color: Colors.textMuted,
    fontSize: 13,
  },
  pillNoticeTextError: {
    color: Colors.text,
    fontSize: 13,
  },
  pillNoticeAction: {
    ...EditorialStyles.floatPillActionText,
    fontSize: 12,
    color: Colors.textMuted,
    textDecorationLine: "underline",
    flexShrink: 0,
  },

  islandGroup: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
  },
  islandBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radii.full,
    minHeight: 30,
  },
  islandBtnPrimary: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 14,
  },
  /** Non-interactive "still generating" state for the results pill — same
   * layout as Choose/More looks/Restart, just dimmed and un-pressable. */
  islandPillDimmed: {
    opacity: 0.45,
  },
  islandActivePill: {
    backgroundColor: Colors.accent,
    borderRadius: Radii.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  islandSavedBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 4,
  },
  islandSavedText: {
    ...EditorialStyles.floatPillActionText,
    color: Colors.accentDark,
    fontWeight: Typography.weights.semibold,
  },
  islandSavedLink: {
    textDecorationLine: "underline",
  },
  islandActiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.text,
    marginLeft: 6,
  },
  islandBtnText: {
    ...EditorialStyles.floatPillActionText,
    lineHeight: 18,
    ...(Platform.OS === "android" ? { includeFontPadding: false } : {}),
  },
  islandBtnAccentText: {
    ...EditorialStyles.floatPillActionAccent,
    lineHeight: 18,
    ...(Platform.OS === "android" ? { includeFontPadding: false } : {}),
  },
  islandDivider: {
    width: 1,
    alignSelf: "center",
    height: 20,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  islandMenuStack: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 2,
    paddingHorizontal: 4,
    gap: 2,
  },
  islandMenuQuestion: {
    ...EditorialStyles.floatPillActionAccent,
    fontSize: 11,
    lineHeight: 14,
    paddingHorizontal: 10,
    paddingTop: 2,
  },
  islandMenuRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  islandTryOnSidesRoot: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
  },
  islandTryOnSideBackdropLeft: {
    position: "absolute",
    left: -8,
    right: "50%",
    top: -10,
    bottom: -10,
    zIndex: 0,
  },
  islandTryOnSideBackdropRight: {
    position: "absolute",
    left: "50%",
    right: -8,
    top: -10,
    bottom: -10,
    zIndex: 0,
  },
  islandTryOnSidesForeground: {
    position: "relative",
    zIndex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  islandEmptyHint: {
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    paddingHorizontal: 16,
    paddingVertical: 6,
    fontStyle: "italic",
  },
  actionPillTextActive: {
    color: "#fff",
  },
  sheet: {
    width: "100%",
    flexDirection: "column",
    backgroundColor: "transparent",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 0,
    shadowOpacity: 0,
    elevation: 0,
    overflow: "hidden",
  },
  sheetOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
  },
  sheetDragHeader: { flexShrink: 0 },
  /** Expanded Auto Builder — no pull chrome (pan doesn’t resize sheet here). */
  sheetDragHeaderHidden: {
    height: 0,
    minHeight: 0,
    overflow: "hidden",
    opacity: 0,
  },
  /** Try-on: instructional copy only — no divider above carousel. */
  sheetDragHeaderTryOnBare: {
    paddingTop: 0,
    paddingBottom: 0,
    justifyContent: "center",
  },
  sheetExpandedInnerFill: {
    alignSelf: "stretch",
    flex: 1,
    minHeight: 0,
    zIndex: 1,
    position: "relative",
  },
  /** “Pull up for closet” — pinned above strip so it never rides the sheet top down. */
  collapsedPullChrome: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 4,
    alignItems: "center",
    backgroundColor: "transparent",
  },
  sheetBody: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  manualStripScroll: {
    alignSelf: "stretch",
    flexGrow: 0,
    flexShrink: 0,
  },
  manualStripMorph: {
    flex: 1,
    minHeight: 0,
    alignSelf: "stretch",
  },
  /** EXPERIMENT: Get Styled composer — the island morphs into an AI-chat
   * style input card while the custom keyboard is up: typed draft on top,
   * controls row underneath (attach / closet-mode chip / mic / send). The
   * island wrapper's existing layout={LinearTransition} animates the pill →
   * card size morph. Left-cluster buttons are visual placeholders for now. */
  getStyledComposer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  getStyledAttachmentRow: {
    position: "absolute",
    top: -60,
    left: 14,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  getStyledAttachmentThumbWrap: {
    width: 44,
    height: 54,
    borderRadius: 10,
    backgroundColor: Colors.glassFill,
    borderWidth: 1,
    borderColor: "rgba(95,82,71,0.14)",
    overflow: "visible",
  },
  getStyledAttachmentThumb: {
    width: "100%",
    height: "100%",
    borderRadius: 10,
  },
  getStyledAttachmentThumbFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  getStyledAttachmentRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.navBarFillOnWarm,
    borderWidth: 1,
    borderColor: "rgba(95,82,71,0.16)",
  },
  getStyledWeatherToast: {
    position: "absolute",
    top: -42,
    left: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.navBarFillOnWarm,
    borderWidth: 1,
    borderColor: "rgba(95,82,71,0.14)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 6,
    zIndex: 12,
  },
  getStyledWeatherToastText: {
    fontWeight: Typography.weights.semibold,
    fontSize: 12,
    color: Colors.text,
    letterSpacing: -0.1,
  },
  getStyledComposerText: {
    fontWeight: Typography.weights.medium,
    fontSize: 14,
    lineHeight: 19,
    color: Colors.text,
    textAlign: "left",
  },
  getStyledComposerPlaceholder: {
    color: Colors.textMuted,
  },
  getStyledComposerPlaceholderOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
  getStyledComposerInput: {
    // Native multiline field — cap height so it grows a few lines then
    // scrolls, and strip the default vertical padding for tight alignment.
    maxHeight: 88,
    minHeight: 22,
    paddingTop: 0,
    paddingBottom: 0,
    margin: 0,
  },
  getStyledComposerInputWrap: {
    position: "relative",
  },
  getStyledComposerCaretMeasure: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
  },
  /** Real blinking cursor bar — sized to actually read as a native cursor
   * (a thin text glyph like "|" was far too small/thin against the real
   * one). Height matches getStyledComposerText's lineHeight (19). */
  getStyledComposerCaret: {
    position: "absolute",
    top: 1,
    width: 2,
    height: 17,
    borderRadius: 1,
    backgroundColor: Colors.accent,
  },
  getStyledComposerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  getStyledComposerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.glassFill,
    borderWidth: 1,
    borderColor: "rgba(95,82,71,0.14)",
  },
  getStyledComposerAttachBtn: {
    width: undefined,
    minWidth: 112,
    paddingHorizontal: 12,
    flexDirection: "row",
    gap: 6,
  },
  getStyledComposerAttachText: {
    fontWeight: Typography.weights.semibold,
    fontSize: 12.5,
    color: Colors.text,
    letterSpacing: -0.12,
  },
  getStyledComposerAttachTextActive: {
    color: Colors.white,
  },
  getStyledComposerIconBtnActive: {
    backgroundColor: Colors.text,
    borderColor: Colors.text,
  },
  getStyledComposerModeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 34,
    paddingHorizontal: 13,
    borderRadius: 17,
    backgroundColor: Colors.glassFill,
    borderWidth: 1,
    borderColor: "rgba(95,82,71,0.14)",
  },
  getStyledComposerModeText: {
    fontWeight: Typography.weights.semibold,
    fontSize: 12.5,
    color: Colors.text,
  },
  getStyledComposerSpacer: {
    flex: 1,
  },
  getStyledComposerIconGhost: {
    width: 30,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  getStyledComposerMicActive: {
    backgroundColor: Colors.accent,
    borderRadius: 15,
  },
  getStyledComposerSend: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.text,
  },
  /** EXPERIMENT: Get Styled custom on-screen keyboard — replaces the item
   * carousel, sized to fit the same fixed strip height. */
  getStyledKb: {
    flex: 1,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  getStyledKbRow: {
    flex: 1,
    flexDirection: "row",
  },
  getStyledKbRowInset: {
    flex: 0.52,
  },
  /** Touch cell — flex weight + 2px padding stands in for the old row gaps,
   * so the space BETWEEN keys registers presses too (was a dead zone). */
  getStyledKbCell: {
    padding: 2,
    alignSelf: "stretch",
  },
  getStyledKbKey: {
    flex: 1,
    alignSelf: "stretch",
    borderRadius: Radii.sm,
    backgroundColor: Colors.glassFill,
    borderWidth: 1,
    borderColor: "rgba(95,82,71,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  getStyledKbKeyPressed: {
    transform: [{ scale: 0.96 }],
    backgroundColor: Colors.glassFillMuted,
  },
  getStyledKbKeyText: {
    fontWeight: Typography.weights.medium,
    fontSize: 14,
    color: Colors.text,
  },
  getStyledKbUtilityKeyActive: {
    backgroundColor: Colors.text,
    borderColor: Colors.text,
  },
  getStyledKbDone: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  getStyledKbDoneText: {
    fontWeight: Typography.weights.semibold,
    fontSize: 13,
    color: "#fff",
  },
  handleWrap: { alignItems: "center", paddingTop: 3, paddingBottom: 0 },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  /** Invisible handle footprint — keeps Get Styled header same height as closet. */
  handleSpacer: {
    width: 40,
    height: 4,
    opacity: 0,
  },
  expandHintRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingBottom: 1,
    paddingTop: 0,
    minHeight: 32,
    gap: 10,
    position: "relative",
  },
  expandHintCenter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 16,
    alignSelf: "stretch",
    width: "100%",
  },
  expandHintChevron: {
    flexShrink: 0,
  },
  expandHintTextInRow: {
    flexShrink: 1,
    textAlign: "center",
  },
  expandHintTextCentered: {
    textAlign: "center",
    alignSelf: "stretch",
  },
  expandHintText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
  },
  expandHintTextTryOn: {
    fontSize: 10.5,
    lineHeight: 13,
  },
  headerCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: Radii.full,
    ...EditorialStyles.ghostIconBtn,
    alignItems: "center",
    justifyContent: "center",
  },
  // ── Manual panel ───────────────────────────────────────────────────────────

  manualExpandedPanel: {
    flex: 1,
    minHeight: 0,
  },
  /** Closet + try-on expanded share one stack so ClosetPickerPanel stays mounted (fast dismiss). */
  manualExpandedPanelStack: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  tryOnExpandedOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
  manualExpandedClosetLayer: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "transparent",
  },
  manualExpandedClosetHidden: {
    opacity: 0,
  },
  /** Strip: ghost base (absolute, opacity 0) stays mounted; try-on sits in flow so onLayout/min sheet height stay correct. */
  sheetStripStack: {
    position: "relative",
  },
  sheetStripFrame: {
    width: "100%",
    position: "relative",
    overflow: "hidden",
  },
  sheetStripTryOnOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
  },
  sheetStripGhostLayer: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0,
  },
  closetGridTopRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 4,
    gap: 10,
  },
  closetGridTopTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  closetGridChromeActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  closetPickerHint: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    paddingTop: 0,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.textMuted,
    letterSpacing: -0.15,
  },
  editLookBanner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  editLookBannerLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    letterSpacing: -0.15,
  },
  editLookCancelBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.full,
  },
  editLookCancelTxt: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  editLookDoneBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radii.full,
    backgroundColor: Colors.accent,
  },
  editLookDoneTxt: {
    fontSize: 13,
    fontWeight: Typography.weights.bold,
    color: "#fff",
  },
  bodyCrossfadeRoot: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  bodyCrossfadeExpanded: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  bodyCrossfadeStrip: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "transparent",
  },
  manualBuilder: {
    paddingBottom: 0,
  },
  manualBuilderCollapsed: {
    height: STRIP_BODY_FIXED_H,
    justifyContent: "flex-start",
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: "transparent",
  },
  tryOnBuilderCollapsed: {
    height: STRIP_BODY_FIXED_H,
    justifyContent: "flex-end",
    paddingTop: TRY_ON_STRIP_TILE_INSET,
    backgroundColor: "transparent",
  },
  manualBuilderGenerating: {
    justifyContent: "flex-start",
  },
  wardrobeStripWrap: {
    paddingHorizontal: 4,
    paddingTop: 2,
    paddingBottom: 4,
  },
  manualTabs: {
    marginBottom: 2,
    paddingBottom: 2,
  },
  manualTabsClosetOnlyTrack: {
    minHeight: 42,
  },
  manualTabsExpanded: {
    paddingTop: 2,
    paddingBottom: 4,
  },
  expandedClosetShell: {
    flex: 1,
    minHeight: 0,
  },
  expandedClosetBody: {
    flex: 1,
    minHeight: 0,
  },
  thisFitExpandedWrap: {
    flex: 1,
    minHeight: 0,
  },
  thisFitPlaceholderRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    width: "100%",
    paddingBottom: 2,
  },
  thisFitPlaceholderTile: {
    height: MANUAL_STRIP_TILE.h,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.06)",
    flexShrink: 0,
  },
  manualItems: {
    paddingLeft: MANUAL_STRIP_EDGE_INSET,
    paddingRight: 16,
    gap: 10,
    paddingBottom: 2,
  },
  manualItem: {
    width: MANUAL_STRIP_TILE.w,
    height: MANUAL_STRIP_TILE.h,
    borderRadius: 16,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 0,
  },
  manualItemActive: {
    borderWidth: 2,
    borderColor: Colors.accent,
  },
  getStyledAttachItemActive: {
    borderWidth: 2,
    borderColor: Colors.text,
  },
  manualItemImg: {
    width: "100%",
    height: "100%",
    transform: [{ scale: 1.14 }],
  },
  manualItemCheck: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  getStyledAttachCheck: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineSavePanel: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 12,
  },
  inlineSaveTitle: {
    fontSize: 16,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  inlineSaveInput: {
    height: 44,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radii.sm,
    paddingHorizontal: 14,
    fontSize: 14,
    fontWeight: Typography.weights.medium,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  inlineSaveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  inlinePlanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  inlinePlanLabel: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    letterSpacing: -0.2,
  },
  inlinePlanLabelActive: { color: Colors.text },
  inlineSaveBtn: {
    flex: 1,
    height: 48,
    backgroundColor: Colors.text,
    borderRadius: Radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineSaveLabel: {
    fontSize: 15,
    fontWeight: Typography.weights.bold,
    color: "#fff",
    letterSpacing: -0.2,
  },

  manualSeparator: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginVertical: 12,
    gap: 12,
  },
  manualSeparatorSoft: {
    fontSize: 11,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  manualSeparatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.border,
    opacity: 0.6,
  },
  manualSeparatorText: {
    fontSize: 10,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  // ── Swap conflict sheet (modal) ─────────────────────────────────────────────
  conflictModalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  conflictModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "transparent",
  },
  conflictSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    paddingHorizontal: 20,
    paddingTop: 8,
    borderTopWidth: 1,
    borderColor: Colors.border,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    maxHeight: "72%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 28,
    zIndex: 2,
  },
  conflictSheetGrabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.1)",
    marginBottom: 12,
  },
  conflictSheetScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  conflictSheetScrollContent: {
    paddingBottom: 2,
  },
  conflictSheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 6,
  },
  conflictSheetTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  conflictSheetKicker: {
    fontSize: 13,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.25,
    marginBottom: 4,
  },
  conflictSheetSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: Colors.textLight,
    letterSpacing: -0.15,
  },
  conflictSheetCloseHit: {
    padding: 4,
    marginTop: -4,
    marginRight: -4,
  },
  conflictSwapRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 18,
    marginTop: 6,
  },
  conflictSwapCol: {
    flex: 1,
    minWidth: 0,
  },
  conflictSwapColLabel: {
    fontSize: 11,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 8,
  },
  conflictSwapDivider: {
    alignSelf: "center",
    paddingTop: 18,
    opacity: 0.85,
  },
  conflictSwapPartialHint: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
    textAlign: "center",
    marginBottom: 14,
    marginTop: -8,
    paddingHorizontal: 8,
    letterSpacing: -0.1,
  },
  conflictThumbScroll: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 2,
    paddingRight: 4,
  },
  conflictThumbCell: {
    width: 92,
  },
  conflictThumbCellSingle: {
    alignItems: "center",
    width: 92,
    alignSelf: "center",
  },
  conflictThumb: {
    width: 88,
    height: 88,
    borderRadius: Radii.md,
    overflow: "hidden",
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  conflictThumbImg: {
    width: "100%",
    height: "100%",
  },
  conflictThumbEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceAlt,
  },
  conflictThumbCaption: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: Typography.weights.medium,
    color: Colors.textLight,
    textAlign: "center",
    letterSpacing: -0.1,
    lineHeight: 14,
  },
  conflictPrimaryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: Radii.full,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  conflictPrimaryBtnText: {
    fontSize: 16,
    fontWeight: Typography.weights.bold,
    color: "#fff",
    letterSpacing: -0.2,
  },
  conflictAddAnywayBtn: {
    marginTop: 10,
    borderRadius: Radii.full,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  conflictAddAnywayBtnText: {
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  conflictGhostBtn: {
    marginTop: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  conflictGhostBtnText: {
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    letterSpacing: -0.15,
  },

  deleteConfirmRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    gap: 16,
  },
  deleteConfirmTextCol: {
    flex: 1,
  },
  deleteConfirmThumbWrapCompact: {
    width: 96,
    height: 120,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: Editorial.navBarFill,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  deleteConfirmCloseAbsolute: {
    position: "absolute",
    top: 4,
    right: 12,
  },
  deleteConfirmThumb: {
    width: "100%",
    height: "100%",
  },
});
