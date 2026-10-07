# JobSeeker UI design system

Compact, mobile-first and theme-aware. Everything is styled in `src/index.css` with CSS variables; Tailwind is only
used for a few utility classes (`w-4`/`h-4`, `w-3.5`/`h-3.5`, `min-h-screen`).

## Principles

- **Dense and scannable**: one line per job in the list, numbers right-aligned, secondary data muted.
- **Thumb first on phones** (≤ 720px): primary actions at the bottom (tab bar, sheet actions).
- **Finger-sized on touch screens** (`@media (pointer: coarse)`, any width incl. tablets): about 44px targets
  (`--control-h` becomes 44px; icon buttons 44×44; list-row actions keep a 28-32px width but take the full 44px
  height) and 16px form text so iOS doesn't zoom into fields.
- **No surprises**: every destructive action has Undo; swipes need a deliberate horizontal gesture.
- **Follows the device theme**: light by default, dark via `prefers-color-scheme`. Popups use the same surfaces.

## Tokens (`:root`)

| Token | Use |
|---|---|
| `--bg`, `--surface`, `--surface-2` | Page, cards/panels, subtle fills and hover |
| `--border`, `--border-strong` | Dividers and control borders |
| `--text`, `--text-2`, `--muted` | Primary, secondary and tertiary text |
| `--primary`, `--on-primary` | Actions, selection, focus ring |
| `--success`, `--warning`, `--orange`, `--danger`, `--accent` | Applied / fit bands / hide / strong-fit metric |
| `--*-soft` | 12-14% tints of the colours above (`color-mix`) for chips and badges |
| `--shadow-sm`, `--shadow-lg`, `--backdrop` | Raised controls, popups (drawer, modal, toast) and their scrim |
| `--radius` 8px, `--radius-sm` 6px | Cards / controls |
| `--header-h` 48px, `--control-h` 32px (44px on touch) | Top bar and control height |
| `--gutter-l`, `--gutter-r` | Page side padding (16px, 10px on phones), widened by the notch's safe-area insets |
| `--font`, `--mono` | UI text and `kbd` / `code` |

Never hard-code colours in components; add a token instead. Base font size is 14px.

## Components

| Class / component | Notes |
|---|---|
| `.btn` (`.primary`, `.success`, `.danger`, `.sm`, `.block`) | Text buttons. `.primary-button` / `.secondary-button` are aliases used by Settings |
| `.icon-btn` (`.is-on`, `.danger`) | 30px icon buttons (44px on touch); icons come from `components/common/icons.jsx` (`.icon`, 16px) |
| `.segmented`, `.tab-group` | Two-state toggles and tabs on a `--surface-2` track (`.settings-tabs` shares the `.tab-group` styles) |
| `.eyebrow` | Small all-caps section label (also used for drawer and shortcut-help headings) |
| `.pill-toggle`, `.filter-chip` | Quick filters (toggle) and removable active filters |
| `.data-freshness` (`.stale`) | "Updated 2 h ago" at the end of the chip row (last pipeline publish; `--warning` after 12 h, absolute time in `title`) |
| `JobRow` (`.job-row`) | List item: fit score, title, company · location, role/exp/skills/age, actions |
| `JobCard` (`.job-card`) | Card item: fit ring, skills, fit bars, footer with exp/age/actions |
| `FitScore` / `FitRing` / `FitBreakdown` | Fit bands: strong ≥ 70 (success), good ≥ 50 (warning), low (orange), none (muted) |
| `Metrics` | Header counters + scrubbable 14-day trend (drag, hover or arrow keys → `.spark-tip`) |
| `JobDrawer` | Side drawer on desktop; full screen on phones with the actions in a bottom bar |
| `.toast` (`.success`, `.danger`) | Themed notification with Undo; tinted like the swipe hint of the same action |
| `.filter-panel` | Centered dialog on desktop, bottom sheet on phones; rendered into `<body>` (a portal) so its backdrop covers the page; only the fields scroll, the header and Apply stay visible |

States: `.is-active` (keyboard selection), `.is-applied` (green left bar), `.is-stale` (dimmed while refreshing).

## Layout

- **Desktop**: sticky top bar (brand, metrics, view toggle, shortcuts, settings, sign out) + sticky toolbar
  (search, filters, sort, tabs) + chip row + list/grid. The toolbar is only sticky with at least 500px of height,
  and below 480px of height (landscape phones) the top bar scrolls away too.
- **Phone**: top bar (brand, trend, search icon, settings, sign out), collapsible search, horizontally scrolling chip
  row, list, fixed bottom bar (All / To apply / Applied / Filters). Utility classes: `.hide-mobile`, `.hide-desktop`.
- Use `min-height: 100dvh` (with a `100vh` line before it as the fallback) for full-height pages and sheets.

## Interaction

- Keyboard (`hooks/useHotkeys.js`): `j`/`k`, `Enter`, `o`, `a`, `x`, `u`, `/`, `1`-`3`, `v`, `r`, `?`, `Esc`.
- Swipe (`hooks/useSwipe.js`): starts after 14px, only if horizontal movement is more than 2× vertical, triggers
  past 40% of the width (min 110px, max 150px so wide rows can still reach it within the 180px drag).
- Pull to refresh (`hooks/usePullToRefresh.js`): at the top of the list, vertical intent, 64px. The `.ptr` pill is
  fixed under the top bar and moved with `transform` only (no React render per touchmove).
- Dialogs (`hooks/useDialogFocus.js`): the drawer, the filter panel and the shortcuts modal keep Tab inside and
  return focus on close (the drawer to the current job's row).
- Motion: short fades/slides; `prefers-reduced-motion` disables all animation and transitions.
