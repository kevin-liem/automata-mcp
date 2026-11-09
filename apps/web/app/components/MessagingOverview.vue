<script setup lang="ts">
import type { Component } from 'vue'
import { BookUserIcon, MessageSquareTextIcon, MessagesSquareIcon, SendIcon, SmartphoneIcon } from '@lucide/vue'
import { assertNever } from '#shared/connection'

/**
 * A messaging account at a glance, in one row: who it is, then its counts —
 * Messages, Chats and, where the kind keeps an address book, Contacts. Each
 * count opens the table behind it.
 *
 * Shared by WhatsApp and Telegram so the two dashboards cannot drift apart
 * again; what differs between them arrives as data, not as markup.
 */
const props = defineProps<{
  id: string
  kind: Extract<InstanceKind, 'whatsapp' | 'telegram'>
  profile: { name: string, detail: string, picUrl?: string }
  /**
   * Absent when the counts could not be measured in time; the cards then show a
   * dash rather than a 0 that reads as an empty account. `contacts` is absent
   * for a kind that keeps none.
   */
  stats?: { messages: number, chats: number, contacts?: number }
  /**
   * Messages is clickable only where the table behind it can answer. Reading
   * goes to the backend's own database, and a connection that has not been
   * given one would open onto a guaranteed refusal — the same fact
   * `DbUrlNotice` explains at length.
   */
  canReadMessages: boolean
}>()

/** Stands in for a profile picture, which only WhatsApp provides. */
const fallbackIcon = computed<Component>(() => {
  switch (props.kind) {
    case 'whatsapp':
      return SmartphoneIcon
    case 'telegram':
      return SendIcon
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

/** From the kind, not from `stats`: missing counts must not remove the card. */
const hasContacts = computed(() => {
  switch (props.kind) {
    case 'whatsapp':
      return true
    case 'telegram':
      return false
    default:
      return assertNever(props.kind, 'connection kind')
  }
})

const chatsOpen = ref(false)
const messagesOpen = ref(false)
const contactsOpen = ref(false)
</script>

<template>
  <!-- Full class strings rather than an interpolated count, so Tailwind sees them. -->
  <div class="grid gap-4 sm:grid-cols-2" :class="hasContacts ? 'lg:grid-cols-4' : 'lg:grid-cols-3'">
    <!-- The profile sits in the same row as the counts, so it stretches to
         their height and centres its contents rather than riding the top. -->
    <Card>
      <CardContent class="flex flex-1 items-center gap-4 pt-6">
        <img
          v-if="profile.picUrl"
          :src="profile.picUrl"
          alt=""
          class="size-12 shrink-0 rounded-full object-cover"
        >
        <span v-else class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted">
          <component :is="fallbackIcon" class="size-5 text-muted-foreground" />
        </span>
        <div class="min-w-0">
          <p class="truncate font-medium">
            {{ profile.name }}
          </p>
          <p class="truncate text-sm text-muted-foreground tabular-nums">
            {{ profile.detail }}
          </p>
        </div>
      </CardContent>
    </Card>

    <StatCard
      label="Messages"
      :value="stats?.messages"
      :icon="MessageSquareTextIcon"
      :clickable="canReadMessages"
      @click="messagesOpen = true"
    />
    <StatCard
      label="Chats"
      :value="stats?.chats"
      :icon="MessagesSquareIcon"
      clickable
      @click="chatsOpen = true"
    />
    <StatCard
      v-if="hasContacts"
      label="Contacts"
      :value="stats?.contacts"
      :icon="BookUserIcon"
      clickable
      @click="contactsOpen = true"
    />
  </div>

  <ChatsDialog
    v-model:open="chatsOpen"
    :instance-id="id"
    :kind="kind"
    :total="stats?.chats"
  />

  <MessagesDialog
    v-model:open="messagesOpen"
    :instance-id="id"
    :kind="kind"
    :total="stats?.messages"
  />

  <ContactsDialog
    v-if="hasContacts"
    v-model:open="contactsOpen"
    :instance-id="id"
  />
</template>
