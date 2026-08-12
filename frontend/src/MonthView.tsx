import { useCallback, useEffect, useState } from 'react'
import { locale, tr } from './i18n'
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

/** The three kinds of reconciliation warning. One per key in the server's _KIND_WHERE. */
export type DrillKind = 'voided' | 'unpaid' | 'mismatch'

/** One check in a drill-down list. */
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
  dine_in: 'Dine-in',
  buffet_togo: 'Buffet to go',
  phone_order: 'Phone order',
}

/** Weekday initials, Monday first, in whichever language is on. */
function weekdayHeads(): string[] {
  const f = new Intl.DateTimeFormat(locale(), { weekday: 'short' })
  // 2024-01-01 was a Monday; any Monday would do
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2024, 0, 1 + i)))
}

/** Cache the last month report fetched, so offline at least shows the previous numbers. */
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
  /** Which warning's detail is currently open */
  const [drill, setDrill] = useState<DrillKind | null>(null)
  // Arriving from "jump to a day", open that day's detail once it has loaded
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
      // The month report **is not the critical path** -- fall back to the last cache rather than turning the page into an error
      const cached = await getMeta<DayRow[] | null>(cacheKey(y, m), null)
      setRows(cached ?? [])
      setState(cached ? 'cached' : 'error')
    }
  }, [])

  useEffect(() => {
    void load(year, month)
  }, [load, year, month])

  // Open the target day only after the data is in -- opening it at selection time would show last month's numbers
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

  // Changing day (or closing the detail) also closes the drill-down,
  // or opening another day would immediately show the previous day's list
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
      // The month report is online-only, so say so rather than pretending it saved
      setTipErr(tr('Save failed, check the connection and retry'))
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
  // Weeks start on Monday: turn JS's 0=Sunday into 0=Monday
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
        {/* The title is tappable -- paging month by month to last year is far too slow */}
        <button className="mtitle tappable" onClick={() => setPicking(true)}>
          {new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long' }).format(
            new Date(year, month - 1, 1),
          )} ▾
        </button>
        <button onClick={() => shift(1)}>›</button>
        {state === 'cached' && <span className="tag warn">{tr('Offline · last data')}</span>}
        {state === 'loading' && <span className="dim small">{tr('Loading…')}</span>}
        {state === 'error' && <span className="tag bad">{tr('Needs a connection')}</span>}
      </div>

      <div className="list-head">
        <div className="stats">
          <Stat label={tr('Revenue this month')} value={money(sum.revenue)} big />
          <Stat label={tr('Days open')} value={String(openDays)} />
          <Stat label={tr('Guest count')} value={String(sum.guests)} />
          <Stat label={tr('Drink count')} value={String(sum.drinks)} />
          <Stat label={tr('Check count')} value={String(sum.checks)} />
          <Stat
            label={tr('Daily average')}
            value={money(openDays ? Math.round(sum.revenue / openDays) : 0)}
          />
          <Stat
            label={tr('Per guest')}
            value={money(sum.guests ? Math.round(sum.revenue / sum.guests) : 0)}
          />
          {sum.service > 0 && <Stat label={tr('Large-party fee')} value={money(sum.service)} />}
          {sum.tax > 0 && <Stat label={tr('Tax')} value={money(sum.tax)} />}
          <Stat
            label={`${tr('Tips this month')}${sum.revenue ? `（${((sum.tips / sum.revenue) * 100).toFixed(1)}%）` : ''}`}
            value={money(sum.tips)}
          />
        </div>
      </div>

      <div className="stats payline">
        <Stat label={tr('Cash')} value={money(sum.cash)} />
        <Stat label={tr('Card')} value={money(sum.card)} />
        <Stat label={tr('Other')} value={money(sum.other)} />
        {sum.voided > 0 && (
          <Stat label={tr('Void')} value={money(sum.voided)} bad />
        )}
        {/* Non-zero here is where reconciliation will go wrong, so it goes somewhere prominent */}
        {sum.unpaid > 0 && <Stat label={tr('No payment method')} value={`${sum.unpaid} ${tr('checks')}`} bad />}
        {sum.mismatch > 0 && (
          <Stat label={tr('Payment does not match')} value={`${sum.mismatch} ${tr('checks')}`} bad />
        )}
      </div>

      <div className="cal">
        {weekdayHeads().map((w) => (
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
                    <span className="tip">{tr('Tips')} {money(r.tips_total_cents)}</span>
                  )}
                  {/* Bar length shows relative size -- which days were busy, at a glance */}
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
        <p className="hint">{tr('No business recorded this month.')}</p>
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
          {/* Two columns: numbers on the left, the tip keypad on the right.
              Stacked, the keypad fills the sheet and "Save tips" is pushed off
              screen, so entering tips means scrolling first -- the same fault the
              collect sheet had, with the same fix. */}
          <div className="sheet pay-wide day-sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{pick.business_date}</h2>
            <div className="pay-split">
              <div className="pay-left">
                <p className="total">{money(pick.revenue_cents)}</p>
                <table className="kv">
                  <tbody>
                    <Row k={tr('Check count')} v={String(pick.check_count)} />
                    <Row k={tr('Buffet guests')} v={String(pick.guests)} />
                    <Row k={tr('Drink count')} v={String(pick.drinks)} />
                    <Row k={tr('Large-party fee')} v={money(pick.service_cents)} />
                    <Row k={tr('Tax')} v={money(pick.tax_cents)} />
                    <Row k={tr('Cash')} v={money(pick.cash_cents)} />
                    <Row k={tr('Card')} v={money(pick.card_cents)} />
                    <Row k={tr('Other')} v={money(pick.other_cents)} />
                    <Row
                      k={tr('Tips')}
                      v={
                        pick.tips_total_cents > 0 && pick.revenue_cents > 0
                          ? `${money(pick.tips_total_cents)}（${((pick.tips_total_cents / pick.revenue_cents) * 100).toFixed(1)}%）`
                          : money(pick.tips_total_cents)
                      }
                    />
                    {/* All three open to show which checks they are.
                        A count of "3" is not something a person can act on -- fixing
                        it means knowing which three and by how much. */}
                    {pick.voided_count > 0 && (
                      <Row
                        k={tr('Voided')}
                        v={`${pick.voided_count} ${tr('checks')} · ${money(pick.voided_cents)}`}
                        bad
                        onOpen={() => setDrill('voided')}
                      />
                    )}
                    {pick.unpaid_count > 0 && (
                      <Row
                        k={tr('No payment method')}
                        v={`${pick.unpaid_count} ${tr('checks')}`}
                        bad
                        onOpen={() => setDrill('unpaid')}
                      />
                    )}
                    {pick.mismatch_count > 0 && (
                      <Row
                        k={tr('Payment does not match')}
                        v={`${pick.mismatch_count} ${tr('checks')}`}
                        bad
                        onOpen={() => setDrill('mismatch')}
                      />
                    )}
                  </tbody>
                </table>

                {/* The footnote sits at the bottom of the left column so it does not
                    add height to the stacked layout.
                    The boundary is a setting, so no specific hour is written here --
                    this used to say "before 2 AM counts as the previous day", which
                    became false the moment it moved to midnight.
                    An out-of-date explanation is worse than none. */}
                <p className="hint">
                  {tr('The numbers come from the server,')} <b>{tr('business day')}</b>{tr('grouped by business day (cutoff in Settings).')}</p>
              </div>

              <div className="pay-right">
                <div className="tipbox">
                  <div className="tiplabel">{tr("Today's tips")}</div>
                  <NumPad value={tipCents} onChange={setTipCents} />
                  <p className="hint">
                    {tr('One number per day -- card machine tips plus the cash on the tables.')}
                    {pick.tips_updated_by && ` ${tr('Last entered by')} ${tr(pick.tips_updated_by)}.`}
                  </p>
                  {tipErr && <p className="err">{tipErr}</p>}
                </div>
              </div>
            </div>

            {/* "Save tips" is this screen's main action, so it lives in the fixed
                action bar. It used to be a link inside the tip box while the bottom
                bar only had "Close" -- the same fault the settings sheet had: the
                prominent button is not the one you want, and a tall keypad pushes
                the real one off screen, so every entry starts with a scroll. */}
            <div className="sheet-actions">
              <button onClick={() => setPick(null)}>{tr('Close')}</button>
              <button className="primary" disabled={savingTip} onClick={saveTip}>
                {savingTip ? tr('Saving…') : tr('Save tips')}
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
  /** Pass it and the row becomes tappable -- it opens which checks make up the number */
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
  voided: 'Voided checks',
  unpaid: 'No payment method',
  mismatch: 'Payment does not match',
}

const DRILL_HINT: Record<DrillKind, string> = {
  voided: 'A voided amount is not sales, but "how much got voided" is the number to watch.',
  unpaid: 'Closed without a payment method. Fill these in first when close of day does not reconcile.',
  mismatch:
    'A payment method was recorded but the amount does not match the check. Usually the check was edited after collecting -- use "top up" on the check.',
}

/**
 * Which checks are behind one kind of reconciliation warning.
 *
 * The server filters them with **exactly the predicate the count uses** -- a
 * report that says 3 and lists 2 makes every other number suspect.
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
      // The month report is online-only -- say so rather than showing an empty
      // list that reads as "no problem checks"
      .catch(() => setErr(tr('Needs a connection to load this')))
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
        {!rows && !err && <p className="hint">{tr('Loading…')}</p>}
        {rows?.length === 0 && <p className="hint">{tr('No checks of this kind on this day.')}</p>}

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
                  {r.table_label ?? r.customer_name ?? tr(SOURCE_LABEL[r.source] ?? 'To go')}
                </span>
                <span className="cr-money">
                  {money(r.total_cents)}
                  {kind !== 'voided' && (
                    <span className="dim"> · {tr('Collected')} {money(r.paid_cents)}</span>
                  )}
                </span>
                {kind === 'mismatch' && (
                  <span className={due > 0 ? 'warnText' : 'badText'}>
                    {due > 0 ? `${tr('Outstanding')} ${money(due)}` : `${tr('Overpaid')} ${money(-due)}`}
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
          <button onClick={onClose}>{tr('Close')}</button>
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
