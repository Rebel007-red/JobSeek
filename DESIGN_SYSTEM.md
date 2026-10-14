# JobSeeker UI design system

Compact, mobile-first and theme-aware. Everything is styled in `src/index.css` with CSS variables; Tailwind is only
used for a few utility classes (`w-4`/`h-4`, `w-3.5`/`h-3.5`, `min-h-screen`).

## Principles

- **Dense and scannable**: one line per job in the list, numbers right-aligned, secondary data muted.
- **Thumb first on phones and tablets** (the MOBILE query below): primary actions at the bottom (tab bar, sheet
  actions, the "Did you apply?" sheet).
- **Finger-sized on touch screens** (`@media (pointer: coarse)`, any width incl. tablets): about 44px targets
  (`--control-h` becomes 44px; icon buttons 44×44; list-row actions keep a 28-32px width but take the full 44px
  height) and 16px form text so iOS doesn't zoom into fields.
- **No surprises**: every destructive action has Undo; swipes need a deliberate horizontal gesture and never start
  at the screen edge (the browser's back gesture).
- **One word per idea**: user-facing text follows [Words](#words); backend words (pipeline, run, scrape, closed) stay
  out of it.
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
| `.data-freshness` (`.stale`) | "Updated 2 h ago" at the end of the chip row (the last update; `--warning` after 6 h, absolute time in `title`, plus the "Job updates are delayed" `.hint-banner`). After a check that found no new jobs it says "Checked 1 h ago · no new jobs" and the 6 h count starts from that check |
| `JobRow` (`.job-row`) | List item: fit score, title, company · location, role/exp/skills/age, actions (Inbox and Saved) |
| `JobCard` (`.job-card`) | Card item: fit ring, skills, fit bars, footer with exp/age/actions (Inbox and Saved) |
| `ApplicationRow` | The Applied tab's dense row in both views: Company · Title, `StagePill`, "Applied 8d ago", "Next Oct 12" or the Needs action flag ("No update 15d"), note icon, open link. One line on desktop; MOBILE two lines, at most 76px. No fit, skills or hide. Finished ones (Rejected, Withdrawn, No reply) fold into "Finished · N" at the bottom |
| `StagePill` / `StageMenuButton` | The stage of an application and its menu ("Move to"): the six applied stages, the current one checked, the suggested one marked " · suggested"; for Applied, Interviewing, Offer and No reply then "Followed up · ask again in 7 days" under a line (the follow-up date a week out, so a Needs action row is dealt with from the list). A popover anchored to the button on desktop, a bottom sheet on phones. The bulk bar's "Move to…" is the same menu |
| `StageStepper` | The drawer's one stage control for a saved or applied job: Saved — Applied — Interviewing — Offer, then No reply · Rejected · Withdrawn; passed steps show ✓, Applied shows its date. Untracked jobs have no stepper (decide first, track later) |
| `CheckinSheet` | The weekly check-in ("How did last week go?"): applications with no update for 7+ days, one tap each (a suggested answer says " · suggested" in words). The newest answer offers "Undo" in place. Centered on desktop, a bottom sheet on phones (one line of answers: the first three and "More"). Opens by itself on the first visit to the Applied tab each week (never over the Inbox), and by hand from the Applied tab |
| `FunnelLine` | Above the Applied tab's chips: "138 applied → 4 replies (3%) → 2 interviews → 1 offer · median reply 6 d", follows the filters; "By source and role" from 10 outcomes; the "Weekly check-in" button |
| `FirstFiveCard` | "Your first 5" at the top of the Inbox after the welcome save: the five best For-you fits with Save / Mark applied / Hide, in place of the Expiring strip until closed (per device) |
| `AlsoPosted` | The drawer's "Also posted in 6 places": place chips that open the other postings of a duplicate; the one you applied to has a ✓ |
| `FitScore` / `FitRing` / `FitBreakdown` | Fit bands: strong ≥ 70 (success), good ≥ 50 (warning), low (orange), none (muted) |
| `Metrics` | Header counters + scrubbable 14-day trend (drag, hover or arrow keys → `.spark-tip`) |
| `JobDrawer` | Side drawer on desktop; full screen on phones with the actions in a bottom bar |
| `.toast` (`.success`, `.danger`, `.primary`) | Themed notification with Undo; tinted like the swipe hint of the same action |
| `ScopeMenu` | "Which jobs": For you / Everything and the time window in one menu, at the start of the chip row (Inbox only) |
| `ExpiringStrip` | "Expiring tonight": untouched For-you jobs on their last day (they disappear at the first update after midnight UTC, 7 days after posting); the first 3 rows (1 under 500px high) until "Show N more", with Save all for the rows shown |
| `ChipInput` | Tag input of Settings; a full list hides its input and says "Remove one to add another" |
| `AccessDenied` | Full page "No access yet" for a signed-in email that is not on the allow list (Sign out, Try again) |
| `.filter-panel` | Centered dialog on desktop, bottom sheet on phones (a grab handle; dragging the handle or header down 60px closes it); rendered into `<body>` (a portal) so its backdrop covers the page. Three groups, Fit · Where · What. Filters apply live, the same ones as the chips; the footer's "Show N jobs" (the tab's count) only closes the panel, and Reset clears them. Only the fields scroll, the header and footer stay visible |
| `.sort-chip` | Phones: the sort as a pill after the scope menu in the chip row (a native select; "Needs action first" is the Applied tab's default) |

States: `.is-active` (keyboard selection), `.is-applied` (green left bar), `.is-stale` (dimmed while refreshing).

## Layout

- **MOBILE query** (every phone rule): `@media (max-width: 720px), (pointer: coarse) and (max-height: 500px),
  (pointer: coarse) and (max-width: 960px)`, so phones in landscape and touch tablets up to 960px get the phone
  layout. The **DESKTOP query** is its exact complement: `@media (min-width: 721px) and (pointer: fine),
  (min-width: 721px) and (pointer: none), (min-width: 961px) and (min-height: 501px)`. Hover styles sit inside
  `@media (hover: hover)`.
- **Desktop**: sticky top bar (brand, metrics, view toggle, shortcuts, settings, sign out) + sticky toolbar
  (search, filters, sort, tabs) + chip row + list/grid. The toolbar is only sticky with at least 500px of height,
  and below 480px of height (landscape phones) the top bar scrolls away too. From 721 to 960px a row's tags take a
  second line.
- **Phone**: top bar (brand, trend, settings, sign out), horizontally scrolling chip row, list, fixed bottom bar
  (Inbox / Saved / Applied / Search / Filters); Search opens a sticky bar under the top bar. Utility classes:
  `.hide-mobile`, `.hide-desktop` (they follow MOBILE / DESKTOP).
- **Settings**: opens at Profile. Tabs in two groups, `YOU` Profile · Mute rules · Hidden · Account and (admins only)
  `ADMIN` Companies · System · Access. Profile fields have anchors for links: `#roles`, `#skills`, `#also-skills`,
  `#experience`, `#cities` (e.g. `/settings?tab=profile#roles` scrolls to and focuses Roles).
- Use `min-height: 100dvh` (with a `100vh` line before it as the fallback) for full-height pages and sheets.

## Interaction

- Keyboard (`hooks/useHotkeys.js`): `j`/`k`, `Enter`, `o`, `s` (Save / Unsave), `a` (Mark applied / Undo applied),
  `x` (Hide), `t` (the stage of the open job: focuses the drawer's current step, or Save on an untracked job), `u`,
  `/`, `1`-`3` (Inbox, Saved, Applied), `v`, `r`, `?`, `Esc`.
- Stage controls: the drawer's `StageStepper` is one tab stop (Left / Right / Home / End move, Enter / Space pick);
  the stage menu takes Up / Down / Home / End, Enter, `1`-`6` and Esc. The weekly check-in: `1`-`5` answer the
  focused application, `j`/`k` (or the arrows) move, `u` undoes the newest answer, Esc closes; the key hint shows on
  desktop only.
- Swipe (`hooks/useSwipe.js`): starts after 14px, only if horizontal movement is more than 2× vertical, triggers
  past 40% of the width (min 110px, max 150px so wide rows can still reach it within the 180px drag). A touch that
  starts within 24px of either screen edge is ignored. What a swipe does depends on the tab: Inbox right = Save
  (Settings → Account "Swipe right marks applied" makes it Mark applied), left = Hide; Saved right = Mark applied,
  left = Unsave; Applied right = the next stage. Arming ticks and committing thuds (`utils/haptics.js`, off under
  reduced motion). New touch users get a one-time peek of the first row instead of a hint banner.
- Pull to refresh (`hooks/usePullToRefresh.js`): at the top of the list, vertical intent, 64px. The `.ptr` pill is
  fixed under the top bar and moved with `transform` only (no React render per touchmove).
- Dialogs (`hooks/useDialogFocus.js`): the drawer, the filter panel, the weekly check-in and the shortcuts modal keep
  Tab inside and return focus on close (the drawer to the current job's row).
- Motion: short fades/slides (a row leaving the list slides out and collapses in 160 ms); `prefers-reduced-motion`
  disables all animation and transitions.
- Saving: Settings forms save with a button, except Mute rules, which save on every change with an Undo toast.

## Words

| Say | Means | Never say |
|---|---|---|
| Inbox | Jobs you haven't saved, applied to or hidden, in the scope you chose | To apply, pending, All |
| Saved | Jobs you're keeping. They never disappear | Bookmarked, shortlisted |
| Applied | Jobs you applied to, at any stage | Done |
| For you | Jobs in your roles (or close to them) with fit 60+ that don't ask for much more experience than you have | Matched, match |
| Everything | Every job, best fit first | Show all |
| Strong fit | Fit 70 or more | Top, great |
| New | Found since your last visit (the last time you opened the app, at least 30 minutes ago) | Fresh, last 48 h |
| Expiring tonight / Disappears in ~9h | Jobs you haven't saved or applied to disappear 7 days after posting, at the first update after midnight UTC (5:30 AM in India). Save a job to keep it | Expires at the next run, deleted, removed |
| the next update (every ~6 hours) | When new jobs arrive | pipeline run, run, scrape, publish |
| Checked · no new jobs | The scrapers ran and found only jobs you already have ("Checked 1 h ago · no new jobs") | Skipped, no run |
| Older postings | Applications to postings over 7 days old. They may still be open (now only in the CSV and the drawer's age line) | Closed, posting closed, no longer listed |
| Waiting | Applied, no reply yet | Pending, in progress |
| Replied | Heard back at all: Interviewing, Offer or Rejected | Response rate, responded |
| Heard back | The answer that moves an application to Interviewing | Got a call |
| No reply | You applied and heard nothing back (suggested from 21 days after applying) | Ghosted, no response, closed |
| Needs action | Your follow-up date came, an interview with no update for 7 days, or an application with no update for 14 days | Overdue, to-do |
| Finished | Applications marked Rejected, Withdrawn or No reply | Closed, done, archived |
| Weekly check-in | The "How did last week go?" sheet, once a week | Survey, review |
| Muted | Left out by your mute rules (Settings → Mute rules) | hidden by your rules |
| Hidden | Jobs you hid yourself (Settings → Hidden) | Removed, dismissed |
| Exp not stated · No skills listed | The posting doesn't say | Exp n/a, skills ?, ? |
| points | Parts of the fit score that add up to it: "49 = 40 role + 7 skills + 2 experience" | weight, % |
| In your profile · Not in your profile | Skills of a job that you listed or didn't | Missing, To learn, Matched from your profile |

Stages, in this order: **Saved · Applied · Interviewing · Offer · No reply · Rejected · Withdrawn**. Moving one is
**Move to {Stage}** (menus, swipe hints, the stepper's titles) and its toast says "Moved to {Stage}".

Verbs (button text, then the aria-label for the other state): **Save / Unsave**, **Mark applied / Undo applied**,
**Hide / Restore**, **Mute / Unmute**, views **List / Cards**. A toggle's aria-label names the action it will take
("Save", "Unsave"), not a state. When the visible text shows a state ("Saved", "Interviewing"), the aria-label starts
with that text and then names the action ("Saved. Unsave"), so voice control can use the word on screen (WCAG 2.5.3).
"Matched by", "Seen in scrapes" and "role confidence" appear only under the admin-only "Technical details". The
admin-only Settings panels (Companies, System, Access, Metrics) are for the operator and may use pipeline words (run,
scrape, publish).

## Icons

One meaning per icon (`components/common/icons.jsx`):

| Icon | Means |
|---|---|
| bookmark (filled when saved) | Save / Unsave |
| check-circle (filled green when applied) | Mark applied / Undo applied |
| eye-off | Hide |
| ✕ | Close, dismiss, or remove a chip. Never Hide |
| external link | Open the posting |
| mute | Unmute (in the muted view) |
| note | The job has a note |
| download | Export CSV |
