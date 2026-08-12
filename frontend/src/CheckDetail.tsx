import { useState } from 'react'
import { modLabel, lineName, locale, tr, paren } from './i18n'
import { canManage, type Role } from './auth'
import {
  money,
  type Category,
  type Drinks,
  type MenuItem,
  type Modifier,
  type PriceRow,
} from './catalog'
import {
  addLines,
  addPayment,
  closeWithPayment,
  dueCents,
  mergeTables,
  modifyTable,
  paidCents,
  restoreTable,
  transferTable,
  updatePayment,
  voidTable,
  type Guests,
  type Payment,
} from './checks'
import type { LocalCheck } from './db'
import CheckHistory from './CheckHistory'
import MenuPicker from './MenuPicker'
import EditSheet from './EditSheet'
import PaymentSheet from './PaymentSheet'
import TransferSheet from './TransferSheet'

export const STATUS_LABEL: Record<LocalCheck['status'], string> = {
  open: 'Open',
  closed: 'Closed',
  voided: 'Voided',
  merged: 'Merged',
}

export const PAY_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  mixed: 'Cash + card',
  other: 'Other',
}

/**
 * Check detail, and every action on a check.
 *
 * The floor and the check list share this component -- written twice, the
 * button visibility, the permission checks and the confirmations would drift
 * apart, and the drift always lands in the branch only one side handled.
 */
export default function CheckDetail({
  check,
  role,
  prices,
  period,
  openChecks,
  menu,
  categories,
  modifiers = [],
  pending = false,
  onClose,
  onChanged,
}: {
  check: LocalCheck
  role: Role
  prices: PriceRow[]
  period: 'lunch' | 'dinner'
  /** Other open checks, for picking merge sources */
  openChecks: LocalCheck[]
  /** The menu, for adding dishes. Without it the add button is not shown */
  menu?: MenuItem[]
  categories?: Category[]
  /** The add-on catalogue, passed to the ordering sheet */
  modifiers?: Modifier[]
  /** This check still has operations that have not reached the server */
  pending?: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const [sub, setSub] = useState<
    'pay' | 'topup' | 'move' | 'edit' | 'void' | 'history' | 'addlines' | null
  >(null)
  const [reason, setReason] = useState('')
  const manage = canManage(role)
  const c = check
  // Dishes added after collecting -> due > 0 (still owed); a voided dish -> due < 0 (overpaid).
  // The month report's "payment does not match" is exactly the checks where this is not 0.
  const paid = paidCents(c)
  const due = dueCents(c)

  async function done() {
    setSub(null)
    await onChanged()
    onClose()
  }

  if (sub === 'pay') {
    return (
      <PaymentSheet
        check={c}
        title={c.status === 'open' ? tr('Collect') : tr('Change payment method')}
        onCancel={() => setSub(null)}
        onConfirm={async (p: Payment) => {
          if (c.status === 'open') await closeWithPayment(c.check_uuid, p)
          else await updatePayment(c.check_uuid, p)
          await done()
        }}
      />
    )
  }

  // Top up: record **only the part not yet collected**, through addPayment (which adds)
  // rather than updatePayment (which replaces) -- replacing would wipe what was collected before.
  if (sub === 'topup') {
    return (
      <PaymentSheet
        check={c}
        title={tr('Collect balance')}
        amount={due}
        collected={paid}
        onCancel={() => setSub(null)}
        onConfirm={async (p: Payment) => {
          await addPayment(c.check_uuid, p)
          await done()
        }}
      />
    )
  }

  if (sub === 'move') {
    return (
      <TransferSheet
        check={c}
        others={openChecks.filter((o) => o.check_uuid !== c.check_uuid)}
        onCancel={() => setSub(null)}
        onTransfer={async (label) => {
          await transferTable(c.check_uuid, label)
          await done()
        }}
        onMerge={async (uuids) => {
          await mergeTables(c.check_uuid, uuids)
          await done()
        }}
      />
    )
  }

  if (sub === 'edit') {
    return (
      <EditSheet
        check={c}
        prices={prices}
        period={period}
        onCancel={() => setSub(null)}
        onConfirm={async (guests: Guests, drinks: Drinks) => {
          await modifyTable(c.check_uuid, guests, drinks)
          await done()
        }}
      />
    )
  }

  if (sub === 'addlines' && menu && categories) {
    return (
      <MenuPicker
        menu={menu}
        categories={categories}
        modifiers={modifiers}
        title={`${tr(c.table_label)} · ${tr('Add dishes')}`}
        onCancel={() => setSub(null)}
        onConfirm={async (lines) => {
          await addLines(c.check_uuid, lines)
          await done()
        }}
      />
    )
  }

  if (sub === 'history') {
    return (
      <CheckHistory
        checkUuid={c.check_uuid}
        tableLabel={tr(c.table_label)}
        onClose={() => setSub(null)}
      />
    )
  }

  if (sub === 'void') {
    return (
      <div className="sheet-back" onClick={() => setSub(null)}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h2>{tr('Void')} {tr(c.table_label)}</h2>
          <p className="total">{money(c.est_cents)}</p>
          <p className="hint">
            {tr('Voiding takes this check out of sales. A reason is required and the operator is recorded. It can be restored at any time.')}
            {c.status === 'closed' && ' ' + tr('Restoring keeps it closed, with the same collect time.')}
          </p>
          <label className="reason">
            {tr('Reason')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={tr('e.g. guest cancelled / wrong table')}
              autoFocus
            />
          </label>
          <div className="sheet-actions">
            <button onClick={() => setSub(null)}>{tr('Cancel')}</button>
            <button
              className="primary danger"
              disabled={!reason.trim()}
              onClick={async () => {
                await voidTable(c.check_uuid, reason.trim())
                await done()
              }}
            >{tr('Void this check')}</button>
          </div>
        </div>
      </div>
    )
  }

  const guests = c.adult + c.child + c.senior
  const drinks = c.drink_adult + c.drink_child

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {tr(c.table_label)}
          <span className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}>
            {tr(STATUS_LABEL[c.status])}
          </span>
          {pending && <span className="tag warn">{tr('Pending')}</span>}
        </h2>

        <table className="kv">
          <tbody>
            <tr>
              <td className="dim">{tr('Tables open')}</td>
              <td className="num">
                {new Date(c.opened_at).toLocaleString(locale(), { hour12: false })}
              </td>
            </tr>
            <tr>
              <td className="dim">{tr('Buffet guests')}</td>
              <td className="num">
                {guests
                  ? `${guests}${paren(`${tr('Adult')} ${c.adult} · ${tr('Child')} ${c.child} · ${tr('Senior')} ${c.senior}`)}`
                  : '—'}
              </td>
            </tr>
            <tr>
              <td className="dim">{tr('Drinks')}</td>
              <td className="num">
                {drinks
                  ? `${drinks}${paren(`${tr('Adult')} ${c.drink_adult} · ${tr('Child')} ${c.drink_child}`)}`
                  : '—'}
              </td>
            </tr>
            {c.service_cents > 0 && (
              <tr>
                <td className="dim">{tr('Large-party fee 10%')}</td>
                <td className="num">{money(c.service_cents)}</td>
              </tr>
            )}
            {(c.tax_cents ?? 0) > 0 && (
              <tr>
                <td className="dim">{tr('Tax')}</td>
                <td className="num">{money(c.tax_cents)}</td>
              </tr>
            )}
            <tr>
              <td className="dim">{tr('Payment')}</td>
              <td className="num">
                {c.pay_method ? tr(PAY_LABEL[c.pay_method]) : tr('Not recorded')}
                {c.pay_method === 'mixed' &&
                  paren(`${tr('Cash')} ${money(c.pay_cash ?? 0)} / ${tr('Card')} ${money(c.pay_card ?? 0)}`)}
                {c.pay_note && ` · ${c.pay_note}`}
              </td>
            </tr>
            {/* The gap gets its own row, and only when it is not 0.
                This is what the month report's "payment does not match" looks like
                on one check -- a count in a report you cannot trace to a check and
                an amount tells you nothing. */}
            {due !== 0 && (
              <tr>
                <td className="dim">{tr(due > 0 ? 'Outstanding' : 'Overpaid (to refund)')}</td>
                <td className={`num ${due > 0 ? 'warnText' : 'badText'}`}>
                  {money(Math.abs(due))}
                  <span className="dim"> · {tr('Collected')} {money(paid)}</span>
                </td>
              </tr>
            )}
            {(c.customer_name || c.phone_last4) && (
              <tr>
                <td className="dim">{tr('Guests')}</td>
                <td className="num">
                  {c.customer_name ?? '—'}
                  {c.phone_last4 && ` · ${tr('last 4')} ${c.phone_last4}`}
                </td>
              </tr>
            )}
            <tr>
              <td className="dim">{tr('By')}</td>
              <td className="num">{operatorText(c)}</td>
            </tr>
            {c.void_reason && (
              <tr>
                <td className="dim">{tr('Void reason')}</td>
                <td className="num badText">{c.void_reason}</td>
              </tr>
            )}
          </tbody>
        </table>

        {(c.lines ?? []).length > 0 && (
          <>
            <div className="divider" />
            <table className="kv lines">
              <tbody>
                {(c.lines ?? []).map((l, i) => (
                  <tr key={i} className={l.voided ? 'voided' : ''}>
                    <td>
                      {lineName(l, menu)}
                      {l.qty > 1 && <span className="dim"> ×{l.qty}</span>}
                      {/* What was added has to be listed -- the kitchen cooks from it,
                          and "was I charged for the shrimp" has to be answerable.
                          The money is already in the unit price; this only breaks it out to read. */}
                      {(l.modifiers ?? []).length > 0 && (
                        <div className="line-mods">
                          {l.modifiers!.map((m, j) => (
                            <span key={j} className="chip sm">
                              {modLabel(m, modifiers)}
                              {m.price_cents > 0 && ` +${money(m.price_cents)}`}
                            </span>
                          ))}
                        </div>
                      )}
                      {l.notes && <div className="dim small">{l.notes}</div>}
                    </td>
                    <td className="num">{money(l.qty * l.unit_price_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <p className="total">{money(c.est_cents)}</p>

        {/* Refunds are never automatic. The system does not touch money, and only
            the person who handled it knows what was actually refunded; this says
            where the gap is and leaves the refund and the correction to them. */}
        {due < 0 && (
          <p className="hint warnbox">
            {tr('Collected')} {money(paid)}, {tr('over the check by')} {money(-due)} —
            {' '}{tr('Usually a dish was voided or the head count lowered after settling. Refund the difference, then use Change payment to record what was actually kept.')}</p>
        )}

        {pending && (
          <p className="hint">
            {tr('This check has changes')}<b>{tr('only on this iPad')}</b>{tr(' and has not reached the server. It sends automatically once online.')}</p>
        )}

        <div className="actiongrid">
          {menu && categories && c.status !== 'voided' && c.status !== 'merged' && (
            <button className="primaryish" onClick={() => setSub('addlines')}>{tr('Add dishes')}</button>
          )}
          <button onClick={() => setSub('history')}>{tr('History')}</button>
        </div>

        {c.status === 'merged' ? (
          <p className="hint">{tr('This check was merged into another; its lines moved and it is no longer counted.')}</p>
        ) : c.status === 'voided' ? (
          <div className="actiongrid">
            {manage ? (
              <button
                className="restore"
                onClick={async () => {
                  await restoreTable(c.check_uuid)
                  await done()
                }}
              >{tr('Restore this check')}</button>
            ) : (
              <p className="hint">{tr('Voided. Restoring needs manager rights.')}</p>
            )}
          </div>
        ) : (
          <div className="actiongrid">
            {c.status === 'open' && (
              <>
                <button className="primaryish" onClick={() => setSub('pay')}>{tr('Take payment')}</button>
                {/* A to-go check has no table, so transfer and merge mean nothing to it */}
                {c.source === 'dine_in' && (
                  <button onClick={() => setSub('move')}>{tr('Move / merge')}</button>
                )}
              </>
            )}
            {c.status === 'closed' && (
              <>
                {/* Dishes added after collecting -- the gap has to be collectable on
                    the spot, and as the **main action**. Hidden behind "change payment
                    method", staff simply re-enter the whole amount, and then it is
                    either under-collected or the earlier payment is wiped. */}
                {due > 0 && (
                  <button className="primaryish" onClick={() => setSub('topup')}>
                    {tr('Collect')} {money(due)}
                  </button>
                )}
                <button onClick={() => setSub('pay')}>{tr('Change payment')}</button>
              </>
            )}
            {/* Closed checks can be edited and voided too -- finding a mistake after collecting is routine */}
            {manage && <button onClick={() => setSub('edit')}>{tr('Edit')}</button>}
            {manage && (
              <button
                className="danger"
                onClick={() => {
                  setReason('')
                  setSub('void')
                }}
              >{tr('Void')}</button>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('Close')}</button>
        </div>
      </div>
    </div>
  )
}


/**
 * Showing the operator.
 *
 * `by` (who opened the table) may be missing in early data -- the operator was
 * not carried into the local mirror then. Missing falls back to `last_by`
 * rather than rendering "- - last: Alice": a dash plus "last" reads as "nobody
 * opened it but somebody changed it", which is harder to follow than just the name.
 */
export function operatorText(c: LocalCheck): string {
  const opened = c.by ?? c.last_by
  if (!opened) return '—'
  // tr() returns the input unchanged when it has no entry -- the seeded accounts
  // are named after roles and get translated, a real person's name does not. That is what the fallback is for.
  if (c.last_by && c.by && c.last_by !== c.by)
    return `${tr(c.by)} · ${tr('last')} ${tr(c.last_by)}`
  return tr(opened)
}
