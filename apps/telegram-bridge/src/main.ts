import { type BridgeConfig, loadConfig } from './config.ts'
import { BRIDGE_SCHEMA, connect, ensureBridgeSchema, grantReader, migrate } from './db.ts'
import { createBridgeServer } from './http.ts'
import { describeError } from './http-error.ts'
import { SessionManager } from './sessions.ts'

// Defence in depth: every request path catches its own rejections; one that
// slips through is logged and the process keeps serving. Exiting would drop
// every tenant's Telegram connection over one failed operation, and nothing
// it could leave behind needs a restart: session locks are re-verified every
// 5 s on their own connection, and shutdown only ever disconnects. Thrown
// (uncaught) exceptions stay fatal.
process.on('unhandledRejection', (error) => {
  console.error(`[bridge] unhandled rejection: ${describeError(error)}`)
})

let config: BridgeConfig
try {
  config = loadConfig()
}
catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}

const sql = connect(config.databaseUrl)

try {
  await ensureBridgeSchema(sql)
}
catch (error) {
  console.error((error as Error).message)
  await sql.end({ timeout: 5 })
  process.exit(1)
}

const applied = await migrate(sql)
if (applied.length > 0) console.info(`[db] applied ${applied.join(', ')} in schema ${BRIDGE_SCHEMA}`)

if (config.readerRole && !(await grantReader(sql, config.readerRole))) {
  console.warn(
    `[db] TELEGRAM_READER_ROLE names "${config.readerRole}", which does not exist. Create it with LOGIN and no other `
    + 'privileges, then restart the bridge to have it granted read access to synced data.',
  )
}

const manager = new SessionManager(sql, config)
const server = createBridgeServer(manager, config)

// :: accepts IPv6 and IPv4. Legacy Railway private networking is IPv6-only.
await new Promise<void>(resolve => server.listen(config.port, '::', resolve))
console.info(`[bridge] listening on :${config.port}${config.testServers ? ' — Telegram TEST servers' : ''}`)
if (!config.telegram) {
  console.warn(
    '[bridge] TELEGRAM_API_ID / TELEGRAM_API_HASH are not set — running without Telegram. '
    + 'Create an app at my.telegram.org and set both to enable it.',
  )
}

await manager.start()

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.info(`[bridge] ${signal}: disconnecting sessions (they stay linked)`)
  server.close()
  await manager.shutdown()
  await sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGTERM', () => { void stop('SIGTERM') })
process.on('SIGINT', () => { void stop('SIGINT') })
