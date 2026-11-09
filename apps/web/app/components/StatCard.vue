<script setup lang="ts">
import type { Component } from 'vue'
import { ChevronRightIcon } from '@lucide/vue'

/**
 * One number on the dashboard.
 *
 * `clickable` turns the whole card into a button rather than binding a click to
 * the card div, so the count is reachable and activatable by keyboard. The card
 * drops its own vertical padding in that mode and the button carries it instead,
 * so the focus ring hugs the card's border instead of floating inside it.
 */
const props = defineProps<{
  label: string
  /** Absent when the count could not be measured: shown as a dash, never as 0. */
  value?: number
  icon?: Component
  clickable?: boolean
}>()

defineEmits<{ click: [] }>()

const format = new Intl.NumberFormat()
</script>

<template>
  <Card :class="props.clickable && 'py-0 transition-colors hover:bg-accent/50'">
    <component
      :is="props.clickable ? 'button' : 'div'"
      :type="props.clickable ? 'button' : undefined"
      :class="props.clickable && 'w-full cursor-pointer rounded-xl py-6 text-left outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'"
      @click="props.clickable && $emit('click')"
    >
      <CardContent class="pt-6">
        <p class="flex items-center gap-1.5 text-sm text-muted-foreground">
          <component :is="icon" v-if="icon" class="size-4 shrink-0" />
          {{ label }}
          <ChevronRightIcon v-if="props.clickable" class="ml-auto size-4 shrink-0" />
        </p>
        <p class="mt-1 font-heading text-3xl font-semibold tabular-nums">
          {{ value === undefined ? '—' : format.format(value) }}
        </p>
      </CardContent>
    </component>
  </Card>
</template>
