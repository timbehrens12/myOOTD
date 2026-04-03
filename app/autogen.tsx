import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView,
  Dimensions, Modal, Alert, TextInput,
  TouchableWithoutFeedback, ActivityIndicator, Image,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import Svg, { Path, Circle } from 'react-native-svg';
import { useUser } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { Colors } from '../constants/AppTheme';
import ColorPickerTriggerIcon from '../components/color-picker/ColorPickerTriggerIcon';
import IosStyleColorPickerModal from '../components/color-picker/IosStyleColorPickerModal';
import { OCCASIONS_FLAT } from '../constants/occasions';
import * as Notifications from 'expo-notifications';
import ClosetCategoryBrowse from '../components/closet/ClosetCategoryBrowse';
import { ClosetShelfSections } from '../components/closet/ClosetShelfSections';

const { width } = Dimensions.get('window');

// ── Layout math so days + time always fit on one row, occasions always 4-per-row ──
const SCROLL_PAD = 20 * 2;   // paddingHorizontal on scrollContent
const CARD_PAD   = 16 * 2;   // padding inside sc.card
const CARD_W     = width - SCROLL_PAD - CARD_PAD;   // usable content width
const TIME_PILL_W = 90;       // approx rendered width of the time pill
const DAY_ROW_GAP = 8;        // gap between time pill and days row
const DAY_DOT_GAP = 4;        // gap between individual day dots
const DAY_DOT_SIZE = Math.floor((CARD_W - TIME_PILL_W - DAY_ROW_GAP - DAY_DOT_GAP * 6) / 7);
const OCC_GAP    = 6;

// ─── TYPES ─────────────────────────────────────────────────────────────────
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface Schedule {
  id: string;
  label: string;
  occasion: string;
  time_hour: number;
  time_minute: number;
  days_of_week: DayOfWeek[];
  anchor_item_ids: string[];
  is_active: boolean;
}

interface ClothingItem {
  id: string;
  name: string;
  category: string;
  type: string;
  color: string;
  image_url: string;
  occasions: string[];
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// ─── ICONS ──────────────────────────────────────────────────────────────────
const PlusIcon = ({ color = '#000' }: { color?: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const CloseIcon = () => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <Path d="M18 6L6 18M6 6l12 12" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const TrashIcon = () => (
  <Svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <Path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="rgba(255,100,100,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const ClockIcon = ({ color = '#000' }: { color?: string }) => (
  <Svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <Circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" />
    <Path d="M12 7v5l3 3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const PencilIcon = () => (
  <Svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <Path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="rgba(0,0,0,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const formatTime = (hour: number, minute: number) => {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m} ${period}`;
};

const createDefaultSchedule = (): Schedule => ({
  id: `local_${Date.now()}`,
  label: '',
  occasion: '',
  time_hour: 8,
  time_minute: 0,
  days_of_week: [1, 2, 3, 4, 5],
  anchor_item_ids: [],
  is_active: true,
});

async function scheduleNotificationsForSlot(schedule: Schedule) {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of all) {
    if ((n.content.data as any)?.scheduleId === schedule.id) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }
  if (!schedule.is_active) return;
  const occasion = OCCASIONS_FLAT.find(o => o.id === schedule.occasion);
  for (const day of schedule.days_of_week) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `✨ Your ${occasion?.label ?? 'Outfit'} fit is ready`,
        body: `"${schedule.label}" — tap to see your look for today.`,
        data: { scheduleId: schedule.id, screen: 'autogen' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: day === 0 ? 1 : day + 1,
        hour: schedule.time_hour,
        minute: schedule.time_minute,
      },
    });
  }
}

// ─── CLOSET PICKER COMPONENT ────────────────────────────────────────────────
const ClosetPicker = ({ 
  items, 
  selectedIds, 
  onToggle, 
  onDone 
}: { 
  items: ClothingItem[]; 
  selectedIds: string[]; 
  onToggle: (id: string) => void; 
  onDone: () => void;
}) => {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('All');
  const [colorFilter, setColorFilter] = useState('All');
  const [autogenColorPickerOpen, setAutogenColorPickerOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [browseCategory, setBrowseCategory] = useState<string | null>(null);

  const tabs = ['All', 'Casual', 'Work', 'Gym', 'Travel', 'Night Out'];

  const filtered = useMemo(() => {
    return items.filter((item) => {
      const q = search.toLowerCase();
      const name = (item.name || item.category || '').toLowerCase();
      if (!name.includes(q)) return false;

      if (activeTab !== 'All') {
        const occs = item.occasions || [];
        if (!occs.includes(activeTab.toLowerCase().replace(' ', '-'))) return false;
      }

      if (colorFilter !== 'All') {
        if (!(item.color || '').toLowerCase().includes(colorFilter.toLowerCase())) return false;
      }

      return true;
    });
  }, [items, search, activeTab, colorFilter]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <View style={{ flex: 1 }}>
    <View style={sc.itemPickerSheet}>
      <View style={sc.itemPickerHeader}>
        <Text style={sc.itemPickerTitle}>Closet</Text>
        <TouchableOpacity onPress={onDone}><Text style={sc.itemPickerDone}>Done</Text></TouchableOpacity>
      </View>

      <View style={cp.searchBar}>
        <TextInput 
          style={cp.searchInput}
          placeholder="Search closet"
          placeholderTextColor="rgba(0,0,0,0.3)"
          value={search}
          onChangeText={setSearch}
        />
        <TouchableOpacity onPress={() => setShowFilters(!showFilters)} style={cp.filterToggle}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <ColorPickerTriggerIcon size={18} />
            <Text style={{ color: showFilters ? Colors.accent : '#000', fontSize: 10, fontWeight: '800' }}>FILTER</Text>
          </View>
        </TouchableOpacity>
      </View>

      {showFilters && (
        <View style={cp.filters}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cp.tabs}>
            {tabs.map((tab) => (
              <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)} style={cp.tabBtn}>
                <Text style={[cp.tabText, activeTab === tab && cp.tabTextActive]}>{tab}</Text>
                {activeTab === tab ? <View style={cp.tabIndicator} /> : null}
              </TouchableOpacity>
            ))}
          </ScrollView>
          
          <View style={cp.colorPickerRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={cp.colorPickerLabel}>Color</Text>
              <Text style={cp.colorPickerValue} numberOfLines={1}>{colorFilter}</Text>
            </View>
            <TouchableOpacity
              onPress={() => setAutogenColorPickerOpen(true)}
              style={cp.colorPickerIconHit}
              accessibilityLabel="Open color picker"
              activeOpacity={0.85}
            >
              <ColorPickerTriggerIcon size={34} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <ClosetShelfSections
          items={filtered}
          onItemPress={(it) => onToggle(it.id)}
          selectedIds={selectedSet}
          selectionMode
          enableViewAll
          onViewAllCategory={(id) => setBrowseCategory(id)}
          emptyHint="No items found"
        />
      </ScrollView>
    </View>
    <ClosetCategoryBrowse
      presentation="overlay"
      visible={browseCategory !== null}
      categoryId={browseCategory}
      sourceItems={items}
      onClose={() => setBrowseCategory(null)}
      selectedIds={selectedSet}
      onToggleId={onToggle}
    />
    <IosStyleColorPickerModal
      variant="filter"
      visible={autogenColorPickerOpen}
      onClose={() => setAutogenColorPickerOpen(false)}
      filterValueId={colorFilter === 'All' ? 'all' : colorFilter}
      onSelectFilterId={(id) => {
        setColorFilter(id === 'all' ? 'All' : id);
        setAutogenColorPickerOpen(false);
      }}
    />
    </View>
  );
};

const TimePicker = ({ hour, minute, onChange, onClose }: { hour: number; minute: number; onChange: (h: number, m: number) => void; onClose: () => void }) => {
  const initialH12 = hour % 12 === 0 ? 12 : hour % 12;
  const initialAMPM = hour >= 12 ? 'PM' : 'AM';
  
  const [h12, setH12] = useState(initialH12);
  const [m, setM] = useState(minute);
  const [ampm, setAMPM] = useState(initialAMPM);

  const confirm = () => {
    let finalH = h12 % 12;
    if (ampm === 'PM') finalH += 12;
    onChange(finalH, m);
    onClose();
  };

  return (
    <View style={tp.container}>
      <Text style={tp.title}>Set Time</Text>
      <View style={tp.pickerRow}>
        <View style={tp.column}>
          <ScrollView style={tp.scroll} showsVerticalScrollIndicator={false}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(hr => (
              <TouchableOpacity key={hr} style={[tp.item, h12 === hr && tp.itemActive]} onPress={() => setH12(hr)}>
                <Text style={[tp.itemText, h12 === hr && tp.itemTextActive]}>{hr}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
        <Text style={tp.colon}>:</Text>
        <View style={tp.column}>
          <ScrollView style={tp.scroll} showsVerticalScrollIndicator={false}>
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(min => (
              <TouchableOpacity key={min} style={[tp.item, m === min && tp.itemActive]} onPress={() => setM(min)}>
                <Text style={[tp.itemText, m === min && tp.itemTextActive]}>{min.toString().padStart(2, '0')}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
        <View style={[tp.column, { marginLeft: 10 }]}>
          <View style={tp.scroll}>
            {['AM', 'PM'].map(p => (
              <TouchableOpacity key={p} style={[tp.item, ampm === p && tp.itemActive, { height: 80 }]} onPress={() => setAMPM(p as 'AM' | 'PM')}>
                <Text style={[tp.itemText, ampm === p && tp.itemTextActive]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
      <View style={tp.actions}>
        <TouchableOpacity style={tp.cancelBtn} onPress={onClose}><Text style={tp.cancelText}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={tp.confirmBtn} onPress={confirm}><Text style={tp.confirmText}>Confirm</Text></TouchableOpacity>
      </View>
    </View>
  );
};

const ScheduleCard = ({ schedule, closetItems, onChange, onDelete, index }: { schedule: Schedule, closetItems: ClothingItem[], onChange: (u: Schedule) => void, onDelete: () => void, index: number }) => {
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showItemPicker, setShowItemPicker] = useState(false);
  const [editing, setEditing] = useState(false);
  const [labelText, setLabelText] = useState(schedule.label);

  useEffect(() => {
    setLabelText(schedule.label);
  }, [schedule.label]);

  const toggleDay = (day: DayOfWeek) => {
    const next = schedule.days_of_week.includes(day) ? schedule.days_of_week.filter(d => d !== day) : [...schedule.days_of_week, day].sort() as DayOfWeek[];
    onChange({ ...schedule, days_of_week: next });
  };

  const toggleAnchor = (itemId: string) => {
    const next = schedule.anchor_item_ids.includes(itemId) ? schedule.anchor_item_ids.filter(id => id !== itemId) : [...schedule.anchor_item_ids, itemId];
    onChange({ ...schedule, anchor_item_ids: next });
  };

  const anchorItems = closetItems.filter(c => schedule.anchor_item_ids.includes(c.id));

  return (
    <Animated.View entering={FadeInDown.delay(index * 60)} style={sc.card}>
      <View style={sc.header}>
        <View style={sc.headerLeft}>
          <TouchableOpacity 
            style={[sc.powerBtn, schedule.is_active ? sc.powerBtnActive : sc.powerBtnPaused]}
            onPress={() => onChange({ ...schedule, is_active: !schedule.is_active })}
          >
            <View style={[sc.powerDot, schedule.is_active && { backgroundColor: '#FFF' } /* dot stays white on black active bg */]} />
            <Text style={[sc.powerText, schedule.is_active && { color: '#000' }]}>{schedule.is_active ? 'ACTIVE' : 'PAUSED'}</Text>
          </TouchableOpacity>
          {editing ? (
            <TextInput 
              style={sc.labelInput} 
              placeholder="Name..." 
              placeholderTextColor="rgba(0,0,0,0.25)"
              value={labelText} 
              onChangeText={setLabelText} 
              onBlur={() => { onChange({ ...schedule, label: labelText }); setEditing(false); }} 
              autoFocus 
              maxLength={28} 
            />
          ) : (
            <TouchableOpacity onPress={() => setEditing(true)} style={sc.labelContainer}>
              <Text 
                style={[sc.label, !schedule.label && { color: 'rgba(0,0,0,0.25)' }, !schedule.is_active && { opacity: 0.4 }]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {schedule.label || 'Name schedule...'}
              </Text>
              <PencilIcon />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={onDelete} style={sc.trashBtn}><TrashIcon /></TouchableOpacity>
      </View>

      {schedule.is_active && (
        <>
          <View style={sc.detailsStack}>
            {/* Time + days — always one row */}
            <View style={sc.timeAndDaysRow}>
              <TouchableOpacity style={sc.timePill} onPress={() => setShowTimePicker(true)}>
                <ClockIcon color={Colors.accent} />
                <Text style={sc.timePillText}>{formatTime(schedule.time_hour, schedule.time_minute)}</Text>
              </TouchableOpacity>
              <View style={sc.daysRow}>
                {DAYS.map((d, i) => {
                  const active = schedule.days_of_week.includes(i as DayOfWeek);
                  return (
                    <TouchableOpacity
                      key={i}
                      style={[sc.dayDot, active && sc.dayDotActive]}
                      onPress={() => toggleDay(i as DayOfWeek)}
                    >
                      <Text style={[sc.dayText, active && sc.dayTextActive]}>{d}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Occasions — horizontal scrollable */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={sc.occScroll}>
              {OCCASIONS_FLAT.map(occ => (
                <TouchableOpacity
                  key={occ.id}
                  style={[sc.occChip, schedule.occasion === occ.id && sc.occChipActive]}
                  onPress={() => {
                    const next = { ...schedule, occasion: occ.id };
                    if (!next.label.trim()) next.label = `${occ.label} OOTD`;
                    onChange(next);
                  }}
                >
                  <Text style={[sc.occLabel, schedule.occasion === occ.id && sc.occLabelActive]} numberOfLines={1}>{occ.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
          <View style={sc.anchorSection}>
            <View style={sc.anchorHeader}>
              <Text style={sc.anchorTitle}>ALWAYS INCLUDE</Text>
              <TouchableOpacity style={sc.anchorAddBtn} onPress={() => setShowItemPicker(true)}>
                <Text style={sc.anchorAddText}>{anchorItems.length > 0 ? `${anchorItems.length} item${anchorItems.length > 1 ? 's' : ''}` : 'Add items +'}</Text>
              </TouchableOpacity>
            </View>
            {anchorItems.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={sc.anchorStrip}>
                {anchorItems.map(item => (
                  <View key={item.id} style={sc.anchorThumbContainer}>
                    <TouchableOpacity style={sc.anchorThumb} onPress={() => toggleAnchor(item.id)}>
                      {item.image_url ? <Image source={{ uri: item.image_url }} style={sc.anchorImg} /> : <View style={[sc.anchorImg, { backgroundColor: 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center' }]}><Text style={{ fontSize: 18 }}>👗</Text></View>}
                      <View style={sc.anchorRemoveDot}><Text style={sc.anchorRemoveX}>×</Text></View>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </>
      )}

      {/* MODALS */}
      <Modal transparent visible={showTimePicker} animationType="fade" onRequestClose={() => setShowTimePicker(false)}>
        <TouchableWithoutFeedback onPress={() => setShowTimePicker(false)}>
          <View style={sc.modalOverlay}>
            <TouchableWithoutFeedback><BlurView intensity={60} tint="light" style={sc.modalCard}><TimePicker hour={schedule.time_hour} minute={schedule.time_minute} onChange={(h: number, m: number) => onChange({ ...schedule, time_hour: h, time_minute: m })} onClose={() => setShowTimePicker(false)} /></BlurView></TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
      <Modal transparent visible={showItemPicker} animationType="slide" onRequestClose={() => setShowItemPicker(false)}>
        <TouchableOpacity 
          style={sc.itemPickerOverlay} 
          activeOpacity={1} 
          onPress={() => setShowItemPicker(false)}
        >
          <View style={sc.itemPickerSheet}>
            <BlurView intensity={80} tint="light" style={StyleSheet.absoluteFill} />
            <ClosetPicker 
              items={closetItems}
              selectedIds={schedule.anchor_item_ids}
              onToggle={toggleAnchor}
              onDone={() => setShowItemPicker(false)}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </Animated.View>
  );
};

// ─── SCREEN ─────────────────────────────────────────────────────────────────
export default function AutoGenScreen() {
  const router = useRouter();
  const { user: clerkUser } = useUser();
  const userId = clerkUser?.id ?? null;
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [closetItems, setClosetItems] = useState<ClothingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: closet, error: closetErr } = await supabase
        .from('clothing_items')
        .select('id, name, category, type, color, image_url, occasions')
        .order('created_at', { ascending: false })
        .limit(200);
      if (closetErr) console.error('[AutoGen] closet fetch error:', closetErr);
      if (closet) setClosetItems(closet as any[]);

      if (userId) {
        const { data } = await supabase.from('autogen_schedules').select('*').eq('user_id', userId).order('created_at', { ascending: true });
        if (data && data.length > 0) {
          setSchedules(data as unknown as Schedule[]);
        } else {
          setSchedules([createDefaultSchedule()]);
        }
      }
      setLoading(false);
    })();
  }, [userId]);

  useEffect(() => {
    if (!userId || loading) return;
    // Only auto-save schedules that have been filled in
    const ready = schedules.filter(s => s.label.trim() && s.occasion);
    if (ready.length === 0) return;
    const timer = setTimeout(() => saveAllSilently(), 1500);
    return () => clearTimeout(timer);
  }, [schedules, userId]);

  const saveAllSilently = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      const filled = schedules.filter(s => s.label.trim() && s.occasion);
      if (filled.length === 0) { setSaving(false); return; }

      const inserts = filled
        .filter(s => s.id.startsWith('local_'))
        .map(({ id: _id, ...rest }) => ({ ...rest, user_id: userId, updated_at: new Date().toISOString() }));
      const updates = filled
        .filter(s => !s.id.startsWith('local_'))
        .map(s => ({ ...s, user_id: userId, updated_at: new Date().toISOString() }));

      if (inserts.length > 0) {
        const { data, error } = await supabase.from('autogen_schedules').insert(inserts).select();
        if (error) {
          Alert.alert('Save Error', error.message);
          setSaving(false);
          return;
        }
        if (data) {
          const { data: refreshed } = await supabase.from('autogen_schedules').select('*').eq('user_id', userId).order('created_at', { ascending: true });
          if (refreshed) setSchedules(refreshed as unknown as Schedule[]);
        }
      }
      if (updates.length > 0) {
        const { error } = await supabase.from('autogen_schedules').upsert(updates);
        if (error) Alert.alert('Update Error', error.message);
      }
      try {
        for (const s of filled) await scheduleNotificationsForSlot(s);
      } catch (notifErr) {
        console.warn('[AutoGen] notification scheduling failed:', notifErr);
      }
    } catch (e) {
      console.error(e);
      Alert.alert('Save failed', String(e));
    } finally { setSaving(false); }
  };

  const deleteSchedule = async (id: string) => {
    if (!id.startsWith('local_')) await supabase.from('autogen_schedules').delete().eq('id', id);
    setSchedules(prev => prev.filter(s => s.id !== id));
  };

  const addSchedule = () => {
    if (schedules.length >= 5) return Alert.alert('Max 5 schedules');
    setSchedules(prev => [...prev, createDefaultSchedule()]);
  };

  if (loading) return <View style={styles.loadingScreen}><ActivityIndicator color="#000" /></View>;

  if (!userId) return (
    <View style={styles.loadingScreen}>
      <Text style={{ color: 'rgba(0,0,0,0.4)', fontSize: 14, fontWeight: '600', textAlign: 'center', paddingHorizontal: 40 }}>
        Sign in to create and save automations.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.modalDragHandle} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBtn} onPress={addSchedule} disabled={schedules.length >= 5}>
          <PlusIcon color={schedules.length >= 5 ? 'rgba(0,0,0,0.2)' : '#FFF'} />
        </TouchableOpacity>
        
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Auto-Gen</Text>
          {saving && <Text style={styles.savingIndicator}>Saving...</Text>}
        </View>

        <TouchableOpacity 
          style={[styles.headerBtn, { alignItems: 'flex-end' }]} 
          onPress={async () => {
            // Only block if a schedule is partially filled (has label XOR occasion)
            const partiallyFilled = schedules.find(s => (s.label.trim() && !s.occasion) || (!s.label.trim() && s.occasion));
            if (partiallyFilled) {
              return Alert.alert(
                'Almost there',
                'Give each started schedule a name AND an occasion, or delete it.',
                [{ text: 'Got it' }]
              );
            }
            await saveAllSilently();
            router.back();
          }}
        >
          <Text style={styles.doneBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {schedules.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>⏰</Text>
            <Text style={styles.emptyTitle}>Personalize your schedule</Text>
            <Text style={styles.emptyBody}>Tap the + icon to create your first generation slot.</Text>
          </View>
        )}
        {schedules.map((s, i) => (
          <ScheduleCard key={s.id} schedule={s} closetItems={closetItems} index={i} onChange={u => setSchedules(prev => prev.map(old => old.id === s.id ? u : old))} onDelete={() => deleteSchedule(s.id)} />
        ))}
        {schedules.length < 5 && (
          <TouchableOpacity style={styles.bottomAddBtn} onPress={addSchedule} activeOpacity={0.8}>
            <View style={styles.bottomAddIconWrapper}>
              <PlusIcon color="rgba(0,0,0,0.5)" />
            </View>
            <Text style={styles.bottomAddText}>Add another schedule</Text>
          </TouchableOpacity>
        )}
        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

// ─── STYLES ─────────────────────────────────────────────────────────────────
const cp = StyleSheet.create({
  searchBar: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginBottom: 12 },
  searchInput: { flex: 1, height: 44, backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 16, color: '#000', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  filterToggle: { width: 60, height: 44, backgroundColor: '#FFFFFF', borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  filters: { paddingHorizontal: 16, marginBottom: 12 },
  typeBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.04)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  typeBtnActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  typeText: { fontSize: 11, fontWeight: '800', color: 'rgba(0,0,0,0.45)' },
  tabs: { paddingHorizontal: 16, gap: 20, paddingBottom: 10 },
  tabBtn: { paddingBottom: 6 },
  tabText: { fontSize: 14, fontWeight: '700', color: 'rgba(0,0,0,0.25)' },
  tabTextActive: { color: Colors.accent },
  tabIndicator: { position: 'absolute', bottom: 0, width: '100%', height: 2, backgroundColor: Colors.accent, borderRadius: 1 },
  colorPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9999, backgroundColor: 'rgba(0,0,0,0.04)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  colorPillActive: { backgroundColor: '#000', borderColor: '#000' },
  colorPillText: { fontSize: 11, fontWeight: '800', color: 'rgba(0,0,0,0.4)' },
  colorPillTextActive: { color: '#FFF' },
  colorPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  colorPickerLabel: { fontSize: 10, fontWeight: '800', color: 'rgba(0,0,0,0.35)', letterSpacing: 0.5 },
  colorPickerValue: { fontSize: 14, fontWeight: '700', color: '#000', marginTop: 2 },
  colorPickerIconHit: { padding: 4 },
});

const sc = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)', marginBottom: 16, padding: 16, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  powerBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1 },
  powerBtnActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  powerBtnPaused: { backgroundColor: 'rgba(0,0,0,0.04)', borderColor: 'rgba(0,0,0,0.08)' },
  powerDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: 'rgba(0,0,0,0.3)' },
  powerText: { fontSize: 9, fontWeight: '900', color: 'rgba(0,0,0,0.4)', letterSpacing: 0.5 },
  labelContainer: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  label: { fontSize: 16, fontWeight: '700', color: '#000', flexShrink: 1 },
  labelInput: { fontSize: 16, fontWeight: '700', color: '#000', borderBottomWidth: 1, borderBottomColor: Colors.accent, minWidth: 100, flexShrink: 1 },
  trashBtn: { padding: 8 },
  detailsStack: { gap: 12 },
  timePill: { width: TIME_PILL_W, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.04)', paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  timePillText: { fontSize: 12, fontWeight: '800', color: Colors.accent },
  occScroll: { gap: OCC_GAP, paddingHorizontal: 2 },
  occChip: { minWidth: 90, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.03)', paddingVertical: 9, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' },
  occChipActive: { backgroundColor: 'rgba(0,0,0,0.08)', borderColor: 'rgba(0,0,0,0.2)' },
  occLabel: { fontSize: 11, fontWeight: '700', color: 'rgba(0,0,0,0.35)', textAlign: 'center' },
  occLabelActive: { color: '#000', fontWeight: '800' },
  timeAndDaysRow: { flexDirection: 'row', alignItems: 'center', gap: DAY_ROW_GAP },
  daysRow: { flexDirection: 'row', gap: DAY_DOT_GAP },
  dayDot: { width: DAY_DOT_SIZE, height: DAY_DOT_SIZE, borderRadius: DAY_DOT_SIZE / 2, backgroundColor: 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' },
  dayDotActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  dayText: { fontSize: 9, fontWeight: '900', color: 'rgba(0,0,0,0.3)' },
  dayTextActive: { color: '#FFF' },
  anchorSection: { gap: 8 },
  anchorHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  anchorTitle: { fontSize: 8, fontWeight: '900', color: 'rgba(0,0,0,0.25)', letterSpacing: 1.5 },
  anchorAddBtn: { backgroundColor: 'rgba(0,0,0,0.06)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  anchorAddText: { fontSize: 9, fontWeight: '800', color: 'rgba(0,0,0,0.5)' },
  anchorStrip: { flexDirection: 'row', gap: 12, paddingRight: 20 },
  anchorThumbContainer: { paddingTop: 6, paddingRight: 6 },
  anchorThumb: { width: 50, height: 50, overflow: 'visible' },
  anchorImg: { width: 50, height: 50, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.05)' },
  anchorRemoveDot: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FF453A',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#F0F0F5',
    zIndex: 10,
  },
  anchorRemoveX: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  modalCard: { borderRadius: 20, overflow: 'hidden', width: width * 0.8, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)', backgroundColor: '#FFFFFF' },
  itemPickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  itemPickerSheet: { height: '100%', borderTopLeftRadius: 0, borderTopRightRadius: 0, overflow: 'hidden', backgroundColor: '#F2F2F7' },
  itemPickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 20, paddingTop: 54 },
  itemPickerTitle: { fontSize: 18, fontWeight: '800', color: '#000' },
  itemPickerDone: { fontSize: 15, fontWeight: '700', color: Colors.accent },
  itemGridCell: { flex: 1, borderRadius: 14, overflow: 'hidden', borderWidth: 1.5, borderColor: 'transparent' },
  itemGridCellActive: { borderColor: Colors.accent },
  itemGridImg: { width: '100%', aspectRatio: 1 },
  itemGridCheck: { position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  itemGridLabel: { fontSize: 9, fontWeight: '700', color: 'rgba(0,0,0,0.4)', padding: 4, textAlign: 'center' },
});

const tp = StyleSheet.create({
  container: { padding: 24 },
  title: { fontSize: 18, fontWeight: '800', color: '#000', marginBottom: 20, textAlign: 'center' },
  pickerRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  column: { alignItems: 'center' },
  colLabel: { fontSize: 8, fontWeight: '900', color: 'rgba(0,0,0,0.3)', letterSpacing: 1.5, marginBottom: 8 },
  scroll: { height: 160, width: 55 },
  colon: { fontSize: 28, fontWeight: '800', color: '#000', marginTop: 40 },
  item: { height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, width: 55 },
  itemActive: { backgroundColor: 'rgba(0,0,0,0.08)' },
  itemText: { fontSize: 22, fontWeight: '600', color: 'rgba(0,0,0,0.3)' },
  itemTextActive: { color: '#000', fontWeight: '800' },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, gap: 12 },
  cancelBtn: { flex: 1, height: 44, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)', alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: 'rgba(0,0,0,0.4)', fontWeight: '700' },
  confirmBtn: { flex: 1, height: 44, borderRadius: 14, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  confirmText: { color: '#FFF', fontWeight: '800' },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  modalDragHandle: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: 3,
    alignSelf: 'center',
    marginTop: 12,
  },
  header: { paddingTop: 20, paddingHorizontal: 20, paddingBottom: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerBtn: { height: 40, alignItems: 'center', justifyContent: 'center', minWidth: 60 },
  doneBtnText: { color: Colors.accent, fontSize: 16, fontWeight: '800' },
  headerCenter: { alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '900', color: Colors.text, letterSpacing: -0.5 },
  savingIndicator: { fontSize: 10, fontWeight: '700', color: Colors.accent, position: 'absolute', bottom: -14 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },
  emptyState: { alignItems: 'center', paddingVertical: 100, gap: 12 },
  emptyEmoji: { fontSize: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: Colors.text },
  emptyBody: { fontSize: 13, color: Colors.textMuted, textAlign: 'center', lineHeight: 20 },
  loadingScreen: { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center' },
  bottomAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.02)',
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(0,0,0,0.1)',
    paddingVertical: 24,
    marginTop: 8,
    gap: 12,
  },
  bottomAddIconWrapper: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomAddText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: -0.2,
  },
});
