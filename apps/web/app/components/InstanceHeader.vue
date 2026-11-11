<script setup lang="ts">
import { ArrowLeftIcon } from '@lucide/vue'

/**
 * The top of every connection dashboard: the way back, the name, one line
 * about the connection, and its state.
 *
 * The subtitle is a slot because it is the one line of this block that differs
 * per kind — a WhatsApp or Telegram hint, a database's DSN — and branching on
 * kind in here would put three panels' copy into one file.
 */
const props = withDefaults(defineProps<{
  id: string
  label?: string
  canManage?: boolean
  state: ConnectionState
  kind: InstanceKind
  /** A messaging session that dropped; see `ConnectionBadge`. */
  lost?: boolean
  /** A WhatsApp reconnect loop; see `ConnectionBadge`. */
  flapping?: boolean
  /** A WhatsApp socket dead under a live `open`; see `ConnectionBadge`. */
  stalled?: boolean
}>(), { canManage: false, lost: false, flapping: false, stalled: false })

defineEmits<{ renamed: [] }>()
</script>

<template>
  <div>
    <NuxtLink to="/instances" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeftIcon class="size-4" />
      All connections
    </NuxtLink>

    <div class="group/title mt-2 flex items-start justify-between gap-4">
      <div class="min-w-0">
        <InstanceTitle
          :id="props.id"
          :label="props.label"
          :can-manage="props.canManage"
          @renamed="$emit('renamed')"
        />
        <slot />
      </div>
      <ConnectionBadge :state="props.state" :kind="props.kind" :lost="props.lost" :flapping="props.flapping" :stalled="props.stalled" />
    </div>
  </div>
</template>
