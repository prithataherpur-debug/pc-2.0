import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Modal,
  RefreshControl, Alert,
} from "react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";

import { theme } from "@/src/lib/theme";
import { api, User, Sale, STATUS_COLOR, STATUS_LABEL } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

type CallLog = {
  id: string;
  customer_id: string;
  customer_name: string;
  phone: string;
  status: string;
  date_key: string;
  user: string;
  timestamp: string;
};

type TabKey = "calls" | "sales";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
const fmtAmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

export default function TeamMemberScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user: me } = useAuth();
  const { username } = useLocalSearchParams<{ username: string }>();
  const currentUser = String(username || "");

  const [tab, setTab] = useState<TabKey>("calls");
  const [profile, setProfile] = useState<User | null>(null);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const users = await api.listUsers();
      setEmployees(users.filter((u) => u.role === "employee"));
      setProfile(users.find((u) => u.username === currentUser) || null);
      const [c, s] = await Promise.all([
        api.userCalls(currentUser, 200),
        api.userSales(currentUser, 200),
      ]);
      setCalls(c);
      setSales(s);
    } catch (e) {
      console.log("team member load err", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentUser]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Reset selection when switching tabs
  useEffect(() => { setSelected(new Set()); }, [tab]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    const ids = tab === "calls" ? calls.map((c) => c.id) : sales.map((s) => s.id);
    setSelected(new Set(ids));
  };

  const clearSel = () => setSelected(new Set());

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const otherEmployees = useMemo(
    () => employees.filter((e) => e.username !== currentUser),
    [employees, currentUser],
  );

  const doMove = async (newOwner: string) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setMoveOpen(false);
    try {
      if (tab === "calls") await api.moveCalls(ids, newOwner);
      else await api.moveSales(ids, newOwner);
      showToast(`Moved ${ids.length} ${tab} → ${newOwner}`);
      setSelected(new Set());
      load();
    } catch (e: any) {
      showToast(String(e?.message || "Move failed"));
    }
  };

  const confirmDelete = (id: string) => {
    Alert.alert(
      "Delete entry?",
      tab === "calls" ? "This removes the call log." : "This removes the sale record.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              if (tab === "calls") await api.deleteCall(id);
              else await api.deleteSale(id);
              showToast("Removed");
              load();
            } catch (e: any) {
              showToast(String(e?.message || "Delete failed"));
            }
          },
        },
      ],
    );
  };

  const isAdmin = me?.role === "admin";
  const listData = tab === "calls" ? calls : sales;

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="member-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>{profile?.display_name || currentUser}</Text>
          <Text style={styles.hdrSub}>@{currentUser} · {calls.length} calls · {sales.length} sales</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        {(["calls", "sales"] as TabKey[]).map((k) => (
          <Pressable
            key={k}
            onPress={() => setTab(k)}
            style={[styles.tab, tab === k && styles.tabActive]}
            testID={`tab-${k}`}
          >
            <Ionicons
              name={k === "calls" ? "call-outline" : "cash-outline"}
              size={16}
              color={tab === k ? theme.color.brand : theme.color.muted}
            />
            <Text style={[styles.tabText, tab === k && styles.tabTextActive]}>
              {k === "calls" ? `Calls (${calls.length})` : `Sales (${sales.length})`}
            </Text>
          </Pressable>
        ))}
      </View>

      {selected.size > 0 ? (
        <View style={styles.selBar}>
          <Text style={styles.selText}>{selected.size} selected</Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable onPress={selectAllVisible} style={styles.selAction}>
              <Text style={styles.selActionText}>Select all</Text>
            </Pressable>
            <Pressable onPress={clearSel} style={styles.selAction}>
              <Text style={styles.selActionText}>Clear</Text>
            </Pressable>
            <Pressable
              onPress={() => setMoveOpen(true)}
              style={[styles.selAction, styles.selPrimary]}
              testID="bulk-move-btn"
            >
              <Ionicons name="arrow-forward-circle" size={14} color="#fff" />
              <Text style={styles.selPrimaryText}>Move to…</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.hint}>
          <Ionicons name="information-circle-outline" size={14} color={theme.color.muted} />
          <Text style={styles.hintText}>Tap a row to select · long-press to open</Text>
        </View>
      )}

      <FlatList
        data={listData}
        keyExtractor={(item: any) => item.id}
        contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
        ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={theme.color.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name={tab === "calls" ? "call" : "cash"}
              size={44}
              color={theme.color.borderStrong}
            />
            <Text style={styles.emptyTitle}>No {tab} yet</Text>
          </View>
        }
        renderItem={({ item }) => {
          const sel = selected.has(item.id);
          if (tab === "calls") {
            const c = item as CallLog;
            const st = c.status || "pending";
            return (
              <Pressable
                onPress={() => toggle(c.id)}
                style={[styles.card, sel && styles.cardSelected]}
                testID={`row-call-${c.id}`}
              >
                <View style={styles.checkbox}>
                  {sel ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{c.customer_name || c.phone}</Text>
                  <Text style={styles.cardMeta}>{fmtDate(c.timestamp)}</Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: (STATUS_COLOR[st] || "#999") + "22" }]}>
                  <Text style={[styles.statusText, { color: STATUS_COLOR[st] || "#666" }]}>
                    {STATUS_LABEL[st] || st}
                  </Text>
                </View>
                {isAdmin ? (
                  <Pressable
                    onPress={(e) => { e.stopPropagation(); confirmDelete(c.id); }}
                    style={styles.rowDel}
                    testID={`del-call-${c.id}`}
                    hitSlop={8}
                  >
                    <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                  </Pressable>
                ) : null}
              </Pressable>
            );
          }
          const s = item as Sale;
          return (
            <Pressable
              onPress={() => toggle(s.id)}
              style={[styles.card, sel && styles.cardSelected]}
              testID={`row-sale-${s.id}`}
            >
              <View style={styles.checkbox}>
                {sel ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {s.customer_name || "Walk-in"}
                  {s.product ? <Text style={styles.cardMetaInline}>  ·  {s.product}</Text> : null}
                </Text>
                <Text style={styles.cardMeta}>{fmtDate(s.timestamp)}</Text>
              </View>
              <Text style={styles.saleAmount}>{fmtAmt(s.amount)}</Text>
              {isAdmin ? (
                <Pressable
                  onPress={(e) => { e.stopPropagation(); confirmDelete(s.id); }}
                  style={styles.rowDel}
                  testID={`del-sale-${s.id}`}
                  hitSlop={8}
                >
                  <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                </Pressable>
              ) : null}
            </Pressable>
          );
        }}
      />

      <MovePicker
        visible={moveOpen}
        options={otherEmployees}
        title={`Move ${selected.size} ${tab} to…`}
        onClose={() => setMoveOpen(false)}
        onPick={doMove}
      />

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function MovePicker({
  visible, options, title, onClose, onPick,
}: {
  visible: boolean;
  options: User[];
  title: string;
  onClose: () => void;
  onPick: (username: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>{title}</Text>
          <FlatList
            data={options}
            keyExtractor={(u) => u.username}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            contentContainerStyle={{ paddingBottom: 24 }}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onPick(item.username)}
                style={styles.pickRow}
                testID={`move-to-${item.username}`}
              >
                <View style={styles.pickAvatar}>
                  <Text style={styles.pickAvatarText}>
                    {(item.display_name || item.username).slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pickName}>{item.display_name || item.username}</Text>
                  <Text style={styles.pickSub}>@{item.username}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={theme.color.muted} />
              </Pressable>
            )}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },

  tabs: {
    flexDirection: "row", gap: 6,
    padding: theme.space.md,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
    backgroundColor: theme.color.surfaceSecondary,
  },
  tab: {
    flex: 1, height: 40, borderRadius: theme.radius.pill,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderWidth: 1, borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  tabActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  tabText: { fontSize: 13, color: theme.color.muted, fontWeight: "700" },
  tabTextActive: { color: theme.color.brand, fontWeight: "800" },

  hint: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: theme.space.lg, paddingVertical: 8,
    backgroundColor: theme.color.surface,
  },
  hintText: { fontSize: 12, color: theme.color.muted },

  selBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: theme.space.lg, paddingVertical: 8,
    backgroundColor: theme.color.brandTertiary,
    borderBottomWidth: 1, borderBottomColor: theme.color.brand,
  },
  selText: { fontSize: 13, fontWeight: "800", color: theme.color.brand },
  selAction: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, height: 30, borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  selActionText: { fontSize: 12, fontWeight: "700", color: theme.color.onSurface },
  selPrimary: { backgroundColor: theme.color.brand, borderColor: theme.color.brand },
  selPrimaryText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  card: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
  },
  cardSelected: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  checkbox: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: theme.color.brand,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "transparent",
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
  cardMeta: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  cardMetaInline: { fontSize: 13, color: theme.color.muted, fontWeight: "600" },
  statusPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.pill },
  statusText: { fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  saleAmount: { fontSize: 15, fontWeight: "800", color: theme.color.success },
  rowDel: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "#FDE8E6",
  },

  empty: { alignItems: "center", padding: theme.space.xxl, gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },

  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, maxHeight: "70%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.md },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface, marginBottom: theme.space.md },
  pickRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  pickAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: theme.color.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  pickAvatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 14 },
  pickName: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
  pickSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },

  toast: {
    position: "absolute", left: theme.space.lg, right: theme.space.lg,
    backgroundColor: theme.color.surfaceInverse,
    borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center",
  },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "700" },
});
