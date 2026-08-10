import { useEffect, useState } from 'react'
import { authFetch } from './auth'
import { money } from './catalog'

interface MonthRow {
  ym: string
  revenue_cents: number
  days: number
  tips_total_cents: number
}

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/**
 * 年月快速选择。
 *
 * 原来只有 ‹ › 一格格翻 —— 要回看去年同期得点二十几下。
 * 这里把「有数据的月份」一次拉回来，没数据的直接灰掉，
 * 并把每月营业额显示在格子里：**选之前就知道该选哪个**。
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
  // 即使某年没数据也允许翻过去，只是格子会是灰的
  const minY = Math.min(year, ...(years.length ? years : [year]))
  const maxY = Math.max(year, new Date().getFullYear())

  const today = new Date()

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>选择月份</h2>

        <div className="month-head">
          <button onClick={() => setY((v) => v - 1)} disabled={y <= minY - 1}>
            ‹
          </button>
          <span className="mtitle">{y} 年</span>
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
                {r && <span className="md">{r.days} 天</span>}
              </button>
            )
          })}
        </div>

        <div className="divider" />

        <label className="reason">
          跳到某一天
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
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              onPick(today.getFullYear(), today.getMonth() + 1)
              onClose()
            }}
          >
            回到本月
          </button>
        </div>
      </div>
    </div>
  )
}
