/**
 * fits.tsx — myOOTD Fits tab
 *
 * Create — manual outfit builder (canvas + closet strip / expanded picker)
 * Library — saved outfits
 */

import { useUser } from "@clerk/clerk-expo";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Image as ExpoImage } from "expo-image";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    Alert,
    DeviceEventEmitter,
    InteractionManager,
    Keyboard,
    LayoutChangeEvent,
    Modal,
    Platform,
    StyleSheet,
    Text,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ClosetItemDetail } from "../../components/closet/ClosetItemDetail";
import type { ClosetItem, SavedFit } from "../../components/fits/types";
import { Colors, EditorialStyles, Fonts } from "../../constants/AppTheme";
import { prefetchFitStudioBackground } from "../../constants/fitStudioBackground";
import { OCCASIONS_FLAT } from "../../constants/occasions";
import { closetGridImageUri } from "../../lib/clothingItemDisplay";
import {
  assignSavedFitToIsoDay,
  fetchPlannedDatesForOutfit,
  isoDayIsStrictlyFuture,
  mergePlannedDates,
  removeFitFromIsoDay,
  updateOutfitName,
} from "../../lib/dayOutfitLog";
import {
  FITS_LIBRARY_PAGE_SIZE,
  fetchFitsLibraryPage,
  mergeFitsById,
  syncFitsFromPage,
} from "../../lib/fetchFitsLibrary";
import type {
  GenerationRecord,
  UnsavedLookSnapshot,
} from "../../lib/latestLooksFeed";
import { fitToUnsavedSnapshot } from "../../lib/latestLooksFeed";
import { parseFitsTopModeFromParams } from "../../lib/fitsNavigation";
import { fitPhotoForExtraction } from "../../lib/fitExtractPhoto";
import { downloadImageToCache } from "../../lib/downloadImageToCache";
import { saveFitExtractItems } from "../../lib/saveFitExtractItems";
import { markOutfitAsWorn } from "../../lib/saveOutfit";
import { confirmLowConfidenceItems } from "../../lib/confirmLowConfidence";
import { supabase } from "../../lib/supabase";
import { useWardrobeContext } from "../../lib/hooks/useWardrobeContext";
import { blockNavigationForActiveTryOn } from "../../lib/tryOnRenderNavigationGuard";
import {
  isExplicitTryOnCutoutUri,
  prepareTryOnImageUri,
} from "../../lib/usePreparedTryOnImage";

import BuilderPanel, {
    type BuilderPanelHandle,
} from "../../components/fits/BuilderPanel";
import FitDetailPager from "../../components/fits/FitDetailPager";
import SavedFitExtractReview from "../../components/fits/SavedFitExtractReview";
import ClosetPicker from "../../components/fits/ClosetPicker";
import { queueOpenClosetItem } from "../../lib/openClosetItem";
import FitLibrary from "../../components/fits/FitLibrary";
import FitPlanSuite from "../../components/fits/FitPlanSuite";
import { PLANNER_CANVAS_BG } from "../../components/ui/PlannerDotGridBackground";
import HomeHeroBackground, {
  STUDIO_BG_SOURCE,
} from "../../components/ui/HomeHeroBackground";
import { attachClothingItemsToOutfit } from "../../lib/linkItemsToOutfit";
import {
  runProgressiveImageExtract,
  uriToBase64,
} from "../add-items";

// ─── ROOT SCREEN ──────────────────────────────────────────────────────────────

/** Temp: hide bottom tab bar on Fits for layout testing */
const DEBUG_HIDE_FITS_TAB_BAR = false;

const TAB_SPRING = { damping: 31, stiffness: 268, mass: 0.88 };
const CHROME_POP_SPRING = { damping: 17, stiffness: 330, mass: 0.62 };

export default function FitsScreen() {
  const { user } = useUser();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const router = useRouter();
  const {
    anchorId,
    remixItemIds,
    initialName,
    initialOccasion,
    landingHeroTryOnUri: landingHeroTryOnUriRaw,
    landingHeroChromaKeyHex,
    plannedDateIso,
    wornOnIso,
    openLibrary,
    librarySection,
    focusDayIso,
    tripId,
    libraryNavAt,
    fitsMode,
    fitsNavAt,
    openFitId,
    editOutfitId,
    editTargetUnsaved,
  } = useLocalSearchParams<{
    anchorId?: string;
    remixItemIds?: string;
    initialName?: string;
    initialOccasion?: string;
    landingHeroTryOnUri?: string;
    landingHeroChromaKeyHex?: string;
    plannedDateIso?: string;
    wornOnIso?: string;
    openLibrary?: string;
    librarySection?: string;
    focusDayIso?: string;
    tripId?: string;
    libraryNavAt?: string;
    fitsMode?: string;
    fitsNavAt?: string;
    openFitId?: string;
    editOutfitId?: string;
    editTargetUnsaved?: string;
  }>();
  const landingHeroTryOnUri =
    typeof landingHeroTryOnUriRaw === "string" &&
    landingHeroTryOnUriRaw.length > 8 &&
    (landingHeroTryOnUriRaw.startsWith("http") ||
      landingHeroTryOnUriRaw.startsWith("data:image") ||
      // Local pre-segmented cutout from the Home widget — shown instantly.
      landingHeroTryOnUriRaw.startsWith("file:"))
      ? landingHeroTryOnUriRaw
      : undefined;


  const focusDayInitial =
    typeof focusDayIso === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(focusDayIso.trim())
      ? focusDayIso.trim()
      : undefined;

  const [fitsTopMode, setFitsTopMode] = useState<"build" | "library" | "plan">(
    () =>
      parseFitsTopModeFromParams({
        fitsMode,
        openLibrary,
        librarySection,
      }) ?? "build",
  );
  const [planFocusDay, setPlanFocusDay] = useState<string | undefined>(
    focusDayInitial,
  );
  const [planFocusNonce, setPlanFocusNonce] = useState(0);
  const planTripInitial =
    typeof tripId === "string" && tripId.trim().length > 0
      ? tripId.trim()
      : undefined;
  const [planTripId, setPlanTripId] = useState<string | undefined>(
    planTripInitial,
  );
  const [planTripNonce, setPlanTripNonce] = useState(0);

  useEffect(() => {
    const modeFromParams = parseFitsTopModeFromParams({
      fitsMode,
      openLibrary,
      librarySection,
    });
    if (!modeFromParams) return;
    if (blockNavigationForActiveTryOn()) return;

    setFitsTopMode(modeFromParams);
    if (modeFromParams === "plan") {
      setPlanFocusDay(focusDayInitial);
      setPlanFocusNonce((n) => n + 1);
      if (planTripInitial) {
        setPlanTripId(planTripInitial);
        setPlanTripNonce((n) => n + 1);
      }
    }
  }, [
    fitsMode,
    fitsNavAt,
    openLibrary,
    librarySection,
    focusDayInitial,
    planTripInitial,
    libraryNavAt,
  ]);

  /** 0 = Build, 1 = Library, 2 = Plan — drives pane crossfade */
  const modeIndex = useSharedValue(0);
  /** 0 = Build chrome, 1 = Library/Plan (hides builder float controls) */
  const tabBlend = useSharedValue(0);
  /** Springs in closet strip + action pill after Build pane settles. */
  const chromeRevealSv = useSharedValue(1);

  /** Measured Fits body height — drives slide distance */
  const clipHShared = useSharedValue(Math.max(windowHeight, 480));

  const fitsChromeExpandSv = useSharedValue(0);

  /** Canvas undo/clear drawer — collapsed by default beside the mode pill */
  const [canvasToolsExpanded, setCanvasToolsExpanded] = useState(false);
  const [canvasCanUndo, setCanvasCanUndo] = useState(false);
  const [canvasCanRedo, setCanvasCanRedo] = useState(false);
  const canvasToolsExpandSv = useSharedValue(0);
  const [styleMeModeActive, setStyleMeModeActive] = useState(false);
  const [tryOnModeActive, setTryOnModeActive] = useState(false);
  const [tryOnRendering, setTryOnRendering] = useState(false);

  const handleStyleMeModeChange = useCallback((active: boolean) => {
    setStyleMeModeActive(active);
  }, []);

  const handleTryOnModeChange = useCallback((active: boolean) => {
    setTryOnModeActive(active);
  }, []);

  const handleTryOnRenderingChange = useCallback((active: boolean) => {
    setTryOnRendering(active);
  }, []);

  useEffect(() => {
    if (!tryOnRendering) return;
    return navigation.addListener("beforeRemove", (event) => {
      event.preventDefault();
      blockNavigationForActiveTryOn();
    });
  }, [navigation, tryOnRendering]);

  useEffect(() => {
    canvasToolsExpandSv.value = withTiming(canvasToolsExpanded ? 1 : 0, {
      duration: 220,
      easing: Easing.bezier(0.33, 0, 0.2, 1),
    });
  }, [canvasToolsExpanded, canvasToolsExpandSv]);

  const canvasToolsActionsStyle = useAnimatedStyle(() => ({
    opacity: canvasToolsExpandSv.value,
    maxHeight: interpolate(
      canvasToolsExpandSv.value,
      [0, 1],
      [0, 136],
      Extrapolation.CLAMP,
    ),
    marginTop: interpolate(
      canvasToolsExpandSv.value,
      [0, 1],
      [0, 8],
      Extrapolation.CLAMP,
    ),
    overflow: "hidden" as const,
  }));

  const builderRef = useRef<BuilderPanelHandle>(null);

  /** True height from layout (0 until first layout) */
  const [carouselClipH, setCarouselClipH] = useState(0);

  /** Defer mounting Library until transitions + studio decode settle (Build-first users avoid double subtree cost). */
  const [libraryDeferredReady, setLibraryDeferredReady] = useState(false);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setLibraryDeferredReady(true);
    });
    return () => task.cancel();
  }, []);

  const libraryPaneMounted =
    fitsTopMode === "library" || fitsTopMode === "plan" || libraryDeferredReady;
  const planPaneMounted = libraryPaneMounted;

  const scheduleRemoteImagePrefetch = useCallback((urls: string[]) => {
    if (!urls.length) return;
    InteractionManager.runAfterInteractions(() => {
      void ExpoImage.prefetch(urls, "memory-disk");
    });
  }, []);

  const carouselH =
    carouselClipH > 0 ? carouselClipH : Math.max(windowHeight, 480);

  const onBodyStackLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (!(h > 0)) return;
    clipHShared.value = h;
    setCarouselClipH(h);
  }, []);

  useEffect(() => {
    const idx =
      fitsTopMode === "build" ? 0 : fitsTopMode === "library" ? 1 : 2;
    modeIndex.value = withSpring(idx, TAB_SPRING);
    if (fitsTopMode === "build") {
      Keyboard.dismiss();
      tabBlend.value = withSpring(0, TAB_SPRING);
      chromeRevealSv.value = withDelay(185, withSpring(1, CHROME_POP_SPRING));
    } else {
      Keyboard.dismiss();
      tabBlend.value = withSpring(1, TAB_SPRING);
      chromeRevealSv.value = withTiming(0, {
        duration: 110,
        easing: Easing.out(Easing.cubic),
      });
    }
  }, [fitsTopMode, tabBlend, chromeRevealSv, modeIndex]);

  const buildPaneStyle = useAnimatedStyle(() => {
    const drift = Math.min(clipHShared.value * 0.032, 22);
    return {
      opacity: interpolate(
        modeIndex.value,
        [0, 0.5, 1],
        [1, 0.2, 0],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateY: interpolate(
            modeIndex.value,
            [0, 1],
            [0, -drift],
            Extrapolation.CLAMP,
          ),
        },
        {
          scale: interpolate(
            modeIndex.value,
            [0, 1],
            [1, 0.988],
            Extrapolation.CLAMP,
          ),
        },
      ],
      zIndex: modeIndex.value < 0.45 ? 2 : 0,
    };
  });

  const libraryPaneStyle = useAnimatedStyle(() => {
    const drift = Math.min(clipHShared.value * 0.038, 26);
    return {
      opacity: interpolate(
        modeIndex.value,
        [0, 0.45, 1, 1.55, 2],
        [0, 0.85, 1, 0.2, 0],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateY: interpolate(
            modeIndex.value,
            [0, 1],
            [drift, 0],
            Extrapolation.CLAMP,
          ),
        },
        {
          scale: interpolate(
            modeIndex.value,
            [0, 1],
            [0.984, 1],
            Extrapolation.CLAMP,
          ),
        },
      ],
      zIndex:
        modeIndex.value >= 0.45 && modeIndex.value < 1.55 ? 2 : 0,
    };
  });

  const planPaneStyle = useAnimatedStyle(() => {
    const drift = Math.min(clipHShared.value * 0.038, 26);
    return {
      opacity: interpolate(
        modeIndex.value,
        [1, 1.55, 2],
        [0, 0.85, 1],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateY: interpolate(
            modeIndex.value,
            [1, 2],
            [drift, 0],
            Extrapolation.CLAMP,
          ),
        },
        {
          scale: interpolate(
            modeIndex.value,
            [1, 2],
            [0.984, 1],
            Extrapolation.CLAMP,
          ),
        },
      ],
      zIndex: modeIndex.value >= 1.55 ? 2 : 0,
    };
  });

  const transitionVeilStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      modeIndex.value,
      [0, 0.42, 0.58, 1, 1.42, 1.58, 2],
      [0, 0.07, 0.07, 0, 0.07, 0.07, 0],
      Extrapolation.CLAMP,
    ),
  }));

  const clearFadeStyle = useAnimatedStyle(() => {
    const expandVal = fitsChromeExpandSv.value;
    const blendVal = tabBlend.value;
    const chromePop = chromeRevealSv.value;
    const baseOpacity = interpolate(
      blendVal,
      [0, 0.2],
      [1, 0],
      Extrapolation.CLAMP,
    );
    const expandOpacity = interpolate(
      expandVal,
      [0, 1],
      [1, 0],
      Extrapolation.CLAMP,
    );
    return {
      opacity: baseOpacity * expandOpacity * chromePop,
      transform: [
        {
          scale: interpolate(chromePop, [0, 1], [0.9, 1], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(
            chromePop,
            [0, 1],
            [8, 0],
            Extrapolation.CLAMP,
          ),
        },
      ],
      zIndex: expandVal > 0.05 || blendVal > 0.5 ? -1 : 32,
    };
  });

  const modePillFadeStyle = useAnimatedStyle(() => {
    const expandVal = fitsChromeExpandSv.value;
    return {
      opacity: interpolate(expandVal, [0, 1], [1, 0], Extrapolation.CLAMP),
    };
  });

  const chromeExpandFadeStyle = useAnimatedStyle(() => {
    const expandVal = fitsChromeExpandSv.value;
    return {
      opacity: interpolate(expandVal, [0, 1], [1, 0], Extrapolation.CLAMP),
      zIndex: expandVal > 0.05 ? -1 : 32,
      transform: [
        {
          translateY: interpolate(
            expandVal,
            [0, 1],
            [0, -10],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  });

  const [fits, setFits] = useState<SavedFit[]>([]);
  const fitsRef = useRef<SavedFit[]>([]);
  useEffect(() => {
    fitsRef.current = fits;
  }, [fits]);
  const [fitsTotalCount, setFitsTotalCount] = useState(0);
  const [fitsHasMore, setFitsHasMore] = useState(false);
  const [loadingMoreFits, setLoadingMoreFits] = useState(false);
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [recentUnsaved, setRecentUnsaved] = useState<UnsavedLookSnapshot[]>(
    [],
  );
  const [loadingFits, setLoadingFits] = useState(true);
  const fitsFetchGenRef = useRef(0);
  const prefetchingRemainingRef = useRef(false);
  const fitsHydratedRef = useRef(false);
  const libraryScrollYRef = useRef(0);
  const fetchFitsRef = useRef<
    (options?: { background?: boolean }) => Promise<SavedFit[] | undefined>
  >(async () => undefined);

  useEffect(() => {
    fitsHydratedRef.current = false;
    setFits([]);
    setFitsTotalCount(0);
    setFitsHasMore(false);
    setLoadingFits(!!user?.id);
  }, [user?.id]);

  const [closetItems, setClosetItems] = useState<ClosetItem[]>([]);
  const {
    wardrobes,
    membershipMaps: wardrobeMembershipMaps,
    activeWardrobeId,
    refreshWardrobes,
    selectActiveWardrobe,
  } = useWardrobeContext(user?.id);

  const [pagerFits, setPagerFits] = useState<SavedFit[]>([]);
  const [pagerInitialIndex, setPagerInitialIndex] = useState(0);
  const [pagerVisible, setPagerVisible] = useState(false);
  const [attachPickerFit, setAttachPickerFit] = useState<SavedFit | null>(null);
  const [attachPickerSelected, setAttachPickerSelected] = useState<Set<string>>(
    new Set(),
  );
  const pagerFitsRef = useRef(pagerFits);
  useEffect(() => {
    pagerFitsRef.current = pagerFits;
  }, [pagerFits]);
  const [stripDetailItem, setStripDetailItem] = useState<ClosetItem | null>(
    null,
  );
  const [pagerDetailItem, setPagerDetailItem] = useState<ClosetItem | null>(
    null,
  );
  const [inlineFitExtract, setInlineFitExtract] = useState<{
    fitId: string;
    imageUri: string;
    items: Record<string, unknown>[];
    scanning: boolean;
    saving: boolean;
    reviewOpen: boolean;
  } | null>(null);
  const inlineFitExtractRunRef = useRef(0);

  type LibraryPagerSnapshot = {
    fits: SavedFit[];
    activeFitId: string;
  };
  const libraryPagerSnapshotRef = useRef<LibraryPagerSnapshot | null>(null);
  const pendingLibraryReturnRef = useRef<LibraryPagerSnapshot | null>(null);

  const rememberLibraryPager = useCallback(
    (snapshot: LibraryPagerSnapshot) => {
      libraryPagerSnapshotRef.current = snapshot;
    },
    [],
  );

  const restoreLibraryPager = useCallback((snapshot: LibraryPagerSnapshot) => {
    const idx = snapshot.fits.findIndex((f) => f.id === snapshot.activeFitId);
    if (idx < 0) return;
    setFitsTopMode("library");
    setPagerFits(snapshot.fits);
    setPagerInitialIndex(idx);
    setPagerVisible(true);
  }, []);

  const barPadBottom = Math.max(insets.bottom, 10);
  const tabBarHeight = 52 + barPadBottom;
  const defaultTabBarStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 0,
      right: 0,
      bottom: 0,
      width: "100%" as const,
      height: tabBarHeight,
      paddingBottom: barPadBottom,
      paddingTop: 6,
      backgroundColor: "transparent",
      borderTopWidth: 0,
      elevation: 0,
      shadowColor: "transparent",
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0,
      shadowRadius: 0,
    }),
    [tabBarHeight, barPadBottom],
  );

  const hiddenTabBarStyle = useMemo(
    () => ({
      display: "none" as const,
    }),
    [],
  );
  const fitsTabBarStyle = DEBUG_HIDE_FITS_TAB_BAR
    ? hiddenTabBarStyle
    : defaultTabBarStyle;

  const handleActiveWardrobeChange = selectActiveWardrobe;

  useFocusEffect(
    useCallback(() => {
      builderRef.current?.collapseCloset();
      prefetchFitStudioBackground();
      void fetchFitsRef.current({ background: fitsHydratedRef.current });
      fetchGenerations();
      fetchCloset();
      void refreshWardrobes();
      navigation.setOptions({ tabBarStyle: fitsTabBarStyle });

      const pendingReturn = pendingLibraryReturnRef.current;
      if (pendingReturn) {
        pendingLibraryReturnRef.current = null;
        restoreLibraryPager(pendingReturn);
      }

      return () => {
        builderRef.current?.collapseCloset();
        navigation.setOptions({ tabBarStyle: defaultTabBarStyle });
      };
    }, [
      user?.id,
      navigation,
      defaultTabBarStyle,
      fitsTabBarStyle,
      refreshWardrobes,
      restoreLibraryPager,
    ]),
  );

  useEffect(() => {
    if (fitsTopMode !== "build") {
      builderRef.current?.collapseCloset();
    }
  }, [fitsTopMode]);

  useEffect(() => {
    const refresh = () => {
      void fetchFitsRef.current({ background: false });
    };
    const savedSub = DeviceEventEmitter.addListener(
      "loggedOutfitSaved",
      refresh,
    );
    const heroSub = DeviceEventEmitter.addListener(
      "loggedOutfitHeroReady",
      refresh,
    );
    return () => {
      savedSub.remove();
      heroSub.remove();
    };
  }, []);

  useEffect(() => {
    if (!user?.id) return;

    // Subscribe to real-time changes for clothing items to keep the closet strip synced
    const channel = supabase
      .channel("fits_closet_sync")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "clothing_items",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setClosetItems((prev) => [payload.new as ClosetItem, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            setClosetItems((prev) =>
              prev.map((it) =>
                it.id === payload.new.id
                  ? { ...it, ...(payload.new as ClosetItem) }
                  : it,
              ),
            );
          } else if (payload.eventType === "DELETE") {
            setClosetItems((prev) =>
              prev.filter((it) => it.id !== payload.old.id),
            );
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel("fits_library_sync")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "outfits",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          void fetchFits({ background: true });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id]);

  useLayoutEffect(() => {
    navigation.setOptions({ tabBarStyle: fitsTabBarStyle });
  }, [navigation, fitsTabBarStyle]);

  /** Reserve space below the floating Build · Library pill (fits tab overlay). */
  const FITS_FLOAT_CHROME_CLEARANCE = 16;

  const fitsCanvasInset = useMemo(() => {
    return {
      left: 0,
      top: FITS_FLOAT_CHROME_CLEARANCE,
    };
  }, []);

  const prefetchFitImageUrls = useCallback(
    (pageFits: SavedFit[]) => {
      if (!pageFits.length) return;
      const fitUrls = [
        ...new Set(
          pageFits
            .flatMap((f) => {
              const tryOn = f.try_on_image_url?.trim() || null;
              if (tryOn) {
                return isExplicitTryOnCutoutUri(tryOn) ? [tryOn] : [];
              }
              return [f.image_url];
            })
            .filter((u): u is string => typeof u === "string" && !!u),
        ),
      ].slice(0, 40);
      scheduleRemoteImagePrefetch(fitUrls);
      for (const fit of pageFits.slice(0, 8)) {
        const tryOn = fit.try_on_image_url?.trim();
        if (tryOn && !isExplicitTryOnCutoutUri(tryOn)) {
          void prepareTryOnImageUri(tryOn, fit.id);
        }
      }
    },
    [scheduleRemoteImagePrefetch],
  );

  const prefetchRemainingFits = useCallback(
    async (startPage: number, gen: number) => {
      if (!user?.id || prefetchingRemainingRef.current) return;
      prefetchingRemainingRef.current = true;
      let page = startPage;
      try {
        while (gen === fitsFetchGenRef.current) {
          const result = await fetchFitsLibraryPage(supabase, user.id, page);
          if (!result.fits.length || gen !== fitsFetchGenRef.current) break;
          setFits((prev) => mergeFitsById(prev, result.fits));
          setFitsTotalCount(result.totalCount);
          setFitsHasMore(result.hasMore);
          if (!result.hasMore) break;
          page += 1;
        }
      } catch (e) {
        console.warn("[prefetchFits]", e);
      } finally {
        prefetchingRemainingRef.current = false;
      }
    },
    [user?.id],
  );

  const fetchFits = useCallback(
    async (options?: { background?: boolean }) => {
      if (!user?.id) {
        setLoadingFits(false);
        return;
      }
      const background =
        options?.background === true ||
        (options?.background !== false && fitsHydratedRef.current);
      const gen = ++fitsFetchGenRef.current;
      if (!background) {
        prefetchingRemainingRef.current = false;
        setLoadingFits(true);
      }
      try {
        const result = await fetchFitsLibraryPage(supabase, user.id, 0);
        if (gen !== fitsFetchGenRef.current) return;
        if (background) {
          setFits((prev) => syncFitsFromPage(prev, result.fits));
        } else {
          setFits(result.fits);
        }
        setFitsTotalCount(result.totalCount);
        setFitsHasMore(result.hasMore);
        fitsHydratedRef.current = true;
        prefetchFitImageUrls(result.fits);
        if (result.hasMore && !background) {
          void prefetchRemainingFits(1, gen);
        }
        return result.fits;
      } catch (e) {
        console.warn("[fetchFits]", e);
      } finally {
        if (gen === fitsFetchGenRef.current && !background) {
          setLoadingFits(false);
        }
      }
    },
    [user?.id, prefetchFitImageUrls, prefetchRemainingFits],
  );

  useEffect(() => {
    fetchFitsRef.current = fetchFits;
  }, [fetchFits]);

  const loadMoreFits = useCallback(async () => {
    if (
      !user?.id ||
      loadingMoreFits ||
      loadingFits ||
      !fitsHasMore ||
      prefetchingRemainingRef.current
    ) {
      return;
    }
    const gen = fitsFetchGenRef.current;
    const nextPage = Math.floor(fits.length / FITS_LIBRARY_PAGE_SIZE);
    setLoadingMoreFits(true);
    try {
      const result = await fetchFitsLibraryPage(supabase, user.id, nextPage);
      if (gen !== fitsFetchGenRef.current) return;
      setFits((prev) => mergeFitsById(prev, result.fits));
      setFitsTotalCount(result.totalCount);
      setFitsHasMore(result.hasMore);
    } catch (e) {
      console.warn("[loadMoreFits]", e);
    } finally {
      setLoadingMoreFits(false);
    }
  }, [
    user?.id,
    fits.length,
    fitsHasMore,
    loadingMoreFits,
    loadingFits,
  ]);

  const fetchGenerations = async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from("generation_history")
        .select("id, item_ids, image_url, try_on_image_url, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) {
        console.warn("[fetchGenerations]", error.message);
        return;
      }
      setGenerations((data ?? []) as GenerationRecord[]);
    } catch (e) {
      console.warn("[fetchGenerations]", e);
    }
  };

  const fetchCloset = async () => {
    if (!user?.id) return;
    try {
      const { data, error } = await supabase
        .from("clothing_items")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (!error && data) {
        const rows = data as ClosetItem[];
        setClosetItems(rows);
        const urls = rows
          .map((it) => closetGridImageUri(it))
          .filter((u): u is string => !!u)
          .slice(0, 48);
        scheduleRemoteImagePrefetch(urls);
      }
    } catch {
      // non-critical
    }
  };

  const handleDeleteFit = useCallback(async (id: string) => {
    const removed = fits.find((f) => f.id === id);
    if (removed) {
      const snapshot = fitToUnsavedSnapshot(removed);
      setRecentUnsaved((prev) => [
        snapshot,
        ...prev.filter((s) => s.outfitId !== id),
      ]);
    }
    setFits((prev) => prev.filter((f) => f.id !== id));
    setFitsTotalCount((prev) => Math.max(0, prev - 1));
    setPagerFits((prev) => {
      const next = prev.filter((f) => f.id !== id);
      if (next.length === 0) setPagerVisible(false);
      return next;
    });
    try {
      let automationQuery = supabase
        .from("autogen_schedules")
        .select("id")
        .eq("last_generated_outfit_id", id)
        .limit(1);
      if (user?.id) {
        automationQuery = automationQuery.eq("user_id", user.id);
      }
      const { data: automationLink, error: automationLinkError } =
        await automationQuery.maybeSingle();
      if (automationLinkError) throw automationLinkError;

      if (automationLink) {
        // Auto OOTD owns this result. "Delete" in Library means removing its
        // Library membership only; deleting the outfit row would trigger the
        // FK's ON DELETE SET NULL and erase the result from the automation.
        let demoteQuery = supabase
          .from("outfits")
          .update({ saved_to_library: false })
          .eq("id", id);
        if (user?.id) demoteQuery = demoteQuery.eq("user_id", user.id);
        const { error } = await demoteQuery;
        if (error) throw error;
      } else {
        await supabase.from("outfit_items").delete().eq("outfit_id", id);
        let deleteQuery = supabase.from("outfits").delete().eq("id", id);
        if (user?.id) deleteQuery = deleteQuery.eq("user_id", user.id);
        const { error } = await deleteQuery;
        if (error) throw error;
        // Deleting the outfit cascades its wear_history rows — recount the
        // items that were in it so their wear stats reflect what's left.
        const itemIds = removed?.item_ids?.filter(Boolean) ?? [];
        if (itemIds.length > 0) {
          void supabase
            .rpc("recount_wear_stats", { p_item_ids: itemIds })
            .then(() => {});
        }
      }
    } catch {
      Alert.alert("Couldn't delete", "Try again in a moment.");
      await fetchFits();
    }
  }, [fits, user?.id]);

  const handleStripItemUpdate = (updated: ClosetItem) => {
    setClosetItems((prev) =>
      prev.map((it) => (it.id === updated.id ? { ...it, ...updated } : it)),
    );
    setStripDetailItem(updated);
  };

  const handleStripItemDelete = (id: string) => {
    setClosetItems((prev) => prev.filter((it) => it.id !== id));
    setStripDetailItem(null);
  };

  const openPieceFromPager = useCallback((piece: ClosetItem) => {
    setPagerDetailItem(piece);
  }, []);

  const handlePagerDetailGoToCloset = useCallback(() => {
    if (!pagerDetailItem) return;
    const piece = pagerDetailItem;
    if (libraryPagerSnapshotRef.current) {
      pendingLibraryReturnRef.current = libraryPagerSnapshotRef.current;
    }
    setPagerDetailItem(null);
    setPagerVisible(false);
    setFitsTopMode("library");
    queueOpenClosetItem(piece, { preferAllWardrobe: true });
    requestAnimationFrame(() => {
      router.push("/(tabs)/closet");
    });
  }, [pagerDetailItem, router]);

  const handlePagerItemUpdate = (updated: ClosetItem) => {
    setClosetItems((prev) =>
      prev.map((it) => (it.id === updated.id ? { ...it, ...updated } : it)),
    );
    setPagerDetailItem(updated);
  };

  const handlePagerItemDelete = (id: string) => {
    setClosetItems((prev) => prev.filter((it) => it.id !== id));
    setPagerDetailItem(null);
  };

  const openExtractForFit = useCallback(
    (fit: SavedFit) => {
      const imageUrl = fitPhotoForExtraction(fit);
      if (!imageUrl) {
        // Only outfits saved from an AI try-on render (no separate original
        // photo) genuinely have nothing scannable. A "manual" photo-upload
        // look with no image here means its hero upload hasn't finished (or
        // failed) — see attachHeroToOutfit in lib/saveOutfit.ts.
        Alert.alert(
          fit.source === "ai"
            ? "No photo to scan"
            : "Photo still uploading",
          fit.source === "ai"
            ? "This look was generated as a try-on render, which can't be scanned for pieces."
            : "This look's photo is still finishing upload. Wait a moment and try again.",
        );
        return;
      }
      const runId = ++inlineFitExtractRunRef.current;
      setInlineFitExtract({
        fitId: fit.id,
        imageUri: imageUrl,
        items: [],
        scanning: true,
        saving: false,
        reviewOpen: true,
      });

      void (async () => {
        try {
          const localUri = imageUrl.startsWith("http")
            ? await downloadImageToCache(imageUrl)
            : imageUrl;
          if (inlineFitExtractRunRef.current !== runId) return;
          setInlineFitExtract((current) =>
            current?.fitId === fit.id
              ? { ...current, imageUri: localUri }
              : current,
          );
          const base64 = await uriToBase64(localUri);
          const found = await runProgressiveImageExtract(
            base64,
            localUri,
            (updater) => {
              if (inlineFitExtractRunRef.current !== runId) return;
              setInlineFitExtract((current) =>
                current?.fitId === fit.id
                  ? { ...current, items: updater(current.items) }
                  : current,
              );
            },
          );
          if (inlineFitExtractRunRef.current !== runId) return;
          setInlineFitExtract((current) =>
            current?.fitId === fit.id
              ? { ...current, scanning: false }
              : current,
          );
          if (found === 0) {
            setInlineFitExtract(null);
            Alert.alert(
              "No items found",
              "We couldn't pull any clothing pieces out of this photo. Try a clearer, well-lit full-look photo.",
            );
          }
        } catch (error) {
          if (inlineFitExtractRunRef.current !== runId) return;
          setInlineFitExtract(null);
          Alert.alert(
            "Extraction failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    },
    [],
  );

  const updateInlineFitExtractItems = useCallback(
    (
      updater: (
        previous: Record<string, unknown>[],
      ) => Record<string, unknown>[],
    ) => {
      setInlineFitExtract((current) =>
        current ? { ...current, items: updater(current.items) } : current,
      );
    },
    [],
  );

  const saveInlineFitExtract = useCallback(async () => {
    if (!inlineFitExtract || !user?.id || inlineFitExtract.saving) return;
    const snapshot = inlineFitExtract;
    // Same low-confidence gate as the add-items save paths — inline extraction
    // must not silently save items the classifier itself wasn't sure about.
    if (!(await confirmLowConfidenceItems(snapshot.items))) return;
    setInlineFitExtract((current) =>
      current ? { ...current, saving: true } : current,
    );
    try {
      await saveFitExtractItems({
        userId: user.id,
        outfitId: snapshot.fitId,
        imageUri: snapshot.imageUri,
        items: snapshot.items,
        supabase,
      });
      setInlineFitExtract(null);
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      );
    } catch (error) {
      setInlineFitExtract((current) =>
        current ? { ...current, saving: false } : current,
      );
      Alert.alert(
        "Couldn't attach pieces",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [inlineFitExtract, user?.id]);

  const closeInlineFitExtractReview = useCallback(() => {
    if (!inlineFitExtract || inlineFitExtract.saving) return;
    const hasDraftPieces = inlineFitExtract.items.length > 0;
    if (!hasDraftPieces && !inlineFitExtract.scanning) {
      inlineFitExtractRunRef.current += 1;
      setInlineFitExtract(null);
      return;
    }
    Alert.alert(
      inlineFitExtract.scanning
        ? "Stop extracting pieces?"
        : "Discard extracted pieces?",
      "These pieces have not been saved. Discarding will not add them to your closet or attach them to this look.",
      [
        { text: "Keep reviewing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            inlineFitExtractRunRef.current += 1;
            setInlineFitExtract(null);
          },
        },
      ],
    );
  }, [inlineFitExtract]);

  const closeAttachPicker = useCallback(() => {
    setAttachPickerFit(null);
    setAttachPickerSelected(new Set());
  }, []);

  const openAttachFromCloset = useCallback((fit: SavedFit) => {
    setAttachPickerSelected(new Set());
    setAttachPickerFit(fit);
  }, []);

  const toggleAttachPickerItem = useCallback((id: string) => {
    setAttachPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const confirmAttachFromCloset = useCallback(async () => {
    const fit = attachPickerFit;
    if (!fit) {
      closeAttachPicker();
      return;
    }
    const existing = new Set(fit.item_ids ?? []);
    const toAttach = [...attachPickerSelected].filter((id) => !existing.has(id));
    if (toAttach.length === 0) {
      closeAttachPicker();
      return;
    }

    try {
      await attachClothingItemsToOutfit(supabase, fit.id, toAttach);
      DeviceEventEmitter.emit("outfitItemsExtracted", {
        outfitId: fit.id,
        itemIds: toAttach,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPagerFits((prev) =>
        prev.map((f) =>
          f.id === fit.id
            ? {
                ...f,
                item_ids: [...new Set([...(f.item_ids ?? []), ...toAttach])],
              }
            : f,
        ),
      );
      closeAttachPicker();
    } catch (e) {
      Alert.alert(
        "Attach failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [attachPickerFit, attachPickerSelected, closeAttachPicker]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener("closetItemsSaved", () => {
      void fetchCloset();
    });
    return () => sub.remove();
  }, [fetchCloset]);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      "outfitItemsExtracted",
      (payload: { outfitId?: string; itemIds?: string[] }) => {
        const outfitId = payload?.outfitId;
        const itemIds = payload?.itemIds ?? [];
        if (!outfitId) return;
        setFits((prev) =>
          prev.map((f) =>
            f.id === outfitId
              ? {
                  ...f,
                  item_ids: [
                    ...new Set([...(f.item_ids ?? []), ...itemIds]),
                  ],
                }
              : f,
          ),
        );
        setPagerFits((prev) =>
          prev.map((f) =>
            f.id === outfitId
              ? {
                  ...f,
                  item_ids: [
                    ...new Set([...(f.item_ids ?? []), ...itemIds]),
                  ],
                }
              : f,
          ),
        );
        void fetchCloset();
      },
    );
    return () => sub.remove();
  }, [fetchFits]);

  const handleMarkAsWorn = useCallback(
    async (fit: SavedFit) => {
      if (!user?.id) return;
      try {
        await markOutfitAsWorn(supabase, user.id, fit.id, fit.item_ids ?? []);
        const today = new Date().toISOString().split("T")[0]!;
        setFits((prev) =>
          prev.map((f) =>
            f.id === fit.id ? { ...f, worn_on: today, planned_date: null } : f,
          ),
        );
        setPagerFits((prev) =>
          prev.map((f) =>
            f.id === fit.id ? { ...f, worn_on: today, planned_date: null } : f,
          ),
        );
        await fetchFits();
      } catch {
        Alert.alert("Couldn’t update", "Try again in a moment.");
      }
    },
    [user?.id],
  );

  const handleRenameFit = useCallback(
    async (fit: SavedFit, name: string) => {
      if (!user?.id) return;
      try {
        await updateOutfitName(supabase, user.id, fit.id, name);
        const trimmed = name.trim() || null;
        setFits((prev) =>
          prev.map((f) => (f.id === fit.id ? { ...f, name: trimmed } : f)),
        );
        setPagerFits((prev) =>
          prev.map((f) => (f.id === fit.id ? { ...f, name: trimmed } : f)),
        );
      } catch {
        Alert.alert("Couldn't rename", "Try again in a moment.");
      }
    },
    [user?.id],
  );

  const handleLogWear = useCallback(
    async (fit: SavedFit, isoDate: string, planLabel?: string) => {
      if (!user?.id) return;
      try {
        await assignSavedFitToIsoDay(
          supabase,
          user.id,
          isoDate,
          {
            id: fit.id,
            name: fit.name,
            thumb: fit.try_on_image_url || fit.image_url || null,
            item_ids: fit.item_ids ?? [],
            worn_on: fit.worn_on,
            planned_date: fit.planned_date,
            planned_dates: fit.planned_dates,
          },
          planLabel !== undefined ? { planLabel } : undefined,
        );
        const plannedDates = mergePlannedDates(
          fit.planned_date,
          await fetchPlannedDatesForOutfit(supabase, user.id, fit.id),
        );
        const nextPlanned =
          plannedDates.find((d) => isoDayIsStrictlyFuture(d)) ?? null;
        const patch = isoDayIsStrictlyFuture(isoDate)
          ? {
              planned_date: nextPlanned,
              planned_dates: plannedDates,
            }
          : {
              worn_on: isoDate,
              planned_date: nextPlanned,
              planned_dates: plannedDates.filter((d) => d !== isoDate),
            };
        setFits((prev) =>
          prev.map((f) => (f.id === fit.id ? { ...f, ...patch } : f)),
        );
        setPagerFits((prev) =>
          prev.map((f) => (f.id === fit.id ? { ...f, ...patch } : f)),
        );
        await fetchFits();
      } catch {
        Alert.alert("Couldn't log wear", "Try again in a moment.");
      }
    },
    [user?.id],
  );

  const handleRemoveFromDay = useCallback(
    async (fit: SavedFit, isoDate: string) => {
      if (!user?.id) return;
      try {
        await removeFitFromIsoDay(supabase, user.id, fit.id, isoDate);
        const plannedDates = await fetchPlannedDatesForOutfit(
          supabase,
          user.id,
          fit.id,
        );
        const wornKey = fit.worn_on?.split("T")[0] ?? null;
        const nextPlanned =
          plannedDates.find((d) => isoDayIsStrictlyFuture(d)) ?? null;
        const patch = {
          worn_on: wornKey === isoDate ? null : fit.worn_on,
          planned_date: nextPlanned,
          planned_dates: plannedDates,
        };
        setFits((prev) =>
          prev.map((f) => (f.id === fit.id ? { ...f, ...patch } : f)),
        );
        setPagerFits((prev) =>
          prev.map((f) => (f.id === fit.id ? { ...f, ...patch } : f)),
        );
        await fetchFits();
      } catch {
        Alert.alert("Couldn't remove", "Try again in a moment.");
      }
    },
    [user?.id],
  );

  const handleContinueGeneration = useCallback((gen: GenerationRecord) => {
    Haptics.selectionAsync();
    setFitsTopMode("build");
    builderRef.current?.loadGeneratedLook(
      gen.item_ids ?? [],
      {
        tryOnSourceUri: gen.try_on_image_url,
        flatImageUri: gen.image_url,
        sourceId: `generation-${gen.id}`,
      },
    );
  }, []);

  const handleContinueUnsaved = useCallback((snapshot: UnsavedLookSnapshot) => {
    Haptics.selectionAsync();
    setFitsTopMode("build");
    builderRef.current?.loadGeneratedLook(
      snapshot.item_ids ?? [],
      {
        tryOnSourceUri: snapshot.try_on_image_url,
        flatImageUri: snapshot.image_url,
        sourceId: snapshot.outfitId,
      },
    );
  }, []);

  const editFitInBuilder = useCallback((fit: SavedFit) => {
    setFitsTopMode("build");
    const tryOnHero = fit.try_on_image_url?.trim();
    if (tryOnHero) {
      builderRef.current?.editSavedTryOn(
        fit.item_ids ?? [],
        tryOnHero,
        fit.name ?? undefined,
        fit.occasion ?? undefined,
        fit.id,
      );
      return;
    }
    builderRef.current?.remixFit(
      fit.item_ids ?? [],
      fit.name ?? undefined,
      fit.occasion ?? undefined,
      fit.id,
    );
  }, []);

  const handleViewInLibrary = useCallback(async (outfitId: string) => {
    void Haptics.selectionAsync();
    setFitsTopMode("library");

    // These refresh other Library sections (generations strip) and aren't
    // needed to open the tapped look — fire in the background instead of
    // blocking the pager on an extra network round-trip.
    void fetchGenerations();

    // Open instantly if this fit is already loaded (the common case — Plan
    // and Library share the same `fits` list). Only fall back to a full
    // refetch when the look genuinely isn't in memory yet.
    const latestFits = fitsRef.current;
    const cachedIdx = latestFits.findIndex((f) => f.id === outfitId);
    if (cachedIdx >= 0) {
      setPagerFits(latestFits);
      setPagerInitialIndex(cachedIdx);
      setPagerVisible(true);
      void fetchFits({ background: true });
      return;
    }

    const list = await fetchFits();
    const idx = (list ?? []).findIndex((f) => f.id === outfitId);
    if (idx >= 0) {
      setPagerFits(list!);
      setPagerInitialIndex(idx);
      setPagerVisible(true);
    }
  }, [user?.id]);

  const handleViewInPlan = useCallback((isoDay: string) => {
    void Haptics.selectionAsync();
    setFitsTopMode("plan");
    setPlanFocusDay(isoDay);
    setPlanFocusNonce((n) => n + 1);
  }, []);

  const handledOpenFitIntentRef = useRef<string | null>(null);
  useEffect(() => {
    const id =
      typeof openFitId === "string" && openFitId.trim().length > 0
        ? openFitId.trim()
        : "";
    if (!id) return;
    const intentKey = `${id}:${typeof fitsNavAt === "string" ? fitsNavAt : ""}`;
    if (handledOpenFitIntentRef.current === intentKey) return;
    handledOpenFitIntentRef.current = intentKey;
    void handleViewInLibrary(id);
  }, [openFitId, fitsNavAt, handleViewInLibrary]);

  useEffect(() => {
    if (recentUnsaved.length === 0 || fits.length === 0) return;
    const savedKeys = new Set(
      fits.map((f) => [...(f.item_ids ?? [])].sort().join("|")),
    );
    setRecentUnsaved((prev) =>
      prev.filter(
        (s) => !savedKeys.has([...(s.item_ids ?? [])].sort().join("|")),
      ),
    );
  }, [fits, recentUnsaved.length]);

  useEffect(() => {
    if (
      (fitsTopMode === "library" || fitsTopMode === "plan") &&
      user?.id
    ) {
      void fetchGenerations();
    }
  }, [fitsTopMode, user?.id]);

  return (
    <GestureHandlerRootView
      style={{
        flex: 1,
        backgroundColor:
          fitsTopMode === "plan" ? PLANNER_CANVAS_BG : Colors.homeHeroBackdrop,
      }}
    >
      <View style={[root.screen, fitsTopMode === "plan" && root.screenPlan]}>
        {/* studio-bg.png, identical on Build/Library/Plan — same photo, same
            treatment, no per-tab branching. */}
        <HomeHeroBackground
          source={STUDIO_BG_SOURCE}
          style={[
            root.pageBackdrop,
            {
              marginBottom: -insets.bottom,
              paddingBottom: insets.bottom,
            },
            fitsTopMode === "plan" && {
              top: -insets.top,
              bottom: -tabBarHeight,
            },
          ]}
        />
        <View
          style={[
            root.bodyStack,
            fitsTopMode === "plan" && root.bodyStackPlan,
          ]}
          onLayout={onBodyStackLayout}
        >
          <View style={[root.paneStack, { height: carouselH || undefined }]}>
            <Animated.View
              style={[root.pane, { height: carouselH }, buildPaneStyle]}
              pointerEvents={fitsTopMode === "build" ? "auto" : "none"}
            >
              <BuilderPanel
                ref={builderRef}
                closetItems={closetItems}
                wardrobes={wardrobes}
                activeWardrobeId={activeWardrobeId}
                onActiveWardrobeChange={handleActiveWardrobeChange}
                wardrobeMembershipMaps={wardrobeMembershipMaps}
                onManageWardrobes={() => router.push("/(tabs)/closet")}
                fitsCanvasInset={fitsCanvasInset}
                onSavedFit={async () => {
                  void Promise.all([
                    fetchFits({ background: true }),
                    fetchGenerations(),
                  ]);
                }}
                onFitUpdated={(fitId, patch) => {
                  const applyPatch = (rows: SavedFit[]) =>
                    rows.map((fit) =>
                      fit.id === fitId ? { ...fit, ...patch } : fit,
                    );
                  setFits((current) => {
                    const next = applyPatch(current);
                    fitsRef.current = next;
                    return next;
                  });
                  setPagerFits(applyPatch);
                  if (libraryPagerSnapshotRef.current) {
                    libraryPagerSnapshotRef.current = {
                      ...libraryPagerSnapshotRef.current,
                      fits: applyPatch(libraryPagerSnapshotRef.current.fits),
                    };
                  }
                  if (pendingLibraryReturnRef.current) {
                    pendingLibraryReturnRef.current = {
                      ...pendingLibraryReturnRef.current,
                      fits: applyPatch(pendingLibraryReturnRef.current.fits),
                    };
                  }
                }}
                onStyleMeLookChosen={() => {
                  void fetchGenerations();
                }}
                onViewInLibrary={handleViewInLibrary}
                onViewInPlan={handleViewInPlan}
                userId={user?.id}
                remixItemIds={remixItemIds}
                editOutfitId={editOutfitId}
                editTargetUnsaved={editTargetUnsaved === "1"}
                initialName={initialName}
                initialOccasion={initialOccasion}
                landingHeroTryOnUri={landingHeroTryOnUri}
                landingHeroChromaKeyHex={
                  typeof landingHeroChromaKeyHex === "string" &&
                  /^#?[0-9A-Fa-f]{6}$/.test(landingHeroChromaKeyHex.trim())
                    ? landingHeroChromaKeyHex.trim()
                    : undefined
                }
                plannedDateIso={plannedDateIso}
                wornOnIso={wornOnIso}
                onStripItemLongPress={setStripDetailItem}
                fitsChromeExpandSv={fitsChromeExpandSv}
                fitsTabBlendSv={tabBlend}
                fitsChromeRevealSv={chromeRevealSv}
                initialAnchorId={anchorId}
                initialAnchorNonce={fitsNavAt}
                onStyleMeModeChange={handleStyleMeModeChange}
                onTryOnModeChange={handleTryOnModeChange}
                onTryOnRenderingChange={handleTryOnRenderingChange}
                onCanvasHistoryChange={({ canUndo, canRedo }) => {
                  setCanvasCanUndo(canUndo);
                  setCanvasCanRedo(canRedo);
                }}
              />
            </Animated.View>
            <Animated.View
              style={[
                root.pane,
                root.libraryBodyBg,
                { height: carouselH },
                libraryPaneStyle,
              ]}
              pointerEvents={fitsTopMode === "library" ? "auto" : "none"}
            >
              {libraryPaneMounted ? (
                <FitLibrary
                  fits={fits}
                  fitsTotalCount={fitsTotalCount}
                  generations={generations}
                  closetItems={closetItems}
                  loading={loadingFits}
                  hasMoreFits={fitsHasMore}
                  loadingMoreFits={loadingMoreFits}
                  onLoadMoreFits={loadMoreFits}
                  scrollOffsetRef={libraryScrollYRef}
                  userId={user?.id}
                  onSwitchBuilder={() => {
                    Haptics.selectionAsync();
                    setFitsTopMode("build");
                  }}
                  onFitPress={(fit, index, filteredFits) => {
                    setPagerFits(filteredFits);
                    setPagerInitialIndex(index);
                    setPagerVisible(true);
                    rememberLibraryPager({
                      fits: filteredFits,
                      activeFitId: fit.id,
                    });
                  }}
                  onFitLongPress={(fit) => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setPagerFits([fit]);
                    setPagerInitialIndex(0);
                    setPagerVisible(true);
                    rememberLibraryPager({ fits: [fit], activeFitId: fit.id });
                  }}
                  onFitDelete={handleDeleteFit}
                  onFitEdit={(fit) => {
                    editFitInBuilder(fit);
                  }}
                  onLogWear={handleLogWear}
                  onRemoveFromDay={handleRemoveFromDay}
                  onDayChanged={() => {
                    void fetchFits();
                  }}
                  onContinueGeneration={handleContinueGeneration}
                  recentUnsaved={recentUnsaved}
                  onContinueUnsaved={handleContinueUnsaved}
                />
              ) : (
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFillObject,
                    root.libraryBodyBg,
                  ]}
                />
              )}
            </Animated.View>
            <Animated.View
              style={[
                root.pane,
                root.planPane,
                {
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: undefined,
                },
                planPaneStyle,
              ]}
              pointerEvents={fitsTopMode === "plan" ? "auto" : "none"}
            >
              {planPaneMounted ? (
                <FitPlanSuite
                  userId={user?.id}
                  closetItems={closetItems}
                  fits={fits}
                  initialFocusDay={planFocusDay}
                  focusDayNonce={planFocusNonce}
                  initialTripId={planTripId}
                  tripFocusNonce={planTripNonce}
                  onDayChanged={() => {
                    void fetchFits();
                  }}
                  onTripChanged={() => {
                    void refreshWardrobes();
                    void fetchFits();
                  }}
                  onOpenInLibrary={handleViewInLibrary}
                />
              ) : (
                <View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFillObject,
                    root.libraryBodyBg,
                  ]}
                />
              )}
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={[root.transitionVeil, transitionVeilStyle]}
            />
          </View>
        </View>

        <Animated.View
          style={[
            root.floatChromeBar,
            { top: insets.top + 8 },
            chromeExpandFadeStyle,
          ]}
          pointerEvents="box-none"
        >
          <Animated.View
            style={[root.floatChromeSide, clearFadeStyle]}
            pointerEvents={fitsTopMode === "build" ? "box-none" : "none"}
            accessibilityElementsHidden={fitsTopMode !== "build"}
            importantForAccessibility={
              fitsTopMode === "build" ? "auto" : "no-hide-descendants"
            }
          >
            <View style={root.canvasToolsAnchor}>
              <TouchableOpacity
                onPress={() => {
                  Haptics.selectionAsync();
                  setCanvasToolsExpanded((prev) => !prev);
                }}
                activeOpacity={0.75}
                style={root.canvasToolsCaretBtn}
                accessibilityRole="button"
                accessibilityState={{ expanded: canvasToolsExpanded }}
                accessibilityLabel={
                  canvasToolsExpanded
                    ? "Collapse canvas tools"
                    : "Expand canvas tools"
                }
              >
                <Ionicons
                  name={canvasToolsExpanded ? "chevron-up" : "chevron-down"}
                  size={17}
                  color={Colors.textMuted}
                />
              </TouchableOpacity>

              <Animated.View
                style={[root.canvasToolsActions, canvasToolsActionsStyle]}
                pointerEvents={canvasToolsExpanded ? "auto" : "none"}
              >
                <TouchableOpacity
                  onPress={() => {
                    Haptics.selectionAsync();
                    builderRef.current?.undoOutfit();
                  }}
                  activeOpacity={0.75}
                  disabled={!canvasCanUndo}
                  style={[
                    root.canvasControlBtn,
                    !canvasCanUndo && root.canvasControlBtnDisabled,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canvasCanUndo }}
                  accessibilityLabel="Undo last change"
                >
                  <Ionicons
                    name="arrow-undo-outline"
                    size={18}
                    color={canvasCanUndo ? Colors.text : Colors.textMuted}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => {
                    Haptics.selectionAsync();
                    builderRef.current?.redoOutfit();
                  }}
                  activeOpacity={0.75}
                  disabled={!canvasCanRedo}
                  style={[
                    root.canvasControlBtn,
                    !canvasCanRedo && root.canvasControlBtnDisabled,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canvasCanRedo }}
                  accessibilityLabel="Redo last undone change"
                >
                  <Ionicons
                    name="arrow-redo-outline"
                    size={18}
                    color={canvasCanRedo ? Colors.text : Colors.textMuted}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => {
                    Haptics.selectionAsync();
                    builderRef.current?.clearOutfit();
                  }}
                  activeOpacity={0.75}
                  style={root.canvasControlBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Clear outfit canvas"
                >
                  <Ionicons
                    name="trash-outline"
                    size={18}
                    color={Colors.text}
                  />
                </TouchableOpacity>
              </Animated.View>
            </View>
          </Animated.View>

          <Animated.View
            style={[root.floatChromeCenter, modePillFadeStyle]}
            pointerEvents="auto"
          >
            <View
              style={[
                root.pillPlate,
                fitsTopMode === "plan" && root.pillPlatePlan,
              ]}
            >
              {fitsTopMode === "plan" ? (
                <View style={root.pillFrost} pointerEvents="none">
                  <BlurView
                    intensity={90}
                    tint="systemUltraThinMaterialLight"
                    style={StyleSheet.absoluteFill}
                  />
                  <View style={root.pillGlassSheen} />
                </View>
              ) : null}
              {tryOnModeActive && fitsTopMode === "build" ? (
                <TouchableOpacity
                  style={root.styleMeBackRow}
                  onPress={() => {
                    Haptics.selectionAsync();
                    builderRef.current?.exitTryOnSession();
                  }}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Done with try-on"
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                >
                  <Ionicons
                    name="chevron-back"
                    size={15}
                    color={Colors.text}
                    style={root.styleMeBackIcon}
                  />
                  <Text style={[root.pillLabel, root.styleMeBackText]}>
                    Done
                  </Text>
                </TouchableOpacity>
              ) : styleMeModeActive ? (
                <TouchableOpacity
                  style={root.styleMeBackRow}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setFitsTopMode("build");
                    builderRef.current?.exitStyleMeToManualBuild();
                  }}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Back to build"
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                >
                  <Ionicons
                    name="chevron-back"
                    size={15}
                    color={Colors.text}
                    style={root.styleMeBackIcon}
                  />
                  <Text style={[root.pillLabel, root.styleMeBackText]}>
                    Back
                  </Text>
                </TouchableOpacity>
              ) : (
                <View style={root.pillCluster}>
                  <TouchableOpacity
                    onPress={() => {
                      Haptics.selectionAsync();
                      setFitsTopMode("build");
                    }}
                    activeOpacity={0.85}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: fitsTopMode === "build" }}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                  >
                    <Text
                      style={[
                        root.pillLabel,
                        fitsTopMode === "build" && root.pillLabelActive,
                      ]}
                    >
                      Build
                    </Text>
                  </TouchableOpacity>
                  <Text style={root.pillDotSep}>·</Text>
                  <TouchableOpacity
                    style={root.pillLibWrap}
                    onPress={() => {
                      if (blockNavigationForActiveTryOn()) return;
                      Haptics.selectionAsync();
                      setFitsTopMode("library");
                    }}
                    activeOpacity={0.85}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: fitsTopMode === "library" }}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                  >
                    <Text
                      style={[
                        root.pillLabel,
                        fitsTopMode === "library" && root.pillLabelActive,
                      ]}
                    >
                      Library
                    </Text>
                  </TouchableOpacity>
                  <Text style={root.pillDotSep}>·</Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (blockNavigationForActiveTryOn()) return;
                      Haptics.selectionAsync();
                      setFitsTopMode("plan");
                    }}
                    activeOpacity={0.85}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: fitsTopMode === "plan" }}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                  >
                    <Text
                      style={[
                        root.pillLabel,
                        fitsTopMode === "plan" && root.pillLabelActive,
                      ]}
                    >
                      Plan
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </Animated.View>

          <View style={root.floatChromeSide} pointerEvents="none" />
        </Animated.View>

        <FitDetailPager
          visible={pagerVisible}
          fits={pagerFits}
          initialIndex={pagerInitialIndex}
          closetItems={closetItems}
          onClose={() => {
            if (inlineFitExtract) {
              closeInlineFitExtractReview();
              return;
            }
            inlineFitExtractRunRef.current += 1;
            setInlineFitExtract(null);
            setPagerDetailItem(null);
            setPagerVisible(false);
            pendingLibraryReturnRef.current = null;
            closeAttachPicker();
          }}
          onDelete={handleDeleteFit}
          onMarkAsWorn={handleMarkAsWorn}
          onLogWear={handleLogWear}
          onRemoveFromDay={handleRemoveFromDay}
          onRenameFit={handleRenameFit}
          onOpenInCloset={openPieceFromPager}
          onExtractItems={openExtractForFit}
          inlineExtract={
            inlineFitExtract
              ? {
                  fitId: inlineFitExtract.fitId,
                  items: inlineFitExtract.items,
                  scanning: inlineFitExtract.scanning,
                  reviewOpen: inlineFitExtract.reviewOpen,
                  imageUri: inlineFitExtract.imageUri,
                  onItemPress: () =>
                    setInlineFitExtract((current) =>
                      current ? { ...current, reviewOpen: true } : current,
                    ),
                  onScanAgain: () => {
                    const fit = pagerFitsRef.current.find(
                      (candidate) => candidate.id === inlineFitExtract.fitId,
                    );
                    if (fit) openExtractForFit(fit);
                  },
                }
              : null
          }
          extractReviewOverlay={
            inlineFitExtract?.reviewOpen ? (
              <SavedFitExtractReview
                visible
                imageUri={inlineFitExtract.imageUri}
                items={inlineFitExtract.items}
                scanning={inlineFitExtract.scanning}
                saving={inlineFitExtract.saving}
                onItemsChange={updateInlineFitExtractItems}
                onClose={closeInlineFitExtractReview}
                onSave={saveInlineFitExtract}
              />
            ) : null
          }
          onAttachFromCloset={openAttachFromCloset}
          onActiveFitChange={(fit) => {
            rememberLibraryPager({
              fits: pagerFitsRef.current,
              activeFitId: fit.id,
            });
          }}
          userId={user?.id}
          activeWardrobeId={activeWardrobeId}
          wardrobeMembershipMaps={wardrobeMembershipMaps}
          itemDetailOverlay={
            pagerDetailItem ? (
              <GestureHandlerRootView style={root.itemDetailModalRoot}>
                <ClosetItemDetail
                  item={pagerDetailItem}
                  occasions={OCCASIONS_FLAT}
                  closetItems={closetItems}
                  primaryAction="closet"
                  onOpenInClosetTab={handlePagerDetailGoToCloset}
                  onClose={() => setPagerDetailItem(null)}
                  onUpdateItem={handlePagerItemUpdate}
                  onDeleteItem={handlePagerItemDelete}
                  onSelectClosetItem={setPagerDetailItem}
                />
              </GestureHandlerRootView>
            ) : null
          }
          attachClosetOverlay={
            attachPickerFit ? (
              <ClosetPicker
                embedded
                items={closetItems}
                selected={attachPickerSelected}
                onToggle={toggleAttachPickerItem}
                onClose={closeAttachPicker}
                onDone={() => void confirmAttachFromCloset()}
                wardrobes={wardrobes}
                wardrobeMembershipMaps={wardrobeMembershipMaps}
                onManageWardrobes={() => router.push("/(tabs)/closet")}
              />
            ) : null
          }
          onRemix={(fit) => {
            setPagerVisible(false);
            editFitInBuilder(fit);
          }}
        />

        <Modal
          visible={!!stripDetailItem}
          transparent
          animationType="none"
          presentationStyle="overFullScreen"
          statusBarTranslucent
          onRequestClose={() => setStripDetailItem(null)}
        >
          {stripDetailItem ? (
            <GestureHandlerRootView style={root.itemDetailModalRoot}>
              <ClosetItemDetail
                item={stripDetailItem}
                occasions={OCCASIONS_FLAT}
                closetItems={closetItems}
                onClose={() => setStripDetailItem(null)}
                onUpdateItem={handleStripItemUpdate}
                onDeleteItem={handleStripItemDelete}
                onSelectClosetItem={setStripDetailItem}
              />
            </GestureHandlerRootView>
          ) : null}
        </Modal>
      </View>
    </GestureHandlerRootView>
  );
}

const root = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.homeHeroBackdrop,
  },
  screenPlan: {
    position: "relative",
    backgroundColor: PLANNER_CANVAS_BG,
  },
  /** Warm page fill — anchored to physical bottom incl. home-indicator safe area */
  pageBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.homeHeroBackdrop,
    zIndex: 0,
  },
  floatChromeBar: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 32,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  /** Matches Clear column footprint so pills stay centered in the remaining width */
  floatChromeSide: {
    width: 64,
    flexShrink: 0,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  floatChromeCenter: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  pillPlate: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: Colors.navBarFillOnWarm,
    overflow: "hidden",
    borderWidth: 0,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
    ...(Platform.OS === "ios" ? { borderCurve: "continuous" as const } : {}),
  },
  pillPlatePlan: {
    backgroundColor: "transparent",
  },
  pillFrost: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
    overflow: "hidden",
    ...(Platform.OS === "ios" ? { borderCurve: "continuous" as const } : {}),
  },
  pillGlassSheen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.glassTabSheen,
  },
  pillCluster: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  styleMeBackRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  /** Reserves pill width while Get Styled loads — no label until looks arrive. */
  styleMePillPlaceholder: {
    minWidth: 80,
    minHeight: 28,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  styleMeBackIcon: {
    marginLeft: 4,
    marginRight: -4,
  },
  sideLabel: {
    fontFamily: Fonts.semibold,
    fontSize: 15,
    color: Colors.textMuted,
    letterSpacing: -0.2,
  },
  pillLabel: {
    ...EditorialStyles.floatPillLabel,
    fontSize: 15,
    lineHeight: 20,
    paddingHorizontal: 6,
    paddingVertical: 4,
    ...(Platform.OS === "android" ? { includeFontPadding: false } : {}),
  },
  pillLabelActive: {
    ...EditorialStyles.floatPillLabelActive,
  },
  /** Same size/weight as Build · Library labels — semibold 16, not extrabold. */
  styleMeBackText: {
    color: Colors.text,
    fontFamily: Fonts.semibold,
  },
  pillDotSep: {
    fontFamily: Fonts.medium,
    fontSize: 15,
    lineHeight: 20,
    color: Colors.textMuted,
    paddingHorizontal: 2,
    textAlign: "center",
    ...(Platform.OS === "android" ? { includeFontPadding: false } : {}),
  },
  pillLibWrap: {
    position: "relative",
  },
  transitionVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.homeHeroBackdrop,
    zIndex: 3,
  },
  bodyStack: {
    flex: 1,
    position: "relative",
    overflow: "visible",
    zIndex: 2,
    backgroundColor: Colors.homeHeroBackdrop,
  },
  bodyStackPlan: {
    backgroundColor: "transparent",
  },
  paneStack: {
    flex: 1,
    width: "100%",
    position: "relative",
    overflow: "visible",
  },
  pane: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    overflow: "hidden",
  },
  planPane: {
    overflow: "visible",
    backgroundColor: "transparent",
  },
  /** Opaque fill so Build canvas never bleeds through Library during transition. */
  libraryBodyBg: {
    backgroundColor: Colors.homeHeroBackdrop,
  },
  itemDetailModalRoot: {
    flex: 1,
    backgroundColor: "transparent",
  },
  canvasToolsActions: {
    position: "absolute",
    top: "100%",
    left: 0,
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
  },
  canvasToolsAnchor: {
    position: "relative",
    width: 40,
  },
  canvasToolsCaretBtn: {
    ...EditorialStyles.floatPillPlate,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  canvasControlBtn: {
    ...EditorialStyles.floatPillPlate,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  canvasControlBtnDisabled: {
    opacity: 0.45,
  },
});
