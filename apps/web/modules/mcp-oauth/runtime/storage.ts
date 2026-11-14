import type { Sql } from 'postgres'
import { errors } from 'oidc-provider'
import type { Adapter, AdapterPayload } from 'oidc-provider'
import { digest, seal, unseal } from './crypto'

/** Database faults must never look like a revoked OAuth credential. */
export async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (cause) {
    if (cause instanceof errors.OIDCProviderError) throw cause
    console.error('[mcp-oauth] database operation failed; check NUXT_DATABASE_URL and mcp_oauth schema permissions:', (cause as Error).message)
    throw Object.assign(new Error('OAuth storage is temporarily unavailable.'), { statusCode: 503 })
  }
}

/** Independent journal: syncing upstream never has to merge OAuth migrations. */
export async function migrateOAuth(db: Sql): Promise<void> {
  await storage(() => db.begin(async sql => {
    await sql`SELECT pg_advisory_xact_lock(442055304, 2)`
    const [schema] = await sql`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'mcp_oauth'`
    if (!schema) await sql`CREATE SCHEMA mcp_oauth`
    await sql`CREATE TABLE IF NOT EXISTS mcp_oauth.migrations (version integer PRIMARY KEY)`
    const [applied] = await sql`SELECT 1 FROM mcp_oauth.migrations WHERE version = 1`
    if (applied) return
    await sql`
      CREATE TABLE mcp_oauth.records (
        model text NOT NULL,
        id_hash text NOT NULL,
        payload bytea NOT NULL,
        uid text,
        grant_id text,
        consumed_at bigint,
        expires_at timestamptz,
        PRIMARY KEY (model, id_hash)
      )
    `
    await sql`CREATE INDEX records_uid ON mcp_oauth.records (model, uid) WHERE uid IS NOT NULL`
    await sql`CREATE INDEX records_grant ON mcp_oauth.records (grant_id) WHERE grant_id IS NOT NULL`
    await sql`CREATE INDEX records_expiry ON mcp_oauth.records (expires_at) WHERE expires_at IS NOT NULL`
    await sql`
      CREATE TABLE mcp_oauth.authorizations (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
        token_id text NOT NULL REFERENCES app.mcp_tokens(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        client_id text NOT NULL,
        client_name text NOT NULL,
        resource text NOT NULL,
        grant_id text UNIQUE NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      )
    `
    await sql`CREATE INDEX authorizations_user ON mcp_oauth.authorizations (user_id)`
    await sql`CREATE INDEX authorizations_expiry ON mcp_oauth.authorizations (expires_at)`
    await sql`INSERT INTO mcp_oauth.migrations (version) VALUES (1)`
  }))
}

interface OAuthRecord {
  id_hash: string
  payload: Buffer
  consumed_at?: string | null
}

export function postgresAdapter(db: Sql, key: Buffer) {
  let nextCleanup = 0
  return class PostgresAdapter implements Adapter {
    readonly model: string

    constructor(model: string) { this.model = model }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      if (Date.now() >= nextCleanup) {
        nextCleanup = Date.now() + 60 * 60 * 1000
        await storage(() => db`DELETE FROM mcp_oauth.records WHERE expires_at < now()`)
        await storage(() => db`DELETE FROM mcp_oauth.authorizations WHERE expires_at < now()`)
      }
      const idHash = digest(id)
      const encrypted = seal(key, JSON.stringify(payload), `oauth:${this.model}:${idHash}`)
      if (this.model === 'Interaction' && payload.result) {
        // A consent decision is single-use and cannot recreate an expired flow.
        const result = await storage(() => db`
          UPDATE mcp_oauth.records SET payload = ${encrypted}, consumed_at = floor(extract(epoch FROM now()))::bigint
          WHERE model = ${this.model} AND id_hash = ${idHash}
            AND consumed_at IS NULL AND expires_at > now()
        `)
        if (result.count !== 1) throw new errors.SessionNotFound('Interaction expired or was already approved.')
        return
      }
      const expiry = expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000)
      await storage(() => db`
        INSERT INTO mcp_oauth.records (model, id_hash, payload, uid, grant_id, consumed_at, expires_at)
        VALUES (${this.model}, ${idHash}, ${encrypted}, ${payload.uid ?? null},
          ${payload.grantId ?? null}, ${payload.consumed ?? null}, ${expiry})
        ON CONFLICT (model, id_hash) DO UPDATE SET payload = EXCLUDED.payload, uid = EXCLUDED.uid,
          grant_id = EXCLUDED.grant_id,
          consumed_at = COALESCE(mcp_oauth.records.consumed_at, EXCLUDED.consumed_at),
          expires_at = EXCLUDED.expires_at
      `)
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      const [row] = await storage(() => db<OAuthRecord[]>`
        SELECT id_hash, payload, consumed_at FROM mcp_oauth.records
        WHERE model = ${this.model} AND id_hash = ${digest(id)}
          AND (expires_at IS NULL OR expires_at > now())
      `)
      return row && this.decode(row)
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const [row] = await storage(() => db<OAuthRecord[]>`
        SELECT id_hash, payload, consumed_at FROM mcp_oauth.records
        WHERE model = ${this.model} AND uid = ${uid} AND expires_at > now()
      `)
      return row && this.decode(row)
    }

    async findByUserCode(): Promise<undefined> { return undefined }

    async consume(id: string): Promise<void> {
      const result = await storage(() => db`
        UPDATE mcp_oauth.records SET consumed_at = floor(extract(epoch FROM now()))::bigint
        WHERE model = ${this.model} AND id_hash = ${digest(id)}
          AND consumed_at IS NULL AND expires_at > now()
      `)
      if (result.count !== 1) throw new errors.InvalidGrant('Credential expired or was already used.')
    }

    async destroy(id: string): Promise<void> {
      await storage(() => db`DELETE FROM mcp_oauth.records WHERE model = ${this.model} AND id_hash = ${digest(id)}`)
    }

    async revokeByGrantId(id: string): Promise<void> {
      await storage(() => db`DELETE FROM mcp_oauth.records WHERE grant_id = ${id}`)
    }

    decode(row: OAuthRecord): AdapterPayload {
      const payload = JSON.parse(unseal(key, row.payload, `oauth:${this.model}:${row.id_hash}`)) as AdapterPayload
      if (row.consumed_at != null) payload.consumed = Number(row.consumed_at)
      return payload
    }
  }
}
