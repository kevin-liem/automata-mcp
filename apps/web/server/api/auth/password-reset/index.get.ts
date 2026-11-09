/**
 * Whether "Forgot password?" can work here: it needs mail. Public, so the page
 * can say plainly that this deployment cannot reset passwords rather than
 * taking an address and failing.
 */
export default defineEventHandler(() => {
  return { available: passwordResetAvailable() }
})
