import { useCallback, useEffect, useMemo, useState } from 'react'
import { catLabel, tr, paren } from './i18n'
import { authFetch } from './auth'
import { money, refreshCatalog } from './catalog'

/**
 * 老板改价页。人头价 / 菜价 / 加料目录。
 *
 * ⚠️ 只给 admin。DESIGN.md 的权限矩阵里「改菜单/价格」只有老板打勾 ——
 *    改价能让每一单的钱都变，和录小费、设税率不是一个量级。
 *    前端这层只是门控，真正拦住的是服务端的 require_role("admin")。
 *
 * 三块的**改价语义不一样**，界面上必须说清楚，否则老板会以为都一样：
 *   · 人头价：换生效日 = 新增一版，旧价原样留着（月报要回查）
 *   · 菜价  ：直接改，因为账单落的是 unit_price_cents 快照
 *   · 加料  ：整份替换，顺序就是列表顺序；删掉的是停用不是删除
 */

interface BuffetRow {
  period_kind: 'lunch' | 'dinner'
  charge_kind: 'admission' | 'drink'
  guest_type: 'adult' | 'child' | 'senior'
  price_cents: number
  effective_from: string
}
interface MenuRow {
  id: number
  name_zh: string
  name_en: string
  category: string
  price_cents: number | null
  open_price: boolean
  is_buffet_dish: boolean
  active: boolean
  sort_order: number
}
interface ModRow {
  id: number | null
  name_zh: string
  name_en: string
  price_cents: number
  active?: boolean
}
interface Pricing {
  buffet: BuffetRow[]
  buffet_effective_from: string | null
  menu: MenuRow[]
  modifiers: (ModRow & { id: number; sort_order: number; active: boolean })[]
  categories: { key: string; label: string }[]
  business_date: string
}

const PERIOD: Record<string, string> = { lunch: '午市', dinner: '晚市' }
const KIND: Record<string, string> = { admission: '自助餐', drink: '饮料' }
const GUEST: Record<string, string> = { adult: '成人', child: '儿童', senior: '长者' }

type Tab = 'buffet' | 'menu' | 'mods'

export default function AdminView() {
  const [data, setData] = useState<Pricing | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('buffet')

  // 各自的草稿。**不直接改 data** —— 没保存就切走要能原样回来
  const [buffet, setBuffet] = useState<Record<string, number>>({})
  const [effFrom, setEffFrom] = useState('')
  const [menuEdit, setMenuEdit] = useState<Record<number, { price: number | null; active: boolean }>>({})
  const [mods, setMods] = useState<ModRow[]>([])
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setErr(null)
    try {
      const res = await authFetch('/api/admin/pricing')
      if (res.status === 403) throw new Error('403')
      if (!res.ok) throw new Error(String(res.status))
      const d: Pricing = await res.json()
      setData(d)
      setBuffet(Object.fromEntries(d.buffet.map((b) => [bkey(b), b.price_cents])))
      setEffFrom(d.business_date)
      setMenuEdit(
        Object.fromEntries(d.menu.map((m) => [m.id, { price: m.price_cents, active: m.active }])),
      )
      setMods(d.modifiers.filter((m) => m.active).map((m) => ({ ...m })))
    } catch (e) {
      setErr(String(e).includes('403') ? '只有老板账号能改价' : '需要联网才能读取')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(path: string, body: unknown, what: string) {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const res = await authFetch(`/api/admin/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(String(res.status))
      const d: Pricing = await res.json()
      setData(d)
      setBuffet(Object.fromEntries(d.buffet.map((b) => [bkey(b), b.price_cents])))
      setMenuEdit(
        Object.fromEntries(d.menu.map((m) => [m.id, { price: m.price_cents, active: m.active }])),
      )
      setMods(d.modifiers.filter((m) => m.active).map((m) => ({ ...m })))
      // 前台缓存的菜单/价格/加料都从 catalog 来 —— 不刷新的话
      // iPad 上还会用旧价显示，直到下次冷启动
      await refreshCatalog()
      setMsg(`${what}已保存。前台会用新价，已经开出去的单不受影响。`)
    } catch {
      setErr('保存失败，检查网络后重试')
    } finally {
      setBusy(false)
    }
  }

  const cats = useMemo(() => data?.categories ?? [], [data])
  const shownMenu = useMemo(() => {
    if (!data) return []
    const k = q.trim().toLowerCase()
    return data.menu.filter(
      (m) =>
        !m.is_buffet_dish &&
        (!k || m.name_zh.includes(q.trim()) || m.name_en.toLowerCase().includes(k)),
    )
  }, [data, q])

  if (err && !data) return <p className="hint">{err}</p>
  if (!data) return <p className="hint">{tr('载入中…')}</p>

  const buffetDirty = data.buffet.some((b) => buffet[bkey(b)] !== b.price_cents)
    || effFrom !== data.buffet_effective_from
  const menuDirty = data.menu.some(
    (m) => menuEdit[m.id]?.price !== m.price_cents || menuEdit[m.id]?.active !== m.active,
  )
  const modsDirty =
    mods.length !== data.modifiers.filter((m) => m.active).length ||
    mods.some((m, i) => {
      const o = data.modifiers.filter((x) => x.active)[i]
      return !o || o.id !== m.id || o.name_zh !== m.name_zh || o.price_cents !== m.price_cents
    })

  return (
    <>
      <div className="tabs sub">
        <button className={tab === 'buffet' ? 'on' : ''} onClick={() => setTab('buffet')}>
          {tr('自助餐 / 饮料')}{buffetDirty && <span className="cnt warn">{tr('改')}</span>}
        </button>
        <button className={tab === 'menu' ? 'on' : ''} onClick={() => setTab('menu')}>
          {tr('菜单价')}{menuDirty && <span className="cnt warn">{tr('改')}</span>}
        </button>
        <button className={tab === 'mods' ? 'on' : ''} onClick={() => setTab('mods')}>
          {tr('常用要求')}{modsDirty && <span className="cnt warn">{tr('改')}</span>}
        </button>
      </div>

      {err && <p className="err">{err}</p>}
      {msg && <p className="hint">{msg}</p>}

      {tab === 'buffet' && (
        <>
          <p className="hint warnbox">
            {tr('换一个生效日 = 新增一版，旧价原样留着（月报和对账要回查当时卖多少钱）。同一个生效日重复保存 = 改回来，不算调价。')}
          </p>

          <label className="reason">
            {tr('生效日期')}
            <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
          </label>
          <p className="hint">
            {tr('当前这版生效于')} <b>{data.buffet_effective_from ?? '—'}</b>
            {' · '}{tr('今天的营业日')} <b>{data.business_date}</b>
          </p>

          {(['lunch', 'dinner'] as const).map((p) => (
            <section key={p}>
              <h3 className="zone">{tr(PERIOD[p])}</h3>
              <div className="price-grid">
                {data.buffet
                  .filter((b) => b.period_kind === p)
                  .map((b) => (
                    <label key={bkey(b)} className="price-cell">
                      <span className="pc-label">
                        {tr(KIND[b.charge_kind])} · {tr(GUEST[b.guest_type])}
                      </span>
                      <Money
                        cents={buffet[bkey(b)] ?? 0}
                        onChange={(v) => setBuffet((s) => ({ ...s, [bkey(b)]: v }))}
                      />
                      {buffet[bkey(b)] !== b.price_cents && (
                        <span className="pc-was">原 {money(b.price_cents)}</span>
                      )}
                    </label>
                  ))}
              </div>
            </section>
          ))}

          <div className="sheet-actions">
            <button onClick={load} disabled={busy}>{tr('撤销改动')}</button>
            <button
              className="primary"
              disabled={busy || !buffetDirty || !effFrom}
              onClick={() =>
                save(
                  'buffet-prices',
                  {
                    effective_from: effFrom,
                    rows: data.buffet.map((b) => ({
                      period_kind: b.period_kind,
                      charge_kind: b.charge_kind,
                      guest_type: b.guest_type,
                      price_cents: buffet[bkey(b)] ?? b.price_cents,
                    })),
                  },
                  '人头价',
                )
              }
            >
              {busy ? tr('保存中…') : buffetDirty ? tr('保存人头价') : tr('未改动')}
            </button>
          </div>
        </>
      )}

      {tab === 'menu' && (
        <>
          <p className="hint">
            改菜价<b>{tr('不影响已经开出去的单')}</b>{tr('—— 下单时存的是当时的价格快照。 下架的菜不会再出现在点菜页，但历史账单照常显示。')}</p>
          <input
            className="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tr('搜菜名（中文或英文）')}
          />

          {cats.map((c) => {
            const items = shownMenu.filter((m) => m.category === c.key)
            if (!items.length) return null
            return (
              <section key={c.key}>
                <h3 className="zone">{catLabel(c)}{paren(String(items.length))}</h3>
                <div className="price-grid wide">
                  {items.map((m) => {
                    const e = menuEdit[m.id]
                    const changed = e?.price !== m.price_cents || e?.active !== m.active
                    return (
                      <div key={m.id} className={`price-cell${changed ? ' changed' : ''}${e?.active ? '' : ' off'}`}>
                        <span className="pc-label">
                          {m.name_zh}
                          <small>{m.name_en}</small>
                        </span>
                        {m.open_price ? (
                          // 按重量称的条目没有固定价，服务端也拒绝设死
                          <span className="pc-open">{tr('现场输金额')}</span>
                        ) : (
                          <Money
                            cents={e?.price ?? 0}
                            onChange={(v) =>
                              setMenuEdit((s) => ({ ...s, [m.id]: { ...s[m.id], price: v } }))
                            }
                          />
                        )}
                        <button
                          className={`pc-toggle${e?.active ? ' on' : ''}`}
                          onClick={() =>
                            setMenuEdit((s) => ({ ...s, [m.id]: { ...s[m.id], active: !s[m.id].active } }))
                          }
                        >
                          {e?.active ? '在售' : '已下架'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}

          <div className="sheet-actions">
            <button onClick={load} disabled={busy}>{tr('撤销改动')}</button>
            <button
              className="primary"
              disabled={busy || !menuDirty}
              onClick={() =>
                save(
                  'menu-items',
                  {
                    items: data.menu.map((m) => ({
                      id: m.id,
                      price_cents: menuEdit[m.id]?.price ?? m.price_cents,
                      active: menuEdit[m.id]?.active ?? m.active,
                    })),
                  },
                  '菜价',
                )
              }
            >
              {busy ? tr('保存中…') : menuDirty ? tr('保存菜价') : tr('未改动')}
            </button>
          </div>
        </>
      )}

      {tab === 'mods' && (
        <>
          <p className="hint">
            点菜时「定制」里的常用要求。<b>{tr('上下箭头调顺序')}</b>{tr('，顺序就是点菜页的显示顺序。 免费的填 0。')}</p>
          <p className="hint warnbox">
            删掉一条是<b>{tr('停用，不是删除')}</b>{tr('—— 历史账单上加过这一项的记录必须留着。 停用后它不再出现在点菜页，已经开出去的单照常显示。')}</p>

          <div className="mod-edit-list">
            {mods.map((m, i) => (
              <div key={m.id ?? `new-${i}`} className="mod-edit">
                <div className="me-move">
                  <button disabled={i === 0} onClick={() => setMods(swap(mods, i, i - 1))}>↑</button>
                  <button disabled={i === mods.length - 1} onClick={() => setMods(swap(mods, i, i + 1))}>↓</button>
                </div>
                <input
                  className="me-name"
                  // 这里在**编辑中文名**，不是显示 —— 绑 name_zh，不跟界面语言走
                  value={m.name_zh}
                  onChange={(e) => setMods(patch(mods, i, { name_zh: e.target.value }))}
                  placeholder={tr('中文名，例如 加虾')}
                />
                <input
                  className="me-en"
                  value={m.name_en}
                  onChange={(e) => setMods(patch(mods, i, { name_en: e.target.value }))}
                  placeholder="English"
                />
                <Money
                  cents={m.price_cents}
                  onChange={(v) => setMods(patch(mods, i, { price_cents: v }))}
                />
                <button className="me-del" onClick={() => setMods(mods.filter((_, j) => j !== i))}>{tr('删除')}</button>
              </div>
            ))}
          </div>

          <button
            className="linkbtn wide"
            onClick={() => setMods([...mods, { id: null, name_zh: '', name_en: '', price_cents: 0 }])}
          >{tr('＋ 加一条')}</button>

          <div className="sheet-actions">
            <button onClick={load} disabled={busy}>{tr('撤销改动')}</button>
            <button
              className="primary"
              disabled={busy || !modsDirty || mods.some((m) => !m.name_zh.trim())}
              onClick={() =>
                save(
                  'modifiers',
                  {
                    rows: mods.map((m) => ({
                      id: m.id ?? undefined,
                      name_zh: m.name_zh.trim(),
                      name_en: m.name_en.trim(),
                      price_cents: m.price_cents,
                    })),
                  },
                  '常用要求',
                )
              }
            >
              {busy ? tr('保存中…') : modsDirty ? tr('保存常用要求') : tr('未改动')}
            </button>
          </div>
        </>
      )}
    </>
  )
}

const bkey = (b: { period_kind: string; charge_kind: string; guest_type: string }) =>
  `${b.period_kind}/${b.charge_kind}/${b.guest_type}`

function swap<T>(a: T[], i: number, j: number): T[] {
  const n = [...a]
  ;[n[i], n[j]] = [n[j], n[i]]
  return n
}
function patch(a: ModRow[], i: number, p: Partial<ModRow>): ModRow[] {
  const n = [...a]
  n[i] = { ...n[i], ...p }
  return n
}

/**
 * 金额输入。**按元输入、按分存**。
 *
 * 这一页是老板在办公室慢慢改的，不是高峰期盲按 —— 所以用普通输入框
 * 而不是 POS 键盘：一次要改几十个价，弹键盘反而慢。
 * 但存的仍然是分，绝不用浮点算钱。
 */
function Money({ cents, onChange }: { cents: number; onChange: (cents: number) => void }) {
  const [text, setText] = useState((cents / 100).toFixed(2))
  useEffect(() => setText((cents / 100).toFixed(2)), [cents])
  return (
    <span className="money-in">
      <span className="mi-sign">$</span>
      <input
        value={text}
        inputMode="decimal"
        onChange={(e) => {
          setText(e.target.value)
          const v = Number(e.target.value)
          // 四舍五入到分再存 —— 输 "12.345" 不能变成 1234.5 分
          if (Number.isFinite(v) && v >= 0) onChange(Math.round(v * 100))
        }}
        onBlur={() => setText((cents / 100).toFixed(2))}
      />
    </span>
  )
}
