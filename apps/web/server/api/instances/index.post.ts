import { assertNever } from '#shared/connection'
import { z } from 'zod'

/**
 * Create a connection.
 *
 * A discriminated union on `kind`, so each kind validates only its own fields
 * and an unknown kind is a 400 rather than a half-built row. `kind` defaults to
 * `whatsapp`: a client written before Postgres connections existed keeps
 * working unchanged.
 *
 * The WhatsApp `server` pair is all-or-nothing. Half of it is not a partial
 * override to be completed from configuration — see `evolutionAdminCredentials`
 * for why pairing our key with their URL, or theirs with ours, is the bug this
 * shape prevents.
 *
 * `server` is refused on the hosted service (`ownServersAllowed` in cloud.ts),
 * inside the provision functions, before the address is dialled.
 *
 * `dbUrl` sits inside `server` because it only means anything for a user's own
 * server, and is optional inside it because reading is the only thing it buys:
 * pairing, listing chats and sending all work without it.
 */
const body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('whatsapp').default('whatsapp'),
    label: z.string().max(100).optional(),
    // Off by default, for everyone: recent history only unless asked for.
    fullHistory: z.boolean().default(false),
    server: z.object({
      baseUrl: z.string().url(),
      adminKey: z.string().min(1),
      dbUrl: z.string().min(1).max(2000).optional(),
    }).optional(),
  }),
  z.object({
    kind: z.literal('postgres'),
    label: z.string().max(100).optional(),
    dsn: z.string().min(1).max(2000),
  }),
  // Same all-or-nothing `server` shape as WhatsApp, for a bridge the user runs.
  z.object({
    kind: z.literal('telegram'),
    label: z.string().max(100).optional(),
    server: z.object({
      baseUrl: z.string().url(),
      adminKey: z.string().min(1),
      dbUrl: z.string().min(1).max(2000).optional(),
    }).optional(),
  }),
  // A mailbox. No plaintext option: `starttls` must upgrade or it fails.
  z.object({
    kind: z.literal('imap'),
    label: z.string().max(100).optional(),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    security: z.enum(['tls', 'starttls']),
    user: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1000),
  }),
])

export default defineEventHandler(async (event) => {
  // Admin-only: a connection costs money and, for WhatsApp, a real phone number.
  // The organization owns whatever is created here; the acting admin is recorded
  // as its creator and gains nothing extra by it.
  const actor = await requireOrgAdmin(event)
  const parsed = await parseBody(event, body)

  // The organization's connection limit, before anything is provisioned:
  // WhatsApp and Telegram reserve a live session on a remote server before the
  // row exists, so a refusal after that would leave one running. Not held
  // across the insert — provisioning makes remote calls — so two racing
  // creates can both pass. That is harmless: only the oldest connections'
  // tokens answer over a limit (`mcpLimitRefusal`), and the org then reads as
  // over its limit.
  await assertCanAdd(await appDb(), actor.org.id, 'connection')

  let instance
  switch (parsed.kind) {
    case 'postgres':
      instance = await provisionPostgresInstance(actor, { label: parsed.label, dsn: parsed.dsn })
      break
    case 'whatsapp':
      instance = await provisionWhatsappInstance(actor, { label: parsed.label, server: parsed.server, fullHistory: parsed.fullHistory })
      break
    case 'telegram':
      instance = await provisionTelegramInstance(actor, { label: parsed.label, server: parsed.server })
      break
    case 'imap':
      instance = await provisionImapInstance(actor, parsed)
      break
    default:
      return assertNever(parsed, 'connection kind')
  }

  // The kind only: hosts, credentials and labels never go into an event.
  recordHostedEventQuietly({ type: 'connection.created', org: actor.org.id, userId: actor.user.id, payload: { id: instance.id, kind: parsed.kind } })

  return { instance: toPublicInstance(instance) }
})
