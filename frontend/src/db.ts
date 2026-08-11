import Dexie, { type EntityTable } from 'dexie'

/** outbox：待同步的操作队列。同步成功后删除。 */
export interface OutboxOp {
  op_id: string
  entity: string
  op_type: 'insert'
  client_seq: number
  client_ts: string
  payload: Record<string, unknown>
}

/** events：本地镜像，UI 直接读它 —— 所以离线时界面照样有数据。 */
export interface LocalEvent {
  op_id: string
  label: string
  created_at: string
  /** 0 = 还在 outbox 里，1 = 服务端已确认 */
  synced: 0 | 1
  /** 来自其它设备的变更 */
  remote: 0 | 1
}

/** meta：客户端 id、同步游标、本地序号计数器 */
export interface Meta {
  key: string
  value: unknown
}

/** 账单上的一道菜。 */
export interface LocalLine {
  /** 服务端行 id；本地刚加的还没有，同步后才会有 */
  line_id?: number
  menu_item_id: number
  name: string
  qty: number
  /**
   * ⚠️ **已经含加料的钱**（菜价 + Σ 加料单价），和服务端
   * order_line.unit_price_cents 一个口径。所有算金额的地方都乘这个数，
   * 不要再去加 modifiers —— 会重复计一次。
   */
  unit_price_cents: number
  /** 加了什么，仅供显示。金额已折进 unit_price_cents。 */
  modifiers?: { label: string; price_cents: number }[]
  notes?: string
  voided?: boolean
}

/** 楼面上的一张账单（本地镜像）。UI 只读它 —— 所以断网照样能用。 */
export interface LocalCheck {
  check_uuid: string
  /** dine_in 占桌；phone_order / buffet_togo 是自提，没有桌号 */
  source: 'dine_in' | 'phone_order' | 'buffet_togo'
  table_label: string
  /** 单点菜品 */
  lines: LocalLine[]
  /** 自提单的客人信息 */
  customer_name?: string
  phone_last4?: string
  status: 'open' | 'closed' | 'voided' | 'merged'
  opened_at: string
  adult: number
  child: number
  senior: number
  drink_adult: number
  drink_child: number
  /** 客户端按缓存价估的金额，**仅供显示**；落库金额以服务端为准 */
  est_cents: number
  /** 0 = 还没被服务端确认 */
  synced: 0 | 1
  /** 1 = 别的设备开的 */
  remote: 0 | 1
  /** 作废原因（仅 voided） */
  void_reason?: string
  /** 作废前的状态，撤销时恢复成它 */
  pre_void_status?: 'open' | 'closed'
  /** 被并入了哪张单 */
  merged_into?: string
  /** 大桌服务费（本地估算） */
  service_cents: number
  /** 税（本地估算） */
  tax_cents: number
  /** 支付方式 */
  pay_method?: 'cash' | 'card' | 'mixed' | 'other'
  pay_cash?: number
  pay_card?: number
  pay_other?: number
  pay_note?: string
  /** 开台的人 */
  by?: string
  /** 最近一次操作的人 */
  last_by?: string
}

const db = new Dexie('restaurant') as Dexie & {
  outbox: EntityTable<OutboxOp, 'op_id'>
  events: EntityTable<LocalEvent, 'op_id'>
  meta: EntityTable<Meta, 'key'>
  deadletter: EntityTable<DeadLetter, 'op_id'>
  checks: EntityTable<LocalCheck, 'check_uuid'>
}

/** 服务端明确拒绝的操作。不能留在 outbox 里无限重试。 */
export interface DeadLetter {
  op_id: string
  entity: string
  payload: Record<string, unknown>
  reason: string
  failed_at: string
}

db.version(1).stores({
  // 主键写在第一位，逗号后面是额外索引
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

export default db

/**
 * 单调递增的本地序号，**NaN 安全**。
 *
 * 踩过的坑：原来直接写 `(await getMeta('client_seq', 0)) + 1`。
 * 一旦 meta 里的值不是数字，结果就是 NaN —— 而 NaN 不是合法的
 * IndexedDB 索引键，于是这条记录：
 *   ① 能存进 outbox
 *   ② 被 count() 数到（UI 显示"待同步 N"）
 *   ③ 却永远不会出现在 orderBy('client_seq') 的结果里
 * 也就是永久卡死、且不报任何错。更糟的是 NaN+1 还是 NaN，
 * 之后每一条都会中招。在餐馆里这等于静默丢单。
 */
export async function nextClientSeq(): Promise<number> {
  const raw = await getMeta<unknown>('client_seq', 0)
  const cur = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  const next = cur + 1
  await setMeta('client_seq', next)
  return next
}

// ---------------------------------------------------------------------------
// meta 读写
// ---------------------------------------------------------------------------

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

/**
 * crypto.randomUUID 只在安全上下文（HTTPS 或 localhost）可用。
 * iPad 上走明文 HTTP 时它是 undefined —— 这正是"必须上 HTTPS"的
 * 又一个理由。这里给个降级实现，避免静默炸掉。
 */
export function uuid(): string {
  // 显式放宽类型：lib.dom 把 crypto 声明为必然存在，
  // 用 `in` 收窄会让 TS 把 else 分支推成 never。
  const c = globalThis.crypto as Crypto | undefined

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    // 最后的兜底。Math.random 不是密码学安全的，但这里只需要
    // op_id 不重复，不需要不可预测。宁可退化也不能抛异常 ——
    // 抛了就等于这台设备永远无法记录任何东西。
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = (Math.random() * 256) | 0
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 设备标识：首次生成后固定，用于服务端区分变更来源。 */
export async function clientId(): Promise<string> {
  let id = await getMeta<string | null>('client_id', null)
  if (!id) {
    id = `web-${uuid().slice(0, 8)}`
    await setMeta('client_id', id)
  }
  return id
}
