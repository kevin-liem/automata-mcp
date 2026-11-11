<script setup lang="ts">
import { DatabaseIcon, MailIcon, MessageCircleIcon, SendIcon } from '@lucide/vue'
import { assertNever } from '#shared/connection'

/**
 * One connection in the listing.
 *
 * The secondary line and the footer say different things per kind because the
 * facts are different: a WhatsApp account has a profile and message counts, a
 * database has a host and a server version. Rendering a zeroed message count for
 * a database would suggest it has messages.
 */
const props = defineProps<{ instance: InstanceListRow }>()

/**
 * What the card's two lines carry. A database and a mailbox both show where
 * they point and a line of health; only the messaging accounts have a profile
 * and message counts.
 */
const layout = computed<'target' | 'messaging'>(() => {
  const kind = props.instance.kind
  switch (kind) {
    case 'postgres':
    case 'imap':
      return 'target'
    case 'whatsapp':
    case 'telegram':
      return 'messaging'
    default:
      return assertNever(kind, 'connection kind')
  }
})

const kindIcon = computed(() => {
  const kind = props.instance.kind
  switch (kind) {
    case 'postgres':
      return DatabaseIcon
    case 'whatsapp':
      return MessageCircleIcon
    case 'telegram':
      return SendIcon
    case 'imap':
      return MailIcon
    default:
      return assertNever(kind, 'connection kind')
  }
})

const secondary = computed(() => {
  if (layout.value === 'target') return props.instance.target || 'No credentials stored'
  return props.instance.profileName || props.instance.number || 'Not paired yet'
})
</script>

<template>
  <NuxtLink :to="`/instances/${instance.id}`" class="block">
    <Card class="transition-colors hover:border-foreground/20">
      <CardHeader>
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <CardTitle class="flex items-center gap-2 truncate">
              <component :is="kindIcon" class="size-4 shrink-0 text-muted-foreground" />
              {{ instance.label }}
            </CardTitle>
            <CardDescription :class="layout === 'target' && 'font-mono text-xs'">
              <ScrollOnHover :text="secondary" />
            </CardDescription>
          </div>
          <ConnectionBadge :state="instance.state" :kind="instance.kind" :lost="instance.sessionLost" :flapping="instance.flapping" :stalled="instance.stalled" />
        </div>
      </CardHeader>
      <CardContent>
        <p v-if="layout === 'target'" class="truncate text-sm text-muted-foreground">
          {{ instance.detail || (instance.kind === 'imap' ? 'IMAP mailbox' : 'PostgreSQL') }}
        </p>
        <p v-else-if="instance.stats" class="text-sm text-muted-foreground tabular-nums">
          {{ instance.stats.messages }} messages · {{ instance.stats.chats }} chats
        </p>
      </CardContent>
    </Card>
  </NuxtLink>
</template>
