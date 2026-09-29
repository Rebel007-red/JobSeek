import { useSwipe } from '../../hooks/useSwipe'
import { CheckIcon, CloseIcon } from './icons'

// Touch swipe wrapper: right = onRight (mark applied), left = onLeft (hide). Omit a handler to disable that side.
// Colours, icons and wording match the undo toast shown after the action.
export function Swipeable({ onLeft, onRight, rightLabel = 'Mark as applied', leftLabel = 'Hide job', children }) {
  const { offset, armed, handlers } = useSwipe({ onLeft, onRight })
  const direction = offset > 0 ? 'to-right' : offset < 0 ? 'to-left' : ''

  return (
    <div className={`swipe-wrap ${direction} ${armed ? 'armed' : ''}`}>
      {offset !== 0 && (
        <span className="swipe-hint" aria-hidden="true">
          {offset > 0 ? <><CheckIcon /> {rightLabel}</> : <>{leftLabel} <CloseIcon /></>}
        </span>
      )}
      <div className="swipe-body" style={offset ? { transform: `translateX(${offset}px)` } : undefined} {...handlers}>
        {children}
      </div>
    </div>
  )
}
