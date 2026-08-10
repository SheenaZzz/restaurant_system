import { useCallback, useEffect, useState } from 'react'
import { authFetch } from './auth'
import { money } from './catalog'
import { getMeta, setMeta } from './db'
import MonthPicker from './MonthPicker'
import NumPad from './NumPad'

export interface DayRow {
  business_date: string
  revenue_cents: number
  service_cents: number
  guests: number
  drinks: number
  check_count: number
  cash_cents: number
  card_cents: number
  other_cents: number
  unpaid_count: number
  mismatch_count: number
  voided_cents: number
  voided_count: number
  tips_total_cents: number
  tips_updated_by: string | null
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

/** 缓存最近一次拉到的月报，离线时至少能看到上次的数字。 */
const cacheKey = (y: number, m: number) => `report_${y}_${m}`

export default function MonthView() {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1) // 1–12
  const [rows, setRows] = useState<DayRow[]>([])
  const [pick, setPick] = useState<DayRow | null>(null)
  const [state, setState] = useState<'loading' | 'live' | 'cached' | 'error'>('loading')
  const [tipCents, setTipCents] = useState(0)
  const [savingTip, setSavingTip] = useState(false)
  const [tipErr, setTipErr] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // 从「跳到某一天」进来时，加载完自动打开那天的明细
  const [pendingDay, setPendingDay] = useState<string | null>(null)

  const load = useCallback(async (y: number, m: number) => {
    setState('loading')
    const from = `${y}-${String(m).padStart(2, '0')}-01`
    const last = new Date(y, m, 0).getDate()
    const to = `${y}-${String(m).padStart(2, '0')}-${last}`
    try {
      const res = await authFetch(`/api/reports/daily?from=${from}&to=${to}`)
      if (!res.ok) throw new Error(String(res.status))
      const data: DayRow[] = await res.json()
      setRows(data)
      await setMeta(cacheKey(y, m), data)
      setState('live')
    } catch {
      // 月报**不是关键路径** —— 拿不到就用上次缓存的，别把页面变成错误页
      const cached = await getMeta<DayRow[] | null>(cacheKey(y, m), null)
      setRows(cached ?? [])
      setState(cached ? 'cached' : 'error')
    }
  }, [])

  useEffect(() => {
    void load(year, month)
  }, [load, year, month])

  // 数据到位后再打开目标日期的明细 —— 直接在选择时打开会拿到上个月的数据
  useEffect(() => {
    if (!pendingDay || state === 'loading') return
    const r = rows.find((x) => x.business_date === pendingDay)
    if (r) {
      setPick(r)
      setTipCents(r.tips_total_cents)
      setTipErr(null)
    }
    setPendingDay(null)
  }, [pendingDay, rows, state])

  function shift(delta: number) {
    const d = new Date(year, month - 1 + delta, 1)
    setYear(d.getFullYear())
    setMonth(d.getMonth() + 1)
    setPick(null)
  }

  const byDate = new Map(rows.map((r) => [r.business_date, r]))
  const daysInMonth = new Date(year, month, 0).getDate()
  // 周一开头：把 JS 的 0=周日 转成 0=周一
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7

  const sum = rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.revenue_cents,
      guests: a.guests + r.guests,
      drinks: a.drinks + r.drinks,
      checks: a.checks + r.check_count,
      service: a.service + r.service_cents,
      voided: a.voided + r.voided_cents,
      tips: a.tips + r.tips_total_cents,
      unpaid: a.unpaid + r.unpaid_count,
      mismatch: a.mismatch + r.mismatch_count,
      cash: a.cash + r.cash_cents,
      card: a.card + r.card_cents,
      other: a.other + r.other_cents,
    }),
    {
      revenue: 0, guests: 0, drinks: 0, checks: 0, service: 0, voided: 0, tips: 0,
      unpaid: 0, mismatch: 0, cash: 0, card: 0, other: 0,
    },
  )

  const busiest = rows.reduce<DayRow | null>(
    (a, r) => (a === null || r.revenue_cents > a.revenue_cents ? r : a),
    null,
  )
  const openDays = rows.filter((r) => r.check_count > 0).length
  const maxRevenue = busiest?.revenue_cents ?? 0

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return (
    <>
      <div className="month-head">
        <button onClick={() => shift(-1)}>‹</button>
        {/* 标题可点 —— 一格格翻着找去年同期太慢了 */}
        <button className="mtitle tappable" onClick={() => setPicking(true)}>
          {year} 年 {month} 月 ▾
        </button>
        <button onClick={() => shift(1)}>›</button>
        {state === 'cached' && <span className="tag warn">离线·上次数据</span>}
        {state === 'loading' && <span className="dim small">载入中…</span>}
        {state === 'error' && <span className="tag bad">需要联网</span>}
      </div>

      <div className="list-head">
        <div className="stats">
          <Stat label="本月营业额" value={money(sum.revenue)} big />
          <Stat label="营业天数" value={String(openDays)} />
          <Stat label="客流" value={String(sum.guests)} />
          <Stat label="饮料份数" value={String(sum.drinks)} />
          <Stat label="单数" value={String(sum.checks)} />
          <Stat
            label="日均"
            value={money(openDays ? Math.round(sum.revenue / openDays) : 0)}
          />
          <Stat
            label="客单价"
            value={money(sum.guests ? Math.round(sum.revenue / sum.guests) : 0)}
          />
          {sum.service > 0 && <Stat label="大桌服务费" value={money(sum.service)} />}
          <Stat
            label={`本月小费${sum.revenue ? `（${((sum.tips / sum.revenue) * 100).toFixed(1)}%）` : ''}`}
            value={money(sum.tips)}
          />
        </div>
      </div>

      <div className="stats payline">
        <Stat label="现金" value={money(sum.cash)} />
        <Stat label="刷卡" value={money(sum.card)} />
        <Stat label="其它" value={money(sum.other)} />
        {sum.voided > 0 && (
          <Stat label="作废" value={money(sum.voided)} bad />
        )}
        {/* 这两个数不为零就是对账会出问题的地方，必须放在显眼位置 */}
        {sum.unpaid > 0 && <Stat label="未记支付方式" value={`${sum.unpaid} 单`} bad />}
        {sum.mismatch > 0 && (
          <Stat label="支付与账单不符" value={`${sum.mismatch} 单`} bad />
        )}
      </div>

      <div className="cal">
        {WEEK.map((w) => (
          <div key={w} className="cal-h">
            {w}
          </div>
        ))}
        {Array.from({ length: firstWeekday }, (_, i) => (
          <div key={`b${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const ds = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const r = byDate.get(ds)
          const ratio = maxRevenue > 0 && r ? r.revenue_cents / maxRevenue : 0
          return (
            <button
              key={ds}
              className={`cal-d${r ? ' has' : ''}${ds === todayStr ? ' today' : ''}${pick?.business_date === ds ? ' on' : ''}`}
              onClick={() => {
                setPick(r ?? null)
                setTipCents(r?.tips_total_cents ?? 0)
                setTipErr(null)
              }}
              disabled={!r}
            >
              <span className="d">{day}</span>
              {r && (
                <>
                  <span className="v">{money(r.revenue_cents)}</span>
                  {r.tips_total_cents > 0 && (
                    <span className="tip">小费 {money(r.tips_total_cents)}</span>
                  )}
                  {/* 用条形长度表示相对高低 —— 一眼看出哪几天忙 */}
                  <span className="bar" style={{ width: `${Math.round(ratio * 100)}%` }} />
                  {(r.unpaid_count > 0 || r.mismatch_count > 0 || r.voided_count > 0) && (
                    <span className="flag" />
                  )}
                </>
              )}
            </button>
          )
        })}
      </div>

      {rows.length === 0 && state !== 'loading' && (
        <p className="hint">这个月还没有营业数据。</p>
      )}

      {picking && (
        <MonthPicker
          year={year}
          month={month}
          onPick={(y, m) => {
            setYear(y)
            setMonth(m)
            setPick(null)
          }}
          onPickDate={(iso) => {
            const [yy, mm] = iso.split('-')
            setYear(Number(yy))
            setMonth(Number(mm))
            setPick(null)
            setPendingDay(iso)
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {pick && (
        <div className="sheet-back" onClick={() => setPick(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{pick.business_date}</h2>
            <p className="total">{money(pick.revenue_cents)}</p>
            <table className="kv">
              <tbody>
                <Row k="单数" v={String(pick.check_count)} />
                <Row k="Buffet 客流" v={String(pick.guests)} />
                <Row k="饮料份数" v={String(pick.drinks)} />
                <Row k="大桌服务费" v={money(pick.service_cents)} />
                <Row k="现金" v={money(pick.cash_cents)} />
                <Row k="刷卡" v={money(pick.card_cents)} />
                <Row k="其它" v={money(pick.other_cents)} />
                <Row
                  k="小费"
                  v={
                    pick.tips_total_cents > 0 && pick.revenue_cents > 0
                      ? `${money(pick.tips_total_cents)}（${((pick.tips_total_cents / pick.revenue_cents) * 100).toFixed(1)}%）`
                      : money(pick.tips_total_cents)
                  }
                />
                {pick.voided_count > 0 && (
                  <Row
                    k="作废"
                    v={`${pick.voided_count} 单 · ${money(pick.voided_cents)}`}
                    bad
                  />
                )}
                {pick.unpaid_count > 0 && (
                  <Row k="未记支付方式" v={`${pick.unpaid_count} 单`} bad />
                )}
                {pick.mismatch_count > 0 && (
                  <Row k="支付与账单不符" v={`${pick.mismatch_count} 单`} bad />
                )}
              </tbody>
            </table>
            <div className="tipbox">
              <div className="tiplabel">当日小费总额</div>
              <NumPad value={tipCents} onChange={setTipCents} />
              <p className="hint">
                一天录一个总数即可 —— 卡机小费和桌上现金加一起。
                {pick.tips_updated_by && ` 上次由 ${pick.tips_updated_by} 录入。`}
              </p>
              {tipErr && <p className="err">{tipErr}</p>}
              <button
                className="linkbtn wide"
                disabled={savingTip}
                onClick={async () => {
                  const cents = tipCents
                  setSavingTip(true)
                  setTipErr(null)
                  try {
                    const res = await authFetch('/api/reports/tips', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        business_date: pick.business_date,
                        tips_total_cents: cents,
                      }),
                    })
                    if (!res.ok) throw new Error(String(res.status))
                    const updated: DayRow = await res.json()
                    setPick(updated)
                    setRows((rs) =>
                      rs.map((x) =>
                        x.business_date === updated.business_date ? updated : x,
                      ),
                    )
                  } catch {
                    // 月报是在线专用的，录不上就明说，不要假装成功
                    setTipErr('保存失败，检查网络后重试')
                  } finally {
                    setSavingTip(false)
                  }
                }}
              >
                {savingTip ? '保存中…' : '保存小费'}
              </button>
            </div>

            <p className="hint">
              数字来自服务端，按**营业日**归集（凌晨 2 点前的单算前一天）。
            </p>
            <div className="sheet-actions">
              <button onClick={() => setPick(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <tr>
      <td className="dim">{k}</td>
      <td className={`num${bad ? ' badText' : ''}`}>{v}</td>
    </tr>
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
