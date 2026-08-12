import { useState } from 'react'
import { tr } from './i18n'
import { estimateCents, money, type Drinks, type PriceRow } from './catalog'
import type { Guests } from './checks'
import type { LocalCheck } from './db'

/**
 * The edit sheet. It shares the steppers with the open-table sheet, but means
 * something different: what it submits is the **final value** (a wholesale
 * replacement), not a delta -- see modify_check in checks.py, where a delta
 * comes out wrong on offline replay.
 */
export default function EditSheet({
  check,
  prices,
  period,
  onCancel,
  onConfirm,
}: {
  check: LocalCheck
  prices: PriceRow[]
  period: 'lunch' | 'dinner'
  onCancel: () => void
  onConfirm: (guests: Guests, drinks: Drinks) => void | Promise<void>
}) {
  const [guests, setGuests] = useState<Guests>({
    adult: check.adult,
    child: check.child,
    senior: check.senior,
  })
  const [drinks, setDrinks] = useState<Drinks>({
    adult: check.drink_adult,
    child: check.drink_child,
  })
  const [busy, setBusy] = useState(false)

  const total = guests.adult + guests.child + guests.senior
  const totalDrinks = drinks.adult + drinks.child
  const est = estimateCents(prices, period, guests, drinks)
  const delta = est - check.est_cents

  const bumpG = (k: keyof Guests, d: number) =>
    setGuests((g) => ({ ...g, [k]: Math.max(0, Math.min(99, g[k] + d)) }))
  const bumpD = (k: keyof Drinks, d: number) =>
    setDrinks((v) => ({ ...v, [k]: Math.max(0, Math.min(99, v[k] + d)) }))

  const Row = (p: { label: string; v: number; on: (d: number) => void }) => (
    <div className="stepper">
      <span className="sl">{tr(p.label)}</span>
      <button onClick={() => p.on(-1)} disabled={p.v === 0}>
        −
      </button>
      <span className="sv">{p.v}</span>
      <button onClick={() => p.on(1)}>+</button>
    </div>
  )

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Edit check')} {check.table_label}</h2>

        <Row label={tr('Adult')} v={guests.adult} on={(d) => bumpG('adult', d)} />
        <Row label={tr('Child')} v={guests.child} on={(d) => bumpG('child', d)} />
        <Row label={tr('Senior')} v={guests.senior} on={(d) => bumpG('senior', d)} />
        <div className="divider" />
        <Row label={tr('Adult drink')} v={drinks.adult} on={(d) => bumpD('adult', d)} />
        <Row label={tr('Child drink')} v={drinks.child} on={(d) => bumpD('child', d)} />

        <p className="total">
          {money(est)}
          {delta !== 0 && (
            <span className={`delta ${delta > 0 ? 'up' : 'down'}`}>
              {delta > 0 ? '+' : '−'}
              {money(Math.abs(delta))}
            </span>
          )}
        </p>

        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('Cancel')}</button>
          <button
            className="primary"
            disabled={busy || (total === 0 && totalDrinks === 0)}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(guests, drinks)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : tr('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
