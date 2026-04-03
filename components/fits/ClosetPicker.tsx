import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Modal,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import ClosetCategoryBrowse from '../closet/ClosetCategoryBrowse';
import { Colors } from '../../constants/AppTheme';
import { filterClosetPickerItems } from './closetCategories';
import type { ClosetItem } from './types';
import ClosetPickerPanel from './ClosetPickerPanel';

const { height: SH } = Dimensions.get('window');

interface Props {
  items: ClosetItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClose: () => void;
  mode?: 'manual' | 'anchors';
  initialCategory?: string;
}

export default function ClosetPicker({
  items,
  selected,
  onToggle,
  onClose,
  mode = 'manual',
  initialCategory,
}: Props) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(initialCategory || 'All');
  const [browseCategory, setBrowseCategory] = useState<string | null>(null);
  const translateY = useSharedValue(SH);

  const filtered = useMemo(
    () => filterClosetPickerItems(items, search, category),
    [items, search, category],
  );

  useEffect(() => {
    setCategory(initialCategory || 'All');
    setSearch('');
  }, [initialCategory]);

  useEffect(() => {
    translateY.value = withTiming(0, { duration: 320 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run open animation once on mount
  }, []);

  const dismissAfterSwipe = useCallback(() => onClose(), [onClose]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(14)
        .failOffsetX([-48, 48])
        .onUpdate((e) => {
          'worklet';
          if (e.translationY > 0) translateY.value = e.translationY;
        })
        .onEnd((e) => {
          'worklet';
          if (e.translationY > 120 || e.velocityY > 600) {
            translateY.value = withTiming(SH * 1.08, { duration: 220 }, (done) => {
              if (done) runOnJS(dismissAfterSwipe)();
            });
          } else {
            translateY.value = withTiming(0, { duration: 260 });
          }
        }),
    [dismissAfterSwipe, translateY],
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Modal transparent visible statusBarTranslucent animationType="none">
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <View style={s.overlay}>
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={1}
              onPress={onClose}
            />
            <GestureDetector gesture={gesture}>
              <Animated.View style={[s.sheet, animStyle]}>
                <View style={s.handle} />
                <ClosetPickerPanel
                  variant="modal"
                  showHeader
                  onDone={onClose}
                  items={items}
                  selected={selected}
                  onToggle={onToggle}
                  mode={mode}
                  category={category}
                  onCategoryChange={setCategory}
                  search={search}
                  onSearchChange={setSearch}
                  shelfItems={filtered}
                  externalBrowse={{
                    category: browseCategory,
                    onChange: setBrowseCategory,
                  }}
                />
              </Animated.View>
            </GestureDetector>
          </View>
          <ClosetCategoryBrowse
            presentation="overlay"
            visible={browseCategory !== null}
            categoryId={browseCategory}
            sourceItems={items}
            onClose={() => setBrowseCategory(null)}
            selectedIds={selected}
            onToggleId={onToggle}
          />
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingTop: '20%',
  },
  sheet: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
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
});
