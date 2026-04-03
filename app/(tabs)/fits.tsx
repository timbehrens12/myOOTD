/**
 * fits.tsx — myOOTD Fits tab
 *
 * Create — playground (Surprise me, quick looks, try-on) + optional manual builder
 * Library — saved lookbook
 */

import { useUser } from '@clerk/clerk-expo';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { Colors, Radii, Typography } from '../../constants/AppTheme';
import { supabase } from '../../lib/supabase';
import type { ClosetItem, SavedFit } from '../../components/fits/types';

import BuilderPanel from '../../components/fits/BuilderPanel';
import FitLibrary from '../../components/fits/FitLibrary';
import FitDetailSheet from '../../components/fits/FitDetailSheet';
import { DEV_FAKE_SAVED_FITS } from '../../lib/devFitSeeds';

// ─── SEGMENTED TOGGLE ─────────────────────────────────────────────────────────

function SegmentedToggle({
  options,
  active,
  onChange,
}: {
  options: string[];
  active: number;
  onChange: (i: number) => void;
}) {
  return (
    <View style={seg.track}>
      {options.map((label, i) => (
        <TouchableOpacity
          key={label}
          style={[seg.pill, active === i && seg.pillActive]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onChange(i);
          }}
          activeOpacity={0.8}
        >
          <Text style={[seg.label, active === i && seg.labelActive]}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const seg = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radii.full,
    padding: 3,
    alignSelf: 'center',
  },
  pill: {
    paddingHorizontal: 26,
    paddingVertical: 9,
    borderRadius: Radii.full,
  },
  pillActive: {
    backgroundColor: Colors.surface,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
    letterSpacing: -0.2,
  },
  labelActive: { color: Colors.text },
});

// ─── ROOT SCREEN ──────────────────────────────────────────────────────────────

export default function FitsScreen() {
  const { user } = useUser();
  const insets = useSafeAreaInsets();

  const [activeTab, setActiveTab] = useState(0);

  const [fits, setFits] = useState<SavedFit[]>([]);
  const [loadingFits, setLoadingFits] = useState(true);

  const [closetItems, setClosetItems] = useState<ClosetItem[]>([]);
  const [loadingCloset, setLoadingCloset] = useState(false);

  const [detailFit, setDetailFit] = useState<SavedFit | null>(null);

  useFocusEffect(
    useCallback(() => {
      fetchFits();
      fetchCloset();
    }, [user?.id]),
  );

  const normalizeOutfitRow = (row: Record<string, unknown>): SavedFit => {
    const items = row.items;
    const legacyIds = row.item_ids;
    const item_ids = Array.isArray(items)
      ? (items as string[])
      : Array.isArray(legacyIds)
        ? (legacyIds as string[])
        : [];
    return {
      id: row.id as string,
      name: (row.name as string) ?? null,
      occasion: (row.occasion as string) ?? null,
      planned_date: (row.planned_date as string) ?? null,
      image_url: (row.image_url as string) ?? null,
      created_at: row.created_at as string,
      item_ids,
      worn_on: (row.worn_on as string) ?? null,
    };
  };

  const fetchFits = async () => {
    if (!user?.id) {
      setLoadingFits(false);
      return;
    }
    try {
      let rawRows: Record<string, unknown>[] | null = null;

      const q1 = await supabase
        .from('outfits')
        .select(
          'id, name, occasion, planned_date, image_url, created_at, items, worn_on',
        )
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!q1.error && q1.data) {
        rawRows = q1.data as unknown as Record<string, unknown>[];
      } else {
        const q2 = await supabase
          .from('outfits')
          .select('id, name, occasion, planned_date, image_url, created_at, items')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
        if (!q2.error && q2.data) {
          rawRows = q2.data as unknown as Record<string, unknown>[];
        } else {
          const q3 = await supabase
            .from('outfits')
            .select('id, name, occasion, planned_date, image_url, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });
          if (!q3.error && q3.data) {
            rawRows = q3.data as unknown as Record<string, unknown>[];
          }
        }
      }

      if (rawRows) {
        let next = rawRows.map((r) => normalizeOutfitRow(r));
        if (__DEV__) {
          next = [...DEV_FAKE_SAVED_FITS, ...next];
        }
        setFits(next);
      }
    } catch {
      // show empty state silently
    } finally {
      setLoadingFits(false);
    }
  };

  const fetchCloset = async () => {
    if (!user?.id) return;
    setLoadingCloset(true);
    try {
      const { data, error } = await supabase
        .from('clothing_items')
        .select('id, name, category, color, image_url, type, style, occasions')
        .order('created_at', { ascending: false })
        .limit(120);
      if (!error && data) setClosetItems(data as ClosetItem[]);
    } catch {
      // non-critical
    } finally {
      setLoadingCloset(false);
    }
  };

  const handleDeleteFit = (id: string) => {
    setFits((prev) => prev.filter((f) => f.id !== id));
    if (id.startsWith('dev-')) return;
    supabase.from('outfits').delete().eq('id', id).then(() => {});
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[root.screen, { paddingTop: insets.top }]}>
        {/* Header toggle */}
        <View style={root.toggleRow}>
          <View style={root.toggleBlock}>
            <SegmentedToggle
              options={['Create', 'Library']}
              active={activeTab}
              onChange={setActiveTab}
            />
          </View>
          {activeTab === 1 && fits.length > 0 ? (
            <Text style={root.countLabel}>{fits.length} saved</Text>
          ) : null}
        </View>

        {/* Content */}
        {activeTab === 0 ? (
          <BuilderPanel
            closetItems={closetItems}
            loadingCloset={loadingCloset}
            onSavedFit={() => {
              fetchFits();
              setActiveTab(1);
            }}
            userId={user?.id}
          />
        ) : (
          <View style={root.libraryWrap}>
            <FitLibrary
              fits={fits}
              closetItems={closetItems}
              loading={loadingFits}
              onSwitchBuilder={() => setActiveTab(0)}
              onFitPress={(f) => setDetailFit(f)}
              onFitLongPress={(f) => setDetailFit(f)}
            />
          </View>
        )}

        {/* Detail sheet */}
        <FitDetailSheet
          fit={detailFit}
          visible={!!detailFit}
          onClose={() => setDetailFit(null)}
          onDelete={handleDeleteFit}
          closetItems={closetItems}
        />
      </View>
    </GestureHandlerRootView>
  );
}

const root = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    position: 'relative',
  },
  toggleBlock: {
    alignItems: 'center',
  },
  countLabel: {
    position: 'absolute',
    right: 20,
    fontSize: 13,
    fontWeight: Typography.weights.medium,
    color: Colors.textMuted,
  },
  libraryWrap: { flex: 1 },
});
