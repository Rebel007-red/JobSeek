import { StageMenuButton } from '../job/StageMenu'

// The sticky bar while jobs are selected: "N selected · Save · Mark applied · Hide · Clear" (also s, a, x and Esc). On
// the Applied tab (onMove given) Save and Mark applied give way to "Move to…", the stage menu of the rows' pills
// (onMove(status)), with "Followed up · ask again in 7 days" (onSnooze(nextActionAt)) at its end. The count is read out by the page's always-mounted live region (a region mounted with its text is
// not announced).
export function BulkBar({ count, busy = false, onSave, onApplied, onHide, onClear, onMove = null, onSnooze = null }) {
  return (
    <div className="bulk-bar" role="region" aria-label="Selected jobs">
      <span className="bulk-count">{count} selected</span>
      {onMove ? (
        <StageMenuButton label="Move to…" onChange={onMove} onSnooze={onSnooze} disabled={busy} />
      ) : (
        <>
          <button type="button" className="btn sm" onClick={onSave} disabled={busy} title="Save (s)">Save</button>
          <button type="button" className="btn sm" onClick={onApplied} disabled={busy} title="Mark applied (a)">Mark applied</button>
        </>
      )}
      <button type="button" className="btn sm danger" onClick={onHide} disabled={busy} title="Hide (x)">Hide</button>
      <button type="button" className="text-button" onClick={onClear} title="Clear the selection (Esc)">Clear</button>
    </div>
  )
}
