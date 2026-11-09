/**
 * Email a member of your organization a password reset.
 *
 * Admin only, checked here; a user outside the admin's organization answers
 * 404, like every other membership route. The mail goes to the member's stored
 * address and nothing in the request becomes a recipient or mail content — there
 * is no body to read. The admin never sees the link or the code and never sets
 * the password: the member chooses it from their own inbox, and the mail names
 * the organization so an unexpected reset is recognisable as one. Same row, TTL,
 * caps and ending as a self-service reset; a new one replaces any earlier one.
 *
 * A failed send is a 502: the reset was withdrawn, and the admin should know
 * the member has nothing to act on.
 *
 * No `hosted_events` row: the outbox has no type for it, and nothing consuming
 * it needs one.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireOrgAdmin(event)
  const member = await requireOrgMember(actor.org.id, getRouterParam(event, 'id'))

  const sent = await sendPasswordResetForMember(actor.user, { id: member.userId, email: member.email }, actor.org.name)
  if (!sent) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Could not send the email. Nothing was changed; try again later, or ask the operator to check mail delivery.',
    })
  }

  console.info(`[password-reset] admin ${actor.user.id} sent a password reset to member ${member.userId}`)
  return { sent: true }
})
