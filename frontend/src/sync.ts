import { authFetch } from './auth'
import { applyCheckOp } from './checks'
import db, {
  clientId,
  getMeta,
  nextClientSeq,
  setMeta,
  uuid,
  type OutboxOp,
} from './db'

/** 一次同步最多带走多少条，与后端 SyncRequest.ops 的 max_length 对齐。 */
const BATCH = 200

type RemoteChange = {
  op_id: string
  entity: string
  client_ts: string
  /** 服务端带出来的操作人显示名 —— 本地只知道自己那些 op 是谁做的 */
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
 * 同步失败的两种性质完全不同，绝不能混为一谈：
 *
 * - `offline`：网络不通。**这是正常状态**，数据安全地排在 outbox 里。
 * - `auth`：会话失效，需要重新登录。数据仍然安全排队。
 * - `error`：连上了但服务端出错。这才需要人介入。
 *
 * 之前统一显示"同步失败"是个真问题 —— 服务员看到"失败"会重复操作，
 * 而在餐馆里，一个骗人的状态提示比崩溃更危险。
 */
export type SyncFailure = { kind: 'offline' | 'auth' | 'error'; message: string }

/** 单次请求的硬超时。Fetch API **没有默认超时** —— 见下方 STUCK_MS 的说明。 */
const FETCH_TIMEOUT = 10_000

/**
 * in-flight 看门狗。
 *
 * 踩过的坑（真机上丢了 6 条记录）：
 * 开飞行模式的瞬间，正好有一个 fetch 在途。Fetch API 没有默认超时，
 * 这个 promise **永远不会 settle** —— 于是 `inFlight` 永久挂着，
 * 之后每次 sync() 都直接返回这个卡死的 promise，**再也不发起新请求**。
 * 定时器照常跑，Caddy 却再也收不到任何东西，而 UI 停在死锁前的最后一次上报。
 *
 * 两道防线：① fetch 加 AbortController 硬超时 ② 这个看门狗兜底。
 */
const STUCK_MS = 30_000

/** 同一时刻只允许一个同步在跑，否则同一批 op 会被发两遍。 */
let inFlight: Promise<SyncResult | null> | null = null
let inFlightAt = 0

/**
 * 写入路径：**先写本地，再排队**。
 *
 * 两张表在同一个 Dexie 事务里写 —— 要么本地镜像和 outbox 都有，
 * 要么都没有。否则会出现"UI 显示了但永远不会被同步"的幽灵记录。
 */
export async function enqueue(
  entity: string,
  payload: Record<string, unknown>,
  /** 允许调用方自带 op_id —— 账单要用它当自己的身份标识 */
  opId?: string,
): Promise<string> {
  const op_id = opId ?? uuid()
  const client_ts = new Date().toISOString()

  await db.transaction('rw', db.outbox, db.events, db.meta, async () => {
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
    if (entity === 'ping_event') {
      await db.events.add({
        op_id,
        label: String(payload.label ?? ''),
        created_at: client_ts,
        synced: 0,
        remote: 0,
      })
    }
  })

  // 尽快发出去：outbox 停留时间越短，设备损坏时丢的越少
  void sync()
  return op_id
}

export async function sync(): Promise<SyncResult | null> {
  // 只在"确实还在跑"时复用。超过看门狗时限就认定它卡死了，
  // 丢弃并重新发起 —— 重复发送是安全的，op_id 保证幂等。
  if (inFlight && Date.now() - inFlightAt < STUCK_MS) return inFlight

  if (inFlight) console.warn('[sync] 上一次同步疑似卡死，丢弃并重试')

  inFlightAt = Date.now()
  const p = doSync().finally(() => {
    // 只有当自己仍是当前那一个时才清空，避免被后来者覆盖后误清
    if (inFlight === p) inFlight = null
  })
  inFlight = p
  return p
}

/**
 * 取待发送的操作。
 *
 * ⚠️ **绝对不要用 `db.outbox.orderBy('client_seq')`。**
 * 那是索引查询，而 IndexedDB 会把索引键无效（NaN / undefined / null）
 * 的记录**静默排除**在结果之外 —— 但 `count()` 照数不误。
 * 结果就是：UI 显示"待同步 4"，请求体却是 `ops: []`，
 * 这 4 条永久卡死且不报任何错。真机上就是这么丢的。
 *
 * 改成全量取出后在 JS 里排序：**不依赖索引，任何记录都跑不掉。**
 */
async function takePending(): Promise<OutboxOp[]> {
  const all = await db.outbox.toArray()

  // 顺手修复历史坏数据：把无效的 client_seq 补成一个合法值，
  // 否则它们即便这次发出去了，下次仍然是隐形的
  const broken = all.filter((o) => !Number.isFinite(o.client_seq))
  if (broken.length) {
    console.warn(`[sync] 修复 ${broken.length} 条 client_seq 无效的记录`)
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

async function doSync(): Promise<SyncResult | null> {
  const ops = await takePending()
  const since = await getMeta<number>('cursor', 0)
  const cid = await clientId()

  // outbox 空也要发一次：这是拉取其它设备变更的唯一时机
  const body = JSON.stringify({ client_id: cid, since_cursor: since, ops })

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
    // 超时中止的请求**可能其实已经送达并处理了**，只是响应没回来。
    // 不要紧 —— 下次重放会得到 duplicate，这正是 op_id 幂等的价值。
    const aborted = (e as Error)?.name === 'AbortError'
    const f: SyncFailure = {
      kind: 'offline',
      message: aborted ? '请求超时，已排队重试' : '离线，已排队',
    }
    throw f
  } finally {
    window.clearTimeout(timer)
  }

  if (res.status === 401) {
    // authFetch 已经试过续期了，还是 401 说明会话真的没了。
    // **绝不清空 outbox** —— 未同步的记录属于店里，
    // 重新登录后照样要发出去。
    const f: SyncFailure = { kind: 'auth', message: '会话已失效，请重新登录' }
    throw f
  }

  if (!res.ok) {
    // 不清 outbox —— 下次重试。重复发送是安全的，因为 op_id 幂等。
    //
    // ⚠️ 反代能通但上游挂了会返回 502/503/504 —— fetch **成功**，
    //    所以不会走上面那个 catch。但对员工来说这跟断网没有区别：
    //    数据安全排队、等会儿自动重发，不需要任何人做任何事。
    //    显示成红色"出错"会让他们以为坏了，然后重复录单。
    //    408/429 同理（超时 / 限流），都是过一会儿就好的。
    const transient = [408, 425, 429, 500, 502, 503, 504].includes(res.status)
    const f: SyncFailure = transient
      ? { kind: 'offline', message: `服务端暂时不可用 (${res.status})，已排队` }
      : { kind: 'error', message: `服务端 HTTP ${res.status}` }
    throw f
  }

  const data = await res.json()

  // applied 和 duplicate 都算"服务端已经有了"，都可以从 outbox 删。
  // duplicate 不是错误，它恰恰是重放机制正常工作的证据。
  const settled: string[] = [...data.applied, ...data.duplicate]

  // 被服务端明确拒绝的：**不能留在 outbox 里无限重试**。
  // 否则 outbox 永远清不空，"待同步"永远不归零，而且每轮都白发一次。
  // 移进死信队列，交给人处理。
  const rejected = (data.rejected ?? []) as { op_id: string; reason: string }[]
  let remoteChanges: RemoteChange[] = []

  await db.transaction(
    'rw',
    db.outbox,
    db.events,
    db.meta,
    db.deadletter,
    db.checks,
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
        // 账单的 check_uuid 就是创建它那条 op 的 op_id
        await Promise.all(settled.map((id) => db.checks.update(id, { synced: 1 })))
      }

      // 其它设备的变更
      remoteChanges = data.changes as RemoteChange[]

      // 游标最后才推进：中途崩了就重来一次，宁可重复也不能跳过
      await setMeta('cursor', data.cursor)
    },
  )

  // 账单类变更在事务外应用 —— applyCheckOp 要读 catalog（也在 meta 表里），
  // 放进同一个事务会因为表作用域重叠而死锁
  for (const c of remoteChanges) {
    if (c.entity === 'ping_event') {
      await db.events.put({
        op_id: c.op_id,
        label: String(c.payload.label ?? ''),
        // 用源设备的 client_ts，不是"收到的时刻" ——
        // 否则离线积压的记录会全被排到列表最前面，时间线是错的
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

/** outbox 有积压时的重试间隔 —— 要快，员工在等它清零 */
const POLL_PENDING = 4_000
/** 空闲时的心跳 —— 只为拉别的设备的变更，可以慢 */
const POLL_IDLE = 20_000

/**
 * 触发时机。
 *
 * ⚠️ iOS 不支持 Background Sync —— 后台绝不会自己重放。
 * 所以必须在**回到前台**时立刻同步，这是 iPad 上最关键的一个钩子。
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
  // ⚠️ iOS 不支持 Background Sync —— 回到前台是最关键的一个钩子
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
