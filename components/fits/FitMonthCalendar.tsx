import { useMemo, useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { Colors, Radii, Typography } from "../../constants/AppTheme";
import type { SavedFit } from "./types";

function wearDateKey(fit: SavedFit): string | null {
  const d = fit.worn_on || fit.planned_date;
  return d ? d.split("T")[0]! : null;
}

interface Props {
  fits: SavedFit[];
  selectedDay: string | null;
  onSelectDay: (iso: string | null) => void;
}

export default function FitMonthCalendar({ fits, selectedDay, onSelectDay }: Props) {
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const { labels, days, byDay } = useMemo(() => {
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const map: Record<string, SavedFit[]> = {};
    for (const f of fits) {
      const k = wearDateKey(f);
      if (!k) continue;
      const [y, m] = k.split("-").map(Number);
      if (y === year && m === month + 1) {
        if (!map[k]) map[k] = [];
        map[k]!.push(f);
      }
    }
    const cells: ({ key: string; inMonth: boolean; dayNum: number } | null)[] = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ key, inMonth: true, dayNum: d });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return {
      labels: ["S", "M", "T", "W", "T", "F", "S"],
      days: cells,
      byDay: map,
    };
  }, [fits, year, month]);

  const title = cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const shiftMonth = (delta: number) => {
    Haptics.selectionAsync();
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    onSelectDay(null);
  };

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => shiftMonth(-1)} hitSlop={10} style={s.navBtn}>
          <ChevronLeft size={20} color={Colors.text} strokeWidth={2.2} />
        </TouchableOpacity>
        <Text style={s.title}>{title}</Text>
        <TouchableOpacity onPress={() => shiftMonth(1)} hitSlop={10} style={s.navBtn}>
          <ChevronRight size={20} color={Colors.text} strokeWidth={2.2} />
        </TouchableOpacity>
      </View>
      <View style={s.dowRow}>
        {labels.map((L, i) => (
          <View key={i} style={s.dowCell}>
            <Text style={s.dow}>{L}</Text>
          </View>
        ))}
      </View>
      <View style={s.grid}>
        {days.map((cell, idx) => {
          if (!cell) return <View key={`e-${idx}`} style={s.cell} />;
          const has = (byDay[cell.key]?.length ?? 0) > 0;
          const sel = selectedDay === cell.key;
          const thumb = byDay[cell.key]?.[0]?.image_url;
          return (
            <TouchableOpacity
              key={cell.key}
              style={[s.cell, sel && s.cellSel]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onSelectDay(sel ? null : cell.key);
              }}
              activeOpacity={0.85}
            >
              <Text style={[s.dayNum, sel && s.dayNumSel]}>{cell.dayNum}</Text>
              {has && thumb ? (
                <Image source={{ uri: thumb }} style={s.thumb} />
              ) : has ? (
                <View style={s.dot} />
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    paddingBottom: 10,
    borderRadius: Radii.xl,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingTop: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    marginBottom: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: Typography.weights.bold,
    color: Colors.text,
    letterSpacing: -0.3,
  },
  navBtn: { padding: 6 },
  dowRow: {
    flexDirection: "row",
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  dowCell: { flex: 1, alignItems: "center" },
  dow: {
    fontSize: 10,
    fontWeight: Typography.weights.semibold,
    color: Colors.textMuted,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 4 },
  cell: {
    width: "14.2857%",
    aspectRatio: 1,
    maxHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radii.sm,
    marginBottom: 2,
  },
  cellSel: { backgroundColor: Colors.surfaceAlt },
  dayNum: {
    position: "absolute",
    top: 2,
    left: 3,
    fontSize: 10,
    fontWeight: Typography.weights.bold,
    color: Colors.textMuted,
  },
  dayNumSel: { color: Colors.text },
  thumb: {
    width: 26,
    height: 26,
    borderRadius: 6,
    marginTop: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.black,
    marginTop: 10,
    opacity: 0.35,
  },
});
