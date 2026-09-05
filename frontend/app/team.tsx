import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Modal,
  TextInput, RefreshControl,
} from "react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { theme } from "@/src/lib/theme";
import { api } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

type TeamRow = {
  id: string;
  username: string;
  display_name: string;
  daily_goal: number;
  is_custom_goal: boolean;
  calls: number;
  pct: number;
  sales_count: number;
  revenue: number;
  attendance: "absent" | "active" | "done";
  check_in?: string | null;
  check_out?: string | null;
  customers_total: number;
};

const ATT_META: Record<TeamRow["attendance"], { icon: keyof typeof Ionicons.glyphMap; color: string; label: string }> = {
  absent: { icon: "close-circle", color: "#9CA3AF", label: "Absent" },
  active: { icon: "radio-button-on", color: "#10B981", label: "On duty" },
  done: { icon: "checkmark-circle", color: "#3B82F6", label: "Checked out" },
};

export default function TeamScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [defaultGoal, setDefaultGoal] = useState(50);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [edit, setEdit] = useState<TeamRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.teamStats();
      setRows(data.rows);
      setDefaultGoal(data.default_goal);
    } catch (e) { console.log(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        sales: acc.sales + r.sales_count,
        revenue: acc.revenue + r.revenue,
        onDuty: acc.onDuty + (r.attendance === "active" ? 1 : 0),
      }),
      { calls: 0, sales: 0, revenue: 0, onDuty: 0 },
    );
  }, [rows]);

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

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
    <View style={[styles.container, { paddingTop: insets.top }]} testID="team-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>Team overview</Text>
          <Text style={styles.hdrSub}>{rows.length} employees · today's snapshot</Text>
        </View>
        <Pressable
          onPress={() => setAddOpen(true)}
          style={styles.addBtn}
          testID="add-employee-btn"
        >
          <Ionicons name="person-add" size={18} color="#fff" />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.color.brand} /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.username}
          contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
          ItemSeparatorComponent={() => <View style={{ height: theme.space.sm }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={theme.color.brand}
            />
          }
          ListHeaderComponent={
            <View style={styles.summaryCard}>
              <View style={styles.summaryRow}>
                <SummaryPill label="Calls today" value={String(totals.calls)} icon="call-outline" />
                <SummaryPill label="Sales" value={String(totals.sales)} icon="cash-outline" />
              </View>
              <View style={styles.summaryRow}>
                <SummaryPill label="Revenue" value={`₹${totals.revenue.toLocaleString()}`} icon="trending-up-outline" wide />
                <SummaryPill label="On duty" value={`${totals.onDuty}/${rows.length}`} icon="people-outline" />
              </View>
            </View>
          }
          renderItem={({ item }) => {
            const att = ATT_META[item.attendance];
            const goalPct = Math.round(item.pct * 100);
            return (
              <Pressable
                onPress={() => router.push(`/team/${encodeURIComponent(item.username)}`)}
                style={styles.row}
                testID={`team-row-${item.username}`}
              >
                <View style={styles.rowTop}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {(item.display_name || item.username).slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: theme.space.md }}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name}>{item.display_name || item.username}</Text>
                      <View style={[styles.attPill, { backgroundColor: att.color + "22" }]}>
                        <Ionicons name={att.icon} size={11} color={att.color} />
                        <Text style={[styles.attText, { color: att.color }]}>{att.label}</Text>
                      </View>
                    </View>
                    <Text style={styles.sub}>@{item.username} · {item.customers_total} customers</Text>
                  </View>
                  <Pressable
                    onPress={(e) => { e.stopPropagation(); setEdit(item); }}
                    style={styles.rowEditBtn}
                    testID={`team-edit-${item.username}`}
                    hitSlop={8}
                  >
                    <Ionicons name="create-outline" size={18} color={theme.color.brand} />
                  </Pressable>
                </View>

                <View style={styles.metricsRow}>
                  <Metric
                    icon="call-outline"
                    label={`${item.calls} / ${item.daily_goal}`}
                    sub="calls"
                    accent={item.is_custom_goal ? theme.color.brand : theme.color.onSurface}
                  />
                  <View style={styles.metricSep} />
                  <Metric icon="cash-outline" label={String(item.sales_count)} sub="sales" />
                  <View style={styles.metricSep} />
                  <Metric
                    icon="trending-up-outline"
                    label={`₹${item.revenue.toLocaleString()}`}
                    sub="revenue"
                    accent={item.revenue > 0 ? theme.color.success : theme.color.onSurface}
                  />
                </View>

                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${goalPct}%`,
                        backgroundColor:
                          goalPct >= 100 ? theme.color.success : theme.color.brand,
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressCap}>
                  {goalPct}% of daily goal{item.is_custom_goal ? " · custom goal" : ""}
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      <EditEmployeeModal
        employee={edit}
        defaultGoal={defaultGoal}
        allEmployees={rows}
        onClose={() => setEdit(null)}
        onSaved={(msg, opts) => {
          setEdit(null);
          showToast(msg);
          if (opts?.selfRenamed) {
            setTimeout(() => signOut(), 1200);
          } else {
            load();
          }
        }}
        onDeleted={(msg) => { setEdit(null); showToast(msg); load(); }}
        currentUsername={user?.username}
      />

      <AddEmployeeModal
        visible={addOpen}
        defaultGoal={defaultGoal}
        onClose={() => setAddOpen(false)}
        onSaved={(msg) => { setAddOpen(false); showToast(msg); load(); }}
      />

      {toast ? (
        <View style={[styles.toast, { bottom: insets.bottom + 24 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SummaryPill({ label, value, icon, wide }: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap; wide?: boolean }) {
  return (
    <View style={[styles.pill, wide && { flex: 2 }]}>
      <View style={styles.pillIcon}>
        <Ionicons name={icon} size={16} color={theme.color.brand} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.pillLabel}>{label}</Text>
        <Text style={styles.pillValue}>{value}</Text>
      </View>
    </View>
  );
}

function Metric({ icon, label, sub, accent }: { icon: keyof typeof Ionicons.glyphMap; label: string; sub: string; accent?: string }) {
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={14} color={theme.color.muted} />
      <Text style={[styles.metricLabel, accent ? { color: accent } : null]}>{label}</Text>
      <Text style={styles.metricSub}>{sub}</Text>
    </View>
  );
}

function EditEmployeeModal({
  employee, defaultGoal, allEmployees, currentUsername, onClose, onSaved, onDeleted,
}: {
  employee: TeamRow | null;
  defaultGoal: number;
  allEmployees: TeamRow[];
  currentUsername?: string;
  onClose: () => void;
  onSaved: (msg: string, opts?: { selfRenamed?: boolean }) => void;
  onDeleted: (msg: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>("");

  useEffect(() => {
    if (employee) {
      setDisplayName(employee.display_name || "");
      setLoginId(employee.username);
      setPassword("");
      setErr("");
      setShowPw(false);
      setGoal(employee.is_custom_goal ? String(employee.daily_goal) : "");
      setConfirmDel(false);
      setReassignTo("");
    }
  }, [employee]);

  const isSelf = employee?.username && employee.username === currentUsername;
  const otherEmployees = allEmployees.filter((e) => e.username !== employee?.username);

  const save = async () => {
    if (!employee) return;
    const patch: {
      display_name?: string;
      password?: string;
      daily_goal?: number;
      reset_daily_goal?: boolean;
      new_username?: string;
    } = {};
    const trimmedName = displayName.trim();
    if (trimmedName && trimmedName !== (employee.display_name || "")) {
      patch.display_name = trimmedName;
    }
    const trimmedId = loginId.trim().toLowerCase();
    if (trimmedId && trimmedId !== employee.username) {
      if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(trimmedId)) {
        setErr("Login ID must be 3-30 chars: letters, digits, _.-");
        return;
      }
      patch.new_username = trimmedId;
    }
    if (password) {
      if (password.length < 4) {
        setErr("Password must be at least 4 characters.");
        return;
      }
      patch.password = password;
    }
    const goalStr = goal.trim();
    if (goalStr) {
      const n = parseInt(goalStr, 10);
      if (Number.isNaN(n) || n < 1 || n > 1000) {
        setErr("Goal must be a number between 1 and 1000.");
        return;
      }
      if (n !== employee.daily_goal || !employee.is_custom_goal) {
        patch.daily_goal = n;
      }
    } else if (employee.is_custom_goal) {
      patch.reset_daily_goal = true;
    }
    if (Object.keys(patch).length === 0) {
      setErr("Nothing to update. Change a field first.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.updateUser(employee.username, patch);
      const selfRenamed = Boolean(isSelf && patch.new_username);
      onSaved(
        selfRenamed
          ? "Login ID changed. Please sign in again."
          : `Updated ${trimmedName || trimmedId || employee.username}`,
        { selfRenamed },
      );
    } catch (e: any) {
      setErr(String(e?.message || "Update failed"));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!employee) return;
    const needsReassign = employee.customers_total > 0;
    if (needsReassign && !reassignTo) {
      setErr("Pick a teammate to receive this employee's customers first.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await api.deleteUser(employee.username, needsReassign ? reassignTo : undefined);
      const moved = res.customers_moved
        ? ` (${res.customers_moved} customers → ${res.reassigned_to})`
        : "";
      onDeleted(`Removed ${employee.display_name || employee.username}${moved}`);
    } catch (e: any) {
      setErr(String(e?.message || "Delete failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={!!employee} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <KeyboardAwareScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bottomOffset={24}
            contentContainerStyle={{ paddingBottom: theme.space.xl }}
          >
            <View style={styles.handle} />
            <View style={styles.sheetHeader}>
              <Ionicons name="person-circle-outline" size={22} color={theme.color.brand} />
              <Text style={styles.sheetTitle}>Edit {isSelf ? "my account" : "employee"}</Text>
            </View>
            <Text style={styles.usernameLabel}>@{employee?.username}</Text>

            <Text style={styles.label}>Display name</Text>
            <TextInput
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Full name"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="edit-display-name"
              returnKeyType="done"
            />

            <Text style={styles.label}>Login ID (username)</Text>
            <TextInput
              value={loginId}
              onChangeText={setLoginId}
              autoCapitalize="none"
              placeholder="e.g. emp1"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="edit-login-id"
              returnKeyType="done"
            />
            <Text style={styles.hint}>
              Changing this renames the login. All customers, calls, sales, attendance stay with them.
            </Text>

            <View style={styles.goalHeader}>
              <Text style={[styles.label, { marginTop: theme.space.lg }]}>Daily call goal</Text>
              {employee?.is_custom_goal ? (
                <Pressable onPress={() => setGoal("")} testID="edit-reset-goal">
                  <Text style={styles.resetLink}>Reset to default</Text>
                </Pressable>
              ) : null}
            </View>
            <TextInput
              value={goal}
              onChangeText={setGoal}
              keyboardType="number-pad"
              placeholder={`Default: ${defaultGoal}`}
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="edit-daily-goal"
              returnKeyType="done"
            />
            <Text style={styles.hint}>
              Overrides the workspace default of {defaultGoal}. Leave blank to keep default.
            </Text>

            <Text style={styles.label}>New password (optional)</Text>
            <View style={styles.pwWrap}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Leave blank to keep unchanged"
                placeholderTextColor={theme.color.muted}
                secureTextEntry={!showPw}
                style={[styles.input, { flex: 1, borderWidth: 0, height: 46 }]}
                autoCapitalize="none"
                testID="edit-password"
                returnKeyType="done"
              />
              <Pressable onPress={() => setShowPw((v) => !v)} style={styles.eye}>
                <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color={theme.color.muted} />
              </Pressable>
            </View>
            <Text style={styles.hint}>
              {isSelf
                ? "You will be signed out after changing your login ID or password."
                : "Employee will need to sign in again with the new password."}
            </Text>

            {err ? <Text style={styles.err}>{err}</Text> : null}

            <Pressable
              onPress={save}
              disabled={busy}
              style={[styles.saveBtn, busy && { opacity: 0.6 }]}
              testID="edit-save"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>Save changes</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={onClose} style={styles.cancelBtn} testID="edit-cancel">
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>

            {!isSelf ? (
              <View style={styles.dangerZone}>
                <Text style={styles.dangerTitle}>Danger zone</Text>
                {!confirmDel ? (
                  <Pressable
                    onPress={() => setConfirmDel(true)}
                    style={styles.deleteLink}
                    testID="edit-delete"
                  >
                    <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                    <Text style={styles.deleteLinkText}>Remove employee</Text>
                  </Pressable>
                ) : (
                  <View style={{ gap: theme.space.sm }}>
                    <Text style={styles.dangerCopy}>
                      This will delete the employee's login and clear their attendance.
                      {employee && employee.customers_total > 0
                        ? ` Their ${employee.customers_total} assigned customers must be moved to another employee.`
                        : ""}
                    </Text>
                    {employee && employee.customers_total > 0 ? (
                      <View>
                        <Text style={styles.label}>Move customers to</Text>
                        <View style={styles.pickerRow}>
                          {otherEmployees.length === 0 ? (
                            <Text style={styles.hint}>No other employees available.</Text>
                          ) : (
                            otherEmployees.map((e) => (
                              <Pressable
                                key={e.username}
                                onPress={() => setReassignTo(e.username)}
                                style={[
                                  styles.pickerPill,
                                  reassignTo === e.username && styles.pickerPillActive,
                                ]}
                                testID={`reassign-${e.username}`}
                              >
                                <Text
                                  style={[
                                    styles.pickerPillText,
                                    reassignTo === e.username && { color: "#fff" },
                                  ]}
                                >
                                  {e.display_name || e.username}
                                </Text>
                              </Pressable>
                            ))
                          )}
                        </View>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: "row", gap: theme.space.sm }}>
                      <Pressable
                        onPress={() => setConfirmDel(false)}
                        style={[styles.cancelBtn, { flex: 1, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md }]}
                      >
                        <Text style={styles.cancelText}>Keep</Text>
                      </Pressable>
                      <Pressable
                        onPress={doDelete}
                        disabled={busy}
                        style={[styles.deleteBtn, busy && { opacity: 0.6 }]}
                        testID="confirm-delete"
                      >
                        {busy ? <ActivityIndicator color="#fff" /> : (
                          <>
                            <Ionicons name="trash" size={16} color="#fff" />
                            <Text style={styles.deleteBtnText}>Delete</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            ) : null}
          </KeyboardAwareScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function AddEmployeeModal({
  visible, defaultGoal, onClose, onSaved,
}: {
  visible: boolean;
  defaultGoal: number;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (visible) {
      setUsername("");
      setDisplayName("");
      setPassword("");
      setShowPw(false);
      setGoal("");
      setErr("");
    }
  }, [visible]);

  const save = async () => {
    const u = username.trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(u)) {
      setErr("Login ID must be 3-30 chars: letters, digits, _.-");
      return;
    }
    if (password.length < 4) {
      setErr("Password must be at least 4 characters.");
      return;
    }
    const payload: {
      username: string; password: string; display_name?: string; daily_goal?: number;
    } = { username: u, password };
    const name = displayName.trim();
    if (name) payload.display_name = name;
    if (goal.trim()) {
      const n = parseInt(goal.trim(), 10);
      if (Number.isNaN(n) || n < 1 || n > 1000) {
        setErr("Goal must be a number between 1 and 1000.");
        return;
      }
      payload.daily_goal = n;
    }
    setBusy(true);
    setErr("");
    try {
      const created = await api.createUser(payload);
      onSaved(`Added ${created.display_name || created.username}`);
    } catch (e: any) {
      setErr(String(e?.message || "Failed to add employee"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <KeyboardAwareScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bottomOffset={24}
            contentContainerStyle={{ paddingBottom: theme.space.xl }}
          >
            <View style={styles.handle} />
            <View style={styles.sheetHeader}>
              <Ionicons name="person-add-outline" size={22} color={theme.color.brand} />
              <Text style={styles.sheetTitle}>Add new employee</Text>
            </View>
            <Text style={styles.usernameLabel}>They'll be able to sign in right away</Text>

            <Text style={styles.label}>Display name</Text>
            <TextInput
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="e.g. Priya Sharma"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="add-display-name"
              returnKeyType="done"
            />

            <Text style={styles.label}>Login ID (username)</Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              placeholder="e.g. priya"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="add-username"
              returnKeyType="done"
            />

            <Text style={styles.label}>Password</Text>
            <View style={styles.pwWrap}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Set a starter password"
                placeholderTextColor={theme.color.muted}
                secureTextEntry={!showPw}
                style={[styles.input, { flex: 1, borderWidth: 0, height: 46 }]}
                autoCapitalize="none"
                testID="add-password"
                returnKeyType="done"
              />
              <Pressable onPress={() => setShowPw((v) => !v)} style={styles.eye}>
                <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color={theme.color.muted} />
              </Pressable>
            </View>

            <Text style={styles.label}>Daily call goal (optional)</Text>
            <TextInput
              value={goal}
              onChangeText={setGoal}
              keyboardType="number-pad"
              placeholder={`Default: ${defaultGoal}`}
              placeholderTextColor={theme.color.muted}
              style={styles.input}
              testID="add-goal"
              returnKeyType="done"
            />

            {err ? <Text style={styles.err}>{err}</Text> : null}

            <Pressable
              onPress={save}
              disabled={busy}
              style={[styles.saveBtn, busy && { opacity: 0.6 }]}
              testID="add-save"
            >
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="person-add" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>Add to team</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </KeyboardAwareScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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

  summaryCard: {
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginBottom: theme.space.md,
    gap: theme.space.sm,
  },
  summaryRow: { flexDirection: "row", gap: theme.space.sm },
  pill: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.color.surface,
    padding: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.border,
  },
  pillIcon: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: theme.color.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  pillLabel: { fontSize: 11, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  pillValue: { fontSize: theme.font.scale.lg, fontWeight: "800", color: theme.color.onSurface, marginTop: 2 },

  row: {
    padding: theme.space.md, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
  },
  rowTop: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.color.brandTertiary,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: theme.color.brand, fontWeight: "800", fontSize: 16 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  name: { fontSize: theme.font.scale.lg, fontWeight: "700", color: theme.color.onSurface },
  sub: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  attPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.pill,
  },
  attText: { fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  rowEditBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.color.brandTertiary,
  },

  metricsRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: theme.space.md,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    padding: 10,
  },
  metric: { flex: 1, alignItems: "center", gap: 3 },
  metricLabel: { fontSize: 15, fontWeight: "800", color: theme.color.onSurface, marginTop: 2 },
  metricSub: { fontSize: 10, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  metricSep: { width: 1, height: 28, backgroundColor: theme.color.border },

  progressTrack: {
    height: 6, borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surfaceTertiary,
    marginTop: theme.space.md, overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: theme.radius.pill },
  progressCap: { fontSize: 11, color: theme.color.muted, marginTop: 6 },

  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.color.surfaceSecondary,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: theme.space.xl, paddingBottom: theme.space.xxl, maxHeight: "90%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.color.border, alignSelf: "center", marginBottom: theme.space.lg },
  sheetHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sheetTitle: { fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  usernameLabel: { fontSize: 13, color: theme.color.muted, marginTop: 4 },
  label: {
    marginTop: theme.space.lg, marginBottom: 4,
    fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase",
  },
  input: {
    height: 48, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surface,
  },
  pwWrap: {
    flexDirection: "row", alignItems: "center",
    borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface, paddingRight: 8,
  },
  eye: { padding: 8 },
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
  goalHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  resetLink: { color: theme.color.brand, fontWeight: "700", fontSize: 12, paddingBottom: 4 },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  saveBtn: {
    marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md,
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  cancelBtn: { marginTop: theme.space.md, height: 44, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.color.muted, fontWeight: "700" },

  dangerZone: {
    marginTop: theme.space.xxl,
    paddingTop: theme.space.md,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
  },
  dangerTitle: {
    fontSize: 11, fontWeight: "700", color: theme.color.error,
    letterSpacing: 1, textTransform: "uppercase", marginBottom: theme.space.sm,
  },
  dangerCopy: { fontSize: 13, color: theme.color.onSurface, lineHeight: 18 },
  deleteLink: {
    flexDirection: "row", alignItems: "center", gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 6,
  },
  deleteLinkText: { color: theme.color.error, fontWeight: "700", fontSize: 14 },
  deleteBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    height: 46, borderRadius: theme.radius.md, backgroundColor: theme.color.error,
  },
  deleteBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  pickerRow: {
    flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6,
  },
  pickerPill: {
    paddingHorizontal: 12, height: 34,
    borderRadius: theme.radius.pill,
    borderWidth: 1, borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    alignItems: "center", justifyContent: "center",
  },
  pickerPillActive: {
    backgroundColor: theme.color.brand,
    borderColor: theme.color.brand,
  },
  pickerPillText: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },

  toast: { position: "absolute", left: theme.space.lg, right: theme.space.lg, backgroundColor: theme.color.surfaceInverse, borderRadius: theme.radius.md, padding: theme.space.md, alignItems: "center" },
  toastText: { color: theme.color.onSurfaceInverse, fontWeight: "600" },

  deniedTitle: { marginTop: theme.space.md, fontSize: 20, fontWeight: "800", color: theme.color.onSurface },
  backBtn: { marginTop: theme.space.lg, paddingHorizontal: theme.space.xl, paddingVertical: theme.space.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brand },
  backBtnText: { color: theme.color.onBrand, fontWeight: "700" },
});
