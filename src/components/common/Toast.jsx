import { CheckIcon, CloseIcon } from './icons'

const TOAST_ICONS = { success: CheckIcon, danger: CloseIcon }

// toast: { id, message, undo, tone, actions, offerUndo } from useToast(), or null. undoCount: steps left on the undo
// stack ("Undo (3)"); a toast with actions (hide reasons, "Mute <company>") keeps offering Undo while the action before
// it can be undone. Always rendered: the polite live region exists before a message arrives (screen readers miss
// regions inserted with their text), and a no-break space on every other toast lets the same message be read again.
export function Toast({ toast, onUndo, undoCount = 0 }) {
  const live = (
    <div className="sr-only" role="status" aria-live="polite">
      {toast ? `${toast.message}${toast.id % 2 ? ' ' : ''}` : ''}
    </div>
  )
  if (!toast) return live
  const Icon = TOAST_ICONS[toast.tone]
  const canUndo = Boolean(toast.undo) || ((Boolean(toast.actions) || toast.offerUndo) && undoCount > 0)
  return (
    <>
      {live}
      <div className={`toast ${toast.tone || ''} ${toast.actions ? 'has-actions' : ''}`}>
        {Icon && <Icon />}
        <span className="toast-message">{toast.message}</span>
        {toast.actions && (
          <span className="toast-actions">
            {toast.actions.map(action => (
              <button key={action.label} type="button" className="toast-action" onClick={action.onClick}>{action.label}</button>
            ))}
          </span>
        )}
        {canUndo && (
          <button type="button" onClick={onUndo}>{undoCount > 1 ? `Undo (${undoCount})` : 'Undo'} <kbd>u</kbd></button>
        )}
      </div>
    </>
  )
}
