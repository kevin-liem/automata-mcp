import { z } from 'zod'
import type { ChatMessage } from '~~/server/utils/chats'
import type { ChatExpansion } from '~~/server/utils/mcp-scope'
import type { LidLinks } from '~~/server/utils/whatsapp-identity'

/**
 * Read tool. Unlike list-chats this refuses loudly when the requested chat is out
 * of scope: returning an empty history would read as "this conversation is
 * empty", which is a different and wrong statement.
 *
 * The same principle governs the response envelope. Pages are newest-first and
 * capped at `limit`, so a page of a `since`-bounded window is
 * missing the *old* end — the part the caller named. Returned bare, it reads as
 * the whole window, and a model summarising it writes a confident summary with a
 * hole in the middle. So every response says whether it is complete
 * (`hasMore`), what span it actually covers (`covered`), and how to get the
 * rest (`nextPage`, plus a `note` in words because the flag alone was not
 * enough).
 *
 * **One person, possibly two JIDs.** WhatsApp may store a person's messages
 * under a LID and under their phone number. When `whatsapp-identity.ts` links
 * the two, either `jid` reads both (`jids` says so), but only the halves this
 * token is scoped to — `expandChat` adds a partner only when it passes the same
 * literal scope check, and a cut half is reported as `linkedOutOfScope`, a
 * count. A 1:1 chat with no link says so (`linkUnknown`) where a second half
 * could exist, since a page from half a conversation reads as the whole one.
 */
export default defineKindTool({
  name: 'read-messages',
  kind: 'whatsapp',
  title: 'Read WhatsApp messages',
  description:
    'Read one page of messages from one WhatsApp conversation, newest first. '
    + 'Takes the `jid` returned by list-chats. Covers the history imported when '
    + 'the account was paired as well as everything since, so older '
    + 'conversations are reachable — use `since`/`until` to target a date range. '
    + 'When the response carries `recentHistoryOnly: true`, that import was '
    + 'partial — only the recent history WhatsApp hands a newly linked device — '
    + 'so the oldest message here is not necessarily where the conversation '
    + 'began; say so rather than treating it as the start. '
    + 'A response is one page, not the whole range: when `hasMore` is true there '
    + 'are older messages you have not seen, so call again with `nextPage` and '
    + 'the same `jid`, `limit` and `window` bounds, and keep going until '
    + '`hasMore` is false before treating the range as fully read. `covered` '
    + 'reports the span this page actually covers, which for a truncated range is '
    + 'narrower than the one you asked for, and `totalMatching`/`totalPages` say '
    + 'how much the range holds in full — a count of distinct messages, safe to '
    + 'quote. A message you sent is marked `fromMe` and carries no `author`; on '
    + 'one you received, `author` is the sender\'s name where the account knows '
    + 'it, and absent where it does not. Reaction messages are left out unless '
    + '`includeReactions` is set. @-mentions in the text are shown as names '
    + 'where the account knows them, and left as raw numeric ids where it does '
    + 'not — an id is not a name to guess at. An edited message arrives as its '
    + 'own record carrying the new text, with `editOf` naming the message it '
    + 'replaces; that earlier record is still in the history with the text it '
    + 'had before, so read the pair as one message that changed rather than as '
    + 'two. One person can be stored under two ids — a `@lid` and their phone '
    + 'number; when this connector has linked them, reading either id returns '
    + 'both halves, merged into one timeline, and `jids` lists what was read. '
    + '`linkedOutOfScope` means part of this person\'s conversation is under an '
    + 'id this token may not read; `linkUnknown` means another part may exist '
    + 'that this connector cannot link. Say so rather than presenting the page '
    + 'as the whole conversation. WhatsApp\'s own control records — deletions, disappearing-message '
    + 'timer changes, key exchanges — carry nothing to read and are left out, '
    + 'counted by `protocolMessagesExcluded` when any were, and still included '
    + 'in `totalMatching`. An edit that WhatsApp encrypted for the chat\'s '
    + 'participants comes back with no text and `unreadable: '
    + '\'encrypted-edit\'`: the current wording of that message is unknown '
    + 'here, so report it as unknown rather than treating the earlier version '
    + 'as final. To find a message by what it says, prefer search-messages when '
    + 'this connector offers it.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).describe('Chat identifier from list-chats, exactly as returned, e.g. 5511999999999@s.whatsapp.net or 79972425314508@lid'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many messages to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` messages, counting back from the newest. Walk this up while `hasMore` is true.'),
    since: z.string().optional().describe('Only messages at or after this date, e.g. 2024-03-01 or 2024-03-01T12:00:00Z'),
    until: z.string().optional().describe('Only messages at or before this date. Pass back the `window.until` from a previous page when paging a range.'),
    includeReactions: z.boolean().default(false).describe(
      'Include reaction messages. Each reaction is its own record — an id, an '
      + 'author, a timestamp and an emoji — so in an active group they are a '
      + 'large share of a page while rarely mattering for reconstructing the '
      + 'conversation. Off by default for that reason; turn it on when who '
      + 'reacted is the question.',
    ),
  },
  handler: async ({ jid, limit, page, since, until, includeReactions }) => {
    const { instance, scope } = useMcpAuth()

    // Asserts `jid` itself first, exactly as before; a linked partner is added
    // only when the token is scoped to it too.
    const links = await lidLinks(instance)
    const chat = expandChat(scope, links, jid)

    // Named `range` rather than `window` only to keep the DOM global unshadowed;
    // it goes back to the caller as `window`.
    const range = {
      since: toIsoDate(since, 'since'),
      // Pin the upper bound as soon as the caller names a lower one. An
      // unpinned `until` means *now*, a value that moves between calls, so page
      // 2 would come from a different range than page 1. Pinned here and echoed
      // back as `window`, paging a range is repeatable. Not about a bound being
      // ignored — the SQL path emits one predicate per bound. Left alone when
      // there is no `since`: putting a `messageTimestamp` predicate on an
      // ordinary unfiltered read would hit a table Evolution indexes by
      // instance and nothing else.
      until: toIsoDate(until, 'until') ?? (since ? new Date().toISOString() : undefined),
    }

    // `includeReactions` is passed alongside `range` rather than folded into it:
    // `range` is echoed back to the caller as `window`, and it should describe
    // the time bounds and nothing else.
    const [{ messages, hasMore, total, protocolMessagesExcluded }, partialHistory] = await Promise.all([
      listMessages(instance, chat.jids, { limit, page, ...range, includeReactions }),
      recentHistoryOnly(instance),
    ])

    const identity = linkStatus(jid, chat, links)

    const covered = coveredSpan(messages)
    const bounded = Boolean(range.since || range.until)

    // One `note` key, assembled from whichever gaps are real — a second
    // note-shaped key would just be a second thing to miss. Byte-identical to
    // what it always said when nothing was dropped.
    const notes = [
      hasMore
        ? incompleteNote({ page, limit, count: messages.length, excluded: protocolMessagesExcluded, range })
        : undefined,
      protocolMessagesExcluded > 0 ? droppedNote(protocolMessagesExcluded) : undefined,
      identity.note,
      // Only once the caller has reached the oldest stored message, which is
      // where it would otherwise conclude the conversation began.
      partialHistory && !hasMore ? RECENT_HISTORY_NOTE : undefined,
    ].filter((note): note is string => Boolean(note))

    return {
      jid,
      ...identity.fields,
      page,
      limit,
      count: messages.length,
      // Wrong only in the safe direction: a page that came back full reports
      // `true` even when it happens to be the last one, which costs one more
      // call returning nothing. A partial answer is never reported as complete.
      hasMore,
      ...(total !== undefined && {
        totalMatching: total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      }),
      ...(hasMore && { nextPage: page + 1 }),
      ...(bounded && { window: range }),
      // The span these messages actually cover, which is the visible half of
      // what truncation took: with `since` set and `hasMore` true, everything
      // between `window.since` and `covered.from` is still unread.
      ...(covered && { covered }),
      // Omitted at zero, so its presence always means something really was
      // dropped. Deliberately not subtracted from `totalMatching`: that count is
      // taken over the whole range, while this describes one page — patching it
      // here would produce a confidently wrong number across pages.
      ...(protocolMessagesExcluded > 0 && { protocolMessagesExcluded }),
      // On every page, not just the last: a caller reading a `since` window
      // needs to know before it pages that the window may predate the import.
      // Omitted when false or unknown, so its presence always means a gap.
      ...(partialHistory && { recentHistoryOnly: true }),
      ...(notes.length > 0 && { note: notes.join(' ') }),
      // Same principle as `hasMore`, for a different kind of gap: a whole class
      // of message is missing, and a caller that does not know it was dropped
      // reads the silence as "nobody reacted".
      ...(!includeReactions && { reactionsExcluded: true }),
      messages,
    }
  },
})

/**
 * What this page says about the person behind a 1:1 chat having a second JID.
 *
 * Four outcomes, each its own field so a caller can test for it, and each with
 * a sentence because a field alone went unread before (`hasMore`):
 *   - both halves read            → `jids`
 *   - a half outside scope        → `linkedOutOfScope`, a count, never the id
 *   - no link, one could exist    → `linkUnknown`. Always for a LID chat; for a
 *                                   phone-number chat only when the account has
 *                                   LID chats it could not link — otherwise
 *                                   every ordinary chat would carry a warning.
 *   - links could not be read     → `linkUnavailable`
 * Groups and anything else carry none.
 */
function linkStatus(
  jid: string,
  chat: ChatExpansion,
  links: LidLinks,
): { fields: Record<string, unknown>, note?: string } {
  const personal = jid.endsWith('@lid') || jid.endsWith('@s.whatsapp.net')
  if (!personal) return { fields: {} }

  if (chat.jids.length > 1) {
    return {
      fields: { jids: chat.jids },
      note: 'This person\'s conversation is stored under two ids — their privacy alias (@lid) and their '
        + 'phone number — and this page reads both, merged into one timeline. Reply with the jid as given.',
    }
  }
  if (chat.outOfScope > 0) {
    return {
      fields: { linkedOutOfScope: chat.outOfScope },
      note: 'Part of this person\'s conversation is stored under another id that this connector token is '
        + 'not scoped to, so it is not in these messages. Do not treat this as the whole conversation; '
        + 'the account owner can add the other part to the token\'s allowed chats.',
    }
  }
  if (!links.available) {
    return {
      fields: { linkUnavailable: true },
      note: 'Could not check whether this person has a second conversation under another id '
        + '(a @lid alias or their phone number), so this may be only part of it.',
    }
  }
  if (jid.endsWith('@lid') || links.unlinkedLids > 0) {
    return {
      fields: { linkUnknown: true },
      note: 'This person may also have a separate, older or newer conversation under '
        + (jid.endsWith('@lid') ? 'their phone number' : 'a @lid privacy alias')
        + ' that this connector cannot link to this one, so these messages may not be the whole '
        + 'conversation.',
    }
  }
  return { fields: {} }
}

/**
 * Said in words as well as in a flag. The failure this exists to prevent was a
 * caller reading `count: 200` against `limit: 200` and concluding the window
 * held exactly 200 messages.
 */
function incompleteNote(
  { page, limit, count, excluded, range }:
  { page: number, limit: number, count: number, excluded: number, range: { since?: string, until?: string } },
): string {
  const scope = range.since ? 'inside the requested window' : 'in this conversation'
  const first = (page - 1) * limit + 1
  // Measured against what Evolution returned, not against what survived
  // filtering: paging walks its rows, so the ordinal of the last message on this
  // page has to count the ones dropped from it.
  const last = (page - 1) * limit + count + excluded

  return `Incomplete: this is page ${page} — messages ${first}-${last} ${scope}, counting back from the `
    + `newest, and not all of them. Older messages ${scope} were NOT returned. Call read-messages again `
    + `with page: ${page + 1}, the same jid and limit`
    + `${range.since || range.until ? ', and the same window bounds' : ''}, and keep going until hasMore `
    + 'is false. Do not summarise this range until then.'
}

/**
 * The count alone reads as "something is missing here". It is the opposite:
 * these rows had nothing in them. Said in words so a caller neither ignores the
 * number nor reports a hole that is not there.
 */
function droppedNote(count: number): string {
  const records = count === 1
    ? '1 WhatsApp control record was'
    : `${count} WhatsApp control records were`

  return `${records} left out of this page — deletions, disappearing-message timer changes, key `
    + 'exchanges and similar bookkeeping, which carry no readable content. Nothing readable was '
    + 'dropped: an edited message is returned as its new text, with editOf naming the message it '
    + 'replaces. totalMatching still counts these records, so it can exceed the messages you receive.'
}

/**
 * Oldest and newest timestamp actually present, computed as a min/max rather
 * than read off the ends of the array. Some message types carry no timestamp at
 * all, and deriving the span from position would quietly become a lie if
 * Evolution's ordering ever changed.
 */
function coveredSpan(messages: ChatMessage[]): { from: string, to: string } | undefined {
  // ISO 8601 UTC strings sort chronologically as text; they all come from
  // `toISOString()`.
  const stamps = messages
    .map(message => message.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort()

  const from = stamps[0]
  const to = stamps[stamps.length - 1]

  return from && to ? { from, to } : undefined
}

/**
 * Normalise a bound to ISO 8601, refusing anything unparseable.
 *
 * `parseDateBound` in `evolution-db.ts` does the parsing and owns the refusal,
 * so the query and this envelope cannot disagree about what a date is. The ISO
 * string is what goes back to the caller as `window`, for it to hand to the
 * next page.
 */
function toIsoDate(value: string | undefined, label: string): string | undefined {
  return parseDateBound(value, label)?.toISOString()
}
