import * as ImageManipulator from 'expo-image-manipulator';

/**
 * Re-encode any camera-roll format (HEIC, PNG, etc.) to JPEG so OpenAI vision
 * accepts the payload (png | jpeg | gif | webp only — not HEIC).
 */
export async function ensureJpegUri(uri: string): Promise<string> {
  const result = await ImageManipulator.manipulateAsync(uri, [], {
    compress: 0.88,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return result.uri;
}
