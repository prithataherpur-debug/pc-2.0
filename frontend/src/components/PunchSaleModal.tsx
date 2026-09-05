import {
  View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator,
  Modal, FlatList,
} from "react-native";
import { useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { theme } from "@/src/lib/theme";
import { api, Customer } from "@/src/lib/api";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  presetCustomer?: { id: string; name: string } | null;
};

export default function PunchSaleModal({ visible, onClose, onSaved, presetCustomer }: Props) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [dupCustomer, setDupCustomer] = useState<Customer | null>(null);
  const [amount, setAmount] = useState("");
  const [product, setProduct] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (visible) {
      setMode(presetCustomer ? "existing" : "existing");
      setCustomer(presetCustomer || null);
      setNewName("");
      setNewPhone("");
      setDupCustomer(null);
      setAmount("");
      setProduct("");
      setNotes("");
      setErr("");
    }
  }, [visible, presetCustomer]);

  // Clear duplicate banner when user edits the phone
  useEffect(() => {
    if (dupCustomer) setDupCustomer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newPhone]);

  const useDuplicateCustomer = () => {
    if (!dupCustomer) return;
    setMode("existing");
    setCustomer({ id: dupCustomer.id, name: dupCustomer.name });
    setDupCustomer(null);
    setErr("");
  };

  const submit = async () => {
    const n = parseFloat(amount);
    if (!amount || Number.isNaN(n) || n < 0) {
      setErr("Enter a valid amount.");
      return;
    }
    if (mode === "new") {
      if (!newName.trim()) {
        setErr("Enter customer name.");
        return;
      }
      if (!newPhone.trim() || newPhone.replace(/\D/g, "").length < 6) {
        setErr("Enter a valid phone number.");
        return;
      }
    }
    setBusy(true);
    setDupCustomer(null);
    try {
      let customerId: string | null = customer?.id ?? null;
      let customerName: string = customer?.name ?? "";

      if (mode === "new") {
        try {
          const created = await api.createCustomer(newName.trim(), newPhone.trim(), notes.trim());
          customerId = created.id;
          customerName = created.name;
        } catch (e: any) {
          const msg = String(e?.message || "").toLowerCase();
          if (msg.includes("already exists") || msg.includes("409")) {
            // Look up existing customer to offer one-tap handoff
            try {
              const res = await api.lookupCustomer(newPhone.trim());
              if (res.exists && res.customer) {
                setDupCustomer(res.customer);
                setErr("");
              } else {
                setErr("This phone already exists but couldn't be found. Try 'Existing'.");
              }
            } catch {
              setErr("This phone number already exists. Switch to 'Existing' and pick it.");
            }
          } else {
            setErr(String(e?.message || "Failed to add customer"));
          }
          setBusy(false);
          return;
        }
      }

      await api.createSale({
        customer_id: customerId,
        customer_name: customerName,
        amount: n,
        product: product.trim(),
        notes: notes.trim(),
      });
      onSaved();
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
          <KeyboardAwareScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bottomOffset={24}
            contentContainerStyle={{ paddingBottom: theme.space.xl }}
          >
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Ionicons name="cash-outline" size={22} color={theme.color.success} />
              <Text style={styles.title}>Punch a sale</Text>
            </View>

            <Text style={styles.label}>Customer</Text>
            <View style={styles.segment}>
              <Pressable
                onPress={() => setMode("existing")}
                style={[styles.segBtn, mode === "existing" && styles.segBtnActive]}
                testID="sale-mode-existing"
              >
                <Ionicons
                  name="people-outline"
                  size={16}
                  color={mode === "existing" ? "#fff" : theme.color.muted}
                />
                <Text style={[styles.segText, mode === "existing" && styles.segTextActive]}>
                  Existing
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMode("new")}
                style={[styles.segBtn, mode === "new" && styles.segBtnActive]}
                testID="sale-mode-new"
              >
                <Ionicons
                  name="person-add-outline"
                  size={16}
                  color={mode === "new" ? "#fff" : theme.color.muted}
                />
                <Text style={[styles.segText, mode === "new" && styles.segTextActive]}>
                  New customer
                </Text>
              </Pressable>
            </View>

            {mode === "existing" ? (
              <Pressable
                onPress={() => setPickerOpen(true)}
                style={[styles.pickBtn, { marginTop: theme.space.md }]}
                testID="sale-customer-picker"
              >
                <Ionicons
                  name={customer ? "person-circle" : "person-add-outline"}
                  size={20}
                  color={customer ? theme.color.brand : theme.color.muted}
                />
                <Text style={[styles.pickText, !customer && { color: theme.color.muted }]}>
                  {customer?.name || "Pick a customer (optional)"}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={theme.color.muted} />
              </Pressable>
            ) : (
              <View style={{ marginTop: theme.space.md, gap: theme.space.sm }}>
                <TextInput
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="Customer name"
                  placeholderTextColor={theme.color.muted}
                  style={styles.input}
                  testID="sale-new-name"
                />
                <TextInput
                  value={newPhone}
                  onChangeText={setNewPhone}
                  keyboardType="phone-pad"
                  placeholder="Phone number"
                  placeholderTextColor={theme.color.muted}
                  style={styles.input}
                  testID="sale-new-phone"
                />
                {dupCustomer ? (
                  <View style={styles.dupBanner}>
                    <View style={styles.dupIconWrap}>
                      <Ionicons name="alert-circle" size={20} color={theme.color.warning} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.dupTitle}>Already in our list</Text>
                      <Text style={styles.dupSub}>
                        {dupCustomer.name} · assigned to{" "}
                        <Text style={{ fontWeight: "700" }}>
                          {dupCustomer.is_mine ? "you" : (dupCustomer.assigned_to || "team")}
                        </Text>
                      </Text>
                    </View>
                    <Pressable
                      onPress={useDuplicateCustomer}
                      style={styles.dupBtn}
                      testID="sale-use-duplicate"
                    >
                      <Text style={styles.dupBtnText}>Use</Text>
                    </Pressable>
                  </View>
                ) : null}
                <Text style={styles.hint}>
                  We'll save this contact under your customers automatically.
                </Text>
              </View>
            )}

            <Text style={styles.label}>Amount (₹)</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="e.g. 1500"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="sale-amount"
              returnKeyType="done"
            />

            <Text style={styles.label}>Product / service</Text>
            <TextInput
              value={product}
              onChangeText={setProduct}
              placeholder="e.g. Silver plan"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="sale-product"
              returnKeyType="done"
            />

            <Text style={styles.label}>Notes</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Anything to remember about this sale…"
              placeholderTextColor={theme.color.muted}
              style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
              testID="sale-notes"
            />

            {err ? <Text style={styles.err}>{err}</Text> : null}

            <Pressable
              onPress={submit}
              disabled={busy}
              style={[styles.saveBtn, busy && { opacity: 0.6 }]}
              testID="sale-submit"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>Log sale</Text>
                </>
              )}
            </Pressable>
          </KeyboardAwareScrollView>
        </Pressable>
      </Pressable>

      <CustomerPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(c) => {
          setCustomer({ id: c.id, name: c.name });
          setPickerOpen(false);
        }}
      />
    </Modal>
  );
}

function CustomerPicker({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (c: Customer) => void;
}) {
  const [items, setItems] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    api
      .listCustomers("all", search, "mine")
      .then(setItems)
      .finally(() => setLoading(false));
  }, [visible, search]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>Pick a customer</Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or phone"
            placeholderTextColor={theme.color.muted}
            style={[styles.input, { marginTop: theme.space.md }]}
            testID="sale-picker-search"
          />
          {loading ? (
            <ActivityIndicator color={theme.color.brand} style={{ marginTop: 16 }} />
          ) : (
            <FlatList
              data={items}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 340, marginTop: theme.space.md }}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => onPick(item)}
                  style={styles.pickerRow}
                  testID={`sale-pick-${item.id}`}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{(item.name || "?").slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: theme.space.md }}>
                    <Text style={styles.pickName}>{item.name}</Text>
                    <Text style={styles.pickHint}>{item.phone}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={{ textAlign: "center", color: theme.color.muted, marginTop: 20 }}>
                  No matches
                </Text>
              }
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "90%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  label: {
    marginTop: theme.space.lg, marginBottom: 4,
    fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase",
  },
  input: {
    height: 48, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surface,
  },
  pickBtn: {
    flexDirection: "row", alignItems: "center", gap: 10, height: 48,
    borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, backgroundColor: theme.color.surface,
  },
  pickText: { flex: 1, fontSize: 15, color: theme.color.onSurface, fontWeight: "600" },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: {
    marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.color.success, height: 52, borderRadius: theme.radius.md,
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  pickerRow: { flexDirection: "row", alignItems: "center", paddingVertical: theme.space.sm },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.color.brandTertiary, alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: theme.color.brand, fontWeight: "800" },
  pickName: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
  pickHint: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    padding: 4,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  segBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: theme.radius.sm,
  },
  segBtnActive: { backgroundColor: theme.color.brand },
  segText: { fontSize: 13, fontWeight: "700", color: theme.color.muted },
  segTextActive: { color: "#fff" },
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  dupBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#F59E0B",
    borderRadius: theme.radius.md,
    padding: 10,
    marginTop: 6,
  },
  dupIconWrap: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: "#FDE68A",
    alignItems: "center", justifyContent: "center",
  },
  dupTitle: { fontSize: 13, fontWeight: "800", color: "#78350F" },
  dupSub: { fontSize: 12, color: "#92400E", marginTop: 2 },
  dupBtn: {
    paddingHorizontal: 14, height: 34, borderRadius: theme.radius.pill,
    backgroundColor: "#B45309", alignItems: "center", justifyContent: "center",
  },
  dupBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
});
