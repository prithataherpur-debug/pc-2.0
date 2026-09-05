import {
  View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, RefreshControl, Linking,
} from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/lib/theme";
import { api } from "@/src/lib/api";

const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const fmtWhen = (iso: string) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) +
      " · " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  } catch { return iso.slice(0, 16); }
};

type LedgerData = Awaited<ReturnType<typeof api.getCustomerLedger>>;

export default function CustomerLedgerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<LedgerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setErr("");
    try {
      const res = await api.getCustomerLedger(String(id));
      setData(res);
    } catch (e: any) {
      setErr(String(e?.message || "Failed to load"));
    } finally { setLoading(false); setRefreshing(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openPdf = (token?: string | null) => {
    if (!token) return;
    const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${token}`;
    Linking.openURL(url).catch(() => {});
  };

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }
  if (err || !data) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, padding: theme.space.lg }]}>
        <Pressable onPress={() => router.back()} style={{ marginBottom: 16 }}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <Text style={{ color: theme.color.error, fontSize: 14 }}>{err || "No data"}</Text>
      </View>
    );
  }

  const balance = data.summary.due_balance;
  const balanceIsDue = balance > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="customer-ledger-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle} numberOfLines={1}>{data.customer.name}</Text>
          <Text style={styles.hdrSub}>{data.customer.phone}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: theme.space.lg, paddingBottom: insets.bottom + 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brand} />}
      >
        {/* Balance card */}
        <View style={[styles.balCard, { backgroundColor: balanceIsDue ? "#B91C1C" : theme.color.success }]}>
          <Text style={styles.balLabel}>{balanceIsDue ? "AMOUNT DUE" : balance < 0 ? "ADVANCE PAID" : "SETTLED"}</Text>
          <Text style={styles.balValue}>{fmt(Math.abs(balance))}</Text>
          <View style={styles.balBreakdown}>
            <View style={styles.balChip}>
              <Text style={styles.balChipLabel}>Billed (sales + invoices)</Text>
              <Text style={styles.balChipValue} testID="ledger-billed">{fmt(data.summary.total_billed)}</Text>
              <Text style={styles.balChipSub}>
                Sales {fmt(data.summary.total_billed_manual)} · Inv {fmt(data.summary.total_invoices)}
              </Text>
            </View>
            <View style={styles.balChip}>
              <Text style={styles.balChipLabel}>Received</Text>
              <Text style={styles.balChipValue}>{fmt(data.summary.total_received)}</Text>
            </View>
          </View>
        </View>

        {/* Counts row */}
        <View style={styles.countsRow}>
          <CountTile icon="cart-outline" label="Sales" value={data.counts.sales} />
          <CountTile icon="document-text-outline" label="Invoices" value={data.counts.invoices} />
          <CountTile icon="receipt-outline" label="Receipts" value={data.counts.receipts} />
        </View>

        {/* Quick actions */}
        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => router.push({ pathname: "/receipts", params: { src_type: "other", customer: data.customer.name } })}
            style={styles.actBtn}
            testID="ledger-add-receipt"
          >
            <Ionicons name="receipt-outline" size={14} color="#fff" />
            <Text style={styles.actBtnText}>New receipt</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push({ pathname: "/invoices" })}
            style={[styles.actBtn, { backgroundColor: theme.color.brand }]}
            testID="ledger-add-invoice"
          >
            <Ionicons name="document-text-outline" size={14} color="#fff" />
            <Text style={styles.actBtnText}>New invoice</Text>
          </Pressable>
        </View>

        {/* Timeline */}
        <Text style={styles.sectionLabel}>ACTIVITY TIMELINE</Text>
        {data.timeline.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Ionicons name="reader-outline" size={22} color={theme.color.borderStrong} />
            <Text style={styles.emptyText}>No activity yet</Text>
          </View>
        ) : (
          data.timeline.map((ev, idx) => (
            <TimelineItem key={`${ev.kind}-${ev.id}`} ev={ev} isLast={idx === data.timeline.length - 1} onOpen={() => openPdf(ev.pdf_token)} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function CountTile({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: number }) {
  return (
    <View style={styles.countTile}>
      <Ionicons name={icon} size={14} color={theme.color.brand} />
      <Text style={styles.countValue}>{value}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

function TimelineItem({ ev, isLast, onOpen }: {
  ev: LedgerData["timeline"][number]; isLast: boolean; onOpen: () => void;
}) {
  const openToken = (token?: string | null) => {
    if (!token) return;
    Linking.openURL(`${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${token}`).catch(() => {});
  };
  const kindMeta = {
    sale: { icon: "cart-outline" as const, color: theme.color.success, sign: "+" },
    invoice: { icon: "document-text-outline" as const, color: theme.color.brand, sign: "+" },
    receipt: { icon: "receipt-outline" as const, color: "#7C3AED", sign: "−" },
  }[ev.kind];

  return (
    <View style={styles.tlRow}>
      <View style={styles.tlLeft}>
        <View style={[styles.tlDot, { backgroundColor: kindMeta.color }]}>
          <Ionicons name={kindMeta.icon} size={12} color="#fff" />
        </View>
        {!isLast ? <View style={styles.tlLine} /> : null}
      </View>
      <Pressable onPress={ev.pdf_token ? onOpen : undefined} style={styles.tlCard}>
        <View style={styles.tlHead}>
          <Text style={styles.tlTitle}>{ev.title || ev.kind}</Text>
          <Text style={[styles.tlAmount, { color: kindMeta.color }]}>
            {kindMeta.sign}{fmt(ev.amount)}
          </Text>
        </View>
        <Text style={styles.tlMeta}>{fmtWhen(ev.when)}{ev.by ? ` · by ${ev.by}` : ""}</Text>
        {ev.notes ? <Text style={styles.tlNotes} numberOfLines={2}>{ev.notes}</Text> : null}
        {ev.kind === "receipt" && ev.payment_mode ? (
          <View style={styles.tlBadgeRow}>
            <View style={styles.tlBadge}>
              <Text style={styles.tlBadgeText}>{String(ev.payment_mode).toUpperCase()}</Text>
            </View>
            {ev.source_label ? <Text style={styles.tlBadgeInfo}>{ev.source_label}</Text> : null}
          </View>
        ) : null}
        {ev.pdf_token ? (
          <Pressable onPress={onOpen} style={styles.tlPdfBtn} testID={`ledger-pdf-${ev.kind}-${ev.id}`}>
            <Ionicons name="document-text-outline" size={12} color="#fff" />
            <Text style={styles.tlPdfBtnText}>Open {ev.kind === "invoice" ? "invoice" : "receipt"} PDF</Text>
          </Pressable>
        ) : null}
        {ev.kind === "sale" && ev.receipts && ev.receipts.length > 0 ? (
          <View style={styles.tlBadgeRow}>
            {ev.receipts.map((r) => (
              <Pressable key={r.id} onPress={() => openToken(r.pdf_token)} style={styles.tlRcptChip} testID={`ledger-sale-rcpt-${r.id}`}>
                <Ionicons name="receipt-outline" size={10} color={theme.color.brand} />
                <Text style={styles.tlRcptChipText}>{r.receipt_no} · {fmt(r.amount)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  tlPdfBtn: {
    marginTop: 8, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6,
    height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: theme.color.brand,
  },
  tlPdfBtnText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  tlRcptChip: {
    flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingHorizontal: 8, borderRadius: 13,
    backgroundColor: theme.color.brandTertiary, borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  tlRcptChipText: { fontSize: 10, fontWeight: "800", color: theme.color.brand },
  container: { flex: 1, backgroundColor: theme.color.surface },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: 17, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },

  balCard: {
    padding: theme.space.lg, borderRadius: theme.radius.lg,
    alignItems: "center",
    marginBottom: theme.space.lg,
  },
  balLabel: { fontSize: 11, color: "#fff", fontWeight: "800", letterSpacing: 2 },
  balValue: { fontSize: 34, color: "#fff", fontWeight: "900", marginTop: 4 },
  balBreakdown: { flexDirection: "row", gap: 8, marginTop: 12 },
  balChip: {
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: theme.radius.md, alignItems: "center",
  },
  balChipLabel: { color: "#fff", fontSize: 10, fontWeight: "700", opacity: 0.85 },
  balChipValue: { color: "#fff", fontSize: 14, fontWeight: "800", marginTop: 2 },
  balChipSub: { color: "#fff", fontSize: 9, fontWeight: "600", opacity: 0.8, marginTop: 2 },


  countsRow: { flexDirection: "row", gap: 8, marginBottom: theme.space.lg },
  countTile: {
    flex: 1, padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    alignItems: "center", gap: 4,
  },
  countValue: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
  countLabel: { fontSize: 10, fontWeight: "700", color: theme.color.muted, letterSpacing: 0.5 },

  actionsRow: { flexDirection: "row", gap: 8, marginBottom: theme.space.lg },
  actBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    backgroundColor: "#7C3AED", height: 40, borderRadius: theme.radius.md,
  },
  actBtnText: { color: "#fff", fontSize: 12, fontWeight: "800" },

  sectionLabel: { fontSize: 11, fontWeight: "800", color: theme.color.muted, letterSpacing: 1, marginBottom: theme.space.sm },
  emptyBlock: {
    alignItems: "center", padding: theme.space.lg, gap: 4,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border, borderStyle: "dashed",
  },
  emptyText: { fontSize: 12, color: theme.color.muted },

  tlRow: { flexDirection: "row", gap: 8 },
  tlLeft: { alignItems: "center", width: 24 },
  tlDot: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  tlLine: { width: 2, flex: 1, backgroundColor: theme.color.border, marginTop: 2 },
  tlCard: {
    flex: 1, marginBottom: theme.space.sm,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
  },
  tlHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  tlTitle: { flex: 1, fontSize: 13, fontWeight: "800", color: theme.color.onSurface },
  tlAmount: { fontSize: 14, fontWeight: "800" },
  tlMeta: { fontSize: 10, color: theme.color.muted, marginTop: 2 },
  tlNotes: { fontSize: 11, color: theme.color.onSurfaceTertiary, marginTop: 4, fontStyle: "italic" },
  tlBadgeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
  tlBadge: {
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3,
    backgroundColor: theme.color.brandTertiary,
  },
  tlBadgeText: { fontSize: 8, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.5 },
  tlBadgeInfo: { fontSize: 10, color: theme.color.muted, flex: 1 },
  tlPdfHint: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 6 },
  tlPdfHintText: { fontSize: 10, color: theme.color.brand, fontWeight: "700" },
});
