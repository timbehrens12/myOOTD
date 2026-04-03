import { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Search } from 'lucide-react-native';
import { Colors, Radii, Typography } from '../../constants/AppTheme';
import ClosetCategoryBrowse from '../closet/ClosetCategoryBrowse';
import { ClosetShelfSections } from '../closet/ClosetShelfSections';
import { CLOSET_CATEGORY_CHIPS, filterClosetPickerItems } from './closetCategories';
import type { ClosetItem } from './types';

type PanelMode = 'manual' | 'anchors';

export function CategoryChipRow({
  category,
  onCategoryChange,
  style,
  contentContainerStyle,
}: {
  category: string;
  onCategoryChange: (c: string) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[ps.catRow, contentContainerStyle]}
      style={[{ flexGrow: 0 }, style]}
      bounces={false}
      alwaysBounceHorizontal={false}
    >
      {CLOSET_CATEGORY_CHIPS.map((c) => (
        <TouchableOpacity
          key={c}
          style={[ps.catChip, category === c && ps.catChipActive]}
          onPress={() => onCategoryChange(c)}
          activeOpacity={0.7}
        >
          <Text style={[ps.catChipText, category === c && ps.catChipTextActive]}>{c}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

export default function ClosetPickerPanel({
  items,
  selected,
  onToggle,
  mode,
  category,
  onCategoryChange,
  search,
  onSearchChange,
  variant,
  onDone,
  showHeader,
  contentBottomPad = 0,
  shelfItems: shelfItemsProp,
  externalBrowse,
}: {
  items: ClosetItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  mode: PanelMode;
  category: string;
  onCategoryChange: (c: string) => void;
  search: string;
  onSearchChange: (s: string) => void;
  variant: 'modal' | 'embedded';
  onDone?: () => void;
  showHeader: boolean;
  contentBottomPad?: number;
  /** When set (e.g. modal picker parent), shelves use this list; browse still uses full `items`. */
  shelfItems?: ClosetItem[];
  /** Parent owns category full-screen state and renders browse (avoids nested Modal). */
  externalBrowse?: {
    category: string | null;
    onChange: (id: string | null) => void;
  };
}) {
  const [internalBrowseCategory, setInternalBrowseCategory] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return filterClosetPickerItems(items, search, category);
  }, [items, search, category]);

  const forShelves = shelfItemsProp ?? filtered;
  const browseCategory = externalBrowse?.category ?? internalBrowseCategory;
  const setBrowseCategory = externalBrowse?.onChange ?? setInternalBrowseCategory;

  const gridPad = { paddingBottom: Math.max(32, contentBottomPad) };

  return (
    <View style={variant === 'embedded' ? ps.embeddedRoot : ps.modalBody}>
      {showHeader && (
        <View style={ps.header}>
          <View style={ps.headerText}>
            <Text style={ps.title}>{mode === 'anchors' ? 'Must-include pieces' : 'Your closet'}</Text>
            <Text style={ps.subtitle}>
              {mode === 'anchors'
                ? selected.size > 0
                  ? `${selected.size} pinned for AI`
                  : 'AI will try to build around these'
                : selected.size > 0
                  ? `${selected.size} in this outfit`
                  : 'Tap items to add or remove'}
            </Text>
          </View>
          {onDone && (
            <TouchableOpacity style={ps.doneBtn} onPress={onDone} activeOpacity={0.8}>
              <Text style={ps.doneBtnText}>{variant === 'embedded' ? 'Minimize' : 'Done'}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <View style={ps.searchBar}>
        <Search size={14} color={Colors.textMuted} strokeWidth={2} />
        <TextInput
          style={ps.searchInput}
          placeholder="Search items..."
          placeholderTextColor="rgba(0,0,0,0.25)"
          value={search}
          onChangeText={onSearchChange}
          clearButtonMode="while-editing"
        />
      </View>

      <ScrollView
        style={ps.gridScroll}
        contentContainerStyle={[ps.grid, gridPad]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        bounces={false}
        alwaysBounceVertical={false}
      >
        <ClosetShelfSections
          items={forShelves}
          onItemPress={(it) => onToggle(it.id)}
          selectedIds={selected}
          selectionMode
          enableViewAll
          onViewAllCategory={(id) => setBrowseCategory(id)}
          emptyHint="No items match your search"
        />
      </ScrollView>

      {!externalBrowse && (
        <ClosetCategoryBrowse
          presentation="modal"
          visible={browseCategory !== null}
          categoryId={browseCategory}
          sourceItems={items}
          onClose={() => setBrowseCategory(null)}
          selectedIds={selected}
          onToggleId={onToggle}
        />
      )}
    </View>
  );
}

const ps = StyleSheet.create({
  embeddedRoot: {
    flex: 1,
    minHeight: 0,
  },
  modalBody: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerText: { flex: 1, marginRight: 12 },
  title: {
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  subtitle: { fontSize: 12, color: Colors.textMuted, marginTop: 1 },
  doneBtn: {
    backgroundColor: Colors.black,
    borderRadius: Radii.full,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  doneBtnText: { fontSize: 13, fontWeight: Typography.weights.bold, color: '#fff' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: Colors.text },
  catRow: {
    paddingHorizontal: 16,
    gap: 8,
    paddingBottom: 12,
  },
  catChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: Radii.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  catChipActive: { backgroundColor: Colors.black, borderColor: Colors.black },
  catChipText: {
    fontSize: 12,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  catChipTextActive: { color: '#fff' },
  gridScroll: { flex: 1, minHeight: 0 },
  grid: { paddingHorizontal: 0, gap: 0 },
});
