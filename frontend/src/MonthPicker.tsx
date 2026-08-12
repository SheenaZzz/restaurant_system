import { useEffect, useState } from 'react'
import { tr } from './i18n'
import { authFetch } from './auth'
import { money } from './catalog'

interface MonthRow {
  ym: string
  revenue_cents: number
  days: number
  tips_total_cents: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Quick year and month picker.
 *
 * It used to be ‹ › one month at a time -- getting back to this time last year
 * took twenty-odd taps. This pulls back **which months have data**, greys out
 * the ones that do not, and puts each month's sales in the cell: you know
 * which one to pick before picking.
 */
export default function MonthPicker({
  year,
  month,
  onPick,
  onPickDate,
  onClose,
}: {
  year: number
  month: number
  onPick: (y: number, m: number) => void
  onPickDate: (iso: string) => void
  onClose: () => void
}) {
  const [y, setY] = useState(year)
  const [rows, setRows] = useState<MonthRow[]>([])
  const [day, setDay] = useState('')

  useEffect(() => {
    authFetch('/api/reports/months')
      .then((r) => (r.ok ? r.json() : []))
      .then(setRows)
      .catch(() => setRows([]))
  }, [])

  const byYm = new Map(rows.map((r) => [r.ym, r]))
  const years = [...new Set(rows.map((r) => Number(r.ym.slice(0, 4))))]
  // Paging into a year with no data is allowed; the cells are simply grey
  const minY = Math.min(year, ...(years.length ? years : [year]))
  const maxY = Math.max(year, new Date().getFullYear())

  const today = new Date()

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Pick a month')}</h2>

        <div className="month-head">
          <button onClick={() => setY((v) => v - 1)} disabled={y <= minY - 1}>
            ‹
          </button>
          <span className="mtitle">{y}</span>
          <button onClick={() => setY((v) => v + 1)} disabled={y >= maxY}>
            ›
          </button>
        </div>

        <div className="mgrid">
          {MONTHS.map((label, i) => {
            const m = i + 1
            const ym = `${y}-${String(m).padStart(2, '0')}`
            const r = byYm.get(ym)
            const cur = y === year && m === month
            return (
              <button
                key={ym}
                className={`mcell${r ? ' has' : ''}${cur ? ' on' : ''}`}
                disabled={!r && !cur}
                onClick={() => {
                  onPick(y, m)
                  onClose()
                }}
              >
                <span className="ml">{label}</span>
                {r && <span className="mv">{money(r.revenue_cents)}</span>}
                {r && <span className="md">{r.days} {tr('days')}</span>}
              </button>
            )
          })}
        </div>

        <div className="divider" />

        <label className="reason">
          {tr('Jump to a day')}
          <input
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value)
              if (e.target.value) {
                onPickDate(e.target.value)
                onClose()
              }
            }}
          />
        </label>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('Cancel')}</button>
          <button
            className="primary"
            onClick={() => {
              onPick(today.getFullYear(), today.getMonth() + 1)
              onClose()
            }}
          >{tr('This month')}</button>
        </div>
      </div>
    </div>
  )
}
