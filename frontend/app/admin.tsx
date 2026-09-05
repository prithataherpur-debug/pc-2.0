import {
  View, Text, StyleSheet, Pressable, ScrollView, FlatList, Modal, ActivityIndicator,
} from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";

import { theme } from "@/src/lib/theme";
import { api, Customer, User, STATUS_LABEL, STATUS_COLOR } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

export default function Admin() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [employees, setEmployees] = useState<User[]>([]);
  const [filterEmp, setFilterEmp] = useState<string>("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const [us, cs] = await Promise.all([api.listUsers(), api.listCustomers("all", "", "all")]);
      setEmployees(us.filter((u) => u.role === "employee"));
      setCustomers(cs);
    } catch (e) { console.log(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = filterEmp
    ? customers.filter((c) => c.assigned_to === filterEmp)
    : customers;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const reassign = async (username: string) => {
    setBusy(true);
    try {
      const res = await api.reassign(Array.from(selected), username);
      showToast(`Reassigned ${res.updated} customers to ${username}`);
      setSelected(new Set());
      setPickerOpen(false);
      load();
    } catch { showToast("Reassign failed"); }
    finally { setBusy(false); }
  };

  if (user?.role !== "admin") {
    return (
      <View style={[styles.container, { paddingTop: insets.top, alignItems: "center", justifyContent: "center" }]}>
        <Ionicons name="lock-closed" size={40} color={theme.color.muted} />
        <Text style={styles.deniedTitle}>Admin only</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}><Text style={styles.backBtnText}>Go back</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="admin-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}><Ionicons name="chevron-back" size={22} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Reassign customers</Text>
          <Text style={styles.hdrSub}>{selected.size} selected · {customers.length} total</Text>
        </View>
        {selected.size > 0 ? (
          <Pressable onPress={() => setPickerOpen(true)} style={styles.reassignBtn} testID="open-reassign">
            <Ionicons name="swap-horizontal" size={14} color={theme.color.onBrand} />
            <Text style={styles.reassignText}>Reassign</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        <Chip label={`All (${customers.length})`} active={filterEmp === ""} onPress={() => setFilterEmp("")} />
        {employees.map((e) => {
          const count = customers.filter((c) => c.assigned_to === e.username).length;
          return (
            <Chip
              key={e.username}
              label={`${e.display_name || e.username} (${count})`}
              active={filterEmp === e.username}
              onPress={() => setFilterEmp(e.username)}
              testID={`filter-emp-${e.username}`}
            />
          );
        })}
      </ScrollView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => toggle(item.id)}
              style={[styles.row, selected.has(item.id) && styles.rowActive]}
              testID={`admin-row-${item.id}`}
            >
              <Ionicons
                name={selected.has(item.id) ? "checkbox" : "square-outline"}
                size={22}
                color={selected.has(item.id) ? theme.color.brand : theme.color.muted}
              />
              <View style={{ flex: 1, marginLeft: theme.space.md }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.phone}>{item.phone}</Text>
                <View style={styles.tagRow}>
                  <View style={styles.tag}><Text style={styles.tagText}>{item.assigned_to || "unassigned"}</Text></View>
                  <View style={[styles.tag, { backgroundColor: STATUS_COLOR[item.status] + "22" }]}>
                    <Text style={[styles.tagText, { color: STATUS_COLOR[item.status] }]}>{STATUS_LABEL[item.status]}</Text>
                  </View>
                </View>
              </View>
            </Pressable>
          )}
        />
      )}

      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Assign to…</Text>
            <ScrollView>
              {employees.map((e) => (
                <Pressable
                  key={e.username}
                  onPress={() => reassign(e.username)}
                  style={styles.pickerRow}
                  disabled={busy}
                  testID={`assign-to-${e.username}`}
                >
                  <View style={styles.avatar}><Text style={styles.avatarText}>{(e.display_name || e.username).slice(0, 1).toUpperCase()}</Text></View>
                  <View style={{ flex: 1, marginLeft: theme.space.md }}>
                    <Text style={styles.pickerName}>{e.display_name || e.username}</Text>
                    <Text style={styles.pickerHint}>@{e.username}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Chip({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary }]}
      testID={testID}
    >
      <Text style={[styles.chipText, active && { color: theme.color.brand, fontWeight: "700" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  reassignBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: theme.color.brand, paddingHorizontal: theme.space.md, height: 36, borderRadius: theme.radius.pill },
  reassignText: { color: theme.color.onBrand, fontWeight: "700", fontSize: 13 },
  chipRow: { paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md, gap: theme.space.sm },
  chip: { flexShrink: 0, height: 36, paddingHorizontal: theme.space.md, borderRadius: theme.radius.pill, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, justifyContent: "center" },
  chipText: { color: theme.color.onSurfaceTertiary, fontSize: theme.font.scale.sm, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", padding: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border },
  rowActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  name: { fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  phone: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  tagRow: { flexDirection: "row", gap: theme.space.sm, marginTop: 6 },
  tag: { backgroundColor: theme.color.surfaceTertiary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.pill },
  tagText: { fontSize: 11, fontWeight: "700", color: theme.color.onSurfaceTertiary, textTransform: "uppercase" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "85%" },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  sheetTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface, marginBottom: theme.space.md },
  pickerRow: { flexDirection: "row", alignItems: "center", paddingVertical: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.color.brandTertiary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: theme.color.brand, fontWeight: "800" },
  pickerName: { fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  pickerHint: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  toast: { position: "absolute", left: theme.space.lg, right: theme.space.lg, backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center" },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "600" },
  deniedTitle: { marginTop: theme.space.md, fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  backBtn: { marginTop: theme.space.lg, paddingHorizontal: theme.space.xl, paddingVertical: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brand },
  backBtnText: { color: theme.color.onBrand, fontWeight: "700" },
});
