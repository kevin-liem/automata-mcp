import net from 'node:net'
import { Duplex } from 'node:stream'

/**
 * A byte cap on what a user's database may send per request, below the driver.
 *
 * **Why below postgres.js.** The driver reads the 32-bit length each server
 * message declares and buffers the whole message before decoding it, and keeps
 * every row of a result until the query completes. Nothing in its options caps
 * either. A real server sends a 1 GB cell for `SELECT repeat('x', 1e9)` — every
 * function in it is a pg_catalog builtin the function gate admits — and a server
 * that only *speaks* Postgres can declare any length it likes. Row-count caps
 * and cell clipping in `pg-run.ts` run on rows already in this process, which is
 * shared by every tenant.
 *
 * **The rule: bytes received since our last write.** Every request we make is a
 * write; everything the server sends until the next write is its answer. Over
 * the cap, the socket is destroyed before the rest arrives, so the driver holds
 * at most `cap` bytes of any one answer. A server pushing data at an idle
 * connection never gets a reset. Counted on the raw socket, so it works the same
 * under TLS (record overhead is a few percent): postgres.js wraps this stream in
 * `tls.connect({ socket })`, and because it is not a `net.Socket`, Node routes
 * the encrypted bytes through it rather than past it.
 *
 * **Dropping the connection aborts the transaction**, so a write whose answer
 * was too large is rolled back by the server. What the driver then rejects
 * with is not ours to choose (often `CONNECTION_CLOSED`), so
 * `responseCapTripped()` is how a caller tells this case apart and words it.
 */
const lastTrip = new Map<string, number>()

/**
 * postgres.js's `socket` option for the pool `key`, capping each answer at `cap`
 * bytes. Trips are recorded under `key` for `responseCapTripped`.
 */
export function cappedSocketFactory(key: string, cap: number) {
  return (options: { host: string[], port: number[], path?: string }): Duplex =>
    new CappedSocket(options, cap, () => { lastTrip.set(key, Date.now()) })
}

/**
 * True when a socket of pool `key` hit the cap at or after `since` (epoch ms).
 * Per pool, not per call: a pool holds a few connections, so a concurrent call
 * whose connection closed for another reason in the same window would be
 * worded as this. Wording only — nothing is decided on it.
 */
export function responseCapTripped(key: string, since: number): boolean {
  return (lastTrip.get(key) ?? 0) >= since
}

class CappedSocket extends Duplex {
  readonly host: string | undefined
  readonly port: number | undefined
  private readonly inner: net.Socket
  private received = 0
  private tripped = false

  constructor(options: { host: string[], port: number[], path?: string }, cap: number, onTrip: () => void) {
    super({ allowHalfOpen: false })
    // postgres.js reads `socket.host` for the TLS servername; our pin is an IP,
    // so this matches what its own socket would carry (and `ssl.servername`
    // still overrides it — see `sslFor` in pg-pool.ts).
    this.host = options.host[0]
    this.port = options.port[0]
    this.inner = options.path
      ? net.connect(options.path)
      : net.connect(options.port[0] ?? 5432, options.host[0] ?? '')

    this.inner.on('data', (chunk: Buffer) => {
      if (this.tripped) return
      this.received += chunk.length
      if (this.received > cap) {
        onTrip()
        this.trip(cap)
        return
      }
      if (!this.push(chunk)) this.inner.pause()
    })
    this.inner.on('end', () => this.tripped || this.push(null))
    this.inner.on('error', error => this.tripped || this.destroy(error))
    this.inner.on('close', () => this.tripped || this.destroy())
  }

  /**
   * Drop the server, then tell postgres.js: **error first, close later.**
   *
   * On 'error' the driver rejects the in-flight query, and `sql.begin` answers
   * that by writing ROLLBACK on the same connection. Had 'close' come with it,
   * the driver would already have nulled its socket, and that write — queued on
   * `setImmediate` — throws an uncaught TypeError (postgres.js 3.4.9
   * `connection.js` `nextWrite`) — logged under Nitro's trap, a crash anywhere
   * else. So writes are swallowed until the close, which then fails the
   * ROLLBACK with CONNECTION_CLOSED, after which nothing more is written.
   */
  private trip(cap: number): void {
    this.tripped = true
    this.inner.destroy()
    this.emit('error', Object.assign(new Error(`database response exceeded ${cap} bytes`), { code: 'RESPONSE_TOO_LARGE' }))
    setTimeout(() => this.destroy(), 100)
  }

  /** postgres.js only sends Terminate on `end()` when this reads 'open'. */
  get readyState(): string {
    return this.inner.readyState
  }

  setKeepAlive(enable?: boolean, delay?: number): this {
    this.inner.setKeepAlive(enable, delay)
    return this
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.tripped) return callback()
    this.received = 0
    this.inner.write(chunk, callback)
  }

  override _read(): void {
    this.inner.resume()
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.tripped) return callback()
    this.inner.end(callback)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner.destroy()
    callback(error)
  }
}
