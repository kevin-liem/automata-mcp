<script setup lang="ts">
// "Upgrade" to the Billing page, then the slot saying what upgrading buys.
// Renders nothing where there is no billing (self-hosted).
const { billing } = usePlan()
</script>

<template>
  <template v-if="billing">
    <NuxtLink to="/billing" class="underline underline-offset-2">
      Upgrade
    </NuxtLink>
    <slot />
  </template>
</template>
