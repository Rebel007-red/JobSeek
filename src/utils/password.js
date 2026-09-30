export const MIN_PASSWORD_LENGTH = 8

// Rules for a new password (set-password page and forgot-password flow); '' when fine.
export function passwordProblem(password, confirm) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`
  if (password !== confirm) return 'Passwords do not match'
  return ''
}
