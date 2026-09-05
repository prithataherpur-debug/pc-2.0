import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Linking, Platform } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";

import { theme } from "@/src/lib/theme";
import { api, Customer, STATUS_COLOR, STATUS_LABEL } from "@/src/lib/api";
import PunchSaleModal from "@/src/components/PunchSaleModal";

export default function Followups() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saleFor, setSaleFor] = useState<Customer | null>(null);

  const load = useCallback(async () => {
    try {
      const cs = await api.followups();
      setItems(cs);
    } catch (e) { console.log("followups err", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const dial = (c: Customer) => {
    const url = `tel:${c.phone}`;
    Linking.canOpenURL(url).then((ok) => ok && Linking.openURL(url));
  };

  const renderItem = ({ item }: { item: Customer }) => {
    const isInterested = item.status === "interested";
    const overdue =
      item.followup_date && item.followup_date < new Date().toISOString().slice(0, 10);
    return (
      <Pressable
        style={styles.card}
        onPress={() => router.push(`/feedback/${item.id}`)}
        testID={`followup-card-${item.id}`}
      >
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.phone}>{item.phone}</Text>
          </View>
          <View
            style={[
              styles.tag,
              { backgroundColor: STATUS_COLOR[item.status] + "22", borderColor: STATUS_COLOR[item.status] },
            ]}
          >
            <Text style={[styles.tagText, { color: STATUS_COLOR[item.status] }]}>
              {STATUS_LABEL[item.status]}
            </Text>
          </View>
        </View>
        <View style={styles.metaRow}>
          {item.followup_date ? (
            <View style={[styles.metaBox, overdue && { backgroundColor: "#FDE8E6" }]}>
              <Ionicons name="calendar-outline" size={12} color={overdue ? theme.color.error : theme.color.muted} />
              <Text style={[styles.metaText, overdue && { color: theme.color.error, fontWeight: "700" }]}>
                {overdue ? "Overdue " : "Follow-up "}{item.followup_date}
              </Text>
            </View>
          ) : null}
          {item.whatsapp_sent_at ? (
            <View style={styles.metaBox}>
              <Ionicons name="logo-whatsapp" size={12} color="#25D366" />
              <Text style={styles.metaText}>Message sent</Text>
            </View>
          ) : null}
          {isInterested && item.rating ? (
            <View style={styles.metaBox}>
              <Ionicons name="star" size={12} color="#D4AC0D" />
              <Text style={styles.metaText}>{item.rating}/5</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.actionRow}>
          <Pressable style={styles.smallBtn} onPress={() => dial(item)} testID={`followup-dial-${item.id}`}>
            <Ionicons name="call" size={14} color={theme.color.brand} />
            <Text style={styles.smallBtnText}>Call</Text>
          </Pressable>
          <Pressable
            style={[styles.smallBtn, { borderColor: theme.color.success }]}
            onPress={() => setSaleFor(item)}
            testID={`followup-sale-${item.id}`}
          >
            <Ionicons name="cash-outline" size={14} color={theme.color.success} />
            <Text style={[styles.smallBtnText, { color: theme.color.success }]}>Log sale</Text>
          </Pressable>
          <Pressable
            style={[styles.smallBtn, { backgroundColor: theme.color.brand }]}
            onPress={() => router.push(`/feedback/${item.id}`)}
            testID={`followup-feedback-${item.id}`}
          >
            <Ionicons name="star-outline" size={14} color={theme.color.onBrand} />
            <Text style={[styles.smallBtnText, { color: theme.color.onBrand }]}>
              {item.rating ? "Update" : "Feedback"}
            </Text>
          </Pressable>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="followups-screen">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Follow-ups</Text>
        <Text style={styles.headerSubtitle}>Interested + Callback customers</Text>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="bookmark-outline" size={56} color={theme.color.borderStrong} />
          <Text style={styles.emptyTitle}>No follow-ups yet</Text>
          <Text style={styles.emptyText}>Mark customers as Interested or Callback to see them here.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: theme.space.xxxl }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        />
      )}

      <PunchSaleModal
        visible={saleFor !== null}
        onClose={() => setSaleFor(null)}
        onSaved={() => { setSaleFor(null); load(); }}
        presetCustomer={saleFor ? { id: saleFor.id, name: saleFor.name } : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  header: {
    paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  headerTitle: { fontSize: theme.font.scale.xxl, fontWeight: "800", color: theme.color.onSurface },
  headerSubtitle: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  card: {
    backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md, padding: theme.space.md,
    borderWidth: 1, borderColor: theme.color.border,
  },
  cardTop: { flexDirection: "row", alignItems: "center" },
  name: { fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  phone: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.pill, borderWidth: 1 },
  tagText: { fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginTop: theme.space.md },
  metaBox: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: theme.color.surfaceTertiary, paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.pill },
  metaText: { fontSize: 11, color: theme.color.onSurfaceTertiary, fontWeight: "600" },
  actionRow: { flexDirection: "row", gap: theme.space.sm, marginTop: theme.space.md },
  smallBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, height: 36, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brand,
    backgroundColor: theme.color.surfaceSecondary,
  },
  smallBtnText: { color: theme.color.brand, fontWeight: "700", fontSize: 12 },
  emptyTitle: { marginTop: theme.space.md, fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  emptyText: { marginTop: 6, fontSize: theme.font.scale.base, color: theme.color.muted, textAlign: "center" },
});
