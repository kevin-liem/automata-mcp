import { Api, events, type TelegramClient } from 'teleproto'
import type { Sql } from '../db.ts'
import { describeError } from '../http-error.ts'
import {
  channelChatId, chatRow, chatsOf, entityMap, inputChannelFor, inputPeerFor, long, markedId,
  type MessageRow, messageRow, migrationOf, reactionList, shortMessageRow, type UserRow, userRow, usersOf,
} from './convert.ts'
import { type BackfillChat, type BackfillStop, type ChatOp, SyncStore, type TrackedChannel } from './store.ts'

/**
 * Keeping one session's chats in Postgres.
 *
 * Four sources, because no one of them is complete:
 *
 *   live       Every update teleproto dispatches, applied in arrival order —
 *              written in batches: see `drain`.
 *   catch-up   On connect: teleproto's common difference (private chats, basic
 *              groups) from the persisted pts, then **our own** channel
 *              difference per channel from `chats.channel_pts`. teleproto only
 *              tracks channels it saw an update for in this process, so after a
 *              restart it would miss every channel's offline edits and deletes.
 *   dialogs    The dialog list, on connect and every RECONCILE_MS. A chat whose
 *              top message is newer than what we hold is filled forward. This is
 *              what covers channels Telegram stopped pushing while nobody polled.
 *   backfill   Older history, newest chat first, one page at a time, bounded by
 *              the configured caps and paused on flood waits. Nothing older than
 *              `days` is stored from it, nor from the dialog list: `days` is a
 *              limit on what is kept (a plan's cap rides on it), not only on how
 *              far the walk goes. Live traffic and catch-up are never cut.
 *
 * What cannot be recovered is recorded, not hidden: a forward fill or channel
 * difference that could not reach back far enough sets `chats.gap_since`.
 *
 * **The live queue is bounded for channel updates, and only for them (#188).**
 * One account in 112 busy supergroups received updates faster than they were
 * written, and the queue held each one (with its entities) until the process ran
 * out of heap. Past MAX_PENDING queued updates, or once the oldest has waited
 * MAX_PENDING_AGE_MS, a channel update is not queued: its channel is marked
 * *dirty* and every later update for it is skipped too, until a channel
 * difference from the stored `channel_pts` has fetched what was skipped. Skipping
 * all of them matters: `setChannelPts(…, false)` moves pts forward with GREATEST,
 * so applying one later update would carry the stored pts past the skipped ones
 * and lose them without a trace. Catch-up runs beside the queue, not in it, one
 * channel at a time, and only for a channel with nothing of its own still queued.
 *
 * Common-sequence updates (private chats, basic groups) are never skipped:
 * teleproto's update state, which is what gets persisted, advances when an update
 * is received, not when it is applied, so a dropped one could not be fetched again.
 */

export interface BackfillOptions {
  maxPerChat: number
  days: number
  includeBroadcast: boolean
  pageDelayMs: number
}

export interface SyncStatus {
  backfilling: boolean
  pausedUntil?: string
  /** The live queue: what is received and not yet written. Absent with no client. */
  queue?: QueueLoad
}

export interface QueueLoad {
  /** Updates received and not yet applied. */
  pending: number
  /** When the oldest of them was received. */
  oldestAt?: string
  /** Channel updates are being skipped, to be recovered by catch-up. */
  shedding: boolean
  /** Channels whose skipped updates still have to be fetched again. */
  dirtyChannels: number
  /** Channel updates skipped since this session's sync started. */
  skipped: number
}

const PAGE = 100
const RECONCILE_MS = 10 * 60_000
const RECONCILE_DIALOGS = 100
const MAX_FORWARD_PAGES = 50
const CHANNEL_CATCHUP_DELAY_MS = 250
const MAX_CHANNEL_DIFFERENCE_ROUNDS = 50
/** Past this many queued updates, channel updates are skipped and recovered by catch-up. */
const MAX_PENDING = 5_000
/** …or once the oldest queued update has waited this long. */
const MAX_PENDING_AGE_MS = 2 * 60_000
/** Skipping stops again once the queue is down to this, so it does not flap at the limit. */
const RESUME_PENDING = 1_000
/**
 * Updates for the channel being caught up that arrive while it is: the difference
 * may or may not include them, so they are kept and applied after it if newer.
 * More than this and the channel is simply caught up again.
 */
const MAX_HELD = 500
/** A channel whose catch-up failed is tried again after this… */
const CATCHUP_RETRY_MS = 60_000
/** …this many times in a row (flood waits not counted), then given up with a gap recorded. */
const MAX_CATCHUP_FAILURES = 5
/** How often a session with a backlog says so. */
const LOAD_REPORT_MS = 60_000
/** A flood wait longer than this is logged: it means this account is syncing too hard. */
const LONG_FLOOD_S = 300
/**
 * Most queued live updates one transaction writes. Bounds the statement size
 * (columns × rows parameters) as much as the work lost to one failed batch.
 */
const MAX_BATCH = 500
/** How often backfill looks again while the client is disconnected. */
const DISCONNECTED_WAIT_MS = 30_000
/** Telegram's answer for history this account cannot read any more. */
const INACCESSIBLE = new Set(['CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'PEER_ID_INVALID', 'CHAT_ID_INVALID', 'CHAT_FORBIDDEN'])

type EntityMap = Map<string, unknown>

interface Queued {
  update: unknown
  /** When it was received, in ms. */
  at: number
  /** The marked id of the channel it belongs to, for a channel update. */
  channel?: string
}

interface CatchUpRun {
  chatId: string
  /** This channel's updates received while its difference was being fetched. */
  held: unknown[]
  /** More arrived than could be held, or Telegram said too long again: run again. */
  again: boolean
}


export class SessionSync {
  private readonly client: TelegramClient
  private readonly store: SyncStore
  private readonly options: BackfillOptions
  private readonly sessionId: string
  private readonly meId: string | null
  private readonly rawEvent = new events.Raw({})
  private readonly onUpdate = (update: unknown) => { this.enqueue(update) }
  /** The live queue, from `head`; applied entries are cleared so their memory goes. */
  private queue: (Queued | undefined)[] = []
  private head = 0
  private draining = false
  /** Queued updates per channel: a channel is caught up only when it has none. */
  private readonly queuedPerChannel = new Map<string, number>()
  private shedding = false
  /** Channels to catch up, in order; `true` once any update of theirs was skipped. */
  private readonly dirty = new Map<string, boolean>()
  private readonly retryAt = new Map<string, number>()
  private readonly failures = new Map<string, number>()
  private catchingUp: CatchUpRun | undefined
  private catchUpRun: Promise<void> | undefined
  private skipped = 0
  private skippedSinceReport = 0
  private loadTimer: NodeJS.Timeout | undefined
  private stopped = false
  private syncingDialogs = false
  private backfillRunning = false
  private pausedUntil = 0
  private reconcileTimer: NodeJS.Timeout | undefined
  private backfilling = false

  constructor(client: TelegramClient, sql: Sql, sessionId: string, meId: string | null, options: BackfillOptions) {
    this.client = client
    this.store = new SyncStore(sql, sessionId)
    this.sessionId = sessionId
    this.meId = meId
    this.options = options
  }

  /** Before connecting, so nothing teleproto dispatches during catch-up is missed. */
  attach(): void {
    this.client.addEventHandler(this.onUpdate, this.rawEvent)
    this.loadTimer = setInterval(() => { this.reportLoad() }, LOAD_REPORT_MS)
    this.loadTimer.unref()
  }

  /** After connecting and confirming the session. Never throws; failures are logged and retried by reconcile. */
  async start(): Promise<void> {
    await this.guard('catch-up', () => this.client.catchUp())
    // Every tracked channel goes through the catch-up worker, so a live update for
    // a channel not yet caught up is skipped (the difference brings it) rather
    // than moving its pts past what the difference has still to fetch.
    await this.guard('channel catch-up', async () => {
      for (const channel of await this.store.channelsForCatchUp()) {
        if (!this.dirty.has(channel.chat_id)) this.dirty.set(channel.chat_id, false)
      }
      await this.runCatchUps()
    })
    await this.guard('dialog sync', async () => {
      await this.syncDialogs()
      if (!this.stopped) await this.store.markDialogsSynced()
    })
    if (this.stopped) return
    this.reconcileTimer = setInterval(() => { void this.reconcile() }, RECONCILE_MS)
    this.reconcileTimer.unref()
    void this.runBackfill()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.reconcileTimer)
    clearInterval(this.loadTimer)
    this.client.removeEventHandler(this.onUpdate, this.rawEvent)
    // Nothing more is applied; let what was waiting be collected.
    this.queue = []
    this.head = 0
    this.queuedPerChannel.clear()
    if (this.catchingUp) this.catchingUp.held = []
  }

  status(): SyncStatus {
    return {
      backfilling: this.backfilling,
      pausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : undefined,
      queue: this.load(),
    }
  }

  load(): QueueLoad {
    const oldest = this.queue[this.head]
    return {
      pending: this.pendingCount(),
      oldestAt: oldest ? new Date(oldest.at).toISOString() : undefined,
      shedding: this.shedding,
      dirtyChannels: this.dirty.size,
      skipped: this.skipped,
    }
  }

  /** The update manager's common state, to persist so the next connect catches up from it. */
  updateState(): { pts: number, qts: number, date: number, seq: number } | undefined {
    return this.client.updateManager.state
  }

  /** Store messages and the chats they belong to. Used by live updates, history pages and sends. */
  async saveMessages(messages: unknown[], entities?: EntityMap): Promise<void> {
    const rows = messages.flatMap((message) => {
      const row = messageRow(message, this.meId)
      return row ? [row] : []
    })
    if (rows.length === 0) return

    await this.store.writeBatch({
      chats: [...new Set(rows.map(row => row.chat_id))].map(chatId => chatOp(chatId, entities)),
      messages: rows,
      migrations: messages.flatMap(message => migrationOf(message) ?? []),
    })
  }

  // ── live ───────────────────────────────────────────────────────────────────

  private enqueue(update: unknown): void {
    if (this.stopped) return
    const channel = channelOf(update)
    if (channel !== undefined) {
      const run = this.catchingUp
      if (run?.chatId === channel) {
        if (update instanceof Api.UpdateChannelTooLong || run.held.length >= MAX_HELD) run.again = true
        else run.held.push(update)
        return
      }
      if (update instanceof Api.UpdateChannelTooLong) {
        // Telegram has more for this channel than it will push: fetch it.
        this.markDirty(channel, false)
        return
      }
      if (this.dirty.has(channel) || this.overloaded()) {
        this.markDirty(channel, true)
        this.skipped++
        this.skippedSinceReport++
        return
      }
    }
    this.push({ update, at: Date.now(), channel })
  }

  private push(item: Queued): void {
    this.queue.push(item)
    if (item.channel !== undefined) {
      this.queuedPerChannel.set(item.channel, (this.queuedPerChannel.get(item.channel) ?? 0) + 1)
    }
    void this.drain()
  }

  private pendingCount(): number {
    return this.queue.length - this.head
  }

  /** Whether channel updates are being skipped, re-decided from the queue as it is now. */
  private overloaded(): boolean {
    const pending = this.pendingCount()
    const age = pending > 0 ? Date.now() - this.queue[this.head]!.at : 0
    if (!this.shedding && (pending >= MAX_PENDING || age >= MAX_PENDING_AGE_MS)) {
      this.shedding = true
      console.warn(
        `[sync] ${this.sessionId}: ${pending} updates pending, oldest ${Math.round(age / 1000)}s; `
        + `skipping channel updates until the queue drains, to fetch them again by catch-up (heap ${heapMb()} MB)`,
      )
    }
    else if (this.shedding && pending <= RESUME_PENDING && age < MAX_PENDING_AGE_MS / 2) {
      this.shedding = false
      console.info(
        `[sync] ${this.sessionId}: queue down to ${pending}; queueing channel updates again, `
        + `${this.dirty.size} channels to catch up`,
      )
      this.wakeCatchUps()
    }
    return this.shedding
  }

  private markDirty(chatId: string, skipped: boolean): void {
    const run = this.catchingUp
    if (run?.chatId === chatId) {
      run.again = true
      return
    }
    const already = this.dirty.get(chatId)
    if (already === undefined) this.dirty.set(chatId, skipped)
    else if (skipped && !already) this.dirty.set(chatId, true)
    this.wakeCatchUps()
  }

  private reportLoad(): void {
    const load = this.load()
    if (load.pending === 0 && load.dirtyChannels === 0 && this.skippedSinceReport === 0) return
    const oldest = this.queue[this.head]
    const age = oldest ? Math.round((Date.now() - oldest.at) / 1000) : 0
    console.info(
      `[sync] ${this.sessionId}: ${load.pending} updates pending (oldest ${age}s), `
      + `${load.dirtyChannels} channels to catch up, ${this.skippedSinceReport} channel updates skipped `
      + `in the last minute${load.shedding ? ' (skipping)' : ''}; heap ${heapMb()} MB`,
    )
    this.skippedSinceReport = 0
  }

  /**
   * Apply queued updates in arrival order, as few writes as possible.
   *
   * A run of consecutive batchable updates (`batchable`) is written as one
   * transaction with one statement per table, instead of about six round trips
   * per message — the per-message path could not keep up with a busy account,
   * and the backlog grew without bound (#188, #189). Any other update ends the
   * run: the run is written, the update applied on its own, then a new run
   * starts, so deletions, reactions and catch-ups still land in arrival order
   * relative to the messages around them.
   *
   * Never throws: a failed batch is retried one update at a time, so one bad
   * row costs one update, not the batch.
   */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pendingCount() > 0 && !this.stopped) {
        let run = 0
        while (run < this.pendingCount() && run < MAX_BATCH && batchable(this.queue[this.head + run]!.update)) run++
        const items = this.take(Math.max(run, 1))
        if (run > 0) await this.applyBatch(items.map(item => item.update))
        else await this.applyOne(items[0]!.update)
        this.release(items)
        this.overloaded()
      }
    }
    finally {
      this.draining = false
    }
    this.wakeCatchUps()
  }

  /** The next `count` queued items, cleared from the queue so their memory can go once applied. */
  private take(count: number): Queued[] {
    const items = this.queue.slice(this.head, this.head + count) as Queued[]
    this.queue.fill(undefined, this.head, this.head + count)
    this.head += count
    if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head)
      this.head = 0
    }
    return items
  }

  /** Applied (or failed): no longer queued for their channels. */
  private release(items: Queued[]): void {
    for (const item of items) {
      if (item.channel === undefined) continue
      const left = (this.queuedPerChannel.get(item.channel) ?? 1) - 1
      if (left > 0) this.queuedPerChannel.set(item.channel, left)
      else {
        this.queuedPerChannel.delete(item.channel)
        // A dirty channel waits for its queued updates; under steady load the
        // queue may never empty, so its last one starts the worker.
        if (this.dirty.has(item.channel)) this.wakeCatchUps()
      }
    }
  }

  private async applyOne(update: unknown): Promise<void> {
    try {
      await this.apply(update)
    }
    catch (error) {
      const name = (update as { className?: string } | undefined)?.className ?? 'update'
      console.error(`[sync] ${this.sessionId}: could not apply ${name}: ${describeError(error)}`)
    }
  }

  private async applyBatch(updates: unknown[]): Promise<void> {
    if (updates.length === 1) return await this.applyOne(updates[0])
    try {
      await this.writeBatch(updates)
    }
    catch (error) {
      if (this.stopped) return
      console.error(`[sync] ${this.sessionId}: a batch of ${updates.length} updates failed (${describeError(error)}); applying them one at a time`)
      for (const update of updates) {
        if (this.stopped) return
        await this.applyOne(update)
      }
    }
  }

  /**
   * What `apply` would write for each of `updates` in turn, as one batch. Every
   * update here passed `batchable`, so it is entities plus, at most, one
   * message upsert and a forward-only pts.
   */
  private async writeBatch(updates: unknown[]): Promise<void> {
    if (this.stopped) return
    const users: UserRow[] = []
    const chats: ChatOp[] = []
    const messages: MessageRow[] = []
    const channelPts = new Map<string, number>()

    for (const update of updates) {
      const entities = entitiesOf(update)
      if (entities) {
        const list = [...entities.values()]
        users.push(...usersOf(list))
        chats.push(...chatsOf(list).map(row => ({ op: 'refresh' as const, row })))
      }
      if (!isMessageUpdate(update)) continue

      const row = messageRow(update.message, this.meId)
      if (row) {
        chats.push(chatOp(row.chat_id, entities))
        messages.push(row)
      }
      const pts = channelPtsOf(update)
      if (pts) channelPts.set(pts.chatId, Math.max(channelPts.get(pts.chatId) ?? 0, pts.pts))
    }

    await this.store.writeBatch({ users, chats, messages, channelPts })
  }

  /**
   * One update on its own. Every class handled here other than a message upsert
   * must be listed in ORDERED, or the batch path will treat it as entities only.
   */
  private async apply(update: unknown): Promise<void> {
    if (this.stopped) return
    const entities = entitiesOf(update)
    if (entities) await this.absorb(entities.values())

    if (isMessageUpdate(update)) {
      await this.saveMessages([update.message], entities)
      const pts = channelPtsOf(update)
      if (pts) await this.store.setChannelPts(pts.chatId, pts.pts, false)
    }
    else if (update instanceof Api.UpdateShortMessage || update instanceof Api.UpdateShortChatMessage) {
      const row = shortMessageRow(update, this.meId)
      await this.store.ensureChats([row.chat_id])
      await this.store.upsertMessages([row])
    }
    else if (update instanceof Api.UpdateDeleteMessages) {
      await this.store.tombstoneCommon(update.messages)
    }
    else if (update instanceof Api.UpdateDeleteChannelMessages) {
      const chatId = channelChatId(update.channelId)
      await this.store.tombstoneInChat(chatId, update.messages)
      if (update.ptsCount > 0) await this.store.setChannelPts(chatId, update.pts, false)
    }
    else if (update instanceof Api.UpdateMessageReactions) {
      await this.store.setReactions(markedId(update.peer), update.msgId, reactionList(update.reactions))
    }
    else if (update instanceof Api.UpdateChannelTooLong) {
      // Only from a channel difference's other updates; live ones never reach the
      // queue. Fetched by the catch-up worker, never here, so the queue does not
      // wait on Telegram.
      this.markDirty(channelChatId(update.channelId), false)
    }
  }

  private async absorb(entities: Iterable<unknown>): Promise<void> {
    const list = [...entities]
    await this.store.upsertUsers(usersOf(list))
    await this.store.refreshKnownChats(chatsOf(list))
  }

  // ── catch-up ───────────────────────────────────────────────────────────────

  /** Starts the catch-up worker if there is work and it is not running. */
  private wakeCatchUps(): void {
    if (this.dirty.size > 0 && !this.stopped) void this.runCatchUps()
  }

  /**
   * The catch-up worker: dirty channels one at a time, CHANNEL_CATCHUP_DELAY_MS
   * apart. Waits out flood pauses; stands aside while channel updates are being
   * skipped (the queue wakes it again) and for a channel with updates still queued
   * (those must be applied first, or its stored pts is not where the skipping
   * began). The promise of the run in progress, so `start()` can wait for it.
   */
  private runCatchUps(): Promise<void> {
    if (this.catchUpRun) return this.catchUpRun
    // Cleared from `.finally`, which runs after this assignment: a run that
    // returns at once would otherwise clear it first and then be stored for good.
    const run = this.catchUps().finally(() => {
      if (this.catchUpRun === run) this.catchUpRun = undefined
    })
    this.catchUpRun = run
    return run
  }

  private async catchUps(): Promise<void> {
    try {
      while (!this.stopped && this.dirty.size > 0) {
        const wait = this.pausedUntil - Date.now()
        if (wait > 0) {
          await sleep(Math.min(wait, 60_000))
          continue
        }
        if (this.shedding) return
        // Disconnected: every difference would fail and count toward giving up
        // with a gap. Wait, as backfill does; a rebuilt client gets a new syncer.
        if (!this.client.connected) {
          await sleep(DISCONNECTED_WAIT_MS)
          continue
        }
        const next = this.nextDirty()
        if (next === undefined) return
        if (typeof next === 'number') {
          await sleep(next)
          continue
        }
        await this.catchUpDirty(next)
        await sleep(CHANNEL_CATCHUP_DELAY_MS)
      }
    }
    catch (error) {
      console.error(`[sync] ${this.sessionId}: channel catch-up stopped: ${describeError(error)}`)
    }
  }

  /**
   * The next channel to catch up; or how long until one is due for a retry; or
   * nothing, when every dirty channel still has updates queued (the queue wakes
   * the worker once it drains).
   */
  private nextDirty(): string | number | undefined {
    const now = Date.now()
    let soonest: number | undefined
    for (const chatId of this.dirty.keys()) {
      if (this.queuedPerChannel.has(chatId)) continue
      const retry = this.retryAt.get(chatId)
      if (retry !== undefined && retry > now) {
        soonest = Math.min(soonest ?? Infinity, retry - now)
        continue
      }
      return chatId
    }
    return soonest === undefined ? undefined : Math.min(soonest, 60_000)
  }

  private async catchUpDirty(chatId: string): Promise<void> {
    const skipped = this.dirty.get(chatId) ?? false
    const run: CatchUpRun = { chatId, held: [], again: false }
    this.catchingUp = run
    let outcome: number | null | 'untracked' | 'unfinished' | 'failed'
    try {
      const channel = await this.store.channelForCatchUp(chatId)
      outcome = channel ? await this.catchUpChannel(channel) : 'untracked'
    }
    catch (error) {
      if (!this.stopped) console.error(`[sync] ${this.sessionId}: catch-up of ${chatId} failed: ${describeError(error)}`)
      outcome = 'failed'
      if (isFlood(error)) this.pause(error)
      else this.failures.set(chatId, (this.failures.get(chatId) ?? 0) + 1)
    }
    finally {
      this.catchingUp = undefined
    }
    if (this.stopped) return
    // Anything this run let go of is fetched again by the next, or lost.
    const lost = skipped || run.again || run.held.length > 0
    const finish = async (gap: boolean, pts: number | null) => {
      this.dirty.delete(chatId)
      this.retryAt.delete(chatId)
      this.failures.delete(chatId)
      if (gap) await this.store.setGap(chatId)
      const now = Date.now()
      for (const update of run.held) {
        // At or below the pts the difference reached, it is already applied.
        if (pts === null || ptsOf(update) > pts) this.push({ update, at: now, channel: chatId })
      }
    }

    if (outcome === 'untracked') {
      // No pts or access hash to fetch a difference with: what was skipped is
      // gone. Say so on the chat, and let its live updates through again.
      return await finish(skipped || run.again, null)
    }
    if (outcome === 'failed' && (this.failures.get(chatId) ?? 0) >= MAX_CATCHUP_FAILURES) {
      console.error(`[sync] ${this.sessionId}: giving up catching up ${chatId}; recording a gap`)
      run.held = []
      return await finish(lost, null)
    }
    if (outcome === 'failed' || outcome === 'unfinished' || run.again) {
      // Again, from wherever the stored pts now is; to the back of the line.
      this.dirty.delete(chatId)
      this.dirty.set(chatId, lost)
      if (outcome === 'failed') this.retryAt.set(chatId, Date.now() + CATCHUP_RETRY_MS)
      return
    }
    // Caught up to `outcome`, or no longer tracked (left, banned, pts expired).
    await finish(outcome === null && skipped, outcome)
  }

  /**
   * Fetches this channel's difference from its stored pts until Telegram says it
   * is final. Answers the pts it reached; `null` when the channel is no longer
   * tracked; 'unfinished' when it stopped early (round cap, or stopping).
   */
  private async catchUpChannel(channel: TrackedChannel): Promise<number | null | 'unfinished'> {
    const input = inputChannelFor(channel.chat_id, channel.access_hash)
    let pts = channel.channel_pts

    for (let round = 0; round < MAX_CHANNEL_DIFFERENCE_ROUNDS && !this.stopped; round++) {
      let diff: Api.updates.TypeChannelDifference
      try {
        diff = await this.client.invoke(new Api.updates.GetChannelDifference({
          channel: input,
          filter: new Api.ChannelMessagesFilterEmpty(),
          pts,
          limit: PAGE,
          force: true,
        }))
      }
      catch (error) {
        const code = describeError(error)
        if (INACCESSIBLE.has(code) || code === 'PERSISTENT_TIMESTAMP_INVALID') {
          // Left, banned, or a pts Telegram no longer recognises: stop tracking
          // it here; the next dialog sync sets a fresh pts if the chat is back.
          await this.store.setChannelPts(channel.chat_id, null, true)
          return null
        }
        throw error
      }

      if (diff instanceof Api.updates.ChannelDifferenceEmpty) {
        await this.store.setChannelPts(channel.chat_id, diff.pts, true)
        return diff.pts
      }

      const entities = entityMap(diff.users, diff.chats)
      await this.absorb(entities.values())

      if (diff instanceof Api.updates.ChannelDifferenceTooLong) {
        // Telegram will not replay this far back: take the latest messages it
        // offers, fill forward from what we held, and record that edits and
        // deletions in between are unknown.
        const storedMax = await this.store.maxMessageId(channel.chat_id)
        await this.saveMessages(diff.messages, entities)
        await this.store.setGap(channel.chat_id)
        const latest = diff.dialog instanceof Api.Dialog && diff.dialog.pts !== undefined ? diff.dialog.pts : null
        if (latest !== null) await this.store.setChannelPts(channel.chat_id, latest, true)
        if (storedMax !== null) await this.fillForward(channel.chat_id, storedMax)
        // Without a pts to stand on, asking again would only answer too long again.
        return latest
      }

      await this.saveMessages(diff.newMessages, entities)
      for (const other of diff.otherUpdates) {
        await this.apply(Object.assign(other, { _entities: entities }))
      }
      pts = diff.pts
      await this.store.setChannelPts(channel.chat_id, pts, true)
      if (diff.final) return pts
    }
    return 'unfinished'
  }

  // ── dialogs ────────────────────────────────────────────────────────────────

  private async syncDialogs(limit?: number): Promise<void> {
    if (this.syncingDialogs) return
    this.syncingDialogs = true
    try {
      for await (const dialog of this.client.iterDialogs(limit ? { limit } : {})) {
        if (this.stopped) return
        const entity = dialog.entity
        const row = entity ? chatRow(entity) : undefined
        if (!row) continue

        const storedMax = await this.store.maxMessageId(row.chat_id)
        await this.store.upsertChats([row])
        if (entity instanceof Api.User) await this.store.upsertUsers([userRow(entity)])
        await this.store.updateDialog(row.chat_id, {
          topMessageId: dialog.dialog.topMessage,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.date ? new Date(dialog.date * 1000) : null,
          archived: dialog.archived,
          pts: dialog.dialog.pts ?? null,
        })
        // A chat's newest message can be older than the backfill window; storing
        // it would put history the window excludes into the chat.
        if (dialog.message && this.withinWindow(dialog.message)) await this.saveMessages([dialog.message])
        if (storedMax !== null && dialog.dialog.topMessage > storedMax) {
          await this.fillForward(row.chat_id, storedMax)
        }
      }
    }
    finally {
      this.syncingDialogs = false
    }
  }

  private async reconcile(): Promise<void> {
    // Disconnected: every request would fail. The session manager rebuilds the
    // client (and this syncer with it); nothing to do here meanwhile.
    if (this.stopped || Date.now() < this.pausedUntil || !this.client.connected) return
    await this.guard('reconcile', () => this.syncDialogs(RECONCILE_DIALOGS))
    void this.runBackfill()
  }

  /** Messages newer than `minId`, newest first, until they meet what we already hold. */
  private async fillForward(chatId: string, minId: number): Promise<void> {
    const chat = await this.store.chat(chatId)
    const peer = chat ? inputPeerFor(chatId, chat.access_hash) : undefined
    if (!peer) return

    let offsetId = 0
    for (let page = 0; page < MAX_FORWARD_PAGES; page++) {
      if (this.stopped) return
      const result = await this.history(peer, { offsetId, minId })
      await this.saveMessages(result.messages, result.entities)
      if (result.ids.length < PAGE) return
      offsetId = Math.min(...result.ids)
      if (offsetId <= minId + 1) return
      await sleep(this.options.pageDelayMs)
    }
    // More than MAX_FORWARD_PAGES behind: say so rather than pretend continuity.
    await this.store.setGap(chatId)
  }

  // ── backfill ───────────────────────────────────────────────────────────────

  private async runBackfill(): Promise<void> {
    if (this.backfillRunning) return
    this.backfillRunning = true
    try {
      while (!this.stopped) {
        const wait = this.pausedUntil - Date.now()
        if (wait > 0) {
          await sleep(Math.min(wait, 60_000))
          continue
        }
        // teleproto reconnecting, or given up: wait rather than fail a page a minute.
        if (!this.client.connected) {
          await sleep(DISCONNECTED_WAIT_MS)
          continue
        }

        const chat = await this.store.nextBackfillChat()
        if (!chat) return

        this.backfilling = true
        try {
          await this.backfillPage(chat)
        }
        catch (error) {
          const code = describeError(error)
          if (isFlood(error)) this.pause(error)
          else if (INACCESSIBLE.has(code)) await this.store.stopBackfill(chat.chat_id, 'inaccessible')
          else {
            console.error(`[sync] ${this.sessionId}: backfill of ${chat.chat_id} failed: ${code}`)
            this.pausedUntil = Date.now() + 60_000
          }
        }
        await sleep(this.options.pageDelayMs)
      }
    }
    catch (error) {
      console.error(`[sync] ${this.sessionId}: backfill stopped: ${describeError(error)}`)
    }
    finally {
      this.backfilling = false
      this.backfillRunning = false
    }
  }

  private async backfillPage(chat: BackfillChat): Promise<void> {
    if (chat.type === 'channel' && !this.options.includeBroadcast) {
      return await this.store.stopBackfill(chat.chat_id, 'skipped')
    }
    if (chat.backfill_count >= this.options.maxPerChat) {
      return await this.store.stopBackfill(chat.chat_id, 'count')
    }
    const peer = inputPeerFor(chat.chat_id, chat.access_hash)
    if (!peer) return await this.store.stopBackfill(chat.chat_id, 'inaccessible')

    const result = await this.history(peer, { offsetId: Number(chat.backfill_cursor ?? 0) })
    // The page that crosses the window's edge is cut at it, so `days` is where
    // stored history ends rather than roughly where the last page did.
    const kept = result.messages.filter(message => this.withinWindow(message))
    await this.saveMessages(kept, result.entities)

    const dates = kept.flatMap(message => dateOf(message) ?? [])
    const oldest = dates.length > 0 ? new Date(Math.min(...dates) * 1000) : null
    const count = chat.backfill_count + dates.length

    let stopped: BackfillStop | null = null
    if (result.ids.length === 0) stopped = 'start'
    else if (kept.length < result.messages.length) stopped = 'days'
    else if (count >= this.options.maxPerChat) stopped = 'count'

    await this.store.recordBackfill(chat.chat_id, {
      cursor: result.ids.length > 0 ? Math.min(...result.ids) : null,
      added: dates.length,
      oldest,
      stopped,
    })
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Whether a history message falls inside the backfill window. One without a date is kept. */
  private withinWindow(message: unknown): boolean {
    const date = dateOf(message)
    return date === undefined || date * 1000 >= Date.now() - this.options.days * 86_400_000
  }

  private async history(peer: Api.TypeInputPeer, params: { offsetId: number, minId?: number }) {
    const result = await this.client.invoke(new Api.messages.GetHistory({
      peer,
      offsetId: params.offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit: PAGE,
      maxId: 0,
      minId: params.minId ?? 0,
      hash: long(0),
    }))
    if (result instanceof Api.messages.MessagesNotModified) {
      return { messages: [] as Api.TypeMessage[], ids: [] as number[], entities: new Map<string, unknown>() }
    }
    return {
      messages: result.messages,
      ids: result.messages.map(message => message.id),
      entities: entityMap(result.users, result.chats),
    }
  }

  private async guard(label: string, task: () => Promise<unknown>): Promise<void> {
    if (this.stopped) return
    try {
      await task()
    }
    catch (error) {
      if (this.stopped) return
      if (isFlood(error)) this.pause(error)
      console.error(`[sync] ${this.sessionId}: ${label} failed: ${describeError(error)}`)
    }
  }

  private pause(error: unknown): void {
    const seconds = Number((error as { seconds?: unknown }).seconds) || 60
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + (seconds + Math.random() * 5) * 1000)
    if (seconds > LONG_FLOOD_S) {
      console.error(`[sync] ${this.sessionId}: Telegram asked this account to wait ${seconds}s; sync is paused until then`)
    }
  }
}

type MessageUpdate = Api.UpdateNewMessage | Api.UpdateEditMessage | Api.UpdateNewChannelMessage | Api.UpdateEditChannelMessage

/**
 * Updates `apply` handles that are not a message upsert. Each one's effect
 * depends on where it lands among the upserts around it — a tombstone must
 * follow the message it deletes, a reaction count is replaced wholesale, a
 * catch-up sets pts exactly — so it ends a batch and is applied on its own.
 * Short messages are here only because `apply` stores them by a separate path.
 */
const ORDERED = [
  Api.UpdateShortMessage, Api.UpdateShortChatMessage, Api.UpdateDeleteMessages,
  Api.UpdateDeleteChannelMessages, Api.UpdateMessageReactions, Api.UpdateChannelTooLong,
]

function isChannelMessageUpdate(update: unknown): update is Api.UpdateNewChannelMessage | Api.UpdateEditChannelMessage {
  return update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateEditChannelMessage
}

function isMessageUpdate(update: unknown): update is MessageUpdate {
  return update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateEditMessage || isChannelMessageUpdate(update)
}

/**
 * Whether an update may share a batch: a message upsert that is not a group
 * migration (which stays on the one-at-a-time path), or an update
 * `apply` reads only for its entities. Never throws: `drain` must not, and an
 * update this cannot read goes to `applyOne`, which logs it.
 */
function batchable(update: unknown): boolean {
  try {
    if (isMessageUpdate(update)) return migrationOf(update.message) === undefined
    return !ORDERED.some(type => update instanceof type)
  }
  catch {
    return false
  }
}

/**
 * The entities teleproto attached to an update, re-keyed: teleproto keys this
 * map with getPeerId, which mis-marks channel ids that are not ten digits long;
 * rebuilt so a lookup by a correct id finds its entity.
 */
function entitiesOf(update: unknown): EntityMap | undefined {
  const attached = (update as { _entities?: EntityMap } | undefined)?._entities
  return attached && attached.size > 0 ? entityMap([...attached.values()]) : undefined
}

/** The channel pts a live message update moves forward, if any. pts 0 marks a message teleproto synthesised from a difference. */
function channelPtsOf(update: MessageUpdate): { chatId: string, pts: number } | undefined {
  if (!isChannelMessageUpdate(update) || update.ptsCount <= 0) return undefined
  if (!('peerId' in update.message) || !update.message.peerId) return undefined
  return { chatId: markedId(update.message.peerId), pts: update.pts }
}

/** The chat write for a stored message: its entity when the update carried one, else a stub. */
function chatOp(chatId: string, entities: EntityMap | undefined): ChatOp {
  const row = entities?.has(chatId) ? chatRow(entities.get(chatId)) : undefined
  return row ? { op: 'upsert', row } : { op: 'stub', chatId }
}

/** A history message's unix date in seconds; `undefined` for MessageEmpty and anything unknown. */
function dateOf(message: unknown): number | undefined {
  return message instanceof Api.Message || message instanceof Api.MessageService ? message.date : undefined
}

function isFlood(error: unknown): boolean {
  return /^FLOOD_(PREMIUM_)?WAIT/.test(describeError(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

/**
 * The marked id of the channel a channel-sequence update belongs to; undefined
 * for everything else, which is never skipped. These four are what a channel
 * difference replays, so they are the only ones that can be dropped and fetched
 * again.
 */
function channelOf(update: unknown): string | undefined {
  if (isChannelMessageUpdate(update)) {
    const peer = 'peerId' in update.message ? update.message.peerId : undefined
    return peer instanceof Api.PeerChannel ? channelChatId(peer.channelId) : undefined
  }
  if (update instanceof Api.UpdateDeleteChannelMessages || update instanceof Api.UpdateChannelTooLong) {
    return channelChatId(update.channelId)
  }
  return undefined
}

/** The channel pts an update brings its channel to; 0 when it carries none. */
function ptsOf(update: unknown): number {
  return isChannelMessageUpdate(update) || update instanceof Api.UpdateDeleteChannelMessages ? update.pts : 0
}

export function heapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1_048_576)
}
