import { STATUS_LABELS } from '../../utils/gold'
import { DownloadIcon } from '../common/icons'

const NEEDS_ACTION_TITLE = 'Your follow-up date came, an interview with no update for 7 days, or an application with no update for 14 days'
// The stage chips after Needs action and Waiting (plain Applied), in pipeline order
const STAGES = ['interviewing', 'offer', 'no_response', 'rejected', 'withdrawn']
const CLEAR = { needsAction: false, stage: '', followUp: false, closed: '' }

// The Applied tab's chips: Needs action · Waiting · Interviewing · Offer · No reply · Rejected · Withdrawn · Any stage
// (the default, active when no chip is) · Export CSV (last). Counts from the summary (needs_action, stages, applied; '–'
// until it arrives or when an older API lacks the key). Each chip sets one of needsAction / stage and clears the
// others; tapping the active one (or Any stage) clears it. An older link's Follow up (followUp=1) or Older postings
// (closed=only) shows as an active chip of its own, and tapping it clears it. onExport downloads the CSV.
export function StageChips({ summary, filters, onChange, onExport, exporting = false }) {
  const ready = summary.applied !== undefined && summary.applied !== null
  const count = (value) => (ready && value !== undefined && value !== null ? Number(value) : '–')
  const stages = summary.stages || {}
  const none = !filters.needsAction && !filters.stage && !filters.followUp && !filters.closed
  const chips = [
    {
      key: 'needsAction',
      label: 'Needs action',
      count: count(summary.needs_action),
      active: Boolean(filters.needsAction),
      title: NEEDS_ACTION_TITLE,
      patch: { ...CLEAR, needsAction: !filters.needsAction },
      tone: Number(summary.needs_action) > 0 ? 'warning' : '',
    },
    {
      key: 'applied',
      label: 'Waiting',
      count: count(stages.applied),
      active: filters.stage === 'applied',
      title: 'Applied, no reply yet',
      patch: { ...CLEAR, stage: filters.stage === 'applied' ? '' : 'applied' },
    },
    ...STAGES.map(stage => ({
      key: stage,
      label: STATUS_LABELS[stage],
      count: count(stages[stage]),
      active: filters.stage === stage,
      patch: { ...CLEAR, stage: filters.stage === stage ? '' : stage },
    })),
    ...(filters.followUp ? [{
      key: 'followUp', label: 'Follow up', count: count(summary.follow_up), active: true,
      title: 'From an older link: applied with no update for 14 days, or your follow-up date has come. Tap to clear',
      patch: CLEAR,
    }] : []),
    ...(filters.closed === 'only' ? [{
      key: 'closed', label: 'Older postings', count: count(summary.closed), active: true,
      title: 'From an older link: applications to postings over 7 days old. They may still be open. Tap to clear',
      patch: CLEAR,
    }] : []),
    { key: 'any', label: 'Any stage', count: count(summary.applied), active: none, patch: CLEAR },
  ]

  return (
    <section className="stage-row" aria-label="Application stages">
      <div className="stage-chips" role="group" aria-label="Filter by stage">
        {chips.map(chip => (
          <button
            key={chip.key}
            type="button"
            className={`pill-toggle ${chip.active ? 'active' : ''} ${chip.tone ? `tone-${chip.tone}` : ''}`}
            aria-pressed={chip.active}
            title={chip.title}
            onClick={() => onChange(chip.patch)}
          >
            {chip.label} <span className="chip-count">{chip.count}</span>
          </button>
        ))}
        <button
          type="button"
          className="icon-btn export-btn"
          onClick={onExport}
          disabled={exporting}
          aria-label={exporting ? 'Exporting…' : 'Export CSV'}
          title="Your saved and applied jobs with notes, as a spreadsheet"
        >
          <DownloadIcon />
        </button>
      </div>
    </section>
  )
}
