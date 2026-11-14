<script setup lang="ts">
const { data } = await useFetch<{ enabled: boolean, resource?: string }>('/api/mcp-oauth/status')
</script>

<template>
  <Card v-if="data?.enabled && data.resource">
    <CardContent class="space-y-3 p-6">
      <h3 class="font-heading font-semibold">Connect with OAuth</h3>
      <p class="text-sm text-muted-foreground">
        Add this URL in ChatGPT, Codex, Gemini, or Claude. Sign in here and choose a connector token by name to approve its permissions.
      </p>
      <CopyableSnippet :value="data.resource" aria-label="OAuth MCP URL" />
      <a href="/oauth/connections" class="text-sm underline underline-offset-4">Manage connected agents</a>
    </CardContent>
  </Card>
</template>
