import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Modal,
  TextInput, RefreshControl, Linking, Platform, Alert,
} from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { theme } from "@/src/lib/theme";
import { api, Invoice, API, MoneyReceipt } from "@/src/lib/api";
import { CustomerPicker, PickerCustomer } from "@/src/components/CustomerPicker";
import { useAuth } from "@/src/lib/auth";

const fmt = (n: number) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN");

export default function InvoicesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [items, setItems] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [toast, setToast] = useState("");
  // Deep-link highlight (e.g. from a LINKED receipt tag in the Daybook)
  const params = useLocalSearchParams<{ highlight?: string }>();
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRef = useRef<FlatList<Invoice>>(null);
  useEffect(() => {
    if (params?.highlight) {
      setHighlightId(String(params.highlight));
      router.setParams({ highlight: undefined } as any);
      const t = setTimeout(() => setHighlightId(null), 6000);
      return () => clearTimeout(t);
    }
  }, [params?.highlight]);
  useEffect(() => {
    if (!highlightId || items.length === 0) return;
    const idx = items.findIndex((i) => i.id === highlightId);
    if (idx >= 0) {
      setTimeout(() => listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.2 }), 300);
    }
  }, [highlightId, items]);

  const load = useCallback(async () => {
    try {
      const list = await api.listInvoices(200);
      setItems(list);
    } catch (e) { console.log("inv err", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const shareWA = async (inv: Invoice) => {
    if (!inv.pdf_path || !inv.pdf_token) { showToast("PDF not ready"); return; }
    const url = `${API}/files/${inv.pdf_path}?token=${encodeURIComponent(inv.pdf_token)}`;
    const phone = (inv.customer_mobile || "").replace(/\D/g, "");
    const text = `Invoice ${inv.invoice_no} · ${fmt(inv.total)}\n${url}`;
    const wa = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    try {
      const supported = await Linking.canOpenURL(wa);
      if (!supported) { showToast("Install WhatsApp first"); return; }
      await Linking.openURL(wa);
    } catch (e: any) { showToast(String(e?.message || "Cannot open WhatsApp")); }
  };

  const openPdf = async (inv: Invoice) => {
    if (!inv.pdf_path || !inv.pdf_token) return;
    const url = `${API}/files/${inv.pdf_path}?token=${encodeURIComponent(inv.pdf_token)}`;
    Linking.openURL(url).catch(() => showToast("Failed to open PDF"));
  };

  const remove = (inv: Invoice) => {
    Alert.alert("Delete invoice?", "This also removes the linked sale.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try { await api.deleteInvoice(inv.id); showToast("Deleted"); load(); }
        catch (e: any) { showToast(String(e?.message || "Delete failed")); }
      } },
    ]);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="invoices-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Invoices</Text>
          <Text style={styles.hdrSub}>{items.length} invoices · auto-linked to sales</Text>
        </View>
        <Pressable onPress={() => setCreating(true)} style={styles.addBtn} testID="new-invoice">
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnText}>New</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(i) => i.id}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true }), 200);
          }}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brand} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="document-text" size={44} color={theme.color.borderStrong} />
              <Text style={styles.emptyTitle}>No invoices yet</Text>
              <Text style={styles.emptySub}>Tap New to generate your first invoice.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.card, highlightId === item.id && styles.cardHighlight]} testID={`inv-${item.id}`}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardNo}>{item.invoice_no}</Text>
                  <Text style={styles.cardName}>{item.customer_name}</Text>
                  <Text style={styles.cardMeta}>
                    {item.date_key} · {item.display_name || item.user} · {item.items.length} item{item.items.length > 1 ? "s" : ""}
                  </Text>
                </View>
                <Text style={styles.cardAmt}>{fmt(item.total)}</Text>
              </View>
              <View style={styles.actionsRow}>
                <Pressable onPress={() => openPdf(item)} style={styles.actionBtn} testID={`inv-pdf-${item.id}`}>
                  <Ionicons name="document-outline" size={14} color={theme.color.brand} />
                  <Text style={styles.actionText}>Open PDF</Text>
                </Pressable>
                <Pressable onPress={() => shareWA(item)} style={[styles.actionBtn, styles.actionWA]} testID={`inv-wa-${item.id}`}>
                  <Ionicons name="logo-whatsapp" size={14} color="#fff" />
                  <Text style={[styles.actionText, { color: "#fff" }]}>WhatsApp</Text>
                </Pressable>
                {isAdmin ? (
                  <Pressable onPress={() => setEditing(item)} style={styles.actionBtn} testID={`inv-edit-${item.id}`}>
                    <Ionicons name="create-outline" size={14} color={theme.color.brand} />
                    <Text style={styles.actionText}>Edit</Text>
                  </Pressable>
                ) : null}
                {isAdmin ? (
                  <Pressable onPress={() => remove(item)} style={styles.trashBtn} testID={`inv-del-${item.id}`}>
                    <Ionicons name="trash-outline" size={14} color={theme.color.error} />
                  </Pressable>
                ) : null}
              </View>
              {/* Linked money receipts — reference-number-first, tap to open PDF */}
              {(item.linked_receipts && item.linked_receipts.length > 0) ? (
                <View style={styles.linkedBox} testID={`inv-linked-${item.id}`}>
                  <View style={styles.linkedHead}>
                    <Ionicons name="receipt-outline" size={12} color={theme.color.brand} />
                    <Text style={styles.linkedTitle}>
                      {item.linked_receipts.length} money receipt{item.linked_receipts.length > 1 ? "s" : ""} linked
                    </Text>
                  </View>
                  <View style={styles.linkedRow}>
                    {item.linked_receipts.map((r) => (
                      <Pressable
                        key={r.id}
                        onPress={() => {
                          if (!r.pdf_token) return;
                          const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${r.pdf_token}`;
                          Linking.openURL(url).catch(() => {});
                        }}
                        style={styles.linkedChip}
                        testID={`inv-linked-rcp-${r.id}`}
                      >
                        <Ionicons name="document-text-outline" size={10} color={theme.color.brand} />
                        <Text style={styles.linkedChipText}>{r.receipt_no}</Text>
                        {r.reference_no ? (
                          <Text style={styles.linkedChipRef} numberOfLines={1}>Ref {r.reference_no}</Text>
                        ) : null}
                        <Text style={styles.linkedChipAmt}>{fmt(r.amount)}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                <Pressable
                  onPress={() => router.push({ pathname: "/receipts", params: { src_type: "invoice", src_id: item.id, customer: item.customer_name || "", mobile: item.customer_mobile || "", amount: String(item.total) } })}
                  style={styles.createRcptBtn}
                  testID={`inv-create-rcpt-${item.id}`}
                  hitSlop={4}
                >
                  <Ionicons name="add-circle-outline" size={12} color={theme.color.brand} />
                  <Text style={styles.createRcptText}>Create money receipt</Text>
                </Pressable>
              )}
            </View>
          )}
        />
      )}

      <InvoiceEditor
        visible={creating || !!editing}
        editing={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={(inv, msg) => {
          const wasEdit = !!editing;
          setCreating(false); setEditing(null);
          showToast(msg);
          load();
          // auto-share prompt via WhatsApp (new invoices only)
          if (inv && !wasEdit) setTimeout(() => shareWA(inv), 400);
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

function InvoiceEditor({
  visible, editing, onClose, onSaved,
}: {
  visible: boolean;
  /** Admin: when set, edits this invoice (all fields) and regenerates its PDF */
  editing?: Invoice | null;
  onClose: () => void;
  onSaved: (inv: Invoice | null, msg: string) => void;
}) {
  const [customer, setCustomer] = useState<PickerCustomer>({ customer_id: null, name: "", mobile: "", address: "" });
  const [notes, setNotes] = useState("");
  const [payMode, setPayMode] = useState<"cash" | "online" | "mixed">("cash");
  const [cashPart, setCashPart] = useState("");
  const [onlinePart, setOnlinePart] = useState("");
  const [items, setItems] = useState<{ id: string; name: string; qty: string; rate: string }[]>([
    { id: "1", name: "", qty: "1", rate: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [advances, setAdvances] = useState<MoneyReceipt[]>([]);
  const [selectedAdvIds, setSelectedAdvIds] = useState<Set<string>>(new Set());
  const [advLoading, setAdvLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (editing) {
      setCustomer({
        customer_id: editing.customer_id || null, name: editing.customer_name || "",
        mobile: editing.customer_mobile || "", address: editing.customer_address || "",
      });
      setNotes(editing.notes || "");
      setItems((editing.items || []).map((it, i) => ({ id: `${i}-${Date.now()}`, name: it.name, qty: String(it.qty), rate: String(it.unit_price) })));
      setPayMode((editing.payment_mode as any) || "cash");
      setCashPart(editing.payment_mode === "mixed" ? String(editing.cash_amount || "") : "");
      setOnlinePart(editing.payment_mode === "mixed" ? String(editing.online_amount || "") : "");
      setErr(""); setAdvances([]); setSelectedAdvIds(new Set());
      return;
    }
    setCustomer({ customer_id: null, name: "", mobile: "", address: "" });
    setNotes("");
    setItems([{ id: String(Date.now()), name: "", qty: "1", rate: "" }]);
    setPayMode("cash"); setCashPart(""); setOnlinePart("");
    setErr("");
    setAdvances([]);
    setSelectedAdvIds(new Set());
  }, [visible, editing]);

  // Fetch advance receipts for the selected customer (new invoices only)
  useEffect(() => {
    if (!visible || editing) return;
    const hasCustomer = customer.customer_id || (customer.mobile && customer.mobile.replace(/\D/g, "").length >= 6);
    if (!hasCustomer) {
      setAdvances([]); setSelectedAdvIds(new Set());
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setAdvLoading(true);
      try {
        const res = await api.getAdvanceReceipts(
          customer.customer_id
            ? { customer_id: customer.customer_id }
            : { phone: customer.mobile.trim() }
        );
        if (!cancelled) {
          setAdvances(res.advances || []);
          // Auto-select all by default (user can uncheck)
          setSelectedAdvIds(new Set((res.advances || []).map((r) => r.id)));
        }
      } catch { /* ignore */ } finally { setAdvLoading(false); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [visible, customer.customer_id, customer.mobile]);

  const total = useMemo(() => {
    return items.reduce((s, it) => {
      const q = parseFloat(it.qty || "0") || 0;
      const r = parseFloat(it.rate || "0") || 0;
      return s + q * r;
    }, 0);
  }, [items]);

  const setItem = (id: string, field: string, val: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, [field]: val } : it)));
  };

  const addRow = () => setItems((prev) => [...prev, { id: String(Date.now() + Math.random()), name: "", qty: "1", rate: "" }]);
  const removeRow = (id: string) => setItems((prev) => (prev.length === 1 ? prev : prev.filter((x) => x.id !== id)));

  const submit = async () => {
    if (!customer.name.trim()) { setErr("Customer name is required."); return; }
    if (!customer.mobile.trim() || customer.mobile.replace(/\D/g, "").length < 6) { setErr("Enter a valid mobile number."); return; }
    const cleanItems: { name: string; qty: number; unit_price: number }[] = [];
    for (const it of items) {
      const q = parseFloat(it.qty || "0") || 0;
      const r = parseFloat(it.rate || "0") || 0;
      if (!it.name.trim()) continue;
      if (q <= 0) { setErr(`Qty must be > 0 for "${it.name}"`); return; }
      cleanItems.push({ name: it.name.trim(), qty: q, unit_price: r });
    }
    if (cleanItems.length === 0) { setErr("Add at least one product."); return; }
    // Payment split
    let cashAmt: number | undefined;
    let onlineAmt: number | undefined;
    const tot = Math.round(total * 100) / 100;
    if (payMode === "online") { cashAmt = 0; onlineAmt = tot; }
    else if (payMode === "mixed") {
      cashAmt = parseFloat(cashPart || "0") || 0;
      onlineAmt = parseFloat(onlinePart || "0") || 0;
      if (Math.abs(cashAmt + onlineAmt - tot) > 0.01) {
        setErr(`Cash (₹${cashAmt}) + Online (₹${onlineAmt}) must equal the grand total ₹${tot}.`);
        return;
      }
    } else { cashAmt = tot; onlineAmt = 0; }
    setBusy(true);
    setErr("");
    try {
      const base = {
        customer_id: customer.customer_id || undefined,
        customer_name: customer.name.trim(),
        customer_mobile: customer.mobile.trim(),
        customer_address: customer.address.trim(),
        notes: notes.trim(),
        items: cleanItems,
        cash_amount: cashAmt,
        online_amount: onlineAmt,
      };
      if (editing) {
        const inv = await api.replaceInvoice(editing.id, base);
        onSaved(inv, `Invoice ${inv.invoice_no} updated · PDF regenerated`);
        return;
      }
      const inv = await api.createInvoice({ ...base, attach_receipt_ids: Array.from(selectedAdvIds) });
      const msg = selectedAdvIds.size > 0
        ? `Invoice ${inv.invoice_no} created · ${selectedAdvIds.size} advance receipt${selectedAdvIds.size > 1 ? "s" : ""} attached`
        : `Invoice ${inv.invoice_no} created`;
      onSaved(inv, msg);
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
              <Ionicons name={editing ? "create-outline" : "document-text-outline"} size={22} color={theme.color.brand} />
              <Text style={styles.sheetTitle}>{editing ? `Edit ${editing.invoice_no}` : "New invoice"}</Text>
            </View>

            <CustomerPicker value={customer} onChange={setCustomer} testID="inv-customer" />

            {/* Advance receipts for this customer */}
            {advLoading ? (
              <View style={styles.advBox}>
                <ActivityIndicator color={theme.color.brand} size="small" />
                <Text style={styles.advHint}>Checking for advance payments…</Text>
              </View>
            ) : advances.length > 0 ? (
              <View style={styles.advBox} testID="inv-advances">
                <View style={styles.advHead}>
                  <Ionicons name="wallet-outline" size={14} color={theme.color.brand} />
                  <Text style={styles.advTitle}>
                    {advances.length} advance receipt{advances.length > 1 ? "s" : ""} for this customer
                  </Text>
                </View>
                <Text style={styles.advHint}>Tap to attach — attached receipts will be marked with this invoice number as reference.</Text>
                {advances.map((r) => {
                  const on = selectedAdvIds.has(r.id);
                  return (
                    <Pressable
                      key={r.id}
                      onPress={() => setSelectedAdvIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                        return next;
                      })}
                      style={[styles.advItem, on && styles.advItemOn]}
                      testID={`inv-adv-${r.id}`}
                    >
                      <Ionicons
                        name={on ? "checkbox" : "square-outline"}
                        size={18}
                        color={on ? theme.color.brand : theme.color.muted}
                      />
                      <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={styles.advItemNo}>{r.receipt_no} · {r.date_key}</Text>
                        <Text style={styles.advItemMeta}>
                          {r.payment_mode.toUpperCase()} · {r.narration || "Advance"}
                        </Text>
                      </View>
                      <Text style={styles.advItemAmt}>{fmt(r.amount)}</Text>
                    </Pressable>
                  );
                })}
                {selectedAdvIds.size > 0 ? (
                  <View style={styles.advFooter}>
                    <Text style={styles.advFooterLabel}>Attaching</Text>
                    <Text style={styles.advFooterValue}>
                      {fmt(advances.filter((r) => selectedAdvIds.has(r.id)).reduce((s, r) => s + r.amount, 0))}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            <View style={styles.itemsHeader}>
              <Text style={styles.label}>Products</Text>
              <Pressable onPress={addRow} style={styles.addItemBtn} testID="add-item">
                <Ionicons name="add" size={14} color={theme.color.brand} />
                <Text style={styles.addItemText}>Add</Text>
              </Pressable>
            </View>

            {items.map((it, idx) => {
              const q = parseFloat(it.qty || "0") || 0;
              const r = parseFloat(it.rate || "0") || 0;
              const sub = q * r;
              return (
                <View key={it.id} style={styles.itemBlock} testID={`inv-item-${idx}`}>
                  <View style={styles.itemHead}>
                    <Text style={styles.itemIndex}>#{idx + 1}</Text>
                    {items.length > 1 ? (
                      <Pressable onPress={() => removeRow(it.id)} hitSlop={8} style={styles.rowDelBtn}>
                        <Ionicons name="close-circle" size={18} color={theme.color.error} />
                      </Pressable>
                    ) : null}
                  </View>
                  <TextInput value={it.name} onChangeText={(v) => setItem(it.id, "name", v)} placeholder="Product name" placeholderTextColor={theme.color.muted} style={styles.input} testID={`inv-item-name-${idx}`} />
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>Qty</Text>
                      <TextInput value={it.qty} onChangeText={(v) => setItem(it.id, "qty", v)} keyboardType="decimal-pad" placeholder="1" placeholderTextColor={theme.color.muted} style={styles.miniInput} testID={`inv-item-qty-${idx}`} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>Rate (₹)</Text>
                      <TextInput value={it.rate} onChangeText={(v) => setItem(it.id, "rate", v)} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.miniInput} testID={`inv-item-rate-${idx}`} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>Amount</Text>
                      <View style={styles.subBox}><Text style={styles.subText}>{fmt(sub)}</Text></View>
                    </View>
                  </View>
                </View>
              );
            })}

            <View style={styles.totalBox}>
              <Text style={styles.totalLabel}>Grand total</Text>
              <Text style={styles.totalValue}>{fmt(total)}</Text>
            </View>

            <Text style={styles.label}>Payment received as</Text>
            <View style={styles.payRow}>
              {(["cash", "online", "mixed"] as const).map((m) => {
                const active = payMode === m;
                return (
                  <Pressable key={m} onPress={() => setPayMode(m)} style={[styles.payChip, active && styles.payChipActive]} testID={`inv-pay-${m}`}>
                    <Ionicons name={m === "cash" ? "cash-outline" : m === "online" ? "card-outline" : "swap-horizontal-outline"} size={14} color={active ? theme.color.brand : theme.color.muted} />
                    <Text style={[styles.payChipText, active && { color: theme.color.brand }]}>{m === "cash" ? "Cash" : m === "online" ? "Online" : "Mixed"}</Text>
                  </Pressable>
                );
              })}
            </View>
            {payMode === "mixed" ? (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.miniLabel}>Cash (₹)</Text>
                  <TextInput value={cashPart} onChangeText={setCashPart} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={theme.color.muted} style={styles.miniInput} testID="inv-cash" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.miniLabel}>Online (₹)</Text>
                  <TextInput value={onlinePart} onChangeText={setOnlinePart} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={theme.color.muted} style={styles.miniInput} testID="inv-online" />
                </View>
              </View>
            ) : null}

            <Text style={styles.label}>Notes (optional)</Text>
            <TextInput value={notes} onChangeText={setNotes} multiline placeholder="Additional details for the customer" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} testID="inv-notes" />

            {err ? <Text style={styles.err}>{err}</Text> : null}

            <Pressable onPress={submit} disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} testID="inv-save">
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>{editing ? "Save changes & regenerate PDF" : "Generate invoice"}</Text>
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

  card: {
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    gap: theme.space.sm,
  },
  cardHighlight: { borderColor: theme.color.brand, borderWidth: 2, backgroundColor: theme.color.brandTertiary },
  payRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  payChip: {
    flex: 1, height: 40, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.surface,
  },
  payChipActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  payChipText: { fontSize: 12, fontWeight: "700", color: theme.color.muted },

  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  cardNo: { fontSize: 11, fontWeight: "800", color: theme.color.brand, letterSpacing: 1, textTransform: "uppercase" },
  cardName: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface, marginTop: 2 },
  cardMeta: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  cardAmt: { fontSize: 18, fontWeight: "900", color: theme.color.success },
  actionsRow: { flexDirection: "row", gap: 8 },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, height: 32, borderRadius: theme.radius.pill,
    backgroundColor: theme.color.brandTertiary,
  },
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
  itemsHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },

  advBox: {
    marginTop: theme.space.md, padding: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "55",
  },
  advHead: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 4 },
  advTitle: { fontSize: 12, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.3 },
  advHint: { fontSize: 10, color: theme.color.muted, fontStyle: "italic", marginBottom: 6 },
  advItem: {
    flexDirection: "row", alignItems: "center",
    padding: 8, borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
    marginTop: 4,
  },
  advItemOn: { borderColor: theme.color.brand, backgroundColor: "#EFF6FF" },
  advItemNo: { fontSize: 12, fontWeight: "800", color: theme.color.onSurface },
  advItemMeta: { fontSize: 10, color: theme.color.muted, marginTop: 1 },
  advItemAmt: { fontSize: 13, fontWeight: "800", color: theme.color.success },
  advFooter: {
    marginTop: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: theme.color.brand + "33", borderStyle: "dashed",
    flexDirection: "row", justifyContent: "space-between",
  },
  advFooterLabel: { fontSize: 11, fontWeight: "700", color: theme.color.muted },
  advFooterValue: { fontSize: 13, fontWeight: "800", color: theme.color.success },
  addItemBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, height: 30, borderRadius: theme.radius.pill, backgroundColor: theme.color.brandTertiary },
  addItemText: { color: theme.color.brand, fontWeight: "800", fontSize: 12 },
  itemBlock: { marginTop: 8, padding: 10, borderRadius: theme.radius.md, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border },
  itemHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  itemIndex: { fontSize: 11, fontWeight: "800", color: theme.color.muted, letterSpacing: 1 },
  rowDelBtn: {},
  miniLabel: { fontSize: 10, color: theme.color.muted, fontWeight: "700", marginBottom: 4 },
  miniInput: { height: 40, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.color.border, paddingHorizontal: 8, color: theme.color.onSurface, fontSize: 14, backgroundColor: theme.color.surfaceSecondary, textAlign: "right" },
  subBox: { height: 40, borderRadius: theme.radius.sm, backgroundColor: theme.color.brandTertiary, alignItems: "flex-end", justifyContent: "center", paddingHorizontal: 8 },
  subText: { fontWeight: "800", color: theme.color.brand, fontSize: 14 },
  totalBox: { marginTop: theme.space.md, padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.color.brand, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  totalLabel: { fontSize: 12, color: "#fff", fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  totalValue: { fontSize: 22, fontWeight: "900", color: "#fff" },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: { marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  cancelBtn: { marginTop: theme.space.md, height: 44, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.color.muted, fontWeight: "700" },
  toast: { position: "absolute", left: theme.space.lg, right: theme.space.lg, backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center" },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "700" },

  // linked receipts on invoice cards
  linkedBox: {
    marginTop: 4, padding: 8, borderRadius: theme.radius.sm,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  linkedHead: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 6 },
  linkedTitle: { fontSize: 10, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.3 },
  linkedRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  linkedChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.brand + "55",
  },
  linkedChipText: { fontSize: 9, fontWeight: "800", color: theme.color.brand },
  linkedChipRef: { fontSize: 9, fontWeight: "700", color: theme.color.warning, marginLeft: 2 },
  linkedChipAmt: { fontSize: 9, fontWeight: "700", color: theme.color.onSurface, marginLeft: 2 },
  createRcptBtn: {
    flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start",
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
    borderWidth: 1, borderColor: theme.color.brand + "55", borderStyle: "dashed",
  },
  createRcptText: { fontSize: 11, fontWeight: "800", color: theme.color.brand },
});
