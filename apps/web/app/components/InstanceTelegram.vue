<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { SendIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { TELEGRAM_RECENT_HISTORY_DAYS } from '#shared/history'

/**
 * The link-and-dashboard panel for a Telegram connection. Chosen by
 * pages/instances/[id].vue from the connection's kind.
 *
 * Unlike WhatsApp, a Telegram connection is created unlinked and pairing is a
 * separate, explicit step: the account is linked by an admin pressing a button,
 * never by opening the page, because it binds a real Telegram account.
 */
const props = withDefaults(defineProps<{
  id: string
  /**
   * Whether this viewer may change the connection, as opposed to use it.
   * Decided by the server; presentation only — every control it hides is
   * independently refused with a 403.
   */
  canManage?: boolean
}>(), { canManage: false })

interface StatusResponse {
  instance: PublicInstanceRow
  state: ConnectionState
  /** Linked, and the connection to Telegram dropped. */
  sessionLost?: boolean
  /** Telegram ended the session; only linking again brings it back. */
  revoked?: boolean
  pairing?: 'qr' | 'password'
  telegramUserId?: string
  profileName?: string
  username?: string
  number?: string
  error?: string
  stats?: { messages: number, chats: number }
  /** `historyDays`: how far back this account's older history is fetched, from the bridge. */
  sync?: { backfilling: boolean, pendingBackfill: number, dialogsSyncedAt?: string, pausedUntil?: string, historyDays?: number }
  /** Linking now fetches only recent history (`historyLimited`). Policy, not the linked account's fact. */
  historyLimitedByPlan?: boolean
}

interface PairingView {
  state: ConnectionState
  pairing?: 'qr' | 'password'
  passwordHint?: string
  passwordRejected?: boolean
  revoked?: boolean
  error?: string
  qr?: { dataUrl: string, expiresAt: string }
}

const id = computed(() => props.id)

const { data, refresh } = await useFetch<StatusResponse>(() => `/api/instances/${id.value}`)

const state = computed<ConnectionState>(() => data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')
/** A Telegram account is (or was until it dropped) linked to this connection. */
const linked = computed(() => Boolean(data.value?.telegramUserId) || data.value?.sessionLost === true)

/** The live pairing flow, as last reported by the bridge. */
const pairing = ref<PairingView | null>(null)
const pairingError = ref('')
const password = ref('')

type Mode = 'connected' | 'pairing' | 'lost' | 'unreachable' | 'unlinked'

/**
 * **Only a manager enters pairing mode**, for the reason InstanceWhatsapp gives:
 * linking binds a real account, and someone who cannot press the button has no
 * business being shown a QR code. A member sees what the state is and who can
 * change it.
 */
const mode = computed<Mode>(() => {
  if (connected.value) return 'connected'
  if (props.canManage && (pairing.value?.pairing || data.value?.pairing)) return 'pairing'
  if (data.value?.sessionLost) return 'lost'
  if (state.value === 'unknown') return 'unreachable'
  return 'unlinked'
})

const display = computed(() => describeState(state.value, 'telegram', { lost: mode.value === 'lost' }))

const needsDbUrl = computed(() =>
  data.value?.instance.ownServer === true && data.value?.instance.canReadMessages === false,
)

/** `@username · +number`, whichever of the two Telegram gave us. */
const profileDetail = computed(() => [
  data.value?.username && `@${data.value.username}`,
  data.value?.number && `+${data.value.number}`,
].filter(Boolean).join(' · ') || '—')

const { busy, run } = useApiAction()
const { busy: passwordBusy, run: runPassword } = useApiAction()

// ── pairing ────────────────────────────────────────────────────────────────
/**
 * Polling the QR endpoint is safe here, which is not true of WhatsApp: the
 * bridge only reads the code of a flow `pair` already started and never asks
 * Telegram for a login token on its own. The code rotates about every 30
 * seconds, and the poll is what picks up the next one.
 */
const { pause: pauseQrPoll, resume: resumeQrPoll } = useIntervalFn(async () => {
  if (mode.value !== 'pairing') return
  try {
    applyPairing(await $fetch<PairingView>(`/api/instances/${id.value}/telegram/qr`))
  }
  catch {
    // Transient. The next tick retries.
  }
}, 2000, { immediate: false })

async function applyPairing(view: PairingView) {
  if (view.pairing) {
    // Keep the last image while the bridge generates the next code, so the QR
    // does not flicker between polls.
    pairing.value = { ...view, qr: view.qr ?? (view.pairing === 'qr' ? pairing.value?.qr : undefined) }
    return
  }

  // The flow has ended: linked, or given up.
  pairing.value = null
  password.value = ''
  if (view.state !== 'open') {
    pairingError.value = view.error ?? 'Linking did not complete. Start again to get a new QR code.'
  }
  await refresh()
  if (view.state === 'open') toast.success('Telegram account linked.')
}

async function startPairing() {
  pairingError.value = ''
  await run(
    async () => {
      const view = await $fetch<PairingView>(`/api/instances/${id.value}/telegram/pair`, { method: 'POST' })
      pairing.value = { ...view, pairing: view.pairing ?? 'qr' }
    },
    { failure: 'Could not start linking' },
  )
}

/**
 * The password leaves the input the moment it is sent, and is not kept anywhere
 * on the page. A wrong one comes back as `passwordRejected` on the next poll.
 */
async function submitPassword() {
  const value = password.value
  if (!value) return
  password.value = ''
  await runPassword(
    async () => {
      applyPairing(await $fetch<PairingView>(`/api/instances/${id.value}/telegram/password`, {
        method: 'POST',
        body: { password: value },
      }))
    },
    { failure: 'Could not submit the password' },
  )
}

// ── status ─────────────────────────────────────────────────────────────────
const { pause: pauseStatusPoll, resume: resumeStatusPoll } = useIntervalFn(() => refresh(), 15000, { immediate: false })

// ── reconnecting ───────────────────────────────────────────────────────────
const {
  busy: reconnectBusy,
  reconnecting,
  stalled: reconnectStalled,
  reconnect,
  reset: resetReconnect,
} = useReconnect({
  url: () => `/api/instances/${id.value}/telegram/reconnect`,
  refresh,
  lost: () => mode.value === 'lost',
})

// ── polling follows the mode ───────────────────────────────────────────────
function applyMode(next: Mode) {
  if (next === 'pairing') {
    pauseStatusPoll()
    resumeQrPoll()
  }
  else {
    pauseQrPoll()
    resumeStatusPoll()
  }

  if (next !== 'lost') resetReconnect()
}

watch(mode, (next, previous) => {
  if (previous === 'lost' && next === 'connected' && reconnecting.value) toast.success('Reconnected.')
  applyMode(next)
})

onMounted(() => applyMode(mode.value))

// ── actions ────────────────────────────────────────────────────────────────
async function unlink() {
  await run(
    async () => {
      await $fetch(`/api/instances/${id.value}/telegram/logout`, { method: 'POST' })
      pairing.value = null
      pairingError.value = ''
      await refresh()
    },
    {
      success: 'Unlinked. The chats synced for this account were deleted.',
      failure: 'Could not unlink this account',
      preferServerMessage: false,
    },
  )
}

const count = new Intl.NumberFormat()
</script>

<template>
  <div class="space-y-8">
    <InstanceHeader
      :id="id"
      :label="data?.instance.label"
      :can-manage="canManage"
      :state="state"
      kind="telegram"
      :lost="mode === 'lost'"
      @renamed="refresh()"
    >
      <!-- A member gets what the state is, not a hint they cannot act on; see
           InstanceWhatsapp. -->
      <p class="text-sm text-muted-foreground">
        {{ canManage ? display.hint : `Telegram account · ${display.label.toLowerCase()}` }}
      </p>
    </InstanceHeader>

    <!-- ── not linked ──────────────────────────────────────────────────── -->
    <Card v-if="mode === 'unlinked'">
      <CardHeader>
        <CardTitle>{{ data?.revoked ? 'Telegram ended this session' : 'Link a Telegram account' }}</CardTitle>
        <CardDescription v-if="canManage">
          <template v-if="data?.revoked">
            Someone terminated this device from Telegram → Settings → Devices, or the
            account was deleted. Link it again to resume; chats synced so far are kept.
          </template>
          <template v-else>
            You will scan a QR code with Telegram on your phone. Chats then sync into
            this connection and Claude can read and send through it.
          </template>
        </CardDescription>
        <CardDescription v-else>
          This connection is not linked to a Telegram account right now. An admin of
          your organization can link it.
        </CardDescription>
      </CardHeader>
      <CardContent v-if="canManage" class="space-y-4">
        <!-- `data.error` is the bridge's own reason when it cannot link at all,
             e.g. running without TELEGRAM_API_ID / TELEGRAM_API_HASH. -->
        <p v-if="pairingError || data?.error" class="text-sm text-destructive">
          {{ pairingError || data?.error }}
        </p>
        <Button :disabled="busy" @click="startPairing">
          <SendIcon class="size-4" />
          {{ busy ? 'Starting…' : 'Show QR code' }}
        </Button>
        <p v-if="data?.historyLimitedByPlan" class="text-xs text-muted-foreground">
          Your plan syncs the last {{ TELEGRAM_RECENT_HISTORY_DAYS }} days of history when an
          account is linked; everything that arrives after that is kept.
          <UpgradeLink>
            before linking to sync further back.
          </UpgradeLink>
        </p>
        <p class="text-xs text-muted-foreground">
          This app signs in as an unofficial Telegram client, which Telegram watches
          more closely than its own apps, and its API terms restrict using chats for
          AI. Use an account you are comfortable linking this way.
        </p>
      </CardContent>
    </Card>

    <!-- ── pairing ─────────────────────────────────────────────────────── -->
    <Card v-else-if="mode === 'pairing'">
      <template v-if="(pairing?.pairing ?? data?.pairing) === 'password'">
        <CardHeader>
          <CardTitle>Enter your two-step verification password</CardTitle>
          <CardDescription>
            This Telegram account has a password on top of the QR code. It goes
            straight to Telegram and is not stored.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 pb-8">
          <div class="space-y-2">
            <Label for="tg-password">Password</Label>
            <Input
              id="tg-password"
              v-model="password"
              type="password"
              autocomplete="off"
              @keydown.enter="submitPassword"
            />
            <p v-if="pairing?.passwordHint" class="text-xs text-muted-foreground">
              Hint: {{ pairing.passwordHint }}
            </p>
            <p v-if="pairing?.passwordRejected" class="text-xs text-destructive">
              That password was not right. Try again.
            </p>
          </div>
          <Button :disabled="passwordBusy || !password" @click="submitPassword">
            {{ passwordBusy ? 'Checking…' : 'Continue' }}
          </Button>
        </CardContent>
      </template>

      <template v-else>
        <CardHeader>
          <CardTitle>Scan to link</CardTitle>
          <CardDescription>
            In Telegram on your phone: Settings → Devices → Link Desktop Device, then
            point the camera at this code.
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col items-center gap-4 pb-8">
          <QrFrame :src="pairing?.qr?.dataUrl" alt="Telegram login QR code" />
          <p class="text-center text-xs text-muted-foreground">
            The code refreshes on its own. If nobody scans it within five minutes,
            start again.
          </p>
        </CardContent>
      </template>
    </Card>

    <!-- ── linked, or was ──────────────────────────────────────────────── -->
    <template v-else>
      <SessionLostNotice
        v-if="mode === 'lost'"
        service="Telegram"
        :can-manage="canManage"
        :reconnecting="reconnecting"
        :stalled="reconnectStalled"
        :busy="reconnectBusy"
        @reconnect="reconnect"
      >
        <template #hint>
          The account is still linked, so reconnecting needs no QR code.
        </template>
        <template #stalled>
          The connection did not come back. {{ data?.error ? `Telegram said: ${data.error}.` : '' }}
          Try again in a minute, or restart the Telegram bridge.
        </template>
      </SessionLostNotice>

      <NoticeCard v-if="mode === 'unreachable'" tone="error" title="Could not reach the Telegram bridge">
        <template #description>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ data?.error || 'The service that keeps this account connected did not answer.' }}
            Synced chats stay readable; linking, reconnecting and sending wait for it.
          </p>
        </template>
      </NoticeCard>

      <!-- Telegram keeps no address book this app reads, so there is no Contacts card. -->
      <MessagingOverview
        :id="id"
        kind="telegram"
        :profile="{ name: data?.profileName || 'Telegram', detail: profileDetail }"
        :stats="data?.stats ?? { messages: 0, chats: 0 }"
        :can-read-messages="data?.instance.canReadMessages !== false"
      />

      <p class="text-xs text-muted-foreground">
        <template v-if="data?.sync && data.sync.pendingBackfill > 0">
          Fetching older history: {{ count.format(data.sync.pendingBackfill) }}
          {{ data.sync.pendingBackfill === 1 ? 'chat' : 'chats' }} to go<template v-if="data.sync.pausedUntil">,
            paused by Telegram until {{ new Date(data.sync.pausedUntil).toLocaleTimeString() }}</template>.
          New messages sync as they arrive.
        </template>
        <template v-else>
          New messages sync as they arrive. Older history is fetched within this
          connection's limits, and Claude is told when a chat's history is incomplete.
        </template>
        <!-- The bridge's figure — what this link actually uses, not the current
             plan, which changes nothing until the account is linked again. -->
        <template v-if="data?.sync?.historyDays !== undefined">
          Older history reaches back {{ count.format(data.sync.historyDays) }}
          {{ data.sync.historyDays === 1 ? 'day' : 'days' }}.
        </template>
      </p>
    </template>

    <Separator />

    <DbUrlNotice v-if="needsDbUrl" :id="id" kind="telegram" @saved="refresh()" />

    <!-- Always shown, including while unlinked: a token must be revocable
         exactly when the account is not working. -->
    <McpTokens
      :instance-id="id"
      kind="telegram"
      :connected="connected"
      :can-manage="canManage"
    />

    <template v-if="canManage">
      <Separator />

      <section class="space-y-4">
        <h2 class="font-heading text-lg font-semibold">
          Manage
        </h2>

        <div class="flex flex-wrap gap-3">
          <ConfirmAction
            v-if="linked"
            label="Unlink account"
            title="Unlink this Telegram account?"
            confirm-label="Unlink"
            :disabled="busy"
            @confirm="unlink"
          >
            This signs the connection out of Telegram and deletes every chat synced
            for it. Connector tokens are kept, but read and send nothing until an
            account is linked again.
          </ConfirmAction>

          <AssignConnectionDialog :id="id" kind="telegram" />

          <DeleteConnectionDialog :id="id" :label="data?.instance.label" kind="telegram" />
        </div>
      </section>
    </template>
  </div>
</template>
