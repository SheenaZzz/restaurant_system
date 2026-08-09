import { useCallback, useEffect, useState } from 'react'
import { canManage, type Role } from './auth'
import { loadCatalog, money, type Drinks, type PriceRow } from './catalog'
import {
  allChecks,
  modifyTable,
  totalsOf,
  voidTable,
  type Guests,
} from './checks'
import type { LocalCheck } from './db'
import EditSheet from './EditSheet'

const STATUS_LABEL = { open: '未结', closed: '已结', voided: '已作废' } as const

export default function ListView({ role }: { role: Role }) {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('dinner')
  const [now, setNow] = useState(new Date())
  const [editing, setEditing] = useState<LocalCheck | null>(null)
  const [voiding, setVoiding] = useState<LocalCheck | null>(null)
  const [reason, setReason] = useState('')

  const reload = useCallback(async () => setRows(await allChecks()), [])

  useEffect(() => {
    void reload()
    loadCatalog().then((c) => {
      if (c) {
        setPrices(c.prices)
        setPeriod(c.current_period_kind)
      }
    })
    // 时钟走 iPad 本地时间 —— 员工核对时看的是墙上的钟，不是服务器时间
    const clock = window.setInterval(() => setNow(new Date()), 1000)
    const poll = window.setInterval(reload, 2000)
    return () => {
      window.clearInterval(clock)
      window.clearInterval(poll)
    }
  }, [reload])

  const t = totalsOf(rows)
  const manage = canManage(role)

  return (
    <>
      <div className="list-head">
        <div className="clock">
          <span className="time">{now.toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <span className="date">
            {now.toLocaleDateString('zh-CN', {
              month: 'long',
              day: 'numeric',
              weekday: 'short',
            })}
          </span>
        </div>

        <div className="stats">
          <Stat label="营业额" value={money(t.revenueCents)} big />
          <Stat label="Buffet 人数" value={String(t.buffetGuests)} />
          <Stat label="饮料份数" value={String(t.drinkCount)} />
          <Stat label="未结 / 已结" value={`${t.openCount} / ${t.closedCount}`} />
          {t.voidedCount > 0 && (
            <Stat
              label="已作废"
              value={`${t.voidedCount} 单 · ${money(t.voidedCents)}`}
              bad
            />
          )}
        </div>
      </div>

      <p className="hint">
        金额为本地估算（按缓存价），权威数字以服务端日结为准。
        {!manage && ' · 你的账号无改单/作废权限'}
      </p>

      {rows.length === 0 && <p className="hint">还没有任何账单。</p>}

      <table className="orders">
        <thead>
          <tr>
            <th>桌</th>
            <th>开台</th>
            <th>人数</th>
            <th>饮料</th>
            <th className="num">金额</th>
            <th>状态</th>
            {manage && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.check_uuid} className={c.status === 'voided' ? 'voided' : ''}>
              <td className="tb">{c.table_label}</td>
              <td className="dim">
                {new Date(c.opened_at).toLocaleTimeString('zh-CN', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </td>
              <td>
                {c.adult > 0 && <span className="chip">成 {c.adult}</span>}
                {c.child > 0 && <span className="chip">童 {c.child}</span>}
                {c.senior > 0 && <span className="chip">长 {c.senior}</span>}
              </td>
              <td>
                {c.drink_adult > 0 && <span className="chip">成 {c.drink_adult}</span>}
                {c.drink_child > 0 && <span className="chip">童 {c.drink_child}</span>}
              </td>
              <td className="num">{money(c.est_cents)}</td>
              <td>
                <span className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}>
                  {STATUS_LABEL[c.status]}
                </span>
                {!c.synced && <span className="tag warn">待同步</span>}
                {c.void_reason && <div className="dim small">{c.void_reason}</div>}
              </td>
              {manage && (
                <td className="ops">
                  {c.status === 'open' && (
                    <>
                      <button onClick={() => setEditing(c)}>改单</button>
                      <button
                        className="danger"
                        onClick={() => {
                          setVoiding(c)
                          setReason('')
                        }}
                      >
                        作废
                      </button>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <EditSheet
          check={editing}
          prices={prices}
          period={period}
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
              作废是唯一能让一整张单的钱消失的操作，**必须填写原因**，
              且会记录操作人并进老板的报表。
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

function Stat({
  label,
  value,
  big,
  bad,
}: {
  label: string
  value: string
  big?: boolean
  bad?: boolean
}) {
  return (
    <div className={`stat${big ? ' big' : ''}${bad ? ' bad' : ''}`}>
      <span className="sv">{value}</span>
      <span className="sl">{label}</span>
    </div>
  )
}
