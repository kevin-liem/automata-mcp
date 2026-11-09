<script setup lang="ts">
import type { Component } from 'vue'
import {
  AppleIcon,
  CloudIcon,
  DatabaseIcon,
  HardDriveIcon,
  LeafIcon,
  MailIcon,
  MessageCircleIcon,
  SendIcon,
  SmartphoneIcon,
} from '@lucide/vue'

/**
 * Pick a kind, then fill in that kind's form.
 *
 * Creating happens on an explicit click, not on mount. Provisioning a WhatsApp
 * account reserves a live socket on the Evolution server, so a page refresh must
 * not silently create a second one — and a database connection is proved by
 * actually connecting, which is not something a refresh should re-do either.
 */
const kind = ref<InstanceKind | undefined>()
const label = ref('')
const busy = ref(false)

// An organization at its connection limit is told so before it fills in a
// form the server will refuse. Never fetched without limits, so a self-hosted
// deployment makes no such request.
const { limited, billing, recentHistoryOnly } = usePlan()
const { data: billingInfo } = await useFetch<{ usage: { connections: number }, limits: { connections?: number } | null }>(
  '/api/billing',
  { immediate: limited.value, server: false },
)
const atConnectionLimit = computed(() => {
  const limit = billingInfo.value?.limits?.connections
  return limited.value && limit != null && (billingInfo.value?.usage.connections ?? 0) >= limit
})

interface KindCard {
  title: string
  description: string
  icon: Component
}

/**
 * The picker's copy for the kinds that exist, keyed on `InstanceKind` rather
 * than listed in an array on purpose: adding a member to that union then fails
 * to compile here, the same reason every per-kind branch is a `switch` ending in
 * `assertNever`. A card silently missing from the picker is a kind nobody can
 * create.
 */
const kindCards: Record<InstanceKind, KindCard> = {
  whatsapp: {
    title: 'WhatsApp account',
    description: 'Pair a phone by scanning a QR code. Claude can read and send messages.',
    icon: MessageCircleIcon,
  },
  telegram: {
    title: 'Telegram account',
    description: 'Link your account by scanning a QR code. Claude can read and send messages.',
    icon: SendIcon,
  },
  postgres: {
    title: 'PostgreSQL database',
    description: 'Point Claude at a database with a connection string or its parameters. Read-only by default.',
    icon: DatabaseIcon,
  },
  imap: {
    title: 'Email (IMAP)',
    description: 'Connect a mailbox with its IMAP login. Claude can list, search and read email and its attachments.',
    icon: MailIcon,
  },
}

/**
 * Presentation order, which the record above does not carry, plus the kinds that
 * do not exist yet. Those are listed so the answer to "can it do MySQL?" is on
 * the page rather than inferred from an absence — no dates are promised.
 */
const groups: {
  heading: string
  kinds: InstanceKind[]
  soon: KindCard[]
}[] = [
  {
    heading: 'Messaging apps',
    kinds: ['whatsapp', 'telegram'],
    soon: [
      {
        title: 'iMessage',
        description: 'Read and send from the Messages account on a Mac.',
        icon: AppleIcon,
      },
      {
        title: 'SMS',
        description: 'Read and send text messages through an SMS provider.',
        icon: SmartphoneIcon,
      },
    ],
  },
  {
    heading: 'Email',
    kinds: ['imap'],
    soon: [],
  },
  {
    heading: 'Databases',
    kinds: ['postgres'],
    soon: [
      {
        title: 'MySQL',
        description: 'Point Claude at a MySQL or MariaDB database with a connection string.',
        icon: DatabaseIcon,
      },
      {
        title: 'SQLite',
        description: 'Point Claude at a SQLite database file.',
        icon: HardDriveIcon,
      },
      {
        title: 'MongoDB',
        description: 'Point Claude at a MongoDB deployment with a connection string.',
        icon: LeafIcon,
      },
      {
        title: 'DynamoDB',
        description: 'Point Claude at DynamoDB tables in an AWS account.',
        icon: CloudIcon,
      },
    ],
  },
]

// WhatsApp and Telegram: bring-your-own server (an Evolution server, or a Telegram
// bridge). All or nothing — half of it is not completed from our configuration,
// see evolutionAdminCredentials() and telegramAdminCredentials().
const ownServer = ref(false)
// Bring-your-own is self-hosted only: the hosted service refuses it
// (`ownServersAllowed` in server/utils/cloud.ts), so the option is not offered.
// Hiding it is presentation; the server is the control.
const hosted = useHosted()
watch(hosted, (isHosted) => {
  if (isHosted) ownServer.value = false
}, { immediate: true })
const serverUrl = ref('')
const serverKey = ref('')
// Optional even with a server: it only buys reading. Pairing and sending work
// without it, and asking for a database credential up front would be a poor
// trade for someone who only wants Claude to send.
const serverDbUrl = ref('')

// WhatsApp: ask for the full history at pairing. Off by default for everyone.
// The plan's limit covers the deployment's server only — a user's own server is
// their disk — so the box locks only while that is the one in use, and is
// cleared if it becomes so. The server refuses it on its own (402) either way.
const fullHistory = ref(false)
const fullHistoryLocked = computed(() => recentHistoryOnly.value && !ownServer.value)
watch(fullHistoryLocked, (locked) => {
  if (locked) fullHistory.value = false
})

// Postgres
const dsn = ref('')

// IMAP
const imap = ref<ImapCredentials>(emptyImapCredentials())

// Whether this deployment's own Telegram bridge can serve Telegram — asked when
// Telegram is picked, so a bridge running without its API credentials says what
// to set before the form is filled in rather than on the click. Re-asked on every
// pick, so an operator who has just set the variables does not need a reload.
type BridgeReadiness = 'absent' | 'ready' | 'unconfigured' | 'unreachable'
const telegramReadiness = ref<BridgeReadiness>()

watch(kind, async (picked) => {
  if (picked !== 'telegram') return
  telegramReadiness.value = undefined
  try {
    const { deploymentBridge } = await $fetch<{ deploymentBridge: BridgeReadiness }>('/api/telegram/readiness')
    telegramReadiness.value = deploymentBridge
  }
  catch {
    // Unknown is not a refusal: the create call still answers for itself.
    telegramReadiness.value = undefined
  }
})

// Only the deployment's bridge is blocked; a user's own bridge is theirs to set
// up, and the create call reports its state.
const telegramBlocked = computed(() =>
  kind.value === 'telegram'
  && !ownServer.value
  && (telegramReadiness.value === 'unconfigured' || telegramReadiness.value === 'absent'),
)

const canSubmit = computed(() => {
  if (busy.value) return false
  if (kind.value === 'postgres') return dsn.value.trim().length > 0
  if (kind.value === 'imap') return imapCredentialsBody(imap.value) !== undefined
  if (kind.value === 'whatsapp' || kind.value === 'telegram') {
    if (!ownServer.value) return !telegramBlocked.value
    return serverUrl.value.trim().length > 0 && serverKey.value.trim().length > 0
  }
  return false
})

async function create() {
  if (!canSubmit.value) return
  busy.value = true

  const body = kind.value === 'postgres'
    ? { kind: 'postgres', label: label.value, dsn: dsn.value.trim() }
    : kind.value === 'imap'
    ? { kind: 'imap', label: label.value, ...imapCredentialsBody(imap.value) }
    : {
        kind: kind.value,
        label: label.value,
        ...(kind.value === 'whatsapp' && { fullHistory: fullHistory.value }),
        ...(ownServer.value && {
          server: {
            baseUrl: serverUrl.value.trim(),
            adminKey: serverKey.value.trim(),
            ...(serverDbUrl.value.trim() && { dbUrl: serverDbUrl.value.trim() }),
          },
        }),
      }

  try {
    const { instance } = await $fetch<{ instance: { id: string } }>('/api/instances', {
      method: 'POST',
      body,
    })
    await navigateTo(`/instances/${instance.id}`)
  }
  catch (err: any) {
    // The server's message is the useful part here — it names the bad host, the
    // refused address or the connection error — so show it rather than a generic.
    toastApiError(err, 'Could not create the connection', { isAdmin: true })
    busy.value = false
  }
}
</script>

<template>
  <!--
    The picker takes the layout's full width so its cards sit in a grid; the
    form for a chosen kind is a single column of inputs and stays narrow.
  -->
  <div class="mx-auto space-y-6" :class="kind ? 'max-w-md' : 'max-w-5xl'">
    <div>
      <h1 class="font-heading text-2xl font-semibold">
        Add a connection
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Each connection gets its own Claude connector, and each connector token
        reaches exactly one connection.
      </p>
    </div>

    <NoticeCard
      v-if="atConnectionLimit"
      :title="`Your plan includes ${billingInfo?.limits?.connections} connection${billingInfo?.limits?.connections === 1 ? '' : 's'}`"
    >
      <template #description>
        <p class="mt-1 text-sm text-muted-foreground">
          Upgrade for more connections and connector tokens, or delete an
          existing connection to add a different one.
        </p>
      </template>
      <Button as-child size="sm">
        <NuxtLink to="/billing">
          See plans
        </NuxtLink>
      </Button>
    </NoticeCard>

    <!-- ── kind ─────────────────────────────────────────────────────────── -->
    <div v-else-if="!kind" class="space-y-6">
      <section v-for="group in groups" :key="group.heading" class="space-y-3">
        <h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {{ group.heading }}
        </h2>

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button
            v-for="available in group.kinds"
            :key="available"
            type="button"
            class="flex h-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent"
            @click="kind = available"
          >
            <component :is="kindCards[available].icon" class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <span>
              <span class="block font-medium">{{ kindCards[available].title }}</span>
              <span class="block text-sm text-muted-foreground">
                {{ kindCards[available].description }}
              </span>
            </span>
          </button>

          <!--
            Nothing to press, so not a control at all: a disabled button still
            reads as one that should work.
          -->
          <div
            v-for="card in group.soon"
            :key="card.title"
            class="flex h-full items-start gap-3 rounded-lg border border-dashed p-4 opacity-60"
          >
            <component :is="card.icon" class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-medium">{{ card.title }}</span>
                <Badge variant="secondary">
                  Coming soon
                </Badge>
              </div>
              <span class="block text-sm text-muted-foreground">
                {{ card.description }}
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ── the form for the chosen kind ─────────────────────────────────── -->
    <template v-else>
      <Card>
        <CardContent class="space-y-4 pt-6">
          <div class="space-y-2">
            <Label for="label">Name this connection</Label>
            <Input
              id="label"
              v-model="label"
              :placeholder="kind === 'postgres' ? 'Production analytics' : kind === 'telegram' ? 'Personal Telegram' : kind === 'imap' ? 'Work inbox' : 'Work phone'"
              @keydown.enter="create"
            />
            <p class="text-xs text-muted-foreground">
              Just for you — it helps when you have more than one.
            </p>
          </div>

          <!-- Postgres -->
          <template v-if="kind === 'postgres'">
            <Separator />
            <div class="space-y-2">
              <PostgresDsnInput v-model="dsn" id-prefix="dsn" />
              <p class="text-xs text-muted-foreground">
                Checked by actually connecting before it is saved, and never shown
                again afterwards. It is stored so this app can reconnect, so treat
                the password in it as one this server holds.
              </p>
            </div>
          </template>

          <!-- IMAP -->
          <template v-else-if="kind === 'imap'">
            <Separator />
            <div class="space-y-2">
              <ImapCredentialsInput v-model="imap" id-prefix="imap" />
              <p class="text-xs text-muted-foreground">
                Checked by logging in before it is saved, and never shown again
                afterwards. The password is stored so this app can sync, so use an
                app password you can revoke on its own.
              </p>
            </div>
          </template>

          <!-- Telegram -->
          <template v-else-if="kind === 'telegram'">
            <template v-if="!hosted">
              <Separator />
              <div class="flex items-start gap-2">
                <Checkbox
                  id="own-bridge"
                  :model-value="ownServer"
                  @update:model-value="value => ownServer = value === true"
                />
                <div class="space-y-1">
                  <Label for="own-bridge" class="font-normal">
                    Use my own Telegram bridge
                  </Label>
                  <p class="text-xs text-muted-foreground">
                    Bring your own bridge for more privacy. Leave it off to use the
                    one this app is configured with.
                  </p>
                </div>
              </div>
            </template>

            <template v-if="!ownServer">
              <NoticeCard
                v-if="telegramReadiness === 'unconfigured'"
                title="Telegram isn't set up on this deployment yet"
              >
                <template #description>
                  <p class="mt-1 text-sm text-muted-foreground">
                    Create an app at
                    <a href="https://my.telegram.org" target="_blank" rel="noopener" class="underline">my.telegram.org</a>
                    (API development tools), then set
                    <span class="font-mono">TELEGRAM_API_ID</span> and
                    <span class="font-mono">TELEGRAM_API_HASH</span> on the Telegram
                    bridge service and redeploy it. If you don't run this deployment,
                    ask whoever does<template v-if="!hosted"> — or use your own bridge</template>.
                  </p>
                </template>
              </NoticeCard>
              <NoticeCard
                v-else-if="telegramReadiness === 'absent'"
                title="This deployment has no Telegram bridge"
              >
                <template #description>
                  <p class="mt-1 text-sm text-muted-foreground">
                    Set <span class="font-mono">NUXT_TELEGRAM_URL</span> and
                    <span class="font-mono">NUXT_TELEGRAM_ADMIN_KEY</span> on the web
                    service to use one<template v-if="!hosted">, or use your own bridge</template>.
                  </p>
                </template>
              </NoticeCard>
              <NoticeCard
                v-else-if="telegramReadiness === 'unreachable'"
                tone="error"
                title="The Telegram bridge is not answering"
              >
                <template #description>
                  <p class="mt-1 text-sm text-muted-foreground">
                    It may still be starting. You can try anyway, or check the
                    bridge service's logs.
                  </p>
                </template>
              </NoticeCard>
            </template>

            <div v-if="ownServer" class="space-y-4 rounded-md border p-3">
              <div class="space-y-2">
                <Label for="bridge-url">Bridge URL</Label>
                <Input
                  id="bridge-url"
                  v-model="serverUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://telegram-bridge.example.com"
                />
              </div>
              <div class="space-y-2">
                <Label for="bridge-key">Admin key</Label>
                <Input
                  id="bridge-key"
                  v-model="serverKey"
                  type="password"
                  autocomplete="off"
                  placeholder="TELEGRAM_BRIDGE_ADMIN_KEY"
                />
                <p class="text-xs text-muted-foreground">
                  Your bridge's <span class="font-mono">TELEGRAM_BRIDGE_ADMIN_KEY</span>. It
                  creates and deletes sessions on that bridge.
                </p>
              </div>
              <div class="space-y-2">
                <Label for="bridge-db">Database connection string <span class="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="bridge-db"
                  v-model="serverDbUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="postgresql://user:password@host:5432/database"
                />
                <p class="text-xs text-muted-foreground">
                  Your bridge's database. Claude needs it to <span class="font-medium">read and
                  search</span> chats; linking and sending work without it, and you can add it later.
                </p>
              </div>
            </div>
          </template>

          <!-- WhatsApp -->
          <template v-else>
            <template v-if="!hosted">
              <Separator />
              <div class="flex items-start gap-2">
                <Checkbox
                  id="own-server"
                  :model-value="ownServer"
                  @update:model-value="value => ownServer = value === true"
                />
                <div class="space-y-1">
                  <Label for="own-server" class="font-normal">
                    Use my own Evolution API server
                  </Label>
                  <p class="text-xs text-muted-foreground">
                    Bring your own server for more privacy. Leave it off to use the
                    one this app is configured with.
                  </p>
                </div>
              </div>
            </template>

            <div v-if="ownServer" class="space-y-4 rounded-md border p-3">
              <div class="space-y-2">
                <Label for="server-url">Server URL</Label>
                <Input
                  id="server-url"
                  v-model="serverUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://evolution.example.com"
                />
              </div>
              <div class="space-y-2">
                <Label for="server-key">Global API key</Label>
                <Input
                  id="server-key"
                  v-model="serverKey"
                  type="password"
                  autocomplete="off"
                  placeholder="AUTHENTICATION_API_KEY"
                />
                <p class="text-xs text-muted-foreground">
                  This is your server's <span class="font-mono">AUTHENTICATION_API_KEY</span>.
                  It can create and delete instances on that server, so it is a
                  wider secret than the per-account token this app normally holds.
                </p>
              </div>

              <div class="space-y-2">
                <Label for="server-db">Database connection string <span class="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="server-db"
                  v-model="serverDbUrl"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="postgres://reader:password@host:5432/evolution"
                />
                <p class="text-xs text-muted-foreground">
                  Your Evolution server's own Postgres. Claude needs it to
                  <span class="font-medium">read and search</span> messages —
                  Evolution's API cannot search message content. Pairing, listing
                  chats and sending all work without it, and you can add it later.
                  A <span class="font-mono">SELECT</span>-only role is enough.
                </p>
              </div>
            </div>

            <div class="flex items-start gap-2">
              <Checkbox
                id="full-history"
                :model-value="fullHistory"
                :disabled="fullHistoryLocked"
                @update:model-value="value => fullHistory = value === true"
              />
              <div class="space-y-1">
                <Label for="full-history" class="font-normal" :class="fullHistoryLocked && 'text-muted-foreground'">
                  Import full history
                </Label>
                <p v-if="fullHistoryLocked" class="text-xs text-muted-foreground">
                  Your plan imports the recent part of your conversations when the
                  phone is linked.
                  <template v-if="billing">
                    <NuxtLink to="/billing" class="underline underline-offset-2">
                      Upgrade
                    </NuxtLink>
                    to import an account's full history.
                  </template>
                </p>
                <p v-else class="text-xs text-muted-foreground">
                  WhatsApp hands over past conversations only while the phone is
                  being linked. Leave this off to import the recent part of them;
                  turn it on to ask for everything the phone holds, which takes
                  longer and stores much more. Adding it later means scanning a
                  new QR code.
                </p>
              </div>
            </div>
          </template>

          <Button class="w-full" :disabled="!canSubmit" @click="create">
            <template v-if="busy">
              {{ kind === 'postgres' || kind === 'imap' ? 'Connecting…' : 'Setting up…' }}
            </template>
            <template v-else>
              {{ kind === 'postgres' ? 'Connect database' : kind === 'imap' ? 'Connect mailbox' : 'Continue to QR code' }}
            </template>
          </Button>

          <Button variant="ghost" class="w-full" :disabled="busy" @click="kind = undefined">
            Back
          </Button>
        </CardContent>
      </Card>

      <div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
        <template v-if="kind === 'postgres'">
          <p class="font-medium">
            Connect with a role that can do only what you need.
          </p>
          <p class="mt-1 text-muted-foreground">
            Per-token table allowlists keep Claude inside the tables you choose,
            but the real boundary is the database role: a role that can read
            everything can be talked into reading everything. Create a role with
            <span class="font-mono">GRANT SELECT</span> on just the tables you
            want, and use that here.
          </p>
        </template>
        <template v-else-if="kind === 'imap'">
          <p class="font-medium">
            Use an app password, not your account password.
          </p>
          <p class="mt-1 text-muted-foreground">
            Most providers issue app passwords for exactly this: one you can revoke
            without changing your main password. Microsoft 365 and Outlook.com no
            longer accept passwords over IMAP and cannot be connected this way.
            Headers sync here; message bodies and attachments are fetched from your
            mail server only when Claude asks, and never stored.
          </p>
        </template>
        <template v-else-if="kind === 'telegram'">
          <p class="font-medium">
            Use an account you are comfortable linking to a third-party app.
          </p>
          <p class="mt-1 text-muted-foreground">
            This app signs in as an unofficial Telegram client, which Telegram watches
            more closely than its own apps, and Telegram's API terms restrict using
            chats for AI. Linking happens on the next page, by QR code.
          </p>
        </template>
        <template v-else>
          <p class="font-medium">
            Use a phone number you can dedicate to this.
          </p>
          <p class="mt-1 text-muted-foreground">
            Pairing links a real WhatsApp account. Repeatedly pairing and
            unpairing a number, or sending unsolicited messages from a freshly
            paired one, can get it banned by WhatsApp.
          </p>
        </template>
      </div>
    </template>
  </div>
</template>
