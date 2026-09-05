import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/lib/theme";

export const todayKey = () => new Date().toISOString().slice(0, 10);
export const shiftDate = (d: string, days: number) => {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

const prettyDate = (d: string) => {
  try {
    return new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", {
      weekday: "short", day: "2-digit", month: "short", year: "numeric",
    });
  } catch { return d; }
};

/** Compact prev / today / next date navigator. Cannot go past today. */
export default function DateNavigator({
  date, onChange, testIDPrefix = "date",
}: {
  date: string;
  onChange: (d: string) => void;
  testIDPrefix?: string;
}) {
  const isToday = date === todayKey();
  return (
    <View style={styles.bar} testID={`${testIDPrefix}-navigator`}>
      <Pressable onPress={() => onChange(shiftDate(date, -1))} style={styles.btn} testID={`${testIDPrefix}-prev`} hitSlop={8}>
        <Ionicons name="chevron-back" size={18} color={theme.color.onSurface} />
      </Pressable>
      <Pressable onPress={() => onChange(todayKey())} style={styles.center} testID={`${testIDPrefix}-today`}>
        <Text style={styles.dateText}>{prettyDate(date)}</Text>
        <Text style={styles.sub}>{isToday ? "Today" : "Tap for today"}</Text>
      </Pressable>
      <Pressable
        onPress={() => onChange(shiftDate(date, 1))}
        style={[styles.btn, isToday && { opacity: 0.35 }]}
        disabled={isToday}
        testID={`${testIDPrefix}-next`}
        hitSlop={8}
      >
        <Ionicons name="chevron-forward" size={18} color={theme.color.onSurface} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.sm,
    backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
    gap: theme.space.sm,
  },
  btn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dateText: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  sub: { fontSize: 10, color: theme.color.muted, marginTop: 1 },
});
