import { useUser } from "@clerk/clerk-expo";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import {
    ArrowLeft,
    CalendarDays,
    Check,
    ChevronDown,
    ChevronUp,
    Plus,
    Shirt,
    Sparkles,
    Wand2,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LinearGradient } from "expo-linear-gradient";
import {
    ActivityIndicator,
    Dimensions,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import {
    Gesture,
    GestureDetector,
    GestureHandlerRootView,
    TouchableOpacity as GHTouchableOpacity,
    ScrollView,
} from "react-native-gesture-handler";
import Animated, {
    Easing,
    FadeIn,
    FadeInDown,
    interpolate,
    runOnJS,
    runOnUI,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSpring,
    withTiming,
    ZoomIn,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { apiClient } from "../../constants/api-client";
import { Colors, Radii, Typography } from "../../constants/AppTheme";
import { DEV_DEMO_BUILDER_ITEMS } from "../../lib/devFitSeeds";
import { supabase } from "../../lib/supabase";
import CalendarSheet from "./CalendarSheet";
import {
    isBagItem,
    isBottomLike,
    isDressLike,
    isOuterItem,
    isShoeItem,
    isTopLike,
    itemMatchesPickerCategory,
} from "./closetCategories";
import ClosetPicker from "./ClosetPicker";
import ClosetPickerPanel, { CategoryChipRow } from "./ClosetPickerPanel";
import OutfitCanvas, { type GenerationPhase } from "./OutfitCanvas";
import type { BuilderItem, ClosetItem } from "./types";
import { OCC_LABEL } from "./types";

const MIN_SHEET_RATIO = 0.4;
const MAX_SHEET_RATIO = 0.78;

const { width: SW, height: SH } = Dimensions.get("window");

type SurfaceMode = "playground" | "manual";
type PickerPurpose = "anchors" | "manual";

type SurpriseCard = {
  id: string;
  title: string;
  occasionId: string;
  items: BuilderItem[];
  imageUri: string | null;
  status: "loading" | "ready" | "error";
};

const SURPRISE_TRIPLE = ["casual", "date-night", "work"] as const;

/** Playground + card theme accents (Aesty-like soft labels). */
const OCC_THEMES: Record<string, { label: string; accent: string; soft: string }> = {
  casual: { label: "Casual Friday", accent: "#5B7FE8", soft: "rgba(91,127,232,0.16)" },
  "date-night": { label: "Date Night", accent: "#D9668C", soft: "rgba(217,102,140,0.16)" },
  work: { label: "Office Ready", accent: "#5C6B7A", soft: "rgba(92,107,122,0.18)" },
};

function themeForOccasion(occId: string) {
  return (
    OCC_THEMES[occId] ?? {
      label: OCC_LABEL[occId] ?? "Your look",
      accent: Colors.textMuted,
      soft: "rgba(0,0,0,0.06)",
    }
  );
}

function SurpriseSkeletonCard({ index }: { index: number }) {
  const pulse = useSharedValue(0.92);
  const shimmerX = useSharedValue(-SW * 0.5);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    shimmerX.value = withRepeat(
      withTiming(SW * 1.2, { duration: 2200, easing: Easing.linear }),
      -1,
      false,
    );
  }, [pulse, shimmerX]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulse.value * 0.55 + 0.38,
  }));

  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerX.value }],
  }));

  return (
    <Animated.View
      entering={FadeIn.delay(index * 70).duration(320)}
      style={[skeletonStyles.outer, pulseStyle]}
    >
      <View style={skeletonStyles.frame}>
        <LinearGradient
          colors={["#E8EAEF", "#F4F5F8", "#E8EAEF"]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={[skeletonStyles.shimmerWrap, shimmerStyle]} pointerEvents="none">
          <LinearGradient
            colors={["transparent", "rgba(255,255,255,0.65)", "transparent"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ width: SW * 0.55, height: "100%" }}
          />
        </Animated.View>
      </View>
      <View style={skeletonStyles.bar} />
    </Animated.View>
  );
}

const skeletonStyles = StyleSheet.create({
  outer: {
    width: SW - 14,
    alignSelf: "center",
    marginBottom: 26,
  },
  frame: {
    width: "100%",
    aspectRatio: 4 / 5,
    borderRadius: 32,
    overflow: "hidden",
    backgroundColor: "#E8EAEF",
  },
  shimmerWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
  },
  bar: {
    marginTop: 14,
    alignSelf: "center",
    width: "42%",
    height: 14,
    borderRadius: 7,
    backgroundColor: "rgba(0,0,0,0.06)",
  },
});

function parseOutfitDataUri(dataUri: string): { buffer: ArrayBuffer; contentType: string } | null {
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

function SurpriseCardView({
  card,
  index,
  onOpen,
}: {
  card: SurpriseCard;
  index: number;
  onOpen: (c: SurpriseCard) => void;
}) {
  const theme = themeForOccasion(card.occasionId);
  const scale = useSharedValue(1);
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const skPulse = useSharedValue(0.94);
  const skShimmer = useSharedValue(-SW * 0.4);
  useEffect(() => {
    if (card.status !== "loading") return;
    skPulse.value = withRepeat(
      withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    skShimmer.value = withRepeat(
      withTiming(SW * 1.1, { duration: 2000, easing: Easing.linear }),
      -1,
      false,
    );
  }, [card.status, skPulse, skShimmer]);

  const inlineSkPulse = useAnimatedStyle(() => ({
    opacity: interpolate(skPulse.value, [0.94, 1], [0.5, 0.72]),
  }));
  const inlineSkShim = useAnimatedStyle(() => ({
    transform: [{ translateX: skShimmer.value }],
  }));

  return (
    <Pressable
      onPressIn={() => {
        scale.value = withSpring(0.978, { damping: 18, stiffness: 420 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 340 });
      }}
      disabled={card.status !== "ready"}
      onPress={() => onOpen(card)}
    >
      <Animated.View
        entering={ZoomIn.delay(Math.min(index * 95, 380))
          .springify()
          .damping(16)
          .stiffness(200)}
        style={[surpriseCardStyles.outer, cardStyle]}
      >
        <Animated.View
          entering={FadeIn.delay(Math.min(index * 80, 320)).duration(380)}
          style={surpriseCardStyles.themePillWrap}
        >
          <View style={[surpriseCardStyles.themePill, { backgroundColor: theme.soft }]}>
            <View style={[surpriseCardStyles.themeDot, { backgroundColor: theme.accent }]} />
            <Text style={[surpriseCardStyles.themePillText, { color: theme.accent }]}>
              {theme.label}
            </Text>
          </View>
        </Animated.View>
        <View style={surpriseCardStyles.frame}>
          {card.status === "loading" ? (
            <Animated.View style={[StyleSheet.absoluteFillObject, inlineSkPulse]}>
              <LinearGradient
                colors={["#E4E7ED", "#F0F2F6", "#E4E7ED"]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
              <Animated.View style={[surpriseCardStyles.cardShimmerWrap, inlineSkShim]}>
                <LinearGradient
                  colors={["transparent", "rgba(255,255,255,0.55)", "transparent"]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={{ width: SW * 0.5, height: "100%" }}
                />
              </Animated.View>
            </Animated.View>
          ) : card.status === "error" ? (
            <View style={surpriseCardStyles.loadingBox}>
              <Text style={surpriseCardStyles.err}>Could not create</Text>
            </View>
          ) : card.imageUri ? (
            <Image
              source={{ uri: card.imageUri }}
              style={surpriseCardStyles.hero}
              resizeMode="cover"
            />
          ) : (
            <View style={surpriseCardStyles.loadingBox}>
              <Shirt size={40} color={Colors.textMuted} strokeWidth={1.5} />
            </View>
          )}
        </View>
        <Text style={surpriseCardStyles.title} numberOfLines={1}>
          {card.title}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const surpriseCardStyles = StyleSheet.create({
  outer: {
    width: SW - 14,
    alignSelf: "center",
    marginBottom: 30,
  },
  themePillWrap: { marginBottom: 10, alignItems: "center" },
  themePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radii.full,
  },
  themeDot: { width: 7, height: 7, borderRadius: 4 },
  themePillText: {
    fontSize: 13,
    fontWeight: Typography.weights.bold,
    letterSpacing: 0.2,
  },
  frame: {
    width: "100%",
    aspectRatio: 4 / 5,
    borderRadius: 32,
    overflow: "hidden",
    backgroundColor: Colors.fitsBuilderCanvas,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.14,
    shadowRadius: 32,
    elevation: 12,
  },
  cardShimmerWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
  },
  hero: { width: "100%", height: "100%" },
  loadingBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 220,
  },
  err: { fontSize: 14, color: Colors.textMuted, fontWeight: Typography.weights.semibold },
  title: {
    marginTop: 14,
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.35,
    textAlign: "center",
  },
});

interface Props {
  closetItems: ClosetItem[];
  loadingCloset: boolean;
  onSavedFit: () => void;
  userId: string | undefined;
}

function ManualCategoryAddGlyph({ category }: { category: string }) {
  const stroke = "rgba(0,0,0,0.55)";

  if (category === "All") {
    return <Plus size={26} color={Colors.textMuted} strokeWidth={2.1} />;
  }

  const plusBadge = (
    <View style={manualGlyphStyles.plusBadge}>
      <Plus size={11} color="#fff" strokeWidth={2.6} />
    </View>
  );

  let icon: React.ReactNode;
  switch (category) {
    case "Tops":
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          <Path
            d="M8 5L12 7L16 5L20 8V11L17.5 10V19H6.5V10L4 11V8L8 5Z"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
      break;
    case "Bottoms":
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          <Path
            d="M7 4H17L16 20H12.8L12 12L11.2 20H8L7 4Z"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
      break;
    case "Full Body":
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          <Path
            d="M9 4.5L12 6.2L15 4.5L17.5 7.2L15.2 10.2L16.7 19H7.3L8.8 10.2L6.5 7.2L9 4.5Z"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M10.8 9.8H13.2"
            stroke={stroke}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </Svg>
      );
      break;
    case "Outerwear":
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          {/* Jacket body + Long Sleeves */}
          <Path
            d="M8 4H16L19 7L21 14L19 15L17 11V20H7V11L5 15L3 14L5 7L8 4Z"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Center zipper */}
          <Path
            d="M12 4V20"
            stroke={stroke}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          {/* Collar detail */}
          <Path
            d="M9 4L12 7L15 4"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
      break;
    case "Shoes":
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          <Path
            d="M4 15C8 15 9.5 12 11 9C12.2 10.8 13.7 12.4 16.2 13.2L20 14.5V18H4V15Z"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
      break;
    case "Bags":
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          <Rect
            x="5"
            y="8"
            width="14"
            height="11"
            rx="3"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
          />
          <Path
            d="M9 8V7A3 3 0 0 1 15 7V8"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
          />
        </Svg>
      );
      break;
    default:
      icon = (
        <Svg width="28" height="28" viewBox="0 0 24 24">
          <Circle
            cx="9"
            cy="12"
            r="3"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
          />
          <Circle
            cx="15"
            cy="12"
            r="3"
            stroke={stroke}
            strokeWidth="1.8"
            fill="none"
          />
          <Path
            d="M12 12H12.01"
            stroke={stroke}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <Path
            d="M6 12H4.5M19.5 12H18"
            stroke={stroke}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </Svg>
      );
      break;
  }

  return (
    <View style={manualGlyphStyles.wrap}>
      <View style={manualGlyphStyles.iconWrap}>{icon}</View>
      {plusBadge}
    </View>
  );
}

const manualGlyphStyles = StyleSheet.create({
  wrap: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrap: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  plusBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.black,
    alignItems: "center",
    justifyContent: "center",
  },
});

export default function BuilderPanel({
  closetItems,
  loadingCloset,
  onSavedFit,
  userId,
}: Props) {
  const router = useRouter();
  const { user } = useUser();
  const insets = useSafeAreaInsets();
  const tabBarH = useBottomTabBarHeight();
  const bottomChromePad =
    tabBarH > 0 ? tabBarH + 8 : 52 + Math.max(insets.bottom, 10) + 8;

  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("playground");
  const [surpriseCards, setSurpriseCards] = useState<SurpriseCard[]>([]);
  const [resultOpen, setResultOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [tryOnSheetOpen, setTryOnSheetOpen] = useState(false);
  const activeSurpriseIdRef = useRef<string | null>(null);
  const resultShineX = useSharedValue(-SW * 0.5);
  const resultShineGuardRef = useRef(false);
  const surpriseOkRef = useRef(0);
  const phantomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [phantomSkeletonCount, setPhantomSkeletonCount] = useState(0);
  const [resultMountKey, setResultMountKey] = useState(0);
  const [resultImageLoading, setResultImageLoading] = useState(false);
  const [resultUsesBody, setResultUsesBody] = useState(false);
  const [mannequinFallbackUri, setMannequinFallbackUri] = useState<string | null>(
    null,
  );

  const [builderItems, setBuilderItems] = useState<BuilderItem[]>([]);
  const [selectedOccasionId, setSelectedOccasionId] = useState<string | null>(
    null,
  );
  const [generationPhase, setGenerationPhase] =
    useState<GenerationPhase>("idle");
  const [saving, setSaving] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [plannedDate, setPlannedDate] = useState<Date | null>(null);
  const [fitName, setFitName] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPurpose, setPickerPurpose] = useState<PickerPurpose>("manual");
  const [pickerFilterCategory, setPickerFilterCategory] = useState<
    string | undefined
  >();
  const [manualCategory, setManualCategory] = useState("All");
  const [manualSearch, setManualSearch] = useState("");
  const [manualExpanded, setManualExpanded] = useState(false);
  const [seedItemIds, setSeedItemIds] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [hasGenerated, setHasGenerated] = useState(false);
  const [heroImageUri, setHeroImageUri] = useState<string | null>(null);
  /** After "Try On" generation completes, show inline save controls. */
  const [manualReadyToSave, setManualReadyToSave] = useState(false);
  /** Cached body photo URL from profiles table. */
  const [bodyPhotoUrl, setBodyPhotoUrl] = useState<string | null>(null);
  const [bodyPhotoChecked, setBodyPhotoChecked] = useState(false);

  const builderItemIds = useMemo(
    () => new Set(builderItems.map((i) => i.id)),
    [builderItems],
  );
  const hasItems = builderItems.length > 0;
  const filteredManualItems = useMemo(
    () =>
      closetItems.filter((i) => itemMatchesPickerCategory(i, manualCategory)),
    [closetItems, manualCategory],
  );

  const minSheet = useSharedValue(SH * MIN_SHEET_RATIO);
  const maxSheet = useSharedValue(SH * MAX_SHEET_RATIO);
  const sheetH = useSharedValue(SH * MIN_SHEET_RATIO);
  const startSheetH = useSharedValue(0);

  useEffect(() => {
    const isManual = surfaceMode === "manual";
    const minS = SH * MIN_SHEET_RATIO;
    const maxS = SH * MAX_SHEET_RATIO;

    minSheet.value = minS;
    maxSheet.value = maxS;

    if (isManual && !manualExpanded) {
      sheetH.value = withTiming(minS, { duration: 180 });
    } else {
      sheetH.value = withTiming(Math.min(maxS, Math.max(minS, sheetH.value)), {
        duration: 180,
      });
    }
  }, [surfaceMode, manualExpanded, minSheet, maxSheet, sheetH]);

  useEffect(() => {
    if (builderItems.length === 0) setManualReadyToSave(false);
  }, [builderItems.length]);

  useEffect(() => {
    if (!user?.id || bodyPhotoChecked) return;
    (async () => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("body_photo_url")
          .eq("user_id", user.id)
          .single();
        if (data?.body_photo_url) setBodyPhotoUrl(data.body_photo_url);
      } catch {
        /* profile may not exist */
      } finally {
        setBodyPhotoChecked(true);
      }
    })();
  }, [user?.id, bodyPhotoChecked]);

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    height: sheetH.value,
  }));

  const snapSheet = useCallback(
    (expand: boolean) => {
      if (surfaceMode === "manual") setManualExpanded(expand);
      runOnUI((ex: boolean) => {
        "worklet";
        sheetH.value = withTiming(ex ? maxSheet.value : minSheet.value, {
          duration: 180,
        });
      })(expand);
    },
    [sheetH, minSheet, maxSheet, surfaceMode],
  );

  const toggleSheetSnap = useCallback(() => {
    runOnUI(() => {
      "worklet";
      const mid = (minSheet.value + maxSheet.value) / 2;
      const expand = sheetH.value < mid;
      sheetH.value = withTiming(expand ? maxSheet.value : minSheet.value, {
        duration: 180,
      });
      if (surfaceMode === "manual") runOnJS(setManualExpanded)(expand);
    })();
  }, [sheetH, minSheet, maxSheet, surfaceMode]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-8, 8])
        .onBegin(() => {
          startSheetH.value = sheetH.value;
        })
        .onUpdate((e) => {
          const next = startSheetH.value - e.translationY;
          sheetH.value = Math.min(
            maxSheet.value,
            Math.max(minSheet.value, next),
          );
        })
        .onEnd((e) => {
          const mid = (minSheet.value + maxSheet.value) / 2;
          if (e.velocityY < -500) {
            sheetH.value = withTiming(maxSheet.value, { duration: 170 });
            if (surfaceMode === "manual") runOnJS(setManualExpanded)(true);
          } else if (e.velocityY > 500) {
            sheetH.value = withTiming(minSheet.value, { duration: 170 });
            if (surfaceMode === "manual") runOnJS(setManualExpanded)(false);
          } else {
            const expand = sheetH.value >= mid;
            sheetH.value = withTiming(
              expand ? maxSheet.value : minSheet.value,
              { duration: 170 },
            );
            if (surfaceMode === "manual") runOnJS(setManualExpanded)(expand);
          }
        }),
    [surfaceMode],
  );

  const occasionForSave = useCallback(() => {
    if (selectedOccasionId) return selectedOccasionId;
    return null;
  }, [selectedOccasionId]);

  const clearRender = () => setHeroImageUri(null);

  const handleRemoveItem = (slot: number) => {
    clearRender();
    setHasGenerated(false);
    setManualReadyToSave(false);
    setBuilderItems((prev) =>
      prev.filter((p) => p.slot !== slot).map((p, i) => ({ ...p, slot: i })),
    );
  };

  const handlePickItemManual = (id: string) => {
    clearRender();
    setHasGenerated(false);
    setManualReadyToSave(false);
    setBuilderItems((prev) => {
      const existing = prev.find((p) => p.id === id);
      if (existing) {
        return prev
          .filter((p) => p.id !== id)
          .map((p, i) => ({ ...p, slot: i }));
      }
      const item = closetItems.find((c) => c.id === id);
      if (!item) return prev;

      let next = [...prev];
      if (isDressLike(item)) {
        next = next.filter(
          (p) => !isDressLike(p) && !isTopLike(p) && !isBottomLike(p),
        );
      } else if (isTopLike(item)) {
        next = next.filter((p) => !isTopLike(p) && !isDressLike(p));
      } else if (isBottomLike(item)) {
        next = next.filter((p) => !isBottomLike(p) && !isDressLike(p));
      } else if (isOuterItem(item)) {
        next = next.filter((p) => !isOuterItem(p));
      } else if (isShoeItem(item)) {
        next = next.filter((p) => !isShoeItem(p));
      } else if (isBagItem(item)) {
        next = next.filter((p) => !isBagItem(p));
      }

      if (next.length >= 6) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return prev;
      }
      return [...next, { ...item, slot: next.length }].map((p, i) => ({
        ...p,
        slot: i,
      }));
    });
  };

  const toggleSeed = (id: string) => {
    setSeedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const itemsForAi = useMemo(
    () =>
      closetItems.map((c) => ({
        id: c.id,
        name: c.name ?? undefined,
        type: c.type ?? undefined,
        category: c.category || "other",
        color: c.color ?? undefined,
        style: c.style ?? undefined,
        occasions: c.occasions ?? undefined,
      })),
    [closetItems],
  );

  const mapIdsToBuilderItems = useCallback(
    (ids: string[]): BuilderItem[] => {
      const mapped: BuilderItem[] = [];
      let slot = 0;
      for (const id of ids) {
        const it = closetItems.find((c) => c.id === id);
        if (it && slot < 6) {
          mapped.push({ ...it, slot });
          slot++;
        }
      }
      return mapped;
    },
    [closetItems],
  );

  const runOneSurprise = useCallback(
    async (cardId: string, occId: string) => {
      const occLabel = OCC_LABEL[occId] ?? occId;
      try {
        const anchors = Array.from(seedItemIds);
        const result = await apiClient.generateOutfits({
          occasion: occLabel,
          items: itemsForAi,
          anchorItemIds: anchors.length ? anchors : undefined,
          extraInstructions: prompt.trim() || undefined,
        });
        const mapped = mapIdsToBuilderItems(result.item_ids);
        if (mapped.length === 0) throw new Error("No valid items");

        const renderUri = await apiClient.generateOutfitImage({
          occasion: occLabel,
          backdropHex: Colors.fitsBuilderCanvas,
          outfitItems: mapped.map((m) => ({
            name: m.name ?? undefined,
            color: m.color ?? undefined,
            category: m.category ?? undefined,
            type: m.type ?? undefined,
          })),
        });

        setSurpriseCards((prev) =>
          prev.map((c) =>
            c.id === cardId
              ? {
                  ...c,
                  title: result.title?.trim() || occLabel,
                  items: mapped,
                  imageUri: renderUri,
                  status: "ready" as const,
                }
              : c,
          ),
        );
        surpriseOkRef.current += 1;
      } catch {
        setSurpriseCards((prev) =>
          prev.map((c) => (c.id === cardId ? { ...c, status: "error" as const } : c)),
        );
      }
    },
    [itemsForAi, mapIdsToBuilderItems, prompt, seedItemIds],
  );

  const runSurpriseBatch = useCallback(
    (triple: boolean, singleOccId?: string) => {
      if (closetItems.length === 0) {
        setToastMsg("Add pieces to your closet first");
        return;
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (phantomTimerRef.current) clearTimeout(phantomTimerRef.current);
      const occIds = triple
        ? [...SURPRISE_TRIPLE]
        : [singleOccId ?? "casual"];
      surpriseOkRef.current = 0;
      setSurpriseCards([]);
      setPhantomSkeletonCount(occIds.length);
      setGenerationPhase("rendering");
      phantomTimerRef.current = setTimeout(() => {
        phantomTimerRef.current = null;
        const cards: SurpriseCard[] = occIds.map((occId) => ({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          title: OCC_LABEL[occId] ?? occId,
          occasionId: occId,
          items: [],
          imageUri: null,
          status: "loading",
        }));
        setPhantomSkeletonCount(0);
        setSurpriseCards(cards);
        void Promise.all(cards.map((c) => runOneSurprise(c.id, c.occasionId))).finally(() => {
          setGenerationPhase("idle");
          if (surpriseOkRef.current > 0) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        });
      }, 260);
    },
    [closetItems.length, runOneSurprise],
  );

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3200);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(
    () => () => {
      if (phantomTimerRef.current) clearTimeout(phantomTimerRef.current);
    },
    [],
  );

  const resultShineStyle = useAnimatedStyle(() => ({
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    width: SW * 0.38,
    transform: [{ translateX: resultShineX.value }],
    opacity: 0.42,
  }));

  const triggerSoftResultShine = useCallback(() => {
    if (resultShineGuardRef.current) return;
    resultShineGuardRef.current = true;
    resultShineX.value = -SW * 0.42;
    resultShineX.value = withTiming(SW * 0.88, {
      duration: 680,
      easing: Easing.out(Easing.cubic),
    });
  }, [resultShineX]);

  useEffect(() => {
    if (!resultOpen) resultShineGuardRef.current = false;
  }, [resultOpen]);

  /** Convert a remote or local image URL to base64. */
  const urlToBase64 = async (url: string): Promise<string | undefined> => {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUri = reader.result as string;
          resolve(dataUri.split(",")[1] ?? dataUri);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  };

  /**
   * @param photoUrlOverride – pass a URL directly (e.g. freshly-uploaded photo) to
   *   avoid the state-lag of `bodyPhotoUrl` which hasn't re-rendered yet.
   */
  const runTryOnGeneration = useCallback(
    async (withBodyPhoto: boolean, photoUrlOverride?: string) => {
      if (builderItems.length === 0) return;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setGenerationPhase("rendering");

      try {
        let base64: string | undefined;
        if (withBodyPhoto) {
          const url = photoUrlOverride || bodyPhotoUrl;
          if (url) base64 = await urlToBase64(url);
        }

        const occ =
          OCC_LABEL[selectedOccasionId ?? ""] ?? selectedOccasionId ?? "casual";
        const renderUri = await apiClient.generateOutfitImage({
          occasion: occ,
          backdropHex: Colors.fitsBuilderCanvas,
          bodyPhotoBase64: base64,
          outfitItems: builderItems.map((m) => ({
            name: m.name ?? undefined,
            color: m.color ?? undefined,
            category: m.category ?? undefined,
            type: m.type ?? undefined,
          })),
        });

        if (renderUri) {
          setHeroImageUri(renderUri);
          setResultUsesBody(!!base64 && withBodyPhoto);
          const sid = activeSurpriseIdRef.current;
          if (sid) {
            setSurpriseCards((prev) =>
              prev.map((c) => (c.id === sid ? { ...c, imageUri: renderUri } : c)),
            );
          }
        }
        setGenerationPhase("idle");
        setHasGenerated(true);
        setManualReadyToSave(true);
        setFitName((prev) => {
          if (prev.trim()) return prev;
          const first = builderItems[0];
          if (!first) return "My fit";
          return (first.name || first.category || "Outfit").trim().slice(0, 38);
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setTryOnSheetOpen(false);
      } catch (e: unknown) {
        setGenerationPhase("idle");
        setToastMsg(e instanceof Error ? e.message : "Could not render. Try again.");
      }
    },
    [builderItems, bodyPhotoUrl, selectedOccasionId],
  );

  const pickBodyPhotoAndTryOn = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [9, 16],
        quality: 0.8,
      });
      if (result.canceled) {
        setTryOnSheetOpen(false);
        return;
      }
      const img = result.assets[0]!;
      const resp = await fetch(img.uri);
      const blob = await resp.blob();
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
      const fileName = `body_${user?.id ?? "anon"}_${Date.now()}.jpg`;
      const { error: storageError } = await supabase.storage
        .from("body-photos")
        .upload(fileName, arrayBuffer, {
          contentType: "image/jpeg",
          upsert: true,
        });
      let newUrl: string | undefined;
      if (!storageError && user?.id) {
        const {
          data: { publicUrl },
        } = supabase.storage.from("body-photos").getPublicUrl(fileName);
        await supabase.from("profiles").upsert(
          {
            user_id: user.id,
            body_photo_url: publicUrl,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
        setBodyPhotoUrl(publicUrl);
        newUrl = publicUrl;
      }
      void runTryOnGeneration(true, newUrl);
    } catch {
      setToastMsg("Could not use that photo");
      setTryOnSheetOpen(false);
    }
  }, [runTryOnGeneration, user?.id]);

  const handleTryOn = useCallback(() => {
    if (builderItems.length === 0) return;
    setTryOnSheetOpen(true);
  }, [builderItems.length]);

  const uploadHeroForOutfit = async (uri: string | null): Promise<string | null> => {
    if (!uri || !userId) return null;
    if (uri.startsWith("http")) return uri;
    if (!uri.startsWith("data:")) return null;
    const parts = parseOutfitDataUri(uri);
    if (!parts) return null;
    const ext = parts.contentType.includes("png") ? "png" : "jpg";
    const fileName = `outfit_${userId.slice(0, 8)}_${Date.now()}.${ext}`;
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
    setHasGenerated(false);
    setSeedItemIds(new Set());
    setPrompt("");
    setManualReadyToSave(false);
    clearRender();
    setResultOpen(false);
    activeSurpriseIdRef.current = null;
    setSurpriseCards([]);
  };

  const handleSave = async () => {
    if (!userId || builderItems.length === 0) return;
    if (builderItems.some((i) => i.id.startsWith("dev-"))) {
      setToastMsg("Swap demo pieces for real closet items to save");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSaving(true);
    try {
      const occ = occasionForSave();
      const imageUrl = await uploadHeroForOutfit(heroImageUri);
      const { error } = await supabase.from("outfits").insert({
        user_id: userId,
        name: fitName.trim() || "My fit",
        occasion: occ,
        planned_date: plannedDate
          ? plannedDate.toISOString().split("T")[0]
          : null,
        image_url: imageUrl,
        items: builderItems.map((i) => i.id),
      });
      if (error) throw error;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      resetAfterSave();
      onSavedFit();
    } catch {
      setToastMsg("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const openPicker = (purpose: PickerPurpose, filterCat?: string) => {
    setPickerPurpose(purpose);
    setPickerFilterCategory(filterCat);
    setPickerOpen(true);
    snapSheet(true);
  };

  const promptAddNewItem = useCallback(
    (category: string) => {
      const params = category === "All" ? {} : { categoryHint: category };
      router.push({ pathname: "/upload", params });
    },
    [router],
  );

  const showInlineSave = surfaceMode === "manual" && manualReadyToSave;
  const sheetBottomPad =
    surfaceMode === "manual" && !manualExpanded
      ? 0
      : bottomChromePad + 8;

  const expandManualCloset = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setManualExpanded(true);
    runOnUI(() => {
      "worklet";
      sheetH.value = withTiming(maxSheet.value, { duration: 200 });
    })();
  }, [sheetH, maxSheet]);

  const openResultFromCard = useCallback(
    (card: SurpriseCard) => {
      if (card.status !== "ready" || card.items.length === 0) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      activeSurpriseIdRef.current = card.id;
      setBuilderItems(card.items);
      setSelectedOccasionId(card.occasionId);
      setFitName(card.title);
      setMannequinFallbackUri(card.imageUri);
      setResultUsesBody(false);
      setHeroImageUri(card.imageUri);
      setHasGenerated(true);
      setManualReadyToSave(true);
      setResultMountKey((k) => k + 1);
      setResultOpen(true);

      const hasBody = !!(bodyPhotoUrl && bodyPhotoChecked);
      if (hasBody) {
        setResultImageLoading(true);
        void (async () => {
          try {
            const b64 = await urlToBase64(bodyPhotoUrl);
            if (!b64) throw new Error("no photo");
            const occ = OCC_LABEL[card.occasionId] ?? card.occasionId;
            const uri = await apiClient.generateOutfitImage({
              occasion: occ,
              backdropHex: Colors.fitsBuilderCanvas,
              bodyPhotoBase64: b64,
              outfitItems: card.items.map((m) => ({
                name: m.name ?? undefined,
                color: m.color ?? undefined,
                category: m.category ?? undefined,
                type: m.type ?? undefined,
              })),
            });
            if (uri) {
              setHeroImageUri(uri);
              setResultUsesBody(true);
              setSurpriseCards((prev) =>
                prev.map((c) => (c.id === card.id ? { ...c, imageUri: uri } : c)),
              );
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          } catch {
            setToastMsg("Showing mannequin — couldn't render on you");
          } finally {
            setResultImageLoading(false);
            triggerSoftResultShine();
          }
        })();
      } else {
        requestAnimationFrame(() => triggerSoftResultShine());
      }
    },
    [bodyPhotoUrl, bodyPhotoChecked, triggerSoftResultShine],
  );

  const closeResultModal = useCallback(() => {
    setResultOpen(false);
    setResultImageLoading(false);
    setMannequinFallbackUri(null);
    activeSurpriseIdRef.current = null;
  }, []);

  const manualHeaderEl = (
    <TouchableOpacity
      style={s.backPlayRow}
      onPress={() => {
        Haptics.selectionAsync();
        setSurfaceMode("playground");
        setManualExpanded(false);
        snapSheet(false);
        setBuilderItems([]);
        clearRender();
        setHasGenerated(false);
        setManualReadyToSave(false);
        setSelectedOccasionId(null);
      }}
      activeOpacity={0.85}
    >
      <ArrowLeft size={20} color={Colors.text} strokeWidth={2.2} />
      <Text style={s.backPlayText}>Playground</Text>
    </TouchableOpacity>
  );

  // ─── Manual mode elements ────────────────────────────────────────────────────

  const manualCategoryTabsEl = (
    <CategoryChipRow
      category={manualCategory}
      onCategoryChange={(c) => {
        Haptics.selectionAsync();
        setManualCategory(c);
      }}
      contentContainerStyle={s.manualTabs}
    />
  );

  const manualHorizontalStripEl = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.manualItems}
      bounces={false}
    >
      <TouchableOpacity
        style={s.manualAddBtn}
        onPress={() => promptAddNewItem(manualCategory)}
      >
        <ManualCategoryAddGlyph category={manualCategory} />
        {manualCategory !== "All" ? (
          <Text style={s.manualAddHint} numberOfLines={1}>
            Add {manualCategory}
          </Text>
        ) : null}
      </TouchableOpacity>
      {filteredManualItems.map((item) => {
        const isSelected = builderItemIds.has(item.id);
        return (
          <TouchableOpacity
            key={item.id}
            onPress={() => {
              Haptics.selectionAsync();
              handlePickItemManual(item.id);
            }}
            style={[s.manualItem, isSelected && s.manualItemActive]}
          >
            {item.image_url ? (
              <Image
                source={{ uri: item.image_url }}
                style={s.manualItemImg}
                resizeMode="contain"
              />
            ) : (
              <Shirt size={28} color={Colors.textMuted} strokeWidth={1.5} />
            )}
            {isSelected && (
              <View style={s.manualItemCheck}>
                <Check size={10} color="#fff" strokeWidth={3} />
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <GestureHandlerRootView style={s.wrap}>
      <View style={s.wrap}>
        {surfaceMode === "playground" ? (
          <View style={s.playgroundRoot}>
            <ScrollView
              style={s.playScroll}
              contentContainerStyle={[
                s.playScrollContent,
                { paddingBottom: bottomChromePad + 100 },
              ]}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              bounces
            >
              <View style={{ height: insets.top + 28 }} />
              <Text style={s.pgTitle}>Find your next look</Text>
              <View style={s.playgroundHeroSpacer} />
              <TouchableOpacity
                style={[
                  s.surpriseHeroBtn,
                  (generationPhase !== "idle" || loadingCloset) && s.surpriseHeroBtnOff,
                ]}
                onPress={() => runSurpriseBatch(true)}
                disabled={generationPhase !== "idle" || loadingCloset}
                activeOpacity={0.92}
              >
                {generationPhase !== "idle" ? (
                  <ActivityIndicator color="#fff" size="large" />
                ) : (
                  <>
                    <Wand2 size={26} color="#fff" strokeWidth={2.2} />
                    <Text style={s.surpriseHeroLabel}>Surprise me</Text>
                  </>
                )}
              </TouchableOpacity>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.quickChipRow}
                bounces={false}
              >
                {(
                  [
                    { occ: "date-night" as const, label: "Tonight" },
                    { occ: "casual" as const, label: "Easy day" },
                    { occ: "work" as const, label: "Work" },
                  ] as const
                ).map(({ occ, label }) => {
                  const th = themeForOccasion(occ);
                  return (
                    <TouchableOpacity
                      key={occ}
                      style={[
                        s.quickChip,
                        {
                          backgroundColor: th.soft,
                          borderColor: `${th.accent}40`,
                        },
                      ]}
                      onPress={() => runSurpriseBatch(false, occ)}
                      disabled={generationPhase !== "idle"}
                      activeOpacity={0.88}
                    >
                      <Text style={[s.quickChipText, { color: th.accent }]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <View style={s.playgroundPinRow}>
                <Text style={s.playgroundPinLabel}>Pin must-haves</Text>
                <TouchableOpacity
                  style={s.playgroundPinAdd}
                  onPress={() => openPicker("anchors")}
                >
                  <Plus size={16} color={Colors.text} strokeWidth={2.5} />
                </TouchableOpacity>
              </View>
              {seedItemIds.size > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.pinRow}
                >
                  {Array.from(seedItemIds).map((id) => {
                    const item = closetItems.find((c) => c.id === id);
                    if (!item) return null;
                    return (
                      <TouchableOpacity
                        key={id}
                        style={s.pinThumb}
                        onPress={() => toggleSeed(id)}
                      >
                        {item.image_url ? (
                          <Image
                            source={{ uri: item.image_url }}
                            style={s.pinImg}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={s.pinImgEmpty}>
                            <Shirt size={12} color={Colors.textMuted} strokeWidth={1.5} />
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : null}

              <TextInput
                style={s.playNotes}
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Note for AI (optional)"
                placeholderTextColor="rgba(0,0,0,0.25)"
                maxLength={160}
                returnKeyType="done"
              />

              {phantomSkeletonCount > 0
                ? Array.from({ length: phantomSkeletonCount }, (_, i) => (
                    <SurpriseSkeletonCard key={`ph-${i}`} index={i} />
                  ))
                : null}
              {surpriseCards.map((card, index) => (
                <SurpriseCardView
                  key={card.id}
                  card={card}
                  index={index}
                  onOpen={openResultFromCard}
                />
              ))}
            </ScrollView>

            <TouchableOpacity
              style={[s.buildScratchBtn, { bottom: bottomChromePad + 8 }]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSurfaceMode("manual");
                setManualExpanded(false);
                snapSheet(false);
                setBuilderItems([]);
                clearRender();
                setHasGenerated(false);
                setManualReadyToSave(false);
              }}
              activeOpacity={0.88}
            >
              <Text style={s.buildScratchText}>Build from scratch</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={s.preview}>
              <OutfitCanvas
                items={builderItems}
                generationPhase={generationPhase}
                onRemoveItem={handleRemoveItem}
                onShuffle={undefined}
                canShuffle={false}
                heroImageUri={heroImageUri}
                onClearHero={() => {
                  clearRender();
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                manualModeHint
                manualGridCollage
                showManualAddPlaceholder={false}
                tryOnVisible={
                  hasItems &&
                  !manualReadyToSave &&
                  !heroImageUri &&
                  generationPhase === "idle"
                }
                onTryOn={handleTryOn}
                manualEditVisible={
                  hasItems &&
                  manualReadyToSave &&
                  generationPhase === "idle"
                }
                onManualEditOutfit={() => {
                  Haptics.selectionAsync();
                  setManualReadyToSave(false);
                  clearRender();
                  setHasGenerated(false);
                }}
              />
            </View>

            <Animated.View
              style={[
                s.sheet,
                sheetAnimatedStyle,
                { paddingBottom: bottomChromePad },
              ]}
            >
              <GestureDetector gesture={panGesture}>
                <View style={s.sheetDragHeader}>
                  <View style={s.handleWrap}>
                    <View style={s.handle} />
                  </View>
                  <GHTouchableOpacity
                    style={s.expandHint}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      if (!manualExpanded) expandManualCloset();
                      else toggleSheetSnap();
                    }}
                    activeOpacity={0.8}
                  >
                    <ChevronUp size={14} color={Colors.textMuted} strokeWidth={2} />
                    <Text style={s.expandHintText}>
                      {!manualExpanded ? "Pull up for closet" : "Drag to resize"}
                    </Text>
                    <ChevronDown size={14} color={Colors.textMuted} strokeWidth={2} />
                  </GHTouchableOpacity>
                </View>
              </GestureDetector>

              {manualHeaderEl}

              {__DEV__ ? (
                <TouchableOpacity
                  style={s.devDemoBtn}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setSurfaceMode("manual");
                    setManualExpanded(false);
                    snapSheet(false);
                    clearRender();
                    setHasGenerated(false);
                    setBuilderItems(DEV_DEMO_BUILDER_ITEMS.map((x) => ({ ...x })));
                    setManualReadyToSave(true);
                    setFitName((n) => (n.trim() ? n : "Demo outfit"));
                    setSelectedOccasionId("casual");
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={s.devDemoBtnText}>Load demo outfit (dev)</Text>
                </TouchableOpacity>
              ) : null}

              <KeyboardAvoidingView
                style={s.sheetBody}
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
              >
                {showInlineSave ? (
                  <View style={s.inlineSavePanel}>
                    <Text style={s.inlineSaveTitle}>Save your look</Text>
                    <TextInput
                      style={s.inlineSaveInput}
                      value={fitName}
                      onChangeText={setFitName}
                      placeholder="Name this fit..."
                      placeholderTextColor="rgba(0,0,0,0.25)"
                      maxLength={40}
                      returnKeyType="done"
                    />
                    <View style={s.inlineSaveRow}>
                      <TouchableOpacity
                        style={s.inlinePlanBtn}
                        onPress={() => setCalendarOpen(true)}
                        activeOpacity={0.8}
                      >
                        <CalendarDays
                          size={15}
                          color={plannedDate ? Colors.text : Colors.textMuted}
                          strokeWidth={2}
                        />
                        <Text
                          style={[
                            s.inlinePlanLabel,
                            plannedDate && s.inlinePlanLabelActive,
                          ]}
                        >
                          {plannedDate
                            ? plannedDate.toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })
                            : "Plan day"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[s.inlineSaveBtn, saving && { opacity: 0.5 }]}
                        onPress={handleSave}
                        disabled={saving}
                        activeOpacity={0.86}
                      >
                        {saving ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Text style={s.inlineSaveLabel}>Save to library</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : manualExpanded ? (
                  <View style={s.manualExpandedPanel}>
                    <ClosetPickerPanel
                      variant="embedded"
                      showHeader
                      onDone={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setManualSearch("");
                        snapSheet(false);
                      }}
                      items={closetItems}
                      selected={builderItemIds}
                      onToggle={handlePickItemManual}
                      mode="manual"
                      category={manualCategory}
                      onCategoryChange={(c) => {
                        Haptics.selectionAsync();
                        setManualCategory(c);
                      }}
                      search={manualSearch}
                      onSearchChange={setManualSearch}
                      contentBottomPad={sheetBottomPad}
                    />
                  </View>
                ) : (
                  <View style={[s.manualBuilder, s.manualBuilderCollapsed]}>
                    {manualCategoryTabsEl}
                    {manualHorizontalStripEl}
                  </View>
                )}
              </KeyboardAvoidingView>
            </Animated.View>
          </>
        )}

        {toastMsg ? (
          <Animated.View entering={FadeInDown.duration(280)} style={s.toastBanner}>
            <Text style={s.toastBannerText}>{toastMsg}</Text>
          </Animated.View>
        ) : null}

        <Modal
          visible={resultOpen}
          animationType="fade"
          presentationStyle="fullScreen"
          onRequestClose={closeResultModal}
        >
          <View style={s.resultRoot}>
            <Animated.View
              key={resultMountKey}
              entering={ZoomIn.duration(320).springify().damping(17).stiffness(200)}
              style={s.resultZoomWrap}
            >
              <View style={s.resultHeroFlex}>
                {heroImageUri ? (
                  <Image
                    source={{ uri: heroImageUri }}
                    style={s.resultHero}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={s.resultHeroEmpty} />
                )}
              </View>
              <Animated.View style={resultShineStyle} pointerEvents="none">
                <LinearGradient
                  colors={["transparent", "rgba(255,255,255,0.14)", "transparent"]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={{ width: 100, height: "100%" }}
                />
              </Animated.View>

              {resultImageLoading ? (
                <View style={s.resultLoadingOverlay} pointerEvents="none">
                  <ActivityIndicator color="#fff" size="large" />
                </View>
              ) : null}

              <View style={[s.resultTopBar, { paddingTop: insets.top + 8 }]}>
                <TouchableOpacity style={s.resultClose} onPress={closeResultModal}>
                  <Text style={s.resultCloseText}>✕</Text>
                </TouchableOpacity>
                <View style={{ flex: 1 }} />
                <TouchableOpacity
                  style={s.resultPlanIconBtn}
                  onPress={() => setCalendarOpen(true)}
                  hitSlop={12}
                >
                  <CalendarDays size={20} color="rgba(255,255,255,0.9)" strokeWidth={2} />
                </TouchableOpacity>
              </View>

              <View style={[s.resultHeroMeta, { top: insets.top + 52 }]}>
                <View style={{ flex: 1 }} />
                <View style={s.resultHeroMetaCol}>
                  {resultUsesBody ? (
                    <View style={s.resultOnMeBadge}>
                      <Sparkles size={12} color="rgba(255,255,255,0.95)" strokeWidth={2} />
                      <Text style={s.resultOnMeBadgeText}>On me</Text>
                    </View>
                  ) : null}
                  {resultUsesBody && mannequinFallbackUri ? (
                    <TouchableOpacity
                      onPress={() => {
                        Haptics.selectionAsync();
                        setHeroImageUri(mannequinFallbackUri);
                        setResultUsesBody(false);
                      }}
                      hitSlop={8}
                    >
                      <Text style={s.resultSwitchMannequinText}>Switch to mannequin</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              <View style={[s.resultActions, { paddingBottom: bottomChromePad + 12 }]}>
                <TextInput
                  style={s.resultNameInput}
                  value={fitName}
                  onChangeText={setFitName}
                  placeholder="Name this look"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                />
                <TouchableOpacity
                  style={s.resultPrimaryBtn}
                  onPress={() => void handleSave()}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator color="#000" />
                  ) : (
                    <Text style={s.resultPrimaryBtnText}>Save to library</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.resultSecondaryBtn}
                  onPress={() => {
                    closeResultModal();
                    runSurpriseBatch(true);
                  }}
                >
                  <Text style={s.resultSecondaryBtnText}>Try another</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.resultEditHint}
                  onPress={() => {
                    closeResultModal();
                    setSurfaceMode("manual");
                    expandManualCloset();
                  }}
                >
                  <Text style={s.resultEditHintText}>Edit this look</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          </View>
        </Modal>

        <Modal
          visible={tryOnSheetOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setTryOnSheetOpen(false)}
        >
          <View style={s.trySheetWrap}>
            <Pressable style={s.trySheetBackdrop} onPress={() => setTryOnSheetOpen(false)} />
            <View style={[s.trySheetPanel, { paddingBottom: bottomChromePad + 16 }]}>
              <Text style={s.trySheetTitle}>Try on</Text>
              {bodyPhotoUrl ? (
                <>
                  <TouchableOpacity
                    style={s.trySheetRow}
                    onPress={() => void runTryOnGeneration(true)}
                  >
                    <Text style={s.trySheetRowText}>On me</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.trySheetRow}
                    onPress={() => void runTryOnGeneration(false)}
                  >
                    <Text style={s.trySheetRowMuted}>Switch to mannequin</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.trySheetRow}
                    onPress={() => void pickBodyPhotoAndTryOn()}
                  >
                    <Text style={s.trySheetRowMuted}>Change body photo</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity
                    style={s.trySheetRow}
                    onPress={() => void pickBodyPhotoAndTryOn()}
                  >
                    <Text style={s.trySheetRowText}>Add body photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.trySheetRow}
                    onPress={() => void runTryOnGeneration(false)}
                  >
                    <Text style={s.trySheetRowMuted}>Use mannequin</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity
                style={s.trySheetCancel}
                onPress={() => setTryOnSheetOpen(false)}
              >
                <Text style={s.trySheetCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {pickerOpen && (
          <ClosetPicker
            items={closetItems}
            selected={
              pickerPurpose === "anchors" ? seedItemIds : builderItemIds
            }
            onToggle={
              pickerPurpose === "anchors" ? toggleSeed : handlePickItemManual
            }
            onClose={() => setPickerOpen(false)}
            mode={pickerPurpose}
            initialCategory={pickerFilterCategory}
          />
        )}

        <CalendarSheet
          visible={calendarOpen}
          onClose={() => setCalendarOpen(false)}
          onSelectDate={(d) => {
            setPlannedDate(d);
            setCalendarOpen(false);
          }}
        />
      </View>
    </GestureHandlerRootView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap: { flex: 1 },
  playgroundRoot: { flex: 1, backgroundColor: Colors.bg },
  playScroll: { flex: 1 },
  playScrollContent: { paddingHorizontal: 24 },
  pgTitle: {
    fontSize: 32,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.8,
    marginBottom: 0,
  },
  playgroundHeroSpacer: {
    minHeight: 48,
    marginBottom: 8,
  },
  surpriseHeroBtn: {
    height: 64,
    borderRadius: Radii.full,
    backgroundColor: Colors.black,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    marginBottom: 28,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 8,
  },
  surpriseHeroBtnOff: { opacity: 0.45 },
  surpriseHeroLabel: {
    fontSize: 18,
    fontWeight: Typography.weights.bold,
    color: "#fff",
    letterSpacing: -0.3,
  },
  quickChipRow: { gap: 12, paddingVertical: 8, paddingBottom: 28 },
  quickChip: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: Radii.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  quickChipText: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  playgroundPinRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  playgroundPinLabel: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  playgroundPinAdd: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  playNotes: {
    marginTop: 6,
    marginBottom: 20,
    height: 44,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    fontSize: 14,
    backgroundColor: Colors.surface,
    color: Colors.text,
  },
  buildScratchBtn: {
    position: "absolute",
    left: 24,
    right: 24,
    paddingVertical: 14,
    alignItems: "center",
    borderRadius: Radii.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  buildScratchText: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  backPlayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  backPlayText: {
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  toastBanner: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 96,
    backgroundColor: "rgba(0,0,0,0.9)",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    zIndex: 80,
    alignItems: "center",
  },
  toastBannerText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    textAlign: "center",
  },
  resultRoot: { flex: 1, backgroundColor: "#000" },
  resultZoomWrap: { flex: 1 },
  resultHeroFlex: { flex: 1, backgroundColor: "#000" },
  resultHero: { width: "100%", height: "100%" },
  resultHeroEmpty: { flex: 1, backgroundColor: "#0a0a0a" },
  resultTopBar: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    zIndex: 30,
  },
  resultClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  resultPlanIconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  resultCloseText: { color: "#fff", fontSize: 18, fontWeight: "300" },
  resultLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 22,
  },
  resultHeroMeta: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    paddingHorizontal: 16,
    zIndex: 19,
    pointerEvents: "box-none",
  },
  resultHeroMetaCol: { alignItems: "flex-end", gap: 8 },
  resultOnMeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radii.full,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.22)",
  },
  resultOnMeBadgeText: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: "rgba(255,255,255,0.95)",
    letterSpacing: 0.3,
  },
  resultSwitchMannequinText: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: "rgba(255,255,255,0.72)",
    textDecorationLine: "underline",
  },
  resultActions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    paddingTop: 20,
    backgroundColor: "rgba(0,0,0,0.55)",
    zIndex: 24,
  },
  resultNameInput: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.25)",
    color: "#fff",
    fontSize: 17,
    fontWeight: Typography.weights.semibold,
    paddingVertical: 10,
    marginBottom: 10,
  },
  resultPrimaryBtn: {
    height: 56,
    borderRadius: Radii.full,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
    marginBottom: 12,
  },
  resultPrimaryBtnText: {
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: "#000",
  },
  resultSecondaryBtn: {
    height: 50,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  resultSecondaryBtnText: {
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: "#fff",
  },
  resultEditHint: { alignItems: "center", paddingVertical: 10 },
  resultEditHintText: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: "rgba(255,255,255,0.5)",
  },
  trySheetWrap: { flex: 1, justifyContent: "flex-end" },
  trySheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  trySheetPanel: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  trySheetTitle: {
    fontSize: 18,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    marginBottom: 14,
    textAlign: "center",
  },
  trySheetRow: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  trySheetRowText: {
    fontSize: 16,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
    textAlign: "center",
  },
  trySheetRowMuted: {
    fontSize: 15,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
    textAlign: "center",
  },
  trySheetCancel: { paddingVertical: 16, alignItems: "center" },
  trySheetCancelText: {
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  preview: {
    flex: 1,
    width: "100%",
    overflow: "hidden",
  },

  sheet: {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: Colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 12,
    overflow: "hidden",
  },
  sheetDragHeader: { flexShrink: 0 },
  sheetBody: { flex: 1, minHeight: 0 },
  handleWrap: { alignItems: "center", paddingTop: 8, paddingBottom: 4 },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  expandHint: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingBottom: 8,
  },
  expandHintText: {
    fontSize: 11,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
  },

  // ── Mode toggle ────────────────────────────────────────────────────────────

  modeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  modeChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  modeChipOn: {
    backgroundColor: Colors.black,
    borderColor: Colors.black,
  },
  modeChipText: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  modeChipTextOn: { color: "#fff" },

  // ── Shared scroll ──────────────────────────────────────────────────────────

  sheetScroll: { flex: 1 },
  sheetScrollContent: { flexGrow: 1 },

  // ── Auto (AI) panel ────────────────────────────────────────────────────────

  occGroupBlock: {
    marginBottom: 10,
  },
  occGroupLabel: {
    fontSize: 10,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  occGroupRow: {
    paddingHorizontal: 16,
    gap: 8,
  },
  occChip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  occChipOn: {
    backgroundColor: Colors.black,
    borderColor: Colors.black,
  },
  occChipText: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  occChipTextOn: { color: "#fff" },

  pinSection: {
    paddingHorizontal: 16,
    marginTop: 4,
    marginBottom: 10,
  },
  pinHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  pinLabel: {
    fontSize: 10,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  pinAddBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radii.full,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pinAddBtnText: {
    fontSize: 11,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  pinRow: {
    gap: 8,
  },
  pinThumb: {
    width: 44,
    height: 44,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pinImg: { width: "100%", height: "100%" },
  pinImgEmpty: {
    flex: 1,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },

  notesSection: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  notesInput: {
    height: 44,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radii.sm,
    paddingHorizontal: 14,
    fontSize: 14,
    backgroundColor: Colors.surfaceAlt,
    color: Colors.text,
  },

  generateBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 52,
    borderRadius: Radii.full,
    backgroundColor: Colors.black,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  generateBtnOff: { opacity: 0.35 },
  generateLabel: {
    fontSize: 16,
    fontWeight: Typography.weights.bold,
    color: "#fff",
    letterSpacing: -0.2,
  },

  // ── Manual panel ───────────────────────────────────────────────────────────

  manualExpandedPanel: {
    flex: 1,
    minHeight: 0,
  },
  manualBuilder: {
    paddingBottom: 16,
  },
  manualBuilderCollapsed: {
    paddingBottom: 10,
  },
  manualTabs: {
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  manualItems: {
    paddingHorizontal: 16,
    gap: 12,
    paddingBottom: 6,
  },
  manualAddBtn: {
    width: 80,
    height: 100,
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceAlt,
    gap: 8,
  },
  manualAddHint: {
    fontSize: 10,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    textAlign: "center",
    paddingHorizontal: 6,
  },
  manualItem: {
    width: 80,
    height: 100,
    borderRadius: 16,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "transparent",
  },
  manualItemActive: {
    borderColor: Colors.black,
  },
  manualItemImg: {
    width: "100%",
    height: "100%",
  },
  manualItemCheck: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.black,
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

  devDemoBtn: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 10,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: "dashed",
    alignItems: "center",
    backgroundColor: Colors.surfaceAlt,
  },
  devDemoBtnText: {
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
});
