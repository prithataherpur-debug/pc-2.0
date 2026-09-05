import {
  View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Modal,
  RefreshControl, Linking, Platform, useWindowDimensions,
} from "react-native";
import CashDesk from "@/src/components/CashDesk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { theme } from "@/src/lib/theme";
import { api, CollectionEntry, MoneyReceipt, Invoice, Sale, LinkedReceipt, DENOMS } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const todayKey = () => new Date().toISOString().slice(0, 10);
const shiftDate = (d: string, days: number) => {
  const dt = new Date(d + "T00:00:00");
  dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
};

type SectionKey = "sales" | "due_collection" | "receipts" | "invoices";

export default function DaybookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [date, setDate] = useState<string>(todayKey());
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getDaybook>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    sales: true,
    due_collection: true,
    receipts: true,
    invoices: true,
  });
  const [toast, setToast] = useState("");
  const [canExport, setCanExport] = useState(isAdmin);
  const [accessChecked, setAccessChecked] = useState(isAdmin);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (isAdmin) { setCanExport(true); setAccessChecked(true); return; }
    api.getCollector()
      .then((r) => setCanExport(r.collector?.username === user?.username))
      .catch(() => setCanExport(false))
      .finally(() => setAccessChecked(true));
  }, [isAdmin, user?.username]);

  // Wide-screen (computer/web) layout: keep content readable in a centered column
  const { width: winW } = useWindowDimensions();
  const wide = winW >= 900;

  const downloadExcel = async (from: string, to?: string) => {
    setExporting(true);
    try {
      const { token } = await api.daybookExportToken(from, to);
      const url = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/api/daybook.xlsx?token=${token}`;
      if (Platform.OS === "web") {
        const a = document.createElement("a");
        a.href = url;
        a.download = to && to !== from ? `daybook_${from}_to_${to}.xlsx` : `daybook_${from}.xlsx`;
        a.click();
      } else {
        await Linking.openURL(url);
      }
      showToast("Excel download started");
    } catch (e: any) {
      showToast(String(e?.message || "Export failed"));
    } finally { setExporting(false); }
  };

  const [exportOpen, setExportOpen] = useState(false);
  const chooseExport = () => setExportOpen(true);
  const monthStart = date.slice(0, 8) + "01";
  const exportOptions: { key: string; label: string; sub: string; run: () => void }[] = [
    { key: "day", label: "This day", sub: date, run: () => downloadExcel(date) },
    { key: "week", label: "Last 7 days", sub: `${shiftDate(date, -6)} → ${date}`, run: () => downloadExcel(shiftDate(date, -6), date) },
    { key: "month", label: "This month", sub: `${monthStart} → ${date}`, run: () => downloadExcel(monthStart, date) },
  ];

  const [forbidden, setForbidden] = useState(false);
  const load = useCallback(async () => {
    try {
      const res = await api.getDaybook(date);
      setData(res);
      setForbidden(false);
    } catch (e: any) {
      console.log("daybook err", e);
      if (String(e?.message || "").includes("403") || /collector/i.test(String(e?.message || ""))) setForbidden(true);
    }
    finally { setLoading(false); setRefreshing(false); }
  }, [date]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  if (forbidden || (accessChecked && !canExport && !loading && !data)) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]} testID="daybook-forbidden">
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()} style={styles.backIcon}>
            <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.hdrTitle}>Daybook</Text>
          </View>
        </View>
        <View style={[styles.emptyBlock, { margin: theme.space.lg, paddingVertical: 40 }]}>
          <Ionicons name="lock-closed-outline" size={28} color={theme.color.borderStrong} />
          <Text style={[styles.emptyText, { fontSize: 15, fontWeight: "700", color: theme.color.onSurface }]}>Admin & collector only</Text>
          <Text style={[styles.emptyText, { textAlign: "center" }]}>The Daybook cash desk is available to the admin and the assigned collector.</Text>
        </View>
      </View>
    );
  }

  if (loading || !data) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="daybook-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Daybook</Text>
          <Text style={styles.hdrSub}>Cash verification & collection ledger</Text>
        </View>
        {canExport ? (
          <Pressable onPress={chooseExport} disabled={exporting} style={styles.exportBtn} testID="daybook-export" hitSlop={6}>
            {exporting ? <ActivityIndicator size="small" color={theme.color.brand} /> : <Ionicons name="download-outline" size={18} color={theme.color.brand} />}
          </Pressable>
        ) : null}
      </View>

      <Modal visible={exportOpen} transparent animationType="fade" onRequestClose={() => setExportOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setExportOpen(false)}>
          <Pressable style={styles.exportSheet} onPress={() => {}}>
            <View style={styles.handle} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Ionicons name="download-outline" size={20} color={theme.color.brand} />
              <Text style={styles.sheetTitle}>Download Daybook Excel</Text>
            </View>
            <Text style={styles.sheetSub}>Sheets: Summary · Sales · Invoices · Due Collection · Money Receipts · Cash Verification</Text>
            {exportOptions.map((o) => (
              <Pressable
                key={o.key}
                onPress={() => { setExportOpen(false); o.run(); }}
                style={({ pressed }) => [styles.exportOpt, pressed && { backgroundColor: theme.color.surfaceTertiary }]}
                testID={`daybook-export-${o.key}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.exportOptLabel}>{o.label}</Text>
                  <Text style={styles.exportOptSub}>{o.sub}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={theme.color.muted} />
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Date navigator */}
      <View style={styles.dateBar}>
        <Pressable onPress={() => setDate(shiftDate(date, -1))} style={styles.dateBtn} testID="date-prev">
          <Ionicons name="chevron-back" size={16} color={theme.color.onSurface} />
        </Pressable>
        <Pressable
          onPress={() => setDate(todayKey())}
          style={styles.dateCenter}
          testID="date-today"
        >
          <Text style={styles.dateText}>{date}</Text>
          {date !== todayKey() ? <Text style={styles.dateSub}>Tap for today</Text> : <Text style={styles.dateSub}>Today</Text>}
        </Pressable>
        <Pressable
          onPress={() => setDate(shiftDate(date, +1))}
          style={[styles.dateBtn, date === todayKey() && { opacity: 0.4 }]}
          disabled={date === todayKey()}
          testID="date-next"
        >
          <Ionicons name="chevron-forward" size={16} color={theme.color.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[{ padding: theme.space.lg, paddingBottom: 100 }, wide && styles.wideContent]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brand} />
        }
      >
        {/* Grand total card */}
        <View style={styles.grandCard}>
          <Text style={styles.grandLabel}>TOTAL COLLECTION</Text>
          <Text style={styles.grandValue}>{fmt(data.grand_total.total)}</Text>
          <View style={styles.grandBreakdown}>
            <View style={styles.grandChip}>
              <Ionicons name="cash-outline" size={12} color="#fff" />
              <Text style={styles.grandChipText}>Cash {fmt(data.grand_total.cash)}</Text>
            </View>
            <View style={styles.grandChip}>
              <Ionicons name="card-outline" size={12} color="#fff" />
              <Text style={styles.grandChipText}>Online {fmt(data.grand_total.online)}</Text>
            </View>
          </View>
        </View>

        {/* Total Collection breakdown card */}
        {data.total_collection ? (
          <View style={styles.tcCard}>
            <Text style={styles.tcTitle}>Breakdown</Text>
            <View style={styles.tcGrid}>
              <TCTile icon="calculator-outline" label="Cash counted" value={data.reconciliation?.verified ? fmt(data.reconciliation.counted_cash || 0) : "—"} />
              <TCTile icon="cart-outline" label="Sales" value={fmt(data.total_collection.sales ?? 0)} />
              <TCTile icon="document-text-outline" label="Invoices" value={fmt(data.total_collection.invoices)} />
              <TCTile icon="wallet-outline" label="Due collection" value={fmt(data.total_collection.due_collection)} />
              <TCTile icon="receipt-outline" label="Money receipts" value={fmt(data.total_collection.money_receipts)} />
            </View>
            <Text style={styles.tcHint}>
              Grand total = sales + invoices + due collection + standalone receipts. Receipts linked to a sale, invoice or collection listed today are informational only.
            </Text>
          </View>
        ) : null}

        {/* Reconciliation card */}
        {data.reconciliation ? <ReconciliationCard data={data.reconciliation} /> : null}

        {/* Cash desk: calculator + photos (admin & collector) */}
        <CashDesk
          date={date}
          data={data}
          canEdit={canExport}
          isAdmin={isAdmin}
          onChanged={(fresh, msg) => { setData(fresh); if (msg) showToast(msg); }}
        />

        {/* Section: Sales (punched by employees) */}
        <View style={{ marginTop: theme.space.lg }}>
          <Section
            title="Sales"
            subtitle={"Cash + online received on punched sales"}
            icon="cart-outline"
            totals={data.sales || { cash: 0, online: 0, total: 0 }}
            expanded={expanded.sales}
            onToggle={() => setExpanded((s) => ({ ...s, sales: !s.sales }))}
          />
          {expanded.sales ? (
            !data.sales || data.sales.entries.length === 0 ? (
              <View style={styles.emptyBlock}>
                <Ionicons name="cart-outline" size={20} color={theme.color.borderStrong} />
                <Text style={styles.emptyText}>No sales punched on {date}</Text>
                <Pressable onPress={() => router.push("/sales")} style={{ marginTop: 6 }}>
                  <Text style={styles.linkText}>Open Sales →</Text>
                </Pressable>
              </View>
            ) : (
              data.sales.entries.map((s) => (
                <SaleRow key={s.id} sale={s} />
              ))
            )
          ) : null}
        </View>

        {/* Section: Invoices */}
        <View style={{ marginTop: theme.space.lg }}>
          <Section
            title="Invoices"
            subtitle={"Bills generated today"}
            icon="document-text-outline"
            totals={data.invoices || { cash: 0, online: 0, total: 0 }}
            expanded={expanded.invoices}
            onToggle={() => setExpanded((s) => ({ ...s, invoices: !s.invoices }))}
          />
          {expanded.invoices ? (
            !data.invoices || data.invoices.entries.length === 0 ? (
              <View style={styles.emptyBlock}>
                <Ionicons name="document-text-outline" size={20} color={theme.color.borderStrong} />
                <Text style={styles.emptyText}>No invoices generated on {date}</Text>
                <Pressable onPress={() => router.push("/invoices")} style={{ marginTop: 6 }}>
                  <Text style={styles.linkText}>Open Invoices →</Text>
                </Pressable>
              </View>
            ) : (
              data.invoices.entries.map((iv) => (
                <InvoiceRow key={iv.id} invoice={iv} />
              ))
            )
          ) : null}
        </View>

        {/* Section: Due Collection */}
        <View style={{ marginTop: theme.space.lg }}>
          <Section
            title="Due collection"
            subtitle={"Cash + online logged by collector"}
            icon="wallet-outline"
            totals={data.due_collection}
            expanded={expanded.due_collection}
            onToggle={() => setExpanded((s) => ({ ...s, due_collection: !s.due_collection }))}
          />
          {expanded.due_collection ? (
            data.due_collection.entries.length === 0 ? (
              <View style={styles.emptyBlock}>
                <Ionicons name="wallet-outline" size={20} color={theme.color.borderStrong} />
                <Text style={styles.emptyText}>No collection logged for {date}</Text>
                <Pressable onPress={() => router.push("/collections")} style={{ marginTop: 6 }}>
                  <Text style={styles.linkText}>Open Due Collection →</Text>
                </Pressable>
              </View>
            ) : (
              data.due_collection.entries.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e as CollectionEntry}
                  own={false}
                  isAdmin={false}
                  onEdit={() => router.push("/collections")}
                  onDelete={() => {}}
                  testIdPrefix="col"
                />
              ))
            )
          ) : null}
        </View>

        {/* Section: Money Receipts */}
        <View style={{ marginTop: theme.space.lg }}>
          <Section
            title="Money receipts"
            subtitle={"Counted = added to total · Linked = already in a sale/invoice/collection"}
            icon="receipt-outline"
            totals={data.receipts || { cash: 0, online: 0, total: 0 }}
            expanded={expanded.receipts}
            onToggle={() => setExpanded((s) => ({ ...s, receipts: !s.receipts }))}
          />
          {expanded.receipts ? (
            !data.receipts || data.receipts.entries.length === 0 ? (
              <View style={styles.emptyBlock}>
                <Ionicons name="receipt-outline" size={20} color={theme.color.borderStrong} />
                <Text style={styles.emptyText}>No money receipts issued on {date}</Text>
                <Pressable onPress={() => router.push("/receipts")} style={{ marginTop: 6 }}>
                  <Text style={styles.linkText}>Open Money Receipts →</Text>
                </Pressable>
              </View>
            ) : (
              data.receipts.entries.map((r) => (
                <ReceiptRow key={r.id} receipt={r} />
              ))
            )
          ) : null}
        </View>
      </ScrollView>

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function TCTile({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.tcTile}>
      <View style={styles.tcIconWrap}>
        <Ionicons name={icon} size={14} color={theme.color.brand} />
      </View>
      <Text style={styles.tcTileLabel}>{label}</Text>
      <Text style={styles.tcTileValue}>{value}</Text>
    </View>
  );
}

function ReconciliationCard({ data }: {
  data: {
    verified: boolean;
    match: boolean;
    expected_cash: number;
    counted_cash: number | null;
    variance_total: number;
    verified_by_name?: string | null;
    verified_at?: string | null;
    note?: string | null;
  };
}) {
  if (!data.verified) {
    return (
      <View style={[styles.reconCard, styles.reconPending]} testID="recon-pending">
        <Ionicons name="calculator-outline" size={22} color={theme.color.muted} />
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={[styles.reconTitle, { color: theme.color.onSurface }]}>Cash not verified yet</Text>
          <Text style={styles.reconSub}>Expected cash {fmt(data.expected_cash)} · use the calculator below to count and save</Text>
        </View>
      </View>
    );
  }
  const isMatch = data.match;
  const variance = data.variance_total;
  return (
    <View style={[styles.reconCard, isMatch ? styles.reconOk : styles.reconWarn]} testID="recon-card">
      <Ionicons name={isMatch ? "checkmark-circle" : "alert-circle"} size={22} color={isMatch ? theme.color.success : "#B45309"} />
      <View style={{ flex: 1, marginLeft: 8 }}>
        <Text style={[styles.reconTitle, { color: isMatch ? theme.color.success : "#B45309" }]}>
          {isMatch ? "Cash matched" : variance > 0 ? `Cash excess ${fmt(variance)}` : `Cash short ${fmt(Math.abs(variance))}`}
        </Text>
        <Text style={styles.reconSub}>
          Counted {fmt(data.counted_cash || 0)} · Expected {fmt(data.expected_cash)}
          {data.verified_by_name ? ` · by ${data.verified_by_name}` : ""}
        </Text>
        {data.note ? <Text style={styles.reconNote}>{data.note}</Text> : null}
      </View>
    </View>
  );
}


function Section({
  title, subtitle, icon, totals, expanded, onToggle,
}: {
  title: string; subtitle: string; icon: keyof typeof Ionicons.glyphMap;
  totals: { cash: number; online: number; total: number };
  expanded: boolean; onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} style={styles.sectionHead}>
      <View style={styles.sectionIcon}>
        <Ionicons name={icon} size={18} color={theme.color.brand} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSub}>{subtitle}</Text>
      </View>
      <View style={styles.sectionTotals}>
        <Text style={styles.sectionValue}>{fmt(totals.total)}</Text>
        <View style={styles.sectionRow}>
          <View style={[styles.sectionSplit, { backgroundColor: theme.color.success + "22" }]}>
            <Ionicons name="cash-outline" size={9} color={theme.color.success} />
            <Text style={[styles.sectionSplitText, { color: theme.color.success }]}>{fmt(totals.cash)}</Text>
          </View>
          <View style={[styles.sectionSplit, { backgroundColor: theme.color.brand + "22" }]}>
            <Ionicons name="card-outline" size={9} color={theme.color.brand} />
            <Text style={[styles.sectionSplitText, { color: theme.color.brand }]}>{fmt(totals.online)}</Text>
          </View>
        </View>
      </View>
      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={theme.color.muted} />
    </Pressable>
  );
}

function EntryRow({
  entry, own, isAdmin, onEdit, onDelete, testIdPrefix,
}: {
  entry: CollectionEntry;
  own: boolean;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  testIdPrefix: string;
}) {
  const linked = (entry.linked_receipts as LinkedReceipt[] | undefined) || [];
  const linkedTotal = linked.reduce((s, r) => s + (r.amount || 0), 0);
  const openPdf = (token?: string | null) => {
    if (!token) return;
    const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${token}`;
    Linking.openURL(url).catch(() => {});
  };
  const canEdit = own || isAdmin;
  return (
    <Pressable
      onPress={canEdit ? onEdit : undefined}
      disabled={!canEdit}
      style={({ pressed }) => [styles.entry, pressed && canEdit && { backgroundColor: theme.color.surfaceTertiary }]}
      testID={`${testIdPrefix}-${entry.id}`}
    >
      <View style={styles.entryTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.entryName}>{entry.display_name || entry.user}</Text>
          {entry.notes ? <Text style={styles.entryNotes} numberOfLines={2}>{entry.notes}</Text> : null}
        </View>
        <Text style={styles.entryAmount}>{fmt(entry.grand_total)}</Text>
      </View>
      <View style={styles.entryBreakdown}>
        <View style={styles.miniChip}>
          <Ionicons name="cash-outline" size={10} color={theme.color.success} />
          <Text style={styles.miniText}>{fmt(entry.cash_total)}</Text>
        </View>
        <View style={styles.miniChip}>
          <Ionicons name="card-outline" size={10} color={theme.color.brand} />
          <Text style={styles.miniText}>{fmt(entry.online_total)}</Text>
        </View>
        <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 3, marginLeft: 6 }}>
          {DENOMS.map((d) => {
            const p = entry.denominations?.[String(d)] || 0;
            return p ? (
              <View key={d} style={styles.denomBadge}>
                <Text style={styles.denomBadgeText}>{d}×{p}</Text>
              </View>
            ) : null;
          })}
        </View>
        {canEdit ? (
          <Pressable onPress={onEdit} style={styles.actionChip} testID={`${testIdPrefix}-edit-${entry.id}`} hitSlop={6}>
            <Ionicons name="create-outline" size={12} color={theme.color.brand} />
            <Text style={styles.actionChipText}>Edit</Text>
          </Pressable>
        ) : null}
        {isAdmin && testIdPrefix === "ds" ? (
          <Pressable onPress={onDelete} style={styles.actionChipDel} testID={`${testIdPrefix}-del-${entry.id}`} hitSlop={6}>
            <Ionicons name="trash-outline" size={12} color={theme.color.error} />
            <Text style={[styles.actionChipText, { color: theme.color.error }]}>Delete</Text>
          </Pressable>
        ) : null}
      </View>
      {linked.length > 0 ? (
        <View style={styles.linkedBox} testID={`${testIdPrefix}-linked-${entry.id}`}>
          <View style={styles.linkedHead}>
            <Ionicons name="receipt-outline" size={12} color={theme.color.brand} />
            <Text style={styles.linkedTitle}>
              {linked.length} receipt{linked.length > 1 ? "s" : ""} linked · {fmt(linkedTotal)}
            </Text>
          </View>
          <View style={styles.linkedRow}>
            {linked.slice(0, 4).map((r) => (
              <Pressable
                key={r.id}
                onPress={() => openPdf(r.pdf_token)}
                style={styles.linkedChip}
                testID={`linked-rcp-${r.id}`}
              >
                <Ionicons name="document-text-outline" size={10} color={theme.color.brand} />
                <Text style={styles.linkedChipText}>{r.receipt_no}</Text>
                <Text style={styles.linkedChipAmt}>{fmt(r.amount)}</Text>
              </Pressable>
            ))}
            {linked.length > 4 ? (
              <Text style={styles.linkedMore}>+{linked.length - 4} more</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

function SaleRow({ sale }: { sale: Sale }) {
  const linked = (sale.linked_receipts as LinkedReceipt[] | undefined) || [];
  const openPdf = (token?: string | null) => {
    if (!token) return;
    const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${token}`;
    Linking.openURL(url).catch(() => {});
  };
  const modeColor = sale.payment_mode === "online" ? theme.color.brand : sale.payment_mode === "mixed" ? "#B45309" : theme.color.success;
  return (
    <View style={styles.entry} testID={`sale-${sale.id}`}>
      <View style={styles.entryTop}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.entryName} numberOfLines={1}>{sale.customer_name || "Customer"}</Text>
            <View style={[styles.modePill, { backgroundColor: modeColor + "22", borderColor: modeColor + "55" }]}>
              <Text style={[styles.modePillText, { color: modeColor }]}>{(sale.payment_mode || "cash").toUpperCase()}</Text>
            </View>
          </View>
          {sale.product ? <Text style={styles.entryNotes} numberOfLines={1}>{sale.product}</Text> : null}
          <Text style={styles.rcpSourceText} numberOfLines={1}>by {sale.display_name || sale.user}</Text>
        </View>
        <Text style={styles.entryAmount}>{fmt(sale.amount)}</Text>
      </View>
      <View style={styles.entryBreakdown}>
        <View style={styles.miniChip}>
          <Ionicons name="cash-outline" size={10} color={theme.color.success} />
          <Text style={styles.miniText}>{fmt(sale.cash_amount ?? 0)}</Text>
        </View>
        <View style={styles.miniChip}>
          <Ionicons name="card-outline" size={10} color={theme.color.brand} />
          <Text style={styles.miniText}>{fmt(sale.online_amount ?? 0)}</Text>
        </View>
        <View style={{ flex: 1 }} />
      </View>
      {linked.length > 0 ? (
        <View style={styles.linkedBox}>
          <View style={styles.linkedHead}>
            <Ionicons name="receipt-outline" size={12} color={theme.color.brand} />
            <Text style={styles.linkedTitle}>{linked.length} receipt{linked.length > 1 ? "s" : ""} linked</Text>
          </View>
          <View style={styles.linkedRow}>
            {linked.map((r) => (
              <Pressable key={r.id} onPress={() => openPdf(r.pdf_token)} style={styles.linkedChip}>
                <Ionicons name="document-text-outline" size={10} color={theme.color.brand} />
                <Text style={styles.linkedChipText}>{r.receipt_no}</Text>
                <Text style={styles.linkedChipAmt}>{fmt(r.amount)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const linked = (invoice.linked_receipts as LinkedReceipt[] | undefined) || [];
  const linkedTotal = linked.reduce((s, r) => s + (r.amount || 0), 0);
  const openPdf = (token?: string | null) => {
    if (!token) return;
    const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${token}`;
    Linking.openURL(url).catch(() => {});
  };
  return (
    <View style={styles.entry} testID={`inv-${invoice.id}`}>
      <View style={styles.entryTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.entryName}>{invoice.invoice_no}</Text>
          <Text style={styles.entryNotes} numberOfLines={1}>
            {invoice.customer_name}{invoice.customer_mobile ? " · " + invoice.customer_mobile : ""}
          </Text>
          <Text style={styles.rcpSourceText} numberOfLines={1}>
            {invoice.items.length} item{invoice.items.length !== 1 ? "s" : ""} · by {invoice.display_name || invoice.user}
          </Text>
        </View>
        <Text style={styles.entryAmount}>{fmt(invoice.total)}</Text>
      </View>
      <View style={styles.entryBreakdown}>
        <View style={{ flex: 1 }} />
        {invoice.pdf_token ? (
          <Pressable onPress={() => openPdf(invoice.pdf_token)} style={styles.actionBtn} hitSlop={6} testID={`inv-pdf-${invoice.id}`}>
            <Ionicons name="download-outline" size={13} color={theme.color.brand} />
          </Pressable>
        ) : null}
      </View>
      {linked.length > 0 ? (
        <View style={styles.linkedBox}>
          <View style={styles.linkedHead}>
            <Ionicons name="receipt-outline" size={12} color={theme.color.brand} />
            <Text style={styles.linkedTitle}>
              {linked.length} receipt{linked.length > 1 ? "s" : ""} linked · {fmt(linkedTotal)}
            </Text>
          </View>
          <View style={styles.linkedRow}>
            {linked.map((r) => (
              <Pressable key={r.id} onPress={() => openPdf(r.pdf_token)} style={styles.linkedChip}>
                <Ionicons name="document-text-outline" size={10} color={theme.color.brand} />
                <Text style={styles.linkedChipText}>{r.receipt_no}</Text>
                <Text style={styles.linkedChipAmt}>{fmt(r.amount)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ReceiptRow({ receipt }: { receipt: MoneyReceipt }) {
  const router = useRouter();
  const openPdf = () => {
    if (!receipt.pdf_token) return;
    const url = `${(process.env.EXPO_PUBLIC_BACKEND_URL || "")}/api/media/${receipt.pdf_token}`;
    Linking.openURL(url).catch(() => {});
  };
  const goToSource = () => {
    if (!receipt.source_id) return;
    const st = (receipt.source_type || "").toLowerCase();
    if (st === "sale") router.push({ pathname: "/sales", params: { highlight: receipt.source_id } });
    else if (st === "invoice") router.push({ pathname: "/invoices", params: { highlight: receipt.source_id } });
    else if (st === "collection") router.push({ pathname: "/collections", params: { highlight: receipt.source_id } });
  };
  const canJump = !!receipt.source_id && ["sale", "invoice", "collection"].includes((receipt.source_type || "").toLowerCase());
  const sourceIcon: keyof typeof Ionicons.glyphMap =
    receipt.source_type === "sale" ? "cart-outline"
    : receipt.source_type === "invoice" ? "document-text-outline"
    : receipt.source_type === "collection" ? "wallet-outline"
    : "cash-outline";
  const modeColor = receipt.payment_mode === "online" ? theme.color.brand : theme.color.success;
  const counted = receipt.counted_standalone === true;
  const flagColor = counted ? theme.color.success : theme.color.muted;
  return (
    <View style={styles.entry} testID={`rcp-${receipt.id}`}>
      <View style={styles.entryTop}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Text style={styles.entryName}>{receipt.receipt_no}</Text>
            <View style={[styles.modePill, { backgroundColor: modeColor + "22", borderColor: modeColor + "55" }]}>
              <Text style={[styles.modePillText, { color: modeColor }]}>{receipt.payment_mode.toUpperCase()}</Text>
            </View>
            {receipt.counted_standalone !== undefined ? (
              <Pressable
                onPress={goToSource}
                disabled={!canJump}
                hitSlop={6}
                style={[styles.modePill, { backgroundColor: flagColor + "22", borderColor: flagColor + "55", flexDirection: "row", alignItems: "center", gap: 3 }]}
                testID={`rcp-flag-${receipt.id}`}
              >
                <Ionicons name={counted ? "checkmark-circle" : "link-outline"} size={9} color={flagColor} />
                <Text style={[styles.modePillText, { color: flagColor }]}>{counted ? "COUNTED" : "LINKED"}</Text>
                {canJump ? <Ionicons name="chevron-forward" size={9} color={flagColor} /> : null}
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.entryNotes} numberOfLines={1}>
            {receipt.customer_name}{receipt.customer_mobile ? " · " + receipt.customer_mobile : ""}
          </Text>
          {receipt.source_label ? (
            <View style={styles.rcpSourceRow}>
              <Ionicons name={sourceIcon} size={10} color={theme.color.muted} />
              <Text style={styles.rcpSourceText} numberOfLines={1}>{receipt.source_label}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.entryAmount}>{fmt(receipt.amount)}</Text>
      </View>
      <View style={styles.entryBreakdown}>
        <Text style={[styles.miniText, { color: theme.color.muted }]}>by {receipt.display_name || receipt.user}</Text>
        <View style={{ flex: 1 }} />
        {receipt.pdf_token ? (
          <Pressable onPress={openPdf} style={styles.actionBtn} hitSlop={6} testID={`rcp-pdf-${receipt.id}`}>
            <Ionicons name="download-outline" size={13} color={theme.color.brand} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wideContent: { maxWidth: 1040, width: "100%", alignSelf: "center" },
  reconPending: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, flexDirection: "row", alignItems: "center" },
  reconNote: { fontSize: 12, color: theme.color.onSurface, marginTop: 4, fontStyle: "italic" },
  container: { flex: 1, backgroundColor: theme.color.surface },
  hdr: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: theme.space.md, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.color.brand,
    paddingHorizontal: 12, height: 36, borderRadius: theme.radius.pill,
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  dateBar: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: theme.space.md, paddingVertical: 10, gap: 8,
    backgroundColor: theme.color.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  dateBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  dateCenter: { flex: 1, alignItems: "center" },
  dateText: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  dateSub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },

  grandCard: {
    padding: theme.space.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.color.brand,
    alignItems: "center",
    marginBottom: theme.space.lg,
  },
  grandLabel: { fontSize: 11, color: "#fff", fontWeight: "800", letterSpacing: 2 },
  grandValue: { fontSize: 34, color: "#fff", fontWeight: "900", marginTop: 4 },
  grandBreakdown: { flexDirection: "row", gap: 8, marginTop: 10 },
  grandChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: theme.radius.pill,
  },
  grandChipText: { color: "#fff", fontWeight: "700", fontSize: 11 },

  sectionHead: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    marginBottom: theme.space.sm,
  },
  sectionIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.brandTertiary },
  sectionTitle: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface },
  sectionSub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  sectionTotals: { alignItems: "flex-end" },
  sectionValue: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  sectionRow: { flexDirection: "row", gap: 4, marginTop: 3 },
  sectionMini: { fontSize: 9, color: theme.color.muted, fontWeight: "700" },
  sectionSplit: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3,
  },
  sectionSplitText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.2 },

  entry: {
    padding: theme.space.sm,
    marginBottom: 6,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
  },
  entryTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  entryName: { fontSize: 13, fontWeight: "800", color: theme.color.onSurface },
  entryNotes: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  entryAmount: { fontSize: 14, fontWeight: "800", color: theme.color.success },
  entryBreakdown: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" },
  miniChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
  },
  miniText: { fontSize: 10, fontWeight: "700", color: theme.color.onSurface },
  denomBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, backgroundColor: theme.color.surfaceTertiary },
  denomBadgeText: { fontSize: 9, color: theme.color.muted, fontWeight: "700" },
  actionBtn: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.brandTertiary },
  actionChip: {
    flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14,
    backgroundColor: theme.color.brandTertiary, borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  actionChipDel: {
    flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14,
    backgroundColor: "#FDE8E6", borderWidth: 1, borderColor: theme.color.error + "44",
  },
  actionChipText: { fontSize: 11, fontWeight: "800", color: theme.color.brand },
  empChip: {
    paddingHorizontal: 12, height: 32, borderRadius: 16, justifyContent: "center",
    borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
  },
  empChipActive: { borderColor: theme.color.brand, backgroundColor: theme.color.brandTertiary },
  empChipText: { fontSize: 12, fontWeight: "700", color: theme.color.muted },
  empChipTextActive: { color: theme.color.brand, fontWeight: "800" },
  actionBtnDel: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#FDE8E6" },

  emptyBlock: {
    alignItems: "center", padding: theme.space.md, gap: 4,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border, borderStyle: "dashed",
    marginBottom: theme.space.sm,
  },
  emptyText: { fontSize: 12, color: theme.color.muted },
  linkText: { fontSize: 12, fontWeight: "700", color: theme.color.brand },

  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.md,
    maxHeight: "92%",
  },
  stickyFooter: {
    paddingTop: theme.space.sm,
    borderTopWidth: 1, borderTopColor: theme.color.border,
    marginTop: theme.space.sm,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.md },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
  sheetSub: { fontSize: 12, color: theme.color.muted, marginBottom: theme.space.md },
  exportBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center",
    backgroundColor: theme.color.brandTertiary, borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  exportSheet: {
    backgroundColor: theme.color.surfaceSecondary,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl,
  },
  exportOpt: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 12, paddingHorizontal: theme.space.md, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.border, marginTop: theme.space.sm, backgroundColor: theme.color.surface,
  },
  exportOptLabel: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
  exportOptSub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },

  label: { marginTop: theme.space.md, marginBottom: 4, fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase" },
  input: {
    height: 46, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surface,
  },
  denomRowInput: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  denomLabel: { flex: 1 },
  denomFace: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface },
  denomSubText: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  denomMult: { fontSize: 14, color: theme.color.muted },
  denomInput: {
    width: 70, height: 36, borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.color.border,
    textAlign: "center", fontSize: 15, fontWeight: "800", color: theme.color.onSurface, backgroundColor: theme.color.surfaceSecondary,
  },
  totalBox: {
    marginTop: theme.space.md,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceTertiary,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  totalLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "700" },
  totalValue: { fontSize: 15, fontWeight: "900", color: theme.color.onSurface },
  grandBox: {
    marginTop: theme.space.md, padding: 12, borderRadius: theme.radius.md,
    backgroundColor: theme.color.brand,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  grandLabelBox: { fontSize: 12, color: "#fff", fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  grandValueBox: { fontSize: 22, fontWeight: "900", color: "#fff" },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: {
    marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md,
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  cancelBtn: { marginTop: theme.space.md, height: 44, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.color.muted, fontWeight: "700" },

  toast: { position: "absolute", left: theme.space.lg, right: theme.space.lg, backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center" },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "700" },

  linkedBox: {
    marginTop: 6, paddingTop: 6,
    borderTopWidth: 1, borderTopColor: theme.color.border, borderStyle: "dashed",
  },
  linkedHead: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  linkedTitle: { fontSize: 10, fontWeight: "700", color: theme.color.brand, letterSpacing: 0.5 },
  linkedRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" },
  linkedChip: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    backgroundColor: theme.color.brandTertiary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  linkedChipText: { fontSize: 9, fontWeight: "800", color: theme.color.brand },
  linkedChipAmt: { fontSize: 9, fontWeight: "700", color: theme.color.onSurface, marginLeft: 2 },
  linkedMore: { fontSize: 9, color: theme.color.muted, fontWeight: "700" },

  modePill: {
    paddingHorizontal: 6, paddingVertical: 1,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  modePillText: { fontSize: 8, fontWeight: "800", letterSpacing: 0.5 },
  rcpSourceRow: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 2 },
  rcpSourceText: { fontSize: 10, color: theme.color.muted, fontStyle: "italic", flex: 1 },

  tcCard: {
    marginBottom: theme.space.lg,
    padding: theme.space.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
  },
  tcTitle: { fontSize: 11, fontWeight: "800", color: theme.color.muted, letterSpacing: 1, marginBottom: 8 },
  tcGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tcTile: {
    flex: 1, minWidth: 140,
    padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    borderWidth: 1, borderColor: theme.color.border,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  tcIconWrap: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: theme.color.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  tcTileLabel: { flex: 1, fontSize: 11, color: theme.color.muted, fontWeight: "700" },
  tcTileValue: { fontSize: 13, fontWeight: "800", color: theme.color.onSurface },
  tcHint: { marginTop: 8, fontSize: 10, color: theme.color.muted, fontStyle: "italic" },

  reconCard: {
    marginBottom: theme.space.lg, padding: theme.space.md,
    borderRadius: theme.radius.lg, borderWidth: 1,
    flexDirection: "row", alignItems: "center",
  },
  reconOk: { backgroundColor: "#ECFDF5", borderColor: "#A7F3D0" },
  reconWarn: { backgroundColor: "#FEF3C7", borderColor: "#FCD34D" },
  reconHead: { flexDirection: "row", alignItems: "center" },
  reconTitle: { fontSize: 14, fontWeight: "800" },
  reconSub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  ackPill: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: theme.color.success,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, marginRight: 6,
  },
  ackPillText: { color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  reconTable: { marginTop: 10, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: 8 },
  reconRow: { flexDirection: "row", alignItems: "center", paddingVertical: 3 },
  reconRowHead: { borderBottomWidth: 1, borderBottomColor: theme.color.border, paddingBottom: 4, marginBottom: 2 },
  reconCell: { flex: 1, fontSize: 11, color: theme.color.onSurface, textAlign: "right" },
  reconCellHead: { fontSize: 9, color: theme.color.muted, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  reconHint: { marginTop: 10, fontSize: 11, color: theme.color.muted, fontStyle: "italic", textAlign: "center" },
  ackBox: {
    marginTop: 10, padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    borderLeftWidth: 3, borderLeftColor: theme.color.success,
  },
  ackTitle: { fontSize: 11, fontWeight: "800", color: theme.color.success },
  ackNote: { fontSize: 12, color: theme.color.onSurface, marginTop: 4 },
  ackForm: { marginTop: 10 },
  ackFormLabel: { fontSize: 10, fontWeight: "800", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 },
  ackInput: {
    minHeight: 56, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 10, paddingVertical: 8, color: theme.color.onSurface, fontSize: 13,
    backgroundColor: theme.color.surface, textAlignVertical: "top",
  },
  ackBtn: {
    marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    backgroundColor: "#B45309", height: 40, borderRadius: theme.radius.md,
  },
  ackBtnText: { color: "#fff", fontWeight: "800", fontSize: 13 },

  cashBox: {
    marginTop: 6, marginBottom: 8,
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.brand + "44",
  },
  cashHead: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 8 },
  cashTitle: { fontSize: 12, fontWeight: "800", color: theme.color.brand, letterSpacing: 0.3 },
  cashGrid: { gap: 4 },
  cashRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  cashRowLabel: { fontSize: 13, fontWeight: "800", color: theme.color.onSurface },
  cashRowValue: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  cashRowSubLabel: { fontSize: 11, color: theme.color.muted },
  cashRowSubValue: { fontSize: 12, fontWeight: "700", color: theme.color.onSurfaceTertiary },
  cashRowTotal: {
    marginTop: 4, paddingTop: 6,
    borderTopWidth: 1, borderTopColor: theme.color.border, borderStyle: "dashed",
  },
  cashRowMatch: { borderTopColor: theme.color.success },
  cashRowMismatch: { borderTopColor: "#B45309" },
  cashDivider: { fontSize: 9, fontWeight: "800", color: theme.color.muted, letterSpacing: 1, marginTop: 6, textTransform: "uppercase" },
});
