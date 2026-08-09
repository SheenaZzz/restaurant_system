import { useEffect, useState } from 'react'
import {
  loadCatalog,
  money,
  partySize,
  serviceCents,
  LARGE_PARTY_MIN,
  type TableInfo,
} from './catalog'
import type { LocalCheck } from './db'

/**
 * 换桌 / 并桌。
 *
 * 两件事放一个弹层里，因为现场是同一个动作的两种结果：
 * 客人挪位子 → 换桌；几桌拼一起 → 并桌。分成两个入口反而要想"我该点哪个"。
 */
export default function TransferSheet({
  check,
  others,
  onCancel,
  onTransfer,
  onMerge,
}: {
  check: LocalCheck
  others: LocalCheck[]
  onCancel: () => void
  onTransfer: (toLabel: string) => void | Promise<void>
  onMerge: (sourceUuids: string[]) => void | Promise<void>
}) {
  const [tab, setTab] = useState<'move' | 'merge'>('move')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadCatalog().then((c) => c && setTables(c.tables))
  }, [])

  const occupied = new Set(others.map((o) => o.table_label))

  // 并桌后的人数与服务费预览 —— 这是并桌最容易被忽略的后果，
  // 必须在**点确认之前**就让人看见
  const merged = [...picked]
    .map((u) => others.find((o) => o.check_uuid === u))
    .filter(Boolean) as LocalCheck[]
  const g = merged.reduce(
    (a, m) => ({
      adult: a.adult + m.adult,
      child: a.child + m.child,
      senior: a.senior + m.senior,
    }),
    { adult: check.adult, child: check.child, senior: check.senior },
  )
  const d = merged.reduce(
    (a, m) => ({ adult: a.adult + m.drink_adult, child: a.child + m.drink_child }),
    { adult: check.drink_adult, child: check.drink_child },
  )
  const size = partySize(g, d)
  const subtotal =
    check.est_cents -
    check.service_cents +
    merged.reduce((a, m) => a + m.est_cents - m.service_cents, 0)
  const svc = serviceCents(subtotal, size)
  const willCharge = svc > 0 && check.service_cents === 0

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{check.table_label}</h2>

        <div className="tabs">
          <button className={tab === 'move' ? 'on' : ''} onClick={() => setTab('move')}>
            换桌
          </button>
          <button className={tab === 'merge' ? 'on' : ''} onClick={() => setTab('merge')}>
            并桌
          </button>
        </div>

        {tab === 'move' ? (
          <>
            <p className="hint">选一张空桌，整张单挪过去。已占用的桌不能选。</p>
            <div className="grid tight">
              {tables.map((t) => {
                const busyT = occupied.has(t.label)
                const self = t.label === check.table_label
                return (
                  <button
                    key={t.label}
                    className={`table ${busyT || self ? 'free' : ''}`}
                    disabled={busyT || self || busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await onTransfer(t.label)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    <span className="tlabel">{t.label}</span>
                    <span className="tseats">
                      {self ? '当前' : busyT ? '占用中' : `${t.seats} 座`}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              选要并进 <b>{check.table_label}</b> 的单。明细会搬到这张单上，
              原来的单标记为「已并入」，不再单独计入营业额。
            </p>

            {others.length === 0 && <p className="hint">没有其它未结账单。</p>}

            <ul className="pick">
              {others.map((o) => (
                <li key={o.check_uuid}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(o.check_uuid)}
                      onChange={(e) => {
                        const n = new Set(picked)
                        if (e.target.checked) n.add(o.check_uuid)
                        else n.delete(o.check_uuid)
                        setPicked(n)
                      }}
                    />
                    <span className="tb">{o.table_label}</span>
                    <span className="dim">
                      {o.adult + o.child + o.senior} 人 · {money(o.est_cents)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {picked.size > 0 && (
              <div className="preview">
                <div>
                  合并后 <b>{size}</b> 人 · 小计 {money(subtotal)}
                </div>
                {svc > 0 && (
                  <div className={willCharge ? 'warnText' : ''}>
                    {willCharge && '⚠️ '}
                    满 {LARGE_PARTY_MIN} 人，加收 10% 服务费 {money(svc)}
                  </div>
                )}
                <div className="total small">合计 {money(subtotal + svc)}</div>
              </div>
            )}

            <div className="sheet-actions">
              <button onClick={onCancel}>取消</button>
              <button
                className="primary"
                disabled={busy || picked.size === 0}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onMerge([...picked])
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? '…' : `并入 ${picked.size} 单`}
              </button>
            </div>
          </>
        )}

        {tab === 'move' && (
          <div className="sheet-actions">
            <button onClick={onCancel}>取消</button>
          </div>
        )}
      </div>
    </div>
  )
}
