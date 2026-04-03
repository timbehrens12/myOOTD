import { useState, useEffect } from 'react';
import { useUser, useAuth } from '@clerk/clerk-expo';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Colors, Radii, Styles, Typography } from '../../constants/AppTheme';
import Svg, { Path, Circle, Rect, Line, Polyline } from 'react-native-svg';
import { supabase } from '../../lib/supabase';

// ── Icons ─────────────────────────────────────────────────────────────────────

const IconUser = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <Circle cx="12" cy="7" r="4" />
  </Svg>
);

const IconBell = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </Svg>
);

const IconHeart = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </Svg>
);

const IconCreditCard = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
    <Line x1="1" y1="10" x2="23" y2="10" />
  </Svg>
);

const IconShield = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Svg>
);

const IconSettingsIcon = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="3" />
    <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
);

const IconHelpCircle = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="10" />
    <Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <Line x1="12" y1="17" x2="12.01" y2="17" />
  </Svg>
);

const IconFileText = ({ color }: { color: string }) => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <Polyline points="14 2 14 8 20 8" />
    <Line x1="16" y1="13" x2="8" y2="13" />
    <Line x1="16" y1="17" x2="8" y2="17" />
  </Svg>
);

const IconChevron = ({ color }: { color: string }) => (
  <Svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M9 18l6-6-6-6" />
  </Svg>
);

// ── Types ─────────────────────────────────────────────────────────────────────

type IconComponent = ({ color }: { color: string }) => JSX.Element;

interface MenuItem {
  label: string;
  sub: string;
  icon: IconComponent;
}

interface MenuGroup {
  heading: string;
  items: MenuItem[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AccountScreen() {
  const { user } = useUser();
  const { signOut } = useAuth();
  const [counts, setCounts] = useState({ items: 0, outfits: 0 });
  const [bodyPhotoUrl, setBodyPhotoUrl] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  useEffect(() => {
    if (!user) return;
    async function fetchStats() {
      const [{ count: items }, { count: outfits }] = await Promise.all([
        supabase.from('clothing_items').select('*', { count: 'exact', head: true }).eq('user_id', user!.id),
        supabase.from('outfits').select('*', { count: 'exact', head: true }).eq('user_id', user!.id),
      ]);
      setCounts({ items: items || 0, outfits: outfits || 0 });
    }
    fetchStats();
  }, [user?.id]);

  // Load body photo
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('body_photo_url')
          .eq('user_id', user.id)
          .single();
        if (data?.body_photo_url) {
          setBodyPhotoUrl(data.body_photo_url);
        }
      } catch (_) {
        // Profile might not exist yet
      }
    })();
  }, [user?.id]);

  // Upload body photo
  const handleUploadBodyPhoto = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [9, 16],
        quality: 0.8,
      });

      if (result.canceled) return;

      const image = result.assets[0];
      setUploadingPhoto(true);

      const response = await fetch(image.uri);
      const blob = await response.blob();

      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });

      const fileName = `body_${user!.id}_${Date.now()}.jpg`;

      const { error: storageError } = await supabase.storage
        .from('body-photos')
        .upload(fileName, arrayBuffer, { contentType: 'image/jpeg', upsert: true });

      if (storageError) throw storageError;

      const { data: { publicUrl } } = supabase.storage
        .from('body-photos')
        .getPublicUrl(fileName);

      // Save/update in profiles table
      await supabase.from('profiles').upsert(
        { user_id: user!.id, body_photo_url: publicUrl, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );

      setBodyPhotoUrl(publicUrl);
      Alert.alert('Success', 'Body photo uploaded!');
    } catch (error) {
      console.error('Failed to upload body photo:', error);
      Alert.alert('Error', 'Failed to upload photo. Please try again.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleClearBodyPhoto = async () => {
    try {
      await supabase.from('profiles').update({ body_photo_url: null }).eq('user_id', user!.id);
      setBodyPhotoUrl(null);
      Alert.alert('Removed', 'Body photo cleared');
    } catch (error) {
      Alert.alert('Error', 'Failed to remove photo');
    }
  };

  const displayName =
    user?.fullName ||
    (user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : null) ||
    user?.firstName ||
    user?.primaryEmailAddress?.emailAddress.split('@')[0] ||
    'Member';

  const handle =
    user?.username ||
    user?.primaryEmailAddress?.emailAddress.split('@')[0] ||
    'member';

  const styleScore =
    counts.outfits > 0
      ? `${Math.min(99, 60 + counts.outfits * 3 + counts.items)}%`
      : '—';

  const MENU_GROUPS: MenuGroup[] = [
    {
      heading: 'Preferences',
      items: [
        { label: 'Profile Settings', sub: 'Bio, measurements, style pref', icon: IconUser },
        { label: 'Notifications', sub: 'Daily recs, weather alerts', icon: IconBell },
        { label: 'Saved myOOTDs', sub: 'Your favorite OOTDs', icon: IconHeart },
      ],
    },
    {
      heading: 'Account',
      items: [
        { label: 'Subscription', sub: 'Manage your plan', icon: IconCreditCard },
        { label: 'Privacy & Security', sub: 'FaceID, data export', icon: IconShield },
        { label: 'App Settings', sub: 'Theme, language, cache', icon: IconSettingsIcon },
      ],
    },
    {
      heading: 'Support',
      items: [
        { label: 'Help & FAQ', sub: 'Get answers fast', icon: IconHelpCircle },
        { label: 'Terms & Privacy', sub: 'Legal docs', icon: IconFileText },
      ],
    },
  ];

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatarWrapper}>
            <Image
              source={{ uri: user?.imageUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&q=80' }}
              style={styles.avatar}
            />
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.handle} numberOfLines={1}>@{handle}</Text>
          </View>
        </View>

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statVal}>{counts.items}</Text>
            <Text style={styles.statLabel}>Items</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statVal}>{counts.outfits}</Text>
            <Text style={styles.statLabel}>Outfits</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statVal}>{styleScore}</Text>
            <Text style={styles.statLabel}>Style Score</Text>
          </View>
        </View>

        {/* Body Photo Section */}
        <View style={styles.bodyPhotoSection}>
          <Text style={styles.groupHeading}>BODY PHOTO</Text>
          <View style={styles.bodyPhotoContainer}>
            {bodyPhotoUrl ? (
              <>
                <Image source={{ uri: bodyPhotoUrl }} style={styles.bodyPhoto} />
                <View style={styles.bodyPhotoOverlay}>
                  <TouchableOpacity
                    style={styles.bodyPhotoBtn}
                    onPress={handleUploadBodyPhoto}
                    disabled={uploadingPhoto}
                  >
                    {uploadingPhoto ? (
                      <ActivityIndicator color="#FFF" size="small" />
                    ) : (
                      <Text style={styles.bodyPhotoBtnText}>Change</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.bodyPhotoBtn, styles.bodyPhotoBtnDanger]}
                    onPress={handleClearBodyPhoto}
                    disabled={uploadingPhoto}
                  >
                    <Text style={styles.bodyPhotoBtnText}>Remove</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <TouchableOpacity
                style={styles.bodyPhotoEmpty}
                onPress={handleUploadBodyPhoto}
                disabled={uploadingPhoto}
              >
                {uploadingPhoto ? (
                  <ActivityIndicator color="rgba(0,0,0,0.4)" size="small" />
                ) : (
                  <>
                    <Text style={styles.bodyPhotoEmptyIcon}>+</Text>
                    <Text style={styles.bodyPhotoEmptyText}>Add Your Photo</Text>
                    <Text style={styles.bodyPhotoEmptySubtext}>For better virtual try-ons</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Menu Groups */}
        {MENU_GROUPS.map((group) => (
          <View key={group.heading} style={styles.menuGroup}>
            <Text style={styles.groupHeading}>{group.heading.toUpperCase()}</Text>
            <View style={styles.menuBlock}>
              {group.items.map((item, i) => {
                const Icon = item.icon;
                const isLast = i === group.items.length - 1;
                return (
                  <TouchableOpacity
                    key={item.label}
                    style={[styles.menuRow, !isLast && styles.menuRowBorder]}
                    activeOpacity={0.65}
                  >
                    <View style={styles.iconBox}>
                      <Icon color="rgba(0,0,0,0.55)" />
                    </View>
                    <View style={styles.menuText}>
                      <Text style={styles.menuLabel}>{item.label}</Text>
                      <Text style={styles.menuSub}>{item.sub}</Text>
                    </View>
                    <IconChevron color="rgba(0,0,0,0.25)" />
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}

        {/* Logout */}
        <TouchableOpacity
          style={styles.logoutBtn}
          activeOpacity={0.7}
          onPress={() =>
            Alert.alert('Log Out', 'Are you sure?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Log Out', style: 'destructive', onPress: () => signOut() },
            ])
          }
        >
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>

        <Text style={styles.versionText}>myOOTD v1.0</Text>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  scrollContent: {
    paddingTop: 72,
    paddingHorizontal: 20,
    paddingBottom: 140,
  },

  // Profile Header
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    marginBottom: 36,
    paddingHorizontal: 4,
  },
  avatarWrapper: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    borderRadius: 40,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.1)',
    backgroundColor: Colors.surface,
  },
  profileInfo: {
    flex: 1,
    gap: 5,
  },
  name: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.5,
  },
  handle: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(0,0,0,0.4)',
    letterSpacing: 0.1,
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 40,
  },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    paddingVertical: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statVal: {
    fontSize: 28,
    fontWeight: '900',
    color: Colors.text,
    letterSpacing: -1,
  },
  statLabel: {
    marginTop: 5,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: 'rgba(0,0,0,0.4)',
  },

  // Menu groups
  menuGroup: {
    marginBottom: 28,
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: 'rgba(0,0,0,0.3)',
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  menuBlock: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 14,
  },
  menuRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: Radii.xs,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  menuText: {
    flex: 1,
    gap: 3,
  },
  menuLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: -0.1,
  },
  menuSub: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(0,0,0,0.4)',
  },

  // Logout
  logoutBtn: {
    height: 56,
    borderRadius: Radii.full,
    backgroundColor: 'rgba(255, 59, 48, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 48, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: 20,
  },
  logoutText: {
    color: Colors.red,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.2,
  },

  // Body Photo
  bodyPhotoSection: {
    marginBottom: 40,
  },
  bodyPhotoContainer: {
    height: 300,
    borderRadius: Radii.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
    position: 'relative',
  },
  bodyPhoto: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  bodyPhotoOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  bodyPhotoBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyPhotoBtnDanger: {
    backgroundColor: 'rgba(255,59,48,0.3)',
  },
  bodyPhotoBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFF',
  },
  bodyPhotoEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bodyPhotoEmptyIcon: {
    fontSize: 48,
    color: 'rgba(0,0,0,0.15)',
    fontWeight: '300',
  },
  bodyPhotoEmptyText: {
    fontSize: 15,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.5)',
  },
  bodyPhotoEmptySubtext: {
    fontSize: 12,
    fontWeight: '500',
    color: 'rgba(0,0,0,0.3)',
  },

  // Version
  versionText: {
    textAlign: 'center',
    fontSize: 11,
    color: 'rgba(0,0,0,0.25)',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});
