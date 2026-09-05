import {
  View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, Alert, RefreshControl,
  TextInput, Modal, KeyboardAvoidingView, Platform, Linking, ScrollView,
} from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/lib/theme";
import { api, Sale, API, TOKEN_KEY } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { storage } from "@/src/utils/storage";
import PunchSaleModal from "@/src/components/PunchSaleModal";

export default function SalesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [sales, setSales] = useState<Sale[]>([]);
  const [today, setToday] = useState({ count: 0, revenue: 0, profit: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<"mine" | "all">("all");
  const [punchOpen, setPunchOpen] = useState(false);
  const [editSale, setEditSale] = useState<Sale | null>(null);
  const [purchaseInput, setPurchaseInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [ownEdit, setOwnEdit] = useState<Sale | null>(null);
  const [ownAmount, setOwnAmount] = useState("");
  const [ownProduct, setOwnProduct] = useState("");
  const [ownNotes, setOwnNotes] = useState("");
  const [ownPurchase, setOwnPurchase] = useState("");
  const [savingOwn, setSavingOwn] = useState(false);
  const [ownErr, setOwnErr] = useState("");
  // Deep-link highlight (e.g. from a LINKED receipt tag in the Daybook)
  const params = useLocalSearchParams<{ highlight?: string }>();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRef = useRef<FlatList<Sale>>(null);
  useEffect(() => {
    if (params?.highlight) {
      setHighlightId(String(params.highlight));
      router.setParams({ highlight: undefined } as any);
      const t = setTimeout(() => setHighlightId(null), 6000);
      return () => clearTimeout(t);
    }
  }, [params?.highlight]);
  useEffect(() => {
    if (!highlightId || sales.length === 0) return;
    const idx = sales.findIndex((s) => s.id === highlightId);
    if (idx >= 0) {
      setTimeout(() => listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.2 }), 300);
    }
  }, [highlightId, sales]);

  const [ownCustomer, setOwnCustomer] = useState("");
  const [ownMode, setOwnMode] = useState<"cash" | "online" | "mixed">("cash");
  const [ownCash, setOwnCash] = useState("");
  const [ownOnline, setOwnOnline] = useState("");
  const [ownDate, setOwnDate] = useState("");

  useEffect(() => {
    if (ownEdit) {
      setOwnAmount(String(ownEdit.amount));
      setOwnProduct(ownEdit.product || "");
      setOwnNotes(ownEdit.notes || "");
      setOwnPurchase(ownEdit.purchase_amount != null ? String(ownEdit.purchase_amount) : "");
      setOwnCustomer(ownEdit.customer_name || "");
      setOwnMode((ownEdit.payment_mode as any) || "cash");
      setOwnCash(String(ownEdit.cash_amount ?? ""));
      setOwnOnline(String(ownEdit.online_amount ?? ""));
      setOwnDate(ownEdit.date_key || "");
      setOwnErr("");
    }
  }, [ownEdit]);

  const saveOwn = async () => {
    if (!ownEdit) return;
    const n = parseFloat(ownAmount);
    if (Number.isNaN(n) || n < 0) { setOwnErr("Enter a valid amount"); return; }
    const patch: Parameters<typeof api.updateSale>[1] = {
      amount: n, product: ownProduct.trim(), notes: ownNotes.trim(), customer_name: ownCustomer.trim(),
    };
    // Payment split → amount is always cash + online
    if (ownMode === "cash") { patch.cash_amount = n; patch.online_amount = 0; }
    else if (ownMode === "online") { patch.cash_amount = 0; patch.online_amount = n; }
    else {
      const c = parseFloat(ownCash || "0") || 0;
      const o = parseFloat(ownOnline || "0") || 0;
      if (Math.abs(c + o - n) > 0.01) { setOwnErr(`Cash ₹${c} + Online ₹${o} must equal amount ₹${n}`); return; }
      patch.cash_amount = c; patch.online_amount = o;
    }
    if (isAdmin && ownDate.trim() && ownDate.trim() !== ownEdit.date_key) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ownDate.trim())) { setOwnErr("Date must be YYYY-MM-DD"); return; }
      patch.date_key = ownDate.trim();
    }
    if (isAdmin && ownPurchase.trim() !== "") {
      const p = parseFloat(ownPurchase);
      if (Number.isNaN(p) || p < 0) { setOwnErr("Enter a valid purchase cost"); return; }
      patch.purchase_amount = p;
    }
    setSavingOwn(true);
    setOwnErr("");
    try {
      await api.updateSale(ownEdit.id, patch);
      setOwnEdit(null);
      load();
    } catch (e: any) {
      setOwnErr(String(e?.message || "Update failed"));
    } finally {
      setSavingOwn(false);
    }
  };

  const deleteSale = (sale: Sale) => {
    if (!isAdmin) return;
    const doDelete = async () => {
      try {
        await api.deleteSale(sale.id);
        setOwnEdit(null);
        load();
      } catch (e: any) {
        setOwnErr(String(e?.message || "Delete failed"));
      }
    };
    // Alert.alert is a no-op on web → use the browser confirm there
    if (Platform.OS === "web") {
      if (window.confirm(`Delete this sale (${sale.customer_name || "Walk-in"} · ₹${sale.amount})? This cannot be undone.`)) doDelete();
      return;
    }
    Alert.alert("Delete sale?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doDelete },
    ]);
  };
  const deleteOwn = () => { if (ownEdit) deleteSale(ownEdit); };

  const load = useCallback(async () => {
    try {
      const [list, tstats] = await Promise.all([
        api.listSales(scope),
        api.salesToday(scope),
      ]);
      setSales(list);
      setToday({ count: tstats.count, revenue: tstats.revenue, profit: (tstats as any).profit ?? 0 });
    } catch (e) { console.log("sales err", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [scope]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const fmtAmt = (n: number) =>
    "₹" + Math.round(n).toLocaleString("en-IN");

  const savePurchase = async () => {
    if (!editSale) return;
    const n = parseFloat(purchaseInput);
    if (Number.isNaN(n) || n < 0) return;
    setSaving(true);
    try {
      const t = await storage.secureGet(TOKEN_KEY, "");
      const res = await fetch(`${API}/sales/${editSale.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ purchase_amount: n }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEditSale(null);
      load();
    } catch (e) { console.log(e); }
    finally { setSaving(false); }
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="sales-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Sales</Text>
          <Text style={styles.hdrSub}>{scope === "all" ? "All employees" : "Your sales"}</Text>
        </View>
        <Pressable
          onPress={() => setPunchOpen(true)}
          style={styles.punchBtn}
          testID="punch-sale-btn"
        >
          <Ionicons name="add-circle" size={18} color="#fff" />
          <Text style={styles.punchText}>Punch</Text>
        </Pressable>
      </View>

      <View style={styles.summary}>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>{scope === "all" ? "Team sales today" : "My sales today"}</Text>
          <Text style={styles.summaryValue}>{today.count}</Text>
        </View>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>{scope === "all" ? "Team revenue" : "My revenue"}</Text>
          <Text style={styles.summaryValue}>{fmtAmt(today.revenue)}</Text>
        </View>
        {isAdmin ? (
          <View style={styles.summaryTile}>
            <Text style={styles.summaryLabel}>Today&apos;s profit</Text>
            <Text style={[styles.summaryValue, { color: today.profit >= 0 ? theme.color.success : theme.color.error }]}>
              {fmtAmt(today.profit)}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.scopeRow}>
        {(["all", "mine"] as const).map((k) => {
          const active = scope === k;
          return (
            <Pressable
              key={k}
              onPress={() => setScope(k)}
              style={[styles.scopeChip, active && styles.scopeActive]}
              testID={`sales-scope-${k}`}
            >
              <Text style={[styles.scopeText, active && { color: theme.color.brand, fontWeight: "800" }]}>
                {k === "all" ? "All employees" : "My sales"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : sales.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="cash-outline" size={56} color={theme.color.borderStrong} />
          <Text style={styles.emptyTitle}>No sales yet</Text>
          <Text style={styles.emptyText}>Tap Punch to log your first sale.</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={sales}
          keyExtractor={(s) => s.id}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true }), 200);
          }}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
          }
          renderItem={({ item }) => {
            const canEditOwn = !isAdmin && item.user === user?.username;
            const canEditAny = isAdmin;
            const canEdit = canEditOwn || canEditAny;
            return (
            <View style={[styles.card, highlightId === item.id && styles.cardHighlight]} testID={`sale-row-${item.id}`}>
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    {item.customer_name || "Walk-in"}
                    {item.product ? <Text style={styles.cardProduct}>  ·  {item.product}</Text> : null}
                  </Text>
                  <Text style={styles.cardMeta}>
                    {isAdmin && item.display_name ? `${item.display_name} · ` : ""}{fmtDate(item.timestamp)}
                  </Text>
                </View>
                <Text style={styles.cardAmount}>{fmtAmt(item.amount)}</Text>
                {canEdit ? (
                  <Pressable
                    onPress={() => setOwnEdit(item)}
                    style={styles.ownEditBtn}
                    testID={`edit-sale-${item.id}`}
                    hitSlop={8}
                  >
                    <Ionicons name="create-outline" size={16} color={theme.color.brand} />
                  </Pressable>
                ) : null}
                {isAdmin ? (
                  <Pressable
                    onPress={() => deleteSale(item)}
                    style={[styles.ownEditBtn, { backgroundColor: "#FDE8E6", marginLeft: 6 }]}
                    testID={`delete-sale-${item.id}`}
                    hitSlop={8}
                  >
                    <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                  </Pressable>
                ) : null}
              </View>

              {isAdmin ? (
                <View style={styles.pnlRow}>
                  <Pressable
                    onPress={() => {
                      setEditSale(item);
                      setPurchaseInput(item.purchase_amount != null ? String(item.purchase_amount) : "");
                    }}
                    style={styles.purchaseChip}
                    testID={`edit-purchase-${item.id}`}
                  >
                    <Ionicons name="pricetag-outline" size={12} color={theme.color.muted} />
                    <Text style={styles.purchaseText}>
                      {item.purchase_amount != null ? `Cost ${fmtAmt(item.purchase_amount)}` : "Add cost"}
                    </Text>
                  </Pressable>
                  {item.purchase_amount != null ? (
                    <View style={[styles.profitChip, { backgroundColor: item.profit >= 0 ? "#E8F8EE" : "#FDE8E6" }]}>
                      <Text style={[styles.profitText, { color: item.profit >= 0 ? theme.color.success : theme.color.error }]}>
                        {item.profit >= 0 ? "Profit " : "Loss "}{fmtAmt(Math.abs(item.profit))}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {item.notes ? <Text style={styles.cardNotes} numberOfLines={2}>{item.notes}</Text> : null}

              {/* Sales-level receipt badges (prevents duplicate proof-of-payment) + Ledger link */}
              <View style={styles.saleFooterRow}>
                {(item.linked_receipts && item.linked_receipts.length > 0) ? (
                  <View style={styles.rcpChipsRow}>
                    {item.linked_receipts.slice(0, 3).map((r) => (
                      <Pressable
                        key={r.id}
                        onPress={() => {
                          if (!r.pdf_token) return;
                          const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${r.pdf_token}`;
                          Linking.openURL(url).catch(() => {});
                        }}
                        style={styles.rcpChip}
                        testID={`sale-linked-rcp-${r.id}`}
                      >
                        <Ionicons name="document-text-outline" size={10} color={theme.color.brand} />
                        <Text style={styles.rcpChipText}>{r.receipt_no}</Text>
                        {r.reference_no ? (
                          <Text style={styles.rcpChipRef} numberOfLines={1}>Ref {r.reference_no}</Text>
                        ) : null}
                        <Text style={styles.rcpChipAmt}>{fmtAmt(r.amount)}</Text>
                      </Pressable>
                    ))}
                    {item.linked_receipts.length > 3 ? (
                      <Text style={styles.rcpChipMore}>+{item.linked_receipts.length - 3}</Text>
                    ) : null}
                  </View>
                ) : (
                  <Pressable
                    onPress={() => router.push({ pathname: "/receipts", params: { src_type: "sale", src_id: item.id, customer: item.customer_name || "", amount: String(item.amount) } })}
                    style={styles.createRcptBtn}
                    testID={`sale-create-rcpt-${item.id}`}
                  >
                    <Ionicons name="add-circle-outline" size={11} color={theme.color.brand} />
                    <Text style={styles.createRcptText}>+ Receipt</Text>
                  </Pressable>
                )}
                {item.customer_id ? (
                  <Pressable
                    onPress={() => router.push({ pathname: "/customer/[id]/ledger", params: { id: item.customer_id! } })}
                    style={styles.ledgerBtn}
                    testID={`sale-ledger-${item.id}`}
                  >
                    <Ionicons name="reader-outline" size={11} color={theme.color.muted} />
                    <Text style={styles.ledgerBtnText}>Ledger</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
          }}
        />
      )}

      <PunchSaleModal
        visible={punchOpen}
        onClose={() => setPunchOpen(false)}
        onSaved={() => { setPunchOpen(false); load(); }}
      />

      <Modal visible={!!editSale} transparent animationType="slide" onRequestClose={() => setEditSale(null)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.overlay} onPress={() => setEditSale(null)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <View style={styles.handle} />
              <Text style={styles.sheetTitle}>Set purchase cost</Text>
              <Text style={styles.sheetSub}>
                {editSale?.customer_name || "Walk-in"} · Sold for {editSale ? fmtAmt(editSale.amount) : ""}
              </Text>
              <TextInput
                value={purchaseInput}
                onChangeText={setPurchaseInput}
                keyboardType="decimal-pad"
                placeholder="e.g. 900"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
                testID="purchase-input"
              />
              <Pressable onPress={savePurchase} disabled={saving} style={[styles.saveBtn, saving && { opacity: 0.6 }]} testID="save-purchase">
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save cost</Text>}
              </Pressable>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!ownEdit} transparent animationType="slide" onRequestClose={() => setOwnEdit(null)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.overlay} onPress={() => setOwnEdit(null)}>
            <Pressable style={[styles.sheet, { maxHeight: "92%" }]} onPress={() => {}}>
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.handle} />
              <Text style={styles.sheetTitle}>{isAdmin ? "Edit sale" : "Edit my sale"}</Text>
              <Text style={styles.sheetSub}>
                {ownEdit?.customer_name || "Walk-in"}
                {isAdmin && ownEdit?.display_name ? `  ·  by ${ownEdit.display_name}` : ""}
              </Text>

              <Text style={styles.fieldLabel}>Customer name</Text>
              <TextInput
                value={ownCustomer}
                onChangeText={setOwnCustomer}
                placeholder="Walk-in"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
                testID="own-customer"
              />
              <Text style={styles.fieldLabel}>Amount (₹)</Text>
              <TextInput
                value={ownAmount}
                onChangeText={setOwnAmount}
                keyboardType="decimal-pad"
                placeholder="e.g. 1500"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
                testID="own-amount"
              />
              <Text style={styles.fieldLabel}>Payment received as</Text>
              <View style={styles.scopeRow}>
                {(["cash", "online", "mixed"] as const).map((m) => {
                  const active = ownMode === m;
                  return (
                    <Pressable key={m} onPress={() => setOwnMode(m)} style={[styles.scopeChip, active && styles.scopeActive]} testID={`own-mode-${m}`}>
                      <Text style={[styles.scopeText, active && { color: theme.color.brand, fontWeight: "800" }]}>
                        {m === "cash" ? "Cash" : m === "online" ? "Online" : "Mixed"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {ownMode === "mixed" ? (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput value={ownCash} onChangeText={setOwnCash} keyboardType="decimal-pad" placeholder="Cash ₹" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} testID="own-cash" />
                  <TextInput value={ownOnline} onChangeText={setOwnOnline} keyboardType="decimal-pad" placeholder="Online ₹" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} testID="own-online" />
                </View>
              ) : null}
              {isAdmin ? (
                <>
                  <Text style={styles.fieldLabel}>Sale date (YYYY-MM-DD) — admin only</Text>
                  <TextInput value={ownDate} onChangeText={setOwnDate} placeholder="2026-01-31" placeholderTextColor={theme.color.muted} style={styles.input} testID="own-date" />
                </>
              ) : null}
              <Text style={styles.fieldLabel}>Product / service</Text>
              <TextInput
                value={ownProduct}
                onChangeText={setOwnProduct}
                placeholder="e.g. Silver plan"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
                testID="own-product"
              />
              {isAdmin ? (
                <>
                  <Text style={styles.fieldLabel}>Purchase cost / COGS (₹) — admin only</Text>
                  <TextInput
                    value={ownPurchase}
                    onChangeText={setOwnPurchase}
                    keyboardType="decimal-pad"
                    placeholder="Leave blank to keep unchanged"
                    placeholderTextColor={theme.color.muted}
                    style={styles.input}
                    testID="own-purchase"
                  />
                </>
              ) : null}
              <Text style={styles.fieldLabel}>Notes</Text>
              <TextInput
                value={ownNotes}
                onChangeText={setOwnNotes}
                multiline
                placeholder="Anything to remember about this sale…"
                placeholderTextColor={theme.color.muted}
                style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                testID="own-notes"
              />
              {ownErr ? <Text style={styles.errText}>{ownErr}</Text> : null}
              <Pressable
                onPress={saveOwn}
                disabled={savingOwn}
                style={[styles.saveBtn, savingOwn && { opacity: 0.6 }]}
                testID="save-own"
              >
                {savingOwn ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save changes</Text>}
              </Pressable>
              {isAdmin ? (
                <Pressable onPress={deleteOwn} style={styles.deleteBtn} testID="delete-sale">
                  <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                  <Text style={styles.deleteBtnText}>Delete this sale</Text>
                </Pressable>
              ) : null}
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  punchBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.color.success, paddingHorizontal: theme.space.md, height: 40, borderRadius: theme.radius.pill,
  },
  punchText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  summary: {
    flexDirection: "row", gap: theme.space.md,
    padding: theme.space.lg, backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  summaryTile: {
    flex: 1, backgroundColor: theme.color.surface, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.border, padding: theme.space.md,
  },
  summaryLabel: { fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase" },
  summaryValue: { fontSize: 24, fontWeight: "800", color: theme.color.onSurface, marginTop: 4, letterSpacing: -0.3 },
  scopeRow: { flexDirection: "row", gap: theme.space.sm, padding: theme.space.md, backgroundColor: theme.color.surfaceSecondary },
  scopeChip: {
    paddingHorizontal: theme.space.md, height: 32, borderRadius: theme.radius.pill,
    justifyContent: "center", borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
  },
  scopeActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  scopeText: { fontSize: 12, color: theme.color.muted, fontWeight: "700" },
  card: {
    backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md,
    padding: theme.space.md, borderWidth: 1, borderColor: theme.color.border,
  },
  cardHighlight: { borderColor: theme.color.brand, borderWidth: 2, backgroundColor: theme.color.brandTertiary },
  cardHead: { flexDirection: "row", alignItems: "center" },
  cardTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
  cardProduct: { fontSize: 13, color: theme.color.muted, fontWeight: "600" },
  cardMeta: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  cardAmount: { fontSize: 18, fontWeight: "800", color: theme.color.success, marginLeft: theme.space.md },
  cardNotes: { marginTop: theme.space.sm, fontSize: 13, color: theme.color.onSurfaceTertiary },
  pnlRow: { flexDirection: "row", gap: theme.space.sm, marginTop: theme.space.sm, alignItems: "center", flexWrap: "wrap" },
  purchaseChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: theme.color.surfaceTertiary,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: theme.radius.pill,
    borderWidth: 1, borderColor: theme.color.border, borderStyle: "dashed",
  },
  purchaseText: { fontSize: 11, fontWeight: "700", color: theme.color.onSurfaceTertiary },
  profitChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: theme.radius.pill },
  profitText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.3 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  sheetTitle: { fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  sheetSub: { fontSize: 13, color: theme.color.muted, marginTop: 4 },
  input: {
    marginTop: theme.space.lg, height: 48, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 16, fontWeight: "700",
    backgroundColor: theme.color.surface,
  },
  saveBtn: {
    marginTop: theme.space.lg, backgroundColor: theme.color.brand,
    height: 52, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center",
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  ownEditBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.color.brandTertiary,
    marginLeft: 8,
  },
  fieldLabel: {
    marginTop: theme.space.md, marginBottom: 4,
    fontSize: 11, fontWeight: "700", color: theme.color.muted,
    letterSpacing: 1, textTransform: "uppercase",
  },
  errText: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  deleteBtn: {
    marginTop: theme.space.md,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    height: 46, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.error + "44",
  },
  deleteBtnText: { color: theme.color.error, fontWeight: "800", fontSize: 14 },
  emptyTitle: { marginTop: theme.space.md, fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  emptyText: { marginTop: 6, fontSize: theme.font.scale.base, color: theme.color.muted, textAlign: "center" },

  saleFooterRow: {
    marginTop: theme.space.sm,
    flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6,
  },
  rcpChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, flex: 1, alignItems: "center" },
  rcpChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  rcpChipText: { fontSize: 9, fontWeight: "800", color: theme.color.brand },
  rcpChipRef: { fontSize: 9, fontWeight: "700", color: theme.color.warning, marginLeft: 2 },
  rcpChipAmt: { fontSize: 9, fontWeight: "700", color: theme.color.onSurface, marginLeft: 2 },
  rcpChipMore: { fontSize: 9, color: theme.color.muted, fontWeight: "700" },
  createRcptBtn: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
    borderWidth: 1, borderColor: theme.color.brand + "55", borderStyle: "dashed",
  },
  createRcptText: { fontSize: 10, fontWeight: "800", color: theme.color.brand },
  ledgerBtn: {
    marginLeft: "auto",
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
    backgroundColor: theme.color.surfaceTertiary,
  },
  ledgerBtnText: { fontSize: 10, fontWeight: "700", color: theme.color.muted },
});
