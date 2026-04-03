import { useUser } from "@clerk/clerk-expo";
import * as Localization from "expo-localization";
import * as Location from "expo-location";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated, DeviceEventEmitter, Dimensions,
    Image,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from "react-native";
import {
    Gesture,
    GestureDetector,
    GestureHandlerRootView,
} from "react-native-gesture-handler";
import Reanimated, {
    FadeInDown,
    FadeInUp,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import ClosetCategoryBrowse from "../../components/closet/ClosetCategoryBrowse";
import { ClosetShelfSections } from "../../components/closet/ClosetShelfSections";
import ColorPickerTriggerIcon from "../../components/color-picker/ColorPickerTriggerIcon";
import IosStyleColorPickerModal from "../../components/color-picker/IosStyleColorPickerModal";
import { Colors } from "../../constants/AppTheme";
import { OCCASION_GROUPS, OCCASIONS_FLAT } from "../../constants/occasions";
import { supabase } from "../../lib/supabase";

const { width, height: SCREEN_H } = Dimensions.get("window");

// Auto-gen carousel sizing — peek at next card
const AG_CARD_W = width - 44; // ~22px peek of next card on right
const AG_SNAP = AG_CARD_W + 12; // card width + gap

const AG_DAYS = ["S", "M", "T", "W", "T", "F", "S"];

function createBlankSchedule() {
  return {
    id: `local_${Date.now()}`,
    label: "",
    occasion: "",
    time_hour: 8,
    time_minute: 0,
    days_of_week: [1, 2, 3, 4, 5],
    is_active: true,
    anchor_item_ids: [] as string[],
  };
}

const BlurView = require("expo-blur").BlurView as any;

// ─── PREMIUM WEATHER ICONS (3D ASSET MAPPING) ───

const ASSETS = {
  sun: require("../../assets/weather/sun.png"),
  moon: require("../../assets/weather/moon.png"),
  cloud: require("../../assets/weather/cloud.png"),
  rain: require("../../assets/weather/rain.png"),
  snow: require("../../assets/weather/snow.png"),
  storm: require("../../assets/weather/storm.png"),
  heat: require("../../assets/weather/heat.png"),
  windy: require("../../assets/weather/windy.png"),
  rainbow: require("../../assets/weather/rainbow.png"),
  partly_cloudy_day: require("../../assets/weather/partly_cloudy_day.png"),
  partly_cloudy_night: require("../../assets/weather/partly_cloudy_night.png"),
};

const WeatherIcon = ({
  type,
  size = 100,
  isNight = false,
  compact = false,
}: {
  type: string;
  size?: number;
  isNight?: boolean;
  compact?: boolean;
}) => {
  // Regulating all icons to a consistent size and top-offset to match the 'cloudy' benchmark
  const globalTopMargin = compact ? 0 : 25;

  if (type === "sun") {
    return (
      <Image
        source={isNight ? ASSETS.moon : ASSETS.sun}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "cloud") {
    return (
      <Image
        source={ASSETS.cloud}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "suncloud") {
    if (!isNight)
      return (
        <Image
          source={ASSETS.partly_cloudy_day}
          style={{ width: size, height: size, marginTop: globalTopMargin }}
          resizeMode="contain"
        />
      );
    return (
      <Image
        source={ASSETS.partly_cloudy_night}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "rain") {
    return (
      <Image
        source={ASSETS.rain}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "snow") {
    return (
      <Image
        source={ASSETS.snow}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "storm") {
    return (
      <Image
        source={ASSETS.storm}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "heat") {
    return (
      <Image
        source={ASSETS.heat}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "windy") {
    return (
      <Image
        source={ASSETS.windy}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  if (type === "rainbow") {
    return (
      <Image
        source={ASSETS.rainbow}
        style={{ width: size, height: size, marginTop: globalTopMargin }}
        resizeMode="contain"
      />
    );
  }
  // Default fallback
  return (
    <Image
      source={ASSETS.cloud}
      style={{ width: size, height: size, marginTop: globalTopMargin }}
      resizeMode="contain"
    />
  );
};

const OCCASION_MAP: Record<string, { label: string; emoji: string }> = {
  casual: { label: "Casual", emoji: "👕" },
  work: { label: "Work", emoji: "💼" },
  school: { label: "School", emoji: "📚" },
  gym: { label: "Gym", emoji: "🏋️" },
  "night-out": { label: "Night Out", emoji: "🌙" },
  travel: { label: "Travel", emoji: "✈️" },
  formal: { label: "Formal", emoji: "🎩" },
  random: { label: "Surprise", emoji: "🎲" },
};
const AG_DAY_CHARS = ["S", "M", "T", "W", "T", "F", "S"];

// ─── SCHEDULE CARD (carousel item) ──────────────────────────────────────────
function ScheduleCard({
  schedule,
  cardWidth,
  onEdit,
  onView,
  onGenerate,
}: {
  schedule: any;
  cardWidth: number;
  onEdit: () => void;
  onView: () => void;
  onGenerate: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [anchorImgs, setAnchorImgs] = useState<string[]>([]);
  const [viewingAnchorIdx, setViewingAnchorIdx] = useState<number | null>(null);

  const today = new Date();
  const generatedToday = schedule.last_generated_at
    ? new Date(schedule.last_generated_at).toDateString() ===
      today.toDateString()
    : false;

  const h = schedule.time_hour ?? 8;
  const m = schedule.time_minute ?? 0;
  const period = h >= 12 ? "PM" : "AM";
  const hFmt = h % 12 === 0 ? 12 : h % 12;
  const timeStr = `${hFmt}:${m.toString().padStart(2, "0")} ${period}`;
  const days: number[] = schedule.days_of_week ?? [];
  const occ = OCCASION_MAP[schedule.occasion] ?? {
    label: schedule.occasion,
    emoji: "✨",
  };

  useEffect(() => {
    const ids: string[] = schedule.anchor_item_ids ?? [];
    if (!ids.length) {
      setAnchorImgs([]);
      return;
    }
    supabase
      .from("clothing_items")
      .select("image_url")
      .in("id", ids)
      .then(({ data }: any) => {
        if (data)
          setAnchorImgs(data.map((d: any) => d.image_url).filter(Boolean));
      });
  }, [JSON.stringify(schedule.anchor_item_ids)]);

  useEffect(() => {
    if (!generatedToday || !schedule.last_generated_outfit_id) return;
    supabase
      .from("outfit_items")
      .select("clothing_item_id, clothing_items(image_url)")
      .eq("outfit_id", schedule.last_generated_outfit_id)
      .order("layer_order", { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }: any) => {
        const url = data?.clothing_items?.image_url;
        if (url) setThumbUrl(url);
      });
  }, [generatedToday, schedule.last_generated_outfit_id]);

  const statusColor = !schedule.is_active
    ? "rgba(0,0,0,0.25)"
    : generatedToday
      ? "#4ADE80"
      : "#63B3ED";

  return (
    <View style={[agCardStyles.card, { width: cardWidth }]}>
      {/* ── LEFT PANEL ── */}
      <View style={agCardStyles.left}>
        {/* Name + occasion */}
        <View style={{ gap: 5 }}>
          <Text style={agCardStyles.name} numberOfLines={1}>
            {schedule.label || "Untitled"}
          </Text>
          <View style={agCardStyles.occChip}>
            <Text style={agCardStyles.occChipText}>{occ.label}</Text>
          </View>
        </View>

        {/* Day dots */}
        <View style={agCardStyles.daysRow}>
          {AG_DAY_CHARS.map((d, i) => {
            const active = days.includes(i);
            return (
              <View
                key={i}
                style={[agCardStyles.dayDot, active && agCardStyles.dayDotOn]}
              >
                <Text
                  style={[
                    agCardStyles.dayDotTxt,
                    active && agCardStyles.dayDotTxtOn,
                  ]}
                >
                  {d}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Always Include items */}
        {anchorImgs.length > 0 && (
          <View style={agCardStyles.anchorRow}>
            <Text style={agCardStyles.anchorLabel}>Always with</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ gap: 4 }}
            >
              {anchorImgs.map((uri, i) => (
                <TouchableOpacity
                  key={i}
                  onPress={() => setViewingAnchorIdx(i)}
                  activeOpacity={0.75}
                >
                  <Image
                    source={{ uri }}
                    style={agCardStyles.anchorThumb}
                    resizeMode="contain"
                  />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Time + status */}
        <View style={{ gap: 4 }}>
          <Text style={[agCardStyles.timeDisplay, { color: statusColor }]}>
            {timeStr}
          </Text>
          <Text style={agCardStyles.statusLine}>
            {!schedule.is_active
              ? "Paused"
              : generatedToday
                ? "✓ Done today"
                : "Scheduled"}
          </Text>
        </View>

        {/* Action buttons */}
        <View style={agCardStyles.btnRow}>
          {/* Generate / Regen */}
          <TouchableOpacity
            style={[
              agCardStyles.genBtn,
              generatedToday && agCardStyles.regenBtn,
            ]}
            onPress={onGenerate}
            activeOpacity={0.8}
          >
            {generatedToday ? (
              <Svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                <Path
                  d="M1 4v6h6M23 20v-6h-6"
                  stroke="#FFF"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <Path
                  d="M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15"
                  stroke="#FFF"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            ) : (
              <Svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                <Path
                  d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                  stroke="#000"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            )}
            <Text
              style={[
                agCardStyles.genBtnTxt,
                generatedToday && agCardStyles.regenBtnTxt,
              ]}
            >
              {generatedToday ? "Regen" : "Generate Now"}
            </Text>
          </TouchableOpacity>

          {/* Edit */}
          <TouchableOpacity
            style={agCardStyles.iconBtn}
            onPress={onEdit}
            activeOpacity={0.8}
          >
            <Svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <Circle
                cx="12"
                cy="12"
                r="3"
                stroke="rgba(0,0,0,0.55)"
                strokeWidth="2.2"
              />
              <Path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
                stroke="rgba(0,0,0,0.55)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </TouchableOpacity>

          {/* Wearing this (only when generated) */}
          {generatedToday && (
            <TouchableOpacity
              style={agCardStyles.iconBtn}
              onPress={onView}
              activeOpacity={0.8}
            >
              <Svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <Path
                  d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <Circle
                  cx="12"
                  cy="12"
                  r="3"
                  stroke="rgba(0,0,0,0.55)"
                  strokeWidth="2.2"
                />
              </Svg>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── RIGHT PANEL — fit preview ── */}
      <View style={agCardStyles.viewport}>
        {thumbUrl ? (
          <Image
            source={{ uri: thumbUrl }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="contain"
          />
        ) : (
          <Svg width={48} height={68} viewBox="0 0 24 32" fill="none">
            <Path
              d="M9 2.1C9 2.1 10 3.1 12 3.1C14 3.1 15 2.1 15 2.1L19 3.6V8.6L16.5 7.6V14.5H7.5V7.6L5 8.6V3.6L9 2.1Z"
              stroke="rgba(0,0,0,0.07)"
              strokeWidth="0.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Path
              d="M9 15.5H15L16.2 30H12.6L12 21L11.4 30H7.8L9 15.5Z"
              stroke="rgba(0,0,0,0.07)"
              strokeWidth="0.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        )}
        {generatedToday && (
          <View style={agCardStyles.generatedBadge}>
            <Text style={agCardStyles.generatedBadgeText}>✓</Text>
          </View>
        )}
      </View>

      {/* Fullscreen anchor image viewer */}
      {viewingAnchorIdx !== null && anchorImgs[viewingAnchorIdx] && (
        <Modal
          transparent
          visible
          animationType="fade"
          onRequestClose={() => setViewingAnchorIdx(null)}
        >
          <TouchableOpacity
            style={agCardStyles.imgViewerOverlay}
            activeOpacity={1}
            onPress={() => setViewingAnchorIdx(null)}
          >
            <TouchableOpacity
              style={agCardStyles.imgViewerContent}
              activeOpacity={1}
              onPress={() => {}}
            >
              <Image
                source={{ uri: anchorImgs[viewingAnchorIdx] }}
                style={agCardStyles.imgViewerImage}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={agCardStyles.imgViewerEditBtn}
                onPress={() => {
                  setViewingAnchorIdx(null);
                  onEdit();
                }}
                activeOpacity={0.8}
              >
                <Text style={agCardStyles.imgViewerEditText}>
                  Edit Always Include
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
}

const agCardStyles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderRadius: 22,
    overflow: "hidden",
    height: 240,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    backgroundColor: Colors.surface,
  },
  left: {
    flex: 5,
    padding: 14,
    justifyContent: "space-between",
  },
  name: {
    fontSize: 15,
    fontWeight: "800",
    color: "#000",
    letterSpacing: -0.4,
  },
  occChip: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.06)",
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  occChipText: {
    fontSize: 9,
    fontWeight: "700",
    color: "rgba(0,0,0,0.5)",
    letterSpacing: 0.3,
  },
  daysRow: {
    flexDirection: "row",
    gap: 3,
  },
  dayDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  dayDotOn: {
    backgroundColor: "#000",
    borderColor: "#000",
  },
  dayDotTxt: {
    fontSize: 8,
    fontWeight: "800",
    color: "rgba(0,0,0,0.3)",
  },
  dayDotTxtOn: {
    color: "#FFF",
  },
  timeDisplay: {
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  statusLine: {
    fontSize: 9,
    fontWeight: "700",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  btnRow: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  genBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: "#000",
    borderRadius: 12,
    paddingVertical: 8,
  },
  genBtnTxt: {
    fontSize: 11,
    fontWeight: "800",
    color: "#FFF",
  },
  regenBtn: {
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  regenBtnTxt: {
    color: "#000",
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewport: {
    flex: 4,
    backgroundColor: Colors.surfaceAlt,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  generatedBadge: {
    position: "absolute",
    bottom: 10,
    right: 10,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(74, 222, 128, 0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  generatedBadgeText: {
    fontSize: 10,
    fontWeight: "900",
    color: "#000",
  },
  anchorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  anchorLabel: {
    fontSize: 9,
    fontWeight: "600",
    color: "rgba(0,0,0,0.4)",
    letterSpacing: 0.2,
    flexShrink: 0,
  },
  anchorThumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.07)",
  },
  imgViewerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  imgViewerContent: {
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  imgViewerImage: {
    width: 300,
    height: 400,
    borderRadius: 12,
  },
  imgViewerEditBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#000",
    borderRadius: 12,
    alignItems: "center",
  },
  imgViewerEditText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFF",
  },
});

// Fetches a single clothing item image to show as the today's outfit preview
function TodayOutfitThumb({ itemId }: { itemId: string }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  useEffect(() => {
    supabase
      .from("clothing_items")
      .select("image_url")
      .eq("id", itemId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setImgUrl(data.image_url);
      });
  }, [itemId]);
  if (!imgUrl) return null;
  return (
    <Image
      source={{ uri: imgUrl }}
      style={{ width: "100%", height: "100%" }}
      resizeMode="contain"
    />
  );
}

// ─── CLOSET PICKER MODAL ─────────────────────────────────────────────────────
type CPMSort =
  | "recent"
  | "oldestAdded"
  | "alpha"
  | "alphaDesc"
  | "mostWorn"
  | "leastWorn";
const CPM_SORT_META: Record<CPMSort, { label: string; short: string }> = {
  recent: { label: "Recently added", short: "Recent" },
  oldestAdded: { label: "Oldest added", short: "Oldest" },
  alpha: { label: "A–Z", short: "A–Z" },
  alphaDesc: { label: "Z–A", short: "Z–A" },
  mostWorn: { label: "Most worn", short: "Most worn" },
  leastWorn: { label: "Least worn", short: "Least worn" },
};
const CPM_SORT_ORDER: CPMSort[] = [
  "recent",
  "oldestAdded",
  "alpha",
  "alphaDesc",
  "mostWorn",
  "leastWorn",
];

/** Normalize occasion ids for filtering (empty → casual). */
function itemOccasionIds(it: any): string[] {
  const o = it?.occasions;
  if (Array.isArray(o) && o.length)
    return o.map((x: string) => String(x).toLowerCase());
  return ["casual"];
}

function itemMatchesOccasionFilter(it: any, activeOccasion: string): boolean {
  if (activeOccasion === "all") return true;
  const group = OCCASION_GROUPS.find((g) => g.id === activeOccasion);
  if (!group) return true;
  const groupOccasionIds = group.occasions.map((o) => o.id);
  return itemOccasionIds(it).some((id) => groupOccasionIds.includes(id));
}

const CPM_OCCASION_TABS = [
  { id: "all", label: "All" },
  ...OCCASION_GROUPS.map((g) => ({ id: g.id, label: g.label })),
];

function ClosetPickerModal({
  items,
  selected,
  onToggle,
  onClose,
}: {
  items: any[];
  selected: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [browseCategory, setBrowseCategory] = useState<string | null>(null);
  const [activeOccasion, setActiveOccasion] = useState("all");
  const [activeColor, setActiveColor] = useState("all");
  const [sortBy, setSortBy] = useState<CPMSort>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [iosFilterColorOpen, setIosFilterColorOpen] = useState(false);
  const sortBtnRef = useRef<View>(null);
  const filterBtnRef = useRef<View>(null);
  const [sortAnchor, setSortAnchor] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [filterAnchor, setFilterAnchor] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const hasFilter = activeOccasion !== "all" || activeColor !== "all";

  const filtered = useMemo(() => {
    const list = items.filter((it) => {
      const occMatch = itemMatchesOccasionFilter(it, activeOccasion);
      const colorMatch =
        activeColor === "all" ||
        (it.color || "").toLowerCase().includes(activeColor.toLowerCase());
      const searchMatch =
        !search ||
        (it.name || it.type || "")
          .toLowerCase()
          .includes(search.toLowerCase()) ||
        (it.brand || "").toLowerCase().includes(search.toLowerCase());
      return occMatch && colorMatch && searchMatch;
    });
    const out = [...list];
    const key = (it: any) =>
      (it?.name || it?.type || it?.brand || "")
        .toString()
        .trim()
        .toLowerCase() || "\uFFFF";
    const cmpName = (a: any, b: any) =>
      key(a).localeCompare(key(b), undefined, { sensitivity: "base" });

    switch (sortBy) {
      case "recent":
        out.sort(
          (a, b) =>
            new Date(b?.created_at || 0).getTime() -
            new Date(a?.created_at || 0).getTime(),
        );
        break;
      case "oldestAdded":
        out.sort(
          (a, b) =>
            new Date(a?.created_at || 0).getTime() -
            new Date(b?.created_at || 0).getTime(),
        );
        break;
      case "alpha":
        out.sort((a, b) => cmpName(a, b));
        break;
      case "alphaDesc":
        out.sort((a, b) => cmpName(b, a));
        break;
      case "mostWorn":
        out.sort((a, b) => {
          const d = (b?.wear_count || 0) - (a?.wear_count || 0);
          return d !== 0 ? d : cmpName(a, b);
        });
        break;
      case "leastWorn":
        out.sort((a, b) => {
          const d = (a?.wear_count || 0) - (b?.wear_count || 0);
          return d !== 0 ? d : cmpName(a, b);
        });
        break;
    }
    return out;
  }, [items, activeOccasion, activeColor, search, sortBy]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const translateY = useSharedValue(SCREEN_H);

  const dismissAfterSwipe = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    translateY.value = withTiming(0, { duration: 320 });
  }, []);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
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
            translateY.value = withTiming(
              SCREEN_H * 1.08,
              { duration: 220 },
              (finished) => {
                if (finished) runOnJS(dismissAfterSwipe)();
              },
            );
          } else {
            translateY.value = withTiming(0, { duration: 260 });
          }
        }),
    [dismissAfterSwipe],
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <>
      <Modal transparent visible statusBarTranslucent animationType="none">
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
          <View style={cpm.overlay}>
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={1}
              onPress={onClose}
            />
            <GestureDetector gesture={gesture}>
              <Reanimated.View style={[cpm.sheet, animStyle]}>
                <View style={cpm.handle} />
                <View style={{ flex: 1 }}>
                  {/* Header */}
                  <View style={cpm.header}>
                    <View>
                      <Text style={cpm.title}>Always Include</Text>
                      <Text style={cpm.subtitle}>
                        {selected.length > 0
                          ? `${selected.length} selected`
                          : "Tap to pin items"}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={cpm.doneBtn}
                      onPress={onClose}
                      activeOpacity={0.8}
                    >
                      <Text style={cpm.doneBtnText}>Done</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Search */}
                  <View style={cpm.searchBar}>
                    <Text style={cpm.searchIcon}>🔍</Text>
                    <TextInput
                      style={cpm.searchInput}
                      placeholder="Search your wardrobe..."
                      placeholderTextColor="rgba(0,0,0,0.25)"
                      value={search}
                      onChangeText={setSearch}
                      clearButtonMode="while-editing"
                    />
                  </View>

                  {/* Sort + Filter row */}
                  <View style={cpm.sortColorRow}>
                    <View
                      ref={sortBtnRef}
                      collapsable={false}
                      style={{ flex: 1 }}
                    >
                      <TouchableOpacity
                        style={cpm.sortColorPill}
                        onPress={() => {
                          if (sortOpen) {
                            setSortOpen(false);
                            return;
                          }
                          setFilterOpen(false);
                          sortBtnRef.current?.measureInWindow((x, y, w, h) => {
                            setSortAnchor({ x, y, w, h });
                            setSortOpen(true);
                          });
                        }}
                        activeOpacity={0.7}
                      >
                        <Text style={cpm.sortColorLabel}>Sort</Text>
                        <View style={cpm.sortColorRight}>
                          <Text style={cpm.sortColorValue}>
                            {CPM_SORT_META[sortBy].short}
                          </Text>
                          <Text style={cpm.sortColorChevron}>
                            {sortOpen ? "▲" : "▼"}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                    <View
                      ref={filterBtnRef}
                      collapsable={false}
                      style={{ flex: 1 }}
                    >
                      <TouchableOpacity
                        style={[
                          cpm.sortColorPill,
                          hasFilter && cpm.sortColorPillActive,
                        ]}
                        onPress={() => {
                          if (filterOpen) {
                            setFilterOpen(false);
                            return;
                          }
                          setSortOpen(false);
                          filterBtnRef.current?.measureInWindow(
                            (x, y, w, h) => {
                              setFilterAnchor({ x, y, w, h });
                              setFilterOpen(true);
                            },
                          );
                        }}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            cpm.sortColorLabel,
                            hasFilter && cpm.sortColorLabelOn,
                          ]}
                        >
                          Filter
                        </Text>
                        <View style={cpm.sortColorRight}>
                          <View
                            style={
                              hasFilter ? cpm.filterTriggerIconOn : undefined
                            }
                          >
                            <ColorPickerTriggerIcon size={20} />
                          </View>
                          {hasFilter && (
                            <View style={cpm.filterBadge}>
                              <Text style={cpm.filterBadgeText}>
                                {(activeOccasion !== "all" ? 1 : 0) +
                                  (activeColor !== "all" ? 1 : 0)}
                              </Text>
                            </View>
                          )}
                          <Text
                            style={[
                              cpm.sortColorChevron,
                              hasFilter && cpm.sortColorChevronOn,
                            ]}
                          >
                            {filterOpen ? "▲" : "▼"}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Closet shelves */}
                  <ScrollView
                    style={cpm.gridScroll}
                    contentContainerStyle={cpm.grid}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                  >
                    <ClosetShelfSections
                      items={filtered}
                      onItemPress={(it) => onToggle(it.id)}
                      selectedIds={selectedSet}
                      selectionMode
                      enableViewAll
                      onViewAllCategory={(id) => setBrowseCategory(id)}
                      emptyHint="No items found"
                    />
                  </ScrollView>
                </View>
              </Reanimated.View>
            </GestureDetector>
          </View>

        {/* Sort overlay — nested modal so it floats above grid */}
        {sortOpen && (
          <View
            style={[
              StyleSheet.absoluteFill,
              { zIndex: 10000, elevation: 10000 },
            ]}
            pointerEvents="box-none"
          >
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={1}
              onPress={() => setSortOpen(false)}
            />
            {sortAnchor && (
              <View
                style={[
                  cpm.floatCard,
                  {
                    top: sortAnchor.y + sortAnchor.h + 6,
                    left: Math.max(8, sortAnchor.x),
                    width: Math.min(220, Dimensions.get("window").width - 16),
                  },
                ]}
              >
                <Text style={cpm.floatHeading}>Sort</Text>
                {CPM_SORT_ORDER.map((s, i) => (
                  <TouchableOpacity
                    key={s}
                    style={[
                      cpm.floatRow,
                      i < CPM_SORT_ORDER.length - 1 && cpm.floatRowDivider,
                    ]}
                    onPress={() => {
                      setSortBy(s);
                      setSortOpen(false);
                    }}
                    activeOpacity={0.65}
                  >
                    <Text
                      style={[
                        cpm.floatRowLabel,
                        sortBy === s && cpm.floatRowLabelOn,
                      ]}
                    >
                      {CPM_SORT_META[s].label}
                    </Text>
                    {sortBy === s ? (
                      <Text style={cpm.floatCheck}>✓</Text>
                    ) : (
                      <View style={cpm.floatCheckSpacer} />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Filter overlay — Occasion + Color */}
        {filterOpen && (
          <View
            style={[
              StyleSheet.absoluteFill,
              { zIndex: 10000, elevation: 10000 },
            ]}
            pointerEvents="box-none"
          >
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={1}
              onPress={() => setFilterOpen(false)}
            />
            {filterAnchor && (
              <View
                style={[
                  cpm.floatCard,
                  {
                    top: filterAnchor.y + filterAnchor.h + 6,
                    right: Math.max(
                      8,
                      Dimensions.get("window").width -
                        filterAnchor.x -
                        filterAnchor.w,
                    ),
                    width: Math.min(240, Dimensions.get("window").width - 16),
                    maxHeight: 380,
                  },
                ]}
              >
                <ScrollView showsVerticalScrollIndicator={false}>
                  {/* Occasion */}
                  <Text style={cpm.filterSectionLabel}>Occasion</Text>
                  {CPM_OCCASION_TABS.map((occ) => {
                    const on = activeOccasion === occ.id;
                    return (
                      <TouchableOpacity
                        key={occ.id}
                        style={[cpm.filterOption, on && cpm.filterOptionActive]}
                        onPress={() => {
                          setActiveOccasion(occ.id);
                          setFilterOpen(false);
                        }}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            cpm.filterOptionText,
                            on && cpm.filterOptionTextActive,
                          ]}
                        >
                          {occ.label}
                        </Text>
                        {on && (
                          <Text style={{ color: "#FFF", fontSize: 10 }}>●</Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                  <View style={cpm.filterDivider} />
                  <View style={cpm.cpmColorFilterRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={cpm.filterSectionLabel}>Color</Text>
                      <Text style={cpm.cpmColorFilterValue} numberOfLines={1}>
                        {activeColor === "all" ? "All colors" : activeColor}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        setFilterOpen(false);
                        setIosFilterColorOpen(true);
                      }}
                      style={cpm.cpmColorFilterIconHit}
                      accessibilityLabel="Open color picker"
                      activeOpacity={0.85}
                    >
                      <ColorPickerTriggerIcon size={36} />
                    </TouchableOpacity>
                  </View>
                </ScrollView>
              </View>
            )}
          </View>
        )}

          <ClosetCategoryBrowse
            presentation="overlay"
            visible={browseCategory !== null}
            categoryId={browseCategory}
            sourceItems={items}
            onClose={() => setBrowseCategory(null)}
            selectedIds={selectedSet}
            onToggleId={onToggle}
          />
          </View>
        </GestureHandlerRootView>
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
    </>
  );
}

const cpm = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingTop: "15%",
  },
  sheet: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 10,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.14,
    shadowRadius: 20,
    elevation: 24,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.12)",
    alignSelf: "center",
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: "#000",
    letterSpacing: -0.5,
  },
  subtitle: { fontSize: 12, color: "rgba(0,0,0,0.4)", marginTop: 2 },
  doneBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "#000",
  },
  doneBtnText: { fontSize: 14, fontWeight: "800", color: "#FFF" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, fontSize: 14, color: "#000" },
  gridScroll: { flex: 1 },
  grid: { paddingHorizontal: 0, paddingBottom: 60, paddingTop: 8 },
  // Sort + Color row
  sortColorRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    flexGrow: 0,
  },
  sortColorPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
    minHeight: 40,
  },
  sortColorPillActive: { backgroundColor: "#000", borderColor: "#000" },
  sortColorLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(0,0,0,0.4)",
    letterSpacing: 0.3,
  },
  sortColorLabelOn: { color: "rgba(255,255,255,0.7)" },
  sortColorRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  sortColorValue: {
    fontSize: 12,
    fontWeight: "700",
    color: "#000",
    maxWidth: 80,
  },
  sortColorChevron: {
    fontSize: 9,
    color: "rgba(0,0,0,0.35)",
    fontWeight: "700",
  },
  sortColorChevronOn: { color: "rgba(255,255,255,0.6)" },
  filterTriggerIconOn: { opacity: 0.95 },
  // Sort dropdown
  sortDropdown: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  sortOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  sortOptionText: { fontSize: 14, fontWeight: "600", color: "#000" },
  sortOptionTextActive: { fontWeight: "800" },
  sortOptionCheck: { fontSize: 14, fontWeight: "800", color: "#000" },
  // Color filter
  colorScroll: { marginBottom: 8 },
  colorRow: { gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  colorChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: Colors.surfaceAlt,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  colorChipActive: { backgroundColor: "#000", borderColor: "#000" },
  colorChipText: { fontSize: 12, fontWeight: "700", color: "rgba(0,0,0,0.5)" },
  colorChipTextActive: { color: "#FFF" },
  swatchHit: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.12)",
  },
  swatchDotLight: { borderWidth: 1, borderColor: "rgba(0,0,0,0.2)" },
  swatchDotOn: { borderWidth: 2.5, borderColor: "#000" },
  colorDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
  },
  rainbowDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#FF9500",
  },
  // Float overlay cards (sort + filter)
  floatCard: {
    position: "absolute",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.09)",
    paddingHorizontal: 8,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 12,
  },
  floatHeading: {
    fontSize: 11,
    fontWeight: "800",
    color: "rgba(0,0,0,0.4)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingBottom: 4,
  },
  floatRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingVertical: 11,
  },
  floatRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.08)",
  },
  floatRowLabel: { fontSize: 14, fontWeight: "500", color: "rgba(0,0,0,0.6)" },
  floatRowLabelOn: { fontWeight: "800", color: "#000" },
  floatCheck: {
    fontSize: 14,
    fontWeight: "800",
    color: "#000",
    marginLeft: 8,
    width: 20,
    textAlign: "right",
  },
  floatCheckSpacer: { width: 28 },
  // Filter Badge
  filterBadge: {
    backgroundColor: "#000",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    marginRight: 4,
  },
  filterBadgeText: { fontSize: 10, fontWeight: "900", color: "#FFF" },
  // Filter panel
  filterSectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(0,0,0,0.5)",
    marginBottom: 4,
    paddingHorizontal: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  filterOption: {
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 8,
    marginBottom: 2,
  },
  filterOptionActive: { backgroundColor: "rgba(0,0,0,0.07)" },
  filterOptionText: {
    fontSize: 14,
    fontWeight: "500",
    color: "rgba(0,0,0,0.6)",
  },
  filterOptionTextActive: { fontWeight: "700", color: "#000" },
  filterDivider: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.08)",
    marginVertical: 8,
  },
  cpmColorFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  cpmColorFilterValue: {
    fontSize: 15,
    fontWeight: "600",
    color: "#000",
    marginTop: -4,
  },
  cpmColorFilterIconHit: { padding: 4 },
  colorGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  colorGridTile: {
    width: 36,
    height: 36,
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
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  colorGridDotAll: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.16)",
  },
  colorGridDotAllOn: {
    backgroundColor: "rgba(0,0,0,0.12)",
    borderColor: "rgba(0,0,0,0.3)",
  },
  colorGridDotAllText: {
    fontSize: 11,
    fontWeight: "900",
    color: "rgba(0,0,0,0.42)",
  },
  colorGridDotAllTextOn: { color: "#000" },
});

// ─── PER-SCHEDULE CONFIG MODAL ───────────────────────────────────────────────
function ScheduleConfigModal({
  schedule,
  userId,
  onSave,
  onDelete,
  onClose,
}: {
  schedule: any;
  userId: string;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState({
    ...schedule,
    anchor_item_ids: schedule.anchor_item_ids ?? [],
  });
  const [saving, setSaving] = useState(false);
  const isNew = draft.id?.startsWith("local_");
  // Track if label was auto-generated so we can update it when occasion changes
  const [labelAutoFilled, setLabelAutoFilled] = useState(
    !schedule.label?.trim(),
  );
  const [showClosetPicker, setShowClosetPicker] = useState(false);
  const [viewingAnchorIdx, setViewingAnchorIdx] = useState<number | null>(null);
  // Cached closet items loaded once picker is opened
  const [closetItems, setClosetItems] = useState<any[]>([]);
  const loadClosetItems = useCallback(async () => {
    if (closetItems.length > 0) return;
    const { data } = await supabase
      .from("clothing_items")
      .select(
        "id, image_url, category, type, name, brand, created_at, color, occasions, wear_count",
      )
      .order("created_at", { ascending: false });
    if (data) setClosetItems(data.filter(Boolean));
  }, [closetItems.length]);

  useEffect(() => {
    loadClosetItems();
  }, []);

  const toggleDay = (d: number) => {
    setDraft((prev: any) => {
      const days: number[] = prev.days_of_week ?? [];
      return {
        ...prev,
        days_of_week: days.includes(d)
          ? days.filter((x: number) => x !== d)
          : [...days, d].sort(),
      };
    });
  };

  const adjustHour = (delta: number) => {
    setDraft((prev: any) => ({
      ...prev,
      time_hour: (prev.time_hour + delta + 24) % 24,
    }));
  };

  const adjustMinute = (delta: number) => {
    setDraft((prev: any) => ({
      ...prev,
      time_minute: (prev.time_minute + delta + 60) % 60,
    }));
  };

  const handleSave = async () => {
    if (!draft.label.trim() || !draft.occasion) {
      const { Alert: A } = require("react-native");
      A.alert(
        "Almost there",
        "Give this automation a name and pick an occasion.",
      );
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const { id: _id, ...rest } = draft;
        await supabase.from("autogen_schedules").insert({
          ...rest,
          user_id: userId,
          updated_at: new Date().toISOString(),
        });
      } else {
        await supabase.from("autogen_schedules").upsert({
          ...draft,
          user_id: userId,
          updated_at: new Date().toISOString(),
        });
      }
      onSave();
    } catch (e) {
      const { Alert: A } = require("react-native");
      A.alert("Save failed", String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!isNew)
      await supabase.from("autogen_schedules").delete().eq("id", draft.id);
    onDelete();
  };

  const h = draft.time_hour ?? 8;
  const m = draft.time_minute ?? 0;
  const period = h >= 12 ? "PM" : "AM";
  const hFmt = h % 12 === 0 ? 12 : h % 12;

  return (
    <Modal
      visible
      animationType="fade"
      transparent
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={scm.overlay}>
        <TouchableOpacity
          style={StyleSheet.absoluteFillObject}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={scm.sheet}>
          <View style={scm.handle} />

          {/* Name */}
          <TextInput
            style={scm.nameInput}
            value={draft.label}
            onChangeText={(t) => {
              setLabelAutoFilled(false);
              setDraft((p: any) => ({ ...p, label: t }));
            }}
            placeholder="Automation name…"
            placeholderTextColor="rgba(0,0,0,0.2)"
            maxLength={40}
          />

          {/* Occasion */}
          <Text style={scm.sectionLabel}>Occasion</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={scm.occasionScroll}
          >
            {OCCASIONS_FLAT.map((o) => (
              <TouchableOpacity
                key={o.id}
                style={[
                  scm.occasionChip,
                  draft.occasion === o.id && scm.occasionChipActive,
                ]}
                onPress={() => {
                  setDraft((p: any) => ({
                    ...p,
                    occasion: o.id,
                    label:
                      labelAutoFilled || !p.label.trim()
                        ? `${o.label} OOTD`
                        : p.label,
                  }));
                  if (labelAutoFilled || !draft.label.trim())
                    setLabelAutoFilled(true);
                }}
                activeOpacity={0.75}
              >
                <Text
                  style={[
                    scm.occasionChipText,
                    draft.occasion === o.id && scm.occasionChipTextActive,
                  ]}
                >
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Days */}
          <Text style={scm.sectionLabel}>Days</Text>
          <View style={scm.daysRow}>
            {AG_DAYS.map((d, i) => (
              <TouchableOpacity
                key={i}
                style={[
                  scm.dayDot,
                  (draft.days_of_week ?? []).includes(i) && scm.dayDotActive,
                ]}
                onPress={() => toggleDay(i)}
                activeOpacity={0.75}
              >
                <Text
                  style={[
                    scm.dayDotText,
                    (draft.days_of_week ?? []).includes(i) &&
                      scm.dayDotTextActive,
                  ]}
                >
                  {d}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Time */}
          <Text style={scm.sectionLabel}>Time</Text>
          <View style={scm.timeRow}>
            <View style={scm.timeSpin}>
              <TouchableOpacity
                onPress={() => adjustHour(1)}
                hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
              >
                <Text style={scm.spinArrow}>▲</Text>
              </TouchableOpacity>
              <Text style={scm.timeVal}>
                {hFmt.toString().padStart(2, "0")}
              </Text>
              <TouchableOpacity
                onPress={() => adjustHour(-1)}
                hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
              >
                <Text style={scm.spinArrow}>▼</Text>
              </TouchableOpacity>
            </View>
            <Text style={scm.timeColon}>:</Text>
            <View style={scm.timeSpin}>
              <TouchableOpacity
                onPress={() => adjustMinute(15)}
                hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
              >
                <Text style={scm.spinArrow}>▲</Text>
              </TouchableOpacity>
              <Text style={scm.timeVal}>{m.toString().padStart(2, "0")}</Text>
              <TouchableOpacity
                onPress={() => adjustMinute(-15)}
                hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
              >
                <Text style={scm.spinArrow}>▼</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={scm.ampmBtn}
              onPress={() => adjustHour(h >= 12 ? -12 : 12)}
              activeOpacity={0.75}
            >
              <Text style={scm.ampmText}>{period}</Text>
            </TouchableOpacity>
          </View>

          {/* Always Include */}
          <View style={scm.anchorSection}>
            <Text style={scm.sectionLabel}>Always Include</Text>
            {(draft.anchor_item_ids ?? []).length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={scm.anchorRow}
                style={scm.anchorScroll}
              >
                {(draft.anchor_item_ids ?? []).map((id: string) => {
                  const item = closetItems.find((c) => c.id === id);
                  return (
                    <TouchableOpacity
                      key={id}
                      style={scm.anchorThumb}
                      onPress={() =>
                        setViewingAnchorIdx(
                          (draft.anchor_item_ids ?? []).indexOf(id),
                        )
                      }
                      activeOpacity={0.75}
                    >
                      {item?.image_url ? (
                        <Image
                          source={{ uri: item.image_url }}
                          style={scm.anchorImg}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={scm.anchorImgPlaceholder} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              style={scm.anchorAddBtn}
              activeOpacity={0.8}
              onPress={() => {
                loadClosetItems();
                setShowClosetPicker(true);
              }}
            >
              <Text style={scm.anchorAddText}>
                {(draft.anchor_item_ids ?? []).length > 0
                  ? "Edit pinned items"
                  : "+ Add items from closet"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Actions */}
          <View style={scm.actions}>
            {!isNew && (
              <TouchableOpacity
                style={scm.deleteBtn}
                onPress={handleDelete}
                activeOpacity={0.8}
              >
                <Text style={scm.deleteBtnText}>Delete</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={scm.saveBtn}
              onPress={handleSave}
              disabled={saving}
              activeOpacity={0.8}
            >
              <Text style={scm.saveBtnText}>
                {saving ? "Saving…" : isNew ? "Add" : "Save"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {showClosetPicker && (
          <ClosetPickerModal
            items={closetItems}
            selected={draft.anchor_item_ids ?? []}
            onToggle={(id: string) =>
              setDraft((p: any) => {
                const ids: string[] = p.anchor_item_ids ?? [];
                return {
                  ...p,
                  anchor_item_ids: ids.includes(id)
                    ? ids.filter((x) => x !== id)
                    : [...ids, id],
                };
              })
            }
            onClose={() => setShowClosetPicker(false)}
          />
        )}

        {/* Fullscreen image viewer */}
        {viewingAnchorIdx !== null &&
          (draft.anchor_item_ids ?? []).length > 0 && (
            <Modal
              transparent
              visible
              animationType="fade"
              onRequestClose={() => setViewingAnchorIdx(null)}
            >
              <TouchableOpacity
                style={scm.imgViewerOverlay}
                activeOpacity={1}
                onPress={() => setViewingAnchorIdx(null)}
              >
                <TouchableOpacity
                  style={scm.imgViewerContent}
                  activeOpacity={1}
                  onPress={() => {}}
                >
                  <Image
                    source={{
                      uri: closetItems.find(
                        (c) =>
                          c.id ===
                          (draft.anchor_item_ids ?? [])[viewingAnchorIdx],
                      )?.image_url,
                    }}
                    style={scm.imgViewerImage}
                    resizeMode="contain"
                  />
                  <TouchableOpacity
                    style={scm.imgViewerEditBtn}
                    onPress={() => {
                      setViewingAnchorIdx(null);
                      setShowClosetPicker(true);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={scm.imgViewerEditText}>
                      Edit Always Include
                    </Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              </TouchableOpacity>
            </Modal>
          )}
      </View>
    </Modal>
  );
}

const scm = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingBottom: 40,
    paddingTop: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    maxHeight: "92%",
    gap: 16,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.15)",
    alignSelf: "center",
    marginBottom: 4,
  },
  nameInput: {
    fontSize: 20,
    fontWeight: "700",
    color: "#000",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.1)",
    paddingBottom: 10,
    letterSpacing: -0.4,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "800",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: -8,
  },
  occasionScroll: { paddingHorizontal: 2, alignItems: "flex-start" },
  occasionChip: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    marginRight: 8,
    alignSelf: "flex-start",
  },
  occasionChipActive: {
    backgroundColor: "#000",
    borderColor: "#000",
  },
  occasionChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "rgba(0,0,0,0.5)",
  },
  occasionChipTextActive: { color: "#FFF", fontWeight: "700" },
  daysRow: { flexDirection: "row", justifyContent: "space-between" },
  dayDot: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  dayDotActive: { backgroundColor: "#000", borderColor: "#000" },
  dayDotText: { fontSize: 12, fontWeight: "700", color: "rgba(0,0,0,0.4)" },
  dayDotTextActive: { color: "#FFF" },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  timeSpin: { alignItems: "center", gap: 6 },
  spinArrow: { fontSize: 10, color: "rgba(0,0,0,0.3)", fontWeight: "700" },
  timeVal: {
    fontSize: 32,
    fontWeight: "800",
    color: "#000",
    letterSpacing: -1,
    minWidth: 52,
    textAlign: "center",
  },
  timeColon: {
    fontSize: 28,
    fontWeight: "800",
    color: "rgba(0,0,0,0.3)",
    marginBottom: 4,
  },
  ampmBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.06)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    marginLeft: 4,
  },
  ampmText: { fontSize: 15, fontWeight: "800", color: "#000" },
  anchorSection: { gap: 8 },
  anchorScroll: { marginTop: 4 },
  anchorRow: { flexDirection: "row", gap: 8 },
  anchorThumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#000",
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  anchorImg: { width: "100%", height: "100%" },
  anchorImgPlaceholder: { flex: 1, backgroundColor: "rgba(0,0,0,0.06)" },
  anchorRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  anchorRemoveText: { fontSize: 8, color: "#FFF", fontWeight: "800" },
  anchorAddBtn: {
    width: "100%",
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.12)",
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.02)",
  },
  anchorAddText: { fontSize: 14, fontWeight: "700", color: "rgba(0,0,0,0.4)" },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  deleteBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: "rgba(255,59,48,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,59,48,0.15)",
    alignItems: "center",
  },
  deleteBtnText: { fontSize: 14, fontWeight: "700", color: Colors.red },
  saveBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: "#000",
    alignItems: "center",
  },
  saveBtnText: { fontSize: 14, fontWeight: "800", color: "#FFF" },
  imgViewerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  imgViewerContent: {
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  imgViewerImage: {
    width: 300,
    height: 400,
    borderRadius: 12,
  },
  imgViewerEditBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#000",
    borderRadius: 12,
    alignItems: "center",
  },
  imgViewerEditText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFF",
  },
});

export default function HomeScreen() {
  const { user } = useUser();
  const userName = user?.firstName || "there";

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    if (hour < 21) return "Good evening";
    return "Good night";
  }, []);

  const isNight = useMemo(() => {
    const hour = new Date().getHours();
    return hour >= 19 || hour < 6;
  }, []);

  const router = useRouter();
  const [recommendation, setRecommendation] = useState<any>(null);
  const [weather, setWeather] = useState<any>(null);
  const [humidity, setHumidity] = useState<number | null>(null);
  const [locationName, setLocationName] = useState("Detecting...");
  const [isLocationModalVisible, setLocationModalVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [tempUnit, setTempUnit] = useState("fahrenheit");
  const [viewDate] = useState(new Date());

  const [hasAutoGenEnabled, setHasAutoGenEnabled] = useState(false);
  const [autoGenSchedules, setAutoGenSchedules] = useState<any[]>([]);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [agPage, setAgPage] = useState(0);
  const agScrollRef = useRef<any>(null);
  const agScrollX = useRef(new Animated.Value(0)).current;
  const [configSchedule, setConfigSchedule] = useState<any | null>(null);
  const { openAutomation } = useLocalSearchParams<{
    openAutomation?: string;
  }>();
  const didHandleAutomation = useRef(false);
  const openAutomationConfigurator = useCallback(() => {
    didHandleAutomation.current = true;
    agScrollRef.current?.scrollTo({ x: 0, animated: true });
    setAgPage(0);
    setConfigSchedule(createBlankSchedule());
  }, []);
  useEffect(() => {
    if (openAutomation) openAutomationConfigurator();
  }, [openAutomation]);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      "openAutomation",
      openAutomationConfigurator,
    );
    return () => sub.remove();
  }, [openAutomationConfigurator]);

  const fetchSchedules = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from("autogen_schedules")
      .select(
        "id, label, occasion, time_hour, time_minute, days_of_week, is_active, last_generated_at, last_generated_outfit_id, anchor_item_ids",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (data) {
      setAutoGenSchedules(data);
      setHasAutoGenEnabled(data.some((s: any) => s.is_active));

      // Auto-scroll to the schedule closest in time to generating
      if (data.length > 0) {
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        const todayDay = now.getDay(); // 0=Sun

        const minutesUntil = (s: any): number => {
          const days: number[] = s.days_of_week ?? [];
          const sMins = (s.time_hour ?? 8) * 60 + (s.time_minute ?? 0);
          // Find closest future occurrence across the week
          let best = Infinity;
          for (let delta = 0; delta < 7; delta++) {
            const checkDay = (todayDay + delta) % 7;
            if (!days.includes(checkDay)) continue;
            const totalMins = delta * 1440 + sMins - nowMins;
            const adjusted = totalMins <= 0 ? totalMins + 7 * 1440 : totalMins;
            if (adjusted < best) best = adjusted;
          }
          return best;
        };

        let closestIdx = 0;
        let closestMins = Infinity;
        data.forEach((s: any, i: number) => {
          if (!s.is_active) return;
          const m = minutesUntil(s);
          if (m < closestMins) {
            closestMins = m;
            closestIdx = i;
          }
        });

        // Card 0 is overview, schedule cards start at index 1
        // Skip auto-scroll if openAutomation nav is pending
        if (!didHandleAutomation.current) {
          setTimeout(() => {
            agScrollRef.current?.scrollTo({
              x: (closestIdx + 1) * AG_SNAP,
              animated: false,
            });
            setAgPage(closestIdx + 1);
          }, 50);
        }
      }
    }
    setSchedulesLoaded(true);
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      fetchSchedules();
    }, [fetchSchedules]),
  );

  const toggleScheduleActive = async (id: string) => {
    const updated = autoGenSchedules.map((s) =>
      s.id === id ? { ...s, is_active: !s.is_active } : s,
    );
    setAutoGenSchedules(updated);
    setHasAutoGenEnabled(updated.some((s) => s.is_active));
    const target = updated.find((s) => s.id === id);
    if (target) {
      await supabase
        .from("autogen_schedules")
        .update({ is_active: target.is_active })
        .eq("id", id);
    }
  };
  const [weekOutfits, setWeekOutfits] = useState<
    Record<string, { image_url: string } | null>
  >({});

  // Determine system unit properly
  useEffect(() => {
    // Localization.isMetric is often more reliable, but getCalendars is also good context
    const isMetric =
      Localization.getLocales()[0]?.measurementSystem === "metric";
    setTempUnit(isMetric ? "celsius" : "fahrenheit");
  }, []);
  const [searchTimer, setSearchTimer] = useState<any>(null);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (searchTimer) clearTimeout(searchTimer);

    if (query.trim().length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    // Debounce to prevent rapid fire API calls/jank
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

  const fetchWeather = async (lat: number, lon: number, name?: string) => {
    try {
      const unit =
        Localization.getLocales()[0]?.measurementSystem === "metric"
          ? "celsius"
          : "fahrenheit";
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min&hourly=relative_humidity_2m&temperature_unit=${unit}&forecast_days=1&timezone=auto`,
      );
      const wData = await res.json();
      setWeather(wData);
      // Take the current hour's humidity
      const currentHour = new Date().getHours();
      if (wData.hourly?.relative_humidity_2m) {
        setHumidity(wData.hourly.relative_humidity_2m[currentHour] ?? null);
      }

      if (name) {
        setLocationName(name);
      } else {
        const address = await Location.reverseGeocodeAsync({
          latitude: lat,
          longitude: lon,
        });
        if (address && address[0]) {
          setLocationName(
            address[0].city || address[0].name || "Current Location",
          );
        }
      }
    } catch (e) {
      console.error("Weather fetch failed", e);
    }
  };

  const selectCity = (city: any) => {
    // Close first to make it feel immediate
    setLocationModalVisible(false);
    setSearchQuery("");
    setSearchResults([]);
    setIsSearching(false);

    // Background fetch
    fetchWeather(city.latitude, city.longitude, city.name);
  };

  const handleLocationSearch = async () => {
    if (searchResults.length > 0) {
      selectCity(searchResults[0]);
    }
  };

  useEffect(() => {
    async function loadData() {
      const { data } = await supabase
        .from("outfits")
        .select("id, outfit_items(clothing_item_id)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data)
        setRecommendation({
          item_ids: (data.outfit_items || []).map(
            (oi: any) => oi.clothing_item_id,
          ),
        });

      // Load this week's outfit thumbnails via junction table
      const today = new Date();
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const { data: weekData } = await supabase
        .from("outfits")
        .select("worn_on, outfit_items(clothing_item_id, layer_order)")
        .gte("worn_on", fmt(weekStart))
        .lte("worn_on", fmt(weekEnd));
      if (weekData && weekData.length > 0) {
        const firstItemIds = weekData
          .map(
            (o: any) =>
              [...(o.outfit_items || [])].sort(
                (a: any, b: any) => a.layer_order - b.layer_order,
              )[0]?.clothing_item_id,
          )
          .filter(Boolean);
        if (firstItemIds.length > 0) {
          const { data: wItems } = await supabase
            .from("clothing_items")
            .select("id, image_url")
            .in("id", firstItemIds);
          const itemMap = Object.fromEntries(
            (wItems || []).map((i: any) => [i.id, i]),
          );
          const map: Record<string, { image_url: string } | null> = {};
          weekData.forEach((o: any) => {
            if (o.worn_on) {
              const firstId = [...(o.outfit_items || [])].sort(
                (a: any, b: any) => a.layer_order - b.layer_order,
              )[0]?.clothing_item_id;
              map[o.worn_on] = firstId ? itemMap[firstId] || null : null;
            }
          });
          setWeekOutfits(map);
        }
      }

      await fetchSchedules();

      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const loc = await Location.getCurrentPositionAsync({});
          await fetchWeather(loc.coords.latitude, loc.coords.longitude);
        } else {
          await fetchWeather(40.7128, -74.006);
        }
      } catch (e) {
        console.error("Weather/Location failed", e);
      }
    }
    loadData();
  }, []);

  const getWeatherInfo = (
    code: number,
    isNight: boolean = false,
    temp: number = 0,
    wind: number = 0,
  ) => {
    if (temp > 88)
      return {
        label: "Extremely Hot",
        highlight: "Dangerously high heat. Stay hydrated.",
        type: "heat",
      };
    if (wind > 18)
      return {
        label: "Very Windy",
        highlight: "Strong gusts expected today.",
        type: "windy",
      };

    if (code === 0)
      return {
        label: isNight ? "Clear Night" : "Sunny",
        highlight: isNight
          ? "Beautiful clear skies tonight."
          : "Beautiful clear skies all day.",
        type: "sun",
      };
    if (code <= 3)
      return {
        label: isNight ? "Partly Cloudy" : "Mostly Sunny",
        highlight: isNight
          ? "A few clouds drifting tonight."
          : "Mostly sunny with some clouds.",
        type: "suncloud",
      };
    if (code >= 45 && code <= 48)
      return {
        label: "Foggy",
        highlight: "Expect some fog throughout the day.",
        type: "cloud",
      };
    if (code >= 51 && code <= 67)
      return {
        label: "Raining",
        highlight: "Expect rain showers today.",
        type: "rain",
      };
    if (code >= 71 && code <= 77)
      return {
        label: "Snowy",
        highlight: "Expect some snow today.",
        type: "snow",
      };
    if (code >= 80 && code <= 82)
      return {
        label: "Showers",
        highlight: "Beautiful rainbows may appear!",
        type: "rainbow",
      };
    if (code >= 85 && code <= 86)
      return {
        label: "Snow Showers",
        highlight: "Expect snow showers today.",
        type: "snow",
      };
    if (code >= 95 && code <= 99)
      return {
        label: "Stormy",
        highlight: "Thunderstorms expected today.",
        type: "storm",
      };
    return {
      label: "Cloudy",
      highlight: "Overcast skies for most of the day.",
      type: "cloud",
    };
  };

  const getStylingHint = (temp: number, wind: number = 0) => {
    const isC = tempUnit === "celsius";
    // Logic thresholds normalized (F equivalents)
    const hotThreshold = isC ? 31 : 88;
    const mildThreshold = isC ? 16 : 60;
    const freezingThreshold = isC ? 0 : 32;

    if (temp > hotThreshold)
      return "Extreme heat: Wear very light, loose fabrics";
    if (wind > 18) return "Heavy winds: A windbreaker is advised";
    if (temp > mildThreshold) return "Mild: Perfect for a light layer";
    if (temp < freezingThreshold) return "Freezing: Heavy winter gear required";
    return "Chilly: Layer up for the cold";
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  const weatherInfo = weather
    ? getWeatherInfo(
        weather.current_weather.weathercode,
        isNight,
        weather.current_weather.temperature,
        weather.current_weather.windspeed,
      )
    : null;

  return (
    <View style={styles.container}>
      {/* Schedule config modal */}
      {configSchedule && (
        <ScheduleConfigModal
          schedule={configSchedule}
          userId={user?.id ?? ""}
          onSave={() => {
            setConfigSchedule(null);
            fetchSchedules();
          }}
          onDelete={() => {
            setConfigSchedule(null);
            fetchSchedules();
          }}
          onClose={() => setConfigSchedule(null)}
        />
      )}

      {/* 0. LOCATION SEARCH MODAL */}
      <Modal
        visible={isLocationModalVisible}
        transparent
        animationType="slide" // Slide up from bottom
        onRequestClose={() => setLocationModalVisible(false)}
      >
        <BlurView
          intensity={100}
          tint="light"
          style={StyleSheet.absoluteFillObject}
        >
          <View style={styles.modalContentStyleWeather}>
            <View style={styles.modalDragHandle} />

            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitleLarge}>Location</Text>
              <TouchableOpacity
                style={styles.closeSearchBtnSmall}
                onPress={() => setLocationModalVisible(false)}
              >
                <Text style={styles.closeSearchBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.searchBarContainer}>
              <TextInput
                style={styles.locationInputModern}
                placeholder="Enter city name..."
                placeholderTextColor="rgba(0,0,0,0.3)"
                value={searchQuery}
                onChangeText={handleSearchChange}
                onSubmitEditing={handleLocationSearch}
                autoFocus
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
              />
            </View>

            <ScrollView
              style={styles.resultsList}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {isSearching && (
                <View style={styles.searchingLoader}>
                  <ActivityIndicator color="#000" />
                  <Text style={styles.searchingText}>Searching cities...</Text>
                </View>
              )}

              {!isSearching &&
                searchResults.map((city, idx) => (
                  <TouchableOpacity
                    key={city.id || idx}
                    style={styles.resultItem}
                    onPress={() => selectCity(city)}
                  >
                    <View>
                      <Text style={styles.resultCityName}>{city.name}</Text>
                      <Text style={styles.resultDetails}>
                        {city.admin1}
                        {city.admin1 ? ", " : ""}
                        {city.country}
                      </Text>
                    </View>
                    <Svg width={12} height={12} viewBox="0 0 24 24">
                      <Path
                        d="M9 5L16 12L9 19"
                        stroke="rgba(0,0,0,0.4)"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </Svg>
                  </TouchableOpacity>
                ))}
            </ScrollView>
          </View>
        </BlurView>
      </Modal>
      {/* TOP BAR — greeting + location */}
      <View style={styles.staticHeaderContainer}>
        <Reanimated.View entering={FadeInUp.delay(100)} style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.greetingSmall}>{greeting}</Text>
            <Text style={styles.greetingName}>{userName}</Text>
          </View>
          <TouchableOpacity
            style={styles.locationPill}
            onPress={() => setLocationModalVisible(true)}
            activeOpacity={0.7}
          >
            <Svg width={10} height={10} viewBox="0 0 24 24" fill="none">
              <Path
                d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"
                fill="rgba(0,0,0,0.4)"
              />
            </Svg>
            <Text style={styles.locationPillText} numberOfLines={1}>
              {locationName}
            </Text>
          </TouchableOpacity>
        </Reanimated.View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        bounces={false}
        alwaysBounceVertical={false}
      >
        {/* ── WEATHER CARD ── */}
        <Reanimated.View
          entering={FadeInDown.delay(100).duration(600)}
          style={styles.weatherCard}
        >
          {weather && weatherInfo ? (
            <>
              {/* Main row: temp + icon */}
              <View style={styles.weatherMainRow}>
                <View style={styles.weatherTempCol}>
                  <Text style={styles.weatherTemp}>
                    {Math.round(weather.current_weather.temperature)}°
                  </Text>
                  <Text style={styles.weatherDesc}>{weatherInfo.label}</Text>
                  <View style={styles.weatherHLRow}>
                    <Text style={styles.weatherHL}>
                      H: {Math.round(weather.daily.temperature_2m_max[0])}°
                    </Text>
                    <Text style={styles.weatherHLDivider}>·</Text>
                    <Text style={styles.weatherHL}>
                      L: {Math.round(weather.daily.temperature_2m_min[0])}°
                    </Text>
                  </View>
                </View>
                <View style={styles.weatherIconWrap}>
                  <WeatherIcon
                    type={weatherInfo.type}
                    size={100}
                    isNight={isNight}
                    compact
                  />
                </View>
              </View>

              {/* Divider */}
              <View style={styles.weatherDivider} />

              {/* Stats + tip row */}
              <View style={styles.weatherStatsRow}>
                {humidity !== null && (
                  <View style={styles.weatherStat}>
                    <Text style={styles.weatherStatValue}>{humidity}%</Text>
                    <Text style={styles.weatherStatLabel}>Humidity</Text>
                  </View>
                )}
                <View style={styles.weatherStat}>
                  <Text style={styles.weatherStatValue}>
                    {Math.round(weather.current_weather.windspeed)} mph
                  </Text>
                  <Text style={styles.weatherStatLabel}>Wind</Text>
                </View>
                <View
                  style={[
                    styles.weatherStat,
                    { flex: 1, alignItems: "flex-end" },
                  ]}
                >
                  <Text style={styles.weatherTip} numberOfLines={2}>
                    {getStylingHint(
                      weather.current_weather.temperature,
                      weather.current_weather.windspeed,
                    )}
                  </Text>
                </View>
              </View>
            </>
          ) : (
            <View
              style={{
                height: 120,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ActivityIndicator color="rgba(0,0,0,0.3)" />
            </View>
          )}
        </Reanimated.View>

        {/* ── YOUR OOTDs SECTION ── */}
        <Reanimated.View
          entering={FadeInDown.delay(200).duration(800)}
          style={styles.agSection}
        >
          {/* Unified carousel — overview card always first, then schedule cards */}
          <Animated.ScrollView
            ref={agScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={AG_SNAP}
            snapToAlignment="start"
            style={{ marginHorizontal: -16 }}
            contentContainerStyle={{
              paddingLeft: 16,
              paddingRight: 8,
              gap: 12,
            }}
            scrollEventThrottle={16}
            bounces={false}
            alwaysBounceHorizontal={false}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { x: agScrollX } } }],
              {
                useNativeDriver: false,
                listener: (e: any) =>
                  setAgPage(
                    Math.round(e.nativeEvent.contentOffset.x / AG_SNAP),
                  ),
              },
            )}
          >
            {/* Card 0: Overview */}
            <View style={[styles.agOnboardCard, { width: AG_CARD_W }]}>
              {/* Card Header */}
              {/* Card Header */}
              <View style={styles.agCardHeader}>
                <Text style={styles.agCardHeaderTitle}>Auto OOTDs</Text>
                {hasAutoGenEnabled && (
                  <View style={styles.agActiveBadge}>
                    <View style={styles.agActiveDot} />
                    <Text style={styles.agActiveBadgeText}>
                      {autoGenSchedules.filter((s) => s.is_active).length}{" "}
                      active
                    </Text>
                  </View>
                )}
              </View>

              {/* Card Content Row */}
              <View style={{ flex: 1, flexDirection: "row" }}>
                <View style={styles.agOnboardLeft}>
                  <View style={{ gap: 4 }}>
                    <Text style={styles.agOnboardHeadline}>
                      Your fits.{"\n"}On autopilot.
                    </Text>
                    <Text style={styles.agOnboardSub}>
                      Set a schedule, define your style — wake up dressed.
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.agOnboardBtn}
                    onPress={() => setConfigSchedule(createBlankSchedule())}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.agOnboardBtnText}>+ Add New</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.agOnboardRight}>
                  {autoGenSchedules.length === 0 ? (
                    <View style={styles.agMiniEmpty}>
                      <Text style={styles.agMiniEmptyText}>
                        No schedules yet
                      </Text>
                    </View>
                  ) : (
                    <ScrollView
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={styles.agMiniList}
                    >
                      {autoGenSchedules.map((s, idx) => {
                        const occ = OCCASION_MAP[s.occasion];
                        const h = s.time_hour ?? 8;
                        const period = h >= 12 ? "PM" : "AM";
                        const hFmt = h % 12 === 0 ? 12 : h % 12;
                        const timeStr = `${hFmt}:${(s.time_minute ?? 0).toString().padStart(2, "0")} ${period}`;
                        return (
                          <View key={s.id} style={styles.agMiniCard}>
                            <TouchableOpacity
                              style={[
                                styles.agToggle,
                                s.is_active && styles.agToggleOn,
                              ]}
                              onPress={() => toggleScheduleActive(s.id)}
                              activeOpacity={0.8}
                              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            >
                              <View
                                style={[
                                  styles.agToggleThumb,
                                  s.is_active && styles.agToggleThumbOn,
                                ]}
                              />
                            </TouchableOpacity>
                            <View style={styles.agMiniInfo}>
                              <Text
                                style={[
                                  styles.agMiniName,
                                  !s.is_active && styles.agQuickNameOff,
                                ]}
                                numberOfLines={1}
                              >
                                {s.label || "Untitled"}
                              </Text>
                              <Text style={styles.agMiniSub} numberOfLines={1}>
                                {occ ? occ.label : s.occasion} · {timeStr}
                              </Text>
                            </View>
                            <TouchableOpacity
                              style={styles.agMiniJump}
                              activeOpacity={0.7}
                              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                              onPress={() => {
                                agScrollRef.current?.scrollTo({
                                  x: (idx + 1) * AG_SNAP,
                                  animated: true,
                                });
                                setAgPage(idx + 1);
                              }}
                            >
                              <Svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <Path
                                  d="M9 18l6-6-6-6"
                                  stroke="rgba(0,0,0,0.4)"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </Svg>
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
              </View>
            </View>

            {/* Cards 1+: individual schedule cards */}
            {autoGenSchedules.map((s) => (
              <ScheduleCard
                key={s.id}
                schedule={s}
                cardWidth={AG_CARD_W}
                onEdit={() => setConfigSchedule({ ...s })}
                onView={() => router.push("/fits")}
                onGenerate={() => router.push("/fits")}
              />
            ))}
          </Animated.ScrollView>

          {/* Dots — animated interpolation from scroll position */}
          {autoGenSchedules.length > 0 && (
            <View style={styles.agDots}>
              {[null, ...autoGenSchedules].map((_, i) => {
                const dotWidth = agScrollX.interpolate({
                  inputRange: [
                    (i - 1) * AG_SNAP,
                    i * AG_SNAP,
                    (i + 1) * AG_SNAP,
                  ],
                  outputRange: [5, 16, 5],
                  extrapolate: "clamp",
                });
                const dotOpacity = agScrollX.interpolate({
                  inputRange: [
                    (i - 1) * AG_SNAP,
                    i * AG_SNAP,
                    (i + 1) * AG_SNAP,
                  ],
                  outputRange: [0.25, 1, 0.25],
                  extrapolate: "clamp",
                });
                return (
                  <Animated.View
                    key={i}
                    style={[
                      styles.agDot,
                      { width: dotWidth, opacity: dotOpacity },
                    ]}
                  />
                );
              })}
            </View>
          )}
        </Reanimated.View>

        {/* 4. THIS WEEK SECTION */}
        <Reanimated.View
          entering={FadeInDown.delay(350)}
          style={styles.weekSection}
        >
          <Text style={styles.sectionLabel}>OOTD's This Week</Text>
          <View style={styles.weekGrid}>
            {["M", "T", "W", "T", "F", "S", "S"].map((dayChar, i) => {
              const day = new Date(viewDate);
              day.setDate(
                viewDate.getDate() - ((viewDate.getDay() + 6) % 7) + i,
              );
              const isActive = isToday(day);
              const dayDate = new Date(viewDate);
              dayDate.setDate(
                viewDate.getDate() - ((viewDate.getDay() + 6) % 7) + i,
              );
              const dayKey = dayDate.toISOString().split("T")[0];
              const dayOutfit = weekOutfits[dayKey];
              const dateNum = dayDate.getDate();
              return (
                <TouchableOpacity
                  key={i}
                  style={styles.dayCard}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      styles.dayHeaderPill,
                      isActive && styles.dayHeaderPillActive,
                    ]}
                  >
                    <Text
                      style={[styles.dayChar, isActive && styles.dayCharActive]}
                    >
                      {dayChar}
                    </Text>
                    <Text
                      style={[
                        styles.dayDateNum,
                        isActive && styles.dayDateNumActive,
                      ]}
                    >
                      {dateNum}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.dayImgFrame,
                      isActive && styles.dayImgFrameActive,
                    ]}
                  >
                    {dayOutfit?.image_url ? (
                      <Image
                        source={{ uri: dayOutfit.image_url }}
                        style={styles.dayImg}
                        resizeMode="contain"
                      />
                    ) : (
                      <View style={styles.emptyDayIcon} />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </Reanimated.View>
        {/* END DASHBOARD */}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scroll: {
    paddingTop: 4,
    paddingHorizontal: 16,
    paddingBottom: 130,
  },
  staticHeaderContainer: {
    paddingTop: 62,
    paddingHorizontal: 16,
    paddingBottom: 4,
    backgroundColor: Colors.bg,
    zIndex: 100,
  },

  // HEADER
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  headerLeft: { gap: 2 },
  greetingSmall: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(0,0,0,0.4)",
    letterSpacing: 0.1,
  },
  greetingName: {
    fontSize: 26,
    fontWeight: "800",
    color: "#000",
    letterSpacing: -0.9,
  },

  locationPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: 140,
  },
  locationPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(0,0,0,0.5)",
  },

  // WEATHER CARD
  weatherCard: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 18,
  },
  weatherMainRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  weatherTempCol: { gap: 1, flex: 1 },
  weatherTemp: {
    fontSize: 40,
    fontWeight: "900",
    color: "#000",
    letterSpacing: -2,
    lineHeight: 40,
  },
  weatherDesc: {
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(0,0,0,0.45)",
    marginTop: 3,
  },
  weatherHLRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 2,
  },
  weatherHL: {
    fontSize: 11,
    fontWeight: "700",
    color: "rgba(0,0,0,0.3)",
  },
  weatherHLDivider: {
    fontSize: 11,
    color: "rgba(0,0,0,0.15)",
  },
  weatherIconWrap: {
    width: 100,
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  weatherDivider: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.07)",
    marginBottom: 8,
  },
  weatherStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  weatherStat: { gap: 1 },
  weatherStatValue: {
    fontSize: 12,
    fontWeight: "800",
    color: "#000",
  },
  weatherStatLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "rgba(0,0,0,0.3)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  weatherTip: {
    fontSize: 10,
    fontWeight: "600",
    color: "rgba(0,0,0,0.4)",
    textAlign: "right",
    lineHeight: 14,
  },

  quickActionsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 24,
  },
  quickActionsContainer: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 24,
  },
  quickActionCard: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
  },
  qaIconCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  qaLabel: {
    fontSize: 10.5,
    fontWeight: "900",
    color: "#000",
    letterSpacing: -0.3,
  },
  labSubTitle: {
    fontSize: 9,
    fontWeight: "900",
    color: "rgba(0,0,0,0.2)",
    letterSpacing: 2,
    marginBottom: 0,
  },
  // CONFIG VIEW STYLES
  configContainer: {
    flex: 1,
    justifyContent: "space-between",
  },
  configHeader: {
    gap: 2,
  },
  configSubtitle: {
    fontSize: 9,
    fontWeight: "900",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 2,
  },
  configTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#000",
    letterSpacing: -0.5,
  },
  configMainStack: {
    gap: 12,
    marginTop: 8,
  },
  configRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  configLabel: {
    fontSize: 8,
    fontWeight: "900",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 0.5,
  },
  configTabStrip: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.06)",
    padding: 2,
    borderRadius: 8,
    gap: 2,
  },
  configTab: {
    width: 24,
    height: 20,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  configTabActive: {
    backgroundColor: "#000",
  },
  configTabText: {
    fontSize: 9,
    fontWeight: "800",
    color: "rgba(0,0,0,0.4)",
  },
  configTabTextActive: {
    color: "#FFF",
  },
  configValueTrigger: {
    backgroundColor: "rgba(0,0,0,0.04)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.04)",
  },
  configValueText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#000",
  },
  ootdViewportImg: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
    opacity: 0.9,
  },
  ootdHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  ootdTitle: {
    fontSize: 12,
    fontWeight: "900",
    color: "rgba(0,0,0,0.6)",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  ootdTimeTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "rgba(0,0,0,0.2)",
    textTransform: "uppercase",
  },
  ootdClockBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.04)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    gap: 8,
  },
  ootdClockBtnLabel: {
    fontSize: 10,
    fontWeight: "900",
    color: "rgba(0,0,0,0.4)",
    letterSpacing: 1,
  },
  ootdResultsStack: {
    gap: 8,
  },
  ootdDescriptionLarge: {
    fontSize: 16,
    fontWeight: "700",
    color: "#000",
    lineHeight: 22,
  },
  ootdActionCluster: {
    flexDirection: "row",
    gap: 8,
  },
  pillActionBtn: {
    backgroundColor: "rgba(0,0,0,0.04)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.04)",
  },
  pillActionBtnText: {
    color: "rgba(0,0,0,0.6)",
    fontSize: 11,
    fontWeight: "700",
  },
  ootdConfirmBtn: {
    backgroundColor: "rgba(0,0,0,0.06)",
    height: 44,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  ootdConfirmBtnText: {
    color: "#000",
    fontWeight: "800",
    fontSize: 13,
  },
  heroContentTop: {
    gap: 6,
  },
  heroTitleSmall: {
    fontSize: 12,
    fontWeight: "800",
    color: "#000",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  heroOutfitDescSide: {
    fontSize: 14,
    fontWeight: "600",
    color: "rgba(0,0,0,0.4)",
    lineHeight: 20,
  },
  heroActionStack: {
    gap: 12,
  },
  heroActionBtn: {
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FFF",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
  },
  heroActionSubRow: {
    flexDirection: "row",
    gap: 10,
  },
  heroActionBtnSmall: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.04)",
  },
  heroActionBtnTextWhite: {
    color: "#000",
    fontSize: 14,
    fontWeight: "700",
  },
  heroActionBtnTextDark: {
    color: "rgba(0,0,0,0.6)",
    fontSize: 12,
    fontWeight: "600",
  },

  // SHARED SECTION LABEL
  sectionLabel: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "rgba(0,0,0,0.3)",
    marginBottom: 14,
  },

  // THIS WEEK SECTION
  weekSection: {
    marginBottom: 24,
  },
  weekGrid: {
    flexDirection: "row",
    gap: 4,
  },
  dayCard: {
    alignItems: "center",
    gap: 5,
    flex: 1,
    minWidth: 0,
  },
  dayHeaderPill: {
    alignSelf: "stretch",
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  dayHeaderPillActive: { backgroundColor: "#000000", borderColor: "#000000" },
  dayChar: {
    fontSize: 10,
    fontWeight: "800",
    color: "rgba(0,0,0,0.3)",
    letterSpacing: 0.5,
    lineHeight: 12,
  },
  dayCharActive: { color: "#FFFFFF" },
  dayDateNum: {
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(0,0,0,0.5)",
    lineHeight: 14,
  },
  dayDateNumActive: { color: "#FFFFFF", fontWeight: "900" },
  dayImgFrame: {
    alignSelf: "stretch",
    aspectRatio: 1 / 2.2,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  },
  dayImgFrameActive: {
    borderColor: "rgba(0,0,0,0.2)",
    borderWidth: 1.5,
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  dayImg: {
    width: "100%",
    height: "100%",
    resizeMode: "contain",
  },
  emptyDayIcon: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(0,0,0,0.1)",
  },

  // SECTION GENERAL
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#000",
    marginBottom: 16,
    letterSpacing: -0.4,
  },
  galleryRow: {
    gap: 16,
    paddingHorizontal: 2,
  },

  // CONTEXT GENERATOR CARDS
  contextCard: {
    width: 170,
    height: 120,
    borderRadius: 24,
    padding: 18,
    justifyContent: "space-between",
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
    backgroundColor: "rgba(0,0,0,0.03)",
  },
  contextHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  contextEmoji: {
    fontSize: 20,
  },
  contextTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#000",
  },
  contextActionBtn: {
    backgroundColor: "#FFF",
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  contextActionText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#000",
  },

  // SAVED OUTFITS CARDS
  savedOutfitCard: {
    width: 160,
    aspectRatio: 0.75,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 24,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
  },
  savedImg: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },
  badgePill: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#FFF",
  },

  // RECENTLY ADDED CARDS
  recentCard: {
    width: 140,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 24,
    padding: 10,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
  },
  recentImg: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.04)",
  },
  recentTextContainer: {
    paddingVertical: 12,
    alignItems: "center",
  },
  modalContentStyleWeather: {
    flex: 1,
    paddingTop: 60,
    paddingHorizontal: 20,
    backgroundColor: Colors.bg,
  },
  modalDragHandle: {
    width: 40,
    height: 5,
    backgroundColor: "rgba(0,0,0,0.2)",
    borderRadius: 3,
    alignSelf: "center",
    marginBottom: 20,
  },
  modalHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  closeSearchBtnSmall: {
    padding: 8,
  },
  modalTitleLarge: {
    fontSize: 34,
    fontWeight: "900",
    color: "#000",
    letterSpacing: -1,
  },
  searchBarContainer: {
    backgroundColor: "rgba(0,0,0,0.06)",
    borderRadius: 14,
    marginBottom: 20,
  },
  locationInputModern: {
    height: 44,
    paddingHorizontal: 16,
    color: "#000",
    fontSize: 17,
  },
  resultsList: {
    flex: 1,
  },
  resultItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(0,0,0,0.08)",
  },
  resultCityName: {
    color: "#000",
    fontSize: 17,
    fontWeight: "600",
  },
  resultDetails: {
    color: "rgba(0,0,0,0.4)",
    fontSize: 13,
    marginTop: 2,
  },
  searchingLoader: {
    paddingVertical: 40,
    alignItems: "center",
    gap: 12,
  },
  searchingText: {
    color: "rgba(0,0,0,0.4)",
    fontSize: 14,
    fontWeight: "600",
  },
  closeSearchBtn: {
    paddingVertical: 20,
    alignItems: "center",
  },
  closeSearchBtnText: {
    color: "#000",
    fontSize: 17,
    fontWeight: "600",
  },
  recentName: {
    fontSize: 12,
    fontWeight: "700",
    color: "rgba(0,0,0,0.6)",
  },
  // ── AUTO-GEN SECTION ─────────────────────────────────────────────────────
  agSection: {
    marginBottom: 4,
    gap: 12,
  },
  agSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  agActiveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(74,222,128,0.1)",
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(74,222,128,0.2)",
  },
  agActiveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#4ADE80",
  },
  agActiveBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#4ADE80",
  },
  agOnboardCard: {
    borderRadius: 22,
    overflow: "hidden",
    height: 235,
    borderWidth: 1.5,
    borderColor: "rgba(0,0,0,0.08)",
    backgroundColor: Colors.surface,
    flexDirection: "column",
  },
  agCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  agCardHeaderTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#000",
  },
  agOnboardLeft: {
    flex: 2.2,
    padding: 16,
    paddingTop: 0,
    justifyContent: "space-between",
  },
  agOnboardRight: {
    flex: 4,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(0,0,0,0.06)",
    overflow: "hidden",
  },
  agMiniList: {
    padding: 10,
    gap: 6,
  },
  agMiniCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.04)",
    borderRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  agMiniInfo: {
    flex: 1,
    gap: 2,
  },
  agMiniName: {
    fontSize: 11,
    fontWeight: "700",
    color: "#000",
    letterSpacing: -0.2,
  },
  agMiniSub: {
    fontSize: 9,
    fontWeight: "500",
    color: "rgba(0,0,0,0.3)",
  },
  agMiniJump: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.04)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
  },
  agMiniEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  agMiniEmptyText: {
    fontSize: 10,
    fontWeight: "600",
    color: "rgba(0,0,0,0.2)",
    textAlign: "center",
  },
  agOnboardHeadline: {
    fontSize: 16,
    fontWeight: "900",
    color: "#000",
    lineHeight: 20,
    letterSpacing: -0.6,
  },
  agOnboardSub: {
    fontSize: 10,
    fontWeight: "500",
    color: "rgba(0,0,0,0.4)",
    lineHeight: 14,
  },
  agOnboardBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#000",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  agOnboardBtnText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#FFF",
  },
  agQuickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.05)",
  },
  agToggle: {
    width: 36,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.08)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.1)",
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  agToggleOn: {
    backgroundColor: "#4ADE80",
    borderColor: "#4ADE80",
  },
  agToggleThumb: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "rgba(0,0,0,0.3)",
    alignSelf: "flex-start",
  },
  agToggleThumbOn: {
    backgroundColor: "#000",
    alignSelf: "flex-end",
  },
  agQuickName: {
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
    color: "#000",
    letterSpacing: -0.2,
  },
  agQuickNameOff: {
    color: "rgba(0,0,0,0.3)",
  },
  agQuickBadge: {
    backgroundColor: "rgba(74,222,128,0.12)",
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: "rgba(74,222,128,0.25)",
  },
  agQuickBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#4ADE80",
  },
  agQuickMore: {
    fontSize: 9,
    fontWeight: "700",
    color: "rgba(0,0,0,0.2)",
    paddingTop: 6,
    textAlign: "center",
  },
  agDots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 5,
    paddingTop: 2,
  },
  agDot: {
    height: 5,
    borderRadius: 3,
    backgroundColor: "#000",
  },
});
