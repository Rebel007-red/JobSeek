# JobSeeker Design System v2.0

## Overview
Modern, professional light-theme design system built with Tailwind CSS and React. Focuses on clean typography, excellent visual hierarchy, and intuitive user interactions. All components follow accessibility best practices and responsive design principles.

---

## Color Palette

### Primary Colors (Indigo)
- **Indigo-50**: `#eef2ff` - Lightest background
- **Indigo-100**: `#e0e7ff` - Light background
- **Indigo-200**: `#c7d2fe` - Selection/borders
- **Indigo-300**: `#a5b4fc` - Hover states
- **Indigo-400**: `#818cf8` - Secondary accents
- **Indigo-500**: `#6366f1` - Primary brand (reserved)
- **Indigo-600**: `#4f46e5` - Primary action buttons, links
- **Indigo-700**: `#4338ca` - Hover state for primary
- **Indigo-800**: `#3730a3` - Dark primary text
- **Indigo-900**: `#312e81` - Darkest primary

### Semantic Colors
- **Success**: `#10b981` - ✓ Applied jobs, confirmations
- **Success-Light**: `#d1fae5` - Success backgrounds
- **Warning**: `#f59e0b` - ⚠️ New jobs, alerts
- **Warning-Light**: `#fef3c7` - Warning backgrounds
- **Error**: `#ef4444` - ❌ Errors, destructive actions
- **Error-Light**: `#fee2e2` - Error backgrounds

### Neutral Colors (Gray)
- **Gray-50**: `#f9fafb` - Page background
- **Gray-100**: `#f3f4f6` - Secondary background
- **Gray-200**: `#e5e7eb` - Borders, dividers
- **Gray-600**: `#4b5563` - Secondary text
- **Gray-700**: `#374151` - Primary text
- **Gray-900**: `#111827` - Dark text

---

## Typography

### Font Family
- **System Font Stack**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif`
- Provides native feel on all platforms

### Text Styles

| Style | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| Heading 1 | 2rem (32px) | 600 | 1.2 | Page titles |
| Heading 2 | 1.5rem (24px) | 600 | 1.2 | Section titles |
| Heading 3 | 1.25rem (20px) | 600 | 1.2 | Subsection titles |
| Heading 4 | 1.125rem (18px) | 600 | 1.2 | Minor headings |
| Body | 1rem (16px) | 400 | 1.6 | Main text |
| Body Small | 0.875rem (14px) | 400 | 1.6 | Secondary text |
| Caption | 0.75rem (12px) | 600 | 1.4 | Labels, badges |

### Text Colors
- **Primary**: `#111827` (Gray-900) - Main content
- **Secondary**: `#6b7280` (Gray-600) - Supporting text, descriptions
- **Tertiary**: `#9ca3af` (Gray-400) - Placeholders, disabled states

---

## Component Design Patterns

### Header Component
- **Height**: 80px (h-20)
- **Sticky Position**: `position: sticky; top: 0; z-index: 20`
- **Background**: White with 95% opacity + backdrop blur
- **Features**:
  - Logo with gradient text (Indigo 600 → 700)
  - Stat pills with gradient backgrounds (Indigo, Emerald, Purple)
  - Action buttons: Skills toggle, Settings, Sign out
  - Responsive: Hides some stats on mobile

### Filter Component
- **Button State**:
  - Inactive: White bg, gray text, gray border
  - Active/Hover: Indigo-50 bg, indigo-300 border, indigo-700 text
- **Dropdown Panel**:
  - Position: Absolute, width 384px (w-96)
  - Shadow: `shadow-2xl` (depth effect)
  - Rounded: 12px (rounded-xl)
  - Padding: 24px (p-6)
- **Form Fields**:
  - Focus state: Indigo ring (2px), transparent border
  - Rounded: 8px (rounded-lg)
  - Padding: 10px 16px (px-4 py-2.5)

### JobCard Component
- **Layout**: Card with flex column, fills height
- **Container**:
  - Background: White
  - Border: 1px gray-200
  - Rounded: 12px (rounded-xl)
  - Padding: 20px (p-5)
  - Shadow: Hover shadow-lg
  - Transition: All 200ms
- **Title**: Bold, line-clamp-2, hover text color changes to indigo
- **Company Name**: Semibold indigo-600
- **Metadata**: Icons (location, department) with gray text
- **Skills Tags**:
  - Matched: Indigo bg/text with ring
  - Unmatched: Gray bg/text with ring
  - Max displayed: 5 (show +X for rest)
- **Badges**:
  - Applied: Emerald with checkmark
  - New: Amber with pulse dot
  - Match %: Purple with sparkle
  - All with ring borders
- **Actions**:
  - Buttons: Icon + text, hover bg color
  - Link: External job link
  - Hide: Delete/remove action

### Tab Component
- **Container**: White bg, border gray-200, rounded-lg, shadow-sm
- **Button States**:
  - Active: Gradient bg (indigo-600 → 700), white text
  - Inactive: Gray bg on hover
  - Font: Semibold, smaller text
  - Count badge: Optional (xs font, faded opacity)

### Loading State
- **Spinner**: 40px border-4, indigo-200 border with indigo-600 top
- **Animation**: `animate-spin` (2 seconds)
- **Text**: "Loading jobs..." with secondary color

### Empty State
- **Icons**: 80px size, gray-100 bg, rounded-full container
- **Text**: Heading, subheading
- **Optional**: Refresh button with indigo gradient

---

## Spacing System

Follows Tailwind's 4px base unit:

| Token | Value | Tailwind Class |
|-------|-------|---|
| XS | 4px | px-1, py-1 |
| SM | 8px | px-2, py-2 |
| MD | 12px | px-3, py-3 |
| LG | 16px | px-4, py-4 |
| XL | 20px | px-5, py-5 |
| 2XL | 24px | px-6, py-6 |
| 3XL | 28px | px-7, py-7 |
| 4XL | 32px | px-8, py-8 |

### Common Spacing
- **Header height**: 80px (20 * 4px)
- **Main padding**: 24px (p-6)
- **Card padding**: 20px (p-5)
- **Gap between grid items**: 20px (gap-5)
- **Vertical spacing**: 32px (py-8) for sections

---

## Layout Grid

### Breakpoints
- **Mobile**: `<640px` - Single column
- **Tablet**: `640px-1024px` - Two columns (md:grid-cols-2)
- **Desktop**: `>1024px` - Three columns (lg:grid-cols-3)

### Container
- **Max Width**: 1280px (max-w-7xl)
- **Padding**: 24px on desktop, 16px on mobile
- **Centered**: `mx-auto` with flex/grid

### Grid
```jsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
```

---

## Interactive States

### Button States
1. **Default**: Normal colors
2. **Hover**: Slightly darker/saturated color
3. **Focus**: 2px outline, 2px offset
4. **Active**: Pressed visual state
5. **Disabled**: Reduced opacity (50%), cursor-not-allowed

### Link States
- **Default**: Indigo-600
- **Hover**: Indigo-700
- **Visited**: (Not explicitly styled, follows default)

### Form States
- **Focus**: 2px indigo ring, no outline
- **Error**: Red border + light red bg
- **Success**: Green border + light green bg

---

## Animation & Transitions

### Transition Speeds
- **Fast**: 150ms (border, bg changes)
- **Normal**: 200ms (default transition-all)
- **Slow**: 300ms (larger motion, fades)

### Animations
- **fadeIn**: 300ms ease-out (content appears)
- **spin**: 2s linear infinite (loading spinner)
- **pulse**: 2s ease-in-out infinite (emphasis)

### CSS Classes
```css
transition-all duration-200
transition-colors duration-200
animate-spin
animate-pulse
```

---

## Accessibility Guidelines

1. **Contrast Ratios**:
   - Indigo-600 text on white: 6.5:1 (AAA)
   - Gray-700 text on white: 10.3:1 (AAA)

2. **Focus Indicators**:
   - All interactive elements have `:focus-visible` state
   - 2px indigo outline with 2px offset

3. **ARIA Labels**:
   - Buttons have title attributes
   - Form fields have associated labels
   - Icons have aria-hidden when decorative

4. **Keyboard Navigation**:
   - Tab order follows visual flow
   - Enter/Space trigger buttons
   - Escape closes modals/dropdowns

5. **Screen Reader Support**:
   - Semantic HTML (article, nav, main, section)
   - Meaningful alt text for images
   - Role attributes where needed

---

## Component Responsive Behavior

### Header
- Logo: Always visible
- Stats: Hidden on mobile (hidden sm:flex)
- Actions: Stack vertically on mobile

### Filter
- Full width on mobile
- Dropdown positioned left on mobile
- Adjusted z-index for visibility

### JobCard
- Full width on mobile
- 2 columns on tablet
- 3 columns on desktop
- Fixed aspect ratio: None (variable height based on content)

### Tabs
- Stack horizontally on mobile
- Pill-shaped with less padding on mobile

---

## Future Design Considerations

### v2.1 Potential Enhancements
1. **Dark Mode Support**: Duplicate color tokens with dark variants
2. **Advanced Animations**: Skeleton loading, transition states
3. **Custom Scrollbar**: Styled, branded appearance
4. **Neumorphism**: Soft shadows for 3D depth
5. **Micro-interactions**: Hover animations, button feedb,ack
6. **Toast/Notifications**: Bottom-right corner, auto-dismiss
7. **Modals**: Centered overlay with backdrop blur
8. **Charts/Graphs**: Stats visualization with Chart.js or Recharts

### Theming Variables
CSS variables defined in `:root` allow easy theme switching:
```css
:root {
  --primary-600: #4f46e5;
  --success: #10b981;
  /* etc */
}
```

---

## File Structure

```
src/
├── index.css                 # Global styles + CSS variables
├── components/
│   ├── layout/
│   │   └── Header.jsx       # Navigation, stats
│   └── common/
│       ├── JobCard.jsx      # Job listing card
│       └── SearchFilter.jsx # Filter dropdown
├── pages/
│   ├── JobsPage.jsx        # Main grid layout
│   ├── LoginPage.jsx       # Auth page
│   └── SettingsPage.jsx    # User settings
└── hooks/
    ├── useAuth.js          # Authentication
    └── useUserSkills.js    # Skills management
```

---

## Notes for Developers

1. **Always use Tailwind classes** for styling (no inline styles)
2. **Respect z-index hierarchy**: 
   - Normal: 0
   - Sticky: 20
   - Dropdowns: 50
   - Modals: 100+
3. **Mobile-first approach**: Design for mobile, then scale up
4. **Semantic HTML**: Use proper tags (article, nav, section, etc.)
5. **Accessibility first**: WCAG 2.1 Level AA minimum
6. **Performance**: Lazy load images, code split components
7. **Testing**: Visual regression, contrast, keyboard navigation

---

**Last Updated**: 2026-09-04  
**Version**: 2.0  
**Status**: Production Ready
