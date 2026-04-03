import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Alert, Platform, Share } from "react-native";

function extFromUrl(url: string): string {
  const u = url.split("?")[0] ?? url;
  const m = u.match(/\.(jpg|jpeg|png|webp)$/i);
  return m ? `.${m[1]!.toLowerCase()}` : ".jpg";
}

/**
 * Shares a remote outfit image: downloads to cache when possible, otherwise shares the URL.
 */
export async function shareFitImage(imageUrl: string | null, title?: string | null) {
  if (!imageUrl) {
    Alert.alert("Nothing to share", "This outfit has no image yet.");
    return;
  }
  try {
    const name = `outfit-${Date.now()}${extFromUrl(imageUrl)}`;
    const base =
      FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? "";
    if (!base) throw new Error("no fs");
    const dest = `${base}${name}`;
    const { uri, status } = await FileSystem.downloadAsync(imageUrl, dest);
    if (status >= 200 && status < 300 && (await Sharing.isAvailableAsync())) {
      await Sharing.shareAsync(uri, {
        mimeType: "image/jpeg",
        dialogTitle: title ?? "Share outfit",
        UTI: "public.jpeg",
      });
      return;
    }
  } catch {
    // fall through to URL share
  }
  try {
    await Share.share(
      Platform.OS === "ios"
        ? { url: imageUrl, title: title ?? "Outfit" }
        : { message: imageUrl, title: title ?? "Outfit" },
    );
  } catch {
    Alert.alert("Share failed", "Could not open the share sheet.");
  }
}

/**
 * Opens share sheet with a local file (same flow as share; user can save to Photos from sheet).
 */
export async function downloadOrShareFitImage(imageUrl: string | null, title?: string | null) {
  await shareFitImage(imageUrl, title ?? "Save outfit");
}
