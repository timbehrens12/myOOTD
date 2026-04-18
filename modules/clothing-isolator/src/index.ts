/**
 * clothing-isolator — segments clothing photos into transparent PNG cutouts (iOS).
 *
 * segmentItems(base64Jpeg):
 *   iOS 17+: VNGenerateForegroundInstanceMaskRequest → one square PNG per instance
 *            (transparent background, garment cover-fitted in the frame).
 *   iOS <17 / Android: returns [] → caller falls back to full photo.
 *
 * cropGarments(maskedBase64, boxes):
 *   Crops each box + polish; PNG with alpha when source has alpha, else legacy JPEG.
 *
 * cropGarmentsWithFallback(masked, original, boxes):
 *   Prefer masked (transparent bg); if patch is mostly white, same rect from original.
 *
 * polishCutout(base64): Core Image polish on-device (iOS), no API. Writes PNG if input has alpha.
 */
import { requireNativeModule } from 'expo-modules-core';

interface ClothingIsolatorNativeModule {
  /** Returns one "data:image/png;base64,…" string per segmented instance (transparent cutout). */
  segmentItems(base64Jpeg: string): Promise<string[]>;
  /**
   * Crops individual garments from a masked (white-bg) image using classifier box_2d coords.
   * @param maskedBase64 - plain base64 of the masked image (no data: prefix)
   * @param boxes - array of [ymin, xmin, ymax, xmax] arrays in 0–1000 coords
   * @returns one "data:image/jpeg;base64,…" per box
   */
  cropGarments(maskedBase64: string, boxes: number[][]): Promise<string[]>;
  /**
   * Masked crop per box; if patch is mostly empty (white), same rect from original JPEG.
   * iOS only; Android returns [].
   */
  cropGarmentsWithFallback(
    maskedBase64: string,
    originalBase64: string,
    boxes: number[][],
  ): Promise<string[]>;
  /**
   * Runs Vision on the original image to generate a fresh full-frame mask, then crops
   * each box from mask+original in the same coordinate system. Guarantees per-item
   * background removal with no alignment drift. iOS 17+ only.
   */
  cropGarmentsFromOriginal(
    originalBase64: string,
    boxes: number[][],
  ): Promise<string[]>;
  /** Core Image sharpen + mild color; no network. iOS only. Returns `file://…` JPEG. */
  polishCutout(jpegPlainBase64: string): Promise<string>;
  /** Same polish as polishCutout but reads `file://` in native code (smaller bridge payload). */
  polishCutoutUri(fileUri: string): Promise<string>;
  /**
   * Aesty-style one-shot Enhance. Returns `{ uri, debug }`.
   * `box2d` is optional [ymin, xmin, ymax, xmax] in 0–1000 coords — when provided
   * the original is pre-cropped to that region before Vision runs, so the result is
   * just THAT garment, not the whole person (critical for fit-check photos).
   */
  enhanceItem(
    input: string,
    box2d: number[],
  ): Promise<{ uri: string; debug: Record<string, any> }>;
}

export type EnhanceItemResult = {
  uri: string | null;
  debug: Record<string, any>;
};

function getNativeModule(): ClothingIsolatorNativeModule | null {
  try {
    return requireNativeModule<ClothingIsolatorNativeModule>('ClothingIsolator');
  } catch {
    return null;
  }
}

const NativeClothingIsolator = getNativeModule();

/**
 * Segment a clothing photo into individual items as transparent PNG data URIs.
 * Returns one URI per Vision instance. Empty array = unavailable/fallback.
 */
export async function segmentItems(base64Jpeg: string): Promise<string[]> {
  if (!NativeClothingIsolator) return [];
  try {
    return await NativeClothingIsolator.segmentItems(base64Jpeg);
  } catch {
    return [];
  }
}

/**
 * Crop individual garments from a masked image using classifier box_2d coords.
 * Each crop is padded, composited on transparent (when source has alpha), polished.
 * Returns data URIs — one per box. Falls back to [] if native unavailable.
 */
export async function cropGarments(maskedBase64: string, boxes: number[][]): Promise<string[]> {
  if (!NativeClothingIsolator || boxes.length === 0) return [];
  try {
    return await NativeClothingIsolator.cropGarments(maskedBase64, boxes);
  } catch {
    return [];
  }
}

export async function cropGarmentsWithFallback(
  maskedBase64: string,
  originalBase64: string,
  boxes: number[][],
): Promise<string[]> {
  if (!NativeClothingIsolator || boxes.length === 0) return [];
  try {
    return await NativeClothingIsolator.cropGarmentsWithFallback(
      maskedBase64,
      originalBase64,
      boxes,
    );
  } catch {
    return [];
  }
}

/**
 * Preferred fit-check crop path: runs Vision fresh on the original to get a
 * perfectly aligned full-frame mask, then crops each box cleanly. Returns one
 * data URI per box. iOS 17+ only — returns [] elsewhere.
 */
export async function cropGarmentsFromOriginal(
  originalBase64: string,
  boxes: number[][],
): Promise<string[]> {
  if (!NativeClothingIsolator || boxes.length === 0) return [];
  try {
    return await NativeClothingIsolator.cropGarmentsFromOriginal(originalBase64, boxes);
  } catch {
    return [];
  }
}

export async function polishCutout(jpegPlainBase64: string): Promise<string | null> {
  if (!NativeClothingIsolator || !jpegPlainBase64?.trim()) {
    if (__DEV__) console.warn("[polishCutout] skipped: no native module or empty input");
    return null;
  }
  try {
    const uri = await NativeClothingIsolator.polishCutout(jpegPlainBase64);
    return uri?.trim() ? uri : null;
  } catch (e) {
    console.warn("[polishCutout] native failed", e);
    return null;
  }
}

/**
 * Aesty-style on-device Enhance. Returns `{ uri, debug }` — uri is null on failure.
 * The debug object contains instance count, bbox, alphaCoverage, etc. so we can see
 * what Vision did without needing the iOS device console.
 */
export async function enhanceItem(
  input: string,
  box2d?: number[] | null,
): Promise<EnhanceItemResult> {
  if (!NativeClothingIsolator || !input?.trim()) {
    return { uri: null, debug: { error: "no native module or empty input" } };
  }
  const safeBox =
    Array.isArray(box2d) && box2d.length === 4 && box2d.every((n) => Number.isFinite(n))
      ? box2d
      : [];
  try {
    const result = await NativeClothingIsolator.enhanceItem(input, safeBox);
    const uri = result?.uri?.trim() ? result.uri : null;
    return { uri, debug: result?.debug ?? {} };
  } catch (e) {
    console.warn("[enhanceItem] native failed", e);
    return { uri: null, debug: { error: String(e) } };
  }
}

export async function polishCutoutUri(fileUri: string): Promise<string | null> {
  if (!NativeClothingIsolator || !fileUri?.trim()) {
    if (__DEV__) console.warn("[polishCutoutUri] skipped: no native module or empty uri");
    return null;
  }
  try {
    const uri = await NativeClothingIsolator.polishCutoutUri(fileUri);
    return uri?.trim() ? uri : null;
  } catch (e) {
    console.warn("[polishCutoutUri] native failed", e);
    return null;
  }
}

export default {
  segmentItems,
  cropGarments,
  cropGarmentsWithFallback,
  cropGarmentsFromOriginal,
  polishCutout,
  polishCutoutUri,
  enhanceItem,
};
