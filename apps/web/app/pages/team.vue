<script setup lang="ts">
import { CheckIcon, KeyRoundIcon, MailIcon, PencilIcon, XIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * The organization: who is in it, who the admins are, and what is outstanding.
 *
 * Members see the roster and nothing else. That is deliberate rather than a
 * courtesy: "ask an admin to assign you a connection" is only actionable if you
 * can see which of your colleagues is an admin. Pending invitations stay
 * admin-only, because an unaccepted one names an address that has not agreed to
 * be associated with this organization yet.
 */
const { user, isAdmin, refresh: refreshSession } = useSession()

const { data, refresh, status } = await useFetch<OrgResponse>('/api/org')

const revealed = ref<RevealedInvite | null>(null)

const renaming = ref(false)
const draftName = ref('')
const { busy: renameBusy, run: runRename } = useApiAction()
const { busy: memberBusy, run: runMember } = useApiAction()

function startRename() {
  draftName.value = data.value?.org.name ?? ''
  renaming.value = true
}

async function saveName() {
  const name = draftName.value.trim()
  if (!name) return

  await runRename(async () => {
    await $fetch('/api/org', { method: 'PATCH', body: { name } })
    renaming.value = false
    await refresh()
    // The header renders the organization name off the session, not off this
    // page, so it would otherwise keep showing the old one until a reload.
    await refreshSession()
  }, { success: 'Organization renamed.', failure: 'Could not rename the organization' })
}

/**
 * Change a role, asking again if the server says tokens will die.
 *
 * Demoting an admin can break tokens: a member reaches only the connections
 * assigned to them, and an admin holds no assignments. The server refuses such a
 * demotion with a 409 and a count rather than doing it quietly — a token that
 * still reads "Active" while answering 401 on the wire is a support ticket with
 * nothing in the logs. The retry carries `revokeTokens`, which is this admin
 * saying yes to that specific consequence and not to a generic "are you sure".
 */
const pendingDemotion = ref<{ member: OrgMemberRow, role: OrgRole, message: string } | null>(null)

const demotionOpen = computed({
  get: () => Boolean(pendingDemotion.value),
  set: (value: boolean) => {
    if (!value) pendingDemotion.value = null
  },
})

function patchRole(member: OrgMemberRow, role: OrgRole, revokeTokens: boolean) {
  return $fetch<{ revokedTokens: number }>(`/api/org/members/${member.userId}`, {
    method: 'PATCH',
    body: { role, revokeTokens },
  })
}

async function announceRole(member: OrgMemberRow, role: OrgRole, revokedTokens: number) {
  await refresh()
  toast.success(revokedTokens
    ? `${member.email} is now a ${role}. ${revokedTokens} token(s) revoked.`
    : `${member.email} is now a ${role}.`)
}

async function setRole(member: OrgMemberRow, role: OrgRole) {
  await runMember(async () => {
    try {
      const result = await patchRole(member, role, false)
      await announceRole(member, role, result.revokedTokens)
    } catch (error) {
      const status = (error as { statusCode?: number, response?: { status?: number } })
      if ((status.statusCode ?? status.response?.status) !== 409) throw error

      pendingDemotion.value = {
        member,
        role,
        message: apiErrorMessage(error, 'This will revoke some connector tokens.'),
      }
    }
  }, { failure: 'Could not change the role' })
}

async function confirmDemotion() {
  const pending = pendingDemotion.value
  if (!pending) return
  pendingDemotion.value = null

  await runMember(async () => {
    const result = await patchRole(pending.member, pending.role, true)
    await announceRole(pending.member, pending.role, result.revokedTokens)
  }, { failure: 'Could not change the role' })
}

async function remove(member: OrgMemberRow) {
  await runMember(async () => {
    const result = await $fetch<{ revokedTokens: number }>(`/api/org/members/${member.userId}`, {
      method: 'DELETE',
    })
    // Removing yourself leaves you in no organization at all; refresh the
    // session first so the global middleware routes on the truth rather than on
    // a stale role.
    if (member.userId === user.value?.id) {
      await refreshSession()
      await navigateTo('/no-organization')
      return
    }
    await refresh()
    toast.success(result.revokedTokens
      ? `${member.email} removed. ${result.revokedTokens} token(s) revoked.`
      : `${member.email} removed.`)
  }, { failure: 'Could not remove that member' })
}

/**
 * Email a member a password reset. The admin starts the mail and nothing else:
 * the link and code go only to the member's own address, and the member chooses
 * the password. See server/utils/password-reset.ts.
 */
async function sendPasswordReset(member: OrgMemberRow) {
  await runMember(async () => {
    await $fetch(`/api/org/members/${member.userId}/password-reset`, { method: 'POST' })
  }, { success: `Password reset emailed to ${member.email}.`, failure: 'Could not send the password reset' })
}

async function revokeInvite(invite: OrgInviteRow) {
  await runMember(async () => {
    await $fetch(`/api/org/invites/${invite.id}`, { method: 'DELETE' })
    await refresh()
  }, { success: 'Invitation revoked.', failure: 'Could not revoke that invitation' })
}

/**
 * Email a pending invitation again.
 *
 * The old link cannot be re-sent — only its hash exists — so the server mints a
 * new one, superseding the old, and mails that. If the mail fails the old link
 * is already dead, so the new one is shown instead: otherwise the invitation
 * would exist with no link anyone has seen.
 */
async function resendInvite(invite: OrgInviteRow) {
  await runMember(async () => {
    const result = await $fetch<{ url: string, code: string, invite: { id: string }, emailed: boolean }>(
      `/api/org/invites/${invite.id}/resend`,
      { method: 'POST' },
    )
    await refresh()

    if (result.emailed) {
      toast.success(`New invitation emailed to ${invite.email}.`)
      return
    }

    toast.error('Could not send the email. Here is the new link — the old one no longer works.')
    revealed.value = {
      id: result.invite.id,
      code: result.code,
      url: result.url,
      email: invite.email,
      role: invite.role,
    }
  }, { failure: 'Could not resend that invitation' })
}

function onInvited(created: RevealedInvite) {
  revealed.value = created
  refresh()
}

const adminCount = computed(() => (data.value?.members ?? []).filter(m => m.role === 'admin').length)
</script>

<template>
  <div class="space-y-8">
    <div class="flex items-end justify-between gap-4">
      <div class="min-w-0">
        <h1 class="font-heading text-2xl font-semibold">
          Organization
        </h1>
        <p class="text-sm text-muted-foreground">
          Connections and connector tokens belong to the organization, not to a
          person.
        </p>
      </div>

      <InviteMemberDialog v-if="isAdmin" @created="onInvited" />
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Name</CardTitle>
      </CardHeader>
      <CardContent>
        <div v-if="renaming" class="flex items-center gap-2">
          <Input v-model="draftName" class="max-w-sm" :disabled="renameBusy" @keyup.enter="saveName()" />
          <Button size="sm" :disabled="renameBusy || !draftName.trim()" @click="saveName()">
            <CheckIcon class="size-4" />
            Save
          </Button>
          <Button size="sm" variant="ghost" :disabled="renameBusy" @click="renaming = false">
            <XIcon class="size-4" />
          </Button>
        </div>

        <div v-else class="flex items-center gap-3">
          <span class="text-sm">{{ data?.org.name }}</span>
          <Button v-if="isAdmin" size="sm" variant="ghost" @click="startRename()">
            <PencilIcon class="size-4" />
            Rename
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>
          {{ data?.members?.length ?? 0 }} in this organization.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Skeleton v-if="status === 'pending'" class="h-24" />

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead v-if="isAdmin" class="text-right">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="member in data?.members ?? []" :key="member.membershipId">
              <TableCell>
                <!-- The display name is what a colleague recognises; the address
                     is what an admin acts on, so both are here rather than one
                     standing in for the other. `name` has always come back on
                     this row — it was simply dropped before it was editable. -->
                <div v-if="member.name" class="font-medium">
                  {{ member.name }}
                </div>
                <div :class="member.name ? 'text-xs text-muted-foreground' : 'font-medium'">
                  {{ member.email }}
                </div>
                <div v-if="member.userId === user?.id" class="text-xs text-muted-foreground">
                  That is you
                </div>
              </TableCell>

              <TableCell>
                <RoleBadge :role="member.role" />
              </TableCell>

              <TableCell v-if="isAdmin" class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="memberBusy || (member.role === 'admin' && adminCount === 1)"
                    @click="setRole(member, member.role === 'admin' ? 'member' : 'admin')"
                  >
                    {{ member.role === 'admin' ? 'Make member' : 'Make admin' }}
                  </Button>

                  <!-- Your own password is the profile page's; this is for a
                       colleague who is locked out. Hidden where there is no
                       mail to send it with. -->
                  <AlertDialog v-if="data?.passwordReset && member.userId !== user?.id">
                    <AlertDialogTrigger as-child>
                      <Button size="sm" variant="outline" :disabled="memberBusy">
                        <KeyRoundIcon class="size-4" />
                        Send password reset
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Email {{ member.email }} a password reset?</AlertDialogTitle>
                        <AlertDialogDescription>
                          They get a link and a code to choose a new password, valid for
                          30 minutes. You won’t see either, and you can’t set the password
                          yourself. Their current password keeps working until they use it.
                          The email says an admin of {{ data?.org.name }} sent it.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction @click="sendPasswordReset(member)">
                          Send
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <AlertDialog>
                    <AlertDialogTrigger as-child>
                      <Button
                        size="sm"
                        variant="ghost"
                        class="text-destructive"
                        :disabled="memberBusy || (member.role === 'admin' && adminCount === 1)"
                      >
                        Remove
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove {{ member.email }}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Every connector token issued to them is revoked and stops
                          working immediately, and any connection assigned to them is
                          unassigned. Their account is not deleted — they keep their
                          login and simply belong to no organization.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction @click="remove(member)">
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <p v-if="isAdmin && adminCount === 1" class="mt-3 text-xs text-muted-foreground">
          An organization must keep at least one admin, so the last one cannot be
          demoted or removed.
        </p>
      </CardContent>
    </Card>

    <Card v-if="isAdmin">
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
        <CardDescription>
          Each link works once, for the address it names, for 14 days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p v-if="!data?.invites?.length" class="text-sm text-muted-foreground">
          Nothing outstanding.
        </p>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead class="text-right">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="invite in data.invites" :key="invite.id">
              <TableCell class="font-medium">
                {{ invite.email }}
              </TableCell>
              <TableCell>
                <RoleBadge :role="invite.role" />
              </TableCell>
              <TableCell class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <AlertDialog>
                    <AlertDialogTrigger as-child>
                      <Button size="sm" variant="outline" :disabled="memberBusy">
                        <MailIcon class="size-4" />
                        Resend email
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Email {{ invite.email }} a new link?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The previous link is not stored, so a new one is created and
                          emailed. The previous link stops working immediately — if you
                          shared it somewhere else, it will no longer let them in.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction @click="resendInvite(invite)">
                          Resend
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <Button
                    size="sm"
                    variant="ghost"
                    class="text-destructive"
                    :disabled="memberBusy"
                    @click="revokeInvite(invite)"
                  >
                    Revoke
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <InviteLinkDialog
      :url="revealed?.url ?? null"
      :invite-id="revealed?.id"
      :code="revealed?.code"
      :email="revealed?.email"
      :role="revealed?.role"
      @close="revealed = null"
    />

    <AlertDialog v-model:open="demotionOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke their connector tokens?</AlertDialogTitle>
          <AlertDialogDescription>
            {{ pendingDemotion?.message }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction @click="confirmDemotion()">
            Change role and revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
