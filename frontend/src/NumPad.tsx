import { money } from './catalog'

/**
 * POS 式金额键盘。
 *
 * 为什么不用系统键盘：
 *   - iOS 键盘弹出来会顶掉半个弹层，金额和按钮都被盖住
 *   - 要输 121.44 得按 6 下，还容易点错小数点
 *   - 餐馆高峰期是**盲按**，手指目标必须大且位置固定
 *
 * **从右往左填**，和刷卡机、收银机一致：
 *   按 5 → $0.05   再按 0 → $0.50   再按 0 → $5.00   再按 0 → $50.00
 * 所以「五十块」是 5-0-0-0，永远不用碰小数点。
 */
export default function NumPad({
  value,
  onChange,
  quick,
  max,
}: {
  /** 当前金额（分） */
  value: number
  onChange: (cents: number) => void
  /** 快捷键，比如「全额」 */
  quick?: { label: string; cents: number }[]
  /** 上限，防手滑多按一个 0 */
  max?: number
}) {
  const push = (d: number) => {
    const next = value * 10 + d
    if (max !== undefined && next > max) return
    // 一亿分 = 一百万元，远超任何一张餐馆账单
    if (next > 100_000_000) return
    onChange(next)
  }

  const pushTwo = () => {
    const next = value * 100
    if (max !== undefined && next > max) return
    if (next > 100_000_000) return
    onChange(next)
  }

  const back = () => onChange(Math.floor(value / 10))

  return (
    <div className="numpad">
      <div className="np-display">{money(value)}</div>

      <div className="np-grid">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <button key={d} onClick={() => push(d)}>
            {d}
          </button>
        ))}
        <button onClick={pushTwo}>00</button>
        <button onClick={() => push(0)}>0</button>
        <button className="np-back" onClick={back}>
          ⌫
        </button>
      </div>

      <div className="np-quick">
        <button onClick={() => onChange(0)}>清空</button>
        {quick?.map((q) => (
          <button key={q.label} className="np-q" onClick={() => onChange(q.cents)}>
            {q.label}
          </button>
        ))}
      </div>
    </div>
  )
}
