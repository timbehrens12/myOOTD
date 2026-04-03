import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { X } from 'lucide-react-native';
import {
  APP_FILTER_COLORS,
  APP_ITEM_NAMED_COLORS,
  namedIdFromItemColorString,
  nearestNamedFilterId,
} from '../../constants/appNamedColors';
import { Radii, Typography } from '../../constants/AppTheme';
import { hexToHsv, hsvToHex } from './colorMath';

const { width: SW } = Dimensions.get('window');
const PALETTE_COLS = 6;
const PALETTE_GAP = 8;
const PALETTE_PAD = 16 * 2;
const PALETTE_CELL = Math.floor((SW - PALETTE_PAD - PALETTE_GAP * (PALETTE_COLS - 1)) / PALETTE_COLS);
const HUE_STRIP_H = 36;

type PaletteCell = { all?: true; hex?: string; id?: string };

function buildPaletteCells(variant: 'filter' | 'item'): PaletteCell[] {
  const cells: PaletteCell[] = [];
  if (variant === 'filter') cells.push({ all: true });
  for (const c of APP_ITEM_NAMED_COLORS) {
    cells.push({ hex: c.swatch, id: c.id });
  }
  return cells;
}

type Tab = 'grid' | 'spectrum' | 'sliders';

type BaseProps = {
  visible: boolean;
  onClose: () => void;
};

export type FilterColorPickerProps = BaseProps & {
  variant: 'filter';
  filterValueId: string;
  onSelectFilterId: (id: string) => void;
};

export type ItemColorPickerProps = BaseProps & {
  variant: 'item';
  itemValue: string;
  onSelectItem: (color: string) => void;
};

export type IosStyleColorPickerModalProps = FilterColorPickerProps | ItemColorPickerProps;

function initialHex(variant: 'filter' | 'item', filterValueId: string, itemValue: string): string {
  if (variant === 'filter') {
    if (filterValueId === 'all') return '#808080';
    const e = APP_FILTER_COLORS.find((c) => c.id === filterValueId);
    if (e?.swatch) return e.swatch;
    return '#808080';
  }
  const v = (itemValue || '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(v)) return v.toUpperCase();
  const id = namedIdFromItemColorString(v);
  if (id) {
    const e = APP_ITEM_NAMED_COLORS.find((c) => c.id === id);
    if (e) return e.swatch;
  }
  return '#CCCCCC';
}

function itemOutputString(hex: string): string {
  const up = hex.toUpperCase();
  const match = APP_ITEM_NAMED_COLORS.find((c) => c.swatch.toUpperCase() === up);
  return match ? match.id : up;
}

export default function IosStyleColorPickerModal(props: IosStyleColorPickerModalProps) {
  const insets = useSafeAreaInsets();
  const { visible, onClose, variant } = props;

  const [tab, setTab] = useState<Tab>('grid');
  const [allSelected, setAllSelected] = useState(variant === 'filter' && props.filterValueId === 'all');
  const [h, setH] = useState(210);
  const [s, setS] = useState(0.85);
  const [v, setV] = useState(0.95);

  const spectrumRef = useRef<View>(null);
  const hueRef = useRef<View>(null);
  const sTrackRef = useRef<View>(null);
  const vTrackRef = useRef<View>(null);
  const hTrackRef = useRef<View>(null);

  const previewHex = useMemo(() => {
    if (variant === 'filter' && allSelected) return '#FFFFFF';
    return hsvToHex(h, s, v);
  }, [allSelected, h, s, v, variant]);

  const syncHsvFromHex = useCallback((hex: string) => {
    const t = hexToHsv(hex);
    if (t) {
      setH(t.h);
      setS(t.s);
      setV(t.v);
    }
  }, []);

  const filterId = props.variant === 'filter' ? props.filterValueId : '';
  const itemVal = props.variant === 'item' ? props.itemValue : '';

  useEffect(() => {
    if (!visible) return;
    const hex =
      variant === 'filter'
        ? initialHex('filter', filterId, '')
        : initialHex('item', '', itemVal);
    syncHsvFromHex(hex);
    setAllSelected(variant === 'filter' && filterId === 'all');
    setTab('grid');
  }, [visible, variant, filterId, itemVal, syncHsvFromHex]);

  const paletteCells = useMemo(() => buildPaletteCells(variant), [variant]);

  const selectedFilterNamed =
    variant === 'filter' && !allSelected && filterId !== 'all' ? filterId : null;
  const selectedItemNamed =
    variant === 'item' ? namedIdFromItemColorString(itemVal) : null;

  const isPaletteCellSelected = useCallback(
    (cell: PaletteCell): boolean => {
      if (cell.all) return allSelected;
      if (!cell.hex) return false;
      if (cell.id) {
        if (variant === 'filter' && selectedFilterNamed && cell.id === selectedFilterNamed) return true;
        if (variant === 'item' && selectedItemNamed && cell.id === selectedItemNamed) return true;
      }
      return !allSelected && previewHex.toUpperCase() === cell.hex.toUpperCase();
    },
    [allSelected, previewHex, selectedFilterNamed, selectedItemNamed, variant],
  );

  const measureAndUpdate = useCallback(
    (
      ref: { current: View | null },
      pageX: number,
      pageY: number,
      kind: 'sv' | 'hue' | 'sliderS' | 'sliderV' | 'sliderH',
    ) => {
      ref.current?.measureInWindow((fx, fy, w, h) => {
        const x = Math.max(0, Math.min(w, pageX - fx));
        const y = Math.max(0, Math.min(h, pageY - fy));
        if (kind === 'sv') {
          setS(Math.max(0, Math.min(1, x / w)));
          setV(Math.max(0, Math.min(1, 1 - y / h)));
          setAllSelected(false);
        } else if (kind === 'hue') {
          setH(Math.max(0, Math.min(360, (x / w) * 360)));
          setAllSelected(false);
        } else if (kind === 'sliderH') {
          setH(Math.max(0, Math.min(360, (x / w) * 360)));
          setAllSelected(false);
        } else if (kind === 'sliderS') {
          setS(Math.max(0, Math.min(1, x / w)));
          setAllSelected(false);
        } else if (kind === 'sliderV') {
          setV(Math.max(0, Math.min(1, x / w)));
          setAllSelected(false);
        }
      });
    },
    [],
  );

  const spectrumTouch = (e: GestureResponderEvent, kind: 'sv' | 'hue' | 'sliderS' | 'sliderV' | 'sliderH') => {
    const { pageX, pageY } = e.nativeEvent;
    if (kind === 'sv') measureAndUpdate(spectrumRef, pageX, pageY, 'sv');
    else if (kind === 'hue') measureAndUpdate(hueRef, pageX, pageY, 'hue');
    else if (kind === 'sliderH') measureAndUpdate(hTrackRef, pageX, pageY, 'sliderH');
    else if (kind === 'sliderS') measureAndUpdate(sTrackRef, pageX, pageY, 'sliderS');
    else if (kind === 'sliderV') measureAndUpdate(vTrackRef, pageX, pageY, 'sliderV');
  };

  const applyAndClose = () => {
    if (props.variant === 'filter') {
      if (allSelected) props.onSelectFilterId('all');
      else props.onSelectFilterId(nearestNamedFilterId(previewHex));
    } else {
      props.onSelectItem(itemOutputString(previewHex));
    }
    onClose();
  };

  const onPaletteCell = (cell: PaletteCell) => {
    if (cell.all) {
      setAllSelected(true);
      return;
    }
    if (cell.hex) {
      setAllSelected(false);
      syncHsvFromHex(cell.hex);
    }
  };

  const hueRight = hsvToHex(h, 1, 1);
  const sliderHFill = hsvToHex(h, 1, 1);

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <View style={styles.headerIcon} />
            <Text style={styles.headerTitle}>Colors</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.headerIcon} accessibilityLabel="Close">
              <X size={22} color="#000" strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <View style={styles.segment}>
            {(['grid', 'spectrum', 'sliders'] as const).map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.segmentChip, tab === t && styles.segmentChipOn]}
                onPress={() => setTab(t)}
                activeOpacity={0.85}
              >
                <Text style={[styles.segmentText, tab === t && styles.segmentTextOn]}>
                  {t === 'grid' ? 'Grid' : t === 'spectrum' ? 'Spectrum' : 'Sliders'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView
            style={styles.bodyScroll}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {tab === 'grid' && (
              <View style={styles.paletteWrap}>
                {paletteCells.map((cell) => {
                  if (cell.all) {
                    return (
                      <TouchableOpacity
                        key="all"
                        style={[
                          styles.paletteCell,
                          styles.gridCellAll,
                          isPaletteCellSelected(cell) && styles.gridCellOn,
                        ]}
                        onPress={() => onPaletteCell(cell)}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.gridAllText}>A</Text>
                      </TouchableOpacity>
                    );
                  }
                  const hex = cell.hex!;
                  const on = isPaletteCellSelected(cell);
                  return (
                    <TouchableOpacity
                      key={cell.id}
                      style={[
                        styles.paletteCell,
                        { backgroundColor: hex },
                        hex.toUpperCase() === '#FFFFFF' && styles.gridCellWhite,
                        hex.toUpperCase() === '#000000' && styles.gridCellBlack,
                        on && styles.gridCellOn,
                      ]}
                      onPress={() => onPaletteCell(cell)}
                      activeOpacity={0.85}
                    />
                  );
                })}
              </View>
            )}

            {tab === 'spectrum' && (
              <View style={styles.spectrumBlock}>
                <View
                  ref={spectrumRef}
                  style={styles.svBox}
                  onTouchStart={(e) => spectrumTouch(e, 'sv')}
                  onTouchMove={(e) => spectrumTouch(e, 'sv')}
                >
                  <LinearGradient
                    colors={['#FFFFFF', hueRight]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <LinearGradient
                    colors={['transparent', '#000000']}
                    start={{ x: 0.5, y: 0 }}
                    end={{ x: 0.5, y: 1 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <View
                    pointerEvents="none"
                    style={[
                      styles.svKnob,
                      {
                        left: `${s * 100}%`,
                        top: `${(1 - v) * 100}%`,
                      },
                    ]}
                  />
                </View>
                <View
                  ref={hueRef}
                  style={styles.hueStrip}
                  onTouchStart={(e) => spectrumTouch(e, 'hue')}
                  onTouchMove={(e) => spectrumTouch(e, 'hue')}
                >
                  <LinearGradient
                    colors={['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FF0000']}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View
                    pointerEvents="none"
                    style={[styles.hueKnob, { left: `${(h / 360) * 100}%` }]}
                  />
                </View>
              </View>
            )}

            {tab === 'sliders' && (
              <View style={styles.slidersBlock}>
                <Text style={styles.sliderLabel}>Hue</Text>
                <View
                  ref={hTrackRef}
                  style={styles.sliderTrack}
                  onTouchStart={(e) => spectrumTouch(e, 'sliderH')}
                  onTouchMove={(e) => spectrumTouch(e, 'sliderH')}
                >
                  <LinearGradient
                    colors={['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FF0000']}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View style={[styles.sliderThumb, { left: `${(h / 360) * 100}%`, borderColor: sliderHFill }]} />
                </View>
                <Text style={styles.sliderLabel}>Saturation</Text>
                <View
                  ref={sTrackRef}
                  style={styles.sliderTrack}
                  onTouchStart={(e) => spectrumTouch(e, 'sliderS')}
                  onTouchMove={(e) => spectrumTouch(e, 'sliderS')}
                >
                  <LinearGradient
                    colors={[hsvToHex(h, 0, v), hsvToHex(h, 1, v)]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View style={[styles.sliderThumb, { left: `${s * 100}%` }]} />
                </View>
                <Text style={styles.sliderLabel}>Brightness</Text>
                <View
                  ref={vTrackRef}
                  style={styles.sliderTrack}
                  onTouchStart={(e) => spectrumTouch(e, 'sliderV')}
                  onTouchMove={(e) => spectrumTouch(e, 'sliderV')}
                >
                  <LinearGradient
                    colors={['#000000', hsvToHex(h, s, 1)]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View style={[styles.sliderThumb, { left: `${v * 100}%` }]} />
                </View>
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <View style={[styles.previewSwatch, { backgroundColor: previewHex }]}>
              {variant === 'filter' && allSelected ? (
                <Text style={styles.previewAll}>A</Text>
              ) : null}
            </View>
            <TouchableOpacity style={styles.doneBtn} onPress={applyAndClose} activeOpacity={0.9}>
              <Text style={styles.doneBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: '#F2F2F7',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '88%',
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.12)',
    marginTop: 8,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  headerIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    fontSize: 17,
    fontWeight: Typography.weights.bold,
    color: '#000',
    letterSpacing: -0.3,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 10,
    padding: 3,
    marginBottom: 14,
    gap: 2,
  },
  segmentChip: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentChipOn: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: { fontSize: 13, fontWeight: Typography.weights.semibold, color: 'rgba(0,0,0,0.45)' },
  segmentTextOn: { color: '#000' },
  bodyScroll: { maxHeight: 420 },
  bodyContent: { paddingBottom: 12 },
  paletteWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: PALETTE_GAP,
  },
  paletteCell: {
    width: PALETTE_CELL,
    height: PALETTE_CELL,
    borderRadius: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridCellAll: { backgroundColor: 'rgba(0,0,0,0.05)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  gridCellWhite: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.18)' },
  gridCellBlack: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' },
  gridCellOn: { borderWidth: 2, borderColor: '#000' },
  gridAllText: { fontSize: 11, fontWeight: '800', color: 'rgba(0,0,0,0.45)' },
  spectrumBlock: { gap: 12 },
  svBox: {
    height: 200,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  svKnob: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#FFF',
    marginLeft: -11,
    marginTop: -11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
  },
  hueStrip: {
    height: HUE_STRIP_H,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  hueKnob: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 4,
    marginLeft: -2,
    borderRadius: 2,
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.25)',
  },
  slidersBlock: { gap: 10 },
  sliderLabel: { fontSize: 12, fontWeight: '600', color: 'rgba(0,0,0,0.45)' },
  sliderTrack: {
    height: 32,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    marginBottom: 6,
  },
  sliderThumb: {
    position: 'absolute',
    top: '50%',
    width: 22,
    height: 22,
    marginLeft: -11,
    marginTop: -11,
    borderRadius: 11,
    backgroundColor: '#FFF',
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.2)',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  previewSwatch: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewAll: { fontSize: 16, fontWeight: '800', color: 'rgba(0,0,0,0.35)' },
  doneBtn: {
    flex: 1,
    backgroundColor: '#000',
    paddingVertical: 14,
    borderRadius: Radii.full,
    alignItems: 'center',
  },
  doneBtnText: { fontSize: 16, fontWeight: Typography.weights.bold, color: '#FFF' },
});
