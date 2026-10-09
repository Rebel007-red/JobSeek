// The sticky bar while jobs are selected: "N selected · Save · Mark applied · Hide · Clear" (also s, a, x and Esc).
// The count is read out by the page's always-mounted live region (a region mounted with its text is not announced).
export function BulkBar({ count, busy = false, onSave, onApplied, onHide, onClear }) {
  return (
    <div className="bulk-bar" role="region" aria-label="Selected jobs">
      <span className="bulk-count">{count} selected</span>
      <button type="button" className="btn sm" onClick={onSave} disabled={busy} title="Save (s)">Save</button>
      <button type="button" className="btn sm" onClick={onApplied} disabled={busy} title="Mark applied (a)">Mark applied</button>
      <button type="button" className="btn sm danger" onClick={onHide} disabled={busy} title="Hide (x)">Hide</button>
      <button type="button" className="text-button" onClick={onClear} title="Clear the selection (Esc)">Clear</button>
    </div>
  )
}
