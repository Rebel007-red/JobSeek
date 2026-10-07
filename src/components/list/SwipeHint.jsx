import { useState } from 'react'
import { readSwipeHintSeen, saveSwipeHintSeen } from '../../utils/viewPref'
import { CloseIcon } from '../common/icons'

const isTouch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches

// A one-time tip on touch devices; dismissed for good on this device
export function SwipeHint() {
  const [show, setShow] = useState(() => isTouch() && !readSwipeHintSeen())
  if (!show) return null
  const dismiss = () => {
    saveSwipeHintSeen()
    setShow(false)
  }
  return (
    <div className="swipe-tip" role="note">
      <span>Tip: swipe right to mark applied, left to hide</span>
      <button type="button" className="icon-btn" onClick={dismiss} aria-label="Dismiss tip" title="Got it">
        <CloseIcon />
      </button>
    </div>
  )
}
