import { z } from 'zod'

/**
 * Search tool. A named chat is asserted and refused loudly; an unnamed search is
 * narrowed to the token's chats in the SQL.
 */
export default defineKindTool({
  name: 'search-telegram-messages',
  kind: 'telegram',
  // A scan over the account's messages: the per-connection budget in mcp-rate-limit.ts.
  expensive: true,
  title: 'Search Telegram messages',
  description:
    'Find synced Telegram messages containing given words, newest first, across every '
    + 'chat unless `chatId` narrows it to one. Matching is case-insensitive and every word '
    + 'must appear in the same message. Matches message text and media captions only, '
    + 'against the current wording of edited messages; deleted messages are not '
    + 'searchable. Only synced history is searched, so finding nothing is not proof a '
    + 'message does not exist — list-telegram-chats shows which chats have incomplete '
    + 'history. A match you sent is marked `fromMe` and carries no `author`. When '
    + '`truncated` is true there were more matches than returned: narrow the search '
    + 'rather than reporting these as all of them.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    query: z.string().min(2).max(MAX_SEARCH_QUERY_LENGTH).describe(
      `Words to look for. All of them must appear in the message. At most ${MAX_SEARCH_TERMS} words `
      + `of at most ${MAX_SEARCH_TERM_LENGTH} characters each.`,
    ),
    chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id written as a string of digits').optional()
      .describe('Restrict to one chat, using a `chatId` from list-telegram-chats. Omit to search every chat.'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date'),
    fromMe: z.boolean().optional().describe('true for only messages you sent, false for only messages you received'),
    limit: z.number().int().min(1).max(100).default(20).describe('How many matches to return'),
  },
  handler: async ({ query, chatId, since, until, fromMe, limit }) => {
    const { instance, scope } = useMcpAuth()

    const terms = splitSearchTerms(query, 'query')
    if (!terms.length) {
      throw createError({ statusCode: 400, message: '`query` needs at least one word to search for.' })
    }

    if (chatId) assertChatAllowed(scope, chatId)

    const { hits, truncated } = await searchTelegramMessages(instance, {
      terms,
      chatId,
      allowedChatIds: chatId ? undefined : scopedTelegramChatIds(scope),
      since,
      until,
      fromMe,
      limit,
    })

    return { query, matches: hits, count: hits.length, truncated }
  },
})
