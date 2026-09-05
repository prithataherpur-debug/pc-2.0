import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, Platform, View, ActivityIndicator } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { registerForPush } from "@/src/lib/push";
import { AuthProvider, useAuth } from "@/src/lib/auth";
import { storage } from "@/src/utils/storage";
import { theme } from "@/src/lib/theme";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync();

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

if (Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "Default",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
  });
}

function Gate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const first = segments[0] as string | undefined;
    const inAuthGroup = first === "login";
    if (!user && !inAuthGroup) {
      router.replace("/login");
    } else if (user && inAuthGroup) {
      router.replace("/(tabs)");
    }
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surface }}>
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="settings" options={{ presentation: "card" }} />
      <Stack.Screen name="admin" options={{ presentation: "card" }} />
      <Stack.Screen name="history" options={{ presentation: "card" }} />
      <Stack.Screen name="attendance" options={{ presentation: "card" }} />
      <Stack.Screen name="sales" options={{ presentation: "card" }} />
      <Stack.Screen name="expenses" options={{ presentation: "card" }} />
      <Stack.Screen name="reports" options={{ presentation: "card" }} />
      <Stack.Screen name="feedback/[id]" options={{ presentation: "modal" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const router = useRouter();

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync();
  }, [loaded, error]);

  useEffect(() => {
    if (Platform.OS === "web") return;

    registerForPush().catch(() => {});

    const tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data || {}) as any;
      const url = data.deeplink || data.action_url;
      if (!url) return;
      url.startsWith("http") ? Linking.openURL(url) : router.push(url);
    });

    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = (response.notification.request.content.data || {}) as any;
      const url = data.deeplink || data.action_url;
      if (url) url.startsWith("http") ? Linking.openURL(url) : router.push(url);
    });

    (async () => {
      try {
        const { status, canAskAgain } = await Notifications.getPermissionsAsync();
        if (status !== "denied" || canAskAgain) return;
        const lastNudge = await storage.getItem("pushNudgeAt", "");
        const oneWeek = 7 * 24 * 60 * 60 * 1000;
        if (lastNudge && Date.now() - Number(lastNudge) <= oneWeek) return;
        await storage.setItem("pushNudgeAt", String(Date.now()));
        Linking.openSettings();
      } catch {}
    })();

    return () => {
      tapSub.remove();
    };
  }, [router]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.color.surfaceTertiary }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <AuthProvider>
            {/* On a computer browser keep the app in a centered, readable column (admin & collector use the web). */}
            <View style={Platform.OS === "web" ? webShell : { flex: 1 }}>
              <Gate />
            </View>
          </AuthProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const webShell = {
  flex: 1,
  width: "100%" as const,
  maxWidth: 1180,
  alignSelf: "center" as const,
  backgroundColor: theme.color.surface,
  // subtle side borders so the column reads as the app on very wide monitors
  borderLeftWidth: 1,
  borderRightWidth: 1,
  borderColor: theme.color.border,
};
