import { useState } from 'react';
import { Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Colors, Radii, Styles, Typography } from '../../constants/AppTheme';
import BottomSheet from './BottomSheet';

const { width: SW, height: SH } = Dimensions.get('window');
const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelectDate: (date: Date) => void;
}

export default function CalendarSheet({ visible, onClose, onSelectDate }: Props) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selected, setSelected] = useState<Date | null>(null);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); }
    else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); }
    else setViewMonth((m) => m + 1);
  };

  const cells: (number | null)[] = [
    ...Array(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const isToday = (day: number) =>
    day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
  const isSelected = (day: number) =>
    selected !== null &&
    day === selected.getDate() &&
    viewMonth === selected.getMonth() &&
    viewYear === selected.getFullYear();
  const isPast = (day: number) => {
    const d = new Date(viewYear, viewMonth, day);
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return d < todayMidnight;
  };

  const confirm = () => {
    if (selected) { onSelectDate(selected); onClose(); }
  };

  const CELL_SZ = Math.floor((SW - 40 - 20) / 7);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Pick a date" snapHeight={SH * 0.62}>
      <View style={s.container}>
        <View style={s.nav}>
          <TouchableOpacity onPress={prevMonth} style={s.navBtn} hitSlop={10}>
            <ChevronLeft size={18} color={Colors.text} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={s.monthLabel}>{MONTHS[viewMonth]} {viewYear}</Text>
          <TouchableOpacity onPress={nextMonth} style={s.navBtn} hitSlop={10}>
            <ChevronRight size={18} color={Colors.text} strokeWidth={2} />
          </TouchableOpacity>
        </View>
        <View style={s.row}>
          {DAYS_SHORT.map((d) => (
            <View key={d} style={[s.cell, { width: CELL_SZ, height: 28 }]}>
              <Text style={s.dayHeader}>{d}</Text>
            </View>
          ))}
        </View>
        {Array.from({ length: cells.length / 7 }, (_, rowIdx) => (
          <View key={rowIdx} style={s.row}>
            {cells.slice(rowIdx * 7, rowIdx * 7 + 7).map((day, colIdx) => {
              if (!day)
                return <View key={colIdx} style={{ width: CELL_SZ, height: CELL_SZ }} />;
              const past = isPast(day);
              const sel = isSelected(day);
              const tod = isToday(day);
              return (
                <TouchableOpacity
                  key={colIdx}
                  style={[
                    s.dayCell,
                    { width: CELL_SZ, height: CELL_SZ },
                    sel && s.dayCellSelected,
                    tod && !sel && s.dayCellToday,
                  ]}
                  onPress={() => {
                    if (!past) {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setSelected(new Date(viewYear, viewMonth, day));
                    }
                  }}
                  disabled={past}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      s.dayText,
                      past && s.dayTextPast,
                      sel && s.dayTextSelected,
                      tod && !sel && s.dayTextToday,
                    ]}
                  >
                    {day}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
      <View style={s.footer}>
        <TouchableOpacity
          style={[Styles.btnPrimary, { marginHorizontal: 20 }, !selected && { opacity: 0.35 }]}
          onPress={confirm}
          disabled={!selected}
          activeOpacity={0.85}
        >
          <Text style={Styles.btnPrimaryText}>
            {selected
              ? `Plan for ${selected.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
              : 'Select a date'}
          </Text>
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  container: { paddingHorizontal: 20, paddingTop: 16, gap: 4 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthLabel: {
    fontSize: 16,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  row: { flexDirection: 'row' },
  cell: { alignItems: 'center', justifyContent: 'center' },
  dayHeader: {
    fontSize: 11,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  dayCell: { alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  dayCellSelected: { backgroundColor: Colors.black },
  dayCellToday: { borderWidth: 1.5, borderColor: Colors.black },
  dayText: { fontSize: 14, fontWeight: Typography.weights.medium, color: Colors.text },
  dayTextPast: { color: 'rgba(0,0,0,0.2)' },
  dayTextSelected: { color: '#fff', fontWeight: Typography.weights.bold },
  dayTextToday: { fontWeight: Typography.weights.bold },
  footer: {
    paddingTop: 14,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    marginTop: 8,
  },
});
