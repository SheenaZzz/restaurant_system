import { useCallback, useEffect, useMemo, useState } from 'react'
import { name, tr } from './i18n'
import { loadCatalog } from './catalog'
import { type LocalTray } from './db'
import {
  agoText,
  lastByDish,
  recordTray,
  type BoardDish,
  type TrayKind,
} from './trays'

/**
 * The refill board. **Shared by the front and the kitchen.**
 *
 * A cook tapping while refilling is the natural case, but the person who
 * notices an empty tray is usually a server -- kitchen-only would lose most of
 * the "ran empty" events, and those are the right-hand end of the censoring
 * interval, the end the model needs most.
 *
 * Every choice on this screen serves one thing: **three seconds at peak**.
 *   - three buttons; no dropdown, no confirmation, no fill-level slider
 *   - ten slots a page, paged rather than a long list -- nobody should scroll to find a dish at the counter
 *   - lunch and dinner are **switched by hand**, not by the clock: changing the
 *     board is something a person does, and a wrong guess files the record against the other board
 */

const KINDS: { kind: TrayKind; label: string; cls: string }[] = [
  { kind: 'refill', label: 'Full', cls: 'k-refill' },
  { kind: 'half', label: 'Half', cls: 'k-half' },
  { kind: 'empty', label: 'Empty', cls: 'k-empty' },
]

/** Backdating options. Cooks usually tap **after** the fact -- see JOURNAL. */
const BACK = [0, 5, 10, 15]

const PAGES = [1, 2, 3]
const SLOTS = 10

export default function RefillView() {
  const [board, setBoard] = useState<Record<string, BoardDish[]> | null>(null)
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('lunch')
  const [page, setPage] = useState(1)
  const [last, setLast] = useState<Map<number, LocalTray>>(new Map())
  const [back, setBack] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  // "How long ago" is recomputed every minute; without it the number freezes at whatever it was when the page opened.
  const [, tick] = useState(0)

  useEffect(() => {
    void (async () => {
      const cat = await loadCatalog()
      setBoard((cat?.buffet_board ?? { lunch: [], dinner: [] }) as Record<string, BoardDish[]>)
      // Default to the period the server says it is, but **allow it to be changed** --
      // the board does not swap itself at 15:00; it swaps when a person swaps it.
      setPeriod(cat?.current_period_kind === 'dinner' ? 'dinner' : 'lunch')
    })()
  }, [])

  const refresh = useCallback(async () => setLast(await lastByDish()), [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => {
      tick((n) => n + 1)
      void refresh()
    }, 30_000)
    return () => window.clearInterval(t)
  }, [refresh])

  const slots = useMemo(() => {
    const dishes = (board?.[period] ?? []).filter((d) => d.page === page)
    const byPos = new Map(dishes.map((d) => [d.pos, d]))
    return Array.from({ length: SLOTS }, (_, i) => byPos.get(i + 1) ?? null)
  }, [board, period, page])

  async function hit(d: BoardDish, kind: TrayKind) {
    await recordTray(d.id, kind, back)
    await refresh()
    const label = tr(KINDS.find((k) => k.kind === kind)!.label)
    setToast(
      `${name(d)} · ${label} · ${back ? `${back} ${tr('min ago')}` : tr('just now')}`,
    )
    // Backdating is **one-shot** and resets immediately. Left on, the next entry
    // is silently filed in the past, and nobody remembers having set it.
    setBack(0)
    window.setTimeout(() => setToast(null), 2500)
  }

  if (!board) return <p className="hint">{tr('Loading…')}</p>

  const filled = (board[period] ?? []).length

  return (
    <>
      <div className="refill-top">
        <div className="seg">
          {(['lunch', 'dinner'] as const).map((p) => (
            <button
              key={p}
              className={period === p ? 'on' : ''}
              onClick={() => setPeriod(p)}
            >
              {tr(p === 'lunch' ? 'Lunch' : 'Dinner')}
            </button>
          ))}
        </div>
        <div className="seg pages">
          {PAGES.map((p) => (
            <button key={p} className={page === p ? 'on' : ''} onClick={() => setPage(p)}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* "-5'" means nothing to anyone (the owner's first question was what it
          was). Written as a sentence: this row answers "when did it happen". */}
      <div className="refill-back">
        <span className="rb-label">{tr('When did it happen?')}</span>
        {BACK.map((m) => (
          <button key={m} className={back === m ? 'on' : ''} onClick={() => setBack(m)}>
            {m === 0 ? tr('just now') : `${m} ${tr('min ago')}`}
          </button>
        ))}
      </div>
      <p className="hint">
        {tr('If you are logging it after the fact, pick how long ago it actually was. It goes back to "just now" after one entry.')}
      </p>

      {filled === 0 && (
        <p className="hint">{tr('This board is empty. The owner sets it up under Prices → Buffet board.')}</p>
      )}

      <div className="tray-grid">
        {slots.map((d, i) =>
          d === null ? (
            <div key={`e${i}`} className="tray empty">
              <span className="t-name">{i + 1}</span>
            </div>
          ) : (
            <div key={d.id} className="tray">
              <div className="t-head">
                <span className="t-name">{name(d)}</span>
                <span className="t-ago">
                  {last.get(d.id)
                    ? `${agoText(last.get(d.id)!.at).text}′ ${tr(
                        KINDS.find((k) => k.kind === last.get(d.id)!.kind)?.label ?? '',
                      )}`
                    : tr('no record yet')}
                </span>
              </div>
              <div className="t-btns">
                {KINDS.map((k) => (
                  <button key={k.kind} className={k.cls} onClick={() => void hit(d, k.kind)}>
                    {tr(k.label)}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
      </div>

      {toast && <div className="tray-toast">{tr('Logged')} · {toast}</div>}
    </>
  )
}
