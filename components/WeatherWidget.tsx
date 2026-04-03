import { useState, useEffect } from 'react';
import { StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import Svg, { Rect, Path, Line, Circle } from 'react-native-svg';
import { Colors, Radii } from '../constants/AppTheme';

// BESPOKE ARCHITECTURAL ICONS
const ArcWeather = ({ color }: { color: string }) => (
  <Svg width="28" height="28" viewBox="0 0 24 24">
    <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth="1.2" fill="none" />
  </Svg>
);

const ArcRain = ({ color }: { color: string }) => (
  <Svg width="12" height="12" viewBox="0 0 24 24">
    <Line x1="12" y1="5" x2="12" y2="19" stroke={color} strokeWidth="1.2" />
    <Path d="M8 15L12 19L16 15" stroke={color} strokeWidth="1.2" fill="none" />
  </Svg>
);

const WEATHER_API_BASE = 'https://api.open-meteo.com/v1/forecast';

export default function WeatherWidget() {
  const [weather, setWeather] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setError('Permission to access location was denied');
          setLoading(false);
          return;
        }

        let location = await Location.getCurrentPositionAsync({});
        const { latitude, longitude } = location.coords;

        const response = await fetch(
          `${WEATHER_API_BASE}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto`
        );
        const data = await response.json();
        setWeather(data);
      } catch (err) {
        setError('Failed to fetch weather');
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const getWeatherIcon = (code: number) => {
    return <ArcWeather color={Colors.text} />;
  };

  const decodeWeather = (code: number) => {
    if (code === 0) return 'Clear';
    if (code <= 3) return 'Partly Cloudy';
    if (code >= 51 && code <= 67) return 'Rain';
    if (code >= 95) return 'Thunderstorm';
    return 'Mostly Sunny';
  };

  if (loading) return (
    <View style={[styles.container, { justifyContent: 'center' }]}>
      <ActivityIndicator color={Colors.accent} />
    </View>
  );

  if (error || !weather) return (
    <View style={styles.container}>
      <View style={styles.mainInfo}>
        <ArcWeather color={Colors.textMuted} />
        <Text style={styles.conditionText}>Weather Unavailable</Text>
      </View>
    </View>
  );

  const { current, daily } = weather;
  const temp = Math.round(current.temperature_2m);
  const high = Math.round(daily.temperature_2m_max[0]);
  const low = Math.round(daily.temperature_2m_min[0]);
  const rain = daily.precipitation_probability_max[0];
  const code = current.weather_code;

  return (
    <View style={styles.container}>
      <View style={styles.mainInfo}>
        <View style={styles.iconBox}>
          {getWeatherIcon(code)}
        </View>
        <View>
          <Text style={styles.tempText}>{temp}°F</Text>
          <Text style={styles.conditionText}>{decodeWeather(code)}</Text>
        </View>
      </View>
      
      <View style={styles.divider} />
      
      <View style={styles.detailsRow}>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>H: {high}°</Text>
        </View>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>L: {low}°</Text>
        </View>
        <View style={styles.detailItem}>
          <View style={styles.rainChance}>
            <ArcRain color={Colors.textMuted} />
            <Text style={styles.detailLabel}>{rain}%</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 2,
    marginBottom: 24,
    minHeight: 80,
  },
  mainInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 0,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tempText: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
  },
  conditionText: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  divider: {
    width: 1,
    height: 30,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 16,
  },
  detailsRow: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  detailItem: {
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
  },
  rainChance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
