import { useEffect, useState } from 'react'
import { tr } from './i18n'
import {
  loadCatalog,
  money,
  partySize,
  serviceCents,
  LARGE_PARTY_MIN,
  type TableInfo,
} from './catalog'
import type { LocalCheck } from './db'

/**
 * Transfer and merge.
 *
 * Both live in one sheet because on the floor they are two outcomes of the
 * same move: guests change seats -> transfer; tables push together -> merge.
 * Two entry points would only raise the question of which one to tap.
 */
export default function TransferSheet({
  check,
  others,
  onCancel,
  onTransfer,
  onMerge,
}: {
  check: LocalCheck
  others: LocalCheck[]
  onCancel: () => void
  onTransfer: (toLabel: string) => void | Promise<void>
  onMerge: (sourceUuids: string[]) => void | Promise<void>
}) {
  const [tab, setTab] = useState<'move' | 'merge'>('move')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadCatalog().then((c) => c && setTables(c.tables))
  }, [])

  const occupied = new Set(others.map((o) => o.table_label))

  // Party size and service charge after the merge -- the consequence people
  // forget, so it has to be visible **before** they confirm
  const merged = [...picked]
    .map((u) => others.find((o) => o.check_uuid === u))
    .filter(Boolean) as LocalCheck[]
  const g = merged.reduce(
    (a, m) => ({
      adult: a.adult + m.adult,
      child: a.child + m.child,
      senior: a.senior + m.senior,
    }),
    { adult: check.adult, child: check.child, senior: check.senior },
  )
  const d = merged.reduce(
    (a, m) => ({ adult: a.adult + m.drink_adult, child: a.child + m.drink_child }),
    { adult: check.drink_adult, child: check.drink_child },
  )
  const size = partySize(g, d)
  const subtotal =
    check.est_cents -
    check.service_cents +
    merged.reduce((a, m) => a + m.est_cents - m.service_cents, 0)
  const svc = serviceCents(subtotal, size)
  const willCharge = svc > 0 && check.service_cents === 0

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{check.table_label}</h2>

        <div className="tabs">
          <button className={tab === 'move' ? 'on' : ''} onClick={() => setTab('move')}>{tr('Move table')}</button>
          <button className={tab === 'merge' ? 'on' : ''} onClick={() => setTab('merge')}>{tr('Merge')}</button>
        </div>

        {tab === 'move' ? (
          <>
            <p className="hint">{tr('Pick an empty table to move the whole check to. Occupied tables cannot be chosen.')}</p>
            <div className="grid tight">
              {tables.map((t) => {
                const busyT = occupied.has(t.label)
                const self = t.label === check.table_label
                return (
                  <button
                    key={tr(t.label)}
                    className={`table ${busyT || self ? 'free' : ''}`}
                    disabled={busyT || self || busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await onTransfer(t.label)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    <span className="tlabel">{tr(t.label)}</span>
                    <span className="tseats">
                      {self ? tr('current') : busyT ? tr('in use') : `${t.seats} ${tr('seats')}`}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              {tr('Pick the checks to fold into')} <b>{check.table_label}</b>{tr('. Their lines move onto this check; the originals are marked merged and no longer counted on their own.')}</p>

            {others.length === 0 && <p className="hint">{tr('No other open checks.')}</p>}

            <ul className="pick">
              {others.map((o) => (
                <li key={o.check_uuid}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(o.check_uuid)}
                      onChange={(e) => {
                        const n = new Set(picked)
                        if (e.target.checked) n.add(o.check_uuid)
                        else n.delete(o.check_uuid)
                        setPicked(n)
                      }}
                    />
                    <span className="tb">{o.table_label}</span>
                    <span className="dim">
                      {o.adult + o.child + o.senior} {tr('guests')} · {money(o.est_cents)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            {picked.size > 0 && (
              <div className="preview">
                <div>
                  {tr('After merging')} <b>{size}</b> {tr('guests')} · {tr('Subtotal')} {money(subtotal)}
                </div>
                {svc > 0 && (
                  <div className={willCharge ? 'warnText' : ''}>
                    {willCharge && '⚠️ '}
                    {tr('At')} {LARGE_PARTY_MIN}{tr(' guests a 10% service charge applies')} {money(svc)}
                  </div>
                )}
                <div className="total small">{tr('Total')} {money(subtotal + svc)}</div>
              </div>
            )}

            <div className="sheet-actions">
              <button onClick={onCancel}>{tr('Cancel')}</button>
              <button
                className="primary"
                disabled={busy || picked.size === 0}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onMerge([...picked])
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? '…' : `${tr('Merge')} ${picked.size}`}
              </button>
            </div>
          </>
        )}

        {tab === 'move' && (
          <div className="sheet-actions">
            <button onClick={onCancel}>{tr('Cancel')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
