import { useUser } from "@clerk/clerk-expo";
import {
    cropGarments,
    cropGarmentsFromOriginal,
    segmentItems,
} from "clothing-isolator";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    ActivityIndicator,
    Alert,
    DeviceEventEmitter,
    Dimensions,
    Image,
    Linking,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    type StyleProp,
    type ViewStyle,
} from "react-native";
import {
    Gesture,
    GestureDetector,
    GestureHandlerRootView,
    ScrollView as GHScrollView,
    TouchableOpacity as GHTouchableOpacity,
} from "react-native-gesture-handler";
import Animated, {
    FadeIn,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { shelfIdForCategoryChip } from "../components/closet/closetShelfUtils";
import ColorPickerTriggerIcon from "../components/color-picker/ColorPickerTriggerIcon";
import IosStyleColorPickerModal from "../components/color-picker/IosStyleColorPickerModal";
import ZoomedItemThumb from "../components/ZoomedItemThumb";
import { apiClient } from "../constants/api-client";
import { APP_ITEM_NAMED_COLORS } from "../constants/appNamedColors";
import { Colors, Styles } from "../constants/AppTheme";
import { OCCASIONS_FLAT } from "../constants/occasions";
import { ensureJpegUri } from "../lib/ensureJpegForVision";
import {
  isShoeMeta,
  mergePairShoeMetasInBatch,
  mergeShoeIsolatesForSegmentBatch,
  mergeShoePairBoxesBeforeCrop,
} from "../lib/mergeShoeScanDuplicates";
import { supabase } from "../lib/supabase";
import { consumeLibraryIntent } from "../lib/uploadIntent";

const { width, height: windowHeight } = Dimensions.get("window");

/**
 * Smooth Reanimated crossfade between two image URIs on a white background.
 * When `uri` changes, the previous image stays mounted beneath while the new
 * one fades in over 320ms — gives the "raw photo → clean cutout" Aesty reveal.
 */
function CrossfadeThumbImage({
  uri,
  style,
  resizeMode = "contain",
  selfAspect = false,
}: {
  uri: string;
  style: StyleProp<ViewStyle>;
  resizeMode?: "contain" | "cover";
  // When true, reads the image's natural dimensions and applies them as
  // `aspectRatio` on the outer View — the card shapes itself around the
  // garment so contain-mode has no wasted bands. Clamped to [0.55, 1.4] so
  // extreme-aspect items (long pants, wide belts) don't blow up row height.
  selfAspect?: boolean;
}) {
  const [prevUri, setPrevUri] = useState<string | null>(null);
  const [curUri, setCurUri] = useState<string>(uri);
  // Seed with 4:5 portrait (typical garment) so card has a sensible height
  // before Image.getSize resolves — prevents a zero-height flash on mount.
  const [aspect, setAspect] = useState<number | undefined>(selfAspect ? 0.8 : undefined);
  const topOpacity = useSharedValue(1);

  useEffect(() => {
    if (uri === curUri) return;
    setPrevUri(curUri);
    setCurUri(uri);
    topOpacity.value = 0;
    topOpacity.value = withTiming(1, { duration: 320 });
    // Drop the previous image from the tree shortly after the crossfade ends.
    const t = setTimeout(() => setPrevUri(null), 380);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  useEffect(() => {
    if (!selfAspect || !curUri) return;
    let cancelled = false;
    Image.getSize(
      curUri,
      (w, h) => {
        if (cancelled || w <= 0 || h <= 0) return;
        const raw = w / h;
        setAspect(Math.max(0.55, Math.min(1.4, raw)));
      },
      () => { /* ignore */ },
    );
    return () => { cancelled = true; };
  }, [curUri, selfAspect]);

  const topStyle = useAnimatedStyle(() => ({ opacity: topOpacity.value }));

  return (
    <View
      style={[
        style,
        selfAspect && aspect
          ? { aspectRatio: aspect, height: undefined }
          : null,
        { overflow: "hidden", backgroundColor: "#fff" },
      ]}
    >
      {prevUri ? (
        <Image
          source={{ uri: prevUri }}
          style={StyleSheet.absoluteFillObject}
          resizeMode={resizeMode}
        />
      ) : null}
      <Animated.Image
        source={{ uri: curUri }}
        style={[StyleSheet.absoluteFillObject, topStyle]}
        resizeMode={resizeMode}
      />
    </View>
  );
}

/** Minimum box span in 0–1000 space so crops are never hairlines (models love mirror edges). */
const MIN_BOX_2D_SPAN = 115;
const MIN_BOX_2D_SPAN_ACCESSORY = 40;
/** Fit-check: lower = allow tighter crops (more “zoom”) on jewelry / small items. */
const MIN_BOX_2D_SPAN_ACCESSORY_FITCHECK = 118;
/** Necklaces / chains on fit-check: allow very tight boxes (more zoom than other accessories). */
const MIN_BOX_2D_SPAN_NECKLACE_FITCHECK = 92;
/** Fit-check shoes: min span; pair merge + foot clamp handle width — keep this moderate. */
const MIN_BOX_2D_SPAN_SHOE_FITCHECK = 218;
/** Fit-check pants/bottoms/skirts: higher = less “zoomed in” on legs only. */
const MIN_BOX_2D_SPAN_BOTTOMS_FITCHECK = 262;
const MIN_BOX_2D_SPAN_BOTTOMS_FLATLAY = 228;
/** Fit-check tops: min span; width is also forced wide below (torso-only boxes are too narrow). */
const MIN_BOX_2D_SPAN_TOP_FITCHECK = 240;
const MIN_BOX_2D_SPAN_TOP_FLATLAY = 188;
/** Dress / jumpsuit when classify uses `full body` — need both collar and hem room. */
const MIN_BOX_2D_SPAN_FULL_BODY_FITCHECK = 208;
const MIN_BOX_2D_SPAN_FULL_BODY_FLATLAY = 192;

function isTinyAccessoryLike(meta: any): boolean {
  const text =
    `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.name ?? ""}`
      .toLowerCase()
      .trim();
  if (!text) return false;
  return (
    /\baccessory\b/.test(text) ||
    /\b(jewelry|jewellery|earring|ring|bracelet|watch|brooch|pendant|chain|choker)\b/.test(
      text,
    )
  );
}

function isBottomsLike(meta: any): boolean {
  const cat = classifyCategoryLower(meta);
  if (cat === "bottom") return true;
  const text =
    `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.type ?? ""} ${meta?.name ?? ""}`
      .toLowerCase()
      .trim();
  if (!text) return false;
  return /\b(pants?|jeans?|trousers?|slacks?|bottoms?|shorts?|leggings?|chinos?|cargo|joggers?|sweatpants?|denim|skirts?)\b/.test(
    text,
  );
}

function isNeckJewelryText(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  return (
    /\b(necklace|choker|pendant|body\s*chain|neck\s*chain)\b/.test(t) ||
    /\bchain\b/.test(t)
  );
}

/** Necklaces / chains / chokers — tighter min-span + override than ties or scarves. */
function isNeckJewelryLike(meta: any): boolean {
  const text =
    `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.type ?? ""} ${meta?.name ?? ""}`
      .toLowerCase()
      .trim();
  return isNeckJewelryText(text);
}

/**
 * Vision returns a tall skinny torso strip; we must ALWAYS re-center and widen X — never
 * early-return when w already “looks ok” or sleeves stay clipped. Min ~72% of frame width.
 */
function ensureTopGarmentMinimumWidth(box: number[]): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  if (h < 36) return box;
  const minW = Math.min(985, Math.max(720, Math.round(0.78 * h)));
  const cx = (xmin + xmax) / 2;
  let half = Math.round(minW / 2);
  let nxmin = Math.round(cx - half);
  let nxmax = Math.round(cx + half);
  if (nxmin < 0) {
    nxmax -= nxmin;
    nxmin = 0;
  }
  if (nxmax > 1000) {
    nxmin -= nxmax - 1000;
    nxmax = 1000;
  }
  nxmin = Math.max(0, nxmin);
  nxmax = Math.min(1000, nxmax);
  let actualW = nxmax - nxmin;
  if (actualW < minW - 1) {
    if (nxmin <= 0) nxmax = Math.min(1000, nxmin + minW);
    else if (nxmax >= 1000) nxmin = Math.max(0, nxmax - minW);
  }
  nxmin = Math.max(0, nxmin);
  nxmax = Math.min(1000, nxmax);
  if (nxmax <= nxmin) return [ymin, xmin, ymax, xmax];
  return [ymin, nxmin, ymax, nxmax];
}

/**
 * Shirts/tops: same aggressive horizontal padding for flat_lay and fit_check (mirror
 * uploads often hit flat_lay — 8% side was leaving sleeves out).
 */
function expandBoxForTopGarmentCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  // fit_check: modest expansion only — per-box Vision segmentation (Swift) finds
  // true garment edges precisely, so we only need a small context border.
  // Old 22% side + hard y-clamps were hacks for the full-body mask slicing approach.
  const up   = mode === "fit_check" ? 0.02 : 0.06;
  const down = mode === "fit_check" ? 0.02 : 0.05;
  const side = mode === "fit_check" ? 0.25 : 0.22; // 25% side pad gives Vision context to drop background
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  const expanded = [ymin, xmin, ymax, xmax];
  return mode === "fit_check" ? expanded : ensureTopGarmentMinimumWidth(expanded);
}

/**
 * Pants/bottoms: bias **down** (hem/cuffs/shoes) + waist context **up**.
 */
function expandBoxForBottomsGarmentCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  // fit_check: reduced expansion — per-box Vision finds the pant boundaries precisely.
  const up   = mode === "fit_check" ? 0.04 : 0.06;
  const down = mode === "fit_check" ? 0.04 : 0.06;
  const side = mode === "fit_check" ? 0.25 : 0.05; // Critical for removing bg between legs
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  if (mode === "fit_check") {
    // Only prevent crops that reach the very floor (shoes bleeding in).
    // Removed the waist clamp (ymin<392) — it forced the box down into a fixed
    // body position that broke seated shots and close-framed photos.
    if (ymax > 940) ymax = 940;
    const nh = ymax - ymin;
    const nw = xmax - xmin;
    // Don't letterbox to a skinny vertical strip; allow a natural leg aspect.
    const maxW = Math.round(nh * 1.32);
    if (nw > maxW) {
      const cx = (xmin + xmax) / 2;
      xmin = Math.max(0, Math.round(cx - maxW / 2));
      xmax = Math.min(1000, Math.round(cx + maxW / 2));
    }
  }
  return [ymin, xmin, ymax, xmax];
}

/** `category: full body` (dress / one-piece) — strong **up** + **down** so neither collar nor hem clips. */
function expandBoxForFullBodyGarmentCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  const up = mode === "fit_check" ? 0.04 : 0.06;
  const down = mode === "fit_check" ? 0.04 : 0.06;
  const side = mode === "fit_check" ? 0.20 : 0.05;
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  return [ymin, xmin, ymax, xmax];
}

function classifyCategoryLower(meta: any): string {
  return String(meta?.category ?? "")
    .toLowerCase()
    .trim();
}

/** Matches api-client classify: top|bottom|outerwear|full body|shoes|accessory|bag */
function isFullBodyCategory(meta: any): boolean {
  return classifyCategoryLower(meta) === "full body";
}

/** Native isolator may return transparent PNG data URIs or file:// paths — match Supabase content-type. */
function guessMimeFromImageUri(uri: string): {
  ext: string;
  contentType: string;
} {
  const u = uri.trim().toLowerCase();
  if (u.startsWith("data:image/png"))
    return { ext: "png", contentType: "image/png" };
  if (u.startsWith("data:image/jpeg") || u.startsWith("data:image/jpg"))
    return { ext: "jpg", contentType: "image/jpeg" };
  if (u.includes(".png")) return { ext: "png", contentType: "image/png" };
  return { ext: "jpg", contentType: "image/jpeg" };
}

/**
 * Items that should be skipped on FIT-CHECK photos (worn outfits) — too small to crop well.
 * Users should photograph these individually as flat-lays. We still allow them on flat-lay photos.
 * KEEPS: necklaces (visible chains), watches, sunglasses, hats, belts, scarves, ties, bags.
 * SKIPS: socks, earrings, rings, bracelets/anklets, hair ties, scrunchies, hair clips, small pendants.
 */
function isSkippableOnFitCheck(meta: any): boolean {
  const text =
    `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.name ?? ""}`
      .toLowerCase()
      .trim();
  if (!text) return false;
  return /\b(socks?|earrings?|ring|rings|bracelets?|anklets?|hair\s*tie|scrunchies?|hair\s*clip|hairband|headband|bobby\s*pin|barrette|small\s*pendant)\b/.test(
    text,
  );
}

/**
 * For accessories on fit-check photos, Gemini's box is often mis-aimed (e.g. glasses
 * mapped to the torso). Override the box based on where the item *must* be on a human body.
 * Returns [ymin, xmin, ymax, xmax] in 0–1000 coords, or null to use Gemini's box.
 */
function fitCheckBoxAccessoryOverride(meta: any): number[] | null {
  const tags = Array.isArray(meta?.style_tags) ? (meta.style_tags as unknown[]).join(" ") : "";
  const text = `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.type ?? ""} ${meta?.name ?? ""} ${meta?.color ?? ""} ${tags}`.toLowerCase().trim();
  
  const hasHeadwear = /\b(hat|cap|beanie|beret|visor|snapback|fedora|bucket\s*hat|baseball\s*cap)\b/.test(text);
  const hasEyewear = /\b(glasses|sunglasses|eyewear|spectacles|goggles|shades|sunnies|aviators?|wayfarers?)\b/.test(text);
  
  if (hasEyewear && !hasHeadwear) return [40, 340, 240, 660];
  if (hasHeadwear) return [0, 300, 240, 700];
  if (isNeckJewelryText(text)) return [230, 310, 400, 690];
  if (/\b(collar|tie|bow\s*tie|necktie|scarf|bandana)\b/.test(text)) return [180, 280, 480, 720];
  if (/\bbelt\b/.test(text)) return [380, 300, 540, 700];
  // Footwear is purposely excluded so its dynamic box is preserved.
  return null;
}

function expandBoxForAccessoryCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  const up = mode === "fit_check" ? 0.10 : 0.10;
  const down = mode === "fit_check" ? 0.10 : 0.10;
  const side = mode === "fit_check" ? 0.25 : 0.15;
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  return [ymin, xmin, ymax, xmax];
}

function expandBoxForFootwearCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  const up = mode === "fit_check" ? 0.05 : 0.10;
  const down = mode === "fit_check" ? 0.05 : 0.10;
  const side = mode === "fit_check" ? 0.25 : 0.15;
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  return [ymin, xmin, ymax, xmax];
}

/** Tops / outerwear — includes classify `category` so “outerwear” isn’t missed when name lacks “jacket”. */
function isTopGarment(meta: any): boolean {
  const cat = classifyCategoryLower(meta);
  if (cat === "outerwear" || cat === "top") return true;
  const text =
    `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.type ?? ""} ${meta?.name ?? ""}`
      .toLowerCase()
      .trim();
  return /\b(shirt|tee|t-?shirt|top|blouse|sweater|sweatshirt|hoodie|jacket|coat|blazer|cardigan|vest|tank|crop\s*top|polo|jersey|tunic|dress|romper|jumpsuit|bodysuit|suit|outerwear|knit|fleece|crewneck|pullover|henley)\b/.test(
    text,
  );
}

/**
 * Expand boxes that are too narrow or too short so native/JS crops stay usable.
 * Keeps box center, clamps to 0–1000.
 */
function expandDegenerateBox2d(box: number[], minSpan: number): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  let w = xmax - xmin;
  let h = ymax - ymin;
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;

  if (w < minSpan) {
    w = minSpan;
    xmin = cx - w / 2;
    xmax = cx + w / 2;
    if (xmin < 0) {
      xmax -= xmin;
      xmin = 0;
    }
    if (xmax > 1000) {
      xmin -= xmax - 1000;
      xmax = 1000;
    }
  }
  if (h < minSpan) {
    h = minSpan;
    ymin = cy - h / 2;
    ymax = cy + h / 2;
    if (ymin < 0) {
      ymax -= ymin;
      ymin = 0;
    }
    if (ymax > 1000) {
      ymin -= ymax - 1000;
      ymax = 1000;
    }
  }

  xmin = Math.max(0, xmin);
  xmax = Math.min(1000, xmax);
  ymin = Math.max(0, ymin);
  ymax = Math.min(1000, ymax);
  if (xmax <= xmin || ymax <= ymin) return box;
  return [
    Math.round(ymin),
    Math.round(xmin),
    Math.round(ymax),
    Math.round(xmax),
  ];
}

/**
 * Resize an image (URI or data URI) to max 1024px on longest side before sending to OpenAI.
 * Returns a plain base64 string (no data: prefix).
 */
async function resizeForVision(sourceUri: string): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width: 1024 } }],
      {
        compress: 0.82,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      },
    );
    return result.base64 ?? "";
  } catch {
    // Fallback: strip prefix from data URI if resize fails
    if (sourceUri.startsWith("data:")) {
      return sourceUri.replace(/^data:image\/\w+;base64,/, "");
    }
    return "";
  }
}

/**
 * Tight direct box crop for fit-check / OOTD photos — no Vision, no segmentation.
 *
 * The key insight: VNGenerateForegroundInstanceMaskRequest segments "foreground" (the
 * whole person), it doesn't understand "shirt" vs "pants." Running it even on a pre-cropped
 * shirt region still includes the visible head and pants — so Vision always bleeds in the
 * wrong body parts. The competitor apps skip Vision entirely for OOTD photos and just crop
 * Gemini's box with a small padding. The item fills the frame precisely; natural background
 * is kept (which is fine and even looks good in the review card).
 *
 * 4% context pad keeps item edges from being flush against the thumbnail border.
 */
async function jsFitCheckCrop(
  originalUri: string,
  items: any[],
): Promise<any[]> {
  // Resolve file dimensions + stable file URI once; reuse for every crop.
  let imgW = 0;
  let imgH = 0;
  let resolvedUri = originalUri;
  try {
    const info = await ImageManipulator.manipulateAsync(originalUri, [], {
      format: ImageManipulator.SaveFormat.JPEG,
    });
    imgW = info.width;
    imgH = info.height;
    resolvedUri = info.uri;
  } catch {
    /* ignore — fallback below */
  }

  if (!imgW || !imgH) {
    return items.map((m: any) => ({
      ...m,
      sourceUri: originalUri,
      originalSourceUri: originalUri,
      isIsolated: false,
    }));
  }

  return Promise.all(
    items.map(async (m: any) => {
      const fallback = {
        ...m,
        sourceUri: originalUri,
        originalSourceUri: originalUri,
        isIsolated: false,
      };
      if (!Array.isArray(m.box_2d) || m.box_2d.length !== 4) return fallback;
      const [ymin, xmin, ymax, xmax] = m.box_2d as number[];
      if (xmax <= xmin || ymax <= ymin) return fallback;
      try {
        const rawX = (xmin / 1000) * imgW;
        const rawY = (ymin / 1000) * imgH;
        const rawW = ((xmax - xmin) / 1000) * imgW;
        const rawH = ((ymax - ymin) / 1000) * imgH;
        const pad = 0.02; // 2% breathing room — tighter per engineer recommendation
        const originX = Math.max(0, Math.round(rawX - rawW * pad));
        const originY = Math.max(0, Math.round(rawY - rawH * pad));
        const cropW = Math.min(
          Math.round(rawW * (1 + pad * 2)),
          imgW - originX,
        );
        const cropH = Math.min(
          Math.round(rawH * (1 + pad * 2)),
          imgH - originY,
        );
        if (cropW < 20 || cropH < 20) return fallback;
        const result = await ImageManipulator.manipulateAsync(
          resolvedUri,
          [{ crop: { originX, originY, width: cropW, height: cropH } }],
          {
            compress: 0.92,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );
        const sourceUri = result.base64
          ? `data:image/jpeg;base64,${result.base64}`
          : originalUri;
        return {
          ...m,
          sourceUri,
          originalSourceUri: originalUri,
          isIsolated: true,
        };
      } catch {
        return fallback;
      }
    }),
  );
}

/**
 * Fit-check OOTD photos: tight direct crop (no Vision).
 * Flat-lay photos: Vision segmentation + background removal.
 *
 * For fit-check we trust Gemini's box_2d directly with minimal expansion —
 * the box already tells us where the shirt/pants/shoes are. Adding heavy expansion
 * or running Vision on top causes exactly the problem that made shirts show heads/pants.
 */
async function cropItemsForFitCheck(
  originalUri: string,
  _maskedUri: string | null,
  items: any[],
  photoLayout: "flat_lay" | "fit_check" = "fit_check",
): Promise<any[]> {
  const effectiveLayout: "flat_lay" | "fit_check" = photoLayout;

  const filtered =
    effectiveLayout === "fit_check"
      ? items.filter((m: any) => !isSkippableOnFitCheck(m))
      : items;

  const prepared = filtered.map((m: any) => {
    let activeBox = m.box_2d;
    if (!Array.isArray(activeBox) || activeBox.length !== 4) return m;

    if (effectiveLayout === "fit_check") {
      const override = fitCheckBoxAccessoryOverride(m);
      if (override) {
        activeBox = override;
      }
    }

    const minSpan = isTinyAccessoryLike(m)
      ? MIN_BOX_2D_SPAN_ACCESSORY
      : isFullBodyCategory(m)
        ? MIN_BOX_2D_SPAN_FULL_BODY_FLATLAY
        : isBottomsLike(m)
          ? MIN_BOX_2D_SPAN_BOTTOMS_FLATLAY
          : isTopGarment(m)
            ? MIN_BOX_2D_SPAN_TOP_FLATLAY
            : MIN_BOX_2D_SPAN;
    
    let box = expandDegenerateBox2d(activeBox as number[], minSpan);
    
    if (isFullBodyCategory(m)) {
      box = expandBoxForFullBodyGarmentCrop(box, effectiveLayout);
    } else if (isTopGarment(m)) {
      box = expandBoxForTopGarmentCrop(box, effectiveLayout);
    } else if (isBottomsLike(m)) {
      box = expandBoxForBottomsGarmentCrop(box, effectiveLayout);
    } else if (isShoeMeta(m)) {
      box = expandBoxForFootwearCrop(box, effectiveLayout);
    } else {
      box = expandBoxForAccessoryCrop(box, effectiveLayout);
    }
    
    return { ...m, box_2d: box };
  });


  // ── fit_check: tight box → Vision → background removed cleanly ──────────
  // The tight Gemini box (collar-to-hem for a shirt, waist-to-ankle for pants) is
  // the critical ingredient. Our Swift cropGarmentsFromOriginal now pre-crops that
  // small region and runs Vision only on it — so Vision sees "just a shirt" not a
  // full person, and masks exactly the shirt. Background removal works; head/pants
  // bleed is gone. jsFitCheckCrop is the fallback when Swift Vision fails.
  if (effectiveLayout === "fit_check") {
    const boxes: number[][] = prepared
      .map((m: any) => m.box_2d)
      .filter(Array.isArray);
    if (boxes.length > 0) {
      const origB64 = await imageUriToPlainBase64(originalUri);
      if (origB64) {
        const freshCrops = await cropGarmentsFromOriginal(origB64, boxes);
        if (freshCrops.length === boxes.length) {
          let i = 0;
          return mergePairShoeMetasInBatch(
            prepared.map((m: any) => ({
              ...m,
              sourceUri:
                m.box_2d && Array.isArray(m.box_2d)
                  ? freshCrops[i++]
                  : originalUri,
              originalSourceUri: originalUri,
              isIsolated: true,
            })),
          );
        }
      }
    }
    // Fallback: plain tight crop (no background removal) if native Vision fails.
    return mergePairShoeMetasInBatch(await jsFitCheckCrop(originalUri, prepared));
  }

  // ── flat_lay: Vision segmentation + background removal ──────────────────
  const boxes: number[][] = prepared
    .map((m: any) => m.box_2d)
    .filter(Array.isArray);

  if (boxes.length > 0) {
    const origB64 = await imageUriToPlainBase64(originalUri);
    if (origB64) {
      const freshCrops = await cropGarmentsFromOriginal(origB64, boxes);
      if (freshCrops.length === boxes.length) {
        let i = 0;
        return prepared.map((m: any) => ({
          ...m,
          sourceUri:
            m.box_2d && Array.isArray(m.box_2d) ? freshCrops[i++] : originalUri,
          originalSourceUri: originalUri,
          isIsolated: true,
        }));
      }
    }
  }
  return cropItemsByBoxes(originalUri, prepared, effectiveLayout, true);
}



/**
 * Crop each box from a single image (original file or data URI). Used as fallback when
 * masked+fallback native path is unavailable (e.g. Android).
 */
async function cropItemsByBoxes(
  sourceImageUri: string,
  items: any[],
  layoutMode: "flat_lay" | "fit_check" = "flat_lay",
  boxesAlreadyExpanded = false,
): Promise<any[]> {
  const prepared = items.map((m: any) => {
    if (!Array.isArray(m.box_2d) || m.box_2d.length !== 4) return m;
    if (boxesAlreadyExpanded) return { ...m };
    const minSpan = isShoeMeta(m)
      ? MIN_BOX_2D_SPAN_SHOE_FITCHECK
      : isNeckJewelryLike(m)
        ? MIN_BOX_2D_SPAN_NECKLACE_FITCHECK
        : isTinyAccessoryLike(m)
          ? MIN_BOX_2D_SPAN_ACCESSORY
          : isFullBodyCategory(m)
            ? MIN_BOX_2D_SPAN_FULL_BODY_FLATLAY
            : isBottomsLike(m)
              ? MIN_BOX_2D_SPAN_BOTTOMS_FLATLAY
              : isTopGarment(m)
                ? MIN_BOX_2D_SPAN_TOP_FLATLAY
                : MIN_BOX_2D_SPAN;
    let box = expandDegenerateBox2d(m.box_2d as number[], minSpan);
    if (isFullBodyCategory(m)) {
      box = expandBoxForFullBodyGarmentCrop(box, layoutMode);
    } else {
      if (isTopGarment(m)) {
        box = expandBoxForTopGarmentCrop(box, layoutMode);
      }
      if (isBottomsLike(m)) {
        box = expandBoxForBottomsGarmentCrop(box, layoutMode);
      }
    }
    return { ...m, box_2d: box };
  });
  const boxes: number[][] = prepared
    .map((m: any) => m.box_2d)
    .filter(Array.isArray);

  if (boxes.length > 0) {
    const imageB64 = await imageUriToPlainBase64(sourceImageUri);
    if (imageB64) {
      const nativeCrops = await cropGarments(imageB64, boxes);
      if (nativeCrops.length === boxes.length) {
        let i = 0;
        return prepared.map((m: any) => ({
          ...m,
          sourceUri:
            m.box_2d && Array.isArray(m.box_2d)
              ? nativeCrops[i++]
              : sourceImageUri,
          originalSourceUri: sourceImageUri,
          isIsolated: true,
        }));
      }
    }
    return await Promise.all(
      prepared.map(async (m: any) => {
        const cropped = m.box_2d
          ? await jsCropBox(sourceImageUri, m.box_2d as number[])
          : null;
        return {
          ...m,
          sourceUri: cropped ?? sourceImageUri,
          originalSourceUri: sourceImageUri,
          isIsolated: true,
        };
      }),
    );
  }

  return prepared.map((m: any) => ({
    ...m,
    sourceUri: sourceImageUri,
    originalSourceUri: sourceImageUri,
    isIsolated: true,
  }));
}

/**
 * JS fallback crop: used when native cropGarments is unavailable (pre-rebuild).
 * Crops box_2d [ymin,xmin,ymax,xmax] (0–1000) from a data URI with 15% padding.
 */
async function jsCropBox(
  dataUri: string,
  box2d: number[],
): Promise<string | null> {
  if (!box2d || box2d.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = box2d;
  if (xmax <= xmin || ymax <= ymin) return null;
  try {
    // Save data URI to temp file first — ImageManipulator is more reliable with file URIs
    const saved = await ImageManipulator.manipulateAsync(dataUri, [], {
      format: ImageManipulator.SaveFormat.JPEG,
    });
    const imgW = saved.width;
    const imgH = saved.height;
    if (!imgW || !imgH) return null;
    const pad = 0.2;
    const rawX = (xmin / 1000) * imgW;
    const rawY = (ymin / 1000) * imgH;
    const rawW = ((xmax - xmin) / 1000) * imgW;
    const rawH = ((ymax - ymin) / 1000) * imgH;
    const originX = Math.max(0, Math.round(rawX - rawW * pad));
    const originY = Math.max(0, Math.round(rawY - rawH * pad));
    const cropW = Math.min(Math.round(rawW * (1 + pad * 2)), imgW - originX);
    const cropH = Math.min(Math.round(rawH * (1 + pad * 2)), imgH - originY);
    if (cropW < 20 || cropH < 20) return null;
    // Use saved.uri (file path) not the original data URI for the crop
    const result = await ImageManipulator.manipulateAsync(
      saved.uri,
      [{ crop: { originX, originY, width: cropW, height: cropH } }],
      {
        compress: 0.92,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      },
    );
    return result.base64 ? `data:image/jpeg;base64,${result.base64}` : null;
  } catch {
    return null;
  }
}

type AutoSegmentStrategy = "per_segment" | "flat_lay_boxes" | "fit_check_boxes";

async function getImagePixelSize(
  uriOrDataUri: string,
): Promise<{ w: number; h: number } | null> {
  try {
    const r = await ImageManipulator.manipulateAsync(uriOrDataUri, [], {
      compress: 1,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    if (r.width && r.height) return { w: r.width, h: r.height };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * One Vision instance: infer "worn outfit / full-body" (classify+crop on original) vs
 * flat-lay / multi-item from crop size vs full photo.
 *
 * Important: a single tall mask (e.g. pants laid vertically on a bed) must NOT trigger
 * fit-check — that path crops poorly for flat lays. Fit-check is for portrait mirror/OOTD shots.
 */
async function shouldTreatSingleSegmentAsFitCheck(
  originalUri: string,
  segmentDataUri: string,
): Promise<boolean> {
  const orig = await getImagePixelSize(originalUri);
  const seg = await getImagePixelSize(segmentDataUri);
  if (!orig || !seg) return false;
  const origA = orig.w * orig.h;
  const segA = seg.w * seg.h;
  if (origA <= 0 || segA <= 0) return false;
  const areaFrac = segA / origA;
  const segAR = seg.w > 0 ? seg.h / seg.w : 1;
  const origAR = orig.w > 0 ? orig.h / orig.w : 1;
  // Landscape / square source photos are almost never “full-body worn outfit” for our fit-check box model.
  if (origAR <= 1.08) return false;
  // Tall mask + coverage — but require portrait-ish photo so we don’t treat flat-lay pants as a person crop.
  if (segAR >= 1.35 && areaFrac >= 0.2 && origAR >= 1.18) return true;
  if (origAR >= 1.22 && segAR >= 1.12 && areaFrac >= 0.24) return true;
  // More mirror OOTDs: portrait photo + person-sized mask (segment not tiny).
  if (origAR >= 1.15 && segAR >= 1.0 && areaFrac >= 0.16) return true;
  return false;
}

/**
 * Auto route: multi-instance → per crop; no masks → full-frame boxes; one mask → usually
 * `flat_lay_boxes` so we still find *multiple* garments (Vision often merges a whole outfit
 * into one foreground blob). Only mirror-style shots use `fit_check_boxes`.
 */
async function decideUploadSegmentStrategy(
  segments: string[],
  originalUri: string,
): Promise<AutoSegmentStrategy> {
  if (segments.length >= 2) return "per_segment";
  if (segments.length === 0) return "flat_lay_boxes";
  const one = segments[0];
  if (!one) return "flat_lay_boxes";
  if (await shouldTreatSingleSegmentAsFitCheck(originalUri, one)) {
    return "fit_check_boxes";
  }
  return "flat_lay_boxes";
}

/** Full-frame classify + `box_2d` crops (flat-lay scene vs worn-outfit scene). */
async function classifyAndCropBoxesFromPhoto(
  uri: string,
  base64Fallback: string,
  maskedSegmentUri: string | null,
  photoLayout: "flat_lay" | "fit_check",
): Promise<any[]> {
  const classifyB64 = (await resizeForVision(uri)) || base64Fallback;
  const result = await apiClient.classify(
    classifyB64,
    "auto",
    "multi",
    photoLayout,
  );
  const items = (
    Array.isArray(result.metadata) ? result.metadata : [result.metadata]
  ).filter(Boolean);
  const mergedShoeBoxes = mergeShoePairBoxesBeforeCrop(items);
  return mergePairShoeMetasInBatch(
    await cropItemsForFitCheck(uri, maskedSegmentUri, mergedShoeBoxes, photoLayout),
  );
}

/** When full-frame box detection finds nothing but Vision gave one mask — classify that cutout. */
async function fallbackClassifySingleCutout(
  segDataUri: string,
  originalUri: string,
): Promise<any | null> {
  try {
    const segB64 = await resizeForVision(segDataUri);
    const result = await apiClient.classify(
      segB64,
      "auto",
      "single",
      undefined,
      true,
    );
    const meta = Array.isArray(result.metadata)
      ? result.metadata[0]
      : result.metadata;
    if (meta && typeof meta === "object") {
      return {
        ...meta,
        sourceUri: segDataUri,
        isIsolated: true,
        originalSourceUri: originalUri,
      };
    }
  } catch (e) {
    console.warn("[upload] single-cutout fallback failed", e);
  }
  return null;
}

const MAX_LIBRARY_PHOTOS = 20;

const UPLOAD_SNAP_CATEGORIES = [
  { id: "top", label: "Tops" },
  { id: "bottom", label: "Bottoms" },
  { id: "full body", label: "Dresses" },
  { id: "outerwear", label: "Outerwear" },
  { id: "shoes", label: "Shoes" },
  { id: "bag", label: "Bags" },
  { id: "accessory", label: "Accessories" },
] as const;

function swatchForItemColor(name: string | undefined): string {
  if (!name) return "#C7C7CC";
  const t = name.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t)) return t;
  const n = t.toLowerCase();
  const metalPairs: [string, string][] = [
    ["rose gold", "#B76E79"],
    ["white gold", "#E8E0D5"],
    ["yellow gold", "#D4AF37"],
    ["gunmetal", "#5C5C5C"],
    ["platinum", "#E5E4E2"],
    ["sterling", "#C0C0C0"],
    ["brass", "#B5A642"],
    ["copper", "#B87333"],
    ["bronze", "#CD7F32"],
    ["silver", "#C0C0C0"],
    ["gold", "#D4AF37"],
    // earth tones & common fashion colors not in the named list
    ["light tan", "#D2B48C"],
    ["dark tan", "#A0785A"],
    ["tan", "#D2B48C"],
    ["camel", "#C19A6B"],
    ["khaki", "#C3B091"],
    ["taupe", "#8B7D6B"],
    ["nude", "#E3BC9A"],
    ["burgundy", "#800020"],
    ["maroon", "#800000"],
    ["rust", "#B7410E"],
    ["mustard", "#FFDB58"],
    ["sage", "#8FAF7A"],
    ["mint", "#98D8C8"],
    ["teal", "#008080"],
    ["turquoise", "#40E0D0"],
    ["coral", "#FF7F50"],
    ["lavender", "#E6E6FA"],
    ["ivory", "#FFFFF0"],
    ["charcoal", "#36454F"],
    ["denim", "#1560BD"],
  ];
  for (const [needle, hex] of metalPairs) {
    if (n.includes(needle)) return hex;
  }
  const hit = APP_ITEM_NAMED_COLORS.find(
    (c) => c.label.toLowerCase() === n || c.id.toLowerCase() === n,
  );
  return hit?.swatch ?? "#C7C7CC";
}

const IconTrashSmall = ({ color = "#FF453A" }: { color?: string }) => (
  <Svg width="18" height="18" viewBox="0 0 24 24">
    <Path
      d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
);

// ICONS
const ArcClose = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24">
    <Path
      d="M18 6L6 18M6 6L18 18"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
    />
  </Svg>
);

const ArcGallery = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24">
    <Rect
      x="3"
      y="3"
      width="18"
      height="18"
      rx="3"
      stroke={color}
      strokeWidth="2"
      fill="none"
    />
    <Circle cx="8.5" cy="8.5" r="1.5" fill={color} />
    <Path
      d="M21 15L16 10L5 21"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
    />
  </Svg>
);

const ArcCheck = ({ color }: { color: string }) => (
  <Svg width="24" height="24" viewBox="0 0 24 24">
    <Path
      d="M20 6L9 17L4 12"
      stroke={color}
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
);

const ArcFlashIcon = ({
  mode,
  color,
}: {
  mode: "off" | "on" | "torch";
  color: string;
}) => (
  <Svg width="20" height="20" viewBox="0 0 24 24">
    <Path
      d="M13 2L4 13h7l-1 9 9-11h-7l1-9z"
      stroke={color}
      strokeWidth="1.8"
      fill={mode !== "off" ? color : "none"}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    {mode === "off" && (
      <Path
        d="M4 4L20 20"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
    )}
  </Svg>
);

const ArcFlipIcon = ({ color }: { color: string }) => (
  <Svg width="22" height="22" viewBox="0 0 24 24">
    {/* camera body */}
    <Rect
      x="3"
      y="6"
      width="18"
      height="12"
      rx="1.5"
      stroke={color}
      strokeWidth="2"
      fill="none"
    />
    {/* lens */}
    <Circle
      cx="12"
      cy="12"
      r="2.5"
      stroke={color}
      strokeWidth="1.5"
      fill="none"
    />
    {/* flip arrows - curved paths forming a rotation symbol */}
    <Path
      d="M16 4c2 0 3 1 3 3M8 20c-2 0-3-1-3-3"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      fill="none"
    />
    <Path
      d="M19 6l1.5-2.5L19 1M5 18l-1.5 2.5L5 23"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
);

function warmthToSeasons(w: string | undefined): string[] {
  switch (w?.toLowerCase()) {
    case "warm":
      return ["spring", "summer"];
    case "cold":
      return ["fall", "winter"];
    case "both":
      return ["all"];
    default:
      return ["all"];
  }
}

function seasonsToWarmth(seasons: string[]): string {
  if (seasons.includes("all")) return "both";
  const hasWarm = seasons.includes("spring") || seasons.includes("summer");
  const hasCold = seasons.includes("fall") || seasons.includes("winter");
  if (hasWarm && hasCold) return "both";
  if (hasWarm) return "warm";
  if (hasCold) return "cold";
  return "both";
}

function isLibraryMenuIntent(raw: string | string[] | undefined): boolean {
  if (typeof raw === "string" && raw.length > 0) return true;
  if (Array.isArray(raw) && raw.length > 0 && raw[0].length > 0) return true;
  return false;
}

function formatUnknownError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function uriToBase64(uri: string): Promise<string> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
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

/** Plain base64 (no data: prefix) for native crop — supports file:// and data:image URIs. */
async function imageUriToPlainBase64(uri: string): Promise<string> {
  if (uri.startsWith("data:image")) {
    return uri.replace(/^data:image\/\w+;base64,/, "");
  }
  try {
    return await uriToBase64(uri);
  } catch {
    return "";
  }
}

export default function AddScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    library?: string | string[];
    categoryHint?: string | string[];
  }>();
  const { user } = useUser();
  const [uploadSource, setUploadSource] = useState<"camera" | "library">(() =>
    consumeLibraryIntent() || isLibraryMenuIntent(params.library)
      ? "library"
      : "camera",
  );
  const [permission, requestPermission] = useCameraPermissions();
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "scanning" | "analyzing" | "review" | "done"
  >("scanning");
  const [uploading, setUploading] = useState(false);
  const [libraryAutoPickPending, setLibraryAutoPickPending] = useState(() =>
    isLibraryMenuIntent(params.library),
  );
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [configCarouselPage, setConfigCarouselPage] = useState(0);
  const [editForm, setEditForm] = useState({
    name: "",
    category: "",
    color: "",
    occasions: [] as string[],
    seasons: [] as string[],
  });

  /** Fits / closet “Add Outerwear” etc. — same shelf ids as Closet tab (top, outerwear, …). */
  const categoryHintShelfId = useMemo(() => {
    const raw = params.categoryHint;
    const hint =
      typeof raw === "string"
        ? raw.trim()
        : Array.isArray(raw) && raw[0]
          ? String(raw[0]).trim()
          : "";
    if (!hint || hint === "All") return "";
    return shelfIdForCategoryChip(hint) ?? "";
  }, [params.categoryHint]);
  const [uploadColorPickerOpen, setUploadColorPickerOpen] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  /** Page index for Configure fullscreen pager (isolated vs original). */
  const [previewFullscreenPage, setPreviewFullscreenPage] = useState(0);
  const previewFullscreenScrollRef =
    useRef<React.ComponentRef<typeof GHScrollView>>(null);
  const [addMoreSheetOpen, setAddMoreSheetOpen] = useState(false);

  /** Progress when analyzing multiple library photos before one combined review */
  const [batchAnalyze, setBatchAnalyze] = useState<{
    current: number;
    total: number;
  } | null>(null);

  /** Shown on library idle screen after permission / analysis issues (never the fake “could not open library” copy). */
  const [libraryBanner, setLibraryBanner] = useState<string | null>(null);
  const [librarySettingsCta, setLibrarySettingsCta] = useState(false);

  // Array of parsed items
  const [aiMetaList, setAiMetaList] = useState<any[]>([]);

  const cameraRef = useRef<CameraView>(null);
  const cameraZoomRef = useRef(0);
  const pinchBaseZoomRef = useRef(0);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"off" | "on" | "torch">("off");
  /** 0–1 maps to device max optical zoom (expo-camera `CameraView` `zoom` prop). */
  const [cameraZoom, setCameraZoom] = useState(0);

  const applyCameraZoom = useCallback((z: number) => {
    const clamped = Math.min(1, Math.max(0, z));
    cameraZoomRef.current = clamped;
    setCameraZoom(clamped);
  }, []);

  const cameraPinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinchBaseZoomRef.current = cameraZoomRef.current;
        })
        .onUpdate((e) => {
          const next = pinchBaseZoomRef.current + (e.scale - 1) * 0.5;
          runOnJS(applyCameraZoom)(next);
        }),
    [applyCameraZoom],
  );
  const [capturedPhotos, setCapturedPhotos] = useState<
    Array<{ uri: string; base64: string }>
  >([]);
  const pickImagesRef = useRef<() => Promise<void>>(async () => {});
  /** When true, handleDoneCapturing appends new items instead of replacing the review list. */
  const appendToReviewRef = useRef(false);

  const tabBarOverlay = Math.max(insets.bottom, 10);
  const reviewStickyBarHeight = 88;
  const reviewScrollBottomPad = tabBarOverlay + reviewStickyBarHeight + 16;
  /** Sheet starts below a “peek” of the source photo (grab handle = slider over content). */
  const reviewSheetTop = Math.max(
    insets.top + 40,
    Math.round(windowHeight * 0.11),
  );
  const doneScrollBottomPad = tabBarOverlay + 28;
  const donePhotoCount = [
    ...new Set(aiMetaList.map((i) => i.sourceUri ?? image).filter(Boolean)),
  ].length;

  /** Jump fullscreen pager to the image that was tapped (isolated vs original). */
  useEffect(() => {
    if (previewUri == null || editIndex == null) return;
    const editItem = aiMetaList[editIndex];
    const orig = editItem?.originalSourceUri;
    if (!orig || !editItem?.sourceUri) return;
    const page = previewUri === orig ? 1 : 0;
    setPreviewFullscreenPage(page);
    const id = requestAnimationFrame(() => {
      previewFullscreenScrollRef.current?.scrollTo({
        x: page * width,
        y: 0,
        animated: false,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [previewUri, editIndex, aiMetaList]);

  const processImage = async (base64: string, uri: string) => {
    setImage(uri);
    setStatus("analyzing");
    try {
      const segments = await segmentItems(base64);
      const strategy = await decideUploadSegmentStrategy(segments, uri);

      if (strategy === "per_segment") {
        // One or more white-bg Vision crops — classify each in isolation
        setImage(uri);
        setStatus("review");
        setAiMetaList(
          segments.map((seg) => ({
            sourceUri: seg,
            originalSourceUri: uri,
            isIsolated: true,
            _classifying: true,
            name: "",
          })),
        );

        await Promise.all(
          segments.map(async (seg, si) => {
            try {
              const segB64 = await resizeForVision(seg);
              const result = await apiClient.classify(
                segB64,
                "auto",
                "single",
                undefined,
                true,
              );
              const meta = Array.isArray(result.metadata)
                ? result.metadata[0]
                : result.metadata;
              if (meta && typeof meta === "object") {
                setAiMetaList((prev) => {
                  const idx = prev.findIndex(
                    (p) => p.sourceUri === seg && p._classifying,
                  );
                  if (idx === -1) return prev;
                  const next = [...prev];
                  next[idx] = {
                    ...meta,
                    sourceUri: seg,
                    isIsolated: true,
                    originalSourceUri: uri,
                  };
                  return next;
                });
              }
            } catch (e) {
              setAiMetaList((prev) =>
                prev.filter((p) => !(p.sourceUri === seg && p._classifying)),
              );
              console.warn("[upload] classify failed for segment", si, e);
            }
          }),
        );
        setAiMetaList((prev) =>
          mergeShoeIsolatesForSegmentBatch(prev, segments),
        );
      } else if (strategy === "flat_lay_boxes") {
        // Full-frame multi-box; if nothing found but we have one Vision mask, classify it.
        setStatus("review");
        setAiMetaList([
          { sourceUri: uri, isIsolated: true, _classifying: true, name: "" },
        ]);
        let resolved = await classifyAndCropBoxesFromPhoto(
          uri,
          base64,
          null,
          "flat_lay",
        );
        if (resolved.length === 0 && segments.length === 1 && segments[0]) {
          const fb = await fallbackClassifySingleCutout(segments[0], uri);
          resolved = fb ? [fb] : [];
        }
        setAiMetaList(resolved.length > 0 ? resolved : []);
        if (resolved.length > 0) setImage(resolved[0].sourceUri);
      } else {
        // Worn outfit / large subject: fit_check on original + per-box crops
        const srcUri = segments.length === 1 ? segments[0] : uri;
        if (segments.length === 1) setImage(segments[0]);
        setStatus("review");
        setAiMetaList([
          { sourceUri: srcUri, isIsolated: true, _classifying: true, name: "" },
        ]);

        const resolved = await classifyAndCropBoxesFromPhoto(
          uri,
          base64,
          segments.length === 1 ? segments[0] : null,
          "fit_check",
        );
        setAiMetaList(resolved.length > 0 ? resolved : []);
      }
    } catch (err) {
      console.error(err);
      setAiMetaList([]);
      setStatus("scanning");
      Alert.alert("AI extraction failed", formatUnknownError(err));
    }
  };

  /** All selected photos → all processed in parallel, items appear as each photo completes */
  const analyzeAllLibraryPhotos = async (jpegUris: string[]) => {
    if (jpegUris.length === 0) return;
    setUploadSource("library");
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    setAiMetaList([]);
    setStatus("analyzing");
    setBatchAnalyze({ current: 0, total: jpegUris.length });
    setImage(jpegUris[0]);

    let reviewShown = false;
    let completedCount = 0;
    let totalAdded = 0;

    try {
      await Promise.all(
        jpegUris.map(async (uri, i) => {
          try {
            const b64 = await uriToBase64(uri);

            // Step 1: segment on-device (~300-600ms)
            const segments = await segmentItems(b64);
            const strategy = await decideUploadSegmentStrategy(segments, uri);

            if (strategy === "per_segment") {
              if (!reviewShown) {
                reviewShown = true;
                setImage(uri);
                setStatus("review");
              }
              setAiMetaList((prev) => [
                ...prev,
                ...segments.map((seg) => ({
                  sourceUri: seg,
                  originalSourceUri: uri,
                  isIsolated: true,
                  _classifying: true,
                  name: "",
                })),
              ]);

              await Promise.all(
                segments.map(async (seg, si) => {
                  try {
                    const segB64 = await resizeForVision(seg);
                    const result = await apiClient.classify(
                      segB64,
                      "auto",
                      "single",
                      undefined,
                      true,
                    );
                    const meta = Array.isArray(result.metadata)
                      ? result.metadata[0]
                      : result.metadata;
                    if (meta && typeof meta === "object") {
                      setAiMetaList((prev) => {
                        const idx = prev.findIndex(
                          (p) => p.sourceUri === seg && p._classifying,
                        );
                        if (idx === -1) return prev;
                        const next = [...prev];
                        next[idx] = {
                          ...meta,
                          sourceUri: seg,
                          isIsolated: true,
                          originalSourceUri: uri,
                        };
                        return next;
                      });
                      totalAdded++;
                    }
                  } catch (e) {
                    setAiMetaList((prev) =>
                      prev.filter(
                        (p) => !(p.sourceUri === seg && p._classifying),
                      ),
                    );
                    console.warn("[upload] classify failed for segment", si, e);
                  }
                }),
              );
              setAiMetaList((prev) =>
                mergeShoeIsolatesForSegmentBatch(prev, segments),
              );
            } else if (strategy === "flat_lay_boxes") {
              let cropped = await classifyAndCropBoxesFromPhoto(
                uri,
                b64,
                null,
                "flat_lay",
              );
              if (
                cropped.length === 0 &&
                segments.length === 1 &&
                segments[0]
              ) {
                const fb = await fallbackClassifySingleCutout(segments[0], uri);
                cropped = fb ? [fb] : [];
              }
              if (cropped.length > 0) {
                if (!reviewShown) {
                  reviewShown = true;
                  setImage(cropped[0].sourceUri);
                  setStatus("review");
                }
                setAiMetaList((prev) => [...prev, ...cropped]);
                totalAdded += cropped.length;
              }
            } else {
              const srcUri = segments.length === 1 ? segments[0] : uri;
              const cropped = await classifyAndCropBoxesFromPhoto(
                uri,
                b64,
                segments.length === 1 ? segments[0] : null,
                "fit_check",
              );
              if (cropped.length > 0) {
                if (!reviewShown) {
                  reviewShown = true;
                  setImage(srcUri);
                  setStatus("review");
                }
                setAiMetaList((prev) => [...prev, ...cropped]);
                totalAdded += cropped.length;
              }
            }
          } catch (e) {
            console.warn("[upload] failed for photo", i + 1, e);
          } finally {
            completedCount++;
            setBatchAnalyze((prev) =>
              prev ? { current: completedCount, total: jpegUris.length } : null,
            );
          }
        }),
      );

      if (totalAdded === 0) {
        setAiMetaList([]);
        setStatus("scanning");
        Alert.alert(
          "No items detected",
          "Try better lighting or a clearer angle.",
        );
      }
    } catch (err) {
      const msg = formatUnknownError(err);
      setLibraryBanner(msg);
      setStatus("scanning");
      Alert.alert("Analysis failed", msg);
    } finally {
      setBatchAnalyze(null);
    }
  };

  const handleCapture = async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.5,
      });
      if (!photo) throw new Error("Capture failed");
      const entry = { uri: photo.uri, base64: photo.base64 || "" };
      setCapturedPhotos((prev) => [...prev, entry]);
      // Strip always shows the real capture; segmentation runs only after Done (see handleDoneCapturing).
    } catch (err) {
      console.error(err);
      Alert.alert("Capture Failed", "Try again in better lighting.");
    }
  };

  const handleDoneCapturing = async () => {
    if (capturedPhotos.length === 0) {
      appendToReviewRef.current = false;
      return;
    }
    if (!appendToReviewRef.current) {
      setAiMetaList([]);
    }
    setStatus("analyzing");
    setBatchAnalyze({ current: 0, total: capturedPhotos.length });
    let addedCount = 0;

    try {
      for (let i = 0; i < capturedPhotos.length; i++) {
        setBatchAnalyze({ current: i + 1, total: capturedPhotos.length });
        const photo = capturedPhotos[i];
        try {
          // Always re-segment from full capture so multi-item flat lays are not reduced to the first instance.
          const segments = await segmentItems(photo.base64);
          const strategy = await decideUploadSegmentStrategy(
            segments,
            photo.uri,
          );

          if (strategy === "per_segment") {
            if (addedCount === 0) {
              // Full capture for review context; each row still uses the isolated `sourceUri`.
              setImage(photo.uri);
              setStatus("review");
            }
            setAiMetaList((prev) => [
              ...prev,
              ...segments.map((seg) => ({
                sourceUri: seg,
                originalSourceUri: photo.uri,
                isIsolated: true,
                _classifying: true,
                name: "",
              })),
            ]);

            await Promise.all(
              segments.map(async (seg) => {
                try {
                  const segB64 = await resizeForVision(seg);
                  const result = await apiClient.classify(
                    segB64,
                    "auto",
                    "single",
                    undefined,
                    true,
                  );
                  const meta = Array.isArray(result.metadata)
                    ? result.metadata[0]
                    : result.metadata;
                  if (meta && typeof meta === "object") {
                    setAiMetaList((prev) => {
                      const idx = prev.findIndex(
                        (p) => p.sourceUri === seg && p._classifying,
                      );
                      if (idx === -1) return prev;
                      const next = [...prev];
                      next[idx] = {
                        ...meta,
                        sourceUri: seg,
                        isIsolated: true,
                        originalSourceUri: photo.uri,
                      };
                      return next;
                    });
                    addedCount++;
                  }
                } catch {
                  setAiMetaList((prev) =>
                    prev.filter(
                      (p) => !(p.sourceUri === seg && p._classifying),
                    ),
                  );
                }
              }),
            );
            setAiMetaList((prev) =>
              mergeShoeIsolatesForSegmentBatch(prev, segments),
            );
          } else if (strategy === "flat_lay_boxes") {
            let cropped = await classifyAndCropBoxesFromPhoto(
              photo.uri,
              photo.base64,
              null,
              "flat_lay",
            );
            if (cropped.length === 0 && segments.length === 1 && segments[0]) {
              const fb = await fallbackClassifySingleCutout(
                segments[0],
                photo.uri,
              );
              cropped = fb ? [fb] : [];
            }
            if (cropped.length > 0 && i === 0) {
              setImage(cropped[0].sourceUri);
              setStatus("review");
            }
            for (const item of cropped) {
              setAiMetaList((prev) => [...prev, item]);
              addedCount++;
            }
          } else {
            const srcUri = segments.length === 1 ? segments[0] : photo.uri;
            const cropped = await classifyAndCropBoxesFromPhoto(
              photo.uri,
              photo.base64,
              segments.length === 1 ? segments[0] : null,
              "fit_check",
            );
            for (const item of cropped) {
              setAiMetaList((prev) => [...prev, item]);
              addedCount++;
            }
            if (cropped.length > 0 && i === 0) {
              setImage(srcUri);
              setStatus("review");
            }
          }
        } catch (e) {
          console.warn("[upload] classify failed for captured photo", i + 1, e);
        }
      }
      if (addedCount === 0) {
        if (appendToReviewRef.current) {
          setStatus("review");
          Alert.alert(
            "No new items",
            "We couldn't find items in those photos. Your existing list is unchanged.",
          );
        } else {
          setStatus("scanning");
          Alert.alert(
            "No items detected",
            "Try better lighting or a clearer angle.",
          );
        }
      }
    } catch (err) {
      if (appendToReviewRef.current) {
        setStatus("review");
        Alert.alert("Analysis failed", formatUnknownError(err));
      } else {
        setStatus("scanning");
        Alert.alert("Analysis failed", formatUnknownError(err));
      }
    } finally {
      appendToReviewRef.current = false;
      setBatchAnalyze(null);
      setCapturedPhotos([]);
    }
  };

  const persistItemsToCloset = async (
    imageUri: string,
    metas: any[],
    userId: string,
  ) => {
    if (!userId) throw new Error("Not signed in");
    if (metas.length === 0) throw new Error("No items to save");

    const response = await fetch(imageUri);
    const blob = await response.blob();

    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });

    const { ext, contentType } = guessMimeFromImageUri(imageUri);
    const fileName = `piece_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const { error: storageError } = await supabase.storage
      .from("clothing-images")
      .upload(fileName, arrayBuffer, {
        contentType,
        upsert: true,
      });

    if (storageError) throw storageError;

    const {
      data: { publicUrl },
    } = supabase.storage.from("clothing-images").getPublicUrl(fileName);

    const inserts = metas.map((meta) => ({
      user_id: userId,
      name: meta?.name || "New Piece",
      image_url: publicUrl,
      type: meta?.sub_category || meta?.category || "Piece",
      category: meta?.category || "other",
      sub_category: meta?.sub_category || null,
      color: meta?.color || "Unknown",
      material: null,
      fit: null,
      weight: null,
      pattern: "solid",
      style: "casual",
      seasons: meta?.seasons || warmthToSeasons(meta?.warmth),
      occasions: meta?.occasions || ["casual"],
      formality: null,
      box_2d: meta?.box_2d || null,
      notes: null,
      is_digitized: true,
      image_url_original: meta?.image_url_original ?? null,
    }));

    const { error } = await supabase.from("clothing_items").insert(inserts);
    if (error) throw error;
  };

  const pickImages = async () => {
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!libPerm.granted) {
      const msg =
        "Allow photo library access to pick images. You can enable it in Settings if you previously denied access.";
      setLibraryBanner(msg);
      setLibrarySettingsCta(true);
      Alert.alert("Photo library access needed", msg, [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => Linking.openSettings() },
      ]);
      return;
    }

    const fromLibraryMenu = uploadSource === "library";
    if (fromLibraryMenu) setLibraryPickerOpen(true);
    let res: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
    try {
      res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: MAX_LIBRARY_PHOTOS,
        orderedSelection: true,
        quality: 0.85,
        base64: false,
        ...(Platform.OS === "ios"
          ? {
              preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode
                  .Automatic,
            }
          : {}),
      });
    } finally {
      if (fromLibraryMenu) setLibraryPickerOpen(false);
    }

    if (res.canceled || res.assets.length === 0) {
      if (fromLibraryMenu) router.back();
      return;
    }

    // Immediately trigger UI loading state so the user doesn't see a hung white screen
    // while the HEIC -> JPEG transcoder bridges to native and blocks.
    setUploadSource("library");
    setStatus("analyzing");
    setBatchAnalyze({ current: 0, total: res.assets.length });
    setImage(res.assets[0].uri);

    // Defer the heavy transcoding to fully yield the thread so the UI can flush the loading view
    setTimeout(async () => {
      const jpegUris: string[] = [];
      for (const a of res.assets) {
        try {
          jpegUris.push(await ensureJpegUri(a.uri));
        } catch (e) {
          console.warn("[upload] JPEG transcode failed, using picker URI", e);
          jpegUris.push(a.uri);
        }
      }

      await analyzeAllLibraryPhotos(jpegUris);
    }, 400);
  };

  /** Pick photos from library and APPEND results to existing review list */
  const addMoreFromLibrary = async () => {
    setAddMoreSheetOpen(false);
    appendToReviewRef.current = false;
    if (status === "done") {
      setStatus("review");
      if (!image) {
        const u = aiMetaList.find((x) => x.sourceUri)?.sourceUri;
        if (u) setImage(u);
      }
    }
    const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!libPerm.granted) {
      Alert.alert("Photo library access needed", "Enable it in Settings.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    let res: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
    try {
      res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        selectionLimit: MAX_LIBRARY_PHOTOS,
        orderedSelection: true,
        quality: 0.85,
        base64: false,
        ...(Platform.OS === "ios"
          ? {
              preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode
                  .Automatic,
            }
          : {}),
      });
    } catch {
      return;
    }
    if (res.canceled || res.assets.length === 0) return;

    // Immediately trigger UI loading state
    setUploadSource("library");
    setStatus("analyzing");
    setBatchAnalyze({ current: 0, total: res.assets.length });
    setImage(res.assets[0].uri);

    setTimeout(async () => {
      const jpegUris: string[] = [];
      for (const a of res.assets) {
        try {
          jpegUris.push(await ensureJpegUri(a.uri));
        } catch {
          jpegUris.push(a.uri);
        }
      }

      // Analyze and append — don't clear existing items
      setBatchAnalyze({ current: 0, total: jpegUris.length });
      for (let i = 0; i < jpegUris.length; i++) {
        setBatchAnalyze({ current: i + 1, total: jpegUris.length });
        const uri = jpegUris[i];
        try {
          const b64 = await uriToBase64(uri);
          const segments = await segmentItems(b64);
          const strategy = await decideUploadSegmentStrategy(segments, uri);
          if (strategy === "per_segment") {
            setAiMetaList((prev) => [
              ...prev,
              ...segments.map((seg) => ({
                sourceUri: seg,
                isIsolated: true,
                _classifying: true,
                name: "",
              })),
            ]);
            await Promise.all(
              segments.map(async (seg, si) => {
                try {
                  const segB64 = await resizeForVision(seg);
                  const result = await apiClient.classify(
                    segB64,
                    "auto",
                    "single",
                    undefined,
                    true,
                  );
                  const meta = Array.isArray(result.metadata)
                    ? result.metadata[0]
                    : result.metadata;
                  if (meta && typeof meta === "object") {
                    setAiMetaList((prev) => {
                      const idx = prev.findIndex(
                        (p) => p.sourceUri === seg && p._classifying,
                      );
                      if (idx === -1) return prev;
                      const next = [...prev];
                      next[idx] = { ...meta, sourceUri: seg, isIsolated: true };
                      return next;
                    });
                  }
                } catch (e) {
                  setAiMetaList((prev) =>
                    prev.filter((p) => !(p.sourceUri === seg && p._classifying)),
                  );
                  console.warn("[upload] classify failed for segment", si, e);
                }
              }),
            );
            setAiMetaList((prev) =>
              mergeShoeIsolatesForSegmentBatch(prev, segments),
            );
          } else if (strategy === "flat_lay_boxes") {
            let cropped = await classifyAndCropBoxesFromPhoto(
              uri,
              b64,
              null,
              "flat_lay",
            );
            if (cropped.length === 0 && segments.length === 1 && segments[0]) {
              const fb = await fallbackClassifySingleCutout(segments[0], uri);
              cropped = fb ? [fb] : [];
            }
            for (const item of cropped) {
              setAiMetaList((prev) => [...prev, item]);
            }
          } else {
            const cropped = await classifyAndCropBoxesFromPhoto(
              uri,
              b64,
              segments.length === 1 ? segments[0] : null,
              "fit_check",
            );
            for (const item of cropped) {
              setAiMetaList((prev) => [...prev, item]);
            }
          }
        } catch (e) {
          console.warn("[upload] addMore failed for photo", i + 1, e);
        }
      }
      setBatchAnalyze(null);
    }, 400);
  };

  /** Open camera to capture more and append */
  const addMoreFromCamera = () => {
    setAddMoreSheetOpen(false);
    appendToReviewRef.current = true;
    setUploadSource("camera");
    setStatus("scanning");
    setCapturedPhotos([]);
  };

  pickImagesRef.current = pickImages;

  useEffect(() => {
    if (!isLibraryMenuIntent(params.library)) return;
    setStatus("scanning");
    setImage(null);
    setAiMetaList([]);
    setCapturedPhotos([]);
    setLibraryAutoPickPending(true);
    const timer = setTimeout(() => {
      pickImagesRef.current().finally(() => setLibraryAutoPickPending(false));
    }, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.library]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener("openLibraryPicker", () => {
      setUploadSource("library");
      setStatus("scanning");
      setImage(null);
      setAiMetaList([]);
      setCapturedPhotos([]);
      setLibraryAutoPickPending(true);
      setTimeout(() => {
        pickImagesRef
          .current()
          .catch((e: unknown) => {
            console.error("[upload] library picker error", e);
            Alert.alert("Error", String(e));
          })
          .finally(() => setLibraryAutoPickPending(false));
      }, 400);
    });
    return () => sub.remove();
  }, []);

  const handleAddToCloset = async () => {
    if (aiMetaList.length === 0) return;
    const userId = user?.id;
    if (!userId) {
      Alert.alert("Sign in", "Sign in to save to your closet.");
      return;
    }
    setUploading(true);
    try {
      // Pre-upload original images for enhanced items so we have a stable URL
      const origUrlMap = new Map<string, string>();
      for (const raw of aiMetaList) {
        const origUri = raw.originalSourceUri;
        if (!origUri || origUrlMap.has(origUri)) continue;
        try {
          const resp = await fetch(origUri);
          const blob = await resp.blob();
          const buf = await new Promise<ArrayBuffer>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result as ArrayBuffer);
            r.onerror = rej;
            r.readAsArrayBuffer(blob);
          });
          const fn = `orig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
          const { error: e } = await supabase.storage
            .from("clothing-images")
            .upload(fn, buf, { contentType: "image/jpeg", upsert: true });
          if (!e) {
            const {
              data: { publicUrl },
            } = supabase.storage.from("clothing-images").getPublicUrl(fn);
            origUrlMap.set(origUri, publicUrl);
          }
        } catch {
          /* skip */
        }
      }

      const byUri = new Map<string, any[]>();
      for (const raw of aiMetaList) {
        const uri = raw.sourceUri ?? image;
        if (!uri) continue;
        const { sourceUri: _s, originalSourceUri: _o, ...meta } = raw;
        const origUri = raw.originalSourceUri;
        const image_url_original = origUri
          ? (origUrlMap.get(origUri) ?? null)
          : null;
        if (!byUri.has(uri)) byUri.set(uri, []);
        byUri.get(uri)!.push({ ...meta, image_url_original });
      }
      const entries = [...byUri.entries()].filter(
        ([, metas]) => metas.length > 0,
      );
      if (entries.length === 0) {
        Alert.alert("Save error", "Missing image data for these items.");
        return;
      }
      // Process in chunks of 5 to avoid overwhelming storage + DB
      const CHUNK = 5;
      for (let i = 0; i < entries.length; i += CHUNK) {
        await Promise.all(
          entries
            .slice(i, i + CHUNK)
            .map(([uri, metas]) => persistItemsToCloset(uri, metas, userId)),
        );
      }
      setStatus("done");
    } catch (err) {
      console.error("Upload Error:", err);
      Alert.alert("Archive Failed", "Could not sync items to database.");
    } finally {
      setUploading(false);
    }
  };

  const removeItem = (index: number) => {
    setAiMetaList((prev) => prev.filter((_, i) => i !== index));
  };

  const enhanceItemAtIndex = async (idx: number) => {
    const item = aiMetaList[idx];
    if (!item || item._classifying || item._enhancing) return;
    // Always enhance from the pristine original, not from a previously enhanced output.
    const src = item.originalSourceUri ?? item.sourceUri;
    if (!src) return;

    setAiMetaList((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, _enhancing: true } : it)),
    );
    try {
      const b64 = await imageUriToPlainBase64(src);
      if (!b64?.trim()) throw new Error("Could not read image");

      console.log("[enhance] calling Gemini enhance…");
      const outUri = await apiClient.enhanceClothingItemCutout({
        imageBase64: b64,
        name: item.name,
        color: item.color,
        category: item.category,
        backdropHex: "#FFFFFF",
      });
      if (!outUri)
        throw new Error(
          "Enhance returned no image — check EXPO_PUBLIC_GOOGLE_AI_API_KEY in .env",
        );
      console.log("[enhance] success");
      setAiMetaList((prev) =>
        prev.map((it, i) =>
          i === idx
            ? {
                ...it,
                sourceUri: outUri,
                originalSourceUri: it.originalSourceUri ?? it.sourceUri,
                isIsolated: true,
                _enhancing: false,
                _displayEpoch: (it._displayEpoch ?? 0) + 1,
              }
            : it,
        ),
      );
      try {
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
      } catch {
        /* no-op */
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.warn("[enhanceItemAtIndex] FAILED:", detail);
      Alert.alert("Couldn't enhance", detail);
      setAiMetaList((prev) =>
        prev.map((it, i) => (i === idx ? { ...it, _enhancing: false } : it)),
      );
    }
  };

  const openUploadEdit = (idx: number) => {
    const item = aiMetaList[idx];
    const categoryDefault =
      (item?.category && String(item.category).trim()) ||
      categoryHintShelfId ||
      "";
    setEditForm({
      name: item?.name || "",
      category: categoryDefault,
      color: item?.color || "",
      occasions: [...(item?.occasions || [])],
      seasons: [...(item?.seasons || warmthToSeasons(item?.warmth))],
    });
    setEditIndex(idx);
    setConfigCarouselPage(0);
  };

  const saveUploadEdit = () => {
    if (editIndex !== null) {
      setAiMetaList((prev) =>
        prev.map((it, i) =>
          i === editIndex
            ? {
                ...it,
                name: editForm.name,
                category: editForm.category,
                color: editForm.color,
                occasions: editForm.occasions,
                seasons: editForm.seasons,
                warmth: seasonsToWarmth(editForm.seasons),
              }
            : it,
        ),
      );
    }
    setEditIndex(null);
    setPreviewUri(null);
  };

  const reset = () => {
    setImage(null);
    setAiMetaList([]);
    setBatchAnalyze(null);
    setPreviewUri(null);
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    setCapturedPhotos([]);
    setStatus("scanning");
  };

  const leaveAddItemsFlow = () => {
    if (router.canDismiss()) router.dismiss();
    else router.back();
  };

  const pickDifferentLibraryPhoto = async () => {
    setImage(null);
    setAiMetaList([]);
    setBatchAnalyze(null);
    setPreviewUri(null);
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    setStatus("scanning");
    await pickImages();
  };

  if (!permission) return <View style={styles.container} />;
  if (
    uploadSource === "camera" &&
    !permission.granted &&
    !libraryAutoPickPending
  ) {
    return (
      <View style={styles.permissionScreen}>
        <ArcGallery color={Colors.black} />
        <Text style={styles.permTitle}>Archive Camera</Text>
        <Text style={styles.permSub}>
          Authorize access to digitize your wardrobe.
        </Text>
        <TouchableOpacity style={Styles.btnPrimary} onPress={requestPermission}>
          <Text style={Styles.btnPrimaryText}>ALLOW CAMERA</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const renderReviewItemsBody = (headerPadTop: number) => {
    if (status !== "review" || !image) return null;
    return (
      <>
        <View style={[styles.snapReviewHeader, { paddingTop: headerPadTop }]}>
          <View style={styles.reviewHeaderRow}>
            <Text style={styles.snapReviewTitle}>Review items</Text>
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.reviewCloseBtn}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <ArcClose color="rgba(0,0,0,0.4)" />
            </TouchableOpacity>
          </View>
          <Text style={styles.snapReviewSubtitle}>
            Check the details before these hit your closet.
          </Text>
          {(() => {
            const nonIsolatedItems = aiMetaList.filter((i) => !i.isIsolated);
            if (nonIsolatedItems.length === 0) return null;
            const uris = [
              ...new Set(
                nonIsolatedItems
                  .map((i) => i.sourceUri ?? image)
                  .filter(Boolean),
              ),
            ] as string[];
            if (uris.length <= 1) return null;
            const parts = uris.map((u, i) => {
              const c = nonIsolatedItems.filter(
                (x) => (x.sourceUri ?? image) === u,
              ).length;
              return `Photo ${i + 1}: ${c} item${c === 1 ? "" : "s"}`;
            });
            return (
              <Text style={styles.snapReviewMultiHint}>
                {uris.length} photos — {parts.join(" · ")}
              </Text>
            );
          })()}
        </View>

        {aiMetaList.map((item, idx) => (
          <Animated.View
            key={`${item.sourceUri ?? image}-${idx}-${item.name ?? ""}-${item._displayEpoch ?? 0}`}
            entering={FadeIn.duration(280)}
          >
            <View style={styles.snapItemCard}>
              <TouchableOpacity
                activeOpacity={0.88}
                style={styles.snapItemMainPressable}
                onPress={() =>
                  !item._classifying && !item._enhancing && openUploadEdit(idx)
                }
              >
                {item.isIsolated ? (
                  <View style={styles.isolatedThumb}>
                    <CrossfadeThumbImage
                      uri={item.sourceUri}
                      style={styles.isolatedThumbImg}
                      resizeMode="contain"
                      selfAspect
                    />
                    {item._classifying && (
                      <View style={styles.classifyingBadge}>
                        <ActivityIndicator
                          color="rgba(0,0,0,0.35)"
                          size="small"
                        />
                      </View>
                    )}
                  </View>
                ) : (
                  <ZoomedItemThumb
                    uri={item.sourceUri ?? image!}
                    box2d={item.isIsolated ? null : item.box_2d}
                    width={130}
                    resizeMode="cover"
                    onPress={() => !item._classifying && openUploadEdit(idx)}
                  />
                )}
                <View style={styles.snapItemMeta}>
                  {!item._classifying && (
                    <TouchableOpacity
                      style={styles.snapItemTrashBtn}
                      onPress={() => removeItem(idx)}
                      hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                    >
                      <IconTrashSmall />
                    </TouchableOpacity>
                  )}
                  {item._classifying ? (
                    <View style={styles.classifyingMeta}>
                      <Text style={styles.classifyingLabel}>Classifying…</Text>
                      <View style={styles.shimmerLine} />
                      <View
                        style={[
                          styles.shimmerLine,
                          { width: "55%", marginTop: 8 },
                        ]}
                      />
                      <View
                        style={[
                          styles.shimmerLine,
                          { width: "70%", marginTop: 8 },
                        ]}
                      />
                    </View>
                  ) : (
                    <>
                      <Text style={styles.snapItemName} numberOfLines={2}>
                        {item?.name || "Unknown item"}
                      </Text>
                      <View style={styles.snapItemCatPill}>
                        <Text style={styles.snapItemCatText}>
                          {(
                            item?.sub_category ||
                            item?.type ||
                            item?.category ||
                            "Piece"
                          ).toUpperCase()}
                        </Text>
                      </View>
                      {item?.color ? (
                        <View style={styles.snapItemColorRow}>
                          <View
                            style={[
                              styles.snapColorDot,
                              {
                                backgroundColor: swatchForItemColor(
                                  String(item.color),
                                ),
                              },
                            ]}
                          />
                          <Text style={styles.snapItemColorText}>
                            {item.color}
                          </Text>
                        </View>
                      ) : null}
                      {item?.occasions?.length > 0 ? (
                        <View style={styles.snapItemOccRow}>
                          {(item.occasions as string[])
                            .slice(0, 4)
                            .map((occ) => (
                              <View key={occ} style={styles.snapItemOccChip}>
                                <Text style={styles.snapItemOccChipText}>
                                  {occ}
                                </Text>
                              </View>
                            ))}
                        </View>
                      ) : null}
                      {item?.warmth ? (
                        <Text style={styles.snapItemSeasonLine}>
                          {item.warmth === "warm"
                            ? "☀️ Warm weather"
                            : item.warmth === "cold"
                              ? "❄️ Cold weather"
                              : "🌤 All weather"}
                        </Text>
                      ) : null}
                    </>
                  )}
                </View>
              </TouchableOpacity>
              {!item._classifying ? (
                <View style={styles.snapItemActionsBar}>
                  <View style={styles.snapItemActionsRow}>
                    <TouchableOpacity
                      style={[
                        styles.snapEnhanceBtn,
                        item._enhancing && styles.snapEnhanceBtnDisabled,
                      ]}
                      onPress={() => enhanceItemAtIndex(idx)}
                      disabled={!!item._enhancing}
                      activeOpacity={0.88}
                    >
                      {item._enhancing ? (
                        <ActivityIndicator color={Colors.accent} size="small" />
                      ) : (
                        <Text style={styles.snapEnhanceBtnText}>Enhance</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.snapConfigureBtn}
                      onPress={() => openUploadEdit(idx)}
                    >
                      <Text style={styles.snapConfigureBtnText}>Configure</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
            </View>
          </Animated.View>
        ))}

        {batchAnalyze && batchAnalyze.total > 0 ? (
          <View style={styles.reviewAppendLoading}>
            <ActivityIndicator color={Colors.accent} size="small" />
            <Text style={styles.reviewAppendLoadingText}>
              {`Adding items… ${batchAnalyze.current} of ${batchAnalyze.total} done`}
            </Text>
          </View>
        ) : null}

        {aiMetaList.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              No items matched your scan.
            </Text>
            <TouchableOpacity
              style={[styles.skipBtn, { marginTop: 12 }]}
              onPress={
                uploadSource === "library" ? pickDifferentLibraryPhoto : reset
              }
            >
              <Text style={styles.skipBtnText}>
                {uploadSource === "library"
                  ? "CHOOSE OTHER PHOTOS"
                  : "TRY AGAIN"}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </>
    );
  };

  return (
    <GestureHandlerRootView style={styles.container}>
      {status === "scanning" || status === "analyzing" ? (
        uploadSource === "library" ? (
          <View style={styles.libraryPassThrough}>
            {status === "analyzing" && (
              <View style={[styles.analyzingSheet, { paddingTop: insets.top }]}>
                <View style={styles.analyzingSheetBody}>
                  <ActivityIndicator color={Colors.accent} size="large" />
                  <Text style={styles.analyzingTitle}>
                    {batchAnalyze && batchAnalyze.total > 1
                      ? `Analyzing ${batchAnalyze.total} photos…`
                      : "Extracting items…"}
                  </Text>
                  {batchAnalyze && batchAnalyze.total > 1 ? (
                    <Text style={styles.analyzingSub}>
                      Detecting every item in each photo.
                    </Text>
                  ) : null}
                </View>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.cameraWrapper}>
            <View
              style={[
                styles.cameraViewport,
                { top: insets.top + 10 },
              ]}
            >
              {permission.granted ? (
                <GestureDetector gesture={cameraPinchGesture}>
                  <View style={StyleSheet.absoluteFill}>
                    <CameraView
                      style={StyleSheet.absoluteFillObject}
                      ref={cameraRef}
                      facing={facing}
                      flash={flash}
                      zoom={cameraZoom}
                    />
                  </View>
                </GestureDetector>
              ) : (
                <View
                  style={[
                    StyleSheet.absoluteFillObject,
                    styles.cameraRollPlaceholder,
                  ]}
                />
              )}
            </View>

            <View
              style={[
                styles.hudOverlay,
                {
                  paddingTop: insets.top + 12,
                  paddingBottom: tabBarOverlay + 12,
                },
              ]}
              pointerEvents="box-none"
            >
              <View style={styles.hudHeader}>
                <TouchableOpacity
                  onPress={() => router.back()}
                  style={styles.hudGhostBtn}
                >
                  <ArcClose color="#fff" />
                </TouchableOpacity>

                <View style={styles.hudHeaderLabel}>
                  <Text style={styles.hudHeaderTitle}>Camera</Text>
                  <Text style={styles.hudHeaderSub} numberOfLines={1}>
                    Individual pieces or whole outfits
                  </Text>
                </View>

                <TouchableOpacity
                  style={[
                    styles.hudGhostBtn,
                    flash !== "off" && styles.hudGhostBtnActive,
                  ]}
                  onPress={() =>
                    setFlash((f) =>
                      f === "off" ? "on" : f === "on" ? "torch" : "off",
                    )
                  }
                >
                  <ArcFlashIcon mode={flash} color="#fff" />
                </TouchableOpacity>
              </View>

              <View style={styles.hudBottom}>
                {capturedPhotos.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.thumbsContent}
                    style={styles.thumbsRow}
                  >
                    {capturedPhotos.map((photo, idx) => (
                      <View key={photo.uri} style={styles.thumbWrap}>
                        <Image
                          source={{ uri: photo.uri }}
                          style={styles.thumbImg}
                          resizeMode="contain"
                        />
                        <TouchableOpacity
                          style={styles.thumbX}
                          onPress={() =>
                            setCapturedPhotos((prev) =>
                              prev.filter((_, i) => i !== idx),
                            )
                          }
                          hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                        >
                          <ArcClose color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )}

                <View style={styles.hudFooter}>
                  <TouchableOpacity
                    style={styles.hudGhostBtn}
                    onPress={pickImages}
                  >
                    <ArcGallery color="#fff" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.shutterBtn, { borderColor: "#fff" }]}
                    onPress={handleCapture}
                    disabled={status === "analyzing"}
                  >
                    <View style={styles.shutterInner} />
                  </TouchableOpacity>

                  {capturedPhotos.length > 0 ? (
                    <TouchableOpacity
                      style={styles.doneBtn}
                      onPress={handleDoneCapturing}
                    >
                      <Text style={styles.doneBtnText}>
                        Done
                        {capturedPhotos.length > 1
                          ? ` (${capturedPhotos.length})`
                          : ""}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.hudGhostBtn}
                      onPress={() => {
                        applyCameraZoom(0);
                        setFacing((f) => (f === "back" ? "front" : "back"));
                      }}
                    >
                      <ArcFlipIcon color="#fff" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>

            {status === "analyzing" && (
              <BlurView
                intensity={80}
                tint="light"
                style={styles.loadingOverlay}
              >
                <ActivityIndicator color={Colors.accent} size="large" />
                <Text style={styles.loadingText}>EXTRACTING ITEMS…</Text>
              </BlurView>
            )}
          </View>
        )
      ) : (
        /* Review / Done — same breakdown as Snap: photo + name + category + color + Configure */
        <View
          style={[
            styles.reviewWrapper,
            status === "review" && styles.reviewWrapperHost,
            status === "review" && image && styles.reviewBackdropHost,
          ]}
        >
          {status === "review" && (
            <>
              <Modal
                visible={editIndex !== null}
                transparent
                animationType="fade"
                onRequestClose={() => {
                  setEditIndex(null);
                  setPreviewUri(null);
                }}
              >
                <View style={styles.uploadEditBackdrop}>
                  <BlurView
                    intensity={60}
                    tint="dark"
                    style={StyleSheet.absoluteFill}
                  />
                  <TouchableOpacity
                    activeOpacity={1}
                    style={styles.uploadEditBackdropDismiss}
                    onPress={() => {
                      setEditIndex(null);
                      setPreviewUri(null);
                    }}
                  />
                  <ScrollView
                    style={styles.uploadEditCard}
                    contentContainerStyle={{ paddingBottom: 32 }}
                    showsVerticalScrollIndicator={false}
                  >
                    {editIndex !== null && aiMetaList[editIndex]?.sourceUri
                      ? (() => {
                          const editItem = aiMetaList[editIndex];
                          const hasOrig = !!editItem?.originalSourceUri;
                          const thumbW = width - 48;
                          return (
                            <View style={styles.uploadEditItemThumb}>
                              <GHScrollView
                                horizontal
                                pagingEnabled
                                nestedScrollEnabled
                                keyboardShouldPersistTaps="handled"
                                showsHorizontalScrollIndicator={false}
                                scrollEnabled={hasOrig}
                                onScroll={(e) => {
                                  const page = Math.round(
                                    e.nativeEvent.contentOffset.x / thumbW,
                                  );
                                  setConfigCarouselPage(page);
                                }}
                                scrollEventThrottle={16}
                                style={{ flex: 1 }}
                              >
                                <GHTouchableOpacity
                                  activeOpacity={0.92}
                                  style={{ width: thumbW }}
                                  onPress={() => {
                                    void Haptics.impactAsync(
                                      Haptics.ImpactFeedbackStyle.Light,
                                    );
                                    setPreviewUri(editItem.sourceUri);
                                  }}
                                >
                                  <Image
                                    source={{ uri: editItem.sourceUri }}
                                    style={[
                                      styles.uploadEditItemThumbImg,
                                      { width: thumbW },
                                    ]}
                                    resizeMode="contain"
                                  />
                                </GHTouchableOpacity>
                                {hasOrig && (
                                  <GHTouchableOpacity
                                    activeOpacity={0.92}
                                    style={{ width: thumbW }}
                                    onPress={() => {
                                      void Haptics.impactAsync(
                                        Haptics.ImpactFeedbackStyle.Light,
                                      );
                                      if (editItem.originalSourceUri) {
                                        setPreviewUri(
                                          editItem.originalSourceUri,
                                        );
                                      }
                                    }}
                                  >
                                    <Image
                                      source={{
                                        uri: editItem.originalSourceUri,
                                      }}
                                      style={[
                                        styles.uploadEditItemThumbImg,
                                        { width: thumbW },
                                      ]}
                                      resizeMode="contain"
                                    />
                                  </GHTouchableOpacity>
                                )}
                              </GHScrollView>
                              {hasOrig && (
                                <View style={styles.carouselDots}>
                                  <View
                                    style={[
                                      styles.carouselDot,
                                      configCarouselPage === 0 &&
                                        styles.carouselDotActive,
                                    ]}
                                  />
                                  <View
                                    style={[
                                      styles.carouselDot,
                                      configCarouselPage === 1 &&
                                        styles.carouselDotActive,
                                    ]}
                                  />
                                </View>
                              )}
                            </View>
                          );
                        })()
                      : null}
                    <View style={styles.uploadEditHeader}>
                      <Text style={styles.uploadEditTitle}>Configure</Text>
                      <TouchableOpacity
                        onPress={() => {
                          setEditIndex(null);
                          setPreviewUri(null);
                        }}
                        hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                        style={styles.uploadEditCloseBtn}
                      >
                        <ArcClose color="rgba(0,0,0,0.4)" />
                      </TouchableOpacity>
                    </View>

                    <Text style={styles.uploadEditLabel}>Name</Text>
                    <TextInput
                      style={styles.uploadEditInput}
                      value={editForm.name}
                      onChangeText={(t) =>
                        setEditForm((prev) => ({ ...prev, name: t }))
                      }
                      placeholder="e.g. Vintage wash tee"
                      placeholderTextColor={Colors.textMuted}
                    />

                    <Text style={styles.uploadEditLabel}>Category</Text>
                    <View style={styles.uploadEditChipRow}>
                      {UPLOAD_SNAP_CATEGORIES.map((cat) => {
                        const isOn =
                          editForm.category.toLowerCase() ===
                          cat.id.toLowerCase();
                        return (
                          <TouchableOpacity
                            key={cat.id}
                            style={[
                              styles.uploadEditChip,
                              isOn && styles.uploadEditChipOn,
                            ]}
                            onPress={() =>
                              setEditForm((prev) => ({
                                ...prev,
                                category: cat.id,
                              }))
                            }
                          >
                            <Text
                              style={[
                                styles.uploadEditChipText,
                                isOn && styles.uploadEditChipTextOn,
                              ]}
                            >
                              {cat.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <Text style={styles.uploadEditLabel}>Color</Text>
                    <TouchableOpacity
                      style={styles.uploadColorTrigger}
                      onPress={() => setUploadColorPickerOpen(true)}
                      activeOpacity={0.88}
                    >
                      <ColorPickerTriggerIcon size={40} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={styles.uploadColorTriggerTitle}
                          numberOfLines={1}
                        >
                          {editForm.color?.trim()
                            ? editForm.color
                            : "Choose color"}
                        </Text>
                        <Text style={styles.uploadColorTriggerSub}>
                          Grid, spectrum, or sliders
                        </Text>
                      </View>
                    </TouchableOpacity>

                    <Text style={styles.uploadEditLabel}>Occasions</Text>
                    <View style={styles.uploadEditChipRow}>
                      {OCCASIONS_FLAT.map((occ) => {
                        const isOn = editForm.occasions
                          .map((o) => o.toLowerCase())
                          .includes(occ.id.toLowerCase());
                        return (
                          <TouchableOpacity
                            key={occ.id}
                            style={[
                              styles.uploadEditChip,
                              isOn && styles.uploadEditChipOn,
                            ]}
                            onPress={() => {
                              const next = isOn
                                ? editForm.occasions.filter(
                                    (o) =>
                                      o.toLowerCase() !== occ.id.toLowerCase(),
                                  )
                                : [...editForm.occasions, occ.id];
                              setEditForm((prev) => ({
                                ...prev,
                                occasions: next,
                              }));
                            }}
                          >
                            <Text
                              style={[
                                styles.uploadEditChipText,
                                isOn && styles.uploadEditChipTextOn,
                              ]}
                            >
                              {occ.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <TextInput
                      style={[styles.uploadEditInput, { marginTop: -12 }]}
                      value={
                        editForm.occasions
                          .filter(
                            (o) =>
                              !OCCASIONS_FLAT.some(
                                (f) => f.id.toLowerCase() === o.toLowerCase(),
                              ),
                          )
                          .join(", ") || ""
                      }
                      onChangeText={(t) => {
                        const known = editForm.occasions.filter((o) =>
                          OCCASIONS_FLAT.some(
                            (f) => f.id.toLowerCase() === o.toLowerCase(),
                          ),
                        );
                        const custom = t
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean);
                        setEditForm((prev) => ({
                          ...prev,
                          occasions: [...known, ...custom],
                        }));
                      }}
                      placeholder="Custom occasions (comma separated)"
                      placeholderTextColor={Colors.textMuted}
                    />

                    <Text style={styles.uploadEditLabel}>Weather</Text>
                    <View style={styles.uploadEditChipRow}>
                      {(
                        [
                          { id: "spring", label: "Spring" },
                          { id: "summer", label: "Summer" },
                          { id: "fall", label: "Fall" },
                          { id: "winter", label: "Winter" },
                          { id: "all", label: "All seasons" },
                        ] as const
                      ).map((s) => {
                        const isOn = editForm.seasons
                          .map((x) => x.toLowerCase())
                          .includes(s.id);
                        return (
                          <TouchableOpacity
                            key={s.id}
                            style={[
                              styles.uploadEditChip,
                              isOn && styles.uploadEditChipOn,
                            ]}
                            onPress={() => {
                              let next: string[];
                              if (s.id === "all") {
                                next = isOn ? [] : ["all"];
                              } else {
                                const withoutAll = editForm.seasons.filter(
                                  (x) => x !== "all",
                                );
                                next = isOn
                                  ? withoutAll.filter((x) => x !== s.id)
                                  : [...withoutAll, s.id];
                              }
                              setEditForm((prev) => ({
                                ...prev,
                                seasons: next,
                              }));
                            }}
                          >
                            <Text
                              style={[
                                styles.uploadEditChipText,
                                isOn && styles.uploadEditChipTextOn,
                              ]}
                            >
                              {s.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={styles.uploadEditActions}>
                      <TouchableOpacity
                        style={styles.uploadEditCancelBtn}
                        onPress={() => {
                          setEditIndex(null);
                          setPreviewUri(null);
                        }}
                      >
                        <Text style={styles.uploadEditCancelText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.uploadEditSaveBtn}
                        onPress={saveUploadEdit}
                      >
                        <Text style={styles.uploadEditSaveText}>Save</Text>
                      </TouchableOpacity>
                    </View>
                  </ScrollView>

                  {/* Nested Modal often fails on Android/iOS while Configure is open — overlay inside this Modal instead */}
                  {previewUri !== null && editIndex !== null
                    ? (() => {
                        const pe = aiMetaList[editIndex];
                        const orig = pe?.originalSourceUri;
                        const hasDual =
                          !!orig && !!pe?.sourceUri && orig !== pe.sourceUri;
                        const bgLight = previewUri.startsWith("data:");
                        return (
                          <View
                            pointerEvents="box-none"
                            style={[
                              StyleSheet.absoluteFill,
                              { zIndex: 200, elevation: 200 },
                            ]}
                          >
                            <GestureHandlerRootView
                              style={StyleSheet.absoluteFill}
                            >
                              {hasDual ? (
                                <View
                                  style={[
                                    StyleSheet.absoluteFill,
                                    {
                                      backgroundColor: bgLight
                                        ? "#FFFFFF"
                                        : "#000",
                                    },
                                  ]}
                                >
                                  <GHScrollView
                                    ref={previewFullscreenScrollRef}
                                    horizontal
                                    pagingEnabled
                                    nestedScrollEnabled
                                    keyboardShouldPersistTaps="handled"
                                    showsHorizontalScrollIndicator={false}
                                    style={{ flex: 1 }}
                                    onScroll={(e) => {
                                      const p = Math.round(
                                        e.nativeEvent.contentOffset.x / width,
                                      );
                                      setPreviewFullscreenPage(p);
                                    }}
                                    scrollEventThrottle={16}
                                  >
                                    <View
                                      style={{ width, height: windowHeight }}
                                    >
                                      <Image
                                        source={{ uri: pe.sourceUri }}
                                        style={{ width, height: windowHeight }}
                                        resizeMode="contain"
                                      />
                                    </View>
                                    <View
                                      style={{ width, height: windowHeight }}
                                    >
                                      <Image
                                        source={{ uri: orig }}
                                        style={{ width, height: windowHeight }}
                                        resizeMode="contain"
                                      />
                                    </View>
                                  </GHScrollView>
                                  <View
                                    style={styles.fullscreenPagerDots}
                                    pointerEvents="none"
                                  >
                                    <View
                                      style={[
                                        styles.fullscreenPagerDot,
                                        previewFullscreenPage === 0 &&
                                          styles.fullscreenPagerDotActive,
                                      ]}
                                    />
                                    <View
                                      style={[
                                        styles.fullscreenPagerDot,
                                        previewFullscreenPage === 1 &&
                                          styles.fullscreenPagerDotActive,
                                      ]}
                                    />
                                  </View>
                                  <TouchableOpacity
                                    style={[
                                      styles.fullscreenPagerClose,
                                      { top: insets.top + 10 },
                                    ]}
                                    onPress={() => setPreviewUri(null)}
                                    hitSlop={12}
                                    activeOpacity={0.85}
                                    accessibilityLabel="Close preview"
                                  >
                                    <View
                                      style={styles.fullscreenPagerCloseInner}
                                    >
                                      <ArcClose color="#FFF" />
                                    </View>
                                  </TouchableOpacity>
                                </View>
                              ) : (
                                <TouchableOpacity
                                  activeOpacity={1}
                                  style={[
                                    StyleSheet.absoluteFill,
                                    bgLight
                                      ? { backgroundColor: "#FFFFFF" }
                                      : { backgroundColor: "#000" },
                                  ]}
                                  onPress={() => setPreviewUri(null)}
                                >
                                  <Image
                                    source={{ uri: previewUri }}
                                    style={{ width, height: windowHeight }}
                                    resizeMode="contain"
                                  />
                                </TouchableOpacity>
                              )}
                            </GestureHandlerRootView>
                          </View>
                        );
                      })()
                    : null}
                </View>
              </Modal>

              {/* Only when Configure is closed — opening preview from Configure uses in-modal overlay above */}
              <Modal
                visible={previewUri !== null && editIndex === null}
                transparent
                animationType="fade"
                onRequestClose={() => setPreviewUri(null)}
              >
                <TouchableOpacity
                  activeOpacity={1}
                  style={[
                    styles.fullscreenBackdrop,
                    previewUri?.startsWith("data:") && {
                      backgroundColor: "#FFFFFF",
                    },
                  ]}
                  onPress={() => setPreviewUri(null)}
                >
                  <Image
                    source={{ uri: previewUri! }}
                    style={styles.fullscreenImage}
                    resizeMode="contain"
                  />
                </TouchableOpacity>
              </Modal>

              <IosStyleColorPickerModal
                variant="item"
                visible={uploadColorPickerOpen}
                onClose={() => setUploadColorPickerOpen(false)}
                itemValue={editForm.color}
                onSelectItem={(c) => {
                  setEditForm((prev) => ({ ...prev, color: c }));
                  setUploadColorPickerOpen(false);
                }}
              />
            </>
          )}

          {status === "review" && image ? (
            <View style={[styles.reviewSheet, { top: insets.top }]}>
              <View style={styles.reviewSheetHandleArea}>
                <View style={styles.dragHandle} />
              </View>
              <ScrollView
                style={styles.reviewSheetScroll}
                contentContainerStyle={[
                  styles.scrollContent,
                  { paddingBottom: reviewScrollBottomPad },
                ]}
                showsVerticalScrollIndicator={false}
              >
                {renderReviewItemsBody(6)}
              </ScrollView>

              <View
                style={[
                  styles.reviewStickyBar,
                  { paddingBottom: Math.max(insets.bottom, 16) },
                ]}
              >
                <TouchableOpacity
                  style={styles.reviewStickySecondary}
                  onPress={() => setAddMoreSheetOpen(true)}
                  disabled={uploading}
                >
                  <Text style={styles.reviewStickySecondaryText}>+ Add</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.reviewStickyPrimary,
                    (!aiMetaList.length || uploading) &&
                      styles.reviewStickyPrimaryDisabled,
                  ]}
                  onPress={handleAddToCloset}
                  disabled={!aiMetaList.length || uploading}
                >
                  {uploading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.reviewStickyPrimaryText}>
                      Save to closet
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <>
              <ScrollView
                contentContainerStyle={[
                  styles.scrollContent,
                  {
                    paddingTop: status === "done" ? insets.top + 18 : 0,
                    paddingBottom: status === "done" ? doneScrollBottomPad : 24,
                  },
                ]}
                showsVerticalScrollIndicator={false}
              >
                {renderReviewItemsBody(insets.top)}

                {status === "done" ? (
                  <View style={styles.doneStage}>
                    <View style={styles.doneCard}>
                      <View style={styles.doneKicker}>
                        <Text style={styles.doneKickerText}>
                          Saved successfully
                        </Text>
                      </View>
                      <View style={styles.checkCircle}>
                        <ArcCheck color="#FFF" />
                      </View>
                      <Text style={styles.doneTitle}>Added to closet</Text>
                      <Text style={styles.doneSub}>
                        {aiMetaList.length} item
                        {aiMetaList.length === 1 ? "" : "s"} ready to style
                        {donePhotoCount > 1
                          ? ` across ${donePhotoCount} photos.`
                          : "."}
                      </Text>

                      <View style={styles.doneStatsRow}>
                        <View style={styles.doneStatPill}>
                          <Text style={styles.doneStatValue}>
                            {aiMetaList.length}
                          </Text>
                          <Text style={styles.doneStatLabel}>Items</Text>
                        </View>
                        <View style={styles.doneStatPill}>
                          <Text style={styles.doneStatValue}>
                            {Math.max(donePhotoCount, 1)}
                          </Text>
                          <Text style={styles.doneStatLabel}>Photos</Text>
                        </View>
                      </View>

                      <View style={styles.doneButtonStack}>
                        <TouchableOpacity
                          style={styles.donePrimaryBtn}
                          onPress={leaveAddItemsFlow}
                        >
                          <Text style={styles.donePrimaryBtnText}>Done</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.doneSecondaryBtn}
                          onPress={() => setAddMoreSheetOpen(true)}
                        >
                          <Text style={styles.doneSecondaryBtnText}>
                            Add more
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                ) : null}
              </ScrollView>

              {status === "review" && !image ? (
                <>
                  <View
                    style={[
                      styles.reviewStickyBar,
                      { paddingBottom: Math.max(insets.bottom, 16) },
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.reviewStickySecondary}
                      onPress={() => setAddMoreSheetOpen(true)}
                      disabled={uploading}
                    >
                      <Text style={styles.reviewStickySecondaryText}>
                        + Add
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.reviewStickyPrimary,
                        (!aiMetaList.length || uploading) &&
                          styles.reviewStickyPrimaryDisabled,
                      ]}
                      onPress={handleAddToCloset}
                      disabled={!aiMetaList.length || uploading}
                    >
                      {uploading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.reviewStickyPrimaryText}>
                          Save to closet
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </>
          )}

          {(status === "review" || status === "done") && (
            <Modal
              visible={addMoreSheetOpen}
              transparent
              animationType="slide"
              onRequestClose={() => setAddMoreSheetOpen(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={styles.sheetBackdrop}
                onPress={() => setAddMoreSheetOpen(false)}
              />
              <View
                style={[
                  styles.addMoreSheet,
                  { paddingBottom: Math.max(insets.bottom, 24) },
                ]}
              >
                <View style={styles.sheetHandle} />
                <Text style={styles.sheetTitle}>Add more items</Text>
                <TouchableOpacity
                  style={styles.sheetOption}
                  onPress={addMoreFromCamera}
                >
                  <View style={styles.sheetOptionIcon}>
                    <Svg width="22" height="22" viewBox="0 0 24 24">
                      <Rect
                        x="3"
                        y="6"
                        width="18"
                        height="13"
                        rx="2"
                        stroke="#000"
                        strokeWidth="2"
                        fill="none"
                      />
                      <Circle
                        cx="12"
                        cy="13"
                        r="3.5"
                        stroke="#000"
                        strokeWidth="1.8"
                        fill="none"
                      />
                      <Path
                        d="M9 6l1.5-2h3L15 6"
                        stroke="#000"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        fill="none"
                      />
                    </Svg>
                  </View>
                  <View style={styles.sheetOptionText}>
                    <Text style={styles.sheetOptionTitle}>Camera</Text>
                    <Text style={styles.sheetOptionSub}>
                      Take a photo right now
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.sheetOption}
                  onPress={addMoreFromLibrary}
                >
                  <View style={styles.sheetOptionIcon}>
                    <Svg width="22" height="22" viewBox="0 0 24 24">
                      <Rect
                        x="3"
                        y="3"
                        width="18"
                        height="18"
                        rx="3"
                        stroke="#000"
                        strokeWidth="2"
                        fill="none"
                      />
                      <Circle cx="8.5" cy="8.5" r="1.5" fill="#000" />
                      <Path
                        d="M21 15L16 10L5 21"
                        stroke="#000"
                        strokeWidth="2"
                        strokeLinecap="round"
                        fill="none"
                      />
                    </Svg>
                  </View>
                  <View style={styles.sheetOptionText}>
                    <Text style={styles.sheetOptionTitle}>Photo library</Text>
                    <Text style={styles.sheetOptionSub}>
                      Pick from your camera roll
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>
            </Modal>
          )}
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  permissionScreen: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
    gap: 32,
    backgroundColor: Colors.bg,
  },
  permTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
  },
  permSub: {
    fontSize: 16,
    color: Colors.textMuted,
    textAlign: "center",
  },
  cameraWrapper: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.bg,
  },
  cameraViewport: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  cameraRollPlaceholder: {
    backgroundColor: Colors.bg,
  },
  libraryPassThrough: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  analyzingSheet: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.bg,
    justifyContent: "center",
  },
  analyzingSheetBody: {
    alignItems: "center",
    gap: 18,
    paddingHorizontal: 40,
  },
  analyzingTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
  },
  analyzingSub: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  libraryOnlyRoot: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  libraryOnlyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  libraryCloseBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  libraryOnlyTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: Colors.text,
  },
  libraryOnlyToggleWrap: {
    alignItems: "center",
    paddingBottom: 12,
  },
  libraryOnlyBody: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
    gap: 20,
  },
  libraryOnlyStatus: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
    paddingHorizontal: 16,
  },
  libraryOnlyStatusSub: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.textMuted,
    textAlign: "center",
    paddingHorizontal: 20,
    marginTop: 6,
    lineHeight: 18,
  },
  libraryOnlyHint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 19,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 8,
    opacity: 0.92,
  },
  libraryOnlyBanner: {
    fontSize: 13,
    fontWeight: "600",
    color: "#B3261E",
    textAlign: "center",
    lineHeight: 19,
    marginTop: 8,
    marginBottom: 10,
    paddingHorizontal: 16,
  },
  libraryOnlyErrorHint: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 16,
    paddingHorizontal: 20,
  },
  librarySecondaryBtn: {
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  librarySecondaryBtnText: {
    fontSize: 12,
    fontWeight: "800",
    color: Colors.accent,
    textAlign: "center",
    letterSpacing: 0.6,
  },
  hudOverlay: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: 20,
    justifyContent: "space-between",
  },
  hudHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  hudHeaderLabel: {
    flex: 1,
    alignItems: "center",
    gap: 1,
  },
  hudHeaderTitle: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  hudHeaderSub: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 10,
    fontWeight: "500",
    letterSpacing: 0.3,
  },
  hudGhostBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  hudGhostBtnActive: {
    backgroundColor: "rgba(255,200,0,0.3)",
    borderWidth: 1.5,
    borderColor: "rgba(255,200,0,0.6)",
  },

  hudBottom: {
    gap: 12,
  },
  thumbsRow: {
    maxHeight: 80,
  },
  thumbsContent: {
    gap: 8,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  thumbWrap: {
    width: 64,
    height: 72,
    borderRadius: 10,
    overflow: "hidden",
    position: "relative",
    backgroundColor: Colors.imageLetterbox,
  },
  thumbImg: {
    width: "100%",
    height: "100%",
  },
  thumbX: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  hudFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  shutterBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: "#fff",
    padding: 5,
  },
  shutterInner: {
    flex: 1,
    borderRadius: 38,
    backgroundColor: "#fff",
  },
  doneBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  doneBtnText: {
    color: "#000",
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 0.2,
    textAlign: "center",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    gap: 20,
  },
  loadingText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 2,
  },
  reviewWrapper: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  reviewWrapperHost: {
    flex: 1,
    flexDirection: "column",
  },
  reviewBackdropHost: {
    backgroundColor: "transparent",
  },
  reviewBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  reviewBackdropImage: {
    width: "100%",
    height: "100%",
  },
  reviewSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
    flexDirection: "column",
    backgroundColor: Colors.bg,
  },
  reviewSheetHandleArea: {
    paddingTop: 10,
    paddingBottom: 2,
    alignItems: "center",
  },
  reviewSheetScroll: {
    flex: 1,
  },
  fullscreenBackdrop: {
    flex: 1,
    backgroundColor: "#000",
  },
  fullscreenImage: {
    flex: 1,
    width: "100%",
  },
  fullscreenPagerClose: {
    position: "absolute",
    right: 14,
    zIndex: 20,
  },
  fullscreenPagerCloseInner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.25)",
  },
  fullscreenPagerDots: {
    position: "absolute",
    bottom: 36,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 7,
    zIndex: 12,
  },
  fullscreenPagerDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.42)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.2)",
  },
  fullscreenPagerDotActive: {
    backgroundColor: "rgba(255,255,255,0.95)",
    borderColor: "rgba(0,0,0,0.15)",
  },
  dragHandle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(0,0,0,0.12)",
    alignSelf: "center",
    marginBottom: 12,
  },
  reviewHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  reviewCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  snapReviewHeader: {
    paddingHorizontal: 24,
    marginBottom: 8,
    alignItems: "center",
  },
  snapReviewTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: Colors.text,
    letterSpacing: -0.5,
  },
  snapReviewSubtitle: {
    fontSize: 14,
    color: Colors.textMuted,
    marginTop: 4,
    textAlign: "center",
    lineHeight: 20,
  },
  snapReviewMultiHint: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.accent,
    textAlign: "center",
    marginTop: 10,
  },
  isolatedThumb: {
    width: 140,
    alignSelf: "center", // shrinks to image height so card hugs the garment with no bands
    backgroundColor: "#F5F1EC", // warm neutral — matches competitor's non-white card tone
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 16,
    overflow: "hidden",
    borderRightWidth: 1,
    borderRightColor: "rgba(0,0,0,0.05)",
  },
  isolatedThumbImg: {
    width: "100%",
    height: "100%",
  },
  shimmerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  classifyingBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.92)",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  classifyingMeta: {
    flex: 1,
    paddingTop: 8,
  },
  classifyingLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "rgba(0,0,0,0.35)",
    letterSpacing: 0.3,
    marginBottom: 10,
  },
  shimmerLine: {
    height: 14,
    width: "80%",
    borderRadius: 7,
    backgroundColor: "rgba(0,0,0,0.07)",
  },
  snapItemCard: {
    marginHorizontal: 20,
    marginBottom: 14,
    backgroundColor: "#fff",
    borderRadius: 20,
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    minHeight: 180,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  snapItemMainPressable: {
    flexDirection: "row",
    minHeight: 180,
    flex: 1,
  },
  snapItemActionsBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(0,0,0,0.08)",
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 12,
    alignItems: "flex-end",
    backgroundColor: "#fff",
  },
  snapItemThumb: {
    width: 130,
    height: 160,
    backgroundColor: Colors.imageLetterbox,
  },
  snapItemMeta: {
    flex: 1,
    padding: 14,
    flexDirection: "column",
    overflow: "hidden",
  },
  snapItemTrashBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 1,
  },
  snapItemName: {
    fontSize: 17,
    fontWeight: "800",
    color: "#000",
    marginTop: 2,
    marginBottom: 8,
    paddingRight: 28,
    lineHeight: 22,
  },
  snapItemCatPill: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.06)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 10,
  },
  snapItemCatText: {
    fontSize: 10,
    fontWeight: "800",
    color: "rgba(0,0,0,0.45)",
    letterSpacing: 0.8,
  },
  snapItemColorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  snapColorDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.12)",
  },
  snapItemColorText: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(0,0,0,0.55)",
    textTransform: "capitalize",
  },
  snapItemOccRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginBottom: 8,
  },
  snapItemOccChip: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  snapItemOccChipText: {
    fontSize: 11,
    fontWeight: "600",
    color: "rgba(0,0,0,0.4)",
    textTransform: "capitalize",
  },
  snapItemSeasonLine: {
    fontSize: 11,
    fontWeight: "600",
    color: "rgba(0,0,0,0.38)",
    marginTop: 4,
    textTransform: "capitalize",
  },
  snapItemActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  snapEnhanceBtn: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.18)",
    backgroundColor: "#fff",
    minWidth: 100,
    alignItems: "center",
    justifyContent: "center",
  },
  snapEnhanceBtnDisabled: {
    opacity: 0.55,
  },
  snapEnhanceBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
  },
  snapConfigureBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  snapConfigureBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
  },
  reviewAppendLoading: {
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 20,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.045)",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  reviewAppendLoadingText: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.textMuted,
    flex: 1,
  },
  reviewStickyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: Colors.bg,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.08)",
  },
  reviewStickySecondary: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.15)",
  },
  reviewStickySecondaryText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
  },
  reviewStickyPrimary: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 28,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
  },
  reviewStickyPrimaryDisabled: {
    opacity: 0.4,
  },
  reviewStickyPrimaryText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
  },
  uploadEditBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  uploadEditBackdropDismiss: {
    flex: 1,
  },
  uploadEditCard: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    maxHeight: "88%",
  },
  uploadEditItemThumb: {
    width: "100%",
    height: 200,
    backgroundColor: "#F5F1EC", // warm neutral — consistent with review card thumbnail
    borderRadius: 12,
    marginBottom: 16,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  uploadEditItemThumbImg: {
    height: "100%",
  },
  carouselDots: {
    position: "absolute",
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  carouselDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  carouselDotActive: {
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  uploadEditHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  uploadEditTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#000",
  },
  uploadEditCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  uploadEditLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(0,0,0,0.4)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  uploadEditInput: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#000",
    marginBottom: 16,
  },
  uploadEditChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 20,
  },
  uploadEditChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.05)",
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
  },
  uploadEditChipOn: {
    backgroundColor: "#000",
    borderColor: "#000",
  },
  uploadEditChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(0,0,0,0.5)",
  },
  uploadEditChipTextOn: {
    color: "#fff",
  },
  uploadColorTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
    backgroundColor: "rgba(0,0,0,0.04)",
    marginBottom: 20,
  },
  uploadColorTriggerTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#000",
  },
  uploadColorTriggerSub: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  uploadOccasionGrid: {
    gap: 8,
    marginBottom: 8,
  },
  uploadOccasionGroupLabel: {
    fontSize: 8,
    fontWeight: "900",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  uploadOccasionGroupRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  uploadOccChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  uploadOccChipOn: {
    backgroundColor: "#000",
    borderColor: "#000",
  },
  uploadOccChipText: {
    fontSize: 9,
    fontWeight: "800",
    color: "rgba(0,0,0,0.4)",
    textTransform: "uppercase",
  },
  uploadOccChipTextOn: {
    color: "#fff",
  },
  uploadEditActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  uploadEditCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.12)",
    alignItems: "center",
  },
  uploadEditCancelText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#000",
  },
  uploadEditSaveBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#000",
    alignItems: "center",
  },
  uploadEditSaveText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
  scrollContent: {
    paddingBottom: 160,
  },
  previewContainer: {
    width: "100%",
    aspectRatio: 0.8,
    backgroundColor: Colors.surface,
  },
  previewImg: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  pillBtn: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 30,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  pillBtnText: {
    color: "#FFF",
    fontWeight: "800",
    fontSize: 12,
    letterSpacing: 1,
  },

  extractionContainer: {
    padding: 24,
  },
  extractionTitle: {
    fontSize: 12,
    fontWeight: "900",
    color: Colors.text,
    letterSpacing: 2,
    marginBottom: 16,
  },
  reviewCard: {
    padding: 20,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
  },
  reviewName: {
    fontSize: 16,
    fontWeight: "800",
    color: Colors.text,
    textTransform: "capitalize",
  },
  reviewTypeSub: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    marginTop: 2,
  },
  occasionGrid: {
    gap: 10,
    marginBottom: 12,
  },
  occasionGroupLabel: {
    fontSize: 9,
    fontWeight: "900",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 5,
  },
  occasionGroupRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  miniChip: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  miniChipActive: {
    backgroundColor: "#000",
    borderColor: "#000",
  },
  miniChipText: {
    fontSize: 9,
    fontWeight: "800",
    color: "rgba(0,0,0,0.4)",
    textTransform: "uppercase",
  },
  miniChipTextActive: {
    color: "#FFF",
  },
  metaRow: {
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.05)",
    paddingTop: 8,
  },
  metaValueSmall: {
    fontSize: 11,
    color: "rgba(0,0,0,0.35)",
    fontWeight: "600",
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,0,0,0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 12,
  },
  removeBtnText: {
    color: "#FF3B30",
    fontSize: 16,
    fontWeight: "900",
  },
  saveBtn: {
    backgroundColor: Colors.accent,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 20,
  },
  saveBtnText: {
    color: "#000",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 1,
  },
  skipBtn: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  skipBtnText: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  emptyState: {
    padding: 40,
    alignItems: "center",
  },
  emptyStateText: {
    color: Colors.textMuted,
    fontSize: 14,
  },
  doneStage: {
    paddingHorizontal: 20,
  },
  doneCard: {
    paddingVertical: 28,
    paddingHorizontal: 22,
    alignItems: "center",
    gap: 18,
    backgroundColor: Colors.surface,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 6,
  },
  doneKicker: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  doneKickerText: {
    fontSize: 11,
    fontWeight: "800",
    color: "rgba(0,0,0,0.55)",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  checkCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  doneTitle: {
    fontSize: 30,
    fontWeight: "800",
    color: Colors.text,
    textAlign: "center",
  },
  doneSub: {
    fontSize: 15,
    color: Colors.textLight,
    textAlign: "center",
  },
  doneStatsRow: {
    width: "100%",
    flexDirection: "row",
    gap: 10,
  },
  doneStatPill: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: Colors.cloud,
    alignItems: "center",
    gap: 2,
  },
  doneStatValue: {
    fontSize: 22,
    fontWeight: "800",
    color: Colors.text,
  },
  doneStatLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  doneButtonStack: {
    width: "100%",
    gap: 10,
    marginTop: 6,
  },
  donePrimaryBtn: {
    width: "100%",
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  donePrimaryBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  doneSecondaryBtn: {
    width: "100%",
    minHeight: 54,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.12)",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  doneSecondaryBtnText: {
    color: Colors.text,
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 0.8,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  addMoreSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 20,
  },
  sheetHandle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(0,0,0,0.15)",
    alignSelf: "center",
    marginBottom: 18,
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: Colors.text,
    marginBottom: 16,
  },
  sheetOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    gap: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.06)",
  },
  sheetOptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.05)",
    justifyContent: "center",
    alignItems: "center",
  },
  sheetOptionText: {
    flex: 1,
  },
  sheetOptionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.text,
  },
  sheetOptionSub: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 2,
  },
});
