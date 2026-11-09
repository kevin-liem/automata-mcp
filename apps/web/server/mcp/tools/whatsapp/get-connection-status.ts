/**
 * Example READ tool.
 *
 * Pattern to copy:
 *   - `title` is what MCP clients show in their UI; `description` is what the
 *     model reads to decide whether to call it.
 *   - `readOnlyHint: true` lets clients skip a human-in-the-loop confirmation.
 *   - No instance argument. The connector token is bound to one WhatsApp
 *     account, so `useEvolutionClient()` already resolves to it. Never accept
 *     an account identifier or an API key as a tool argument.
 */
export default defineKindTool({
  // Declared explicitly rather than derived from the filename, so renaming the
  // file cannot silently detach it from the token scopes that reference it.
  name: 'get-connection-status',
  kind: 'whatsapp',
  title: 'Check WhatsApp connection',
  description:
    'Report whether the connected WhatsApp account is currently online, along with '
    + 'the profile it is signed in as and how many messages, chats and contacts have '
    + 'been recorded. `stats` is absent when the counts could not be measured in time; '
    + 'that means unknown, not zero. Call this before sending anything: only an account in the '
    + '`open` state can send or receive. `flapping: true` means the account keeps '
    + 'reconnecting over and over even though it reads `open`: messages may be missed '
    + 'and sends may fail, and only restarting the Evolution service ends it. '
    + 'With `operatorAlerted: true` as well, the team running this service has '
    + 'already been alerted and will restart it, so the user has nothing to do. '
    + '`recentHistoryOnly: true` means the history imported when the account was '
    + 'linked is partial — recent messages only — so older conversations may be '
    + 'missing from reads and searches.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Reaches WhatsApp, an external system whose state this server does not own.
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance } = useMcpAuth()
    const [status, partialHistory] = await Promise.all([
      getInstanceStatus(instance),
      recentHistoryOnly(instance),
    ])
    // Omitted when false or unknown, as on the read tools.
    return { ...status, ...(partialHistory && { recentHistoryOnly: true }) }
  },
})
