import { useEffect, useState } from 'react'
import {
  canManage,
  getIdentity,
  isFront,
  logout,
  refreshIdentity,
  type Identity,
} from './auth'
import { CarriedOverBanner, ClockDriftBanner } from './CarriedOver'
import db from './db'
import DeadLetters from './DeadLetters'
import FloorPlan from './FloorPlan'
import ListView from './ListView'
import MonthView from './MonthView'
import SettingsSheet from './SettingsSheet'
import ToGoView from './ToGoView'
import LoginPage from './LoginPage'
import { cutoffHourOf } from './businessDay'
import { loadCatalog } from './catalog'
import { pruneLocalMirror, resetLocalData } from './checks'
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
  const [view, setView] = useState<'floor' | 'togo' | 'list' | 'month'>('floor')
  const [showDead, setShowDead] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

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

    // 归档：本地镜像只保留最近几个营业日。
    // 只删本机缓存里"已结清 + 已上传 + 早于保留窗口"的单，服务端一条不动，
    // 月报照样查得到。不做的话本地镜像只增不减，而楼面/清单每 2 秒
    // 要全表扫一遍算营业日 —— 一年下来 iPad 上会明显变卡。
    void loadCatalog()
      .then((c) => pruneLocalMirror(cutoffHourOf(c)))
      .then((n) => n > 0 && console.info(`[archive] 本地清理了 ${n} 张旧账单`))
      .catch(() => {})

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
        <button
          className={pending ? 'badge warn clickable' : 'badge clickable'}
          onClick={() => setShowSync(true)}
        >
          未上传 {pending}
        </button>
        {dead > 0 && (
          <button className="badge bad clickable" onClick={() => setShowDead(true)}>
            失败 {dead}
          </button>
        )}
        <span className="badge build">build {__BUILD__}</span>
        {/* 设置一年也点不了几次，放个小齿轮就够，不占主界面 */}
        {canManage(identity.role) && (
          <button className="linkbtn" onClick={() => setShowSettings(true)}>
            ⚙︎
          </button>
        )}
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
            className={view === 'togo' ? 'on' : ''}
            onClick={() => setView('togo')}
          >
            自提
          </button>
          <button
            className={view === 'list' ? 'on' : ''}
            onClick={() => setView('list')}
          >
            账单清单
          </button>
          {/* 整月营业额只给主管和老板看 —— 最小权限 */}
          {canManage(identity.role) && (
            <button
              className={view === 'month' ? 'on' : ''}
              onClick={() => setView('month')}
            >
              月报
            </button>
          )}
        </div>
      )}

      {/* 跨天未结账单的提醒。放在这里而不是楼面里面 ——
          切到清单页、自提页也要看得见，那笔钱不会因为换了个 tab 就不存在了。
          没有未结单时这个组件什么都不渲染。 */}
      <ClockDriftBanner />
      {isFront(identity.role) && <CarriedOverBanner role={identity.role} />}

      {!isFront(identity.role) ? (
        <>
          <p className="hint">后厨界面在 Step 5（订单队列 + 补菜记录）。</p>
          <button className="big" onClick={tap}>
            记录一次（骨架探针）
          </button>
        </>
      ) : view === 'floor' ? (
        <FloorPlan role={identity.role} />
      ) : view === 'togo' ? (
        <ToGoView role={identity.role} />
      ) : view === 'month' ? (
        <MonthView />
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

      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}

      {/* 一个员工看不懂的状态标签等于没有标签 —— 必须能点开问"这是什么" */}
      {showSync && (
        <div className="sheet-back" onClick={() => setShowSync(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>未上传 {pending}</h2>
            <p className="hint">
              这台 iPad 上有 <b>{pending}</b> 条操作还没传到店里的服务器。
            </p>
            <table className="kv">
              <tbody>
                <tr>
                  <td className="dim">要我做什么吗</td>
                  <td className="num">不用。联网后会自动补发。</td>
                </tr>
                <tr>
                  <td className="dim">数据会丢吗</td>
                  <td className="num">不会。已经存在这台 iPad 上了。</td>
                </tr>
                <tr>
                  <td className="dim">多久补发一次</td>
                  <td className="num">有积压时每 4 秒重试一次</td>
                </tr>
                <tr>
                  <td className="dim">现在网络</td>
                  <td className="num">{online ? '在线' : '离线'}</td>
                </tr>
                <tr>
                  <td className="dim">上次同步</td>
                  <td className="num">{last}</td>
                </tr>
              </tbody>
            </table>
            <p className="hint">
              如果一直不归零，说明服务器连不上（检查店内 WiFi 和后台机器）。
              红色的「失败 N」才是需要人处理的 —— 那是服务端明确拒绝的操作。
            </p>
            <div className="sheet-actions">
              <button onClick={() => setShowSync(false)}>知道了</button>
              <button
                className="primary"
                onClick={() => {
                  sync()
                    .then((r) => report(r))
                    .catch(() => {})
                  setShowSync(false)
                }}
              >
                立即重试
              </button>
            </div>

            {canManage(identity.role) && (
              <>
                <div className="divider" />
                <p className="hint">
                  <b>重置本机数据</b>：清空这台设备缓存的账单，重新从服务器拉一遍。
                  服务端的数据被清理过、而本机还留着旧单时才需要 ——
                  服务端删数据不会通知客户端。
                </p>
                <button
                  className="linkbtn wide danger"
                  onClick={async () => {
                    const r = await resetLocalData()
                    if (!r.ok) {
                      setLast(`还有 ${r.pending} 条未上传，先等它同步完再重置`)
                      setTone('bad')
                      return
                    }
                    await sync().catch(() => {})
                    await refresh()
                    setShowSync(false)
                    setLast('本机数据已重置，正在重新拉取')
                    setTone('ok')
                  }}
                >
                  重置本机数据
                </button>
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
