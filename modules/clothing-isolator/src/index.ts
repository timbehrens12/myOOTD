/**
 * clothing-isolator — JS bridge for the ClothingIsolator Expo native module.
 *
 * iOS 17+: Uses VNGenerateForegroundInstanceMaskRequest (Vision framework) to
 *          remove the background entirely on-device in ~200-400ms.
 * iOS <17 / Android: requireNativeModule throws → we catch and return null so
 *          the caller can fall back to the Gemini cloud pipeline.
 *
 * Usage:
 *   const uri = await isolateClothing(base64Jpeg);
 *   // uri is "data:image/jpeg;base64,..." on success, null on failure/unavailable
 */
import { requireNativeModule } from 'expo-modules-core';

interface ClothingIsolatorNativeModule {
  /**
   * Isolate the clothing item in a base64-encoded JPEG.
   * Returns a "data:image/jpeg;base64,…" string with the item on a white
   * background, or null if Vision could not find a foreground subject.
   */
  isolateClothing(base64Jpeg: string): Promise<string | null>;
}

function getNativeModule(): ClothingIsolatorNativeModule | null {
  try {
    return requireNativeModule<ClothingIsolatorNativeModule>('ClothingIsolator');
  } catch {
    return null;
  }
}

// Resolved once at module load time — no overhead per call.
const NativeClothingIsolator = getNativeModule();

/**
 * Remove the background from a clothing item photo using Apple Vision.
 * Requires iOS 17+ and a native build (expo prebuild + pod install).
 * Returns null on any failure so callers always have a safe fallback path.
 */
export async function isolateClothing(base64Jpeg: string): Promise<string | null> {
  if (!NativeClothingIsolator) return null;
  try {
    return await NativeClothingIsolator.isolateClothing(base64Jpeg);
  } catch {
    return null;
  }
}

export default { isolateClothing };
