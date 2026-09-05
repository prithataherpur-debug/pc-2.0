import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Modal,
  TextInput, RefreshControl, Linking, Alert,
} from "react-native";
import { useCallback, useEffect, useState, useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { theme } from "@/src/lib/theme";
import { api, MoneyReceipt, API } from "@/src/lib/api";
import { CustomerPicker, PickerCustomer } from "@/src/components/CustomerPicker";
import { useAuth } from "@/src/lib/auth";
import DateNavigator, { todayKey } from "@/src/components/DateNavigator";

const fmt = (n: number) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN");
type SrcType = "sale" | "invoice" | "collection" | "other";
type Mode = "cash" | "online" | "mixed";
const SOURCES: { key: SrcType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "sale", label: "Sale", icon: "cash-outline" },
  { key: "invoice", label: "Invoice", icon: "document-text-outline" },
  { key: "collection", label: "Collection", icon: "wallet-outline" },
  { key: "other", label: "Other", icon: "ellipsis-horizontal-outline" },
];
const MODES: { key: Mode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "cash", label: "Cash", icon: "cash-outline" },
  { key: "online", label: "Online", icon: "card-outline" },
  { key: "mixed", label: "Mixed", icon: "swap-horizontal-outline" },
];

export default function ReceiptsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const params = useLocalSearchParams<{ src_type?: string; src_id?: string; customer?: string; amount?: string }>();

  const [items, setItems] = useState<MoneyReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MoneyReceipt | null>(null);
  const [prefill, setPrefill] = useState<{
    src_type?: SrcType; src_id?: string; customer?: string; amount?: string;
  } | null>(null);
  const [toast, setToast] = useState("");
  const [date, setDate] = useState<string>(todayKey());

  const load = useCallback(async () => {
    try {
      const list = await api.listReceipts(200, undefined, date);
      setItems(list);
    } catch (e) { console.log("rcpt err", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [date]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Handle deep-link params: auto-open editor pre-filled with source type
  useEffect(() => {
    if (params?.src_type) {
      const st = String(params.src_type) as SrcType;
      if (["sale", "invoice", "collection", "other"].includes(st)) {
        setPrefill({
          src_type: st,
          src_id: params.src_id ? String(params.src_id) : undefined,
          customer: params.customer ? String(params.customer) : undefined,
          amount: params.amount ? String(params.amount) : undefined,
        });
        setCreating(true);
        // Clear params so re-focus doesn't retrigger
        router.setParams({ src_type: undefined, src_id: undefined, customer: undefined, amount: undefined } as any);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.src_type, params?.src_id]);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const shareWA = async (r: MoneyReceipt) => {
    if (!r.pdf_path || !r.pdf_token) { showToast("PDF not ready"); return; }
    const url = `${API}/files/${r.pdf_path}?token=${encodeURIComponent(r.pdf_token)}`;
    const phone = (r.customer_mobile || "").replace(/\D/g, "");
    const text = `Money Receipt ${r.receipt_no} · ${fmt(r.amount)}\n${url}`;
    const wa = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
    try {
      const ok = await Linking.canOpenURL(wa);
      if (!ok) { showToast("Install WhatsApp first"); return; }
      await Linking.openURL(wa);
    } catch (e: any) { showToast(String(e?.message || "Cannot open WhatsApp")); }
  };

  const openPdf = async (r: MoneyReceipt) => {
    if (!r.pdf_path || !r.pdf_token) return;
    Linking.openURL(`${API}/files/${r.pdf_path}?token=${encodeURIComponent(r.pdf_token)}`);
  };

  const remove = (r: MoneyReceipt) => {
    Alert.alert("Delete receipt?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try { await api.deleteReceipt(r.id); showToast("Deleted"); load(); }
        catch (e: any) { showToast(String(e?.message || "Delete failed")); }
      } },
    ]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="receipts-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Money receipts</Text>
          <Text style={styles.hdrSub}>Proof of payment received</Text>
        </View>
        <Pressable onPress={() => setCreating(true)} style={styles.addBtn} testID="new-receipt">
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnText}>New</Text>
        </Pressable>
      </View>

      <DateNavigator date={date} onChange={setDate} testIDPrefix="rcpt-date" />

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brand} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="receipt-outline" size={44} color={theme.color.borderStrong} />
              <Text style={styles.emptyTitle}>No receipts on this day</Text>
              <Text style={styles.emptySub}>Use the arrows to browse another day, or tap New to log a payment.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.card} testID={`rcpt-${item.id}`}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardNo}>{item.receipt_no}</Text>
                  <Text style={styles.cardName}>{item.customer_name}</Text>
                  <Text style={styles.cardMeta}>
                    {item.date_key} · {item.display_name || item.user} · {item.payment_mode.toUpperCase()}
                    {item.source_label ? `  ·  ${item.source_label}` : ""}
                  </Text>
                  <View style={styles.refRow}>
                    {item.reference_no ? (
                      <View style={styles.refChip}>
                        <Ionicons name="pricetag-outline" size={10} color={theme.color.brand} />
                        <Text style={styles.refChipText}>Ref: {item.reference_no}</Text>
                      </View>
                    ) : (
                      <View style={[styles.refChip, styles.refChipAdvance]}>
                        <Ionicons name="hourglass-outline" size={10} color="#B45309" />
                        <Text style={[styles.refChipText, { color: "#B45309" }]}>ADVANCE</Text>
                      </View>
                    )}
                    {isAdmin ? (
                      <Pressable onPress={() => setEditing(item)} style={styles.refEditBtn} testID={`rcpt-edit-${item.id}`} hitSlop={6}>
                        <Ionicons name="create-outline" size={11} color={theme.color.brand} />
                        <Text style={styles.refEditText}>Edit</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {item.narration ? <Text style={styles.narration}>Note: {item.narration}</Text> : null}
                  {item.payment_mode === "mixed" ? (
                    <View style={styles.splitRow}>
                      <View style={styles.splitChip}>
                        <Ionicons name="cash-outline" size={10} color={theme.color.success} />
                        <Text style={styles.splitChipText}>Cash {fmt(item.cash_amount || 0)}</Text>
                      </View>
                      <View style={styles.splitChip}>
                        <Ionicons name="card-outline" size={10} color={theme.color.brand} />
                        <Text style={styles.splitChipText}>Online {fmt(item.online_amount || 0)}</Text>
                      </View>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.cardAmt}>{fmt(item.amount)}</Text>
              </View>
              <View style={styles.actionsRow}>
                <Pressable onPress={() => openPdf(item)} style={styles.actionBtn} testID={`rcpt-pdf-${item.id}`}>
                  <Ionicons name="document-outline" size={14} color={theme.color.brand} />
                  <Text style={styles.actionText}>Open PDF</Text>
                </Pressable>
                <Pressable onPress={() => shareWA(item)} style={[styles.actionBtn, styles.actionWA]} testID={`rcpt-wa-${item.id}`}>
                  <Ionicons name="logo-whatsapp" size={14} color="#fff" />
                  <Text style={[styles.actionText, { color: "#fff" }]}>WhatsApp</Text>
                </Pressable>
                {isAdmin ? (
                  <Pressable onPress={() => remove(item)} style={styles.trashBtn} testID={`rcpt-del-${item.id}`}>
                    <Ionicons name="trash-outline" size={14} color={theme.color.error} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          )}
        />
      )}

      <ReceiptEditor
        visible={creating || !!editing}
        prefill={prefill}
        editing={editing}
        onClose={() => { setCreating(false); setPrefill(null); setEditing(null); }}
        onSaved={(r, msg) => {
          const wasEdit = !!editing;
          setCreating(false); setPrefill(null); setEditing(null); showToast(msg); load();
          if (r && !wasEdit) setTimeout(() => shareWA(r), 400);
        }}
      />

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ReceiptEditor({
  visible, prefill, editing, onClose, onSaved,
}: {
  visible: boolean;
  prefill?: { src_type?: SrcType; src_id?: string; customer?: string; amount?: string } | null;
  /** Admin: when set, the sheet edits this receipt (all fields) and regenerates its PDF */
  editing?: MoneyReceipt | null;
  onClose: () => void;
  onSaved: (r: MoneyReceipt | null, msg: string) => void;
}) {
  const [customer, setCustomer] = useState<PickerCustomer>({ customer_id: null, name: "", mobile: "", address: "" });
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<Mode>("cash");
  const [cashPart, setCashPart] = useState("");
  const [onlinePart, setOnlinePart] = useState("");
  const [sourceType, setSourceType] = useState<SrcType>("other");
  const [sourceId, setSourceId] = useState<string | undefined>(undefined);
  const [refNo, setRefNo] = useState("");
  const [narration, setNarration] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [srcInfo, setSrcInfo] = useState<Awaited<ReturnType<typeof api.getReceiptSource>> | null>(null);
  const [srcLoading, setSrcLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (editing) {
      setCustomer({
        customer_id: editing.customer_id || null, name: editing.customer_name || "",
        mobile: editing.customer_mobile || "", address: editing.customer_address || "",
      });
      setAmount(String(editing.amount || ""));
      setMode((editing.payment_mode as Mode) || "cash");
      setCashPart(editing.payment_mode === "mixed" ? String(editing.cash_amount || "") : "");
      setOnlinePart(editing.payment_mode === "mixed" ? String(editing.online_amount || "") : "");
      setSourceType((editing.source_type as SrcType) || "other");
      setSourceId(editing.source_id || undefined);
      setRefNo(editing.reference_no || "");
      setNarration(editing.narration || ""); setNotes(editing.notes || ""); setErr("");
      setSrcInfo(null);
      return;
    }
    setCustomer({ customer_id: null, name: prefill?.customer || "", mobile: "", address: "" });
    setAmount(prefill?.amount || "");
    setMode("cash");
    setCashPart(""); setOnlinePart("");
    setSourceType(prefill?.src_type || "other");
    setSourceId(prefill?.src_id);
    setRefNo("");
    setNarration(""); setNotes(""); setErr("");
    setSrcInfo(null);
  }, [visible, prefill, editing]);

  // Auto-fetch the customer from the source (sale / invoice / collection) so the receipt is pre-filled
  useEffect(() => {
    const st = prefill?.src_type;
    const sid = prefill?.src_id;
    if (!visible || editing || !sid || !st || st === "other") return;
    let cancelled = false;
    setSrcLoading(true);
    api.getReceiptSource(st, sid)
      .then((info) => {
        if (cancelled) return;
        setSrcInfo(info);
        if (info.customer_name || info.customer_id) {
          setCustomer({
            customer_id: info.customer_id || null,
            name: info.customer_name || prefill?.customer || "",
            mobile: info.customer_mobile || "",
            address: info.customer_address || "",
          });
        }
        // Default the amount to what is still unpaid on the source (falls back to full amount)
        const suggested = info.remaining > 0 ? info.remaining : info.amount;
        if (suggested > 0) setAmount(String(suggested));
        if (info.reference_no) setRefNo(info.reference_no);
      })
      .catch((e) => console.log("source prefill err", e))
      .finally(() => { if (!cancelled) setSrcLoading(false); });
    return () => { cancelled = true; };
  }, [visible, editing, prefill?.src_type, prefill?.src_id]);

  // Auto-sync total when in mixed mode
  const mixedSum = useMemo(() => {
    const c = parseFloat(cashPart || "0") || 0;
    const o = parseFloat(onlinePart || "0") || 0;
    return c + o;
  }, [cashPart, onlinePart]);

  const submit = async () => {
    if (!customer.name.trim()) { setErr("Customer name is required."); return; }
    if (!customer.mobile.trim() || customer.mobile.replace(/\D/g, "").length < 6) { setErr("Enter a valid mobile number."); return; }
    if (!customer.customer_id && !customer.address.trim()) { setErr("Address is required for a new customer."); return; }
    let n = parseFloat(amount);
    let cashN = 0;
    let onlineN = 0;
    if (mode === "mixed") {
      cashN = parseFloat(cashPart || "0") || 0;
      onlineN = parseFloat(onlinePart || "0") || 0;
      if (cashN < 0 || onlineN < 0) { setErr("Cash and online amounts must be ≥ 0"); return; }
      if (cashN === 0 && onlineN === 0) { setErr("Enter both cash and online amounts."); return; }
      const computed = Math.round((cashN + onlineN) * 100) / 100;
      if (Number.isNaN(n) || n <= 0) {
        n = computed;
      } else if (Math.abs(computed - n) > 0.01) {
        setErr(`Cash (₹${cashN}) + Online (₹${onlineN}) = ₹${computed}, but total is ₹${n}. Fix the numbers.`);
        return;
      }
    } else {
      if (Number.isNaN(n) || n <= 0) { setErr("Enter a valid amount."); return; }
    }
    setBusy(true);
    setErr("");
    try {
      const body = {
        customer_id: customer.customer_id || undefined,
        customer_name: customer.name.trim(),
        customer_mobile: customer.mobile.trim(),
        customer_address: customer.address.trim(),
        amount: n,
        payment_mode: mode,
        cash_amount: mode === "mixed" ? cashN : undefined,
        online_amount: mode === "mixed" ? onlineN : undefined,
        source_type: sourceType,
        source_id: sourceId,
        reference_no: refNo.trim() || undefined,
        narration: narration.trim(),
        notes: notes.trim(),
      };
      if (editing) {
        const r = await api.replaceReceipt(editing.id, body);
        onSaved(r, `Receipt ${r.receipt_no} updated · PDF regenerated`);
        return;
      }
      const r = await api.createReceipt(body);
      onSaved(r, `Receipt ${r.receipt_no} created`);
    } catch (e: any) {
      setErr(String(e?.message || "Failed"));
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bottomOffset={24} contentContainerStyle={{ paddingBottom: theme.space.xl }}>
            <View style={styles.handle} />
            <View style={styles.sheetHeader}>
              <Ionicons name={editing ? "create-outline" : "receipt-outline"} size={22} color={theme.color.brand} />
              <Text style={styles.sheetTitle}>{editing ? `Edit ${editing.receipt_no}` : "New money receipt"}</Text>
            </View>

            {srcInfo || srcLoading ? (
              <View style={styles.srcBanner} testID="rcpt-source-banner">
                <Ionicons name={srcLoading ? "hourglass-outline" : "link-outline"} size={14} color={theme.color.brand} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.srcBannerTitle}>
                    {srcLoading ? "Fetching customer from source…" : `From ${srcInfo?.label || prefill?.src_type}`}
                  </Text>
                  {srcInfo ? (
                    <Text style={styles.srcBannerMeta}>
                      Total ₹{Math.round(srcInfo.amount).toLocaleString("en-IN")}
                      {srcInfo.already_receipted > 0 ? ` · Receipted ₹${Math.round(srcInfo.already_receipted).toLocaleString("en-IN")}` : ""}
                      {` · Remaining ₹${Math.round(srcInfo.remaining).toLocaleString("en-IN")}`}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            <CustomerPicker value={customer} onChange={setCustomer} testID="rcpt-customer" />

            <Text style={styles.label}>Amount received (₹)</Text>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="e.g. 5000" placeholderTextColor={theme.color.muted} style={styles.input} testID="rcpt-amount" />

            <Text style={styles.label}>Payment mode</Text>
            <View style={styles.segment}>
              {MODES.map((m) => (
                <Pressable key={m.key} onPress={() => setMode(m.key)} style={[styles.segBtn, mode === m.key && styles.segBtnActive]} testID={`rcpt-mode-${m.key}`}>
                  <Ionicons name={m.icon} size={14} color={mode === m.key ? "#fff" : theme.color.muted} />
                  <Text style={[styles.segText, mode === m.key && styles.segTextActive]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>

            {mode === "mixed" ? (
              <View style={styles.mixedBox}>
                <Text style={styles.mixedTitle}>Split — enter how much of ₹{amount || 0} was cash vs online</Text>
                <View style={styles.mixedRow}>
                  <View style={styles.mixedCol}>
                    <View style={styles.mixedLabelRow}>
                      <Ionicons name="cash-outline" size={12} color={theme.color.success} />
                      <Text style={styles.mixedLabel}>Cash</Text>
                    </View>
                    <TextInput
                      value={cashPart}
                      onChangeText={setCashPart}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={theme.color.muted}
                      style={styles.mixedInput}
                      testID="rcpt-cash-part"
                    />
                  </View>
                  <Ionicons name="add" size={16} color={theme.color.muted} style={{ marginTop: 24 }} />
                  <View style={styles.mixedCol}>
                    <View style={styles.mixedLabelRow}>
                      <Ionicons name="card-outline" size={12} color={theme.color.brand} />
                      <Text style={styles.mixedLabel}>Online</Text>
                    </View>
                    <TextInput
                      value={onlinePart}
                      onChangeText={setOnlinePart}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={theme.color.muted}
                      style={styles.mixedInput}
                      testID="rcpt-online-part"
                    />
                  </View>
                </View>
                <View style={styles.mixedTotalRow}>
                  <Text style={styles.mixedTotalLabel}>Split total</Text>
                  <Text style={[styles.mixedTotalValue, {
                    color: (parseFloat(amount || "0") || 0) === 0 || Math.abs(mixedSum - (parseFloat(amount || "0") || 0)) < 0.01
                      ? theme.color.success : theme.color.error,
                  }]}>
                    ₹{Math.round(mixedSum).toLocaleString("en-IN")}
                  </Text>
                </View>
              </View>
            ) : null}

            <Text style={styles.label}>What was this payment for?</Text>
            <View style={styles.segment}>
              {SOURCES.map((s) => (
                <Pressable key={s.key} onPress={() => setSourceType(s.key)} style={[styles.segBtn, sourceType === s.key && styles.segBtnActive]} testID={`rcpt-src-${s.key}`}>
                  <Ionicons name={s.icon} size={13} color={sourceType === s.key ? "#fff" : theme.color.muted} />
                  <Text style={[styles.segText, sourceType === s.key && styles.segTextActive]}>{s.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.label}>
              Reference no. {sourceType === "other" ? "(leave blank for advance)" : "(optional — auto-filled from source)"}
            </Text>
            <TextInput
              value={refNo}
              onChangeText={setRefNo}
              placeholder={sourceType === "other" ? "Leave empty = advance payment" : "e.g. INV-000012 or Bill #"}
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="rcpt-ref-no"
            />
            {sourceType === "other" && !refNo.trim() ? (
              <View style={styles.advHint}>
                <Ionicons name="information-circle-outline" size={12} color="#B45309" />
                <Text style={styles.advHintText}>
                  This will be recorded as an <Text style={{ fontWeight: "800" }}>advance payment</Text>. Attach it to a bill later from the Invoice screen.
                </Text>
              </View>
            ) : null}

            <Text style={styles.label}>Narration (e.g. advance for product)</Text>
            <TextInput value={narration} onChangeText={setNarration} multiline placeholder="Customer wants to buy…" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} testID="rcpt-narration" />

            <Text style={styles.label}>Notes (internal)</Text>
            <TextInput value={notes} onChangeText={setNotes} multiline placeholder="Anything for us to remember" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} testID="rcpt-notes" />

            {err ? <Text style={styles.err}>{err}</Text> : null}

            <Pressable onPress={submit} disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} testID="rcpt-save">
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>{editing ? "Save changes & regenerate PDF" : "Generate receipt"}</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </KeyboardAwareScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  srcBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.color.brandTertiary, borderRadius: 10, padding: 10,
    borderWidth: 1, borderColor: theme.color.brand + "33", marginBottom: theme.space.sm,
  },
  srcBannerTitle: { fontSize: 12, fontWeight: "800", color: theme.color.brand },
  srcBannerMeta: { fontSize: 11, color: theme.color.muted, marginTop: 2 },

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
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.color.brand, paddingHorizontal: 12, height: 36, borderRadius: theme.radius.pill },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  card: { padding: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, gap: theme.space.sm },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  cardNo: { fontSize: 11, fontWeight: "800", color: theme.color.brand, letterSpacing: 1, textTransform: "uppercase" },
  cardName: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface, marginTop: 2 },
  cardMeta: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  narration: { fontSize: 12, color: theme.color.onSurface, marginTop: 4, fontStyle: "italic" },
  cardAmt: { fontSize: 18, fontWeight: "900", color: theme.color.success },
  actionsRow: { flexDirection: "row", gap: 8 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, height: 32, borderRadius: theme.radius.pill, backgroundColor: theme.color.brandTertiary },
  actionWA: { backgroundColor: "#25D366" },
  actionText: { fontSize: 12, fontWeight: "700", color: theme.color.brand },
  trashBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#FDE8E6" },

  empty: { alignItems: "center", padding: theme.space.xxl, gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: 4 },
  emptySub: { fontSize: 12, color: theme.color.muted, textAlign: "center" },

  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: theme.space.xl, maxHeight: "92%" },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.md },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
  label: { marginTop: theme.space.md, marginBottom: 4, fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase" },
  input: { minHeight: 46, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, paddingHorizontal: theme.space.md, paddingVertical: 10, color: theme.color.onSurface, fontSize: 15, backgroundColor: theme.color.surface },
  segment: {
    flexDirection: "row", flexWrap: "wrap", gap: 6,
    marginTop: 2,
  },
  segBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, height: 36, borderRadius: theme.radius.pill, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
  segBtnActive: { backgroundColor: theme.color.brand, borderColor: theme.color.brand },
  segText: { fontSize: 12, fontWeight: "700", color: theme.color.muted },
  segTextActive: { color: "#fff" },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: { marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  cancelBtn: { marginTop: theme.space.md, height: 44, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.color.muted, fontWeight: "700" },
  toast: { position: "absolute", left: theme.space.lg, right: theme.space.lg, backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center" },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "700" },

  mixedBox: {
    marginTop: theme.space.md,
    padding: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  mixedTitle: { fontSize: 11, fontWeight: "800", color: theme.color.brand, marginBottom: 8, letterSpacing: 0.3 },
  mixedRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  mixedCol: { flex: 1 },
  mixedLabelRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  mixedLabel: { fontSize: 10, fontWeight: "800", color: theme.color.onSurface, letterSpacing: 0.5, textTransform: "uppercase" },
  mixedInput: {
    height: 42, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 10, color: theme.color.onSurface, fontSize: 15, fontWeight: "700",
    backgroundColor: theme.color.surface, textAlign: "center",
  },
  mixedTotalRow: {
    marginTop: 8, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: theme.color.brand + "33", borderStyle: "dashed",
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  mixedTotalLabel: { fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 0.5 },
  mixedTotalValue: { fontSize: 15, fontWeight: "800" },

  splitRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  splitChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3,
    backgroundColor: theme.color.surfaceTertiary,
    borderWidth: 1, borderColor: theme.color.border,
  },
  splitChipText: { fontSize: 10, fontWeight: "700", color: theme.color.onSurface },

  refRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  refChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  refChipAdvance: {
    backgroundColor: "#FEF3C7", borderColor: "#FCD34D",
  },
  refChipText: { fontSize: 9, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.3 },
  refEditBtn: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    borderWidth: 1, borderColor: theme.color.brand + "44", borderStyle: "dashed",
  },
  refEditText: { fontSize: 9, fontWeight: "700", color: theme.color.brand },

  advHint: {
    marginTop: 6, padding: 8, borderRadius: theme.radius.sm,
    backgroundColor: "#FEF3C7", borderWidth: 1, borderColor: "#FCD34D",
    flexDirection: "row", alignItems: "flex-start", gap: 5,
  },
  advHintText: { flex: 1, fontSize: 11, color: "#78350F", lineHeight: 15 },
});
