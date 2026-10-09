import { useSwipe } from '../../hooks/useSwipe'
import { BookmarkIcon, CheckCircleIcon, ChevronUpIcon, EyeOffIcon } from './icons'

const HINT_ICONS = { save: BookmarkIcon, applied: CheckCircleIcon, stage: ChevronUpIcon, hide: EyeOffIcon, unsave: BookmarkIcon }

function Hint({ side, hint }) {
  const Icon = HINT_ICONS[hint.action]
  return (
    <span className={`swipe-hint is-${side} tone-${hint.tone || 'success'}`} aria-hidden="true">
      {side === 'right' ? <>{Icon && <Icon />} {hint.label}</> : <>{hint.label} {Icon && <Icon />}</>}
    </span>
  )
}

// Touch swipe wrapper. right / left: null (no swipe that way) or { action, label, tone } from listState swipeActions;
// onRight / onLeft run the action. The hint under the item names the action in the colour of its toast (Save primary,
// applied success, hide danger). peek: the one-time demo (the item slides right, then left, showing both hints; it is a
// CSS animation, skipped under "reduce motion"), onPeekEnd when it is over. leaving: the exit slide + collapse after a
// write took the item off the list (JobsPage removes it 160 ms later).
export function Swipeable({ right = null, left = null, onRight, onLeft, peek = false, onPeekEnd, leaving = false, children }) {
  const { offset, armed, handlers } = useSwipe({ onLeft: left ? onLeft : undefined, onRight: right ? onRight : undefined })
  const direction = offset > 0 ? 'to-right' : offset < 0 ? 'to-left' : ''
  const tone = offset > 0 ? right?.tone : offset < 0 ? left?.tone : ''

  return (
    <div
      className={['swipe-wrap', direction, tone ? `tone-${tone}` : '', armed ? 'armed' : '', peek ? 'is-peeking' : '', leaving ? 'is-leaving' : '']
        .filter(Boolean).join(' ')}
      onAnimationEnd={(e) => { if (peek && e.target === e.currentTarget.lastElementChild) onPeekEnd?.() }}
    >
      {offset > 0 && right && <Hint side="right" hint={right} />}
      {offset < 0 && left && <Hint side="left" hint={left} />}
      {peek && offset === 0 && (
        <span className="swipe-peek" aria-hidden="true">
          {right ? <Hint side="right" hint={right} /> : <span />}
          {left ? <Hint side="left" hint={left} /> : <span />}
        </span>
      )}
      <div className="swipe-body" style={offset ? { transform: `translateX(${offset}px)` } : undefined} {...handlers}>
        {children}
      </div>
    </div>
  )
}
