import { useCallback, useEffect, useState } from 'react'
import type { Role } from './auth'
import { loadCatalog, money, refreshCatalog, type Catalog, type Drinks } from './catalog'
import {
  openChecksByTable,
  openTable,
  pendingCheckUuids,
  type Guests,
} from './checks'
import CheckDetail from './CheckDetail'
import type { LocalCheck } from './db'
import OpenSheet from './OpenSheet'

export default function FloorPlan({ role }: { role: Role }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [open, setOpen] = useState<Map<string, LocalCheck>>(new Map())
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<LocalCheck | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    const m = await openChecksByTable()
    setOpen(m)
    setPending(await pendingCheckUuids())
    // 详情页开着的时候，底下的数据可能被别的设备改了 —— 跟着刷新，
    // 否则会拿着过期的金额去结账
    setDetailFor((d) => (d ? (m.get(d.table_label) ?? null) : null))
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
                    onClick={() => (chk ? setDetailFor(chk) : setSheetFor(t.label))}
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
          onCancel={() => setSheetFor(null)}
          onConfirm={async (label: string, guests: Guests, drinks: Drinks) => {
            await openTable(label, guests, drinks)
            setSheetFor(null)
            await reload()
          }}
        />
      )}

      {detailFor && (
        <CheckDetail
          check={detailFor}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={openList}
          pending={pending.has(detailFor.check_uuid)}
          onClose={() => setDetailFor(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}
