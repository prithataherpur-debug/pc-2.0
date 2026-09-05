import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput,
} from "react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { theme } from "@/src/lib/theme";
import { api } from "@/src/lib/api";
import { useAuth } from "@/src/lib/auth";

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useAuth();

  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [loginId, setLoginId] = useState(user?.username || "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [toast, setToast] = useState("");

  if (!user) return null;

  const save = async () => {
    if (!user) return;
    const patch: {
      display_name?: string;
      password?: string;
      new_username?: string;
    } = {};
    const name = displayName.trim();
    if (name && name !== (user.display_name || "")) patch.display_name = name;
    const id = loginId.trim().toLowerCase();
    if (id && id !== user.username) {
      if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(id)) {
        setErr("Login ID must be 3-30 chars: letters, digits, _.-");
        return;
      }
      patch.new_username = id;
    }
    if (password) {
      if (password.length < 4) { setErr("Password must be at least 4 characters."); return; }
      patch.password = password;
    }
    if (Object.keys(patch).length === 0) {
      setErr("Change a field first.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.updateUser(user.username, patch);
      const needsSignOut = Boolean(patch.new_username || patch.password);
      if (needsSignOut) {
        setToast("Credentials updated — signing out…");
        setTimeout(() => signOut(), 1200);
      } else {
        setToast("Saved.");
        setTimeout(() => router.back(), 800);
      }
    } catch (e: any) {
      setErr(String(e?.message || "Update failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="account-screen">
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()} style={styles.backIcon}>
          <Ionicons name="chevron-back" size={22} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.hdrTitle}>My account</Text>
          <Text style={styles.hdrSub}>Update your login and profile</Text>
        </View>
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 100 }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <View style={styles.card}>
          <View style={styles.avatarBig}>
            <Text style={styles.avatarBigText}>
              {(user.display_name || user.username).slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.roleTag}>{user.role.toUpperCase()}</Text>
          <Text style={styles.currentName}>{user.display_name || user.username}</Text>
          <Text style={styles.currentSub}>@{user.username}</Text>
        </View>

        <Text style={styles.label}>Display name</Text>
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Full name"
          placeholderTextColor={theme.color.muted}
          style={styles.input}
          testID="account-display-name"
          returnKeyType="done"
        />

        <Text style={styles.label}>Login ID (username)</Text>
        <TextInput
          value={loginId}
          onChangeText={setLoginId}
          autoCapitalize="none"
          placeholder="e.g. myname"
          placeholderTextColor={theme.color.muted}
          style={styles.input}
          testID="account-login-id"
          returnKeyType="done"
        />
        <Text style={styles.hint}>
          Changing your ID or password will sign you out on this device so you can log back in with the new credentials.
        </Text>

        <Text style={styles.label}>New password (optional)</Text>
        <View style={styles.pwWrap}>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Leave blank to keep current"
            placeholderTextColor={theme.color.muted}
            secureTextEntry={!showPw}
            style={[styles.input, { flex: 1, borderWidth: 0, height: 46 }]}
            autoCapitalize="none"
            testID="account-password"
            returnKeyType="done"
          />
          <Pressable onPress={() => setShowPw((v) => !v)} style={styles.eye}>
            <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color={theme.color.muted} />
          </Pressable>
        </View>

        {err ? <Text style={styles.err}>{err}</Text> : null}
        {toast ? <Text style={styles.toast}>{toast}</Text> : null}

        <Pressable
          onPress={save}
          disabled={busy}
          style={[styles.saveBtn, busy && { opacity: 0.6 }]}
          testID="account-save"
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

        <Pressable onPress={signOut} style={styles.signOutBtn} testID="account-signout">
          <Ionicons name="log-out-outline" size={18} color={theme.color.error} />
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
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

  card: {
    alignItems: "center",
    padding: theme.space.xl,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.color.surfaceSecondary,
    borderWidth: 1, borderColor: theme.color.border,
    marginBottom: theme.space.lg,
  },
  avatarBig: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: theme.color.brand,
    alignItems: "center", justifyContent: "center",
  },
  avatarBigText: { color: "#fff", fontSize: 28, fontWeight: "800" },
  roleTag: {
    marginTop: theme.space.md,
    fontSize: 10, fontWeight: "800", color: theme.color.brand,
    letterSpacing: 2, textTransform: "uppercase",
  },
  currentName: { marginTop: 4, fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
  currentSub: { fontSize: 13, color: theme.color.muted, marginTop: 2 },

  label: {
    marginTop: theme.space.md, marginBottom: 4,
    fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 1, textTransform: "uppercase",
  },
  input: {
    height: 48, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
    paddingHorizontal: theme.space.md, color: theme.color.onSurface, fontSize: 15,
    backgroundColor: theme.color.surfaceSecondary,
  },
  pwWrap: {
    flexDirection: "row", alignItems: "center",
    borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSecondary, paddingRight: 8,
  },
  eye: { padding: 8 },
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
  err: { color: theme.color.error, marginTop: theme.space.md, fontSize: 13 },
  toast: { color: theme.color.success, marginTop: theme.space.md, fontSize: 13, fontWeight: "700" },
  saveBtn: {
    marginTop: theme.space.xl, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: theme.color.brand, height: 52, borderRadius: theme.radius.md,
  },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  signOutBtn: {
    marginTop: theme.space.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    height: 46, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.error + "44",
  },
  signOutText: { color: theme.color.error, fontWeight: "800", fontSize: 15 },
});
