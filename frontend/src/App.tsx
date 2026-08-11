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
  front_employee: '前台员工',
  front_manager: '前台主管',
  kitchen: '后厨',
  admin: '老板',
}

export default function App() {
  const [booting, setBooting] = useState(true)
  // ⚠️ 只有 App 订阅语言就够：项目里没有任何 React.memo，
  //    App 一重渲染，整棵树都会重新求值 tr()。不用把每个组件都包一遍。
  const lang = useLang()
  const [identity, setIdentity] = useState<Identity | null>(null)

  const [pending, setPending] = useState(0)
  const [events, setEvents] = useState<
    { op_id: string; label: string; created_at: string; synced: 0 | 1; remote: 0 | 1 }[]
  >([])
  const [online, setOnline] = useState(navigator.onLine)
  const [last, setLast] = useState<string>('—')
  /** 同步的原始计数，只在「未上传」详情里给排障用 */
  const [detail, setDetail] = useState<string>('—')
  const [tone, setTone] = useState<'ok' | 'warn' | 'bad'>('ok')
  const [dead, setDead] = useState(0)
  const [view, setView] = useState<
    'floor' | 'togo' | 'list' | 'month' | 'admin' | 'refill' | 'kitchen'
  >('floor')
  const [showDead, setShowDead] = useState(false)
  const [showSync, setShowSync] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // 身份从 IndexedDB 读，**不需要网络** ——
  // 离线冷启动时也能立刻渲染出正确的角色界面
  useEffect(() => {
    // 语言和身份一起读 —— 先渲染再切会闪一下
    void initLang()
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
      // ⚠️ 这里原本直接显示 `applied N · dup N · cursor N`。
      //    那是调试用的原始数字，店里没人知道 dup 和 cursor 是什么 ——
      //    而看不懂的状态等于没有状态，出真问题时也不会有人多看一眼。
      //    人话留在主界面，原始数字挪进「未上传」那个详情里（iPad 上
      //    没有 devtools，真机排障还得靠它们）。
      setLast(r.applied > 0 ? `${tr('已上传')} ${r.applied}` : tr('数据都已上传'))
      setDetail(`applied ${r.applied} · dup ${r.duplicate} · cursor ${r.cursor}`)
      setTone('ok')
    } else if (f?.kind === 'offline') {
      // 关键：离线**不是错误**。说成"失败"会让员工重复操作。
      setLast(tr('离线，数据已排队，联网后自动补发'))
      setTone('warn')
    } else if (f?.kind === 'auth') {
      // 会话没了，但**数据仍在排队**，这点必须说清楚
      setLast(tr('会话已失效，请重新登录（数据仍在排队）'))
      setTone('bad')
      void getIdentity().then(setIdentity)
    } else {
      setLast(`${tr('同步出错')}：${f?.message ?? tr('未知')}`)
      setTone('bad')
    }
    void refresh()
  }

  // 每次登录把页面拨回这个角色的首页。后厨没有楼面那些页 ——
  // 不拨的话它一进来两个 tab 都不高亮，看不出自己在哪一页；
  // 换人接班时也该从头开始，而不是停在上一个人最后看的那一页。
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

  if (booting) return <div className="wrap">{tr('载入中…')}</div>
  if (!identity) return <LoginPage onDone={setIdentity} />

  return (
    <div className="wrap">
      <header>
        <span className={online ? 'dot ok' : 'dot bad'} />
        <strong>{tr(online ? '在线' : '离线')}</strong>
        <span className="who">
          {/* 显示名是数据，但种子账号叫「前台主管」这种角色名，词表里有。
              真人姓名不在词表里，tr() 会原样返回 —— 和 operatorText 一个处理。 */}
          {tr(identity.display_name)}
          <span className={`role ${identity.role}`}>{tr(ROLE_LABEL[identity.role])}</span>
        </span>
        <span className="grow" />
        <button
          className={pending ? 'badge warn clickable' : 'badge clickable'}
          onClick={() => setShowSync(true)}
        >
          {tr('未上传')} {pending}
        </button>
        {dead > 0 && (
          <button className="badge bad clickable" onClick={() => setShowDead(true)}>
            {tr('失败')} {dead}
          </button>
        )}
        <span className="badge build">build {__BUILD__}</span>
        {/* 一键中英切换。放顶栏是因为它跟角色一样是"整个界面的状态"，
            而不是某一页的设置 —— 藏进齿轮里，员工换班时找不到。 */}
        <button
          className="langbtn"
          onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')}
          title={lang === 'zh' ? 'Switch to English' : '切换成中文'}
        >
          {lang === 'zh' ? 'EN' : '中'}
        </button>
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
        >{tr('登出')}</button>
      </header>

      {identity.role === 'kitchen' && (
        <div className="tabs">
          <button
            className={view === 'kitchen' ? 'on' : ''}
            onClick={() => setView('kitchen')}
          >{tr('订单')}</button>
          <button
            className={view === 'refill' ? 'on' : ''}
            onClick={() => setView('refill')}
          >{tr('补菜')}</button>
        </div>
      )}

      {isFront(identity.role) && (
        <div className="tabs">
          <button
            className={view === 'floor' ? 'on' : ''}
            onClick={() => setView('floor')}
          >{tr('楼面')}</button>
          <button
            className={view === 'togo' ? 'on' : ''}
            onClick={() => setView('togo')}
          >{tr('自提')}</button>
          <button
            className={view === 'list' ? 'on' : ''}
            onClick={() => setView('list')}
          >{tr('账单清单')}</button>
          {/* 补菜前台也要能记：发现菜盘空了的往往是服务员，不是厨师。
              只给后厨的话，"空了"这个最关键的事件会大量丢失。 */}
          <button
            className={view === 'refill' ? 'on' : ''}
            onClick={() => setView('refill')}
          >{tr('补菜')}</button>
          {/* 整月营业额只给主管和老板看 —— 最小权限 */}
          {canManage(identity.role) && (
            <button
              className={view === 'month' ? 'on' : ''}
              onClick={() => setView('month')}
            >{tr('月报')}</button>
          )}
          {/* 改价**只给老板**，比月报还严 —— 见 DESIGN.md 的权限矩阵。
              服务端 require_role("admin") 才是真正拦住的那道。 */}
          {identity.role === 'admin' && (
            <button
              className={view === 'admin' ? 'on' : ''}
              onClick={() => setView('admin')}
            >{tr('修改')}</button>
          )}
        </div>
      )}

      {/* 跨天未结账单的提醒。放在这里而不是楼面里面 ——
          切到清单页、自提页也要看得见，那笔钱不会因为换了个 tab 就不存在了。
          没有未结单时这个组件什么都不渲染。 */}
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
        >{tr('立即同步')}</button>
        <code className={`status ${tone}`}>{last}</code>
      </div>

      {showDead && <DeadLetters onClose={() => { setShowDead(false); void refresh() }} />}

      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}

      {/* 一个员工看不懂的状态标签等于没有标签 —— 必须能点开问"这是什么" */}
      {showSync && (
        <div className="sheet-back" onClick={() => setShowSync(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('未上传')} {pending}</h2>
            <p className="hint">
              这台 iPad 上有 <b>{pending}</b>{tr('条操作还没传到店里的服务器。')}</p>
            <table className="kv">
              <tbody>
                <tr>
                  <td className="dim">{tr('要我做什么吗')}</td>
                  <td className="num">{tr('不用。联网后会自动补发。')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('数据会丢吗')}</td>
                  <td className="num">{tr('不会。已经存在这台 iPad 上了。')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('多久补发一次')}</td>
                  <td className="num">{tr('有积压时每 4 秒重试一次')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('现在网络')}</td>
                  <td className="num">{tr(online ? '在线' : '离线')}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('上次同步')}</td>
                  <td className="num">{last}</td>
                </tr>
                <tr>
                  <td className="dim">{tr('技术细节')}</td>
                  <td className="num"><code>{detail}</code></td>
                </tr>
              </tbody>
            </table>
            <p className="hint">{tr('如果一直不归零，说明服务器连不上（检查店内 WiFi 和后台机器）。 红色的「失败 N」才是需要人处理的 —— 那是服务端明确拒绝的操作。')}</p>
            <div className="sheet-actions">
              <button onClick={() => setShowSync(false)}>{tr('知道了')}</button>
              <button
                className="primary"
                onClick={() => {
                  sync()
                    .then((r) => report(r))
                    .catch(() => {})
                  setShowSync(false)
                }}
              >{tr('立即重试')}</button>
            </div>

            {canManage(identity.role) && (
              <>
                <div className="divider" />
                <p className="hint">
                  <b>{tr('重置本机数据')}</b>{tr('：清空这台设备缓存的账单，重新从服务器拉一遍。 服务端的数据被清理过、而本机还留着旧单时才需要 —— 服务端删数据不会通知客户端。')}</p>
                <button
                  className="linkbtn wide danger"
                  onClick={async () => {
                    const r = await resetLocalData()
                    if (!r.ok) {
                      setLast(`${tr('还有未上传的操作，等它同步完再重置')}（${r.pending}）`)
                      setTone('bad')
                      return
                    }
                    await sync().catch(() => {})
                    await refresh()
                    setShowSync(false)
                    setLast(tr('本机数据已重置，正在重新拉取'))
                    setTone('ok')
                  }}
                >{tr('重置本机数据')}</button>
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
                {tr(e.synced ? '已同步' : '待同步')}
              </span>
              {e.remote ? <span className="tag remote">{tr('其它设备')}</span> : null}
              <span className="label">{tr(e.label)}</span>
              <code className="id">{e.op_id.slice(0, 8)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
