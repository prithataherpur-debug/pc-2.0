import { View, Text, StyleSheet, Pressable, ActivityIndicator, Platform, Linking } from "react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@react-native-vector-icons/ionicons";
import {
  CameraView,
  useCameraPermissions,
  type CameraView as CameraViewType,
} from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";

import { theme } from "@/src/lib/theme";

type Props = {
  visible: boolean;
  label: string;
  onCancel: () => void;
  onCapture: (uri: string) => void;
  /** "front" for selfies (default) or "back" for documents / cash desk photos */
  facing?: "front" | "back";
  /** Explanation shown on the permission card */
  permissionText?: string;
  /** Hint under the framing guide; pass "" to hide the face ring */
  hint?: string;
  /** Downscale width for the captured image (default 720) */
  maxWidth?: number;
};

export default function SelfieCapture({
  visible, label, onCancel, onCapture, facing = "front", permissionText, hint, maxWidth = 720,
}: Props) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<CameraViewType | null>(null);

  const ask = useCallback(async () => {
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain) {
      await requestPermission();
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    if (visible) ask();
  }, [visible, ask]);

  const snap = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const shot = await cameraRef.current.takePictureAsync({ quality: 0.7, skipProcessing: false });
      // Compress to keep upload snappy (~200-400 KB)
      const compressed = await ImageManipulator.manipulateAsync(
        shot.uri,
        [{ resize: { width: maxWidth } }],
        { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG },
      );
      onCapture(compressed.uri);
    } catch (e) {
      console.log("snap err", e);
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  if (!permission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
        <View style={styles.permCard}>
          <Ionicons name="camera-outline" size={40} color={theme.color.brand} />
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permText}>
            {permissionText || "To record attendance we take a quick selfie so your team knows you actually clocked in."}
          </Text>
          {permission.canAskAgain ? (
            <Pressable onPress={requestPermission} style={styles.permBtn} testID="selfie-perm-grant">
              <Text style={styles.permBtnText}>Allow camera</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => Linking.openSettings()} style={styles.permBtn} testID="selfie-perm-settings">
              <Text style={styles.permBtnText}>Open Settings</Text>
            </Pressable>
          )}
          <Pressable onPress={onCancel} style={styles.permCancel} testID="selfie-perm-cancel">
            <Text style={styles.permCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="selfie-capture">
      <CameraView
        ref={(r) => {
          cameraRef.current = r;
        }}
        facing={facing}
        style={StyleSheet.absoluteFill}
        onCameraReady={() => setReady(true)}
      />
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onCancel} style={styles.closeBtn} testID="selfie-close">
          <Ionicons name="close" size={22} color="#fff" />
        </Pressable>
        <Text style={styles.label}>{label}</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.overlay}>
        {facing === "front" ? <View style={styles.oval} /> : <View style={styles.frame} />}
        <Text style={styles.hint}>{hint ?? (facing === "front" ? "Center your face inside the ring" : "Fit the cash / counter inside the frame")}</Text>
      </View>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
        <Pressable
          onPress={snap}
          disabled={!ready || busy}
          style={[styles.shutter, (!ready || busy) && { opacity: 0.6 }]}
          testID="selfie-shutter"
        >
          {busy ? <ActivityIndicator color="#000" /> : <View style={styles.shutterInner} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", inset: 0 as any, top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "#000", zIndex: 999, elevation: 999 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  closeBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)", borderRadius: 20 },
  label: { color: "#fff", fontSize: 16, fontWeight: "700" },
  overlay: { flex: 1, alignItems: "center", justifyContent: "center" },
  oval: {
    width: 240, height: 300, borderRadius: 150, borderWidth: 3, borderColor: "rgba(255,255,255,0.85)",
  },
  hint: { marginTop: 16, color: "#fff", fontSize: 13, opacity: 0.85, fontWeight: "600" },
  frame: { width: "84%", aspectRatio: 4 / 3, borderRadius: 16, borderWidth: 3, borderColor: "rgba(255,255,255,0.85)" },
  bottomBar: { alignItems: "center", paddingTop: 20 },
  shutter: { width: 74, height: 74, borderRadius: 37, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: "rgba(255,255,255,0.5)" },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#fff", borderWidth: 2, borderColor: "#ddd" },
  permCard: {
    margin: 24, marginTop: 80, backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.lg, padding: 24, alignItems: "center",
  },
  permTitle: { marginTop: 12, fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
  permText: { marginTop: 8, color: theme.color.muted, textAlign: "center", fontSize: 14 },
  permBtn: { marginTop: 20, backgroundColor: theme.color.brand, paddingHorizontal: 24, height: 44, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  permBtnText: { color: theme.color.onBrand, fontWeight: "700", fontSize: 15 },
  permCancel: { marginTop: 12, padding: 8 },
  permCancelText: { color: theme.color.muted, fontWeight: "600" },
});
