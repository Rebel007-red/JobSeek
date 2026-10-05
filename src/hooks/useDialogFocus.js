import { useEffect } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Modal focus: focuses initialRef on open, keeps Tab / Shift+Tab inside panelRef, and on close returns focus to
// restoreTarget() (when given and still in the page) or to whatever was focused before the dialog opened.
export function useDialogFocus(panelRef, initialRef, restoreTarget) {
  useEffect(() => {
    const previous = document.activeElement
    initialRef.current?.focus()

    const onKey = (e) => {
      const panel = panelRef.current
      if (e.key !== 'Tab' || !panel) return
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length > 0)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const inside = panel.contains(document.activeElement)
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const target = restoreTarget?.() || previous
      if (target?.isConnected && target !== document.body) target.focus?.({ preventScroll: true })
    }
  }, []) // once per open dialog; restoreTarget is called at close time
}
