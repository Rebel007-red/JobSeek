import { FIT_PARTS, fitLabel, fitTone } from '../../utils/gold'

export function FitRing({ score, size = 'md' }) {
  const tone = fitTone(score)
  const value = tone === 'none' ? 0 : Math.max(0, Math.min(100, Number(score)))
  return (
    <div
      className={`fit-ring ${tone} ${size}`}
      style={{ '--fit': value }}
      role="img"
      aria-label={tone === 'none' ? 'Fit not scored yet' : `${fitLabel(score)}: ${value} out of 100`}
      title={tone === 'none' ? 'Fit not scored yet' : `${fitLabel(score)} (${value}/100)`}
    >
      <span>{tone === 'none' ? '–' : value}</span>
    </div>
  )
}

// Compact numeric badge for list rows.
export function FitScore({ score }) {
  const tone = fitTone(score)
  const value = tone === 'none' ? null : Math.round(Math.max(0, Math.min(100, Number(score))))
  const label = value === null ? 'Fit not scored yet' : `${fitLabel(score)} (${value}/100)`
  return (
    <span className={`fit-score ${tone}`} title={label} aria-label={label}>
      {value ?? '–'}
    </span>
  )
}

// Component bars (role / skills / experience), each 0-1, with their fixed share of the score.
// reasons (optional, not in compact mode): { [part key]: text | [text, ...] } shown under each bar (fit.js fitReasons).
export function FitBreakdown({ job, compact = false, reasons }) {
  const hasAny = FIT_PARTS.some(part => job[part.key] !== null && job[part.key] !== undefined)
  if (!hasAny) return null

  return (
    <div className={`fit-breakdown ${compact ? 'compact' : ''}`}>
      {FIT_PARTS.map(part => {
        const value = Math.round(Math.max(0, Math.min(1, Number(job[part.key]) || 0)) * 100)
        const lines = compact ? [] : [reasons?.[part.key]].flat().filter(Boolean)
        return (
          <div key={part.key} className="fit-part" title={`${part.label}: ${value}%`}>
            {!compact && (
              <div className="fit-part-label">
                <span>{part.label}</span>
                <em>{value}% · weight {Math.round(part.weight * 100)}%</em>
              </div>
            )}
            <div className="fit-bar" aria-hidden={compact ? 'true' : undefined}>
              <i style={{ width: `${value}%` }} className={fitTone(value)} />
            </div>
            {compact && <small>{part.short}</small>}
            {lines.map(line => <p key={line} className="fit-reason">{line}</p>)}
          </div>
        )
      })}
    </div>
  )
}
