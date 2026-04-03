import { useCallback, useEffect } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { X } from 'lucide-react-native';
import { Colors, Typography } from '../../constants/AppTheme';

const { height: SH } = Dimensions.get('window');

interface Props {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  snapHeight?: number;
  title?: string;
}

export default function BottomSheet({
  visible,
  onClose,
  children,
  snapHeight = SH * 0.75,
  title,
}: Props) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(snapHeight);

  useEffect(() => {
    translateY.value = visible
      ? withTiming(0, { duration: 240 })
      : withTiming(snapHeight, { duration: 280 });
  }, [visible]);

  const dismiss = useCallback(() => {
    translateY.value = withTiming(snapHeight, { duration: 260 }, () =>
      runOnJS(onClose)(),
    );
  }, [snapHeight, onClose]);

  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > snapHeight * 0.35 || e.velocityY > 600) {
        runOnJS(dismiss)();
      } else {
        translateY.value = withTiming(0, { duration: 200 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Pressable style={s.backdrop} onPress={dismiss}>
          <BlurView intensity={18} tint="light" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.22)' }]} />
        </Pressable>
        <GestureDetector gesture={panGesture}>
          <Animated.View
            style={[s.sheet, { height: snapHeight, paddingBottom: insets.bottom + 8 }, sheetStyle]}
          >
            <View style={s.handle} />
            {title ? (
              <View style={s.header}>
                <Text style={s.headerTitle}>{title}</Text>
                <TouchableOpacity onPress={dismiss} hitSlop={10}>
                  <View style={s.closeBtn}>
                    <X size={14} color={Colors.text} strokeWidth={2.5} />
                  </View>
                </TouchableOpacity>
              </View>
            ) : null}
            {children}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderTopWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 20,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.12)',
    marginTop: 10,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.4,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
