import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl, Pressable, Platform, Image } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import * as Location from "expo-location";

import { theme } from "@/src/lib/theme";
import { api, StatsToday, STATUS_COLOR, STATUS_LABEL, AttendanceRec, LeaderboardRow } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import SelfieCapture from "@/src/components/SelfieCapture";
import { uploadSelfie, mediaUrl, fetchMediaToken } from "@/src/lib/media";
import PunchSaleModal from "@/src/components/PunchSaleModal";

function fmtDuration(mins: number): string {
  if (mins <= 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function computeBreakMinutes(breaks: { start: string; end: string | null }[] | null | undefined, now: number): number {
  if (!breaks?.length) return 0;
  return Math.floor(
    breaks.reduce((acc, b) => {
      const start = Date.parse(b.start);
      const end = b.end ? Date.parse(b.end) : now;
      return acc + Math.max(0, end - start);
    }, 0) / 60000,
  );
}

function currentBreakStartTs(breaks: { start: string; end: string | null }[] | null | undefined): number | null {
  if (!breaks?.length) return null;
  const last = breaks[breaks.length - 1];
  if (last.end) return null;
  return Date.parse(last.start);
}

export default function Progress() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [stats, setStats] = useState<StatsToday | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRec | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [selfieMode, setSelfieMode] = useState<null | "in" | "out">(null);
  const [saleOpen, setSaleOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a, lb] = await Promise.all([
        api.statsToday(),
        api.attendanceToday(),
        api.leaderboard().catch(() => ({ rows: [] as LeaderboardRow[] })),
      ]);
      setStats(s);
      const mine = a.records.find((r) => r.user === user?.username) || a.records[0] || null;
      setAttendance(mine);
      setLeaderboard(lb.rows || []);
    } catch (e) { console.log("progress err", e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [user?.username]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // 1s ticker while on break so timer counts up live
  useEffect(() => {
    const active = currentBreakStartTs(attendance?.breaks);
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [attendance?.breaks]);

  const getLocation = useCallback(async () => {
    if (Platform.OS === "web") return {};
    const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
    let ok = status === "granted";
    if (!ok && canAskAgain) {
      const req = await Location.requestForegroundPermissionsAsync();
      ok = req.status === "granted";
    }
    if (!ok) return {};
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy || undefined,
      };
    } catch {
      return {};
    }
  }, []);

  const onCheckIn = async () => {
    setErr("");
    setSelfieMode("in");
  };

  const onCheckOut = async () => {
    setErr("");
    setSelfieMode("out");
  };

  const onSelfieCaptured = async (uri: string) => {
    const mode = selfieMode;
    setSelfieMode(null);
    if (!mode) return;
    setBusy(true);
    try {
      const upload = await uploadSelfie(uri);
      const loc = await getLocation();
      const rec = mode === "in"
        ? await api.checkIn({ ...loc, selfie_path: upload.path })
        : await api.checkOut({ ...loc, selfie_path: upload.path });
      setAttendance(rec);
    } catch (e: any) {
      setErr(String(e?.message || `${mode === "in" ? "Check-in" : "Check-out"} failed`));
    } finally {
      setBusy(false);
    }
  };

  const onBreakStart = async () => {
    setErr(""); setBusy(true);
    try {
      const rec = await api.breakStart();
      setAttendance(rec);
    } catch (e: any) {
      setErr(String(e?.message || "Could not start break"));
    } finally { setBusy(false); }
  };

  const onBreakEnd = async () => {
    setErr(""); setBusy(true);
    try {
      const rec = await api.breakEnd();
      setAttendance(rec);
    } catch (e: any) {
      setErr(String(e?.message || "Could not end break"));
    } finally { setBusy(false); }
  };

  const activeBreakStart = currentBreakStartTs(attendance?.breaks);
  const totalBreakMin = computeBreakMinutes(attendance?.breaks, now);
  const workingMin = (() => {
    if (!attendance?.check_in) return 0;
    const start = Date.parse(attendance.check_in);
    const end = attendance.check_out ? Date.parse(attendance.check_out) : now;
    return Math.max(0, Math.floor((end - start) / 60000) - totalBreakMin);
  })();

  const pct = stats ? Math.min(1, stats.total_calls / (stats.goal || 50)) : 0;

  const timeStr = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

  const locStr = (loc?: AttendanceRec["check_in_location"]) =>
    loc?.latitude != null && loc?.longitude != null
      ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`
      : "—";

  const openMaps = (loc?: AttendanceRec["check_in_location"]) => {
    if (!loc?.latitude || !loc?.longitude) return;
    const url = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
    if (Platform.OS === "web") {
      window.open(url, "_blank");
    } else {
      import("react-native").then(({ Linking }) => Linking.openURL(url));
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="progress-screen">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Progress</Text>
        <Text style={styles.headerSubtitle}>Today&apos;s performance &amp; attendance</Text>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {/* Attendance card */}
          <View style={styles.attendanceCard}>
            <View style={styles.attHeader}>
              <Ionicons name="finger-print" size={18} color={theme.color.brand} />
              <Text style={styles.attTitle}>Attendance · {stats?.date}</Text>
            </View>
            <View style={styles.attGrid}>
              <View style={styles.attCol}>
                <Text style={styles.attLabel}>Check-in</Text>
                <View style={styles.attRowInline}>
                  <SelfieThumb path={attendance?.check_in_selfie} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={styles.attValue}>{timeStr(attendance?.check_in)}</Text>
                    <Pressable onPress={() => openMaps(attendance?.check_in_location)}>
                      <Text style={[styles.attLoc, attendance?.check_in_location && { color: theme.color.brand }]} numberOfLines={1}>
                        {locStr(attendance?.check_in_location)}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
              <View style={styles.attCol}>
                <Text style={styles.attLabel}>Check-out</Text>
                <View style={styles.attRowInline}>
                  <SelfieThumb path={attendance?.check_out_selfie} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={styles.attValue}>{timeStr(attendance?.check_out)}</Text>
                    <Pressable onPress={() => openMaps(attendance?.check_out_location)}>
                      <Text style={[styles.attLoc, attendance?.check_out_location && { color: theme.color.brand }]} numberOfLines={1}>
                        {locStr(attendance?.check_out_location)}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </View>

            {attendance?.check_in ? (
              <View style={styles.workingRow}>
                <View style={styles.workingChip}>
                  <Ionicons name="time-outline" size={12} color={theme.color.brand} />
                  <Text style={styles.workingText}>Working {fmtDuration(workingMin)}</Text>
                </View>
                {totalBreakMin > 0 || activeBreakStart ? (
                  <View style={[styles.workingChip, { backgroundColor: "#FFF6E5" }]}>
                    <Ionicons name="cafe-outline" size={12} color="#D4AC0D" />
                    <Text style={[styles.workingText, { color: "#B8860B" }]}>
                      Breaks {fmtDuration(totalBreakMin)}
                    </Text>
                  </View>
                ) : null}
                {activeBreakStart ? (
                  <View style={[styles.workingChip, { backgroundColor: "#FDE8E6" }]}>
                    <View style={styles.livePulse} />
                    <Text style={[styles.workingText, { color: theme.color.error }]} testID="break-live-timer">
                      On break {fmtDuration(Math.floor((now - activeBreakStart) / 60000))}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {err ? <Text style={styles.errText}>{err}</Text> : null}

            <View style={{ flexDirection: "row", gap: theme.space.sm, marginTop: theme.space.md }}>
              {!attendance?.check_in ? (
                <Pressable
                  onPress={onCheckIn}
                  disabled={busy}
                  style={[styles.attBtn, { backgroundColor: theme.color.brand }]}
                  testID="check-in-btn"
                >
                  {busy ? <ActivityIndicator color={theme.color.onBrand} /> : (
                    <>
                      <Ionicons name="log-in-outline" size={16} color={theme.color.onBrand} />
                      <Text style={styles.attBtnText}>Check in</Text>
                    </>
                  )}
                </Pressable>
              ) : !attendance?.check_out ? (
                <>
                  {activeBreakStart ? (
                    <Pressable
                      onPress={onBreakEnd}
                      disabled={busy}
                      style={[styles.attBtn, { backgroundColor: theme.color.warning }]}
                      testID="break-end-btn"
                    >
                      {busy ? <ActivityIndicator color="#fff" /> : (
                        <>
                          <Ionicons name="play-outline" size={16} color="#fff" />
                          <Text style={styles.attBtnText}>End break</Text>
                        </>
                      )}
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={onBreakStart}
                      disabled={busy}
                      style={[styles.attBtn, { backgroundColor: "#FFF6E5", borderWidth: 1, borderColor: "#D4AC0D" }]}
                      testID="break-start-btn"
                    >
                      {busy ? <ActivityIndicator color="#D4AC0D" /> : (
                        <>
                          <Ionicons name="cafe-outline" size={16} color="#B8860B" />
                          <Text style={[styles.attBtnText, { color: "#B8860B" }]}>Take break</Text>
                        </>
                      )}
                    </Pressable>
                  )}
                  <Pressable
                    onPress={onCheckOut}
                    disabled={busy || !!activeBreakStart}
                    style={[styles.attBtn, { backgroundColor: theme.color.info, opacity: activeBreakStart ? 0.5 : 1 }]}
                    testID="check-out-btn"
                  >
                    {busy ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="log-out-outline" size={16} color="#fff" />
                        <Text style={styles.attBtnText}>Check out</Text>
                      </>
                    )}
                  </Pressable>
                </>
              ) : (
                <View style={[styles.attBtn, { backgroundColor: theme.color.success }]}>
                  <Ionicons name="checkmark-circle" size={16} color="#fff" />
                  <Text style={styles.attBtnText}>Day complete</Text>
                </View>
              )}
              <Pressable
                onPress={() => router.push("/attendance")}
                style={[styles.attBtn, { backgroundColor: theme.color.surfaceTertiary, flex: 0.6 }]}
                testID="attendance-history-btn"
              >
                <Ionicons name="calendar-outline" size={16} color={theme.color.onSurface} />
                <Text style={[styles.attBtnText, { color: theme.color.onSurface }]}>Log</Text>
              </Pressable>
            </View>
          </View>

          {/* Daily goal big card */}
          <View style={styles.bigCard}>
            <Text style={styles.bigLabel}>Daily goal</Text>
            <Text style={styles.bigValue} testID="progress-total">
              {stats?.total_calls ?? 0}
              <Text style={styles.bigDenom}> / {stats?.goal ?? 50}</Text>
            </Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${pct * 100}%` }]} />
            </View>
            <Text style={styles.pctText}>{Math.round(pct * 100)}% complete</Text>
          </View>

          <View style={styles.grid}>
            {["interested", "not_interested", "callback", "no_answer", "done", "pending"].map((k) => (
              <MetricTile
                key={k}
                label={STATUS_LABEL[k] || k}
                value={stats?.breakdown?.[k] ?? 0}
                color={STATUS_COLOR[k] || theme.color.muted}
              />
            ))}
          </View>

          <View style={styles.summaryCard}>
            <Ionicons name="people" size={22} color={theme.color.brand} />
            <View style={{ marginLeft: theme.space.md }}>
              <Text style={styles.summaryValue}>{stats?.pending_customers ?? 0}</Text>
              <Text style={styles.summaryLabel}>Pending customers · {stats?.total_customers ?? 0} total</Text>
            </View>
          </View>

          {/* Leaderboard */}
          {leaderboard.length > 0 ? (
            <View style={styles.lbCard} testID="leaderboard">
              <View style={styles.lbHeader}>
                <Ionicons name="trophy" size={18} color="#D4AC0D" />
                <Text style={styles.lbTitle}>Today&apos;s leaderboard</Text>
                <Pressable
                  onPress={() => setSaleOpen(true)}
                  style={styles.punchPill}
                  testID="punch-sale-pill"
                >
                  <Ionicons name="cash-outline" size={12} color="#fff" />
                  <Text style={styles.punchPillText}>Punch a sale</Text>
                </Pressable>
              </View>
              {leaderboard.map((row, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : null;
                const barPct = Math.min(1, row.pct);
                return (
                  <View
                    key={row.username}
                    style={[styles.lbRow, row.is_me && styles.lbRowMe]}
                    testID={`leaderboard-row-${row.username}`}
                  >
                    <View style={styles.lbRank}>
                      {medal ? <Text style={styles.lbMedal}>{medal}</Text> : <Text style={styles.lbRankNum}>{row.rank}</Text>}
                    </View>
                    <View style={{ flex: 1, marginLeft: theme.space.sm }}>
                      <View style={styles.lbNameRow}>
                        <Text style={[styles.lbName, row.is_me && { color: theme.color.brand }]} numberOfLines={1}>
                          {row.display_name}{row.is_me ? " (you)" : ""}
                        </Text>
                        <Text style={styles.lbCount}>
                          {row.total}<Text style={styles.lbGoal}>/{row.goal}</Text>
                        </Text>
                      </View>
                      <View style={styles.lbTrack}>
                        <View
                          style={[
                            styles.lbFill,
                            { width: `${barPct * 100}%`, backgroundColor: i === 0 ? "#D4AC0D" : theme.color.brand },
                          ]}
                        />
                      </View>
                      {row.interested > 0 || row.sales_count > 0 ? (
                        <Text style={styles.lbSub}>
                          {row.sales_count > 0 ? `💰 ${row.sales_count} sale${row.sales_count > 1 ? "s" : ""} · ₹${Math.round(row.revenue).toLocaleString("en-IN")}` : ""}
                          {row.sales_count > 0 && row.interested > 0 ? "  ·  " : ""}
                          {row.interested > 0 ? `${row.interested} interested` : ""}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
        </ScrollView>
      )}

      <SelfieCapture
        visible={selfieMode !== null}
        label={selfieMode === "in" ? "Check-in selfie" : "Check-out selfie"}
        onCancel={() => setSelfieMode(null)}
        onCapture={onSelfieCaptured}
      />

      <PunchSaleModal
        visible={saleOpen}
        onClose={() => setSaleOpen(false)}
        onSaved={() => { setSaleOpen(false); load(); }}
      />
    </View>
  );
}

function MetricTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.tile, { borderLeftColor: color, borderLeftWidth: 4 }]}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

function SelfieThumb({ path }: { path?: string | null }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    if (!path) { setToken(null); return; }
    fetchMediaToken(path).then((t) => { if (!cancel) setToken(t); });
    return () => { cancel = true; };
  }, [path]);
  if (!path) {
    return (
      <View style={styles.thumbEmpty}>
        <Ionicons name="camera-outline" size={16} color={theme.color.muted} />
      </View>
    );
  }
  const uri = mediaUrl(path, token);
  if (!uri) return <View style={styles.thumbEmpty} />;
  return (
    <Image
      source={{ uri, headers: Platform.OS === "web" ? undefined : token ? { Authorization: `Bearer ${token}` } as any : undefined }}
      style={styles.thumb}
      testID="selfie-thumb"
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  headerTitle: { fontSize: theme.font.scale.xxl, fontWeight: "800", color: theme.color.onSurface },
  headerSubtitle: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  attendanceCard: {
    backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg, padding: theme.space.lg,
    borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.space.lg,
  },
  attHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  attTitle: { fontSize: theme.font.scale.lg, fontWeight: "800", color: theme.color.onSurface },
  attGrid: { flexDirection: "row", gap: theme.space.md, marginTop: theme.space.md },
  attCol: { flex: 1 },
  attLabel: { fontSize: 11, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: "700" },
  attValue: { fontSize: 22, fontWeight: "800", color: theme.color.onSurface, marginTop: 4 },
  attLoc: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  attBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    height: 44, borderRadius: theme.radius.md,
  },
  attBtnText: { color: "#fff", fontWeight: "700" },
  bigCard: { backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.lg, padding: theme.space.xl },
  bigLabel: { color: theme.color.borderStrong, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: "700" },
  bigValue: { color: theme.color.onSurfaceInverse, fontSize: 44, fontWeight: "800", letterSpacing: -1, marginTop: theme.space.sm },
  bigDenom: { fontSize: 20, color: theme.color.borderStrong, fontWeight: "600" },
  track: { height: 10, borderRadius: theme.radius.pill, backgroundColor: "rgba(255,255,255,0.15)", marginTop: theme.space.md, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: theme.color.brand },
  pctText: { color: theme.color.borderStrong, marginTop: theme.space.sm, fontSize: theme.font.scale.sm, fontWeight: "600" },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: theme.space.lg, gap: theme.space.md },
  tile: {
    flexGrow: 1, flexBasis: "45%", backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md, padding: theme.space.lg, borderWidth: 1, borderColor: theme.color.border,
  },
  tileValue: { fontSize: 30, fontWeight: "800", color: theme.color.onSurface, letterSpacing: -0.5 },
  tileLabel: { marginTop: 4, color: theme.color.muted, fontSize: theme.font.scale.sm, fontWeight: "600" },
  summaryCard: {
    flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary,
    padding: theme.space.lg, borderRadius: theme.radius.md, marginTop: theme.space.lg,
    borderWidth: 1, borderColor: theme.color.border,
  },
  summaryValue: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  summaryLabel: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  errText: { color: theme.color.error, fontSize: 13, marginTop: 8 },
  workingRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginTop: theme.space.md },
  workingChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: theme.color.brandTertiary, paddingHorizontal: 10, paddingVertical: 5, borderRadius: theme.radius.pill,
  },
  workingText: { fontSize: 11, fontWeight: "700", color: theme.color.brand, textTransform: "uppercase", letterSpacing: 0.5 },
  livePulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.error },
  lbCard: {
    marginTop: theme.space.lg,
    backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.border,
    padding: theme.space.lg,
  },
  lbHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: theme.space.md },
  lbTitle: { fontSize: theme.font.scale.lg, fontWeight: "800", color: theme.color.onSurface },
  lbRow: { flexDirection: "row", alignItems: "center", paddingVertical: theme.space.sm },
  lbRowMe: {
    backgroundColor: theme.color.brandTertiary + "80",
    marginHorizontal: -theme.space.md,
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.md,
  },
  lbRank: { width: 32, alignItems: "center" },
  lbMedal: { fontSize: 22 },
  lbRankNum: { fontSize: 14, fontWeight: "800", color: theme.color.muted },
  lbNameRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  lbName: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
  lbCount: { fontSize: 16, fontWeight: "800", color: theme.color.onSurface, marginLeft: 8 },
  lbGoal: { fontSize: 12, color: theme.color.muted, fontWeight: "600" },
  lbTrack: { height: 6, backgroundColor: theme.color.surfaceTertiary, borderRadius: 3, marginTop: 4, overflow: "hidden" },
  lbFill: { height: "100%", borderRadius: 3 },
  lbSub: { fontSize: 11, color: theme.color.muted, marginTop: 2, fontWeight: "600" },
  attRowInline: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  thumb: { width: 44, height: 44, borderRadius: 8, backgroundColor: theme.color.surfaceTertiary },
  thumbEmpty: {
    width: 44, height: 44, borderRadius: 8,
    backgroundColor: theme.color.surfaceTertiary,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: theme.color.border, borderStyle: "dashed",
  },
  punchPill: {
    marginLeft: "auto",
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: theme.color.success, paddingHorizontal: 10, height: 26, borderRadius: theme.radius.pill,
  },
  punchPillText: { color: "#fff", fontWeight: "800", fontSize: 11, letterSpacing: 0.2 },
});
