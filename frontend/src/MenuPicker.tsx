import { useMemo, useState } from 'react'
import { money, type Category, type MenuItem } from './catalog'
import type { NewLine } from './checks'
import NumPad from './NumPad'

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
  onCancel,
  onConfirm,
  title = '点菜',
}: {
  menu: MenuItem[]
  categories: Category[]
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
  const [cart, setCart] = useState<Map<number, number>>(new Map())
  const [busy, setBusy] = useState(false)

  const shown = q.trim()
    ? sellable.filter((m) => {
        const k = q.trim().toLowerCase()
        return (
          m.name_en.toLowerCase().includes(k) || m.name_zh.includes(q.trim())
        )
      })
    : sellable.filter((m) => m.category === cat)

  const byId = new Map(sellable.map((m) => [m.id, m]))
  const total = [...cart].reduce(
    (a, [id, n]) => a + n * (byId.get(id)?.price_cents ?? 0),
    0,
  )
  const count = [...cart.values()].reduce((a, n) => a + n, 0)

  const bump = (id: number, d: number) =>
    setCart((c) => {
      const n = new Map(c)
      const v = (n.get(id) ?? 0) + d
      if (v <= 0) n.delete(id)
      else n.set(id, v)
      return n
    })

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet menu-sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>

        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜菜名（中文或英文）"
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
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <div className="menu-items">
            {shown.map((m) => {
              const n = cart.get(m.id) ?? 0
              return (
                <div key={m.id} className={`mi${n ? ' on' : ''}`}>
                  <button className="mi-main" onClick={() => bump(m.id, 1)}>
                    <span className="mi-zh">{m.name_zh}</span>
                    <span className="mi-en">{m.name_en}</span>
                    <span className="mi-price">{money(m.price_cents ?? 0)}</span>
                  </button>
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
            {shown.length === 0 && <p className="hint">没有匹配的菜。</p>}
          </div>
        </div>

        {count > 0 && (
          <div className="cart">
            {[...cart].map(([id, n]) => (
              <span key={id} className="chip">
                {byId.get(id)?.name_zh} ×{n}
              </span>
            ))}
          </div>
        )}

        <div className="sheet-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={busy || count === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(
                  [...cart].map(([menu_item_id, qty]) => ({ menu_item_id, qty })),
                )
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : `确认 ${count} 项 · ${money(total)}`}
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
        <h2>自助餐打包</h2>
        <p className="hint">
          秤上算出多少就录多少 —— 系统只负责记进总账，不做称重也不算单品。
        </p>
        <NumPad value={cents} onChange={setCents} />
        <div className="sheet-actions">
          <button onClick={onCancel}>取消</button>
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
