import { useMemo } from "react";
import {
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { Check, Shirt } from "lucide-react-native";
import { Colors, Typography } from "../../constants/AppTheme";
import { buildClosetShelfSections } from "./closetShelfUtils";

const { width: SW } = Dimensions.get("window");

/** Horizontal shelf tiles — compact (matches Closet tab). */
const SHELF_CARD_W = Math.min(112, SW * 0.3);
const SHELF_IMG_H = SHELF_CARD_W * 1.1;
const SHELF_GAP = 10;

/** 3-column grid cell (browse / picker) — re-export for callers. */
export {
  CLOSET_GRID_CELL_H,
  CLOSET_GRID_CELL_W,
} from "./ClosetCategoryBrowse";

export type ClosetShelfItem = {
  id: string;
  image_url?: string | null;
  name?: string | null;
  type?: string | null;
  brand?: string | null;
  category?: string | null;
  wear_count?: number | null;
};

/** Main closet: tap opens item. Pickers: optional selection + view-all modal. */
export function ClosetShelfTile({
  item,
  onPress,
  selected,
  selectionMode,
}: {
  item: ClosetShelfItem;
  onPress: () => void;
  selected?: boolean;
  selectionMode?: boolean;
}) {
  const name = item.name || item.type || "";
  const brand = item.brand || "";
  return (
    <TouchableOpacity
      style={shelfTile.wrap}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View
        style={[
          shelfTile.card,
          selectionMode && selected && shelfTile.cardSelected,
        ]}
      >
        {item.image_url ? (
          <Image
            source={{ uri: item.image_url }}
            style={shelfTile.img}
            resizeMode="contain"
          />
        ) : (
          <View style={shelfTile.imgEmpty}>
            <Shirt size={20} color={Colors.textMuted} strokeWidth={1.5} />
          </View>
        )}
        {selectionMode && selected ? (
          <View style={shelfTile.check}>
            <Check size={10} color="#fff" strokeWidth={3} />
          </View>
        ) : null}
        {!selectionMode && (item.wear_count ?? 0) > 0 ? (
          <View style={shelfTile.wearBadge}>
            <Text style={shelfTile.wearBadgeText}>{item.wear_count}x</Text>
          </View>
        ) : null}
      </View>
      <View style={shelfTile.label}>
        {brand.length > 0 ? (
          <Text style={shelfTile.brand} numberOfLines={1}>
            {brand}
          </Text>
        ) : null}
        <Text style={shelfTile.name} numberOfLines={2}>
          {name || "Untitled"}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const shelfTile = StyleSheet.create({
  wrap: { width: SHELF_CARD_W, marginRight: SHELF_GAP },
  card: {
    width: SHELF_CARD_W,
    height: SHELF_IMG_H,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  cardSelected: { borderColor: Colors.black, borderWidth: 2 },
  img: { width: "100%", height: "100%" },
  imgEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surfaceAlt,
  },
  check: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.black,
    alignItems: "center",
    justifyContent: "center",
  },
  wearBadge: {
    position: "absolute",
    top: 5,
    right: 5,
    backgroundColor: "#000",
    borderRadius: 9999,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  wearBadgeText: { fontSize: 9, fontWeight: "800", color: "#FFF" },
  label: { marginTop: 5, paddingRight: 2, gap: 1 },
  brand: {
    fontSize: 9,
    fontWeight: "600",
    color: "rgba(0,0,0,0.42)",
    letterSpacing: 0.15,
  },
  name: {
    fontSize: 11,
    fontWeight: "600",
    color: "rgba(0,0,0,0.78)",
    lineHeight: 14,
  },
});

const shelfLayout = StyleSheet.create({
  shelfRoot: { paddingTop: 4, paddingBottom: 16 },
  shelfSection: { marginBottom: 0, paddingBottom: 10 },
  shelfHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 6,
    paddingTop: 2,
  },
  shelfTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#000",
    letterSpacing: -0.25,
  },
  shelfViewAll: { flexDirection: "row", alignItems: "center", gap: 2 },
  shelfCount: {
    fontSize: 13,
    fontWeight: "600",
    color: "rgba(0,0,0,0.32)",
  },
  shelfChevron: {
    fontSize: 17,
    fontWeight: "300",
    color: "rgba(0,0,0,0.26)",
    marginTop: -1,
  },
  shelfRowContent: {
    paddingLeft: 20,
    paddingRight: 8,
    paddingBottom: 0,
  },
});

export function ClosetShelfSections({
  items,
  onItemPress,
  selectedIds,
  selectionMode = false,
  enableViewAll,
  onViewAllCategory,
  emptyHint,
}: {
  items: ClosetShelfItem[];
  onItemPress: (item: ClosetShelfItem) => void;
  selectedIds?: Set<string>;
  selectionMode?: boolean;
  /** Show count + chevron and call onViewAllCategory(categoryId) from header. */
  enableViewAll?: boolean;
  onViewAllCategory?: (categoryId: string) => void;
  emptyHint?: string;
}) {
  const sections = useMemo(() => buildClosetShelfSections(items), [items]);

  if (sections.length === 0) {
    return (
      <View style={shelfLayout.shelfRoot}>
        <Text style={emptyStyles.text}>
          {emptyHint ?? "No items match your search"}
        </Text>
      </View>
    );
  }

  return (
    <View style={shelfLayout.shelfRoot}>
      {sections.map((section, sIdx) => (
        <Animated.View
          key={section.id}
          entering={FadeInDown.delay(sIdx * 35).duration(220)}
          style={shelfLayout.shelfSection}
        >
          {enableViewAll && onViewAllCategory ? (
            <TouchableOpacity
              style={shelfLayout.shelfHeader}
              onPress={() => onViewAllCategory(section.id)}
              activeOpacity={0.65}
              accessibilityRole="button"
              accessibilityLabel={`View all ${section.label}, ${section.data.length} items`}
            >
              <Text style={shelfLayout.shelfTitle}>{section.label}</Text>
              <View style={shelfLayout.shelfViewAll}>
                <Text style={shelfLayout.shelfCount}>{section.data.length}</Text>
                <Text style={shelfLayout.shelfChevron}>›</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <View style={shelfLayout.shelfHeader} accessibilityRole="header">
              <Text style={shelfLayout.shelfTitle}>{section.label}</Text>
            </View>
          )}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={shelfLayout.shelfRowContent}
            decelerationRate="fast"
            keyboardShouldPersistTaps="handled"
          >
            {section.data.map((item) => (
              <ClosetShelfTile
                key={item.id}
                item={item}
                onPress={() => onItemPress(item)}
                selected={selectedIds?.has(item.id)}
                selectionMode={selectionMode}
              />
            ))}
          </ScrollView>
        </Animated.View>
      ))}
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  text: {
    paddingTop: 28,
    textAlign: "center",
    fontSize: 14,
    color: Colors.textMuted,
    paddingHorizontal: 24,
  },
});
