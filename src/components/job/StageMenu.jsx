import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { APPLIED_STATUSES, statusLabel } from '../../utils/gold'
import { FOLLOWED_UP_LABEL, SNOOZE_STAGES, askAgainDay, suggestedStage } from '../../utils/tracker'
import { CheckIcon, ChevronDownIcon } from '../common/icons'
import { isMobile } from './dates'

const MENU_WIDTH = 220
const MENU_GAP = 4 // between the button and the popover
const EDGE = 8 // the popover keeps this far from the window's edges

// The menu's clicks, keys and touches stay away from the row around it (the row opens on click and Enter and swipes on
// touch; React passes events from the portal up through the row too)
const stop = (e) => e.stopPropagation()
// The button lets Tab through (the drawer's focus trap) and Escape (closes the drawer or clears the selection)
const stopKey = (e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation() }

const statusOf = (job) => job?.application_status || (job?.is_applied ? 'applied' : 'not_applied')

const SNOOZE = 'snooze' // the menu's last item, under a separator, when the button has onSnooze

// Where the popover goes: under the button, or above it when there is no room below; inside the window horizontally
function popoverPlace(anchor, menu) {
  const rect = anchor.getBoundingClientRect()
  const height = menu?.offsetHeight || 0
  const width = menu?.offsetWidth || MENU_WIDTH
  const below = rect.bottom + MENU_GAP
  const top = below + height > window.innerHeight - EDGE && rect.top - MENU_GAP - height >= EDGE
    ? rect.top - MENU_GAP - height
    : below
  const left = Math.min(Math.max(EDGE, rect.left), Math.max(EDGE, window.innerWidth - width - EDGE))
  return { top, left }
}

// The open menu: a popover anchored to the button on desktop, a bottom sheet on phones (the MOBILE query).
// Up / Down / Home / End move, Enter / Space pick, 1-6 pick that item, Esc and Tab close; a press outside closes it too,
// and the popover follows its button when the page scrolls. onPick(status) picks; onClose(refocus) closes (refocus: give
// the button its focus back). snooze: also offer "Followed up · ask again in 7 days" (onPick('snooze')) under a separator.
function StageMenuList({ anchorRef, current, suggested, snooze = false, onPick, onClose }) {
  const titleId = useId()
  const menuRef = useRef(null)
  const itemRefs = useRef([])
  const [sheet] = useState(isMobile)
  const [place, setPlace] = useState(null)
  const entries = snooze ? [...APPLIED_STATUSES, SNOOZE] : APPLIED_STATUSES
  const startIndex = Math.max(APPLIED_STATUSES.indexOf(current), 0)
  const [active, setActive] = useState(startIndex)

  useLayoutEffect(() => {
    if (!sheet && anchorRef.current) setPlace(popoverPlace(anchorRef.current, menuRef.current))
  }, [sheet, anchorRef])

  // Focus follows the active item; once more when the popover is first placed (it renders off screen until then)
  const placed = sheet || place !== null
  useEffect(() => {
    itemRefs.current[active]?.focus({ preventScroll: true })
  }, [active, placed])

  useEffect(() => {
    // On phones the sheet's backdrop covers the page and closes it on its own click: closing on the press would let the
    // tap's click land on the row underneath (and open it)
    const outside = (e) => {
      if (sheet || menuRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return
      onClose(false)
    }
    // The popover follows its button when the page or the list scrolls, and closes once the button is out of view
    const follow = (e) => {
      if (sheet || menuRef.current?.contains(e?.target)) return
      const anchor = anchorRef.current
      const rect = anchor?.getBoundingClientRect()
      if (!anchor?.isConnected || !rect || rect.bottom < 0 || rect.top > window.innerHeight) {
        onClose(false)
        return
      }
      setPlace(popoverPlace(anchor, menuRef.current))
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [onClose, anchorRef, sheet])

  const onKeyDown = (e) => {
    e.stopPropagation()
    const last = entries.length - 1
    let next = null
    if (e.key === 'ArrowDown') next = active >= last ? 0 : active + 1
    else if (e.key === 'ArrowUp') next = active <= 0 ? last : active - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next !== null) {
      e.preventDefault()
      setActive(next)
      return
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      onClose(true)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick(entries[active])
      return
    }
    const digit = Number(e.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= APPLIED_STATUSES.length) {
      e.preventDefault()
      onPick(APPLIED_STATUSES[digit - 1])
    }
  }

  const items = (
    <div
      ref={menuRef}
      className={`stage-menu ${sheet ? 'is-sheet' : 'is-popover'}`}
      role="menu"
      aria-labelledby={titleId}
      style={sheet ? undefined : { top: place?.top ?? -9999, left: place?.left ?? -9999 }}
      onKeyDown={onKeyDown}
      onClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
    >
      {sheet && <span className="stage-menu-grip" aria-hidden="true" />}
      <p className="stage-menu-title" id={titleId}>Move to</p>
      {APPLIED_STATUSES.map((status, index) => {
        const checked = status === current
        const isSuggested = status === suggested && !checked
        return (
          <button
            key={status}
            ref={el => { itemRefs.current[index] = el }}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            tabIndex={index === active ? 0 : -1}
            className={`stage-menu-item stage-${status} ${checked ? 'is-current' : ''} ${isSuggested ? 'is-suggested' : ''}`}
            onClick={() => onPick(status)}
            onFocus={() => setActive(index)}
          >
            <span className="stage-menu-check" aria-hidden="true">{checked && <CheckIcon />}</span>
            <span className="stage-menu-label">{statusLabel(status)}{isSuggested && ' · suggested'}</span>
            <kbd className="hide-mobile" aria-hidden="true">{index + 1}</kbd>
          </button>
        )
      })}
      {snooze && (
        <>
          <span className="stage-menu-sep" role="separator" />
          <button
            ref={el => { itemRefs.current[APPLIED_STATUSES.length] = el }}
            type="button"
            role="menuitem"
            tabIndex={active === APPLIED_STATUSES.length ? 0 : -1}
            className="stage-menu-item stage-menu-snooze"
            title="Keep the stage and set the follow-up date a week out"
            onClick={() => onPick(SNOOZE)}
            onFocus={() => setActive(APPLIED_STATUSES.length)}
          >
            <span className="stage-menu-check" aria-hidden="true" />
            <span className="stage-menu-label">{FOLLOWED_UP_LABEL}</span>
          </button>
        </>
      )}
    </div>
  )

  return createPortal(
    sheet ? (
      <div className="stage-menu-root" onClick={stop} onTouchStart={stop}>
        <div className="stage-menu-backdrop" aria-hidden="true" onClick={() => onClose(true)} />
        {items}
      </div>
    ) : items,
    document.body,
  )
}

// A button that opens the stage menu: the applied stages (Applied, Interviewing, Offer, No reply, Rejected, Withdrawn),
// the current one checked and the suggested one marked " · suggested". onChange(status) runs only on a real change.
// label: the button's text ("Move to…" in the bulk bar); ariaLabel names what a press does; size 'sm' | 'md'.
// onSnooze(nextActionAt): also offer "Followed up · ask again in 7 days" (the follow-up date a week out, tracker.js
// askAgainDay), so a Needs-action row is dealt with from the list.
export function StageMenuButton({ label, current = null, suggested = null, onChange, onSnooze = null, size = 'sm', ariaLabel, className = '', disabled = false, title }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)

  // Stable, so the open menu's listeners are bound once
  const close = useCallback((refocus) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus({ preventScroll: true })
  }, [])

  const pick = (status) => {
    close(true)
    if (status === SNOOZE) onSnooze?.(askAgainDay())
    else if (status !== current) onChange?.(status)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`stage-menu-button ${size} ${className}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen(value => !value) }}
        onKeyDown={(e) => {
          stopKey(e)
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
        onTouchStart={stop}
      >
        <span className="stage-menu-button-label">{label}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <StageMenuList anchorRef={buttonRef} current={current} suggested={suggested} snooze={Boolean(onSnooze)} onPick={pick} onClose={close} />
      )}
    </>
  )
}

// The stage of one application as a pill (Applied-tab rows): its label toned by stage; the menu suggests No reply 21
// days after applying with no update (tracker.js suggestedStage). onChange(status) on a real change; onSnooze(nextActionAt)
// adds "Followed up · ask again in 7 days" for the stages a follow-up date can make Needs action.
export function StagePill({ job, onChange, onSnooze = null, size = 'sm' }) {
  const current = statusOf(job)
  const label = statusLabel(current)
  return (
    <StageMenuButton
      label={label}
      current={current}
      suggested={suggestedStage(job)}
      onChange={onChange}
      onSnooze={onSnooze && SNOOZE_STAGES.includes(current) ? onSnooze : null}
      size={size}
      ariaLabel={`${label}. Change stage`}
      title="Change stage"
      className={`stage-pill stage-${current}`}
    />
  )
}
