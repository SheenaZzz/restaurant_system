import { loadCatalog } from './catalog'
import db, { type LocalTray } from './db'
import { enqueue } from './sync'

/**
 * 补菜记录。
 *
 * 这是全项目唯一一条**采集不可观测量**的路径：buffet 的消耗速度没人读得出来，
 * 只有「t₁ 补满、t₂ 发现空了」这样的区间截尾事件。所以这里的每个决定
 * 都优先服务于"事后能不能建模"，其次才是界面。
 *
 * ⚠️ append-only。误点了就紧接着记一条对的 —— 没有撤销。
 *    相隔几秒的两条事件在建模时是可分辨的，而一张"能改的事实表"
 *    会让整张表失去可信度：事后谁也说不清哪条是当时记的。
 */

export type TrayKind = 'refill' | 'half' | 'empty'

export interface BoardDish {
  id: number
  page: number
  pos: number
  name_zh: string
  name_en: string
}

/** 目录里那块板。离线可用 —— 断网时厨师照样在补菜。 */
export async function loadBoard(): Promise<Record<string, BoardDish[]>> {
  const cat = await loadCatalog()
  return (cat?.buffet_board ?? { lunch: [], dinner: [] }) as Record<string, BoardDish[]>
}

/**
 * 记一次。`minutesAgo` 是回拨的分钟数 —— 厨师往往是**事后**才想起来点的。
 *
 * 服务端按 `client_ts − minutesAgo` 落 observed_at：只有一套时钟，
 * 不会出现"设备时间"和"观察时间"两个来源各自漂移。
 */
export async function recordTray(
  dish_id: number,
  kind: TrayKind,
  minutesAgo = 0,
): Promise<void> {
  // 本地镜像由 enqueue 在**同一个事务**里一起写 —— 见 sync.ts。
  await enqueue('tray_event', {
    dish_id,
    event_type: kind,
    minutes_ago: minutesAgo,
  })
}

/** 服务端下发的别人记的那些。 */
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

/** 每道菜最近一条。补菜页每格都要显示"上次多久以前"。 */
export async function lastByDish(): Promise<Map<number, LocalTray>> {
  const out = new Map<number, LocalTray>()
  await db.trays.each((t) => {
    const cur = out.get(t.dish_id)
    if (!cur || t.at > cur.at) out.set(t.dish_id, t)
  })
  return out
}

/**
 * 只留最近 24 小时。
 *
 * 本地这份纯粹是为了显示"上次多久以前"，超过一天的记录对台前没有任何意义，
 * 而 iPad 上的 IndexedDB 是会被系统在存储紧张时整个清掉的 ——
 * 留着不用的数据只会提高那个风险。历史全在服务端，模型也只从那里读。
 */
export async function pruneTrays(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()
  const doomed = await db.trays.where('at').below(cutoff).primaryKeys()
  if (doomed.length) await db.trays.bulkDelete(doomed)
  return doomed.length
}

/** 「12 分钟前」这种。台前要的是**过了多久**，不是几点几分。 */
export function agoText(iso: string, now = Date.now()): { mins: number; text: string } {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  return { mins, text: String(mins) }
}
