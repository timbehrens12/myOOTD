import { Dimensions, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Shirt, Tag } from 'lucide-react-native';
import { Colors, Radii, Typography } from '../../constants/AppTheme';
import type { SavedFit } from './types';
import { OCC_LABEL } from './types';

const { width: SW } = Dimensions.get('window');
const GRID_PAD = 16;
const GRID_GAP = 10;
const CARD_W = (SW - GRID_PAD * 2 - GRID_GAP) / 2;

interface Props {
  fit: SavedFit;
  onPress: () => void;
  onLongPress: () => void;
  index: number;
}

export default function FitCard({ fit, onPress, onLongPress, index }: Props) {
  const occLabel = fit.occasion ? (OCC_LABEL[fit.occasion] ?? fit.occasion) : null;
  const formattedDate = fit.planned_date
    ? new Date(fit.planned_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(200)}>
      <TouchableOpacity
        style={s.card}
        onPress={onPress}
        onLongPress={onLongPress}
        activeOpacity={0.92}
        delayLongPress={300}
      >
        <View style={s.imgWrap}>
          {fit.image_url ? (
            <Image source={{ uri: fit.image_url }} style={s.img} resizeMode="cover" />
          ) : (
            <View style={s.imgPlaceholder}>
              <Shirt size={30} color="rgba(0,0,0,0.12)" strokeWidth={1.5} />
            </View>
          )}
          {formattedDate && (
            <View style={s.dateBadge}>
              <Text style={s.dateBadgeText}>{formattedDate}</Text>
            </View>
          )}
        </View>

        <View style={s.footer}>
          <Text style={fit.name ? s.name : s.nameEmpty} numberOfLines={1}>
            {fit.name ?? 'Unnamed fit'}
          </Text>
          {occLabel && (
            <View style={s.tagRow}>
              <Tag size={9} color={Colors.textMuted} strokeWidth={2} />
              <Text style={s.tagText}>{occLabel}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export { CARD_W, GRID_PAD, GRID_GAP };

const s = StyleSheet.create({
  card: {
    width: CARD_W,
    backgroundColor: Colors.surface,
    borderRadius: Radii.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  imgWrap: {
    width: '100%',
    aspectRatio: 0.82,
    position: 'relative',
    backgroundColor: Colors.surfaceAlt,
  },
  img: { width: '100%', height: '100%' },
  imgPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dateBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  dateBadgeText: {
    fontSize: 10,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: 0.1,
  },
  footer: { paddingHorizontal: 11, paddingTop: 9, paddingBottom: 11, gap: 4 },
  name: {
    fontSize: 13,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.2,
  },
  nameEmpty: {
    fontSize: 13,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
    fontStyle: 'italic',
  },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tagText: { fontSize: 11, fontWeight: Typography.weights.medium, color: Colors.textMuted },
});
