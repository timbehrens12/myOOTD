export const Colors = {
  bg: '#F2F2F7',
  /** Fits builder hero (OutfitCanvas) — AI outfit renders use this exact hex as the frame backdrop */
  fitsBuilderCanvas: '#DDE1E6',
  surface: '#FFFFFF',
  surfaceAlt: '#F0F0F5',
  surfaceGloss: 'rgba(0,0,0,0.04)',
  border: 'rgba(0,0,0,0.08)',
  text: '#000000',
  textMuted: 'rgba(0,0,0,0.4)',
  textLight: 'rgba(0,0,0,0.6)',
  accent: '#000000',
  accent2: '#6E6E73',
  silver: '#E5E5EA',
  obsidian: '#F0F0F5',
  cloud: '#F2F2F7',
  white: '#FFFFFF',
  black: '#000000',
  grayBtn: '#F0F0F5',
  red: '#FF3B30',
};

export const Typography = {
  header: 'System',
  mono: 'monospace',
  sans: 'System',
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    extrabold: '800' as const,
    boldest: '900' as const,
  }
};

export const Radii = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  full: 9999,
};

export const Styles = {
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: Radii.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  glass: {
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius: Radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  glassCard: {
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: Radii.xl,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  pill: {
    backgroundColor: '#000000',
    borderRadius: Radii.full,
    paddingHorizontal: 20,
    paddingVertical: 10,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  pillText: {
    color: '#FFFFFF',
    fontWeight: Typography.weights.bold,
    fontSize: 13,
  },
  glow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  btnPrimary: {
    backgroundColor: '#000000',
    borderRadius: Radii.full,
    height: 56,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  btnPrimaryText: {
    color: '#FFFFFF',
    fontWeight: Typography.weights.bold,
    fontSize: 16,
    letterSpacing: -0.2,
  },
};
