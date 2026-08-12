import { useEffect, useState } from 'react'
import { getLang, initLang, setLang, tr, useLang } from './i18n'
import {
  canManage,
  getIdentity,
  isFront,
  logout,
  refreshIdentity,
  type Identity,
} from './auth'
import AdminView from './AdminView'
import { CarriedOverBanner, ClockDriftBanner } from './CarriedOver'
import db from './db'
import DeadLetters from './DeadLetters'
import FloorPlan from './FloorPlan'
import KitchenView from './KitchenView'
import ListView from './ListView'
import MonthView from './MonthView'
import RefillView from './RefillView'
import SettingsSheet from './SettingsSheet'
import ToGoView from './ToGoView'
import LoginPage from './LoginPage'
import { cutoffHourOf } from './businessDay'
import { loadCatalog } from './catalog'
import { pruneLocalMirror, resetLocalData } from './checks'
import {
  installSyncTriggers,
  sync,
  type SyncFailure,
  type SyncResult,
} from './sync'

const ROLE_LABEL: Record<Identity['role'], string> = {
  front_employee: 'Front staff',
  front_manager: 'Front manager',
  kitchen: 'Kitchen',
  admin: 'Owner',
}

export default function App() {
  const [booting, setBooting] = useState(true)
  // ⚠️ Only App needs to subscribe to the language: nothing here is
  //    React.memo, so one re-render of App re-evaluates every tr() in the tree.
  const lang = useLang()
  const [identity, setIdentity] = useState<Identity | null>(null)

  const [pending, setPending] = useState(0)
  const [events, setEvents] = useState<
    { op_id: string; label: string; created_at: string; synced: 0 | 1; remote: 0 | 1 }[]
  >([])
  const [online, setOnline] = useState(navigator.onLine)
  const [last, setLast] = useState<string>('—')
  /** Raw sync counters, shown only in the "pending" detail for troubleshooting */
  const [detail, setDetail] = useState<string>('—')
  const [tone, setTone] = useState<'ok' | 'warn' | 'bad'>('ok')
  const [dead, setDead] = useState(0)
  const [view, setView] = useState<
    'floor' | 'togo' | 'list' | 'month' | 'admin' | 'refill' | 'kitchen'
  >('floor')
  const [showDead, setShowDead] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // The identity is read from IndexedDB, **no network needed** -- an offline
  // cold start still renders the right role immediately
  useEffect(() => {
    // Language and identity are read together; rendering first and switching after flickers
    void initLang()
    getIdentity()
      .then((id) => {
        setIdentity(id)
        // Confirm the role with the server when online -- the cache is a snapshot
        // from sign-in, and a role changed server-side would render wrong forever
        if (id) void refreshIdentity().then((f) => f && setIdentity(f))
      })
      .finally(() => setBooting(false))
  }, [])

  async function refresh() {
    setPending(await db.outbox.count())
    // Dead letters have to be visible. A failure nobody sees did not happen -- except it lost a check.
    setDead(await db.deadletter.count())
    setEvents(await db.events.orderBy('created_at').reverse().limit(30).toArray())
  }

    // Manual sync and the automatic triggers report through the same path,
    // or a manual tap leaves the previous failure on the status bar, which is very misleading
  function report(r: SyncResult | null, f?: SyncFailure) {
    if (r) {
      // ⚠️ This used to print `applied N · dup N · cursor N`.
      //    Those are debugging numbers, and nobody in a shop knows what dup and
      //    cursor mean -- a status nobody understands is no status at all, and
      //    when something really breaks, nobody looks twice.
      //    Plain words on the main screen; the raw numbers moved into the
      //    "pending" detail (an iPad has no devtools, so they are still needed).
      setLast(r.applied > 0 ? `${tr('Uploaded')} ${r.applied}` : tr('Everything uploaded'))
      setDetail(`applied ${r.applied} · dup ${r.duplicate} · cursor ${r.cursor}`)
      setTone('ok')
    } else if (f?.kind === 'offline') {
      // The point: offline **is not an error**. Calling it "failed" makes staff redo the work.
      setLast(tr('Offline. Queued, will send when back online.'))
      setTone('warn')
    } else if (f?.kind === 'auth') {
      // The session is gone, but **the data is still queued** -- that has to be said
      setLast(tr('Session expired, please log in again (your data is still queued)'))
      setTone('bad')
      void getIdentity().then(setIdentity)
    } else {
      setLast(`${tr('Sync error')}：${f?.message ?? tr('unknown')}`)
      setTone('bad')
    }
    void refresh()
  }

  // Every sign-in lands on that role's home page. The kitchen has none of the
  // floor pages, and without this neither of its tabs is highlighted, so there
  // is no telling which page you are on. A shift change should also start fresh
  // rather than wherever the last person left off.
  useEffect(() => {
    if (!identity) return
    setView(identity.role === 'kitchen' ? 'kitchen' : 'floor')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.username])

  useEffect(() => {
    if (!identity) return

    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)

    const uninstall = installSyncTriggers(report)
    void refresh()

    // Archiving: the local mirror keeps only the last few business days.
    // Only this device's cache, and only checks that are settled, uploaded and
    // older than the window; the server keeps everything and the month report
    // still finds them. Without it the mirror only grows, while the floor and the
    // check list scan the whole table every 2 seconds to work out business days --
    // a year of that is visibly slow on an iPad.
    void loadCatalog()
      .then((c) => pruneLocalMirror(cutoffHourOf(c)))
      .then((n) => n > 0 && console.info(`[archive] cleaned ${n} old checks from the local mirror`))
      .catch(() => {})

    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
      uninstall()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.username])

  if (booting) return <div className="wrap">{tr('Loading…')}</div>
  if (!identity) return <LoginPage onDone={setIdentity} />

  return (
    <div className="wrap">
      <header>
        <span className={online ? 'dot ok' : 'dot bad'} />
        <strong>{tr(online ? 'Online' : 'Offline')}</strong>
        <span className="who">
          {/* A display name is data, but the seeded accounts are named after roles
              ("Front manager"), which the catalogue has. A real person's name is not
              in it and tr() returns it unchanged -- same handling as operatorText. */}
          {tr(identity.display_name)}
          <span className={`role ${identity.role}`}>{tr(ROLE_LABEL[identity.role])}</span>
        </span>
        <span className="grow" />
        <button
          className={pending ? 'badge warn clickable' : 'badge clickable'}
          onClick={() => setShowSync(true)}
        >
          {tr('Pending')} {pending}
        </button>
        {dead > 0 && (
          <button className="badge bad clickable" onClick={() => setShowDead(true)}>
            {tr('Failed')} {dead}
          </button>
        )}
        <span className="badge build">build {__BUILD__}</span>
        {/* One-tap language switch. In the header because, like the role, it is
            **the whole interface's state** rather than one page's setting -- buried
            in the gear icon, a shift change would never find it. */}
        <button
          className="langbtn"
          onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')}
          title={tr('Switch language')}
        >
          {lang === 'zh' ? 'EN' : 'ZH'}
        </button>
        {/* Settings is tapped a few times a year, so a small gear is enough */}
        {canManage(identity.role) && (
          <button className="linkbtn" onClick={() => setShowSettings(true)}>
            ⚙︎
          </button>
        )}
        <button
          className="linkbtn"
          onClick={async () => {
            // Signing out clears credentials only and **leaves the outbox alone** --
            // unsynced records belong to the store and still have to go out
            await logout()
            setIdentity(null)
          }}
        >{tr('Log out')}</button>
      </header>

      {identity.role === 'kitchen' && (
        <div className="tabs">
          <button
            className={view === 'kitchen' ? 'on' : ''}
            onClick={() => setView('kitchen')}
          >{tr('Orders')}</button>
          <button
            className={view === 'refill' ? 'on' : ''}
            onClick={() => setView('refill')}
          >{tr('Refills')}</button>
        </div>
      )}

      {isFront(identity.role) && (
        <div className="tabs">
          <button
            className={view === 'floor' ? 'on' : ''}
            onClick={() => setView('floor')}
          >{tr('Floor')}</button>
          <button
            className={view === 'togo' ? 'on' : ''}
            onClick={() => setView('togo')}
          >{tr('To go')}</button>
          <button
            className={view === 'list' ? 'on' : ''}
            onClick={() => setView('list')}
          >{tr('Checks')}</button>
          {/* The front records refills too: the person who notices an empty tray is
              usually a server, not a cook. Kitchen-only would lose most of the
              "ran empty" events, which are the ones that matter most. */}
          <button
            className={view === 'refill' ? 'on' : ''}
            onClick={() => setView('refill')}
          >{tr('Refills')}</button>
          {/* A whole month's sales is for managers and the owner only -- least privilege */}
          {canManage(identity.role) && (
            <button
              className={view === 'month' ? 'on' : ''}
              onClick={() => setView('month')}
            >{tr('Reports')}</button>
          )}
          {/* Pricing is **owner only**, stricter than the month report -- see the
              permission matrix in DESIGN.md. The server's require_role("admin") is what actually stops it. */}
          {identity.role === 'admin' && (
            <button
              className={view === 'admin' ? 'on' : ''}
              onClick={() => setView('admin')}
            >{tr('Prices')}</button>
          )}
        </div>
      )}

      {/* The carried-over reminder. Here rather than inside the floor, because it
          has to stay visible on the check list and to-go pages too -- that money
          does not stop existing because someone changed tab.
          It renders nothing when there is nothing carried over. */}
      <ClockDriftBanner />
      {isFront(identity.role) && <CarriedOverBanner role={identity.role} />}

      {identity.role === 'kitchen' ? (
        view === 'refill' ? <RefillView /> : <KitchenView />
      ) : view === 'refill' ? (
        <RefillView />
      ) : view === 'floor' ? (
        <FloorPlan role={identity.role} />
      ) : view === 'togo' ? (
        <ToGoView role={identity.role} />
      ) : view === 'month' ? (
        <MonthView />
      ) : view === 'admin' ? (
        <AdminView />
      ) : (
        <ListView role={identity.role} />
      )}

      <div className="row">
        <button
          onClick={() => {
            sync()
              .then((r) => report(r))
              .catch((e: unknown) =>
                report(
                  null,
                  e && typeof e === 'object' && 'kind' in e
                    ? (e as SyncFailure)
                    : { kind: 'error', message: String(e) },
                ),
              )
          }}
        >{tr('Sync now')}</button>
        <code className={`status ${tone}`}>{last}</code>
      </div>

      {showDead && <DeadLetters onClose={() => { setShowDead(false); void refresh() }} />}

      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}

      {/* A status label staff cannot read is no label -- it has to open and explain itself */}
      {showSync && (
        <div className="sheet-back" onClick={() => setShowSync(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Pending')} {pending}</h2>
            <p className="hint">
              {tr('This iPad has')} <b>{pending}</b>{tr('operations have not reached the store server yet.')}</p>
            <table className="kv">
              <tbody>
                <tr>
                  <td className="dim">{tr('Anything to do')}</td>
                  <td className="num">{tr('Nothing. It sends automatically once online.')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('Can data be lost')}</td>
                  <td className="num">{tr('No. It is already stored on this iPad.')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('How often it retries')}</td>
                  <td className="num">{tr('Every 4 seconds while anything is queued')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('Network')}</td>
                  <td className="num">{tr(online ? 'Online' : 'Offline')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('Last sync')}</td>
                  <td className="num">{last}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('Details')}</td>
                  <td className="num"><code>{detail}</code></td>
                </tr>
              </tbody>
            </table>
            <p className="hint">{tr('If it never reaches zero the server is unreachable — check the WiFi and the back-office machine. The red Failed badge is the one that needs a person: those were rejected outright.')}</p>
            <div className="sheet-actions">
              <button onClick={() => setShowSync(false)}>{tr('Got it')}</button>
              <button
                className="primary"
                onClick={() => {
                  sync()
                    .then((r) => report(r))
                    .catch(() => {})
                  setShowSync(false)
                }}
              >{tr('Retry now')}</button>
            </div>

            {canManage(identity.role) && (
              <>
                <div className="divider" />
                <p className="hint">
                  <b>{tr('Reset local data')}</b>{tr(': clears the checks cached on this device and pulls them again. Only needed when the server data was cleaned up and this device still holds old checks.')}</p>
                <button
                  className="linkbtn wide danger"
                  onClick={async () => {
                    const r = await resetLocalData()
                    if (!r.ok) {
                      setLast(`${tr('Some operations are still queued; let them sync before resetting')}（${r.pending}）`)
                      setTone('bad')
                      return
                    }
                    await sync().catch(() => {})
                    await refresh()
                    setShowSync(false)
                    setLast(tr('Local data reset, fetching again'))
                    setTone('ok')
                  }}
                >{tr('Reset local data')}</button>
              </>
            )}
          </div>
        </div>
      )}

      {!isFront(identity.role) && (
        <ul>
          {events.map((e) => (
            <li key={e.op_id}>
              <span className={e.synced ? 'tag ok' : 'tag warn'}>
                {tr(e.synced ? 'Synced' : 'Pending upload')}
              </span>
              {e.remote ? <span className="tag remote">{tr('Other device')}</span> : null}
              <span className="label">{tr(e.label)}</span>
              <code className="id">{e.op_id.slice(0, 8)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
