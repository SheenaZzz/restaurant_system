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
 * 购物车里的一条。
 *
 * ⚠️ 不能再用「菜品 id → 份数」的 Map 了：同一道菜可以带**不同的加料**
 *    出现多次（一份加虾、一份加辣），Map 会把它们合成一条，
 *    结果就是客人要的东西上错。
 */
interface CartEntry {
  menu_item_id: number
  qty: number
  modifiers: PickedModifier[]
}

/** 加料相同的才算同一条，可以合并份数。 */
function modKey(mods: PickedModifier[]): string {
  return mods
    .map((m) => (m.modifier_id !== undefined ? `#${m.modifier_id}` : `~${tr(m.label)}@${m.price_cents}`))
    .sort()
    .join('|')
}

/**
 * 点菜。
 *
 * 100 多个单品，高峰期不可能靠滚动找 —— 所以左边分类、右边搜索，
 * 两条路都能到。搜索同时匹配中英文名，因为员工可能听到的是英文菜名
 * （客人念的），也可能是中文（后厨说的）。
 */
export default function MenuPicker({
  menu,
  categories,
  modifiers = [],
  onCancel,
  onConfirm,
  title = '点菜',
}: {
  menu: MenuItem[]
  categories: Category[]
  /** 加料目录。空数组时「定制」按钮仍可用（还能手写要求） */
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
  /** 正在定制哪道菜 */
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

  /** 一份的价钱 = 菜价 + 加料。和服务端 _add_lines 折进单价的算法一致。 */
  const perDish = (e: CartEntry) =>
    (byId.get(e.menu_item_id)?.price_cents ?? 0) +
    e.modifiers.reduce((a, m) => a + m.price_cents, 0)

  const total = cart.reduce((a, e) => a + e.qty * perDish(e), 0)
  const count = cart.reduce((a, e) => a + e.qty, 0)

  /** 无加料的快速加减 —— 高峰期最高频的动作，保持一点就加。 */
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

  /** 定制过的加进购物车：加料完全相同的合并份数，不同的各占一条。 */
  const addCustom = (id: number, qty: number, mods: PickedModifier[]) =>
    setCart((c) => {
      if (mods.length === 0) {
        // 定制页里什么都没选 = 普通下单
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

  /** 这道菜在购物车里的总份数（含各种加料版本），用于卡片上的角标 */
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
          placeholder={tr('搜菜名（中文或英文）')}
        />

        {/* 搜索时分类栏整个不渲染 —— 必须同时把网格改回单列。
            不改的话菜品列表会掉进那个 128px 的分类列里（它成了第一个
            网格子元素），右边一大片空着，看上去就是"搜索结果只有窄窄一条"。 */}
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
                  {/* 点菜名本身 = 直接加一份。
                      高峰期绝大多数菜是不带要求的，这条路必须最快 ——
                      要求先弹一个窗再让人点"确认"，一晚上多按几百次。 */}
                  <button className="mi-main" onClick={() => bump(m.id, 1)}>
                    <span className="mi-zh">{nameOf(m)}</span>
                    <span className="mi-en">{m.name_en}</span>
                    <span className="mi-price">{money(m.price_cents ?? 0)}</span>
                  </button>
                  {/* 要加辣/加虾/写要求的走这个按钮，不打断上面那条快路 */}
                  <button
                    className="mi-cust"
                    onClick={() => setCustomizing(m)}
                    title={tr('加辣、加料、特殊要求')}
                  >{tr('定制')}</button>
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
            {shown.length === 0 && <p className="hint">{tr('没有匹配的菜。')}</p>}
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
                {/* 加了什么必须写在车里 —— 只显示菜名的话，
                    "加虾的那份"和"没加的那份"长得一模一样，改都没法改 */}
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
          <button onClick={onCancel}>{tr('取消')}</button>
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
            {busy ? '…' : `${tr('确认')} ${count} · ${money(total)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Buffet To Go：秤上直接出金额，前台把数字录进来。
 * **不点菜、不称重量** —— 系统只负责把这笔钱记进总账。
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
        <h2>{tr('自助餐打包')}</h2>
        <p className="hint">{tr('秤上算出多少就录多少 —— 系统只负责记进总账，不做称重也不算单品。')}</p>
        <NumPad value={cents} onChange={setCents} />
        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('取消')}</button>
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
            {busy ? '…' : '建单'}
          </button>
        </div>
      </div>
    </div>
  )
}
