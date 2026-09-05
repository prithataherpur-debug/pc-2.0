import { useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Image, Alert, Platform,
  useWindowDimensions, Modal, ScrollView,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";

import { api, DaybookData, DaybookPhoto, DENOMS } from "@/src/lib/api";
import { uploadSelfie, mediaUrl } from "@/src/lib/media";
import { theme } from "@/src/lib/theme";
import SelfieCapture from "@/src/components/SelfieCapture";

const fmt = (n: number) => `₹${Math.round(n || 0).toLocaleString("en-IN")}`;

type Props = {
  date: string;
  data: DaybookData;
  canEdit: boolean;
  isAdmin: boolean;
  onChanged: (fresh: DaybookData, msg?: string) => void;
};

/**
 * Cash desk for the Daybook (admin + collector):
 *  1. Expected cash breakdown (sales / invoices / due collection / standalone receipts)
 *  2. Cash calculator — count physical notes by denomination, live total + variance, save once per day
 *  3. Photos — capture images of the cash bundle / counter for the day
 */
export default function CashDesk({ date, data, canEdit, isAdmin, onChanged }: Props) {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  return (
    <View style={[styles.wrap, wide && styles.wrapWide]}>
      <View style={[styles.col, wide && styles.colWide]}>
        <ExpectedCashCard data={data} />
        <CashCalculator date={date} data={data} canEdit={canEdit} isAdmin={isAdmin} onChanged={onChanged} />
      </View>
      <View style={[styles.col, wide && styles.colWide]}>
        <PhotosCard date={date} photos={data.photos || []} canEdit={canEdit} isAdmin={isAdmin} onChanged={onChanged} />
      </View>
    </View>
  );
}

function ExpectedCashCard({ data }: { data: DaybookData }) {
  const rows = [
    { label: "From sales (cash portion)", value: data.sales?.cash ?? 0 },
    { label: "From invoices (cash portion)", value: data.invoices?.cash ?? 0 },
    { label: "From due collections", value: data.due_collection?.cash ?? 0 },
    { label: "From money receipts (standalone)", value: data.standalone_receipts?.cash ?? 0 },
  ];
  const onlineRows = [
    { label: "From sales", value: data.sales?.online ?? 0 },
    { label: "From invoices", value: data.invoices?.online ?? 0 },
    { label: "From due collections", value: data.due_collection?.online ?? 0 },
    { label: "From money receipts (standalone)", value: data.standalone_receipts?.online ?? 0 },
  ];
  return (
    <View style={styles.card} testID="expected-cash-card">
      <View style={styles.cardHead}>
        <Ionicons name="shield-checkmark-outline" size={14} color={theme.color.brand} />
        <Text style={styles.cardTitle}>Expected cash today</Text>
      </View>
      {rows.map((r) => (
        <View key={r.label} style={styles.row}>
          <Text style={styles.rowLabel}>{r.label}</Text>
          <Text style={styles.rowValue}>{fmt(r.value)}</Text>
        </View>
      ))}
      <View style={[styles.row, styles.rowTotal]}>
        <Text style={styles.rowTotalLabel}>Expected cash</Text>
        <Text style={styles.rowTotalValue} testID="expected-cash-total">{fmt(data.expected_cash || 0)}</Text>
      </View>
      <Text style={styles.divider}>ONLINE RECEIVED</Text>
      {onlineRows.map((r) => (
        <View key={r.label} style={styles.row}>
          <Text style={styles.rowLabel}>{r.label}</Text>
          <Text style={styles.rowValue}>{fmt(r.value)}</Text>
        </View>
      ))}
      <View style={[styles.row, styles.rowTotal]}>
        <Text style={styles.rowTotalLabel}>Total online</Text>
        <Text style={[styles.rowTotalValue, { color: theme.color.brand }]}>{fmt(data.grand_total?.online || 0)}</Text>
      </View>
    </View>
  );
}

function CashCalculator({ date, data, canEdit, isAdmin, onChanged }: Props) {
  const saved = data.cash_verification;
  const [pcs, setPcs] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dirty, setDirty] = useState(false);

  // Load saved denominations when the date / saved record changes
  useEffect(() => {
    const d: Record<string, string> = {};
    DENOMS.forEach((k) => {
      const v = saved?.denominations?.[String(k)] || 0;
      d[String(k)] = v ? String(v) : "";
    });
    setPcs(d);
    setNote(saved?.note || "");
    setDirty(false);
    setErr("");
  }, [date, saved?.verified_at]);

  const total = useMemo(
    () => DENOMS.reduce((sum, k) => sum + (parseInt(pcs[String(k)] || "0", 10) || 0) * k, 0),
    [pcs],
  );
  const expected = data.expected_cash || 0;
  const variance = total - expected;
  const matched = Math.abs(variance) < 0.01;

  const setCount = (k: number, v: string) => {
    setPcs((p) => ({ ...p, [String(k)]: v.replace(/[^0-9]/g, "") }));
    setDirty(true);
  };
  const bump = (k: number, delta: number) => {
    const cur = parseInt(pcs[String(k)] || "0", 10) || 0;
    setCount(k, String(Math.max(0, cur + delta)));
  };

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const denominations: Record<string, number> = {};
      DENOMS.forEach((k) => { denominations[String(k)] = parseInt(pcs[String(k)] || "0", 10) || 0; });
      const fresh = await api.saveCashVerification({ date_key: date, denominations, note: note.trim() });
      onChanged(fresh, matched ? "Cash verified — matched ✓" : "Cash count saved");
      setDirty(false);
    } catch (e: any) {
      setErr(String(e?.message || "Save failed"));
    } finally { setBusy(false); }
  };

  const clear = () => {
    const doClear = async () => {
      try {
        await api.clearCashVerification(date);
        const fresh = await api.getDaybook(date);
        onChanged(fresh, "Verification cleared");
      } catch (e: any) { setErr(String(e?.message || "Failed")); }
    };
    if (Platform.OS === "web") { if (window.confirm("Clear the saved cash verification for this day?")) doClear(); return; }
    Alert.alert("Clear verification?", "The saved count for this day will be removed.", [
      { text: "Cancel", style: "cancel" }, { text: "Clear", style: "destructive", onPress: doClear },
    ]);
  };

  return (
    <View style={styles.card} testID="cash-calculator">
      <View style={styles.cardHead}>
        <Ionicons name="calculator-outline" size={14} color={theme.color.brand} />
        <Text style={styles.cardTitle}>Cash calculator</Text>
        {saved ? (
          <View style={styles.savedPill}>
            <Ionicons name="checkmark-circle" size={10} color={theme.color.success} />
            <Text style={styles.savedPillText}>Saved{saved.verified_by_name ? ` · ${saved.verified_by_name}` : ""}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardSub}>Enter how many notes of each value you physically have. The total is matched against expected cash.</Text>

      {DENOMS.map((k) => {
        const n = parseInt(pcs[String(k)] || "0", 10) || 0;
        return (
          <View key={k} style={styles.denRow}>
            <View style={{ width: 64 }}>
              <Text style={styles.denLabel}>₹{k}</Text>
            </View>
            <Pressable onPress={() => bump(k, -1)} disabled={!canEdit} style={[styles.stepBtn, !canEdit && styles.disabled]} hitSlop={4} testID={`den-minus-${k}`}>
              <Ionicons name="remove" size={16} color={theme.color.onSurface} />
            </Pressable>
            <TextInput
              value={pcs[String(k)] || ""}
              onChangeText={(v) => setCount(k, v)}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={theme.color.muted}
              editable={canEdit}
              style={[styles.denInput, !canEdit && styles.disabled]}
              testID={`den-input-${k}`}
            />
            <Pressable onPress={() => bump(k, +1)} disabled={!canEdit} style={[styles.stepBtn, !canEdit && styles.disabled]} hitSlop={4} testID={`den-plus-${k}`}>
              <Ionicons name="add" size={16} color={theme.color.onSurface} />
            </Pressable>
            <Text style={styles.denSubtotal}>{n ? fmt(n * k) : "—"}</Text>
          </View>
        );
      })}

      <View style={styles.totalsBox}>
        <View style={styles.row}>
          <Text style={styles.rowTotalLabel}>Counted cash</Text>
          <Text style={styles.rowTotalValue} testID="calc-total">{fmt(total)}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Expected cash</Text>
          <Text style={styles.rowValue}>{fmt(expected)}</Text>
        </View>
        <View style={[styles.row, styles.rowTotal, { borderTopColor: matched ? "#A7F3D0" : "#FCD34D" }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name={matched ? "checkmark-circle" : "alert-circle"} size={16} color={matched ? theme.color.success : "#B45309"} />
            <Text style={[styles.rowTotalLabel, { color: matched ? theme.color.success : "#B45309" }]}>
              {matched ? "Matched" : variance > 0 ? "Excess" : "Short"}
            </Text>
          </View>
          <Text style={[styles.rowTotalValue, { color: matched ? theme.color.success : "#B45309" }]} testID="calc-variance">
            {matched ? "₹0" : `${variance > 0 ? "+" : "−"}${fmt(Math.abs(variance))}`}
          </Text>
        </View>
      </View>

      {canEdit ? (
        <>
          <TextInput
            value={note}
            onChangeText={(v) => { setNote(v); setDirty(true); }}
            placeholder="Note (optional) — e.g. ₹200 short, paid from petty cash"
            placeholderTextColor={theme.color.muted}
            style={styles.noteInput}
            testID="calc-note"
          />
          {err ? <Text style={styles.err}>{err}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Pressable onPress={save} disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} testID="calc-save">
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="save-outline" size={16} color="#fff" />
                  <Text style={styles.saveBtnText}>{saved ? (dirty ? "Update verification" : "Saved") : "Save verification"}</Text>
                </>
              )}
            </Pressable>
            {saved && isAdmin ? (
              <Pressable onPress={clear} style={styles.clearBtn} testID="calc-clear">
                <Ionicons name="trash-outline" size={16} color={theme.color.error} />
              </Pressable>
            ) : null}
          </View>
        </>
      ) : (
        <Text style={styles.readOnly}>Only the admin or assigned collector can save the count.</Text>
      )}
    </View>
  );
}

function PhotosCard({ date, photos, canEdit, isAdmin, onChanged }: {
  date: string; photos: DaybookPhoto[]; canEdit: boolean; isAdmin: boolean;
  onChanged: (fresh: DaybookData, msg?: string) => void;
}) {
  const [camOpen, setCamOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [viewer, setViewer] = useState<DaybookPhoto | null>(null);
  const { width } = useWindowDimensions();
  const cols = width >= 900 ? 4 : 3;

  const onCaptured = async (uri: string) => {
    setCamOpen(false);
    setBusy(true); setErr("");
    try {
      const up = await uploadSelfie(uri);
      await api.addDaybookPhoto({ date_key: date, path: up.path });
      const fresh = await api.getDaybook(date);
      onChanged(fresh, "Photo added");
    } catch (e: any) {
      setErr(String(e?.message || "Upload failed"));
    } finally { setBusy(false); }
  };

  const remove = (p: DaybookPhoto) => {
    const doRemove = async () => {
      try {
        await api.deleteDaybookPhoto(p.id);
        const fresh = await api.getDaybook(date);
        setViewer(null);
        onChanged(fresh, "Photo removed");
      } catch (e: any) { setErr(String(e?.message || "Delete failed")); }
    };
    if (Platform.OS === "web") { if (window.confirm("Delete this photo?")) doRemove(); return; }
    Alert.alert("Delete photo?", "", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: doRemove }]);
  };

  return (
    <View style={styles.card} testID="daybook-photos">
      <View style={styles.cardHead}>
        <Ionicons name="camera-outline" size={14} color={theme.color.brand} />
        <Text style={styles.cardTitle}>Cash desk photos</Text>
        <Text style={styles.countText}>{photos.length}</Text>
      </View>
      <Text style={styles.cardSub}>Capture the counted cash bundle or counter as proof for {date}.</Text>

      <View style={styles.grid}>
        {photos.map((p) => (
          <Pressable key={p.id} onPress={() => setViewer(p)} style={[styles.thumbWrap, { width: `${100 / cols - 2}%` }]} testID={`photo-${p.id}`}>
            <Image source={{ uri: mediaUrl(p.path, p.token) }} style={styles.thumb} />
            <Text style={styles.thumbMeta} numberOfLines={1}>{(p.created_at || "").slice(11, 16)} · {p.display_name || p.user}</Text>
          </Pressable>
        ))}
        {canEdit ? (
          <Pressable onPress={() => setCamOpen(true)} disabled={busy} style={[styles.thumbWrap, styles.addTile, { width: `${100 / cols - 2}%` }]} testID="photo-capture">
            {busy ? <ActivityIndicator color={theme.color.brand} /> : (
              <>
                <Ionicons name="camera" size={22} color={theme.color.brand} />
                <Text style={styles.addTileText}>Capture</Text>
              </>
            )}
          </Pressable>
        ) : null}
      </View>
      {photos.length === 0 && !canEdit ? <Text style={styles.readOnly}>No photos for this day.</Text> : null}
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <SelfieCapture
        visible={camOpen}
        label="Cash desk photo"
        facing="back"
        maxWidth={1280}
        permissionText="We use the camera to photograph the counted cash as proof for the daybook."
        onCancel={() => setCamOpen(false)}
        onCapture={onCaptured}
      />

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable style={styles.viewerBg} onPress={() => setViewer(null)}>
          {viewer ? (
            <View style={styles.viewerBox}>
              <ScrollView maximumZoomScale={3} contentContainerStyle={{ alignItems: "center" }}>
                <Image source={{ uri: mediaUrl(viewer.path, viewer.token) }} style={styles.viewerImg} resizeMode="contain" />
              </ScrollView>
              <View style={styles.viewerBar}>
                <Text style={styles.viewerMeta}>{viewer.created_at?.replace("T", " ").slice(0, 16)} · {viewer.display_name || viewer.user}</Text>
                {isAdmin || canEdit ? (
                  <Pressable onPress={() => remove(viewer)} style={styles.viewerDel} testID="photo-delete">
                    <Ionicons name="trash-outline" size={16} color="#fff" />
                  </Pressable>
                ) : null}
                <Pressable onPress={() => setViewer(null)} style={styles.viewerDel}>
                  <Ionicons name="close" size={18} color="#fff" />
                </Pressable>
              </View>
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: theme.space.md },
  wrapWide: { flexDirection: "row", alignItems: "flex-start" },
  col: { gap: theme.space.md },
  colWide: { flex: 1 },
  card: {
    backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg,
    borderWidth: 1, borderColor: theme.color.border, padding: theme.space.md,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  cardTitle: { fontSize: 13, fontWeight: "800", color: theme.color.onSurface, flex: 1 },
  cardSub: { fontSize: 11, color: theme.color.muted, marginBottom: 10 },
  countText: { fontSize: 12, fontWeight: "800", color: theme.color.muted },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  rowLabel: { fontSize: 12, color: theme.color.muted },
  rowValue: { fontSize: 12, fontWeight: "700", color: theme.color.onSurface },
  rowTotal: { borderTopWidth: 1, borderTopColor: theme.color.border, marginTop: 4, paddingTop: 8 },
  rowTotalLabel: { fontSize: 13, fontWeight: "800", color: theme.color.onSurface },
  rowTotalValue: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface },
  divider: { fontSize: 9, fontWeight: "800", color: theme.color.muted, letterSpacing: 0.8, marginTop: 12, marginBottom: 2 },
  denRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  denLabel: { fontSize: 14, fontWeight: "800", color: theme.color.onSurface },
  stepBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
    backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border,
  },
  denInput: {
    width: 72, height: 40, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    backgroundColor: theme.color.surface, textAlign: "center", fontSize: 16, fontWeight: "800", color: theme.color.onSurface,
  },
  denSubtotal: { flex: 1, textAlign: "right", fontSize: 13, fontWeight: "700", color: theme.color.muted },
  disabled: { opacity: 0.5 },
  totalsBox: {
    marginTop: 10, padding: 10, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border,
  },
  noteInput: {
    marginTop: 10, height: 42, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: 12, backgroundColor: theme.color.surface, color: theme.color.onSurface, fontSize: 13,
  },
  saveBtn: {
    flex: 1, height: 46, borderRadius: theme.radius.md, backgroundColor: theme.color.brand,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  clearBtn: {
    width: 46, height: 46, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center",
    backgroundColor: "#FDE8E6", borderWidth: 1, borderColor: theme.color.error + "44",
  },
  readOnly: { fontSize: 11, color: theme.color.muted, marginTop: 8, fontStyle: "italic" },
  err: { color: theme.color.error, fontSize: 12, marginTop: 6 },
  savedPill: {
    flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 8, height: 20, borderRadius: 10,
    backgroundColor: "#ECFDF5", borderWidth: 1, borderColor: "#A7F3D0",
  },
  savedPillText: { fontSize: 9, fontWeight: "800", color: theme.color.success },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: "2%" as any, rowGap: 8 },
  thumbWrap: { aspectRatio: 1, borderRadius: theme.radius.md, overflow: "hidden", backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border },
  thumb: { width: "100%", height: "100%" },
  thumbMeta: {
    position: "absolute", bottom: 0, left: 0, right: 0, fontSize: 9, color: "#fff", paddingHorizontal: 4, paddingVertical: 2,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  addTile: { alignItems: "center", justifyContent: "center", borderStyle: "dashed", borderColor: theme.color.brand + "88", backgroundColor: theme.color.brandTertiary },
  addTileText: { fontSize: 11, fontWeight: "800", color: theme.color.brand, marginTop: 4 },
  viewerBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center", padding: 16 },
  viewerBox: { width: "100%", maxWidth: 900, height: "90%", justifyContent: "center" },
  viewerImg: { width: "100%", height: 600, maxHeight: "100%" as any },
  viewerBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 10 },
  viewerMeta: { flex: 1, color: "#fff", fontSize: 12 },
  viewerDel: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.15)" },
});
