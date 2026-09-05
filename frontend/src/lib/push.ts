import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const USER_ID_KEY = "callflow_user_id";

function makeId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

async function getOrCreateUserId(): Promise<string> {
  const existing = await AsyncStorage.getItem(USER_ID_KEY);
  if (existing) return existing;
  const fresh = `dev_${makeId()}`;
  await AsyncStorage.setItem(USER_ID_KEY, fresh);
  return fresh;
}

export async function registerForPush(): Promise<void> {
  if (Platform.OS === "web") return;

  const { status, canAskAgain } = await Notifications.getPermissionsAsync();
  let finalStatus = status;
  if (finalStatus !== "granted" && canAskAgain) {
    const req = await Notifications.requestPermissionsAsync();
    finalStatus = req.status;
  }
  if (finalStatus !== "granted") return;

  let tokenResp;
  try {
    tokenResp = await Notifications.getDevicePushTokenAsync();
  } catch (e) {
    // No FCM/APNs config yet (e.g., Expo Go); silently skip.
    return;
  }
  if (!tokenResp?.data) return;

  const user_id = await getOrCreateUserId();
  try {
    await fetch(`${BASE}/api/register-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id,
        platform: Platform.OS,
        device_token: tokenResp.data,
      }),
    });
  } catch {
    // best-effort — non-blocking
  }
}

export async function triggerTestPush(): Promise<void> {
  try {
    await fetch(`${BASE}/api/push/test`, { method: "POST" });
  } catch {}
}
