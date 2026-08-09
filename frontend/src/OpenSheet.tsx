import { useState } from 'react'
import { estimateCents, money, type PriceRow } from './catalog'
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
  onConfirm: (label: string, guests: Guests, drinks: number) => void | Promise<void>
}) {
  // 默认 2 位成人 —— 最常见的情况，很多时候直接点确认就完事
  const [guests, setGuests] = useState<Guests>({ adult: 2, child: 0, senior: 0 })
  const [drinks, setDrinks] = useState(0)
  const [busy, setBusy] = useState(false)

  const total = guests.adult + guests.child + guests.senior
  const est = estimateCents(prices, period, guests, drinks)
  // 饮料数**可以**超过吃 buffet 的人数 —— 陪同的人不吃自助只要饮料

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
            饮料<small>（按人无限续）</small>
          </span>
          <button onClick={() => setDrinks((d) => Math.max(0, d - 1))} disabled={drinks === 0}>
            −
          </button>
          <span className="sv">{drinks}</span>
          <button onClick={() => setDrinks((d) => Math.min(99, d + 1))}>+</button>
        </div>
        {/* 全员要饮料是高频操作，给个一键 */}
        {total > 0 && drinks !== total && (
          <button className="linkbtn wide" onClick={() => setDrinks(total)}>
            全部 {total} 位都要饮料
          </button>
        )}

        <p className="total">{money(est)}</p>

        <div className="sheet-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={busy || (total === 0 && drinks === 0)}
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
