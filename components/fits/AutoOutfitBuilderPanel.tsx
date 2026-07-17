/**
 * AutoOutfitBuilderPanel — Get Styled (fits sheet)
 *
 * Matches Fits / closet sheet: light surfaces, black chips, minimal chrome.
 */
import { useUser } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { Image as ExpoImage } from "expo-image";
import * as Location from "expo-location";
import { MapPin } from "lucide-react-native";
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    Alert,
    Keyboard,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
    Colors,
    Editorial,
    EditorialStyles,
    Fonts,
    Radii,
    Styles,
    Typography,
} from "../../constants/AppTheme";
import {
    STYLE_ME_MANUAL_OCCASION,
    STYLE_ME_OCCASIONS_FOR_WHEEL,
    STYLE_ME_WHEEL_OCCASIONS,
} from "../../constants/styleMeWheelOccasions";
import {
    fetchRecentGeneratedItemIds,
    generateAutoOutfitBatch,
    idsToBuilderItems,
    recordStylistGeneration,
} from "../../lib/autoOutfitBatch";
import { closetGridImageUri } from "../../lib/clothingItemDisplay";
import { supabase } from "../../lib/supabase";
import { fetchOptionalOpenMeteo } from "../../lib/weatherSnapshot";
import { ClosetItemImage } from "../closet/ClosetItemImage";
import { ClosetToolbarSearchToggle } from "../closet/ClosetSearchSortFilterBar";
import {
    WeatherLocationPickerModal,
    type WeatherLocationHit,
} from "../home/WeatherLocationPickerModal";
import ClosetPickerPanel from "./ClosetPickerPanel";
import {
    OCCASION_WHEEL_NONE_KEY,
    OccasionSpinWheel,
    type OccasionWheelOccasion,
} from "./OccasionSpinWheel";
import type { BuilderItem, ClosetItem } from "./types";
const HOME_BG_SOURCE = require("../../assets/images/home-bg.png");

export type ApplyOutfitPayload = {
  items: BuilderItem[];
  heroImageUri: string | null;
  title: string;
  occasionLabelForTryOn: string;
  occasionId: string;
  openCalendar?: boolean;
  fromAutoBuilder?: boolean;
  anchorItemIds?: string[];
  colorHarmony?: boolean;
  extraUserText?: string;
  keepBuilderPanelOpen?: boolean;
  builderPrompt?: string;
  builderOccasionKey?: string;
  reasoning?: string;
};

export type AutoLookSummary = {
  key: string;
  heroUri: string | null;
  title: string;
  reasoning?: string;
  /** Closet item ids for this look — used to swap onto the canvas from the strip. */
  itemIds?: string[];
};

export type AutoLooksSummaryPayload = {
  looks: AutoLookSummary[];
  generating: boolean;
  progress?: number;
  statusText?: string;
};

export type BuilderFormSeed = {
  prompt: string;
  occasionKey: string;
  nonce: number;
};

export type AutoOutfitBuilderPanelProps = {
  presentation: "floating" | "sheet";
  active: boolean;
  onClose: () => void;
  closetItems: ClosetItem[];
  bodyPhotoUrl: string | null;
  /** Styling direction preference (profiles.gender) — feeds the stylist so
   * outfit selection, not just the mannequin, follows it. */
  genderPref?: string | null;
  /** Onboarding style moods; applied as gentle ranking preferences only. */
  styleArchetypes?: readonly string[] | null;
  seedBuildAroundItemIds?: string[];
  onConsumeBuildAroundSeed?: () => void;
  formSeed?: BuilderFormSeed | null;
  onConsumeFormSeed?: () => void;
  onApplyOutfit: (p: ApplyOutfitPayload) => void;
  onLooksSummaryChange?: (payload: AutoLooksSummaryPayload) => void;
};

export type AutoOutfitBuilderPanelRef = {
  regenerate: () => void;
  shuffleRecipe: () => void;
  applyLookByKey: (key: string) => void;
  cancelGeneration: () => void;
};

// ─── Occasions ──────────────────────────────────────────────────────────────────

const LOADING_STEPS = [
  "Finding pieces that match your vibe…",
  "Checking the local forecast…",
  "Balancing colors and textures…",
  "Styling your unique look…",
  "Finishing touches…",
];

/** Get Styled always requests this many stylist variations per run. */
export const LOOK_BATCH_COUNT = 5;

// ─── Component ────────────────────────────────────────────────────────────────

const decodeWeather = (code: number) => {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly Cloudy";
  if (code >= 51 && code <= 67) return "Rain";
  if (code >= 95) return "Thunderstorm";
  return "Mostly Sunny";
};

const AutoOutfitBuilderPanel = forwardRef<
  AutoOutfitBuilderPanelRef,
  AutoOutfitBuilderPanelProps
>(function AutoOutfitBuilderPanel(
  {
    active: live,
    onClose,
    closetItems,
    genderPref,
    styleArchetypes,
    seedBuildAroundItemIds,
    onConsumeBuildAroundSeed,
    formSeed,
    onConsumeFormSeed,
    onApplyOutfit,
    onLooksSummaryChange,
  },
  ref,
) {
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const [selectedOccasion, setSelectedOccasion] =
    useState<OccasionWheelOccasion | null>(null);
  /** Sync mirror — wheel commits before React re-renders; Go must read this. */
  const selectedOccasionRef = useRef<OccasionWheelOccasion | null>(null);
  const genCancelledRef = useRef(false);
  const loadingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const [anchorIds, setAnchorIds] = useState<Set<string>>(new Set());
  const [useWeather, setUseWeather] = useState(true);
  const [extraNotes, setExtraNotes] = useState("");
  const [pinsOverlayOpen, setPinsOverlayOpen] = useState(false);
  const [draftPinIds, setDraftPinIds] = useState<Set<string>>(new Set());
  const [pinsCategory, setPinsCategory] = useState("All");
  const [pinsSearch, setPinsSearch] = useState("");
  const [pinsToolbarExpanded, setPinsToolbarExpanded] = useState(false);
  const [working, setWorking] = useState(false);
  const [loadingText, setLoadingText] = useState(LOADING_STEPS[0]!);
  const [weatherData, setWeatherData] = useState<any>(null);
  const [locationName, setLocationName] = useState("Detecting...");
  const [isLocationModalVisible, setLocationModalVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchTimer, setSearchTimer] = useState<any>(null);
  const [styleMeLocBusy, setStyleMeLocBusy] = useState(false);

  const activeOccasionDisplay = selectedOccasion ?? STYLE_ME_MANUAL_OCCASION;
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const s1 = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const s2 = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      s1.remove();
      s2.remove();
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // Check-only on mount — opening the panel must NOT trigger the OS
        // location prompt. If access was already granted we personalize with
        // the device location; otherwise we quietly default to NYC. The user
        // can opt in explicitly via the location picker's "use my location"
        // button (usePanelDeviceWeatherLocation), which does prompt.
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status === "granted") {
          const loc = await Location.getCurrentPositionAsync({});
          const data = await fetchOptionalOpenMeteo({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          });
          if (data) setWeatherData(data);

          const address = await Location.reverseGeocodeAsync({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          });
          if (address && address[0]) {
            setLocationName(
              address[0].city || address[0].name || "Current Location",
            );
          }
        } else {
          // Default NYC
          const data = await fetchOptionalOpenMeteo({
            latitude: 40.7128,
            longitude: -74.006,
          });
          if (data) setWeatherData(data);
          setLocationName("New York");
        }
      } catch (err) {
        console.error("AutoBuilder weather/location fetch failed:", err);
      }
    })();
  }, []);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (searchTimer) clearTimeout(searchTimer);

    if (query.trim().length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`,
        );
        const data = await res.json();
        setSearchResults(data.results || []);
      } catch (e) {
        console.error("Geocoding search failed", e);
      } finally {
        setIsSearching(false);
      }
    }, 400);
    setSearchTimer(timer);
  };

  const selectCity = async (city: any) => {
    setLocationModalVisible(false);
    setSearchQuery("");
    setSearchResults([]);
    setIsSearching(false);
    setLocationName(city.name);

    try {
      const data = await fetchOptionalOpenMeteo({
        latitude: city.latitude,
        longitude: city.longitude,
      });
      if (data) setWeatherData(data);
    } catch (e) {
      console.error("Weather fetch failed for city", e);
    }
  };

  const handleLocationSearchSubmit = () => {
    if (searchResults.length > 0) {
      void selectCity(searchResults[0]);
      return;
    }
    Keyboard.dismiss();
  };

  const usePanelDeviceWeatherLocation = async () => {
    setStyleMeLocBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location is off",
          "Turn on location in Settings, or search for your city.",
        );
        return;
      }
      const loc = await Location.getCurrentPositionAsync({});
      Keyboard.dismiss();
      setLocationModalVisible(false);
      setSearchQuery("");
      setSearchResults([]);
      setIsSearching(false);

      const data = await fetchOptionalOpenMeteo({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
      if (data) setWeatherData(data);
      const address = await Location.reverseGeocodeAsync({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
      if (address && address[0]) {
        setLocationName(
          address[0].city || address[0].name || "Current Location",
        );
      }
    } catch {
      Alert.alert("Couldn’t get location", "Try searching by city.");
    } finally {
      setStyleMeLocBusy(false);
    }
  };

  useEffect(() => {
    if (!live || !formSeed) return;
    const occ = STYLE_ME_WHEEL_OCCASIONS.find(
      (o) => o.key === formSeed.occasionKey && o.key !== "custom",
    );
    if (occ) {
      selectedOccasionRef.current = occ;
      setSelectedOccasion(occ);
    }
    if (formSeed.prompt?.trim()) setExtraNotes(formSeed.prompt.trim());
    onConsumeFormSeed?.();
  }, [live, formSeed, onConsumeFormSeed]);

  useEffect(() => {
    if (!live || !seedBuildAroundItemIds?.length) return;
    setAnchorIds(new Set(seedBuildAroundItemIds.slice(0, 3)));
    onConsumeBuildAroundSeed?.();
  }, [live, seedBuildAroundItemIds, onConsumeBuildAroundSeed]);

  const toggleDraftPin = useCallback((id: string) => {
    setDraftPinIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) {
        next.add(id);
        void Haptics.selectionAsync();
      } else {
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning,
        );
      }
      return next;
    });
  }, []);

  const openPinsPicker = useCallback(() => {
    void Haptics.selectionAsync();
    setDraftPinIds(new Set(anchorIds));
    setPinsCategory("All");
    setPinsSearch("");
    setPinsToolbarExpanded(false);
    setPinsOverlayOpen(true);
  }, [anchorIds]);

  const cancelPinsPicker = useCallback(() => {
    setPinsOverlayOpen(false);
    setPinsToolbarExpanded(false);
  }, []);

  const commitPinsPicker = useCallback(() => {
    setAnchorIds(new Set(draftPinIds));
    setPinsOverlayOpen(false);
    setPinsToolbarExpanded(false);
    void Haptics.selectionAsync();
  }, [draftPinIds]);

  const pinnedItems = useMemo(() => {
    return Array.from(anchorIds)
      .map((id) => closetItems.find((c) => c.id === id))
      .filter(Boolean) as ClosetItem[];
  }, [anchorIds, closetItems]);

  const handleWheelOccasion = useCallback(
    (occ: OccasionWheelOccasion | null) => {
      selectedOccasionRef.current = occ;
      // null means the Manual slice was selected
      setSelectedOccasion((prev) => {
        const nk = occ?.key ?? OCCASION_WHEEL_NONE_KEY;
        const pk = prev?.key ?? OCCASION_WHEEL_NONE_KEY;
        if (pk === nk) return prev;
        return occ; // null for None, object otherwise
      });
    },
    [],
  );

  const runGenerate = useCallback(async () => {
    if (!closetItems.length) {
      Alert.alert("Closet empty", "Add a few pieces first.");
      return;
    }

    const occasion = selectedOccasionRef.current;

    // Manual mode requires a custom prompt
    if (!occasion && !extraNotes.trim()) {
      Alert.alert(
        "Prompt required",
        "You selected Manual — describe what you need in the prompt field to guide the AI.",
      );
      return;
    }

    setPinsOverlayOpen(false);

    genCancelledRef.current = false;
    if (loadingIntervalRef.current) {
      clearInterval(loadingIntervalRef.current);
      loadingIntervalRef.current = null;
    }

    setWorking(true);
    setLoadingText(LOADING_STEPS[0]!);
    let stepIdx = 0;
    loadingIntervalRef.current = setInterval(() => {
      if (genCancelledRef.current) return;
      stepIdx = (stepIdx + 1) % LOADING_STEPS.length;
      const nextText = LOADING_STEPS[stepIdx]!;
      setLoadingText(nextText);
      onLooksSummaryChange?.({
        looks: [],
        generating: true,
        statusText: nextText,
      });
    }, 1800);

    onLooksSummaryChange?.({
      looks: [],
      generating: true,
      statusText: LOADING_STEPS[0]!,
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const notes = extraNotes.trim();
      // Manual → notes IS the full prompt; preset → use phrase
      const occasionPhrase = !occasion
        ? notes // required (validated above)
        : occasion.phrase?.trim()
          ? occasion.phrase.trim()
          : "A stylish outfit";
      const occasionLabelForTryOn = !occasion
        ? occasionPhrase.slice(0, 120) // notes already IS the phrase
        : notes.length > 0
          ? `${occasionPhrase} · ${notes}`.slice(0, 120)
          : occasionPhrase.slice(0, 120);

      const weather = useWeather
        ? await fetchOptionalOpenMeteo().catch(() => undefined)
        : undefined;
      if (genCancelledRef.current) return;

      const anchors = Array.from(anchorIds);

      const recentOutfitItemIds = user?.id
        ? await fetchRecentGeneratedItemIds(supabase, user.id)
        : [];
      if (genCancelledRef.current) return;

      const raw = await generateAutoOutfitBatch({
        count: LOOK_BATCH_COUNT,
        occasionPhrase,
        closetItems,
        weather,
        anchorItemIds: anchors,
        colorHarmony: true,
        onlyCloset: true,
        extraUserText: notes || undefined,
        genderStylePref: genderPref,
        styleArchetypes,
        recentOutfitItemIds,
      });

      if (genCancelledRef.current) return;
      if (!raw.length) throw new Error("Couldn't create a look — try again.");

      // Rotation bookkeeping: record EVERY generated look (including the
      // alternatives the user never applies) so they can't repeat next batch.
      if (user?.id) {
        void recordStylistGeneration(
          supabase,
          user.id,
          raw.map((o) => o.item_ids),
          "batch",
        );
      }

      const plans = raw.slice(0, LOOK_BATCH_COUNT);
      const lookSummaries: AutoLookSummary[] = [];

      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]!;
        const title = plan.title?.trim() || `Look ${i + 1}`;
        const reasoning = plan.reasoning?.trim() ?? "";
        lookSummaries.push({
          key: `look-${i}`,
          heroUri: null,
          title,
          reasoning,
          itemIds: plan.item_ids,
        });
      }

      const firstPlan = plans[0]!;
      const firstItems = idsToBuilderItems(firstPlan.item_ids, closetItems);
      const firstSummary = lookSummaries[0]!;
      if (genCancelledRef.current) return;

      onApplyOutfit({
        items: firstItems,
        heroImageUri: null,
        title: firstSummary.title,
        occasionLabelForTryOn,
        occasionId: occasion?.key || "casual",
        fromAutoBuilder: true,
        anchorItemIds: anchors,
        colorHarmony: true,
        keepBuilderPanelOpen: true,
        builderOccasionKey: occasion?.key,
        builderPrompt: notes,
        extraUserText: notes || undefined,
        reasoning: firstSummary.reasoning,
      });

      onLooksSummaryChange?.({
        looks: lookSummaries,
        generating: false,
        progress: 100,
        statusText: "Looks ready",
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (!genCancelledRef.current) {
        const msg = e instanceof Error ? e.message : "Something went wrong.";
        Alert.alert("Generate failed", msg);
        onLooksSummaryChange?.({ looks: [], generating: false, progress: 0 });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      }
    } finally {
      if (loadingIntervalRef.current) {
        clearInterval(loadingIntervalRef.current);
        loadingIntervalRef.current = null;
      }
      setWorking(false);
    }
  }, [
    anchorIds,
    closetItems,
    extraNotes,
    genderPref,
    styleArchetypes,
    onApplyOutfit,
    onLooksSummaryChange,
    useWeather,
  ]);

  const cancelGeneration = useCallback(() => {
    genCancelledRef.current = true;
    if (loadingIntervalRef.current) {
      clearInterval(loadingIntervalRef.current);
      loadingIntervalRef.current = null;
    }
    setWorking(false);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      regenerate: () => {
        void runGenerate();
      },
      shuffleRecipe: () => {
        void runGenerate();
      },
      applyLookByKey: () => {},
      cancelGeneration,
    }),
    [runGenerate, cancelGeneration],
  );

  if (!live) return null;

  // While generating, the LooksTray in the strip handles all loading UI.
  if (working) return null;

  const swipeDismissGesture = Gesture.Pan()
    .activeOffsetY([0, 12])
    .failOffsetX([-16, 16])
    .onEnd((e) => {
      "worklet";
      if (e.translationY > 60 || e.velocityY > 600) {
        runOnJS(onClose)();
      }
    });

  return (
    <GestureDetector gesture={swipeDismissGesture}>
      <View style={sty.kbWrap}>
        <View style={sty.root}>
          <View style={sty.backdropFill} />
          <ExpoImage
            source={HOME_BG_SOURCE}
            style={StyleSheet.absoluteFillObject}
            contentFit="cover"
            pointerEvents="none"
          />
          <BlurView
            intensity={100}
            tint="light"
            style={StyleSheet.absoluteFill}
          >
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: Editorial.cardBgMuted },
              ]}
            />
          </BlurView>

          {/* Drag handle */}
          <View style={sty.dragHandleWrap} pointerEvents="none">
            <View style={sty.dragHandle} />
          </View>

          <TouchableOpacity
            onPress={onClose}
            hitSlop={12}
            style={[
              sty.closeBtn,
              { position: "absolute", top: 12, right: 16, zIndex: 1000 },
            ]}
          >
            <Ionicons name="close" size={22} color={Colors.text} />
          </TouchableOpacity>

          <View style={sty.keyboardAvoid}>
            <Animated.ScrollView
              style={sty.flex1}
              contentContainerStyle={[
                sty.bodyMain,
                { paddingBottom: Math.max(insets.bottom, 10) + 120 },
              ]}
              scrollEnabled
              bounces={false}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={sty.heroHeader}>
                <Text style={sty.headerTitle}>Choose an occasion</Text>
                <Text style={[sty.listCardSub, { marginTop: 2, fontSize: 13 }]}>
                  Select a preset, or describe what you need below.
                </Text>
              </View>
              <View style={sty.splitRow}>
                <OccasionSpinWheel
                  variant="glass"
                  occasions={STYLE_ME_OCCASIONS_FOR_WHEEL}
                  selectedKey={selectedOccasion?.key ?? OCCASION_WHEEL_NONE_KEY}
                  onSelect={handleWheelOccasion}
                />
                <View style={sty.rail}>
                  <View style={sty.railIconCircle}>
                    <Ionicons
                      name={activeOccasionDisplay.icon}
                      size={24}
                      color={Colors.text}
                    />
                  </View>
                  <Text style={sty.railOccasionTitle}>
                    {activeOccasionDisplay.label}
                  </Text>
                  <Text style={sty.railOccasionPhrase}>
                    {activeOccasionDisplay.phrase}
                  </Text>
                </View>
              </View>

              <View style={sty.notesCard}>
                <View
                  style={[
                    sty.listCardIconBox,
                    sty.listCardIconBoxBeige,
                    { width: 32, height: 32, borderRadius: 10, marginTop: 2 },
                  ]}
                >
                  <Ionicons
                    name="pencil-outline"
                    size={17}
                    color={Colors.textMuted}
                  />
                </View>
                <View style={sty.flex1}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <Text style={[sty.listCardTitle, { fontSize: 13 }]}>
                      {selectedOccasion === null
                        ? "What you need"
                        : "Additional instructions"}
                    </Text>
                    <Text
                      style={[
                        sty.listCardOptionalTxt,
                        {
                          fontSize: 9,
                          color:
                            selectedOccasion === null ? "#E05252" : undefined,
                        },
                      ]}
                    >
                      {selectedOccasion === null ? "Required" : "Optional"}
                    </Text>
                  </View>
                  <TextInput
                    value={extraNotes}
                    onChangeText={setExtraNotes}
                    placeholder={
                      selectedOccasion === null
                        ? "What do you need help styling for?"
                        : "Any specific requirements?"
                    }
                    placeholderTextColor={Colors.textMuted}
                    style={[sty.notesInput, { minHeight: 40, paddingTop: 0 }]}
                    multiline
                    textAlignVertical="top"
                    maxLength={420}
                    returnKeyType="done"
                    blurOnSubmit
                    onSubmitEditing={() => Keyboard.dismiss()}
                  />
                </View>
              </View>

              <View style={sty.listCardsStack}>
                <View style={sty.listCardsRow}>
                  {/* Weather Card */}
                  <View style={[sty.listCard, sty.flex1, { minHeight: 110 }]}>
                    <View style={sty.listCardTopRow}>
                      <View
                        style={[
                          sty.listCardIconBox,
                          sty.listCardIconBoxBeige,
                          { width: 36, height: 36, borderRadius: 12 },
                        ]}
                      >
                        <Ionicons
                          name="partly-sunny-outline"
                          size={20}
                          color={Colors.text}
                        />
                      </View>
                      <TouchableOpacity
                        onPress={() => {
                          void Haptics.selectionAsync();
                          setUseWeather(!useWeather);
                        }}
                        style={[
                          sty.toggleSwitchSmall,
                          useWeather && sty.toggleSwitchOn,
                        ]}
                        activeOpacity={1}
                      >
                        <View
                          style={[
                            sty.toggleThumbSmall,
                            useWeather && sty.toggleThumbOnSmall,
                          ]}
                        />
                      </TouchableOpacity>
                    </View>

                    <View style={{ marginTop: 8 }}>
                      <Text style={sty.listCardTitle}>Weather</Text>
                      <Text style={[sty.listCardSub, { fontSize: 10 }]}>
                        AI will style for the weather.
                      </Text>
                    </View>

                    <View
                      style={{
                        marginTop: 8,
                        flex: 1,
                        justifyContent: "flex-end",
                      }}
                    >
                      {useWeather ? (
                        <>
                          {weatherData ? (
                            <View style={{ gap: 2 }}>
                              <View style={sty.miniWeatherRow}>
                                <Text style={sty.weatherTempTxtMini}>
                                  {Math.round(
                                    weatherData.current.temperature_2m,
                                  )}
                                  °
                                </Text>
                                <Text style={sty.weatherDescTxtMini}>
                                  {decodeWeather(
                                    weatherData.current.weather_code,
                                  )}
                                </Text>
                              </View>
                              <Text
                                style={[
                                  sty.weatherHiLoTxt,
                                  { fontSize: 9, marginTop: 0 },
                                ]}
                              >
                                H:{" "}
                                {Math.round(
                                  weatherData.daily.temperature_2m_max[0],
                                )}
                                ° L:{" "}
                                {Math.round(
                                  weatherData.daily.temperature_2m_min[0],
                                )}
                                °
                              </Text>
                            </View>
                          ) : (
                            <Text style={sty.weatherDescTxtMini}>
                              Loading...
                            </Text>
                          )}
                          <TouchableOpacity
                            style={sty.weatherChangeLocBtnMini}
                            onPress={() => setLocationModalVisible(true)}
                            activeOpacity={0.7}
                          >
                            <MapPin
                              size={10}
                              color={Colors.accent}
                              fill={Colors.accent}
                            />
                            <Text
                              style={sty.weatherChangeLocTxtMini}
                              numberOfLines={1}
                            >
                              {locationName}
                            </Text>
                          </TouchableOpacity>
                        </>
                      ) : (
                        <Text style={sty.weatherDescTxtMini}>
                          Weather disabled
                        </Text>
                      )}
                    </View>
                  </View>

                  {/* Must-haves Card */}
                  <TouchableOpacity
                    style={[
                      sty.listCard,
                      sty.flex1,
                      { minHeight: 110, paddingHorizontal: 10 },
                    ]}
                    onPress={openPinsPicker}
                    activeOpacity={0.88}
                  >
                    <View style={sty.listCardTopRow}>
                      <View
                        style={[
                          sty.listCardIconBox,
                          sty.listCardIconBoxBeige,
                          { width: 36, height: 36, borderRadius: 12 },
                        ]}
                      >
                        <Ionicons
                          name="bookmark-outline"
                          size={18}
                          color={Colors.text}
                        />
                      </View>
                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={Colors.textMuted}
                      />
                    </View>

                    <View style={{ marginTop: 8 }}>
                      <Text style={sty.listCardTitle}>Must-haves</Text>
                      <Text
                        style={[
                          sty.listCardOptionalTxt,
                          { fontSize: 9, marginVertical: 1 },
                        ]}
                      >
                        Optional
                      </Text>
                      <Text style={[sty.listCardSub, { fontSize: 10 }]}>
                        Pieces to definitely use.
                      </Text>
                    </View>

                    <View
                      style={{
                        marginTop: 8,
                        flex: 1,
                        justifyContent: "flex-end",
                      }}
                    >
                      {anchorIds.size > 0 ? (
                        <View style={sty.mustHavesListMini}>
                          {[0, 1, 2].map((slot) => {
                            const it = pinnedItems[slot];
                            const uri = it ? closetGridImageUri(it) : undefined;
                            if (!uri) return null;
                            return (
                              <View
                                key={slot}
                                style={[
                                  sty.mustHaveImgBoxMini,
                                  { width: 44, height: 44, borderRadius: 10 },
                                ]}
                              >
                                <ClosetItemImage
                                  uri={uri}
                                  style={sty.mustHaveImg}
                                />
                              </View>
                            );
                          })}
                          {anchorIds.size > 3 && (
                            <View
                              style={[
                                sty.mustHavePlusBoxMini,
                                { width: 44, height: 44, borderRadius: 10 },
                              ]}
                            >
                              <Text
                                style={[
                                  sty.mustHavePlusTxtMini,
                                  { fontSize: 12 },
                                ]}
                              >
                                +{anchorIds.size - 3}
                              </Text>
                            </View>
                          )}
                        </View>
                      ) : (
                        <Text style={sty.weatherDescTxtMini}>
                          No items pinned
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                </View>
              </View>
            </Animated.ScrollView>
          </View>

          {/* Sticky CTA */}
          {!keyboardVisible && (
            <View style={[sty.ctaWrap, { paddingBottom: 16 }]}>
              <BlurView
                intensity={28}
                tint="light"
                style={StyleSheet.absoluteFill}
              />
              <TouchableOpacity
                onPress={() => void runGenerate()}
                activeOpacity={0.88}
                style={[Styles.btnPrimary, Styles.glow, sty.ctaInner]}
              >
                <Text style={Styles.btnPrimaryText}>Create looks</Text>
              </TouchableOpacity>
            </View>
          )}

          <WeatherLocationPickerModal
            visible={isLocationModalVisible}
            title="Weather for Get Styled"
            onDismiss={() => {
              Keyboard.dismiss();
              setLocationModalVisible(false);
              setSearchQuery("");
              setSearchResults([]);
              setIsSearching(false);
            }}
            searchQuery={searchQuery}
            onChangeQuery={handleSearchChange}
            onSubmitSearch={handleLocationSearchSubmit}
            results={searchResults}
            searching={isSearching}
            onPick={(city: WeatherLocationHit) => void selectCity(city)}
            onUseDeviceLocation={usePanelDeviceWeatherLocation}
            deviceLocBusy={styleMeLocBusy}
          />

          <Modal
            visible={pinsOverlayOpen}
            transparent
            animationType="slide"
            onRequestClose={cancelPinsPicker}
          >
            <View style={sty.pinModalRoot}>
              <Pressable
                style={sty.pinModalBackdrop}
                onPress={cancelPinsPicker}
              />
              <View
                style={[
                  sty.pinModalSheet,
                  { paddingBottom: Math.max(insets.bottom, 12) },
                ]}
              >
                <View style={sty.pinModalHeader}>
                  <TouchableOpacity
                    style={sty.pinModalHeaderBtn}
                    onPress={cancelPinsPicker}
                    hitSlop={10}
                  >
                    <Text style={sty.pinModalHeaderBtnLbl}>Cancel</Text>
                  </TouchableOpacity>
                  <Text style={sty.pinModalTitle}>Pin pieces</Text>
                  <View style={sty.pinModalHeaderRight}>
                    <ClosetToolbarSearchToggle
                      expanded={pinsToolbarExpanded}
                      onPress={() => setPinsToolbarExpanded((prev) => !prev)}
                      variant="control"
                    />
                    <TouchableOpacity
                      style={sty.pinModalHeaderBtn}
                      onPress={commitPinsPicker}
                      hitSlop={10}
                    >
                      <Text style={sty.pinModalHeaderBtnLblBold}>Done</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <Text style={sty.pinModalSubtitle}>
                  Tap items to toggle (max 3). AI builds around what you pin.
                </Text>
                <View style={sty.pinPickerWrap}>
                  <ClosetPickerPanel
                    variant="embedded"
                    showHeader={false}
                    mode="anchors"
                    items={closetItems}
                    selected={draftPinIds}
                    onToggle={toggleDraftPin}
                    category={pinsCategory}
                    onCategoryChange={(c) => {
                      void Haptics.selectionAsync();
                      setPinsCategory(c);
                    }}
                    search={pinsSearch}
                    onSearchChange={setPinsSearch}
                    contentBottomPad={24}
                    tileBackgroundColor="transparent"
                    toolbarExpanded={pinsToolbarExpanded}
                    onToolbarExpandedChange={setPinsToolbarExpanded}
                  />
                </View>
              </View>
            </View>
          </Modal>
        </View>
      </View>
    </GestureDetector>
  );
});

AutoOutfitBuilderPanel.displayName = "AutoOutfitBuilderPanel";
export default AutoOutfitBuilderPanel;

// ─── Styles ───────────────────────────────────────────────────────────────────

const sty = StyleSheet.create({
  dragHandleWrap: {
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 2,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.15)",
  },
  kbWrap: { flex: 1 },
  root: {
    flex: 1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
    backgroundColor: Colors.homeHeroBackdrop,
  },
  backdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.homeHeroBackdrop,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 10,
  },
  headerText: { flex: 1, marginRight: 8, minWidth: 0 },
  headerTitle: {
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.35,
  },
  headerSubtitle: {
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    marginTop: 2,
    letterSpacing: -0.1,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    ...EditorialStyles.ghostIconBtn,
    alignItems: "center",
    justifyContent: "center",
  },
  keyboardAvoid: {
    flex: 1,
    minHeight: 0,
  },
  heroHeader: {
    paddingTop: 8,
    paddingBottom: 6,
    paddingRight: 40,
    backgroundColor: "transparent",
  },
  bodyMain: {
    paddingHorizontal: 16,
    paddingTop: 0,
    gap: 4,
  },
  flex1: { flex: 1 },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rail: {
    flex: 1,
    minWidth: 0,
    alignItems: "flex-start",
    paddingTop: 16,
    paddingLeft: 12,
    gap: 4,
  },
  railIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Editorial.iconBtnBg,
    borderWidth: 1,
    borderColor: Editorial.iconBtnBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  railOccasionTitle: {
    fontSize: 19,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.4,
  },
  railOccasionPhrase: {
    fontSize: 11,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    lineHeight: 14,
  },
  customOccasionInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: Typography.weights.medium,
    color: Colors.text,
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  listCardsStack: {
    flexDirection: "column",
    gap: 8,
  },
  listCard: {
    ...EditorialStyles.card,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  customOccasionCard: {
    ...EditorialStyles.card,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  customOccasionCardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  customDoneBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Colors.accent,
    borderRadius: Radii.full,
  },
  customDoneTxt: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: "#fff",
  },
  listCardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  listCardIconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  listCardIconBoxBeige: {
    backgroundColor: "rgba(0,0,0,0.04)",
    borderRadius: 12,
  },
  listCardTextWrap: {
    flex: 1,
    justifyContent: "center",
  },
  listCardTitle: {
    fontSize: 15,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  listCardSub: {
    fontSize: 12,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
    marginTop: 2,
  },
  listCardOptionalTxt: {
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
    color: "#C49B70",
  },
  listCardDivider: {
    height: 0,
    borderTopWidth: 1,
    borderStyle: "dashed",
    borderColor: "rgba(0,0,0,0.08)",
    marginVertical: 10,
  },
  listCardWeatherRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  weatherTempTxt: {
    fontSize: 22,
    fontWeight: Typography.weights.medium,
    color: Colors.text,
  },
  weatherDescCol: {
    justifyContent: "center",
    flexShrink: 1,
  },
  weatherDescTxt: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
  },
  weatherHiLoTxt: {
    fontSize: 11,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
    marginTop: 2,
  },
  weatherChangeLocBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.04)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.full,
    gap: 4,
    flexShrink: 0,
  },
  notesCard: {
    ...EditorialStyles.card,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  notesInput: {
    flex: 1,
    fontSize: 13,
    fontWeight: Typography.weights.medium,
    color: Colors.text,
    lineHeight: 18,
    minHeight: 48,
    paddingTop: 4,
  },
  listCardsRow: {
    flexDirection: "row",
    gap: 6,
  },
  miniCardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  miniWeatherRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  weatherTempTxtMini: {
    fontSize: 18,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
  },
  weatherDescTxtMini: {
    fontSize: 11,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  weatherChangeLocBtnMini: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    gap: 4,
    backgroundColor: "rgba(0,0,0,0.04)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  weatherChangeLocTxtMini: {
    fontSize: 10,
    fontFamily: Fonts.bold,
    color: Colors.text,
    maxWidth: 80,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  mustHavesListMini: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mustHaveImgBoxMini: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: "transparent",
    borderWidth: 0,
    overflow: "hidden",
  },
  mustHavePlusBoxMini: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  mustHavePlusTxtMini: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
  },
  toggleSwitchSmall: {
    width: 34,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.borderStrong,
    padding: 2,
    justifyContent: "center",
  },
  toggleThumbSmall: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.surface,
  },
  toggleThumbOnSmall: {
    transform: [{ translateX: 14 }],
  },
  listCardBottomRow: {
    marginTop: 14,
    paddingLeft: 58,
  },
  mustHavesList: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  mustHaveImgBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "transparent",
    borderWidth: 0,
    overflow: "hidden",
  },
  mustHaveImg: {
    width: "100%",
    height: "100%",
  },
  mustHavePlusBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  mustHavePlusTxt: {
    fontSize: 12,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
  },
  listCardInput: {
    minHeight: 80,
    fontSize: 14,
    fontWeight: Typography.weights.medium,
    color: Colors.text,
    paddingHorizontal: 8,
  },
  toggleSwitch: {
    width: 50,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.borderStrong,
    padding: 2,
    justifyContent: "center",
  },
  toggleSwitchOn: {
    backgroundColor: Colors.accent,
  },
  toggleThumb: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Colors.surface,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
    }),
  },
  toggleThumbOn: {
    transform: [{ translateX: 20 }],
  },
  pinModalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  pinModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "transparent",
  },
  pinModalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    maxHeight: "92%",
    height: "90%",
    paddingTop: 6,
    overflow: "hidden",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.12,
        shadowRadius: 10,
      },
      android: { elevation: 16 },
    }),
  },
  pinModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  pinModalHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 72,
    justifyContent: "flex-end",
  },
  pinModalHeaderBtn: {
    minWidth: 72,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  pinModalHeaderBtnLbl: {
    fontSize: 16,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  pinModalHeaderBtnLblBold: {
    fontSize: 16,
    fontWeight: Typography.weights.bold,
    color: Colors.black,
    textAlign: "right",
  },
  pinModalTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.35,
  },
  pinModalSubtitle: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: Typography.weights.semibold,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 4,
    lineHeight: 17,
    letterSpacing: -0.1,
  },
  pinPickerWrap: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 0,
  },
  ctaWrap: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    overflow: "hidden",
    backgroundColor: Editorial.cardBg,
  },
  ctaInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    width: "100%",
    alignSelf: "stretch",
  },
  miniActionLblPrimary: {
    color: "#fff",
    fontSize: 13,
    fontWeight: Typography.weights.bold,
  },
});
