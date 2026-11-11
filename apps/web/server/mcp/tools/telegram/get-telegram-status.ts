export default defineKindTool({
  name: 'get-telegram-status',
  kind: 'telegram',
  title: 'Check Telegram connection',
  description:
    'Report whether the connected Telegram account is online, which account it is '
    + 'signed in as, how many chats and messages have been synced, and whether older '
    + 'history is still being fetched. `sync.historyDays` is how many days back older '
    + 'history is fetched at all: messages older than that were never synced and cannot '
    + 'be read or searched, so say so rather than treating the oldest synced message as '
    + 'where a conversation began. Call this before sending: only an account in the '
    + '`open` state can send. `sessionLost` means the account is still linked and its '
    + 'connection dropped; `revoked` means the session was ended from Telegram, and the '
    + 'account has to be linked again by scanning a QR code in the web app.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance } = useMcpAuth()
    return await getTelegramStatus(instance)
  },
})
