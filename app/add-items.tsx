import { useUser } from "@clerk/clerk-expo";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState, useCallback } from "react";
import Animated, { useSharedValue, useAnimatedStyle, withTiming, FadeIn } from "react-native-reanimated";
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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import ColorPickerTriggerIcon from "../components/color-picker/ColorPickerTriggerIcon";
import IosStyleColorPickerModal from "../components/color-picker/IosStyleColorPickerModal";
import ZoomedItemThumb from "../components/ZoomedItemThumb";
import { apiClient } from "../constants/api-client";
import { APP_ITEM_NAMED_COLORS } from "../constants/appNamedColors";
import { Colors, Styles } from "../constants/AppTheme";
import { OCCASIONS_FLAT } from "../constants/occasions";
import { ensureJpegUri } from "../lib/ensureJpegForVision";
import { consumeLibraryIntent } from "../lib/uploadIntent";
import { supabase } from "../lib/supabase";
import { segmentItems } from "clothing-isolator";

const { width } = Dimensions.get("window");

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
      <Path d="M4 4L20 20" stroke={color} strokeWidth="2" strokeLinecap="round" />
    )}
  </Svg>
);

const ArcFlipIcon = ({ color }: { color: string }) => (
  <Svg width="22" height="22" viewBox="0 0 24 24">
    {/* camera body */}
    <Rect x="3" y="6" width="18" height="12" rx="1.5" stroke={color} strokeWidth="2" fill="none" />
    {/* lens */}
    <Circle cx="12" cy="12" r="2.5" stroke={color} strokeWidth="1.5" fill="none" />
    {/* flip arrows - curved paths forming a rotation symbol */}
    <Path d="M16 4c2 0 3 1 3 3M8 20c-2 0-3-1-3-3" stroke={color} strokeWidth="1.8" strokeLinecap="round" fill="none" />
    <Path d="M19 6l1.5-2.5L19 1M5 18l-1.5 2.5L5 23" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </Svg>
);

function warmthToSeasons(w: string | undefined): string[] {
  switch (w?.toLowerCase()) {
    case "warm": return ["spring", "summer"];
    case "cold": return ["fall", "winter"];
    case "both": return ["all"];
    default: return ["all"];
  }
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

export default function AddScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ library?: string | string[] }>();
  const { user } = useUser();
  const [uploadSource, setUploadSource] = useState<"camera" | "library">(
    () => (consumeLibraryIntent() || isLibraryMenuIntent(params.library) ? "library" : "camera"),
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
  const [editForm, setEditForm] = useState({
    name: "",
    category: "",
    color: "",
    occasions: [] as string[],
    seasons: [] as string[],
  });
  const [uploadColorPickerOpen, setUploadColorPickerOpen] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  /** Progress when analyzing multiple library photos before one combined review */
  const [batchAnalyze, setBatchAnalyze] = useState<{
    current: number;
    total: number;
  } | null>(null);

  /** Shown on library idle screen after permission / analysis issues (never the fake “could not open library” copy). */
  const [libraryBanner, setLibraryBanner] = useState<string | null>(null);
  const [librarySettingsCta, setLibrarySettingsCta] = useState(false);

  // The extraction mode
  const [mode, setMode] = useState<"single" | "multi">("multi");

  // Array of parsed items
  const [aiMetaList, setAiMetaList] = useState<any[]>([]);

  const cameraRef = useRef<CameraView>(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"off" | "on" | "torch">("off");
  const [capturedPhotos, setCapturedPhotos] = useState<Array<{ uri: string; base64: string; isolatedUri?: string }>>([]);
  const pickImagesRef = useRef<() => Promise<void>>(async () => {});

  const tabBarOverlay = Math.max(insets.bottom, 10);
  const reviewStickyBarHeight = 88;
  const reviewScrollBottomPad = tabBarOverlay + reviewStickyBarHeight + 16;
  const doneScrollBottomPad = tabBarOverlay + 28;
  const donePhotoCount = [
    ...new Set(aiMetaList.map((i) => i.sourceUri ?? image).filter(Boolean)),
  ].length;

  const processImage = async (base64: string, uri: string) => {
    setImage(uri);
    setStatus("analyzing");
    try {
      // Step 1: segment on-device (fast ~300-600ms)
      const segments = await segmentItems(base64);

      if (segments.length > 1) {
        // Multiple isolated items (flat-lay) — show each on white, classify in parallel
        setImage(segments[0]);
        setStatus("review");
        const placeholders = segments.map((seg) => ({
          sourceUri: seg,
          isIsolated: true,
          _classifying: true,
          name: "",
        }));
        setAiMetaList(placeholders);

        await Promise.all(
          segments.map(async (seg, si) => {
            try {
              const segB64 = seg.replace(/^data:image\/\w+;base64,/, "");
              const result = await apiClient.classify(segB64, "auto", "single");
              const items = Array.isArray(result.metadata)
                ? result.metadata : [result.metadata];
              const meta = items[0];
              if (meta && typeof meta === "object") {
                setAiMetaList((prev) => {
                  const idx = prev.findIndex(
                    (p) => p.sourceUri === seg && p._classifying
                  );
                  if (idx === -1) return prev;
                  const next = [...prev];
                  next[idx] = { ...meta, sourceUri: seg, isIsolated: true };
                  return next;
                });
              }
            } catch (e) {
              setAiMetaList((prev) =>
                prev.filter((p) => !(p.sourceUri === seg && p._classifying))
              );
              console.warn("[upload] classify failed for segment", si, e);
            }
          })
        );
      } else {
        // 1 segment (person on white) or no segments (fallback) — classify with multi
        const cleanUri = segments.length === 1 ? segments[0] : null;
        const classifyB64 = cleanUri
          ? cleanUri.replace(/^data:image\/\w+;base64,/, "")
          : base64;
        const sourceUri = cleanUri ?? uri;
        if (cleanUri) setImage(cleanUri);
        setStatus("review");

        const result = await apiClient.classify(classifyB64, "auto", mode);
        const items = Array.isArray(result.metadata)
          ? result.metadata : [result.metadata];
        setAiMetaList(
          items.filter(Boolean).map((m: any) => ({ ...m, sourceUri })),
        );
      }
    } catch (err) {
      console.error(err);
      setAiMetaList([]);
      setStatus("scanning");
      Alert.alert("AI extraction failed", formatUnknownError(err));
    }
  };

  /** All selected photos → parallel segment+classify, items appear as they complete */
  const analyzeAllLibraryPhotos = async (jpegUris: string[]) => {
    if (jpegUris.length === 0) return;
    setLibraryBanner(null);
    setLibrarySettingsCta(false);
    setAiMetaList([]);
    setStatus("analyzing");
    setBatchAnalyze({ current: 0, total: jpegUris.length });
    setImage(jpegUris[0]);

    let addedCount = 0;
    const classifyMode = jpegUris.length > 1 ? "multi" : mode;

    try {
      for (let i = 0; i < jpegUris.length; i++) {
        setBatchAnalyze({ current: i + 1, total: jpegUris.length });
        const uri = jpegUris[i];
        try {
          const b64 = await uriToBase64(uri);

          // Step 1: segment on-device (~300-600ms)
          const segments = await segmentItems(b64);

          if (segments.length > 1) {
            // Multiple isolated items (flat-lay) — show each on white, classify in parallel
            if (addedCount === 0) {
              setImage(segments[0]);
              setStatus("review");
            }
            const placeholders = segments.map((seg) => ({
              sourceUri: seg,
              isIsolated: true,
              _classifying: true,
              name: "",
            }));
            setAiMetaList((prev) => [...prev, ...placeholders]);

            await Promise.all(
              segments.map(async (seg, si) => {
                try {
                  const segB64 = seg.replace(/^data:image\/\w+;base64,/, "");
                  const result = await apiClient.classify(segB64, "auto", "single");
                  const items = Array.isArray(result.metadata)
                    ? result.metadata : [result.metadata];
                  const meta = items[0];
                  if (meta && typeof meta === "object") {
                    setAiMetaList((prev) => {
                      const idx = prev.findIndex(
                        (p) => p.sourceUri === seg && p._classifying
                      );
                      if (idx === -1) return prev;
                      const next = [...prev];
                      next[idx] = { ...meta, sourceUri: seg, isIsolated: true };
                      return next;
                    });
                    addedCount++;
                  }
                } catch (e) {
                  setAiMetaList((prev) =>
                    prev.filter((p) => !(p.sourceUri === seg && p._classifying))
                  );
                  console.warn("[upload] classify failed for segment", si, e);
                }
              })
            );
          } else {
            // 1 segment (person on white) or no segments — classify with multi
            const cleanUri = segments.length === 1 ? segments[0] : null;
            const classifyB64 = cleanUri
              ? cleanUri.replace(/^data:image\/\w+;base64,/, "")
              : b64;
            const sourceUri = cleanUri ?? uri;

            const result = await apiClient.classify(classifyB64, "auto", classifyMode);
            const items = Array.isArray(result.metadata)
              ? result.metadata : [result.metadata];
            for (const meta of items) {
              if (meta && typeof meta === "object") {
                setAiMetaList((prev) => [...prev, { ...meta, sourceUri }]);
                addedCount++;
              }
            }
            if (addedCount > 0 && i === 0) {
              setImage(sourceUri);
              setStatus("review");
            }
          }
        } catch (e) {
          console.warn("[upload] failed for photo", i + 1, e);
        }
      }

      if (addedCount === 0) {
        setAiMetaList([]);
        setStatus("scanning");
        Alert.alert("No items detected", "Try better lighting or a clearer angle.");
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
      // Fire-and-forget segmentation — updates strip thumbnail when ready
      segmentItems(entry.base64).then((segs) => {
        if (segs.length > 0) {
          setCapturedPhotos((prev) =>
            prev.map((p) => (p.uri === entry.uri ? { ...p, isolatedUri: segs[0] } : p))
          );
        }
      }).catch(() => {});
    } catch (err) {
      console.error(err);
      Alert.alert("Capture Failed", "Try again in better lighting.");
    }
  };

  const handleDoneCapturing = async () => {
    if (capturedPhotos.length === 0) return;
    setAiMetaList([]);
    setStatus("analyzing");
    setBatchAnalyze({ current: 0, total: capturedPhotos.length });
    let addedCount = 0;

    try {
      for (let i = 0; i < capturedPhotos.length; i++) {
        setBatchAnalyze({ current: i + 1, total: capturedPhotos.length });
        const photo = capturedPhotos[i];
        try {
          // Use pre-computed segments if available
          const segments = photo.isolatedUri
            ? [photo.isolatedUri]
            : await segmentItems(photo.base64);

          if (segments.length > 1) {
            // Multiple isolated items (flat-lay) — show each on white
            if (addedCount === 0) {
              setImage(segments[0]);
              setStatus("review");
            }
            setAiMetaList((prev) => [
              ...prev,
              ...segments.map((seg) => ({
                sourceUri: seg, isIsolated: true, _classifying: true, name: "",
              })),
            ]);
            await Promise.all(
              segments.map(async (seg) => {
                try {
                  const segB64 = seg.replace(/^data:image\/\w+;base64,/, "");
                  const result = await apiClient.classify(segB64, "auto", "single");
                  const items = Array.isArray(result.metadata) ? result.metadata : [result.metadata];
                  const meta = items[0];
                  if (meta && typeof meta === "object") {
                    setAiMetaList((prev) => {
                      const idx = prev.findIndex((p) => p.sourceUri === seg && p._classifying);
                      if (idx === -1) return prev;
                      const next = [...prev];
                      next[idx] = { ...meta, sourceUri: seg, isIsolated: true };
                      return next;
                    });
                    addedCount++;
                  }
                } catch (e) {
                  setAiMetaList((prev) =>
                    prev.filter((p) => !(p.sourceUri === seg && p._classifying))
                  );
                }
              })
            );
          } else {
            // 1 segment (person on white) or no segments — classify with multi
            const cleanUri = segments.length === 1 ? segments[0] : null;
            const classifyB64 = cleanUri
              ? cleanUri.replace(/^data:image\/\w+;base64,/, "")
              : photo.base64;
            const sourceUri = cleanUri ?? photo.uri;

            const result = await apiClient.classify(classifyB64, "auto", mode);
            const items = Array.isArray(result.metadata) ? result.metadata : [result.metadata];
            for (const meta of items) {
              if (meta && typeof meta === "object") {
                setAiMetaList((prev) => [...prev, { ...meta, sourceUri }]);
                addedCount++;
              }
            }
            if (addedCount > 0 && i === 0) {
              setImage(sourceUri);
              setStatus("review");
            }
          }
        } catch (e) {
          console.warn("[upload] classify failed for captured photo", i + 1, e);
        }
      }
      if (addedCount === 0) {
        setStatus("scanning");
        Alert.alert("No items detected", "Try better lighting or a clearer angle.");
      }
    } catch (err) {
      setStatus("scanning");
      Alert.alert("Analysis failed", formatUnknownError(err));
    } finally {
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

    const fileName = `piece_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.jpg`;

    const { error: storageError } = await supabase.storage
      .from("clothing-images")
      .upload(fileName, arrayBuffer, {
        contentType: "image/jpeg",
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
        pickImagesRef.current()
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
      const byUri = new Map<string, any[]>();
      for (const raw of aiMetaList) {
        const uri = raw.sourceUri ?? image;
        if (!uri) continue;
        const { sourceUri: _s, ...meta } = raw;
        if (!byUri.has(uri)) byUri.set(uri, []);
        byUri.get(uri)!.push(meta);
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
          entries.slice(i, i + CHUNK).map(([uri, metas]) =>
            persistItemsToCloset(uri, metas, userId)
          )
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

  const openUploadEdit = (idx: number) => {
    const item = aiMetaList[idx];
    setEditForm({
      name: item?.name || "",
      category: item?.category || "",
      color: item?.color || "",
      occasions: [...(item?.occasions || [])],
      seasons: [...(item?.seasons || warmthToSeasons(item?.warmth))],
    });
    setEditIndex(idx);
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
              }
            : it,
        ),
      );
    }
    setEditIndex(null);
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

  const modeToggleRow = (
    <View style={styles.modeToggle}>
      <TouchableOpacity
        style={[styles.modeBtn, mode === "single" && styles.modeBtnActive]}
        onPress={() => setMode("single")}
      >
        <Text
          style={[styles.modeText, mode === "single" && styles.modeTextActive]}
        >
          FLAT LAY
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.modeBtn, mode === "multi" && styles.modeBtnActive]}
        onPress={() => setMode("multi")}
      >
        <Text
          style={[styles.modeText, mode === "multi" && styles.modeTextActive]}
        >
          FIT CHECK
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      {status === "scanning" || status === "analyzing" ? (
        uploadSource === "library" ? (
          status === "analyzing" ? (
            <View style={styles.analyzingFullScreen}>
              <ActivityIndicator color={Colors.accent} size="large" />
              <Text style={styles.analyzingTitle}>
                {batchAnalyze && batchAnalyze.total > 1
                  ? `Photo ${batchAnalyze.current} of ${batchAnalyze.total}`
                  : "Extracting items…"}
              </Text>
              {batchAnalyze && batchAnalyze.total > 1 ? (
                <Text style={styles.analyzingSub}>
                  Detecting every item in each photo.
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.libraryPassThrough} />
          )
        ) : (
          <View style={styles.cameraWrapper}>
            {permission.granted ? (
              <CameraView
                style={StyleSheet.absoluteFillObject}
                ref={cameraRef}
                facing={facing}
                flash={flash}
              />
            ) : (
              <View
                style={[
                  StyleSheet.absoluteFillObject,
                  styles.cameraRollPlaceholder,
                ]}
              />
            )}

            <View style={[styles.hudOverlay, { paddingTop: insets.top + 12, paddingBottom: tabBarOverlay + 12 }]}>
              <View style={styles.hudHeader}>
                <TouchableOpacity
                  onPress={() => router.back()}
                  style={styles.hudGhostBtn}
                >
                  <ArcClose color="#fff" />
                </TouchableOpacity>

                <View style={styles.hudHeaderLabel}>
                  <Text style={styles.hudHeaderTitle}>Camera</Text>
                  <Text style={styles.hudHeaderSub} numberOfLines={1}>items, shoes & outfits</Text>
                </View>

                <TouchableOpacity
                  style={[styles.hudGhostBtn, flash !== "off" && styles.hudGhostBtnActive]}
                  onPress={() =>
                    setFlash((f) =>
                      f === "off" ? "on" : f === "on" ? "torch" : "off",
                    )
                  }
                >
                  <ArcFlashIcon mode={flash} color="#fff" />
                </TouchableOpacity>
              </View>

              <View style={styles.reticle}>
                <View style={[styles.corner, styles.tl]} />
                <View style={[styles.corner, styles.tr]} />
                <View style={[styles.corner, styles.bl]} />
                <View style={[styles.corner, styles.br]} />
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
                          source={{ uri: photo.isolatedUri ?? photo.uri }}
                          style={[styles.thumbImg, photo.isolatedUri && { backgroundColor: "#fff" }]}
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
                        Done{capturedPhotos.length > 1 ? ` (${capturedPhotos.length})` : ""}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.hudGhostBtn}
                      onPress={() => setFacing((f) => (f === "back" ? "front" : "back"))}
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
          ]}
        >
          {status === "review" && (
            <>
              {/* Fullscreen photo preview */}
              <Modal
                visible={previewUri !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setPreviewUri(null)}
              >
                <TouchableOpacity
                  activeOpacity={1}
                  style={styles.fullscreenBackdrop}
                  onPress={() => setPreviewUri(null)}
                >
                  <Image
                    source={{ uri: previewUri! }}
                    style={styles.fullscreenImage}
                    resizeMode="contain"
                  />
                </TouchableOpacity>
              </Modal>

              <Modal
                visible={editIndex !== null}
                transparent
                animationType="slide"
                onRequestClose={() => setEditIndex(null)}
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
                    onPress={() => setEditIndex(null)}
                  />
                  <ScrollView
                    style={styles.uploadEditCard}
                    contentContainerStyle={{ paddingBottom: 32 }}
                    showsVerticalScrollIndicator={false}
                  >
                    <View style={styles.uploadEditHeader}>
                      <Text style={styles.uploadEditTitle}>Configure</Text>
                      <TouchableOpacity
                        onPress={() => setEditIndex(null)}
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
                                      o.toLowerCase() !==
                                      occ.id.toLowerCase(),
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
                                (f) =>
                                  f.id.toLowerCase() === o.toLowerCase(),
                              ),
                          )
                          .join(", ") || ""
                      }
                      onChangeText={(t) => {
                        const known = editForm.occasions.filter((o) =>
                          OCCASIONS_FLAT.some(
                            (f) =>
                              f.id.toLowerCase() === o.toLowerCase(),
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
                        onPress={() => setEditIndex(null)}
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

          <ScrollView
            contentContainerStyle={[
              styles.scrollContent,
              {
                paddingTop: status === "done" ? insets.top + 18 : 0,
                paddingBottom:
                  status === "done"
                    ? doneScrollBottomPad
                    : 24,
              },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {status === "review" && image ? (
              <>
                <View
                  style={[
                    styles.snapReviewHeader,
                    { paddingTop: insets.top + 8 },
                  ]}
                >
                  <View style={styles.dragHandle} />
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
                    const uris = [
                      ...new Set(
                        aiMetaList
                          .map((i) => i.sourceUri ?? image)
                          .filter(Boolean),
                      ),
                    ] as string[];
                    if (uris.length <= 1) return null;
                    const parts = uris.map((u, i) => {
                      const c = aiMetaList.filter(
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
                    key={`${item.sourceUri ?? image}-${idx}-${item.name ?? ""}`}
                    entering={FadeIn.duration(280)}
                    style={styles.snapItemCard}
                  >
                    {/* Isolated segment: show directly on white, centered */}
                    {item.isIsolated ? (
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => !item._classifying && setPreviewUri(item.sourceUri)}
                        style={styles.isolatedThumb}
                      >
                        <Image
                          source={{ uri: item.sourceUri }}
                          style={styles.isolatedThumbImg}
                          resizeMode="contain"
                        />
                        {item._classifying && (
                          <View style={styles.shimmerOverlay}>
                            <ActivityIndicator color="rgba(0,0,0,0.25)" size="small" />
                          </View>
                        )}
                      </TouchableOpacity>
                    ) : (
                      <ZoomedItemThumb
                        uri={item.sourceUri ?? image!}
                        box2d={item.box_2d}
                        width={130}
                        resizeMode="cover"
                        onPress={() => setPreviewUri(item.sourceUri ?? image)}
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
                          <View style={styles.shimmerLine} />
                          <View style={[styles.shimmerLine, { width: "55%", marginTop: 8 }]} />
                          <View style={[styles.shimmerLine, { width: "70%", marginTop: 8 }]} />
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
                          <View style={{ flex: 1 }} />
                          <TouchableOpacity
                            style={styles.snapConfigureBtn}
                            onPress={() => openUploadEdit(idx)}
                          >
                            <Text style={styles.snapConfigureBtnText}>
                              Configure
                            </Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  </Animated.View>
                ))}

                {aiMetaList.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyStateText}>
                      No items matched your scan.
                    </Text>
                    <TouchableOpacity
                      style={[styles.skipBtn, { marginTop: 12 }]}
                      onPress={
                        uploadSource === "library"
                          ? pickDifferentLibraryPhoto
                          : reset
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
            ) : null}

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
                    {aiMetaList.length} item{aiMetaList.length === 1 ? "" : "s"}{" "}
                    ready to style
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
                      onPress={() => router.push("/closet")}
                    >
                      <Text style={styles.donePrimaryBtnText}>VIEW CLOSET</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.doneSecondaryBtn}
                      onPress={
                        uploadSource === "library"
                          ? pickDifferentLibraryPhoto
                          : reset
                      }
                    >
                      <Text style={styles.doneSecondaryBtnText}>
                        {uploadSource === "library"
                          ? "ADD MORE PHOTOS"
                          : "SCAN ANOTHER ITEM"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ) : null}
          </ScrollView>

          {status === "review" ? (
            <View
              style={[
                styles.reviewStickyBar,
                { paddingBottom: Math.max(insets.bottom, 16) },
              ]}
            >
              <TouchableOpacity
                style={styles.reviewStickySecondary}
                onPress={
                  uploadSource === "library" ? pickDifferentLibraryPhoto : reset
                }
                disabled={uploading}
              >
                <Text style={styles.reviewStickySecondaryText}>
                  {uploadSource === "library" ? "Change photos" : "Rescan"}
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
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "transparent",
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
    backgroundColor: "#000",
  },
  cameraRollPlaceholder: {
    backgroundColor: Colors.bg,
  },
  libraryPassThrough: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  analyzingFullScreen: {
    flex: 1,
    backgroundColor: Colors.bg,
    justifyContent: "center",
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

  modeToggle: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 30,
    padding: 4,
  },
  modeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 24,
  },
  modeBtnActive: {
    backgroundColor: Colors.accent,
  },
  modeText: {
    fontSize: 10,
    fontWeight: "900",
    color: "rgba(255,255,255,0.5)",
    letterSpacing: 1,
  },
  modeTextActive: {
    color: "#000",
  },

  reticle: {
    width: width * 0.75,
    aspectRatio: 3 / 4,
    alignSelf: "center",
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  reticleText: {
    position: "absolute",
    top: -30,
    color: Colors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 3,
  },
  corner: {
    position: "absolute",
    width: 30,
    height: 30,
    borderColor: "rgba(255,255,255,0.5)",
  },
  tl: { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2 },
  tr: { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2 },
  br: { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2 },
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
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
  },
  reviewWrapperHost: {
    flex: 1,
    flexDirection: "column",
  },
  fullscreenBackdrop: {
    flex: 1,
    backgroundColor: "#000",
  },
  fullscreenImage: {
    flex: 1,
    width: "100%",
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
    width: 130,
    alignSelf: "stretch",
    backgroundColor: "#FFFFFF",
    padding: 10,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 12,
    overflow: "hidden",
  },
  isolatedThumbImg: {
    width: "100%",
    height: 150,
  },
  shimmerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  classifyingMeta: {
    flex: 1,
    paddingTop: 8,
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
    flexDirection: "row",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.07)",
    minHeight: 170,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  snapItemThumb: {
    width: 130,
    height: 160,
    backgroundColor: Colors.surface,
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
  snapConfigureBtn: {
    marginTop: 4,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: "#000",
    alignItems: "center",
  },
  snapConfigureBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
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
});
