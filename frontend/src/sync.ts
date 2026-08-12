import { authFetch } from './auth'
import { applyCheckOp } from './checks'
import { applyTrayOp } from './trays'
import db, {
  clientId,
  getMeta,
  nextClientSeq,
  setMeta,
  uuid,
  type OutboxOp,
} from './db'

/** How many ops one sync carries at most; matches SyncRequest.ops max_length on the server. */
const BATCH = 200

type RemoteChange = {
  op_id: string
  entity: string
  client_ts: string
  /** Display name the server attaches -- a device only knows that for its own ops */
  user_display?: string | null
  payload: Record<string, unknown>
}

export type SyncResult = {
  applied: number
  duplicate: number
  rejected: { op_id: string; reason: string }[]
  changes: number
  cursor: number
}

/**
 * The two kinds of sync failure are nothing alike and must never be conflated:
 *
 * - `offline`: no network. **This is a normal state**; the data is safe in the outbox.
 * - `auth`: the session expired and someone has to sign in again. Still queued safely.
 * - `error`: connected, but the server failed. This is the one that needs a person.
 *
 * Showing all three as "sync failed" was a real problem -- a server who reads
 * "failed" redoes the work, and in a restaurant a lying status is worse than a crash.
 */
export type SyncFailure = { kind: 'offline' | 'auth' | 'error'; message: string }

/** Hard timeout for one request. Fetch has **no default timeout** -- see STUCK_MS below. */
const FETCH_TIMEOUT = 10_000

/**
 * The in-flight watchdog.
 *
 * What this cost once (six records lost on a real device):
 * airplane mode goes on with a fetch in flight. Fetch has no default timeout,
 * so that promise **never settles** -- `inFlight` stays set forever and every
 * later sync() hands back the same dead promise, **never issuing a request
 * again**. The timer keeps firing, Caddy never hears anything, and the UI sits
 * on whatever it last reported.
 *
 * Two defences: (1) AbortController on the fetch, (2) this watchdog behind it.
 */
const STUCK_MS = 30_000

/** Only one sync may run at a time, or the same batch of ops goes out twice. */
let inFlight: Promise<SyncResult | null> | null = null
let inFlightAt = 0

/**
 * The write path: **write locally, then queue**.
 *
 * Both tables are written in one Dexie transaction -- either the mirror and the
 * outbox both have it, or neither does. Otherwise you get a ghost record the UI
 * shows and sync never sends.
 */
export async function enqueue(
  entity: string,
  payload: Record<string, unknown>,
  /** Callers may bring their own op_id -- a check uses it as its identity */
  opId?: string,
): Promise<string> {
  const op_id = opId ?? uuid()
  const client_ts = new Date().toISOString()

  await db.transaction('rw', db.outbox, db.trays, db.meta, async () => {
    const seq = await nextClientSeq()

    const op: OutboxOp = {
      op_id,
      entity,
      op_type: 'insert',
      client_seq: seq,
      client_ts,
      payload,
    }
    await db.outbox.add(op)

    // A refill's local mirror row and its outbox entry are written in **one
    // transaction**. Split, they produce "the record went out but the board does
    // not show it" -- and "last refilled N minutes ago" is the only feedback there is, so people tap again.
    if (entity === 'tray_event') {
      const back = Number(payload.minutes_ago ?? 0) || 0
      await db.trays.add({
        op_id,
        dish_id: Number(payload.dish_id),
        kind: String(payload.event_type) as 'refill' | 'half' | 'empty',
        at: new Date(Date.parse(client_ts) - back * 60_000).toISOString(),
        synced: 0,
        remote: 0,
      })
    }
  })

  // Send it as soon as possible: the less time in the outbox, the less a broken device loses
  void sync()
  return op_id
}

export async function sync(): Promise<SyncResult | null> {
  // Only reuse one that is **really still running**. Past the watchdog window it
  // counts as dead: drop it and start again -- resending is safe, op_id is idempotent.
  if (inFlight && Date.now() - inFlightAt < STUCK_MS) return inFlight

  if (inFlight) console.warn('[sync] the previous sync looks stuck; dropping it and retrying')

  inFlightAt = Date.now()
  const p = doSync().finally(() => {
    // Only clear it while still the current one, or a later sync gets cleared by an earlier one
    if (inFlight === p) inFlight = null
  })
  inFlight = p
  return p
}

/**
 * Take the ops to send.
 *
 * ⚠️ **Never use `db.outbox.orderBy('client_seq')`.**
 * That is an index query, and IndexedDB **silently excludes** records whose
 * index key is invalid (NaN / undefined / null) -- while `count()` still counts
 * them. The result: the UI says "4 pending" and the request body is `ops: []`,
 * with those four stuck forever and no error anywhere. That is how they were lost on a real device.
 *
 * Reading everything and sorting in JS **depends on no index, so nothing can hide.**
 */
async function takePending(): Promise<OutboxOp[]> {
  const all = await db.outbox.toArray()

  // Repair bad historical rows on the way past: give an invalid client_seq a
  // legal value, or they stay invisible on the next pass even if this one sends them
  const broken = all.filter((o) => !Number.isFinite(o.client_seq))
  if (broken.length) {
    console.warn(`[sync] repairing ${broken.length} records with an invalid client_seq`)
    let base = await nextClientSeq()
    await db.transaction('rw', db.outbox, db.meta, async () => {
      for (const o of broken) {
        o.client_seq = base++
        await db.outbox.put(o)
      }
      await setMeta('client_seq', base)
    })
  }

  return all
    .sort((a, b) => (a.client_seq ?? 0) - (b.client_seq ?? 0))
    .slice(0, BATCH)
}

/**
 * The server says its log no longer holds anything before our cursor (`reset`).
 *
 * Sync is **append-only**: what the server deleted never arrives as a change,
 * so those checks stay in the local mirror and the screen shows checks that no
 * longer exist. The only right move is to drop the mirror, zero the cursor and pull again.
 *
 * ⚠️ **Only synced=1 rows go.** synced=0 means it is still in the outbox and
 *    has never been sent -- a check the store just entered that the server has
 *    never seen, so clearing it really would lose data.
 *    The outbox and the dead letter queue are not touched at all.
 */
async function resetMirror(): Promise<void> {
  await db.transaction('rw', db.checks, db.events, db.trays, db.meta, async () => {
    await db.checks.filter((c) => c.synced === 1).delete()
    await db.events.filter((e) => e.synced === 1).delete()
    await db.trays.filter((t) => t.synced === 1).delete()
    await setMeta('cursor', 0)
    // Stored rather than kept in memory: reloading halfway through a re-pull
    // still has to start over, or the mirror misses the part the server "only sends to others".
    await setMeta('resync', 1)
  })
  console.warn('[sync] the server log was truncated; rebuilding the local mirror')
}

async function doSync(): Promise<SyncResult | null> {
  const ops = await takePending()
  const since = await getMeta<number>('cursor', 0)
  const cid = await clientId()
  const resync = (await getMeta<number>('resync', 0)) === 1

  // Send even with an empty outbox: this is the only moment other devices' changes get pulled
  const body = JSON.stringify({
    client_id: cid,
    since_cursor: since,
    ops,
    resync,
  })

  let res: Response
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  try {
    res = await authFetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    })
  } catch (e) {
    // A request aborted on timeout **may well have arrived and been processed**,
    // with only the response lost. That is fine -- the replay comes back as a duplicate, which is what op_id is for.
    const aborted = (e as Error)?.name === 'AbortError'
    const f: SyncFailure = {
      kind: 'offline',
      message: aborted ? 'Request timed out, queued for retry' : 'Offline, queued',
    }
    throw f
  } finally {
    window.clearTimeout(timer)
  }

  if (res.status === 401) {
    // authFetch already tried to refresh, so a 401 here means the session is really gone.
    // **Never clear the outbox** -- unsynced records belong to the store and
    // still have to go out after signing in again.
    const f: SyncFailure = { kind: 'auth', message: 'Session expired, please sign in again' }
    throw f
  }

  if (!res.ok) {
    // Do not clear the outbox -- retry next time. Resending is safe, op_id is idempotent.
    //
    // ⚠️ A reachable proxy with a dead upstream returns 502/503/504, so fetch
    //    **succeeds** and the catch above never runs. To staff that is no
    //    different from being offline: the data is queued and resends itself,
    //    and nobody has to do anything.
    //    A red "error" makes them think it broke and re-enter the check.
    //    408/429 (timeout / rate limit) are the same -- they pass on their own.
    const transient = [408, 425, 429, 500, 502, 503, 504].includes(res.status)
    const f: SyncFailure = transient
      ? { kind: 'offline', message: `Server unavailable (${res.status}), queued` }
      : { kind: 'error', message: `Server HTTP ${res.status}` }
    throw f
  }

  const data = await res.json()

  // applied and duplicate both mean "the server has it", so both leave the outbox.
  // A duplicate is not an error; it is the replay mechanism working.
  const settled: string[] = [...data.applied, ...data.duplicate]

  // Explicitly rejected by the server: **it must not sit in the outbox retrying**
  // forever, or the outbox never empties, "pending" never reaches zero and every
  // round wastes a send.
  // Move it to the dead letter queue for a person to handle.
  const rejected = (data.rejected ?? []) as { op_id: string; reason: string }[]
  let remoteChanges: RemoteChange[] = []


  // Dexie only takes an array scope past five tables
  await db.transaction(
    'rw',
    [db.outbox, db.events, db.meta, db.deadletter, db.checks, db.trays],
    async () => {
      if (rejected.length) {
        const byId = new Map(ops.map((o) => [o.op_id, o]))
        for (const r of rejected) {
          const op = byId.get(r.op_id)
          await db.deadletter.put({
            op_id: r.op_id,
            entity: op?.entity ?? '?',
            payload: op?.payload ?? {},
            reason: r.reason,
            failed_at: new Date().toISOString(),
          })
        }
        await db.outbox.bulkDelete(rejected.map((r) => r.op_id))
      }

      if (settled.length) {
        await db.outbox.bulkDelete(settled)
        await Promise.all(settled.map((id) => db.events.update(id, { synced: 1 })))
        // A check's check_uuid is the op_id of the op that created it
        await Promise.all(settled.map((id) => db.checks.update(id, { synced: 1 })))
        await Promise.all(settled.map((id) => db.trays.update(id, { synced: 1 })))
      }

      // Other devices' changes. On a reset this batch is empty by definition,
      // and the mirror is about to be cleared -- so nothing is applied.
      remoteChanges = data.reset ? [] : (data.changes as RemoteChange[])

      if (!data.reset) {
        // The cursor advances last: a crash in between just repeats a round, and repeating beats skipping
        await setMeta('cursor', data.cursor)

        // A full re-pull is only done at an **empty response**. A full batch means
        // more is coming (the server sends 500 at most), and clearing resync now
        // would make the next page filter out this device's own ops again -- leaving a gap.
        if (resync && data.changes.length === 0) await setMeta('resync', 0)
      }
    },
  )

  if (data.reset) {
    // Order matters: the transaction above already settled this batch out of the
    // outbox and marked the matching local checks synced=1. Marking has to come
    // first -- otherwise they stay in the mirror as synced=0 with no op left in
    // the outbox, which is a ghost check that can never sync.
    await resetMirror()
    // Immediately go again and pull back what the server actually has.
    // Not waiting for the next heartbeat (up to 20 seconds) -- the screen is empty until then.
    setTimeout(() => void sync(), 0)
    return {
      applied: data.applied.length,
      duplicate: data.duplicate.length,
      rejected: data.rejected,
      changes: 0,
      cursor: 0,
    }
  }

  // Check changes are applied outside the transaction -- applyCheckOp reads the
  // catalog (also in the meta table), and overlapping table scopes would deadlock
  for (const c of remoteChanges) {
    if (c.entity === 'tray_event') {
      await applyTrayOp(c.op_id, c.payload, c.client_ts, {
        synced: 1,
        remote: 1,
        who: c.user_display ?? undefined,
      })
    } else if (c.entity === 'ping_event') {
      await db.events.put({
        op_id: c.op_id,
        label: String(c.payload.label ?? ''),
        // Use the source device's client_ts, not "when it arrived" --
        // otherwise a backlog of offline records all sorts to the top and the timeline is wrong
        created_at: c.client_ts,
        synced: 1,
        remote: 1,
      })
    } else {
      await applyCheckOp(c.entity, c.op_id, c.payload, c.client_ts, {
        synced: 1,
        remote: 1,
        who: c.user_display ?? undefined,
      })
    }
  }

  return {
    applied: data.applied.length,
    duplicate: data.duplicate.length,
    rejected: data.rejected,
    changes: data.changes.length,
    cursor: data.cursor,
  }
}

/** Retry interval while the outbox has a backlog -- fast, because staff are watching it clear */
const POLL_PENDING = 4_000
/** Idle heartbeat -- only to pull other devices' changes, so it can be slow */
const POLL_IDLE = 20_000

/**
 * When it fires.
 *
 * ⚠️ iOS has no Background Sync -- nothing ever replays in the background.
 * So it has to sync the moment the app **comes back to the foreground**; that is the critical hook on an iPad.
 */
export function installSyncTriggers(
  onResult?: (r: SyncResult | null, failure?: SyncFailure) => void,
) {
  let timer: number | undefined
  let stopped = false

  const schedule = async () => {
    if (stopped) return
    const pending = await db.outbox.count()
    window.clearTimeout(timer)
    timer = window.setTimeout(run, pending > 0 ? POLL_PENDING : POLL_IDLE)
  }

  const run = () => {
    sync()
      .then((r) => onResult?.(r))
      .catch((e: unknown) => {
        const f: SyncFailure =
          e && typeof e === 'object' && 'kind' in e
            ? (e as SyncFailure)
            : { kind: 'error', message: String(e) }
        onResult?.(null, f)
      })
      .finally(schedule)
  }

  window.addEventListener('online', run)
  // ⚠️ iOS has no Background Sync -- returning to the foreground is the critical hook
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  run()

  return () => {
    stopped = true
    window.removeEventListener('online', run)
    window.clearTimeout(timer)
  }
}
