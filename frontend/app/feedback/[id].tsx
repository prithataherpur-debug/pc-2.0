import {
  View, Text, StyleSheet, Pressable, TextInput, ScrollView, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from "react-native";
import { useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";

import { theme } from "@/src/lib/theme";
import { api, Customer, STATUS_COLOR, STATUS_LABEL } from "@/src/lib/api";

export default function Feedback() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [rating, setRating] = useState<number>(0);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const list = await api.listCustomers("all", "", "mine");
        const c = list.find((x) => x.id === id) || null;
        if (c) {
          setCustomer(c);
          setRating(c.rating || 0);
          setNotes(c.feedback || "");
        }
      } catch (e) { console.log(e); }
      finally { setLoading(false); }
    })();
  }, [id]);

  const submit = async () => {
    if (!id || !rating) { setErr("Pick a rating from 1 to 5."); return; }
    setErr(""); setBusy(true);
    try {
      await api.submitFeedback(id as string, rating, notes.trim());
      router.back();
    } catch (e: any) {
      setErr(String(e?.message || "Save failed"));
    } finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.color.surface }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()} style={styles.backIcon}><Ionicons name="close" size={22} color={theme.color.onSurface} /></Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.hdrTitle}>Customer feedback</Text>
            <Text style={styles.hdrSub}>Log rating & notes after your conversation</Text>
          </View>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
        ) : !customer ? (
          <View style={styles.center}>
            <Ionicons name="alert-circle-outline" size={40} color={theme.color.muted} />
            <Text style={{ color: theme.color.muted, marginTop: 8 }}>Customer not found</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }} keyboardShouldPersistTaps="handled">
            <View style={styles.card}>
              <Text style={styles.name}>{customer.name}</Text>
              <Text style={styles.phone}>{customer.phone}</Text>
              <View style={styles.metaRow}>
                <View style={[styles.tag, { borderColor: STATUS_COLOR[customer.status], backgroundColor: STATUS_COLOR[customer.status] + "22" }]}>
                  <Text style={[styles.tagText, { color: STATUS_COLOR[customer.status] }]}>{STATUS_LABEL[customer.status]}</Text>
                </View>
                {customer.followup_date ? (
                  <View style={styles.tag}>
                    <Text style={styles.tagText}>Follow-up {customer.followup_date}</Text>
                  </View>
                ) : null}
                {customer.whatsapp_sent_at ? (
                  <View style={styles.tag}>
                    <Ionicons name="logo-whatsapp" size={11} color="#25D366" />
                    <Text style={[styles.tagText, { color: "#25D366", marginLeft: 4 }]}>WA sent</Text>
                  </View>
                ) : null}
              </View>
            </View>

            <Text style={styles.section}>RATING</Text>
            <View style={styles.starRow}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} onPress={() => setRating(n)} testID={`star-${n}`}>
                  <Ionicons
                    name={n <= rating ? "star" : "star-outline"}
                    size={40}
                    color={n <= rating ? "#D4AC0D" : theme.color.borderStrong}
                    style={{ marginHorizontal: 4 }}
                  />
                </Pressable>
              ))}
            </View>

            <Text style={styles.section}>NOTES</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="How did the conversation go? What are next steps?"
              placeholderTextColor={theme.color.muted}
              style={styles.notesInput}
              testID="feedback-notes"
            />

            {err ? <Text style={styles.err}>{err}</Text> : null}

            <Pressable
              onPress={submit}
              disabled={busy}
              style={[styles.saveBtn, busy && { opacity: 0.6 }]}
              testID="feedback-submit"
            >
              {busy ? <ActivityIndicator color={theme.color.onBrand} /> : <Text style={styles.saveBtnText}>Save feedback</Text>}
            </Pressable>
          </ScrollView>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hdr: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: theme.space.md, paddingVertical: theme.space.md, backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  card: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: theme.space.lg, borderWidth: 1, borderColor: theme.color.border },
  name: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  phone: { fontSize: theme.font.scale.base, color: theme.color.muted, marginTop: 2 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginTop: theme.space.md },
  tag: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.pill, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceTertiary },
  tagText: { fontSize: 11, fontWeight: "700", color: theme.color.onSurfaceTertiary, textTransform: "uppercase", letterSpacing: 0.5 },
  section: { fontSize: 11, letterSpacing: 1, color: theme.color.muted, fontWeight: "700", marginTop: theme.space.xl, marginBottom: theme.space.sm },
  starRow: { flexDirection: "row", justifyContent: "center", padding: theme.space.md, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border },
  notesInput: { minHeight: 140, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, padding: theme.space.md, color: theme.color.onSurface, fontSize: 15, textAlignVertical: "top" },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: { marginTop: theme.space.xl, backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  saveBtnText: { color: theme.color.onBrand, fontWeight: "700", fontSize: 16 },
});
