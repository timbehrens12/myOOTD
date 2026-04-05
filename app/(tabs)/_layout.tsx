import { BlurView } from "expo-blur";
import { setLibraryIntent } from "../../lib/uploadIntent";
import { Tabs, usePathname, useRouter } from "expo-router";
import React, { useState } from "react";
import {
    DeviceEventEmitter,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { Colors, Typography } from "../../constants/AppTheme";

// ─── ICONS (unchanged paths) ─────────────────────────────────────────────────

const IconWrapper = ({
  focused,
  label,
  children,
}: {
  focused: boolean;
  label: string;
  children: React.ReactNode;
}) => (
  <View style={styles.tabItem}>
    <View style={[styles.iconWell, focused && styles.iconWellActive]}>
      {children}
    </View>
    <Text
      style={[styles.tabLabel, focused && styles.tabLabelActive]}
      numberOfLines={1}
    >
      {label}
    </Text>
  </View>
);

const ArcHome = ({ focused }: { focused: boolean }) => (
  <IconWrapper focused={focused} label="Home">
    <Svg width="22" height="22" viewBox="0 0 24 24">
      <Path
        d="M3 9L12 2L21 9V20C21 21 20 22 19 22H5C4 22 3 21 3 20V9Z"
        fill={focused ? Colors.accent : "none"}
        stroke={focused ? Colors.accent : Colors.textMuted}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  </IconWrapper>
);

const ArcCloset = ({ focused }: { focused: boolean }) => (
  <IconWrapper focused={focused} label="Closet">
    <Svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <Rect
        x="4"
        y="3"
        width="16"
        height="18"
        rx="2"
        stroke={focused ? Colors.accent : Colors.textMuted}
        strokeWidth="2.4"
      />
      <Path
        d="M12 3V21M8.5 12H9.5M14.5 12H15.5"
        stroke={focused ? Colors.accent : Colors.textMuted}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </Svg>
  </IconWrapper>
);

const ArcOutfits = ({ focused }: { focused: boolean }) => (
  <IconWrapper focused={focused} label="Fits">
    <Svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 3H18L21 6V9L18 8V19C18 20.1046 17.1046 21 16 21H8C6.89543 21 6 20.1046 6 19V8L3 9V6L6 3H9L12 5L15 3Z"
        stroke={focused ? Colors.accent : Colors.textMuted}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  </IconWrapper>
);

const ArcAccount = ({ focused }: { focused: boolean }) => (
  <IconWrapper focused={focused} label="Account">
    <Svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <Circle
        cx="12"
        cy="12"
        r="9"
        stroke={focused ? Colors.accent : Colors.textMuted}
        strokeWidth="2.5"
        fill={focused ? Colors.accent : "none"}
      />
      <Circle
        cx="12"
        cy="11"
        r="3"
        stroke={focused ? "#FFF" : Colors.textMuted}
        strokeWidth="1.5"
      />
      <Path
        d="M7 18C7 18 8.5 15 12 15C15.5 15 17 18 17 18"
        stroke={focused ? "#FFF" : Colors.textMuted}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Svg>
  </IconWrapper>
);

const PlusMenuIcon = ({ name }: { name: string }) => {
  const c = "#FFFFFF";
  if (name === "plus")
    return (
      <Svg width="22" height="22" viewBox="0 0 24 24">
        <Path
          d="M12 5v14M5 12h14"
          stroke={c}
          strokeWidth="2"
          strokeLinecap="round"
        />
      </Svg>
    );
  if (name === "camera")
    return (
      <Svg width="22" height="22" viewBox="0 0 24 24">
        <Rect
          x="2"
          y="5"
          width="20"
          height="16"
          rx="3"
          stroke={c}
          strokeWidth="2"
          fill="none"
        />
        <Circle cx="12" cy="13" r="4" stroke={c} strokeWidth="2" fill="none" />
      </Svg>
    );
  if (name === "photo")
    return (
      <Svg width="22" height="22" viewBox="0 0 24 24">
        <Rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="2"
          stroke={c}
          strokeWidth="2"
          fill="none"
        />
        <Path
          d="M3 16l5-5 5 5 2-2 6 6"
          stroke={c}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  if (name === "sparkles")
    return (
      <Svg width="22" height="22" viewBox="0 0 24 24">
        <Path
          d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"
          stroke={c}
          strokeWidth="2"
          fill="none"
        />
      </Svg>
    );
  if (name === "outfit")
    return (
      <Svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <Path
          d="M15 3H18L21 6V9L18 8V19C18 20.1046 17.1046 21 16 21H8C6.89543 21 6 20.1046 6 19V8L3 9V6L6 3H9L12 5L15 3Z"
          stroke={c}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  if (name === "clock")
    return (
      <Svg width="22" height="22" viewBox="0 0 24 24">
        <Circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2" fill="none" />
        <Path
          d="M12 7v5l3 3"
          stroke={c}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  return null;
};

function PlusButton() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBottom = Math.max(insets.bottom, 12) + 58;

  return (
    <>
      <TouchableOpacity
        style={styles.plusBtn}
        activeOpacity={0.85}
        onPress={() => setMenuOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel="Add"
      >
        <View style={styles.plusCircle}>
          <Svg width="24" height="24" viewBox="0 0 24 24">
            <Path
              d="M12 5V19M5 12H19"
              stroke="#FFF"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </Svg>
        </View>
      </TouchableOpacity>

      <Modal
        transparent
        visible={menuOpen}
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setMenuOpen(false)}
          />
          <View style={[styles.menuSheet, { bottom: menuBottom }]}>
            <View style={styles.menuHandle} />
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setTimeout(() => {
                  router.push("/add-items" as any);
                }, 100);
              }}
              activeOpacity={0.7}
            >
              <View style={styles.menuIconCircle}>
                <PlusMenuIcon name="camera" />
              </View>
              <View style={styles.menuRowTextBlock}>
                <Text style={styles.menuRowText}>Take a picture</Text>
                <Text style={styles.menuRowSub}>
                  Snap a clothing item — AI extracts and reviews before saving.
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                setMenuOpen(false);
                setLibraryIntent();
                setTimeout(() => {
                  router.push("/add-items" as any);
                  setTimeout(() => DeviceEventEmitter.emit("openLibraryPicker"), 300);
                }, 100);
              }}
              activeOpacity={0.7}
            >
              <View style={styles.menuIconCircle}>
                <PlusMenuIcon name="photo" />
              </View>
              <View style={styles.menuRowTextBlock}>
                <Text style={styles.menuRowText}>Upload from photos</Text>
                <Text style={styles.menuRowSub}>
                  Pick up to 20 photos — AI scans every item across all of them.
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuRow}
              activeOpacity={0.7}
              onPress={() => {
                setMenuOpen(false);
                router.push("/(tabs)/fits");
              }}
            >
              <View style={styles.menuIconCircle}>
                <PlusMenuIcon name="outfit" />
              </View>
              <View style={styles.menuRowTextBlock}>
                <Text style={styles.menuRowText}>Create an outfit</Text>
                <Text style={styles.menuRowSub}>
                  Build manually or auto-generate from your closet
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuRow, styles.menuRowLast]}
              activeOpacity={0.7}
              onPress={() => {
                setMenuOpen(false);
                const isHome =
                  pathname === "/" ||
                  pathname === "/index" ||
                  pathname === "/(tabs)" ||
                  pathname === "/(tabs)/index";
                if (isHome) {
                  setTimeout(
                    () => DeviceEventEmitter.emit("openAutomation"),
                    300,
                  );
                } else {
                  router.push({
                    pathname: "/",
                    params: { openAutomation: Date.now().toString() },
                  });
                }
              }}
            >
              <View style={styles.menuIconCircle}>
                <PlusMenuIcon name="clock" />
              </View>
              <View style={styles.menuRowTextBlock}>
                <Text style={styles.menuRowText}>Add automation</Text>
                <Text style={styles.menuRowSub}>
                  Auto-plan fits around your daily life
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const barPadBottom = Math.max(insets.bottom, 10);
  const tabBarHeight = 52 + barPadBottom;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarItemStyle: styles.tabBarItem,
        tabBarBackground: () => (
          <View style={StyleSheet.absoluteFill}>
            <BlurView
              intensity={90}
              tint="systemUltraThinMaterialLight"
              style={StyleSheet.absoluteFill}
            />
            {/* glass sheen overlay */}
            <View style={styles.glassOverlay} />
          </View>
        ),
        tabBarStyle: {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: tabBarHeight,
          paddingBottom: barPadBottom,
          paddingTop: 6,
          backgroundColor: "transparent",
          borderTopWidth: 0,
          elevation: 0,
          shadowColor: "transparent",
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0,
          shadowRadius: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ tabBarIcon: ({ focused }) => <ArcHome focused={focused} /> }}
      />
      <Tabs.Screen
        name="fits"
        options={{
          tabBarIcon: ({ focused }) => <ArcOutfits focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{ tabBarButton: () => <PlusButton /> }}
      />
      <Tabs.Screen
        name="closet"
        options={{
          tabBarIcon: ({ focused }) => <ArcCloset focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          tabBarIcon: ({ focused }) => <ArcAccount focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBarItem: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 0,
  },
  tabItem: {
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    minWidth: 56,
  },
  iconWell: {
    width: 44,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWellActive: {
    backgroundColor: "rgba(0,0,0,0.055)",
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: Typography.weights.semibold,
    color: "rgba(0,0,0,0.32)",
    letterSpacing: 0.2,
  },
  tabLabelActive: {
    color: "#000000",
    fontWeight: Typography.weights.bold,
  },

  plusBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 56,
    paddingVertical: 2,
  },
  plusCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },

  modalRoot: {
    flex: 1,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  menuSheet: {
    position: "absolute",
    left: 12,
    right: 12,
    backgroundColor: Colors.surface,
    borderRadius: 20,
    paddingTop: 8,
    paddingBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.06)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 16,
  },
  menuHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(0,0,0,0.12)",
    marginBottom: 8,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.06)",
  },
  menuRowLast: {
    borderBottomWidth: 0,
  },
  menuIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  glassOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  menuRowTextBlock: {
    flex: 1,
    gap: 2,
  },
  menuRowText: {
    fontSize: 16,
    fontWeight: Typography.weights.semibold,
    color: "#000000",
    letterSpacing: -0.2,
  },
  menuRowSub: {
    fontSize: 12,
    fontWeight: Typography.weights.regular,
    color: "rgba(0,0,0,0.4)",
    lineHeight: 16,
  },
  menuRowSubHint: {
    fontSize: 11,
    fontWeight: Typography.weights.regular,
    color: "rgba(0,0,0,0.32)",
    lineHeight: 15,
    marginTop: 2,
  },
});
