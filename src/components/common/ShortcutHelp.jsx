import { useRef } from 'react'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { CloseIcon } from './icons'

const GROUPS = [
  {
    title: 'Navigate',
    keys: [
      [['j'], 'Next job'],
      [['k'], 'Previous job'],
      [['Enter'], 'Open details'],
      [['Esc'], 'Close / leave search'],
    ],
  },
  {
    title: 'Act on selected job',
    keys: [
      [['o'], 'Open posting in new tab'],
      [['a'], 'Toggle applied'],
      [['x'], 'Hide job'],
      [['u'], 'Undo last action'],
    ],
  },
  {
    title: 'View',
    keys: [
      [['/'], 'Search'],
      [['1'], 'All jobs'],
      [['2'], 'To apply'],
      [['3'], 'Applied'],
      [['v'], 'Toggle list / grid'],
      [['r'], 'Refresh data from Databricks'],
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
                {group.keys.map(([keys, label]) => (
                  <div key={label}>
                    <dt>{keys.map(key => <kbd key={key}>{key}</kbd>)}</dt>
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
