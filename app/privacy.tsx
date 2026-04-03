import { StyleSheet, Text, View, ScrollView, TouchableOpacity, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors, Typography } from '../constants/AppTheme';
import Svg, { Path } from 'react-native-svg';

const ArcClose = ({ color }: { color: string }) => (
  <Svg width="24" height="24" viewBox="0 0 24 24">
    <Path d="M18 6L6 18M6 6L18 18" stroke={color} strokeWidth="2" strokeLinecap="round" />
  </Svg>
);

export default function PrivacyScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <ArcClose color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Privacy Policy</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.updated}>Last updated: March 21, 2026</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. DATA COLLECTION</Text>
          <Text style={styles.bodyText}>
            MyOOTD collects images of clothing you upload for stabilization and AI analysis. We also collect basic account info (email, name) and device info for styling performance. We do not collect location data unless explicitly enabled for weather-based styling.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. CLOTHING DATA & AI TRAINING</Text>
          <Text style={styles.bodyText}>
            Images of clothing items are used to generate styling metadata. To improve our styling algorithms, anonymized clothing data may be used for machine learning. Your clothing images are not sold to third parties.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>3. USER RIGHTS</Text>
          <Text style={styles.bodyText}>
            You have the right to delete your digital archive and all associated clothing images at any time. We utilize Supabase Storage for secure, encrypted hosting of your digital wardrobe assets.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>4. DATA SHARING & ANALYTICS</Text>
          <Text style={styles.bodyText}>
            We share anonymized metadata with third-party styling providers to identify trends, but no personal identifiers are shared. We use RevenueCat for subscription tracking and analytics.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>5. SECURITY</Text>
          <Text style={styles.bodyText}>
            We use industry-standard security protocols to protect your digital wardrobe. We recommend using a strong password. MyOOTD is compliant with standard data protection regulations where applicable.
          </Text>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: 0.5,
  },
  closeBtn: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    padding: 24,
  },
  updated: {
    fontSize: 11,
    color: Colors.textMuted,
    marginBottom: 32,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: Colors.accent,
    marginBottom: 12,
    letterSpacing: 1,
  },
  bodyText: {
    fontSize: 14,
    color: Colors.textLight,
    lineHeight: 22,
    fontWeight: '500',
  },
});
