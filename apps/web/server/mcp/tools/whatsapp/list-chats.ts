/**
 * Read tool. Chat scope is applied by filtering rather than refusing — a listing
 * is the honest answer to "what can I see", so a scoped token sees its own
 * conversations and simply does not learn the others exist.
 *
 * **This answers with one page, and says so.** `listChats` returns a `ChatPage`
 * whose `hasMore` means "more conversations exist past this page", and dropping it here left the
 * only read tool that presents a page as a complete listing — the exact gap
 * `read-messages` and `list-tables` both carry an envelope to close. A model
 * told nothing concludes these are all the conversations there are.
 *
 * No page-size or offset argument, though, and that is not an omission: the
 * page size stays this server's decision, and one large page is what a model
 * needs to find a chat.
 *
 * Fresh within a minute, not live: the account's whole listing is read once
 * and shared by every page and caller for `CHAT_ACTIVITY_TTL_MS` (`chats.ts`,
 * #174), so a chat whose message arrived seconds ago can still sit lower down.
 *
 * `phoneNumber` on a LID chat discloses nothing a token could not already reach:
 * its evidence is the LID chat's own rows, and `filterChatsToScope` keeps it only
 * when the LID is in scope. A person folded into one row (`jids`) is cut to the
 * halves the token holds, never widened — scope is literal JIDs — and a cut
 * half is reported as a count, not an id.
 */
export default defineKindTool({
  name: 'list-chats',
  kind: 'whatsapp',
  title: 'List WhatsApp chats',
  description:
    'List recent WhatsApp conversations, most recently active first, with the '
    + '`jid` needed by read-messages and send-text-message. `number` is present only '
    + 'for chats addressed by phone number: a jid ending in `@lid` is a WhatsApp '
    + 'privacy alias whose digits are not a phone number. A `@lid` chat carries `phoneNumber` only '
    + 'when WhatsApp has revealed the number behind it on a live message; its absence means the '
    + 'number is unknown to this connector, not that the person has none. Even when present, '
    + 'reply by the chat\'s `jid`, never by `phoneNumber`. A person WhatsApp stored under both a '
    + '`@lid` and their phone number is listed once, under the `@lid`, with both ids in `jids`; '
    + 'read-messages on that `jid` reads both. `linkedOutOfScope` means part of that person\'s '
    + 'conversation is under an id this connector may not read. Includes conversations imported from the '
    + 'phone when the account was paired, not only ones active since. If this '
    + 'connector is scoped to specific chats, only those are listed. This '
    + 'answers with one page, most recently active first: when `hasMore` is true '
    + 'there are older conversations it did not include, so do not report the '
    + 'list as complete or conclude that a chat does not exist — search-messages '
    + 'finds a conversation by what was said in it. It carries no read or unread '
    + 'status: whether the user has read a message is not available to this '
    + 'connector, so say so rather than telling the user they have, or have no, '
    + 'unread messages. Timestamps are UTC.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance, scope } = useMcpAuth()

    // Fetches a page and filters. A scoped token with chats far down a very long
    // list could miss some; raise the page size here if that becomes real.
    const { chats, hasMore } = await listChats(instance)
    const visible = filterChatsToScope(scope, chats)

    return {
      // `count` is what survived scope; `hasMore` is about the page underneath
      // it, so a scoped token can legitimately see few chats and still be told
      // there are more.
      count: visible.length,
      hasMore,
      ...(hasMore && {
        note: 'This is one page of conversations, ordered by most recent activity, '
          + 'and there are older ones it does not include. Do not tell the user '
          + 'these are all their chats. Use search-messages to find a conversation '
          + 'by what was said in it rather than assuming it does not exist.',
      }),
      chats: visible,
    }
  },
})
