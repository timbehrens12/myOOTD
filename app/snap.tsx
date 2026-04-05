/**
 * Legacy route: deep links and old bookmarks. Unified add flow lives in `app/(tabs)/upload.tsx`.
 */
import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";

export default function SnapRedirect() {
  const p = useLocalSearchParams<{ categoryHint?: string }>();

  const href = useMemo(
    () =>
      ({
        pathname: "/add-items",
        params: {
          source: "camera",
          ...(typeof p.categoryHint === "string" && p.categoryHint.trim()
            ? { categoryHint: p.categoryHint.trim() }
            : {}),
        },
      }) as const,
    [p.categoryHint],
  );

  return <Redirect href={href} />;
}
