import { useEffect, useState } from 'react'
import db from './db'
import { enqueue, installSyncTriggers, sync, type SyncResult } from './sync'

export default function App() {
  const [pending, setPending] = useState(0)
  const [events, setEvents] = useState<
    { op_id: string; label: string; created_at: string; synced: 0 | 1; remote: 0 | 1 }[]
  >([])
  const [online, setOnline] = useState(navigator.onLine)
  const [last, setLast] = useState<string>('—')

  async function refresh() {
    setPending(await db.outbox.count())
    setEvents(await db.events.orderBy('created_at').reverse().limit(30).toArray())
  }

  // 手动同步和自动触发共用同一个上报路径，
  // 否则手点的那次不会刷新状态栏，会留下上一次的失败信息（误导性很强）
  function report(r: SyncResult | null) {
    setLast(
      r
        ? `applied ${r.applied} · dup ${r.duplicate} · rej ${r.rejected.length} · cursor ${r.cursor}`
        : '同步失败（离线？）',
    )
    void refresh()
  }

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)

    const uninstall = installSyncTriggers(report)
    void refresh()

    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
      uninstall()
    }
  }, [])

  async function tap() {
    await enqueue('ping_event', { label: `tap @ ${new Date().toLocaleTimeString()}` })
    await refresh()
  }

  return (
    <div className="wrap">
      <header>
        <span className={online ? 'dot ok' : 'dot bad'} />
        <strong>{online ? '在线' : '离线'}</strong>
        <span className="grow" />
        <span className={pending ? 'badge warn' : 'badge'}>待同步 {pending}</span>
      </header>

      <button className="big" onClick={tap}>
        记录一次
      </button>

      <div className="row">
        <button
          onClick={() => {
            sync().then(report).catch(() => report(null))
          }}
        >
          立即同步
        </button>
        <code>{last}</code>
      </div>

      <ul>
        {events.map((e) => (
          <li key={e.op_id}>
            <span className={e.synced ? 'tag ok' : 'tag warn'}>
              {e.synced ? '已同步' : '待同步'}
            </span>
            {e.remote ? <span className="tag remote">其它设备</span> : null}
            <span className="label">{e.label}</span>
            <code className="id">{e.op_id.slice(0, 8)}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
