import { useState } from 'react'
import { estimateCents, money, type Drinks, type PriceRow } from './catalog'
import type { Guests } from './checks'
import type { LocalCheck } from './db'

/**
 * 改单弹层。与开桌页共用同一套加减器，但语义不同：
 * 这里提交的是**最终值**（整体替换），不是增量 —— 见 checks.py 里
 * modify_check 的说明：增量在离线重放时会算错。
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
      <span className="sl">{p.label}</span>
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
        <h2>改单 {check.table_label}</h2>

        <Row label="成人" v={guests.adult} on={(d) => bumpG('adult', d)} />
        <Row label="儿童" v={guests.child} on={(d) => bumpG('child', d)} />
        <Row label="长者" v={guests.senior} on={(d) => bumpG('senior', d)} />
        <div className="divider" />
        <Row label="成人饮料" v={drinks.adult} on={(d) => bumpD('adult', d)} />
        <Row label="儿童饮料" v={drinks.child} on={(d) => bumpD('child', d)} />

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
          <button onClick={onCancel}>取消</button>
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
            {busy ? '…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
