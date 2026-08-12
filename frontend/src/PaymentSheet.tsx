import { useState } from 'react'
import { paren, tr } from './i18n'
import { money } from './catalog'
import type { PayMethod, Payment } from './checks'
import type { LocalCheck } from './db'
import NumPad from './NumPad'

const METHODS: { k: PayMethod; label: string }[] = [
  { k: 'cash', label: 'Cash' },
  { k: 'card', label: 'Card' },
  { k: 'mixed', label: 'Cash + card' },
  { k: 'other', label: 'Other' },
]

/**
 * Recording the payment method.
 *
 * ⚠️ The system **does not take payment** -- this only records how the guest paid.
 * Why it has to be recorded: at close of day the only cross-check is this
 * against the card machine and the drawer. Without the method, a $30 gap cannot be pinned on cash or card.
 *
 * Mixed payments use **two columns**: amounts and the picker on the left, keypad on the right.
 * Stacked, the sheet fills the screen and the confirm button is pushed off it,
 * needing a scroll -- and at peak every extra scroll is wasted motion.
 */
export default function PaymentSheet({
  check,
  title,
  /**
   * The amount being collected now. Omitted = everything the check owes.
   *
   * Three uses share this one sheet:
   *   collect (first time)   amount omitted -> the whole check
   *   top up                 amount = outstanding -> **only the part not yet collected**
   *   change payment method  amount omitted -> the whole check (wholesale replacement)
   */
  amount,
  /** In top-up mode, used to show owed / collected / outstanding */
  collected,
  onCancel,
  onConfirm,
}: {
  check: LocalCheck
  title: string
  amount?: number
  collected?: number
  onCancel: () => void
  onConfirm: (p: Payment) => void | Promise<void>
}) {
  // What is being collected now. In a top-up this is the **gap**, not the whole
  // check -- asking someone to collect $6.99 while $62.46 is on screen goes wrong sooner or later.
  const total = amount ?? check.est_cents
  const topUp = collected !== undefined && collected > 0
  const [method, setMethod] = useState<PayMethod>(
    // A top-up does not preselect last time's method: paying by card once does
    // not mean paying by card again, and a preselection is easy to tap straight past
    topUp ? 'cash' : (check.pay_method ?? 'cash'),
  )

  /**
   * A mixed payment only takes **one side**; the other is always the remainder.
   *
   * That is what happens at the counter: "they gave 50 in cash, the rest on card".
   * Letting both sides be typed only produces "the two do not add up to the total" --
   * which is exactly what the month report's "payment does not match" catches. Better to prevent it at the source.
   */
  const [entrySide, setEntrySide] = useState<'cash' | 'card'>('cash')
  const [entered, setEntered] = useState(
    !topUp && check.pay_method === 'mixed' ? (check.pay_cash ?? 0) : 0,
  )
  const [note, setNote] = useState(check.pay_note ?? '')
  const [busy, setBusy] = useState(false)

  const rest = Math.max(0, total - entered)
  const cash = entrySide === 'cash' ? entered : rest
  const card = entrySide === 'cash' ? rest : entered
  const mixed = method === 'mixed'

  const valid =
    method === 'other'
      ? note.trim().length > 0
      : mixed
        ? entered > 0 && entered < total
        : true

  function build(): Payment {
    if (method === 'cash')
      return { method, cash_cents: total, card_cents: 0, other_cents: 0 }
    if (method === 'card')
      return { method, cash_cents: 0, card_cents: total, other_cents: 0 }
    if (method === 'other')
      return {
        method,
        cash_cents: 0,
        card_cents: 0,
        other_cents: total,
        note: note.trim(),
      }
    return { method: 'mixed', cash_cents: cash, card_cents: card, other_cents: 0 }
  }

  const left = (
    <div className="pay-left">
      <p className="total">{money(total)}</p>
      {topUp ? (
        // In a top-up the three numbers sit side by side, so staff can see that the
        // big figure is "what is still owed", not "what this check costs"
        <table className="kv duebox">
          <tbody>
            <tr>
              <td className="dim">{tr('Check total')}</td>
              <td className="num">{money(check.est_cents)}</td>
            </tr>
            <tr>
              <td className="dim">{tr('Already collected')}</td>
              <td className="num">{money(collected ?? 0)}</td>
            </tr>
            <tr>
              <td className="dim">{tr('Collect now')}</td>
              <td className="num strong">{money(total)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        check.service_cents > 0 && (
          <p className="hint">{tr('Includes the large-party fee')} {money(check.service_cents)}{paren('10%')}</p>
        )
      )}

      <div className="paygrid">
        {METHODS.map((m) => (
          <button
            key={m.k}
            className={method === m.k ? 'on' : ''}
            onClick={() => setMethod(m.k)}
          >
            {tr(m.label)}
          </button>
        ))}
      </div>

      {mixed && (
        <>
          <div className="splitrow">
            <button
              className={entrySide === 'cash' ? 'on' : ''}
              onClick={() => {
                // Switching sides carries the current remainder over, so the number does not jump
                if (entrySide !== 'cash') setEntered(cash)
                setEntrySide('cash')
              }}
            >
              <span className="sl">{tr('Cash')} {entrySide === 'cash' ? tr('(entering)') : ''}</span>
              <span className="sv">{money(cash)}</span>
            </button>
            <button
              className={entrySide === 'card' ? 'on' : ''}
              onClick={() => {
                if (entrySide !== 'card') setEntered(card)
                setEntrySide('card')
              }}
            >
              <span className="sl">{tr('Card')} {entrySide === 'card' ? tr('(entering)') : ''}</span>
              <span className="sv">{money(card)}</span>
            </button>
          </div>
          <p className="hint">
            {tr('Tap above to choose which side you type;')} <b>{tr('the other side is always the remainder')}</b> -- {tr('they always add up to')} {topUp ? tr('what is being collected') : tr('what is owed')}.
          </p>
        </>
      )}

      {method === 'other' && (
        <label className="reason">
          {tr('Note (required)')}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('e.g. gift card / voucher')}
            autoFocus
          />
        </label>
      )}
    </div>
  )

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div
        className={`sheet${mixed ? ' pay-wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>
          {title} {check.table_label}
        </h2>

        {mixed ? (
          <div className="pay-split">
            {left}
            <div className="pay-right">
              <NumPad
                value={entered}
                onChange={setEntered}
                max={total}
                quick={[
                  { label: tr('Half'), cents: Math.round(total / 2) },
                  { label: tr('Full amount'), cents: total },
                ]}
              />
            </div>
          </div>
        ) : (
          left
        )}

        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('Cancel')}</button>
          <button
            className="primary"
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(build())
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : tr('Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
