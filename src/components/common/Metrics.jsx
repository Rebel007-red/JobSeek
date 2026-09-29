import { useEffect, useRef, useState } from 'react'

const TIP_HALF_WIDTH_PX = 90 // keeps the readout on screen near the edges
const TIP_LINGER_MS = 1500

// 14-day "found per day" bars. Drag a finger (or move the mouse) across them to read each day; tap works too.
// Keyboard: focus it and use the arrow keys.
function Sparkline({ days }) {
  const barsRef = useRef(null)
  const hideTimer = useRef(null)
  const [tip, setTip] = useState(null) // { index, left, top }
  const max = Math.max(1, ...days.map(day => day.added))
  const total = days.reduce((sum, day) => sum + day.added, 0)

  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const show = (index) => {
    const rect = barsRef.current.getBoundingClientRect()
    const center = rect.left + ((index + 0.5) * rect.width) / days.length
    clearTimeout(hideTimer.current)
    setTip({
      index,
      left: Math.min(Math.max(center, TIP_HALF_WIDTH_PX), window.innerWidth - TIP_HALF_WIDTH_PX),
      top: rect.bottom + 10,
    })
  }

  const showAt = (clientX) => {
    const rect = barsRef.current.getBoundingClientRect()
    const index = Math.floor(((clientX - rect.left) / rect.width) * days.length)
    show(Math.min(days.length - 1, Math.max(0, index)))
  }

  const hideSoon = (delay = TIP_LINGER_MS) => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setTip(null), delay)
  }

  const day = tip ? days[tip.index] : null
  const isToday = tip && tip.index === days.length - 1

  return (
    <span
      className={`metric trend ${tip ? 'scrubbing' : ''}`}
      tabIndex={0}
      role="slider"
      aria-label={`Jobs found per day, last ${days.length} days (${total} total)`}
      aria-valuemin={1}
      aria-valuemax={days.length}
      aria-valuenow={(tip ? tip.index : days.length - 1) + 1}
      aria-valuetext={day ? `${isToday ? 'Today' : day.label}: ${day.added} found, ${day.applied} applied` : undefined}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        showAt(e.clientX)
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse' || e.buttons) showAt(e.clientX)
      }}
      onPointerUp={() => hideSoon()}
      onPointerCancel={() => hideSoon()}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') hideSoon(200) }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const from = tip ? tip.index : days.length - 1
        show(Math.min(days.length - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1))))
      }}
      onFocus={() => show(days.length - 1)}
      onBlur={() => hideSoon(0)}
    >
      <span className="sparkline" ref={barsRef}>
        {days.map((item, index) => (
          <i
            key={item.key}
            className={`${item.applied ? 'has-applied' : ''} ${tip?.index === index ? 'selected' : ''}`}
            style={{ height: `${Math.max(10, Math.round((item.added / max) * 100))}%` }}
          />
        ))}
      </span>
      {day && (
        <span className="spark-tip" style={{ left: tip.left, top: tip.top }} role="status">
          <b>{isToday ? 'Today' : day.label}</b> · {day.added} found · {day.applied} applied
        </span>
      )}
    </span>
  )
}

// items: [{ key, label, value, title, tone, active }] rendered as tappable counters, plus the found-per-day trend.
export function Metrics({ items, trend = [], onSelect }) {
  return (
    <div className="metrics" aria-label="Summary">
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          className={`metric ${item.tone || ''} ${item.active ? 'active' : ''}`}
          onClick={() => onSelect(item.key)}
          title={item.title}
          aria-pressed={item.active}
        >
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </button>
      ))}
      {trend.length > 0 && <Sparkline days={trend} />}
    </div>
  )
}
