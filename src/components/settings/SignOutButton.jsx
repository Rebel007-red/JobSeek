import { useEffect, useRef, useState } from 'react'
import { signOut } from '../../lib/api'
import { SignOutIcon } from '../common/icons'

// Sign out behind a confirm step ("Sign out?" Yes / Cancel). variant 'icon': the top bar button, the question opens
// under it; 'button': a labelled button with the question inline (Account tab).
export function SignOutButton({ variant = 'button' }) {
  const [confirming, setConfirming] = useState(false)
  const triggerRef = useRef(null)
  const boxRef = useRef(null)

  const cancel = (refocus = true) => {
    setConfirming(false)
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  // A press outside the question closes it. (Not a blur check: Safari does not focus buttons on click, so a blur would
  // close the question before "Yes" receives its click.)
  useEffect(() => {
    if (!confirming) return undefined
    const onPointerDown = (e) => {
      if (!boxRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) setConfirming(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [confirming])

  const trigger = variant === 'icon' ? (
    <button ref={triggerRef} type="button" onClick={() => setConfirming(on => !on)} className={`icon-btn ${confirming ? 'is-on' : ''}`}
      title="Sign out" aria-label="Sign out" aria-expanded={confirming}>
      <SignOutIcon />
    </button>
  ) : (
    <button ref={triggerRef} type="button" onClick={() => setConfirming(true)} className="secondary-button" aria-expanded={confirming} hidden={confirming}>
      <SignOutIcon /> Sign out
    </button>
  )

  return (
    <div className={`signout ${variant === 'icon' ? 'signout-icon' : ''}`}>
      {trigger}
      {confirming && (
        <div
          ref={boxRef}
          className="inline-confirm signout-confirm"
          role="group"
          aria-label="Sign out?"
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              cancel()
            }
          }}
          // Tab moving focus past the buttons closes the question (relatedTarget is null for a click, handled above)
          onBlur={e => {
            if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== triggerRef.current) cancel(false)
          }}
        >
          <span>Sign out?</span>
          <button type="button" className="primary-button compact-button" onClick={signOut}>Yes</button>
          <button type="button" className="secondary-button compact-button" onClick={() => cancel()} autoFocus>Cancel</button>
        </div>
      )}
    </div>
  )
}
