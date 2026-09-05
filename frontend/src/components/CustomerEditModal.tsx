import { useEffect, useState } from "react";
import {
  View, Text, StyleSheet, Pressable, TextInput, Modal, ScrollView, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useRouter } from "expo-router";

import { api, Customer } from "@/src/lib/api";
import { theme } from "@/src/lib/theme";

type Props = {
  customer: Customer | null;
  onClose: () => void;
  onSaved: (c: Customer) => void;
};

/** Bottom sheet to edit a customer's name / phone / address / note, with a shortcut to the ledger. */
export default function CustomerEditModal({ customer, onClose, onSaved }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (customer) {
      setName(customer.name || "");
      setPhone(customer.phone || "");
      setAddress(customer.address || "");
      setNote(customer.notes || "");
      setErr("");
    }
  }, [customer]);

  const save = async () => {
    if (!customer) return;
    if (!name.trim() || !phone.trim()) { setErr("Name and phone are required."); return; }
    setSaving(true); setErr("");
    try {
      const patch: { name?: string; phone?: string; address?: string; notes?: string } = {};
      if (name.trim() !== (customer.name || "")) patch.name = name.trim();
      if (phone.trim() !== (customer.phone || "")) patch.phone = phone.trim();
      if (address.trim() !== (customer.address || "")) patch.address = address.trim();
      if (note.trim() !== (customer.notes || "")) patch.notes = note.trim();
      if (Object.keys(patch).length === 0) { onClose(); return; }
      const updated = await api.updateCustomer(customer.id, patch);
      onSaved(updated);
    } catch (e: any) {
      const msg = String(e?.message || "");
      setErr(msg.includes("409") ? "That phone number already belongs to another customer." : msg || "Update failed.");
    } finally { setSaving(false); }
  };

  return (
    <Modal visible={!!customer} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}} testID="customer-edit-sheet">
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.handle} />
              <View style={styles.head}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(name || "?").slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>Edit customer</Text>
                  <Text style={styles.sub}>Changes also update this customer&apos;s invoices & receipts</Text>
                </View>
              </View>

              <Text style={styles.label}>Name</Text>
              <TextInput value={name} onChangeText={setName} placeholder="Customer name" placeholderTextColor={theme.color.muted} style={styles.input} testID="edit-cust-name" />
              <Text style={styles.label}>Phone number</Text>
              <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Phone" placeholderTextColor={theme.color.muted} style={styles.input} testID="edit-cust-phone" />
              <Text style={styles.label}>Address</Text>
              <TextInput value={address} onChangeText={setAddress} multiline placeholder="Street, city, pincode" placeholderTextColor={theme.color.muted} style={[styles.input, styles.multi]} testID="edit-cust-address" />
              <Text style={styles.label}>Note</Text>
              <TextInput value={note} onChangeText={setNote} multiline placeholder="e.g. interested in 3-door cabinet" placeholderTextColor={theme.color.muted} style={[styles.input, styles.multi]} testID="edit-cust-note" />

              {err ? <Text style={styles.err}>{err}</Text> : null}

              <Pressable onPress={save} disabled={saving} style={[styles.saveBtn, saving && { opacity: 0.6 }]} testID="edit-cust-save">
                {saving ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                    <Text style={styles.saveText}>Save changes</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                onPress={() => { if (customer) { onClose(); router.push({ pathname: "/customer/[id]/ledger", params: { id: customer.id } }); } }}
                style={styles.ledgerBtn}
                testID="edit-cust-ledger"
              >
                <Ionicons name="book-outline" size={16} color={theme.color.brand} />
                <Text style={styles.ledgerText}>Open customer ledger</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "92%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.brandTertiary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 18 },
  title: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
  sub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  label: { marginTop: theme.space.md, marginBottom: 4, fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 0.5, textTransform: "uppercase" },
  input: {
    minHeight: 46, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 12, paddingVertical: 10, color: theme.color.onSurface, fontSize: 15, backgroundColor: theme.color.surface,
  },
  multi: { minHeight: 64, textAlignVertical: "top" },
  err: { color: theme.color.error, fontSize: 12, marginTop: 8 },
  saveBtn: {
    marginTop: theme.space.lg, height: 48, borderRadius: theme.radius.md, backgroundColor: theme.color.brand,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  ledgerBtn: {
    marginTop: theme.space.sm, height: 44, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brand + "55",
    backgroundColor: theme.color.brandTertiary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  ledgerText: { color: theme.color.brand, fontWeight: "800", fontSize: 13 },
  cancelBtn: { marginTop: theme.space.sm, height: 40, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.color.muted, fontWeight: "600" },
});
