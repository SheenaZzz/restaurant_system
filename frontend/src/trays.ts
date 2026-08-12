import { loadCatalog } from './catalog'
import db, { type LocalTray } from './db'
import { enqueue } from './sync'

/**
 * Refill records.
 *
 * This is the project's only path for collecting a quantity that **cannot be
 * observed**: nobody can read the buffet's rate of consumption, only
 * interval-censored events -- filled at t1, found empty at t2. So every decision
 * here serves "can this be modelled later" before it serves the interface.
 *
 * ⚠️ Append-only. Tapped the wrong one? Record the right one straight after --
 *    there is no undo. Two events seconds apart are distinguishable when
 *    modelling, while a fact table that can be edited loses all credibility:
 *    nobody could say afterwards which row was recorded at the time.
 */

export type TrayKind = 'refill' | 'half' | 'empty'

export interface BoardDish {
  id: number
  page: number
  pos: number
  name_zh: string
  name_en: string
}

/** The board from the catalogue. Works offline -- cooks keep refilling when the network is down. */
export async function loadBoard(): Promise<Record<string, BoardDish[]>> {
  const cat = await loadCatalog()
  return (cat?.buffet_board ?? { lunch: [], dinner: [] }) as Record<string, BoardDish[]>
}

/**
 * Record one. `minutesAgo` is how far back it is dated -- cooks usually tap **after** the fact.
 *
 * The server stores observed_at as `client_ts - minutesAgo`: one clock, so
 * "device time" and "observation time" cannot drift apart as two separate sources.
 */
export async function recordTray(
  dish_id: number,
  kind: TrayKind,
  minutesAgo = 0,
): Promise<void> {
  // The local mirror is written by enqueue in the **same transaction** -- see sync.ts.
  await enqueue('tray_event', {
    dish_id,
    event_type: kind,
    minutes_ago: minutesAgo,
  })
}

/** Records other people made, sent down by the server. */
export async function applyTrayOp(
  op_id: string,
  payload: Record<string, unknown>,
  client_ts: string,
  opts: { synced: 0 | 1; remote: 0 | 1; who?: string },
): Promise<void> {
  const back = Number(payload.minutes_ago ?? 0) || 0
  await db.trays.put({
    op_id,
    dish_id: Number(payload.dish_id),
    kind: String(payload.event_type ?? 'refill') as TrayKind,
    at: new Date(new Date(client_ts).getTime() - back * 60_000).toISOString(),
    ...opts,
  })
}

/** The latest record per dish. Every slot on the board shows "how long ago". */
export async function lastByDish(): Promise<Map<number, LocalTray>> {
  const out = new Map<number, LocalTray>()
  await db.trays.each((t) => {
    const cur = out.get(t.dish_id)
    if (!cur || t.at > cur.at) out.set(t.dish_id, t)
  })
  return out
}

/**
 * Keep only the last 24 hours.
 *
 * This copy exists purely to show "how long ago", and anything older than a day
 * means nothing at the counter -- while IndexedDB on an iPad can be evicted
 * wholesale when storage runs short, so unused data only raises that risk.
 * The history is all on the server, and the model reads only from there.
 */
export async function pruneTrays(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()
  const doomed = await db.trays.where('at').below(cutoff).primaryKeys()
  if (doomed.length) await db.trays.bulkDelete(doomed)
  return doomed.length
}

/** "12 minutes ago" and the like. What the counter needs is **how long**, not a clock time. */
export function agoText(iso: string, now = Date.now()): { mins: number; text: string } {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  return { mins, text: String(mins) }
}
