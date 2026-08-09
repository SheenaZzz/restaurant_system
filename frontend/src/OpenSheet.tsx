import { useState } from 'react'
import { estimateCents, money, type Drinks, type PriceRow } from './catalog'
import type { Guests } from './checks'

/**
 * 开桌页。**这一屏的速度决定整个系统会不会被真正使用。**
 *
 * 设计约束（来自现场，不是假想）：
 *   - 高峰期领位员只有 3 秒，手上可能还端着东西
 *   - 使用者可能是中老年人
 *   → 大按钮、层级浅、默认值就是最常见的情况（2 位成人）
 */
export default function OpenSheet({
  tableLabel,
  prices,
  period,
  onCancel,
  onConfirm,
}: {
  tableLabel: string
  prices: PriceRow[]
  period: 'lunch' | 'dinner'
  onCancel: () => void
  onConfirm: (label: string, guests: Guests, drinks: Drinks) => void | Promise<void>
}) {
  // 默认 2 位成人 —— 最常见的情况，很多时候直接点确认就完事
  const [guests, setGuests] = useState<Guests>({ adult: 2, child: 0, senior: 0 })
  const [drinks, setDrinks] = useState<Drinks>({ adult: 0, child: 0 })
  const [busy, setBusy] = useState(false)

  const total = guests.adult + guests.child + guests.senior
  const totalDrinks = drinks.adult + drinks.child
  const est = estimateCents(prices, period, guests, drinks)
  // 饮料数**可以**超过吃 buffet 的人数 —— 陪同的人不吃自助只要饮料

  // 一键：成人饮料 = 成人 + 长者（长者饮料按成人价），儿童饮料 = 儿童
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

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {tableLabel} 开桌
          <span className="period-tag">{period === 'lunch' ? '午市' : '晚市'}</span>
        </h2>

        <Row label="成人" k="adult" />
        <Row label="儿童" k="child" />
        <Row label="长者" k="senior" />

        <div className="divider" />

        <div className="stepper">
          <span className="sl">
            成人饮料<small>（长者同价 · 按人无限续）</small>
          </span>
          <button onClick={() => bumpDrink('adult', -1)} disabled={drinks.adult === 0}>
            −
          </button>
          <span className="sv">{drinks.adult}</span>
          <button onClick={() => bumpDrink('adult', 1)}>+</button>
        </div>

        <div className="stepper">
          <span className="sl">
            儿童饮料<small>（另有价格）</small>
          </span>
          <button onClick={() => bumpDrink('child', -1)} disabled={drinks.child === 0}>
            −
          </button>
          <span className="sv">{drinks.child}</span>
          <button onClick={() => bumpDrink('child', 1)}>+</button>
        </div>

        {/* 全员要饮料是高频操作。按人数自动分档：
            成人+长者 → 成人饮料，儿童 → 儿童饮料 */}
        {total > 0 && !suggestionApplied && (
          <button className="linkbtn wide" onClick={() => setDrinks(suggested)}>
            全部都要饮料（成人 {suggested.adult}
            {suggested.child > 0 && ` · 儿童 ${suggested.child}`}）
          </button>
        )}

        <p className="total">{money(est)}</p>

        <div className="sheet-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={busy || (total === 0 && totalDrinks === 0)}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(tableLabel, guests, drinks)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : total === 0 ? '开桌（仅饮料）' : `开桌 ${total} 人`}
          </button>
        </div>
      </div>
    </div>
  )
}
