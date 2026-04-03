import { StyleSheet, Text, View, ScrollView, TouchableOpacity, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors, Typography } from '../constants/AppTheme';
import Svg, { Path } from 'react-native-svg';

const ArcClose = ({ color }: { color: string }) => (
  <Svg width="24" height="24" viewBox="0 0 24 24">
    <Path d="M18 6L6 18M6 6L18 18" stroke={color} strokeWidth="2" strokeLinecap="round" />
  </Svg>
);

export default function TermsScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <ArcClose color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Terms of Service</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.updated}>Last updated: March 21, 2026</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. ACCEPTANCE OF TERMS</Text>
          <Text style={styles.bodyText}>
            By accessing or using MyOOTD, you agree to be bound by these Terms of Service. If you do not agree to all of these terms, do not use the application. MyOOTD provides an AI-driven digital wardrobe and styling service.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. USER ACCOUNTS & PRIVACY</Text>
          <Text style={styles.bodyText}>
            You must provide accurate information when creating an account. You are responsible for maintaining the security of your account. By uploading images of clothing, you grant MyOOTD a license to process these images for the purpose of identifying metadata and generating outfit suggestions.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>3. AI USAGE & CREDITS</Text>
          <Text style={styles.bodyText}>
            MyOOTD utilizes artificial intelligence to analyze garments and generate "fits." Usage may be governed by a credit system. We do not guarantee 100% accuracy in garment identification. Image generation is subject to compute availability and subscription status.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>4. SUBSCRIPTIONS & PAYMENTS</Text>
          <Text style={styles.bodyText}>
            Digital wardrobe subscriptions are managed via integrated app store payment systems. Fees are non-refundable unless required by law. High-fidelity generation features require an active Pro subscription.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>5. INTELLECTUAL PROPERTY</Text>
          <Text style={styles.bodyText}>
            The design, aesthetics, and algorithms of MyOOTD are the property of MyOOTD. You retain ownership of the original images you upload, but grant us the rights needed to provide the styling service.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>6. LIMITATION OF LIABILITY</Text>
          <Text style={styles.bodyText}>
            MyOOTD is provided "as is" without warranties of any kind. We are not responsible for any style choices made based on AI suggestions or for any loss of digital archive data.
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
