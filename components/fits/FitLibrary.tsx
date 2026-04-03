import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
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
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Download,
  Search,
  Share2,
  Shirt,
  ShoppingBag,
} from "lucide-react-native";
import { Colors, Radii, Styles, Typography } from "../../constants/AppTheme";
import { downloadOrShareFitImage, shareFitImage } from "../../lib/fitShareDownload";
import FitCard, { GRID_GAP, GRID_PAD } from "./FitCard";
import FitMonthCalendar from "./FitMonthCalendar";
import type { ClosetItem, SavedFit } from "./types";

const { width: SW, height: SH } = Dimensions.get("window");

const FILTERS = ["All", "Planned", "Casual", "Work", "Social", "Active"] as const;

const CAROUSEL_H = Math.min(SH * 0.38, 312);
const TOGGLE_ROW = 56;
const MIN_SHEET = 128;
const CARD_W_PEEK = SW * 0.72;

function wearDateKey(fit: SavedFit): string | null {
  const d = fit.worn_on || fit.planned_date;
  return d ? d.split("T")[0]! : null;
}

function sortKeyForRecents(f: SavedFit): string {
  const w = f.worn_on || f.planned_date;
  if (w) return w;
  return f.created_at.split("T")[0] ?? f.created_at;
}

function resolvePieces(fit: SavedFit, closet: ClosetItem[]): ClosetItem[] {
  const ids = fit.item_ids ?? [];
  if (!ids.length) return [];
  const map = Object.fromEntries(closet.map((c) => [c.id, c]));
  return ids.map((id) => map[id]).filter(Boolean) as ClosetItem[];
}

interface Props {
  fits: SavedFit[];
  closetItems: ClosetItem[];
  loading: boolean;
  onSwitchBuilder: () => void;
  onFitPress: (fit: SavedFit) => void;
  onFitLongPress: (fit: SavedFit) => void;
}

export default function FitLibrary({
  fits,
  closetItems,
  loading,
  onSwitchBuilder,
  onFitPress,
  onFitLongPress,
}: Props) {
  const insets = useSafeAreaInsets();
  const tabBarH = useBottomTabBarHeight();
  const bottomPad = Math.max(tabBarH, insets.bottom) + 8;

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("All");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [piecesFit, setPiecesFit] = useState<SavedFit | null>(null);

  const listRef = useRef<FlatList<SavedFit>>(null);

  /** Sheet can grow over the calendar; leave a sliver of the header visible. */
  const maxSheet = Math.max(
    MIN_SHEET + 100,
    SH - insets.top - TOGGLE_ROW - 28 - bottomPad,
  );

  const sheetH = useSharedValue(MIN_SHEET);
  const startH = useSharedValue(MIN_SHEET);

  const sheetStyle = useAnimatedStyle(() => ({
    height: sheetH.value,
  }));

  const expandSheet = useCallback(() => {
    sheetH.value = withTiming(maxSheet, { duration: 220 });
  }, [maxSheet, sheetH]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-10, 10])
        .onBegin(() => {
          startH.value = sheetH.value;
        })
        .onUpdate((e) => {
          const next = startH.value - e.translationY;
          sheetH.value = Math.min(maxSheet, Math.max(MIN_SHEET, next));
        })
        .onEnd((e) => {
          const mid = (MIN_SHEET + maxSheet) / 2;
          if (e.velocityY < -420) {
            sheetH.value = withTiming(maxSheet, { duration: 200 });
          } else if (e.velocityY > 420) {
            sheetH.value = withTiming(MIN_SHEET, { duration: 200 });
          } else {
            const open = sheetH.value >= mid;
            sheetH.value = withTiming(open ? maxSheet : MIN_SHEET, {
              duration: 200,
            });
          }
        }),
    [maxSheet, sheetH, startH],
  );

  const recentCarouselFits = useMemo(() => {
    return [...fits]
      .sort((a, b) => sortKeyForRecents(b).localeCompare(sortKeyForRecents(a)))
      .slice(0, 24);
  }, [fits]);

  const filtered = useMemo(() => {
    let result = fits;

    if (selectedDay) {
      result = result.filter((f) => wearDateKey(f) === selectedDay);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (f) =>
          (f.name ?? "").toLowerCase().includes(q) ||
          (f.occasion ?? "").toLowerCase().includes(q),
      );
    }

    if (filter === "Planned") {
      result = result.filter((f) => f.planned_date);
    } else if (filter !== "All") {
      const q = filter.toLowerCase();
      result = result.filter((f) =>
        (f.occasion ?? "").toLowerCase().includes(q),
      );
    }

    return result;
  }, [fits, search, filter, selectedDay]);

  useEffect(() => {
    if (selectedDay && recentCarouselFits.length) {
      const idx = recentCarouselFits.findIndex(
        (f) => wearDateKey(f) === selectedDay,
      );
      if (idx >= 0) {
        setCarouselIndex(idx);
        const step = CARD_W_PEEK + 14;
        listRef.current?.scrollToOffset({
          offset: Math.max(0, idx * step),
          animated: true,
        });
      }
    }
  }, [selectedDay, recentCarouselFits]);

  const onCarouselScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const i = Math.round(x / (CARD_W_PEEK + 14));
      setCarouselIndex(Math.max(0, Math.min(i, recentCarouselFits.length - 1)));
    },
    [recentCarouselFits.length],
  );

  const heroFit = recentCarouselFits[carouselIndex] ?? recentCarouselFits[0];

  const col0 = filtered.filter((_, i) => i % 2 === 0);
  const col1 = filtered.filter((_, i) => i % 2 === 1);

  const pieceList = piecesFit ? resolvePieces(piecesFit, closetItems) : [];

  if (loading) {
    return (
      <View style={s.loadingWrap}>
        <ActivityIndicator size="large" color={Colors.textMuted} />
      </View>
    );
  }

  if (!fits.length) {
    return (
      <View style={s.emptyWrap}>
        <View style={s.emptyIconRing}>
          <Shirt size={36} color={Colors.textMuted} strokeWidth={1.5} />
        </View>
        <Text style={s.emptyTitle}>Your saved looks will appear here</Text>
        <Text style={s.emptySub}>
          When you save a fit from Create, it shows up on your carousel and in
          this lookbook — ready whenever you are.
        </Text>
        <TouchableOpacity
          style={[Styles.btnPrimary, s.emptyBtn]}
          onPress={onSwitchBuilder}
          activeOpacity={0.85}
        >
          <Text style={Styles.btnPrimaryText}>Open Create</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={s.root}>
      <ScrollView
        style={s.topScroll}
        contentContainerStyle={[s.topScrollContent, { paddingBottom: MIN_SHEET + bottomPad }]}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        bounces
      >
        <View style={s.carouselBlock}>
          <FlatList
            ref={listRef}
            data={recentCarouselFits}
            keyExtractor={(item) => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={CARD_W_PEEK + 14}
            decelerationRate="fast"
            contentContainerStyle={s.carouselContent}
            onMomentumScrollEnd={onCarouselScroll}
            onScrollEndDrag={onCarouselScroll}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[s.carouselCard, { width: CARD_W_PEEK }]}
                activeOpacity={0.92}
                onPress={() => onFitPress(item)}
              >
                {item.image_url ? (
                  <Image
                    source={{ uri: item.image_url }}
                    style={s.carouselImg}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={s.carouselImgEmpty}>
                    <Shirt size={40} color="rgba(0,0,0,0.1)" strokeWidth={1.5} />
                  </View>
                )}
              </TouchableOpacity>
            )}
          />

          {heroFit ? (
            <View style={s.fabColLeft} pointerEvents="box-none">
              <TouchableOpacity
                style={s.fab}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setPiecesFit(heroFit);
                }}
              >
                <ShoppingBag size={18} color={Colors.text} strokeWidth={2.2} />
              </TouchableOpacity>
            </View>
          ) : null}
          {heroFit ? (
            <View style={s.fabColRight} pointerEvents="box-none">
              <TouchableOpacity
                style={s.fab}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  shareFitImage(heroFit.image_url, heroFit.name);
                }}
              >
                <Share2 size={18} color={Colors.text} strokeWidth={2.2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={s.fab}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  downloadOrShareFitImage(heroFit.image_url, heroFit.name);
                }}
              >
                <Download size={18} color={Colors.text} strokeWidth={2.2} />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        <Text style={s.carouselCaption} numberOfLines={1}>
          Recently worn
        </Text>

        <FitMonthCalendar
          fits={fits}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
        />
      </ScrollView>

      <Animated.View style={[s.sheet, sheetStyle]}>
        <GestureDetector gesture={panGesture}>
          <View style={s.sheetHandleArea}>
            <View style={s.handle} />
            <Text style={s.sheetHint}>Drag to expand your library</Text>
          </View>
        </GestureDetector>

        <View style={s.sheetHead}>
          <View>
            <Text style={s.sheetTitle}>Your library</Text>
            <Text style={s.sheetSub}>
              {selectedDay
                ? `Showing looks for ${selectedDay}`
                : `${fits.length} saved look${fits.length === 1 ? "" : "s"}`}
            </Text>
          </View>
          <TouchableOpacity onPress={expandSheet} hitSlop={12}>
            <Text style={s.expandLink}>Expand</Text>
          </TouchableOpacity>
        </View>

        <View style={s.searchBar}>
          <Search size={16} color={Colors.textMuted} strokeWidth={2} />
          <TextInput
            style={s.searchInput}
            placeholder="Search fits..."
            placeholderTextColor="rgba(0,0,0,0.25)"
            value={search}
            onChangeText={setSearch}
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.filterRow}
          style={{ flexGrow: 0 }}
          bounces={false}
        >
          {FILTERS.map((f) => (
            <TouchableOpacity
              key={f}
              style={[s.filterChip, filter === f && s.filterChipActive]}
              onPress={() => setFilter(f)}
              activeOpacity={0.7}
            >
              <Text style={[s.filterText, filter === f && s.filterTextActive]}>
                {f}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <ScrollView
          style={s.gridScroll}
          contentContainerStyle={{ paddingBottom: bottomPad + 8 }}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          {filtered.length > 0 ? (
            <View style={s.grid}>
              <View style={s.col}>
                {col0.map((fit, i) => (
                  <FitCard
                    key={fit.id}
                    fit={fit}
                    index={i * 2}
                    onPress={() => onFitPress(fit)}
                    onLongPress={() => onFitLongPress(fit)}
                  />
                ))}
              </View>
              <View style={s.col}>
                {col1.map((fit, i) => (
                  <FitCard
                    key={fit.id}
                    fit={fit}
                    index={i * 2 + 1}
                    onPress={() => onFitPress(fit)}
                    onLongPress={() => onFitLongPress(fit)}
                  />
                ))}
              </View>
            </View>
          ) : (
            <View style={s.noResults}>
              <Text style={s.noResultsText}>
                No looks match {selectedDay ? "that day" : "those filters"}.
              </Text>
              {selectedDay ? (
                <TouchableOpacity onPress={() => setSelectedDay(null)}>
                  <Text style={s.clearLink}>Clear day</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
        </ScrollView>
      </Animated.View>

      <Modal
        visible={!!piecesFit}
        transparent
        animationType="fade"
        onRequestClose={() => setPiecesFit(null)}
      >
        <View style={s.modalRoot}>
          <Pressable style={s.modalBackdrop} onPress={() => setPiecesFit(null)}>
            <BlurView intensity={22} tint="light" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, s.modalDim]} />
          </Pressable>
          <View style={s.modalCenter} pointerEvents="box-none">
            <View style={s.piecesSheet}>
            <Text style={s.piecesTitle}>Closet pieces in this fit</Text>
            {pieceList.length === 0 ? (
              <Text style={s.piecesEmpty}>
                No linked closet items (older saves may not include piece IDs).
              </Text>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.piecesRow}
              >
                {pieceList.map((it) => (
                  <View key={it.id} style={s.pieceCell}>
                    {it.image_url ? (
                      <Image
                        source={{ uri: it.image_url }}
                        style={s.pieceImg}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={s.pieceImgEmpty}>
                        <Shirt size={22} color={Colors.textMuted} strokeWidth={1.5} />
                      </View>
                    )}
                    <Text style={s.pieceName} numberOfLines={2}>
                      {it.name ?? it.category ?? "Item"}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity
              style={s.piecesClose}
              onPress={() => setPiecesFit(null)}
            >
              <Text style={s.piecesCloseText}>Close</Text>
            </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </GestureHandlerRootView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  topScroll: { flex: 1 },
  topScrollContent: { flexGrow: 1 },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
  },
  carouselBlock: {
    height: CAROUSEL_H,
    marginTop: 4,
    position: "relative",
  },
  carouselContent: {
    paddingHorizontal: (SW - CARD_W_PEEK) / 2,
    gap: 0,
  },
  carouselCard: {
    height: CAROUSEL_H - 8,
    marginHorizontal: 7,
    borderRadius: Radii.xl,
    overflow: "hidden",
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  carouselImg: { width: "100%", height: "100%" },
  carouselImgEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  fabColLeft: {
    position: "absolute",
    left: (SW - CARD_W_PEEK) / 2 + 14,
    bottom: 18,
  },
  fabColRight: {
    position: "absolute",
    right: (SW - CARD_W_PEEK) / 2 + 14,
    bottom: 18,
    gap: 10,
    alignItems: "flex-end",
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.88)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  carouselCaption: {
    marginTop: 6,
    marginBottom: 2,
    paddingHorizontal: 20,
    fontSize: 13,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    letterSpacing: -0.2,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 10,
    zIndex: 4,
  },
  sheetHandleArea: {
    paddingTop: 8,
    paddingBottom: 4,
    alignItems: "center",
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  sheetHint: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: Typography.weights.extrabold,
    color: Colors.text,
    letterSpacing: -0.5,
  },
  sheetSub: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
  },
  expandLink: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
    textDecorationLine: "underline",
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text },
  filterRow: {
    paddingHorizontal: 16,
    gap: 8,
    paddingBottom: 10,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  filterChipActive: { backgroundColor: Colors.black, borderColor: Colors.black },
  filterText: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  filterTextActive: { color: "#fff" },
  gridScroll: { flex: 1 },
  grid: {
    flexDirection: "row",
    paddingHorizontal: GRID_PAD,
    gap: GRID_GAP,
    paddingTop: 4,
  },
  col: { flex: 1, gap: GRID_GAP },
  noResults: { paddingTop: 28, alignItems: "center", gap: 8 },
  noResultsText: { fontSize: 14, color: Colors.textMuted },
  clearLink: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
    textDecorationLine: "underline",
  },
  emptyWrap: {
    alignItems: "center",
    paddingTop: 64,
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyIconRing: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: Typography.weights.extrabold,
    color: Colors.text,
    letterSpacing: -0.5,
    textAlign: "center",
  },
  emptySub: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 21,
  },
  emptyBtn: { marginTop: 8, paddingHorizontal: 36, width: 220 },
  modalRoot: { flex: 1 },
  modalBackdrop: { ...StyleSheet.absoluteFillObject },
  modalCenter: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    paddingTop: SH * 0.04,
  },
  modalDim: { backgroundColor: "rgba(0,0,0,0.2)" },
  piecesSheet: {
    marginHorizontal: 16,
    backgroundColor: Colors.surface,
    borderRadius: Radii.xl,
    padding: 18,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  piecesTitle: {
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    marginBottom: 12,
  },
  piecesEmpty: { fontSize: 14, color: Colors.textMuted, lineHeight: 20 },
  piecesRow: { gap: 12, paddingVertical: 4 },
  pieceCell: { width: 88 },
  pieceImg: {
    width: 88,
    height: 88,
    borderRadius: Radii.md,
    backgroundColor: Colors.surfaceAlt,
  },
  pieceImgEmpty: {
    width: 88,
    height: 88,
    borderRadius: Radii.md,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  pieceName: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  piecesClose: {
    marginTop: 16,
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: Radii.full,
    backgroundColor: Colors.black,
  },
  piecesCloseText: {
    color: "#fff",
    fontWeight: Typography.weights.semibold,
    fontSize: 15,
  },
});
