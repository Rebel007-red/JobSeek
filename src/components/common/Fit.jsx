import { FIT_PARTS, fitLabel, fitTone } from '../../utils/gold'
import { FIT_POINTS_MAX, fitBars, fitPoints } from '../../utils/fit'

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

// fitPoints() names the parts role / skills / experience
const POINT_NAMES = { fit_role: 'role', fit_skills: 'skills', fit_experience: 'experience' }

// The bar's colour: the share of the part's points, toned like a score
const barTone = (share) => fitTone(Math.round(share * 100))

// The fit score as three bars of points that add up to it (fit.js fitPoints): "Role 40/40 · Matches your #1 role, …".
// compact (cards): bars and short labels only. Otherwise profile gives the reasons, and slots ({ [part key]: node })
// renders extra content right under a bar (the drawer puts the skills gap under the skills bar).
export function FitBreakdown({ job, compact = false, profile, slots }) {
  const hasAny = FIT_PARTS.some(part => job[part.key] !== null && job[part.key] !== undefined)
  if (!hasAny) return null

  if (compact) {
    const points = fitPoints(job)
    return (
      <div className="fit-breakdown compact">
        {FIT_PARTS.map(part => {
          const max = FIT_POINTS_MAX[part.key]
          const value = points ? points[POINT_NAMES[part.key]] : Math.round(Math.max(0, Math.min(1, Number(job[part.key]) || 0)) * max)
          const share = max ? value / max : 0
          return (
            <div key={part.key} className="fit-part" title={`${part.label} ${value}/${max} points`}>
              <div className="fit-bar" aria-hidden="true">
                <i style={{ width: `${Math.round(share * 100)}%` }} className={barTone(share)} />
              </div>
              <small>{part.short}</small>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="fit-breakdown">
      {fitBars(job, profile).map(bar => (
        <div key={bar.key} className="fit-part">
          <p className="fit-part-text">
            <strong>{bar.label}{bar.points !== null && ` ${bar.points}/${bar.max}`}</strong>
            {bar.reason && <span> · {bar.reason}</span>}
          </p>
          <div className="fit-bar" role="presentation">
            <i style={{ width: `${Math.round(bar.share * 100)}%` }} className={barTone(bar.share)} />
          </div>
          {slots?.[bar.key]}
        </div>
      ))}
    </div>
  )
}
