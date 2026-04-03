import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Check, Shirt } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import ColorPickerTriggerIcon from "../color-picker/ColorPickerTriggerIcon";
import IosStyleColorPickerModal from "../color-picker/IosStyleColorPickerModal";
import { Colors, Typography } from "../../constants/AppTheme";
import {
  CLOSET_BROWSE_OCCASION_TABS,
  CLOSET_SORT_META,
  CLOSET_SORT_ORDER,
  type ClosetSortMode,
  filterClosetItems,
  sortClosetItems,
} from "./closetItemFilters";
import { closetItemShelfKey, shelfLabelForCategoryId } from "./closetShelfUtils";

const { width: W } = Dimensions.get("window");
const SORT_DROPDOWN_W = Math.min(200, W - 56);
const COLOR_PANEL_W = Math.min(280, W - 40);
export const CLOSET_GRID_CELL_W = (W - 32 - 20) / 3;
export const CLOSET_GRID_CELL_H = CLOSET_GRID_CELL_W * (4 / 3);

export type CategoryBrowseItem = {
  id: string;
  image_url?: string | null;
  name?: string | null;
  type?: string | null;
  brand?: string | null;
  category?: string | null;
  color?: string | null;
  wear_count?: number | null;
  created_at?: string | null;
  occasions?: unknown;
};

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

const ArcSearch = ({ color, size = 20 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);

type Presentation = "modal" | "overlay";

type Props = {
  presentation: Presentation;
  visible: boolean;
  categoryId: string | null;
  /** Full pool; items are sliced by `categoryId` then browse filters apply. */
  sourceItems: CategoryBrowseItem[];
  onClose: () => void;
  selectedIds?: Set<string>;
  onToggleId?: (id: string) => void;
  onItemPress?: (item: CategoryBrowseItem) => void;
};

/**
 * Full-screen category grid with the same search, sort, occasion, and color
 * controls as the main Closet tab. Use `presentation="overlay"` when this sits
 * inside another `Modal` (e.g. must-include picker) so nested modals do not break.
 */
export default function ClosetCategoryBrowse({
  presentation,
  visible,
  categoryId,
  sourceItems,
  onClose,
  selectedIds,
  onToggleId,
  onItemPress,
}: Props) {
  const insets = useSafeAreaInsets();
  const sortBtnRef = useRef<View>(null);
  const colorBtnRef = useRef<View>(null);
  const [browseSearch, setBrowseSearch] = useState("");
  const [activeOccasion, setActiveOccasion] = useState("all");
  const [activeColor, setActiveColor] = useState("all");
  const [sortBy, setSortBy] = useState<ClosetSortMode>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [iosFilterColorOpen, setIosFilterColorOpen] = useState(false);
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
    if (!visible || !categoryId) return;
    setBrowseSearch("");
    setActiveOccasion("all");
    setActiveColor("all");
    setSortBy("recent");
    setSortOpen(false);
    setColorOpen(false);
    setIosFilterColorOpen(false);
  }, [visible, categoryId]);

  useEffect(() => {
    if (!sortOpen) setSortAnchor(null);
  }, [sortOpen]);

  useEffect(() => {
    if (!colorOpen) setColorAnchor(null);
  }, [colorOpen]);

  const title = categoryId ? shelfLabelForCategoryId(categoryId) : "";

  const inCategory = useMemo(() => {
    if (!categoryId) return [];
    return sourceItems.filter((it) => closetItemShelfKey(it) === categoryId);
  }, [sourceItems, categoryId]);

  const displayItems = useMemo(() => {
    const filtered = filterClosetItems(inCategory, {
      search: browseSearch,
      activeOccasion,
      activeColor,
      searchCategory: true,
    });
    return sortClosetItems(filtered, sortBy);
  }, [inCategory, browseSearch, activeOccasion, activeColor, sortBy]);

  const rows = useMemo(() => {
    const r: CategoryBrowseItem[][] = [];
    for (let i = 0; i < displayItems.length; i += 3)
      r.push(displayItems.slice(i, i + 3));
    return r;
  }, [displayItems]);

  const open = visible && categoryId !== null;

  const body = (
    <>
      <View
        style={[
          styles.root,
          {
            paddingTop: insets.top + 8,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <View style={styles.topBar}>
          <TouchableOpacity
            style={styles.closeHit}
            onPress={onClose}
            hitSlop={12}
            accessibilityLabel="Close"
          >
            <ArcClose color="#000" size={22} />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.topSpacer} />
        </View>

        <View style={styles.searchBar}>
          <ArcSearch color="rgba(0,0,0,0.3)" size={16} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search your wardrobe..."
            placeholderTextColor="rgba(0,0,0,0.25)"
            value={browseSearch}
            onChangeText={setBrowseSearch}
            clearButtonMode="while-editing"
          />
        </View>

        <View style={styles.sortColorRow}>
          <View ref={sortBtnRef} collapsable={false} style={styles.sortColorHit}>
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
                  {CLOSET_SORT_META[sortBy].short}
                </Text>
                <Text style={styles.sortColorChevron}>▼</Text>
              </View>
            </TouchableOpacity>
          </View>

          <View ref={colorBtnRef} collapsable={false} style={styles.sortColorHit}>
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
                    activeColor !== "all" ? styles.filterTriggerIconOn : undefined
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

        <Text style={styles.meta}>
          {displayItems.length}{" "}
          {displayItems.length === 1 ? "piece" : "pieces"}
        </Text>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {displayItems.length === 0 ? (
            <Text style={styles.emptyText}>
              No items match your search or filters
            </Text>
          ) : (
            rows.map((row, rowIdx) => (
              <View key={rowIdx} style={styles.row}>
                {row.map((item) => {
                  const name = item.name || item.type || "";
                  const brand = item.brand || "";
                  const pickerMode = !!onToggleId && !onItemPress;
                  const pinned = pickerMode && selectedIds?.has(item.id);

                  const handlePress = () => {
                    if (onItemPress) onItemPress(item);
                    else if (onToggleId) onToggleId(item.id);
                  };

                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={styles.cellWrap}
                      onPress={handlePress}
                      activeOpacity={0.8}
                    >
                      <View
                        style={[styles.cell, pinned && styles.cellActive]}
                      >
                        {item.image_url ? (
                          <Image
                            source={{ uri: item.image_url }}
                            style={styles.cellImg}
                            resizeMode="contain"
                          />
                        ) : (
                          <View style={styles.cellEmpty}>
                            <Shirt
                              size={22}
                              color={Colors.textMuted}
                              strokeWidth={1.5}
                            />
                          </View>
                        )}
                        {pickerMode && pinned ? (
                          <View style={styles.cellCheck}>
                            <Check size={10} color="#fff" strokeWidth={3} />
                          </View>
                        ) : null}
                        {!pickerMode &&
                        onItemPress &&
                        (item.wear_count ?? 0) > 0 ? (
                          <View style={styles.wearBadge}>
                            <Text style={styles.wearBadgeText}>
                              {item.wear_count}x
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      {(brand || name) && (
                        <View style={styles.cellLabel}>
                          {brand ? (
                            <Text style={styles.cellBrand} numberOfLines={1}>
                              {brand}
                            </Text>
                          ) : null}
                          {name ? (
                            <Text style={styles.cellName} numberOfLines={1}>
                              {name}
                            </Text>
                          ) : null}
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
                {row.length < 3 &&
                  Array.from({ length: 3 - row.length }).map((_, i) => (
                    <View key={`p-${i}`} style={{ width: CLOSET_GRID_CELL_W }} />
                  ))}
              </View>
            ))
          )}
        </ScrollView>
      </View>

      {sortOpen ? (
        <View
          style={[StyleSheet.absoluteFillObject, styles.floatLayer]}
          pointerEvents="box-none"
        >
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => setSortOpen(false)}
          />
          {sortAnchor ? (
            <View
              style={[
                styles.sortDropdown,
                {
                  top: sortAnchor.y + sortAnchor.h + 6,
                  left: Math.max(
                    8,
                    Math.min(sortAnchor.x, W - SORT_DROPDOWN_W - 8),
                  ),
                  width: SORT_DROPDOWN_W,
                },
              ]}
            >
              <Text style={styles.dropdownHeading}>Sort</Text>
              {CLOSET_SORT_ORDER.map((id, index) => {
                const { label } = CLOSET_SORT_META[id];
                const selected = sortBy === id;
                return (
                  <TouchableOpacity
                    key={id}
                    style={[
                      styles.dropdownRow,
                      index < CLOSET_SORT_ORDER.length - 1 &&
                        styles.dropdownRowDivider,
                    ]}
                    onPress={() => {
                      setSortBy(id);
                      setSortOpen(false);
                    }}
                    activeOpacity={0.65}
                  >
                    <Text
                      style={[
                        styles.dropdownLabel,
                        selected && styles.dropdownLabelSelected,
                      ]}
                    >
                      {label}
                    </Text>
                    {selected ? (
                      <Text style={styles.dropdownCheck}>✓</Text>
                    ) : (
                      <View style={styles.dropdownCheckSpacer} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}

      {colorOpen ? (
        <View
          style={[StyleSheet.absoluteFillObject, styles.floatLayer]}
          pointerEvents="box-none"
        >
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={() => setColorOpen(false)}
          />
          {colorAnchor ? (
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
                      W - COLOR_PANEL_W - 8,
                    ),
                  ),
                  width: COLOR_PANEL_W,
                },
              ]}
              showsVerticalScrollIndicator
            >
              <View style={styles.filterSection}>
                <Text style={styles.filterSectionLabel}>Occasion</Text>
                <ScrollView
                  style={styles.occasionList}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
                  {CLOSET_BROWSE_OCCASION_TABS.map((occ) => {
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
              <View style={styles.filterDivider} />
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
      ) : null}

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

  if (!open) return null;

  if (presentation === "overlay") {
    return (
      <View
        style={[StyleSheet.absoluteFillObject, styles.overlayShell]}
        pointerEvents="auto"
      >
        {body}
      </View>
    );
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {body}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlayShell: {
    zIndex: 50000,
    elevation: 50000,
    backgroundColor: "#FFFFFF",
  },
  root: { flex: 1, backgroundColor: "#FFFFFF" },
  floatLayer: { zIndex: 60000, elevation: 60000 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  closeHit: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  topSpacer: { width: 44 },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 18,
    fontWeight: Typography.weights.bold,
    color: "#000",
    letterSpacing: -0.3,
  },
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
    marginBottom: 12,
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
  sortColorHit: { flex: 1, minWidth: 0 },
  sortColorHalf: {
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
  },
  sortColorLabelOn: { color: "rgba(255,255,255,0.65)" },
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
  sortColorChevron: { fontSize: 9, color: "rgba(0,0,0,0.35)" },
  sortColorChevronOn: { color: "rgba(255,255,255,0.85)" },
  filterTriggerIconOn: { opacity: 0.95 },
  meta: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(0,0,0,0.38)",
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 32 },
  emptyText: {
    textAlign: "center",
    marginTop: 24,
    fontSize: 14,
    color: Colors.textMuted,
    paddingHorizontal: 24,
  },
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  cellWrap: { width: CLOSET_GRID_CELL_W, gap: 4 },
  cell: {
    height: CLOSET_GRID_CELL_H,
    borderRadius: 14,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  cellActive: { borderColor: Colors.black, borderWidth: 2 },
  cellImg: { width: "100%", height: "100%" },
  cellEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceAlt,
  },
  cellCheck: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.black,
    alignItems: "center",
    justifyContent: "center",
  },
  wearBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "#000",
    borderRadius: 9999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  wearBadgeText: { fontSize: 10, fontWeight: "800", color: "#FFF" },
  cellLabel: { gap: 1, paddingHorizontal: 2 },
  cellBrand: {
    fontSize: 10,
    fontWeight: "700",
    color: "rgba(0,0,0,0.4)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cellName: {
    fontSize: 12,
    fontWeight: "600",
    color: "rgba(0,0,0,0.75)",
  },
  sortDropdown: {
    position: "absolute",
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 12,
  },
  dropdownHeading: {
    fontSize: 11,
    fontWeight: "800",
    color: "rgba(0,0,0,0.35)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  dropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dropdownRowDivider: { borderBottomWidth: 1, borderBottomColor: "rgba(0,0,0,0.06)" },
  dropdownLabel: { fontSize: 15, fontWeight: "600", color: "#000" },
  dropdownLabelSelected: { fontWeight: "800" },
  dropdownCheck: { fontSize: 15, fontWeight: "700", color: Colors.accent },
  dropdownCheckSpacer: { width: 18 },
  filterDropdownPanel: {
    maxHeight: 360,
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 12,
  },
  filterSection: { paddingHorizontal: 12, paddingVertical: 10 },
  filterSectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "rgba(0,0,0,0.35)",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  occasionList: { maxHeight: 200 },
  filterOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 4,
  },
  filterOptionActive: { backgroundColor: "#000" },
  filterOptionText: { fontSize: 14, fontWeight: "600", color: "#000" },
  filterOptionTextActive: { color: "#fff" },
  filterDivider: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.06)",
    marginHorizontal: 12,
  },
  colorFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  colorFilterValue: { fontSize: 14, fontWeight: "700", color: "#000", marginTop: 2 },
  colorFilterIconHit: { padding: 4 },
});
