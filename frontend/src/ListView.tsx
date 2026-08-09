import { useCallback, useEffect, useState } from 'react'
import { canManage, type Role } from './auth'
import { loadCatalog, money, type Drinks, type PriceRow } from './catalog'
import {
  allChecks,
  closeWithPayment,
  mergeTables,
  modifyTable,
  restoreTable,
  totalsOf,
  transferTable,
  updatePayment,
  voidTable,
  type Guests,
  type Payment,
} from './checks'
import type { LocalCheck } from './db'
import EditSheet from './EditSheet'
import PaymentSheet from './PaymentSheet'
import TransferSheet from './TransferSheet'

const STATUS_LABEL: Record<LocalCheck['status'], string> = {
  open: '未结',
  closed: '已结',
  voided: '已作废',
  merged: '已并入',
}

const PAY_LABEL: Record<string, string> = {
  cash: '现金',
  card: '刷卡',
  mixed: '现金+刷卡',
  other: '其它',
}

export default function ListView({ role }: { role: Role }) {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('dinner')
  const [now, setNow] = useState(new Date())
  const [editing, setEditing] = useState<LocalCheck | null>(null)
  const [voiding, setVoiding] = useState<LocalCheck | null>(null)
  const [reason, setReason] = useState('')
  const [paying, setPaying] = useState<LocalCheck | null>(null)
  const [payTitle, setPayTitle] = useState('结账')
  const [moving, setMoving] = useState<LocalCheck | null>(null)

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
          {t.serviceCents > 0 && (
            <Stat label="大桌服务费" value={money(t.serviceCents)} />
          )}
          <Stat
            label="现金 / 刷卡 / 其它"
            value={`${money(t.cashCents)} · ${money(t.cardCents)} · ${money(t.otherCents)}`}
          />
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
            <th>支付</th>
            <th>状态</th>
            <th>操作人</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.check_uuid} className={`row-${c.status}`}>
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
              <td className="num">
                {money(c.est_cents)}
                {c.service_cents > 0 && (
                  <div className="dim small">含服务费 {money(c.service_cents)}</div>
                )}
              </td>
              <td>
                {c.pay_method ? (
                  <>
                    <span className="chip">{PAY_LABEL[c.pay_method]}</span>
                    {c.pay_method === 'mixed' && (
                      <div className="dim small">
                        现 {money(c.pay_cash ?? 0)} / 卡 {money(c.pay_card ?? 0)}
                      </div>
                    )}
                    {c.pay_note && <div className="dim small">{c.pay_note}</div>}
                  </>
                ) : (
                  <span className="dim small">—</span>
                )}
              </td>
              <td>
                <span className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}>
                  {STATUS_LABEL[c.status]}
                </span>
                {!c.synced && <span className="tag warn">待同步</span>}
                {c.void_reason && <div className="dim small">{c.void_reason}</div>}
                {c.merged_into && <div className="dim small">已并入其它单</div>}
              </td>
              <td className="dim small">
                {c.by ?? '—'}
                {c.last_by && c.last_by !== c.by && <div>最近：{c.last_by}</div>}
              </td>
              <td className="ops">
                {c.status === 'merged' ? null : c.status === 'voided' ? (
                  manage && (
                    <button
                      className="restore"
                      onClick={async () => {
                        await restoreTable(c.check_uuid)
                        await reload()
                      }}
                    >
                      恢复
                    </button>
                  )
                ) : (
                  <>
                    {c.status === 'open' && (
                      <>
                        <button
                          className="primaryish"
                          onClick={() => {
                            setPayTitle('结账')
                            setPaying(c)
                          }}
                        >
                          结账
                        </button>
                        <button onClick={() => setMoving(c)}>换/并桌</button>
                      </>
                    )}
                    {c.status === 'closed' && (
                      <button
                        onClick={() => {
                          setPayTitle('改支付方式')
                          setPaying(c)
                        }}
                      >
                        改支付
                      </button>
                    )}
                    {/* 已结账的单也能改和作废 —— 结完账才发现录错是常事 */}
                    {manage && (
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
                  </>
                )}
              </td>
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

      {paying && (
        <PaymentSheet
          check={paying}
          title={payTitle}
          onCancel={() => setPaying(null)}
          onConfirm={async (p: Payment) => {
            if (paying.status === 'open') await closeWithPayment(paying.check_uuid, p)
            else await updatePayment(paying.check_uuid, p)
            setPaying(null)
            await reload()
          }}
        />
      )}

      {moving && (
        <TransferSheet
          check={moving}
          others={rows.filter(
            (r) => r.status === 'open' && r.check_uuid !== moving.check_uuid,
          )}
          onCancel={() => setMoving(null)}
          onTransfer={async (label) => {
            await transferTable(moving.check_uuid, label)
            setMoving(null)
            await reload()
          }}
          onMerge={async (uuids) => {
            await mergeTables(moving.check_uuid, uuids)
            setMoving(null)
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
              作废会把这单从营业额里剔除。**必须填写原因**，会记录操作人并进
              老板的报表。作废后可以随时「恢复」——
              {voiding.status === 'closed' && ' 恢复后仍是已结账状态，结账时间不变。'}
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
