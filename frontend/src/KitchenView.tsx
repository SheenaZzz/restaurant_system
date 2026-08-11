import { useCallback, useEffect, useState } from 'react'
import { lineName, modLabel, tr } from './i18n'
import { loadCatalog, type Catalog } from './catalog'
import db, { getMeta, setMeta, type LocalCheck, type LocalLine } from './db'

/**
 * 后厨订单队列。前台点的单品**自动出现在这里**。
 *
 * 数据没有走任何新接口：每台设备的本地镜像里本来就有所有账单和菜品明细
 * （同步下发的），后厨缺的只是一页界面。所以这一页**离线照样有单** ——
 * 断网时前台照录、后厨照做，恢复后各自补齐。
 *
 * ⚠️ 「做好了」是**这台设备上的显示状态，不是账单的事实**，存本地不进同步。
 *    理由：真要做成共享状态，就得给每一行菜一个客户端生成的 id
 *    （现在本地明细是从 op 的 payload 重建的，没有服务端行号），
 *    那是一整条改动，而 DESIGN.md 自己写着这一页要先看两周真实使用量
 *    ——「2 个厨师的小厨房里，服务员走五步喊一声可能更快」。
 *    先用最小的东西把它送上去，用起来了再谈共享状态。
 */

const DONE_KEY = 'kitchen_done'

interface Ticket {
  uuid: string
  table: string
  at: string
  lines: LocalLine[]
}

/** 一张单里还没做的菜。作废的不算。 */
function pending(c: LocalCheck, done: Set<string>): LocalLine[] {
  return (c.lines ?? []).filter(
    (l, i) => !l.voided && !done.has(`${c.check_uuid}#${i}`),
  )
}

/** 这张单上有没有要后厨做的东西（纯自助的桌子不进队列）。 */
function hasFood(c: LocalCheck): boolean {
  return (c.lines ?? []).some((l) => !l.voided)
}

export default function KitchenView() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const [cat, setCat] = useState<Catalog | null>(null)
  const [, tick] = useState(0)

  const refresh = useCallback(async () => {
    const marks = new Set(await getMeta<string[]>(DONE_KEY, []))
    const rows = await db.checks.toArray()
    // 做完的单**不消失**，变绿留在下面 —— 厨师要能看见自己刚做完什么，
    // 也才有机会撤销误点。真正让它离开屏幕的是前台关单：
    // 客人结账走人，这张单对后厨就结束了，这个界限比任何超时规则都准。
    const open = rows
      .filter((c) => c.status === 'open' && hasFood(c))
      .sort((a, b) => {
        const da = pending(a, marks).length === 0
        const db_ = pending(b, marks).length === 0
        // 没做完的排前面；同类按下单先后
        if (da !== db_) return da ? 1 : -1
        return a.opened_at.localeCompare(b.opened_at)
      })
    setDone(marks)
    setTickets(
      open.map((c) => ({
        uuid: c.check_uuid,
        table: c.table_label,
        at: c.opened_at,
        lines: c.lines ?? [],
      })),
    )
  }, [])

  useEffect(() => {
    void loadCatalog().then(setCat)
    void refresh()
    // 5 秒一刷：同步心跳最长 20 秒，加上这个轮询，
    // 前台点完菜到后厨看见最长 25 秒。厨房不需要更快，也不该更快 ——
    // 每秒重渲染会让正在看的人失去位置感。
    const t = window.setInterval(() => {
      tick((n) => n + 1)
      void refresh()
    }, 5_000)
    return () => window.clearInterval(t)
  }, [refresh])

  /** 标记 / 撤销标记。误点「做好了」在厨房里太容易发生，必须能改回来。 */
  async function mark(uuid: string, idx: number, undo = false) {
    const next = new Set(done)
    const key = `${uuid}#${idx}`
    if (undo) next.delete(key)
    else next.add(key)
    setDone(next)
    await setMeta(DONE_KEY, [...next])
    await refresh()
  }

  if (tickets === null) return <p className="hint">{tr('载入中…')}</p>

  if (!tickets.length) {
    return <p className="hint big-hint">{tr('现在没有单。')}</p>
  }

  const now = Date.now()

  return (
    <div className="kq">
      {tickets.map((t) => {
        const waited = Math.max(0, Math.round((now - Date.parse(t.at)) / 60_000))
        const live = t.lines.filter((l, i) => !l.voided && !done.has(`${t.uuid}#${i}`))
        const allDone = live.length === 0
        return (
          <section
            key={t.uuid}
            className={`kq-card${allDone ? ' ok' : waited >= 15 ? ' late' : ''}`}
          >
            <div className="kq-head">
              <span className="kq-table">{tr(t.table)}</span>
              {/* 等了多久比几点下的单有用得多 —— 厨房排的是先后，不是钟点 */}
              <span className="kq-wait">{allDone ? tr('已完成') : `${waited}′`}</span>
            </div>
            <ul className="kq-lines">
              {t.lines.map((l, i) => {
                const key = `${t.uuid}#${i}`
                if (l.voided) return null
                const isDone = done.has(key)
                return (
                  <li key={key} className={isDone ? 'done' : ''}>
                    <span className="kl-qty">{isDone ? '✓' : l.qty}</span>
                    <span className="kl-name">
                      {lineName(l, cat?.menu)}
                      {!!l.modifiers?.length && (
                        <em className="kl-mods">
                          {l.modifiers.map((m) => modLabel(m, cat?.modifiers)).join(' · ')}
                        </em>
                      )}
                      {l.notes && <em className="kl-mods">{l.notes}</em>}
                    </span>
                    <button
                      className={isDone ? 'kl-undo' : 'kl-done'}
                      onClick={() => void mark(t.uuid, i, isDone)}
                    >
                      {tr(isDone ? '撤销' : '做好了')}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
