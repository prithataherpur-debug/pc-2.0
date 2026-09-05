import {
  View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, ScrollView,
} from "react-native";
import { useEffect, useState, useRef } from "react";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/lib/theme";
import { api, Customer } from "@/src/lib/api";

export type PickerCustomer = {
  customer_id?: string | null;
  name: string;
  mobile: string;
  address: string;
};

export type CustomerPickerProps = {
  value: PickerCustomer;
  onChange: (v: PickerCustomer) => void;
  disabled?: boolean;
  testID?: string;
};

type Match = Customer & { is_mine?: boolean; assigned_to?: string | null };

/**
 * CustomerPicker
 * Toggle between:
 *   - EXISTING: free-text search (name OR mobile) → live-result list → tap to select
 *   - NEW: fresh name/mobile/address inputs (customer will be auto-created on save,
 *     backend still enforces uniqueness by mobile).
 * All employees can pull any existing customer (regardless of assignee).
 */
export function CustomerPicker({ value, onChange, disabled, testID }: CustomerPickerProps) {
  const [mode, setMode] = useState<"existing" | "new">(value.customer_id ? "existing" : "new");
  const [query, setQuery] = useState(value.customer_id ? value.name || value.mobile : "");
  const [looking, setLooking] = useState(false);
  const [lookupErr, setLookupErr] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const timer = useRef<any>(null);

  // External prefill (e.g. receipt created from a sale/invoice): when a customer_id arrives
  // while we're in "new" mode, switch to "existing" and show the selected-customer card.
  useEffect(() => {
    if (value.customer_id && mode === "new") {
      setQuery(value.name || value.mobile || "");
      setMatches([]);
      setLookupErr("");
      setMode("existing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.customer_id]);

  // When switching modes, reset accordingly
  useEffect(() => {
    if (mode === "new") {
      if (value.customer_id) {
        onChange({ ...value, customer_id: null });
      }
      setMatches([]);
      setLookupErr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Debounced search while typing (name OR mobile) in "existing" mode
  useEffect(() => {
    if (mode !== "existing") return;
    const q = query.trim();
    if (!q || q.length < 2) {
      setMatches([]); setLookupErr("");
      // Clear currently selected if query shortened away from it
      if (value.customer_id) {
        onChange({ customer_id: null, name: "", mobile: q, address: "" });
      }
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLooking(true); setLookupErr("");
      try {
        const res = await api.searchCustomers(q, 20);
        setMatches(res.customers || []);
        if ((res.customers || []).length === 0) {
          setLookupErr("No matching customer — switch to New to add.");
        }
      } catch (e: any) {
        setLookupErr(String(e?.message || "Search failed"));
      } finally { setLooking(false); }
    }, 400);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode]);

  const pick = (c: Match) => {
    onChange({
      customer_id: c.id,
      name: c.name || "",
      mobile: c.phone || "",
      address: (c as any).address || "",
    });
    setQuery(c.name || c.phone || "");
    setMatches([]);
    setDupes([]);
  };

  // "New customer" duplicate guard: while typing a name or mobile, search the DB and
  // surface existing customers so the user can reuse them instead of creating a duplicate.
  const [dupes, setDupes] = useState<Match[]>([]);
  useEffect(() => {
    if (mode !== "new" || value.customer_id || disabled) { setDupes([]); return; }
    const name = (value.name || "").trim();
    const mobile = (value.mobile || "").replace(/\D/g, "");
    const q = mobile.length >= 4 ? mobile : name.length >= 3 ? name : "";
    if (!q) { setDupes([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api.searchCustomers(q, 5);
        if (!cancelled) setDupes(res.customers || []);
      } catch { if (!cancelled) setDupes([]); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [mode, value.name, value.mobile, value.customer_id, disabled]);

  const clear = () => {
    setQuery("");
    setMatches([]);
    onChange({ customer_id: null, name: "", mobile: "", address: "" });
    setLookupErr("");
  };

  return (
    <View testID={testID}>
      <View style={styles.tabsRow}>
        <Pressable
          onPress={() => { setMode("existing"); }}
          disabled={disabled}
          style={[styles.tab, mode === "existing" && styles.tabActive]}
          testID="cust-tab-existing"
        >
          <Ionicons name="people-outline" size={13} color={mode === "existing" ? "#fff" : theme.color.muted} />
          <Text style={[styles.tabText, mode === "existing" && styles.tabTextActive]}>Existing customer</Text>
        </Pressable>
        <Pressable
          onPress={() => { setMode("new"); setQuery(""); }}
          disabled={disabled}
          style={[styles.tab, mode === "new" && styles.tabActive]}
          testID="cust-tab-new"
        >
          <Ionicons name="person-add-outline" size={13} color={mode === "new" ? "#fff" : theme.color.muted} />
          <Text style={[styles.tabText, mode === "new" && styles.tabTextActive]}>New customer</Text>
        </Pressable>
      </View>

      {mode === "existing" ? (
        <View>
          <Text style={styles.label}>Find by name or mobile</Text>
          <View style={styles.searchRow}>
            <View style={styles.searchInputWrap}>
              <Ionicons name="search" size={14} color={theme.color.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                editable={!disabled}
                placeholder="Name or 91XXXXXXXXXX"
                placeholderTextColor={theme.color.muted}
                style={styles.searchInput}
                testID="cust-search-input"
                autoCapitalize="words"
              />
              {looking ? <ActivityIndicator size="small" color={theme.color.brand} /> : null}
              {query && !looking ? (
                <Pressable onPress={clear} hitSlop={8} testID="cust-clear">
                  <Ionicons name="close-circle" size={16} color={theme.color.muted} />
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* Selected customer summary */}
          {value.customer_id ? (
            <View style={styles.foundCard} testID="cust-found">
              <View style={styles.foundIcon}>
                <Ionicons name="checkmark-circle" size={16} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.foundName}>{value.name}</Text>
                <Text style={styles.foundMeta}>{value.mobile}</Text>
                {value.address ? <Text style={styles.foundMeta}>{value.address}</Text> : null}
              </View>
              <Pressable onPress={clear} hitSlop={6}>
                <Ionicons name="close" size={16} color={theme.color.muted} />
              </Pressable>
            </View>
          ) : matches.length > 0 ? (
            <View style={styles.resultsBox} testID="cust-results">
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
                {matches.map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => pick(c)}
                    style={({ pressed }) => [styles.resultRow, pressed && { backgroundColor: theme.color.surfaceTertiary }]}
                    testID={`cust-result-${c.id}`}
                  >
                    <View style={styles.resultAvatar}>
                      <Text style={styles.resultAvatarText}>{(c.name || "?").slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.resultName} numberOfLines={1}>{c.name || "—"}</Text>
                      <Text style={styles.resultMeta} numberOfLines={1}>
                        {c.phone}{c.is_mine ? " · mine" : ""}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={14} color={theme.color.muted} />
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : lookupErr ? (
            <View style={styles.notFoundCard}>
              <Ionicons name="alert-circle-outline" size={14} color="#B45309" />
              <Text style={styles.notFoundText}>{lookupErr}</Text>
              <Pressable onPress={() => { setMode("new"); }} style={styles.switchBtn} testID="cust-switch-new">
                <Text style={styles.switchBtnText}>+ Add new</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : (
        <View>
          <Text style={styles.label}>Customer name</Text>
          <TextInput
            value={value.name}
            onChangeText={(t) => onChange({ ...value, name: t })}
            editable={!disabled}
            placeholder="e.g. Ravi Sharma"
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            testID="cust-new-name"
          />
          <Text style={styles.label}>Mobile number</Text>
          <TextInput
            value={value.mobile}
            onChangeText={(t) => onChange({ ...value, mobile: t })}
            keyboardType="phone-pad"
            editable={!disabled}
            placeholder="Include country code, e.g. 91XXXXXXXXXX"
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            testID="cust-new-mobile"
          />
          <Text style={styles.hint}>If a customer with this mobile already exists, we&apos;ll reuse them automatically.</Text>
          {dupes.length > 0 ? (
            <View style={styles.dupeBox} testID="cust-dupe-box">
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="alert-circle" size={14} color="#B45309" />
                <Text style={styles.dupeTitle}>Already in the database — tap to use</Text>
              </View>
              {dupes.map((c) => (
                <Pressable key={c.id} onPress={() => pick(c)} style={styles.dupeRow} testID={`cust-dupe-${c.id}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dupeName}>{c.name || "Unnamed"}</Text>
                    <Text style={styles.dupeMeta}>{c.phone}{(c as any).assigned_to ? ` · ${(c as any).assigned_to}` : ""}</Text>
                  </View>
                  <Text style={styles.dupeUse}>Use</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Text style={styles.label}>Address</Text>
          <TextInput
            value={value.address}
            onChangeText={(t) => onChange({ ...value, address: t })}
            multiline
            editable={!disabled}
            placeholder="Street, city, pincode"
            placeholderTextColor={theme.color.muted}
            style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]}
            testID="cust-new-address"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dupeBox: { marginTop: 8, padding: 10, borderRadius: theme.radius.md, backgroundColor: "#FEF3C7", borderWidth: 1, borderColor: "#FCD34D" },
  dupeTitle: { fontSize: 12, fontWeight: "800", color: "#B45309" },
  dupeRow: {
    flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, padding: 8, borderRadius: theme.radius.sm,
    backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border,
  },
  dupeName: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },
  dupeMeta: { fontSize: 11, color: theme.color.muted, marginTop: 1 },
  dupeUse: { fontSize: 12, fontWeight: "800", color: theme.color.brand },
  tabsRow: {
    flexDirection: "row", gap: 6, marginTop: theme.space.md, marginBottom: 4,
    padding: 4, backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
  },
  tab: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    paddingVertical: 8, borderRadius: theme.radius.sm,
  },
  tabActive: { backgroundColor: theme.color.brand },
  tabText: { fontSize: 12, fontWeight: "700", color: theme.color.muted },
  tabTextActive: { color: "#fff" },
  label: { marginTop: theme.space.md, marginBottom: 4, fontSize: 12, fontWeight: "700", color: theme.color.muted, letterSpacing: 0.5, textTransform: "uppercase" },
  hint: { marginTop: 4, fontSize: 10, color: theme.color.muted, fontStyle: "italic" },
  input: {
    minHeight: 44, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 12, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surface,
  },
  searchRow: { marginBottom: 4 },
  searchInputWrap: {
    flexDirection: "row", alignItems: "center", gap: 6,
    height: 44, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 10, backgroundColor: theme.color.surface,
  },
  searchInput: {
    flex: 1, color: theme.color.onSurface, fontSize: 15,
  },
  foundCard: {
    marginTop: 8, padding: 10, borderRadius: theme.radius.md,
    backgroundColor: "#ECFDF5", borderWidth: 1, borderColor: "#A7F3D0",
    flexDirection: "row", alignItems: "center", gap: 10,
  },
  foundIcon: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: theme.color.success,
    alignItems: "center", justifyContent: "center",
  },
  foundName: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  foundMeta: { fontSize: 11, color: theme.color.muted, marginTop: 1 },
  notFoundCard: {
    marginTop: 8, padding: 10, borderRadius: theme.radius.md,
    backgroundColor: "#FEF3C7", borderWidth: 1, borderColor: "#FCD34D",
    flexDirection: "row", alignItems: "center", gap: 6,
  },
  notFoundText: { flex: 1, fontSize: 11, color: "#78350F" },
  switchBtn: { backgroundColor: theme.color.brand, paddingHorizontal: 10, paddingVertical: 5, borderRadius: theme.radius.sm },
  switchBtnText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  resultsBox: {
    marginTop: 8, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    backgroundColor: theme.color.surface, overflow: "hidden",
  },
  resultRow: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  resultAvatar: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: theme.color.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  resultAvatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 13 },
  resultName: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },
  resultMeta: { fontSize: 11, color: theme.color.muted, marginTop: 1 },
});
