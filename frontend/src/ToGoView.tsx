import { useCallback, useEffect, useState } from 'react'
import { lineName, tr } from './i18n'
import type { Role } from './auth'
import { loadCatalog, money, refreshCatalog, type Catalog } from './catalog'
import {
  allChecks,
  isTogo,
  openTogo,
  pendingCheckUuids,
  type NewLine,
} from './checks'
import CheckDetail, { operatorText, PAY_LABEL, STATUS_LABEL } from './CheckDetail'
import type { LocalCheck } from './db'
import MenuPicker, { TogoAmountSheet } from './MenuPicker'

/**
 * To go. Kept apart from the floor because it **has no concept of a table** --
 * forcing it into the floor grid only makes people look for which table it is on.
 */
export default function ToGoView({ role }: { role: Role }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [sheet, setSheet] = useState<'buffet' | 'phone' | null>(null)
  const [phoneLines, setPhoneLines] = useState<NewLine[] | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [pick, setPick] = useState<LocalCheck | null>(null)

  const reload = useCallback(async () => {
    const all = await allChecks()
    // A whitelist -- old rows have no source, and excluding by type would sweep dine-in checks in
    setRows(all.filter(isTogo))
    setPending(await pendingCheckUuids())
    setPick((p) => (p ? (all.find((r) => r.check_uuid === p.check_uuid) ?? null) : null))
  }, [])

  useEffect(() => {
    loadCatalog().then(setCat)
    refreshCatalog().then((c) => c && setCat(c))
    void reload()
    const t = window.setInterval(reload, 2000)
    return () => window.clearInterval(t)
  }, [reload])

  if (!cat) return <p className="hint">{tr('First run needs a connection to load the menu…')}</p>

  const togoItem = cat.menu.find((m) => m.open_price)
  const openOnes = rows.filter((r) => r.status === 'open')

  return (
    <>
      <div className="togo-actions">
        <button
          className="bigcard buffet"
          disabled={!togoItem}
          onClick={() => setSheet('buffet')}
        >
          <span className="bc-title">{tr('Buffet to go')}</span>
          <span className="bc-sub">{tr('Buffet To Go — by weight, enter the amount')}</span>
        </button>
        <button className="bigcard phone" onClick={() => setSheet('phone')}>
          <span className="bc-title">{tr('Phone order')}</span>
          <span className="bc-sub">{tr('Order from the menu for pickup')}</span>
        </button>
      </div>


      <h3 className="zone">{tr('Waiting')} {openOnes.length}</h3>

      <div className="cards">
        {rows.map((c) => (
          <button
            key={c.check_uuid}
            className={`card ${c.status}`}
            onClick={() => setPick(c)}
          >
            <div className="c-top">
              <span className="c-table">
                {tr(c.source === 'buffet_togo' ? 'Takeout' : 'Phone')}
              </span>
              <span
                className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}
              >
                {tr(STATUS_LABEL[c.status])}
              </span>
              {pending.has(c.check_uuid) && <span className="tag warn">{tr('Pending')}</span>}
              <span className="grow" />
              <span className="c-time">
                {new Date(c.opened_at).toLocaleTimeString('zh-CN', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>

            <div className="c-money">{money(c.est_cents)}</div>

            {(c.customer_name || c.phone_last4) && (
              <div className="c-line">
                {c.customer_name && <span className="chip">{c.customer_name}</span>}
                {c.phone_last4 && <span className="chip">{tr('last 4')} {c.phone_last4}</span>}
              </div>
            )}

            <div className="c-line">
              {(c.lines ?? []).slice(0, 3).map((l, i) => (
                <span key={i} className="chip">
                  {lineName(l, cat?.menu)}
                  {l.qty > 1 && ` ×${l.qty}`}
                </span>
              ))}
              {(c.lines ?? []).length > 3 && (
                <span className="chip">+{(c.lines ?? []).length - 3}</span>
              )}
            </div>

            <div className="c-foot">
              <span>{c.pay_method ? tr(PAY_LABEL[c.pay_method]) : tr('No payment recorded')}</span>
              <span className="grow" />
              <span>{operatorText(c)}</span>
            </div>
          </button>
        ))}
        {rows.length === 0 && <p className="hint">{tr('No to-go orders yet.')}</p>}
      </div>

      {sheet === 'buffet' && togoItem && (
        <TogoAmountSheet
          item={togoItem}
          onCancel={() => setSheet(null)}
          onConfirm={async (lines) => {
            await openTogo('buffet_togo', lines)
            setSheet(null)
            await reload()
          }}
        />
      )}

      {sheet === 'phone' && !phoneLines && (
        <MenuPicker
          menu={cat.menu}
          categories={cat.categories}
          modifiers={cat.modifiers ?? []}
          title={tr('Phone order')}
          onCancel={() => setSheet(null)}
          onConfirm={(lines) => {
            setPhoneLines(lines)
            setName('')
            setPhone('')
          }}
        />
      )}

      {/* Ask for the guest's details after the dishes -- the other way round leaves them waiting on the phone */}
      {sheet === 'phone' && phoneLines && (
        <div className="sheet-back" onClick={() => setPhoneLines(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Customer')}</h2>
            <p className="hint">{tr('Both optional. Only the last 4 digits are kept.')}</p>
            <label className="reason">
              {tr('Name')}
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <label className="reason">
              {tr('Phone (last 4 digits)')}
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <div className="sheet-actions">
              <button onClick={() => setPhoneLines(null)}>{tr('Back to dishes')}</button>
              <button
                className="primary"
                onClick={async () => {
                  await openTogo('phone_order', phoneLines, {
                    name: name.trim() || undefined,
                    phone: phone.trim() || undefined,
                  })
                  setPhoneLines(null)
                  setSheet(null)
                  await reload()
                }}
              >{tr('Create')}</button>
            </div>
          </div>
        </div>
      )}

      {pick && (
        <CheckDetail
          check={pick}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={[]}
          menu={cat.menu}
          categories={cat.categories}
          pending={pending.has(pick.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}
