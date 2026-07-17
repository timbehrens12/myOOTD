import { useUser } from "@clerk/clerk-expo";
import {
    cropGarments,
    cropGarmentsFromOriginal,
    segmentItems,
} from "clothing-isolator";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions, type FlashMode } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import {
  Camera,
  Images,
  ShieldCheck,
  Shirt,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    ActivityIndicator,
    Alert,
    AppState,
    DeviceEventEmitter,
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
    useWindowDimensions,
    type StyleProp,
    type ViewStyle,
} from "react-native";
import {
    Gesture,
    GestureDetector,
    GestureHandlerRootView,
    TouchableOpacity as GHTouchableOpacity,
} from "react-native-gesture-handler";
import Animated, {
    Easing,
    FadeIn,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import ManualCropModal from "../components/add-items/ManualCropModal";
import OutfitUploadReview from "../components/add-items/OutfitUploadReview";
import { shelfIdForCategoryChip } from "../components/closet/closetShelfUtils";
import ColorPickerTriggerIcon from "../components/color-picker/ColorPickerTriggerIcon";
import IosStyleColorPickerModal from "../components/color-picker/IosStyleColorPickerModal";
import {
  apiClient,
  isLowConfidenceClassification,
  normalizeFormality,
  normalizePattern,
  normalizeStyleTags,
  primaryStyleFromTags,
} from "../constants/api-client";
import { APP_ITEM_NAMED_COLORS } from "../constants/appNamedColors";
import {
  Colors,
  Editorial,
  EditorialStyles,
  Fonts,
  Radii,
} from "../constants/AppTheme";
import { OCCASIONS_FLAT } from "../constants/occasions";
import { confirmLowConfidenceItems } from "../lib/confirmLowConfidence";
import { ensureJpegUri } from "../lib/ensureJpegForVision";
import {
    isShoeMeta,
    mergePairShoeMetasInBatch,
    mergeShoeIsolatesForSegmentBatch,
    mergeShoePairBoxesBeforeCrop,
} from "../lib/mergeShoeScanDuplicates";
import { downloadImageToCache } from "../lib/downloadImageToCache";
import { attachClothingItemsToOutfit } from "../lib/linkItemsToOutfit";
import { fitsLibraryRoute } from "../lib/fitsNavigation";
import { supabase } from "../lib/supabase";
import { markPendingFirstWardrobePrompt } from "../lib/wardrobeOnboarding";
import { takeAddItemsWardrobeId } from "../lib/wardrobeAddIntent";
import { addItemsToWardrobe, fetchWardrobes } from "../lib/wardrobes/wardrobeApi";
import { consumeLibraryIntent } from "../lib/uploadIntent";
import {
  ensureRecoveryDeclinesLoaded,
  isItemsRecoveryDismissed,
  isOutfitUploadRecoveryDismissed,
  suppressRecoveryPrompt,
} from "../lib/uploadRecoveryCoordinator";
import {
  clearOutfitUploadRecoverySession,
  loadOutfitUploadRecoverySession,
  migrateOutfitUploadRecoverySession,
  persistOutfitUploadSession,
  validateOutfitUploadRecoverySession,
  type OutfitUploadRecoverySession,
} from "../lib/outfitUploadRecoverySession";
import { buildOutfitHeroFromUri } from "../lib/outfitUploadPrepare";
import {
  newOutfitDraftId,
  saveOutfitUploadDraft,
  saveOutfitUploadDrafts,
  type OutfitUploadDraft,
} from "../lib/outfitUploadDraft";
import { saveUploadSessionToCloset } from "../lib/uploadRecoveryQueue";
import { enhanceViaGeminiAndVision } from "../lib/isolateEnhanceCutout";
import ReviewItemThumbView from "../components/review/ReviewItemThumb";
import {
  isItemClassifying,
  useReviewItemReveal,
} from "../components/review/reviewScanItemState";
import {
    clearUploadRecoverySession,
    effectiveUploadUserId,
    loadUploadRecoverySession,
    migrateUploadRecoverySession,
    persistUploadReviewSession,
    sessionPendingCount,
    sessionToAiMetaList,
    UPLOAD_RECOVERY_LOCAL_USER,
    validateUploadRecoverySession,
    type UploadRecoverySession,
} from "../lib/uploadRecoverySession";
import { requestLibraryAccessWithPriming } from "../lib/requestLibraryAccess";

/** Temporary visual-QA lock. Turn off after the camera permission screen is approved. */
const DEV_LOCK_CAMERA_PERMISSION_SCREEN = false; // visual QA: force the redesigned gate

function isoDayIsStrictlyFuture(isoDay: string): boolean {
  const parts = isoDay.split("-").map((n) => parseInt(n, 10));
  const y = parts[0];
  const mo = parts[1];
  const d = parts[2];
  if (y === undefined || mo === undefined || d === undefined) return false;
  const pick = new Date(y, mo - 1, d).getTime();
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  return pick > todayStart;
}

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
  const [aspect, setAspect] = useState<number | undefined>(
    selfAspect ? 0.8 : undefined,
  );
  const topOpacity = useSharedValue(1);

  useEffect(() => {
    if (uri === curUri) return;
    const nextIsPng = uri.includes("image/png");
    setCurUri(uri);
    if (nextIsPng) {
      setPrevUri(null);
      topOpacity.value = 1;
      return;
    }
    setPrevUri(curUri);
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
      () => {
        /* ignore */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [curUri, selfAspect]);

  const topStyle = useAnimatedStyle(() => ({ opacity: topOpacity.value }));

  return (
    <View
      style={[
        style,
        selfAspect && aspect
          ? { aspectRatio: aspect, height: undefined }
          : null,
        { overflow: "hidden", backgroundColor: Colors.homeHeroBackdrop },
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

const SHIMMER_SWEEP = [
  "transparent",
  "rgba(255,255,255,0.55)",
  "transparent",
] as const;

function ShimmerPlaceholderBar({
  width = "80%",
  height = 14,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const shimmerX = useSharedValue(-88);
  const pulse = useSharedValue(0.55);

  useEffect(() => {
    shimmerX.value = withRepeat(
      withTiming(168, { duration: 1300, easing: Easing.linear }),
      -1,
      false,
    );
    pulse.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [pulse, shimmerX]);

  const barPulse = useAnimatedStyle(() => ({
    opacity: interpolate(pulse.value, [0.55, 1], [0.62, 1]),
  }));
  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerX.value }],
  }));

  return (
    <Animated.View
      style={[
        {
          height,
          width,
          borderRadius: height / 2,
          backgroundColor: Colors.surfaceInset,
          overflow: "hidden",
        },
        barPulse,
        style,
      ]}
    >
      <Animated.View
        style={[
          { position: "absolute", top: 0, bottom: 0, width: 72 },
          sweepStyle,
        ]}
      >
        <LinearGradient
          colors={SHIMMER_SWEEP}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </Animated.View>
  );
}

const REVIEW_ITEM_META_MIN_HEIGHT = 128;

function ClassifyingMetaSkeleton() {
  return (
    <View style={styles.classifyingMeta}>
      <Text style={styles.classifyingLabel}>Identifying piece…</Text>
      <ShimmerPlaceholderBar />
      <ShimmerPlaceholderBar width="55%" style={{ marginTop: 10 }} />
      <ShimmerPlaceholderBar width="70%" style={{ marginTop: 10 }} />
    </View>
  );
}

/** Review-row thumb: shimmer until the final cutout is ready. */
function ReviewItemThumb({
  readyUri,
  enhancing,
  onReady,
}: {
  readyUri: string | null;
  enhancing?: boolean;
  onReady?: () => void;
}) {
  return (
    <ReviewItemThumbView
      readyUri={readyUri}
      enhancing={enhancing}
      onReady={onReady}
      thumbStyle={styles.snapItemThumb}
      innerStyle={styles.snapItemThumbInner}
      skeletonStyle={styles.scanSkeletonBlock}
    />
  );
}

function ReviewScanSkeletonActionsBar() {
  return (
    <View style={styles.snapItemActionsBar} pointerEvents="none">
      <View
        style={[styles.snapItemActionsRow, styles.snapItemActionsRowPending]}
      >
        <View style={styles.snapEnhanceBtn}>
          <Text style={styles.snapEnhanceBtnText}>Enhance</Text>
        </View>
        <View style={styles.snapAdjustBtn}>
          <Text style={styles.snapAdjustBtnText}>Adjust</Text>
        </View>
        <View style={styles.snapConfigureBtn}>
          <Text style={styles.snapConfigureBtnText}>Configure</Text>
        </View>
      </View>
    </View>
  );
}

function ReviewScanSkeletonCard() {
  return (
    <View style={styles.snapItemCard}>
      <View style={styles.snapItemMainPressable}>
        <View
          style={[
            styles.snapItemThumb,
            styles.scanSkeletonBlock,
            { overflow: "hidden" },
          ]}
        >
          <ShimmerPlaceholderBar
            width={138}
            height={160}
            style={{ borderRadius: 0 }}
          />
        </View>
        <View style={styles.snapItemMeta}>
          <ClassifyingMetaSkeleton />
        </View>
      </View>
      <ReviewScanSkeletonActionsBar />
    </View>
  );
}

type ReviewScanItemRowProps = {
  item: Record<string, unknown>;
  idx: number;
  onRemoveAt: (idx: number) => void;
  onConfigureAt: (idx: number) => void;
  onEnhanceAt: (idx: number) => void;
  onAdjustAt: (idx: number) => void;
};

function ReviewScanItemRow({
  item,
  idx,
  onRemoveAt,
  onConfigureAt,
  onEnhanceAt,
  onAdjustAt,
}: ReviewScanItemRowProps) {
  const { readyUri, showMetaSkeleton, onThumbReady } =
    useReviewItemReveal(item);
  const pending = isItemClassifying(item) || showMetaSkeleton;

  return (
    <View style={styles.snapItemCard}>
      <TouchableOpacity
        activeOpacity={0.88}
        style={styles.snapItemMainPressable}
        onPress={() =>
          !pending && !item._enhancing && onConfigureAt(idx)
        }
      >
        <ReviewItemThumb
          readyUri={readyUri}
          enhancing={!!item._enhancing}
          onReady={onThumbReady}
        />
        <View style={styles.snapItemMeta}>
          {!showMetaSkeleton ? (
            <TouchableOpacity
              style={styles.snapItemTrashBtn}
              onPress={() => onRemoveAt(idx)}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <IconTrashSmall />
            </TouchableOpacity>
          ) : null}
          {showMetaSkeleton ? (
            <ClassifyingMetaSkeleton />
          ) : (
            <View style={styles.snapItemMetaBody}>
              <Text style={styles.snapItemName}>
                {americanizeFashionText(
                  String(item?.name || "Unknown item"),
                )}
              </Text>
              <View style={styles.snapItemCatPill}>
                <Text style={styles.snapItemCatText}>
                  {americanizeFashionText(
                    String(
                      item?.sub_category ||
                        item?.type ||
                        item?.category ||
                        "Piece",
                    ),
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
                    {String(item.color)}
                  </Text>
                </View>
              ) : null}
              {Array.isArray(item?.occasions) &&
              (item.occasions as string[]).length > 0 ? (
                <View style={styles.snapItemOccRow}>
                  {(item.occasions as string[]).slice(0, 4).map((occ) => (
                    <View key={occ} style={styles.snapItemOccChip}>
                      <Text style={styles.snapItemOccChipText}>{occ}</Text>
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
              {isLowConfidenceClassification(item) ? (
                <View style={styles.snapItemLowConfidenceChip}>
                  <Text style={styles.snapItemLowConfidenceText}>
                    ⚠︎ Double-check this one — tap to edit
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </TouchableOpacity>
      <View style={styles.snapItemActionsBar} pointerEvents={pending ? "none" : "auto"}>
        <View
          style={[
            styles.snapItemActionsRow,
            pending && styles.snapItemActionsRowPending,
          ]}
        >
          <TouchableOpacity
            style={[
              styles.snapEnhanceBtn,
              !!item._enhancing && styles.snapEnhanceBtnDisabled,
            ]}
            onPress={() => onEnhanceAt(idx)}
            disabled={!!item._enhancing || pending}
            activeOpacity={0.88}
          >
            <Text style={styles.snapEnhanceBtnText}>Enhance</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.snapAdjustBtn}
            onPress={() => onAdjustAt(idx)}
            disabled={pending}
            activeOpacity={0.88}
          >
            <Text style={styles.snapAdjustBtnText}>Adjust</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.snapConfigureBtn}
            onPress={() => onConfigureAt(idx)}
            disabled={pending}
          >
            <Text style={styles.snapConfigureBtnText}>Configure</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function boxArea2d(box: number[]): number {
  const [ymin, xmin, ymax, xmax] = box;
  return Math.max(0, ymax - ymin) * Math.max(0, xmax - xmin);
}

function boxIoU2d(a: number[], b: number[]): number {
  const [ay0, ax0, ay1, ax1] = a;
  const [by0, bx0, by1, bx1] = b;
  const iy0 = Math.max(ay0, by0);
  const ix0 = Math.max(ax0, bx0);
  const iy1 = Math.min(ay1, by1);
  const ix1 = Math.min(ax1, bx1);
  const inter = Math.max(0, iy1 - iy0) * Math.max(0, ix1 - ix0);
  const union = boxArea2d(a) + boxArea2d(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Drop duplicate/overlapping Gemini boxes before we mount placeholder rows. */
function dedupeOverlappingBoxMetas(metas: any[]): any[] {
  const withBoxes = metas.filter(
    (m) => Array.isArray(m?.box_2d) && m.box_2d.length >= 4,
  );
  const withoutBoxes = metas.filter(
    (m) => !Array.isArray(m?.box_2d) || m.box_2d.length < 4,
  );
  const sorted = [...withBoxes].sort(
    (a, b) => boxArea2d(b.box_2d) - boxArea2d(a.box_2d),
  );
  const kept: any[] = [];
  for (const meta of sorted) {
    const box = meta.box_2d as number[];
    if (kept.some((k) => boxIoU2d(box, k.box_2d as number[]) >= 0.42)) {
      continue;
    }
    kept.push(meta);
  }
  return [...kept, ...withoutBoxes];
}

/** Minimum box span in 0–1000 space so crops are never hairlines (models love mirror edges). */
const MIN_BOX_2D_SPAN = 115;
const MIN_BOX_2D_SPAN_ACCESSORY = 40;
/** Fit-check: lower = allow tighter crops (more “zoom”) on jewelry / small items. */
const MIN_BOX_2D_SPAN_ACCESSORY_FITCHECK = 118;
/** Necklaces / chains on fit-check: keep them visible without over-zooming to one corner. */
const MIN_BOX_2D_SPAN_NECKLACE_FITCHECK = 120;
/** Headbands / glasses on fit-check need more context than hats to stay centered. */
const MIN_BOX_2D_SPAN_HEAD_ACCESSORY_FITCHECK = 150;
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
  if (isHeadAccessoryLike(meta)) return false;
  const text =
    `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.name ?? ""}`
      .toLowerCase()
      .trim();
  if (!text) return false;
  return (
    /\b(jewelry|jewellery|earring|ring|bracelet|watch|brooch|pendant|chain|choker)\b/.test(
      text,
    ) ||
    (classifyCategoryLower(meta) === "accessory" && !isNeckJewelryLike(meta))
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

function fashionText(meta: any): string {
  return `${meta?.category ?? ""} ${meta?.sub_category ?? ""} ${meta?.type ?? ""} ${meta?.name ?? ""}`
    .toLowerCase()
    .trim();
}

function isHatAccessoryLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(hat|cap|beanie|beret|visor|snapback|fedora|bucket\s*hat|baseball\s*cap)\b/.test(
    text,
  );
}

function isEyewearAccessoryLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(glasses|sunglasses|eyewear|spectacles|goggles|shades|sunnies|aviators?|wayfarers?)\b/.test(
    text,
  );
}

function isHeadbandAccessoryLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(headband|hairband|bandana|durag|balaclava)\b/.test(text);
}

function isHeadAccessoryLike(meta: any): boolean {
  return (
    isHatAccessoryLike(meta) ||
    isEyewearAccessoryLike(meta) ||
    isHeadbandAccessoryLike(meta)
  );
}

function isWristAccessoryLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(watch|watches|bracelet|bracelets|cuff|bangle)\b/.test(text);
}

function isBeltAccessoryLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(belt|waist\s*chain)\b/.test(text);
}

function isTinyWornAccessoryLike(meta: any): boolean {
  return (
    isEyewearAccessoryLike(meta) ||
    isNeckJewelryLike(meta) ||
    isWristAccessoryLike(meta) ||
    isBeltAccessoryLike(meta)
  );
}

function isBootLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(boot|chelsea|combat\s*boot|cowboy\s*boot|ankle\s*boot|knee[-\s]*high|thigh[-\s]*high)\b/.test(
    text,
  );
}

function isShortBottomLike(meta: any): boolean {
  const text = fashionText(meta);
  return /\b(shorts?|mini\s*skirt|skort|tennis\s*skirt|micro\s*skirt)\b/.test(
    text,
  );
}

function americanizeFashionText(input: string): string {
  return input
    .replace(/\bthongs\b/gi, "flip-flops")
    .replace(/\bthong\b/gi, "flip-flop")
    .replace(/\btrainers\b/gi, "sneakers")
    .replace(/\btrainer\b/gi, "sneaker");
}

function normalizedSeasonsForMeta(meta: any): string[] | null {
  const text = fashionText(meta);
  const raw = Array.isArray(meta?.seasons)
    ? (meta.seasons as unknown[])
        .map((s) => String(s).toLowerCase().trim())
        .filter(Boolean)
    : [];
  const isVeryWarmTop =
    /\b(tube\s*top|strapless|cami|camisole|tank|crop\s*top|halter|bralette)\b/.test(
      text,
    );
  if (!isVeryWarmTop) return raw.length ? raw : null;
  const cleaned = raw.filter((s) => s !== "winter" && s !== "fall");
  const ensured = Array.from(new Set([...cleaned, "spring", "summer"]));
  return ensured.length ? ensured : ["spring", "summer"];
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
  // Tops need horizontal room for sleeves and a touch of vertical room for
  // collar/hem, but never so much that pants leak in from below.
  const up = mode === "fit_check" ? 0.025 : 0.06;
  // Small down-padding so the native crop keeps hems; display code also guards
  // in-view, but a slightly generous box helps shirts/pants.
  const down = mode === "fit_check" ? 0.025 : 0.05;
  // Moderate side margin: enough to keep sleeves in frame without zooming so
  // far out that adjacent garments leak in.
  const side = mode === "fit_check" ? 0.2 : 0.22;
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  if (mode === "fit_check") {
    // Mirror/OOTD top boxes often include the face. For shirt-like items, trim
    // obvious headroom while keeping enough neck/shoulder context to identify
    // collars and straps.
    const maxHeadroom = Math.round(ymax - (ymax - ymin) * 0.84);
    if (ymin < 260 && ymax > 360) {
      ymin = Math.max(ymin, Math.min(320, maxHeadroom));
    }
  }
  return ensureTopGarmentMinimumWidth([ymin, xmin, ymax, xmax]);
}

/**
 * Pants/bottoms: bias **down** (hem/cuffs/shoes) + waist context **up**.
 */
function expandBoxForBottomsGarmentCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
  meta?: any,
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  // Small upward pad so the waistband isn't sliced when the model's top edge
  // sits exactly on the belt-line.
  const up = mode === "fit_check" ? 0.02 : 0.04;
  const down = mode === "fit_check" ? 0.045 : 0.06;
  // Moderate horizontal pad: prevents one-leg clipping without grabbing extra
  // floor or shoes.
  const side = mode === "fit_check" ? 0.13 : 0.06;
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  if (mode === "fit_check") {
    if (meta && isShortBottomLike(meta)) {
      // Shorts/mini skirts should never include calves/shoes. If the detector
      // gives a full-leg box, keep the top and cap the lower edge around the
      // upper-thigh region of that detected span.
      const maxShortH = 285;
      if (ymax - ymin > maxShortH) {
        ymax = Math.min(1000, ymin + maxShortH);
      }
    }
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
  const up = mode === "fit_check" ? 0.035 : 0.06;
  const down = mode === "fit_check" ? 0.035 : 0.06;
  const side = mode === "fit_check" ? 0.12 : 0.05;
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
/**
 * Items that should be skipped on FIT-CHECK photos (worn outfits) — too small or
 * low-value for auto-building fits to crop well from a distance.
 * KEEPS: Tops, Bottoms, Outerwear, Full Body, Shoes, Hats, Headbands, Bags.
 * SKIPS: Jewelry, Watches, Glasses, Belts, Socks, Ties, Scarves, and tiny hair accessories.
 */
function isSkippableOnFitCheck(meta: any): boolean {
  const text = fashionText(meta);
  if (!text) return false;

  // Skip Jewelry & Watches
  if (isNeckJewelryLike(meta) || isWristAccessoryLike(meta)) return true;
  if (
    /\b(earrings?|ring|rings|brooch|pendant|small\s*pendant|jewelry|jewellery)\b/.test(
      text,
    )
  )
    return true;

  // Skip Glasses/Eyewear (user said scrap for outfit scans)
  if (isEyewearAccessoryLike(meta)) return true;

  // Skip Belts, Socks, Ties, Scarves, etc.
  if (isBeltAccessoryLike(meta)) return true;
  if (/\b(socks?|tie|necktie|bow\s*tie|scarf|bandana|collar)\b/.test(text))
    return true;

  // Skip tiny hair accessories
  return /\b(hair\s*tie|scrunchies?|hair\s*clip|bobby\s*pin|barrette)\b/.test(
    text,
  );
}

/**
 * For accessories on fit-check photos, Gemini's box is often mis-aimed (e.g. glasses
 * mapped to the torso). Override the box based on where the item *must* be on a human body.
 * Returns [ymin, xmin, ymax, xmax] in 0–1000 coords, or null to use Gemini's box.
 */
function expandBoxForAccessoryCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
  meta?: any,
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;

  const hatLike = !!meta && isHatAccessoryLike(meta);
  const eyewearLike = !!meta && isEyewearAccessoryLike(meta);
  const headbandLike = !!meta && isHeadbandAccessoryLike(meta);
  const neckLike = !!meta && isNeckJewelryLike(meta);

  // ── 1. Category-specific box cleanup for fit-check accessories ──────────
  if (mode === "fit_check" && meta) {
    const w0 = xmax - xmin;
    const h0 = ymax - ymin;
    const cx0 = (xmin + xmax) / 2;
    const cy0 = (ymin + ymax) / 2;

    // Hats are currently good. Keep the same side-biased trim that removes
    // raised-hand bleed without changing hat framing behavior.
    if (hatLike) {
      const maxW = Math.round(h0 * 1.9);
      if (w0 > maxW) {
        const useLeft = cx0 > 500; // hand likely on right side
        if (useLeft) xmax = Math.min(1000, xmin + maxW);
        else xmin = Math.max(0, xmax - maxW);
      }
    }

    // Glasses/headbands: prefer symmetric width clamp around center so we
    // don't drift to one side, and clamp to an upper-body vertical band.
    if (eyewearLike || headbandLike) {
      const maxAspect = eyewearLike ? 3.2 : 3.4;
      const maxW = Math.round(h0 * maxAspect);
      if (w0 > maxW) {
        const half = Math.round(maxW / 2);
        xmin = Math.max(0, Math.round(cx0) - half);
        xmax = Math.min(1000, Math.round(cx0) + half);
      }
      // Headbands can be higher (hairline), glasses are mid-face.
      const maxY = headbandLike ? 280 : 340;
      if (ymax > maxY) {
        const keepH = Math.max(120, Math.round((ymax - ymin) * 0.92));
        ymax = maxY;
        ymin = Math.max(0, ymax - keepH);
      }
    }

    // Neck jewelry: keep chain centered in a neck/chest window, not a corner.
    if (neckLike) {
      const targetH = Math.max(130, Math.min(260, Math.round(h0 * 0.95)));
      const targetW = Math.max(170, Math.min(340, Math.round(targetH * 1.55)));
      const cyClamped = Math.max(240, Math.min(cy0, 500));
      const halfW = Math.round(targetW / 2);
      const halfH = Math.round(targetH / 2);
      xmin = Math.max(0, Math.round(cx0) - halfW);
      xmax = Math.min(1000, Math.round(cx0) + halfW);
      ymin = Math.max(0, Math.round(cyClamped) - halfH);
      ymax = Math.min(1000, Math.round(cyClamped) + halfH);
    }
  }

  const h = ymax - ymin;
  const w = xmax - xmin;
  // Per-accessory expansion. Keep hats untouched; relax other head accessories
  // and chains to avoid corner crops.
  const up =
    mode === "fit_check"
      ? neckLike
        ? 0.04
        : eyewearLike || headbandLike
          ? 0.06
          : 0.02
      : 0.1;
  const down =
    mode === "fit_check"
      ? neckLike
        ? 0.06
        : eyewearLike || headbandLike
          ? 0.03
          : 0.02
      : 0.1;
  const side =
    mode === "fit_check"
      ? neckLike
        ? 0.08
        : eyewearLike || headbandLike
          ? 0.08
          : 0.05
      : 0.15;
  ymin = Math.max(0, ymin - Math.round(h * up));
  ymax = Math.min(1000, ymax + Math.round(h * down));
  xmin = Math.max(0, xmin - Math.round(w * side));
  xmax = Math.min(1000, xmax + Math.round(w * side));
  return [ymin, xmin, ymax, xmax];
}

function expandBoxForFootwearCrop(
  box: number[],
  mode: "fit_check" | "flat_lay",
  meta?: any,
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const h = ymax - ymin;
  const w = xmax - xmin;
  const bootLike = !!meta && isBootLike(meta);
  const up = mode === "fit_check" ? (bootLike ? 0.12 : 0.09) : 0.1;
  const down = mode === "fit_check" ? (bootLike ? 0.18 : 0.12) : 0.1;
  // Moderate horizontal pad: keeps both shoes in frame without grabbing floor.
  const side = mode === "fit_check" ? (bootLike ? 0.16 : 0.14) : 0.15;
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
 * Re-balance a box so neither side is glued to the original tight bounds. If the
 * supplied box has different left/right margins relative to a reference center
 * (e.g. body center), shift outward to make both margins at least `minMarginPct`
 * of the box width. Keeps the larger margin intact when one side hits the frame.
 */
function ensureSymmetricSideMargins(
  box: number[],
  minMarginPct = 0.06,
): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  if (xmax <= xmin || ymax <= ymin) return box;
  const w = xmax - xmin;
  const minMargin = Math.round(w * minMarginPct);
  // We don't know the garment edge precisely; approximate by ensuring the
  // crop has at least `minMargin` between any of its edges and the next body
  // landmark (the frame). For body-frame purposes the helpful effect is that
  // boxes which already touch 0 or 1000 get pushed away from that edge if
  // there's room.
  if (xmin < minMargin) xmin = Math.max(0, xmin - minMargin);
  if (xmax > 1000 - minMargin) xmax = Math.min(1000, xmax + minMargin);
  if (ymin < minMargin) ymin = Math.max(0, ymin - minMargin);
  if (ymax > 1000 - minMargin) ymax = Math.min(1000, ymax + minMargin);
  return [ymin, xmin, ymax, xmax];
}

/**
 * After category-specific expansion, double the side padding on the side that
 * is closer to the model's original box (asymmetric crop fixer). Prevents
 * one-shoulder/leg/foot clipping when the source box was offset.
 */
function rebalanceCropSides(
  expanded: number[],
  originalBox: number[],
  extraSidePct = 0.06,
): number[] {
  let [ymin, xmin, ymax, xmax] = expanded;
  const [, oxmin, , oxmax] = originalBox;
  if (xmax <= xmin) return expanded;
  const w = xmax - xmin;
  const leftMargin = oxmin - xmin;
  const rightMargin = xmax - oxmax;
  if (leftMargin >= 0 && rightMargin >= 0) {
    const extra = Math.round(w * extraSidePct);
    if (leftMargin < rightMargin) {
      xmin = Math.max(0, xmin - extra);
    } else if (rightMargin < leftMargin) {
      xmax = Math.min(1000, xmax + extra);
    }
  }
  return [ymin, xmin, ymax, xmax];
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

function boxCenterX(box: unknown): number | null {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [, xmin, , xmax] = box as number[];
  if (xmax <= xmin) return null;
  return (xmin + xmax) / 2;
}

type FitCheckBodyGeometry = {
  centerX: number;
  leftX: number;
  rightX: number;
  headY: number;
  eyeY: number;
  neckY: number;
  chestY: number;
  waistY: number;
};

type CropCandidate = {
  box: number[];
  reason: string;
};

function clampBox2d(box: number[]): number[] {
  let [ymin, xmin, ymax, xmax] = box;
  ymin = Math.max(0, Math.min(1000, Math.round(ymin)));
  xmin = Math.max(0, Math.min(1000, Math.round(xmin)));
  ymax = Math.max(0, Math.min(1000, Math.round(ymax)));
  xmax = Math.max(0, Math.min(1000, Math.round(xmax)));
  if (ymax <= ymin) ymax = Math.min(1000, ymin + 40);
  if (xmax <= xmin) xmax = Math.min(1000, xmin + 40);
  return [ymin, xmin, ymax, xmax];
}

function centeredBox2d(cx: number, cy: number, w: number, h: number): number[] {
  return clampBox2d([cy - h / 2, cx - w / 2, cy + h / 2, cx + w / 2]);
}

function boxMetrics(box: number[]) {
  const [ymin, xmin, ymax, xmax] = box;
  const w = xmax - xmin;
  const h = ymax - ymin;
  return {
    ymin,
    xmin,
    ymax,
    xmax,
    w,
    h,
    cx: (xmin + xmax) / 2,
    cy: (ymin + ymax) / 2,
    area: w * h,
  };
}

function inferFitCheckBodyGeometry(items: any[]): FitCheckBodyGeometry {
  const usable = items
    .map((m: any) => {
      const cx = boxCenterX(m?.box_2d);
      if (cx == null) return null;
      const [ymin, xmin, ymax, xmax] = m.box_2d as number[];
      return { cx, ymin, xmin, ymax, xmax, meta: m };
    })
    .filter(Boolean) as {
    cx: number;
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
    meta: any;
  }[];

  const headAnchor = usable.find(
    ({ meta }) =>
      (isHatAccessoryLike(meta) || isHeadbandAccessoryLike(meta)) &&
      !isEyewearAccessoryLike(meta),
  );

  const upperBodyAnchor = usable.find(
    ({ meta, ymin, ymax }) =>
      (isTopGarment(meta) || classifyCategoryLower(meta) === "outerwear") &&
      ymin < 520 &&
      ymax > 180,
  );
  const fullBodyAnchor = usable.find(({ meta }) => isFullBodyCategory(meta));
  const bottomAnchor = usable.find(({ meta }) => isBottomsLike(meta));
  const centerX =
    headAnchor?.cx ??
    upperBodyAnchor?.cx ??
    fullBodyAnchor?.cx ??
    bottomAnchor?.cx ??
    500;

  const bodyAnchors = usable.filter(
    ({ meta }) =>
      isTopGarment(meta) ||
      isBottomsLike(meta) ||
      isFullBodyCategory(meta) ||
      classifyCategoryLower(meta) === "outerwear",
  );
  const leftX =
    bodyAnchors.length > 0
      ? Math.min(...bodyAnchors.map((b) => b.xmin))
      : Math.max(80, centerX - 180);
  const rightX =
    bodyAnchors.length > 0
      ? Math.max(...bodyAnchors.map((b) => b.xmax))
      : Math.min(920, centerX + 180);
  const topY =
    headAnchor?.ymin ??
    (upperBodyAnchor ? Math.max(0, upperBodyAnchor.ymin - 180) : 70);
  const neckY = upperBodyAnchor
    ? Math.max(190, Math.min(360, upperBodyAnchor.ymin + 65))
    : Math.max(190, topY + 145);
  const chestY = upperBodyAnchor
    ? Math.max(
        260,
        Math.min(520, (upperBodyAnchor.ymin + upperBodyAnchor.ymax) / 2),
      )
    : neckY + 120;
  const waistY = bottomAnchor
    ? Math.max(420, Math.min(760, bottomAnchor.ymin + 25))
    : upperBodyAnchor
      ? Math.max(420, Math.min(740, upperBodyAnchor.ymax - 30))
      : 560;

  return {
    centerX,
    leftX,
    rightX,
    headY: Math.max(60, Math.min(210, topY + 60)),
    eyeY: Math.max(95, Math.min(235, topY + 115)),
    neckY,
    chestY,
    waistY,
  };
}

type PersonBbox = {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  w: number;
  h: number;
  headYmin: number;
  /** True when at least 2 garment boxes were available, so the union is a
   *  reasonable proxy for the person's silhouette. With only 1 item we don't
   *  trust the union and skip body-zone framing. */
  reliable: boolean;
};

/**
 * Best-effort person bbox from the union of all detected item boxes. We use
 * this as the canvas inside which body zones (head/neck/upper/lower/feet)
 * are computed. When the photo only has 1 detected item, we can't infer the
 * person silhouette so this returns `reliable=false`.
 */
function inferPersonBbox(items: any[]): PersonBbox | null {
  const usable = items
    .map((m: any) => {
      if (!Array.isArray(m?.box_2d) || m.box_2d.length !== 4) return null;
      const [ymin, xmin, ymax, xmax] = m.box_2d as number[];
      if (xmax <= xmin || ymax <= ymin) return null;
      return { ymin, xmin, ymax, xmax, meta: m };
    })
    .filter(Boolean) as {
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
    meta: any;
  }[];
  if (usable.length === 0) return null;

  // Prefer body anchors for the person silhouette so a stray hat/glasses box
  // doesn't pull the union to extreme y values when not actually placed there.
  const anchors = usable.filter(
    ({ meta }) =>
      isTopGarment(meta) ||
      isBottomsLike(meta) ||
      isFullBodyCategory(meta) ||
      classifyCategoryLower(meta) === "outerwear" ||
      isShoeMeta(meta),
  );
  const pool = anchors.length >= 2 ? anchors : usable;
  const ymin = Math.min(...pool.map((b) => b.ymin));
  const ymax = Math.max(...pool.map((b) => b.ymax));
  const xmin = Math.min(...pool.map((b) => b.xmin));
  const xmax = Math.max(...pool.map((b) => b.xmax));
  const upper = pool.find(
    ({ meta }) =>
      isTopGarment(meta) || classifyCategoryLower(meta) === "outerwear",
  );
  const shoe = pool.find(({ meta }) => isShoeMeta(meta));
  let height = ymax - ymin;
  const width = xmax - xmin;

  // Seated/Squatting pose detection: if the detected garments are very wide
  // relative to height, the person is likely sitting. Standard standing
  // height-to-width is ~2.8-3.2x. If we're below 1.8x, expand the person box
  // downward to prevent "squashed" body zones.
  if (height < width * 1.8) {
    height = Math.round(width * 2.2);
  }

  // Widen the X-axis: model boxes are often too tight on sleeves/legs.
  // Expand the silhouette width by 15% to ensure limbs aren't clipped.
  const wExpand = Math.round(width * 0.15);
  const wideXmin = Math.max(0, xmin - wExpand);
  const wideXmax = Math.min(1000, xmax + wExpand);

  // Garment union usually starts around collar/chest, not the top of head.
  // Extrapolate a person-head top from the upper garment when possible.
  const headYmin = upper
    ? Math.max(0, Math.round(upper.ymin - height * 0.15))
    : Math.max(0, Math.round(ymin - height * 0.1));
  const footYmax = shoe
    ? Math.min(1000, Math.round(shoe.ymax + height * 0.02))
    : Math.min(1000, headYmin + height);

  return {
    ymin: headYmin,
    xmin: wideXmin,
    ymax: footYmax,
    xmax: wideXmax,
    w: wideXmax - wideXmin,
    h: footYmax - headYmin,
    headYmin,
    reliable: pool.length >= 2,
  };
}

/**
 * Body-zone crop box for a given item. Returns a SQUARE band centered on the
 * person's centerline for every item of a given category. This matches the
 * visual style of top-tier fashion apps (consistent framing across photos).
 *
 * Returns null when no zone is appropriate.
 */
function bodyZoneCropBox(item: any, person: PersonBbox): number[] | null {
  if (!person.reliable) return null;
  const {
    ymin: pYmin,
    ymax: pYmax,
    h: pH,
    xmin: pXmin,
    xmax: pXmax,
    w: pW,
  } = person;
  const centerX = (pXmin + pXmax) / 2;

  /**
   * Returns a square box centered on the person's X-axis.
   * @param topPct - start of the band (0 = head top, 1 = feet)
   * @param bottomPct - end of the band
   * @param widthMult - multiplier for the square size (default 1.0 = band height)
   */
  const squareZone = (topPct: number, bottomPct: number, widthMult = 1.1) => {
    const ymin = Math.max(0, Math.round(pYmin + pH * topPct));
    const ymax = Math.min(1000, Math.round(pYmin + pH * bottomPct));
    const h = ymax - ymin;

    // Ensure the square width is at least the full person width to prevent clipping
    const minW = pW;
    const w = Math.max(minW, Math.round(h * widthMult));
    return [
      ymin,
      Math.max(0, Math.round(centerX - w / 2)),
      ymax,
      Math.min(1000, Math.round(centerX + w / 2)),
    ];
  };

  // ─── COMP-STYLE FIXED BANDS ───────────────────────────────────────────────
  // These percentages are tuned to match the competitor's visual language:
  // - Upper items (Tops/Jackets) include the head for context.
  // - Lower items (Pants) start at the waist and include the feet.
  // - Shoes focus on the shins-to-floor area.

  if (isFullBodyCategory(item)) return squareZone(0, 1.0, 0.8);
  if (isShoeMeta(item)) return squareZone(0.7, 1.0, 1.3);
  if (isBottomsLike(item)) {
    return isShortBottomLike(item)
      ? squareZone(0.4, 0.75, 1.2)
      : squareZone(0.4, 1.0, 0.9);
  }
  if (classifyCategoryLower(item) === "outerwear") {
    // Jackets: Head to mid-thigh
    return squareZone(0, 0.65, 0.95);
  }
  if (isTopGarment(item)) {
    // Tops: Head to waist
    return squareZone(0, 0.55, 1.05);
  }

  // Head accessories (Hats/Glasses) use a tighter head-focused square
  if (isHatAccessoryLike(item) || isHeadbandAccessoryLike(item)) {
    return squareZone(0, 0.28, 1.3);
  }
  if (isEyewearAccessoryLike(item)) {
    return squareZone(0.02, 0.26, 1.4);
  }
  if (isNeckJewelryLike(item)) {
    return squareZone(0.1, 0.4, 1.3);
  }
  if (isBeltAccessoryLike(item)) {
    return squareZone(0.38, 0.6, 1.5);
  }

  return null;
}

function candidateBoxesForAccessory(
  item: any,
  currentBox: number[],
  body: FitCheckBodyGeometry,
): CropCandidate[] {
  const current = clampBox2d(currentBox);
  const candidates: CropCandidate[] = [{ box: current, reason: "model" }];
  const currentMetrics = boxMetrics(current);
  const add = (box: number[], reason: string) => {
    const clamped = clampBox2d(box);
    if (
      !candidates.some((c) => JSON.stringify(c.box) === JSON.stringify(clamped))
    ) {
      candidates.push({ box: clamped, reason });
    }
  };

  if (isEyewearAccessoryLike(item)) {
    add(centeredBox2d(body.centerX, body.eyeY, 300, 130), "eye-zone");
  } else if (isNeckJewelryLike(item)) {
    add(centeredBox2d(body.centerX, body.neckY + 70, 300, 220), "neck-zone");
    add(centeredBox2d(body.centerX, body.chestY, 340, 240), "chest-zone");
  } else if (isWristAccessoryLike(item)) {
    // Wrists land anywhere from chest to upper-thigh depending on pose, so we
    // generate multiple y-bands and let scoring pick the one closest to the
    // model's vertical hint. Boxes are wider (220) so a tilted forearm still
    // fits inside the frame.
    const leftWristX = Math.max(60, body.leftX - 25);
    const rightWristX = Math.min(940, body.rightX + 25);
    const elbowY = Math.round((body.chestY + body.waistY) / 2);
    const hipY = Math.round(body.waistY + 30);
    const sideBias = currentMetrics.cx < body.centerX ? -1 : 1;
    const sideX = sideBias < 0 ? leftWristX : rightWristX;
    add(centeredBox2d(sideX, currentMetrics.cy, 220, 220), "wrist-near-model");
    add(centeredBox2d(sideX, elbowY, 220, 220), "wrist-side-elbow");
    add(centeredBox2d(sideX, hipY, 220, 220), "wrist-side-hip");
    add(centeredBox2d(leftWristX, elbowY, 220, 220), "wrist-left-elbow");
    add(centeredBox2d(rightWristX, elbowY, 220, 220), "wrist-right-elbow");
    add(centeredBox2d(leftWristX, hipY, 220, 220), "wrist-left-hip");
    add(centeredBox2d(rightWristX, hipY, 220, 220), "wrist-right-hip");
  } else if (isBeltAccessoryLike(item)) {
    add(centeredBox2d(body.centerX, body.waistY, 430, 150), "waist-zone");
  }

  return candidates;
}

function scoreCropCandidate(
  item: any,
  candidate: CropCandidate,
  body: FitCheckBodyGeometry,
  originalBox: number[],
): number {
  const b = boxMetrics(candidate.box);
  const original = boxMetrics(originalBox);
  let score = candidate.reason === "model" ? 4 : 0;
  const aspect = b.w / Math.max(1, b.h);

  if (isEyewearAccessoryLike(item)) {
    score += 40 - Math.abs(b.cy - body.eyeY) * 0.45;
    score += 22 - Math.abs(b.cx - body.centerX) * 0.08;
    if (aspect >= 1.4 && aspect <= 3.6) score += 12;
    if (b.cy > body.neckY) score -= 35;
  } else if (isNeckJewelryLike(item)) {
    score += 35 - Math.abs(b.cy - (body.neckY + 70)) * 0.14;
    score += 18 - Math.abs(b.cx - body.centerX) * 0.06;
    if (b.h >= 120 && b.h <= 280 && b.w <= 380) score += 10;
  } else if (isWristAccessoryLike(item)) {
    // Watches must sit on a wrist (left or right side of body), not on the
    // torso. Heavily reward boxes near the body's left/right edge and any y
    // between chest and hip; heavily penalize torso-centered boxes.
    const leftEdgeX = Math.max(60, body.leftX - 25);
    const rightEdgeX = Math.min(940, body.rightX + 25);
    const nearestWristDist = Math.min(
      Math.abs(b.cx - leftEdgeX),
      Math.abs(b.cx - rightEdgeX),
    );
    score += 42 - nearestWristDist * 0.16;
    const inWristYBand = b.cy >= body.chestY - 20 && b.cy <= body.waistY + 80;
    score += inWristYBand ? 18 : -22;
    if (b.w >= 140 && b.w <= 260 && b.h >= 140 && b.h <= 260) score += 14;
    // Reward staying close to the model's vertical hint when it isn't crazy.
    if (Math.abs(b.cy - original.cy) < 110) score += 8;
    // Hard penalty on torso-centered boxes — the model often boxes the watch
    // on the chest/jacket panel.
    if (Math.abs(b.cx - body.centerX) < 110) score -= 26;
    // Small extra penalty when the model's own box is what we're scoring
    // and it sits on the torso, so a sane wrist candidate beats it.
    if (candidate.reason === "model" && Math.abs(b.cx - body.centerX) < 130) {
      score -= 18;
    }
  } else if (isBeltAccessoryLike(item)) {
    score += 34 - Math.abs(b.cy - body.waistY) * 0.12;
    score += 12 - Math.abs(b.cx - body.centerX) * 0.04;
    if (aspect >= 2.0 && aspect <= 5.2) score += 10;
  }

  if (b.area < 7000) score -= 8;
  if (b.area > 140000) score -= 12;
  if (b.ymin <= 0 || b.xmin <= 0 || b.ymax >= 1000 || b.xmax >= 1000) {
    score -= 3;
  }
  return score;
}

function selectBestCropBox(
  item: any,
  currentBox: number[],
  body: FitCheckBodyGeometry,
): { box: number[]; reason: string; score: number } {
  if (!isTinyWornAccessoryLike(item)) {
    return { box: currentBox, reason: "not-tiny-accessory", score: 0 };
  }
  const candidates = candidateBoxesForAccessory(item, currentBox, body);
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCropCandidate(item, candidate, body, currentBox),
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0] ?? { box: currentBox, reason: "fallback", score: 0 };
  if (__DEV__ && best.reason !== "model") {
    console.log("[crop-select]", {
      item: fashionText(item),
      reason: best.reason,
      score: Math.round(best.score),
      original: currentBox,
      selected: best.box,
    });
  }
  return best;
}

/**
 * If a per-item native crop came back as a JPEG (Vision didn't find a
 * foreground for that patch and fell back to the raw color crop), re-run
 * on-device segmentation on it to recover the transparent PNG cutout. We pick
 * the largest segmented instance to avoid stray reflections/shadows.
 */
async function rescueBackgroundIfMissing(dataUri: string): Promise<string> {
  if (!dataUri || !dataUri.startsWith("data:image/jpeg")) return dataUri;
  try {
    const plain = dataUri.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    if (!plain) return dataUri;
    const segments = await segmentItems(plain);
    if (!segments || segments.length === 0) return dataUri;
    // Pick the largest non-empty segment as the rescue. Without dimensions
    // available here, segments[0] is fine — the native module already returns
    // them sorted by foreground area.
    const best = segments[0];
    return best && best.startsWith("data:image/") ? best : dataUri;
  } catch (e) {
    if (__DEV__) console.warn("[rescueBackgroundIfMissing]", e);
    return dataUri;
  }
}

/**
 * Resize an image (URI or data URI) before sending to the vision model.
 * Returns a plain base64 string (no data: prefix).
 *
 * Width: 768 (default) for classify-only calls — ~40% smaller payload than
 * 1024 with no measurable label-accuracy loss. Pass 1024 for multi-item
 * box detection: box_2d precision degrades visibly at 768 (mis-aimed crops
 * on skirts/bags in fit-check photos), and those calls are per-photo rather
 * than per-item so the payload cost is paid once.
 */
async function resizeForVision(
  sourceUri: string,
  width: number = 768,
): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      sourceUri,
      [{ resize: { width } }],
      {
        compress: 0.75,
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
  options?: { removeBackground?: boolean },
): Promise<any[]> {
  const removeBackground = options?.removeBackground ?? false;
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
        let sourceUri = result.base64
          ? `data:image/jpeg;base64,${result.base64}`
          : originalUri;
        // Optional: run Vision on the cropped JPEG to pull the person off the
        // background so tiny accessories (glasses, watches, chains) match the
        // rest of the review thumbs visually.
        if (removeBackground && result.base64) {
          try {
            const segments = await segmentItems(result.base64);
            if (segments && segments.length > 0 && segments[0]) {
              sourceUri = segments[0];
            }
          } catch {
            /* keep JPEG */
          }
        }
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
  const bodyGeometry =
    effectiveLayout === "fit_check"
      ? inferFitCheckBodyGeometry(filtered)
      : null;
  const prepared = filtered.map((m: any) => {
    let activeBox = m.box_2d;
    if (!Array.isArray(activeBox) || activeBox.length !== 4) return m;

    if (effectiveLayout === "fit_check" && bodyGeometry) {
      // Keep Gemini's item box for garments/shoes/hats. Only tiny worn
      // accessories get a body-aware candidate picker; broad body-zone overrides
      // make every category crop like a generic body region instead of the item.
      activeBox = selectBestCropBox(m, activeBox as number[], bodyGeometry).box;
    }

    const minSpan =
      effectiveLayout === "fit_check"
        ? isShoeMeta(m)
          ? MIN_BOX_2D_SPAN_SHOE_FITCHECK
          : isHeadbandAccessoryLike(m) || isEyewearAccessoryLike(m)
            ? MIN_BOX_2D_SPAN_HEAD_ACCESSORY_FITCHECK
            : isNeckJewelryLike(m)
              ? MIN_BOX_2D_SPAN_NECKLACE_FITCHECK
              : isTinyAccessoryLike(m)
                ? MIN_BOX_2D_SPAN_ACCESSORY_FITCHECK
                : isFullBodyCategory(m)
                  ? MIN_BOX_2D_SPAN_FULL_BODY_FITCHECK
                  : isBottomsLike(m)
                    ? MIN_BOX_2D_SPAN_BOTTOMS_FITCHECK
                    : isTopGarment(m)
                      ? MIN_BOX_2D_SPAN_TOP_FITCHECK
                      : MIN_BOX_2D_SPAN
        : isHeadbandAccessoryLike(m) || isEyewearAccessoryLike(m)
          ? MIN_BOX_2D_SPAN_HEAD_ACCESSORY_FITCHECK
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

    const tightBox = expandDegenerateBox2d(activeBox as number[], minSpan);
    let box = tightBox;

    if (isFullBodyCategory(m)) {
      box = expandBoxForFullBodyGarmentCrop(box, effectiveLayout);
    } else if (isTopGarment(m)) {
      box = expandBoxForTopGarmentCrop(box, effectiveLayout);
    } else if (isBottomsLike(m)) {
      box = expandBoxForBottomsGarmentCrop(box, effectiveLayout, m);
    } else if (isShoeMeta(m)) {
      box = expandBoxForFootwearCrop(box, effectiveLayout, m);
    } else {
      box = expandBoxForAccessoryCrop(box, effectiveLayout, m);
    }

    if (
      effectiveLayout === "fit_check" &&
      (isTopGarment(m) ||
        isBottomsLike(m) ||
        isFullBodyCategory(m) ||
        isShoeMeta(m))
    ) {
      box = rebalanceCropSides(box, tightBox, isShoeMeta(m) ? 0.05 : 0.035);
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
    const directCropItems = prepared.filter((m: any) =>
      isTinyWornAccessoryLike(m),
    );
    const visionItems = prepared.filter(
      (m: any) => !isTinyWornAccessoryLike(m),
    );
    const boxes: number[][] = visionItems
      .map((m: any) => m.box_2d)
      .filter(Array.isArray);
    const directCrops =
      directCropItems.length > 0
        ? await jsFitCheckCrop(originalUri, directCropItems, {
            removeBackground: true,
          })
        : [];
    if (boxes.length > 0) {
      const origB64 = await imageUriToPlainBase64(originalUri);
      if (origB64) {
        const freshCrops = await cropGarmentsFromOriginal(origB64, boxes);
        if (freshCrops.length === boxes.length) {
          // Background rescue: any native crop that came back as JPEG had
          // segmentation skipped (Vision didn't find a foreground for that
          // patch). Re-run segmentItems on those crops to recover the cutout.
          const rescued = await Promise.all(
            freshCrops.map(async (uri) => rescueBackgroundIfMissing(uri)),
          );
          let visionIndex = 0;
          let directIndex = 0;
          return mergePairShoeMetasInBatch(
            prepared.map((m: any) => {
              if (isTinyWornAccessoryLike(m)) {
                return directCrops[directIndex++] ?? m;
              }
              return {
                ...m,
                sourceUri:
                  m.box_2d && Array.isArray(m.box_2d)
                    ? rescued[visionIndex++]
                    : originalUri,
                originalSourceUri: originalUri,
                isIsolated: true,
              };
            }),
          );
        }
      }
    } else if (directCrops.length > 0) {
      return directCrops;
    }
    // Fallback: plain tight crop (no background removal) if native Vision fails.
    return mergePairShoeMetasInBatch(
      await jsFitCheckCrop(originalUri, prepared),
    );
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
      : isHeadbandAccessoryLike(m) || isEyewearAccessoryLike(m)
        ? MIN_BOX_2D_SPAN_HEAD_ACCESSORY_FITCHECK
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
        box = expandBoxForBottomsGarmentCrop(box, layoutMode, m);
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
 * Multiple Vision segments can still be one worn outfit/person (Vision splits
 * jacket/hands/shoes into blobs). If we send those blobs down `per_segment`,
 * each crop gets classified in isolation and the full outfit collapses to one
 * item (e.g. only blazer). For portrait/OOTD photos, prefer full-frame
 * fit-check classification whenever at least one segment looks person-sized.
 */
async function shouldTreatMultiSegmentsAsFitCheck(
  originalUri: string,
  segments: string[],
): Promise<boolean> {
  const orig = await getImagePixelSize(originalUri);
  if (!orig) return false;
  const origA = orig.w * orig.h;
  const origAR = orig.w > 0 ? orig.h / orig.w : 1;
  if (origA <= 0 || origAR < 1.08) return false;

  const sizes = (
    await Promise.all(segments.slice(0, 4).map((seg) => getImagePixelSize(seg)))
  ).filter((s): s is { w: number; h: number } => !!s);
  if (sizes.length === 0) return false;

  const totalAreaFrac =
    sizes.reduce((sum, s) => sum + s.w * s.h, 0) / Math.max(1, origA);
  const largest = sizes.reduce((best, s) =>
    s.w * s.h > best.w * best.h ? s : best,
  );
  const largestAreaFrac = (largest.w * largest.h) / origA;
  const largestAR = largest.w > 0 ? largest.h / largest.w : 1;

  // Portrait source + enough foreground coverage = person/OOTD. This avoids
  // isolated crop classification stealing the whole upload.
  if (origAR >= 1.15 && totalAreaFrac >= 0.18) return true;
  if (largestAreaFrac >= 0.14 && largestAR >= 1.0) return true;
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
  if (segments.length >= 2) {
    return (await shouldTreatMultiSegmentsAsFitCheck(originalUri, segments))
      ? "fit_check_boxes"
      : "per_segment";
  }
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
  // 1024: box_2d precision matters more than payload here (one call per photo).
  const classifyB64 = (await resizeForVision(uri, 1024)) || base64Fallback;
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
    await cropItemsForFitCheck(
      uri,
      maskedSegmentUri,
      mergedShoeBoxes,
      photoLayout,
    ),
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

type AiMetaUpdater = (
  fn: (prev: Record<string, unknown>[]) => Record<string, unknown>[],
) => void;

function reviewItemRowKey(
  item: Record<string, unknown>,
  idx: number,
  fallbackImage?: string | null,
): string {
  if (typeof item._rowId === "string") return item._rowId;
  if (typeof item._scanKey === "string") return item._scanKey;
  return `${item.originalSourceUri ?? item.sourceUri ?? fallbackImage ?? "row"}-${idx}`;
}

/** Multi-detect only — returns Gemini metadata + box_2d, no crops yet. */
async function detectBoxMetasFromPhoto(
  uri: string,
  base64Fallback: string,
  photoLayout: "flat_lay" | "fit_check",
): Promise<any[]> {
  // 1024: box_2d precision matters more than payload here (one call per photo).
  const classifyB64 = (await resizeForVision(uri, 1024)) || base64Fallback;
  const result = await apiClient.classify(
    classifyB64,
    "auto",
    "multi",
    photoLayout,
  );
  const items = (
    Array.isArray(result.metadata) ? result.metadata : [result.metadata]
  ).filter(Boolean);
  return mergeShoePairBoxesBeforeCrop(items);
}

/** All rows appear together on the full photo; classify in parallel, then swap to cutouts. */
async function runPerSegmentClassifyProgressive(
  photoUri: string,
  segments: string[],
  updateList: AiMetaUpdater,
): Promise<number> {
  let added = 0;
  const scanKeys = segments.map(
    (_, i) => `${photoUri}::seg::${i}::${Date.now()}`,
  );

  updateList((prev) => [
    ...prev,
    ...segments.map((seg, i) => ({
      _rowId: scanKeys[i],
      _scanKey: scanKeys[i],
      _segmentUri: seg,
      sourceUri: photoUri,
      originalSourceUri: photoUri,
      isIsolated: false,
      _classifying: true,
      name: "",
    })),
  ]);

  await Promise.all(
    segments.map(async (seg, si) => {
      const scanKey = scanKeys[si]!;
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
          updateList((prev) => {
            const idx = prev.findIndex(
              (p) => p._rowId === scanKey || p._scanKey === scanKey,
            );
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = {
              ...meta,
              _rowId: scanKey,
              sourceUri: seg,
              isIsolated: true,
              originalSourceUri: photoUri,
            };
            return next;
          });
          added++;
        } else {
          updateList((prev) =>
            prev.filter((p) => p._rowId !== scanKey && p._scanKey !== scanKey),
          );
        }
      } catch (e) {
        updateList((prev) =>
          prev.filter((p) => p._rowId !== scanKey && p._scanKey !== scanKey),
        );
        console.warn("[upload] classify failed for segment", si, e);
      }
    }),
  );

  updateList((prev) => mergeShoeIsolatesForSegmentBatch(prev, segments));
  return added;
}

/** Detect boxes, show every row at once on the full photo, then crop in parallel. */
async function runBoxStrategyProgressive(
  uri: string,
  b64: string,
  segments: string[],
  photoLayout: "flat_lay" | "fit_check",
  updateList: AiMetaUpdater,
): Promise<number> {
  const maskedSegmentUri =
    photoLayout === "fit_check" && segments.length === 1 ? segments[0]! : null;
  const metas = dedupeOverlappingBoxMetas(
    await detectBoxMetasFromPhoto(uri, b64, photoLayout),
  );

  if (metas.length === 0 && segments.length === 1 && segments[0]) {
    const scanKey = `${uri}::fb::${Date.now()}`;
    updateList((prev) => [
      ...prev,
      {
        _rowId: scanKey,
        _scanKey: scanKey,
        sourceUri: uri,
        originalSourceUri: uri,
        isIsolated: false,
        _classifying: true,
        name: "",
      },
    ]);
    const fb = await fallbackClassifySingleCutout(segments[0], uri);
    if (fb) {
      updateList((prev) => {
        const idx = prev.findIndex(
          (p) => p._rowId === scanKey || p._scanKey === scanKey,
        );
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...fb, _rowId: scanKey, originalSourceUri: uri };
        return next;
      });
      return 1;
    }
    updateList((prev) =>
      prev.filter((p) => p._rowId !== scanKey && p._scanKey !== scanKey),
    );
    return 0;
  }

  const scanKeys = metas.map(
    (_, i) => `${uri}::box::${i}::${Date.now()}`,
  );

  updateList((prev) => [
    ...prev,
    ...metas.map((meta, i) => ({
      _rowId: scanKeys[i],
      _scanKey: scanKeys[i],
      sourceUri: uri,
      originalSourceUri: uri,
      isIsolated: false,
      box_2d: meta.box_2d,
      _classifying: true,
      name: "",
    })),
  ]);

  let added = 0;
  await Promise.all(
    metas.map(async (meta, i) => {
      const scanKey = scanKeys[i]!;
      try {
        const cropped = mergePairShoeMetasInBatch(
          await cropItemsForFitCheck(
            uri,
            maskedSegmentUri,
            [meta],
            photoLayout,
          ),
        );
        const item = cropped[0];
        if (!item) {
          updateList((prev) =>
            prev.filter((p) => p._rowId !== scanKey && p._scanKey !== scanKey),
          );
          return;
        }
        updateList((prev) => {
          const idx = prev.findIndex(
            (p) => p._rowId === scanKey || p._scanKey === scanKey,
          );
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...item,
            _rowId: scanKey,
            originalSourceUri: uri,
          };
          return next;
        });
        added++;
      } catch (e) {
        updateList((prev) =>
          prev.filter((p) => p._rowId !== scanKey && p._scanKey !== scanKey),
        );
        console.warn("[upload] box crop failed", i, e);
      }
    }),
  );
  return added;
}

/** Progressive garment detect + classify (shared by log-outfit and library
 * fit extract). Returns how many items were detected so callers can handle
 * the "found nothing" case instead of stalling on an empty review. */
export async function runProgressiveImageExtract(
  base64: string,
  uri: string,
  updateList: AiMetaUpdater,
): Promise<number> {
  const segments = await segmentItems(base64);
  const strategy = await decideUploadSegmentStrategy(segments, uri);

  if (strategy === "per_segment") {
    updateList(() => []);
    return await runPerSegmentClassifyProgressive(uri, segments, updateList);
  } else if (strategy === "flat_lay_boxes") {
    updateList(() => []);
    return await runBoxStrategyProgressive(
      uri,
      base64,
      segments,
      "flat_lay",
      updateList,
    );
  } else {
    updateList(() => []);
    return await runBoxStrategyProgressive(
      uri,
      base64,
      segments,
      "fit_check",
      updateList,
    );
  }
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

const ArcFlashIcon = ({ mode, color }: { mode: FlashMode; color: string }) => (
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

export async function uriToBase64(uri: string): Promise<string> {
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
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isLogOutfitRoute =
    pathname === "/log-outfit" || pathname.endsWith("/log-outfit");
  const isFitExtractRoute =
    pathname === "/fit-extract" || pathname.endsWith("/fit-extract");
  const params = useLocalSearchParams<{
    library?: string | string[];
    categoryHint?: string | string[];
    mode?: string | string[];
    wornOnIso?: string | string[];
    plannedDateIso?: string | string[];
    outfitId?: string | string[];
    outfitImageUrl?: string | string[];
    restoreUpload?: string | string[];
    restoreOutfit?: string | string[];
  }>();
  const { user } = useUser();
  const isOutfitMode = useMemo(() => {
    const m = params.mode;
    const v = Array.isArray(m) ? m[0] : m;
    return v === "outfit" || isLogOutfitRoute;
  }, [params.mode, isLogOutfitRoute]);
  const extractOutfitId = useMemo(() => {
    const raw = params.outfitId;
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }, [params.outfitId]);
  const isExtractForOutfitMode = useMemo(() => {
    const m = params.mode;
    const v = Array.isArray(m) ? m[0] : m;
    return (
      (v === "extract" && !!extractOutfitId) ||
      (isFitExtractRoute && !!extractOutfitId)
    );
  }, [params.mode, extractOutfitId, isFitExtractRoute]);
  const outfitImageUrlParam = useMemo(() => {
    const raw = params.outfitImageUrl;
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== "string" || v.length < 8) return null;
    const trimmed = v.trim();
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }, [params.outfitImageUrl]);
  const [uploadSource, setUploadSource] = useState<"camera" | "library">(() =>
    consumeLibraryIntent() || isLibraryMenuIntent(params.library)
      ? "library"
      : "camera",
  );
  const [permission, requestPermission] = useCameraPermissions();
  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState<
    | "scanning"
    | "analyzing"
    | "review"
    | "done"
    | "outfit_review"
    | "outfit_processing"
    | "outfit_isolating"
  >("scanning");
  const [uploading, setUploading] = useState(false);
  const [libraryAutoPickPending, setLibraryAutoPickPending] = useState(() =>
    isLibraryMenuIntent(params.library),
  );
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    category: "",
    color: "",
    occasions: [] as string[],
    seasons: [] as string[],
  });
  /** Manual crop modal target — index into aiMetaList. */
  const [manualCropIndex, setManualCropIndex] = useState<number | null>(null);

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
  /** When set, configure modal edits `extractItems` on this draft (mirrored via aiMetaList). */
  const [outfitExtractEditDraftId, setOutfitExtractEditDraftId] = useState<
    string | null
  >(null);
  /** Full scan-in review sheet over outfit review (same UI as item upload). */
  const [outfitExtractReviewDraftId, setOutfitExtractReviewDraftId] = useState<
    string | null
  >(null);
  const outfitExtractEditSnapshotRef = useRef<
    Record<string, unknown>[] | null
  >(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [addMoreSheetOpen, setAddMoreSheetOpen] = useState(false);

  /** Full-body outfit photo — no per-item segmentation */
  const [outfitName, setOutfitName] = useState("");
  const [outfitSchedule, setOutfitSchedule] = useState<
    "none" | "today" | "pick"
  >("none");
  const [outfitPickIso, setOutfitPickIso] = useState<string | null>(null);

  const paramWearIso = useMemo(() => {
    const raw = params.wornOnIso ?? params.plannedDateIso;
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
      ? v.trim()
      : null;
  }, [params.wornOnIso, params.plannedDateIso]);

  useEffect(() => {
    if (!isOutfitMode || !paramWearIso) return;
    setOutfitSchedule("pick");
    setOutfitPickIso(paramWearIso);
  }, [isOutfitMode, paramWearIso]);
  const [savingOutfitPhoto, setSavingOutfitPhoto] = useState(false);
  /** After outfit-only save, link extracted items to this outfit on closet save. */
  const [pendingLinkOutfitId, setPendingLinkOutfitId] = useState<string | null>(
    null,
  );
  const outfitOriginalUriRef = useRef<string | null>(null);
  const extractBootstrappedRef = useRef(false);
  const activeLinkOutfitId = extractOutfitId ?? pendingLinkOutfitId;
  const [outfitDrafts, setOutfitDrafts] = useState<OutfitUploadDraft[]>([]);
  const outfitDraftsRef = useRef<OutfitUploadDraft[]>([]);
  const handleOutfitLeaveRef = useRef<() => void>(() => {});
  /** Remaining JPEG URIs after the current outfit review (legacy sequential batch). */
  const [outfitReviewQueue, setOutfitReviewQueue] = useState<string[]>([]);
  const outfitReviewQueueRef = useRef<string[]>([]);
  /** Set when the user started a multi-photo outfit batch (camera or library). */
  const [outfitReviewBatch, setOutfitReviewBatch] = useState<{
    index: number;
    total: number;
  } | null>(null);
  const outfitReviewBatchRef = useRef<{
    index: number;
    total: number;
  } | null>(null);
  useEffect(() => {
    outfitReviewBatchRef.current = outfitReviewBatch;
  }, [outfitReviewBatch]);

  const replaceOutfitReviewQueue = useCallback((uris: string[]) => {
    outfitReviewQueueRef.current = uris;
    setOutfitReviewQueue(uris);
  }, []);

  const syncOutfitDrafts = useCallback((next: OutfitUploadDraft[]) => {
    outfitDraftsRef.current = next;
    setOutfitDrafts(next);
  }, []);

  const defaultDraftSchedule = useCallback((): Pick<
    OutfitUploadDraft,
    "schedule" | "pickIso"
  > => {
    if (paramWearIso) return { schedule: "pick", pickIso: paramWearIso };
    return { schedule: "none", pickIso: null };
  }, [paramWearIso]);

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

  const recoverySessionRef = useRef<UploadRecoverySession | null>(null);
  const uploadRestoreHandledRef = useRef(false);
  const persistReviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const restoreUploadParam = useMemo(() => {
    const raw = params.restoreUpload;
    const v = Array.isArray(raw) ? raw[0] : raw;
    return v === "1" || v === "true";
  }, [params.restoreUpload]);
  const restoreOutfitParam = useMemo(() => {
    const raw = params.restoreOutfit;
    const v = Array.isArray(raw) ? raw[0] : raw;
    return v === "1" || v === "true";
  }, [params.restoreOutfit]);
  const uploadUserId = effectiveUploadUserId(user?.id);
  const outfitRecoverySessionRef = useRef<OutfitUploadRecoverySession | null>(
    null,
  );
  const outfitPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const persistOutfitDraftsToSession = useCallback(
    async (
      drafts: OutfitUploadDraft[],
      phase: "processing" | "isolating" | "review" = "review",
    ) => {
      const session = await persistOutfitUploadSession({
        userId: uploadUserId,
        phase,
        uploadSource,
        pendingUris: [],
        drafts: drafts.map((d) => ({
          id: d.id,
          heroUri: d.heroUri,
          originalUri: d.originalUri,
          name: d.name,
          schedule: d.schedule,
          pickIso: d.pickIso,
        })),
        existingSession: outfitRecoverySessionRef.current,
      });
      if (session) outfitRecoverySessionRef.current = session;
    },
    [uploadSource, uploadUserId],
  );

  const isMountedRef = useRef(true);
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  const cameraRef = useRef<CameraView>(null);
  const cameraZoomRef = useRef(0);
  const pinchBaseZoomRef = useRef(0);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<FlashMode>("off");
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
  const reviewScrollRef = useRef<ScrollView>(null);
  /** Pin review list to bottom while + Add scan is in progress. */
  const pinReviewScrollToAppendRef = useRef(false);

  const scrollReviewToEnd = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      reviewScrollRef.current?.scrollToEnd({ animated });
    });
  }, []);

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
  const classifyingCount = useMemo(
    () => aiMetaList.filter((i) => isItemClassifying(i)).length,
    [aiMetaList],
  );
  const reviewEnhancing = aiMetaList.some((i) => i._enhancing);
  const reviewItemsStillLoading = aiMetaList.some((i) => isItemClassifying(i));
  const reviewScanActive = !!(batchAnalyze || reviewItemsStillLoading);
  /** One ghost row while we wait for detection — never alongside real placeholders. */
  const showScanGapSkeleton = reviewScanActive && classifyingCount === 0;
  const reviewHeaderTitle = useMemo(() => {
    const n = aiMetaList.length;
    return n > 0 ? `Review items (${n})` : "Review items";
  }, [aiMetaList.length]);
  const reviewScanSubtitle = useMemo(() => {
    if (!reviewScanActive) {
      return "Check the details before these hit your closet.";
    }
    const n = aiMetaList.length;
    if (n === 0) {
      if (batchAnalyze && batchAnalyze.total > 1) {
        const photo = Math.min(batchAnalyze.current + 1, batchAnalyze.total);
        return `Scanning photo ${photo} of ${batchAnalyze.total}…`;
      }
      return "Finding pieces in your photo…";
    }
    if (classifyingCount > 0) {
      if (
        batchAnalyze &&
        batchAnalyze.total > 1 &&
        batchAnalyze.current < batchAnalyze.total
      ) {
        return `${n} found · scanning more photos…`;
      }
      return n === 1
        ? "Identifying this piece…"
        : `Identifying ${classifyingCount} pieces…`;
    }
    if (batchAnalyze && batchAnalyze.current < batchAnalyze.total) {
      return `${n} found · photo ${batchAnalyze.current + 1} of ${batchAnalyze.total}…`;
    }
    return "";
  }, [reviewScanActive, aiMetaList, batchAnalyze, classifyingCount]);
  const showReviewAppendLoading =
    !!batchAnalyze &&
    batchAnalyze.total > 1 &&
    reviewScanActive &&
    batchAnalyze.current < batchAnalyze.total;
  const reviewSaveBlocked =
    !aiMetaList.length ||
    uploading ||
    reviewItemsStillLoading ||
    reviewEnhancing ||
    !!batchAnalyze;

  useEffect(() => {
    if (!pinReviewScrollToAppendRef.current) return;
    if (status !== "review" && status !== "analyzing") return;
    scrollReviewToEnd(true);
  }, [
    aiMetaList.length,
    batchAnalyze,
    reviewScanActive,
    showScanGapSkeleton,
    classifyingCount,
    status,
    scrollReviewToEnd,
  ]);

  useEffect(() => {
    if (!pinReviewScrollToAppendRef.current) return;
    if (status === "review" && !reviewScanActive) {
      pinReviewScrollToAppendRef.current = false;
      scrollReviewToEnd(true);
    }
  }, [reviewScanActive, status, scrollReviewToEnd]);

  const prepareOutfitDraftBatch = useCallback(
    async (uris: string[], opts?: { append?: boolean }) => {
      if (uris.length === 0) return;
      setStatus("outfit_processing");
      setBatchAnalyze({ current: 0, total: uris.length });
      const base = opts?.append ? [...outfitDraftsRef.current] : [];
      const schedDefaults = defaultDraftSchedule();
      try {
        for (let i = 0; i < uris.length; i++) {
          setBatchAnalyze({ current: i + 1, total: uris.length });
          const { heroUri, originalUri } = await buildOutfitHeroFromUri(
            uris[i]!,
          );
          if (!isMountedRef.current) return;
          base.push({
            id: newOutfitDraftId(),
            heroUri,
            originalUri,
            name: "",
            ...schedDefaults,
          });
        }
        syncOutfitDrafts(base);
        setBatchAnalyze(null);
        setCapturedPhotos([]);
        replaceOutfitReviewQueue([]);
        setOutfitReviewBatch(null);
        setStatus("outfit_review");
        await persistOutfitDraftsToSession(base, "review");
      } catch (e) {
        setBatchAnalyze(null);
        Alert.alert("Could not prepare looks", formatUnknownError(e));
        if (base.length > 0) {
          syncOutfitDrafts(base);
          setStatus("outfit_review");
          await persistOutfitDraftsToSession(base, "review");
        } else {
          setStatus("scanning");
        }
      }
    },
    [
      defaultDraftSchedule,
      persistOutfitDraftsToSession,
      replaceOutfitReviewQueue,
      syncOutfitDrafts,
    ],
  );

  const datePickOptions = useMemo(() => {
    const out: { iso: string; label: string }[] = [];
    const start = new Date();
    start.setDate(start.getDate() - 21);
    start.setHours(12, 0, 0, 0);
    for (let i = 0; i < 100; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = d.toISOString().split("T")[0]!;
      out.push({
        iso,
        label: d.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      });
    }
    return out;
  }, []);

  const processImageInto = async (
    base64: string,
    uri: string,
    updateList: AiMetaUpdater,
  ): Promise<number> => {
    setBatchAnalyze({ current: 0, total: 1 });
    try {
      return await runProgressiveImageExtract(base64, uri, updateList);
    } catch (err) {
      console.error(err);
      updateList(() => []);
      throw err;
    } finally {
      setBatchAnalyze(null);
    }
  };

  const processImage = async (base64: string, uri: string): Promise<number> => {
    setImage(uri);
    setStatus("review");
    try {
      return await processImageInto(base64, uri, setAiMetaList);
    } catch (err) {
      setAiMetaList([]);
      // In extract-for-outfit mode the full-screen bootstrap owns terminal
      // handling (message + navigate back). Rethrow so it can react instead
      // of leaving the "Extracting pieces…" spinner stuck on screen forever.
      if (isExtractForOutfitMode) throw err;
      setStatus("scanning");
      Alert.alert("AI extraction failed", formatUnknownError(err));
      return 0;
    }
  };

  /** Selected photos processed in order; batch progress updates after each photo finishes */
  const analyzeAllLibraryPhotos = async (jpegUris: string[]) => {
    if (jpegUris.length === 0) return;
    if (isOutfitMode && !appendToReviewRef.current && jpegUris[0]) {
      try {
        await prepareOutfitDraftBatch(jpegUris);
      } catch (e) {
        Alert.alert("Could not use photo", formatUnknownError(e));
        setStatus("scanning");
      }
      return;
    }
    setUploadSource("library");
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    if (!appendToReviewRef.current) {
      setAiMetaList([]);
      setImage(jpegUris[0]);
      setStatus("review");
    }

    let reviewShown = false;
    let totalAdded = 0;

    try {
      for (let i = 0; i < jpegUris.length; i++) {
        const uri = jpegUris[i];
        try {
          const b64 = await uriToBase64(uri);

          // Step 1: segment on-device (~300-600ms)
          const segments = await segmentItems(b64);
          const strategy = await decideUploadSegmentStrategy(segments, uri);

          if (strategy === "per_segment") {
            if (!reviewShown && !appendToReviewRef.current) {
              reviewShown = true;
              setImage(uri);
            }
            setStatus("review");
            totalAdded += await runPerSegmentClassifyProgressive(
              uri,
              segments,
              setAiMetaList,
            );
          } else if (strategy === "flat_lay_boxes") {
            if (!reviewShown && !appendToReviewRef.current) {
              reviewShown = true;
              setImage(uri);
            }
            setStatus("review");
            totalAdded += await runBoxStrategyProgressive(
              uri,
              b64,
              segments,
              "flat_lay",
              setAiMetaList,
            );
          } else {
            if (!reviewShown && !appendToReviewRef.current) {
              reviewShown = true;
              setImage(uri);
            }
            setStatus("review");
            totalAdded += await runBoxStrategyProgressive(
              uri,
              b64,
              segments,
              "fit_check",
              setAiMetaList,
            );
          }
        } catch (e) {
          console.warn("[upload] failed for photo", i + 1, e);
        }
        setBatchAnalyze({ current: i + 1, total: jpegUris.length });
      }

      if (totalAdded === 0 && !appendToReviewRef.current) {
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
    if (isOutfitMode && !appendToReviewRef.current) {
      appendToReviewRef.current = false;
      const toProcess = [...capturedPhotos];
      const rawUris = toProcess.map((p) => p.uri);
      setCapturedPhotos([]);
      try {
        const processingSession = await persistOutfitUploadSession({
          userId: uploadUserId,
          phase: "processing",
          uploadSource: "camera",
          pendingUris: rawUris,
          existingSession: outfitRecoverySessionRef.current,
        });
        if (processingSession) {
          outfitRecoverySessionRef.current = processingSession;
        }
        const jpegs = await Promise.all(
          toProcess.map((p) => ensureJpegUri(p.uri)),
        );
        if (jpegs.length === 0) {
          setStatus("scanning");
          return;
        }
        await prepareOutfitDraftBatch(jpegs);
      } catch (e) {
        console.warn(e);
        Alert.alert("Could not use photo", formatUnknownError(e));
        setStatus("scanning");
      }
      return;
    }
    if (!appendToReviewRef.current) {
      setAiMetaList([]);
      setImage(capturedPhotos[0].uri);
    }
    const toProcess = [...capturedPhotos];
    const rawUris = toProcess.map((p) => p.uri);
    const existingItemsSnapshot = appendToReviewRef.current
      ? [...aiMetaList]
      : [];
    setCapturedPhotos([]);
    setStatus("review");
    setBatchAnalyze({ current: 0, total: toProcess.length });
    if (appendToReviewRef.current) {
      pinReviewScrollToAppendRef.current = true;
      scrollReviewToEnd(false);
    }

    const queuedSession = await persistUploadReviewSession({
      userId: uploadUserId,
      aiMetaList: existingItemsSnapshot,
      imageUri: rawUris[0] ?? image,
      pendingPhotoUris: rawUris,
      uploadSource: "camera",
      sessionStatus: "queued",
      linkOutfitId: activeLinkOutfitId,
      existingSession: recoverySessionRef.current,
    });
    if (queuedSession) recoverySessionRef.current = queuedSession;

    let addedCount = 0;

    try {
      for (let i = 0; i < toProcess.length; i++) {
        const photo = toProcess[i];
        try {
          // Always re-segment from full capture so multi-item flat lays are not reduced to the first instance.
          const segments = await segmentItems(photo.base64);
          const strategy = await decideUploadSegmentStrategy(
            segments,
            photo.uri,
          );

          if (strategy === "per_segment") {
            if (addedCount === 0 && !appendToReviewRef.current) {
              setImage(photo.uri);
            }
            setStatus("review");
            addedCount += await runPerSegmentClassifyProgressive(
              photo.uri,
              segments,
              setAiMetaList,
            );
          } else if (strategy === "flat_lay_boxes") {
            if (addedCount === 0 && !appendToReviewRef.current) {
              setImage(photo.uri);
            }
            setStatus("review");
            addedCount += await runBoxStrategyProgressive(
              photo.uri,
              photo.base64,
              segments,
              "flat_lay",
              setAiMetaList,
            );
          } else {
            if (addedCount === 0 && !appendToReviewRef.current) {
              setImage(photo.uri);
            }
            setStatus("review");
            addedCount += await runBoxStrategyProgressive(
              photo.uri,
              photo.base64,
              segments,
              "fit_check",
              setAiMetaList,
            );
          }
        } catch (e) {
          console.warn("[upload] classify failed for captured photo", i + 1, e);
        }
        setBatchAnalyze({ current: i + 1, total: toProcess.length });
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

  /** Build the row shape for a single meta entry against an uploaded image URL. */
  const buildClothingItemRow = (
    meta: any,
    imageUrl: string,
    userId: string,
    thumbnailUrl?: string | null,
  ) => {
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
      seasons: normalizedSeasonsForMeta(meta) || warmthToSeasons(meta?.warmth),
      occasions: meta?.occasions || ["casual"],
      formality: normalizeFormality(meta?.formality),
      box_2d: meta?.box_2d || null,
      notes: null,
      is_digitized: true,
      image_url_original: meta?.image_url_original ?? null,
      image_url_isolated: meta?.image_url_isolated ?? null,
      thumbnail_url: thumbnailUrl ?? null,
    };
  };

  const pickImages = async () => {
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    // Snapshot before any `await` — if this changes mid-flight, we still
    // decide "cancel = leave add-items" from the state when the user opened
    // the picker (fixes closing the whole flow when dismissing the roll from
    // the in-session camera, or with items already in review).
    const fromLibraryMenu =
      uploadSource === "library" || isLibraryMenuIntent(params.library);
    const canExitToParentOnPickerCancel =
      fromLibraryMenu && aiMetaList.length === 0 && !appendToReviewRef.current;
    const existingItemsSnapshot = appendToReviewRef.current
      ? [...aiMetaList]
      : [];

    if (isOutfitMode) {
      const pickingSession = await persistOutfitUploadSession({
        userId: uploadUserId,
        phase: "picking",
        uploadSource: "library",
        existingSession: outfitRecoverySessionRef.current,
      });
      if (pickingSession) outfitRecoverySessionRef.current = pickingSession;
    } else {
      const scanningSession = await persistUploadReviewSession({
        userId: uploadUserId,
        aiMetaList: existingItemsSnapshot,
        sessionStatus: "scanning",
        uploadSource: "library",
        linkOutfitId: activeLinkOutfitId,
        existingSession: recoverySessionRef.current,
      });
      if (scanningSession) recoverySessionRef.current = scanningSession;
    }

    const libPerm = await requestLibraryAccessWithPriming();
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

    if (fromLibraryMenu) setLibraryPickerOpen(true);
    let res: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
    try {
      res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
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
    } catch (e) {
      console.error("[upload] launchImageLibraryAsync failed", e);
      Alert.alert("Could not open photos", formatUnknownError(e));
      setStatus("scanning");
      return;
    } finally {
      if (fromLibraryMenu) setLibraryPickerOpen(false);
    }

    if (res.canceled || res.assets.length === 0) {
      if (canExitToParentOnPickerCancel) {
        if (isOutfitMode) {
          await clearOutfitUploadRecoverySession(uploadUserId);
        } else {
          await clearUploadRecoverySession(uploadUserId);
        }
        router.back();
      }
      return;
    }

    const assetUris = res.assets.map((a) => a.uri);

    setUploadSource("library");

    if (isOutfitMode) {
      // Flip to the processing screen immediately. Persisting the recovery
      // session copies every selected photo to disk (several seconds for a
      // multi-photo batch), so awaiting it here would leave the user staring
      // at the live camera the whole time. Show the loader first, then persist.
      setStatus("outfit_processing");
      setBatchAnalyze({ current: 0, total: res.assets.length });
      setImage(null);

      const processingSession = await persistOutfitUploadSession({
        userId: uploadUserId,
        phase: "processing",
        uploadSource: "library",
        pendingUris: assetUris,
        existingSession: outfitRecoverySessionRef.current,
      });
      if (processingSession) {
        outfitRecoverySessionRef.current = processingSession;
      }
    } else {
      const queuedSession = await persistUploadReviewSession({
        userId: uploadUserId,
        aiMetaList: existingItemsSnapshot,
        imageUri: assetUris[0],
        pendingPhotoUris: assetUris,
        uploadSource: "library",
        sessionStatus: "queued",
        linkOutfitId: activeLinkOutfitId,
        existingSession: recoverySessionRef.current,
      });
      if (queuedSession) recoverySessionRef.current = queuedSession;

      // UI after durable save — crash during transcode still recovers photos.
      setStatus("review");
      setBatchAnalyze({ current: 0, total: res.assets.length });
      setImage(assetUris[0] ?? null);
    }

    // Defer the heavy transcoding to fully yield the thread so the UI can flush the loading view.
    // 50ms is plenty — one frame + buffer — vs 400ms which was producing a visible lag.
    setTimeout(async () => {
      // Safety net: this runs detached (setTimeout), so an unexpected throw
      // here would otherwise be swallowed and leave the review stuck on the
      // loading bar. Surface it and reset to a usable state instead.
      try {
        // Transcode in parallel — HEIC→JPEG is independent per asset and previously serial.
        const jpegUris = await Promise.all(
          res.assets.map(async (a) => {
            try {
              return await ensureJpegUri(a.uri);
            } catch (e) {
              console.warn("[upload] JPEG transcode failed, using picker URI", e);
              return a.uri;
            }
          }),
        );

        await analyzeAllLibraryPhotos(jpegUris);
      } catch (e) {
        console.error("[upload] library analyze crashed", e);
        setBatchAnalyze(null);
        setAiMetaList([]);
        setStatus("scanning");
        Alert.alert("Upload failed", formatUnknownError(e));
      }
    }, 50);
  };

  /** Pick photos from library and APPEND results to existing review list */
  const addMoreFromLibrary = async () => {
    setAddMoreSheetOpen(false);
    appendToReviewRef.current = true;
    if (status === "done") {
      setStatus("review");
      if (!image) {
        const u = aiMetaList.find((x) => x.sourceUri)?.sourceUri;
        if (u) setImage(u);
      }
    }
    const libPerm = await requestLibraryAccessWithPriming();
    if (!libPerm.granted) {
      Alert.alert("Photo library access needed", "Enable it in Settings.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => Linking.openSettings() },
      ]);
      return;
    }

    const scanningSession = await persistUploadReviewSession({
      userId: uploadUserId,
      aiMetaList: [...aiMetaList],
      sessionStatus: "scanning",
      uploadSource: "library",
      linkOutfitId: activeLinkOutfitId,
      existingSession: recoverySessionRef.current,
    });
    if (scanningSession) recoverySessionRef.current = scanningSession;

    let res: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
    try {
      res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
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

    const assetUris = res.assets.map((a) => a.uri);

    const appendSession = await persistUploadReviewSession({
      userId: uploadUserId,
      aiMetaList: [...aiMetaList],
      imageUri: assetUris[0] ?? image,
      pendingPhotoUris: assetUris,
      uploadSource: "library",
      sessionStatus: "queued",
      linkOutfitId: activeLinkOutfitId,
      existingSession: recoverySessionRef.current,
    });
    if (appendSession) recoverySessionRef.current = appendSession;

    setUploadSource("library");
    setStatus("review");
    setBatchAnalyze({ current: 0, total: res.assets.length });
    setImage(assetUris[0] ?? null);
    pinReviewScrollToAppendRef.current = true;
    scrollReviewToEnd(false);

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
        const uri = jpegUris[i];
        try {
          const b64 = await uriToBase64(uri);
          const segments = await segmentItems(b64);
          const strategy = await decideUploadSegmentStrategy(segments, uri);
          if (strategy === "per_segment") {
            setStatus("review");
            await runPerSegmentClassifyProgressive(uri, segments, setAiMetaList);
          } else if (strategy === "flat_lay_boxes") {
            setStatus("review");
            await runBoxStrategyProgressive(
              uri,
              b64,
              segments,
              "flat_lay",
              setAiMetaList,
            );
          } else {
            setStatus("review");
            await runBoxStrategyProgressive(
              uri,
              b64,
              segments,
              "fit_check",
              setAiMetaList,
            );
          }
        } catch (e) {
          console.warn("[upload] addMore failed for photo", i + 1, e);
        }
        setBatchAnalyze({ current: i + 1, total: jpegUris.length });
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

  const closeCamera = () => {
    if (appendToReviewRef.current && aiMetaList.length > 0) {
      appendToReviewRef.current = false;
      setCapturedPhotos([]);
      setBatchAnalyze(null);
      setStatus("review");
      return;
    }
    if (isOutfitMode && !isExtractForOutfitMode && !appendToReviewRef.current) {
      const hasWork =
        outfitDraftsRef.current.length > 0 ||
        capturedPhotos.length > 0 ||
        status === "outfit_processing";
      if (hasWork) {
        handleOutfitLeaveRef.current();
        return;
      }
    }
    void clearUploadRecoverySession(uploadUserId);
    void clearOutfitUploadRecoverySession(uploadUserId);
    recoverySessionRef.current = null;
    outfitRecoverySessionRef.current = null;
    router.back();
  };

  const outfitRestoreHandledRef = useRef(false);
  const uploadIntentSavedRef = useRef(false);

  const persistItemsUploadIntent = useCallback(
    async (source: "camera" | "library") => {
      if (isOutfitMode || isExtractForOutfitMode) return;
      const session = await persistUploadReviewSession({
        userId: uploadUserId,
        aiMetaList: appendToReviewRef.current ? [...aiMetaList] : [],
        sessionStatus: "scanning",
        uploadSource: source,
        linkOutfitId: activeLinkOutfitId,
        existingSession: recoverySessionRef.current,
      });
      if (session) recoverySessionRef.current = session;
    },
    [
      activeLinkOutfitId,
      aiMetaList,
      isExtractForOutfitMode,
      isOutfitMode,
      uploadUserId,
    ],
  );

  const persistOutfitUploadIntent = useCallback(
    async (source: "camera" | "library") => {
      if (!isOutfitMode || isExtractForOutfitMode) return;
      const session = await persistOutfitUploadSession({
        userId: uploadUserId,
        phase: "picking",
        uploadSource: source,
        existingSession: outfitRecoverySessionRef.current,
      });
      if (session) outfitRecoverySessionRef.current = session;
    },
    [isExtractForOutfitMode, isOutfitMode, uploadUserId],
  );

  pickImagesRef.current = pickImages;

  useEffect(() => {
    if (!isLibraryMenuIntent(params.library) || restoreOutfitParam) return;
    setUploadSource("library");
    setStatus("scanning");
    setImage(null);
    setAiMetaList([]);
    setCapturedPhotos([]);
    setLibraryAutoPickPending(true);
    void (async () => {
      if (isOutfitMode) {
        await persistOutfitUploadIntent("library");
      } else {
        await persistItemsUploadIntent("library");
      }
    })();
    const timer = setTimeout(() => {
      pickImagesRef.current().finally(() => setLibraryAutoPickPending(false));
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.library]);

  useEffect(() => {
    if (isExtractForOutfitMode || restoreUploadParam || restoreOutfitParam) return;
    if (uploadIntentSavedRef.current) return;
    if (isLibraryMenuIntent(params.library)) return;
    uploadIntentSavedRef.current = true;
    void (async () => {
      if (isOutfitMode) {
        await persistOutfitUploadIntent(uploadSource);
      } else {
        await persistItemsUploadIntent(uploadSource);
      }
    })();
  }, [
    isExtractForOutfitMode,
    isOutfitMode,
    params.library,
    persistItemsUploadIntent,
    persistOutfitUploadIntent,
    restoreOutfitParam,
    restoreUploadParam,
    uploadSource,
  ]);

  useEffect(() => {
    if (!isExtractForOutfitMode || !outfitImageUrlParam || extractBootstrappedRef.current) {
      return;
    }
    extractBootstrappedRef.current = true;
    void (async () => {
      try {
        let localUri = outfitImageUrlParam;
        if (outfitImageUrlParam.startsWith("http")) {
          localUri = await downloadImageToCache(outfitImageUrlParam);
        }
        setImage(localUri);
        setStatus("analyzing");
        const b64 = await uriToBase64(localUri);
        const found = await processImage(b64, localUri);
        // Nothing detected — don't strand the user on the extraction spinner
        // (aiMetaList stays empty, so the loading guard would render forever).
        // Tell them plainly and return to where they came from.
        if (found === 0) {
          Alert.alert(
            "No items found",
            "We couldn't pull any clothing pieces out of that photo. Try a clearer, well-lit shot of the full outfit.",
          );
          router.back();
        }
      } catch (e) {
        console.error("[extract-for-outfit]", e);
        Alert.alert("Extraction failed", formatUnknownError(e));
        router.back();
      }
    })();
  }, [isExtractForOutfitMode, outfitImageUrlParam, router]);

  const resolveUploadSessionStatus = useCallback((): UploadRecoverySession["status"] => {
    if (uploading) return "uploading";
    if (status === "analyzing") return "analyzing";
    if (
      recoverySessionRef.current?.status === "partial" ||
      recoverySessionRef.current?.status === "uploading"
    ) {
      return recoverySessionRef.current.status;
    }
    return aiMetaList.length > 0 ? "reviewing" : "analyzing";
  }, [aiMetaList.length, status, uploading]);

  const flushUploadSession = useCallback(async () => {
    if (isOutfitMode || isExtractForOutfitMode || uploading) return;

    if (status === "scanning") {
      const session = await persistUploadReviewSession({
        userId: uploadUserId,
        aiMetaList: appendToReviewRef.current ? [...aiMetaList] : [],
        sessionStatus: "scanning",
        uploadSource,
        linkOutfitId: activeLinkOutfitId,
        existingSession: recoverySessionRef.current,
      });
      if (session) recoverySessionRef.current = session;
      return;
    }

    if (aiMetaList.length === 0 && !image) return;

    const session = await persistUploadReviewSession({
      userId: uploadUserId,
      aiMetaList,
      imageUri: image,
      linkOutfitId: activeLinkOutfitId,
      existingSession: recoverySessionRef.current,
      sessionStatus: resolveUploadSessionStatus(),
      pendingPhotoUris: aiMetaList.length > 0 ? null : undefined,
      uploadSource,
    });
    if (session) recoverySessionRef.current = session;
  }, [
    activeLinkOutfitId,
    aiMetaList,
    image,
    isExtractForOutfitMode,
    isOutfitMode,
    resolveUploadSessionStatus,
    uploadUserId,
    uploading,
    uploadSource,
    status,
  ]);

  useEffect(() => {
    if (!user?.id) return;
    void migrateUploadRecoverySession(UPLOAD_RECOVERY_LOCAL_USER, user.id);
    void migrateOutfitUploadRecoverySession(
      UPLOAD_RECOVERY_LOCAL_USER,
      user.id,
    );
  }, [user?.id]);

  const flushOutfitUploadSession = useCallback(async () => {
    if (!isOutfitMode || isExtractForOutfitMode || savingOutfitPhoto) return;

    if (
      status === "outfit_review" &&
      outfitDraftsRef.current.length > 0
    ) {
      await persistOutfitDraftsToSession(
        outfitDraftsRef.current,
        "review",
      );
      return;
    }

    if (status === "outfit_processing" || status === "outfit_isolating") {
      return;
    }

    if (status === "scanning") {
      const session = await persistOutfitUploadSession({
        userId: uploadUserId,
        phase: "picking",
        uploadSource,
        existingSession: outfitRecoverySessionRef.current,
      });
      if (session) outfitRecoverySessionRef.current = session;
    }
  }, [
    isExtractForOutfitMode,
    isOutfitMode,
    persistOutfitDraftsToSession,
    savingOutfitPhoto,
    status,
    uploadSource,
    uploadUserId,
  ]);

  const applyOutfitRecoverySession = useCallback(
    async (opts?: { showMissingAlert?: boolean }) => {
      if (!isOutfitMode || isExtractForOutfitMode || savingOutfitPhoto) {
        return false;
      }
      if (
        status === "outfit_review" &&
        outfitDraftsRef.current.length > 0
      ) {
        return false;
      }

      await ensureRecoveryDeclinesLoaded(uploadUserId);

      let session =
        (await loadOutfitUploadRecoverySession(uploadUserId)) ??
        (user?.id
          ? await loadOutfitUploadRecoverySession(UPLOAD_RECOVERY_LOCAL_USER)
          : null);
      if (!session || isOutfitUploadRecoveryDismissed(session.id)) return false;

      const validated = await validateOutfitUploadRecoverySession(session);
      if (!validated) {
        await clearOutfitUploadRecoverySession(session.userId);
        if (opts?.showMissingAlert) {
          Alert.alert(
            "Nothing to restore",
            "The saved photos for that outfit are no longer on this device.",
          );
        }
        return false;
      }
      session = validated;
      outfitRecoverySessionRef.current = session;
      setUploadSource(session.uploadSource);

      if (session.phase === "picking") {
        setStatus("scanning");
        if (session.uploadSource === "library") {
          await pickImagesRef.current();
        }
        return true;
      }

      if (session.drafts && session.drafts.length > 0) {
        syncOutfitDrafts(
          session.drafts.map((d) => ({
            id: d.id,
            heroUri: d.heroUri,
            originalUri: d.originalUri,
            name: d.name ?? "",
            schedule: d.schedule ?? "none",
            pickIso: d.pickIso ?? null,
          })),
        );
        setStatus("outfit_review");
        return true;
      }

      if (session.phase === "review" && session.imageUri) {
        syncOutfitDrafts([
          {
            id: newOutfitDraftId(),
            heroUri: session.imageUri,
            originalUri: session.originalUri ?? session.imageUri,
            name: session.outfitName ?? "",
            schedule: session.outfitSchedule ?? "none",
            pickIso: session.outfitPickIso ?? null,
          },
        ]);
        setStatus("outfit_review");
        return true;
      }

      const allUris = session.originalUri
        ? [
            session.originalUri,
            ...session.pendingUris.filter((u) => u !== session.originalUri),
          ]
        : [...session.pendingUris];
      if (allUris.length === 0) return false;

      const jpegUris = await Promise.all(
        allUris.map((uri) => ensureJpegUri(uri)),
      );
      await prepareOutfitDraftBatch(jpegUris);
      return true;
    },
    [
      isExtractForOutfitMode,
      isOutfitMode,
      prepareOutfitDraftBatch,
      savingOutfitPhoto,
      status,
      syncOutfitDrafts,
      uploadUserId,
      user?.id,
    ],
  );

  useEffect(() => {
    if (!isOutfitMode || isExtractForOutfitMode) return;
    if (outfitRestoreHandledRef.current) return;
    outfitRestoreHandledRef.current = true;

    void (async () => {
      const restored = await applyOutfitRecoverySession({
        showMissingAlert: restoreOutfitParam,
      });
      if (restoreOutfitParam && !restored) {
        const session = await loadOutfitUploadRecoverySession(uploadUserId);
        if (!session) {
          Alert.alert(
            "Nothing to restore",
            "Your last outfit session is no longer available.",
          );
        }
      }
    })();
  }, [
    applyOutfitRecoverySession,
    isExtractForOutfitMode,
    isOutfitMode,
    restoreOutfitParam,
    uploadUserId,
  ]);

  useEffect(() => {
    if (!isOutfitMode || isExtractForOutfitMode) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void applyOutfitRecoverySession();
      } else if (next === "background" || next === "inactive") {
        void flushOutfitUploadSession();
      }
    });
    return () => sub.remove();
  }, [
    applyOutfitRecoverySession,
    flushOutfitUploadSession,
    isExtractForOutfitMode,
    isOutfitMode,
  ]);

  useEffect(() => {
    if (!isOutfitMode || isExtractForOutfitMode || !image) return;
    if (status !== "analyzing" && status !== "scanning") return;
    void flushOutfitUploadSession();
  }, [
    flushOutfitUploadSession,
    image,
    isExtractForOutfitMode,
    isOutfitMode,
    status,
  ]);

  useEffect(() => {
    if (!isOutfitMode || isExtractForOutfitMode) return;
    if (status !== "scanning") return;
    void flushOutfitUploadSession();
  }, [flushOutfitUploadSession, isExtractForOutfitMode, isOutfitMode, status]);

  useEffect(() => {
    if (!isOutfitMode || status !== "outfit_review") return;
    if (outfitPersistTimerRef.current) {
      clearTimeout(outfitPersistTimerRef.current);
    }
    outfitPersistTimerRef.current = setTimeout(() => {
      void persistOutfitDraftsToSession(outfitDraftsRef.current, "review");
    }, 400);
    return () => {
      if (outfitPersistTimerRef.current) {
        clearTimeout(outfitPersistTimerRef.current);
      }
    };
  }, [
    isOutfitMode,
    outfitDrafts,
    persistOutfitDraftsToSession,
    status,
  ]);

  const applyUploadRecoverySession = useCallback(
    async (opts?: { showMissingAlert?: boolean; showResumeHint?: boolean }) => {
      if (isOutfitMode || isExtractForOutfitMode || uploading) return false;
      if (aiMetaList.length > 0 || status === "review") return false;

      await ensureRecoveryDeclinesLoaded(uploadUserId);

      let session =
        (await loadUploadRecoverySession(uploadUserId)) ??
        (user?.id
          ? await loadUploadRecoverySession(UPLOAD_RECOVERY_LOCAL_USER)
          : null);
      if (!session || isItemsRecoveryDismissed(session.id)) return false;

      session = await validateUploadRecoverySession(session);
      if (sessionPendingCount(session) === 0) {
        await clearUploadRecoverySession(session.userId);
        if (opts?.showMissingAlert) {
          Alert.alert(
            "Nothing to restore",
            "The saved images for that upload are no longer on this device.",
          );
        }
        return false;
      }

      recoverySessionRef.current = session;
      const restored = sessionToAiMetaList(session);
      const resumeSaving =
        session.status === "uploading" || session.status === "partial";

      if (
        session.status === "scanning" &&
        (session.pendingPhotoUris?.length ?? 0) === 0
      ) {
        setUploadSource(session.uploadSource ?? "library");
        setStatus("scanning");
        if (session.uploadSource === "library") {
          await pickImagesRef.current();
        } else {
          setUploadSource("camera");
        }
        return true;
      }

      const queuedPhotos = session.pendingPhotoUris ?? [];
      const resumeQueuedScan = queuedPhotos.length > 0;

      if (restored.length > 0) {
        setAiMetaList(restored);
        const firstSourceUri =
          typeof restored[0]?.sourceUri === "string"
            ? restored[0].sourceUri
            : null;
        setUploadSource(session.uploadSource ?? "library");
        setImage(session.imageUri ?? firstSourceUri);
        if (!resumeQueuedScan) {
          setStatus("review");
          if (resumeSaving && opts?.showResumeHint) {
            Alert.alert(
              "Ready to resume",
              "Tap Save to finish adding the remaining items.",
            );
          }
          return true;
        }
        setStatus("review");
      }

      if (resumeQueuedScan) {
        appendToReviewRef.current = restored.length > 0;
        setUploadSource(session.uploadSource ?? "library");
        setStatus("review");
        setBatchAnalyze({ current: 0, total: queuedPhotos.length });
        if (!image) setImage(queuedPhotos[0] ?? null);
        try {
          const jpegUris = await Promise.all(
            queuedPhotos.map((uri) => ensureJpegUri(uri)),
          );
          await analyzeAllLibraryPhotos(jpegUris);
          return true;
        } catch (e) {
          console.error("[upload-restore-queue]", e);
          Alert.alert(
            "Could not resume",
            "We found your photos but could not re-run analysis. Try uploading again.",
          );
        }
        return false;
      }

      if (session.imageUri) {
        setUploadSource("library");
        setImage(session.imageUri);
        setStatus("review");
        try {
          const b64 = await uriToBase64(session.imageUri);
          await processImage(b64, session.imageUri);
          return true;
        } catch (e) {
          console.error("[upload-restore]", e);
          setStatus("review");
          Alert.alert(
            "Could not resume",
            "We found your photo but could not re-run analysis. Try uploading again.",
          );
        }
      }

      return false;
    },
    [
      aiMetaList.length,
      isExtractForOutfitMode,
      isOutfitMode,
      status,
      uploadUserId,
      uploading,
      user?.id,
    ],
  );

  useEffect(() => {
    if (isOutfitMode || isExtractForOutfitMode) return;
    if (uploadRestoreHandledRef.current) return;
    uploadRestoreHandledRef.current = true;

    void (async () => {
      const restored = await applyUploadRecoverySession({
        showMissingAlert: restoreUploadParam,
        showResumeHint: restoreUploadParam,
      });
      if (restoreUploadParam && !restored) {
        const session = await loadUploadRecoverySession(uploadUserId);
        if (!session) {
          Alert.alert(
            "Nothing to restore",
            "Your last upload session is no longer available.",
          );
        }
      }
    })();
  }, [
    applyUploadRecoverySession,
    isExtractForOutfitMode,
    isOutfitMode,
    restoreUploadParam,
    uploadUserId,
  ]);

  useEffect(() => {
    if (isOutfitMode || isExtractForOutfitMode) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void applyUploadRecoverySession();
      }
    });
    return () => sub.remove();
  }, [applyUploadRecoverySession, isExtractForOutfitMode, isOutfitMode]);

  useEffect(() => {
    if (isOutfitMode || isExtractForOutfitMode) return;
    if (status !== "scanning") return;
    void flushUploadSession();
  }, [flushUploadSession, isExtractForOutfitMode, isOutfitMode, status]);

  useEffect(() => {
    if (isOutfitMode || isExtractForOutfitMode) return;
    if (aiMetaList.length === 0 && !image) return;

    if (persistReviewTimerRef.current) {
      clearTimeout(persistReviewTimerRef.current);
    }
    persistReviewTimerRef.current = setTimeout(() => {
      void flushUploadSession();
    }, 350);

    return () => {
      if (persistReviewTimerRef.current) {
        clearTimeout(persistReviewTimerRef.current);
      }
    };
  }, [
    aiMetaList,
    flushUploadSession,
    image,
    isExtractForOutfitMode,
    isOutfitMode,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "background" && next !== "inactive") return;
      void flushUploadSession();
    });
    return () => sub.remove();
  }, [flushUploadSession]);

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
    if (!(await confirmLowConfidenceItems(aiMetaList))) return;
    const itemsSnapshot = [...aiMetaList];
    const imageSnapshot = image;

    if (persistReviewTimerRef.current) {
      clearTimeout(persistReviewTimerRef.current);
      persistReviewTimerRef.current = null;
    }

    setUploading(true);

    try {
      const session = await persistUploadReviewSession({
        userId,
        aiMetaList: itemsSnapshot,
        imageUri: imageSnapshot,
        linkOutfitId: activeLinkOutfitId,
        existingSession: recoverySessionRef.current,
      });

      if (!session) {
        Alert.alert("Save error", "Could not prepare your upload session.");
        setUploading(false);
        return;
      }

      recoverySessionRef.current = session;

      const { session: updatedSession, insertedIds, allSaved } =
        await saveUploadSessionToCloset(
          session,
          supabase,
          userId,
          buildClothingItemRow,
        );

      recoverySessionRef.current = updatedSession;

      if (insertedIds.length === 0) {
        Alert.alert(
          "Save error",
          "All uploads failed. Open Upload again to retry.",
        );
        setUploading(false);
        return;
      }

      const wardrobeId = takeAddItemsWardrobeId();
      if (wardrobeId && insertedIds.length) {
        await addItemsToWardrobe(wardrobeId, insertedIds);
      } else if (insertedIds.length) {
        void fetchWardrobes(userId)
          .then((existingWardrobes) => {
            if (existingWardrobes.length === 0) {
              return markPendingFirstWardrobePrompt(userId);
            }
          })
          .catch(() => {});
      }

      if (activeLinkOutfitId && insertedIds.length) {
        await attachClothingItemsToOutfit(
          supabase,
          activeLinkOutfitId,
          insertedIds,
        );
        DeviceEventEmitter.emit("closetItemsSaved");
        DeviceEventEmitter.emit("outfitItemsExtracted", {
          outfitId: activeLinkOutfitId,
          itemIds: insertedIds,
        });
        if (allSaved) {
          await clearUploadRecoverySession(userId);
          recoverySessionRef.current = null;
        }
        setUploading(false);
        setPendingLinkOutfitId(null);
        if (allSaved) {
          router.replace(fitsLibraryRoute({ openFitId: activeLinkOutfitId }) as any);
        } else {
          const remaining = sessionPendingCount(updatedSession);
          setAiMetaList(sessionToAiMetaList(updatedSession));
          Alert.alert(
            "Partially saved",
            `${insertedIds.length} saved, ${remaining} still waiting. Tap save again or come back later.`,
          );
        }
        return;
      }

      DeviceEventEmitter.emit("closetItemsSaved");

      if (allSaved) {
        await clearUploadRecoverySession(userId);
        recoverySessionRef.current = null;
        leaveAddItemsFlow();
      } else {
        const remaining = sessionPendingCount(updatedSession);
        setAiMetaList(sessionToAiMetaList(updatedSession));
        Alert.alert(
          "Partially saved",
          `${insertedIds.length} saved, ${remaining} still waiting. Tap save again or come back later.`,
        );
      }
    } catch (err) {
      console.error("Upload Error:", err);
      Alert.alert(
        "Archive Failed",
        "Could not sync items to database. Open Upload again to resume.",
      );
    } finally {
      setUploading(false);
    }
  };

  const removeItem = (index: number) => {
    setAiMetaList((prev) => prev.filter((_, i) => i !== index));
  };

  const syncOutfitExtractItemsFromAiMeta = (
    draftId: string,
    items: Record<string, unknown>[],
  ) => {
    syncOutfitDrafts(
      outfitDraftsRef.current.map((d) =>
        d.id === draftId
          ? { ...d, extractItems: items.map((it) => ({ ...it })) }
          : d,
      ),
    );
  };

  const enhanceItemAtIndex = async (idx: number, extractDraftId?: string) => {
    const draftItems = extractDraftId
      ? outfitDraftsRef.current.find((d) => d.id === extractDraftId)
          ?.extractItems
      : null;
    const item = draftItems?.[idx] ?? aiMetaList[idx];
    if (!item || item._classifying || item._enhancing) return;
    const src = item.sourceUri ?? item.originalSourceUri;
    if (!src) return;

    const markEnhancing = (prev: Record<string, unknown>[]) =>
      prev.map((it, i) => (i === idx ? { ...it, _enhancing: true } : it));

    if (extractDraftId) {
      const base = (draftItems ?? []).map((it) => ({ ...it }));
      const next = markEnhancing(base);
      syncOutfitExtractItemsFromAiMeta(extractDraftId, next);
      setAiMetaList(next);
    } else {
      setAiMetaList(markEnhancing);
    }
    try {
      const originalUri =
        (typeof item.originalSourceUri === "string" && item.originalSourceUri) ||
        src;
      console.log("[enhance] Gemini + Vision…");
      const outUri = await enhanceViaGeminiAndVision({
        sourceUri: src,
        originalUri,
        box2d: item.box_2d,
        name: typeof item.name === "string" ? item.name : undefined,
        color: typeof item.color === "string" ? item.color : undefined,
        category:
          typeof item.category === "string" ? item.category : undefined,
      });
      console.log("[enhance] success");
      const applyEnhance = (prev: Record<string, unknown>[]) =>
        prev.map((it, i) =>
          i === idx
            ? {
                ...it,
                enhancedUri: outUri,
                is_enhanced: true,
                _enhancing: false,
                _displayEpoch: (Number(it._displayEpoch) || 0) + 1,
              }
            : it,
        );
      if (extractDraftId) {
        setAiMetaList((prev) => {
          const next = applyEnhance(prev);
          syncOutfitExtractItemsFromAiMeta(extractDraftId, next);
          return next;
        });
      } else {
        setAiMetaList(applyEnhance);
      }
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
      const clearEnhancing = (prev: Record<string, unknown>[]) =>
        prev.map((it, i) => (i === idx ? { ...it, _enhancing: false } : it));
      if (extractDraftId) {
        setAiMetaList((prev) => {
          const next = clearEnhancing(prev);
          syncOutfitExtractItemsFromAiMeta(extractDraftId, next);
          return next;
        });
      } else {
        setAiMetaList(clearEnhancing);
      }
    }
  };

  const closeConfigureModal = useCallback(() => {
    if (outfitExtractEditDraftId && outfitExtractEditSnapshotRef.current) {
      syncOutfitDrafts(
        outfitDraftsRef.current.map((d) =>
          d.id === outfitExtractEditDraftId
            ? { ...d, extractItems: [...outfitExtractEditSnapshotRef.current!] }
            : d,
        ),
      );
      outfitExtractEditSnapshotRef.current = null;
      setOutfitExtractEditDraftId(null);
    }
    setEditIndex(null);
    setPreviewUri(null);
  }, [syncOutfitDrafts]);

  const prepareOutfitExtractContext = useCallback(
    (draftId: string) => {
      const draft = outfitDraftsRef.current.find((d) => d.id === draftId);
      if (!draft) return;
      setOutfitExtractEditDraftId(draftId);
      setAiMetaList((draft.extractItems ?? []).map((it) => ({ ...it })));
    },
    [],
  );

  const removeOutfitExtractItem = useCallback(
    (draftId: string, index: number) => {
      syncOutfitDrafts(
        outfitDraftsRef.current.map((d) => {
          if (d.id !== draftId) return d;
          const next = (d.extractItems ?? []).filter((_, i) => i !== index);
          return { ...d, extractItems: next };
        }),
      );
    },
    [syncOutfitDrafts],
  );

  const enhanceOutfitExtractItem = useCallback(
    async (draftId: string, idx: number) => {
      prepareOutfitExtractContext(draftId);
      await enhanceItemAtIndex(idx, draftId);
    },
    [prepareOutfitExtractContext],
  );

  const adjustOutfitExtractItem = useCallback(
    (draftId: string, idx: number) => {
      prepareOutfitExtractContext(draftId);
      setManualCropIndex(idx);
    },
    [prepareOutfitExtractContext],
  );

  const openOutfitExtractReview = useCallback(
    (draftId: string) => {
      const draft = outfitDraftsRef.current.find((d) => d.id === draftId);
      if (!draft) return;
      prepareOutfitExtractContext(draftId);
      setImage(draft.originalUri);
      setOutfitExtractReviewDraftId(draftId);
    },
    [prepareOutfitExtractContext],
  );

  const closeOutfitExtractReview = useCallback(() => {
    setOutfitExtractReviewDraftId(null);
    setEditIndex(null);
    setPreviewUri(null);
    setManualCropIndex(null);
  }, []);

  useEffect(() => {
    if (!outfitExtractReviewDraftId || editIndex !== null) return;
    const draft = outfitDrafts.find((d) => d.id === outfitExtractReviewDraftId);
    if (!draft) return;
    setAiMetaList((draft.extractItems ?? []).map((it) => ({ ...it })));
    setImage(draft.originalUri);
  }, [outfitDrafts, outfitExtractReviewDraftId, editIndex]);

  const outfitExtractReviewReadyCount = useMemo(() => {
    if (!outfitExtractReviewDraftId) return 0;
    return aiMetaList.filter(
      (it) => !(it._classifying || it._scanning),
    ).length;
  }, [aiMetaList, outfitExtractReviewDraftId]);

  const outfitExtractReviewSaveBlocked =
    !!outfitExtractReviewDraftId &&
    (savingOutfitPhoto ||
      outfitExtractReviewReadyCount === 0 ||
      aiMetaList.some((i) => isItemClassifying(i) || i._enhancing));

  const openOutfitExtractEdit = useCallback(
    (draftId: string, idx: number) => {
      const draft = outfitDraftsRef.current.find((d) => d.id === draftId);
      const items = draft?.extractItems ?? [];
      const item = items[idx];
      if (!item || item._classifying || item._scanning) return;
      outfitExtractEditSnapshotRef.current = items.map((it) => ({ ...it }));
      setOutfitExtractEditDraftId(draftId);
      setAiMetaList(items.map((it) => ({ ...it })));
      const categoryDefault =
        (typeof item?.category === "string" && item.category.trim()) ||
        categoryHintShelfId ||
        "";
      setEditForm({
        name: typeof item?.name === "string" ? item.name : "",
        category: categoryDefault,
        color: typeof item?.color === "string" ? item.color : "",
        occasions: Array.isArray(item?.occasions)
          ? [...(item.occasions as string[])]
          : [],
        seasons: Array.isArray(item?.seasons)
          ? [...(item.seasons as string[])]
          : warmthToSeasons(
              typeof item?.warmth === "string" ? item.warmth : undefined,
            ),
      });
      setEditIndex(idx);
    },
    [categoryHintShelfId],
  );

  const openUploadEdit = (idx: number) => {
    if (outfitExtractEditDraftId) return;
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
  };

  const handleManualCropSave = ({
    sourceUri,
    box2d,
  }: {
    sourceUri: string;
    box2d: number[];
  }) => {
    if (manualCropIndex === null) return;
    const patch = {
      sourceUri,
      box_2d: box2d,
      isIsolated: true,
      _manualCrop: true,
      enhancedUri: undefined,
      is_enhanced: false,
      _displayEpoch: 0,
    };
    if (outfitExtractEditDraftId) {
      syncOutfitDrafts(
        outfitDraftsRef.current.map((d) => {
          if (d.id !== outfitExtractEditDraftId) return d;
          const items = [...(d.extractItems ?? [])];
          if (manualCropIndex >= 0 && manualCropIndex < items.length) {
            const prev = items[manualCropIndex]!;
            items[manualCropIndex] = {
              ...prev,
              ...patch,
              _displayEpoch: (Number(prev._displayEpoch) || 0) + 1,
            };
          }
          return { ...d, extractItems: items };
        }),
      );
      setAiMetaList((prev) =>
        prev.map((it, i) =>
          i === manualCropIndex
            ? {
                ...it,
                ...patch,
                _displayEpoch: (Number(it._displayEpoch) || 0) + 1,
              }
            : it,
        ),
      );
    } else {
      setAiMetaList((prev) =>
        prev.map((it, i) =>
          i === manualCropIndex
            ? {
                ...it,
                ...patch,
                _displayEpoch: (Number(it._displayEpoch) || 0) + 1,
              }
            : it,
        ),
      );
    }
    setManualCropIndex(null);
  };

  const saveUploadEdit = () => {
    if (editIndex !== null) {
      const patch = {
        name: editForm.name,
        category: editForm.category,
        color: editForm.color,
        occasions: editForm.occasions,
        seasons: editForm.seasons,
        warmth: seasonsToWarmth(editForm.seasons),
      };
      if (outfitExtractEditDraftId) {
        const nextItems = aiMetaList.map((it, i) =>
          i === editIndex ? { ...it, ...patch } : it,
        );
        syncOutfitDrafts(
          outfitDraftsRef.current.map((d) =>
            d.id === outfitExtractEditDraftId
              ? { ...d, extractItems: nextItems }
              : d,
          ),
        );
        outfitExtractEditSnapshotRef.current = null;
        setOutfitExtractEditDraftId(null);
      } else {
        setAiMetaList((prev) =>
          prev.map((it, i) => (i === editIndex ? { ...it, ...patch } : it)),
        );
      }
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
    replaceOutfitReviewQueue([]);
    setOutfitReviewBatch(null);
    syncOutfitDrafts([]);
    setOutfitName("");
    setOutfitSchedule("none");
    setOutfitPickIso(null);
    setPendingLinkOutfitId(null);
    outfitOriginalUriRef.current = null;
    setStatus("scanning");
  };

  const leaveAddItemsFlow = () => {
    if (router.canDismiss()) router.dismiss();
    else router.back();
  };

  const handleOutfitLeave = useCallback(() => {
    const n = outfitDraftsRef.current.length;
    const hasCaptures = capturedPhotos.length > 0;
    const isProcessing = status === "outfit_processing";
    if (n === 0 && !hasCaptures && !isProcessing) {
      void clearOutfitUploadRecoverySession(uploadUserId);
      outfitRecoverySessionRef.current = null;
      leaveAddItemsFlow();
      return;
    }
    Alert.alert(
      "Leave without saving?",
      n > 0
        ? `${n} look${n === 1 ? "" : "s"} won't be saved to Fits.`
        : "Your photos won't be saved.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            void (async () => {
              if (outfitPersistTimerRef.current) {
                clearTimeout(outfitPersistTimerRef.current);
                outfitPersistTimerRef.current = null;
              }
              await clearOutfitUploadRecoverySession(uploadUserId);
              outfitRecoverySessionRef.current = null;
              syncOutfitDrafts([]);
              replaceOutfitReviewQueue([]);
              setOutfitReviewBatch(null);
              setCapturedPhotos([]);
              suppressRecoveryPrompt();
              leaveAddItemsFlow();
            })();
          },
        },
      ],
    );
  }, [
    capturedPhotos.length,
    replaceOutfitReviewQueue,
    status,
    syncOutfitDrafts,
    uploadUserId,
  ]);

  useEffect(() => {
    handleOutfitLeaveRef.current = handleOutfitLeave;
  }, [handleOutfitLeave]);

  const saveAllOutfitDrafts = useCallback(async () => {
    if (!user?.id || outfitDraftsRef.current.length === 0) {
      Alert.alert("Sign in", "Sign in to save outfits.");
      return;
    }
    setSavingOutfitPhoto(true);
    try {
      await saveOutfitUploadDrafts(user.id, outfitDraftsRef.current);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await clearOutfitUploadRecoverySession(user.id);
      outfitRecoverySessionRef.current = null;
      syncOutfitDrafts([]);
      suppressRecoveryPrompt();
      leaveAddItemsFlow();
    } catch (e) {
      Alert.alert("Save failed", formatUnknownError(e));
    } finally {
      setSavingOutfitPhoto(false);
    }
  }, [router, syncOutfitDrafts, user?.id]);

  const updateOutfitDraft = useCallback(
    (id: string, patch: Partial<OutfitUploadDraft>) => {
      syncOutfitDrafts(
        outfitDraftsRef.current.map((d) =>
          d.id === id ? { ...d, ...patch } : d,
        ),
      );
    },
    [syncOutfitDrafts],
  );

  const finishOutfitDraftReview = useCallback(
    async (draftId: string) => {
      const draft = outfitDraftsRef.current.find((d) => d.id === draftId);
      if (!draft || !user?.id) {
        Alert.alert("Sign in", "Sign in to save outfits.");
        return;
      }
      setSavingOutfitPhoto(true);
      try {
        if (draft.savedOutfitId) {
          const remaining = outfitDraftsRef.current.filter(
            (d) => d.id !== draftId,
          );
          if (remaining.length === 0) {
            await clearOutfitUploadRecoverySession(user.id);
            outfitRecoverySessionRef.current = null;
            syncOutfitDrafts([]);
          } else {
            syncOutfitDrafts(remaining);
            await persistOutfitDraftsToSession(remaining, "review");
          }
          suppressRecoveryPrompt();
          leaveAddItemsFlow();
          return;
        }
        const idx = outfitDraftsRef.current.findIndex((d) => d.id === draftId);
        await saveOutfitUploadDraft(user.id, draft, idx);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const remaining = outfitDraftsRef.current.filter(
          (d) => d.id !== draftId,
        );
        if (remaining.length === 0) {
          await clearOutfitUploadRecoverySession(user.id);
          outfitRecoverySessionRef.current = null;
          syncOutfitDrafts([]);
          suppressRecoveryPrompt();
          leaveAddItemsFlow();
        } else {
          syncOutfitDrafts(remaining);
          await persistOutfitDraftsToSession(remaining, "review");
        }
      } catch (e) {
        Alert.alert("Save failed", formatUnknownError(e));
      } finally {
        setSavingOutfitPhoto(false);
      }
    },
    [persistOutfitDraftsToSession, router, syncOutfitDrafts, user?.id],
  );

  const startOutfitDraftExtract = useCallback(
    async (draftId: string) => {
      const draft = outfitDraftsRef.current.find((d) => d.id === draftId);
      if (!draft || !user?.id || draft.extractScanning) return;
      // Flip to "scanning" FIRST, before the (sometimes slow) outfit-row
      // save below — that save only happens on the very first extract, and
      // while it's in flight extractScanning was still false, so the item
      // strip fell through to its "Scan this look…" empty-state prompt for
      // however long the network call took. Read as a spurious "no items
      // found" flash even though nothing had actually failed yet.
      updateOutfitDraft(draftId, {
        extractScanning: true,
        extractItems: [],
        savedExtractItemIds: undefined,
      });
      setSavingOutfitPhoto(true);
      try {
        let outfitId = draft.savedOutfitId ?? null;
        if (!outfitId) {
          const idx = outfitDraftsRef.current.findIndex((d) => d.id === draftId);
          outfitId = await saveOutfitUploadDraft(user.id, draft, idx);
          updateOutfitDraft(draftId, { savedOutfitId: outfitId });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        if (editIndex !== null) closeConfigureModal();
        prepareOutfitExtractContext(draftId);
        setImage(draft.originalUri);
        setOutfitExtractReviewDraftId(draftId);
        setSavingOutfitPhoto(false);

        const setExtractItems: AiMetaUpdater = (fn) => {
          syncOutfitDrafts(
            outfitDraftsRef.current.map((d) =>
              d.id === draftId
                ? { ...d, extractItems: fn(d.extractItems ?? []) }
                : d,
            ),
          );
        };

        const b64 = await uriToBase64(draft.originalUri);
        const found = await processImageInto(
          b64,
          draft.originalUri,
          setExtractItems,
        );
        updateOutfitDraft(draftId, { extractScanning: false });
        if (found === 0) {
          Alert.alert(
            "No items found",
            "We couldn't pull any pieces out of this look. You can still save the outfit photo on its own.",
          );
        }
      } catch (e) {
        updateOutfitDraft(draftId, { extractScanning: false });
        Alert.alert("Extraction failed", formatUnknownError(e));
      } finally {
        setSavingOutfitPhoto(false);
      }
    },
    [closeConfigureModal, prepareOutfitExtractContext, syncOutfitDrafts, updateOutfitDraft, user?.id],
  );

  const saveOutfitDraftExtractItems = useCallback(
    async (draftId: string) => {
      const draft = outfitDraftsRef.current.find((d) => d.id === draftId);
      const outfitId = draft?.savedOutfitId;
      const items = (draft?.extractItems ?? []).filter(
        (it) => !(it._classifying || it._scanning),
      );
      if (!draft || !outfitId || !user?.id || items.length === 0) return;
      if (!(await confirmLowConfidenceItems(items))) return;

      setSavingOutfitPhoto(true);
      try {
        const session = await persistUploadReviewSession({
          userId: user.id,
          aiMetaList: items,
          imageUri: draft.originalUri,
          linkOutfitId: outfitId,
          existingSession: recoverySessionRef.current,
        });
        if (!session) {
          Alert.alert("Save error", "Could not prepare your upload session.");
          return;
        }
        recoverySessionRef.current = session;
        const { session: updatedSession, insertedIds, allSaved } =
          await saveUploadSessionToCloset(
            session,
            supabase,
            user.id,
            buildClothingItemRow,
          );
        recoverySessionRef.current = updatedSession;
        if (insertedIds.length === 0) {
          Alert.alert("Save error", "Could not save pieces to your closet.");
          return;
        }
        await attachClothingItemsToOutfit(supabase, outfitId, insertedIds);
        DeviceEventEmitter.emit("closetItemsSaved");
        DeviceEventEmitter.emit("outfitItemsExtracted", {
          outfitId,
          itemIds: insertedIds,
        });
        if (allSaved) {
          await clearUploadRecoverySession(user.id);
          recoverySessionRef.current = null;
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Keep extractItems intact — it's what the palette row, item strip,
        // "Review items" button, and footer label all render from. Wiping
        // it to [] here was the bug: the moment you hit Done, the whole
        // pieces UI collapsed back to its never-extracted empty state (and
        // stayed that way on revisit, since this is the persisted draft
        // state), even though the pieces WERE saved. savedExtractItemIds is
        // just the "already saved, don't re-save" gate (see hasUnsavedPieces
        // above) — it doesn't need extractItems cleared to do that job.
        updateOutfitDraft(draftId, {
          savedExtractItemIds: insertedIds,
        });
      } catch (e) {
        Alert.alert("Save failed", formatUnknownError(e));
      } finally {
        setSavingOutfitPhoto(false);
      }
    },
    [updateOutfitDraft, user?.id],
  );

  const removeOutfitDraft = useCallback(
    (id: string) => {
      const next = outfitDraftsRef.current.filter((d) => d.id !== id);
      syncOutfitDrafts(next);
      if (next.length === 0) {
        void clearOutfitUploadRecoverySession(uploadUserId);
        outfitRecoverySessionRef.current = null;
        setStatus("scanning");
      } else {
        void persistOutfitDraftsToSession(next, "review");
      }
    },
    [persistOutfitDraftsToSession, syncOutfitDrafts, uploadUserId],
  );

  const addMoreOutfitPhotos = useCallback(async () => {
    const libPerm = await requestLibraryAccessWithPriming();
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
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: MAX_LIBRARY_PHOTOS,
        orderedSelection: true,
        quality: 0.85,
        base64: false,
      });
    } catch {
      return;
    }
    if (res.canceled || res.assets.length === 0) return;
    const jpegs = await Promise.all(
      res.assets.map((a) => ensureJpegUri(a.uri)),
    );
    await prepareOutfitDraftBatch(jpegs, { append: true });
  }, [prepareOutfitDraftBatch]);

  const handleReviewClose = useCallback(() => {
    const hasUnsavedWork =
      aiMetaList.length > 0 ||
      !!image ||
      !!batchAnalyze ||
      reviewItemsStillLoading ||
      reviewEnhancing;

    if (!hasUnsavedWork) {
      void clearUploadRecoverySession(uploadUserId);
      recoverySessionRef.current = null;
      leaveAddItemsFlow();
      return;
    }

    const n = aiMetaList.length;
    Alert.alert(
      "Leave without saving?",
      n > 0
        ? `${n} item${n === 1 ? "" : "s"} won't be added to your closet.`
        : "Your scan won't be added to your closet.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            void (async () => {
              if (persistReviewTimerRef.current) {
                clearTimeout(persistReviewTimerRef.current);
                persistReviewTimerRef.current = null;
              }
              await clearUploadRecoverySession(uploadUserId);
              recoverySessionRef.current = null;
              suppressRecoveryPrompt();
              leaveAddItemsFlow();
            })();
          },
        },
      ],
    );
  }, [
    aiMetaList.length,
    batchAnalyze,
    image,
    reviewItemsStillLoading,
    reviewEnhancing,
    uploadUserId,
  ]);

  const pickDifferentLibraryPhoto = async () => {
    setImage(null);
    setAiMetaList([]);
    setBatchAnalyze(null);
    setPreviewUri(null);
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    replaceOutfitReviewQueue([]);
    setOutfitReviewBatch(null);
    syncOutfitDrafts([]);
    setOutfitName("");
    setOutfitSchedule("none");
    setOutfitPickIso(null);
    setStatus("scanning");
    await pickImages();
  };

  if (
    isExtractForOutfitMode &&
    aiMetaList.length === 0 &&
    (status === "analyzing" ||
      status === "scanning" ||
      status === "review")
  ) {
    return (
      <View
        style={[
          styles.container,
          {
            justifyContent: "center",
            alignItems: "center",
            paddingHorizontal: 32,
            gap: 12,
          },
        ]}
      >
        <ActivityIndicator size="large" color={Colors.accent} />
        <Text style={styles.extractionTitle}>Extracting pieces…</Text>
        <Text style={styles.extractionSub}>
          Scanning your look photo for individual items.
        </Text>
      </View>
    );
  }

  if (status === "outfit_review" && outfitDrafts.length > 0) {
    return (
      <GestureHandlerRootView style={styles.container}>
        <OutfitUploadReview
          drafts={outfitDrafts}
          saving={savingOutfitPhoto}
          datePickOptions={datePickOptions}
          onClose={handleOutfitLeave}
          onUpdateDraft={updateOutfitDraft}
          onRemoveDraft={removeOutfitDraft}
          onAddPhotos={() => void addMoreOutfitPhotos()}
          onSaveAll={() => void saveAllOutfitDrafts()}
          onFinishDraft={(id) => void finishOutfitDraftReview(id)}
          onStartExtract={(id) => void startOutfitDraftExtract(id)}
          onOpenExtractReview={(id) => openOutfitExtractReview(id)}
          onExtractItemPress={(draftId, idx) => {
            openOutfitExtractReview(draftId);
            if (idx >= 0) openOutfitExtractEdit(draftId, idx);
          }}
          onSaveExtractItems={(id) => void saveOutfitDraftExtractItems(id)}
        />
        {outfitExtractReviewDraftId && image && editIndex === null ? (
          <View
            style={[StyleSheet.absoluteFillObject, { zIndex: 20 }]}
            pointerEvents="box-none"
          >
            <View
              style={[
                styles.reviewWrapper,
                styles.reviewWrapperHost,
                styles.reviewBackdropHost,
                StyleSheet.absoluteFillObject,
              ]}
            >
              <View style={styles.reviewBackdrop}>
                <Image
                  source={{ uri: image }}
                  style={styles.reviewBackdropImage}
                  resizeMode="cover"
                />
                <BlurView
                  intensity={28}
                  tint="light"
                  style={StyleSheet.absoluteFillObject}
                />
              </View>
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
                  keyboardShouldPersistTaps="handled"
                >
                  {renderReviewItemsBody(6, outfitExtractReviewDraftId)}
                </ScrollView>
                <View
                  style={[
                    styles.reviewStickyBar,
                    { paddingBottom: Math.max(insets.bottom, 16) },
                  ]}
                >
                  <TouchableOpacity
                    style={styles.reviewStickySecondary}
                    onPress={closeOutfitExtractReview}
                    disabled={savingOutfitPhoto}
                  >
                    <Text style={styles.reviewStickySecondaryText}>
                      Back to look
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.reviewStickyPrimary,
                      outfitExtractReviewSaveBlocked &&
                        styles.reviewStickyPrimaryDisabled,
                    ]}
                    onPress={() => {
                      if (!outfitExtractReviewDraftId) return;
                      void saveOutfitDraftExtractItems(
                        outfitExtractReviewDraftId,
                      ).then(() => closeOutfitExtractReview());
                    }}
                    disabled={outfitExtractReviewSaveBlocked}
                  >
                    {savingOutfitPhoto ? (
                      <ActivityIndicator color={Colors.white} />
                    ) : (
                      <Text style={styles.reviewStickyPrimaryText}>
                        Add to closet
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        ) : null}
        {editIndex !== null ? (
          <>
            <Modal
              visible
              transparent
              animationType="fade"
              onRequestClose={closeConfigureModal}
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
                  onPress={closeConfigureModal}
                />
                <View
                  style={[
                    styles.uploadEditCard,
                    { paddingBottom: Math.max(insets.bottom, 16) },
                  ]}
                >
                  <ScrollView
                    contentContainerStyle={styles.uploadEditScrollContent}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    automaticallyAdjustKeyboardInsets
                  >
                  <View style={styles.uploadEditHeader}>
                    <Text style={styles.uploadEditTitle}>Configure</Text>
                    <TouchableOpacity
                      onPress={closeConfigureModal}
                      hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                      style={styles.uploadEditCloseBtn}
                    >
                      <ArcClose color={Colors.textMuted} />
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
                    <ColorPickerTriggerIcon size={32} />
                    <Text
                      style={styles.uploadColorTriggerTitle}
                      numberOfLines={1}
                    >
                      {editForm.color?.trim()
                        ? editForm.color
                        : "Choose color"}
                    </Text>
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
                    ).map((season) => {
                      const isOn = editForm.seasons
                        .map((x) => x.toLowerCase())
                        .includes(season.id);
                      return (
                        <TouchableOpacity
                          key={season.id}
                          style={[
                            styles.uploadEditChip,
                            isOn && styles.uploadEditChipOn,
                          ]}
                          onPress={() => {
                            let next: string[];
                            if (season.id === "all") {
                              next = isOn ? [] : ["all"];
                            } else {
                              const withoutAll = editForm.seasons.filter(
                                (x) => x !== "all",
                              );
                              next = isOn
                                ? withoutAll.filter((x) => x !== season.id)
                                : [...withoutAll, season.id];
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
                            {season.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <View style={styles.uploadEditActions}>
                    <TouchableOpacity
                      style={styles.uploadEditCancelBtn}
                      onPress={closeConfigureModal}
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
                </View>
              </View>
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
        ) : null}
        <ManualCropModal
          visible={manualCropIndex !== null}
          imageUri={
            manualCropIndex !== null
              ? (aiMetaList[manualCropIndex]?.originalSourceUri ??
                aiMetaList[manualCropIndex]?.sourceUri ??
                null)
              : null
          }
          initialBox={
            manualCropIndex !== null &&
            Array.isArray(aiMetaList[manualCropIndex]?.box_2d)
              ? (aiMetaList[manualCropIndex]?.box_2d as number[])
              : null
          }
          onCancel={() => setManualCropIndex(null)}
          onSave={handleManualCropSave}
        />
      </GestureHandlerRootView>
    );
  }

  if (!permission) return <View style={styles.container} />;
  if (
    DEV_LOCK_CAMERA_PERMISSION_SCREEN ||
    (uploadSource === "camera" &&
      !permission.granted &&
      !libraryAutoPickPending)
  ) {
    const permissionPermanentlyDenied =
      !DEV_LOCK_CAMERA_PERMISSION_SCREEN && permission.canAskAgain === false;
    const handleCameraPermission = async () => {
      if (DEV_LOCK_CAMERA_PERMISSION_SCREEN) return;
      if (permissionPermanentlyDenied) {
        await Linking.openSettings();
        return;
      }
      const result = await requestPermission();
      if (!result.granted && result.canAskAgain === false) {
        Alert.alert(
          "Camera access is off",
          "You can enable camera access for myOOTD in Settings.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
      }
    };
    const choosePhotosInstead = () => {
      if (DEV_LOCK_CAMERA_PERMISSION_SCREEN) return;
      setUploadSource("library");
      void pickImages();
    };

    return (
      <View
        style={[
          styles.permissionScreen,
          {
            paddingTop: insets.top + 10,
            paddingBottom: Math.max(insets.bottom, 18),
          },
        ]}
      >
        <View style={styles.permissionTopBar}>
          <TouchableOpacity
            style={styles.permissionCloseBtn}
            onPress={() => {
              if (!DEV_LOCK_CAMERA_PERMISSION_SCREEN) router.back();
            }}
            activeOpacity={0.72}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <X size={18} color={Colors.text} strokeWidth={2.4} />
          </TouchableOpacity>
          <Text style={styles.permissionTopTitle}>Add items</Text>
          <View style={styles.permissionTopSpacer} />
        </View>

        <ScrollView
          style={styles.permissionScroll}
          contentContainerStyle={styles.permissionScrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <Text style={styles.permTitle}>
            {permissionPermanentlyDenied
              ? "Camera access is\nturned off"
              : "Let myOOTD use\nyour camera"}
          </Text>
          <Text style={styles.permSub}>
            {permissionPermanentlyDenied
              ? "Re-enable camera access for myOOTD in Settings, then come back to start shooting."
              : "Your device will ask you to confirm."}
          </Text>

          <View style={styles.permCard}>
            <View style={styles.permRow}>
              <View style={styles.permRowIcon}>
                <Camera size={19} color={Colors.text} strokeWidth={2} />
              </View>
              <View style={styles.permRowText}>
                <Text style={styles.permRowTitle}>Snap outfits & pieces</Text>
                <Text style={styles.permRowSub}>
                  Photograph a full look or a single item to add it.
                </Text>
              </View>
            </View>
            <View style={styles.permDivider} />
            <View style={styles.permRow}>
              <View style={styles.permRowIcon}>
                <Shirt size={19} color={Colors.text} strokeWidth={2} />
              </View>
              <View style={styles.permRowText}>
                <Text style={styles.permRowTitle}>Auto-sorted closet</Text>
                <Text style={styles.permRowSub}>
                  We isolate garments and file them for you.
                </Text>
              </View>
            </View>
            <View style={styles.permDivider} />
            <View style={styles.permRow}>
              <View style={styles.permRowIcon}>
                <ShieldCheck size={19} color={Colors.text} strokeWidth={2} />
              </View>
              <View style={styles.permRowText}>
                <Text style={styles.permRowTitle}>Private by default</Text>
                <Text style={styles.permRowSub}>
                  Only you can see your photos — nobody else ever will.
                </Text>
              </View>
            </View>
          </View>
        </ScrollView>

        <View style={styles.permissionFooter}>
          <TouchableOpacity
            style={styles.permissionPrimaryBtn}
            onPress={() => void handleCameraPermission()}
            activeOpacity={0.86}
          >
            <Text style={styles.permissionPrimaryText}>
              {permissionPermanentlyDenied ? "Open Settings" : "Allow camera access"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.permissionSecondaryBtn}
            onPress={choosePhotosInstead}
            activeOpacity={0.8}
          >
            <Images size={17} color={Colors.text} strokeWidth={2.1} />
            <Text style={styles.permissionSecondaryText}>Choose from photos instead</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function renderReviewItemsBody(
    headerPadTop: number,
    extractDraftId?: string | null,
  ) {
    const extractId = extractDraftId ?? null;
    const isOutfitExtractReview = !!extractId;
    if (
      !isOutfitExtractReview &&
      (status !== "review" && status !== "analyzing" || !image)
    ) {
      return null;
    }
    if (isOutfitExtractReview && !image) return null;
    const fallbackPhotoUri = image ?? "";

    const onCloseReview = isOutfitExtractReview
      ? closeOutfitExtractReview
      : handleReviewClose;
    const onRemoveAt = (idx: number) => {
      if (isOutfitExtractReview && extractId) {
        removeOutfitExtractItem(extractId, idx);
      } else {
        removeItem(idx);
      }
    };
    const onConfigureAt = (idx: number) => {
      if (isOutfitExtractReview && extractId) {
        openOutfitExtractEdit(extractId, idx);
      } else {
        openUploadEdit(idx);
      }
    };
    const onEnhanceAt = (idx: number) => {
      if (isOutfitExtractReview && extractId) {
        void enhanceOutfitExtractItem(extractId, idx);
      } else {
        void enhanceItemAtIndex(idx);
      }
    };
    const onAdjustAt = (idx: number) => {
      if (isOutfitExtractReview && extractId) {
        adjustOutfitExtractItem(extractId, idx);
      } else {
        setManualCropIndex(idx);
      }
    };

    return (
      <>
        <View style={[styles.snapReviewHeader, { paddingTop: headerPadTop }]}>
          <View style={styles.reviewHeaderRow}>
            <Text style={styles.snapReviewTitle}>{reviewHeaderTitle}</Text>
            <TouchableOpacity
              onPress={onCloseReview}
              style={styles.reviewCloseBtn}
              hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            >
              <ArcClose color={Colors.textMuted} />
            </TouchableOpacity>
          </View>
          {isOutfitExtractReview || reviewScanSubtitle ? (
            <Text style={styles.snapReviewSubtitle}>
              {isOutfitExtractReview
                ? "Check the details before these hit your closet."
                : reviewScanSubtitle}
            </Text>
          ) : null}
        </View>

        {showScanGapSkeleton && aiMetaList.length === 0 ? (
          <ReviewScanSkeletonCard />
        ) : null}

        {aiMetaList.map((item, idx) => (
          <View key={reviewItemRowKey(item, idx, fallbackPhotoUri)}>
            <ReviewScanItemRow
              item={item}
              idx={idx}
              onRemoveAt={onRemoveAt}
              onConfigureAt={onConfigureAt}
              onEnhanceAt={onEnhanceAt}
              onAdjustAt={onAdjustAt}
            />
          </View>
        ))}

        {showScanGapSkeleton && aiMetaList.length > 0 ? (
          <ReviewScanSkeletonCard />
        ) : null}

        {showReviewAppendLoading && batchAnalyze ? (
          <View style={styles.reviewAppendLoading}>
            <ActivityIndicator color={Colors.accent} size="small" />
            <Text style={styles.reviewAppendLoadingText}>
              {aiMetaList.length > 0
                ? `${aiMetaList.length} found · scanning photo ${Math.min(batchAnalyze.current + 1, batchAnalyze.total)} of ${batchAnalyze.total}…`
                : `Looking for pieces · photo ${Math.min(batchAnalyze.current + 1, batchAnalyze.total)} of ${batchAnalyze.total}`}
            </Text>
          </View>
        ) : null}

        {aiMetaList.length === 0 && !reviewScanActive ? (
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
  }

  const showAppendCameraCapture =
    status === "scanning" &&
    uploadSource === "camera" &&
    !isOutfitMode &&
    !isExtractForOutfitMode;
  const showOutfitCameraCapture =
    status === "scanning" &&
    uploadSource === "camera" &&
    isOutfitMode &&
    !isExtractForOutfitMode;
  const showScanOrIsolateShell =
    status === "outfit_isolating" ||
    status === "outfit_processing" ||
    showAppendCameraCapture ||
    (status === "scanning" && !image) ||
    (status === "analyzing" && aiMetaList.length === 0 && !image) ||
    (status === "review" && isOutfitMode && !isExtractForOutfitMode);
  const showLibraryPassThrough =
    !showAppendCameraCapture &&
    !showOutfitCameraCapture &&
    (uploadSource === "library" ||
      status === "outfit_isolating" ||
      status === "outfit_processing" ||
      isOutfitMode ||
      (status === "scanning" && !!image));

  return (
    <GestureHandlerRootView style={styles.container}>
      {showScanOrIsolateShell ? (
        showLibraryPassThrough ? (
          <View style={styles.libraryPassThrough}>
            {!libraryAutoPickPending &&
              !libraryPickerOpen &&
              (status === "analyzing" ||
                status === "scanning" ||
                status === "outfit_isolating" ||
                status === "outfit_processing" ||
                (status === "review" &&
                  isOutfitMode &&
                  !isExtractForOutfitMode)) && (
              <View
                style={[
                  styles.analyzingSheet,
                  { paddingTop: insets.top },
                  (status === "outfit_isolating" ||
                    status === "outfit_processing") &&
                    styles.outfitIsolateSheet,
                  status === "review" &&
                    isOutfitMode &&
                    !isExtractForOutfitMode &&
                    styles.outfitIsolateSheet,
                ]}
              >
                <View style={styles.analyzingSheetBody}>
                  {status === "outfit_isolating" ||
                  status === "outfit_processing" ||
                  (status === "review" &&
                    isOutfitMode &&
                    !isExtractForOutfitMode) ? (
                    <View style={styles.outfitIsolateCopy}>
                      <Text style={styles.outfitIsolateHeadline}>
                        <Text style={styles.outfitIsolateHeadStrong}>
                          {status === "outfit_processing" ||
                          (status === "review" && isOutfitMode)
                            ? "PREPARING "
                            : "REMOVING "}
                        </Text>
                        <Text style={styles.outfitIsolateHeadSoft}>
                          {status === "outfit_processing" ||
                          (status === "review" && isOutfitMode)
                            ? "YOUR LOOKS"
                            : "BACKGROUND"}
                        </Text>
                      </Text>
                      <Text style={styles.outfitIsolateSub}>
                        {batchAnalyze && batchAnalyze.total > 1
                          ? `Look ${batchAnalyze.current} of ${batchAnalyze.total} — cutting you out for your library.`
                          : "Cutting you out like the main character you are. Stay on the app for a sec."}
                      </Text>
                      {status === "outfit_processing" ||
                      (status === "review" && isOutfitMode) ? (
                        <ActivityIndicator
                          color={Colors.accent}
                          size="large"
                          style={{ marginTop: 16 }}
                        />
                      ) : null}
                    </View>
                  ) : (
                    <>
                      <ActivityIndicator color={Colors.accent} size="large" />
                      <Text style={styles.analyzingTitle}>
                        {status === "scanning"
                          ? "Opening photos…"
                          : isOutfitMode
                            ? "Preparing your look…"
                            : batchAnalyze && batchAnalyze.total > 1
                              ? `Analyzing ${batchAnalyze.total} photos…`
                              : "Extracting items…"}
                      </Text>
                      {status === "analyzing" &&
                      batchAnalyze &&
                      batchAnalyze.total > 1 ? (
                        <Text style={styles.analyzingSub}>
                          Detecting every item in each photo.
                        </Text>
                      ) : null}
                    </>
                  )}
                </View>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.cameraWrapper}>
            <View style={[styles.cameraViewport, { top: insets.top + 10 }]}>
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
                  onPress={closeCamera}
                  style={styles.hudGhostBtn}
                >
                  <ArcClose color="#fff" />
                </TouchableOpacity>

                <View style={styles.hudHeaderLabel}>
                  <Text style={styles.hudHeaderTitle}>Camera</Text>
                  <Text style={styles.hudHeaderSub} numberOfLines={2}>
                    {isOutfitMode
                      ? capturedPhotos.length > 1
                        ? "Each capture becomes one look — Done reviews them in order"
                        : "One full look — saved to Fits"
                      : "Individual pieces or whole outfits"}
                  </Text>
                </View>

                <TouchableOpacity
                  style={[
                    styles.hudGhostBtn,
                    flash !== "off" && styles.hudGhostBtnActive,
                  ]}
                  onPress={() =>
                    setFlash((f) =>
                      f === "off" ? "on" : f === "on" ? "auto" : "off",
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
            (status === "review" || status === "analyzing") &&
              styles.reviewWrapperHost,
            (status === "review" || status === "analyzing") &&
              image &&
              styles.reviewBackdropHost,
          ]}
        >
          {(status === "review" || status === "analyzing") && (
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
                  <View
                    style={[
                      styles.uploadEditCard,
                      { paddingBottom: Math.max(insets.bottom, 16) },
                    ]}
                  >
                    <ScrollView
                      contentContainerStyle={styles.uploadEditScrollContent}
                      showsVerticalScrollIndicator={false}
                      keyboardShouldPersistTaps="handled"
                      automaticallyAdjustKeyboardInsets
                    >
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
                        <ArcClose color={Colors.textMuted} />
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
                      <ColorPickerTriggerIcon size={32} />
                      <Text
                        style={styles.uploadColorTriggerTitle}
                        numberOfLines={1}
                      >
                        {editForm.color?.trim()
                          ? editForm.color
                          : "Choose color"}
                      </Text>
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
                  </View>

                  {/* Nested Modal often fails on Android/iOS while Configure is open — overlay inside this Modal instead */}
                  {previewUri !== null && editIndex !== null
                    ? (() => {
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
                              <TouchableOpacity
                                activeOpacity={1}
                                style={[
                                  StyleSheet.absoluteFill,
                                  bgLight
                                    ? { backgroundColor: Colors.imageLetterbox }
                                    : { backgroundColor: "#000" },
                                ]}
                                onPress={() => setPreviewUri(null)}
                              >
                                <Image
                                  source={{ uri: previewUri }}
                                  style={{
                                    width: windowWidth,
                                    height: windowHeight,
                                  }}
                                  resizeMode="contain"
                                />
                              </TouchableOpacity>
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
                      backgroundColor: Colors.imageLetterbox,
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

          {(status === "review" || status === "analyzing") && image ? (
            <View style={[styles.reviewSheet, { top: insets.top }]}>
              <View style={styles.reviewSheetHandleArea}>
                <View style={styles.dragHandle} />
              </View>
              <ScrollView
                ref={reviewScrollRef}
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
                    reviewSaveBlocked && styles.reviewStickyPrimaryDisabled,
                  ]}
                  onPress={handleAddToCloset}
                  disabled={reviewSaveBlocked}
                >
                  {uploading ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <Text style={styles.reviewStickyPrimaryText}>
                      {activeLinkOutfitId
                        ? "Save & attach to look"
                        : "Save to closet"}
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

              {(status === "review" || status === "analyzing") && !image ? (
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
                        reviewSaveBlocked && styles.reviewStickyPrimaryDisabled,
                      ]}
                      onPress={handleAddToCloset}
                      disabled={reviewSaveBlocked}
                    >
                      {uploading ? (
                        <ActivityIndicator color={Colors.white} />
                      ) : (
                        <Text style={styles.reviewStickyPrimaryText}>
                          {activeLinkOutfitId
                            ? "Save & attach to look"
                            : "Save to closet"}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </>
          )}

          {(status === "review" ||
            status === "analyzing" ||
            status === "done") && (
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
                        stroke={Colors.text}
                        strokeWidth="2"
                        fill="none"
                      />
                      <Circle
                        cx="12"
                        cy="13"
                        r="3.5"
                        stroke={Colors.text}
                        strokeWidth="1.8"
                        fill="none"
                      />
                      <Path
                        d="M9 6l1.5-2h3L15 6"
                        stroke={Colors.text}
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
                        stroke={Colors.text}
                        strokeWidth="2"
                        fill="none"
                      />
                      <Circle cx="8.5" cy="8.5" r="1.5" fill={Colors.text} />
                      <Path
                        d="M21 15L16 10L5 21"
                        stroke={Colors.text}
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

      <ManualCropModal
        visible={manualCropIndex !== null}
        imageUri={
          manualCropIndex !== null
            ? (aiMetaList[manualCropIndex]?.originalSourceUri ??
              aiMetaList[manualCropIndex]?.sourceUri ??
              image ??
              null)
            : null
        }
        initialBox={
          manualCropIndex !== null
            ? Array.isArray(aiMetaList[manualCropIndex]?.box_2d)
              ? (aiMetaList[manualCropIndex]?.box_2d as number[])
              : null
            : null
        }
        onCancel={() => setManualCropIndex(null)}
        onSave={handleManualCropSave}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.homeHeroBackdrop,
  },
  permissionScreen: {
    flex: 1,
    backgroundColor: Colors.homeHeroBackdrop,
  },
  permissionTopBar: {
    height: 48,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  permissionCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.glassFill,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
  },
  permissionTopTitle: {
    fontFamily: Fonts.bold,
    fontSize: 15,
    color: Colors.text,
    letterSpacing: -0.25,
  },
  permissionTopSpacer: {
    width: 36,
  },
  permissionScroll: {
    flex: 1,
  },
  permissionScrollContent: {
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 20,
    alignItems: "stretch",
  },
  permTitle: {
    fontFamily: Fonts.extrabold,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -1.2,
    color: Colors.text,
  },
  permSub: {
    marginTop: 12,
    fontFamily: Fonts.medium,
    fontSize: 15,
    lineHeight: 22,
    color: Colors.textMuted,
    maxWidth: 320,
  },
  permCard: {
    marginTop: 28,
    borderRadius: Editorial.cardRadius,
    backgroundColor: Editorial.cardBg,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
    overflow: "hidden",
  },
  permRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 15,
  },
  permRowIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
  },
  permRowText: {
    flex: 1,
  },
  permRowTitle: {
    fontFamily: Fonts.bold,
    fontSize: 15,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  permRowSub: {
    marginTop: 2,
    fontFamily: Fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.textMuted,
  },
  permDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 15 + 40 + 14,
    backgroundColor: Colors.border,
  },
  permissionFooter: {
    paddingHorizontal: 22,
    paddingTop: 10,
    gap: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  permissionPrimaryBtn: {
    height: 54,
    borderRadius: Radii.full,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    backgroundColor: Colors.accent,
  },
  permissionPrimaryText: {
    flex: 1,
    fontFamily: Fonts.bold,
    fontSize: 15,
    color: Colors.white,
    textAlign: "center",
  },
  permissionSecondaryBtn: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  permissionSecondaryText: {
    fontFamily: Fonts.bold,
    fontSize: 14,
    color: Colors.text,
  },
  cameraWrapper: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.homeHeroBackdrop,
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
    backgroundColor: Colors.homeHeroBackdrop,
  },
  libraryPassThrough: {
    flex: 1,
    backgroundColor: Colors.homeHeroBackdrop,
  },
  outfitIsolateSheet: {
    backgroundColor: Colors.surface,
  },
  outfitIsolateCopy: {
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 28,
    maxWidth: 340,
  },
  outfitIsolateHeadline: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1.6,
    textAlign: "center",
  },
  outfitIsolateHeadStrong: {
    color: Colors.text,
  },
  outfitIsolateHeadSoft: {
    color: Colors.textMuted,
  },
  outfitIsolateSub: {
    fontSize: 15,
    fontWeight: "500",
    lineHeight: 22,
    textAlign: "center",
    color: Colors.textMuted,
  },
  analyzingSheet: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.homeHeroBackdrop,
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
    backgroundColor: Colors.homeHeroBackdrop,
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
    backgroundColor: Colors.homeHeroBackdrop,
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
    backgroundColor: Colors.navBarFillOnWarm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
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
    backgroundColor: Colors.borderStrong,
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
    backgroundColor: Editorial.ghostBg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Editorial.ghostBorder,
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
  isolatedThumb: {
    width: 140,
    alignSelf: "center", // shrinks to image height so card hugs the garment with no bands
    backgroundColor: Colors.imageLetterbox,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 16,
    overflow: "hidden",
    borderRightWidth: 1,
    borderRightColor: Colors.border,
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
  enhanceThumbOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.55)",
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
    backgroundColor: Colors.surfaceElevated,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: Colors.accentDark,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  classifyingMeta: {
    flex: 1,
    paddingTop: 4,
    minHeight: REVIEW_ITEM_META_MIN_HEIGHT,
  },
  classifyingLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textMuted,
    letterSpacing: 0.3,
    marginBottom: 10,
  },
  shimmerLine: {
    height: 14,
    width: "80%",
    borderRadius: 7,
    backgroundColor: Colors.surfaceInset,
  },
  scanSkeletonBlock: {
    backgroundColor: Colors.surfaceInset,
  },
  snapItemCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: Editorial.cardBg,
    borderRadius: Editorial.cardRadius,
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
    minHeight: 212,
    shadowColor: Colors.accentDark,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  snapItemMainPressable: {
    flexDirection: "row",
    minHeight: 160,
    flex: 1,
  },
  snapItemActionsBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 10,
    alignItems: "flex-end",
    backgroundColor: Editorial.cardBgMuted,
  },
  snapItemThumb: {
    width: 138,
    height: 160,
    backgroundColor: Colors.homeHeroBackdrop,
    overflow: "hidden",
  },
  snapItemThumbInner: {
    width: 138,
    height: 160,
  },
  snapItemMeta: {
    flex: 1,
    padding: 12,
    flexDirection: "column",
    minHeight: REVIEW_ITEM_META_MIN_HEIGHT,
  },
  snapItemMetaBody: {
    flex: 1,
    minHeight: REVIEW_ITEM_META_MIN_HEIGHT - 24,
  },
  snapItemTrashBtn: {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 1,
  },
  snapItemName: {
    fontSize: 15,
    fontWeight: "800",
    color: Colors.text,
    marginTop: 0,
    marginBottom: 6,
    paddingRight: 28,
    lineHeight: 20,
    flexShrink: 1,
  },
  snapItemCatPill: {
    alignSelf: "flex-start",
    backgroundColor: Editorial.chipBg,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Editorial.chipBorder,
  },
  snapItemCatText: {
    fontSize: 9,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.6,
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
    borderColor: Colors.borderStrong,
  },
  snapItemColorText: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textLight,
    textTransform: "capitalize",
  },
  snapItemOccRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginBottom: 8,
  },
  snapItemOccChip: {
    backgroundColor: Editorial.ghostBg,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: Editorial.ghostBorder,
  },
  snapItemOccChipText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textMuted,
    textTransform: "capitalize",
  },
  snapItemSeasonLine: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.textMuted,
    marginTop: 4,
    textTransform: "capitalize",
  },
  snapItemLowConfidenceChip: {
    alignSelf: "flex-start",
    marginTop: 6,
    backgroundColor: "rgba(214, 138, 0, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(214, 138, 0, 0.35)",
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  snapItemLowConfidenceText: {
    fontSize: 10.5,
    fontWeight: "700",
    color: "#9A6A00",
  },
  snapItemActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  snapItemActionsRowPending: {
    opacity: 0.32,
  },
  snapEnhanceBtn: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.surfaceElevated,
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
  snapAdjustBtn: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.surfaceElevated,
    minWidth: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  snapAdjustBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
  },
  snapConfigureBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  snapConfigureBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.white,
  },
  reviewAppendLoading: {
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 20,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: Editorial.cardBgMuted,
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
    backgroundColor: Colors.navBarFillOnWarm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  reviewStickySecondary: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.surfaceElevated,
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
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 52,
  },
  reviewStickyPrimaryDisabled: {
    opacity: 0.4,
  },
  reviewStickyPrimaryText: {
    color: Colors.white,
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
    width: "100%",
    maxWidth: 600,
    maxHeight: "88%",
    alignSelf: "center",
    backgroundColor: Colors.navBarFillOnWarm,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: Colors.border,
  },
  uploadEditScrollContent: {
    paddingBottom: 4,
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
    backgroundColor: Colors.borderStrong,
  },
  carouselDotActive: {
    backgroundColor: Colors.accent,
  },
  uploadEditHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  uploadEditTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: Colors.text,
  },
  uploadEditCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Editorial.ghostBg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Editorial.ghostBorder,
  },
  uploadEditLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  uploadEditInput: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.text,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  uploadEditChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 10,
  },
  uploadEditChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Editorial.ghostBg,
    borderWidth: 1.5,
    borderColor: Editorial.ghostBorder,
  },
  uploadEditChipOn: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  uploadEditChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textMuted,
  },
  uploadEditChipTextOn: {
    color: Colors.white,
  },
  uploadColorTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    marginBottom: 10,
  },
  uploadColorTriggerTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
  },
  uploadOccasionGrid: {
    gap: 8,
    marginBottom: 8,
  },
  uploadOccasionGroupLabel: {
    fontSize: 8,
    fontWeight: "900",
    color: Colors.textMuted,
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
    backgroundColor: Editorial.ghostBg,
    borderWidth: 1,
    borderColor: Editorial.ghostBorder,
  },
  uploadOccChipOn: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  uploadOccChipText: {
    fontSize: 9,
    fontWeight: "800",
    color: Colors.textMuted,
    textTransform: "uppercase",
  },
  uploadOccChipTextOn: {
    color: Colors.white,
  },
  uploadEditActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  uploadEditCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    alignItems: "center",
    backgroundColor: Colors.surfaceElevated,
  },
  uploadEditCancelText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.text,
  },
  uploadEditSaveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Colors.accent,
    alignItems: "center",
  },
  uploadEditSaveText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.white,
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
    backgroundColor: Colors.accent,
  },
  pillBtnText: {
    color: Colors.white,
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
    textAlign: "center",
  },
  extractionSub: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  reviewCard: {
    padding: 20,
    borderRadius: Editorial.cardRadius,
    backgroundColor: Editorial.cardBg,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
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
    color: Colors.textMuted,
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
    backgroundColor: Editorial.ghostBg,
    borderWidth: 1,
    borderColor: Editorial.ghostBorder,
  },
  miniChipActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  miniChipText: {
    fontSize: 9,
    fontWeight: "800",
    color: Colors.textMuted,
    textTransform: "uppercase",
  },
  miniChipTextActive: {
    color: Colors.white,
  },
  metaRow: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 8,
  },
  metaValueSmall: {
    fontSize: 11,
    color: Colors.textMuted,
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
  snapItemDots: {
    position: "absolute",
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 4,
    zIndex: 10,
  },
  snapItemDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "rgba(255,255,255,0.4)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
  },
  snapItemDotActive: {
    backgroundColor: Colors.accent,
    width: 6,
    height: 6,
    borderRadius: 3,
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
    color: Colors.white,
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
    backgroundColor: Editorial.cardBg,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
    shadowColor: Colors.accentDark,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 6,
  },
  doneKicker: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Editorial.chipBg,
    borderWidth: 1,
    borderColor: Editorial.chipBorder,
  },
  doneKickerText: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.textMuted,
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
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  donePrimaryBtnText: {
    color: Colors.white,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  doneSecondaryBtn: {
    width: "100%",
    minHeight: 54,
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.surfaceElevated,
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
    backgroundColor: Colors.navBarFillOnWarm,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 14,
    borderTopWidth: 1,
    borderColor: Colors.border,
    shadowColor: Colors.accentDark,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 20,
  },
  sheetHandle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.borderStrong,
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
    borderTopColor: Colors.border,
  },
  sheetOptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: Editorial.cardBgMuted,
    borderWidth: 1,
    borderColor: Editorial.cardBorderSubtle,
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

  outfitReviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  outfitReviewTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: Colors.text,
  },
  outfitReviewSub: {
    fontSize: 13,
    color: Colors.textMuted,
    marginBottom: 16,
    lineHeight: 18,
  },
  outfitBatchProgress: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 10,
    marginTop: -4,
  },
  outfitReviewHero: {
    width: "100%",
    aspectRatio: 0.75,
    borderRadius: Editorial.cardRadius,
    overflow: "hidden",
    backgroundColor: Colors.imageLetterbox,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  outfitReviewHeroImg: {
    width: "100%",
    height: "100%",
  },
  outfitFieldLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 1.2,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  outfitNameInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
    marginBottom: 18,
    backgroundColor: Colors.surface,
  },
  outfitWearHint: {
    fontSize: 13,
    fontWeight: "500",
    color: Colors.textMuted,
    lineHeight: 18,
    marginTop: -4,
    marginBottom: 12,
  },
  outfitScheduleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 24,
  },
  outfitSchedChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Editorial.ghostBg,
    borderWidth: 1,
    borderColor: Editorial.ghostBorder,
  },
  outfitSchedChipOn: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  outfitSchedChipText: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.text,
  },
  outfitSchedChipTextOn: {
    color: Colors.white,
  },
  outfitSkipBtn: {
    alignItems: "center",
    paddingVertical: 14,
    marginBottom: 4,
  },
  outfitSkipBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.textMuted,
  },
  outfitExtractBtn: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  outfitExtractBtnText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: "800",
  },
  outfitSaveBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  outfitSaveBtnText: {
    color: Colors.white,
    fontSize: 16,
    fontWeight: "800",
  },
  outfitDateModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  outfitDateModalSheet: {
    backgroundColor: Colors.navBarFillOnWarm,
    borderRadius: 18,
    padding: 16,
    maxHeight: "70%",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  outfitDateModalTitle: {
    fontSize: 17,
    fontWeight: "800",
    marginBottom: 12,
    color: Colors.text,
  },
  outfitDateRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  outfitDateRowText: {
    fontSize: 16,
    fontWeight: "600",
    color: Colors.text,
  },
  outfitDateCancel: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 12,
  },
  outfitDateCancelText: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.textMuted,
  },
});
