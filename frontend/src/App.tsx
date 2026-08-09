import { useEffect, useState } from 'react'
import { getIdentity, isFront, logout, refreshIdentity, type Identity } from './auth'
import db from './db'
import DeadLetters from './DeadLetters'
import FloorPlan from './FloorPlan'
import ListView from './ListView'
import LoginPage from './LoginPage'
import {
  enqueue,
  installSyncTriggers,
  sync,
  type SyncFailure,
  type SyncResult,
} from './sync'

const ROLE_LABEL: Record<Identity['role'], string> = {
  front_employee: '前台员工',
  front_manager: '前台主管',
  kitchen: '后厨',
  admin: '老板',
}

export default function App() {
  const [booting, setBooting] = useState(true)
  const [identity, setIdentity] = useState<Identity | null>(null)

  const [pending, setPending] = useState(0)
  const [events, setEvents] = useState<
    { op_id: string; label: string; created_at: string; synced: 0 | 1; remote: 0 | 1 }[]
  >([])
  const [online, setOnline] = useState(navigator.onLine)
  const [last, setLast] = useState<string>('—')
  const [tone, setTone] = useState<'ok' | 'warn' | 'bad'>('ok')
  const [dead, setDead] = useState(0)
  const [view, setView] = useState<'floor' | 'list'>('floor')
  const [showDead, setShowDead] = useState(false)

  // 身份从 IndexedDB 读，**不需要网络** ——
  // 离线冷启动时也能立刻渲染出正确的角色界面
  useEffect(() => {
    getIdentity()
      .then((id) => {
        setIdentity(id)
        // 联网时向服务端确认一次角色 —— 缓存的是登录那一刻的快照，
        // 角色在服务端被改过的话（比如员工升主管）前端会一直渲染错
        if (id) void refreshIdentity().then((f) => f && setIdentity(f))
      })
      .finally(() => setBooting(false))
  }, [])

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
    } else if (f?.kind === 'auth') {
      // 会话没了，但**数据仍在排队**，这点必须说清楚
      setLast('会话已失效，请重新登录（数据仍在排队）')
      setTone('bad')
      void getIdentity().then(setIdentity)
    } else {
      setLast(`同步出错：${f?.message ?? '未知'}`)
      setTone('bad')
    }
    void refresh()
  }

  useEffect(() => {
    if (!identity) return

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.username])

  async function tap() {
    await enqueue('ping_event', { label: `tap @ ${new Date().toLocaleTimeString()}` })
    await refresh()
  }

  if (booting) return <div className="wrap">载入中…</div>
  if (!identity) return <LoginPage onDone={setIdentity} />

  return (
    <div className="wrap">
      <header>
        <span className={online ? 'dot ok' : 'dot bad'} />
        <strong>{online ? '在线' : '离线'}</strong>
        <span className="who">
          {identity.display_name}
          <span className={`role ${identity.role}`}>{ROLE_LABEL[identity.role]}</span>
        </span>
        <span className="grow" />
        <span className={pending ? 'badge warn' : 'badge'}>待同步 {pending}</span>
        {dead > 0 && (
          <button className="badge bad clickable" onClick={() => setShowDead(true)}>
            失败 {dead}
          </button>
        )}
        <span className="badge build">build {__BUILD__}</span>
        <button
          className="linkbtn"
          onClick={async () => {
            // 登出只清凭证，**不动 outbox** —— 未同步的记录属于店里，
            // 换个人登进来照样要发出去
            await logout()
            setIdentity(null)
          }}
        >
          登出
        </button>
      </header>

      {isFront(identity.role) && (
        <div className="tabs">
          <button
            className={view === 'floor' ? 'on' : ''}
            onClick={() => setView('floor')}
          >
            楼面
          </button>
          <button
            className={view === 'list' ? 'on' : ''}
            onClick={() => setView('list')}
          >
            账单清单
          </button>
        </div>
      )}

      {!isFront(identity.role) ? (
        <>
          <p className="hint">后厨界面在 Step 5（订单队列 + 补菜记录）。</p>
          <button className="big" onClick={tap}>
            记录一次（骨架探针）
          </button>
        </>
      ) : view === 'floor' ? (
        <FloorPlan role={identity.role} />
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
        >
          立即同步
        </button>
        <code className={`status ${tone}`}>{last}</code>
      </div>

      {showDead && <DeadLetters onClose={() => { setShowDead(false); void refresh() }} />}

      {!isFront(identity.role) && (
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
      )}
    </div>
  )
}
