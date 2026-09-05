import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, Platform, Linking, Image } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";

import { theme } from "@/src/lib/theme";
import { api, AttendanceRec } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";
import { mediaUrl, fetchMediaToken } from "@/src/lib/media";

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
    />
  );
}

export default function AttendanceHistory() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [records, setRecords] = useState<AttendanceRec[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.attendanceHistory();
      setRecords(r.records || []);
    } catch (e) { console.log("att history err", e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const timeStr = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

  const openMaps = (loc?: AttendanceRec["check_in_location"]) => {
    if (!loc?.latitude || !loc?.longitude) return;
    const url = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
    if (Platform.OS === "web") { (window as any).open(url, "_blank"); }
    else Linking.openURL(url);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}><Ionicons name="chevron-back" size={22} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Attendance history</Text>
          <Text style={styles.hdrSub}>{user?.role === "admin" ? "All employees" : "Your check-ins"}</Text>
        </View>
      </View>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : records.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="calendar-outline" size={56} color={theme.color.borderStrong} />
          <Text style={styles.emptyTitle}>No records yet</Text>
        </View>
      ) : (
        <FlatList
          data={records}
          keyExtractor={(r) => `${r.date_key}-${r.user}`}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.rowTop}>
                <Text style={styles.date}>{item.date_key}</Text>
                {user?.role === "admin" ? <Text style={styles.who}>{item.display_name || item.user}</Text> : null}
              </View>
              <View style={styles.rowGrid}>
                <View style={styles.col}>
                  <Text style={styles.colLabel}>IN</Text>
                  <View style={styles.rowInline}>
                    <SelfieThumb path={item.check_in_selfie} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={styles.colVal}>{timeStr(item.check_in)}</Text>
                      <Pressable onPress={() => openMaps(item.check_in_location)}>
                        <Text style={[styles.loc, item.check_in_location && { color: theme.color.brand }]} numberOfLines={1}>
                          {item.check_in_location?.latitude != null
                            ? `${item.check_in_location.latitude.toFixed(4)}, ${item.check_in_location.longitude?.toFixed(4)}`
                            : "no location"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
                <View style={styles.col}>
                  <Text style={styles.colLabel}>OUT</Text>
                  <View style={styles.rowInline}>
                    <SelfieThumb path={item.check_out_selfie} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={styles.colVal}>{timeStr(item.check_out)}</Text>
                      <Pressable onPress={() => openMaps(item.check_out_location)}>
                        <Text style={[styles.loc, item.check_out_location && { color: theme.color.brand }]} numberOfLines={1}>
                          {item.check_out_location?.latitude != null
                            ? `${item.check_out_location.latitude.toFixed(4)}, ${item.check_out_location.longitude?.toFixed(4)}`
                            : "no location"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  hdr: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: theme.space.md, paddingVertical: theme.space.md, backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  backIcon: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  hdrTitle: { fontSize: theme.font.scale.xl, fontWeight: "800", color: theme.color.onSurface },
  hdrSub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  card: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: theme.space.lg, borderWidth: 1, borderColor: theme.color.border },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  date: { fontSize: theme.font.scale.lg, fontWeight: "800", color: theme.color.onSurface },
  who: { fontSize: theme.font.scale.sm, color: theme.color.muted, fontWeight: "600" },
  rowGrid: { flexDirection: "row", gap: theme.space.md, marginTop: theme.space.md },
  col: { flex: 1 },
  colLabel: { fontSize: 10, letterSpacing: 1, fontWeight: "700", color: theme.color.muted, textTransform: "uppercase" },
  colVal: { fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface, marginTop: 2 },
  loc: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  emptyTitle: { marginTop: theme.space.md, fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  rowInline: { flexDirection: "row", alignItems: "center", marginTop: 2 },
  thumb: { width: 44, height: 44, borderRadius: 8, backgroundColor: theme.color.surfaceTertiary },
  thumbEmpty: {
    width: 44, height: 44, borderRadius: 8, backgroundColor: theme.color.surfaceTertiary,
    alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.color.border, borderStyle: "dashed",
  },
});
