import { useCallback, useEffect, useMemo, useState } from 'react'
import { catLabel, tr, paren } from './i18n'
import { authFetch, getIdentity, refreshIdentity } from './auth'
import { money, refreshCatalog } from './catalog'

/**
 * The owner's back office: per-head prices / dish prices / add-ons / accounts.
 *
 * ⚠️ admin only. In DESIGN.md's permission matrix, "edit menu / prices" is
 *    ticked for the owner alone -- a price change moves the money on every
 *    check, which is not the same league as entering tips or setting a rate.
 *    This layer only gates the UI; require_role("admin") on the server is what stops it.
 *
 * The three blocks have **different edit semantics**, and the page has to say
 * so or the owner will assume they are alike:
 *   - per-head: a new effective date adds a version, the old prices stay (the month report looks them up)
 *   - dishes:   edited in place, because a check stores a unit_price_cents snapshot
 *   - add-ons:  replaced wholesale, order = list order; removing deactivates rather than deletes
 *
 * The accounts tab only does "see the names, change the names, reset the
 * password". **The password itself cannot be seen** -- it is an argon2 hash and
 * irreversible. The page has to say that, or the owner will assume they simply cannot find it.
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

/** One slot on the buffet. No id = the owner just added it. */
interface BoardRow {
  id: number | null
  page: number
  pos: number
  name_zh: string
  name_en: string
}

interface UserRow {
  id: number
  username: string
  display_name: string
  role: string
  role_label: string
  active: boolean
  /** How many sessions this account has that are neither expired nor signed out */
  sessions: number
}

const PERIOD: Record<string, string> = { lunch: 'Lunch', dinner: 'Dinner' }
const KIND: Record<string, string> = { admission: 'Buffet', drink: 'Drinks' }
const GUEST: Record<string, string> = { adult: 'Adult', child: 'Child', senior: 'Senior' }

type Tab = 'buffet' | 'menu' | 'mods' | 'users' | 'board'

export default function AdminView() {
  const [data, setData] = useState<Pricing | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('buffet')

  // A draft per section. **data is never edited directly** -- switching away without saving has to come back unchanged
  const [buffet, setBuffet] = useState<Record<string, number>>({})
  const [effFrom, setEffFrom] = useState('')
  const [menuEdit, setMenuEdit] = useState<Record<number, { price: number | null; active: boolean }>>({})
  const [mods, setMods] = useState<ModRow[]>([])
  const [q, setQ] = useState('')

  // Accounts are fetched separately: the pricing page is opened daily, accounts twice a year.
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [uEdit, setUEdit] = useState<Record<number, { username: string; display_name: string }>>({})
  const [pw, setPw] = useState<Record<number, string>>({})
  const [me, setMe] = useState<string | null>(null)

  // The buffet board. One board for lunch and one for dinner, saved separately.
  const [board, setBoard] = useState<Record<string, BoardRow[]> | null>(null)
  const [bPeriod, setBPeriod] = useState<'lunch' | 'dinner'>('lunch')
  const [bDraft, setBDraft] = useState<Record<string, BoardRow[]>>({})

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
      setErr(tr(String(e).includes('403') ? 'Only the owner account can change prices' : 'Needs a connection to load this'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const takeUsers = useCallback((list: UserRow[]) => {
    setUsers(list)
    setUEdit(
      Object.fromEntries(
        list.map((u) => [u.id, { username: u.username, display_name: u.display_name }]),
      ),
    )
    setPw({})
  }, [])

  const loadUsers = useCallback(async () => {
    setErr(null)
    try {
      const res = await authFetch('/api/admin/users')
      if (!res.ok) throw new Error(String(res.status))
      takeUsers(((await res.json()) as { users: UserRow[] }).users)
      setMe((await getIdentity())?.username ?? null)
    } catch {
      setErr(tr('Needs a connection to load this'))
    }
  }, [takeUsers])

  useEffect(() => {
    if (tab === 'users' && users === null) void loadUsers()
  }, [tab, users, loadUsers])

  const takeBoard = useCallback((b: Record<string, BoardRow[]>) => {
    setBoard(b)
    setBDraft({ lunch: [...(b.lunch ?? [])], dinner: [...(b.dinner ?? [])] })
  }, [])

  const loadBoardRows = useCallback(async () => {
    setErr(null)
    try {
      const res = await authFetch('/api/admin/buffet-board')
      if (!res.ok) throw new Error(String(res.status))
      takeBoard(((await res.json()) as { board: Record<string, BoardRow[]> }).board)
    } catch {
      setErr(tr('Needs a connection to load this'))
    }
  }, [takeBoard])

  useEffect(() => {
    if (tab === 'board' && board === null) void loadBoardRows()
  }, [tab, board, loadBoardRows])

  /** Saving a board refreshes the catalog -- the refill page reads the cached copy. */
  async function saveBoard() {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const rows = (bDraft[bPeriod] ?? []).filter((r) => r.name_zh.trim())
      const res = await authFetch('/api/admin/buffet-board', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_kind: bPeriod, rows }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.detail ?? String(res.status))
      }
      takeBoard(((await res.json()) as { board: Record<string, BoardRow[]> }).board)
      await refreshCatalog()
      setMsg(tr('Board saved. The refill page has it already.'))
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

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
      // The floor's cached menu, prices and add-ons all come from the catalog --
      // without a refresh the iPad keeps showing the old prices until its next cold start
      await refreshCatalog()
      setMsg(`${what} · ${tr('saved. The floor will use the new prices; checks already open are unaffected.')}`)
    } catch {
      setErr(tr('Save failed, check the connection and retry'))
    } finally {
      setBusy(false)
    }
  }

  /** Account writes. All three return the whole list, which replaces local state. */
  async function saveUser(path: string, body: unknown, ok: string) {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const res = await authFetch(`/api/admin/${path}`, {
        method: path.endsWith('/password') ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        // A duplicate username is the only error the owner will really hit, so it
        // is worth a translated sentence. Everything else passes the server's
        // detail through -- those should not happen, and the raw text helps more
        // than a vague translation.
        if (res.status === 409) throw new Error(tr('That username is already taken'))
        const d = await res.json().catch(() => null)
        throw new Error(d?.detail ?? String(res.status))
      }
      takeUsers(((await res.json()) as { users: UserRow[] }).users)
      // When it is their own name, the cached identity goes stale (the header still shows the old one)
      await refreshIdentity().catch(() => null)
      setMe((await getIdentity())?.username ?? null)
      setMsg(ok)
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  /** Edit one slot. An empty one becomes a new row (id=null -> the server adds it). */
  function setSlot(page: number, pos: number, patch: Partial<BoardRow>) {
    setBDraft((s) => {
      const rows = [...(s[bPeriod] ?? [])]
      const i = rows.findIndex((r) => r.page === page && r.pos === pos)
      if (i < 0) {
        rows.push({ id: null, page, pos, name_zh: '', name_en: '', ...patch })
      } else {
        rows[i] = { ...rows[i], ...patch }
      }
      return { ...s, [bPeriod]: rows }
    })
  }

  /** Clear a slot. It is then absent from the saved list -> the server deactivates it (never deletes). */
  function clearSlot(page: number, pos: number) {
    setBDraft((s) => ({
      ...s,
      [bPeriod]: (s[bPeriod] ?? []).filter((r) => !(r.page === page && r.pos === pos)),
    }))
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
  if (!data) return <p className="hint">{tr('Loading…')}</p>

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
          {tr('Buffet & drinks')}{buffetDirty && <span className="cnt warn">{tr('edited')}</span>}
        </button>
        <button className={tab === 'menu' ? 'on' : ''} onClick={() => setTab('menu')}>
          {tr('Menu prices')}{menuDirty && <span className="cnt warn">{tr('edited')}</span>}
        </button>
        <button className={tab === 'mods' ? 'on' : ''} onClick={() => setTab('mods')}>
          {tr('Common requests')}{modsDirty && <span className="cnt warn">{tr('edited')}</span>}
        </button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
          {tr('Buffet board')}
        </button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
          {tr('Accounts')}
        </button>
      </div>

      {err && <p className="err">{err}</p>}
      {msg && <p className="hint">{msg}</p>}

      {tab === 'buffet' && (
        <>
          <p className="hint warnbox">
            {tr('A new effective date adds a version and keeps the old prices — reports and reconciliation need to know what a seat cost on a given day. Saving twice on the same date is a correction, not a price change.')}
          </p>

          <label className="reason">
            {tr('Effective from')}
            <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
          </label>
          <p className="hint">
            {tr('This version applies from')} <b>{data.buffet_effective_from ?? '—'}</b>
            {' · '}{tr("today's business day is")} <b>{data.business_date}</b>
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
                        <span className="pc-was">{tr('was')} {money(b.price_cents)}</span>
                      )}
                    </label>
                  ))}
              </div>
            </section>
          ))}

          <div className="sheet-actions">
            <button onClick={load} disabled={busy}>{tr('Discard changes')}</button>
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
                  tr('Per-head prices'),
                )
              }
            >
              {busy ? tr('Saving…') : buffetDirty ? tr('Save buffet prices') : tr('No changes')}
            </button>
          </div>
        </>
      )}

      {tab === 'menu' && (
        <>
          <p className="hint">
            {tr('Changing a dish price does not touch checks already open — the price is snapshotted when the dish is ordered. A dish taken off keeps showing on past checks.')}
          </p>
          <input
            className="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tr('Search dishes')}
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
                          // Items sold by weight have no fixed price, and the server refuses to pin one
                          <span className="pc-open">{tr('Amount entered on the spot')}</span>
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
                          {e?.active ? tr('On sale') : tr('Off menu')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}

          <div className="sheet-actions">
            <button onClick={load} disabled={busy}>{tr('Discard changes')}</button>
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
                  tr('Dish prices'),
                )
              }
            >
              {busy ? tr('Saving…') : menuDirty ? tr('Save menu prices') : tr('No changes')}
            </button>
          </div>
        </>
      )}

      {tab === 'mods' && (
        <>
          <p className="hint">
            {tr('The add-ons offered under "Customise" when ordering. The arrows set the order they appear in. Put 0 for free ones.')}
          </p>
          <p className="hint warnbox">
            {tr('Removing one deactivates it rather than deleting it — past checks that used it have to keep their record. It stops appearing when ordering; existing checks still show it.')}
          </p>

          <div className="mod-edit-list">
            {mods.map((m, i) => (
              <div key={m.id ?? `new-${i}`} className="mod-edit">
                <div className="me-move">
                  <button disabled={i === 0} onClick={() => setMods(swap(mods, i, i - 1))}>↑</button>
                  <button disabled={i === mods.length - 1} onClick={() => setMods(swap(mods, i, i + 1))}>↓</button>
                </div>
                <input
                  className="me-name"
                  // This **edits the Chinese name**, it does not display one -- bound to name_zh, not to the interface language
                  value={m.name_zh}
                  onChange={(e) => setMods(patch(mods, i, { name_zh: e.target.value }))}
                  placeholder={tr('Name, e.g. Add shrimp')}
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
                <button className="me-del" onClick={() => setMods(mods.filter((_, j) => j !== i))}>{tr('Delete')}</button>
              </div>
            ))}
          </div>

          <button
            className="linkbtn wide"
            onClick={() => setMods([...mods, { id: null, name_zh: '', name_en: '', price_cents: 0 }])}
          >{tr('+ Add one')}</button>

          <div className="sheet-actions">
            <button onClick={load} disabled={busy}>{tr('Discard changes')}</button>
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
                  tr('Common requests'),
                )
              }
            >
              {busy ? tr('Saving…') : modsDirty ? tr('Save requests') : tr('No changes')}
            </button>
          </div>
        </>
      )}

      {tab === 'board' && (
        <>
          <p className="hint">
            {tr('The dishes out on the buffet. Three pages of ten, one board for lunch and one for dinner, shown in this order.')}
          </p>
          <p className="hint warnbox">
            {tr('Renaming keeps the same dish and its history. To put a different dish in a slot, clear it first and type the new one — renaming in place would hand the old dish’s history to the new one.')}
          </p>

          <div className="seg">
            {(['lunch', 'dinner'] as const).map((p) => (
              <button key={p} className={bPeriod === p ? 'on' : ''} onClick={() => setBPeriod(p)}>
                {tr(p === 'lunch' ? 'Lunch' : 'Dinner')}
              </button>
            ))}
          </div>

          {board === null ? (
            <p className="hint">{tr('Loading…')}</p>
          ) : (
            <>
              {[1, 2, 3].map((pg) => (
                <section key={pg}>
                  <h3 className="zone">{tr('Page N').replace('N', String(pg))}</h3>
                  <div className="board-edit">
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((pos) => {
                      const row = (bDraft[bPeriod] ?? []).find(
                        (r) => r.page === pg && r.pos === pos,
                      )
                      return (
                        <div key={pos} className={`board-row${row ? '' : ' blank'}`}>
                          <span className="bp">{pos}</span>
                          <input
                            // What is edited is the **Chinese name**; it does not follow the interface language
                            value={row?.name_zh ?? ''}
                            placeholder={tr('empty')}
                            onChange={(e) => setSlot(pg, pos, { name_zh: e.target.value })}
                          />
                          <input
                            className="be"
                            value={row?.name_en ?? ''}
                            placeholder="English"
                            onChange={(e) => setSlot(pg, pos, { name_en: e.target.value })}
                          />
                          <button
                            className="me-del"
                            disabled={!row}
                            onClick={() => clearSlot(pg, pos)}
                          >
                            {tr('Clear')}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}

              <div className="sheet-actions">
                <button onClick={loadBoardRows} disabled={busy}>{tr('Discard changes')}</button>
                <button className="primary" disabled={busy} onClick={saveBoard}>
                  {busy ? tr('Saving…') : tr('Save this board')}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'users' && (
        <>
          <p className="hint">
            {tr('One account per person. The name here is what shows up as "who did this" on a check.')}
          </p>
          <p className="hint warnbox">
            {tr('Passwords are stored as a one-way hash, so they cannot be shown — only replaced. Resetting one signs that account out on every device (within 15 minutes).')}
          </p>

          {users === null ? (
            <p className="hint">{tr('Loading…')}</p>
          ) : (
            <div className="acct-list">
              {users.map((u) => {
                const e = uEdit[u.id]
                const dirty =
                  !!e && (e.username !== u.username || e.display_name !== u.display_name)
                const isMe = u.username === me
                return (
                  <section key={u.id} className="acct">
                    <div className="ac-top">
                      <span className="ac-role">
                        {tr(u.role_label)}
                      </span>
                      {isMe && <span className="cnt">{tr('You')}</span>}
                      <span className="ac-sess">
                        {u.sessions > 0
                          ? `${u.sessions} ${tr('signed in')}`
                          : tr('No device signed in')}
                      </span>
                    </div>

                    <label className="reason">
                      {tr('Display name')}
                      <input
                        // A display name is **data** (it appears on checks), so following the interface language would make no sense
                        value={e?.display_name ?? ''}
                        onChange={(ev) =>
                          setUEdit((s) => ({
                            ...s,
                            [u.id]: { ...s[u.id], display_name: ev.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className="reason">
                      {tr('Username')}
                      <input
                        value={e?.username ?? ''}
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(ev) =>
                          setUEdit((s) => ({
                            ...s,
                            [u.id]: { ...s[u.id], username: ev.target.value },
                          }))
                        }
                      />
                    </label>

                    <div className="sheet-actions">
                      <button
                        disabled={busy || !dirty}
                        onClick={() =>
                          setUEdit((s) => ({
                            ...s,
                            [u.id]: { username: u.username, display_name: u.display_name },
                          }))
                        }
                      >
                        {tr('Discard changes')}
                      </button>
                      <button
                        className="primary"
                        disabled={busy || !dirty || !e.username.trim() || !e.display_name.trim()}
                        onClick={() =>
                          saveUser(
                            `users/${u.id}`,
                            {
                              username: e.username.trim(),
                              display_name: e.display_name.trim(),
                            },
                            tr('Name saved'),
                          )
                        }
                      >
                        {busy ? tr('Saving…') : dirty ? tr('Save') : tr('No changes')}
                      </button>
                    </div>

                    <label className="reason">
                      {tr('New password')}
                      <input
                        // Deliberately **not masked**: the owner reads it out to the
                        // member of staff, and masking only hides their own typos. This is not their own password.
                        value={pw[u.id] ?? ''}
                        placeholder={tr('At least 4 characters')}
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(ev) => setPw((s) => ({ ...s, [u.id]: ev.target.value }))}
                      />
                    </label>
                    <button
                      className="linkbtn wide danger"
                      disabled={busy || (pw[u.id]?.trim().length ?? 0) < 4}
                      onClick={() =>
                        saveUser(
                          `users/${u.id}/password`,
                          { password: pw[u.id].trim() },
                          `${tr(u.display_name)} · ${tr('new password is live, every existing sign-in was revoked')}${
                            isMe ? ` · ${tr('you will have to sign in again with it')}` : ''
                          }`,
                        )
                      }
                    >
                      {tr('Reset password')}
                    </button>
                  </section>
                )
              })}
            </div>
          )}
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
 * Amount input. **Typed in dollars, stored in cents.**
 *
 * This page is the owner editing prices in the back office, not blind tapping at
 * peak, so it uses a normal input rather than the POS keypad: with dozens of
 * prices to change, a keypad is slower.
 * What is stored is still cents -- money is never a float.
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
          // Round to cents before storing -- "12.345" must not become 1234.5 cents
          if (Number.isFinite(v) && v >= 0) onChange(Math.round(v * 100))
        }}
        onBlur={() => setText((cents / 100).toFixed(2))}
      />
    </span>
  )
}
