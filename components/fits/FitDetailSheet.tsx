import {
  Alert,
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  CalendarDays,
  ChevronRight,
  Download,
  Pencil,
  Share2,
  Shirt,
  ShoppingBag,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import { Colors, Radii, Typography } from "../../constants/AppTheme";
import { downloadOrShareFitImage, shareFitImage } from "../../lib/fitShareDownload";
import BottomSheet from "./BottomSheet";
import type { ClosetItem, SavedFit } from "./types";
import { OCC_LABEL } from "./types";

const { height: SH } = Dimensions.get("window");

function resolvePieces(fit: SavedFit, closet: ClosetItem[]): ClosetItem[] {
  const ids = fit.item_ids ?? [];
  if (!ids.length) return [];
  const map = Object.fromEntries(closet.map((c) => [c.id, c]));
  return ids.map((id) => map[id]).filter(Boolean) as ClosetItem[];
}

interface Props {
  fit: SavedFit | null;
  visible: boolean;
  onClose: () => void;
  onDelete: (id: string) => void;
  onEdit?: (fit: SavedFit) => void;
  closetItems?: ClosetItem[];
}

export default function FitDetailSheet({
  fit,
  visible,
  onClose,
  onDelete,
  onEdit,
  closetItems = [],
}: Props) {
  if (!fit) return null;

  const occLabel = fit.occasion ? (OCC_LABEL[fit.occasion] ?? fit.occasion) : null;
  const planned = fit.planned_date
    ? new Date(fit.planned_date).toLocaleDateString("en-US", {
        weekday: "short",
        month: "long",
        day: "numeric",
      })
    : null;
  const worn = fit.worn_on
    ? new Date(fit.worn_on).toLocaleDateString("en-US", {
        weekday: "short",
        month: "long",
        day: "numeric",
      })
    : null;

  const pieces = resolvePieces(fit, closetItems);

  const handleDelete = () => {
    Alert.alert("Delete fit?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          onDelete(fit.id);
          onClose();
        },
      },
    ]);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} snapHeight={SH * 0.82}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        bounces={false}
        alwaysBounceVertical={false}
      >
        <View style={s.imgWrap}>
          {fit.image_url ? (
            <Image source={{ uri: fit.image_url }} style={s.img} resizeMode="cover" />
          ) : (
            <View style={s.imgEmpty}>
              <Shirt size={48} color="rgba(0,0,0,0.12)" strokeWidth={1.5} />
            </View>
          )}
        </View>

        <View style={s.body}>
          <Text style={s.name}>{fit.name ?? "Unnamed fit"}</Text>

          {worn && (
            <View style={s.metaRow}>
              <CalendarDays size={13} color={Colors.textMuted} strokeWidth={2} />
              <Text style={s.metaText}>Worn {worn}</Text>
            </View>
          )}
          {planned && (
            <View style={s.metaRow}>
              <CalendarDays size={13} color={Colors.textMuted} strokeWidth={2} />
              <Text style={s.metaText}>Planned {planned}</Text>
            </View>
          )}
          {occLabel && (
            <View style={s.metaRow}>
              <Sparkles size={13} color={Colors.textMuted} strokeWidth={2} />
              <Text style={s.metaText}>{occLabel}</Text>
            </View>
          )}

          <View style={s.sep} />

          <ActionRow
            icon={<Share2 size={16} color={Colors.text} strokeWidth={2} />}
            label="Share look"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              shareFitImage(fit.image_url, fit.name);
            }}
          />
          <ActionRow
            icon={<Download size={16} color={Colors.text} strokeWidth={2} />}
            label="Save or export image"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              downloadOrShareFitImage(fit.image_url, fit.name);
            }}
          />
          {pieces.length > 0 ? (
            <>
              <Text style={s.piecesHeading}>From your closet</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.piecesRow}
              >
                {pieces.map((it) => (
                  <View key={it.id} style={s.pieceCell}>
                    {it.image_url ? (
                      <Image source={{ uri: it.image_url }} style={s.pieceImg} resizeMode="cover" />
                    ) : (
                      <View style={s.pieceImgEmpty}>
                        <Shirt size={20} color={Colors.textMuted} strokeWidth={1.5} />
                      </View>
                    )}
                    <Text style={s.pieceName} numberOfLines={2}>
                      {it.name ?? it.category ?? "Item"}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </>
          ) : (
            <ActionRow
              icon={<ShoppingBag size={16} color={Colors.text} strokeWidth={2} />}
              label="Closet pieces"
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                Alert.alert(
                  "No pieces linked",
                  "This save doesn't list closet items yet. New saves from the Builder include them.",
                );
              }}
            />
          )}

          <View style={s.sep} />

          {onEdit && (
            <ActionRow
              icon={<Pencil size={16} color={Colors.text} strokeWidth={2} />}
              label="Edit in builder"
              onPress={() => {
                onClose();
                setTimeout(() => onEdit(fit), 350);
              }}
            />
          )}
          <ActionRow
            icon={<CalendarDays size={16} color={Colors.text} strokeWidth={2} />}
            label="Plan for a day"
            onPress={() => {}}
          />
          <ActionRow
            icon={<Sparkles size={16} color={Colors.text} strokeWidth={2} />}
            label="Get styling tips"
            onPress={() => {}}
          />
          <TouchableOpacity
            style={[s.actionRow, s.actionDanger]}
            onPress={handleDelete}
            activeOpacity={0.7}
          >
            <View style={[s.actionIcon, s.actionIconDanger]}>
              <Trash2 size={16} color={Colors.red} strokeWidth={2} />
            </View>
            <Text style={s.actionTextDanger}>Delete fit</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

function ActionRow({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={s.actionRow} onPress={onPress} activeOpacity={0.7}>
      <View style={s.actionIcon}>{icon}</View>
      <Text style={s.actionText}>{label}</Text>
      <ChevronRight size={14} color={Colors.textMuted} strokeWidth={2} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  imgWrap: {
    marginHorizontal: 20,
    marginTop: 12,
    borderRadius: Radii.xl,
    overflow: "hidden",
    height: 220,
    backgroundColor: Colors.surfaceAlt,
  },
  img: { width: "100%", height: "100%" },
  imgEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 24, gap: 8 },
  name: {
    fontSize: 22,
    fontWeight: Typography.weights.extrabold,
    color: Colors.text,
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: {
    fontSize: 13,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
  },
  sep: { height: 1, backgroundColor: Colors.border, marginVertical: 12 },
  piecesHeading: {
    fontSize: 13,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  piecesRow: { gap: 10, paddingVertical: 4, marginBottom: 4 },
  pieceCell: { width: 76 },
  pieceImg: {
    width: 76,
    height: 76,
    borderRadius: Radii.md,
    backgroundColor: Colors.surfaceAlt,
  },
  pieceImgEmpty: {
    width: 76,
    height: 76,
    borderRadius: Radii.md,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  pieceName: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: Colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: Colors.text,
  },
  actionDanger: { borderBottomWidth: 0 },
  actionIconDanger: { backgroundColor: "rgba(255,59,48,0.08)" },
  actionTextDanger: {
    flex: 1,
    fontSize: 15,
    fontWeight: Typography.weights.semibold,
    color: Colors.red,
  },
});
