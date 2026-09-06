import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from "react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { theme } from "@/src/lib/theme";
import { useAuth } from "@/src/lib/auth";

export default function Login() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (!username.trim() || !password) {
      setErr("Enter username and password.");
      return;
    }
    setBusy(true);
    try {
      await signIn(username.trim(), password);
    } catch (e: any) {
      setErr("Invalid username or password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.color.surface }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.logoWrap}>
          <Image
            source={require("../assets/images/icon.png")}
            style={styles.logoImg}
          />
          <Text style={styles.title}>Pritha Cabinet</Text>
          <Text style={styles.subtitle}>Sign in to your account</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder="Username"
            placeholderTextColor={theme.color.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            testID="login-username"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={theme.color.muted}
            secureTextEntry
            style={styles.input}
            testID="login-password"
          />

          {err ? <Text style={styles.err} testID="login-error">{err}</Text> : null}

          <Pressable
            onPress={submit}
            disabled={busy}
            style={[styles.btn, busy && { opacity: 0.6 }]}
            testID="login-submit"
          >
            {busy ? (
              <ActivityIndicator color={theme.color.onBrand} />
            ) : (
              <Text style={styles.btnText}>Sign in</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.space.xl,
    paddingBottom: 48,
    flexGrow: 1,
  },
  logoWrap: { alignItems: "center", marginBottom: theme.space.xxxl },
  logoImg: {
    width: 96,
    height: 96,
    borderRadius: 24,
    marginBottom: theme.space.md,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: theme.color.brand,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.space.md,
  },
  title: { fontSize: 28, fontWeight: "800", color: theme.color.onSurface },
  subtitle: { fontSize: 14, color: theme.color.muted, marginTop: 4 },
  form: { gap: theme.space.sm },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.color.muted,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 4,
    marginTop: theme.space.md,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    color: theme.color.onSurface,
    fontSize: 16,
  },
  err: { color: theme.color.error, marginTop: 8, fontSize: 13 },
  btn: {
    marginTop: theme.space.xl,
    height: 52,
    backgroundColor: theme.color.brand,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { color: theme.color.onBrand, fontWeight: "700", fontSize: 16 },
});
