import { useCallback, useEffect, useState } from 'react'
import type { Role } from './auth'
import {
  businessDateLabel,
  currentBusinessDate,
  cutoffHourOf,
} from './businessDay'
import { loadCatalog, money, refreshCatalog, type Catalog } from './catalog'
import {
  carriedOverByTable,
  checkBusinessDate,
  openChecksByTable,
  openTable,
  pendingCheckUuids,
} from './checks'
import CheckDetail from './CheckDetail'
import type { LocalCheck } from './db'
import OpenSheet from './OpenSheet'

export default function FloorPlan({ role }: { role: Role }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [open, setOpen] = useState<Map<string, LocalCheck>>(new Map())
  const [carried, setCarried] = useState<Map<string, LocalCheck>>(new Map())
  const [bdate, setBdate] = useState('')
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<LocalCheck | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [blocked, setBlocked] = useState<LocalCheck | null>(null)

  const reload = useCallback(async () => {
    // 营业日每次都重算，不缓存在闭包里 —— 这台 iPad 很可能整夜
    // 停在楼面这一屏没重新加载过，过了零点必须自己翻篇
    const c = await loadCatalog()
    const cutoff = cutoffHourOf(c)
    const today = currentBusinessDate(cutoff)
    setBdate(today)
    const m = await openChecksByTable(today, cutoff)
    const stale = await carriedOverByTable(today, cutoff)
    setOpen(m)
    setCarried(stale)
    setPending(await pendingCheckUuids())
    // 详情页开着的时候，底下的数据可能被别的设备改了 —— 跟着刷新，
    // 否则会拿着过期的金额去结账。
    // ⚠️ 两个 map 都要找：从「去处理这张单」进来的是跨天的那张，
    //    只查 m 的话下一次轮询就会把详情页自己关掉。
    setDetailFor((d) =>
      d ? (m.get(d.table_label) ?? stale.get(d.table_label) ?? null) : null,
    )
  }, [])

  useEffect(() => {
    // 先用缓存立刻渲染，再后台刷新 ——
    // 离线冷启动时也要能看到 20 张桌，不能白屏等网络
    loadCatalog().then(setCat)
    refreshCatalog().then((c) => c && setCat(c))
    void reload()
    const t = window.setInterval(reload, 2000)
    return () => window.clearInterval(t)
  }, [reload])

  if (!cat) {
    return <p className="hint">首次使用需要联网加载一次桌位和菜单…</p>
  }

  const zones = [...new Set(cat.tables.map((t) => t.zone ?? '—'))]
  const openList = [...open.values()]

  return (
    <>
      <div className="floor-head">
        <span className="period">
          {cat.current_period_kind === 'lunch' ? '午市' : '晚市'}
        </span>
        {/* 营业日必须显示出来。旁边这些数字是"这一天"的，
            不写清是哪一天，跨零点之后员工没法判断该不该信 */}
        {bdate && <span className="bday">{businessDateLabel(bdate)}</span>}
        <span className="muted">
          在座 {openList.reduce((s, c) => s + c.adult + c.child + c.senior, 0)} 人 · 开台{' '}
          {open.size}/{cat.tables.length}
        </span>
      </div>

      {zones.map((z) => (
        <section key={z}>
          <h3 className="zone">{z === 'main' ? '主厅' : z === 'large' ? '大桌' : z}</h3>
          <div className="grid">
            {cat.tables
              .filter((t) => (t.zone ?? '—') === z)
              .map((t) => {
                const chk = open.get(t.label)
                return (
                  <button
                    key={t.label}
                    className={`table ${
                      chk
                        ? pending.has(chk.check_uuid)
                          ? 'busy pending'
                          : 'busy'
                        : 'free'
                    }`}
                    onClick={() => {
                      if (chk) return setDetailFor(chk)
                      // 这张桌昨天那单还没结 —— 服务端的唯一偏索引会拒掉
                      // 今天的新单，掉进死信队列。与其让员工点了"没反应"，
                      // 不如当场说清楚该做什么。
                      const stale = carried.get(t.label)
                      if (stale) return setBlocked(stale)
                      setSheetFor(t.label)
                    }}
                  >
                    <span className="tlabel">{t.label}</span>
                    {chk ? (
                      <>
                        <span className="tguests">
                          {chk.adult + chk.child + chk.senior} 人
                          {chk.drink_adult + chk.drink_child > 0 &&
                            ` · ${chk.drink_adult + chk.drink_child} 饮`}
                        </span>
                        <span className="tmoney">
                          {money(chk.est_cents)}
                          {chk.service_cents > 0 && <span className="svc"> +服务费</span>}
                        </span>
                      </>
                    ) : (
                      <span className="tseats">{t.seats} 座</span>
                    )}
                  </button>
                )
              })}
          </div>
        </section>
      ))}

      {sheetFor && (
        <OpenSheet
          tableLabel={sheetFor}
          prices={cat.prices}
          period={cat.current_period_kind}
          taxRate={cat.tax_rate}
          menu={cat.menu}
          categories={cat.categories}
          onCancel={() => setSheetFor(null)}
          onConfirm={async (label, guests, drinks, lines) => {
            await openTable(label, guests, drinks, lines)
            setSheetFor(null)
            await reload()
          }}
        />
      )}

      {blocked && (
        <div className="sheet-back" onClick={() => setBlocked(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{blocked.table_label} 还有一张没结的单</h2>
            <p className="hint">
              这张单开在 <b>{businessDateLabel(checkBusinessDate(blocked, cutoffHourOf(cat)))}</b>
              ，金额 <b>{money(blocked.est_cents)}</b>，到现在还没结账。
            </p>
            <p className="hint">
              一张桌同时只能有一张未结账单，所以现在开不了新单。
              先把它结掉或作废，这张桌就空出来了。
            </p>
            <div className="sheet-actions">
              <button onClick={() => setBlocked(null)}>取消</button>
              <button
                className="primary"
                onClick={() => {
                  setDetailFor(blocked)
                  setBlocked(null)
                }}
              >
                去处理这张单
              </button>
            </div>
          </div>
        </div>
      )}

      {detailFor && (
        <CheckDetail
          check={detailFor}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={openList}
          menu={cat.menu}
          categories={cat.categories}
          pending={pending.has(detailFor.check_uuid)}
          onClose={() => setDetailFor(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}
