/**
 * The organization, its members, and — for an admin — its pending invitations.
 *
 * A member gets the roster: who else is here and who the admins are, which is
 * what makes "ask an admin to assign you a connection" an actionable sentence
 * rather than a dead end. Pending invitations are admin-only: an unaccepted
 * invitation names an email address that has not yet agreed to be associated
 * with this organization.
 *
 * `toolCalls` goes to everyone: a member's calls are recorded too, and whether
 * they are is theirs to know.
 *
 * `passwordReset` tells an admin whether the Team page's "Send password reset"
 * can work here: it needs mail.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireMembership(event)
  const [members, invites, toolCalls] = await Promise.all([
    listOrgMembers(actor.org.id),
    actor.role === 'admin' ? listPendingInvites(actor.org.id) : undefined,
    loadToolCallSetting(actor.org.id),
  ])

  return {
    org: { id: actor.org.id, name: actor.org.name },
    role: actor.role,
    members,
    invites,
    toolCalls,
    passwordReset: actor.role === 'admin' ? passwordResetAvailable() : undefined,
  }
})
