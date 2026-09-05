import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

import { theme } from "@/src/lib/theme";
import { useAuth } from "@/src/lib/auth";
import { api } from "@/src/lib/api";

export default function More() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const isAdmin = user?.role === "admin";
  const [collectorUsername, setCollectorUsername] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    api.getCollector().then((r) => setCollectorUsername(r.collector?.username || null)).catch(() => {});
  }, []));

  const isCollector = user?.username && collectorUsername === user.username;
  const showCollections = isAdmin || isCollector;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="more-screen">
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{user?.display_name || user?.username}</Text>
        <Text style={styles.headerSubtitle}>
          {isAdmin ? "Administrator" : "Employee"} · @{user?.username}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.space.lg, paddingBottom: 64 }}>
        <Text style={styles.section}>WORKSPACE</Text>
        <View style={styles.group}>
          <Row icon="cash-outline" label="Sales" onPress={() => router.push("/sales")} testID="row-sales" />
          <Row icon="document-text-outline" label="Invoices" onPress={() => router.push("/invoices")} testID="row-invoices" />
          <Row icon="receipt-outline" label="Money receipts" onPress={() => router.push("/receipts")} testID="row-receipts" />
          <Row icon="book-outline" label="Daybook" onPress={() => router.push("/daybook")} testID="row-daybook" />
          <Row icon="calendar-outline" label="Attendance history" onPress={() => router.push("/attendance")} testID="row-attendance" />
          <Row icon="time-outline" label="Call history" onPress={() => router.push("/history")} testID="row-history" />
          <Row
            icon="wallet-outline"
            label={isCollector ? "Due collection (assigned to you)" : "Due collection"}
            onPress={() => router.push("/collections")}
            testID="row-collections"
          />
        </View>

        {isAdmin ? (
          <>
            <Text style={styles.section}>ADMIN</Text>
            <View style={styles.group}>
              <Row icon="settings-outline" label="Settings & import" onPress={() => router.push("/settings")} testID="row-settings" />
              <Row icon="people-outline" label="Reassign customers" onPress={() => router.push("/admin")} testID="row-admin" />
              <Row icon="person-circle-outline" label="Manage team" onPress={() => router.push("/team")} testID="row-team" />
              <Row icon="receipt-outline" label="Expenses" onPress={() => router.push("/expenses")} testID="row-expenses" />
              <Row icon="stats-chart-outline" label="Reports (Excel)" onPress={() => router.push("/reports")} testID="row-reports" />
            </View>
          </>
        ) : null}

        <Text style={styles.section}>ACCOUNT</Text>
        <View style={styles.group}>
          <Row icon="person-outline" label="My account" onPress={() => router.push("/account")} testID="row-account" />
          <Row icon="log-out-outline" label="Sign out" danger onPress={signOut} testID="row-signout" />
        </View>
      </ScrollView>
    </View>
  );
}

function Row({ icon, label, onPress, danger, testID }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; danger?: boolean; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.color.surfaceTertiary }]}
      testID={testID}
    >
      <View style={[styles.iconWrap, { backgroundColor: danger ? "#FDE8E6" : theme.color.brandTertiary }]}>
        <Ionicons name={icon} size={20} color={danger ? theme.color.error : theme.color.brand} />
      </View>
      <Text style={[styles.rowLabel, danger && { color: theme.color.error }]}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  header: {
    paddingHorizontal: theme.space.lg, paddingVertical: theme.space.md,
    backgroundColor: theme.color.surfaceSecondary, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  headerTitle: { fontSize: theme.font.scale.xxl, fontWeight: "800", color: theme.color.onSurface },
  headerSubtitle: { fontSize: theme.font.scale.sm, color: theme.color.muted, marginTop: 2 },
  section: {
    fontSize: 11, letterSpacing: 1, color: theme.color.muted, fontWeight: "700",
    marginBottom: theme.space.sm, marginTop: theme.space.md,
  },
  group: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", padding: theme.space.md, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", marginRight: theme.space.md },
  rowLabel: { flex: 1, fontSize: theme.font.scale.lg, fontWeight: "600", color: theme.color.onSurface },
});
