import { money } from './catalog'
import { tr } from './i18n'

/**
 * A POS-style amount keypad.
 *
 * Why not the system keyboard:
 *   - the iOS keyboard covers half the sheet, hiding the amount and the buttons
 *   - 121.44 takes six taps and the decimal point is easy to miss
 *   - at peak this is tapped **without looking**, so the targets have to be big and always in the same place
 *
 * **Filled right to left**, like a card terminal or a till:
 *   5 -> $0.05   then 0 -> $0.50   then 0 -> $5.00   then 0 -> $50.00
 * So fifty dollars is 5-0-0-0 and the decimal point is never touched.
 */
export default function NumPad({
  value,
  onChange,
  quick,
  max,
}: {
  /** The current amount, in cents */
  value: number
  onChange: (cents: number) => void
  /** Shortcuts, "full amount" for instance */
  quick?: { label: string; cents: number }[]
  /** A ceiling, so one stray tap cannot add a zero */
  max?: number
}) {
  const push = (d: number) => {
    const next = value * 10 + d
    if (max !== undefined && next > max) return
    // 100 million cents = $1,000,000, well past any restaurant check
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
        <button onClick={() => onChange(0)}>{tr('Clear')}</button>
        {quick?.map((q) => (
          <button key={tr(q.label)} className="np-q" onClick={() => onChange(q.cents)}>
            {tr(q.label)}
          </button>
        ))}
      </div>
    </div>
  )
}
