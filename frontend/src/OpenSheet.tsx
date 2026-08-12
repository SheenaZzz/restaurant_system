import { useState } from 'react'
import { tr, paren } from './i18n'
import {
  estimateCents,
  money,
  serviceCents,
  partySize,
  taxCents,
  type Category,
  type Drinks,
  type MenuItem,
  type Modifier,
  type PriceRow,
} from './catalog'
import type { NewLine } from './checks'
import MenuPicker from './MenuPicker'
import type { Guests } from './checks'

/**
 * The open-table sheet. **How fast this screen is decides whether the system gets used at all.**
 *
 * The constraints come from the floor, not from imagination:
 *   - at peak the host has three seconds, possibly with their hands full
 *   - the person using it may not be young
 *   -> big buttons, a shallow hierarchy, and defaults that match the common case (2 adults)
 */
export default function OpenSheet({
  tableLabel,
  prices,
  period,
  taxRate,
  menu,
  categories,
  modifiers = [],
  onCancel,
  onConfirm,
}: {
  tableLabel: string
  prices: PriceRow[]
  period: 'lunch' | 'dinner'
  taxRate: number
  menu: MenuItem[]
  categories: Category[]
  /** The add-on catalogue, passed to the ordering sheet behind "order a la carte" */
  modifiers?: Modifier[]
  onCancel: () => void
  onConfirm: (
    label: string,
    guests: Guests,
    drinks: Drinks,
    lines: NewLine[],
  ) => void | Promise<void>
}) {
  // Two adults by default -- the common case, and often Confirm is the only tap needed
  const [guests, setGuests] = useState<Guests>({ adult: 2, child: 0, senior: 0 })
  const [drinks, setDrinks] = useState<Drinks>({ adult: 0, child: 0 })
  const [busy, setBusy] = useState(false)
  // A whole table ordering a la carte instead of the buffet -- common enough that nobody should have to enter 0 guests first
  const [ordering, setOrdering] = useState(false)

  const total = guests.adult + guests.child + guests.senior
  const totalDrinks = drinks.adult + drinks.child
  const sub = estimateCents(prices, period, guests, drinks)
  const svc = serviceCents(sub, partySize(guests, drinks))
  const est = sub + svc + taxCents(sub, svc, taxRate)
  // Drinks **may** exceed the number of buffet guests -- someone tagging along has a drink without eating

  // One tap: adult drinks = adults + seniors (seniors pay the adult price), child drinks = children
  const suggested: Drinks = { adult: guests.adult + guests.senior, child: guests.child }
  const suggestionApplied =
    drinks.adult === suggested.adult && drinks.child === suggested.child

  const bumpDrink = (k: keyof Drinks, d: number) =>
    setDrinks((v) => ({ ...v, [k]: Math.max(0, Math.min(99, v[k] + d)) }))

  const bump = (k: keyof Guests, d: number) =>
    setGuests((g) => ({ ...g, [k]: Math.max(0, Math.min(99, g[k] + d)) }))

  const Row = ({ label, k }: { label: string; k: keyof Guests }) => (
    <div className="stepper">
      <span className="sl">{label}</span>
      <button onClick={() => bump(k, -1)} disabled={guests[k] === 0}>
        −
      </button>
      <span className="sv">{guests[k]}</span>
      <button onClick={() => bump(k, 1)}>+</button>
    </div>
  )

  if (ordering) {
    return (
      <MenuPicker
        menu={menu}
        categories={categories}
        modifiers={modifiers}
        title={`${tableLabel} · ${tr('Order à la carte')}`}
        onCancel={() => setOrdering(false)}
        onConfirm={async (lines) => {
          // No guests and no drinks: the whole table is a la carte
          await onConfirm(tableLabel, { adult: 0, child: 0, senior: 0 },
                          { adult: 0, child: 0 }, lines)
        }}
      />
    )
  }

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {tableLabel} · {tr('Seat table')}
          <span className="period-tag">
            {tr(period === 'lunch' ? 'Lunch' : 'Dinner')}
          </span>
          <span className="grow" />
          {/* On the right of the title row: whoever is ordering a la carte should
              see that fork immediately, not after filling in guests and scrolling to the bottom */}
          <button className="headbtn" onClick={() => setOrdering(true)}>{tr('Order à la carte')}</button>
        </h2>

        <Row label={tr('Adult')} k="adult" />
        <Row label={tr('Child')} k="child" />
        <Row label={tr('Senior')} k="senior" />

        <div className="divider" />

        <div className="stepper">
          <span className="sl">
            {tr('Adult drink')}<small>{tr('(seniors same as adults, free refills)')}</small>
          </span>
          <button onClick={() => bumpDrink('adult', -1)} disabled={drinks.adult === 0}>
            −
          </button>
          <span className="sv">{drinks.adult}</span>
          <button onClick={() => bumpDrink('adult', 1)}>+</button>
        </div>

        <div className="stepper">
          <span className="sl">
            {tr('Child drink')}<small>{tr('(priced separately)')}</small>
          </span>
          <button onClick={() => bumpDrink('child', -1)} disabled={drinks.child === 0}>
            −
          </button>
          <span className="sv">{drinks.child}</span>
          <button onClick={() => bumpDrink('child', 1)}>+</button>
        </div>

        {/* "Drinks for everyone" is frequent. The tiers follow the guest counts:
            adults + seniors -> adult drinks, children -> child drinks */}
        {total > 0 && !suggestionApplied && (
          <button className="quickbtn" onClick={() => setDrinks(suggested)}>
            {tr('Drinks for everyone')}
            {paren(
              `${tr('Adult')} ${suggested.adult}` +
                (suggested.child > 0 ? ` · ${tr('Child')} ${suggested.child}` : ''),
            )}
          </button>
        )}

        <p className="total">{money(est)}</p>
        {svc > 0 && (
          <p className="hint">
            {tr('incl. large-party fee')} {money(svc)}
            {paren(tr('10% on parties of 5+'))}
          </p>
        )}

        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('Cancel')}</button>
          <button
            className="primary"
            disabled={busy || (total === 0 && totalDrinks === 0)}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(tableLabel, guests, drinks, [])
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy
              ? '…'
              : total === 0
                ? tr('Open (drinks only)')
                : `${tr('Seat table')} ${total} ${tr('guests')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
