import { useEffect, useState } from 'react'
import { locale, paren, tr } from './i18n'
import { authFetch } from './auth'
import { refreshCatalog } from './catalog'

interface TaxRow {
  rate: number
  effective_from: string
  note: string | null
  updated_by: string | null
}

interface BusinessDayRow {
  tz: string
  business_day_cutoff_hour: number
  updated_by: string | null
  /** The store's current time under these settings (ISO with the offset) */
  store_now: string
  business_date: string
  choices: { tz: string; label: string }[]
}

/** The boundaries offered. 0-5 covers any real restaurant; the server takes 0-23. */
const CUTOFF_CHOICES: { h: number; label: string }[] = [
  { h: 0, label: 'Midnight -- a new day starts at 00:00' },
  { h: 1, label: '1 AM' },
  { h: 2, label: '2 AM -- late entries still count as the previous day' },
  { h: 3, label: '3 AM' },
  { h: 4, label: '4 AM' },
  { h: 5, label: '5 AM' },
]

/**
 * Settings: the business day and time zone, and the sales tax rate.
 *
 * **Opened a few times a year**, so it hides behind a small gear rather than taking main-screen space.
 * But both really do change (the county adjusts the rate; the time zone was set
 * wrong once), and hard-coding them means a release and a container rebuild for
 * a one-line change -- a restaurant has no IT.
 */
export default function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState<TaxRow | null>(null)
  const [percent, setPercent] = useState('')
  // ⚠️ Never new Date().toISOString().slice(0,10) -- that is the **UTC date**.
  //    The store is at UTC-7, so after 17:00 UTC is already tomorrow and the
  //    default effective date quietly jumps a day. It uses the business day the server sends (filled in after the GET).
  const [from, setFrom] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [bd, setBd] = useState<BusinessDayRow | null>(null)
  const [tz, setTz] = useState('')
  const [cutoff, setCutoff] = useState(0)

  useEffect(() => {
    authFetch('/api/reports/tax')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaxRow | null) => {
        setCur(d)
        if (d) {
          setPercent(taxPercentText(d.rate))
          setFrom(d.effective_from)
          setNote(d.note ?? '')
        }
      })
      .catch(() => setErr(tr('Needs a connection to read settings')))

    authFetch('/api/reports/business-day')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: BusinessDayRow | null) => {
        if (!d) return
        setBd(d)
        setTz(d.tz)
        setCutoff(d.business_day_cutoff_hour)
        // The tax rate's effective date defaults to **the store's business day**, not the device date and not UTC
        setFrom((f) => f || d.business_date)
      })
      .catch(() => setErr(tr('Needs a connection to read settings')))
  }, [])

  const bdDirty =
    bd !== null && (tz !== bd.tz || cutoff !== bd.business_day_cutoff_hour)

  // The tax rate is only submitted when it really changed.
  // ⚠️ This caused a real incident once: there were two save buttons and the
  //    prominent one only saved the rate. Someone changed the time zone and
  //    tapped Save at the bottom -- the time zone was not saved, and a tax rate
  //    row effective tomorrow appeared out of nowhere (with no rate change).
  //    There is one save button now, and it checks each section for changes.
  const taxDirty = cur
    ? percent.trim() !== taxPercentText(cur.rate) ||
      from !== cur.effective_from ||
      note.trim() !== (cur.note ?? '')
    : percent.trim() !== ''

  const dirty = bdDirty || taxDirty

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Settings')}</h2>

        <h3 className="zone">{tr('Business day & time zone')}</h3>

        {bd ? (
          <>
            {/* The store's current time is shown -- with the wrong time zone this
                line is obviously wrong at a glance, which beats any validation message */}
            <p className="hint">
              {tr('Store time now')} <b>{storeClockText(bd.store_now)}</b>
              <br />
              {tr('Business day')} <b>{bd.business_date}</b>
              {bd.updated_by && ` · ${tr('by')} ${tr(bd.updated_by)}`}
            </p>

            <label className="reason">
              {tr('Time zone')}
              <select value={tz} onChange={(e) => setTz(e.target.value)}>
                {bd.choices.map((c) => (
                  <option key={c.tz} value={c.tz}>
                    {tr(c.label)}
                  </option>
                ))}
              </select>
            </label>

            <label className="reason">
              {tr('Business day starts at')}
              <select
                value={cutoff}
                onChange={(e) => setCutoff(Number(e.target.value))}
              >
                {CUTOFF_CHOICES.map((c) => (
                  <option key={c.h} value={c.h}>
                    {tr(c.label)}
                  </option>
                ))}
              </select>
            </label>

            <p className="hint">
              {tr('The time zone decides where lunch becomes dinner (15:00) and which day a check belongs to. Get it wrong and the wrong period price is charged.')}
            </p>

            <p className="hint warnbox">
              {tr('⚠️ A time zone change applies to everything, with no effective date — checks near the cutoff may move to a different day in the reports.')}
            </p>

          </>
        ) : (
          <p className="hint">{tr('Needs a connection to read the business-day settings.')}</p>
        )}

        <div className="divider" />

        <h3 className="zone">{tr('Sales tax')}</h3>

        {cur ? (
          <p className="hint">
            <b>{taxPercentText(cur.rate)}%</b> · {tr('from')} {cur.effective_from}
            {cur.updated_by && ` · ${tr('by')} ${tr(cur.updated_by)}`}
            {cur.note && ` · ${cur.note}`}
          </p>
        ) : (
          <p className="hint">{tr('No tax rate set yet; 0% is being used.')}</p>
        )}

        <label className="reason">
          {tr('Tax rate (%)')}
          <input
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            inputMode="decimal"
            placeholder={tr('e.g. 7.1')}
          />
        </label>

        <label className="reason">
          {tr('Effective from')}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <label className="reason">
          {tr('Note (optional)')}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('e.g. county rate change')}
          />
        </label>

        <p className="hint">
          {tr('Tax applies to the subtotal plus the large-party fee. Changing it adds a new effective-dated record; existing checks are unaffected.')}
        </p>

        {err && <p className="err">{err}</p>}
        {msg && <p className="hint">{msg}</p>}

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('Close')}</button>
          {/* **One save button** for everything on this page.
              The two-button version caused an incident: the time zone was changed, this was tapped, and the tax rate got saved. */}
          <button
            className="primary"
            disabled={busy || !dirty}
            onClick={async () => {
              setErr(null)
              setMsg(null)

              const v = Number(percent)
              if (taxDirty && (!percent.trim() || !Number.isFinite(v) || v < 0 || v >= 100)) {
                setErr(tr('Tax rate is not valid'))
                return
              }
              if (taxDirty && !from) {
                setErr(tr('Pick an effective date for the tax rate'))
                return
              }

              setBusy(true)
              const done: string[] = []
              try {
                if (bdDirty) {
                  const res = await authFetch('/api/reports/business-day', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tz, business_day_cutoff_hour: cutoff }),
                  })
                  if (!res.ok) throw new Error(String(res.status))
                  const d: BusinessDayRow = await res.json()
                  setBd(d)
                  setTz(d.tz)
                  setCutoff(d.business_day_cutoff_hour)
                  done.push(tr('time zone and business day'))
                }

                if (taxDirty) {
                  const res = await authFetch('/api/reports/tax', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      rate_percent: v,
                      effective_from: from,
                      note: note.trim() || null,
                    }),
                  })
                  if (!res.ok) throw new Error(String(res.status))
                  setCur(await res.json())
                  done.push(tr('sales tax (from the next check opened)'))
                }

                // The business day rule and the tax rate both reach the front end
                // through the catalog -- without a refresh the check list still
                // splits on the old boundary and local estimates use the old rate,
                // so they disagree with the month report
                await refreshCatalog()
                setMsg(`${tr('Saved:')} ${done.join('; ')}`)
              } catch {
                setErr(tr('Save failed, check the connection and retry'))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? tr('Saving…') : dirty ? tr('Save') : tr('No changes')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 0.071 -> '7.1'. Trailing zeros dropped, so settings never shows '7.100%'. */
function taxPercentText(rate: number): string {
  return (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Show the store's own time.
 *
 * ⚠️ Not toLocaleString() -- that renders in **this device's** time zone, and
 *    the entire point of this line is letting someone see whether **the store's**
 *    time is right. The server sends ISO with the offset; the fields are read off that offset by hand.
 */
function storeClockText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  const [, y, mo, d, hh, mm] = m
  // Read the fields off the store's offset by hand (toLocaleString would use the
  // **device's** zone, and this line exists to show **the store's** time), then
  // let Intl name the month, so an English screen never shows a Chinese date.
  const day = new Intl.DateTimeFormat(locale(), { month: 'long', day: 'numeric' }).format(
    new Date(Number(y), Number(mo) - 1, Number(d)),
  )
  return `${day} ${hh}:${mm}${paren(y)}`
}
