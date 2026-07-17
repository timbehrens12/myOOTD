import { Alert } from "react-native";

import { isLowConfidenceClassification } from "./stylistGuards";

/**
 * Blocking "are you sure?" gate for saving classifier output the model itself
 * wasn't confident about ("a bird was added to my closet"). Missing confidence
 * counts as low. Resolves true to proceed with the save. Shared by every
 * interactive save path: add-items closet saves, add-items outfit-draft
 * extraction, and the fits-tab inline extraction.
 */
export function confirmLowConfidenceItems(
  items: Record<string, unknown>[],
): Promise<boolean> {
  const flagged = items.filter((it) => isLowConfidenceClassification(it));
  if (flagged.length === 0) return Promise.resolve(true);
  const names = flagged
    .slice(0, 3)
    .map((it) => String(it.name || "Unnamed item"))
    .join(", ");
  const more = flagged.length > 3 ? ` +${flagged.length - 3} more` : "";
  return new Promise((resolve) => {
    Alert.alert(
      flagged.length === 1
        ? "Double-check 1 item"
        : `Double-check ${flagged.length} items`,
      `The AI wasn't confident about: ${names}${more}. They may be misread — or not clothing at all. Tap an item in the list to review or remove it before saving.`,
      [
        { text: "Review first", style: "cancel", onPress: () => resolve(false) },
        { text: "Save anyway", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
