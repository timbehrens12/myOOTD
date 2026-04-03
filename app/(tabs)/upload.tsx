/**
 * Add piece — Aesty-style single-photo flow:
 * fullscreen hero → in-place enhance (blur + progress + shimmer) → clean cut-out on neutral bg.
 * Minimal chrome; background Supabase save; snap route redirects here.
 */
import { useUser } from "@clerk/clerk-expo";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Check, ChevronDown, ChevronLeft, ChevronUp, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import IosStyleColorPickerModal from "../../components/color-picker/IosStyleColorPickerModal";
import ZoomedItemThumb from "../../components/ZoomedItemThumb";
import { apiClient } from "../../constants/api-client";
import { APP_ITEM_NAMED_COLORS } from "../../constants/appNamedColors";
import { Colors, Radii, Typography } from "../../constants/AppTheme";
import { OCCASION_GROUPS } from "../../constants/occasions";
import { ensureJpegUri } from "../../lib/ensureJpegForVision";
import { queueClosetToast } from "../../lib/closetToast";
import { isolateClothing } from "../../modules/clothing-isolator/src";
import { supabase } from "../../lib/supabase";

const { width: SW, height: SH } = Dimensions.get("window");
const NEUTRAL = Colors.fitsBuilderCanvas;

const ALLOWED_STYLE_IDS = new Set([
  "casual",
  "office",
  "street",
  "evening",
  "sporty",
  "preppy",
  "minimalist",
  "romantic",
  "edgy",
]);

const STYLE_OPTIONS: { id: string; label: string }[] = [
  { id: "casual", label: "Casual" },
  { id: "office", label: "Office" },
  { id: "street", label: "Street" },
  { id: "evening", label: "Evening" },
  { id: "sporty", label: "Sporty" },
  { id: "preppy", label: "Preppy" },
  { id: "minimalist", label: "Minimal" },
  { id: "romantic", label: "Romantic" },
  { id: "edgy", label: "Edgy" },
];

const CATEGORY_OPTIONS: { id: string; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
  { id: "shoes", label: "Shoes" },
  { id: "outerwear", label: "Outer" },
  { id: "accessory", label: "Accessory" },
  { id: "bag", label: "Bag" },
  { id: "full body", label: "Full body" },
  { id: "other", label: "Other" },
];

function normalizeCategorySlug(raw?: string): string {
  const x = (raw ?? "other").toLowerCase().trim();
  return CATEGORY_OPTIONS.some((c) => c.id === x) ? x : "other";
}

function sanitizeStyleTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["casual"];
  const out = raw
    .map((v) => String(v).toLowerCase().trim())
    .filter((id) => ALLOWED_STYLE_IDS.has(id));
  return out.length ? [...new Set(out)].slice(0, 3) : ["casual"];
}

function swatchForItemColor(name: string | undefined): string {
  const t = (name ?? "").trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t)) return t.startsWith("#") ? t : `#${t}`;
  const n = t.toLowerCase();
  const hit = APP_ITEM_NAMED_COLORS.find(
    (c) => c.label.toLowerCase() === n || c.id.toLowerCase() === n,
  );
  return hit?.swatch ?? "#C7C7CC";
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

function dataUriToParts(dataUri: string): { buffer: ArrayBuffer; contentType: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUri.trim());
  if (!m) throw new Error("Invalid image data");
  const contentType = m[1] ?? "image/jpeg";
  const b64 = m[2] ?? "";
  const binary = globalThis.atob?.(b64);
  if (!binary) throw new Error("Cannot decode image");
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return { buffer: bytes.buffer, contentType };
}

type Phase = "gate" | "camera" | "hero" | "enhancing" | "ready";

type ItemMeta = {
  name?: string;
  category?: string;
  sub_category?: string;
  color?: string;
  warmth?: string;
  occasions?: string[];
  style_tags?: string[];
  box_2d?: number[] | null;
};

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

export default function AddPieceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarH = useBottomTabBarHeight();
  const bottomPad = Math.max(tabBarH, insets.bottom) + 12;
  const { user } = useUser();
  const params = useLocalSearchParams<{
    source?: string;
    library?: string;
    categoryHint?: string;
  }>();

  const categoryHint =
    typeof params.categoryHint === "string" && params.categoryHint.trim()
      ? params.categoryHint.trim()
      : "auto";

  const sourceParam = typeof params.source === "string" ? params.source : "";
  const libraryIntent =
    params.library === "1" ||
    params.library === "true" ||
    sourceParam === "library";

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [phase, setPhase] = useState<Phase>(() => {
    if (sourceParam === "camera") return "camera";
    return "gate";
  });
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [displayUri, setDisplayUri] = useState<string | null>(null);
  const [usedGeminiCutout, setUsedGeminiCutout] = useState(false);
  const [meta, setMeta] = useState<ItemMeta | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [occasions, setOccasions] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [itemId, setItemId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [pieceCategory, setPieceCategory] = useState<string>("other");
  const [styleTags, setStyleTags] = useState<string[]>(["casual"]);
  const [fabCommitting, setFabCommitting] = useState(false);
  const [enhanceSubLabel, setEnhanceSubLabel] = useState("Analyzing…");

  const pipelineStarted = useRef(false);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedOnce = useRef(false);
  const itemIdRef = useRef<string | null>(null);
  const prevPhaseRef = useRef<Phase | null>(null);
  const fabLockRef = useRef(false);

  const heroOpacity = useSharedValue(1);
  const resultOpacity = useSharedValue(0);
  const fallbackOpacity = useSharedValue(0);
  const shimmerX = useSharedValue(0);
  const presentScale = useSharedValue(1);
  const presentGlow = useSharedValue(0);
  const flyActive = useSharedValue(0);
  const flyProgress = useSharedValue(0);

  const rawPhotoAnimStyle = useAnimatedStyle(() => ({
    opacity: heroOpacity.value,
  }));

  const resultAnimStyle = useAnimatedStyle(() => ({
    opacity: resultOpacity.value,
  }));

  const fallbackAnimStyle = useAnimatedStyle(() => ({
    opacity: fallbackOpacity.value,
  }));

  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerX.value }],
  }));

  const previewMotionStyle = useAnimatedStyle(() => {
    if (flyActive.value > 0.5) {
      return {
        transform: [
          { translateY: interpolate(flyProgress.value, [0, 1], [0, SH * 0.38]) },
          { scale: interpolate(flyProgress.value, [0, 1], [1, 0.24]) },
        ],
        opacity: interpolate(flyProgress.value, [0, 0.82, 1], [1, 1, 0]),
      };
    }
    return {
      transform: [{ scale: presentScale.value }],
    };
  });

  const glowOverlayAnimStyle = useAnimatedStyle(() => ({
    position: "absolute" as const,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#fff",
    opacity: flyActive.value > 0.5 ? 0 : presentGlow.value,
  }));

  const checkPopStyle = useAnimatedStyle(() => ({
    opacity: interpolate(flyProgress.value, [0, 0.52, 0.78, 1], [0, 0, 1, 0.92]),
    transform: [
      { scale: interpolate(flyProgress.value, [0, 0.62, 0.82, 1], [0.35, 1.18, 1, 0.88]) },
    ],
  }));

  useEffect(() => {
    itemIdRef.current = itemId;
  }, [itemId]);

  const resetSession = useCallback(() => {
    pipelineStarted.current = false;
    savedOnce.current = false;
    setPhotoUri(null);
    setDisplayUri(null);
    setUsedGeminiCutout(false);
    setMeta(null);
    setName("");
    setColor("");
    setOccasions([]);
    setPieceCategory("other");
    setStyleTags(["casual"]);
    setFabCommitting(false);
    fabLockRef.current = false;
    setEnhanceSubLabel("Analyzing…");
    setDetailsOpen(false);
    setSaveState("idle");
    setItemId(null);
    setInlineError(null);
    heroOpacity.value = 1;
    resultOpacity.value = 0;
    fallbackOpacity.value = 0;
    presentScale.value = 1;
    presentGlow.value = 0;
    flyActive.value = 0;
    flyProgress.value = 0;
    if (sourceParam === "camera") setPhase("camera");
    else setPhase("gate");
  }, [
    heroOpacity,
    resultOpacity,
    fallbackOpacity,
    presentScale,
    presentGlow,
    flyActive,
    flyProgress,
    sourceParam,
  ]);

  const pickFromLibrary = useCallback(async () => {
    setInlineError(null);
    const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!libPerm.granted) {
      setInlineError("Photos access is off. Enable it in Settings to pick an image.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: false,
      quality: 0.9,
    });
    if (res.canceled || !res.assets[0]) {
      if (libraryIntent) router.back();
      return;
    }
    let uri = res.assets[0].uri;
    try {
      uri = await ensureJpegUri(uri);
    } catch {
      /* keep original */
    }
    setPhotoUri(uri);
    setPhase("hero");
  }, [libraryIntent, router]);

  useEffect(() => {
    if (!libraryIntent) return;
    const t = setTimeout(() => void pickFromLibrary(), 300);
    return () => clearTimeout(t);
  }, [libraryIntent, pickFromLibrary]);

  useEffect(() => {
    if (phase !== "enhancing") {
      shimmerX.value = 0;
      return;
    }
    shimmerX.value = withRepeat(
      withTiming(SW * 1.2, { duration: 1800, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [phase, shimmerX]);

  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === "ready" || phase !== "ready") return;
    presentScale.value = 0.9;
    presentScale.value = withTiming(1, { duration: 720, easing: Easing.out(Easing.cubic) });
    presentGlow.value = 0.12;
    presentGlow.value = withSequence(
      withTiming(0.045, { duration: 260, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 440, easing: Easing.inOut(Easing.quad) }),
    );
  }, [phase, presentScale, presentGlow]);

  const finishClosetNav = useCallback(() => {
    fabLockRef.current = false;
    queueClosetToast("Item added to your closet");
    router.replace("/(tabs)/closet");
    setFabCommitting(false);
  }, [router]);

  const runPipeline = useCallback(async () => {
    if (!photoUri || pipelineStarted.current) return;
    pipelineStarted.current = true;
    setPhase("enhancing");
    setEnhanceSubLabel("Analyzing…");
    setInlineError(null);
    heroOpacity.value = 1;
    resultOpacity.value = 0;
    fallbackOpacity.value = 0;

    try {
      const b64 = await uriToBase64(photoUri);

      // ── Tier 1: run Vision (on-device, ~300ms) AND classify in parallel ──
      // Vision resolves in ~300ms; classify takes ~2-3s.  If Vision wins we
      // skip Gemini entirely.  On iOS <17 / Android, isolateClothing returns
      // null immediately and we drop straight to the Gemini path below.
      setEnhanceSubLabel("Detecting & classifying…");
      const [{ metadata }, nativeCutout] = await Promise.all([
        apiClient.classify(b64, categoryHint, "single"),
        isolateClothing(b64).catch(() => null),
      ]);

      const list = Array.isArray(metadata) ? metadata : [metadata];
      const primary = (list[0] ?? {}) as ItemMeta;
      setMeta(primary);
      setName((primary.name ?? "New piece").slice(0, 80));
      setColor(primary.color ?? "Unknown");
      setOccasions(
        Array.isArray(primary.occasions) && primary.occasions.length
          ? primary.occasions
          : ["casual"],
      );
      setPieceCategory(normalizeCategorySlug(primary.category));
      setStyleTags(sanitizeStyleTags(primary.style_tags));

      let cutout: string | null = nativeCutout ?? null;

      // ── Tier 2: Gemini cloud (fallback when Vision unavailable / failed) ──
      if (!cutout) {
        setEnhanceSubLabel("Enhancing…");
        cutout = await apiClient.enhanceClothingItemCutout({
          imageBase64: b64,
          name: primary.name,
          color: primary.color,
          category: primary.category,
          backdropHex: NEUTRAL,
        });

        if (cutout) {
          setEnhanceSubLabel("Polishing…");
          const polished = await apiClient.polishClothingCutoutPreview({
            imageDataUri: cutout,
            backdropHex: NEUTRAL,
          });
          if (polished) cutout = polished;
        }
      }

      if (cutout) {
        setDisplayUri(cutout);
        setUsedGeminiCutout(true);
        resultOpacity.value = 0;
        resultOpacity.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) });
        heroOpacity.value = withTiming(0, { duration: 480, easing: Easing.out(Easing.cubic) });
        fallbackOpacity.value = 0;
      } else {
        setDisplayUri(photoUri);
        setUsedGeminiCutout(false);
        resultOpacity.value = 0;
        fallbackOpacity.value = 0;
        fallbackOpacity.value = withTiming(1, { duration: 440, easing: Easing.out(Easing.cubic) });
        heroOpacity.value = withTiming(0, { duration: 420, easing: Easing.out(Easing.cubic) });
      }

      setPhase("ready");
    } catch (e) {
      pipelineStarted.current = false;
      setPhase("hero");
      setInlineError(
        e instanceof Error ? e.message : "Something went wrong. Try another photo.",
      );
    }
  }, [photoUri, categoryHint, heroOpacity, resultOpacity, fallbackOpacity]);

  useEffect(() => {
    if (phase !== "hero" || !photoUri) return;
    autoTimerRef.current = setTimeout(() => void runPipeline(), 600);
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, [phase, photoUri, runPipeline]);

  const onManualEnhance = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    void runPipeline();
  }, [runPipeline]);

  const persistItem = useCallback(async (): Promise<boolean> => {
    if (!user?.id || !meta || !photoUri) return true;
    if (itemIdRef.current) return true;
    if (savedOnce.current) return true;
    savedOnce.current = true;
    setSaveState("saving");
    try {
      let buffer: ArrayBuffer;
      let contentType = "image/jpeg";
      let ext = "jpg";

      if (usedGeminiCutout && displayUri?.startsWith("data:")) {
        const parts = dataUriToParts(displayUri);
        buffer = parts.buffer;
        contentType = parts.contentType;
        ext = contentType.includes("png") ? "png" : "jpg";
      } else {
        const response = await fetch(photoUri);
        const blob = await response.blob();
        buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = reject;
          reader.readAsArrayBuffer(blob);
        });
      }

      const fileName = `piece_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const { error: storageError } = await supabase.storage
        .from("clothing-images")
        .upload(fileName, buffer, { contentType, upsert: true });
      if (storageError) throw storageError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("clothing-images").getPublicUrl(fileName);

      const styleStr =
        styleTags.length > 0 ? styleTags.slice(0, 4).join(", ") : "casual";
      const row = {
        user_id: user.id,
        name: name.trim() || meta.name || "New piece",
        image_url: publicUrl,
        type: meta.sub_category || meta.category || "Piece",
        category: pieceCategory || meta.category || "other",
        sub_category: meta.sub_category || null,
        color: color.trim() || meta.color || "Unknown",
        material: null,
        fit: null,
        weight: null,
        pattern: "solid",
        style: styleStr,
        seasons: warmthToSeasons(meta.warmth),
        occasions: occasions.length ? occasions : ["casual"],
        formality: null,
        box_2d: meta.box_2d ?? null,
        notes: null,
        is_digitized: true,
      };

      const { data: inserted, error } = await supabase
        .from("clothing_items")
        .insert(row)
        .select("id")
        .single();
      if (error) throw error;
      setItemId(inserted?.id ?? null);
      setSaveState("saved");
      return true;
    } catch {
      savedOnce.current = false;
      setSaveState("error");
      return false;
    }
  }, [
    user?.id,
    meta,
    photoUri,
    displayUri,
    usedGeminiCutout,
    name,
    color,
    occasions,
    pieceCategory,
    styleTags,
  ]);

  useEffect(() => {
    if (phase !== "ready" || !meta || !user?.id) return;
    const t = setTimeout(() => void persistItem(), 800);
    return () => clearTimeout(t);
  }, [phase, meta, user?.id, persistItem]);

  useEffect(() => {
    if (!itemId) return;
    const t = setTimeout(() => {
      void supabase
        .from("clothing_items")
        .update({
          name: name.trim() || meta?.name || "Piece",
          color: color.trim() || meta?.color || "Unknown",
          occasions: occasions.length ? occasions : ["casual"],
          category: pieceCategory || meta?.category || "other",
          style: styleTags.length ? styleTags.slice(0, 4).join(", ") : "casual",
        })
        .eq("id", itemId);
    }, 450);
    return () => clearTimeout(t);
  }, [
    name,
    color,
    occasions,
    pieceCategory,
    styleTags,
    itemId,
    meta?.name,
    meta?.color,
    meta?.category,
  ]);

  const toggleOccasion = (id: string) => {
    setOccasions((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleStyleTag = (id: string) => {
    setStyleTags((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        return next.length ? next : ["casual"];
      }
      return [...prev, id].slice(0, 4);
    });
  };

  const onAddToCloset = useCallback(() => {
    if (fabLockRef.current) return;
    if (!user?.id) {
      setInlineError("Sign in to save pieces to your closet.");
      return;
    }
    fabLockRef.current = true;
    setFabCommitting(true);
    void (async () => {
      try {
        await persistItem();
        let n = 0;
        while (!itemIdRef.current && n < 50) {
          await new Promise((r) => setTimeout(r, 80));
          n += 1;
        }
      } finally {
        if (!itemIdRef.current) {
          fabLockRef.current = false;
          setFabCommitting(false);
          flyActive.value = 0;
          flyProgress.value = 0;
          setInlineError("Could not save. Check connection and try again.");
          return;
        }
        flyActive.value = 1;
        flyProgress.value = 0;
        flyProgress.value = withTiming(
          1,
          { duration: 540, easing: Easing.inOut(Easing.cubic) },
          (finished) => {
            if (finished) runOnJS(finishClosetNav)();
          },
        );
      }
    })();
  }, [user?.id, persistItem, flyActive, flyProgress, finishClosetNav]);

  const capturePhoto = async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: false,
        quality: 0.85,
      });
      if (!photo?.uri) return;
      let uri = photo.uri;
      try {
        uri = await ensureJpegUri(uri);
      } catch {
        /* */
      }
      setPhotoUri(uri);
      setPhase("hero");
    } catch {
      setInlineError("Could not capture. Try again.");
    }
  };

  const gateChooser = (
    <View style={[styles.gate, { paddingTop: insets.top + 24, paddingBottom: bottomPad }]}>
      <TouchableOpacity style={styles.backGhost} onPress={() => router.back()} hitSlop={12}>
        <ChevronLeft size={28} color={Colors.text} strokeWidth={2} />
      </TouchableOpacity>
      <Text style={styles.gateTitle}>Add a piece</Text>
      <Text style={styles.gateHint}>One photo. We handle the rest.</Text>
      <View style={styles.gateRow}>
        <TouchableOpacity
          style={styles.gateCircle}
          onPress={async () => {
            if (!permission?.granted) await requestPermission();
            setPhase("camera");
          }}
          activeOpacity={0.85}
        >
          <Text style={styles.gateCircleLabel}>Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.gateCircle}
          onPress={() => void pickFromLibrary()}
          activeOpacity={0.85}
        >
          <Text style={styles.gateCircleLabel}>Library</Text>
        </TouchableOpacity>
      </View>
      {inlineError ? <Text style={styles.inlineErr}>{inlineError}</Text> : null}
    </View>
  );

  const cameraUi = (
    <View style={styles.flex1}>
      {permission?.granted ? (
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      ) : (
        <View style={[styles.flex1, styles.center, { backgroundColor: "#111" }]}>
          <Text style={styles.permText}>Camera access lets you snap clothes in seconds.</Text>
          <TouchableOpacity style={styles.primaryFab} onPress={() => void requestPermission()}>
            <Text style={styles.primaryFabText}>Enable camera</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={[styles.camChrome, { paddingTop: insets.top + 8, paddingBottom: bottomPad }]}>
        <TouchableOpacity onPress={() => (sourceParam === "camera" ? router.back() : setPhase("gate"))}>
          <ChevronLeft size={28} color="#fff" strokeWidth={2} />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
      </View>
      {permission?.granted ? (
        <TouchableOpacity style={[styles.shutter, { bottom: bottomPad + 8 }]} onPress={() => void capturePhoto()} />
      ) : null}
      {inlineError ? (
        <Text style={[styles.inlineErr, { position: "absolute", bottom: bottomPad + 100, alignSelf: "center" }]}>
          {inlineError}
        </Text>
      ) : null}
    </View>
  );

  const heroAndProcess = photoUri && (
    <View style={styles.flex1}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, rawPhotoAnimStyle]}>
          <Image
            source={{ uri: photoUri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={200}
          />
        </Animated.View>
        {phase === "ready" && !usedGeminiCutout ? (
          <Animated.View
            style={[StyleSheet.absoluteFill, { backgroundColor: NEUTRAL }, fallbackAnimStyle]}
            pointerEvents="none"
          >
            <Animated.View style={[styles.cutoutStage, { paddingTop: insets.top + 28 }, previewMotionStyle]}>
              <Animated.View style={glowOverlayAnimStyle} pointerEvents="none" />
              <ZoomedItemThumb
                uri={photoUri}
                box2d={meta?.box_2d}
                width={SW - 48}
                height={SH * 0.58}
                resizeMode="contain"
              />
            </Animated.View>
          </Animated.View>
        ) : null}
        {phase === "ready" && usedGeminiCutout && displayUri ? (
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: NEUTRAL }, resultAnimStyle]}>
            <Animated.View style={[styles.cutoutStage, { paddingTop: insets.top + 28 }, previewMotionStyle]}>
              <Animated.View style={glowOverlayAnimStyle} pointerEvents="none" />
              <Image
                source={{ uri: displayUri }}
                style={{ width: SW - 40, height: SH * 0.62 }}
                contentFit="contain"
                transition={400}
              />
            </Animated.View>
          </Animated.View>
        ) : null}
      </View>

      {fabCommitting ? (
        <Animated.View style={[styles.checkBurst, checkPopStyle]} pointerEvents="none">
          <View style={styles.checkBurstCircle}>
            <Check size={38} color="#fff" strokeWidth={3} />
          </View>
        </Animated.View>
      ) : null}

      {phase === "enhancing" && (
        <>
          <BlurView intensity={55} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Animated.View style={[styles.shimmerStrip, shimmerStyle]}>
              <LinearGradient
                colors={["transparent", "rgba(255,255,255,0.35)", "transparent"]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={{ width: SW * 0.65, height: SH }}
              />
            </Animated.View>
          </View>
          <View style={[styles.center, StyleSheet.absoluteFill]}>
            <View style={styles.ringWrap}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
            <Text style={styles.enhanceLabel}>{enhanceSubLabel}</Text>
          </View>
        </>
      )}

      <View style={[styles.topChrome, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => {
            resetSession();
            if (libraryIntent) router.back();
          }}
          hitSlop={12}
        >
          <ChevronLeft
            size={26}
            color={phase === "ready" ? Colors.text : "#fff"}
            strokeWidth={2.2}
            style={phase === "ready" ? undefined : styles.iconShadow}
          />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        {phase === "ready" && saveState === "error" && (
          <View style={styles.savePill}>
            <Text style={styles.savePillText}>Save failed</Text>
          </View>
        )}
      </View>

      {phase === "hero" && (
        <>
          <TouchableOpacity style={[styles.enhanceFab, { bottom: bottomPad + 20 }]} onPress={onManualEnhance}>
            <Sparkles size={20} color="#fff" strokeWidth={2.2} />
            <Text style={styles.enhanceFabText}>Enhance</Text>
          </TouchableOpacity>
          {inlineError ? (
            <View style={[styles.errorBanner, { bottom: bottomPad + 100 }]}>
              <Text style={styles.errorBannerText}>{inlineError}</Text>
              <TouchableOpacity onPress={() => setInlineError(null)}>
                <Text style={styles.errorDismiss}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </>
      )}

      {phase === "ready" && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[styles.bottomSheet, { paddingBottom: bottomPad + 96 }]}
        >
          <View style={styles.fieldRow}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Name"
              placeholderTextColor="rgba(0,0,0,0.22)"
              style={styles.nameInput}
            />
            <TouchableOpacity
              onPress={() => setColorPickerOpen(true)}
              hitSlop={16}
              accessibilityLabel="Edit color"
              style={styles.colorDotHit}
            >
              <View
                style={[
                  styles.colorDot,
                  { backgroundColor: swatchForItemColor(color) },
                ]}
              />
            </TouchableOpacity>
          </View>
          <Pressable style={styles.detailsToggle} onPress={() => setDetailsOpen((o) => !o)}>
            <Text style={styles.detailsToggleText}>Details</Text>
            {detailsOpen ? (
              <ChevronUp size={18} color={Colors.textMuted} />
            ) : (
              <ChevronDown size={18} color={Colors.textMuted} />
            )}
          </Pressable>
          {detailsOpen ? (
            <View style={styles.detailsBody}>
              <Text style={styles.aiHint}>AI suggested</Text>
              <Text style={styles.detailsSectionLabel}>Category</Text>
              <View style={styles.occRow}>
                {CATEGORY_OPTIONS.map((c) => {
                  const on = pieceCategory === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => setPieceCategory(c.id)}
                      style={[styles.metaChip, on && styles.metaChipOn]}
                    >
                      <Text style={[styles.metaChipText, on && styles.metaChipTextOn]}>{c.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.detailsSectionLabel, { marginTop: 14 }]}>Style</Text>
              <View style={styles.occRow}>
                {STYLE_OPTIONS.map((s) => {
                  const on = styleTags.includes(s.id);
                  return (
                    <Pressable
                      key={s.id}
                      onPress={() => toggleStyleTag(s.id)}
                      style={[styles.metaChip, on && styles.metaChipOn]}
                    >
                      <Text style={[styles.metaChipText, on && styles.metaChipTextOn]}>{s.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.detailsSectionMuted, { marginTop: 16 }]}>Wear it for</Text>
              {OCCASION_GROUPS.map((g) => (
                <View key={g.id} style={{ marginBottom: 8 }}>
                  <Text style={styles.occGroupMuted}>{g.label}</Text>
                  <View style={styles.occRow}>
                    {g.occasions.map((o) => {
                      const on = occasions.includes(o.id);
                      return (
                        <Pressable
                          key={o.id}
                          onPress={() => toggleOccasion(o.id)}
                          style={[styles.occChipSm, on && styles.occChipSmOn]}
                        >
                          <Text style={[styles.occChipSmText, on && styles.occChipSmTextOn]}>{o.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {saveState === "error" ? (
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => {
                savedOnce.current = false;
                void persistItem();
              }}
            >
              <Text style={styles.retryBtnText}>Retry save</Text>
            </TouchableOpacity>
          ) : null}
          {inlineError && phase === "ready" ? (
            <Text style={styles.inlineErrSmall}>{inlineError}</Text>
          ) : null}
        </KeyboardAvoidingView>
      )}

      {phase === "ready" && (
        <TouchableOpacity
          style={[styles.closetFab, fabCommitting && styles.closetFabBusy, { bottom: bottomPad + 18 }]}
          activeOpacity={0.88}
          disabled={fabCommitting}
          onPress={onAddToCloset}
        >
          <Text style={styles.closetFabText}>{fabCommitting ? "…" : "Add to closet"}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <View style={styles.root}>
      {phase === "gate" && gateChooser}
      {phase === "camera" && cameraUi}
      {(phase === "hero" || phase === "enhancing" || phase === "ready") && photoUri && heroAndProcess}

      <IosStyleColorPickerModal
        visible={colorPickerOpen}
        onClose={() => setColorPickerOpen(false)}
        variant="item"
        itemValue={color}
        onSelectItem={(c) => setColor(c)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  flex1: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  cutoutStage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
  },
  checkBurst: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 40,
  },
  checkBurstCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: "rgba(0,0,0,0.9)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 16,
  },
  iconShadow: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.45,
    shadowRadius: 3,
  },
  gate: {
    flex: 1,
    backgroundColor: NEUTRAL,
    paddingHorizontal: 28,
  },
  backGhost: { alignSelf: "flex-start", marginBottom: 20 },
  gateTitle: {
    fontSize: 28,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.6,
  },
  gateHint: {
    marginTop: 8,
    fontSize: 15,
    color: Colors.textMuted,
    marginBottom: 40,
  },
  gateRow: { flexDirection: "row", gap: 20, justifyContent: "center" },
  gateCircle: {
    width: (SW - 100) / 2,
    aspectRatio: 1,
    maxWidth: 160,
    borderRadius: 999,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 6,
  },
  gateCircleLabel: {
    fontSize: 16,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  permText: {
    color: "rgba(255,255,255,0.75)",
    textAlign: "center",
    paddingHorizontal: 40,
    marginBottom: 20,
    fontSize: 15,
  },
  primaryFab: {
    backgroundColor: "#fff",
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: Radii.full,
  },
  primaryFabText: { fontWeight: Typography.weights.bold, color: "#000" },
  camChrome: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  shutter: {
    position: "absolute",
    alignSelf: "center",
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "#fff",
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  topChrome: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    zIndex: 20,
  },
  savePill: {
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radii.full,
  },
  savePillText: { fontSize: 12, fontWeight: Typography.weights.semibold, color: Colors.text },
  shimmerStrip: {
    position: "absolute",
    left: -SW * 0.35,
    top: 0,
    width: SW * 0.65,
    height: SH,
  },
  ringWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.5)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  enhanceLabel: {
    color: "rgba(255,255,255,0.95)",
    fontSize: 17,
    fontWeight: Typography.weights.semibold,
    letterSpacing: 0.3,
  },
  enhanceFab: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#000",
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: Radii.full,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  enhanceFabText: { color: "#fff", fontSize: 16, fontWeight: Typography.weights.bold },
  errorBanner: {
    position: "absolute",
    left: 20,
    right: 20,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: Radii.md,
    padding: 14,
  },
  errorBannerText: { color: "#fff", fontSize: 14, marginBottom: 8 },
  errorDismiss: { color: "rgba(255,255,255,0.85)", fontWeight: Typography.weights.semibold },
  bottomSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.98)",
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 24,
    paddingTop: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.05)",
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 4,
  },
  nameInput: {
    flex: 1,
    fontSize: 24,
    fontWeight: Typography.weights.bold,
    letterSpacing: -0.4,
    color: Colors.text,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.1)",
  },
  colorDotHit: {
    padding: 6,
  },
  colorDot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: "rgba(0,0,0,0.1)",
  },
  closetFab: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: "#000",
    paddingHorizontal: 36,
    paddingVertical: 17,
    borderRadius: Radii.full,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 16,
    elevation: 10,
    minWidth: 200,
    alignItems: "center",
  },
  closetFabBusy: {
    opacity: 0.55,
  },
  closetFabText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: Typography.weights.bold,
  },
  detailsToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  detailsToggleText: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    letterSpacing: 0.2,
  },
  detailsBody: { maxHeight: SH * 0.34, marginBottom: 10, paddingBottom: 4 },
  aiHint: {
    fontSize: 11,
    fontWeight: Typography.weights.semibold,
    color: "rgba(0,0,0,0.38)",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  detailsSectionLabel: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  detailsSectionMuted: {
    fontSize: 11,
    fontWeight: Typography.weights.bold,
    color: "rgba(0,0,0,0.35)",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 6,
  },
  metaChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radii.full,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  metaChipOn: {
    backgroundColor: Colors.black,
    borderColor: Colors.black,
  },
  metaChipText: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  metaChipTextOn: { color: "#fff" },
  occGroupMuted: {
    fontSize: 9,
    fontWeight: Typography.weights.bold,
    color: "rgba(0,0,0,0.32)",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 5,
    marginTop: 2,
  },
  occRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  occChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radii.full,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  occChipOn: { backgroundColor: Colors.black, borderColor: Colors.black },
  occChipText: { fontSize: 12, fontWeight: Typography.weights.medium, color: Colors.text },
  occChipTextOn: { color: "#fff" },
  occChipSm: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.full,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  occChipSmOn: {
    backgroundColor: "rgba(0,0,0,0.12)",
    borderColor: "rgba(0,0,0,0.2)",
  },
  occChipSmText: {
    fontSize: 11,
    fontWeight: Typography.weights.medium,
    color: "rgba(0,0,0,0.55)",
  },
  occChipSmTextOn: {
    color: Colors.text,
    fontWeight: Typography.weights.semibold,
  },
  retryBtn: {
    alignSelf: "center",
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryBtnText: { fontWeight: Typography.weights.semibold, color: Colors.text },
  inlineErr: { marginTop: 24, color: Colors.red, textAlign: "center", paddingHorizontal: 20 },
  inlineErrSmall: { fontSize: 12, color: Colors.red, marginTop: 6, textAlign: "center" },
});
