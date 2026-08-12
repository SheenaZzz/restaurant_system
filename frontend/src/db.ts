import Dexie, { type EntityTable } from 'dexie'

/** outbox: operations waiting to sync. Deleted once the server has them. */
export interface OutboxOp {
  op_id: string
  entity: string
  op_type: 'insert'
  client_seq: number
  client_ts: string
  payload: Record<string, unknown>
}

/** events: the local mirror the UI reads directly, which is why it still has data offline. */
export interface LocalEvent {
  op_id: string
  label: string
  created_at: string
  /** 0 = still in the outbox, 1 = the server confirmed it */
  synced: 0 | 1
  /** A change that came from another device */
  remote: 0 | 1
}

/** meta: client id, sync cursor, local sequence counter */
export interface Meta {
  key: string
  value: unknown
}

/** One dish on a check. */
export interface LocalLine {
  /** The server's line id; a line just added locally has none until it syncs */
  line_id?: number
  menu_item_id: number
  name: string
  /** English dish name, captured at order time -- renaming the menu never restates a past check. */
  name_en?: string
  qty: number
  /**
   * ⚠️ **Add-on money is already in here** (dish price + the sum of add-on
   * prices), the same convention as the server's order_line.unit_price_cents.
   * Everything that computes money multiplies this; never add modifiers on top -- that counts them twice.
   */
  unit_price_cents: number
  /**
   * What was added, for display only. The money is folded into unit_price_cents.
   * label_en / modifier_id are for the language switch: catalogue add-ons follow
   * the language, hand-typed requests (no id) are shown exactly as the front typed them.
   */
  modifiers?: {
    label: string
    label_en?: string
    modifier_id?: number
    price_cents: number
  }[]
  notes?: string
  voided?: boolean
}

/** One check on the floor (local mirror). The UI only reads this, which is why it works offline. */
export interface LocalCheck {
  check_uuid: string
  /** dine_in holds a table; phone_order / buffet_togo are to-go and have none */
  source: 'dine_in' | 'phone_order' | 'buffet_togo'
  table_label: string
  /** A la carte dishes */
  lines: LocalLine[]
  /** Guest details on a to-go check */
  customer_name?: string
  phone_last4?: string
  status: 'open' | 'closed' | 'voided' | 'merged'
  opened_at: string
  adult: number
  child: number
  senior: number
  drink_adult: number
  drink_child: number
  /** The client's estimate from cached prices, **for display only**; the stored amount is the server's */
  est_cents: number
  /** 0 = the server has not confirmed it yet */
  synced: 0 | 1
  /** 1 = opened on another device */
  remote: 0 | 1
  /** Void reason (voided only) */
  void_reason?: string
  /** The status before the void; undo restores it */
  pre_void_status?: 'open' | 'closed'
  /** Which check this was folded into */
  merged_into?: string
  /** Large-party service charge (local estimate) */
  service_cents: number
  /** Tax (local estimate) */
  tax_cents: number
  /** Payment method */
  pay_method?: 'cash' | 'card' | 'mixed' | 'other'
  pay_cash?: number
  pay_card?: number
  pay_other?: number
  pay_note?: string
  /** Who opened the table */
  by?: string
  /** Who touched it last */
  last_by?: string
}

/**
 * One refill record in the local mirror.
 *
 * It exists only to show "last refilled N minutes ago" -- the one piece of
 * feedback the board needs. Without it nobody knows whether their tap
 * registered, so they tap again or stop bothering. The fact itself lives in
 * tray_event on the server; this is a read-only copy.
 */
export interface LocalTray {
  op_id: string
  dish_id: number
  kind: 'refill' | 'half' | 'empty'
  /** When it was observed (the backdating is already applied) */
  at: string
  synced: 0 | 1
  remote: 0 | 1
  who?: string
}

const db = new Dexie('restaurant') as Dexie & {
  outbox: EntityTable<OutboxOp, 'op_id'>
  events: EntityTable<LocalEvent, 'op_id'>
  meta: EntityTable<Meta, 'key'>
  deadletter: EntityTable<DeadLetter, 'op_id'>
  checks: EntityTable<LocalCheck, 'check_uuid'>
  trays: EntityTable<LocalTray, 'op_id'>
}

/** Operations the server explicitly rejected. They must not retry forever in the outbox. */
export interface DeadLetter {
  op_id: string
  entity: string
  payload: Record<string, unknown>
  reason: string
  failed_at: string
}

db.version(1).stores({
  // The primary key comes first; anything after the comma is an extra index
  outbox: 'op_id, client_seq',
  events: 'op_id, created_at, synced',
  meta: 'key',
})

db.version(2).stores({
  deadletter: 'op_id, failed_at',
})

db.version(3).stores({
  checks: 'check_uuid, table_label, status',
})

db.version(4).stores({
  // Indexed on dish_id: the refill page asks "when was the last one" per dish
  trays: 'op_id, dish_id, at',
})

export default db

/**
 * A monotonic local sequence number, **NaN-safe**.
 *
 * What this cost: it used to be `(await getMeta('client_seq', 0)) + 1`.
 * The moment meta holds something that is not a number the result is NaN --
 * and NaN is not a valid IndexedDB index key, so that record:
 *   1. stores into the outbox fine
 *   2. is counted by count() (the UI shows "N pending")
 *   3. never appears in an orderBy('client_seq') result
 * That is stuck forever, with no error. Worse, NaN+1 is still NaN, so every
 * record after it is caught too. In a restaurant that is silently losing checks.
 */
export async function nextClientSeq(): Promise<number> {
  const raw = await getMeta<unknown>('client_seq', 0)
  const cur = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  const next = cur + 1
  await setMeta('client_seq', next)
  return next
}

// ---------------------------------------------------------------------------
// meta read/write
// ---------------------------------------------------------------------------

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

/**
 * crypto.randomUUID only exists in a secure context (HTTPS or localhost).
 * On an iPad over plain HTTP it is undefined -- one more reason HTTPS is not
 * optional. This is a fallback so it degrades instead of throwing.
 */
export function uuid(): string {
  // Widen the type deliberately: lib.dom declares crypto as always present,
  // so narrowing with `in` makes TS infer the else branch as never.
  const c = globalThis.crypto as Crypto | undefined

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    // The last resort. Math.random is not cryptographically secure, but this
    // only needs op_ids not to collide, not to be unpredictable. Degrading beats
    // throwing -- a throw means this device can never record anything again.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (Math.random() * 256) | 0
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Device identity: generated once and then fixed, so the server can tell where a change came from. */
export async function clientId(): Promise<string> {
  let id = await getMeta<string | null>('client_id', null)
  if (!id) {
    id = `web-${uuid().slice(0, 8)}`
    await setMeta('client_id', id)
  }
  return id
}
