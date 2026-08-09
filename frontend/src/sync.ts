import db, { clientId, getMeta, setMeta, uuid, type OutboxOp } from './db'

/** 一次同步最多带走多少条，与后端 SyncRequest.ops 的 max_length 对齐。 */
const BATCH = 200

export type SyncResult = {
  applied: number
  duplicate: number
  rejected: { op_id: string; reason: string }[]
  changes: number
  cursor: number
}

/** 同一时刻只允许一个同步在跑，否则同一批 op 会被发两遍。 */
let inFlight: Promise<SyncResult | null> | null = null

/**
 * 写入路径：**先写本地，再排队**。
 *
 * 两张表在同一个 Dexie 事务里写 —— 要么本地镜像和 outbox 都有，
 * 要么都没有。否则会出现"UI 显示了但永远不会被同步"的幽灵记录。
 */
export async function enqueue(
  entity: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const op_id = uuid()
  const client_ts = new Date().toISOString()

  await db.transaction('rw', db.outbox, db.events, db.meta, async () => {
    const seq = (await getMeta<number>('client_seq', 0)) + 1
    await setMeta('client_seq', seq)

    const op: OutboxOp = {
      op_id,
      entity,
      op_type: 'insert',
      client_seq: seq,
      client_ts,
      payload,
    }
    await db.outbox.add(op)
    await db.events.add({
      op_id,
      label: String(payload.label ?? ''),
      created_at: client_ts,
      synced: 0,
      remote: 0,
    })
  })

  // 尽快发出去：outbox 停留时间越短，设备损坏时丢的越少
  void sync()
  return op_id
}

export async function sync(): Promise<SyncResult | null> {
  if (inFlight) return inFlight
  inFlight = doSync().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doSync(): Promise<SyncResult | null> {
  const ops = await db.outbox.orderBy('client_seq').limit(BATCH).toArray()
  const since = await getMeta<number>('cursor', 0)
  const cid = await clientId()

  // outbox 空也要发一次：这是拉取其它设备变更的唯一时机
  const body = JSON.stringify({ client_id: cid, since_cursor: since, ops })

  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) {
    // 不清 outbox —— 下次重试。重复发送是安全的，因为 op_id 幂等。
    throw new Error(`sync failed: HTTP ${res.status}`)
  }

  const data = await res.json()

  // applied 和 duplicate 都算"服务端已经有了"，都可以从 outbox 删。
  // duplicate 不是错误，它恰恰是重放机制正常工作的证据。
  const settled: string[] = [...data.applied, ...data.duplicate]

  await db.transaction('rw', db.outbox, db.events, db.meta, async () => {
    if (settled.length) {
      await db.outbox.bulkDelete(settled)
      await Promise.all(settled.map((id) => db.events.update(id, { synced: 1 })))
    }

    // 应用其它设备的变更
    for (const c of data.changes as {
      op_id: string
      entity: string
      payload: Record<string, unknown>
    }[]) {
      if (c.entity !== 'ping_event') continue
      await db.events.put({
        op_id: c.op_id,
        label: String(c.payload.label ?? ''),
        created_at: String(c.payload.created_at ?? new Date().toISOString()),
        synced: 1,
        remote: 1,
      })
    }

    // 游标最后才推进：中途崩了就重来一次，宁可重复也不能跳过
    await setMeta('cursor', data.cursor)
  })

  return {
    applied: data.applied.length,
    duplicate: data.duplicate.length,
    rejected: data.rejected,
    changes: data.changes.length,
    cursor: data.cursor,
  }
}

/**
 * 触发时机。
 *
 * ⚠️ iOS 不支持 Background Sync —— 后台绝不会自己重放。
 * 所以必须在**回到前台**时立刻同步，这是 iPad 上最关键的一个钩子。
 */
export function installSyncTriggers(onResult?: (r: SyncResult | null) => void) {
  const run = () => {
    sync()
      .then((r) => onResult?.(r))
      .catch(() => onResult?.(null))
  }

  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  // 兜底轮询：网络在"连着但不通"的状态时，online 事件不会触发
  const timer = window.setInterval(run, 15_000)
  run()

  return () => {
    window.removeEventListener('online', run)
    window.clearInterval(timer)
  }
}
