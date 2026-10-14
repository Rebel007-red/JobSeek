import { Fragment, useRef } from 'react'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { CloseIcon } from './icons'

// Every key the jobs page handles (JobsPage useHotkeys) and the weekly check-in sheet's own keys. A third item joins the
// keys of a range ('1-5') or a pair ('j / k')
const GROUPS = [
  {
    title: 'Navigate',
    keys: [
      [['j'], 'Next job'],
      [['k'], 'Previous job'],
      [['g'], 'First job'],
      [['G'], 'Last loaded job'],
      [['Enter'], 'Open details'],
      [['Esc'], 'Close / clear the selection / leave search'],
    ],
  },
  {
    title: 'Act on selected job',
    keys: [
      [['o'], 'Open the posting in a new tab'],
      [['a'], 'Mark applied / Undo applied'],
      [['s'], 'Save / Unsave'],
      [['t'], 'Stage of the open job'],
      [['x'], 'Hide'],
      [['u'], 'Undo (up to 5 steps)'],
    ],
  },
  {
    title: 'Did you apply?',
    keys: [
      [['a'], 'Yes, applied'],
      [['s'], 'Save for later'],
      [['Esc'], 'Not yet'],
    ],
  },
  {
    title: 'Weekly check-in',
    keys: [
      [['1', '5'], 'Answer', '-'],
      [['j', 'k'], 'Move', '/'],
      [['u'], 'Undo the last answer'],
      [['Esc'], 'Close'],
    ],
  },
  {
    title: 'Select several',
    keys: [
      [['Space'], 'Select / unselect job'],
      [['J'], 'Extend selection down'],
      [['K'], 'Extend selection up'],
      [['s', 'a', 'x'], 'Save, mark applied or hide the selection'],
    ],
  },
  {
    title: 'View',
    keys: [
      [['/'], 'Search'],
      [['f'], 'Filters'],
      [['1', '2', '3'], 'Inbox, Saved, Applied'],
      [['v'], 'List / Cards view'],
      [['r'], 'Refresh data'],
      [['?'], 'This help'],
    ],
  },
]

export function ShortcutHelp({ onClose }) {
  const closeRef = useRef(null)
  const panelRef = useRef(null)
  useDialogFocus(panelRef, closeRef)

  return (
    <div className="modal-root" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <div className="modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal-panel shortcut-panel" ref={panelRef}>
        <div className="modal-header">
          <h2 id="shortcut-title">Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close shortcuts">
            <CloseIcon />
          </button>
        </div>
        <div className="shortcut-groups">
          {GROUPS.map(group => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.keys.map(([keys, label, joiner]) => (
                  <div key={label}>
                    <dt>
                      {keys.map((key, index) => (
                        <Fragment key={key}>
                          {joiner && index > 0 && <span className="kbd-joiner">{joiner}</span>}
                          <kbd>{key}</kbd>
                        </Fragment>
                      ))}
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
