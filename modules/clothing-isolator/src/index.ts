/**
 * clothing-isolator — segments a clothing photo into individual items,
 * each on a white background.
 *
 * iOS 17+: Uses VNGenerateForegroundInstanceMaskRequest to produce one
 *          white-background JPEG per detected garment/accessory (~300-600ms).
 * iOS <17 / Android: returns [] so the caller falls back to the full photo.
 */
import { requireNativeModule } from 'expo-modules-core';

interface ClothingIsolatorNativeModule {
  /** Returns one "data:image/jpeg;base64,…" string per segmented item. */
  segmentItems(base64Jpeg: string): Promise<string[]>;
}

function getNativeModule(): ClothingIsolatorNativeModule | null {
  try {
    return requireNativeModule<ClothingIsolatorNativeModule>('ClothingIsolator');
  } catch {
    return null;
  }
}

const NativeClothingIsolator = getNativeModule();

/**
 * Segment a clothing photo into individual items on white backgrounds.
 * Returns an array of data URIs — one per item. Empty array = unavailable/fallback.
 */
export async function segmentItems(base64Jpeg: string): Promise<string[]> {
  if (!NativeClothingIsolator) return [];
  try {
    return await NativeClothingIsolator.segmentItems(base64Jpeg);
  } catch {
    return [];
  }
}

export default { segmentItems };
