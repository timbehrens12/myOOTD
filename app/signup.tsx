import { useState, useCallback } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Dimensions, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useSignUp, useOAuth } from '@clerk/clerk-expo';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

// Ensure the web browser is correctly warmed up for oauth flows on Android
WebBrowser.maybeCompleteAuthSession();

const { width } = Dimensions.get('window');

const BackIcon = () => (
  <Svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <Path d="M19 12H5" />
    <Path d="M12 19l-7-7 7-7" />
  </Svg>
);

const AppleIcon = () => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="#000">
    <Path d="M16.148 10.748C16.128 7.625 18.669 6.101 18.784 6.037C17.319 3.882 15.034 3.559 14.249 3.468C12.378 3.284 10.584 4.549 9.615 4.549C8.653 4.549 7.153 3.486 5.567 3.504C3.513 3.535 1.637 4.673 0.585 6.471C-1.554 10.088 0.041 15.421 2.115 18.337C3.125 19.756 4.316 21.363 5.867 21.303C7.362 21.239 7.925 20.354 9.689 20.354C11.453 20.354 11.964 21.303 13.515 21.272C15.118 21.239 16.148 19.816 17.154 18.397C18.324 16.745 18.799 15.143 18.824 15.04C18.782 15.023 16.171 14.023 16.148 10.748ZM12.716 2.052C13.541 1.077 14.1 0.443 14.084 -0.016C13.385 0.009 12.016 0.442 11.161 1.401C10.401 2.25 9.719 3.655 9.75 4.978C10.518 5.032 11.879 4.57 12.716 2.052Z"/>
  </Svg>
);

const GoogleIcon = () => (
  <Svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </Svg>
);

export default function SignupScreen() {
  const router = useRouter();
  const { isLoaded, signUp, setActive } = useSignUp();
  
  const { startOAuthFlow: startAppleOAuth } = useOAuth({ strategy: 'oauth_apple' });
  const { startOAuthFlow: startGoogleOAuth } = useOAuth({ strategy: 'oauth_google' });

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const onSignUpPress = async () => {
    if (!isLoaded) return;
    setLoading(true);

    try {
      await signUp.create({
        emailAddress: email,
        password,
        firstName: name.split(' ')[0],
        lastName: name.split(' ').slice(1).join(' '),
      });

      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setPendingVerification(true);
    } catch (err: any) {
      console.error(JSON.stringify(err, null, 2));
      Alert.alert('Signup Error', err.errors?.[0]?.message || 'Could not initialize account');
    } finally {
      setLoading(false);
    }
  };

  const onPressVerify = async () => {
    if (!isLoaded) return;
    setLoading(true);

    try {
      const completeSignUp = await signUp.attemptEmailAddressVerification({
        code,
      });

      await setActive({ session: completeSignUp.createdSessionId });
      router.push('/survey');
    } catch (err: any) {
      console.error(JSON.stringify(err, null, 2));
      Alert.alert('Verification Error', err.errors?.[0]?.message || 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  };

  const onSelectOAuth = useCallback(async (strategy: 'apple' | 'google') => {
    try {
      setLoading(true);
      const startFlow = strategy === 'apple' ? startAppleOAuth : startGoogleOAuth;
      const { createdSessionId, setActive, signIn, signUp } = await startFlow({
         redirectUrl: Linking.createURL('/') // Fall back to dynamic resolution for Expo Go / Native interchange
      });

      console.log('OAuth StartFlow Success:', { createdSessionId, signInStatus: signIn?.status, signUpStatus: signUp?.status });

      if (createdSessionId) {
        await setActive!({ session: createdSessionId });
        router.replace('/survey'); // newly created account goes to survey
      } else if (signIn?.status === 'complete' && signIn.createdSessionId) {
        await setActive!({ session: signIn.createdSessionId });
        router.replace('/(tabs)');
      } else if (signUp?.status === 'complete' && signUp.createdSessionId) {
        await setActive!({ session: signUp.createdSessionId });
        router.replace('/survey');
      } else {
        const missingInfo = signUp?.unverifiedFields || signUp?.missingFields || [];
        Alert.alert(
          'Missing Requirements', 
          `Status: ${signUp?.status}\nClerk is asking for required fields that Google cannot provide: ${JSON.stringify(missingInfo)}.\nPlease disable these required fields (like Username or Phone) in your Clerk Dashboard.`
        );
      }
    } catch (err: any) {
      console.error('OAuth error:', JSON.stringify(err, null, 2));
      Alert.alert('SSO Error', 'Could not register via ' + strategy);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
      style={styles.container}
    >
      <SafeAreaView style={styles.safe}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <BackIcon />
        </TouchableOpacity>

        <ScrollView 
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {!pendingVerification ? (
            <>
              <Animated.View entering={FadeInDown.duration(800).delay(100)} style={styles.header}>
                <Text style={styles.title}>Create account.</Text>
                <Text style={styles.subtitle}>Begin your style journey here.</Text>
              </Animated.View>

              <Animated.View entering={FadeInDown.duration(800).delay(300)} style={styles.form}>
                
                {/* OAuth Buttons */}
                <View style={styles.oauthContainer}>
                  <TouchableOpacity activeOpacity={0.7} style={styles.btnWrapper} onPress={() => onSelectOAuth('apple')}>
                    <BlurView intensity={25} tint="light" style={styles.glassBtn}>
                      <View style={styles.glassOverlay} />
                      <View style={styles.oauthBtnContent}>
                        <AppleIcon />
                        <Text style={styles.btnText}>Sign up with Apple</Text>
                      </View>
                    </BlurView>
                  </TouchableOpacity>
                  
                  <TouchableOpacity activeOpacity={0.7} style={styles.btnWrapper} onPress={() => onSelectOAuth('google')}>
                    <BlurView intensity={25} tint="light" style={styles.glassBtn}>
                      <View style={styles.glassOverlay} />
                      <View style={styles.oauthBtnContent}>
                        <GoogleIcon />
                        <Text style={styles.btnText}>Sign up with Google</Text>
                      </View>
                    </BlurView>
                  </TouchableOpacity>
                </View>

                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or continue with email</Text>
                  <View style={styles.dividerLine} />
                </View>

                <View style={styles.inputsGrid}>
                  <View style={styles.inputContainer}>
                    <TextInput 
                      style={styles.input}
                      placeholder="Full name"
                      placeholderTextColor="rgba(0,0,0,0.3)"
                      value={name}
                      onChangeText={setName}
                    />
                  </View>

                  <View style={styles.inputContainer}>
                    <TextInput 
                      style={styles.input}
                      placeholder="Email address"
                      placeholderTextColor="rgba(0,0,0,0.3)"
                      value={email}
                      onChangeText={setEmail}
                      autoCapitalize="none"
                      keyboardType="email-address"
                    />
                  </View>

                  <View style={styles.inputContainer}>
                    <TextInput 
                      style={styles.input}
                      placeholder="Password"
                      placeholderTextColor="rgba(0,0,0,0.3)"
                      secureTextEntry
                      value={password}
                      onChangeText={setPassword}
                    />
                  </View>
                </View>

                <TouchableOpacity 
                  activeOpacity={0.7}
                  style={[styles.btnWrapper, loading && { opacity: 0.7 }, { marginTop: 8 }]} 
                  onPress={onSignUpPress}
                  disabled={loading}
                >
                  <BlurView intensity={40} tint="light" style={styles.glassBtn}>
                    <View style={styles.glassOverlay} />
                    <Text style={styles.btnText}>{loading ? 'Creating...' : 'Create account'}</Text>
                  </BlurView>
                </TouchableOpacity>
              </Animated.View>
            </>
          ) : (
            <>
              <Animated.View entering={FadeInDown.duration(800).delay(100)} style={styles.header}>
                <Text style={styles.title}>Confirm identity.</Text>
                <Text style={styles.subtitle}>Enter the code sent to {email}.</Text>
              </Animated.View>

              <Animated.View entering={FadeInDown.duration(800).delay(300)} style={styles.form}>
                <View style={styles.inputContainer}>
                  <TextInput 
                    style={[styles.input, { textAlign: 'center', fontSize: 24, letterSpacing: 8 }]}
                    placeholder="000000"
                    placeholderTextColor="rgba(0,0,0,0.2)"
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                </View>

                <TouchableOpacity 
                  activeOpacity={0.7}
                  style={[styles.btnWrapper, loading && { opacity: 0.7 }, { marginTop: 8 }]} 
                  onPress={onPressVerify}
                  disabled={loading}
                >
                  <BlurView intensity={40} tint="light" style={styles.glassBtn}>
                    <View style={styles.glassOverlay} />
                    <Text style={styles.btnText}>{loading ? 'Verifying...' : 'Verify Email'}</Text>
                  </BlurView>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => setPendingVerification(false)} style={styles.resendBtn}>
                  <Text style={styles.resendText}>Back to registration</Text>
                </TouchableOpacity>
              </Animated.View>
            </>
          )}

          <Animated.View entering={FadeInDown.duration(800).delay(500)} style={styles.footer}>
            <Text style={styles.footerText}>Already have an account?</Text>
            <TouchableOpacity onPress={() => router.push('/login')}>
              <Text style={styles.footerLink}> Sign in</Text>
            </TouchableOpacity>
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  safe: {
    flex: 1,
  },
  backBtn: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    marginLeft: 24,
    marginTop: 10,
  },
  scrollContent: {
    paddingHorizontal: 32,
    paddingTop: 30,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
    color: '#000',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: 'rgba(0,0,0,0.5)',
    marginTop: 8,
  },
  form: {
    gap: 16,
  },
  oauthContainer: {
    gap: 12,
  },
  btnWrapper: {
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  glassBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  glassOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.01)',
  },
  oauthBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  btnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
    opacity: 0.5,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  dividerText: {
    color: '#000',
    fontSize: 13,
    paddingHorizontal: 16,
  },
  inputsGrid: {
    gap: 16,
  },
  inputContainer: {
    height: 56,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
    justifyContent: 'center',
  },
  input: {
    paddingHorizontal: 16,
    color: '#000',
    fontSize: 15,
    height: '100%',
  },
  resendBtn: {
    alignItems: 'center',
    marginTop: 16,
  },
  resendText: {
    color: 'rgba(0,0,0,0.4)',
    fontSize: 14,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 40,
  },
  footerText: {
    color: 'rgba(0,0,0,0.5)',
    fontSize: 14,
  },
  footerLink: {
    color: '#000',
    fontSize: 14,
    fontWeight: '600',
  },
});
