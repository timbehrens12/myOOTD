import { useFocusEffect } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Dimensions,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StatusBar,
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
    FadeIn,
    FadeInDown,
    FadeInUp,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import ColorPickerTriggerIcon from "../../components/color-picker/ColorPickerTriggerIcon";
import IosStyleColorPickerModal from "../../components/color-picker/IosStyleColorPickerModal";
import { Colors, Radii, Styles } from "../../constants/AppTheme";
import { OCCASION_GROUPS, OCCASIONS_FLAT } from "../../constants/occasions";
import ClosetCategoryBrowse from "../../components/closet/ClosetCategoryBrowse";
import { ClosetShelfSections } from "../../components/closet/ClosetShelfSections";
import {
  CLOSET_SORT_META as SORT_META,
  CLOSET_SORT_ORDER as SORT_ORDER,
  type ClosetSortMode as SortMode,
  filterClosetItems,
  itemMatchesOccasionFilter,
  sortClosetItems,
} from "../../components/closet/closetItemFilters";
import { takeClosetToast } from "../../lib/closetToast";
import { supabase } from "../../lib/supabase";

const { width, height } = Dimensions.get("window");

const SORT_DROPDOWN_W = Math.min(200, width - 56);

/** Compact color overlay: 5×N grid of equal square cells, centered panel. */
const COLOR_PANEL_W = Math.min(280, width - 40);
const COLOR_GAP = 6;
const COLOR_PAD = 8;

// ─── ICONS ────────────────────────────────────────────────────────────────────

const ArcPlus = ({ color, size = 24 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      d="M12 5V19M5 12H19"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
);

const ArcSearch = ({ color, size = 20 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Circle
      cx="11"
      cy="11"
      r="7.5"
      stroke={color}
      strokeWidth="2"
      fill="none"
    />
    <Path
      d="M16.5 16.5L22 22"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
    />
  </Svg>
);

const ArcClose = ({ color, size = 20 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      d="M18 6L6 18M6 6L18 18"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
);

// ─── ITEM DETAIL ──────────────────────────────────────────────────────────────

type ItemDetailProps = {
  item: any;
  occasions: { id: string; label: string }[];
  closetItems: any[];
  onClose: () => void;
  onUpdateItem: (updated: any) => void;
  onDeleteItem: (id: string) => void;
  onSelectClosetItem: (picked: any) => void;
};

function itemToDraft(item: any) {
  const seasons = item?.seasons;
  const seasonsStr =
    Array.isArray(seasons) && seasons.length ? seasons.join(", ") : "all";
  return {
    name: item?.name ?? "",
    brand: item?.brand ?? "",
    type: item?.type ?? "",
    color: item?.color ?? "",
    seasonsStr,
    occasions: [...(item?.occasions || [])],
  };
}

function normCategory(c: string | undefined) {
  return (c || "other").toLowerCase().trim();
}

const NEUTRALS = [
  "black",
  "white",
  "gray",
  "grey",
  "navy",
  "beige",
  "cream",
  "camel",
  "khaki",
  "tan",
  "brown",
  "ivory",
  "charcoal",
  "off-white",
];
const FORMALITY_RANK: Record<string, number> = {
  casual: 0,
  streetwear: 0,
  athletic: 0,
  "smart casual": 1,
  smart_casual: 1,
  "business casual": 2,
  business_casual: 2,
  formal: 3,
  business: 3,
  "black tie": 4,
  black_tie: 4,
};

/** Pair weights: how strongly two categories complement each other (0 = never pair). */
const PAIR_W: Record<string, Record<string, number>> = {
  top: { bottom: 3, shoes: 2, outerwear: 2, bag: 1.5, accessory: 1.5 },
  bottom: { top: 3, shoes: 3, outerwear: 2, bag: 1.5, accessory: 1.5 },
  outerwear: {
    top: 2,
    bottom: 2,
    shoes: 2,
    "full body": 2,
    bag: 1.5,
    accessory: 1.5,
  },
  shoes: {
    bottom: 3,
    top: 2,
    outerwear: 2,
    "full body": 3,
    bag: 1.5,
    accessory: 1.5,
  },
  bag: {
    "full body": 2,
    shoes: 2,
    top: 1.5,
    bottom: 1.5,
    outerwear: 1.5,
    accessory: 1,
  },
  accessory: {
    "full body": 1.5,
    top: 1.5,
    shoes: 1.5,
    bottom: 1,
    outerwear: 1,
    bag: 1,
    accessory: 0.8,
  },
  "full body": { shoes: 3, bag: 2, accessory: 2, outerwear: 2 },
};

function compatibleScore(center: any, other: any): number {
  const cc = normCategory(center?.category);
  const oc = normCategory(other?.category);

  // Same category is never a match (except accessories can layer)
  if (cc === oc && cc !== "accessory") return 0;

  const basePair = PAIR_W[cc]?.[oc] ?? 0;
  if (basePair === 0) return 0;
  let s = basePair;

  // Occasions overlap — strongest real-world signal
  const co: string[] = Array.isArray(center?.occasions) ? center.occasions : [];
  const oo: string[] = Array.isArray(other?.occasions) ? other.occasions : [];
  if (co.length && oo.length) {
    const overlap = co.filter((x: string) => oo.includes(x)).length;
    s += overlap * 2;
    if (overlap === 0) s -= 1.5; // penalise zero overlap hard
  }

  // Formality alignment
  const cf = (center?.formality || center?.style || "").toLowerCase();
  const of_ = (other?.formality || other?.style || "").toLowerCase();
  if (cf && of_) {
    const cr = FORMALITY_RANK[cf] ?? -1;
    const or_ = FORMALITY_RANK[of_] ?? -1;
    if (cr >= 0 && or_ >= 0) {
      const diff = Math.abs(cr - or_);
      if (diff === 0) s += 1.5;
      else if (diff === 1) s += 0.5;
      else if (diff >= 2) s -= 2; // e.g. athletic shoes + formal top = bad
    }
  }

  // Style match (e.g. both streetwear)
  const cs = (center?.style || "").toLowerCase();
  const os = (other?.style || "").toLowerCase();
  if (cs && os && cs === os) s += 1;

  // Color harmony
  const cColor = (center?.color || "").toLowerCase();
  const oColor = (other?.color || "").toLowerCase();
  if (cColor && oColor) {
    const cNeutral = NEUTRALS.some((n) => cColor.includes(n));
    const oNeutral = NEUTRALS.some((n) => oColor.includes(n));
    if (cNeutral || oNeutral) s += 0.8; // neutrals work with everything
    if (cColor === oColor) s += 0.4; // monochrome can work
  }

  // Season overlap
  const cSeas: string[] = Array.isArray(center?.seasons) ? center.seasons : [];
  const oSeas: string[] = Array.isArray(other?.seasons) ? other.seasons : [];
  if (cSeas.length && oSeas.length) {
    if (cSeas.includes("all") || oSeas.includes("all")) s += 0.3;
    else if (cSeas.some((x: string) => oSeas.includes(x))) s += 0.5;
    else s -= 0.5;
  }

  return s;
}

function listCompatibleClosetItems(center: any, all: any[]): any[] {
  if (!center?.id) return [];
  return all
    .filter((x) => x && x.id !== center.id)
    .map((o) => ({ o, s: compatibleScore(center, o) }))
    .filter((x) => x.s > 1.5) // only genuinely compatible items
    .sort((a, b) => b.s - a.s)
    .map((x) => x.o);
}

function ItemDetail({
  item,
  occasions,
  closetItems,
  onClose,
  onUpdateItem,
  onDeleteItem,
  onSelectClosetItem,
}: ItemDetailProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compatibleOpen, setCompatibleOpen] = useState(false);
  const [itemColorPickerOpen, setItemColorPickerOpen] = useState(false);
  const [draft, setDraft] = useState(() => itemToDraft(item));

  const compatibleList = useMemo(
    () => listCompatibleClosetItems(item, closetItems),
    [item, closetItems],
  );

  useEffect(() => {
    setDraft(itemToDraft(item));
    setEditing(false);
    setCompatibleOpen(false);
  }, [item?.id]);

  useEffect(() => {
    if (editing) setCompatibleOpen(false);
  }, [editing]);

  const toggleOccasion = (occId: string) => {
    setDraft((prev) => {
      const cur = prev.occasions;
      const next = cur.includes(occId)
        ? cur.filter((x: string) => x !== occId)
        : [...cur, occId];
      return { ...prev, occasions: next };
    });
  };

  const saveMetadata = async () => {
    if (!item?.id || saving) return;
    setSaving(true);
    try {
      const seasonParts = draft.seasonsStr
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const seasons = seasonParts.length ? seasonParts : ["all"];
      const payload = {
        name: draft.name.trim() || null,
        brand: draft.brand.trim() || null,
        type: draft.type.trim() || null,
        color: draft.color.trim() || null,
        seasons,
        occasions: draft.occasions.length ? draft.occasions : ["casual"],
      };
      await supabase.from("clothing_items").update(payload).eq("id", item.id);
      const next = { ...item, ...payload };
      onUpdateItem(next);
      setDraft(itemToDraft(next));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const onRemove = () => {
    Alert.alert("Remove from closet?", "This can’t be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          if (!item?.id) return;
          await supabase.from("clothing_items").delete().eq("id", item.id);
          onDeleteItem(item.id);
        },
      },
    ]);
  };

  const goMakeOutfit = () => {
    onClose();
    router.push({
      pathname: "/(tabs)/fits",
      params: { seedItemId: String(item.id) },
    });
  };

  const titleLine = item?.name || item?.type || "Piece";
  const brandLine = item?.brand?.trim() || item?.type?.trim() || "";

  const translateY = useSharedValue(0);
  const dismissOpacity = useSharedValue(1);

  const dismissAfterSwipe = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    translateY.value = 0;
    dismissOpacity.value = 1;
  }, [item?.id]);

  const swipeDismissStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: dismissOpacity.value,
  }));

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!editing && !compatibleOpen)
        .activeOffsetY(14)
        .failOffsetX([-48, 48])
        .onUpdate((e) => {
          "worklet";
          const ty = e.translationY;
          if (ty > 0) translateY.value = ty;
        })
        .onEnd((e) => {
          "worklet";
          if (e.translationY > 110 || e.velocityY > 620) {
            dismissOpacity.value = withTiming(0, { duration: 200 });
            translateY.value = withTiming(
              height * 1.08,
              { duration: 220 },
              (finished) => {
                if (finished) runOnJS(dismissAfterSwipe)();
              },
            );
          } else {
            translateY.value = withTiming(0, { duration: 200 });
          }
        }),
    [editing, compatibleOpen, dismissAfterSwipe],
  );

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={[detailStyles.fsRoot, swipeDismissStyle]}>
        <StatusBar barStyle="light-content" />
        <View
          style={[detailStyles.fsDragLipWrap, { paddingTop: insets.top + 6 }]}
          pointerEvents="none"
        >
          <View style={detailStyles.fsDragLip} />
        </View>
        <Image
          source={{ uri: item?.image_url }}
          style={detailStyles.fsImage}
          resizeMode="contain"
        />
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.5)", "rgba(0,0,0,0.88)"]}
          locations={[0.35, 0.65, 1]}
          style={detailStyles.fsGradient}
          pointerEvents="none"
        />

        <TouchableOpacity
          style={[detailStyles.fsClose, { top: insets.top + 10 }]}
          onPress={onClose}
          hitSlop={14}
          activeOpacity={0.85}
        >
          <View style={detailStyles.fsCloseInner}>
            <ArcClose color="#FFF" size={17} />
          </View>
        </TouchableOpacity>

        <View style={[detailStyles.fsMeta, { bottom: insets.bottom + 108 }]}>
          <Text style={detailStyles.fsTitle} numberOfLines={2}>
            {titleLine}
          </Text>
          {!!brandLine && (
            <Text style={detailStyles.fsBrand} numberOfLines={1}>
              {brandLine}
            </Text>
          )}
        </View>

        {!editing && (
          <View
            style={[
              detailStyles.bubbleBar,
              { paddingBottom: Math.max(insets.bottom, 14) },
            ]}
          >
            <View style={detailStyles.bubbleRow}>
              <TouchableOpacity
                style={detailStyles.bubbleWrap}
                onPress={goMakeOutfit}
                activeOpacity={0.88}
              >
                <View style={detailStyles.bubble}>
                  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <Path
                      d="M15 3H18L21 6V9L18 8V19C18 20.1046 17.1046 21 16 21H8C6.89543 21 6 20.1046 6 19V8L3 9V6L6 3H9L12 5L15 3Z"
                      stroke="#000"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </Svg>
                </View>
                <View style={detailStyles.bubbleLabelSlot}>
                  <Text style={detailStyles.bubbleLabel} numberOfLines={2}>
                    Make{"\n"}outfit
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={detailStyles.bubbleWrap}
                onPress={() => setEditing(true)}
                activeOpacity={0.88}
              >
                <View style={detailStyles.bubble}>
                  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <Path
                      d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
                      stroke="#000"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </Svg>
                </View>
                <View style={detailStyles.bubbleLabelSlot}>
                  <Text style={detailStyles.bubbleLabel} numberOfLines={2}>
                    Edit
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={detailStyles.bubbleWrap}
                onPress={onRemove}
                activeOpacity={0.88}
              >
                <View style={detailStyles.bubble}>
                  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <Circle
                      cx="12"
                      cy="12"
                      r="8.5"
                      stroke="#000"
                      strokeWidth="2"
                    />
                    <Path
                      d="M8 12h8"
                      stroke="#000"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </Svg>
                </View>
                <View style={detailStyles.bubbleLabelSlot}>
                  <Text style={detailStyles.bubbleLabel} numberOfLines={2}>
                    Remove
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={detailStyles.bubbleWrap}
                onPress={() => setCompatibleOpen(true)}
                activeOpacity={0.88}
              >
                <View style={detailStyles.bubble}>
                  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <Circle
                      cx="9"
                      cy="12"
                      r="4.5"
                      stroke="#000"
                      strokeWidth="2"
                    />
                    <Circle
                      cx="15"
                      cy="12"
                      r="4.5"
                      stroke="#000"
                      strokeWidth="2"
                    />
                  </Svg>
                </View>
                <View style={detailStyles.bubbleLabelSlot}>
                  <Text style={detailStyles.bubbleLabel} numberOfLines={2}>
                    Matches
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {compatibleOpen && !editing ? (
          <View style={detailStyles.compatOverlay} pointerEvents="box-none">
            <Pressable
              style={detailStyles.compatBackdrop}
              onPress={() => setCompatibleOpen(false)}
            />
            <View
              style={[
                detailStyles.compatSheet,
                { paddingBottom: Math.max(insets.bottom, 12) + 10 },
              ]}
            >
              <View style={detailStyles.compatGrab} />
              <Text style={detailStyles.compatTitle}>Could wear with</Text>
              <Text style={detailStyles.compatSub}>
                From your closet · tap to open
              </Text>
              {compatibleList.length === 0 ? (
                <Text style={detailStyles.compatEmpty}>
                  Add more pieces to see pairings.
                </Text>
              ) : (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={detailStyles.compatScrollContent}
                  style={detailStyles.compatScroll}
                >
                  {compatibleList.map((p) => {
                    const line = p?.name || p?.type || "Piece";
                    const sub = (p?.category || "").toString();
                    return (
                      <TouchableOpacity
                        key={p.id}
                        style={detailStyles.compatCard}
                        onPress={() => {
                          setCompatibleOpen(false);
                          onSelectClosetItem(p);
                        }}
                        activeOpacity={0.88}
                      >
                        <Image
                          source={{ uri: p?.image_url }}
                          style={detailStyles.compatImage}
                          resizeMode="cover"
                        />
                        <Text
                          style={detailStyles.compatCardTitle}
                          numberOfLines={2}
                        >
                          {line}
                        </Text>
                        {!!sub && (
                          <Text
                            style={detailStyles.compatCardCat}
                            numberOfLines={1}
                          >
                            {sub}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          </View>
        ) : null}

        {editing ? (
          <>
            <View style={detailStyles.editOverlay}>
              <Pressable
                style={detailStyles.editBackdrop}
                onPress={() => {
                  setDraft(itemToDraft(item));
                  setEditing(false);
                }}
              />
              <KeyboardAvoidingView
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                style={detailStyles.editKav}
              >
                <Animated.View
                  entering={FadeInUp.duration(280)}
                  style={editPanelStyles.sheet}
                >
                  <View style={editPanelStyles.grab} />
                  <ScrollView
                    style={editPanelStyles.scroll}
                    contentContainerStyle={editPanelStyles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                    nestedScrollEnabled
                  >
                    <View style={editPanelStyles.heroRow}>
                      <Image
                        source={{ uri: item?.image_url }}
                        style={editPanelStyles.heroThumb}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          style={editPanelStyles.heroName}
                          numberOfLines={1}
                        >
                          {titleLine}
                        </Text>
                        {brandLine ? (
                          <Text
                            style={editPanelStyles.heroSub}
                            numberOfLines={1}
                          >
                            {brandLine}
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    <View style={editPanelStyles.tagsCard}>
                      <Text style={editPanelStyles.tagGroupLabel}>
                        Occasion
                      </Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={editPanelStyles.chipScrollInner}
                      >
                        {occasions.map((occ) => {
                          const isActive = draft.occasions.includes(occ.id);
                          return (
                            <TouchableOpacity
                              key={occ.id}
                              style={[
                                editPanelStyles.occChip,
                                isActive && editPanelStyles.occChipOn,
                              ]}
                              onPress={() => toggleOccasion(occ.id)}
                              activeOpacity={0.85}
                            >
                              <Text
                                style={[
                                  editPanelStyles.occChipText,
                                  isActive && editPanelStyles.occChipTextOn,
                                ]}
                              >
                                {occ.label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>

                      <View style={editPanelStyles.tagGroupSpacer} />

                      <Text style={editPanelStyles.tagGroupLabel}>Season</Text>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={editPanelStyles.chipScrollInner}
                      >
                        {SEASON_CHIPS.map((chip) => {
                          const on = isSeasonChipOn(draft.seasonsStr, chip.id);
                          return (
                            <TouchableOpacity
                              key={chip.id}
                              style={[
                                editPanelStyles.chip,
                                on && editPanelStyles.chipOn,
                              ]}
                              onPress={() =>
                                setDraft((d) => ({
                                  ...d,
                                  seasonsStr: toggleSeasonChip(
                                    d.seasonsStr,
                                    chip.id,
                                  ),
                                }))
                              }
                              activeOpacity={0.85}
                            >
                              <Text
                                style={[
                                  editPanelStyles.chipText,
                                  on && editPanelStyles.chipTextOn,
                                ]}
                              >
                                {chip.label}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>

                      <View style={editPanelStyles.tagGroupSpacer} />

                      <Text style={editPanelStyles.tagGroupLabel}>Color</Text>
                      <TouchableOpacity
                        style={editPanelStyles.colorTriggerRow}
                        onPress={() => setItemColorPickerOpen(true)}
                        activeOpacity={0.88}
                        accessibilityLabel="Choose color"
                      >
                        <ColorPickerTriggerIcon size={40} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={editPanelStyles.colorTriggerLabel}
                            numberOfLines={1}
                          >
                            {draft.color?.trim() ? draft.color : "Choose color"}
                          </Text>
                          <Text style={editPanelStyles.colorTriggerHint}>
                            Grid, spectrum, or sliders
                          </Text>
                        </View>
                      </TouchableOpacity>
                      <TextInput
                        style={[
                          editPanelStyles.compactInput,
                          editPanelStyles.colorCustomInput,
                        ]}
                        value={draft.color}
                        onChangeText={(t) =>
                          setDraft((d) => ({ ...d, color: t }))
                        }
                        placeholder="Custom color (optional)"
                        placeholderTextColor={Colors.textMuted}
                      />
                    </View>

                    <View style={editPanelStyles.sectionCard}>
                      <View
                        style={[
                          editPanelStyles.denseBlock,
                          editPanelStyles.denseBlockFirst,
                        ]}
                      >
                        <Text style={editPanelStyles.fieldMicro}>Name</Text>
                        <TextInput
                          style={editPanelStyles.compactInput}
                          value={draft.name}
                          onChangeText={(t) =>
                            setDraft((d) => ({ ...d, name: t }))
                          }
                          placeholder="Name"
                          placeholderTextColor={Colors.textMuted}
                        />
                      </View>
                      <View style={editPanelStyles.pairRow}>
                        <View style={editPanelStyles.pairCell}>
                          <Text style={editPanelStyles.fieldMicro}>
                            Brand (optional)
                          </Text>
                          <TextInput
                            style={editPanelStyles.compactInput}
                            value={draft.brand}
                            onChangeText={(t) =>
                              setDraft((d) => ({ ...d, brand: t }))
                            }
                            placeholder="—"
                            placeholderTextColor={Colors.textMuted}
                          />
                        </View>
                        <View style={editPanelStyles.pairCell}>
                          <Text style={editPanelStyles.fieldMicro}>
                            Type (optional)
                          </Text>
                          <TextInput
                            style={editPanelStyles.compactInput}
                            value={draft.type}
                            onChangeText={(t) =>
                              setDraft((d) => ({ ...d, type: t }))
                            }
                            placeholder="—"
                            placeholderTextColor={Colors.textMuted}
                          />
                        </View>
                      </View>
                    </View>
                  </ScrollView>

                  <View
                    style={[
                      editPanelStyles.footer,
                      { paddingBottom: insets.bottom + 10 },
                    ]}
                  >
                    <TouchableOpacity
                      style={editPanelStyles.footerGhost}
                      onPress={() => {
                        setDraft(itemToDraft(item));
                        setEditing(false);
                      }}
                      activeOpacity={0.88}
                    >
                      <Text style={editPanelStyles.footerGhostText}>
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        editPanelStyles.footerSave,
                        saving && { opacity: 0.5 },
                      ]}
                      onPress={saveMetadata}
                      disabled={saving}
                      activeOpacity={0.88}
                    >
                      <Text style={editPanelStyles.footerSaveText}>
                        {saving ? "Saving…" : "Save"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              </KeyboardAvoidingView>
            </View>
            <IosStyleColorPickerModal
              variant="item"
              visible={itemColorPickerOpen}
              onClose={() => setItemColorPickerOpen(false)}
              itemValue={draft.color || ""}
              onSelectItem={(c) => {
                setDraft((d) => ({ ...d, color: c }));
                setItemColorPickerOpen(false);
              }}
            />
          </>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

const detailStyles = StyleSheet.create({
  /** Matches closet screen so dismiss doesn’t flash solid black behind the sheet. */
  fsRoot: { flex: 1, backgroundColor: Colors.bg },
  fsDragLipWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    zIndex: 19,
    alignItems: "center",
  },
  fsDragLip: {
    width: 42,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.52)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.2)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 4,
  },
  fsImage: {
    ...StyleSheet.absoluteFillObject,
    top: 0,
  },
  fsGradient: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: Math.round(height * 0.5),
  },
  fsClose: {
    position: "absolute",
    right: 16,
    zIndex: 20,
  },
  fsCloseInner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  fsMeta: {
    position: "absolute",
    left: 20,
    right: 20,
    zIndex: 8,
  },
  fsTitle: {
    color: "#FFF",
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: -0.5,
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  fsBrand: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 13,
    fontWeight: "700",
    marginTop: 6,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    textShadowColor: "rgba(0,0,0,0.4)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  bubbleBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 12,
    paddingTop: 16,
    backgroundColor: "transparent",
  },
  bubbleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 12,
  },
  bubbleWrap: {
    width: (width - 24) / 4,
    alignItems: "center",
    gap: 8,
  },
  bubble: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(255,255,255,0.88)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.65)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 8,
  },
  bubbleLabelSlot: {
    minHeight: 32,
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 2,
  },
  bubbleLabel: {
    color: "#FFF",
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "800",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  editOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    justifyContent: "flex-end",
  },
  editBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  editKav: {
    maxHeight: Math.round(height * 0.88),
    width: "100%",
  },
  compatOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 28,
    justifyContent: "flex-end",
  },
  compatBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  compatSheet: {
    backgroundColor: "rgba(22,22,24,0.97)",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    paddingTop: 6,
    maxHeight: Math.round(height * 0.42),
  },
  compatGrab: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignSelf: "center",
    marginBottom: 10,
  },
  compatTitle: {
    color: "#FFF",
    fontSize: 17,
    fontWeight: "900",
    letterSpacing: -0.3,
    paddingHorizontal: 18,
  },
  compatSub: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 10,
    paddingHorizontal: 18,
  },
  compatEmpty: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontWeight: "600",
    paddingHorizontal: 18,
    paddingVertical: 20,
  },
  compatScroll: {
    flexGrow: 0,
  },
  compatScrollContent: {
    paddingHorizontal: 14,
    paddingBottom: 16,
    paddingTop: 4,
    gap: 0,
  },
  compatCard: {
    width: 100,
    marginRight: 12,
  },
  compatImage: {
    width: 100,
    height: 128,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  compatCardTitle: {
    marginTop: 8,
    color: "#FFF",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: -0.2,
    lineHeight: 15,
  },
  compatCardCat: {
    marginTop: 2,
    color: "rgba(255,255,255,0.45)",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "capitalize",
  },
});

const SEASON_CHIPS = [
  { id: "all", label: "All year" },
  { id: "spring", label: "Spring" },
  { id: "summer", label: "Summer" },
  { id: "fall", label: "Fall" },
  { id: "winter", label: "Winter" },
] as const;

function seasonTokenSet(str: string) {
  return new Set(
    str
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isSeasonChipOn(seasonsStr: string, chipId: string) {
  const s = seasonTokenSet(seasonsStr);
  if (chipId === "all") return s.has("all") || s.size === 0;
  if (s.has("all")) return false;
  return s.has(chipId);
}

function toggleSeasonChip(seasonsStr: string, chipId: string) {
  const s = seasonTokenSet(seasonsStr);
  if (chipId === "all") return "all";
  s.delete("all");
  if (s.has(chipId)) s.delete(chipId);
  else s.add(chipId);
  if (s.size === 0) return "all";
  return [...s].join(", ");
}

const editPanelStyles = StyleSheet.create({
  sheet: {
    backgroundColor: Colors.bg,
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    maxHeight: Math.round(height * 0.92),
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 28,
  },
  grab: {
    width: 36,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.1)",
    alignSelf: "center",
    marginTop: 6,
    marginBottom: 4,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  heroThumb: {
    width: 36,
    height: 36,
    borderRadius: Radii.sm,
    backgroundColor: Colors.silver,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  heroName: {
    fontSize: 15,
    fontWeight: "800",
    color: Colors.text,
    letterSpacing: -0.3,
  },
  heroSub: {
    fontSize: 10,
    fontWeight: "600",
    color: Colors.textLight,
    marginTop: 1,
    letterSpacing: 0.12,
    textTransform: "uppercase",
  },
  scroll: {
    flexGrow: 1,
    maxHeight: Math.round(height * 0.58),
  },
  scrollContent: {
    paddingBottom: 4,
  },
  tagsCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
    paddingBottom: 8,
    paddingTop: 10,
  },
  tagGroupLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.textLight,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  tagGroupSpacer: {
    height: 8,
  },
  chipScrollInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 2,
  },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  colorTriggerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  colorTriggerLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  colorTriggerHint: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  colorSwatchScroll: {
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 4,
    gap: 4,
  },
  swatchHit: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  swatchHitOn: {
    borderWidth: 2,
    borderColor: Colors.text,
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  swatchDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.12)",
  },
  swatchDotLight: {
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.18)",
  },
  colorCustomInput: {
    marginHorizontal: 12,
    marginTop: 6,
    marginBottom: 2,
    minHeight: 36,
    paddingVertical: Platform.OS === "ios" ? 8 : 6,
  },
  denseBlock: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  denseBlockFirst: {
    borderTopWidth: 0,
    paddingTop: 10,
  },
  pairRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  pairCell: {
    flex: 1,
    minWidth: 0,
  },
  fieldMicro: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textMuted,
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  compactInput: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.text,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 9,
    paddingVertical: Platform.OS === "ios" ? 8 : 6,
    minHeight: 36,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radii.full,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipOn: {
    backgroundColor: Colors.text,
    borderColor: Colors.text,
  },
  chipText: {
    fontSize: 10,
    fontWeight: "700",
    color: Colors.textLight,
  },
  chipTextOn: {
    color: Colors.white,
  },
  occChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radii.full,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  occChipOn: {
    backgroundColor: Colors.text,
    borderColor: Colors.text,
  },
  occChipText: {
    fontSize: 10,
    fontWeight: "800",
    color: Colors.textLight,
    letterSpacing: 0.2,
  },
  occChipTextOn: {
    color: Colors.white,
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  footerGhost: {
    flex: 1,
    height: 46,
    borderRadius: Radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  footerGhostText: {
    fontSize: 15,
    fontWeight: "800",
    color: Colors.textLight,
  },
  footerSave: {
    flex: 1,
    height: 46,
    borderRadius: Radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.text,
    ...Styles.glow,
  },
  footerSaveText: {
    fontSize: 15,
    fontWeight: "800",
    color: Colors.white,
    letterSpacing: -0.2,
  },
});

const OCCASION_TABS = [
  { id: "all", label: "All" },
  ...OCCASION_GROUPS.map((g) => ({ id: g.id, label: g.label })),
];

// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────

export default function ClosetScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [closetToastMsg, setClosetToastMsg] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  /** Full category shelf modal (null = closed). */
  const [browseCategory, setBrowseCategory] = useState<string | null>(null);
  const [activeOccasion, setActiveOccasion] = useState("all");
  const [activeColor, setActiveColor] = useState("all");
  const [colorOpen, setColorOpen] = useState(false);
  const [iosFilterColorOpen, setIosFilterColorOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortMode>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const sortBtnRef = useRef<View>(null);
  const colorBtnRef = useRef<View>(null);
  const [sortAnchor, setSortAnchor] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [colorAnchor, setColorAnchor] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("clothing_items")
        .select("*")
        .order("created_at", { ascending: false });
      if (data) setItems(data.filter(Boolean));
      setLoading(false);
    })();
  }, []);

  useFocusEffect(
    useCallback(() => {
      const t = takeClosetToast();
      if (t) {
        setClosetToastMsg(t);
        const id = setTimeout(() => setClosetToastMsg(null), 2800);
        return () => clearTimeout(id);
      }
    }, []),
  );

  useEffect(() => {
    if (!sortOpen) setSortAnchor(null);
  }, [sortOpen]);

  useEffect(() => {
    if (!colorOpen) setColorAnchor(null);
  }, [colorOpen]);

  /** Items after search / occasion / color / sort — all categories shown as shelves. */
  const filteredItems = useMemo(() => {
    const filtered = filterClosetItems(items, {
      search,
      activeOccasion,
      activeColor,
      searchCategory: false,
    });
    return sortClosetItems(filtered, sortBy);
  }, [items, activeOccasion, activeColor, search, sortBy]);

  const handleUpdateItem = (updated: any) => {
    setItems((prev) =>
      prev.map((it) => (it && it.id === updated.id ? updated : it)),
    );
    setSelectedItem(updated);
  };

  const handleDeleteItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it && it.id !== id));
    setSelectedItem(null);
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" />

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bounces={false}
        alwaysBounceVertical={false}
      >
        {/* HEADER */}
        <Animated.View entering={FadeIn.duration(400)} style={styles.header}>
          <View>
            <Text style={styles.title}>My Closet</Text>
            {!loading && (
              <Text style={styles.subtitle}>
                {items.length} {items.length === 1 ? "piece" : "pieces"}
              </Text>
            )}
          </View>
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => router.push("/upload")}
            activeOpacity={0.8}
          >
            <ArcPlus color="#FFF" size={20} />
          </TouchableOpacity>
        </Animated.View>

        {/* SEARCH BAR */}
        <View style={styles.searchBar}>
          <ArcSearch color="rgba(0,0,0,0.3)" size={16} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search your wardrobe..."
            placeholderTextColor="rgba(0,0,0,0.25)"
            value={search}
            onChangeText={setSearch}
            clearButtonMode="while-editing"
          />
        </View>

        {/* Sort + color — one row, two compact pills side by side */}
        <View style={styles.sortColorRow}>
          <View
            ref={sortBtnRef}
            collapsable={false}
            style={styles.sortColorHit}
          >
            <TouchableOpacity
              style={styles.sortColorHalf}
              onPress={() => {
                if (sortOpen) {
                  setSortOpen(false);
                  return;
                }
                setColorOpen(false);
                sortBtnRef.current?.measureInWindow((x, y, w, h) => {
                  setSortAnchor({ x, y, w, h });
                  setSortOpen(true);
                });
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.sortColorLabelInline}>Sort</Text>
              <View style={styles.sortColorRight}>
                <Text
                  style={styles.sortColorValue}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.85}
                >
                  {SORT_META[sortBy].short}
                </Text>
                <Text style={styles.sortColorChevron}>▼</Text>
              </View>
            </TouchableOpacity>
          </View>

          <View
            ref={colorBtnRef}
            collapsable={false}
            style={styles.sortColorHit}
          >
            <TouchableOpacity
              style={[
                styles.sortColorHalf,
                activeColor !== "all" && styles.sortColorHalfActive,
              ]}
              onPress={() => {
                if (colorOpen) {
                  setColorOpen(false);
                  return;
                }
                setSortOpen(false);
                colorBtnRef.current?.measureInWindow((x, y, w, h) => {
                  setColorAnchor({ x, y, w, h });
                  setColorOpen(true);
                });
              }}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.sortColorLabelInline,
                  activeColor !== "all" && styles.sortColorLabelOn,
                ]}
              >
                Filter
              </Text>
              <View style={styles.sortColorRight}>
                <View
                  style={
                    activeColor !== "all"
                      ? styles.filterTriggerIconOn
                      : undefined
                  }
                >
                  <ColorPickerTriggerIcon size={20} />
                </View>
                <Text
                  style={[
                    styles.sortColorChevron,
                    activeColor !== "all" && styles.sortColorChevronOn,
                  ]}
                >
                  {colorOpen ? "▲" : "▼"}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* SORT DROPDOWN (modal menu) */}
        <Modal
          visible={sortOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setSortOpen(false)}
        >
          <View style={styles.sortModalRoot} pointerEvents="box-none">
            <Pressable
              style={styles.sortModalBackdrop}
              onPress={() => setSortOpen(false)}
            />
            {sortOpen && sortAnchor ? (
              <View
                style={[
                  styles.sortDropdown,
                  {
                    top: sortAnchor.y + sortAnchor.h + 6,
                    left: Math.max(
                      8,
                      Math.min(sortAnchor.x, width - SORT_DROPDOWN_W - 8),
                    ),
                    width: SORT_DROPDOWN_W,
                  },
                ]}
              >
                <Text style={styles.sortDropdownHeading}>Sort</Text>
                {SORT_ORDER.map((id, index) => {
                  const { label } = SORT_META[id];
                  const selected = sortBy === id;
                  return (
                    <TouchableOpacity
                      key={id}
                      style={[
                        styles.sortDropdownRow,
                        index < SORT_ORDER.length - 1 &&
                          styles.sortDropdownRowDivider,
                      ]}
                      onPress={() => {
                        setSortBy(id);
                        setSortOpen(false);
                      }}
                      activeOpacity={0.65}
                    >
                      <Text
                        style={[
                          styles.sortDropdownLabel,
                          selected && styles.sortDropdownLabelSelected,
                        ]}
                      >
                        {label}
                      </Text>
                      {selected ? (
                        <Text style={styles.sortDropdownCheck}>✓</Text>
                      ) : (
                        <View style={styles.sortDropdownCheckSpacer} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
          </View>
        </Modal>

        {/* FILTER MODAL — occasions + colors */}
        <Modal
          visible={colorOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setColorOpen(false)}
        >
          <View style={styles.colorModalRoot} pointerEvents="box-none">
            <Pressable
              style={styles.sortModalBackdrop}
              onPress={() => setColorOpen(false)}
            />
            {colorOpen && colorAnchor ? (
              <ScrollView
                style={[
                  styles.filterDropdownPanel,
                  {
                    position: "absolute",
                    top: colorAnchor.y + colorAnchor.h + 6,
                    left: Math.max(
                      8,
                      Math.min(
                        colorAnchor.x + colorAnchor.w - COLOR_PANEL_W,
                        width - COLOR_PANEL_W - 8,
                      ),
                    ),
                    width: COLOR_PANEL_W,
                  },
                ]}
                scrollEnabled={true}
                showsVerticalScrollIndicator={true}
              >
                {/* Occasions Section */}
                <View style={styles.filterSection}>
                  <Text style={styles.filterSectionLabel}>Occasion</Text>
                  <ScrollView
                    style={styles.occasionList}
                    scrollEnabled={true}
                    showsVerticalScrollIndicator={true}
                  >
                    {OCCASION_TABS.map((occ) => {
                      const isActive = activeOccasion === occ.id;
                      return (
                        <TouchableOpacity
                          key={occ.id}
                          style={[
                            styles.filterOption,
                            isActive && styles.filterOptionActive,
                          ]}
                          onPress={() => {
                            setActiveOccasion(occ.id);
                            setColorOpen(false);
                          }}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.filterOptionText,
                              isActive && styles.filterOptionTextActive,
                            ]}
                          >
                            {occ.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                {/* Divider */}
                <View style={styles.filterDivider} />

                {/* Colors — iOS-style picker */}
                <View style={styles.filterSection}>
                  <View style={styles.colorFilterRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.filterSectionLabel}>Color</Text>
                      <Text style={styles.colorFilterValue} numberOfLines={1}>
                        {activeColor === "all" ? "All colors" : activeColor}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        setColorOpen(false);
                        setIosFilterColorOpen(true);
                      }}
                      style={styles.colorFilterIconHit}
                      accessibilityLabel="Open color picker"
                      activeOpacity={0.85}
                    >
                      <ColorPickerTriggerIcon size={36} />
                    </TouchableOpacity>
                  </View>
                </View>
              </ScrollView>
            ) : null}
          </View>
        </Modal>

        <IosStyleColorPickerModal
          variant="filter"
          visible={iosFilterColorOpen}
          onClose={() => setIosFilterColorOpen(false)}
          filterValueId={activeColor}
          onSelectFilterId={(id) => {
            setActiveColor(id);
            setIosFilterColorOpen(false);
          }}
        />

        {/* BODY */}
        {loading ? (
          <ActivityIndicator
            size="large"
            color={Colors.accent}
            style={{ marginTop: 80 }}
          />
        ) : items.length === 0 ? (
          /* EMPTY STATE */
          <Animated.View
            entering={FadeInDown.delay(200)}
            style={styles.emptyState}
          >
            <View style={styles.emptyIconContainer}>
              <Svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                <Rect
                  x="4"
                  y="3"
                  width="16"
                  height="18"
                  rx="2"
                  stroke={Colors.accent}
                  strokeWidth="2"
                />
                <Path
                  d="M12 8V16M8 12H16"
                  stroke={Colors.accent}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </Svg>
            </View>
            <Text style={styles.emptyTitle}>Build your look from here.</Text>
            <Text style={styles.emptySub}>
              Add your closet to get OOTDs generated for your vibe.
            </Text>
            <TouchableOpacity
              style={[styles.emptyBtn, Styles.glow]}
              onPress={() => router.push("/upload")}
            >
              <Text style={styles.emptyBtnText}>DIGITIZE WARDROBE</Text>
            </TouchableOpacity>
          </Animated.View>
        ) : filteredItems.length === 0 ? (
          <View style={styles.noResults}>
            <Text style={styles.noResultsText}>No items found</Text>
            <Text style={styles.noResultsHint}>
              Try adjusting search or filters
            </Text>
          </View>
        ) : (
          <ClosetShelfSections
            items={filteredItems}
            onItemPress={(item) => setSelectedItem(item)}
            enableViewAll
            onViewAllCategory={setBrowseCategory}
          />
        )}
      </ScrollView>

      <ClosetCategoryBrowse
        presentation="overlay"
        visible={browseCategory !== null}
        categoryId={browseCategory}
        sourceItems={items}
        onClose={() => setBrowseCategory(null)}
        onItemPress={(item) => setSelectedItem(item)}
      />

      {/* ITEM DETAIL — full-screen photo + bubble actions */}
      <Modal
        visible={!!selectedItem}
        transparent
        animationType="none"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => setSelectedItem(null)}
      >
        {selectedItem ? (
          <GestureHandlerRootView style={styles.itemDetailModalRoot}>
            <ItemDetail
              item={selectedItem}
              occasions={OCCASIONS_FLAT}
              closetItems={items}
              onClose={() => setSelectedItem(null)}
              onUpdateItem={handleUpdateItem}
              onDeleteItem={handleDeleteItem}
              onSelectClosetItem={setSelectedItem}
            />
          </GestureHandlerRootView>
        ) : null}
      </Modal>

      {closetToastMsg ? (
        <Animated.View
          entering={FadeInDown.duration(320)}
          pointerEvents="none"
          style={[styles.closetToastBanner, { bottom: insets.bottom + 20 }]}
        >
          <Text style={styles.closetToastBannerText}>{closetToastMsg}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  closetToastBanner: {
    position: "absolute",
    left: 20,
    right: 20,
    backgroundColor: "rgba(0,0,0,0.88)",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    alignItems: "center",
    zIndex: 50,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 12,
  },
  closetToastBannerText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.2,
    textAlign: "center",
  },
  itemDetailModalRoot: {
    flex: 1,
    backgroundColor: "transparent",
  },
  scroll: {
    paddingTop: 72,
    paddingBottom: 130,
  },

  // HEADER
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "900",
    color: "#000000",
    letterSpacing: -1,
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    color: "rgba(0,0,0,0.4)",
    fontWeight: "600",
  },
  addBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },

  // SEARCH
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    height: 46,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    gap: 10,
    marginBottom: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: "#000",
    fontWeight: "500",
  },

  sortColorRow: {
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 10,
  },
  sortColorHit: {
    flex: 1,
    minWidth: 0,
  },
  sortColorHalf: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    paddingVertical: 11,
    paddingHorizontal: 12,
    gap: 8,
  },
  sortColorHalfActive: {
    backgroundColor: "#000000",
    borderColor: "#000000",
  },
  sortColorLabelInline: {
    fontSize: 11,
    fontWeight: "800",
    color: "rgba(0,0,0,0.42)",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    flexShrink: 0,
  },
  sortColorLabelOn: {
    color: "rgba(255,255,255,0.65)",
  },
  sortColorRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    justifyContent: "flex-end",
    minWidth: 0,
  },
  sortColorValue: {
    fontSize: 14,
    fontWeight: "800",
    color: "#000",
    letterSpacing: -0.2,
    flexShrink: 1,
    textAlign: "right",
  },
  sortColorChevron: {
    fontSize: 9,
    color: "rgba(0,0,0,0.35)",
  },
  sortColorChevronOn: {
    color: "rgba(255,255,255,0.85)",
  },
  filterTriggerIconOn: {
    opacity: 0.95,
  },

  dropdownChevron: {
    fontSize: 9,
    color: "rgba(0,0,0,0.35)",
  },
  sortModalRoot: {
    flex: 1,
  },
  sortModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sortDropdown: {
    position: "absolute",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 10,
    overflow: "hidden",
  },
  sortDropdownHeading: {
    fontSize: 10,
    fontWeight: "800",
    color: "rgba(0,0,0,0.32)",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  sortDropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  sortDropdownRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.08)",
  },
  sortDropdownLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: "#000",
    letterSpacing: -0.2,
  },
  sortDropdownLabelSelected: {
    fontWeight: "700",
  },
  sortDropdownCheck: {
    fontSize: 14,
    fontWeight: "800",
    color: "#000",
    marginLeft: 8,
    width: 20,
    textAlign: "right",
  },
  sortDropdownCheckSpacer: {
    width: 20,
    marginLeft: 8,
  },
  colorModalRoot: {
    flex: 1,
  },
  colorDropdownPanel: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.09)",
    padding: COLOR_PAD,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 10,
  },
  filterDropdownPanel: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.09)",
    paddingHorizontal: COLOR_PAD,
    paddingVertical: COLOR_PAD,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 10,
    maxHeight: 380,
  },
  filterSection: {
    marginVertical: 4,
  },
  filterSectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(0,0,0,0.5)",
    marginBottom: 8,
    paddingHorizontal: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  colorFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  colorFilterValue: {
    fontSize: 15,
    fontWeight: "600",
    color: "#000",
    marginTop: -4,
    marginBottom: 4,
  },
  colorFilterIconHit: {
    padding: 4,
  },
  filterOption: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 4,
  },
  filterOptionActive: {
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  filterOptionText: {
    fontSize: 14,
    fontWeight: "500",
    color: "rgba(0,0,0,0.6)",
  },
  filterOptionTextActive: {
    fontWeight: "700",
    color: "#000",
  },
  filterDivider: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.08)",
    marginVertical: 8,
  },
  occasionList: {
    maxHeight: 150,
  },
  colorGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: COLOR_GAP,
  },
  colorGridTile: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
  },
  colorGridTileActive: {
    backgroundColor: "rgba(0,0,0,0.07)",
    borderWidth: 2,
    borderColor: "#000",
  },
  colorGridDot: {
    alignItems: "center",
    justifyContent: "center",
  },
  colorGridDotAll: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.16)",
  },
  colorGridDotAllOn: {
    backgroundColor: "rgba(255,255,255,0.22)",
    borderColor: "rgba(255,255,255,0.55)",
  },
  colorGridDotAllText: {
    fontSize: 11,
    fontWeight: "900",
    color: "rgba(0,0,0,0.42)",
    marginTop: -1,
  },
  colorGridDotAllTextOn: {
    color: "rgba(255,255,255,0.95)",
  },

  // NO RESULTS
  noResults: {
    paddingTop: 80,
    alignItems: "center",
  },
  noResultsText: {
    fontSize: 14,
    fontWeight: "600",
    color: "rgba(0,0,0,0.3)",
  },
  noResultsHint: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: "500",
    color: "rgba(0,0,0,0.22)",
    textAlign: "center",
    paddingHorizontal: 32,
  },

  // EMPTY STATE
  emptyState: {
    paddingTop: 80,
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyIconContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#000000",
    textAlign: "center",
    marginBottom: 12,
  },
  emptySub: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 32,
  },
  emptyBtn: {
    backgroundColor: Colors.accent,
    height: 52,
    borderRadius: 26,
    paddingHorizontal: 32,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 15,
  },
  emptyBtnText: {
    fontSize: 13,
    fontWeight: "900",
    color: "#FFFFFF",
    letterSpacing: 0.5,
  },
});
