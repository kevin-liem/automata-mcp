<script setup lang="ts">
import { startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'
import { toast } from 'vue-sonner'

/**
 * Two-factor authentication for your own account: an authenticator app,
 * passkeys or security keys, and the recovery codes that come with the first
 * of them.
 *
 * One password field serves every change here. Adding a factor needs it as much
 * as removing one: a browser left signed in must not be enough to enrol someone
 * else's authenticator, which would lock the owner out at their next sign-in.
 *
 * Recovery codes appear once — when the first factor is added, or when they are
 * regenerated — and are never fetchable again; the server keeps only hashes.
 */
interface Status {
  enabled: boolean
  totp: boolean
  passkeys: { id: string, name: string, created: string, lastUsed?: string }[]
  recoveryRemaining: number
  passkeysAvailable: boolean
}

const status = ref<Status>()
const loadError = ref('')
const password = ref('')

const setup = ref<{ secret: string, qr: string }>()
const setupCode = ref('')
const passkeyName = ref('')
const recoveryCodes = ref<string[]>()

const { busy, run } = useApiAction()

async function load() {
  loadError.value = ''
  try {
    status.value = await $fetch<Status>('/api/auth/mfa')
  }
  catch (error) {
    loadError.value = apiErrorMessage(error, 'Could not load two-factor settings')
  }
}

onMounted(load)

/** First factor added: say so, and show the codes the server just minted. */
function settleFirstFactor(codes: string[] | undefined) {
  if (!codes) return
  recoveryCodes.value = codes
  toast.info('Two-factor authentication is on. Your other sessions were signed out.')
}

async function startTotp() {
  const result = await run(() => $fetch<{ secret: string, qr: string }>('/api/auth/mfa/totp/setup', {
    method: 'POST',
    body: { currentPassword: password.value },
  }), { failure: 'Could not start authenticator setup' })
  if (!result) return
  setup.value = result
  setupCode.value = ''
}

async function confirmTotp() {
  const result = await run(async () => {
    try {
      return await $fetch<{ recoveryCodes?: string[] }>('/api/auth/mfa/totp/confirm', {
        method: 'POST',
        body: { code: setupCode.value.trim() },
      })
    }
    catch (error) {
      // The pending secret is gone (expired, out of tries, or another browser's):
      // this QR code can never be confirmed, so put the Set up button back.
      if (errorDetails(error).code === 'totp_setup_expired') setup.value = undefined
      throw error
    }
  }, { success: 'Authenticator app added.', failure: 'Could not confirm the code' })
  if (!result) return
  setup.value = undefined
  password.value = ''
  settleFirstFactor(result.recoveryCodes)
  await load()
}

async function removeTotp() {
  const result = await run(() => $fetch<{ ok: boolean }>('/api/auth/mfa/totp', {
    method: 'DELETE',
    body: { currentPassword: password.value },
  }), { success: 'Authenticator app removed.', failure: 'Could not remove the authenticator app' })
  if (!result) return
  password.value = ''
  await load()
}

async function addPasskey() {
  const result = await run(async () => {
    const optionsJSON = await $fetch<PublicKeyCredentialCreationOptionsJSON>('/api/auth/mfa/passkeys/options', {
      method: 'POST',
      body: { currentPassword: password.value },
    })
    let response
    try {
      response = await startRegistration({ optionsJSON })
    }
    catch (error: any) {
      // The browser's own refusal, not the API's: say it in words.
      throw { data: { message: error?.name === 'NotAllowedError' ? 'The passkey prompt was cancelled or timed out.' : error?.message } }
    }
    return await $fetch<{ recoveryCodes?: string[] }>('/api/auth/mfa/passkeys', {
      method: 'POST',
      body: { response, name: passkeyName.value.trim() },
    })
  }, { success: 'Passkey added.', failure: 'Could not add the passkey' })
  if (!result) return
  passkeyName.value = ''
  password.value = ''
  settleFirstFactor(result.recoveryCodes)
  await load()
}

async function removePasskey(id: string) {
  const result = await run(() => $fetch<{ ok: boolean }>(`/api/auth/mfa/passkeys/${id}`, {
    method: 'DELETE',
    body: { currentPassword: password.value },
  }), { success: 'Passkey removed.', failure: 'Could not remove the passkey' })
  if (!result) return
  password.value = ''
  await load()
}

async function regenerate() {
  const result = await run(() => $fetch<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', {
    method: 'POST',
    body: { currentPassword: password.value },
  }), { failure: 'Could not regenerate recovery codes' })
  if (!result) return
  password.value = ''
  recoveryCodes.value = result.recoveryCodes
  await load()
}

async function copyCodes() {
  if (!recoveryCodes.value) return
  try {
    await navigator.clipboard.writeText(recoveryCodes.value.join('\n'))
    toast.success('Recovery codes copied.')
  }
  catch {
    toast.error('Could not copy. Select the codes and copy them by hand.')
  }
}

function downloadCodes() {
  if (!recoveryCodes.value) return
  const blob = new Blob([`DOPE recovery codes\n\n${recoveryCodes.value.join('\n')}\n`], { type: 'text/plain' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'dope-recovery-codes.txt'
  link.click()
  URL.revokeObjectURL(link.href)
}

/** The last factor going also turns 2FA off — the confirmation says so. */
const isLastFactor = (kind: 'totp' | 'passkey') => {
  const s = status.value
  if (!s) return false
  return kind === 'totp' ? s.passkeys.length === 0 : !s.totp && s.passkeys.length === 1
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleDateString() : 'never'
}
</script>

<template>
  <section class="space-y-4">
    <div>
      <h3 class="text-sm font-medium">
        Two-factor authentication
      </h3>
      <p class="mt-1 text-xs text-muted-foreground">
        <template v-if="status?.enabled">
          On. Signing in asks for a code or passkey after your password.
        </template>
        <template v-else>
          Off. Add an authenticator app or a passkey to ask for a second step
          after your password. Connector tokens are not affected.
        </template>
      </p>
    </div>

    <p v-if="loadError" class="text-xs text-destructive">
      {{ loadError }}
    </p>

    <div v-if="recoveryCodes" class="space-y-3 rounded-md border p-3">
      <p class="text-sm font-medium">
        Save your recovery codes
      </p>
      <p class="text-xs text-muted-foreground">
        If you lose your phone and keys, each of these signs you in once. They
        will not be shown again.
      </p>
      <ul class="grid grid-cols-2 gap-1 font-mono text-sm">
        <li v-for="item in recoveryCodes" :key="item">
          {{ item }}
        </li>
      </ul>
      <div class="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" @click="copyCodes">
          Copy
        </Button>
        <Button type="button" size="sm" variant="outline" @click="downloadCodes">
          Download
        </Button>
        <Button type="button" size="sm" @click="recoveryCodes = undefined">
          I saved them
        </Button>
      </div>
    </div>

    <template v-if="status">
      <div class="space-y-2">
        <Label for="mfa-password">Current password</Label>
        <Input
          id="mfa-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="busy"
        />
        <p class="text-xs text-muted-foreground">
          Needed to add or remove a factor.
        </p>
      </div>

      <!-- Authenticator app -->
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div>
            <p class="text-sm">
              Authenticator app
            </p>
            <p class="text-xs text-muted-foreground">
              {{ status.totp ? 'Set up.' : 'Google Authenticator, 1Password, Authy, or similar.' }}
            </p>
          </div>
          <ConfirmAction
            v-if="status.totp"
            label="Remove"
            title="Remove the authenticator app?"
            confirm-label="Remove"
            :disabled="busy || !password"
            @confirm="removeTotp"
          >
            {{ isLastFactor('totp')
              ? 'This is your only second factor: two-factor authentication turns off and your recovery codes stop working.'
              : 'Signing in will no longer accept codes from this app.' }}
          </ConfirmAction>
          <Button
            v-else-if="!setup"
            type="button"
            size="sm"
            variant="outline"
            :disabled="busy || !password"
            @click="startTotp"
          >
            Set up
          </Button>
        </div>

        <form v-if="setup" class="space-y-3" @submit.prevent="confirmTotp">
          <p class="text-xs text-muted-foreground">
            Scan this with your authenticator app, then enter the code it shows.
          </p>
          <QrFrame :src="setup.qr" alt="Authenticator setup QR code" />
          <p class="break-all font-mono text-xs">
            {{ setup.secret }}
          </p>
          <div class="flex gap-2">
            <Input
              v-model="setupCode"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="123456"
              :disabled="busy"
            />
            <Button type="submit" size="sm" :disabled="busy || !setupCode.trim()">
              Confirm
            </Button>
            <Button type="button" size="sm" variant="ghost" :disabled="busy" @click="setup = undefined">
              Cancel
            </Button>
          </div>
        </form>
      </div>

      <!-- Passkeys -->
      <div class="space-y-3">
        <div>
          <p class="text-sm">
            Passkeys and security keys
          </p>
          <p v-if="!status.passkeysAvailable" class="text-xs text-muted-foreground">
            Not available: this deployment has no NUXT_PUBLIC_APP_URL set.
          </p>
        </div>

        <ul v-if="status.passkeys.length" class="space-y-2">
          <li v-for="key in status.passkeys" :key="key.id" class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm">
                {{ key.name || 'Passkey' }}
              </p>
              <p class="text-xs text-muted-foreground">
                Added {{ formatDate(key.created) }} · last used {{ formatDate(key.lastUsed) }}
              </p>
            </div>
            <ConfirmAction
              label="Remove"
              :title="`Remove ${key.name || 'this passkey'}?`"
              confirm-label="Remove"
              :disabled="busy || !password"
              @confirm="removePasskey(key.id)"
            >
              {{ isLastFactor('passkey')
                ? 'This is your only second factor: two-factor authentication turns off and your recovery codes stop working.'
                : 'Signing in will no longer accept this key.' }}
            </ConfirmAction>
          </li>
        </ul>

        <form v-if="status.passkeysAvailable" class="flex gap-2" @submit.prevent="addPasskey">
          <Input
            v-model="passkeyName"
            placeholder="Name, e.g. YubiKey"
            maxlength="100"
            :disabled="busy"
          />
          <Button type="submit" size="sm" variant="outline" :disabled="busy || !password">
            Add passkey
          </Button>
        </form>
      </div>

      <!-- Recovery codes -->
      <div v-if="status.enabled" class="flex items-center justify-between gap-2">
        <div>
          <p class="text-sm">
            Recovery codes
          </p>
          <p class="text-xs" :class="status.recoveryRemaining <= 2 ? 'text-destructive' : 'text-muted-foreground'">
            {{ status.recoveryRemaining }} unused
          </p>
        </div>
        <ConfirmAction
          label="Regenerate"
          title="Replace your recovery codes?"
          confirm-label="Regenerate"
          :disabled="busy || !password"
          @confirm="regenerate"
        >
          Every old recovery code stops working, used or not. The new ones are
          shown once.
        </ConfirmAction>
      </div>
    </template>
  </section>
</template>
