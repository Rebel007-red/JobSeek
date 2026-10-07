import { companyKey } from '../../utils/gold'

// "Not right for you?" under the fit: hide with a reason (kept as feedback for calibration) or mute the company.
// onHide(reason) hides the job; onMuteCompany() adds a company mute rule. muted: the company is muted already.
export function FitFeedback({ job, onHide, onMuteCompany, muted }) {
  const company = String(job.company_name || '').trim()
  const canMute = Boolean(company) && companyKey(company) !== ''
  return (
    <div className="fit-feedback" role="group" aria-label="Not right for you?">
      <span>Not right for you?</span>
      <button type="button" className="btn sm" onClick={() => onHide('wrong_role')} title="Hide it and note that the role is wrong">
        Wrong role
      </button>
      <button type="button" className="btn sm" onClick={() => onHide('too_senior')} title="Hide it and note that it is too senior">
        Too senior
      </button>
      {canMute && (
        <button
          type="button"
          className="btn sm"
          onClick={onMuteCompany}
          disabled={muted}
          title={muted ? `${company} is muted (Settings → Mute rules)` : `Leave ${company} jobs out of your lists, except ones you saved or applied to`}
        >
          {muted ? 'Company muted' : 'Mute this company'}
        </button>
      )}
    </div>
  )
}
