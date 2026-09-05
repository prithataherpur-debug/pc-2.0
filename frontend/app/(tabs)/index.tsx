import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Linking,
  Platform,
  RefreshControl,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Image,
} from "react-native";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";

import { theme } from "@/src/lib/theme";
import {
  api,
  Customer,
  StatsToday,
  STATUS_LABEL,
  STATUS_COLOR,
} from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import CustomerEditModal from "@/src/components/CustomerEditModal";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "interested", label: "Interested" },
  { key: "callback", label: "Callback" },
  { key: "no_answer", label: "No Answer" },
  { key: "not_interested", label: "Not Interested" },
  { key: "done", label: "Done" },
];

const STATUS_OPTIONS = [
  { key: "interested", label: "Interested", icon: "checkmark-circle" as const },
  { key: "callback", label: "Callback", icon: "refresh-circle" as const },
  { key: "no_answer", label: "No Answer", icon: "help-circle" as const },
  { key: "not_interested", label: "Not Interested", icon: "close-circle" as const },
  { key: "done", label: "Done", icon: "checkmark-done-circle" as const },
];

export default function Home() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<StatsToday | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [statusFor, setStatusFor] = useState<Customer | null>(null);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cs, st] = await Promise.all([
        api.listCustomers(filter, search, "mine"),
        api.statsToday(),
      ]);
      setCustomers(cs);
      setStats(st);
    } catch (e) {
      console.log("load err", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, search]);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const onDial = async (c: Customer) => {
    try {
      if (Platform.OS !== "web") await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
    const url = `tel:${c.phone}`;
    const supported = await Linking.canOpenURL(url);
    if (supported) Linking.openURL(url);
    setStatusFor(c);
  };

  const applyStatus = async (status: string) => {
    if (!statusFor) return;
    try {
      const updated = await api.updateStatus(statusFor.id, status);
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStatusFor(null);
      load();
      // if interested, offer to log feedback right away
      if (status === "interested") {
        setTimeout(() => router.push(`/feedback/${updated.id}`), 200);
      }
    } catch (e) {
      console.log("status err", e);
      setStatusFor(null);
    }
  };

  const progressPct = useMemo(() => {
    if (!stats || stats.goal === 0) return 0;
    return Math.min(1, stats.total_calls / stats.goal);
  }, [stats]);

  const renderItem = ({ item }: { item: Customer }) => (
    <View style={styles.card} testID={`customer-card-${item.id}`}>
      <Pressable
        style={({ pressed }) => [styles.cardLeft, pressed && { opacity: 0.7 }]}
        onPress={() => setEditCustomer(item)}
        testID={`open-customer-${item.id}`}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(item.name || "?").slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1, marginLeft: theme.space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>{item.name || "Unnamed"}</Text>
            <Ionicons name="create-outline" size={12} color={theme.color.muted} />
          </View>
          <Text style={styles.phone} numberOfLines={1}>{item.phone}</Text>
          {item.address ? <Text style={styles.phone} numberOfLines={1}>{item.address}</Text> : null}
          <View style={styles.badgeRow}>
            <View style={[styles.statusDot, { backgroundColor: STATUS_COLOR[item.status] || theme.color.muted }]} />
            <Text style={styles.statusText}>{STATUS_LABEL[item.status] || item.status}</Text>
            {item.whatsapp_sent_at ? (
              <View style={styles.waTag}>
                <Ionicons name="logo-whatsapp" size={10} color="#25D366" />
                <Text style={styles.waTagText}>sent</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.dialBtn, pressed && { opacity: 0.75 }]}
        onPress={() => onDial(item)}
        testID={`dial-button-${item.id}`}
      >
        <Ionicons name="call" size={22} color={theme.color.onBrand} />
      </Pressable>
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="home-screen">
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Image
            source={require("../../assets/images/pritha-logo.jpg")}
            style={styles.brandLogo}
            resizeMode="contain"
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.brandName}>Pritha Cabinet</Text>
            <Text style={styles.brandTagline}>Customer Relationship</Text>
          </View>
        </View>
        <View style={styles.headerTopRow}>
          <View>
            <Text style={styles.headerTitle}>Hi, {user?.display_name || user?.username}</Text>
            <Text style={styles.headerSubtitle}>Today&apos;s target</Text>
          </View>
          <View style={styles.metricBox}>
            <Text style={styles.metricValue} testID="calls-count">
              {stats ? stats.total_calls : 0}
              <Text style={styles.metricDenominator}>{stats ? `/${stats.goal}` : "/50"}</Text>
            </Text>
            <Text style={styles.metricLabel}>calls</Text>
          </View>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progressPct * 100}%` }]} testID="progress-fill" />
        </View>

        <View style={styles.searchRow}>
          <Ionicons name="search" size={16} color={theme.color.muted} style={{ marginRight: 6 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search name or phone"
            placeholderTextColor={theme.color.muted}
            value={search}
            onChangeText={setSearch}
            testID="search-input"
          />
          <Pressable onPress={() => setAddOpen(true)} style={styles.addBtn} testID="open-add-customer">
            <Ionicons name="add" size={20} color={theme.color.onBrand} />
          </Pressable>
        </View>

        {/* Customer Ledger quick-lookup (searches ALL customers) */}
        <LedgerSearchBar />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {STATUS_FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[
                  styles.chip,
                  active && { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
                ]}
                testID={`filter-chip-${f.key}`}
              >
                <Text style={[styles.chipText, active && { color: theme.color.brand, fontWeight: "700" }]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : customers.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={56} color={theme.color.borderStrong} />
          <Text style={styles.emptyTitle}>No customers assigned</Text>
          <Text style={styles.emptyText}>
            {user?.role === "admin"
              ? "Import a list from More → Settings."
              : "Ask your admin to import and assign customers."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={customers}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: theme.space.xxxl }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          testID="customer-list"
        />
      )}

      <Modal visible={!!statusFor} transparent animationType="slide" onRequestClose={() => setStatusFor(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setStatusFor(null)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Log call outcome</Text>
            <Text style={styles.sheetSubtitle}>{statusFor?.name} · {statusFor?.phone}</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ height: theme.space.md }} />
              {STATUS_OPTIONS.map((o) => (
                <Pressable
                  key={o.key}
                  onPress={() => applyStatus(o.key)}
                  style={styles.statusOption}
                  testID={`status-option-${o.key}`}
                >
                  <Ionicons name={o.icon} size={22} color={STATUS_COLOR[o.key]} />
                  <Text style={styles.statusOptionText}>{o.label}</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => setStatusFor(null)}
                style={[styles.statusOption, { justifyContent: "center" }]}
                testID="status-option-cancel"
              >
                <Text style={[styles.statusOptionText, { color: theme.color.muted }]}>Cancel</Text>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <CustomerEditModal
        customer={editCustomer}
        onClose={() => setEditCustomer(null)}
        onSaved={() => { setEditCustomer(null); load(); }}
      />

      <AddCustomerModal
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { setAddOpen(false); load(); }}
      />
    </View>
  );
}

function LedgerSearchBar() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<any>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term || term.length < 2) {
      setResults([]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.searchCustomers(term, 15);
        setResults(res.customers || []);
      } catch {
        setResults([]);
      } finally { setLoading(false); }
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const openLedger = (c: Customer) => {
    setOpen(false);
    setQ("");
    setResults([]);
    router.push({ pathname: "/customer/[id]/ledger", params: { id: c.id } });
  };

  return (
    <View style={ledgerStyles.wrap} testID="ledger-search-bar">
      <Pressable onPress={() => setOpen(true)} style={ledgerStyles.pill} testID="open-ledger-search">
        <Ionicons name="reader-outline" size={14} color={theme.color.brand} />
        <Text style={ledgerStyles.pillText}>Customer Ledger</Text>
        <View style={ledgerStyles.pillArrow}>
          <Ionicons name="search" size={12} color={theme.color.brand} />
        </View>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={ledgerStyles.overlay} onPress={() => setOpen(false)}>
            <Pressable style={ledgerStyles.sheet} onPress={() => {}}>
              <View style={ledgerStyles.sheetHead}>
                <Ionicons name="reader-outline" size={18} color={theme.color.brand} />
                <Text style={ledgerStyles.sheetTitle}>Find customer ledger</Text>
                <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                  <Ionicons name="close" size={20} color={theme.color.muted} />
                </Pressable>
              </View>
              <Text style={ledgerStyles.sheetSub}>Type a name or mobile — jump to the customer&apos;s ledger.</Text>
              <View style={ledgerStyles.inputWrap}>
                <Ionicons name="search" size={16} color={theme.color.muted} />
                <TextInput
                  autoFocus
                  value={q}
                  onChangeText={setQ}
                  placeholder="e.g. Ravi or 91XXXXXXXXXX"
                  placeholderTextColor={theme.color.muted}
                  style={ledgerStyles.input}
                  testID="ledger-search-input"
                />
                {loading ? <ActivityIndicator size="small" color={theme.color.brand} /> : null}
                {q && !loading ? (
                  <Pressable onPress={() => setQ("")} hitSlop={8}>
                    <Ionicons name="close-circle" size={16} color={theme.color.muted} />
                  </Pressable>
                ) : null}
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 340, marginTop: 6 }}>
                {q.trim().length < 2 ? (
                  <Text style={ledgerStyles.hint}>Type at least 2 characters to search.</Text>
                ) : results.length === 0 && !loading ? (
                  <Text style={ledgerStyles.hint}>No matching customer found.</Text>
                ) : (
                  results.map((c) => (
                    <Pressable
                      key={c.id}
                      onPress={() => openLedger(c)}
                      style={({ pressed }) => [ledgerStyles.row, pressed && { backgroundColor: theme.color.surfaceTertiary }]}
                      testID={`ledger-result-${c.id}`}
                    >
                      <View style={ledgerStyles.avatar}>
                        <Text style={ledgerStyles.avatarText}>{(c.name || "?").slice(0, 1).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={ledgerStyles.rowName} numberOfLines={1}>{c.name || "—"}</Text>
                        <Text style={ledgerStyles.rowMeta} numberOfLines={1}>{c.phone}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={theme.color.muted} />
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const ledgerStyles = StyleSheet.create({
  wrap: { marginTop: theme.space.md },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, height: 40, borderRadius: theme.radius.md,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "55",
  },
  pillText: { flex: 1, color: theme.color.brand, fontWeight: "800", fontSize: 13 },
  pillArrow: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: "#fff", alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: theme.color.brand + "55",
  },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg,
    padding: theme.space.lg, maxHeight: "80%",
  },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  sheetTitle: { flex: 1, fontSize: 16, fontWeight: "800", color: theme.color.onSurface },
  sheetSub: { fontSize: 11, color: theme.color.muted, marginTop: 4, marginBottom: 12 },
  inputWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    height: 46, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 12, backgroundColor: theme.color.surface,
  },
  input: { flex: 1, fontSize: 15, color: theme.color.onSurface },
  hint: { padding: 12, textAlign: "center", color: theme.color.muted, fontSize: 12 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: theme.radius.sm,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  avatar: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: theme.color.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 14 },
  rowName: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
  rowMeta: { fontSize: 11, color: theme.color.muted, marginTop: 1 },
});


function AddCustomerModal({ visible, onClose, onAdded }: { visible: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (visible) { setName(""); setPhone(""); setAddress(""); setNote(""); setErr(""); }
  }, [visible]);

  const submit = async () => {
    if (!name.trim() || !phone.trim() || !address.trim()) { setErr("Name, phone and address are required."); return; }
    setSaving(true);
    try {
      await api.createCustomer(name.trim(), phone.trim(), note.trim(), address.trim());
      onAdded();
    } catch (e: any) {
      const msg = String(e?.message || "");
      setErr(msg.includes("409") ? "Phone number already exists." : "Failed to add.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <KeyboardAwareScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bottomOffset={24}
            contentContainerStyle={{ paddingBottom: theme.space.xl }}
          >
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Add Customer</Text>
            <View style={{ height: theme.space.md }} />
            <TextInput
              placeholder="Name"
              placeholderTextColor={theme.color.muted}
              value={name}
              onChangeText={setName}
              style={styles.input}
              testID="add-name-input"
            />
            <TextInput
              placeholder="Phone number"
              placeholderTextColor={theme.color.muted}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              style={styles.input}
              testID="add-phone-input"
            />
            <TextInput
              placeholder="Address"
              placeholderTextColor={theme.color.muted}
              value={address}
              onChangeText={setAddress}
              multiline
              style={[styles.input, { minHeight: 56, textAlignVertical: "top" }]}
              testID="add-address-input"
            />
            <TextInput
              placeholder="Note (optional) — e.g. interested in 3-door cabinet"
              placeholderTextColor={theme.color.muted}
              value={note}
              onChangeText={setNote}
              multiline
              style={[styles.input, { minHeight: 56, textAlignVertical: "top" }]}
              testID="add-note-input"
            />
            {err ? <Text style={styles.errText}>{err}</Text> : null}
            <Pressable
              onPress={submit}
              style={[styles.primaryBtn, saving && { opacity: 0.6 }]}
              disabled={saving}
              testID="submit-add-customer"
            >
              <Text style={styles.primaryBtnText}>{saving ? "Saving..." : "Add"}</Text>
            </Pressable>
          </KeyboardAwareScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  header: {
    backgroundColor: theme.color.surfaceSecondary,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
    paddingBottom: theme.space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    marginBottom: theme.space.md,
  },
  brandLogo: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#fff",
  },
  brandName: {
    fontSize: theme.font.scale.lg,
    fontWeight: "800",
    color: theme.color.onSurface,
    letterSpacing: 0.2,
  },
  brandTagline: {
    fontSize: 11,
    color: theme.color.muted,
    marginTop: 2,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  headerTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: theme.space.sm },
  headerTitle: { fontSize: theme.font.scale.xxl, fontWeight: "800", color: theme.color.onSurface },
  headerSubtitle: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  metricBox: { alignItems: "flex-end" },
  metricValue: { fontSize: 28, fontWeight: "800", color: theme.color.brand, letterSpacing: -0.5 },
  metricDenominator: { fontSize: 16, color: theme.color.muted, fontWeight: "600" },
  metricLabel: { fontSize: 11, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 1 },
  progressTrack: { height: 8, borderRadius: theme.radius.pill, backgroundColor: theme.color.surfaceTertiary, marginTop: theme.space.md, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: theme.color.brand, borderRadius: theme.radius.pill },
  searchRow: {
    flexDirection: "row", alignItems: "center", marginTop: theme.space.md,
    backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md, height: 40,
  },
  searchInput: { flex: 1, color: theme.color.onSurface, fontSize: theme.font.scale.base },
  addBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.color.brand, alignItems: "center", justifyContent: "center", marginLeft: theme.space.sm },
  chipRow: { gap: theme.space.sm, paddingHorizontal: 0, paddingTop: theme.space.md, paddingBottom: 2 },
  chip: {
    flexShrink: 0, height: 36, paddingHorizontal: theme.space.md, borderRadius: theme.radius.pill,
    borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, justifyContent: "center",
  },
  chipText: { color: theme.color.onSurfaceTertiary, fontSize: theme.font.scale.sm, fontWeight: "600" },
  card: {
    flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md, padding: theme.space.md, borderWidth: 1, borderColor: theme.color.border,
  },
  cardLeft: { flexDirection: "row", alignItems: "center", flex: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.brandTertiary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 18 },
  name: { color: theme.color.onSurface, fontSize: theme.font.scale.lg, fontWeight: "700" },
  phone: { color: theme.color.onSurfaceTertiary, fontSize: theme.font.scale.base, marginTop: 2 },
  badgeRow: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 11, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "600" },
  waTag: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: 4, backgroundColor: "#E8F8EE", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  waTagText: { fontSize: 10, color: "#25D366", fontWeight: "700", textTransform: "uppercase" },
  dialBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.color.brand, alignItems: "center", justifyContent: "center", marginLeft: theme.space.md },
  emptyTitle: { marginTop: theme.space.md, fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  emptyText: { marginTop: 6, fontSize: theme.font.scale.base, color: theme.color.muted, textAlign: "center" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "85%",
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  sheetTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  sheetSubtitle: { fontSize: theme.font.scale.base, color: theme.color.muted, marginTop: 4 },
  statusOption: { flexDirection: "row", alignItems: "center", paddingVertical: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border, gap: theme.space.md },
  statusOptionText: { fontSize: theme.font.scale.lg, color: theme.color.onSurface, fontWeight: "600" },
  input: {
    borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md, height: 48, fontSize: theme.font.scale.base,
    color: theme.color.onSurface, marginBottom: theme.space.md, backgroundColor: theme.color.surface,
  },
  primaryBtn: { backgroundColor: theme.color.brand, borderRadius: theme.radius.md, height: 52, alignItems: "center", justifyContent: "center", marginTop: theme.space.sm },
  primaryBtnText: { color: theme.color.onBrand, fontSize: theme.font.scale.lg, fontWeight: "700" },
  errText: { color: theme.color.error, marginBottom: theme.space.sm, fontSize: theme.font.scale.base },
});
