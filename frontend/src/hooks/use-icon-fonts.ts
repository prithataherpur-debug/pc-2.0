// Icon font loader for Expo apps. The Ionicons .ttf is loaded from a CDN only
// under Expo Go (StoreClient) — that's where third-party vector-icon .ttf files
// come back as 0 bytes from Metro's asset resolver on Android. Native dev/prod
// builds (via the @react-native-vector-icons config plugin) and web pass an empty
// map, so useFonts resolves to [true, null] immediately.
// The family key MUST be "Ionicons" — the postScriptName that
// @react-native-vector-icons/ionicons renders with.
// ICON_VECTOR_VERSION must match @react-native-vector-icons/ionicons in package.json.
// Usage: const [loaded, error] = useIconFonts();

import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "13.1.3";

const cdnUrl = (): string =>
  `https://cdn.jsdelivr.net/npm/@react-native-vector-icons/ionicons@${ICON_VECTOR_VERSION}/fonts/Ionicons.ttf`;

export const useIconFonts = (): readonly [boolean, Error | null] =>
  useFonts(
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? { Ionicons: cdnUrl() }
      : {},
  );
