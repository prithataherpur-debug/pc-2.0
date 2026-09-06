import {
  View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl,
  TextInput, Modal, KeyboardAvoidingView, Platform, ScrollView,
} from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/lib/theme";
import { API } from "@/src/lib/api";
import { storage } from "@/src/utils/storage";
import { TOKEN_KEY } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

const CATEGORIES = ["marketing", "office", "salaries", "utilities", "travel", "misc"];

type Expense = {
  id: string;
  amount: number;
  category: string;
  description?: string;
  date_key: string;
  created_by: string;
  created_at: string;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await storage.secureGet(TOKEN_KEY, "");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}`, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export default function Expenses() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [items, setItems] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("misc");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try { setItems(await req<Expense[]>(`/expenses`)); }
    catch (e) { console.log(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const submit = async () => {
    const n = parseFloat(amount);
    if (!amount || Number.isNaN(n) || n < 0) { setErr("Enter a valid amount"); return; }
    setBusy(true); setErr("");
    try {
      await req(`/expenses`, {
        method: "POST",
        body: JSON.stringify({ amount: n, category, description: desc.trim() }),
      });
      setOpen(false);
      setAmount(""); setDesc(""); setCategory("misc");
      load();
    } catch (e: any) { setErr(String(e?.message || "Failed")); }
    finally { setBusy(false); }
  };

  const del = async (id: string) => {
    try { await req(`/expenses/${id}`, { method: "DELETE" }); load(); }
    catch (e) { console.log(e); }
  };

  const total = items.reduce((s, e) => s + e.amount, 0);
  const fmtAmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

  if (user?.role !== "admin") {
    return (
      <View style={[styles.container, { paddingTop: insets.top, alignItems: "center", justifyContent: "center" }]}>
        <Ionicons name="lock-closed" size={40} color={theme.color.muted} />
        <Text style={styles.deniedTitle}>Admin only</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="expenses-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Expenses</Text>
          <Text style={styles.hdrSub}>Total: {fmtAmt(total)}</Text>
        </View>
        <Pressable onPress={() => setOpen(true)} style={styles.addBtn} testID="add-expense-btn">
          <Ionicons name="add-circle" size={18} color="#fff" />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="receipt-outline" size={56} color={theme.color.borderStrong} />
          <Text style={styles.emptyTitle}>No expenses yet</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          renderItem={({ item }) => (
            <View style={styles.card} testID={`expense-${item.id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardCat}>{item.category.toUpperCase()}</Text>
                <Text style={styles.cardAmt}>{fmtAmt(item.amount)}</Text>
                {item.description ? <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text> : null}
                <Text style={styles.cardDate}>{item.date_key}</Text>
              </View>
              <Pressable onPress={() => del(item.id)} style={styles.delBtn} testID={`del-expense-${item.id}`}>
                <Ionicons name="trash-outline" size={18} color={theme.color.error} />
              </Pressable>
            </View>
          )}
        />
      )}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <View style={styles.handle} />
                <Text style={styles.sheetTitle}>Add expense</Text>

                <Text style={styles.label}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {CATEGORIES.map((c) => {
                    const active = category === c;
                    return (
                      <Pressable
                        key={c}
                        onPress={() => setCategory(c)}
                        style={[styles.chip, active && styles.chipActive]}
                        testID={`cat-${c}`}
                      >
                        <Text style={[styles.chipText, active && { color: theme.color.brand, fontWeight: "800" }]}>
                          {c}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                <Text style={styles.label}>Amount (₹)</Text>
                <TextInput
                  value={amount} onChangeText={setAmount} keyboardType="decimal-pad"
                  placeholder="e.g. 500" placeholderTextColor={theme.color.muted}
                  style={styles.input} testID="expense-amount"
                />
                <Text style={styles.label}>Description</Text>
                <TextInput
                  value={desc} onChangeText={setDesc} multiline
                  placeholder="What was it for?" placeholderTextColor={theme.color.muted}
                  style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]} testID="expense-desc"
                />
                {err ? <Text style={styles.err}>{err}</Text> : null}
                <Pressable onPress={submit} disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} testID="expense-submit">
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save expense</Text>}
                </Pressable>
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
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.color.brand, paddingHorizontal: theme.space.md, height: 40, borderRadius: theme.radius.pill,
  },
  addBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md,
    padding: theme.space.md, borderWidth: 1, borderColor: theme.color.border,
  },
  cardCat: { fontSize: 10, letterSpacing: 1, fontWeight: "800", color: theme.color.brand },
  cardAmt: { fontSize: 20, fontWeight: "800", color: theme.color.onSurface, marginTop: 2 },
  cardDesc: { fontSize: 13, color: theme.color.onSurfaceTertiary, marginTop: 4 },
  cardDate: { fontSize: 11, color: theme.color.muted, marginTop: 4 },
  delBtn: { padding: 10 },
  emptyTitle: { marginTop: theme.space.md, fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "90%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  sheetTitle: { fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  label: {
    marginTop: theme.space.lg, marginBottom: 4,
    fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase",
  },
  chip: {
    paddingHorizontal: theme.space.md, height: 34, borderRadius: theme.radius.pill,
    justifyContent: "center", borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
  },
  chipActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  chipText: { color: theme.color.muted, fontWeight: "700", fontSize: 12 },
  input: {
    height: 48, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surface,
  },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: {
    marginTop: theme.space.xl, backgroundColor: theme.color.brand,
    height: 52, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center",
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  deniedTitle: { marginTop: theme.space.md, fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  backBtn: { marginTop: theme.space.lg, paddingHorizontal: theme.space.xl, paddingVertical: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brand },
  backBtnText: { color: theme.color.onBrand, fontWeight: "700" },
});
