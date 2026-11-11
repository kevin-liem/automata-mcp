<script setup lang="ts">
import { KeyRoundIcon } from '@lucide/vue'

const props = defineProps<{
  open: boolean
  kind: InstanceKind
  /** The token's name, so the dialog says which one it is describing. */
  label?: string
  scope?: TokenScope
  /**
   * The plaintext token, known only in the moment it is minted. Everywhere else
   * the list endpoint has no token material to give, so the URL is masked.
   */
  token?: string | null
}>()

const emit = defineEmits<{ 'update:open': [boolean], 'create': [] }>()

const { connectorUrl, bearerUrl } = useConnectorUrl()

const known = computed(() => Boolean(props.token))
const url = computed(() => connectorUrl(props.token))
const authHeader = computed(() => `Authorization: Bearer ${props.token || MASKED_TOKEN}`)
// The CLI needs a name for the server. The kind itself, rather than a hardcoded
// or two-way choice, so no connector is added to Claude under another kind's name.
const serverName = computed(() => props.kind)
const cliCommand = computed(() => `claude mcp add --transport http ${serverName.value} ${url.value}`)
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {{ label ? `How to connect “${label}”` : 'How to connect' }}
        </DialogTitle>
        <DialogDescription>
          This token adds one {{ describeKind(kind) }} to Claude. The steps differ by client.
        </DialogDescription>
      </DialogHeader>

      <p v-if="scope" class="text-sm">
        <span class="text-muted-foreground">Scope:</span> {{ describeScope(scope, kind) }}
      </p>

      <div v-if="!known" class="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
        <div class="flex items-start gap-2">
          <KeyRoundIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            The token is shown once, when it is created — only a hash is stored, so
            it cannot be recovered. It is masked below. If you no longer have it,
            create a new token and revoke this one.
          </p>
        </div>
        <Button variant="outline" size="sm" @click="emit('create')">
          Create new token
        </Button>
      </div>

      <Tabs default-value="web" class="min-w-0 gap-4">
        <TabsList class="w-full">
          <TabsTrigger value="web">
            Claude.ai
          </TabsTrigger>
          <TabsTrigger value="code">
            Claude Code
          </TabsTrigger>
          <TabsTrigger value="bearer">
            Bearer
          </TabsTrigger>
          <TabsTrigger value="inspector">
            Inspector
          </TabsTrigger>
        </TabsList>

        <TabsContent value="web" class="min-w-0">
          <ol class="list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
            <li>Open Claude on the web or in the desktop app, then go to <strong class="font-semibold">Settings → Customize → Connectors</strong>.</li>
            <li>Click <strong class="font-semibold">Add → Add custom connector</strong>.</li>
            <li>
              <p class="mb-2">Give it a name and paste this URL:</p>
              <CopyableSnippet :value="url" :copyable="known" aria-label="Copy connector URL" />
            </li>
            <li>Click <strong class="font-semibold">Add</strong>, then turn the connector on from the tools menu in a chat.</li>
          </ol>
        </TabsContent>

        <TabsContent value="code" class="min-w-0 space-y-2">
          <p class="text-sm">
            Run this in your project. Add <code class="font-mono">--scope user</code> to
            make it available in every project instead.
          </p>
          <CopyableSnippet :value="cliCommand" :copyable="known" wrap aria-label="Copy command" />
          <p class="text-xs text-muted-foreground">
            Confirm it registered with <code class="font-mono">claude mcp list</code>.
          </p>
        </TabsContent>

        <TabsContent value="bearer" class="min-w-0 space-y-4">
          <p class="text-sm">
            For clients that can set request headers. The token travels in the
            header instead of the URL, so point them at the plain endpoint.
          </p>
          <div class="min-w-0 space-y-2">
            <Label>Endpoint</Label>
            <CopyableSnippet :value="bearerUrl" aria-label="Copy endpoint URL" />
          </div>
          <div class="min-w-0 space-y-2">
            <Label>Header</Label>
            <CopyableSnippet :value="authHeader" :copyable="known" aria-label="Copy authorization header" />
          </div>
        </TabsContent>

        <TabsContent value="inspector" class="min-w-0 space-y-4">
          <div class="min-w-0 space-y-2">
            <p class="text-sm">
              Inspect the endpoint by hand:
            </p>
            <CopyableSnippet value="pnpm dlx @modelcontextprotocol/inspector" aria-label="Copy inspector command" />
          </div>
          <div class="min-w-0 space-y-2">
            <p class="text-sm">
              Point it at the connector URL:
            </p>
            <CopyableSnippet :value="url" :copyable="known" aria-label="Copy connector URL" />
            <p class="text-xs text-muted-foreground">
              Or at <code class="font-mono">{{ bearerUrl }}</code> with the
              <code class="font-mono">Authorization</code> header from the Bearer tab.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      <DialogFooter>
        <Button @click="emit('update:open', false)">
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
