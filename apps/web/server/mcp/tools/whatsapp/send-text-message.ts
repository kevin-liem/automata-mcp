import { z } from 'zod'

/**
 * Example WRITE tool.
 *
 * On the hints: `destructiveHint` is false because sending adds a message rather
 * than destroying existing state — that is the MCP definition, not a judgement
 * about how consequential the call is. A tool that ends a paired session
 * (`/instance/logout/{instance}`, which forces a fresh QR scan) is what
 * `destructiveHint: true` is for. `idempotentHint` is false: calling this twice
 * sends two messages.
 *
 * **`number` takes a phone number or a chat's full JID.** Many 1:1 chats are
 * addressed by a LID (`…@lid`), WhatsApp's privacy alias for a person, and for
 * those the model has no phone number at all — a description asking only for
 * one left it unable to reply in a chat it could read. Evolution's `createJid()`
 * passes any value containing `@lid` or `@s.whatsapp.net` through unchanged, and
 * a send to `<lid>@lid` was confirmed on a real account (#114): it lands in the
 * existing conversation, stored under the LID. Nothing here rewrites the value;
 * Evolution decides, as everywhere ("never normalise JIDs locally").
 *
 * The description steers hard away from the one dangerous reading: a LID's
 * digits passed as a phone number reach whoever owns that number, if anyone.
 * `assertNotBareLid` (lid-guard.ts) is the check under it: digits this account
 * has seen as a LID are refused with the full JID to use instead (#113).
 */
export default defineKindTool({
  name: 'send-text-message',
  kind: 'whatsapp',
  title: 'Send WhatsApp message',
  description:
    'Send a plain-text WhatsApp message from the connected account. To reply in '
    + 'an existing conversation, pass its `jid` from list-chats or read-messages '
    + 'as `number`, exactly as returned. A chat whose jid ends in `@lid` is '
    + 'addressed by a WhatsApp privacy alias: its digits are not a phone number, '
    + 'so never strip the suffix or send to the digits alone — that would reach '
    + 'whoever owns that number, if anyone. The account '
    + 'must be in the `open` state — check with get-connection-status first. '
    + 'Messages cannot be unsent once delivered. The account owner may have set a '
    + 'disclaimer line that is appended to every message automatically; when one was, '
    + 'the response names it in `disclaimerAppended`. Do not add a sign-off of your own.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    number: z.string().min(1).describe(
      'Recipient: a chat\'s full jid exactly as list-chats or read-messages return it '
      + '(e.g. 79972425314508@lid or 5511999999999@s.whatsapp.net), or, for someone with '
      + 'no existing chat, a phone number in international format — country code '
      + 'included, digits only, no "+", spaces or dashes, e.g. 5511999999999',
    ),
    text: z.string().min(1).describe('Message body'),
  },
  handler: async ({ number, text }) => {
    const { instance, scope, sendDisclaimer } = useMcpAuth()

    // First, so a stripped LID is refused as that rather than resolved as a
    // phone number by the scope check. Refuses only digits known as a LID.
    await assertNotBareLid(instance, number)

    // Resolves the number through Evolution and compares exact JIDs. Fails
    // closed — an unverifiable recipient is refused, not sent to. No-op when
    // the token is not chat-scoped.
    await assertNumberAllowed(instance, scope, number)

    const evolution = useEvolutionClient()
    let result: Record<string, unknown>
    try {
      result = await evolution<Record<string, unknown>>(`/message/sendText/${encodeURIComponent(instance.name)}`, {
        method: 'POST',
        body: { number, text: withSendDisclaimer(text, sendDisclaimer) },
      })
    }
    catch (error) {
      // Evolution's reason lives in the response body, which the raw FetchError
      // drops — see relayEvolutionSendError.
      relayEvolutionSendError(error, number, instance.id)
    }
    // The socket answered: any dead-socket evidence is out of date (#205).
    noteSocketAlive(instance)
    return sendDisclaimer ? { ...result, disclaimerAppended: sendDisclaimer } : result
  },
})
