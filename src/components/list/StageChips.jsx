import { APPLIED_STATUSES, STATUS_LABELS } from '../../utils/gold'
import { DownloadIcon } from '../common/icons'

// The Applied tab's chips: All · each stage · Follow up · Older postings (last), with counts from the summary (stages,
// follow_up, closed). They set one of the stage / followUp / closed filters; All clears them. Older postings = closed
// 'only': applications to postings that left the job snapshot (over 2 days old), which may still be open. onExport
// downloads the CSV.
export function StageChips({ summary, filters, onChange, onExport, exporting = false }) {
  const ready = summary.applied !== undefined && summary.applied !== null
  const count = (value) => (ready ? Number(value ?? 0) : '–')
  const stages = summary.stages || {}
  const none = !filters.stage && !filters.followUp && !filters.closed
  const chips = [
    { key: 'all', label: 'All', count: count(summary.applied), active: none, patch: { stage: '', followUp: false, closed: '' } },
    ...APPLIED_STATUSES.map(stage => ({
      key: stage,
      label: STATUS_LABELS[stage],
      count: count(stages[stage]),
      active: filters.stage === stage,
      patch: { stage: filters.stage === stage ? '' : stage, followUp: false, closed: '' },
    })),
    {
      key: 'followUp',
      label: 'Follow up',
      count: count(summary.follow_up),
      active: filters.followUp,
      title: 'Applied with no update for 14 days, or your follow-up date has come',
      patch: { stage: '', followUp: !filters.followUp, closed: '' },
    },
    {
      key: 'closed',
      label: 'Older postings',
      count: count(summary.closed),
      active: filters.closed === 'only',
      title: 'Applications to postings over 2 days old; they may still be open',
      patch: { stage: '', followUp: false, closed: filters.closed === 'only' ? '' : 'only' },
    },
  ]

  return (
    <section className="stage-row" aria-label="Application stages">
      <div className="stage-chips" role="group" aria-label="Filter by stage">
        {chips.map(chip => (
          <button
            key={chip.key}
            type="button"
            className={`pill-toggle ${chip.active ? 'active' : ''}`}
            aria-pressed={chip.active}
            title={chip.title}
            onClick={() => onChange(chip.patch)}
          >
            {chip.label} <span className="chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      <button type="button" className="btn sm export-btn" onClick={onExport} disabled={exporting} title="Your saved and applied jobs with notes, as a spreadsheet">
        <DownloadIcon /> {exporting ? 'Exporting…' : 'Export CSV'}
      </button>
    </section>
  )
}
