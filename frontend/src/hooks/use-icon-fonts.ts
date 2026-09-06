// Ionicons .ttf is loaded from a CDN only under Expo Go (StoreClient), because
// @expo/vector-icons' vendored .ttf files come back as 0 bytes from Metro's asset
// resolver on Android in Expo Go. Native dev/prod builds and web pass an empty map,
// so useFonts resolves to [true, null] immediately.
// ICON_VECTOR_VERSION must match @expo/vector-icons in package.json.
// Usage: const [loaded, error] = useIconFonts();

import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "15.1.1";

const cdnUrl = (file: string): string =>
  `https://cdn.jsdelivr.net/npm/@expo/vector-icons@${ICON_VECTOR_VERSION}/build/vendor/react-native-vector-icons/Fonts/${file}.ttf`;

export const useIconFonts = (): readonly [boolean, Error | null] =>
  useFonts(
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? { Ionicons: cdnUrl("Ionicons") }
      : {},
  );
