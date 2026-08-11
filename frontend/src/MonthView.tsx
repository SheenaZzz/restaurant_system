import { useCallback, useEffect, useState } from 'react'
import { getLang, locale, tr } from './i18n'
import { authFetch } from './auth'
import { money } from './catalog'
import { getMeta, setMeta } from './db'
import MonthPicker from './MonthPicker'
import NumPad from './NumPad'

export interface DayRow {
  business_date: string
  revenue_cents: number
  service_cents: number
  tax_cents: number
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

/** 对账告警的三类。和服务端 _KIND_WHERE 的键一一对应。 */
export type DrillKind = 'voided' | 'unpaid' | 'mismatch'

/** 下钻列表里的一张账单。 */
export interface DayCheck {
  check_uuid: string | null
  table_label: string | null
  source: string
  status: string
  opened_at: string
  closed_at: string | null
  total_cents: number
  paid_cents: number
  payment_method: string | null
  customer_name: string | null
  operator: string | null
  void_reason: string | null
  voided_by: string | null
}

const SOURCE_LABEL: Record<string, string> = {
  dine_in: '堂食',
  buffet_togo: '自助打包',
  phone_order: '电话单',
}

const MONTH_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const WEEK_ZH = ['一', '二', '三', '四', '五', '六', '日']
const WEEK_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

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
  /** 正在下钻看哪一类告警的明细 */
  const [drill, setDrill] = useState<DrillKind | null>(null)
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

  // 换一天（或关掉日详情）时把下钻也收起来，
  // 否则下次点开另一天会直接弹出上一天的明细
  useEffect(() => {
    setDrill(null)
  }, [pick?.business_date])

  async function saveTip() {
    if (!pick) return
    setSavingTip(true)
    setTipErr(null)
    try {
      const res = await authFetch('/api/reports/tips', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_date: pick.business_date,
          tips_total_cents: tipCents,
        }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const updated: DayRow = await res.json()
      setPick(updated)
      setRows((rs) =>
        rs.map((x) => (x.business_date === updated.business_date ? updated : x)),
      )
    } catch {
      // 月报是在线专用的，录不上就明说，不要假装成功
      setTipErr('保存失败，检查网络后重试')
    } finally {
      setSavingTip(false)
    }
  }

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
      tax: a.tax + r.tax_cents,
      voided: a.voided + r.voided_cents,
      tips: a.tips + r.tips_total_cents,
      unpaid: a.unpaid + r.unpaid_count,
      mismatch: a.mismatch + r.mismatch_count,
      cash: a.cash + r.cash_cents,
      card: a.card + r.card_cents,
      other: a.other + r.other_cents,
    }),
    {
      revenue: 0, guests: 0, drinks: 0, checks: 0, service: 0, tax: 0, voided: 0, tips: 0,
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
          {getLang() === 'zh' ? `${year} 年 ${month} 月` : `${MONTH_EN[month - 1]} ${year}`} ▾
        </button>
        <button onClick={() => shift(1)}>›</button>
        {state === 'cached' && <span className="tag warn">{tr('离线·上次数据')}</span>}
        {state === 'loading' && <span className="dim small">{tr('载入中…')}</span>}
        {state === 'error' && <span className="tag bad">{tr('需要联网')}</span>}
      </div>

      <div className="list-head">
        <div className="stats">
          <Stat label={tr('本月营业额')} value={money(sum.revenue)} big />
          <Stat label={tr('营业天数')} value={String(openDays)} />
          <Stat label={tr('客流')} value={String(sum.guests)} />
          <Stat label={tr('饮料份数')} value={String(sum.drinks)} />
          <Stat label={tr('单数')} value={String(sum.checks)} />
          <Stat
            label={tr('日均')}
            value={money(openDays ? Math.round(sum.revenue / openDays) : 0)}
          />
          <Stat
            label={tr('客单价')}
            value={money(sum.guests ? Math.round(sum.revenue / sum.guests) : 0)}
          />
          {sum.service > 0 && <Stat label={tr('大桌服务费')} value={money(sum.service)} />}
          {sum.tax > 0 && <Stat label={tr('税')} value={money(sum.tax)} />}
          <Stat
            label={`${tr('本月小费')}${sum.revenue ? `（${((sum.tips / sum.revenue) * 100).toFixed(1)}%）` : ''}`}
            value={money(sum.tips)}
          />
        </div>
      </div>

      <div className="stats payline">
        <Stat label={tr('现金')} value={money(sum.cash)} />
        <Stat label={tr('刷卡')} value={money(sum.card)} />
        <Stat label={tr('其它')} value={money(sum.other)} />
        {sum.voided > 0 && (
          <Stat label={tr('作废')} value={money(sum.voided)} bad />
        )}
        {/* 这两个数不为零就是对账会出问题的地方，必须放在显眼位置 */}
        {sum.unpaid > 0 && <Stat label={tr('未记支付方式')} value={`${sum.unpaid} ${tr('单')}`} bad />}
        {sum.mismatch > 0 && (
          <Stat label={tr('支付与账单不符')} value={`${sum.mismatch} ${tr('单')}`} bad />
        )}
      </div>

      <div className="cal">
        {(getLang() === 'zh' ? WEEK_ZH : WEEK_EN).map((w) => (
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
                    <span className="tip">{tr('小费')} {money(r.tips_total_cents)}</span>
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
        <p className="hint">{tr('这个月还没有营业数据。')}</p>
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
          {/* 左右分栏：左边数字、右边小费键盘。
              竖着排的话，键盘把弹层撑满整屏，「保存小费」被挤到屏幕外，
              每次录小费都要先滚一下 —— 和结账弹层当初一个毛病，用同一个解法。 */}
          <div className="sheet pay-wide day-sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{pick.business_date}</h2>
            <div className="pay-split">
              <div className="pay-left">
                <p className="total">{money(pick.revenue_cents)}</p>
                <table className="kv">
                  <tbody>
                    <Row k="单数" v={String(pick.check_count)} />
                    <Row k="Buffet 客流" v={String(pick.guests)} />
                    <Row k="饮料份数" v={String(pick.drinks)} />
                    <Row k="大桌服务费" v={money(pick.service_cents)} />
                    <Row k="税" v={money(pick.tax_cents)} />
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
                    {/* 这三行都可以点开看是哪几单。
                        只给一个「3 单」的计数，人是没法处理的 ——
                        得知道是哪三单、差多少，才谈得上去改。 */}
                    {pick.voided_count > 0 && (
                      <Row
                        k="作废"
                        v={`${pick.voided_count} ${tr('单')} · ${money(pick.voided_cents)}`}
                        bad
                        onOpen={() => setDrill('voided')}
                      />
                    )}
                    {pick.unpaid_count > 0 && (
                      <Row
                        k="未记支付方式"
                        v={`${pick.unpaid_count} ${tr('单')}`}
                        bad
                        onOpen={() => setDrill('unpaid')}
                      />
                    )}
                    {pick.mismatch_count > 0 && (
                      <Row
                        k="支付与账单不符"
                        v={`${pick.mismatch_count} ${tr('单')}`}
                        bad
                        onOpen={() => setDrill('mismatch')}
                      />
                    )}
                  </tbody>
                </table>

                {/* 脚注放左栏底部，不占竖向堆叠的高度。
                    分界时间是设置项，这里不写死具体几点 —— 以前这句写着
                    「凌晨 2 点前的单算前一天」，改成 0 点后就成了假的。
                    过时的说明比没有说明更糟。 */}
                <p className="hint">
                  数字来自服务端，按<b>{tr('营业日')}</b>{tr('归集（分界时间见 ⚙︎ 设置）。')}</p>
              </div>

              <div className="pay-right">
                <div className="tipbox">
                  <div className="tiplabel">{tr('当日小费总额')}</div>
                  <NumPad value={tipCents} onChange={setTipCents} />
                  <p className="hint">
                    一天录一个总数 —— 卡机小费和桌上现金加一起。
                    {pick.tips_updated_by && ` 上次由 ${pick.tips_updated_by} 录入。`}
                  </p>
                  {tipErr && <p className="err">{tipErr}</p>}
                </div>
              </div>
            </div>

            {/* 「保存小费」是这一屏的主操作，放底部固定的动作条。
                以前它是小费框里一个 linkbtn，而底部只有「关闭」——
                和设置页当初一样的毛病：显眼的按钮不是你要按的那个，
                而且键盘一高就把它挤到屏幕外，每次都得先滚一下。 */}
            <div className="sheet-actions">
              <button onClick={() => setPick(null)}>{tr('关闭')}</button>
              <button className="primary" disabled={savingTip} onClick={saveTip}>
                {savingTip ? '保存中…' : '保存小费'}
              </button>
            </div>
          </div>

          {drill && (
            <DayCheckList
              date={pick.business_date}
              kind={drill}
              onClose={() => setDrill(null)}
            />
          )}
        </div>
      )}
    </>
  )
}

function Row({
  k,
  v,
  bad,
  /** 传了就变成可点的行 —— 点开看这个数字是由哪几单构成的 */
  onOpen,
}: {
  k: string
  v: string
  bad?: boolean
  onOpen?: () => void
}) {
  return (
    <tr className={onOpen ? 'tappable-row' : ''}>
      <td className="dim">{k}</td>
      <td className={`num${bad ? ' badText' : ''}`}>
        {onOpen ? (
          <button className="drill" onClick={onOpen}>
            {v} <span className="cb-go">›</span>
          </button>
        ) : (
          v
        )}
      </td>
    </tr>
  )
}

const DRILL_TITLE: Record<DrillKind, string> = {
  voided: '作废的账单',
  unpaid: '未记支付方式',
  mismatch: '支付与账单不符',
}

const DRILL_HINT: Record<DrillKind, string> = {
  voided: '作废的金额不计入营业额，但「作废了多少钱」正是要盯的数。',
  unpaid: '已经关单、但没选支付方式。日结对不上时先补这些。',
  mismatch:
    '记了支付方式，但收的钱和账单金额对不上。最常见的成因是结账之后又改了单 —— 到账单详情里「补收差额」即可。',
}

/**
 * 某一类对账告警具体是哪几单。
 *
 * 服务端用**和聚合计数完全同一段谓词**筛出来 ——
 * 报表说 3 单、点进去只列 2 单的话，人会开始怀疑所有数字。
 */
function DayCheckList({
  date,
  kind,
  onClose,
}: {
  date: string
  kind: DrillKind
  onClose: () => void
}) {
  const [rows, setRows] = useState<DayCheck[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    authFetch(`/api/reports/day-checks?date=${date}&kind=${kind}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setRows)
      // 月报是在线专用的 —— 拿不到就明说，不要显示一个空列表
      // 让人以为"没有问题单"
      .catch(() => setErr('需要联网才能查看明细'))
  }, [date, kind])

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <h2>
          {tr(DRILL_TITLE[kind])}
          <span className="period-tag">{date}</span>
        </h2>
        <p className="hint">{tr(DRILL_HINT[kind])}</p>

        {err && <p className="err">{err}</p>}
        {!rows && !err && <p className="hint">{tr('载入中…')}</p>}
        {rows?.length === 0 && <p className="hint">{tr('这一天没有这类账单。')}</p>}

        <div className="carry-list">
          {rows?.map((r) => {
            const due = r.total_cents - r.paid_cents
            return (
              <div key={r.check_uuid ?? `${r.opened_at}`} className="carry-row static">
                <span className="cr-day">
                  {new Date(r.opened_at).toLocaleTimeString(locale(), {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="cr-table">
                  {r.table_label ?? r.customer_name ?? SOURCE_LABEL[r.source] ?? '自提'}
                </span>
                <span className="cr-money">
                  {money(r.total_cents)}
                  {kind !== 'voided' && (
                    <span className="dim"> · {tr('已收')} {money(r.paid_cents)}</span>
                  )}
                </span>
                {kind === 'mismatch' && (
                  <span className={due > 0 ? 'warnText' : 'badText'}>
                    {due > 0 ? `待收 ${money(due)}` : `多收 ${money(-due)}`}
                  </span>
                )}
                <span className="cr-who">{r.operator ?? '—'}</span>
                {r.void_reason && (
                  <span className="cr-reason">
                    {r.void_reason}
                    {r.voided_by && ` · ${r.voided_by}`}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('关闭')}</button>
        </div>
      </div>
    </div>
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
