import { useMemo, useState } from 'react'
import { listSep, modLabel, catLabel, name as nameOf, tr } from './i18n'
import {
  money,
  type Category,
  type MenuItem,
  type Modifier,
  type PickedModifier,
} from './catalog'
import type { NewLine } from './checks'
import ModifierSheet from './ModifierSheet'
import NumPad from './NumPad'

/**
 * One line in the cart.
 *
 * ⚠️ A "dish id -> quantity" Map no longer works: the same dish can appear
 *    several times with **different add-ons** (one with shrimp, one extra
 *    spicy), and a Map merges them into one line -- so the guest gets the wrong food.
 */
interface CartEntry {
  menu_item_id: number
  qty: number
  modifiers: PickedModifier[]
}

/** Only identical add-ons count as the same line and can merge quantities. */
function modKey(mods: PickedModifier[]): string {
  return mods
    .map((m) => (m.modifier_id !== undefined ? `#${m.modifier_id}` : `~${tr(m.label)}@${m.price_cents}`))
    .sort()
    .join('|')
}

/**
 * Ordering.
 *
 * Over a hundred dishes cannot be found by scrolling at peak, so categories on
 * the left and search on the right both reach them. Search matches Chinese and
 * English names, because staff may hear the English (from the guest) or the Chinese (from the kitchen).
 */
export default function MenuPicker({
  menu,
  categories,
  modifiers = [],
  onCancel,
  onConfirm,
  title = 'Order',
}: {
  menu: MenuItem[]
  categories: Category[]
  /** The add-on catalogue. "Customise" still works when it is empty (hand-typed requests) */
  modifiers?: Modifier[]
  onCancel: () => void
  onConfirm: (lines: NewLine[]) => void | Promise<void>
  title?: string
}) {
  const sellable = useMemo(
    () => menu.filter((m) => !m.is_buffet_dish && !m.open_price),
    [menu],
  )
  const cats = useMemo(
    () => categories.filter((c) => sellable.some((m) => m.category === c.key)),
    [categories, sellable],
  )

  const [cat, setCat] = useState(cats[0]?.key ?? '')
  const [q, setQ] = useState('')
  const [cart, setCart] = useState<CartEntry[]>([])
  const [busy, setBusy] = useState(false)
  /** Which dish is being customised */
  const [customizing, setCustomizing] = useState<MenuItem | null>(null)

  const shown = q.trim()
    ? sellable.filter((m) => {
        const k = q.trim().toLowerCase()
        return (
          m.name_en.toLowerCase().includes(k) || m.name_zh.includes(q.trim())
        )
      })
    : sellable.filter((m) => m.category === cat)

  const byId = new Map(sellable.map((m) => [m.id, m]))

  /** Price of one portion = dish + add-ons. Same arithmetic the server folds into the unit price. */
  const perDish = (e: CartEntry) =>
    (byId.get(e.menu_item_id)?.price_cents ?? 0) +
    e.modifiers.reduce((a, m) => a + m.price_cents, 0)

  const total = cart.reduce((a, e) => a + e.qty * perDish(e), 0)
  const count = cart.reduce((a, e) => a + e.qty, 0)

  /** Quick add and remove with no add-ons -- the most frequent action at peak, so one tap adds. */
  const bump = (id: number, d: number) =>
    setCart((c) => {
      const i = c.findIndex((e) => e.menu_item_id === id && e.modifiers.length === 0)
      if (i < 0) return d > 0 ? [...c, { menu_item_id: id, qty: d, modifiers: [] }] : c
      const next = [...c]
      const qty = next[i].qty + d
      if (qty <= 0) next.splice(i, 1)
      else next[i] = { ...next[i], qty }
      return next
    })

  /** Add a customised one: identical add-ons merge quantities, different ones get their own line. */
  const addCustom = (id: number, qty: number, mods: PickedModifier[]) =>
    setCart((c) => {
      if (mods.length === 0) {
        // Nothing chosen in the customise sheet = an ordinary order
        const i = c.findIndex((e) => e.menu_item_id === id && e.modifiers.length === 0)
        if (i < 0) return [...c, { menu_item_id: id, qty, modifiers: [] }]
        const next = [...c]
        next[i] = { ...next[i], qty: next[i].qty + qty }
        return next
      }
      const k = modKey(mods)
      const i = c.findIndex((e) => e.menu_item_id === id && modKey(e.modifiers) === k)
      if (i < 0) return [...c, { menu_item_id: id, qty, modifiers: mods }]
      const next = [...c]
      next[i] = { ...next[i], qty: next[i].qty + qty }
      return next
    })

  /** Total quantity of this dish in the cart (across add-on variants), for the badge on the card */
  const qtyOf = (id: number) =>
    cart.filter((e) => e.menu_item_id === id).reduce((a, e) => a + e.qty, 0)

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet menu-sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>

        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tr('Search dishes')}
        />

        {/* While searching, the category rail is not rendered at all -- the grid has
            to go back to one column at the same time, or the dish list falls into
            that 128px rail column (it becomes the first grid child), leaving the
            right-hand side empty and looking like "the results are one narrow strip". */}
        <div className={`menu-body${q.trim() ? ' searching' : ''}`}>
          {!q.trim() && (
            <div className="menu-cats">
              {cats.map((c) => (
                <button
                  key={c.key}
                  className={cat === c.key ? 'on' : ''}
                  onClick={() => setCat(c.key)}
                >
                  {catLabel(c)}
                </button>
              ))}
            </div>
          )}

          <div className="menu-items">
            {shown.map((m) => {
              const n = qtyOf(m.id)
              return (
                <div key={m.id} className={`mi${n ? ' on' : ''}`}>
                  {/* Tapping the name itself adds one.
                      Most dishes at peak carry no request, so this path has to be
                      the fastest -- a sheet plus a confirm tap is hundreds of extra taps a night. */}
                  <button className="mi-main" onClick={() => bump(m.id, 1)}>
                    <span className="mi-zh">{nameOf(m)}</span>
                    <span className="mi-en">{m.name_en}</span>
                    <span className="mi-price">{money(m.price_cents ?? 0)}</span>
                  </button>
                  {/* Extra spicy, add shrimp or a written request go through this button, without interrupting the fast path above */}
                  <button
                    className="mi-cust"
                    onClick={() => setCustomizing(m)}
                    title={tr('Spice, add-ons, special requests')}
                  >{tr('Options')}</button>
                  {n > 0 && (
                    <div className="mi-qty">
                      <button onClick={() => bump(m.id, -1)}>−</button>
                      <span>{n}</span>
                      <button onClick={() => bump(m.id, 1)}>+</button>
                    </div>
                  )}
                </div>
              )
            })}
            {shown.length === 0 && <p className="hint">{tr('No matching dishes.')}</p>}
          </div>
        </div>

        {count > 0 && (
          <div className="cart">
            {cart.map((e, i) => (
              <span
                key={`${e.menu_item_id}-${modKey(e.modifiers)}`}
                className={`chip${e.modifiers.length ? ' has-mod' : ''}`}
              >
                {nameOf(byId.get(e.menu_item_id))} ×{e.qty}
                {/* What was added has to appear in the cart -- with only the dish
                    name, "the one with shrimp" and "the one without" look identical and cannot be corrected */}
                {e.modifiers.length > 0 && (
                  <small>
                    {e.modifiers
                      .map((m) => {
                        const label = modLabel(m, modifiers)
                        return m.price_cents ? `${label}+${money(m.price_cents)}` : label
                      })
                      .join(listSep())}
                  </small>
                )}
                <button
                  className="chip-x"
                  onClick={() => setCart((c) => c.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {customizing && (
          <ModifierSheet
            item={customizing}
            modifiers={modifiers}
            onCancel={() => setCustomizing(null)}
            onConfirm={(qty, mods) => {
              addCustom(customizing.id, qty, mods)
              setCustomizing(null)
            }}
          />
        )}

        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('Cancel')}</button>
          <button
            className="primary"
            disabled={busy || count === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(
                  cart.map((e) => ({
                    menu_item_id: e.menu_item_id,
                    qty: e.qty,
                    modifiers: e.modifiers.length ? e.modifiers : undefined,
                  })),
                )
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : `${tr('Confirm')} ${count} · ${money(total)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Buffet To Go: the scale gives the amount and the front types it in.
 * **No dishes and no weighing** -- the system only records the money.
 */
export function TogoAmountSheet({
  item,
  onCancel,
  onConfirm,
}: {
  item: MenuItem
  onCancel: () => void
  onConfirm: (lines: NewLine[]) => void | Promise<void>
}) {
  const [cents, setCents] = useState(0)
  const [busy, setBusy] = useState(false)

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Buffet to go')}</h2>
        <p className="hint">{tr('Enter the amount from the scale. The system only records the total; it does not weigh anything or itemise it.')}</p>
        <NumPad value={cents} onChange={setCents} />
        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('Cancel')}</button>
          <button
            className="primary"
            disabled={busy || cents <= 0}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm([
                  { menu_item_id: item.id, qty: 1, amount_cents: cents },
                ])
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : tr('Create')}
          </button>
        </div>
      </div>
    </div>
  )
}
