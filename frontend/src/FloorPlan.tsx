import { useCallback, useEffect, useState } from 'react'
import { loadCatalog, money, refreshCatalog, type Catalog } from './catalog'
import { closeTable, openChecksByTable, openTable, type Guests } from './checks'
import type { LocalCheck } from './db'
import OpenSheet from './OpenSheet'

export default function FloorPlan() {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [open, setOpen] = useState<Map<string, LocalCheck>>(new Map())
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<LocalCheck | null>(null)

  const reload = useCallback(async () => {
    setOpen(await openChecksByTable())
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

  async function confirmOpen(label: string, guests: Guests, drinks: number) {
    await openTable(label, guests, drinks)
    setSheetFor(null)
    await reload()
  }

  const zones = [...new Set(cat.tables.map((t) => t.zone ?? '—'))]

  return (
    <>
      <div className="floor-head">
        <span className="period">{cat.current_period_kind === 'lunch' ? '午市' : '晚市'}</span>
        <span className="muted">
          在座 {[...open.values()].reduce((s, c) => s + c.adult + c.child + c.senior, 0)} 人
          · 开台 {open.size}/{cat.tables.length}
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
                    className={`table ${chk ? (chk.synced ? 'busy' : 'busy pending') : 'free'}`}
                    onClick={() => (chk ? setDetailFor(chk) : setSheetFor(t.label))}
                  >
                    <span className="tlabel">{t.label}</span>
                    {chk ? (
                      <>
                        <span className="tguests">
                          {chk.adult + chk.child + chk.senior} 人
                          {chk.drinks > 0 && ` · ${chk.drinks} 饮`}
                        </span>
                        <span className="tmoney">{money(chk.est_cents)}</span>
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
          onConfirm={confirmOpen}
        />
      )}

      {detailFor && (
        <div className="sheet-back" onClick={() => setDetailFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{detailFor.table_label}</h2>
            <p className="muted">
              成人 {detailFor.adult} · 儿童 {detailFor.child} · 长者 {detailFor.senior}
              {detailFor.drinks > 0 && ` · 饮料 ${detailFor.drinks}`}
            </p>
            <p className="total">{money(detailFor.est_cents)}</p>
            <p className="hint">
              金额为本地估算，以服务端记录为准。本系统**不处理收款**。
            </p>
            <div className="sheet-actions">
              <button onClick={() => setDetailFor(null)}>返回</button>
              <button
                className="primary"
                onClick={async () => {
                  await closeTable(detailFor.check_uuid)
                  setDetailFor(null)
                  await reload()
                }}
              >
                结账关单
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
