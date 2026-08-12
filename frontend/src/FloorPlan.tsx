import { useCallback, useEffect, useState } from 'react'
import { tr } from './i18n'
import type { Role } from './auth'
import {
  businessDateLabel,
  currentBusinessDate,
  cutoffHourOf,
} from './businessDay'
import { loadCatalog, money, refreshCatalog, type Catalog } from './catalog'
import {
  carriedOverByTable,
  checkBusinessDate,
  openChecksByTable,
  openTable,
  pendingCheckUuids,
} from './checks'
import CheckDetail from './CheckDetail'
import type { LocalCheck } from './db'
import OpenSheet from './OpenSheet'

export default function FloorPlan({ role }: { role: Role }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [open, setOpen] = useState<Map<string, LocalCheck>>(new Map())
  const [carried, setCarried] = useState<Map<string, LocalCheck>>(new Map())
  const [bdate, setBdate] = useState('')
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [detailFor, setDetailFor] = useState<LocalCheck | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [blocked, setBlocked] = useState<LocalCheck | null>(null)

  const reload = useCallback(async () => {
    // The business day is recomputed every time rather than captured in the
    // closure -- this iPad may sit on the floor screen all night without reloading, and midnight has to turn the page by itself
    const c = await loadCatalog()
    const cutoff = cutoffHourOf(c)
    const today = currentBusinessDate(cutoff)
    setBdate(today)
    const m = await openChecksByTable(today, cutoff)
    const stale = await carriedOverByTable(today, cutoff)
    setOpen(m)
    setCarried(stale)
    setPending(await pendingCheckUuids())
    // While the detail is open another device may have changed the data --
    // refresh along, or someone collects against a stale amount.
    // ⚠️ Both maps have to be searched: arriving from "deal with this check"
    //    opens a carried-over one, and looking only in m would make the next poll close the detail by itself.
    setDetailFor((d) =>
      d ? (m.get(d.table_label) ?? stale.get(d.table_label) ?? null) : null,
    )
  }, [])

  useEffect(() => {
    // Render from the cache immediately, then refresh in the background --
    // an offline cold start still has to show 20 tables rather than a blank screen waiting on the network
    loadCatalog().then(setCat)
    refreshCatalog().then((c) => c && setCat(c))
    void reload()
    const t = window.setInterval(reload, 2000)
    return () => window.clearInterval(t)
  }, [reload])

  if (!cat) {
    return <p className="hint">{tr('First run needs a connection to load tables and menu…')}</p>
  }

  const zones = [...new Set(cat.tables.map((t) => t.zone ?? '—'))]
  const openList = [...open.values()]

  return (
    <>
      <div className="floor-head">
        <span className="period">
          {tr(cat.current_period_kind === 'lunch' ? 'Lunch' : 'Dinner')}
        </span>
        {/* The business day has to be shown. The numbers beside it are "this
            day's", and without saying which day nobody can tell after midnight whether to trust them */}
        {bdate && <span className="bday">{businessDateLabel(bdate)}</span>}
        <span className="muted">
          {tr('Seated')} {openList.reduce((s, c) => s + c.adult + c.child + c.senior, 0)} ·{' '}
          {tr('Tables open')} {open.size}/{cat.tables.length}
        </span>
      </div>

      {zones.map((z) => (
        <section key={z}>
          <h3 className="zone">{tr(z === 'main' ? 'Main' : z === 'large' ? 'Large tables' : z)}</h3>
          <div className="grid">
            {cat.tables
              .filter((t) => (t.zone ?? '—') === z)
              .map((t) => {
                const chk = open.get(t.label)
                return (
                  <button
                    key={tr(t.label)}
                    className={`table ${
                      chk
                        ? pending.has(chk.check_uuid)
                          ? 'busy pending'
                          : 'busy'
                        : 'free'
                    }`}
                    onClick={() => {
                      if (chk) return setDetailFor(chk)
                      // Yesterday's check on this table is still open -- the
                      // server's partial unique index would reject today's and
                      // drop it in the dead letter queue. Rather than a tap that
                      // does nothing, say what to do about it.
                      const stale = carried.get(t.label)
                      if (stale) return setBlocked(stale)
                      setSheetFor(t.label)
                    }}
                  >
                    <span className="tlabel">{tr(t.label)}</span>
                    {chk ? (
                      <>
                        <span className="tguests">
                          {chk.adult + chk.child + chk.senior} {tr('guests')}
                          {chk.drink_adult + chk.drink_child > 0 &&
                            ` · ${chk.drink_adult + chk.drink_child} ${tr('drinks')}`}
                        </span>
                        <span className="tmoney">
                          {money(chk.est_cents)}
                          {chk.service_cents > 0 && <span className="svc">{tr('+fee')}</span>}
                        </span>
                      </>
                    ) : (
                      <span className="tseats">{t.seats} {tr('seats')}</span>
                    )}
                  </button>
                )
              })}
          </div>
        </section>
      ))}

      {sheetFor && (
        <OpenSheet
          tableLabel={sheetFor}
          prices={cat.prices}
          period={cat.current_period_kind}
          taxRate={cat.tax_rate}
          menu={cat.menu}
          categories={cat.categories}
          modifiers={cat.modifiers ?? []}
          onCancel={() => setSheetFor(null)}
          onConfirm={async (label, guests, drinks, lines) => {
            await openTable(label, guests, drinks, lines)
            setSheetFor(null)
            await reload()
          }}
        />
      )}

      {blocked && (
        <div className="sheet-back" onClick={() => setBlocked(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{blocked.table_label} · {tr('still has an open check')}</h2>
            <p className="hint">
              {tr('Opened on')} <b>{businessDateLabel(checkBusinessDate(blocked, cutoffHourOf(cat)))}</b>
              {' · '}<b>{money(blocked.est_cents)}</b>{' · '}{tr('not settled yet')}
            </p>
            <p className="hint">{tr('One open check per table, so a new one cannot be started. Settle or void it and the table frees up.')}</p>
            <div className="sheet-actions">
              <button onClick={() => setBlocked(null)}>{tr('Cancel')}</button>
              <button
                className="primary"
                onClick={() => {
                  setDetailFor(blocked)
                  setBlocked(null)
                }}
              >{tr('Go settle it')}</button>
            </div>
          </div>
        </div>
      )}

      {detailFor && (
        <CheckDetail
          check={detailFor}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={openList}
          menu={cat.menu}
          categories={cat.categories}
          modifiers={cat.modifiers ?? []}
          pending={pending.has(detailFor.check_uuid)}
          onClose={() => setDetailFor(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}
