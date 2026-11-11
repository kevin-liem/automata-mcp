<script setup lang="ts">
import { Loader2Icon, TriangleAlertIcon } from '@lucide/vue'
import { useIntervalFn, useNow } from '@vueuse/core'
import { toast } from 'vue-sonner'

/**
 * The pairing-and-dashboard panel for a WhatsApp connection. Chosen by
 * pages/instances/[id].vue from the connection's kind; everything in here
 * assumes Evolution and a phone, which is why it is not the page itself.
 */
const props = withDefaults(defineProps<{
  id: string
  /**
   * Whether this viewer may change the connection, as opposed to use it.
   *
   * Decided by the server and passed down from the page. It gates presentation
   * only — every control it hides is independently refused with a 403.
   */
  canManage?: boolean
}>(), { canManage: false })

interface StatusResponse {
  instance: PublicInstanceRow
  state: ConnectionState
  /** Was connected, and Evolution's live socket no longer is. */
  sessionLost?: boolean
  /** Evolution keeps reopening the socket; reads `open` most of the time. */
  flapping?: boolean
  /** Reads `open`, but a send or group lookup found the socket dead since it last opened. */
  stalled?: boolean
  /** With `flapping` or `stalled`: the deployment's operator is alerted and will restart Evolution. */
  operatorAlerted?: boolean
  profileName?: string
  profilePicUrl?: string
  number?: string
  /** Absent when the counts could not be measured in time — unknown, not zero. */
  stats?: { messages: number, chats: number, contacts: number }
  /**
   * The plan imports only the recent history WhatsApp sends any linked device,
   * and refuses a full-history import. Decided by the server.
   */
  historyLimitedByPlan?: boolean
}

interface QrResponse {
  state: ConnectionState
  qr?: { base64?: string, code?: string, pairingCode?: string, count?: number }
}

const id = computed(() => props.id)

/**
 * Set while the history import runs. The server caches counts for a few minutes,
 * and the import screen decides it is done when they stop moving — so cached
 * counts would end it early. `applyMode` sets it; the reactive query makes the
 * status fetch ask for counts recomputed on (nearly) every poll.
 */
const freshCounts = ref(false)

const { data, refresh } = await useFetch<StatusResponse>(() => `/api/instances/${id.value}`, {
  query: computed(() => (freshCounts.value ? { fresh: 'counts' } : {})),
})

/**
 * The QR poll reports state far more often than the status fetch does, so it is
 * the fresher source while pairing. Without this the badge sits on
 * "Disconnected" the whole time a QR is on screen.
 */
const polledState = ref<ConnectionState | null>(null)

const state = computed<ConnectionState>(() => polledState.value ?? data.value?.state ?? 'unknown')
const connected = computed(() => state.value === 'open')

/**
 * Set by Disconnect and Import full history. Both end the session on purpose,
 * and for a moment afterwards Evolution's stored status still says `open` —
 * which is exactly what a dropped session looks like. Without this the page
 * would offer to reconnect the account it was just told to sign out.
 */
const pairingRequested = ref(false)

/**
 * A scan completed while this page was open. WhatsApp hands its history over in
 * the minute or so after a device links, so until the counts settle the page
 * says it is importing rather than showing a dashboard of zeros. Only the QR
 * poll sets it, and only managers run that poll. A reload during the import
 * simply lands on the dashboard, whose counts keep climbing on the status poll.
 */
const justPaired = ref(false)
const importDone = ref(false)
/** When the scan was seen — the import's clock, read by the stats watcher. */
const importStartedAt = ref(0)

/**
 * What this page is showing. A lost session is its own mode rather than a
 * flavour of pairing: its phone is still linked, so the instruction is
 * different, and it must not be polled the way pairing is — see `applyMode`.
 * `importing` is a connected account straight after its pairing, while the
 * history WhatsApp sends with a new device link is still arriving.
 */
type Mode = 'pairing' | 'importing' | 'lost' | 'connected'

/**
 * **A member never enters pairing mode**, and that is a safety property rather
 * than a tidiness one. Pairing mode runs the QR poll, and the QR poll calls
 * `/instance/connect` — which a member is refused with a 403 anyway, so for them
 * it would be a failing request every two seconds forever. Pairing is
 * management: scanning a code binds a real phone number, and someone who cannot
 * press Reconnect or Disconnect has no business being shown a QR either.
 *
 * They get the `lost` wording instead, minus the button, which is the honest
 * description of what they are looking at: a connection that is not currently
 * usable and that somebody else has to fix.
 */
const mode = computed<Mode>(() => {
  if (connected.value) return justPaired.value && !importDone.value ? 'importing' : 'connected'
  if (!props.canManage) return 'lost'
  if (data.value?.sessionLost && !pairingRequested.value) return 'lost'
  return 'pairing'
})

const flapping = computed(() => data.value?.flapping === true)
// Not `stalled`: that name is taken below by a Reconnect that did not land.
// The server never sends `stalled` alongside `flapping`.
const socketStuck = computed(() => data.value?.stalled === true)
const operatorAlerted = computed(() => (flapping.value || socketStuck.value) && data.value?.operatorAlerted === true)

const display = computed(() => describeState(state.value, 'whatsapp', {
  lost: mode.value === 'lost',
  flapping: flapping.value,
  stalled: socketStuck.value,
  operatorAlerted: operatorAlerted.value,
}))

/**
 * Reconnect is offered only from `close`: that is the one state with a safe call
 * behind it, and the server refuses the others (`reconnectInstance`). From
 * `connecting` or `unknown` the notice says what does help instead.
 */
const canReconnect = computed(() => state.value === 'close')
const evolutionServer = computed(() => (data.value?.instance.ownServer ? 'your Evolution server' : 'the Evolution server'))

/**
 * A connection nobody has ever paired is deleted an hour after it was created
 * (server/utils/unpaired-reaper.ts). Said on the pairing screen with the time
 * left, so it is not a surprise later. The server decides whether it applies —
 * a re-pair after a logout carries no deadline.
 */
const now = useNow({ interval: 30_000 })
const removalMinutes = computed(() => {
  const at = data.value?.instance.unpairedRemovalAt
  if (!at) return undefined
  const left = Date.parse(at) - now.value.getTime()
  return Number.isNaN(left) ? undefined : Math.max(0, Math.ceil(left / 60_000))
})

const qr = ref<QrResponse['qr'] | null>(null)
const pairingTimedOut = ref(false)
const pairingStartedAt = ref(Date.now())

const { busy, run } = useApiAction()

// Reading goes to Evolution's own Postgres, so an account on a server the user
// supplied needs that server's database URL. `DbUrlNotice` asks for it.
const needsDbUrl = computed(() =>
  data.value?.instance.ownServer === true && data.value?.instance.canReadMessages === false,
)

// ── pairing ────────────────────────────────────────────────────────────────
// Polling the QR endpoint is what drives pairing: the server starts the
// connection the first time it is asked for a QR on a disconnected instance,
// and again only once `close` has outlasted its connect hold — never in the
// moment after a scan, when Evolution is reconnecting by itself (#122).
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000

const { pause: pauseQrPoll, resume: resumeQrPoll } = useIntervalFn(async () => {
  if (mode.value !== 'pairing') return

  if (Date.now() - pairingStartedAt.value > PAIRING_TIMEOUT_MS) {
    pairingTimedOut.value = true
    pauseQrPoll()
    return
  }

  try {
    const result = await $fetch<QrResponse>(`/api/instances/${id.value}/qr`)
    if (result.state === 'open') {
      qr.value = null
      if (!justPaired.value) importStartedAt.value = Date.now()
      justPaired.value = true
      // Refreshed rather than recorded, so the page does not flip to connected on
      // this poll's word and back again while the status fetch catches up.
      await refresh()
      // But the state this poll recorded earlier must go now: `polledState` wins
      // over the status fetch, so a stale `connecting` left here would hold the
      // page on an empty QR frame for good — every later tick lands back in this
      // branch and nothing else clears it. The status fetch decides from here.
      polledState.value = null
      return
    }
    polledState.value = result.state
    // Keep the previous QR while Evolution generates the next one, so the image
    // does not flicker between polls. But `close` means the code on screen is
    // spent — just scanned, with Evolution restarting the link, or expired and
    // waiting out the server's connect hold — so it must not stay scannable.
    if (result.qr?.base64) qr.value = result.qr
    else if (result.state === 'close') qr.value = null
  }
  catch {
    // Transient. The next tick retries; a hard failure surfaces on the status poll.
  }
}, 2000, { immediate: false })

// ── connected status ───────────────────────────────────────────────────────
const { pause: pauseStatusPoll, resume: resumeStatusPoll } = useIntervalFn(
  () => refresh(),
  15000,
  { immediate: false },
)

// ── importing history after pairing ────────────────────────────────────────
/**
 * Evolution says nothing when a history sync is finished, so the page decides
 * from the counts: done once they have stopped moving for a while. History can
 * start a few seconds after the link opens, so an account still at zero is
 * given longer before it is called empty, and the wait is capped regardless —
 * the dashboard's own status poll keeps the counts current after that.
 */
const IMPORT_POLL_MS = 3000
const IMPORT_STABLE_POLLS = 5
const IMPORT_EMPTY_MS = 60 * 1000
const IMPORT_MAX_MS = 3 * 60 * 1000

const lastImportTotal = ref<number | null>(null)
const unchangedPolls = ref(0)

const { pause: pauseImportPoll, resume: resumeImportPoll } = useIntervalFn(
  () => refresh(),
  IMPORT_POLL_MS,
  { immediate: false },
)

function resetImport() {
  justPaired.value = false
  importDone.value = false
  lastImportTotal.value = null
  unchangedPolls.value = 0
}

function finishImport(announce: boolean) {
  importDone.value = true
  if (announce) toast.success('WhatsApp connected — history imported.')
}

watch(() => data.value?.stats, (stats) => {
  if (mode.value !== 'importing' || !stats) return

  const total = stats.messages + stats.chats + stats.contacts
  unchangedPolls.value = total === lastImportTotal.value ? unchangedPolls.value + 1 : 0
  lastImportTotal.value = total

  const elapsed = Date.now() - importStartedAt.value
  if (
    (total > 0 && unchangedPolls.value >= IMPORT_STABLE_POLLS)
    || (total === 0 && elapsed >= IMPORT_EMPTY_MS)
    || elapsed >= IMPORT_MAX_MS
  ) {
    finishImport(true)
  }
})

const format = new Intl.NumberFormat()
const importProgress = computed(() => {
  const stats = data.value?.stats
  if (!stats || stats.messages + stats.chats === 0) return ''
  return `${format.format(stats.messages)} messages · ${format.format(stats.chats)} chats so far`
})

// ── reconnecting ───────────────────────────────────────────────────────────
// Three ways out: the session comes back (`applyMode` sees `connected`), the
// credentials were rejected and Evolution shows a QR instead (`applyMode` sees
// `pairing`), or nothing happens within the window and the notice says so.
const {
  busy: reconnectBusy,
  reconnecting,
  stalled: reconnectStalled,
  reconnect,
  reset: resetReconnect,
} = useReconnect({
  url: () => `/api/instances/${id.value}/reconnect`,
  refresh,
  lost: () => mode.value === 'lost',
})

// ── polling follows the mode ───────────────────────────────────────────────
/**
 * **The QR poll runs in pairing mode only, and that is load-bearing.** It calls
 * `/instance/connect`, which on an instance Evolution holds in `close` builds a
 * brand-new socket from the stored credentials. Pointed every two seconds at a
 * lost session Evolution cannot bring back, that is a fresh WhatsApp login every
 * two seconds — sockets leaked on the server, and the pattern that gets a
 * number banned. A lost session is reconnected once, when someone asks.
 *
 * The status poll runs whenever a session exists, lost included, so a recovery
 * Evolution makes on its own is noticed without anyone pressing anything.
 */
function applyMode(next: Mode) {
  freshCounts.value = next === 'importing'

  if (next === 'pairing') {
    pauseStatusPoll()
    pauseImportPoll()
    resumeQrPoll()
  }
  else if (next === 'importing') {
    polledState.value = null
    pauseQrPoll()
    pauseStatusPoll()
    resumeImportPoll()
  }
  else {
    polledState.value = null
    pauseQrPoll()
    pauseImportPoll()
    resumeStatusPoll()
  }

  if (next !== 'lost') resetReconnect()

  if (next === 'connected' || next === 'importing') pairingRequested.value = false
  if (next === 'connected') justPaired.value = false
}

watch(mode, (next, previous) => {
  if (previous === 'lost' && next === 'connected' && reconnecting.value) {
    toast.success('Reconnected.')
  }
  applyMode(next)
})

onMounted(() => applyMode(mode.value))

function restartPairing() {
  pairingTimedOut.value = false
  pairingStartedAt.value = Date.now()
  resumeQrPoll()
}

// ── actions ────────────────────────────────────────────────────────────────
/**
 * Both controls here end the WhatsApp session and send the page back to
 * pairing, and both then need a QR: `logout` because that is all it does, and
 * `resync` because arming a history import only takes effect on a fresh device
 * link. So they differ in the endpoint they call and in what to tell the user,
 * and in nothing else.
 *
 * The failure text is a generic on purpose — these answer "Not found" or a bare
 * Evolution status, which is a worse thing to show someone than the sentence
 * below.
 */
function backToPairing(path: string, success: string, failure: string) {
  return run(
    async () => {
      await $fetch(`/api/instances/${id.value}/${path}`, { method: 'POST' })
      qr.value = null
      polledState.value = null
      resetImport()
      pairingRequested.value = true
      restartPairing()
      await refresh()
    },
    { success, failure, preferServerMessage: false },
  )
}

const disconnect = () => backToPairing(
  'logout',
  'Disconnected. Scan the new QR code to reconnect.',
  'Could not disconnect',
)

/**
 * Arm a full-history import. Signs the device out — WhatsApp only hands history
 * over when a device is linked, so the import rides in on the next QR scan.
 */
const importHistory = () => backToPairing(
  'resync',
  'Scan the new QR code — your history imports as it connects.',
  'Could not start the history import',
)
</script>

<template>
  <div class="space-y-8">
    <InstanceHeader
      :id="id"
      :label="data?.instance.label"
      :can-manage="canManage"
      :state="state"
      kind="whatsapp"
      :lost="mode === 'lost'"
      :flapping="flapping"
      :stalled="socketStuck"
      @renamed="refresh()"
    >
      <!--
        `describeState`'s hints are written for someone who can act on them
        — "reconnect", "scan a QR code" — and a member can do neither. The
        banner below already says what is wrong and who fixes it, so for
        them the subtitle says what the connection *is* instead of issuing
        an instruction they cannot follow.
      -->
      <p class="text-sm text-muted-foreground">
        {{ canManage ? display.hint : `WhatsApp account · ${display.label.toLowerCase()}` }}
      </p>
    </InstanceHeader>

    <!-- ── scanned: linking, then importing history ────────────────────── -->
    <!--
      Covers the gap between the scan and the dashboard. Without it the QR frame
      empties to a skeleton the moment the code is used and the page reads as
      stuck, and the dashboard that follows would show counts of zero while the
      history is still arriving.
    -->
    <Card v-if="mode === 'importing' || (mode === 'pairing' && justPaired)">
      <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
        <Loader2Icon class="size-8 animate-spin text-muted-foreground" />
        <p class="font-medium">
          {{ mode === 'importing' ? 'Importing your WhatsApp history' : 'Linking your phone…' }}
        </p>
        <p class="max-w-md text-sm text-muted-foreground">
          WhatsApp is sending your past conversations to this device. Keep your
          phone online — this usually takes under a minute.
        </p>
        <p v-if="importProgress" class="text-sm tabular-nums">
          {{ importProgress }}
        </p>
        <Button
          v-if="mode === 'importing'"
          variant="ghost"
          size="sm"
          class="mt-2"
          @click="finishImport(false)"
        >
          Show dashboard now
        </Button>
      </CardContent>
    </Card>

    <!-- ── pairing ─────────────────────────────────────────────────────── -->
    <Card v-else-if="mode === 'pairing'">
      <CardHeader>
        <CardTitle>Scan to connect</CardTitle>
        <CardDescription>
          On your phone: WhatsApp → Settings → Linked devices → Link a device.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col items-center gap-4 pb-8">
        <QrFrame :src="qr?.base64" alt="WhatsApp pairing QR code" :expired="pairingTimedOut" />

        <p v-if="qr?.pairingCode" class="text-sm text-muted-foreground">
          Or enter code <code class="font-mono font-medium">{{ qr.pairingCode }}</code> on your phone.
        </p>

        <p v-if="removalMinutes !== undefined && removalMinutes > 0" class="max-w-sm text-center text-xs text-muted-foreground">
          A connection that isn't paired within an hour of being created is removed automatically.
          {{ removalMinutes === 1 ? '1 minute' : `${removalMinutes} minutes` }} left.
        </p>
        <!-- Past the deadline: deletion is imminent and cannot be undone, so it
             reads as a warning rather than as helper text. -->
        <div
          v-else-if="removalMinutes === 0"
          role="alert"
          class="flex max-w-sm items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
          <p>
            This connection wasn't paired within an hour and is about to be removed automatically.
            You can create a new one.
          </p>
        </div>

        <div v-if="pairingTimedOut" class="text-center">
          <p class="text-sm text-muted-foreground">
            The code expired.
          </p>
          <Button variant="outline" size="sm" class="mt-2" @click="restartPairing">
            Show a new code
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- ── connected, or was ───────────────────────────────────────────── -->
    <template v-else-if="mode === 'connected' || mode === 'lost'">
      <!--
        A dropped session keeps its profile and counts below: the phone is still
        linked, and everything stored up to the drop is still readable.
      -->
      <!--
        A reconnect loop, which reads `open` on most polls. Reconnect has no
        socket to act on, so nobody gets a button — only who can end it.
        Takes the place of the lost-session notice when both are true: a poll
        that lands between two sockets sees a dropped session, and offering
        Reconnect then is the wrong fix.
      -->
      <NoticeCard v-if="flapping" title="Evolution keeps reconnecting this account" tone="error">
        <template #description>
          <p class="mt-1 text-sm text-muted-foreground">
            Its connection to WhatsApp is being replaced over and over, so messages
            may be missing here and sends may fail.
            <!--
              Hosted offering: only we can restart Evolution, and we have been
              mailed. Same words for admins and members — neither can act.
            -->
            <template v-if="operatorAlerted">
              This is on our side: we have been alerted and will restart the
              service. Nothing needs scanning, the phone stays linked, and there
              is nothing you need to do.
            </template>
            <template v-else-if="canManage">
              Reconnect cannot end this. Restarting {{ evolutionServer }} does, with
              no new QR scan. Repeated logins can get a number flagged by WhatsApp,
              so do it soon.
            </template>
            <template v-else>
              Nothing needs scanning. Whoever runs {{ evolutionServer }} has to
              restart it — an admin of your organization can see to that.
            </template>
          </p>
        </template>
      </NoticeCard>

      <!--
        A dead socket under an `open` that never wavers (#205): a send or a
        group lookup failed with Connection Closed, and Evolution has not
        reopened the socket since. Its session is stuck; Reconnect answers 409
        from `open`, so again nobody gets a button.
      -->
      <NoticeCard v-else-if="socketStuck" title="This account has stopped sending and receiving" tone="error">
        <template #description>
          <p class="mt-1 text-sm text-muted-foreground">
            It reads as connected, but its last attempts to reach WhatsApp failed:
            Evolution's session for it is stuck, so sends fail and new messages
            are not arriving.
            <template v-if="operatorAlerted">
              This is on our side: we have been alerted and will restart the
              service. Nothing needs scanning, the phone stays linked, and there
              is nothing you need to do.
            </template>
            <template v-else-if="canManage">
              Reconnect cannot end this. Restarting {{ evolutionServer }} does, with
              no new QR scan.
            </template>
            <template v-else>
              Nothing needs scanning. Whoever runs {{ evolutionServer }} has to
              restart it — an admin of your organization can see to that.
            </template>
          </p>
        </template>
      </NoticeCard>

      <SessionLostNotice
        v-else-if="mode === 'lost'"
        service="WhatsApp"
        :can-manage="canManage"
        :reconnecting="reconnecting"
        :stalled="reconnectStalled"
        :busy="reconnectBusy"
        :can-reconnect="canReconnect"
        @reconnect="reconnect"
      >
        <template #hint>
          The phone is still linked, so reconnecting normally needs no new QR code.
        </template>
        <template #stalled>
          <template v-if="canReconnect">
            Evolution did not bring the connection back. Its session for this account
            may be stuck — restarting {{ evolutionServer }} usually reconnects it
            without a new scan.
          </template>
          <template v-else-if="state === 'connecting'">
            Evolution is still trying to connect this account. If it does not settle
            within a minute or two, restarting {{ evolutionServer }} reconnects it
            without a new scan.
          </template>
          <template v-else>
            Evolution has no live connection for this account. Restarting
            {{ evolutionServer }} reconnects it without a new scan.
          </template>
        </template>
      </SessionLostNotice>

      <MessagingOverview
        :id="id"
        kind="whatsapp"
        :profile="{ name: data?.profileName || 'WhatsApp', detail: data?.number || '—', picUrl: data?.profilePicUrl }"
        :stats="data?.stats"
        :can-read-messages="data?.instance.canReadMessages !== false"
      />

      <!-- The last sentence points at a section a member does not have, and
           re-importing costs a QR scan on a real phone — so they are told what
           the counts mean, not how to change them. -->
      <p v-if="data?.historyLimitedByPlan" class="text-xs text-muted-foreground">
        Your plan imports recent history only: when a device is linked, WhatsApp
        hands over the recent part of your conversations, and everything since is
        kept. Older messages are not imported.
        <UpgradeLink v-if="canManage">
          to import an account's full history.
        </UpgradeLink>
      </p>
      <p v-else class="text-xs text-muted-foreground">
        WhatsApp hands over its history only at the moment a device is linked, so
        these counts are the import from pairing plus everything since.
        <template v-if="canManage">
          If an old conversation is missing, re-import it under Manage.
        </template>
        <template v-else>
          If an old conversation is missing, an admin of your organization can
          re-import it.
        </template>
      </p>
    </template>

    <Separator />

    <DbUrlNotice v-if="needsDbUrl" :id="id" kind="whatsapp" @saved="refresh()" />

    <!--
      Always shown, including while disconnected. Hiding it would mean you
      cannot revoke a token for an account that is offline — which is exactly
      when you are most likely to want to.
    -->
    <McpTokens
      :instance-id="id"
      kind="whatsapp"
      :connected="connected"
      :can-manage="canManage"
    />

    <template v-if="canManage">
      <Separator />

      <!-- ── controls ──────────────────────────────────────────────────── -->
      <section class="space-y-4">
        <h2 class="font-heading text-lg font-semibold">
          Manage
        </h2>

        <div class="flex flex-wrap gap-3">
          <ConfirmAction
            v-if="connected"
            label="Disconnect"
            title="Disconnect this account?"
            confirm-label="Disconnect"
            :disabled="busy"
            @confirm="disconnect"
          >
            WhatsApp signs this device out. Your tokens and message history are
            kept, but nothing can send or receive until you scan a new QR code
            with the same phone.
          </ConfirmAction>

          <!-- Hidden rather than left to fail: the server refuses it with 402
               on a plan limited to recent history, and the note above says
               why and where to upgrade. -->
          <ConfirmAction
            v-if="!data?.historyLimitedByPlan"
            label="Import full history"
            title="Import this account's full history?"
            confirm-label="Disconnect and import"
            :disabled="busy"
            @confirm="importHistory"
          >
            WhatsApp only hands over past conversations while a device is being
            linked, so this signs the device out and imports as you scan a new
            QR code with the same phone. Nothing already stored is lost, and
            nothing can send or receive until the scan completes. Repeatedly
            linking and unlinking a number risks it being banned by WhatsApp.
          </ConfirmAction>

          <AssignConnectionDialog :id="id" kind="whatsapp" />

          <DeleteConnectionDialog :id="id" :label="data?.instance.label" kind="whatsapp" />
        </div>
      </section>
    </template>
  </div>
</template>
