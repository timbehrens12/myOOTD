---
description: Print the myOOTD design system — colors, typography, radii, and reusable style constants so every UI component stays on-brand
---

# myOOTD Design System

**Vibe:** Dark, editorial, high-fashion. Pure black backgrounds, white accents, glass/blur effects, heavy font weights, generous border radii.

---

## Colors (`constants/AppTheme.ts → Colors`)

| Token | Value | Use |
|---|---|---|
| `bg` | `#000000` | Screen backgrounds |
| `surface` | `#121214` | Cards, sheets |
| `surfaceAlt` | `#1C1C1E` | Secondary surfaces |
| `surfaceGloss` | `rgba(255,255,255,0.05)` | Subtle tinted areas |
| `border` | `rgba(255,255,255,0.12)` | Default borders |
| `text` | `#FFFFFF` | Primary text |
| `textMuted` | `rgba(255,255,255,0.45)` | Secondary/helper text |
| `textLight` | `rgba(255,255,255,0.7)` | Mid-emphasis text |
| `accent` | `#FFFFFF` | Primary action color |
| `accent2` | `#AEAEB2` | Slate gray accent |
| `silver` | `#2C2C2E` | Borders, dividers |
| `red` | `#FF3B30` | Destructive actions |
| `white` | `#FFFFFF` | |
| `black` | `#000000` | |

**Glass effect pattern:**
```ts
backgroundColor: 'rgba(255,255,255,0.05)',
borderWidth: 1,
borderColor: 'rgba(255,255,255,0.1)',
// + BlurView intensity={25} tint="dark"
```

---

## Typography (`Typography`)

- **Font family:** System (SF Pro on iOS)
- **Weights:** 400 regular · 500 medium · 600 semibold · 700 bold · 800 extrabold · 900 boldest
- **Common patterns:**
  - Screen titles: `fontSize: 24–28, fontWeight: '800', letterSpacing: -0.8`
  - Section labels: `fontSize: 11, fontWeight: '900', letterSpacing: 2, textTransform: 'uppercase'`
  - Body: `fontSize: 14–16, fontWeight: '600'`
  - Captions: `fontSize: 10–12, fontWeight: '700'`

---

## Border Radii (`Radii`)

| Token | Value | Use |
|---|---|---|
| `xs` | 8 | Small chips, tags |
| `sm` | 12 | Small cards |
| `md` | 16 | Standard cards |
| `lg` | 20 | Larger cards |
| `xl` | 24 | Sheets, modals |
| `full` | 9999 | Pills, circular |

**Note:** Modals/bottom sheets typically use 32–40px, larger than `xl`.

---

## Reusable Styles (`Styles`)

**`Styles.card`** — standard dark card with subtle border + shadow
**`Styles.glass`** — frosted glass surface
**`Styles.glassCard`** — glass + padding + xl radius (use for main content cards)
**`Styles.glow`** — white glow shadow (use on primary buttons/hero elements)
**`Styles.btnPrimary`** — white pill button, full width, height 56
**`Styles.btnPrimaryText`** — black text for primary buttons

---

## Component Conventions

**Bottom sheets / modals:**
- `borderTopLeftRadius: 32–40, borderTopRightRadius: 32–40`
- `borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.12)'`
- Always wrap content with `<BlurView intensity={25–40} tint="dark">`

**Section headers:**
```ts
fontSize: 11, fontWeight: '900', color: 'rgba(255,255,255,0.3)',
letterSpacing: 2, textTransform: 'uppercase'
```

**Tab bar:** floating, `borderRadius: 38`, blur background, 76px height, sits 24px from bottom

**Primary button:**
- White fill (`#FFF`), black text, `borderRadius: full`, height 52–56
- Secondary: `backgroundColor: 'rgba(255,255,255,0.08)'`, white text, same shape

**Item cards (closet):** `3:4` editorial portrait ratio, `borderRadius: 20–24`

**Tab icon active state:** white fill/stroke. Inactive: `rgba(255,255,255,0.4)`

---

## Import path
```ts
import { Colors, Typography, Radii, Styles } from '../../constants/AppTheme';
```
