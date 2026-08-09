import { useCallback, useEffect, useState } from 'react'
import { canManage, type Role } from './auth'
import { loadCatalog, money, refreshCatalog, type Catalog, type Drinks } from './catalog'
import {
  closeWithPayment,
  mergeTables,
  modifyTable,
  openChecksByTable,
  openTable,
  transferTable,
  voidTable,
  type Guests,
  type Payment,
} from './checks'
import type { LocalCheck } from './db'
import EditSheet from './EditSheet'
import OpenSheet from './OpenSheet'
import PaymentSheet from './PaymentSheet'
import TransferSheet from './TransferSheet'

export default function FloorPlan({ role }: { role: Role }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [open, setOpen] = useState<Map<string, LocalCheck>>(new Map())
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<LocalCheck | null>(null)

  // 三个从详情页发起的动作
  const [moving, setMoving] = useState<LocalCheck | null>(null)
  const [paying, setPaying] = useState<LocalCheck | null>(null)
  const [editing, setEditing] = useState<LocalCheck | null>(null)
  const [voiding, setVoiding] = useState<LocalCheck | null>(null)
  const [reason, setReason] = useState('')

  const manage = canManage(role)

  const reload = useCallback(async () => {
    const m = await openChecksByTable()
    setOpen(m)
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
                    className={`table ${chk ? (chk.synced ? 'busy' : 'busy pending') : 'free'}`}
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

      {/* --- 桌位详情：楼面上直接能做的动作 --- */}
      {detailFor && !moving && !paying && !editing && !voiding && (
        <div className="sheet-back" onClick={() => setDetailFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{detailFor.table_label}</h2>
            <p className="muted">
              成人 {detailFor.adult} · 儿童 {detailFor.child} · 长者 {detailFor.senior}
              {detailFor.drink_adult > 0 && ` · 成人饮料 ${detailFor.drink_adult}`}
              {detailFor.drink_child > 0 && ` · 儿童饮料 ${detailFor.drink_child}`}
            </p>
            <p className="total">{money(detailFor.est_cents)}</p>
            {detailFor.service_cents > 0 && (
              <p className="hint">含大桌服务费 {money(detailFor.service_cents)}（10%）</p>
            )}

            <div className="actiongrid">
              <button onClick={() => setMoving(detailFor)}>换桌 / 并桌</button>
              {manage && <button onClick={() => setEditing(detailFor)}>改单</button>}
              {manage && (
                <button
                  className="danger"
                  onClick={() => {
                    setReason('')
                    setVoiding(detailFor)
                  }}
                >
                  作废
                </button>
              )}
            </div>

            <div className="sheet-actions">
              <button onClick={() => setDetailFor(null)}>返回</button>
              <button className="primary" onClick={() => setPaying(detailFor)}>
                结账
              </button>
            </div>
          </div>
        </div>
      )}

      {moving && (
        <TransferSheet
          check={moving}
          others={openList.filter((o) => o.check_uuid !== moving.check_uuid)}
          onCancel={() => setMoving(null)}
          onTransfer={async (label) => {
            await transferTable(moving.check_uuid, label)
            setMoving(null)
            setDetailFor(null)
            await reload()
          }}
          onMerge={async (uuids) => {
            await mergeTables(moving.check_uuid, uuids)
            setMoving(null)
            setDetailFor(null)
            await reload()
          }}
        />
      )}

      {paying && (
        <PaymentSheet
          check={paying}
          title="结账"
          onCancel={() => setPaying(null)}
          onConfirm={async (p: Payment) => {
            await closeWithPayment(paying.check_uuid, p)
            setPaying(null)
            setDetailFor(null)
            await reload()
          }}
        />
      )}

      {editing && (
        <EditSheet
          check={editing}
          prices={cat.prices}
          period={cat.current_period_kind}
          onCancel={() => setEditing(null)}
          onConfirm={async (guests: Guests, drinks: Drinks) => {
            await modifyTable(editing.check_uuid, guests, drinks)
            setEditing(null)
            await reload()
          }}
        />
      )}

      {voiding && (
        <div className="sheet-back" onClick={() => setVoiding(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>作废 {voiding.table_label}</h2>
            <p className="total">{money(voiding.est_cents)}</p>
            <p className="hint">
              作废会把这单从营业额里剔除，必须填写原因，会记录操作人。
              作废后可以在清单页随时「恢复」。
            </p>
            <label className="reason">
              原因
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：客人取消 / 录错桌号"
                autoFocus
              />
            </label>
            <div className="sheet-actions">
              <button onClick={() => setVoiding(null)}>取消</button>
              <button
                className="primary danger"
                disabled={!reason.trim()}
                onClick={async () => {
                  await voidTable(voiding.check_uuid, reason.trim())
                  setVoiding(null)
                  setDetailFor(null)
                  await reload()
                }}
              >
                确认作废
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
