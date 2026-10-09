// Short vibrations for swipes on phones: tick() when a swipe arms (let go now and it happens), thud() when it commits.
// Nothing happens under "reduce motion", without navigator.vibrate (iOS, desktops) or when the browser refuses.
const TICK_MS = 8
const THUD_MS = 18

function vibrate(ms) {
  try {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    globalThis.navigator?.vibrate?.(ms)
  } catch {
    // not allowed (no user gesture yet, iframe policy)
  }
}

export const tick = () => vibrate(TICK_MS)
export const thud = () => vibrate(THUD_MS)
