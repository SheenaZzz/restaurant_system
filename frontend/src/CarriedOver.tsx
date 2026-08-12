import { useCallback, useEffect, useState } from 'react'
import { tr } from './i18n'
import type { Role } from './auth'
import {
  businessDateLabel,
  clockDrift,
  currentBusinessDate,
  cutoffHourOf,
  offsetText,
} from './businessDay'
import { loadCatalog, money, type Catalog } from './catalog'
import {
  carriedOverChecks,
  checkBusinessDate,
  isTogo,
  pendingCheckUuids,
} from './checks'
import CheckDetail, { operatorText } from './CheckDetail'
import type { LocalCheck } from './db'

/**
 * Checks carried over from an earlier day.
 *
 * The floor starts clean every day -- but **what is cleared is the floor, not the books**.
 * A table was opened, an amount is owed and nothing was collected, so that is
 * money not yet received; this system is the store's only record, and
 * disappearing from the screen means nobody will ever think of it again.
 *
 * So the banner stays until it is dealt with, rather than appearing once as a notification.
 */

function useCarried(): {
  rows: LocalCheck[]
  cat: Catalog | null
  today: string
  reload: () => Promise<void>
  pending: Set<string>
} {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [cat, setCat] = useState<Catalog | null>(null)
  const [today, setToday] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    const c = await loadCatalog()
    const cutoff = cutoffHourOf(c)
    // Recomputed every time -- this iPad may sit on this screen all night without
    // reloading, and it has to notice midnight itself
    const bd = currentBusinessDate(cutoff)
    setCat(c)
    setToday(bd)
    setRows(await carriedOverChecks(bd, cutoff))
    setPending(await pendingCheckUuids())
  }, [])

  useEffect(() => {
    void reload()
    const t = window.setInterval(reload, 2000)
    return () => window.clearInterval(t)
  }, [reload])

  return { rows, cat, today, reload, pending }
}

/**
 * The warning that the device's time zone does not match the store's.
 *
 * This device works out the business day from **its own clock** (offline there
 * is nothing else). With the wrong time zone, the few hours near the boundary
 * file checks on the wrong business day every day -- silently, with everything
 * looking normal. So once it is out, the warning stays.
 */
export function ClockDriftBanner() {
  const [drift, setDrift] = useState<ReturnType<typeof clockDrift>>(null)

  useEffect(() => {
    const check = () => void loadCatalog().then((c) => setDrift(clockDrift(c)))
    check()
    // Every 10 seconds. That looks frequent, but it reads local IndexedDB and costs almost nothing.
    // It was 60 once: on a cold start the cache still holds the **previous**
    // catalog (without store_utc_offset_minutes), so it decides there is no
    // drift; once FloorPlan refreshes the catalog, this would still take another
    // minute to notice -- and that minute is exactly when someone has just opened
    // the iPad and is most likely to seat the first table.
    const t = window.setInterval(check, 10_000)
    return () => window.clearInterval(t)
  }, [])

  if (!drift) return null

  return (
    <div className="carry-banner bad" role="alert">
      <span className="cb-n">⚠</span>
      <span className="cb-txt">
        {tr("This device's time zone differs from the store's")}
        <small>
          {tr('Store')} {offsetText(drift.storeMinutes)} · {tr('This device')}{' '}
          {offsetText(drift.deviceMinutes)}（{deviceTzName()}）
          <br />
          {tr("Checks may land on the wrong business day. Set this iPad's time zone to the store's in iOS Settings.")}
        </small>
      </span>
    </div>
  )
}

function deviceTzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return tr('unknown')
  }
}

/** The banner **renders nothing** when there is nothing carried over: no space taken, no noise. */
export function CarriedOverBanner({ role }: { role: Role }) {
  const [open, setOpen] = useState(false)
  const { rows, cat, reload, pending } = useCarried()

  if (rows.length === 0) return null

  const total = rows.reduce((s, c) => s + c.est_cents, 0)

  return (
    <>
      <button className="carry-banner" onClick={() => setOpen(true)}>
        <span className="cb-n">{rows.length}</span>
        <span className="cb-txt">
          {tr(' checks carried over')} · {money(total)}
          <small>{tr('The floor has moved to a new day. These are still unpaid — tap to handle.')}</small>
        </span>
        <span className="cb-go">›</span>
      </button>

      {open && (
        <CarriedOverSheet
          role={role}
          rows={rows}
          cat={cat}
          pending={pending}
          onChanged={reload}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function CarriedOverSheet({
  role,
  rows,
  cat,
  pending,
  onChanged,
  onClose,
}: {
  role: Role
  rows: LocalCheck[]
  cat: Catalog | null
  pending: Set<string>
  onChanged: () => void | Promise<void>
  onClose: () => void
}) {
  const [pick, setPick] = useState<LocalCheck | null>(null)
  const cutoff = cutoffHourOf(cat)

  // While the detail is open another device may have collected it -- refresh
  // along, or someone acts on a check that no longer exists
  const live = pick
    ? (rows.find((r) => r.check_uuid === pick.check_uuid) ?? null)
    : null

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Checks carried over')} {rows.length}</h2>
        <p className="hint">
          {tr('These were opened before today and never settled. Each one is money that was never collected — settle or void them to clear this list.')}
        </p>

        <div className="carry-list">
          {rows.map((c) => {
            const bd = checkBusinessDate(c, cutoff)
            return (
              <button
                key={c.check_uuid}
                className="carry-row"
                onClick={() => setPick(c)}
              >
                <span className="cr-day">{bd ? businessDateLabel(bd) : tr('Bad timestamp')}</span>
                <span className="cr-table">
                  {isTogo(c) ? (c.customer_name || tr('To go')) : c.table_label}
                </span>
                <span className="cr-money">{money(c.est_cents)}</span>
                <span className="cr-who">{operatorText(c)}</span>
                {pending.has(c.check_uuid) && <span className="tag warn">{tr('Pending')}</span>}
                <span className="cb-go">›</span>
              </button>
            )
          })}
        </div>

        <p className="hint">
          {tr('⚠️ You cannot open that table today — one open check per table. Settle these first.')}
        </p>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('Got it')}</button>
        </div>
      </div>

      {live && cat && (
        <CheckDetail
          check={live}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={rows}
          menu={cat.menu}
          categories={cat.categories}
          modifiers={cat.modifiers ?? []}
          pending={pending.has(live.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}
