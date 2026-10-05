import { CheckIcon, CloseIcon } from './icons'

const TOAST_ICONS = { success: CheckIcon, danger: CloseIcon }

// toast: { message, undo, tone } from useToast()
export function Toast({ toast, onUndo }) {
  const Icon = TOAST_ICONS[toast.tone]
  return (
    <div className={`toast ${toast.tone || ''}`} role="status">
      {Icon && <Icon />}
      <span>{toast.message}</span>
      {toast.undo && (
        <button type="button" onClick={onUndo}>Undo <kbd>u</kbd></button>
      )}
    </div>
  )
}
