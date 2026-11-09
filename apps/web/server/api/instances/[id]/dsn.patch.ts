import { z } from 'zod'

const body = z.object({
  dsn: z.string().min(1).max(2000),
})

/**
 * Replace a database connection's connection string.
 *
 * Proved before it is stored, for the same reason creating one is: a DSN that
 * does not work should be a failed edit with a message about the DSN, not a
 * connection that silently stops answering. The pool is dropped afterwards so
 * the change takes effect immediately rather than at the next fingerprint
 * check — belt and braces, since `withPg` would notice on its own.
 *
 * Every token on this connection keeps working, deliberately. The tokens name
 * *this connection*, not this credential; making an owner reissue them because
 * a password rotated would be a reason not to rotate it.
 */
export default defineEventHandler(async (event) => {
  const { instance } = await requireManagedInstanceOfKind(event, getRouterParam(event, 'id'), 'postgres')
  const { dsn: raw } = await parseBody(event, body)
  const dsn = raw.trim()

  // The write itself lives in instances.ts with the create path it mirrors, so
  // the two cannot drift about which columns a DSN owns.
  const updated = await updatePostgresDsn(instance, dsn)

  return { instance: toPublicInstance(updated) }
})
