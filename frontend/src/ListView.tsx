import { useCallback, useEffect, useState } from 'react'
import { canManage, type Role } from './auth'
import { loadCatalog, money, type PriceRow } from './catalog'
import { allChecks, pendingCheckUuids, totalsOf } from './checks'
import CheckDetail, { operatorText, PAY_LABEL, STATUS_LABEL } from './CheckDetail'
import type { LocalCheck } from './db'

type Filter = 'all' | 'open' | 'closed' | 'voided'

const FILTERS: { k: Filter; label: string }[] = [
  { k: 'all', label: '全部' },
  { k: 'open', label: '未结' },
  { k: 'closed', label: '已结' },
  { k: 'voided', label: '已作废' },
]

export default function ListView({ role }: { role: Role }) {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('dinner')
  const [now, setNow] = useState(new Date())
  const [pick, setPick] = useState<LocalCheck | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [pending, setPending] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    const all = await allChecks()
    setRows(all)
    setPending(await pendingCheckUuids())
    // 详情开着时底下可能被别的设备改了 —— 跟着刷新，
    // 否则会拿着过期的金额去结账
    setPick((p) => (p ? (all.find((r) => r.check_uuid === p.check_uuid) ?? null) : null))
  }, [])

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
  const shown = rows.filter((r) => (filter === 'all' ? true : r.status === filter))
  const openChecks = rows.filter((r) => r.status === 'open')

  return (
    <>
      <div className="list-head">
        <div className="clock">
          <span className="time">
            {now.toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
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

      <div className="tabs sub">
        {FILTERS.map((f) => (
          <button
            key={f.k}
            className={filter === f.k ? 'on' : ''}
            onClick={() => setFilter(f.k)}
          >
            {f.label}
            <span className="cnt">
              {f.k === 'all' ? rows.length : rows.filter((r) => r.status === f.k).length}
            </span>
          </button>
        ))}
      </div>

      <p className="hint">
        金额为本地估算（按缓存价），权威数字以月报为准。
        {!manage && ' · 你的账号无改单、作废权限'}
      </p>

      {shown.length === 0 && <p className="hint">没有符合条件的账单。</p>}

      <div className="cards">
        {shown.map((c) => {
          const guests = c.adult + c.child + c.senior
          const drinks = c.drink_adult + c.drink_child
          return (
            <button
              key={c.check_uuid}
              className={`card ${c.status}`}
              onClick={() => setPick(c)}
            >
              <div className="c-top">
                <span className="c-table">{c.table_label}</span>
                <span
                  className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}
                >
                  {STATUS_LABEL[c.status]}
                </span>
                {pending.has(c.check_uuid) && (
                  <span className="tag warn">未上传</span>
                )}
                <span className="grow" />
                <span className="c-time">
                  {new Date(c.opened_at).toLocaleTimeString('zh-CN', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              <div className="c-money">
                {money(c.est_cents)}
                {c.service_cents > 0 && (
                  <span className="c-svc">含服务费 {money(c.service_cents)}</span>
                )}
              </div>

              <div className="c-line">
                {guests > 0 && <span className="chip">{guestText(c)}</span>}
                {drinks > 0 && <span className="chip">{drinkText(c)}</span>}
              </div>

              <div className="c-foot">
                <span>{c.pay_method ? PAY_LABEL[c.pay_method] : '未记支付'}</span>
                <span className="grow" />
                <span>{operatorText(c)}</span>
              </div>

              {c.void_reason && <div className="c-note">{c.void_reason}</div>}
              {c.merged_into && <div className="c-note">已并入其它单</div>}
            </button>
          )
        })}
      </div>

      {pick && (
        <CheckDetail
          check={pick}
          role={role}
          prices={prices}
          period={period}
          openChecks={openChecks}
          pending={pending.has(pick.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}

/**
 * 「3人（成2童1）」而不是「3人 · 成2 · 童1」——
 * 后者容易被读成三个并列的数字，加起来变成 6 个人。
 * 只有一种客型时不显示括号，省得每张卡都写「2人（成2）」这种废话。
 */
function guestText(c: LocalCheck): string {
  const total = c.adult + c.child + c.senior
  const parts: string[] = []
  if (c.adult) parts.push(`成${c.adult}`)
  if (c.child) parts.push(`童${c.child}`)
  if (c.senior) parts.push(`长${c.senior}`)
  return parts.length > 1 ? `${total}人（${parts.join('')}）` : `${total}人`
}

function drinkText(c: LocalCheck): string {
  const total = c.drink_adult + c.drink_child
  return c.drink_adult && c.drink_child
    ? `饮${total}（成${c.drink_adult}童${c.drink_child}）`
    : `饮${total}`
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
