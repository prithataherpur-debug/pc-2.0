import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";
import { TOKEN_KEY, API } from "@/src/lib/api";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;

async function bearer(): Promise<string> {
  return (await storage.secureGet(TOKEN_KEY, "")) as string;
}

/** Uploads a local URI (photo) to the backend, returns the stored path & token. */
export async function uploadSelfie(uri: string): Promise<{ path: string; token: string }> {
  const token = await bearer();
  if (!token) throw new Error("Not authenticated");

  const form = new FormData();
  const fileName = `selfie-${Date.now()}.jpg`;

  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    form.append("file", blob, fileName);
  } else {
    // Native: pass the special shape that Expo/react-native FormData understands
    form.append("file", { uri, name: fileName, type: "image/jpeg" } as any);
  }

  const res = await fetch(`${API}/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }, // do NOT set Content-Type
    body: form as any,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed ${res.status}: ${text}`);
  }
  return res.json();
}

/** Returns a URL usable by <Image> — signed with token on web, plain otherwise. */
export function mediaUrl(path?: string | null, token?: string | null): string | undefined {
  if (!path) return undefined;
  const base = `${BACKEND}/api/files/${path}`;
  if (Platform.OS === "web" && token) return `${base}?token=${token}`;
  return base;
}

/** Ask backend for a fresh short-lived media token (used for images already stored). */
export async function fetchMediaToken(path: string): Promise<string | null> {
  const jwt = await bearer();
  if (!jwt) return null;
  try {
    const res = await fetch(`${API}/files/token?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.token ?? null;
  } catch {
    return null;
  }
}
