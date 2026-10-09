import { useId, useRef, useState } from 'react'

const MAX_NEAREST = 3

// Tag input: Enter or comma adds, × removes, suggestions via <datalist>.
// resolve(text) -> { value } for a known entry (stored in the list's spelling), { blocked: message } for a refused one,
// or null when unknown. Unknown entries need confirming ("add as my own") and must pass validate(text) -> '' | problem.
// noteFor(value) -> optional short status shown on the chip (e.g. for entries the user added themselves).
// Without resolve, every entry is added as typed (after validate) and suggestions only autocomplete.
// A full list (maxItems) hides the input and says "Remove one to add another". id: the wrapper's id (a link anchor such
// as /settings?tab=profile#roles).
export function ChipInput({ id, label, values, onChange, suggestions = [], resolve, validate, noteFor, placeholder, help, maxItems = 50, numbered = false, disabled = false }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(null) // { text, nearest }
  const chipsRef = useRef(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const inputId = `${baseId}-input`
  const helpId = `${baseId}-help`
  const errorId = `${baseId}-error`
  const full = values.length >= maxItems
  const describedBy = [error && errorId, help && helpId].filter(Boolean).join(' ') || undefined

  const push = (value) => {
    setPending(null)
    setInput('')
    if (values.some(item => item.toLowerCase() === value.toLowerCase())) return
    onChange([...values, value])
    // The last free place: the input goes away, so focus moves to the new chip's remove button
    if (values.length + 1 >= maxItems) requestAnimationFrame(() => chipsRef.current?.querySelector('.skill-chip:last-child button')?.focus())
  }

  // The removed chip's button goes away; when the list was full the input comes back, so focus moves there
  const remove = (value) => {
    onChange(values.filter(item => item !== value))
    if (full) requestAnimationFrame(() => document.getElementById(inputId)?.focus())
  }

  const add = (raw) => {
    const text = raw.trim()
    setError('')
    setPending(null)
    if (!text || full) return
    if (!resolve) {
      const problem = validate ? validate(text) : ''
      if (problem) return setError(problem)
      return push(suggestions.find(item => item.toLowerCase() === text.toLowerCase()) || text)
    }
    const known = resolve(text)
    if (known?.blocked) return setError(known.blocked)
    if (known?.value) return push(known.value)
    const problem = validate ? validate(text) : ''
    if (problem) return setError(problem)
    const lower = text.toLowerCase()
    const nearest = suggestions.filter(item => item.toLowerCase().includes(lower) || lower.includes(item.toLowerCase())).slice(0, MAX_NEAREST)
    setPending({ text, nearest })
  }

  // A "Did you mean" suggestion goes through resolve too, so a refused entry (e.g. a skill in the other list) stays out
  const pick = (item) => {
    const known = resolve ? resolve(item) : null
    if (known?.blocked) {
      setPending(null)
      return setError(known.blocked)
    }
    push(known?.value || item)
  }

  return (
    <div id={id} className="settings-field settings-field-full chip-field">
      {full ? (
        // No input to label: the chips' remove buttons are what you can use
        <span className="chip-field-label" id={`${baseId}-label`}>{label}</span>
      ) : (
        <label htmlFor={inputId}>{label}</label>
      )}
      {full ? (
        <p className="chip-field-full">Remove one to add another</p>
      ) : (
        <div className="settings-input-row">
          <input
            id={inputId}
            type="text"
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            value={input}
            list={suggestions.length ? listId : undefined}
            onChange={e => {
              setInput(e.target.value)
              setPending(null)
              setError('')
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                add(input)
              } else if (e.key === 'Backspace' && !input && values.length) {
                onChange(values.slice(0, -1))
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="settings-input"
          />
          <button type="button" onClick={() => add(input)} className="secondary-button compact-button" disabled={disabled || !input.trim()}>Add</button>
        </div>
      )}
      {suggestions.length > 0 && !full && (
        <datalist id={listId}>
          {suggestions.map(item => <option key={item} value={item} />)}
        </datalist>
      )}
      {pending && (
        <div className="custom-confirm" role="alert">
          <span>
            &ldquo;{pending.text}&rdquo; is not in our list.
            {pending.nearest.length > 0 && ' Did you mean:'}
          </span>
          {pending.nearest.map(item => (
            <button key={item} type="button" className="pill-toggle" onClick={() => pick(item)}>{item}</button>
          ))}
          <button type="button" className="secondary-button compact-button" onClick={() => push(pending.text)}>
            Add &ldquo;{pending.text}&rdquo; as my own
          </button>
        </div>
      )}
      {error && <p id={errorId} className="settings-inline-error">{error}</p>}
      {help && <small id={helpId}>{help}</small>}
      {values.length > 0 && (
        <div ref={chipsRef} className="settings-skill-list" role={full ? 'group' : undefined} aria-labelledby={full ? `${baseId}-label` : undefined}>
          {values.map((value, index) => {
            const note = noteFor?.(value)
            return (
              <span key={value} className={`skill-chip ${note ? 'is-custom' : ''}`} title={note || undefined}>
                {numbered && <b>{index + 1}</b>}
                <span className="skill-chip-label">{value}</span>
                {note && <em>{note}</em>}
                <button type="button" onClick={() => remove(value)} aria-label={`Remove ${value}`} disabled={disabled}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
