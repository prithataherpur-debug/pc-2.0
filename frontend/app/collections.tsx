import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Modal,
  TextInput, RefreshControl, Alert, Linking,
} from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { theme } from "@/src/lib/theme";
import { api, CollectionEntry, LinkedReceipt, User, DENOMS } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

const fmtAmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const todayKey = () => new Date().toISOString().slice(0, 10);

export default function CollectionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [entries, setEntries] = useState<CollectionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collector, setCollector] = useState<User | null>(null);
  const [employees, setEmployees] = useState<User[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [edit, setEdit] = useState<CollectionEntry | "new" | null>(null);
  const [toast, setToast] = useState("");
  // Deep-link highlight (e.g. from a LINKED receipt tag in the Daybook)
  const params = useLocalSearchParams<{ highlight?: string }>();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRef = useRef<FlatList<CollectionEntry>>(null);
  useEffect(() => {
    if (params?.highlight) {
      setHighlightId(String(params.highlight));
      router.setParams({ highlight: undefined } as any);
      const t = setTimeout(() => setHighlightId(null), 6000);
      return () => clearTimeout(t);
    }
  }, [params?.highlight]);
  useEffect(() => {
    if (!highlightId || entries.length === 0) return;
    const idx = entries.findIndex((e) => e.id === highlightId);
    if (idx >= 0) {
      setTimeout(() => listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.2 }), 300);
    }
  }, [highlightId, entries]);

  const load = useCallback(async () => {
    try {
      const [rows, col] = await Promise.all([
        api.listCollections(undefined, undefined, 200),
        api.getCollector(),
      ]);
      setEntries(rows);
      setCollector(col.collector);
      if (isAdmin) {
        const us = await api.listUsers();
        setEmployees(us.filter((u) => u.role === "employee"));
      }
    } catch (e) {
      console.log("collections load err", e);
    } finally { setLoading(false); setRefreshing(false); }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const isCollector = collector?.username === user?.username;
  const canAdd = true; // Any employee can add a collection entry now

  const totals = useMemo(() => {
    return entries.reduce(
      (acc, e) => ({
        cash: acc.cash + (e.cash_total || 0),
        online: acc.online + (e.online_total || 0),
        total: acc.total + (e.grand_total || 0),
      }),
      { cash: 0, online: 0, total: 0 },
    );
  }, [entries]);

  const assign = async (username: string | null) => {
    setAssignOpen(false);
    try {
      const res = await api.setCollector(username);
      setCollector(res.collector);
      showToast(username ? `Collector set to ${res.collector?.display_name || res.collector?.username}` : "Collector cleared");
    } catch (e: any) {
      showToast(String(e?.message || "Failed"));
    }
  };

  const removeEntry = (id: string) => {
    Alert.alert("Delete entry?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          try {
            await api.deleteCollection(id);
            showToast("Deleted");
            load();
          } catch (e: any) { showToast(String(e?.message || "Delete failed")); }
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="collections-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Due collection</Text>
          <Text style={styles.hdrSub}>Daily cash + online receipts</Text>
        </View>
        {canAdd ? (
          <Pressable onPress={() => setEdit("new")} style={styles.addBtn} testID="add-collection">
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={styles.addBtnText}>New</Text>
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={entries}
          keyExtractor={(e) => e.id}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true }), 200);
          }}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brand} />
          }
          ListHeaderComponent={
            <View>
              <View style={styles.collectorCard}>
                <View style={styles.collectorIcon}>
                  <Ionicons name="person-circle" size={28} color={theme.color.brand} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.collectorLabel}>ASSIGNED COLLECTOR</Text>
                  <Text style={styles.collectorName}>
                    {collector ? (collector.display_name || collector.username) : "Not assigned"}
                  </Text>
                  {collector ? <Text style={styles.collectorSub}>@{collector.username}</Text> : null}
                </View>
                {isAdmin ? (
                  <Pressable onPress={() => setAssignOpen(true)} style={styles.reassignBtn} testID="assign-collector">
                    <Ionicons name="swap-horizontal" size={14} color="#fff" />
                    <Text style={styles.reassignText}>{collector ? "Change" : "Assign"}</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.summaryRow}>
                <SummaryPill label="Cash" value={fmtAmt(totals.cash)} icon="cash-outline" />
                <SummaryPill label="Online" value={fmtAmt(totals.online)} icon="card-outline" />
                <SummaryPill label="Total" value={fmtAmt(totals.total)} icon="wallet-outline" accent />
              </View>

              {/* Any employee can add — collector designation is just for reporting */}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="wallet" size={44} color={theme.color.borderStrong} />
              <Text style={styles.emptyTitle}>No collections yet</Text>
              <Text style={styles.emptySub}>Tap New to add today&apos;s collection.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                if (isAdmin || item.user === user?.username) setEdit(item);
              }}
              style={[styles.card, highlightId === item.id && styles.cardHighlight]}
              testID={`col-${item.id}`}
            >
              <View style={styles.cardTop}>
                <View>
                  <Text style={styles.cardDate}>{item.date_key}</Text>
                  <Text style={styles.cardMeta}>
                    {item.display_name || item.user}
                    {item.notes ? <Text style={styles.cardMetaThin}>  ·  {item.notes}</Text> : null}
                  </Text>
                </View>
                <Text style={styles.cardTotal}>{fmtAmt(item.grand_total)}</Text>
              </View>
              <View style={styles.breakdownRow}>
                <View style={styles.chip}><Ionicons name="cash-outline" size={11} color={theme.color.success} /><Text style={styles.chipText}>{fmtAmt(item.cash_total)}</Text></View>
                <View style={styles.chip}><Ionicons name="card-outline" size={11} color={theme.color.brand} /><Text style={styles.chipText}>{fmtAmt(item.online_total)}</Text></View>
                <View style={{ flex: 1 }} />
                {isAdmin ? (
                  <Pressable onPress={() => removeEntry(item.id)} style={styles.trashBtn} testID={`del-col-${item.id}`} hitSlop={8}>
                    <Ionicons name="trash-outline" size={14} color={theme.color.error} />
                  </Pressable>
                ) : null}
              </View>
              {/* Denomination chips — shown only for legacy records that still carry denominations */}
              {item.denominations && Object.keys(item.denominations).length > 0 && Object.values(item.denominations).some((v) => (v as number) > 0) ? (
                <View style={styles.denomRow}>
                  {DENOMS.map((d) => {
                    const pcs = item.denominations?.[String(d)] || 0;
                    if (!pcs) return null;
                    return (
                      <View key={d} style={styles.denomChip}>
                        <Text style={styles.denomChipText}>{d}×{pcs}</Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
              {/* Linked money receipts (prevents duplicate receipts) */}
              {(item.linked_receipts && item.linked_receipts.length > 0) ? (
                <View style={styles.linkedBox}>
                  <View style={styles.linkedHead}>
                    <Ionicons name="receipt-outline" size={12} color={theme.color.brand} />
                    <Text style={styles.linkedTitle}>
                      {item.linked_receipts.length} money receipt{item.linked_receipts.length > 1 ? "s" : ""} issued
                    </Text>
                  </View>
                  <View style={styles.linkedRow}>
                    {item.linked_receipts.map((r: LinkedReceipt) => (
                      <Pressable
                        key={r.id}
                        onPress={() => {
                          if (!r.pdf_token) return;
                          const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${r.pdf_token}`;
                          Linking.openURL(url).catch(() => {});
                        }}
                        style={styles.linkedChip}
                        testID={`col-linked-${r.id}`}
                      >
                        <Ionicons name="document-text-outline" size={10} color={theme.color.brand} />
                        <Text style={styles.linkedChipText}>{r.receipt_no}</Text>
                        {r.reference_no ? (
                          <Text style={styles.linkedChipRef} numberOfLines={1}>Ref {r.reference_no}</Text>
                        ) : null}
                        <Text style={styles.linkedChipAmt}>{fmtAmt(r.amount)}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
              {/* Any employee can create a money receipt against this collection */}
              <Pressable
                onPress={() => router.push({ pathname: "/receipts", params: { src_type: "collection", src_id: item.id } })}
                style={styles.createRcptBtn}
                testID={`col-create-rcpt-${item.id}`}
                hitSlop={4}
              >
                <Ionicons name="add-circle-outline" size={13} color={theme.color.brand} />
                <Text style={styles.createRcptText}>Create money receipt</Text>
              </Pressable>
            </Pressable>
          )}
        />
      )}

      <EntryEditor
        entry={edit}
        onClose={() => setEdit(null)}
        onSaved={(msg) => { setEdit(null); showToast(msg); load(); }}
      />

      <AssignCollectorModal
        visible={assignOpen}
        current={collector?.username || null}
        options={employees}
        onClose={() => setAssignOpen(false)}
        onPick={assign}
      />

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SummaryPill({ label, value, icon, accent }: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap; accent?: boolean }) {
  return (
    <View style={[styles.pill, accent && styles.pillAccent]}>
      <Ionicons name={icon} size={16} color={accent ? "#fff" : theme.color.brand} />
      <Text style={[styles.pillLabel, accent && { color: "#fff" }]}>{label}</Text>
      <Text style={[styles.pillValue, accent && { color: "#fff" }]}>{value}</Text>
    </View>
  );
}

function EntryEditor({
  entry, onClose, onSaved,
}: {
  entry: CollectionEntry | "new" | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isNew = entry === "new";
  const editing = entry && entry !== "new" ? (entry as CollectionEntry) : null;
  const visible = entry !== null;

  const [dateKey, setDateKey] = useState("");
  const [cash, setCash] = useState("");
  const [online, setOnline] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!visible) return;
    if (isNew) {
      setDateKey(todayKey());
      setCash("");
      setOnline("");
      setNotes("");
    } else if (editing) {
      setDateKey(editing.date_key);
      setCash(String(editing.cash_total || ""));
      setOnline(String(editing.online_total || ""));
      setNotes(editing.notes || "");
    }
    setErr("");
  }, [visible, isNew, editing]);

  const cashN = parseFloat(cash || "0") || 0;
  const onlineN = parseFloat(online || "0") || 0;
  const grand = cashN + onlineN;

  const save = async () => {
    if (cashN === 0 && onlineN === 0) {
      setErr("Enter at least a cash or online amount.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const payload = {
        date_key: dateKey || undefined,
        cash_total: cashN,
        online_total: onlineN,
        notes,
      };
      if (isNew) {
        await api.createCollection(payload);
        onSaved("Entry added.");
      } else if (editing) {
        await api.updateCollection(editing.id, payload);
        onSaved("Entry updated.");
      }
    } catch (e: any) {
      setErr(String(e?.message || "Save failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            <Ionicons name="wallet-outline" size={22} color={theme.color.brand} />
            <Text style={styles.sheetTitle}>{isNew ? "New collection" : "Edit collection"}</Text>
          </View>
          <KeyboardAwareScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bottomOffset={24}
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingBottom: theme.space.md }}
          >
            <Text style={styles.label}>Date</Text>
            <TextInput
              value={dateKey}
              onChangeText={setDateKey}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="col-date"
            />

            <Text style={styles.label}>Cash collection (₹)</Text>
            <TextInput
              value={cash}
              onChangeText={setCash}
              keyboardType="decimal-pad"
              placeholder="e.g. 5000"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="col-cash"
            />

            <Text style={styles.label}>Online collection (₹)</Text>
            <TextInput
              value={online}
              onChangeText={setOnline}
              keyboardType="decimal-pad"
              placeholder="e.g. 12500"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="col-online"
            />

            <View style={styles.grandBox}>
              <Text style={styles.grandLabel}>Grand total</Text>
              <Text style={styles.grandValue}>{fmtAmt(grand)}</Text>
            </View>

            <Text style={styles.label}>Notes</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Anything to remember about today's collection…"
              placeholderTextColor={theme.color.muted}
              style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
              testID="col-notes"
            />

            {err ? <Text style={styles.err}>{err}</Text> : null}
          </KeyboardAwareScrollView>

          {/* Sticky footer — always visible above the keyboard */}
          <View style={styles.stickyFooter}>
            <Pressable onPress={save} disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} testID="save-collection">
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>{isNew ? "Save collection" : "Update collection"}</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function AssignCollectorModal({
  visible, current, options, onClose, onPick,
}: {
  visible: boolean;
  current: string | null;
  options: User[];
  onClose: () => void;
  onPick: (username: string | null) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            <Ionicons name="swap-horizontal" size={22} color={theme.color.brand} />
            <Text style={styles.sheetTitle}>Assign collector</Text>
          </View>

          <FlatList
            data={options}
            keyExtractor={(u) => u.username}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            contentContainerStyle={{ paddingBottom: 12 }}
            renderItem={({ item }) => {
              const active = item.username === current;
              return (
                <Pressable onPress={() => onPick(item.username)} style={[styles.pickRow, active && styles.pickRowActive]} testID={`pick-${item.username}`}>
                  <View style={styles.pickAvatar}><Text style={styles.pickAvatarText}>{(item.display_name || item.username).slice(0, 1).toUpperCase()}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickName}>{item.display_name || item.username}</Text>
                    <Text style={styles.pickSub}>@{item.username}</Text>
                  </View>
                  {active ? <Ionicons name="checkmark-circle" size={20} color={theme.color.success} /> : <Ionicons name="chevron-forward" size={16} color={theme.color.muted} />}
                </Pressable>
              );
            }}
          />
          {current ? (
            <Pressable onPress={() => onPick(null)} style={styles.clearBtn} testID="clear-collector">
              <Ionicons name="close-circle-outline" size={16} color={theme.color.error} />
              <Text style={styles.clearBtnText}>Clear collector</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.color.brand,
    paddingHorizontal: 12, height: 36, borderRadius: theme.radius.pill,
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  collectorCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    marginBottom: theme.space.md,
  },
  collectorIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.brandTertiary },
  collectorLabel: { fontSize: 10, color: theme.color.muted, letterSpacing: 1, fontWeight: "800" },
  collectorName: { fontSize: 16, fontWeight: "800", color: theme.color.onSurface, marginTop: 2 },
  collectorSub: { fontSize: 12, color: theme.color.muted, marginTop: 1 },
  reassignBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, height: 32, borderRadius: theme.radius.pill,
    backgroundColor: theme.color.brand,
  },
  reassignText: { color: "#fff", fontWeight: "700", fontSize: 12 },

  summaryRow: { flexDirection: "row", gap: theme.space.sm, marginBottom: theme.space.md },
  pill: {
    flex: 1, padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    gap: 4,
  },
  pillAccent: { backgroundColor: theme.color.brand, borderColor: theme.color.brand },
  pillLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: theme.color.muted },
  pillValue: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface },

  notice: {
    flexDirection: "row", alignItems: "center", gap: 6,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceTertiary,
    marginBottom: theme.space.md,
  },
  noticeText: { fontSize: 12, color: theme.color.muted },

  cardHighlight: { borderColor: theme.color.brand, borderWidth: 2, backgroundColor: theme.color.brandTertiary },
  card: {
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    gap: 8,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  cardDate: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  cardMeta: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  cardMetaThin: { fontSize: 12, color: theme.color.muted, fontWeight: "600" },
  cardTotal: { fontSize: 17, fontWeight: "900", color: theme.color.success },
  breakdownRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  chipText: { fontSize: 11, fontWeight: "700", color: theme.color.onSurface },
  trashBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "#FDE8E6" },
  denomRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  denomChip: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    backgroundColor: theme.color.surfaceTertiary,
  },
  denomChipText: { fontSize: 10, color: theme.color.muted, fontWeight: "700" },

  linkedBox: {
    marginTop: 8, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: theme.color.border, borderStyle: "dashed",
  },
  linkedHead: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  linkedTitle: { fontSize: 10, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.5 },
  linkedRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  linkedChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  linkedChipText: { fontSize: 9, fontWeight: "800", color: theme.color.brand },
  linkedChipRef: { fontSize: 9, fontWeight: "700", color: theme.color.warning, marginLeft: 2 },
  linkedChipAmt: { fontSize: 9, fontWeight: "700", color: theme.color.onSurface, marginLeft: 2 },

  createRcptBtn: {
    marginTop: 8,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    paddingVertical: 8, borderRadius: theme.radius.sm,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44", borderStyle: "dashed",
  },
  createRcptText: { fontSize: 11, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.3 },

  empty: { alignItems: "center", padding: theme.space.xxl, gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: 4 },
  emptySub: { fontSize: 12, color: theme.color.muted, textAlign: "center" },

  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, maxHeight: "92%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.md },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface },

  label: {
    marginTop: theme.space.md, marginBottom: 4,
    fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase",
  },
  input: {
    height: 46, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surface,
  },
  denomGrid: { gap: 8 },
  denomRowInput: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  denomLabel: { flex: 1 },
  denomFace: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface },
  denomSub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  denomMult: { fontSize: 14, color: theme.color.muted },
  denomInput: {
    width: 70, height: 36, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.color.border,
    textAlign: "center", fontSize: 15, fontWeight: "800", color: theme.color.onSurface, backgroundColor: theme.color.surfaceSecondary,
  },

  totalBox: {
    marginTop: theme.space.md,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceTertiary,
  },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  totalLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "700" },
  totalValue: { fontSize: 15, fontWeight: "900", color: theme.color.onSurface },

  grandBox: {
    marginTop: theme.space.md, padding: 12, borderRadius: theme.radius.md,
    backgroundColor: theme.color.brand,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  grandLabel: { fontSize: 12, color: "#fff", fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  grandValue: { fontSize: 22, fontWeight: "900", color: "#fff" },

  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: {
    marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md,
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  cancelBtn: { marginTop: theme.space.md, height: 44, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.color.muted, fontWeight: "700" },

  pickRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  pickRowActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  pickAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.color.brandTertiary, alignItems: "center", justifyContent: "center" },
  pickAvatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 14 },
  pickName: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
  pickSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  clearBtn: {
    marginTop: theme.space.md, height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.error + "44",
  },
  clearBtnText: { color: theme.color.error, fontWeight: "800" },

  toast: {
    position: "absolute", left: theme.space.lg, right: theme.space.lg,
    backgroundColor: theme.color.surfaceInverse,
    borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center",
  },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "700" },
});
