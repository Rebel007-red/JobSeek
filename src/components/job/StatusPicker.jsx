import { STATUS_OPTIONS } from '../../utils/gold'

// Keeps the picker's own clicks, keys and touches away from the row around it (open on click, Enter, swipe).
// Escape and Tab still bubble, so Escape closes the drawer or clears the selection as usual and the drawer's focus
// trap still sees Tab.
const stop = (e) => e.stopPropagation()
const stopKey = (e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation() }

// The application status of one job (all 7 statuses, gold.js STATUS_OPTIONS). onChange(status) runs only on a real
// change. size: 'sm' (list rows) | 'md' (drawer). Used by the drawer and by the Applied tab's rows; ref reaches the
// <select> (the drawer focuses it for the t key).
export function StatusPicker({ status, onChange, size = 'md', disabled = false, id, ref }) {
  const value = STATUS_OPTIONS.some(option => option.value === status) ? status : 'not_applied'
  return (
    <select
      ref={ref}
      id={id}
      className={`status-picker ${size} status-${value}`}
      value={value}
      disabled={disabled}
      aria-label="Application status"
      title="Application status"
      onChange={(e) => { if (e.target.value !== value) onChange?.(e.target.value) }}
      onClick={stop}
      onKeyDown={stopKey}
      onTouchStart={stop}
    >
      {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}
