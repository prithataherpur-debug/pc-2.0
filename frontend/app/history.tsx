import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/lib/theme";
import { api, STATUS_COLOR, STATUS_LABEL } from "@/src/lib/api";

type Row = { date: string; total: number; breakdown: Record<string, number> };

export default function History() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.statsHistory(); setRows(r.history || []); }
    catch (e) { console.log("history err", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}><Ionicons name="chevron-back" size={22} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Call history</Text>
          <Text style={styles.hdrSub}>Past 30 days</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="time-outline" size={56} color={theme.color.borderStrong} />
          <Text style={styles.emptyTitle}>No history yet</Text>
          <Text style={styles.emptyText}>Start making calls to build your daily log.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(it) => it.date}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.date}>{item.date}</Text>
                <View style={styles.totalPill}>
                  <Ionicons name="call" size={12} color={theme.color.brand} />
                  <Text style={styles.totalText}>{item.total} calls</Text>
                </View>
              </View>
              <View style={styles.breakRow}>
                {Object.entries(item.breakdown).filter(([, v]) => v > 0).map(([k, v]) => (
                  <View key={k} style={styles.pill}>
                    <View style={[styles.dot, { backgroundColor: STATUS_COLOR[k] || theme.color.muted }]} />
                    <Text style={styles.pillText}>{STATUS_LABEL[k] || k} · {v}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  hdr: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: theme.space.md, paddingVertical: theme.space.md, backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  card: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: theme.space.lg, borderWidth: 1, borderColor: theme.color.border },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  date: { fontSize: theme.font.scale.lg, fontWeight: "800", color: theme.color.onSurface },
  totalPill: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: theme.color.brandTertiary, paddingHorizontal: theme.space.md, paddingVertical: 4, borderRadius: theme.radius.pill },
  totalText: { color: theme.color.brand, fontWeight: "700", fontSize: theme.font.scale.sm },
  breakRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginTop: theme.space.md },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.color.surfaceTertiary, paddingHorizontal: theme.space.md, paddingVertical: 6, borderRadius: theme.radius.pill },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: theme.font.scale.sm, color: theme.color.onSurfaceTertiary, fontWeight: "600" },
  emptyTitle: { marginTop: theme.space.md, fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  emptyText: { marginTop: 6, fontSize: theme.font.scale.base, color: theme.color.muted, textAlign: "center" },
});
