import { useEffect, useState } from 'react'
import db from './db'
import {
  enqueue,
  installSyncTriggers,
  sync,
  type SyncFailure,
  type SyncResult,
} from './sync'

export default function App() {
  const [pending, setPending] = useState(0)
  const [events, setEvents] = useState<
    { op_id: string; label: string; created_at: string; synced: 0 | 1; remote: 0 | 1 }[]
  >([])
  const [online, setOnline] = useState(navigator.onLine)
  const [last, setLast] = useState<string>('—')
  const [tone, setTone] = useState<'ok' | 'warn' | 'bad'>('ok')
  const [dead, setDead] = useState(0)

  async function refresh() {
    setPending(await db.outbox.count())
    // 死信必须可见。看不见的失败等于没发生 —— 而它其实是丢了一单。
    setDead(await db.deadletter.count())
    setEvents(await db.events.orderBy('created_at').reverse().limit(30).toArray())
  }

  // 手动同步和自动触发共用同一个上报路径，
  // 否则手点的那次不会刷新状态栏，会留下上一次的失败信息（误导性很强）
  function report(r: SyncResult | null, f?: SyncFailure) {
    if (r) {
      setLast(`已同步 · applied ${r.applied} · dup ${r.duplicate} · cursor ${r.cursor}`)
      setTone('ok')
    } else if (f?.kind === 'offline') {
      // 关键：离线**不是错误**。说成"失败"会让员工重复操作。
      setLast('离线，数据已排队，联网后自动补发')
      setTone('warn')
    } else {
      setLast(`同步出错：${f?.message ?? '未知'}`)
      setTone('bad')
    }
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
        {dead > 0 && <span className="badge bad">失败 {dead}</span>}
        <span className="badge build">build {__BUILD__}</span>
      </header>

      <button className="big" onClick={tap}>
        记录一次
      </button>

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
        >
          立即同步
        </button>
        <code className={`status ${tone}`}>{last}</code>
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
