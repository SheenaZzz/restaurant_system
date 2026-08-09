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

const db = new Dexie('restaurant') as Dexie & {
  outbox: EntityTable<OutboxOp, 'op_id'>
  events: EntityTable<LocalEvent, 'op_id'>
  meta: EntityTable<Meta, 'key'>
}

db.version(1).stores({
  // 主键写在第一位，逗号后面是额外索引
  outbox: 'op_id, client_seq',
  events: 'op_id, created_at, synced',
  meta: 'key',
})

export default db

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
