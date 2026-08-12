import { useCallback, useEffect, useState } from 'react'
import { getLang, locale, tr, paren } from './i18n'
import { canManage, type Role } from './auth'
import {
  loadCatalog,
  money,
  type Category,
  type MenuItem,
  type Modifier,
  type PriceRow,
} from './catalog'
import {
  businessDateLabel,
  currentBusinessDate,
  cutoffHourOf,
} from './businessDay'
import { checksOfDay, dueCents, pendingCheckUuids, totalsOf } from './checks'
import CheckDetail, { operatorText, PAY_LABEL, STATUS_LABEL } from './CheckDetail'
import type { LocalCheck } from './db'

type Filter = 'all' | 'open' | 'due' | 'closed' | 'voided'

const FILTERS: { k: Filter; label: string }[] = [
  { k: 'all', label: 'All' },
  { k: 'open', label: 'Open' },
  // "Not settled" is not a status, it is a **condition**: the check is closed
  // but the money is not all in. Next to open, because they are the same kind of task: money still out.
  { k: 'due', label: 'Not settled' },
  { k: 'closed', label: 'Closed' },
  { k: 'voided', label: 'Voided' },
]

/** Whether a check matches a filter. */
function matches(c: LocalCheck, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'due') return dueCents(c) !== 0
  return c.status === f
}

export default function ListView({ role }: { role: Role }) {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [menu, setMenu] = useState<MenuItem[]>([])
  const [cats, setCats] = useState<Category[]>([])
  const [mods, setMods] = useState<Modifier[]>([])
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('dinner')
  const [now, setNow] = useState(new Date())
  const [bdate, setBdate] = useState('')
  const [pick, setPick] = useState<LocalCheck | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [pending, setPending] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    // ⚠️ **The current business day only.** This used to be allChecks() -- the
    //    header clock said today while the sales figure below was everything
    //    since opening day. That combination is worse than no summary: it looks completely normal.
    const c = await loadCatalog()
    const cutoff = cutoffHourOf(c)
    // Recomputed every time, never cached -- the page may not have reloaded all night
    const today = currentBusinessDate(cutoff)
    setBdate(today)
    const all = await checksOfDay(today, cutoff)
    setRows(all)
    setPending(await pendingCheckUuids())
    // While the detail is open another device may have changed it -- refresh
    // along, or someone collects against a stale amount
    setPick((p) => (p ? (all.find((r) => r.check_uuid === p.check_uuid) ?? null) : null))
  }, [])

  useEffect(() => {
    void reload()
    loadCatalog().then((c) => {
      if (c) {
        setPrices(c.prices)
        setMenu(c.menu)
        setCats(c.categories)
        setMods(c.modifiers ?? [])
        setPeriod(c.current_period_kind)
      }
    })
    // The clock runs on iPad local time -- staff compare against the wall clock, not the server
    const clock = window.setInterval(() => setNow(new Date()), 1000)
    const poll = window.setInterval(reload, 2000)
    return () => {
      window.clearInterval(clock)
      window.clearInterval(poll)
    }
  }, [reload])

  const t = totalsOf(rows)
  const manage = canManage(role)
  const shown = rows.filter((r) => matches(r, filter))
  const openChecks = rows.filter((r) => r.status === 'open')
  // Closed but not fully collected -- this money is already invisible on the
  // floor (the table is free), so the check list is the only place left to find it
  const dueRows = rows.filter((r) => dueCents(r) > 0)
  const dueTotal = dueRows.reduce((s, r) => s + dueCents(r), 0)

  return (
    <>
      <div className="list-head">
        <div className="clock">
          <span className="time">
            {now.toLocaleTimeString(locale(), { hour12: false })}
          </span>
          {/* This is the **business day**, not the device date. With a boundary
              other than midnight the two differ for a stretch, and every number
              below is by business day */}
          <span className="date">{bdate ? businessDateLabel(bdate) : '—'}</span>
        </div>

        <div className="stats">
          <Stat label={tr('Revenue')} value={money(t.revenueCents)} big />
          <Stat label={tr('Buffet guests')} value={String(t.buffetGuests)} />
          <Stat label={tr('Drink count')} value={String(t.drinkCount)} />
          <Stat label={tr('Open / closed')} value={`${t.openCount} / ${t.closedCount}`} />
          {/* "Closed but not collected" has to be visible at a glance, not only
              inside a card. Dozens of checks a day cannot be found by scanning cards */}
          {dueRows.length > 0 && (
            <Stat
              label={tr('Owing')}
              value={`${dueRows.length} · ${money(dueTotal)}`}
              bad
            />
          )}
          {t.serviceCents > 0 && (
            <Stat label={tr('Large-party fee')} value={money(t.serviceCents)} />
          )}
          <Stat
            label={tr('Cash / card / other')}
            value={`${money(t.cashCents)} · ${money(t.cardCents)} · ${money(t.otherCents)}`}
          />
          {t.voidedCount > 0 && (
            <Stat
              label={tr('Voided')}
              value={`${t.voidedCount} · ${money(t.voidedCents)}`}
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
            {tr(f.label)}
            <span className="cnt">{rows.filter((r) => matches(r, f.k)).length}</span>
          </button>
        ))}
      </div>

      {!manage && <p className="hint">{tr('Your account cannot edit or void checks.')}</p>}

      {shown.length === 0 && <p className="hint">{tr('No checks match.')}</p>}

      <div className="cards">
        {shown.map((c) => {
          const guests = c.adult + c.child + c.senior
          const drinks = c.drink_adult + c.drink_child
          const due = dueCents(c)
          return (
            <button
              key={c.check_uuid}
              // Closed but not fully collected **must not look like fully
              // collected**. Green "closed" is the strongest "this one is done"
              // signal in the UI, and using it to cover money that never arrived is hiding money.
              className={`card ${c.status}${due !== 0 ? ' due' : ''}`}
              onClick={() => setPick(c)}
            >
              <div className="c-top">
                <span className="c-table">{tr(c.table_label)}</span>
                <span
                  className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}
                >
                  {tr(STATUS_LABEL[c.status])}
                </span>
                {/* Status and collection are two things: the check really is closed
                    (the table is free) but the money is not all in. So both labels
                    show; they do not replace each other. */}
                {due > 0 && <span className="tag warn">{tr('Owing')} {money(due)}</span>}
                {due < 0 && <span className="tag bad">{tr('Overpaid')} {money(-due)}</span>}
                {pending.has(c.check_uuid) && (
                  <span className="tag warn">{tr('Pending')}</span>
                )}
                <span className="grow" />
                <span className="c-time">
                  {new Date(c.opened_at).toLocaleTimeString(locale(), {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              <div className="c-money">
                {money(c.est_cents)}
                {c.service_cents > 0 && (
                  <span className="c-svc">{tr('incl. fee')} {money(c.service_cents)}</span>
                )}
              </div>

              <div className="c-line">
                {guests > 0 && <span className="chip">{guestText(c)}</span>}
                {drinks > 0 && <span className="chip">{drinkText(c)}</span>}
              </div>

              <div className="c-foot">
                <span>{c.pay_method ? tr(PAY_LABEL[c.pay_method]) : tr('No payment recorded')}</span>
                <span className="grow" />
                <span>{operatorText(c)}</span>
              </div>

              {c.void_reason && <div className="c-note">{c.void_reason}</div>}
              {c.merged_into && <div className="c-note">{tr('Merged into another check')}</div>}
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
          menu={menu}
          categories={cats}
          modifiers={mods}
          pending={pending.has(pick.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}

/**
 * "3 guests (2A 1C)" rather than "3 guests - 2 adults - 1 child" --
 * the latter reads as three numbers in a row and gets added up to six.
 * The parentheses are dropped when there is only one type, to avoid "2 guests (2A)" on every card.
 */
function guestText(c: LocalCheck): string {
  const total = c.adult + c.child + c.senior
  // Chinese puts the type first and English last, so the two are built
  // separately. The single-letter keys are display tokens, not sentences.
  const zh = getLang() === 'zh'
  const parts: string[] = []
  if (c.adult) parts.push(zh ? `${tr('A')}${c.adult}` : `${c.adult}A`)
  if (c.child) parts.push(zh ? `${tr('C')}${c.child}` : `${c.child}C`)
  if (c.senior) parts.push(zh ? `${tr('S')}${c.senior}` : `${c.senior}S`)
  const head = zh ? `${total}${tr('ppl')}` : `${total} ${tr('guests')}`
  return parts.length > 1 ? `${head}${paren(parts.join(zh ? '' : ' '))}` : head
}

function drinkText(c: LocalCheck): string {
  const total = c.drink_adult + c.drink_child
  return c.drink_adult && c.drink_child
    ? `${tr('drinks')}${total}${paren(`${c.drink_adult}/${c.drink_child}`)}`
    : `${tr('drinks')}${total}`
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
