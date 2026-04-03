import * as Haptics from "expo-haptics";
import { Pencil, Plus, RefreshCw, Shirt, X } from "lucide-react-native";
import { useState } from "react";
import {
    ActivityIndicator,
    Image,
    LayoutChangeEvent,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { Colors, Radii, Typography } from "../../constants/AppTheme";
import {
  isBagItem,
  isBottomLike,
  isDressLike,
  isOuterItem,
  isShoeItem,
  isTopLike,
} from "./closetCategories";
import type { BuilderItem } from "./types";

export type GenerationPhase = "idle" | "picking" | "rendering";

type Pos = { w: number; h: number; x: number; y: number };

const LAYOUTS: Record<number, Pos[]> = {
  1: [{ w: 0.5, h: 0.82, x: 0.25, y: 0.09 }],
  2: [
    { w: 0.42, h: 0.74, x: 0.04, y: 0.13 },
    { w: 0.42, h: 0.74, x: 0.54, y: 0.13 },
  ],
  3: [
    { w: 0.4, h: 0.52, x: 0.03, y: 0.05 },
    { w: 0.4, h: 0.52, x: 0.57, y: 0.05 },
    { w: 0.42, h: 0.46, x: 0.29, y: 0.5 },
  ],
  4: [
    { w: 0.38, h: 0.46, x: 0.03, y: 0.04 },
    { w: 0.38, h: 0.46, x: 0.57, y: 0.04 },
    { w: 0.38, h: 0.46, x: 0.03, y: 0.52 },
    { w: 0.38, h: 0.46, x: 0.57, y: 0.52 },
  ],
  5: [
    { w: 0.34, h: 0.44, x: 0.02, y: 0.04 },
    { w: 0.34, h: 0.44, x: 0.38, y: 0.04 },
    { w: 0.24, h: 0.44, x: 0.74, y: 0.04 },
    { w: 0.36, h: 0.44, x: 0.1, y: 0.52 },
    { w: 0.36, h: 0.44, x: 0.52, y: 0.52 },
  ],
  6: [
    { w: 0.3, h: 0.44, x: 0.01, y: 0.04 },
    { w: 0.3, h: 0.44, x: 0.35, y: 0.04 },
    { w: 0.3, h: 0.44, x: 0.67, y: 0.04 },
    { w: 0.3, h: 0.44, x: 0.01, y: 0.52 },
    { w: 0.3, h: 0.44, x: 0.35, y: 0.52 },
    { w: 0.3, h: 0.44, x: 0.67, y: 0.52 },
  ],
};

function itemLabel(item: BuilderItem): string {
  const raw = (item.name || item.type || item.category || "Item").trim();
  return raw.length > 24 ? `${raw.slice(0, 22)}…` : raw;
}

interface Props {
  items: BuilderItem[];
  generationPhase: GenerationPhase;
  onRemoveItem: (slot: number) => void;
  onShuffle?: () => void;
  canShuffle?: boolean;
  heroImageUri?: string | null;
  onClearHero?: () => void;
  manualModeHint?: boolean;
  /** Even rows/columns instead of scattered editorial layout */
  manualGridCollage?: boolean;
  /** Dashed “add” tile (Auto collage only) */
  showManualAddPlaceholder?: boolean;
  manualDoneVisible?: boolean;
  onManualDone?: () => void;
  /** "Try On" replaces "Done" in the new flow */
  tryOnVisible?: boolean;
  onTryOn?: () => void;
  manualEditVisible?: boolean;
  onManualEditOutfit?: () => void;
}

export default function OutfitCanvas({
  items,
  generationPhase,
  onRemoveItem,
  onShuffle,
  canShuffle,
  heroImageUri,
  onClearHero,
  manualModeHint,
  manualGridCollage = false,
  showManualAddPlaceholder = true,
  manualDoneVisible = false,
  onManualDone,
  tryOnVisible = false,
  onTryOn,
  manualEditVisible = false,
  onManualEditOutfit,
}: Props) {
  const [box, setBox] = useState({ w: 0, h: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setBox({ w: width, h: height });
  };

  const innerW = Math.max(box.w - 32, 1);
  const innerH = Math.max(box.h, 1);
  const count = Math.min(items.length, 6);
  const layout = LAYOUTS[count] ?? LAYOUTS[6]!;

  const generating = generationPhase !== "idle";
  const isEmpty = items.length === 0 && !generating && !heroImageUri;
  const showCollage = items.length > 0 && !heroImageUri;
  const showHero = !!heroImageUri && !generating;

  const genLabel =
    generationPhase === "picking"
      ? "Choosing pieces (GPT-5 nano)…"
      : generationPhase === "rendering"
        ? "Rendering look (Gemini)…"
        : "";

  const renderCollageCard = (item: BuilderItem, style: object, idx: number) => (
    <Animated.View
      key={item.id}
      entering={FadeInDown.delay(idx * 50).duration(200)}
      style={[s.card, manualGridCollage ? s.cardGrid : {}, style]}
    >
      {item.image_url ? (
        <Image
          source={{ uri: item.image_url }}
          style={s.cardImg}
          resizeMode="cover"
        />
      ) : (
        <View style={s.cardEmpty}>
          <Shirt size={20} color="rgba(255,255,255,0.3)" strokeWidth={1.5} />
        </View>
      )}
      <TouchableOpacity
        style={s.removeBtn}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onRemoveItem(item.slot);
        }}
        hitSlop={8}
      >
        <X size={10} color="#fff" strokeWidth={3} />
      </TouchableOpacity>
      <View style={s.nameBadge}>
        <Text style={s.nameBadgeText} numberOfLines={1}>
          {itemLabel(item)}
        </Text>
      </View>
    </Animated.View>
  );

  const renderManualGrid = () => {
    const slice = items.slice(0, 6);
    const placed = new Set<string>();

    const getPos = (item: BuilderItem, index: number) => {
      if (isDressLike(item) && !placed.has("dress")) {
        placed.add("dress");
        return { x: 0.05, y: 0.1, w: 0.45, h: 0.8 };
      }
      if (isTopLike(item) && !placed.has("top")) {
        placed.add("top");
        return { x: 0.05, y: 0.1, w: 0.45, h: 0.38 };
      }
      if (isBottomLike(item) && !placed.has("bottom")) {
        placed.add("bottom");
        return { x: 0.05, y: 0.5, w: 0.45, h: 0.4 };
      }
      if (isOuterItem(item) && !placed.has("outer")) {
        placed.add("outer");
        return { x: 0.52, y: 0.05, w: 0.42, h: 0.4 };
      }
      if (isBagItem(item) && !placed.has("bag")) {
        placed.add("bag");
        return { x: 0.55, y: 0.2, w: 0.35, h: 0.25 };
      }
      if (isShoeItem(item) && !placed.has("shoes")) {
        placed.add("shoes");
        return { x: 0.55, y: 0.55, w: 0.35, h: 0.25 };
      }

      const fallbacks = [
        { x: 0.55, y: 0.1, w: 0.35, h: 0.25 },
        { x: 0.55, y: 0.4, w: 0.35, h: 0.25 },
        { x: 0.55, y: 0.7, w: 0.35, h: 0.25 },
        { x: 0.1, y: 0.7, w: 0.35, h: 0.25 },
      ];
      return fallbacks[index % fallbacks.length]!;
    };

    return slice.map((item, idx) => {
      const pos = getPos(item, idx);
      return renderCollageCard(
        item,
        {
          position: "absolute",
          left: innerW * pos.x,
          top: innerH * pos.y,
          width: innerW * pos.w,
          height: innerH * pos.h,
        },
        idx,
      );
    });
  };

  return (
    <View style={s.root} onLayout={onLayout}>
      <View style={s.surface}>
        {showHero && (
          <Animated.View
            entering={FadeIn.duration(350)}
            style={StyleSheet.absoluteFill}
          >
            <Image
              source={{ uri: heroImageUri! }}
              style={s.heroImg}
              resizeMode="cover"
            />
            {onClearHero ? (
              <TouchableOpacity
                style={s.clearHero}
                onPress={onClearHero}
                hitSlop={10}
              >
                <Text style={s.clearHeroText}>Pieces</Text>
              </TouchableOpacity>
            ) : null}
          </Animated.View>
        )}

        {isEmpty && (
          <Animated.View entering={FadeIn.duration(400)} style={s.emptyState}>
            <View style={s.emptyIcon}>
              <Shirt
                size={30}
                color="rgba(255,255,255,0.22)"
                strokeWidth={1.5}
              />
            </View>
            <Text style={s.emptyTitle}>your next OOTD</Text>
            <Text style={s.emptySub}>
              {manualModeHint
                ? "Pull up the panel and add items from your closet"
                : "Pull up the panel to pick an occasion and generate"}
            </Text>
          </Animated.View>
        )}

        {generating && (
          <Animated.View entering={FadeIn.duration(200)} style={s.genOverlay}>
            <View style={s.genPulse}>
              <ActivityIndicator size="large" color="rgba(255,255,255,0.8)" />
            </View>
            <Text style={s.genText}>{genLabel}</Text>
          </Animated.View>
        )}

        {showCollage && !generating && manualGridCollage && (
          <View style={[s.collage, { marginHorizontal: 16 }]}>
            {renderManualGrid()}
          </View>
        )}

        {showCollage && !generating && !manualGridCollage && (
          <View style={[s.collage, { marginHorizontal: 16 }]}>
            {items.slice(0, 6).map((item, idx) => {
              const pos = layout[idx];
              if (!pos) return null;
              return renderCollageCard(
                item,
                {
                  width: innerW * pos.w,
                  height: innerH * pos.h,
                  left: innerW * pos.x,
                  top: innerH * pos.y,
                },
                idx,
              );
            })}

            {showManualAddPlaceholder && items.length < 6 && (
              <View
                style={[
                  s.addSlot,
                  {
                    width: innerW * 0.28,
                    height: innerH * 0.36,
                    left: innerW * (LAYOUTS[count + 1]?.[count]?.x ?? 0.36),
                    top: innerH * (LAYOUTS[count + 1]?.[count]?.y ?? 0.32),
                  },
                ]}
              >
                <Plus
                  size={18}
                  color="rgba(255,255,255,0.18)"
                  strokeWidth={1.5}
                />
              </View>
            )}
          </View>
        )}

        <View style={s.actionRow}>
          {tryOnVisible && onTryOn ? (
            <TouchableOpacity
              style={s.tryOnPill}
              onPress={onTryOn}
              activeOpacity={0.9}
            >
              <Text style={s.tryOnPillText}>Try on ✨</Text>
            </TouchableOpacity>
          ) : null}

          {manualEditVisible && onManualEditOutfit ? (
            <TouchableOpacity
              style={s.editOutfitPill}
              onPress={onManualEditOutfit}
              activeOpacity={0.85}
            >
              <Pencil size={14} color={Colors.text} strokeWidth={2.5} />
              <Text style={s.editOutfitPillText}>Edit</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {manualDoneVisible && onManualDone ? (
          <TouchableOpacity
            style={s.donePill}
            onPress={onManualDone}
            activeOpacity={0.9}
          >
            <Text style={s.donePillText}>Done</Text>
            <Text style={s.donePillSub}>Name & save</Text>
          </TouchableOpacity>
        ) : null}

        {canShuffle && !generating && items.length > 0 && (
          <Animated.View entering={FadeIn.delay(300)} style={s.shuffleWrap}>
            <TouchableOpacity
              style={s.shuffleBtn}
              onPress={onShuffle}
              activeOpacity={0.8}
            >
              <RefreshCw size={13} color="#fff" strokeWidth={2.5} />
              <Text style={s.shuffleLabel}>shuffle</Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    width: "100%",
  },
  surface: {
    flex: 1,
    backgroundColor: Colors.fitsBuilderCanvas,
    overflow: "hidden",
    position: "relative",
  },
  heroImg: {
    width: "100%",
    height: "100%",
  },
  clearHero: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radii.full,
  },
  clearHeroText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
  },
  emptyState: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "rgba(0,0,0,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: Typography.weights.bold,
    color: "rgba(0,0,0,0.22)",
    letterSpacing: 1,
    textTransform: "lowercase",
  },
  emptySub: {
    fontSize: 13,
    color: "rgba(0,0,0,0.28)",
    textAlign: "center",
    lineHeight: 19,
  },
  genOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  genPulse: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  genText: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: "rgba(255,255,255,0.95)",
    letterSpacing: 0.2,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  collage: {
    flex: 1,
    position: "relative",
  },
  card: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  cardGrid: {
    position: "absolute",
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.35)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  cardImg: {
    width: "100%",
    height: "100%",
  },
  cardEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  removeBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  nameBadge: {
    position: "absolute",
    bottom: 6,
    left: 6,
    right: 32,
    maxWidth: "85%",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  nameBadgeText: {
    fontSize: 10,
    fontWeight: Typography.weights.semibold,
    color: "rgba(255,255,255,0.95)",
    letterSpacing: 0.2,
  },
  addSlot: {
    position: "absolute",
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "rgba(0,0,0,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  actionRow: {
    position: "absolute",
    bottom: 24,
    left: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  tryOnPill: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: Radii.full,
    backgroundColor: "rgba(255,255,255,0.85)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  tryOnPillText: {
    fontSize: 14,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
  },
  editOutfitPill: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: Radii.full,
    backgroundColor: "rgba(255,255,255,0.85)",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  editOutfitPillText: {
    fontSize: 14,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
  },
  donePill: {
    position: "absolute",
    bottom: 20,
    alignSelf: "center",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: Radii.full,
    backgroundColor: "#000",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  donePillText: {
    fontSize: 15,
    fontWeight: Typography.weights.bold,
    color: "#fff",
    letterSpacing: -0.2,
  },
  donePillSub: {
    fontSize: 11,
    fontWeight: Typography.weights.medium,
    color: "rgba(255,255,255,0.72)",
    marginTop: 2,
  },
  shuffleWrap: {
    position: "absolute",
    bottom: 12,
    right: 16,
  },
  shuffleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: Radii.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  shuffleLabel: {
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
    color: "rgba(255,255,255,0.9)",
    letterSpacing: 0.2,
  },
});
