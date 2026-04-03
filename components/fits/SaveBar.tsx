import { useEffect } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CalendarDays } from 'lucide-react-native';
import { Colors, Radii, Typography } from '../../constants/AppTheme';

interface Props {
  visible: boolean;
  saving: boolean;
  plannedDate: Date | null;
  fitName: string;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onPlanDay: () => void;
}

export default function SaveBar({
  visible,
  saving,
  plannedDate,
  fitName,
  onNameChange,
  onSave,
  onPlanDay,
}: Props) {
  const insets = useSafeAreaInsets();
  const tabBarH = useBottomTabBarHeight();
  const bottomPad =
    tabBarH > 0 ? tabBarH + 8 : 52 + Math.max(insets.bottom, 10) + 8;
  const translateY = useSharedValue(100);

  useEffect(() => {
    translateY.value = withTiming(visible ? 0 : 100, { duration: 220 });
  }, [visible]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: translateY.value > 60 ? 0 : 1,
  }));

  return (
    <Animated.View
      style={[s.bar, { paddingBottom: bottomPad }, animStyle]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <TextInput
        style={s.nameInput}
        value={fitName}
        onChangeText={onNameChange}
        placeholder="Name this fit..."
        placeholderTextColor="rgba(0,0,0,0.25)"
        maxLength={40}
        returnKeyType="done"
      />

      <View style={s.actions}>
        <TouchableOpacity style={s.planBtn} onPress={onPlanDay} activeOpacity={0.8}>
          <CalendarDays
            size={15}
            color={plannedDate ? Colors.text : Colors.textMuted}
            strokeWidth={2}
          />
          <Text style={[s.planLabel, plannedDate && s.planLabelActive]}>
            {plannedDate
              ? plannedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : 'Plan day'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.saveBtn, saving && { opacity: 0.5 }]}
          onPress={onSave}
          disabled={saving}
          activeOpacity={0.86}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.saveLabel}>Save fit</Text>
          )}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 10,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 10,
  },
  nameInput: {
    height: 40,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radii.sm,
    paddingHorizontal: 14,
    fontSize: 14,
    fontWeight: Typography.weights.medium,
    color: Colors.text,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  planBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceAlt,
  },
  planLabel: {
    fontSize: 13,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    letterSpacing: -0.2,
  },
  planLabelActive: { color: Colors.text },
  saveBtn: {
    flex: 1,
    height: 48,
    backgroundColor: Colors.text,
    borderRadius: Radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveLabel: {
    fontSize: 15,
    fontWeight: Typography.weights.bold,
    color: '#fff',
    letterSpacing: -0.2,
  },
});
