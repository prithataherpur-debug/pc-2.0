import {
  View, Text, StyleSheet, Pressable, ScrollView, TextInput, Modal, ActivityIndicator,
  KeyboardAvoidingView, Platform, FlatList,
} from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@react-native-vector-icons/ionicons";
import * as DocumentPicker from "expo-document-picker";
import { useFocusEffect, useRouter } from "expo-router";

import { theme } from "@/src/lib/theme";
import { api, SettingsShape, PreviewRow } from "@/src/lib/api";
import { triggerTestPush } from "@/src/lib/push";
import { useAuth } from "@/src/lib/auth";

type ParsedRow = { name: string; phone: string; notes?: string };

function parseCsvOrText(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return rows;
  const firstLower = lines[0].toLowerCase();
  const hasHeader =
    firstLower.includes("name") || firstLower.includes("phone") ||
    firstLower.includes("mobile") || firstLower.includes("number");
  const startIdx = hasHeader ? 1 : 0;
  const delim = lines[0].includes(",") ? "," : lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : lines[0].includes("|") ? "|" : " ";
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(delim).map((p) => p.trim().replace(/^"|"$/g, ""));
    let name = "", phone = "", notes = "";
    if (parts.length === 1) { phone = parts[0]; name = parts[0]; }
    else { name = parts[0]; phone = parts[1]; notes = parts.slice(2).join(" "); }
    if (!phone) continue;
    rows.push({ name: name || phone, phone, notes });
  }
  return rows;
}

export default function Settings() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [settings, setSettings] = useState<SettingsShape | null>(null);
  const [goal, setGoal] = useState("50");
  const [followDays, setFollowDays] = useState("3");
  const [tplName, setTplName] = useState("hello_world");
  const [tplLang, setTplLang] = useState("en_US");
  const [busy, setBusy] = useState(false);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [importing, setImporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState("");

  // Import preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewCounts, setPreviewCounts] = useState<{ total: number; new: number; duplicates: number }>({
    total: 0,
    new: 0,
    duplicates: 0,
  });
  const [pendingRows, setPendingRows] = useState<{ name: string; phone: string; notes?: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setGoal(String(s.daily_goal));
      setFollowDays(String(s.follow_up_days));
      setTplName(s.whatsapp_template_name);
      setTplLang(s.whatsapp_language_code);
    } catch (e) { console.log(e); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const save = async () => {
    setBusy(true);
    try {
      await api.updateSettings({
        daily_goal: parseInt(goal, 10) || 50,
        follow_up_days: parseInt(followDays, 10) || 3,
        whatsapp_template_name: tplName.trim() || "hello_world",
        whatsapp_language_code: tplLang.trim() || "en_US",
      });
      showToast("Settings saved");
    } catch (e: any) {
      showToast("Save failed");
    } finally { setBusy(false); }
  };

  const importText = async (text: string) => {
    const rows = parseCsvOrText(text);
    if (rows.length === 0) { showToast("No valid rows found"); return; }
    setImporting(true);
    try {
      const preview = await api.previewBulk(rows);
      setPendingRows(rows);
      setPreviewRows(preview.rows);
      setPreviewCounts({ total: preview.total, new: preview.new, duplicates: preview.duplicates });
      setPasteOpen(false);
      setPasteText("");
      setPreviewOpen(true);
    } catch (e) { showToast("Preview failed"); }
    finally { setImporting(false); }
  };

  const commitImport = async () => {
    setImporting(true);
    try {
      const res = await api.bulkCreate(pendingRows);
      showToast(`Imported ${res.inserted}, skipped ${res.duplicates} duplicates`);
      setPreviewOpen(false);
      setPendingRows([]);
      setPreviewRows([]);
    } catch (e) { showToast("Import failed"); }
    finally { setImporting(false); }
  };

  const pickCsv = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["text/csv", "text/plain", "text/comma-separated-values", "*/*"],
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const file = res.assets?.[0];
      if (!file?.uri) return;
      const r = await fetch(file.uri);
      const text = await r.text();
      await importText(text);
    } catch { showToast("Could not read file"); }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    try { await api.clearAll(); showToast("All customers cleared"); }
    catch { showToast("Clear failed"); }
  };

  if (!isAdmin) {
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
    <View style={[styles.container, { paddingTop: insets.top }]} testID="settings-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}><Ionicons name="chevron-back" size={22} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Settings</Text>
          <Text style={styles.hdrSub}>Import list, targets & WhatsApp template</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }}>
        <Text style={styles.section}>IMPORT DATA</Text>
        <View style={styles.group}>
          <Row icon="cloud-upload-outline" label="Import CSV file" hint="Skips duplicate phone numbers; round-robins across all employees" onPress={pickCsv} testID="import-csv-button" />
          <Row icon="clipboard-outline" label="Paste list" hint="Bulk paste from Excel or Sheets" onPress={() => setPasteOpen(true)} testID="paste-list-button" />
        </View>

        <Text style={styles.section}>GOALS</Text>
        <View style={styles.group}>
          <View style={styles.fieldRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Daily call target</Text>
              <Text style={styles.rowHint}>Per employee, per day</Text>
            </View>
            <TextInput value={goal} onChangeText={setGoal} keyboardType="number-pad" style={styles.smallInput} testID="goal-input" />
          </View>
          <View style={styles.fieldRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Follow-up days</Text>
              <Text style={styles.rowHint}>After &quot;Interested&quot;, schedule follow-up in N days</Text>
            </View>
            <TextInput value={followDays} onChangeText={setFollowDays} keyboardType="number-pad" style={styles.smallInput} testID="followdays-input" />
          </View>
        </View>

        <Text style={styles.section}>WHATSAPP TEMPLATE</Text>
        <View style={styles.group}>
          <View style={styles.stackField}>
            <Text style={styles.rowLabel}>Template name</Text>
            <Text style={styles.rowHint}>Approved Meta WhatsApp template. First body variable is filled with the customer&apos;s name.</Text>
            <TextInput value={tplName} onChangeText={setTplName} autoCapitalize="none" style={styles.wideInput} testID="tplname-input" />
          </View>
          <View style={styles.stackField}>
            <Text style={styles.rowLabel}>Language code</Text>
            <Text style={styles.rowHint}>e.g. en_US, hi, en_GB</Text>
            <TextInput value={tplLang} onChangeText={setTplLang} autoCapitalize="none" style={styles.wideInput} testID="tpllang-input" />
          </View>
        </View>

        <Pressable onPress={save} style={[styles.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} testID="save-settings-btn">
          {busy ? <ActivityIndicator color={theme.color.onBrand} /> : <Text style={styles.primaryBtnText}>Save settings</Text>}
        </Pressable>

        <Text style={styles.section}>NOTIFICATIONS</Text>
        <View style={styles.group}>
          <Row icon="notifications-outline" label="Send test notification" hint="Works on real devices after build & deploy" onPress={async () => { await triggerTestPush(); showToast("Test push sent"); }} testID="test-push-button" />
        </View>

        <Text style={styles.section}>DANGER ZONE</Text>
        <View style={styles.group}>
          <Row icon="trash-outline" label="Clear all customers" hint="Delete every contact from every employee&apos;s list" danger onPress={() => setConfirmClear(true)} testID="clear-all-button" />
        </View>
      </ScrollView>

      <Modal visible={pasteOpen} animationType="slide" transparent onRequestClose={() => setPasteOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.overlay} onPress={() => setPasteOpen(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <View style={styles.handle} />
                <Text style={styles.sheetTitle}>Paste customer list</Text>
                <Text style={styles.sheetSubtitle}>One per line: Name, Phone, Notes</Text>
                <TextInput
                  value={pasteText}
                  onChangeText={setPasteText}
                  multiline
                  placeholder={"John Doe, 555-0100\nJane Smith, 555-0101, VIP"}
                  placeholderTextColor={theme.color.muted}
                  style={styles.pasteInput}
                  testID="paste-input"
                />
                <Pressable onPress={() => importText(pasteText)} style={[styles.primaryBtn, importing && { opacity: 0.6 }]} disabled={importing} testID="submit-paste">
                  {importing ? <ActivityIndicator color={theme.color.onBrand} /> : <Text style={styles.primaryBtnText}>Import</Text>}
                </Pressable>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Import preview modal */}
      <Modal visible={previewOpen} animationType="slide" transparent onRequestClose={() => setPreviewOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setPreviewOpen(false)}>
          <Pressable style={[styles.sheet, { maxHeight: "90%" }]} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Import preview</Text>
            <Text style={styles.sheetSubtitle}>
              {previewCounts.total} row{previewCounts.total === 1 ? "" : "s"} · {previewCounts.new} new · {previewCounts.duplicates} duplicate{previewCounts.duplicates === 1 ? "" : "s"}
            </Text>

            <View style={styles.previewLegend}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: theme.color.success }]} />
                <Text style={styles.legendText}>New</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: theme.color.error }]} />
                <Text style={styles.legendText}>Duplicate — will be skipped</Text>
              </View>
            </View>

            <FlatList
              data={previewRows}
              keyExtractor={(r) => String(r.index)}
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ paddingBottom: theme.space.md }}
              ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
              renderItem={({ item }) => (
                <View
                  style={[
                    styles.previewRow,
                    item.status === "duplicate" && styles.previewRowDup,
                  ]}
                  testID={`preview-row-${item.index}`}
                >
                  <View
                    style={[
                      styles.previewBadge,
                      { backgroundColor: item.status === "new" ? theme.color.success : theme.color.error },
                    ]}
                  >
                    <Ionicons
                      name={item.status === "new" ? "checkmark" : "close"}
                      size={12}
                      color="#fff"
                    />
                  </View>
                  <View style={{ flex: 1, marginLeft: theme.space.md }}>
                    <Text style={styles.previewName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.previewPhone} numberOfLines={1}>{item.phone}</Text>
                    {item.status === "duplicate" ? (
                      <Text style={styles.previewReason}>
                        {item.reason === "already_in_system"
                          ? "Phone already assigned to an employee"
                          : item.reason === "repeated_in_batch"
                          ? "Repeated within this list"
                          : "Invalid phone number"}
                      </Text>
                    ) : null}
                  </View>
                </View>
              )}
            />

            <View style={{ flexDirection: "row", gap: theme.space.sm, marginTop: theme.space.md }}>
              <Pressable
                onPress={() => setPreviewOpen(false)}
                style={[styles.previewBtn, { backgroundColor: theme.color.surfaceTertiary }]}
                testID="preview-cancel"
              >
                <Text style={{ color: theme.color.onSurface, fontWeight: "700" }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={commitImport}
                disabled={importing || previewCounts.new === 0}
                style={[
                  styles.previewBtn,
                  { backgroundColor: theme.color.brand, opacity: previewCounts.new === 0 ? 0.5 : 1 },
                ]}
                testID="preview-confirm"
              >
                {importing ? (
                  <ActivityIndicator color={theme.color.onBrand} />
                ) : (
                  <Text style={{ color: theme.color.onBrand, fontWeight: "700" }}>
                    Import {previewCounts.new} new
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={confirmClear} transparent animationType="fade" onRequestClose={() => setConfirmClear(false)}>        <Pressable style={styles.centerOverlay} onPress={() => setConfirmClear(false)}>
          <Pressable style={styles.confirmCard} onPress={() => {}}>
            <Ionicons name="warning" size={32} color={theme.color.error} />
            <Text style={styles.confirmTitle}>Clear all customers?</Text>
            <Text style={styles.confirmText}>This removes every contact. Call history is preserved.</Text>
            <View style={{ flexDirection: "row", gap: theme.space.md, marginTop: theme.space.lg }}>
              <Pressable style={[styles.confirmBtn, { backgroundColor: theme.color.surfaceTertiary }]} onPress={() => setConfirmClear(false)} testID="cancel-clear">
                <Text style={{ color: theme.color.onSurface, fontWeight: "700" }}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.confirmBtn, { backgroundColor: theme.color.error }]} onPress={clearAll} testID="confirm-clear">
                <Text style={{ color: "#fff", fontWeight: "700" }}>Delete</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Row({ icon, label, hint, onPress, danger, testID }: { icon: keyof typeof Ionicons.glyphMap; label: string; hint?: string; onPress: () => void; danger?: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.color.surfaceTertiary }]} testID={testID}>
      <View style={[styles.iconWrap, { backgroundColor: danger ? "#FDE8E6" : theme.color.brandTertiary }]}>
        <Ionicons name={icon} size={20} color={danger ? theme.color.error : theme.color.brand} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, danger && { color: theme.color.error }]}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
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
  section: { fontSize: 11, letterSpacing: 1, color: theme.color.muted, fontWeight: "700", marginBottom: theme.space.sm, marginTop: theme.space.md },
  group: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", padding: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", marginRight: theme.space.md },
  rowLabel: { fontSize: theme.font.scale.lg, fontWeight: "600", color: theme.color.onSurface },
  rowHint: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  fieldRow: { flexDirection: "row", alignItems: "center", padding: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border, gap: theme.space.md },
  smallInput: { width: 80, height: 40, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, textAlign: "center", color: theme.color.onSurface, fontSize: 16, fontWeight: "700", backgroundColor: theme.color.surface },
  stackField: { padding: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  wideInput: { height: 44, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, paddingHorizontal: theme.space.md, marginTop: theme.space.sm, color: theme.color.onSurface, fontSize: 14, backgroundColor: theme.color.surface },
  primaryBtn: { backgroundColor: theme.color.brand, borderRadius: theme.radius.md, height: 52, alignItems: "center", justifyContent: "center", marginTop: theme.space.lg },
  primaryBtnText: { color: theme.color.onBrand, fontSize: theme.font.scale.lg, fontWeight: "700" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "85%" },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  sheetTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  sheetSubtitle: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 4, marginBottom: theme.space.md },
  pasteInput: { minHeight: 160, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.space.md, color: theme.color.onSurface, backgroundColor: theme.color.surface, textAlignVertical: "top", fontSize: theme.font.scale.base, marginBottom: theme.space.md },
  centerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  confirmCard: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg, padding: theme.space.xl, width: "100%", maxWidth: 400, alignItems: "center" },
  confirmTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface, marginTop: theme.space.md },
  confirmText: { fontSize: theme.font.scale.base, color: theme.color.muted, marginTop: theme.space.sm, textAlign: "center" },
  confirmBtn: { flex: 1, height: 48, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  toast: { position: "absolute", left: theme.space.lg, right: theme.space.lg, backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center" },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "600" },
  previewLegend: { flexDirection: "row", gap: theme.space.md, marginVertical: theme.space.md },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 12, color: theme.color.muted, fontWeight: "600" },
  previewRow: {
    flexDirection: "row", alignItems: "center",
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface, borderWidth: 1, borderColor: theme.color.border,
  },
  previewRowDup: { backgroundColor: "#FDF3F2", borderColor: "#F5C6C2" },
  previewBadge: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  previewName: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
  previewPhone: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  previewReason: { fontSize: 11, color: theme.color.error, marginTop: 2, fontWeight: "600" },
  previewBtn: { flex: 1, height: 48, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  deniedTitle: { marginTop: theme.space.md, fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  backBtn: { marginTop: theme.space.lg, paddingHorizontal: theme.space.xl, paddingVertical: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brand },
  backBtnText: { color: theme.color.onBrand, fontWeight: "700" },
});
