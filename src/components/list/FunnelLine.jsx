import { useId, useState } from 'react'
import { funnelText, replyRate } from '../../utils/tracker'
import { sourceLabel } from '../../utils/sources'
import { ChevronDownIcon, ChevronUpIcon } from '../common/icons'

const FUNNEL_TITLE = 'Replied = heard back at all (Interviewing, Offer or Rejected). Follows your filters.'
const BREAKDOWN_MIN_OUTCOMES = 10 // below this the per-source and per-role rates are noise

const rate = (row) => {
  const value = replyRate(row)
  return value === null ? '–' : `${value}%`
}

function BreakdownTable({ caption, label, rows, name }) {
  if (!rows?.length) return null
  return (
    <table className="funnel-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{label}</th>
          <th scope="col">Applied</th>
          <th scope="col">Replied</th>
          <th scope="col">Rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={name(row)}>
            <th scope="row">{name(row)}</th>
            <td>{Number(row.applied) || 0}</td>
            <td>{Number(row.replied) || 0}</td>
            <td>{rate(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// The personal funnel above the Applied tab's stage chips: "138 applied → 4 replies (3%) → 2 interviews → 1 offer ·
// median reply 6 d" (summary.funnel, so it follows the filters, scope and search), then the "Weekly check-in" button
// (opens the sheet by hand; disabled while nothing qualifies). With 10 or more recorded outcomes, "By source and role"
// shows the reply rate per source and per role (the top 5 of each). Hidden while the summary has no funnel (an older
// API) or nothing is applied.
export function FunnelLine({ funnel, checkinTotal = 0, checkinBusy = false, onCheckin }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const text = funnelText(funnel)
  if (!text) return null
  const breakdown = Number(funnel.outcomes) >= BREAKDOWN_MIN_OUTCOMES
    && (funnel.by_source?.length > 0 || funnel.by_role?.length > 0)
  const nothing = !(Number(checkinTotal) > 0)

  return (
    <section className="funnel-line" aria-label="Your applications">
      <div className="funnel-head">
        <p className="funnel-text" title={FUNNEL_TITLE}>{text}</p>
        {breakdown && (
          <button
            type="button"
            className="text-button funnel-toggle"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={() => setOpen(!open)}
          >
            By source and role {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
        )}
        <button
          type="button"
          className="btn sm checkin-open"
          onClick={onCheckin}
          aria-disabled={nothing || undefined}
          disabled={checkinBusy}
          title={nothing ? 'Nothing to check: every application had an update this week' : 'How did last week go? One tap per application'}
        >
          Weekly check-in
        </button>
      </div>
      {breakdown && open && (
        <div className="funnel-breakdown" id={bodyId}>
          <BreakdownTable caption="Replies by source" label="Source" rows={funnel.by_source} name={row => sourceLabel(row.source)} />
          <BreakdownTable caption="Replies by role" label="Role" rows={funnel.by_role} name={row => row.role} />
        </div>
      )}
    </section>
  )
}
