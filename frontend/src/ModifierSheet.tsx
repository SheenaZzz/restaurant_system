import { useState } from 'react'
import { modLabel, name as nameOf, tr } from './i18n'
import {
  money,
  type MenuItem,
  type Modifier,
  type PickedModifier,
} from './catalog'
import NumPad from './NumPad'

/**
 * Add-ons and special requests for one dish.
 *
 * Catalogue add-ons **send an id and no price**: the server looks the price up.
 * A client-sent amount would let anyone discount themselves -- the same rule everywhere in this project.
 *
 * A hand-typed request is the one exception, in the same class as weighing
 * Buffet To Go: that number **only exists at the counter**, agreed on the spot for what the guest asked.
 * So it is attributed to a person (sync_op carries user_id) and can be traced later.
 */
export default function ModifierSheet({
  item,
  modifiers,
  initial = [],
  initialQty = 1,
  onCancel,
  onConfirm,
}: {
  item: MenuItem
  modifiers: Modifier[]
  initial?: PickedModifier[]
  initialQty?: number
  onCancel: () => void
  onConfirm: (qty: number, picked: PickedModifier[]) => void
}) {
  const [qty, setQty] = useState(initialQty)
  const [ids, setIds] = useState<Set<number>>(
    () => new Set(initial.filter((p) => p.modifier_id !== undefined).map((p) => p.modifier_id!)),
  )
  // There can be several hand-typed requests ("no peanuts" plus "split onto two plates")
  const [custom, setCustom] = useState<{ label: string; price_cents: number }[]>(
    () => initial.filter((p) => p.modifier_id === undefined).map((p) => ({ label: p.label, price_cents: p.price_cents })),
  )
  const [draft, setDraft] = useState('')
  const [draftCents, setDraftCents] = useState(0)

  const chosen = modifiers.filter((m) => ids.has(m.id))
  // Add-ons are **per portion**: two dishes with shrimp is twice the money. Same as the server.
  const perDish =
    (item.price_cents ?? 0) +
    chosen.reduce((a, m) => a + m.price_cents, 0) +
    custom.reduce((a, c) => a + c.price_cents, 0)

  function build(): PickedModifier[] {
    return [
      // From the catalogue: **no price**, the server looks it up
      ...chosen.map((m) => ({ modifier_id: m.id, label: m.name_zh, price_cents: m.price_cents })),
      ...custom.map((c) => ({ label: c.label, price_cents: c.price_cents })),
    ]
  }

  function addDraft() {
    const label = draft.trim()
    if (!label) return
    setCustom((c) => [...c, { label, price_cents: draftCents }])
    setDraft('')
    setDraftCents(0)
  }

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet mod-sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {nameOf(item)}
          <span className="period-tag">{money(item.price_cents ?? 0)}</span>
        </h2>

        <div className="mod-split">
          <div className="mod-left">
            <div className="stepper">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
              <span className="sl">{tr('Qty')}</span>
              <span className="qty">{qty}</span>
              <button onClick={() => setQty((q) => q + 1)}>＋</button>
            </div>

            <h3 className="zone">{tr('Common requests')}</h3>
            <div className="mod-grid">
              {modifiers.map((m) => (
                <button
                  key={m.id}
                  className={ids.has(m.id) ? 'on' : ''}
                  onClick={() =>
                    setIds((s) => {
                      const n = new Set(s)
                      n.has(m.id) ? n.delete(m.id) : n.add(m.id)
                      return n
                    })
                  }
                >
                  <span className="m-name">{nameOf(m)}</span>
                  {/* Free ones show 0 rather than nothing -- a blank reads as "no price given" and costs a second of thought */}
                  <span className={`m-price${m.price_cents ? '' : ' free'}`}>
                    {m.price_cents ? `+${money(m.price_cents)}` : tr('Free')}
                  </span>
                </button>
              ))}
              {modifiers.length === 0 && (
                <p className="hint">{tr('Add-ons not loaded yet. Try again online.')}</p>
              )}
            </div>

            {custom.length > 0 && (
              <>
                <h3 className="zone">{tr('Custom requests')}</h3>
                <div className="mod-custom-list">
                  {custom.map((c, i) => (
                    <div key={i} className="mod-custom">
                      <span className="cc-label">{modLabel(c, modifiers)}</span>
                      <span className="cc-price">
                        {c.price_cents ? `+${money(c.price_cents)}` : tr('Free')}
                      </span>
                      <button
                        className="cc-del"
                        onClick={() => setCustom((x) => x.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="mod-right">
            {/* The note lives inside the label and **has to fit on one line** --
                a wrap costs 20px, and in short landscape every line competes with
                the keypad. How the price works is obvious from the keypad below. */}
            {/* "Add" sits on the same row as the input.
                 Below the keypad, as it was, short landscape pushes it outside the
                 scroll area -- and it is the one thing in this column that must
                 **always be visible**.
                 The button is outside the label: inside, tapping it also focuses the
                 input, which pops the system keyboard on iOS. */}
            <div className="cust-block">
              <label className="reason">
                {/* ⚠️ It has to be wrapped in a span. .reason is a flex column, so a
                    bare <small> becomes its own flex item on its own line -- nothing
                    to do with width, and the extra 20px comes straight out of the keypad. */}
                <span>
                  {tr('Custom request')} <small>{tr('price below')}</small>
                </span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={tr('e.g. no peanuts / split into two')}
                />
              </label>
              <button className="cust-add" disabled={!draft.trim()} onClick={addDraft}>{tr('Add')}</button>
            </div>

            {/* The amount and "clear" share one row.
                NumPad's own display (37px) and clear row (42px) are two separate
                rows; together those 80px come out of the keys -- which is why the
                keys were squeezed to 34px in landscape and looked cut off.
                Merged into one 40px row, the keys get it back.
                NumPad is shared by three screens, so it is not changed -- its own two rows are just hidden in this column. */}
            <div className="cust-amt">
              <span className="ca-val">{money(draftCents)}</span>
              <button className="ca-clear" onClick={() => setDraftCents(0)}>{tr('Clear')}</button>
            </div>

            <NumPad value={draftCents} onChange={setDraftCents} />
          </div>
        </div>

        <div className="mod-total">
          <span>
            {money(perDish)} / {tr('ea')} × {qty}
          </span>
          <strong>{money(perDish * qty)}</strong>
        </div>

        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('Cancel')}</button>
          <button
            className="primary"
            onClick={() => {
              // Typed something and confirmed without tapping "add to this dish" --
              // take it along, or staff believe it was recorded when it was lost
              const extra = draft.trim()
                ? [{ label: draft.trim(), price_cents: draftCents }]
                : []
              onConfirm(qty, [...build(), ...extra])
            }}
          >{tr('Confirm')}</button>
        </div>
      </div>
    </div>
  )
}
