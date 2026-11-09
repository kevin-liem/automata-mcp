import postgres from 'postgres'

export type Sql = postgres.Sql
export type Db = postgres.Sql | postgres.TransactionSql

/**
 * The cloud service's database access.
 *
 * It connects to the web app's database and works across two schemas, naming
 * both on every query rather than relying on search_path:
 *
 *   app     owned by the web app's migrations. This service reads it, writes
 *           only an organization's billing and entitlement columns, and appends
 *           `plan.changed` to `app.hosted_events`. It never touches `instances`
 *           credentials.
 *   cloud   this service's own state — consumer cursors on the event outbox,
 *           and CRM updates Brevo refused for good. Created here at boot.
 */
export const CLOUD_SCHEMA = 'cloud'

/**
 * The web app migration this service needs: the newest one whose columns it
 * writes — `0022` adds `recent_history_only`, on top of `0013`'s
 * `tool_calls_required` and `0007`'s entitlement columns, outbox and
 * `app.entitlement_defaults`. Migrations apply in order, so waiting for the
 * newest covers the rest. The service waits rather than failing, since the two
 * are deployed together and either may start first.
 */
const REQUIRED_APP_MIGRATION = '0022_recent_history_only'

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    // A RAISE NOTICE can carry row data; the process log is not where that goes.
    onnotice: () => {},
    // NULL reads as undefined and timestamps as ISO strings, exactly like the
    // web app's pool, so a row means the same thing on both sides.
    transform: {
      undefined: null,
      value: {
        from: (value: unknown) => value === null ? undefined : value instanceof Date ? value.toISOString() : value,
      },
    },
    connection: {
      application_name: 'automata-cloud',
      statement_timeout: 15_000,
    },
  })
}

/**
 * Create this service's schema and tables. Idempotent; runs at every boot.
 * Existence is tested before creating because `CREATE SCHEMA IF NOT EXISTS`
 * still demands CREATE on the database, which a restricted role may lack even
 * when the schema is already there.
 */
export async function ensureCloudSchema(sql: Sql): Promise<void> {
  const [existing] = await sql`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${CLOUD_SCHEMA}`
  if (!existing) await sql`CREATE SCHEMA IF NOT EXISTS ${sql(CLOUD_SCHEMA)}`

  // How far each consumer has read `app.hosted_events`. One row per consumer, so
  // a consumer added later (CRM, telemetry) starts from the beginning of the
  // retained backlog while the existing ones carry on where they were.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.cursors (
      consumer text PRIMARY KEY,
      last_id  bigint NOT NULL,
      updated  timestamptz NOT NULL DEFAULT now()
    )
  `

  // Contact updates Brevo refused for a reason retrying will not fix (an
  // address it calls invalid, say). Kept so they can be replayed by hand once
  // the cause is fixed — see "CRM (Brevo)" in docs/billing.md. event_id is
  // NULL for a refusal during the one-off backfill. Never holds the address.
  await sql`
    CREATE TABLE IF NOT EXISTS cloud.crm_skipped (
      id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id bigint,
      user_id  text NOT NULL,
      status   integer NOT NULL,
      code     text,
      at       timestamptz NOT NULL DEFAULT now()
    )
  `
}

/**
 * Resolve once the web app has migrated far enough for this service. Polls
 * rather than failing: deployed together, either may start first.
 */
export async function waitForApp(sql: Sql, signal: { stopped: boolean }): Promise<void> {
  let announced = false
  while (!signal.stopped) {
    try {
      const [row] = await sql`SELECT 1 FROM app.migrations WHERE name = ${REQUIRED_APP_MIGRATION}`
      if (row) return
    }
    catch {
      // The app schema does not exist yet.
    }
    if (!announced) {
      announced = true
      console.info(`[db] waiting for the web app to apply migration ${REQUIRED_APP_MIGRATION}`)
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
}
