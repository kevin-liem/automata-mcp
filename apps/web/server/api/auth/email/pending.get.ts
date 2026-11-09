/** The email change policy and any address waiting on verification for Profile. */
export default defineEventHandler(async (event) => {
  const user = await requireSessionUser(event)
  const disabled = emailChangeDisabled()
  return {
    emailChangeDisabled: disabled,
    pendingEmail: disabled ? null : (await pendingEmailChange(user.id)) ?? null,
  }
})
