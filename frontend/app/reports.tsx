import {
  View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Platform, Linking,
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

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;

type Pnl = {
  since: string; days: number; revenue: number; cogs: number; gross_profit: number;
  expenses: number; net_profit: number; sales_count: number; expense_count: number;
};

async function auth<T>(path: string): Promise<T> {
  const t = await storage.secureGet(TOKEN_KEY, "");
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function Reports() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>("");

  const load = useCallback(async () => {
    try { setPnl(await auth<Pnl>(`/stats/pnl`)); }
    catch (e) { console.log(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openDownload = async (url: string, filename: string) => {
    if (Platform.OS === "web") {
      // trigger browser download
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
    } else {
      await Linking.openURL(url);
    }
  };

  const download = async (kind: "sales" | "expenses" | "pnl") => {
    setBusy(kind);
    try {
      const { token } = await auth<{ token: string }>(`/reports/token?kind=${kind}`);
      await openDownload(`${BACKEND}/api/reports/${kind}.xlsx?token=${token}`, `${kind}.xlsx`);
    } catch (e: any) {
      console.log(e);
    } finally {
      setBusy("");
    }
  };

  // Full data backup — every collection (customers, sales, invoices, receipts, collections, attendance, users …)
  const backup = async (format: "xlsx" | "json") => {
    setBusy(`backup-${format}`);
    try {
      const { token } = await auth<{ token: string }>(`/admin/backup/token`);
      const stamp = new Date().toISOString().slice(0, 10);
      await openDownload(`${BACKEND}/api/admin/backup.${format}?token=${token}`, `backup_${stamp}.${format}`);
    } catch (e: any) {
      console.log(e);
    } finally {
      setBusy("");
    }
  };

  const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

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
    <View style={[styles.container, { paddingTop: insets.top }]} testID="reports-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Reports</Text>
          <Text style={styles.hdrSub}>Last 30 days · download Excel</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }}>
        {loading || !pnl ? (
          <ActivityIndicator color={theme.color.brand} style={{ marginTop: 32 }} />
        ) : (
          <>
            <View style={styles.pnlCard}>
              <Text style={styles.pnlLabel}>NET PROFIT · LAST {pnl.days} DAYS</Text>
              <Text style={[styles.pnlNet, pnl.net_profit < 0 && { color: theme.color.error }]}>
                {fmt(pnl.net_profit)}
              </Text>
              <View style={styles.pnlRow}>
                <PnlLine label="Revenue" value={fmt(pnl.revenue)} count={`${pnl.sales_count} sales`} />
                <PnlLine label="COGS" value={"−" + fmt(pnl.cogs)} count="purchase cost" />
              </View>
              <View style={styles.divider} />
              <View style={styles.pnlRow}>
                <PnlLine label="Gross profit" value={fmt(pnl.gross_profit)} count="revenue − cogs" />
                <PnlLine label="Expenses" value={"−" + fmt(pnl.expenses)} count={`${pnl.expense_count} logged`} />
              </View>
            </View>

            <Text style={styles.section}>DOWNLOAD</Text>
            <View style={styles.group}>
              <DownloadRow icon="cash-outline" label="Sales report" hint="Every sale with profit column" busy={busy === "sales"} onPress={() => download("sales")} testID="download-sales" />
              <DownloadRow icon="receipt-outline" label="Expenses report" hint="All expense entries" busy={busy === "expenses"} onPress={() => download("expenses")} testID="download-expenses" />
              <DownloadRow icon="stats-chart-outline" label="P&L report" hint="Day-by-day profit/loss + totals" busy={busy === "pnl"} onPress={() => download("pnl")} testID="download-pnl" />
            </View>

            <Text style={styles.section}>BACKUP ALL DATA</Text>
            <View style={styles.group}>
              <DownloadRow icon="server-outline" label="Backup (Excel)" hint="One sheet per collection — customers, sales, invoices, receipts, collections, cash verifications, attendance, users, settings…" busy={busy === "backup-xlsx"} onPress={() => backup("xlsx")} testID="backup-xlsx" />
              <DownloadRow icon="code-download-outline" label="Backup (JSON, restore-ready)" hint="Exact copy of every record. Keep it private — it contains account data." busy={busy === "backup-json"} onPress={() => backup("json")} testID="backup-json" />
            </View>
            <Text style={styles.backupHint}>Tip: also use “Save to GitHub” for the code. Run a backup at least weekly and keep the files somewhere safe (Drive / laptop).</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function PnlLine({ label, value, count }: { label: string; value: string; count: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.pnlLineLabel}>{label}</Text>
      <Text style={styles.pnlLineValue}>{value}</Text>
      <Text style={styles.pnlLineCount}>{count}</Text>
    </View>
  );
}

function DownloadRow({ icon, label, hint, onPress, busy, testID }: { icon: keyof typeof Ionicons.glyphMap; label: string; hint: string; onPress: () => void; busy: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} disabled={busy} style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.color.surfaceTertiary }]} testID={testID}>
      <View style={styles.iconWrap}>
        {busy ? <ActivityIndicator color={theme.color.brand} /> : <Ionicons name={icon} size={20} color={theme.color.brand} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <Ionicons name="download-outline" size={18} color={theme.color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  pnlCard: {
    backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.lg,
    padding: theme.space.xl,
  },
  pnlLabel: { color: theme.color.borderStrong, fontSize: 11, fontWeight: "700", letterSpacing: 1.5 },
  pnlNet: { color: theme.color.success, fontSize: 40, fontWeight: "800", marginTop: 6, letterSpacing: -1 },
  pnlRow: { flexDirection: "row", gap: theme.space.md, marginTop: theme.space.lg },
  divider: { height: 1, backgroundColor: "rgba(255,255,255,0.15)", marginVertical: theme.space.md },
  pnlLineLabel: { color: theme.color.borderStrong, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  pnlLineValue: { color: "#fff", fontSize: 18, fontWeight: "800", marginTop: 4 },
  pnlLineCount: { color: theme.color.borderStrong, fontSize: 11, marginTop: 2, fontWeight: "600" },
  section: {
    fontSize: 11, letterSpacing: 1, color: theme.color.muted, fontWeight: "700",
    marginBottom: theme.space.sm, marginTop: theme.space.xl,
  },
  group: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", padding: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", marginRight: theme.space.md, backgroundColor: theme.color.brandTertiary },
  rowLabel: { fontSize: theme.font.scale.lg, fontWeight: "600", color: theme.color.onSurface },
  rowHint: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  backupHint: { fontSize: 11, color: theme.color.muted, marginTop: theme.space.sm, lineHeight: 16 },
  deniedTitle: { marginTop: theme.space.md, fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  backBtn: { marginTop: theme.space.lg, paddingHorizontal: theme.space.xl, paddingVertical: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brand },
  backBtnText: { color: theme.color.onBrand, fontWeight: "700" },
});
