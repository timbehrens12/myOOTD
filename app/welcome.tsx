import { StyleSheet, Text, View, TouchableOpacity, Dimensions, ScrollView, Alert } from 'react-native';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@clerk/clerk-expo';
import * as SecureStore from 'expo-secure-store';

// Expected location: assets/images/welcome.bg.mp4
const videoSource = require('../assets/images/welcome.bg.mp4');

const { width, height } = Dimensions.get('window');

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();

  // Initialize the high-fidelity video background with auto-loop
  const player = useVideoPlayer(videoSource, (player) => {
    player.loop = true;
    player.muted = true;
    player.staysActiveInBackground = true;
    player.play();
  });

  // POWER MOVE: Force logout if session is stale/stuck after account deletion
  const forceSessionReset = async () => {
    try {
      await signOut();
      await SecureStore.deleteItemAsync('__clerk_client_jwt');
      Alert.alert('Session Cleared', 'All local session data has been erased. You can now log back in fresh.');
    } catch (e) {
      console.warn('Reset failed:', e);
    }
  };

  return (
    <View style={styles.container}>
      <LinearGradient colors={['#F2F2F7', '#FFFFFF']} style={StyleSheet.absoluteFillObject} />

      <ScrollView 
        contentContainerStyle={{ flexGrow: 1 }}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.topSection, { paddingTop: insets.top + (height < 700 ? 10 : 30) }]}>
          <View style={styles.videoCard}>
            <Animated.View entering={FadeIn.duration(2000)} style={StyleSheet.absoluteFillObject}>
              <VideoView 
                style={StyleSheet.absoluteFillObject} 
                player={player} 
                nativeControls={false}
                contentFit="contain"
              />
            </Animated.View>
            <LinearGradient
              colors={['transparent', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.3)']}
              style={StyleSheet.absoluteFillObject}
              locations={[0.6, 0.9, 1]}
            />
          </View>
        </View>

        <View style={[styles.bottomSection, { paddingBottom: insets.bottom + 20 }]}>
          <Animated.View entering={FadeInDown.duration(800).delay(200)} style={styles.brandContainer}>
            <TouchableOpacity onLongPress={forceSessionReset} activeOpacity={0.9}>
               <Text style={styles.brandTitle}>myOOTD</Text>
            </TouchableOpacity>
            <Text style={styles.brandSubtitle}>
              Digitize your closet. Automate your style.
            </Text>
          </Animated.View>

          <Animated.View entering={FadeInDown.duration(800).delay(400)} style={styles.actions}>
            <TouchableOpacity 
              activeOpacity={0.7}
              style={styles.btnWrapper}
              onPress={() => router.push('/login')}
            >
              <BlurView intensity={40} tint="light" style={styles.glassBtn}>
                <View style={styles.glassOverlay} />
                <Text style={styles.btnText}>Login</Text>
              </BlurView>
            </TouchableOpacity>
            
            <TouchableOpacity 
              activeOpacity={0.7}
              style={styles.btnWrapper}
              onPress={() => router.push('/signup')}
            >
              <BlurView intensity={25} tint="light" style={styles.glassBtn}>
                <View style={styles.glassOverlay} />
                <Text style={styles.btnText}>Create account</Text>
              </BlurView>
            </TouchableOpacity>
          </Animated.View>
          
          <Animated.View entering={FadeInDown.duration(800).delay(600)} style={styles.termsContainer}>
            <Text style={styles.terms}>
              By signing up, you agree to our{'\n'}
              <Text style={styles.link} onPress={() => router.push('/terms')}>Terms of Service</Text> & <Text style={styles.link} onPress={() => router.push('/privacy')}>Privacy Policy</Text>
            </Text>
          </Animated.View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  topSection: {
    flex: 1,
    minHeight: height * 0.35,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoCard: {
    flex: 1,
    width: width * 0.88,
    maxWidth: 480,
    maxHeight: height * 0.55,
    borderRadius: 36,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.08)',
  },
  bottomSection: {
    paddingHorizontal: 32,
    justifyContent: 'center',
    paddingTop: 0,
    paddingBottom: 24,
  },
  brandContainer: {
    alignItems: 'center',
    marginBottom: 24,
    marginTop: 0,
  },
  brandTitle: {
    fontSize: 52,
    fontWeight: '800',
    color: '#000',
    letterSpacing: -2.5,
    marginBottom: 4,
  },
  brandSubtitle: {
    fontSize: 15,
    color: 'rgba(0,0,0,0.4)',
    fontWeight: '500',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  actions: {
    gap: 12,
    marginBottom: 20,
  },
  btnWrapper: {
    height: 54,
    borderRadius: 27,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  glassBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  btnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  termsContainer: {
    marginTop: 8,
  },
  terms: {
    fontSize: 10,
    color: 'rgba(0,0,0,0.4)',
    textAlign: 'center',
    lineHeight: 14,
  },
  link: {
    color: 'rgba(0,0,0,0.6)',
    textDecorationLine: 'underline',
  },
});
