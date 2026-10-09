import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MATCH_MIN_FIT } from '../../utils/gold'
import { scopeLabel, scopeMenuItems } from '../../utils/filters'
import { ChevronDownIcon } from '../common/icons'

// What each scope means (the glossary in DESIGN_SYSTEM.md, "Words")
const SCOPE_TITLES = {
  match: `For you: jobs in your roles or roles close to them, with fit ${MATCH_MIN_FIT}+, that don't ask for much more experience than you have`,
  all: 'Everything: every job, best fit first',
}

// "Which jobs": the scope (For you / Everything) and the time window of the Inbox, set together. Sits at the left end of
// the chip row on the Inbox only. value: { scope, postedWithin }; onChange gets the chosen { scope, postedWithin }.
// The three presets are always listed; any other state (from a link) shows as its own checked item. The menu is
// rendered into <body> (fixed, under its button), because the chip row scrolls sideways on phones and would clip it.
export function ScopeMenu({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState(null) // { top, left } of the menu
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()
  const items = scopeMenuItems(value)

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setPlace({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)) })
  }, [open])

  // Focus the checked item on open; close on a tap outside, scrolling, resizing or Esc (focus back on the button)
  useEffect(() => {
    if (!open) return undefined
    const menu = menuRef.current
    ;(menu?.querySelector('[aria-checked="true"]') || menu?.querySelector('[role="menuitemradio"]'))?.focus({ preventScroll: true })
    const close = () => setOpen(false)
    const onPointer = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) close()
    }
    const onScroll = (e) => { if (!menuRef.current?.contains(e.target)) close() }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, place])

  const choose = (item) => {
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
    if (!item.checked) onChange({ scope: item.scope, postedWithin: item.postedWithin })
  }

  const onMenuKey = (e) => {
    const options = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"]') || [])]
    const index = options.indexOf(document.activeElement)
    let next = null
    if (e.key === 'ArrowDown') next = options[(index + 1) % options.length]
    else if (e.key === 'ArrowUp') next = options[(index - 1 + options.length) % options.length]
    else if (e.key === 'Home') next = options[0]
    else if (e.key === 'End') next = options[options.length - 1]
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation() // the page's Esc (clear the selection) must not act too
      }
      // Tab goes on from the button (the menu sits at the end of <body>, so from there it would leave the page)
      buttonRef.current?.focus({ preventScroll: true })
      setOpen(false)
      return
    }
    if (!next) return
    e.preventDefault()
    next.focus()
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`pill-toggle scope-menu-button ${open ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Which jobs: ${SCOPE_TITLES[value.scope] || SCOPE_TITLES.match}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="sr-only">Which jobs: </span>
        {scopeLabel(value)}
        <ChevronDownIcon />
      </button>
      {open && place && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="scope-menu"
          role="menu"
          aria-label="Which jobs"
          style={{ top: place.top, left: place.left }}
          onKeyDown={onMenuKey}
        >
          <p className="scope-menu-title" aria-hidden="true">Which jobs</p>
          {items.map(item => (
            <button
              key={`${item.scope}-${item.postedWithin}`}
              type="button"
              role="menuitemradio"
              aria-checked={item.checked}
              className={`scope-menu-item ${item.checked ? 'is-checked' : ''}`}
              title={SCOPE_TITLES[item.scope]}
              tabIndex={-1}
              onClick={() => choose(item)}
            >
              <span className="scope-menu-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
