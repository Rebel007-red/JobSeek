import { useId, useState } from 'react'

// Tag input: Enter or comma adds, × removes, suggestions via <datalist>.
export function ChipInput({ label, values, onChange, suggestions = [], placeholder, help, maxItems = 50, numbered = false }) {
  const [input, setInput] = useState('')
  const listId = useId()

  const add = (raw) => {
    const value = raw.trim()
    setInput('')
    if (!value || values.length >= maxItems) return
    if (values.some(item => item.toLowerCase() === value.toLowerCase())) return
    const canonical = suggestions.find(item => item.toLowerCase() === value.toLowerCase()) || value
    onChange([...values, canonical])
  }

  return (
    <div className="settings-field settings-field-full">
      <label>{label}</label>
      <div className="settings-input-row">
        <input
          type="text"
          value={input}
          list={suggestions.length ? listId : undefined}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add(input)
            } else if (e.key === 'Backspace' && !input && values.length) {
              onChange(values.slice(0, -1))
            }
          }}
          placeholder={placeholder}
          className="settings-input"
        />
        <button type="button" onClick={() => add(input)} className="secondary-button compact-button" disabled={!input.trim()}>Add</button>
      </div>
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map(item => <option key={item} value={item} />)}
        </datalist>
      )}
      {help && <small>{help}</small>}
      {values.length > 0 && (
        <div className="settings-skill-list">
          {values.map((value, index) => (
            <span key={value} className="skill-chip">
              {numbered && <b>{index + 1}</b>}
              {value}
              <button type="button" onClick={() => onChange(values.filter(item => item !== value))} aria-label={`Remove ${value}`}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
